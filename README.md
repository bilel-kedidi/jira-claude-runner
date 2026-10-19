# Jira → Claude

**A Chrome extension that turns a Jira ticket into a ready-to-review commit.**
Open a ticket, pick your local project, and Claude Code creates a branch named after the ticket, solves the issue, and commits only the files it changed.
Not sure what the ticket needs first? Ask Claude about it in a read-only chat that searches your codebase.

```
Jira tab ──(your Jira session)──▶ popup ──▶ background worker ──native messaging──▶ host/host.js
                                                                                     ├─ git switch -c <branch> / git worktree add
                                                                                     ├─ claude -p "<ticket + chat context>"
                                                                                     └─ git commit --only <files Claude changed>
```

## Features

- **Reads the ticket from the page you're on.** Uses your logged-in Jira session (REST API v2), so you don't need an API token. Works on `/browse/KEY-123` and board URLs with `?selectedIssue=`.
- **Ask Claude (read-only chat).** Ask "Is this a data fix or a code change?", "Which files are involved?" and similar questions. Claude can read, search and run `git log`/`git blame`/`git show`, but cannot edit files. Follow-up questions continue the same conversation.
- **Solve.** Creates the branch, runs Claude Code headless and streams its progress live. When Solve starts, the chat is passed to Claude as context.
- **Hotfixes and custom branches.** Choose the base branch for each run (with suggestions from your repo) and edit the new branch name.
- **Commits only Claude's changes.** Your uncommitted or staged work is left untouched (see below).
- **In-place or worktree mode.** Work directly in your repo, or in a separate `git worktree` so your checkout is never touched.
- **Resume any run.** Each run is a normal Claude Code session; the popup shows a `claude --resume <id>` command to review or continue it.
- **Survives closing the popup.** You get a desktop notification when the run finishes.

## Requirements

- Google Chrome (or Chromium / Brave)
- [Node.js](https://nodejs.org) 18+
- [Claude Code](https://docs.claude.com/en/docs/claude-code) CLI (`claude`), logged in
- git
- macOS or Linux

## Install

1. **Load the extension:** go to `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and select the `extension/` folder. Copy the extension **ID** from its card.
2. **Register the native host:**
   ```bash
   ./host/install.sh <extension-id>
   ```
   Run this from a shell where `node` and `claude` work. If Claude should run tests, that shell also needs `ruby`, `bundle` and so on on its PATH. The current PATH is saved in `host/run-host.sh` because Chrome starts the host with a minimal environment. Re-run it after switching Node versions (for example with nvm).
3. **Configure:** open the extension's **Settings**, add your projects, click **Save**, then **Test connection**.

To update after pulling changes, click ↻ on the extension card. You only need to re-run `install.sh` if the extension ID or your Node/Claude location changed.

## Usage

1. Open a Jira ticket and click the extension icon.
2. Choose the **target project**. Your choice is remembered per Jira project key.
3. **Ask Claude** (optional): ask questions until you understand the ticket.
4. **Solve:** check the base branch and new branch name, add any hints, then click **Create branch & solve with Claude**.
5. Review the commit (`git show`) and push it yourself. The extension never pushes.

## How "commit only the changes" works

Right after the branch is ready, the host takes a snapshot of every dirty or untracked file, with a content hash. When Claude finishes:

- files that were **not** dirty before are committed with `git commit --only`, so anything you had already staged stays staged and is not committed;
- files that were already dirty **and** that Claude modified are not committed, and are listed in the popup for you to review;
- if Claude fails or is cancelled, nothing is committed.

## Project settings

| Field | Description |
|---|---|
| Local repository path | Absolute path to the git repo. |
| Base branch | Default branch to start from. Empty means the current HEAD; otherwise the host runs `git fetch origin <base>` and branches from `origin/<base>`. You can override it in the popup for each run. |
| Branch name template | `{key}`, `{slug}` (from the summary), `{type}`. Examples: `20_26_release_{key}`, `{type}/{key}-{slug}`. If the branch already exists, it is reused. |
| Mode | **In place** switches the branch in your repo. **Worktree** creates `<repo>-worktrees/<branch>`. |
| Files to copy into worktree | Untracked files a fresh worktree needs, for example `.env, config/master.key`. |
| Claude permission mode | `acceptEdits` (default: file edits plus the allowed tools only) or `bypassPermissions`. |
| Allowed tools | Passed to `claude --allowedTools`. The default allows edits and read-only git. Add for example `Bash(bundle exec rspec:*)` to let Claude run specs. |
| Model | Optional, e.g. `opus`, `sonnet`. |

Global settings: the commit message template (default `{key}: {summary}`) and whether to add Claude's summary as the commit body.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Native host not reachable" | Re-run `./host/install.sh <extension-id>` with the exact ID shown on `chrome://extensions`. |
| "Claude is not logged in" / "OAuth session expired" | Run `claude` in a terminal, type `/login`, then retry. For a long-lived login, use `claude setup-token` and add `export CLAUDE_CODE_OAUTH_TOKEN=…` to `host/run-host.sh`. **Never commit that file**; it is already gitignored. |
| Jira returns HTTP 401/404 | Make sure the tab is on your Jira site and you are logged in. Self-hosted Jira under a sub-path (e.g. `/jira`) isn't supported yet. |
| Stopped working after switching Node versions | Re-run `install.sh`. |
| `install.sh: permission denied` | Run `chmod +x host/install.sh`, or use `bash host/install.sh <id>`. |

## Project structure

```
extension/          Chrome extension (Manifest V3)
  manifest.json
  popup.html/js     ticket view, Ask Claude chat, Solve, live job log
  background.js     keeps native connections alive, stores job and chat state
  options.html/js   project settings
  common.js         shared defaults
  styles.css
host/
  host.js           native messaging host: git, Claude, commit
  install.sh        registers the host with Chrome
```

## Security notes

- The native host only accepts connections from your extension ID (`allowed_origins`).
- The chat runs Claude with read-only tools; editing tools are explicitly disallowed.
- Solve runs with the permission mode and tools you configure for each project. Be careful with `bypassPermissions`.
- Nothing is pushed, and nothing is sent anywhere except to Jira (from your own browser session) and to Claude.
