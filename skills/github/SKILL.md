---
name: github
description: "GitHub project and tasks by the AGENTS.md canon in one command — `task next` (the entry: the state and one next step); `project check` and `project fix` (the project, the default-branch rule, rebase-only merge); `task new` (a task with all its fields); `task start`, `task show`, `task answer` and `task edit`; `task status`, `task drop`; `task finish` (the tail: PR to close), `task actualize` and `task close` after a merge; `task queue` and `batch release` for a dispatcher session; `pr labels`, `pr premerge` (a red PR or a red base). When — once per session before task work; creating a task or subtask; a PR opened, green or merged; taking, reading, finishing, reopening or cancelling a task; an answer to a task's question; 'do all tasks of epic #M', 'fix all High bugs'; asked whether the project is set up, why a task isn't in Done or on the board, why GitHub won't merge a PR — even if 'project' and 'task' weren't said."
allowed-tools: Bash(bun *skills/github/scripts/github.ts *) Bash(git remote get-url *)
---

# github — project and tasks by the canon, not from memory

Principles — `AGENTS.md`, "Task tracking"; the full rules (types,
decision labels, epics, dependencies, the project, milestones, the five
epic-refresh checks) and what each command below checks, sets and prints —
`reference.md` next to this file.
The script `scripts/github.ts` checks the project
against the canon, fixes what the API can, and does each task step in one
command. Syntax — the blocks below: call without `--help` first, a call
error prints the corrected command whole. Editing an existing task (Priority, links) and
milestones — `reference.md`, "Manual commands".

**In Claude Code — at once a separate unsandboxed call**
(`dangerouslyDisableSandbox`): `gh` fails on TLS in the sandbox, `task close`
also calls Docker for the task's stacks — the sandbox denies its socket
(`claude/CLAUDE.md`; `SKILL.md` of the task-env skill, "Checked on the machine").

## Project — check and fix

```bash
bun --no-env-file <skill dir>/scripts/github.ts project check [--repo owner/repo]
bun --no-env-file <skill dir>/scripts/github.ts project fix [--repo owner/repo] [--confirm] [--create [--template owner/N | none]]
```

The repository — from `git remote get-url origin` or `--repo`, under its
current name: a renamed repository's former name resolves to it. Needs `gh` with
the `project` scope (`gh auth refresh -s project`); the organization's issue
types — `admin:org`.

| Moment | Action |
|---|---|
| Session start, before working with tasks | `project check` — once per session |
| `check` gave ❌ | `project fix` → UI steps → confirmations → `check` again |
| Repository without a project | the board is optional: `check` — an `○` line, code 0; the tasks go by the facts (`reference.md`, "Project"); the owner wants one — `project fix --create`: links the owner's project of the same name, otherwise copies the template, otherwise creates one |

Codes: `0` — everything per the canon (for `fix` — and no steps left), `1` —
there are ❌, steps or errors, `2` — a call or access error, or a Claude Code
cloud session (`CLAUDE_CODE_REMOTE=true`): the flow runs only in a local one.

`fix` prints `+` lines — done via the API; **UI steps** — calling `fix` is
permission to configure this repository's project: the agent goes through the
steps itself, in a browser where the user is signed in to GitHub, without
asking separately; no browser or sign-in — a list of steps with links for the
user; the agent doesn't enter a password; after the steps — `check` again;
**Confirmation needed** — show the list to the user, after a "yes" —
`fix --confirm`; `!` — an error with the reason, most often `gh` lacks a
scope. The eleven items checked, who does what, the UI steps and the API's
gaps — `reference.md`, "Project check and fix".

## Tasks and PRs — one entry: `task next`

```bash
bun --no-env-file <skill dir>/scripts/github.ts task next [<N>]
```

