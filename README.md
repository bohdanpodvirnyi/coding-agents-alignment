# pi-agents-alignment

Ambient, zero-input GitHub Project tracking for `pi` sessions.

## What it does

Automatically tracks coding work in a GitHub Project — no prompts, no enrollment dialogs, no interruptions.

**How it works:**

1. You start a `pi` session and give it a task
2. The extension silently captures the prompt
3. On the first `edit` or `write`, it auto-creates a GitHub Project draft item (or links an existing one by branch name) and sets status to **In Progress**
4. When a PR is detected or work lands on the default branch → **Done**
5. A small footer indicator shows tracking state — that's it

**Design principles:**
- **Zero user input** — never prompts, asks, or blocks
- **Fail silently** — GitHub API issues log a warning, coding continues
- **Smart defaults** — auto-detects repo, branch, generates title from prompt
- **Branch matching** — if a Project item already references the current branch, it links instead of creating a duplicate

## Install

### From git

```bash
pi install git:github.com/bohdanpodvirnyi/pi-agents-alignment
```

### Local dev

```bash
pi install /absolute/path/to/pi-agents-alignment
```

## Configure

Create `.pi-agents-alignment.json` in your repo root:

```json
{
  "githubOwner": "bohdanpodvirnyi",
  "githubProjectNumber": 1,
  "repo": "hos-agent"
}
```

Optional keys:
- `statusFieldName` (default `"Status"`)
- `repoFieldName` (default `"Repo"`)
- `branchFieldName` (default `"Branch"`)
- `prUrlFieldName` (default `"PR URL"`)
- `agentFieldName` (default `"Agent"`)
- `statuses.todo` (default `"Todo"`)
- `statuses.inProgress` (default `"In Progress"`)
- `statuses.finished` (default `"Done"`)
- `finishCheckIntervalMs` (default `60000`)

Env var overrides: `PI_ALIGNMENT_GITHUB_OWNER`, `PI_ALIGNMENT_GITHUB_PROJECT_NUMBER`, `PI_ALIGNMENT_REPO`, etc.

## GitHub Project requirements

Expected fields:
- `Status` — single select with `Todo`, `In Progress`, `Done`
- `Repo` — text
- `Branch` — text
- `PR URL` — text
- `Agent` — text

## State machine

```
idle → pending (prompt captured) → tracked (item created/linked)
                                       ↓
                              inProgress → finished
```

- **idle** — no config found, or session just started
- **pending** — prompt captured, waiting for first code change
- **tracked** — GitHub Project item created or linked
- **unlinked** — user explicitly stopped tracking via `/track-unlink`

## Footer indicator

- `📋 tracking…` — prompt captured, waiting for edits
- `📋 ● Title` — actively tracking (In Progress)
- `📋 ✓ Title` — work finished (Done)

## Commands

| Command | Description |
|---------|-------------|
| `/track` | Re-enable tracking after `/track-unlink` |
| `/track-status` | Show current tracking state |
| `/track-finish` | Force tracked item to Done |
| `/track-unlink` | Stop tracking for this session |
| `/track-resync` | Re-sync tracked item with GitHub |

## Dev

```bash
npm install
npm run check
```

## Notes

- Uses local `gh` auth; no GitHub App required
- GitHub sync runs in a background worker process
- Failures are non-fatal; coding is never blocked
- Read-only sessions (no edits) don't create project items
- Items are created as draft issues in the GitHub Project
