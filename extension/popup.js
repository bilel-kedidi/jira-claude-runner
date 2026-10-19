const $ = (id) => document.getElementById(id);
const KEY_RE = /\b([A-Z][A-Z0-9_]+-\d+)\b/;

let tab = null;
let issue = null;
let settings = null;
let jobRunning = false;
let chat = null; // this ticket's chat state from the background worker

document.addEventListener('DOMContentLoaded', init);

async function init() {
  $('open-options').onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
  $('load-btn').onclick = () => loadIssue($('key-input').value.trim().toUpperCase());
  $('key-input').onkeydown = (e) => { if (e.key === 'Enter') $('load-btn').click(); };
  $('project').onchange = onProjectChange;
  $('base-branch').oninput = showProjectInfo;
  $('branch-name').oninput = showProjectInfo;
  $('start').onclick = start;
  $('cancel').onclick = () => chrome.runtime.sendMessage({ type: 'cancel' });
  $('clear').onclick = () => chrome.runtime.sendMessage({ type: 'clear' });
  document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => selectTab(t.dataset.tab); });
  document.querySelectorAll('.chip').forEach((c) => { c.onclick = () => sendChat(c.textContent); });
  $('chat-send').onclick = () => sendChat($('chat-input').value);
  $('chat-input').onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('chat-send').click(); }
  };
  $('chat-clear').onclick = (e) => { e.preventDefault(); if (issue) chrome.runtime.sendMessage({ type: 'chat-clear', ticketKey: issue.key }); };
  $('chat-stop').onclick = (e) => { e.preventDefault(); chrome.runtime.sendMessage({ type: 'chat-cancel' }); };
  chrome.storage.session.onChanged.addListener((c) => { if (c.chats) renderChat(c.chats.newValue); });
  let savedTab = 'ask';
  try { savedTab = localStorage.getItem('tab') || 'ask'; } catch {}
  selectTab(savedTab);

  settings = await getSettings();
  const { job } = await chrome.storage.session.get('job');
  renderJob(job);
  chrome.storage.session.onChanged.addListener((c) => { if (c.job) renderJob(c.job.newValue); });

  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const key = detectKey(tab?.url || '');
  if (key) loadIssue(key);
  else {
    setStatus('No Jira ticket found in this tab URL. Enter a key (this tab must be on your Jira site):');
    $('manual').hidden = false;
  }
}

function detectKey(url) {
  try {
    const u = new URL(url);
    const browse = u.pathname.match(/\/browse\/([A-Z][A-Z0-9_]+-\d+)/);
    if (browse) return browse[1];
    const selected = u.searchParams.get('selectedIssue');
    if (selected && KEY_RE.test(selected)) return selected;
    const any = url.match(KEY_RE);
    return any ? any[1] : null;
  } catch {
    return null;
  }
}

function setStatus(text, isError = false) {
  const el = $('ticket-status');
  el.textContent = text;
  el.className = isError ? 'error' : 'muted';
  el.hidden = !text;
}

async function loadIssue(key) {
  if (!KEY_RE.test(key)) return setStatus(`"${key}" is not a valid ticket key`, true);
  if (!tab?.url?.startsWith('http')) return setStatus('Open your Jira site in this tab first.', true);
  setStatus(`Loading ${key}…`);
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: fetchIssueInPage,
      args: [key],
    });
    if (result.error) throw new Error(result.error);
    issue = result;
  } catch (e) {
    $('manual').hidden = false;
    return setStatus(`Could not read ${key}: ${e.message}`, true);
  }
  setStatus('');
  $('manual').hidden = true;
  $('ticket-card').hidden = false;
  $('t-key').textContent = issue.key;
  $('t-key').href = issue.url;
  $('t-meta').replaceChildren(...[issue.type, issue.status, issue.priority].filter(Boolean).map((t) => el('span', 'pill', t)));
  $('t-summary').textContent = issue.summary;
  renderProjects();
  renderChat((await chrome.storage.session.get('chats')).chats);
}

// Runs inside the Jira page, so it uses the user's Jira session cookies.
// Uses REST API v2 because it returns plain-text descriptions (v3 returns ADF JSON).
async function fetchIssueInPage(key) {
  const fields = 'summary,description,issuetype,priority,status,labels,components,comment';
  const res = await fetch(`/rest/api/2/issue/${encodeURIComponent(key)}?fields=${fields}`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) return { error: `Jira API returned HTTP ${res.status} — is this tab on your Jira site and are you logged in?` };
  const d = await res.json();
  const f = d.fields || {};
  return {
    key: d.key,
    url: `${location.origin}/browse/${d.key}`,
    summary: f.summary || '',
    description: f.description || '',
    type: f.issuetype?.name,
    priority: f.priority?.name,
    status: f.status?.name,
    labels: f.labels || [],
    components: (f.components || []).map((c) => c.name),
    comments: (f.comment?.comments || []).slice(-10).map((c) => ({
      author: c.author?.displayName,
      body: (c.body || '').slice(0, 3000),
    })),
  };
}

