# coding-agents-alignment — Claude Code Plugin

Ambient, zero-input GitHub Project alignment for Claude Code sessions.

## What it does

Automatically aligns coding work with a GitHub Project — no prompts, no dialogs, no interruptions.

1. You start a Claude Code session and give it a task
2. The plugin captures the prompt via `UserPromptSubmit` hook
3. On the first substantive task prompt, it auto-creates a GitHub issue (with you as assignee) and adds it to the project as **Planning** — or links an existing item by branch name
4. On the first `Edit` or `Write`, it promotes the item to **In Progress** and, when possible, comments changed Markdown planning artifacts onto the issue
5. When work lands on the default branch → **Done**

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
- GitHub Project with a `Status` single-select field (`Planning` / `In Progress` / `Done`)

## Hooks

| Hook | Trigger | Action |
|------|---------|--------|
| `UserPromptSubmit` | Substantive task prompts | Create/link issue, set `Planning`, or switch tasks |
| `PostToolUse` (Edit/Write) | Code changes | Promote to `In Progress` |
| `PostToolUse` (Bash) | Shell commands | Check for merge-to-default → Done |
| `Stop` | Agent stops | Final finish check |

## Commands

| Command | Description |
|---------|-------------|
| `/align` | Re-enable alignment, or start tracking current work immediately |
| `/align-status` | Show current alignment state |
| `/align-finish` | Force aligned item to Done |
| `/align-unlink` | Stop alignment for this session |
| `/align-resync` | Re-sync aligned item with GitHub |

Example:

```text
/align
```

Use this when you want to start tracking manually before the prompt hook creates the item automatically.

## State

Per-session state stored in `~/.cache/coding-agents-alignment/<session-id>.json`.

## Notes

- Creates real GitHub issues (not drafts) with current user as assignee
- Falls back to draft items if issue creation fails
- Failures are non-fatal — coding is never blocked
- Read-only planning or investigation sessions stay in `Planning`
