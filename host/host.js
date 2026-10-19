#!/usr/bin/env node
// Native messaging host for the "Jira → Claude" Chrome extension.
// Protocol: Chrome sends/receives JSON messages prefixed with a 4-byte little-endian length.
// Nothing except protocol frames may ever be written to stdout.
'use strict';

const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const MAX_LOG_CHARS = 16000; // Chrome caps host→extension messages at 1 MB

let child = null;
let cancelled = false;
let session = { id: null, cwd: null }; // reported with every result so the run can be resumed
let input = Buffer.alloc(0);

// ---------------------------------------------------------------- protocol

function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

function log(text, level = 'info') {
  text = String(text);
  if (text.length > MAX_LOG_CHARS) text = text.slice(0, MAX_LOG_CHARS) + '… [truncated]';
  send({ type: 'log', level, text });
}

function step(name) {
  send({ type: 'step', step: name });
  log(`▶ ${name}`, 'step');
}

process.stdin.on('data', (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4) {
    const len = input.readUInt32LE(0);
    if (input.length < 4 + len) break;
    const msg = JSON.parse(input.subarray(4, 4 + len).toString('utf8'));
    input = input.subarray(4 + len);
    handle(msg);
  }
});

// Extension disconnected (popup/background gone or job finished): stop Claude and exit.
process.stdin.on('end', () => {
  if (child) child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 300);
});

async function handle(msg) {
  if (msg.type === 'cancel') {
    cancelled = true;
    if (child) child.kill('SIGTERM');
    log('Cancellation requested', 'warn');
    return;
  }
  try {
    if (msg.type === 'check') send(await check(msg));
    else if (msg.type === 'branches') send(await branches(msg));
    else if (msg.type === 'chat') send(await chat(msg));
    else if (msg.type === 'run') send({ type: 'done', ok: true, ...(await run(msg.job)) });
    else send({ type: 'done', ok: false, error: `Unknown message type: ${msg.type}` });
  } catch (err) {
    send({ type: 'done', ok: false, error: err.message, sessionId: session.id, cwd: session.cwd });
  }
}

// ---------------------------------------------------------------- helpers

function git(cwd, args, { allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !allowFail) {
        return reject(new Error(`git ${args.join(' ')} failed: ${(stderr || err.message).trim()}`));
      }
      resolve({ ok: !err, stdout, stderr });
    });
  });
}

async function branchExists(repo, branch) {
  return (await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true })).ok;
}

function fingerprint(cwd, file) {
  try {
    const full = path.join(cwd, file);
    if (fs.lstatSync(full).isDirectory()) return 'dir';
    return crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex');
  } catch {
    return 'missing';
  }
}

// Map of every dirty/untracked path → content fingerprint.
async function dirtyMap(cwd) {
  const { stdout } = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const entries = stdout.split('\0');
  const paths = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const xy = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (xy[0] === 'R' || xy[0] === 'C') paths.push(entries[++i]); // rename/copy source
  }
  const map = new Map();
  for (const p of paths) map.set(p, fingerprint(cwd, p));
  return map;
}

function render(template, ticket) {
  const slug = (ticket.summary || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40)
    .replace(/-$/, '');
  return template
    .replace(/\{key\}/g, ticket.key)
    .replace(/\{summary\}/g, ticket.summary || '')
    .replace(/\{slug\}/g, slug)
    .replace(/\{type\}/g, (ticket.type || 'task').toLowerCase().replace(/\s+/g, '-'));
}

// ---------------------------------------------------------------- check

async function check({ paths = [] }) {
  const claude = await new Promise((resolve) =>
    execFile(CLAUDE_BIN, ['--version'], (err, out) => resolve(err ? null : out.trim()))
  );
  const repos = {};
  for (const p of paths) {
    const r = await git(p, ['rev-parse', '--show-toplevel'], { allowFail: true });
    repos[p] = r.ok ? 'ok' : 'not a git repository';
  }
  return { type: 'check', ok: true, node: process.version, claude, repos };
}