function renderProjects() {
  const sel = $('project');
  sel.innerHTML = '';
  if (!settings.projects.length) {
    $('run').hidden = false;
    $('project-info').innerHTML = 'No projects configured yet. <a href="#" id="go-opts">Add one in Settings</a>.';
    $('go-opts').onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
    $('start').disabled = true;
    return;
  }
  for (const p of settings.projects) sel.append(new Option(p.name, p.name));
  const remembered = settings.mapping[issue.key.split('-')[0]];
  if (remembered && settings.projects.some((p) => p.name === remembered)) sel.value = remembered;
  $('run').hidden = false;
  onProjectChange();
}

function selectedProject() {
  return settings.projects.find((p) => p.name === $('project').value);
}

function previewBranch(template, t) {
  const slug = t.summary.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim()
    .replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 40).replace(/-$/, '');
  return template.replace(/\{key\}/g, t.key).replace(/\{slug\}/g, slug)
    .replace(/\{type\}/g, (t.type || 'task').toLowerCase().replace(/\s+/g, '-'));
}

// Reset the per-run fields to the project defaults and load branch suggestions.
function onProjectChange() {
  const p = selectedProject();
  if (!p) return;
  $('base-branch').value = p.baseBranch || '';
  $('branch-name').value = previewBranch(p.branchTemplate || '{key}', issue);
  loadBranches(p);
  showProjectInfo();
}

async function loadBranches(p) {
  const list = $('branch-list');
  list.innerHTML = '';
  try {
    const res = await chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: 'branches', path: p.path });
    if (selectedProject() !== p || !res?.ok) return;
    for (const b of res.branches) list.append(new Option(b));
    $('base-branch').placeholder = res.current ? `current HEAD (${res.current})` : 'current HEAD';
  } catch {
    // Native host not installed yet — free text still works.
  }
}

function showProjectInfo() {
  const p = selectedProject();
  if (!p) return;
  const base = $('base-branch').value.trim().replace(/^origin\//, '');
  const from = base ? `origin/${base}` : 'current HEAD';
  const mode = p.mode === 'worktree' ? 'new worktree' : 'in place';
  const hotfix = base && base !== (p.baseBranch || '') ? '  ← overridden for this run' : '';
  $('project-info').textContent = `${p.path} (${mode})\nfrom ${from}${hotfix}`;
  $('start').disabled = jobRunning || !$('branch-name').value.trim();
}

async function start() {
  const project = selectedProject();
  if (!project || !issue) return;
  settings.mapping[issue.key.split('-')[0]] = project.name;
  await chrome.storage.local.set({ mapping: settings.mapping });
  const res = await chrome.runtime.sendMessage({
    type: 'start',
    payload: {
      ticket: issue,
      project,
      baseBranch: $('base-branch').value.trim(),
      branchName: $('branch-name').value.trim(),
      chatContext: chatContext(),
      extraInstructions: $('extra').value,
      commitTemplate: settings.commitTemplate,
      includeSummaryInCommit: settings.includeSummaryInCommit,
    },
  });
  if (!res?.ok) setStatus(res?.error || 'Could not start the job', true);
}

function renderJob(job) {
  jobRunning = job?.status === 'running';
  $('start').disabled = jobRunning || !settings?.projects.length;
  if (!job) { $('job').hidden = true; return; }

  $('job').hidden = false;
  $('job-title').textContent = `${job.ticket} → ${job.project}`;
  const badge = $('job-status');
  badge.textContent = job.status;
  badge.className = `badge ${job.status}`;
  $('job-step').textContent = jobRunning ? job.step : '';
  $('cancel').hidden = !jobRunning;
  $('clear').hidden = jobRunning;
  renderStepper(job);

  const log = $('job-log');
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
  log.innerHTML = '';
  for (const l of job.logs) {
    const line = document.createElement('div');
    line.className = `log-${l.level}`;
    line.textContent = l.text;
    log.append(line);
  }
  if (atBottom) log.scrollTop = log.scrollHeight;

  const out = $('job-result');
  out.innerHTML = '';
  const r = job.result;
  if (!r) return;
  if (!r.ok) {
    out.append(el('div', 'result error', r.error));
    appendResume(out, r);
    return;
  }
  const box = el('div', r.commit ? 'result success' : 'note', '');
  const title = el('strong', '', r.commit ? 'Committed ' : 'No changes committed on ');
  if (r.commit) title.append(el('code', '', r.commit), ' on ');
  title.append(el('code', '', r.branch));
  box.append(title);
  if (r.cwd) box.append(el('div', 'path', r.cwd));
  if (r.files?.length) {
    const list = el('ul', 'file-list', '');
    for (const f of r.files) list.append(el('li', '', f));
    box.append(list);
  }
  out.append(box);
  if (r.skipped?.length) out.append(el('div', 'note', `Not committed (already had your changes): ${r.skipped.join(', ')}`));
  appendResume(out, r);
}

// Headless runs are normal Claude Code sessions: show the command to open/continue one interactively.
function appendResume(out, r) {
  if (!r.sessionId || !r.cwd) return;
  const cmd = `cd ${JSON.stringify(r.cwd)} && claude --resume ${r.sessionId}`;
  const box = el('div', 'resume', '');
  box.append(el('div', 'resume-label', 'Open this Claude session to review or continue it'));
  const row = el('div', 'resume-row', '');
  const code = el('code', '', cmd);
  const copy = el('button', '', 'Copy');
  copy.onclick = async () => {
    await navigator.clipboard.writeText(cmd);
    copy.textContent = 'Copied';
    setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
  };
  row.append(code, copy);
  box.append(row);
  out.append(box);
}

// Maps the host's step text onto the 4-stage progress bar.
const STEPS = [['branch', /^Preparing branch/], ['claude', /^Running Claude/], ['collect', /^Collecting/], ['commit', /^Committing/]];

function renderStepper(job) {
  let current = STEPS.findIndex(([, re]) => re.test(job.step || ''));
  if (current < 0) current = 0;
  const finished = job.status === 'done';
  $('stepper').querySelectorAll('li').forEach((li, i) => {
    li.className = '';
    if (finished || i < current) li.classList.add('complete');
    else if (i === current) li.classList.add(job.status === 'failed' ? 'error' : 'active');
  });
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  e.className = cls;
  e.textContent = text;
  return e;
}

// ---------------------------------------------------------------- tabs & chat

function selectTab(name) {
  document.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on);
  });
  $('panel-ask').hidden = name !== 'ask';
  $('panel-solve').hidden = name !== 'solve';
  try { localStorage.setItem('tab', name); } catch {}
  if (name === 'ask') scrollChat();
}

