# coding-agents-alignment — Claude Code Plugin

Ambient, zero-input GitHub Project alignment for Claude Code sessions.

## What it does

Automatically aligns coding work with a GitHub Project — no prompts, no dialogs, no interruptions.

1. You start a Claude Code session and give it a task
2. The plugin captures the prompt via `UserPromptSubmit` hook
3. On the first `Edit` or `Write`, it auto-creates a GitHub issue (with you as assignee) and adds it to the project as **In Progress** — or links an existing item by branch name
4. When a PR is detected or work lands on the default branch → **Done**

## Install

```bash
ln -s /path/to/coding-agents-alignment/claude-code-plugin ~/.claude/plugins/coding-agents-alignment
```

## Configure

Create `.coding-agents-alignment.json` in your repo root:

```json
{
  "githubOwner": "your-org",
  "githubProjectNumber": 1,
  "repo": "your-repo"
}
```

Same config format as the pi package — see the [main README](../README.md) for all options.

## Requirements

- `gh` CLI authenticated (`gh auth login`)
- Node.js ≥ 18
- GitHub Project with a `Status` single-select field (`Todo` / `In Progress` / `Done`)

## Hooks

| Hook | Trigger | Action |
|------|---------|--------|
| `UserPromptSubmit` | Every prompt | Capture prompt text, set `pending` |
| `PostToolUse` (Edit/Write) | Code changes | Create/link issue, set In Progress |
| `PostToolUse` (Bash) | Shell commands | Check for PR/merge → Done |
| `Stop` | Agent stops | Final finish check |

## Commands

| Command | Description |
|---------|-------------|
| `/align` | Re-enable alignment after `/align-unlink` |
| `/align-status` | Show current alignment state |
| `/align-finish` | Force aligned item to Done |
| `/align-unlink` | Stop alignment for this session |
| `/align-resync` | Re-sync aligned item with GitHub |

## State

Per-session state stored in `~/.cache/coding-agents-alignment/<session-id>.json`.

## Notes

- Creates real GitHub issues (not drafts) with current user as assignee
- Falls back to draft items if issue creation fails
- Failures are non-fatal — coding is never blocked
- Read-only sessions (no edits) don't create project items