// Local + origin branch names (deduplicated, most recently committed first) for the base-branch picker.
async function branches({ path: repoPath }) {
  const { stdout } = await git(repoPath, ['for-each-ref', '--sort=-committerdate', '--count=300',
    '--format=%(refname:short)', 'refs/heads', 'refs/remotes/origin']);
  const names = stdout.split('\n')
    .map((n) => n.trim().replace(/^origin\//, ''))
    .filter((n) => n && n !== 'HEAD' && n !== 'origin');
  const current = (await git(repoPath, ['branch', '--show-current'], { allowFail: true })).stdout.trim();
  return { type: 'branches', ok: true, current, branches: [...new Set(names)] };
}

// ---------------------------------------------------------------- run

async function run({ ticket, project, baseBranch, branchName, extraInstructions = '', chatContext = [], commitTemplate, includeSummaryInCommit }) {
  if (!ticket?.key) throw new Error('No ticket provided');
  if (!project?.path || !fs.existsSync(project.path)) throw new Error(`Project path not found: ${project?.path}`);

  const repo = (await git(project.path, ['rev-parse', '--show-toplevel'])).stdout.trim();
  const branch = branchName?.trim() || render(project.branchTemplate || '{key}', ticket);
  const valid = await git(repo, ['check-ref-format', '--branch', branch], { allowFail: true });
  if (!valid.ok) throw new Error(`Invalid branch name "${branch}"`);

  step(`Preparing branch ${branch}`);
  // Per-run override (e.g. a hotfix branch) wins over the project default.
  const base = await resolveBase(repo, (baseBranch ?? project.baseBranch ?? '').trim().replace(/^origin\//, ''));
  const cwd = project.mode === 'worktree'
    ? await prepareWorktree(repo, branch, base, project)
    : await checkoutInPlace(repo, branch, base);

  // Snapshot AFTER branch setup, so anything already dirty is excluded from the commit.
  const before = await dirtyMap(cwd);
  if (before.size) log(`${before.size} pre-existing uncommitted file(s) will be left out of the commit`, 'warn');

  step('Running Claude');
  const summary = await runClaude(cwd, buildPrompt(ticket, extraInstructions, chatContext), project);

  step('Collecting changes');
  const after = await dirtyMap(cwd);
  const files = [];
  const skipped = [];
  for (const [file, hash] of after) {
    if (!before.has(file)) files.push(file);
    else if (before.get(file) !== hash) skipped.push(file); // was already dirty AND Claude touched it
  }
  for (const s of skipped) log(`Skipped ${s}: it had uncommitted changes before Claude ran — review it manually`, 'warn');

  if (!files.length) {
    log('Claude made no new changes — nothing to commit', 'warn');
    return { branch, cwd, commit: null, files, skipped, summary, sessionId: session.id };
  }

  step(`Committing ${files.length} file(s)`);
  files.forEach((f) => log(`  + ${f}`));
  await git(cwd, ['--literal-pathspecs', 'add', '-A', '--', ...files]);
  const subject = render(commitTemplate || '{key}: {summary}', ticket);
  const msgArgs = ['-m', subject];
  if (includeSummaryInCommit && summary.trim()) msgArgs.push('-m', summary.trim().slice(0, 4000));
  // --only commits exactly these paths, even if other changes were already staged.
  await git(cwd, ['--literal-pathspecs', 'commit', '--only', ...msgArgs, '--', ...files]);
  const commit = (await git(cwd, ['rev-parse', '--short', 'HEAD'])).stdout.trim();
  log(`✔ Committed ${commit} on ${branch}`, 'success');

  return { branch, cwd, commit, files, skipped, summary, sessionId: session.id };
}

async function resolveBase(repo, baseBranch) {
  if (!baseBranch) return 'HEAD';
  const fetched = await git(repo, ['fetch', 'origin', baseBranch], { allowFail: true });
  if (fetched.ok) {
    log(`Fetched origin/${baseBranch}`);
    return `origin/${baseBranch}`;
  }
  log(`Could not fetch origin/${baseBranch}; using local ${baseBranch}`, 'warn');
  return baseBranch;
}

async function checkoutInPlace(repo, branch, base) {
  if (await branchExists(repo, branch)) {
    log(`Branch ${branch} already exists — switching to it`);
    await git(repo, ['switch', branch]);
  } else {
    await git(repo, ['switch', '--no-track', '-c', branch, base]);
    log(`Created branch ${branch} from ${base}`);
  }
  return repo;
}

async function prepareWorktree(repo, branch, base, project) {
  const root = project.worktreeDir || `${repo}-worktrees`;
  const wt = path.join(root, branch.replace(/[\/\\]/g, '-'));
  if (fs.existsSync(wt)) {
    log(`Reusing existing worktree ${wt}`);
    return wt;
  }
  fs.mkdirSync(root, { recursive: true });
  const args = (await branchExists(repo, branch))
    ? ['worktree', 'add', wt, branch]
    : ['worktree', 'add', '--no-track', '-b', branch, wt, base];
  await git(repo, args);
  log(`Created worktree ${wt}`);
  for (const f of project.copyFiles || []) {
    const src = path.join(repo, f);
    if (!fs.existsSync(src)) { log(`copyFiles: ${f} not found, skipped`, 'warn'); continue; }
    fs.mkdirSync(path.dirname(path.join(wt, f)), { recursive: true });
    fs.cpSync(src, path.join(wt, f), { recursive: true });
    log(`Copied ${f} into worktree`);
  }
  return wt;
}

function ticketContext(t) {
  const lines = [
    `Jira ticket ${t.key}: ${t.summary}`,
    t.url && `Ticket URL: ${t.url}`,
    `Type: ${t.type || '-'} | Priority: ${t.priority || '-'} | Status: ${t.status || '-'}`,
    t.labels?.length && `Labels: ${t.labels.join(', ')}`,
    t.components?.length && `Components: ${t.components.join(', ')}`,
    '',
    '## Description',
    t.description || '(no description)',
  ];
  if (t.comments?.length) {
    lines.push('', '## Comments (most recent last)');
    for (const c of t.comments) lines.push(`- ${c.author || 'unknown'}: ${c.body}`);
  }
  return lines.filter((l) => l !== false && l !== undefined && l !== null && l !== 0);
}

function buildPrompt(t, extra, chatContext = []) {
  const lines = ['You are working on the following ticket in this repository.', '', ...ticketContext(t)];
  if (chatContext.length) {
    lines.push('', '## Earlier discussion with the developer about this ticket');
    for (const m of chatContext) lines.push(`${m.role === 'user' ? 'Developer' : 'You'}: ${m.text}`);
  }
  if (extra?.trim()) lines.push('', '## Additional instructions from the developer', extra.trim());
  lines.push(
    '',
    '## Rules',
    '- Investigate the codebase first, then implement the fix/feature described by the ticket.',
    '- If the ticket is a data fix, implement it the way this codebase does data fixes (e.g. a migration, rake task or script) rather than editing data by hand.',
    '- Keep changes minimal and focused on this ticket; do not touch unrelated files or reformat code.',
    '- Do NOT run git commit, checkout, switch, stash, reset, rebase or push. Branching and committing are handled for you.',
    '- When finished, reply with a short summary (a few bullet points) of what you changed and why.'
  );
  return lines.join('\n');
}

function buildChatPrompt(t, question) {
  return [
    'A developer is asking you about a Jira ticket before working on it. You are in the repository it belongs to.',
    'You are in READ-ONLY mode: search and read the code to ground your answers, but never modify files.',
    'Be concise and concrete: reference files/classes/methods you found. When relevant, say clearly whether this looks like',
    'a DATA fix (bad records to correct), a CODE change, a configuration issue, or both — and why.',
    '',
    ...ticketContext(t),
    '',
    '## Developer question',
    question,
  ].join('\n');
}

function describeTool(input = {}) {
  const v = input.file_path || input.command || input.pattern || input.path || input.url;
  return v ? String(v).slice(0, 300) : JSON.stringify(input).slice(0, 300);
}

const CHAT_TOOLS = 'Read,Glob,Grep,Bash(git log:*),Bash(git show:*),Bash(git grep:*),Bash(git blame:*),Bash(ls:*)';

function runClaude(cwd, prompt, project) {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose',
    '--permission-mode', project.permissionMode || 'acceptEdits'];
  if (project.allowedTools) args.push('--allowedTools', project.allowedTools);
  if (project.model) args.push('--model', project.model);
  return spawnClaude(cwd, args, 'changes left uncommitted').then((result) => {
    if (result.total_cost_usd != null) log(`Claude finished in ${result.num_turns} turns, $${result.total_cost_usd.toFixed(4)}`);
    return result.result || '';
  });
}

// Read-only Q&A about the ticket. Follow-up questions resume the same Claude session.
async function chat({ ticket, project, sessionId, message }) {
  if (!project?.path || !fs.existsSync(project.path)) throw new Error(`Project path not found: ${project?.path}`);
  const cwd = (await git(project.path, ['rev-parse', '--show-toplevel'])).stdout.trim();
  const args = ['-p', sessionId ? message : buildChatPrompt(ticket, message),
    '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'default', // in -p mode anything not allowed below is auto-denied
    '--allowedTools', CHAT_TOOLS,
    '--disallowedTools', 'Edit,Write,NotebookEdit'];
  if (sessionId) args.push('--resume', sessionId);
  if (project.model) args.push('--model', project.model);
  const result = await spawnClaude(cwd, args, 'no files were changed', { quietText: true });
  return { type: 'done', ok: true, reply: result.result || '', sessionId: result.session_id || session.id };
}

function spawnClaude(cwd, args, failureNote, { quietText = false } = {}) {
  return new Promise((resolve, reject) => {
    child = spawn(CLAUDE_BIN, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let pending = '';
    let result = null;

    const onEvent = (line) => {
      let ev;
      try { ev = JSON.parse(line); } catch { return log(line); }
      if (ev.type === 'system' && ev.subtype === 'init') {
        session = { id: ev.session_id, cwd };
        if (!quietText) log(`Claude session ${ev.session_id} (${ev.model})`);
      } else if (ev.type === 'assistant') {
        for (const b of ev.message?.content || []) {
          if (b.type === 'text' && b.text.trim() && !quietText) log(b.text, 'claude');
          else if (b.type === 'tool_use') log(`🔧 ${b.name} ${describeTool(b.input)}`, 'tool');
        }
      } else if (ev.type === 'result') {
        result = ev;
      }
    };

    child.stdout.on('data', (d) => {
      pending += d;
      let i;
      while ((i = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, i).trim();
        pending = pending.slice(i + 1);
        if (line) onEvent(line);
      }
    });
    child.stderr.on('data', (d) => log(String(d).trim(), 'warn'));
    child.on('error', (err) => { child = null; reject(new Error(`Could not start claude (${CLAUDE_BIN}): ${err.message}`)); });
    child.on('close', (code) => {
      child = null;
      if (pending.trim()) onEvent(pending.trim());
      if (cancelled) return reject(new Error(`Cancelled — ${failureNote}`));
      if (!result) return reject(new Error(`Claude exited with code ${code} without a result`));
      if (result.is_error) {
        const text = result.result || result.subtype || '';
        if (/authenticat|oauth|log ?in|api key/i.test(text)) {
          return reject(new Error(`Claude is not logged in (${text}). Run \`claude\` in a terminal and type /login, then retry — ${failureNote}`));
        }
        return reject(new Error(`Claude failed: ${text} — ${failureNote}`));
      }
      resolve(result);
    });
  });
}
