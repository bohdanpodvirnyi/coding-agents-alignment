# pi-agents-alignment — Claude Code Plugin

Ambient, zero-input GitHub Project tracking for Claude Code sessions.

## What it does

Automatically tracks coding work in a GitHub Project — no prompts, no dialogs, no interruptions.

1. You start a Claude Code session and give it a task
2. The plugin captures the prompt via `UserPromptSubmit` hook
3. On the first `Edit` or `Write`, it auto-creates a GitHub issue (with you as assignee) and adds it to the project as **In Progress** — or links an existing item by branch name
4. When a PR is detected or work lands on the default branch → **Done**

## Install

### As a plugin (recommended)

Symlink or copy the plugin directory:

```bash
# Symlink
ln -s /path/to/pi-agents-alignment/claude-code-plugin ~/.claude/plugins/pi-agents-alignment

# Or copy
cp -r /path/to/pi-agents-alignment/claude-code-plugin ~/.claude/plugins/pi-agents-alignment
```

Then enable it in Claude Code settings or restart.

### Manual hooks

Add the hooks from `hooks/hooks.json` to your `.claude/settings.json` under the `hooks` key, replacing `${CLAUDE_PLUGIN_ROOT}` with the absolute path to this directory.

## Configure

Create `.pi-agents-alignment.json` in your repo root:

```json
{
  "githubOwner": "your-org",
  "githubProjectNumber": 1,
  "repo": "your-repo"
}
```

Same config format as the pi version. See the [main README](../README.md) for all options.

## Requirements

- `gh` CLI authenticated (`gh auth login`)
- Node.js (for tracker scripts)
- GitHub Project with `Status` field (Todo / In Progress / Done)

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
| `/track` | Re-enable tracking after `/track-unlink` |
| `/track-status` | Show current tracking state |
| `/track-finish` | Force tracked item to Done |
| `/track-unlink` | Stop tracking for this session |
| `/track-resync` | Re-sync tracked item with GitHub |

## State

Per-session state is stored in `~/.cache/pi-agents-alignment/<session-id>.json`.

## Notes

- Creates real GitHub issues (not drafts) — supports assignees
- Current `gh` user is auto-assigned to created issues
- Falls back to draft items if issue creation fails
- Failures are non-fatal — coding is never blocked
- Read-only sessions (no edits) don't create project items
