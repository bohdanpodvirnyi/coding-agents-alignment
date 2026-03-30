# pi-agents-alignment

Ambient GitHub Project tracking for `pi` sessions.

## What it does

This package adds a `pi` extension that can:
- ask once when durable work starts
- create or link a GitHub Project draft item
- warn on likely overlap with `Todo` / `In Progress`
- move the item to `In Progress` on first `edit` / `write`
- move the item to `Finished` when a PR appears or work lands on the default branch
- expose manual commands like `/track`, `/track-status`, `/track-resync`

v0 scope:
- `pi` only
- one GitHub Project
- one repo at a time
- explicit user enrollment

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

Create `.pi-agents-alignment.json` in your repo root.

```json
{
  "githubOwner": "bohdanpodvirnyi",
  "githubProjectNumber": 1,
  "repo": "hos-agent"
}
```

Optional keys:
- `statusFieldName`
- `repoFieldName`
- `branchFieldName`
- `prUrlFieldName`
- `agentFieldName`
- `statuses.todo`
- `statuses.inProgress`
- `statuses.finished`
- `askKeywords`
- `finishCheckIntervalMs`

You can also override with env vars:
- `PI_ALIGNMENT_GITHUB_OWNER`
- `PI_ALIGNMENT_GITHUB_PROJECT_NUMBER`
- `PI_ALIGNMENT_REPO`
- `PI_ALIGNMENT_STATUS_FIELD`
- `PI_ALIGNMENT_REPO_FIELD`
- `PI_ALIGNMENT_BRANCH_FIELD`
- `PI_ALIGNMENT_PR_URL_FIELD`
- `PI_ALIGNMENT_AGENT_FIELD`
- `PI_ALIGNMENT_STATUS_TODO`
- `PI_ALIGNMENT_STATUS_IN_PROGRESS`
- `PI_ALIGNMENT_STATUS_FINISHED`

## GitHub Project requirements

Expected fields:
- `Status` — single select
- `Repo` — text
- `Branch` — text
- `PR URL` — text
- `Agent` — text

Default statuses expected:
- `Todo`
- `In Progress`
- `Finished`

Project items are created as **draft items**.

## Commands

- `/track`
- `/track-status`
- `/track-finish`
- `/track-unlink`
- `/track-resync`

## Dev

```bash
npm install
npm run check
```

## Notes

- Uses local `gh` auth; no GitHub App.
- GitHub sync runs in a separate worker process.
- Failures are non-fatal; coding continues.
- v0 intentionally keeps state coarse: `Todo`, `In Progress`, `Finished`.
