# Coding Agents Alignment Tool Spec

## Purpose

`coding-agents-alignment` keeps coding-agent work aligned with a GitHub Project item with minimal user involvement.

The tool must treat planning as real work, create or link a project item early, keep the project state in sync with actual implementation progress, and avoid interrupting the user.

This spec covers:

- shared product behavior for `pi` and Claude Code
- project and issue lifecycle
- task-switching rules
- planning artifact capture
- configuration
- failure handling
- acceptance criteria

## Product Principles

- Planning is first-class work and must be tracked explicitly.
- The unit of work is a distinct task, not a session.
- Tracking is ambient by default.
- Failures must never block the coding workflow.
- Branch continuity is the strongest implementation-phase identity signal.
- Read-only investigation is valid tracked work and should remain in `Planning` until implementation starts.

## Scope

The spec applies to both supported platforms:

- `pi`
- Claude Code

Behavior must be shared across platforms. Hook wiring and persistence details may differ by platform.

## Non-Goals

- The tool does not require explicit confirmations for normal lifecycle changes.
- The tool does not manage review workflow as a separate project status.
- The tool does not attempt to track every conversational turn as a separate task.
- The tool does not block the user on auth, config, or network problems.

## Core Concepts

### Unit Of Work

A unit of work is one distinct user task.

Examples:

- "plan and implement OAuth callback handling"
- "debug why the extension does not load"
- "write the tool spec for alignment behavior"

A single agent session may contain multiple units of work. Each distinct task must map to its own GitHub Project item.

### Backing Content Model

The tool should prefer creating a real GitHub issue and then adding it to the project.

Required behavior:

- create a real issue when possible
- assign the current GitHub user to that issue when possible
- add the issue to the configured GitHub Project
- fall back to a draft project item if issue creation fails

Minimum managed metadata:

- project `Status`
- project `Repo`
- project `Branch`
- project `PR URL`
- project `Agent`
- issue assignee when the item is backed by a real issue
- issue title
- issue body

## Shared Lifecycle

### Project Statuses

The project must use these statuses:

- `Planning`
- `In Progress`
- `Done`

There is no `In Review` state in this spec.

### Internal Tracking States

The implementation may use internal states as needed, but it must support the following conceptual states:

- `idle`: no active tracked task
- `planning`: active task exists and project item status is `Planning`
- `in_progress`: active task exists and project item status is `In Progress`
- `done`: active task exists and project item status is `Done`
- `unlinked`: alignment is disabled for the current session
- `error_backoff`: non-blocking failure state with retry eligibility

The internal state model may be more detailed than this as long as external behavior matches the spec.

### State Transitions

Normal lifecycle:

1. first substantive task prompt
2. create or link item in `Planning`
3. planning, brainstorming, investigation, or read-only work continues in `Planning`
4. first implementation signal promotes item to `In Progress`
5. merged to default branch promotes item to `Done`

Manual override:

- `/align` may force immediate creation or relinking of the current task
- `/align-finish` may force `Done`
- `/align-unlink` disables further alignment for the current session
- `/align-resync` forces a fresh sync with GitHub

## Event Model

### 1. Substantive Prompt Detection

On the first substantive user task prompt for a distinct task, the tool must create or link a project item and set project `Status = Planning`.

Substantive prompts include:

- requests to plan, investigate, debug, design, brainstorm, spec, or implement a concrete task
- follow-up requests that materially clarify the task

Non-substantive prompts should not create a new item:

- greetings
- chit-chat
- generic capability questions not tied to current repo work
- short continuation turns that clearly refine the current task

### 2. Planning Phase

While the task remains exploratory or read-only, the item must stay in `Planning`.

This includes:

- brainstorming with the agent
- implementation planning
- reading code
- tracing behavior
- running tests or commands for diagnosis
- writing planning notes or specs

### 3. Promotion To In Progress

The tool must promote the active task from `Planning` to `In Progress` when implementation begins.

Implementation signals:

- first code-changing tool action such as `Edit` or `Write`
- any equivalent platform-specific file mutation
- optionally, a manual `/align` execution if implementation has already started outside normal hooks

Read-only actions alone must not promote the item to `In Progress`.

### 4. Done Detection

The tool must mark the active item `Done` only when one of the following is true:

- the work is merged into the default branch
- the default branch already contains the relevant branch changes
- the user explicitly runs `/align-finish`

The following must not mark an item `Done` by themselves:

- local commits
- pushed commits
- open PR
- closed but unmerged PR
- agent stop

If a PR exists but is not merged, the item must remain `In Progress`.

## Task Identity And Switching

### Distinct Task Rule

The tool must track each distinct task as a separate item, even within the same session.

### Automatic Task Switching

If the user appears to switch to a different task, the tool must switch automatically without confirmation.

Expected behavior:

- detect likely task switch from a new substantive prompt
- stop treating the previous task as active
- create or link the new task in `Planning`
- preserve the old task's last known state as-is

The previous task must not be auto-marked `Done` unless done criteria were actually met.

### Task Switch Heuristics

The implementation should use a conservative heuristic that favors continuity during implementation and switches only on clearly new substantive prompts.

