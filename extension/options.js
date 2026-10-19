const $ = (id) => document.getElementById(id);
let settings;

const FIELDS = [
  { key: 'name', label: 'Name' },
  { key: 'path', label: 'Local repository path', hint: 'absolute path' },
  { key: 'baseBranch', label: 'Base branch', hint: 'empty = current HEAD, else fetched from origin (e.g. qa)' },
  { key: 'branchTemplate', label: 'Branch name template', hint: '{key} {slug} {type} — e.g. 20_26_release_{key}' },
  { key: 'mode', label: 'Mode', options: [['inplace', 'In place (switch branch in the repo)'], ['worktree', 'Separate git worktree']] },
  { key: 'worktreeDir', label: 'Worktree folder', hint: 'worktree mode; default <repo>-worktrees' },
  { key: 'copyFiles', label: 'Files to copy into worktree', hint: 'comma-separated, e.g. .env, config/master.key', list: true, full: true },
  { key: 'permissionMode', label: 'Claude permission mode', options: [['acceptEdits', 'acceptEdits (edit files, only allowed Bash)'], ['bypassPermissions', 'bypassPermissions (anything — use with care)']] },
  { key: 'model', label: 'Model', hint: 'optional, e.g. opus, sonnet' },
  { key: 'allowedTools', label: 'Allowed tools', hint: 'comma-separated, e.g. Bash(bundle exec rspec:*)', full: true },
];

document.addEventListener('DOMContentLoaded', async () => {
  settings = await getSettings();
  $('commitTemplate').value = settings.commitTemplate;
  $('includeSummaryInCommit').checked = settings.includeSummaryInCommit;
  $('add').onclick = () => { settings.projects.push({ ...DEFAULT_PROJECT }); render(); };
  $('save').onclick = save;
  $('test').onclick = test;
  render();
});

function render() {
  const root = $('projects');
  root.innerHTML = '';
  if (!settings.projects.length) {
    root.innerHTML = '<div class="empty">No projects yet — add the local repositories Claude should work in.</div>';
  }
  settings.projects.forEach((p, i) => {
    const fs = document.createElement('fieldset');
    const head = document.createElement('div');
    head.className = 'project-head';
    const title = document.createElement('strong');
    title.textContent = p.name || 'New project';
    const remove = document.createElement('button');
    remove.className = 'ghost danger';
    remove.textContent = 'Remove';
    remove.onclick = () => { settings.projects.splice(i, 1); render(); };
    head.append(title, remove);
    const grid = document.createElement('div');
    grid.className = 'grid';
    for (const f of FIELDS) {
      const label = document.createElement('label');
      if (f.full) label.className = 'full';
      label.textContent = f.label + ' ';
      if (f.hint) {
        const h = document.createElement('span');
        h.className = 'hint';
        h.textContent = f.hint;
        label.append(h);
      }
      let input;
      if (f.options) {
        input = document.createElement('select');
        for (const [v, t] of f.options) input.append(new Option(t, v));
      } else {
        input = document.createElement('input');
      }
      const value = p[f.key] ?? DEFAULT_PROJECT[f.key];
      input.value = f.list ? (value || []).join(', ') : value;
      input.oninput = input.onchange = () => {
        p[f.key] = f.list ? input.value.split(',').map((s) => s.trim()).filter(Boolean) : input.value.trim();
        if (f.key === 'name') title.textContent = p.name || 'New project';
      };
      label.append(input);
      grid.append(label);
    }
    fs.append(head, grid);
    root.append(fs);
  });
}

function flash(text, cls = 'success') {
  $('msg').className = `small ${cls}`;
  $('msg').textContent = text;
}

async function save() {
  const names = settings.projects.map((p) => p.name);
  if (names.some((n) => !n)) return flash('Every project needs a name.', 'error');
  if (new Set(names).size !== names.length) return flash('Project names must be unique.', 'error');
  if (settings.projects.some((p) => !p.path?.startsWith('/'))) return flash('Project paths must be absolute.', 'error');
  settings.commitTemplate = $('commitTemplate').value.trim() || DEFAULT_SETTINGS.commitTemplate;
  settings.includeSummaryInCommit = $('includeSummaryInCommit').checked;
  await chrome.storage.local.set(settings);
  flash('Saved.');
}

async function test() {
  const out = $('test-out');
  out.hidden = false;
  out.textContent = 'Contacting native host…';
  try {
    const res = await chrome.runtime.sendNativeMessage(NATIVE_HOST, {
      type: 'check',
      paths: settings.projects.map((p) => p.path).filter(Boolean),
    });
    const lines = [`Native host OK (node ${res.node})`, `claude: ${res.claude || 'NOT FOUND — re-run install.sh'}`];
    for (const [p, s] of Object.entries(res.repos || {})) lines.push(`${s === 'ok' ? '✔' : '✘'} ${p} ${s === 'ok' ? '' : '— ' + s}`);
    out.textContent = lines.join('\n');
  } catch (e) {
    out.textContent = `Native host not reachable: ${e.message}\n\nRun:  host/install.sh ${chrome.runtime.id}`;
  }
}
