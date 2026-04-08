# coding-agents-alignment

Ambient GitHub Project alignment for coding agents. Zero input required — work is automatically aligned as issues in a GitHub Project.

Works with **[pi](https://github.com/badlogic/pi-mono)** and **Claude Code**.

## How it works

1. Agent session starts, user gives a task
2. The extension captures the prompt silently
3. On the first substantive task prompt, it auto-creates a GitHub issue (with the current user as assignee) and adds it to the project as **Planning** — or links an existing item by branch name
4. On the first code-changing action, it moves the item to **In Progress** and, when possible, comments changed Markdown planning artifacts onto the issue
5. When work lands on the default branch → **Done**

No prompts. No dialogs. No interruptions.

## Install

### pi

```bash
pi install git:github.com/bohdanpodvirnyi/coding-agents-alignment
```

### Claude Code

```bash
ln -s /path/to/coding-agents-alignment/claude-code-plugin ~/.claude/plugins/coding-agents-alignment
```

See [`claude-code-plugin/README.md`](./claude-code-plugin/README.md) for Claude Code–specific details.

## Configure

Create `.coding-agents-alignment.json` in your repo root:

```json
{
  "githubOwner": "your-org",
  "githubProjectNumber": 1,
  "repo": "your-repo"
}
```

### All options

| Key | Default | Description |
|-----|---------|-------------|
| `githubOwner` | — | GitHub user or org that owns the project |
| `githubProjectNumber` | — | Project number (visible in project URL) |
| `repo` | inferred from git | Display name for the repo field |
| `repoPath` | — | Relative path to the git repo (for multi-repo workspaces) |
| `statusFieldName` | `"Status"` | Name of the single-select status field |
| `repoFieldName` | `"Repo"` | Name of the repo text field |
| `branchFieldName` | `"Branch"` | Name of the branch text field |
| `prUrlFieldName` | `"PR URL"` | Name of the PR URL text field |
| `agentFieldName` | `"Agent"` | Name of the agent text field |
| `statuses.planning` | `"Planning"` | Label for the planning status |
| `statuses.inProgress` | `"In Progress"` | Label for the in-progress status |
| `statuses.finished` | `"Done"` | Label for the finished status |
| `visibility` | `"silent"` | Ambient output level: `silent`, `status`, or `verbose` |
| `attachPlanningArtifacts` | `true` | Comment changed Markdown planning artifacts when promoting to `In Progress` |
| `artifactMaxFiles` | `20` | Maximum Markdown artifact files to include |
| `artifactInlineMaxBytes` | `32768` | Max total inlined artifact bytes in the planning comment |
| `finishCheckIntervalMs` | `60000` | Throttle for finish detection checks |

Every key can be overridden with env vars: `CODING_AGENTS_ALIGNMENT_GITHUB_OWNER`, `CODING_AGENTS_ALIGNMENT_GITHUB_PROJECT_NUMBER`, `CODING_AGENTS_ALIGNMENT_REPO`, `CODING_AGENTS_ALIGNMENT_REPO_PATH`, etc.

## GitHub Project setup

Your project needs these fields:

| Field | Type | Purpose |
|-------|------|---------|
| `Status` | Single select | `Planning` → `In Progress` → `Done` |
| `Repo` | Text | Which repo the work is in |
| `Branch` | Text | Git branch name |
| `PR URL` | Text | Pull request URL |
| `Agent` | Text | Which agent did the work |

Items are created as real GitHub issues (with assignee), not drafts. Falls back to drafts if issue creation fails.

## State machine

```text
idle → pending (prompt captured) → aligned (issue created/linked)
                                       ↓
                              inProgress → finished
```

## Commands

### pi

| Command | Description |
|---------|-------------|
| `/align` | Re-enable alignment, or start tracking current work immediately |
| `/align-status` | Show current alignment state |
| `/align-finish` | Force aligned item to Done |
| `/align-unlink` | Stop alignment for this session |
| `/align-resync` | Re-sync aligned item with GitHub |

Examples:

```text
/align
```

Start tracking immediately, even before the first edit/write. If you don't pass text, alignment infers a title from recent session prompts.

```text
/align fix extension loading conflict
```

In pi, optional text seeds the issue title/summary when you want to start tracking manually.

### Claude Code

Same commands, same names.

Example:

```text
/align
```

Useful when you want to create/link the project item right away instead of waiting for the first substantive prompt hook to do it automatically.

## Requirements

- `gh` CLI authenticated (`gh auth login`)
- Node.js ≥ 18

## Development

```bash
npm install
npm run check
```

## License

MIT