Recommended heuristic order:

1. if the current branch matches an existing project item, prefer that item as the active implementation task
2. if a new prompt clearly requests a different outcome than the current active item title or summary, start a new task
3. if the prompt is an obvious continuation, refinement, or substep of the active task, keep the current task

Signals that strongly indicate a new task:

- new bug or feature request unrelated to the current item summary
- explicit "now" transition to a different area of the codebase or deliverable
- a prompt that would naturally deserve a separate issue title

Signals that should not trigger a switch:

- clarification on the same task
- implementation detail questions for the same task
- additional debugging steps for the same task
- asking for tests, docs, or cleanup for the same task

## Existing Branch Match Behavior

If the current branch already maps to an existing project item, the tool must always link to that item and treat it as the active task.

Implications:

- branch-linked continuity overrides prompt-only inference once implementation is branch-scoped
- if a branch item is found while creating or switching tasks, reuse it instead of creating a duplicate item
- if the linked branch item has `Planning`, the tool may promote it to `In Progress` when implementation begins
- if the linked branch item is already `Done`, the tool should relink only if the branch is still the active branch and the user is clearly continuing the same work; otherwise create a new task on a new branch or wait for stronger evidence

## Planning Artifacts

### Goal

When work transitions from `Planning` to `In Progress`, the tool should attach the planning output generated during planning to the backing issue.

Primary artifact type:

- changed Markdown files related to the current task

### Default Artifact Selection Rule

On `Planning` to `In Progress`, the tool must collect Markdown artifacts using this default rule:

- include `.md` files in the repo that are currently changed in git at the time of transition

This includes:

- staged changes
- unstaged changes
- newly added Markdown files

This excludes:

- unchanged Markdown files
- deleted Markdown files, unless explicitly supported in the manifest
- Markdown files outside the repo

### Attachment Semantics

Because GitHub issues do not natively support arbitrary local-file attachment in the same way as a file upload workflow, "attach" in this spec means "associate the planning artifacts with the issue in a durable, reviewable form."

Required behavior:

- add a planning-artifacts section to the issue thread when promoting to `In Progress`
- include the relative repo path for each selected Markdown file
- include enough information for a reviewer to find and inspect the artifact later

Recommended implementation:

- if the item is backed by a real issue, add an issue comment titled `Planning Artifacts`
- if the item is only a draft item, append the artifacts manifest to the draft body if supported, otherwise skip with no user interruption

Recommended manifest content per file:

- relative path
- current git status code
- current blob link if a committed blob or pushed URL can be resolved
- optional inline excerpt or full content snapshot, subject to size limits

### Artifact Limits

Recommended defaults:

- only attach Markdown artifacts once per `Planning` to `In Progress` transition
- cap total inlined artifact content size
- if content exceeds the cap, include a manifest entry without full inline content

Suggested config keys:

- `artifactGlobs`
- `artifactMaxFiles`
- `artifactInlineMaxBytes`
- `attachPlanningArtifacts`

## Issue Content

### Title

The title must be a concise task summary inferred from the substantive user prompt.

Good examples:

- `Fix extension loading conflict`
- `Write alignment lifecycle tool spec`
- `Investigate login race condition`

### Body

The issue body must be structured and short, but preserve planning context.

Required sections:

- goal or requested behavior
- important constraints
- planning notes captured from the conversation
- repo, branch, and agent metadata when available

Recommended template:

```md
## Goal
<concise summary of requested outcome>

## Constraints
<important user constraints, if any>

## Planning Notes
<captured planning and brainstorming notes>

## Context
- Repo: <repo>
- Branch: <branch>
- Agent: <agent>
```

The body should evolve conservatively:

- initial creation should include the best available task summary and early planning context
- promotion to `In Progress` may append a planning-artifacts reference
- resync should update metadata fields without rewriting the body unless explicitly needed

## Visibility And UX

Default visibility must be fully ambient.

Default behavior:

- no routine prompts
- no confirmation dialogs
- no success chatter on normal create, link, promote, or done transitions

Visibility must be configurable through the repo config file.

Recommended config:

- `visibility: "silent" | "status" | "verbose"`

Expected modes:

- `silent`: only diagnostics commands expose state or failures
- `status`: lightweight status updates for transitions
- `verbose`: transition and retry notifications

Default:

- `silent`

## Failure Handling

Failures must be non-blocking and mostly silent.

Failure examples:

- missing GitHub auth
- missing or invalid config
- missing project fields
- GitHub API errors
- network failures
- worker subprocess failures

Required behavior:

- never block editing, writing, or command execution
- preserve enough local state to retry later
- retry on the next relevant lifecycle event
- expose diagnostics via explicit command

Recommended failure policy:

- first failure: record locally and remain eligible for retry
- repeated failures: enter backoff
- permanent config errors: suppress repeated retries until config changes or `/align-resync`

Recommended diagnostics surface:

- `/align-status` shows current task, project item, last sync result, and last error if any

## Commands

The command surface should remain:

- `/align`
- `/align-status`
- `/align-finish`
- `/align-unlink`
- `/align-resync`

Expected semantics:

### `/align`