// The question/answer pairs only (no tool activity), trimmed, for the solve prompt.
function chatContext() {
  return (chat?.messages || [])
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-12)
    .map((m) => ({ role: m.role, text: m.text.slice(0, 4000) }));
}

async function sendChat(text) {
  text = text.trim();
  const project = selectedProject();
  if (!text || !issue || !project || chat?.busy) return;
  $('chat-input').value = '';
  const res = await chrome.runtime.sendMessage({ type: 'chat', ticket: issue, project, message: text });
  if (!res?.ok) setStatus(res?.error || 'Could not reach Claude', true);
}

function renderChat(chats) {
  if (!issue) return;
  chat = chats?.[issue.key] || null;
  const messages = chat?.messages || [];
  const busy = !!chat?.busy;
  const logEl = $('chat-log');
  logEl.innerHTML = '';

  if (!messages.length) {
    logEl.append(el('div', 'chat-empty', "Not sure what the ticket needs? Ask Claude. It reads this project's code to answer, but can't change anything."));
  }
  // Collapse consecutive tool calls into one "activity" line.
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'tool') {
      const tools = [];
      while (i < messages.length && messages[i].role === 'tool') tools.push(messages[i++].text);
      i--;
      const live = busy && i === messages.length - 1;
      const d = document.createElement('details');
      d.className = 'chat-activity';
      if (live) d.open = true;
      d.append(el('summary', '', `${live ? 'Looking through the code' : 'Looked at'} ${tools.length} place${tools.length > 1 ? 's' : ''}`));
      const list = el('ul', '', '');
      for (const t of tools.slice(-15)) list.append(el('li', '', t));
      d.append(list);
      logEl.append(d);
    } else if (m.role === 'assistant') {
      const b = el('div', 'bubble assistant', '');
      b.innerHTML = renderMarkdown(m.text);
      logEl.append(b);
    } else {
      logEl.append(el('div', `bubble ${m.role}`, m.text));
    }
  }
  if (busy) {
    const typing = el('div', 'bubble assistant typing', '');
    typing.append(el('span', '', ''), el('span', '', ''), el('span', '', ''));
    logEl.append(typing);
  }

  $('chat-chips').hidden = messages.length > 0;
  $('chat-send').disabled = busy;
  $('chat-input').disabled = busy;
  $('chat-stop').hidden = !busy;
  $('chat-clear').hidden = busy || !messages.length;
  $('chat-context-note').hidden = !chatContext().length;
  scrollChat();
}

function scrollChat() {
  const logEl = $('chat-log');
  logEl.scrollTop = logEl.scrollHeight;
}

// Tiny, safe Markdown subset: escape first, then code blocks, inline code, bold, headings, bullets.
function renderMarkdown(md) {
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const blocks = md.split(/```[\w-]*\n?/);
  return blocks.map((part, i) => {
    if (i % 2) return `<pre>${esc(part.replace(/\n$/, ''))}</pre>`;
    return esc(part)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/^#{1,6} +(.+)$/gm, '<strong class="h">$1</strong>')
      .replace(/^\s*[-*] +(.+)$/gm, '<span class="li">$1</span>')
      .replace(/\n{2,}/g, '<br><br>')
      .replace(/\n/g, '<br>');
  }).join('');
}