**Call `task next` and do what it prints** (#842): by the facts — the task,
its questions and its epic's, the checkout's task branch, the PR and its
checks, `pr premerge` on its head, the batch, the deploy, the epic refresh,
the close — the state in one line and exactly one next step, a ready command
(run it as a separate call, no pipeline). A step that waits for the owner (an
answer, a «yes» to the merge outside auto) or the dispatcher (a batch's
release) is named so; a closed task — `none`. Without `<N>` — the checkout's
task branch, otherwise the session's pinned task. Every task command ends
with the same `Next:` line — after any of them do its `Next:`, not a step
from memory. Exit codes of every command: `0` — done, `1` — a step (its
`Next:` says which), `2` — an error (a call error prints the corrected
command). The commands themselves — `github --help`, `<command> --help`;
what each checks, sets and prints — `reference.md`, "Task and PR commands".

What starts outside a task's path, so `task next` doesn't name it:

- **A new task, an epic's subtask, an epic** — first whether one already
  exists (`gh issue list --search`), then `task new --title "…" [--epic N]
  [--body-file F] …`; in a session with a task — the question to the owner
  «queue #N?», "yes" — its executor at once (`task new` prints its prompt).
- **"Do all tasks of epic #M", "fix all High bugs", a new epic — the owner's
  "yes"** — the session is a dispatcher: `task queue --epic M` (below,
  "Dispatcher").
- **Won't do, duplicate, replaced by others** — `task drop N
  [--duplicate-of M]`.
- **The session resumed after the app restarted** — the `SessionStart` hook
  runs `task resume`: run the command its line names, a background wait died
  with the process.
- **An answer from chat or a comment** — `task answer N k "<answer>"` (auto —
  `--auto`) before the code it changes; a description edit — `task edit N`,
  not `--body-file`.

What the agent gets wrong without the details (all of them — `reference.md`,
"Task and PR commands"):

- **`task new`** — `--labels`: a decision from the default branch — by name
  (`billing`), a new decision — `kind:name` (`capability:export`), a regular
  or slice label — by name, it must exist. The `questions` label — `task new` itself, when the
  description has a question without ✅. Everything is checked before
  creating: an error (code 2) leaves no half-made task.
- **`task answer`** — a question with ✅ is refused: a changed answer — `task
  edit --replace`.
- **`task status`** — In progress pins the task to the session: a second
  task is refused (code 2) with «queue #M?» and its executor's prompt; an
  executor's handed-out task isn't pinned; a mistaken pin — a human deletes
  its file. `--branch` (In progress, not an epic) renames the branch with its
  `.git/config` section, not a bare `git branch -m`; a lock still held — a
  `!` line with the command that finishes it, code 1.
- **`pr premerge`** — from a repository checkout, a separate call. Not `0` —
  don't merge: its `Next:` names the fix in the PR or, when **`main` is red,
  not this PR**, the wait for its one bug — don't fix it in the PR: the
  printed `wait-ci.sh issue <N>` (the `ci-wait` skill, as a background
  command), or the printed `task new --type Bug` command and «queue it?», then
  `premerge` again (`reference.md`, "Red main").
- **`task actualize`** (`task finish` calls it) — the mechanics itself, then
  the subagent's prompt: its two lines, as is; the subagent prints its
  assignment itself (`--assignment`, outside the sandbox). `○ refresh not
  needed` — no subagent.
- **`task close`** — only after the PR is merged (or a close without a PR):
  an open PR is refused before any changes, a merged PR GitHub didn't link is
  found by itself — no manual `gh issue close`. Refused until the refresh
  subagent reports on the epic. A wait with a code other than
  0 — the `RESULT:` line in its output file. It doesn't delete the session's worktree; `--no-git`
  — without the git step. Its last output line — the end-of-session steps;
  then the last line of the answer, one of three (wording in the project
  language — `AGENTS.md`, "Language"): `All done. The session can be closed.`;
  the owner has something to decide — `All done, but there are questions: …`
  with the questions themselves; something remains — `Remaining: …`. In auto
  mode after the first — archiving the session where the agent has the tool,
  after the other two — no; information without a decision isn't a question.

### Dispatcher

"Do all tasks of epic #M", "fix all High bugs", a "yes" to «run the
dispatcher on epic #M?» (`AGENTS.md`, "Session and branch — one task"): any
session, its own task stays pinned; one started for it — in the project
folder, not a worktree: executors start from `main`. `task queue` prints ready
tasks, each with an indented line — its executor's prompt. In Claude Code: an executor — `Agent` with
`isolation: "worktree"` and `run_in_background: true`, the prompt — as
is; at most the machine's executors at once, the owner's number replaces
it; another project's task — an app session in
its folder (`start_session`, own worktree);
`=` — a task in work, its line says why, not launched again. A batch project
(`"batch": true` in `.agents/elves.json`) — executors merge into the batch
branch without CI (`reference.md`, "task queue"), the owner's «past the
batch» — `--assignment N --main`: a PR into `main`; `batch release` takes it
into `main` once the queue's `Next:` names it or on the owner's «release»:
one CI run, one refresh per epic. The owner's group — `--tasks`. Before each launch —
`get_usage` (its limit — `reference.md`, "task queue"). After each executor's answer — `task queue` again: it alone
removes finished executors' worktrees (`+`), not `git worktree remove`; its last line names the step:
an executor session whose task closed — the dispatcher archives it in an
auto project, not one still working in the background or awaiting the
owner's answer; outside auto the owner closes it. A question — to the
owner in text; the answer — ✅ in the task and to the same
executor with `SendMessage`. After the app restarts — `task resume`: each stopped executor
continued, not replaced. Waits for subagents — it answers again. Failed — a
task comment, no restart (the owner's restart, external blockers —
`reference.md`, "task queue", "Dependencies"). Queue empty and nothing running — the summary, the last
line (a session with its own task — after it) and, in auto mode, archiving. The executor's side (`--assignment`;
`--session`) — `reference.md`, "task queue".

## Git, PRs and merging — mechanics

Principles — `AGENTS.md`, "Git, PRs and merging"; the full rules —
`reference.md`, "Git, PRs and merging — full rules". Waiting for checks, the
full SHA and a merge that deploys — `docs/pr-checks.md`.

- **Merge — rebase only:** `gh pr merge <N> --rebase`; each commit of the
  branch lands in `main` — a conventional commit with `Refs #N`.
- **Merge without a queue:** as soon as the PR's own CI is green and GitHub
  merges it without a conflict, a branch that fell behind too. Rebase onto
  `origin/main` and `git push --force-with-lease` (not `--force`) — only on a
  textual conflict or my own changes; someone else's branch rule with strict —
  rebase, not `gh pr merge --admin`. **Before merging — `github pr premerge
  <N>`** (after `ci-wait` PASS).
- **Before a push** — `git branch --show-current`: my own branch, not the
  local `main`.
- **Merge in auto mode in Claude Code — as a separate call:**
  `gh pr merge <N> --rebase` — the whole command, without `cd`, a pipeline,
  `;` or `&&`: the owner's rule `Bash(gh pr merge *)` must match each part.
  Exit code `0` — merged. Refused even as a separate call — I don't retry the
  merge or push it through in another form; `Remaining: merge — from the
  owner`. The agent doesn't widen its own permission settings.
- **After such a merge `gh pr view` isn't needed:** the merge SHA is taken by
  `wait-ci.sh merged <N>`, `task close <N>` reads the PR itself; a read still
  needed — a narrow `gh pr view <N> --json state` as a separate call; refused —
  not repeated, not in another form.
- **Right after a PR merge — I delete what was merged entirely, without
  asking** (a `github task close` step): the checkout moves off the merged
  branch to `origin/main` detached, the local and remote branches, the task's
  Compose stacks with their volumes, my own worktrees. "Merged" — by the PR or
  `git cherry origin/main <branch>`, not `git branch --merged`. Others'
  branches, worktrees of live sessions, unmerged work — never. The next task —
  not in this session.
- `gh pr merge --delete-branch` from a worktree leaves the local branch — not
  a merge error: `gh pr view <N> --json state`, no repeated merge.
