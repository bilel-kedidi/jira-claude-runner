// Shared by popup.html and options.html.
const NATIVE_HOST = 'com.jira_claude.runner';

const DEFAULT_PROJECT = {
  name: '',
  path: '',
  baseBranch: '',            // empty = branch from current HEAD; otherwise fetched from origin
  branchTemplate: '{key}',   // placeholders: {key} {slug} {type}
  mode: 'inplace',           // 'inplace' = switch branch in the repo, 'worktree' = separate git worktree
  worktreeDir: '',           // default: <repo>-worktrees
  copyFiles: [],             // worktree only: untracked files to copy (e.g. .env, config/master.key)
  permissionMode: 'acceptEdits',
  allowedTools: 'Read,Edit,Write,Glob,Grep,Bash(git diff:*),Bash(git status:*),Bash(git log:*)',
  model: '',
};

const DEFAULT_SETTINGS = {
  projects: [],
  commitTemplate: '{key}: {summary}',
  includeSummaryInCommit: true,
  mapping: {}, // Jira project key (e.g. "BDEV") → local project name
};

function getSettings() {
  return chrome.storage.local.get(DEFAULT_SETTINGS);
}