- if no active item exists, create or link the current task immediately in `Planning`
- if an active item already exists, relink or report current alignment state

### `/align-status`

- show active task summary
- show project item identity
- show project status
- show repo, branch, and PR URL if known
- show last sync error if present

### `/align-finish`

- force active item to `Done`

### `/align-unlink`

- disable alignment for the current session
- do not mutate the current project item

### `/align-resync`

- refresh git state
- refresh project item linkage
- repair missing item references where possible
- push the current metadata back to GitHub

## Configuration

### Required

- `githubOwner`
- `githubProjectNumber`

### Existing Keys To Preserve

- `repo`
- `repoPath`
- `statusFieldName`
- `repoFieldName`
- `branchFieldName`
- `prUrlFieldName`
- `agentFieldName`
- `finishCheckIntervalMs`

### Status Configuration

The config model should be updated to support:

```json
{
  "statuses": {
    "planning": "Planning",
    "inProgress": "In Progress",
    "finished": "Done"
  }
}
```

Compatibility guidance:

- existing `statuses.todo` should be treated as legacy
- migration should prefer `statuses.planning` when present
- if only `statuses.todo` exists, interpret it as the planning status during upgrade

### New Recommended Config Keys

```json
{
  "visibility": "silent",
  "attachPlanningArtifacts": true,
  "artifactGlobs": ["**/*.md"],
  "artifactMaxFiles": 20,
  "artifactInlineMaxBytes": 32768
}
```

Config semantics:

- `visibility`: user-facing output level
- `attachPlanningArtifacts`: enable Markdown artifact association on promotion
- `artifactGlobs`: file patterns eligible for artifact capture
- `artifactMaxFiles`: cap number of attached artifacts
- `artifactInlineMaxBytes`: cap total inlined artifact content

Environment variable overrides may be added for new keys but are not required for the first implementation pass.

## Platform Integration

### Shared Behavior

Both platforms must implement the same lifecycle and decision rules.

### Claude Code

Recommended event mapping:

- `UserPromptSubmit`: substantive prompt detection and planning creation or task switch
- `PostToolUse` for code-changing tools: promotion to `In Progress`
- `PostToolUse` for shell commands: done detection and periodic resync
- `Stop`: final done check and state persistence

### pi

Recommended event mapping:

- prompt capture or equivalent session-input hook: substantive prompt detection and planning creation or task switch
- file mutation hook: promotion to `In Progress`
- shell or git observation hook: done detection
- session stop hook: final sync attempt

## Data Model Requirements

The persisted session state should be extended to support task-centric tracking.

Recommended fields:

- `activeTaskId`
- `activeTaskTitle`
- `activeStatusKey`
- `activeContentId`
- `activeContentUrl`
- `repo`
- `branch`
- `prUrl`
- `recentPrompts`
- `planningNotes`
- `artifactCandidates`
- `lastSyncAt`
- `lastFinishCheckAt`
- `lastError`
- `lastErrorAt`
- `retryCount`
- `mode`

If historical task switching is needed later, a `tasks[]` structure may be added, but it is not required for the first pass.

## Matching And Deduplication

To avoid duplicate items, the tool should attempt reuse in this order:

1. exact active branch match in the GitHub Project
2. existing linked item already persisted in session state
3. explicit content id from previous sync state
4. otherwise create a new item

Prompt-text similarity alone should not be used as the primary deduplication key once a branch exists.

## Acceptance Criteria

### Planning Creation

- Given a substantive new task prompt in an aligned repo, the tool creates or links a project item in `Planning`.
- Given a read-only investigation session, the item remains `Planning`.

### Promotion

- Given an item in `Planning`, the first code-changing action promotes it to `In Progress`.
- Promotion does not happen on read-only commands alone.

### Done

- Given an open PR with no merge, the item remains `In Progress`.
- Given a merge to the default branch, the item becomes `Done`.
- Given `/align-finish`, the item becomes `Done` even without a merge.

### Task Switching

- Given a new substantive task in the same session, the tool creates or links a new item automatically without confirmation.
- Given a continuation of the same task, the tool does not create a new item.

### Branch Reuse

- Given a branch already linked to a project item, the tool links that item instead of creating a duplicate.

### Planning Artifacts

- Given changed Markdown files at the moment of `Planning` to `In Progress`, the tool associates those artifacts with the issue thread.
- Given no changed Markdown files, promotion succeeds without artifacts.

### Failure Handling

- Given missing GitHub auth or project config, the user can continue working uninterrupted.
- Given a transient GitHub failure, the tool records the error and retries later.
- Given repeated permanent config failures, the tool backs off and exposes diagnostics through `/align-status`.

## Migration Notes

This spec changes the current conceptual behavior in several important ways:

- create or link on first substantive prompt instead of first code change
- replace `Todo` with `Planning` as the pre-implementation project status
- keep read-only work tracked in `Planning`
- treat each distinct task as a separate item
- switch tasks automatically without confirmation
- do not mark items `Done` on PR creation
- optionally attach planning Markdown artifacts when implementation begins

Any implementation update should revise the README and platform-specific docs to match these semantics after the behavior lands.
