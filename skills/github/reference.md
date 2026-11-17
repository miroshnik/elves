# github — canon reference: GitHub project and tasks

Principles — `AGENTS.md`, section "Task tracking". Here are the rules in force
in full: how tasks are organized (types, decision labels, epics, dependencies),
the GitHub project, milestones and the five epic-refresh checks on task close;
then the details of the skill's commands — what `project check` verifies and
`project fix` does, what each `task` and `pr` command checks, sets and prints —
and the full git, PR and merge rules; at the end — manual commands for what
the skill's commands don't cover (editing an already created task and
milestones). When to call each command and its syntax — `SKILL.md`; a
command's summary — `github <command> --help`. Examples use made-up owners and numbers.

## Task tracking — structure

- Tasks live in the project repository's **GitHub Issues** (the `github`
  skill: `task new`, `task status`, `task drop`), not in local lists,
  TODO files or the agent's built-in task list.
- **Every issue has a type** (the organization's Issue type, not a label) —
  exactly three: **Task** (the default: a unit of work for one PR), **Bug**
  (a defect: something that already exists works wrong), **Epic** (a big task
  with subtasks). There are no other types: the default Task/Bug are
  named in the project language (`issueTypes` in `locales/<language>.json`
  of the `github` skill), Feature is disabled. The type is set on creation
  (`github task new --type`); `github project fix` configures the
  organization's types. Repositories of a personal account have no types —
  there an epic gets the `epic` label; this is the only exception.
- **Decision labels** — the topic's name (folder `tests/<root>/<topic>` or a
  model module) without a kind prefix; a section of a topic has no label of
  its own — its changes label the topic; the kind is shown by color: capability
  green, standard blue, architecture orange; one name across different kinds
  is one label. A code task carries the label of every decision it introduces
  or changes (`github task new --labels`, from the PR diff —
  `github pr labels <PR>`; a mechanical edit — a deletion, a rename without
  changes, the decision folder's exceptions file that spec reads as an
  exception: `exceptions/*.json` — doesn't change
  the decision and gives no label); no labels — only a task without code. An epic has the
  union of its subtasks' labels. `github project check` checks the set
  against the spec tree of the main branch.
- **Project slice labels** — the team's own slice of tasks (apps `web`,
  `api`, `admin`; teams), not decisions: the marker is the description
  `Slice: <slice>[ — note]` (a decision label has `Decision: …`). The name
  may coincide with a model module: then
  `project check` prints a `○` line with the slice, `fix` doesn't touch the
  label, and the decision stays without a label (the name is taken);
  `pr labels` doesn't set such a label as a decision label, `task new
  --labels api` sets it as a regular label. A slice's color is not a decision
  kind's color: a decision's kind is visible only by color.
- **A small task** — one issue of type Task or Bug.
- **A big task** — an epic + subtasks:
  - the epic is an issue of type Epic: goal, context, the agreed design,
    questions, definition of done; **no list of subtasks, their order or
    stages** — the plan is the sub-issues themselves, the order — *blocked
    by*, the stages — milestones (the epic's `Sub-issues` and
    `Relationships` show them); a copy in text goes stale with the first
    change of a link;
  - the epic has a **short prefix** (`Billing`, `Import`, `API`): the titles
    of the epic and all its subtasks start with it (`<Prefix> · <title>`),
    and it also goes into milestone names;
  - each subtask is a separate issue attached to the epic as a **sub-issue**
    (native GitHub sub-issues; `github task new --epic N`);
  - a subtask must be a complete unit of work that can be done in one PR;
  - an epic may split its plan into stages — then a stage is a milestone
    (section "Milestones — sets of tasks" below) and each subtask belongs to
    one stage; an epic without stages has no milestones.
- **Dependencies — only GitHub's built-in links** (Relationships), not text
  in the description: the parent — sub-issue (the epic), "is blocked by" —
  *blocked by*, "blocks" — *blocking*; on creation —
  `github task new --blocked-by`.
  We don't write "Depends on" / "After #N" sections. **An external
  blocker** that is an issue of another repository (an upstream bug) — also
  *blocked by*: GitHub links issues of any owner (`gh issue edit <N>
  --add-blocked-by <issue URL>`). A blocker that isn't an issue (a release, a
  PR, another tracker, a client's answer, an external deadline) — the label
  `external blocker` in the project language (`labels.externalBlocker`; not in
  the repository yet — `gh label create`) and a comment that starts with
  `External blocker:` (`comments.externalBlocker`) and gives the reason; the
  blocker is lifted — the label is removed. *Relates to* — only in the UI and
  only if the link isn't "blocks". A task with an open *blocked by* or that
  label isn't taken into work: `task queue` shows it as `○` with the blocker,
  `task start` stops on it (code 1) by the same rules.
- Before creating a new task we check that it doesn't exist yet
  (`gh issue list --search`); before starting work — that it isn't already
  going in a parallel session (`AGENTS.md`, section "Git, PRs and merging").
- **Nothing native is duplicated in text:** status — only the project's
  `Status` field (section "Project (GitHub Projects)" below; no board — the
  facts), links — only
  sub-issue and blocked by, a stage — only the milestone, the decisions a
  task changes — only decision labels, the actual — only the fields (no
  board — est's «Actual» comment),
  the PR — only `Closes #N`; the issue's text holds what GitHub doesn't keep
  (goal, context, the agreed design, questions, scenarios). An epic is closed
  when all its subtasks are closed.
- No GitHub repository — say so and ask where to keep tasks, rather than
  silently filing them somewhere else.

## Project (GitHub Projects)

**The board is optional** (#847): a repository without one is no
discrepancy — `project check` prints an `○` line «no board connected» and
exits 0, `install` connects none, `project fix --create` connects one (the
owner's choice: the board is for a human, not every project needs it).
Without a board the same commands run — `task new`, `show`, `start`,
`status`, `drop`, `close`, `finish`, `actualize`, `queue`, `batch release`
and `est fact --write`: a board's step is an `○` line, and **a task's status
is by the facts** — closed as completed — Done; closed otherwise (not
planned, a duplicate) — not done; open with an open PR (linked, or by the
task branch and «Closes #N»), a task branch `*/N-*` on origin or a session
pin on this machine (`sessions/` of `~/.config/elves`) — In progress;
otherwise — Backlog. The actual's fields are a board's: without one the
actual is est's «Actual» comment with its marker, and `task close`'s tail
counts as over by it and the completed close. One path for every command
(`taskContext` with its `board`, `factStatus`), not a check per command.

Where there is a board, every repository has **exactly one** GitHub Project
linked to the repo (`github project fix --create`); the project name = the
repository name. It holds
**all** epics and tasks of the repository — we don't create separate projects
per epic/area (an area = an epic inside the shared project). All tasks are
added to the project right on creation (`github task new`). Required:

- **Three views**, with exactly these names, as in the template:
  - `Board` (BOARD_LAYOUT, columns by `Status`) — cards show Title, Status,
    Labels, Sub-issues progress;
  - `Table` (TABLE_LAYOUT, grouped by `Status`) — columns Title, Status,
    Labels, Assignees, Sub-issues progress;
  - `Roadmap` (ROADMAP_LAYOUT).
- **The `Status` field** with options `Backlog` → `In progress` → `Done`,
  colored `GREEN`, `YELLOW`, `PURPLE` (a new GitHub project's colors);
  option descriptions are the project's own.
  I change the status **myself, immediately**, without waiting to be asked
  (`github task status <N> <status>`):
  - a new task — I set Backlog on creation;
  - took a task into work — I set In progress before starting the work;
  - finished (PR merged / task closed) — `github task close <N>` sets Done
    together with the actual, the epic, the milestone and removing the merged
    branches;
  - the task was reopened (the bug came back, the PR was reverted) — I set
    In progress again (or Backlog if no one is working on it); an already
    closed milestone and epic I reopen as well;
  - **closed without being done** (won't do, duplicate, replaced by other
    tasks) — I close it as not planned and **remove it from the project**
    (`github task drop <N>`): it doesn't get into Done and doesn't count in
    the epic's actual.
  Epic: In progress when its first subtask is taken; Done when all are done
  (those closed as not planned don't count — they are no longer in the
  project).
  Safety net — the project's built-in workflows "Item added to project" →
  Backlog, "Item closed" and "Pull request merged" → Done, "Auto-close issue"
  (Done → the issue is closed), "Auto-add to project" (new open issues of
  the repository get into the project by themselves) and "Auto-add sub-issues
  to project": the status gets set even if there is no one to set it (another
  agent, closing from the GitHub UI). The agent sets the
  status anyway; a task closed as not planned it removes from the project —
  otherwise the workflow puts it into Done. "Auto-archive items" (`is:issue
  is:closed updated:<@today-2w`) takes a task closed and untouched for two
  weeks off the board and the table.
- **No estimate field:** tasks aren't estimated (`AGENTS.md`, section
  "Task tracking"); a project that still has the old «Estimate, h»
  gets an `○` line from `project check`, `project fix --confirm` deletes it.
- **The `Actual, h`, `Tokens, M`, `Cost, $` fields** (Number) — the actual:
  the agent's active hours, all tokens
  of the linked model responses (input, output, cache write and read,
  including subagents) and their price at public API rates — an **API
  equivalent**: not charged on a subscription, but comparable across tasks
  and models. Filled only by `est fact --write` when the task is closed,
  never touched by hand; for an epic — the sum of its subtasks.
- **Priority — the issue's built-in `Priority` field** (an organization Issue
  field it has by default: `Urgent` → `High` → `Medium` → `Low`), **not** a
  project field of our own.
  Required on every open task: a new one gets `Medium` unless the user said
  otherwise; an epic — no lower than its most urgent open subtask. The field
  is added to the project, `Table` and `Board` are **sorted by it**; within
  a priority the order is manual. We take into work the most urgent of the
  unblocked. A personal account has no issue fields — no priority is kept.
  `github task new` sets it (`--priority`, `Medium` by default).

Nothing extra: there are no other fields (Iteration, Readiness…), views or
columns until they are added here. What the public API doesn't read — the
slice by a field, the sub-issue hierarchy, column widths, the project's
description and README — isn't in the canon: a copy of the template carries
it, nothing checks it. Readiness — the status and *blocked by*; stages —
milestones (the `Milestone` field).

The project — the `github` skill: where there is a board, `project check`
once per session before working with tasks, ❌ — `project fix`. No project —
`fix --create` links one, copies the template or creates one (`fix` without
it leaves the repository without a board); what the API lacks (workflows, sorting) — UI
steps: the agent goes through them with the session's browser without asking
separately, without a browser — links to the user. Deleting or renaming in a
project that has already been used and changing organization settings — only
after confirmation (`fix --confirm`). What exactly `check` verifies, item by
item — section "What is checked" below.

## Milestones — sets of tasks

A milestone (a built-in repository entity) is **just a named set of tasks**
with a common goal and, if there is one, a due date; we use nothing else for
grouping (sprints, our own "Stage"/"Phase"/"Release" field). Meaning decides
the contents: plain tasks (`Release 2026-10`), whole epics (the milestone is
on the epics themselves), **an epic's stage** (a set of its subtasks).

- **Optional** for both a task and an epic: created only when a group has to
  be tracked as a whole. An epic without a stage plan has no milestones.
- **Name** of a stage: `<Epic> · <N> · <Stage name>`
  (`Billing · 1 · Data model`), `N` — the stage number in the plan (from 0 or
  from 1); a set without an epic — a meaningful name without a prefix; names
  must not be confusable. **Description** of a stage: `Epic: #<number>`; of
  another set — the goal in one or two lines.
- **An issue has only one milestone**, so we don't mix levels: subtasks go
  into their epic's stages; into a cross-cutting set (a release, a demo) we
  put the epic itself or plain tasks.
- **I set it on creation** of a task if the task belongs to a set; stage
  milestones I create together with the epic, as soon as the plan is agreed
  (later stages may be refined).
- **A stage not yet broken down** → the milestone has one stage task with a
  checklist (`<Epic> · Stage N. …`, a sub-issue of the epic, for the whole
  stage; an exception to the "one PR" rule; its items aren't issues
  yet, so the checklist isn't a copy). Decomposition: issues
  from the checklist items (the same milestone, sub-issues),
  then the stage task — not planned and out of the project.
- **Due date** — only a real deadline (then the set shows on the roadmap).
- **I close it myself** when the set's last task is closed; I reopen it if a
  task is reopened. On task creation — `github task new --milestone`, the
  other commands — section "Manual commands" below.

## Epic refresh on task close

The task's PR is merged — right after the merge **a subagent with a fresh
context** goes through all open tasks of the same epic and brings them in line
with what shipped; the session at peak context doesn't do it itself — each of
its turns costs several times more. This is part of closing the task, not a
separate request. The refresh doesn't depend on the deploy: the subagent and
the deploy wait (`ci-wait`) run in the background in parallel,
`github task close` — after both. What needs no judgment `github task
actualize <N>` does itself: blocked by on done tasks is removed (check 4), the
`questions` label without open questions in the section (check 2), a milestone
of the epic's tasks without open tasks is closed (check 1; the task's and the
epic's own — by `task close`); its fixes — one line in a comment on the epic.
Then it prints the subagent's two-line prompt; the whole assignment — the
texts of the epic and its open tasks, the PR files, the copies of links in
text and the answers to open questions in comments the script found (named,
not edited: a line may carry meaning, a comment's numbering may be its own),
the checks by meaning 1, 3 and 5 — is printed by `task actualize <N>
--assignment`, the subagent's first call. Its edits — one JSON file applied by
`task actualize <N> --apply <file>`, no `gh` (#669: 27 turns a refresh, a
`gh` call per edit): checked whole before any write — one that can't be done
refuses the file, nothing changed — then applied all, with the report posted
on the epic. No epic or no open tasks in it — the
line `○ refresh not needed`, no subagent. Five checks:

1. **Done is closed.** No open tasks that are already part of what shipped
   (done — I close it; lost its point — not planned and out of the project).
   Statuses and milestones match: the set's last task is closed — I close the
   milestone.
2. **Answered questions are marked.** Every already answered question in
   `## Questions` (comments, another task, code) is marked ✅ with the answer
   (`github task answer <N> <k> "<answer>"`); the numbering doesn't change —
   it is referenced. None open — the `questions` label goes (`task answer`
   and `task actualize` remove it).
3. **Descriptions don't lie.** The wording of open tasks is checked against
   the code and specs: what doesn't exist after the rollout (fields, tables,
   routes, permissions) is removed. After **a reversal of an accepted
   decision** I edit every task where it is quoted.
4. **Dependencies are real and only links.** GitHub links (sub-issue,
   blocked by) reflect the actual state: blocked by on closed tasks is
   removed, a new task is attached to the epic. Their copy in text — a list
   of subtasks in the epic, an order, "⛔" or "after #N" marks — is removed.
5. **Repetition is a standard.** A decision that, in what shipped, repeats an
   existing one in two or more places — a `Standard · …` issue
   (a rule in `tests/standards/` and a refactoring); a repeat in the files a
   task changes anyway is fixed in its PR by its executor, without a task.
   First — an open task of the epic of the same kind (the same helper, module
   or standard) in Backlog: the finding is an item in its «What to do» (and a
   scenario, if needed), not a new task; one In progress or with an open PR is
   already going — a new task (the assignment names each one's status). Then
   a search among the open `Standard · …`: one exists — don't file another; an
   extension of a neighboring one — a comment in it. The result names where
   the finding went: «appended to #N» or «filed #M». A standard's priority —
   by the cost of the mistake it prevents; standards of one area — as an epic:
   otherwise they are born faster than they are worked off (#636: seven tasks
   in a day on one helper's copies, each refresh finding the next). Something
   deferred as "not in this PR" — an issue or dropped explicitly, not
   forgotten.

What was fixed — one comment on the epic, the history of decisions in one
place; it is the subagent's last step, always — the `report` of its file,
`--apply` posts it: nothing to fix — «the block is current». The comment starts with «Refresh after #N, result:» in the project
language (`report` of the dictionary) — it is the end of the refresh for
`task close`: until it, close refuses (#571: an executor closed its task while
its refresh still ran in its worktree, the dispatcher's queue removed the
worktree, and the subagent was left without a directory).

**End of session — one line, one of three.** A missing line can't be told
from a forgotten one, so the answer always has the last line:

- **`All done. The session can be closed.`** — everything is done: the PR is
  merged; the post-merge deploy was
  awaited (where the merge deploys); `task close` passed without `!` lines;
  the epic refresh is done; there are no open questions to the user or in
  issues; proposed tasks are filed in Backlog.
- **`All done, but there are questions: …`** — the same is done, but the
  owner has something to decide beyond the
  task: whether to file a task for an observation ("your call"), whether to
  revert a setting, whether to cut a release. The questions themselves — in
  this same line, briefly, one per decision; `The session can be closed` is
  not written: with it the questions read as
  "nothing to decide".
- **`Remaining: …`** — not everything is done: what the session
  waits for and from whom (a merge from the owner, an answer to the task's
  question, a red check).

Information without a decision — a period to wait out, a warning ("didn't
make it into the release"), an observation with nothing to decide — is not a
question: it goes into the report above, and the line is
`All done. The session can be closed.`. A report of what was done (what was
merged, links to PRs and tasks) is not a question either. A session without a
task (epic planning, an investigation) ends the same way — by what it was
assigned.

**In auto mode the session archives itself at the end.** A project with
`"auto": true` in `.agents/elves.json` runs the task entirely without asking,
and closing the session is the last step left to a human: after the line
`All done. The session can be closed.` the session archives itself — as its
last action, after which the conversation ends. After the other two lines and
outside auto mode — no: an archived session leaves the list, and the owner
will no longer read the questions in its last answer. Before archiving the
session stops its own background tasks still running (a wait, a watcher over
its output, a subagent): by this line everything needed has finished, and a
live leftover blocks archiving (#437). How to archive — in the
agent's file (`claude/CLAUDE.md`); an agent without such a tool (another
agent) keeps the line. Archiving isn't deletion: the session can be
restored.

## Project check and fix

When to run `project check` and `project fix`, their codes — `SKILL.md`. Here —
what is checked item by item, who does what in `fix`, how to go through the UI
steps and the API's gaps the script exists for. Done by hand, projects drift
apart: somewhere "Item closed" is off, somewhere a filter hides tasks from the
board.

### What is checked

Names of views, `Status` options, fields, issue types and label markers here
and below are the `en` ones (in the project language — `locales/<language>.json`
of the `github` skill). The project language — `language` in
`.agents/elves.json` of the checkout the script runs from (module
`scripts/locale.ts`). Views,
`Status` options, fields and issue types named in another language of the
dictionary — ❌, `fix` renames them keeping the ids
(task values and the «Item closed» target survive; with tasks in the project —
after `--confirm`); a decision label with a marker in another language — its
description is rewritten.

No manifest at the checkout's root (the nearest directory up with `.git`) —
the language is unknown (#681): a fresh
worktree of a project that keeps `.agents/` out of git got the `en` names and
checked its `ru` project against them. The commands that write the canon's
names to GitHub or check the project against them — `project check`, `project
fix`, `task new`, `task answer`, `task status`, `task actualize`, `task close`,
`pr labels`, `batch release` — refuse with code 2 before any request: the
reason, and the way out — copy the manifest from the main checkout (the first
line of `git worktree list`) or commit it there; a repository without Elves —
`bunx @miroshnik/elves install --lang <language>`. Reading (`task show`, `task
queue`, `task resume`, `pr premerge`) goes on: it parses every language's
names; `task drop` writes none. The installer's `check` names the same: the
package without the manifest — ❌ instead of «not installed», the manifest
outside git — ❌, `update` puts it into its commit.

1. The project is linked to the repository, it is the only one, its title =
   the repository name; none — an `○` line, the board is optional: items 2–9
   aren't checked, 10 and 11 are; `fix --create` connects one.
2. Views `Board` (BOARD, columns by `Status`), `Table` (TABLE, grouped by
   `Status`), `Roadmap` (ROADMAP), filters empty, no others; the columns of
   `Board` and `Table` — the canon's set (a built-in field by its type, the
   rest by name), `fix` sets them in the template's order. The roadmap's
   columns aren't compared: the API gives it the default ones.
3. `Status`: `Backlog` → `In progress` → `Done`, colors `GREEN`, `YELLOW`,
   `PURPLE`; descriptions aren't compared.
4. Fields «Actual, h», «Tokens, M», «Cost, $» (Number), no custom fields
   beyond the canon; the old «Estimate, h» (in any dictionary language) isn't
   a discrepancy — an `○` line, the item stays ✅, its `Table` column isn't
   «extra»; `fix --confirm` deletes it (with the column), `fix` without it
   names the step under «Optional, on the user's confirmation» and doesn't
   fail on it.
5. Organization only: `Priority` — the organization's issue field, connected,
   `Table` and `Board` are sorted by it; issue types — exactly «Task»,
   «Bug», «Epic». A personal account has none — a `➖` line.
6. The template's workflows are on: "Item added to project" (→ Backlog),
   "Item closed" and "Pull request merged" (→ Done), "Auto-close issue",
   "Auto-add to project" (`is:issue is:open`), "Auto-add sub-issues to
   project", "Auto-archive items" (`is:issue is:closed updated:<@today-2w`).
   Others aren't checked.
7. Closed tasks — in Done; those closed without being done (not planned,
   duplicate) — outside the project.
8. The repository's open tasks — in the project, each has a `Status`. A
   task the project's item list doesn't return is rechecked by its own
   `projectItems`: a live (not archived) item of this project — GitHub
   hasn't reindexed the project yet, and `AddItem` would answer with that
   same item — is an `○` line with the item's id, item ✅, `task start`
   goes on.
9. Decision labels — by the spec tree of the default branch (via the API): the
   label name is the topic name (folder
   `tests/capabilities|standards|architecture/<topic>` or a model module), kind
   — by color: capability `0E8A16`, standard `1D76DB`, architecture `D93F0B`.
   One name for decisions of different kinds — one label: the color of the
   senior kind (capability → standard → architecture), all paths in the
   description. A decision label is recognized by the description
   `Decision: …`. A decision without a label — the label is created. A label
   without a decision on an open task — a new decision (`task new` puts it, it
   reaches the default branch with the task's PR): an `○` line with the task
   numbers, item ✅, the label is left alone. A label without a decision and
   without open tasks — deleted with `--confirm`; one such and one missing of
   the same kind — a rename with `--confirm` (tasks keep the label); a foreign
   color or description — fixed. A regular label with a decision's name — ❌, it
   becomes a decision label with `--confirm`. A slice label — another slice of
   the project's tasks (apps, teams), recognized by the description
   `Slice: <slice>[ — note]`: with a decision's name — an `○` line
   with the slice, item ✅, `fix` doesn't touch it, the decision stays without a
   label. The model (`tests/architecture/model.ts`) is read by a separate
   process — if it didn't load, module labels are left alone, ❌ with the
   reason.
10. Merging into the default branch — only with green required checks: an
    active branch rule (`Ref.rules` — a repository or organization ruleset —
    or classic protection) with a non-empty list of required checks. None —
    `fix` sets the `elves` ruleset: `~DEFAULT_BRANCH`, without strict (the
    rule doesn't require an up-to-date branch), required — the checks green on
    each of the last 10 merged PRs (by the latest run; skipped or neutral
    isn't green here), bypass — the admin role (the owner's direct
    push). Its own ruleset keeps being checked: disabled, with strict or
    without bypass — fixed; a required check that the fresh head lacks (the
    last merged PR, an open PR with finished checks) leaves the list —
    otherwise a PR would wait for it forever; a new stable one is added.
    Someone else's rule with required checks — ✅, with strict or without: no
    own ruleset is created, the other rule isn't edited. A private repository
    on Free (GraphQL returns empty rules, REST — 403 "Upgrade to GitHub Pro")
    and merged PRs without a common green check — a `➖` line. This item
    doesn't need the project.
11. PR merge method — rebase only (canon, "PR"): in the repository settings
    merge commit and squash are off, rebase is on — otherwise a PR would be
    merged past the merge rule, and `gh pr merge --rebase` would be refused.
    `fix` sets this with one REST request (`PATCH repos/{owner}/{repo}`:
    GraphQL doesn't change merge settings); it needs admin rights — without
    them a `!` line with GitHub's response and a link to the settings. This
    item doesn't need the project.

### fix: who does what

- **API — the script itself:** linking, a template copy or a new project,
  missing views and fields, view layout and columns, removing a filter,
  `Status` options and colors,
  the `Priority` issue field, task statuses, adding open tasks, removing tasks
  closed without being done from the project, decision labels (creation,
  color), the default-branch ruleset (creation, editing its own), merge
  methods — rebase only (REST). `+` lines.
- **UI steps** (`UI steps …`) — what the API lacks. Calling
  `fix` is permission to configure this repository's project: the agent goes
  through the steps itself, in a browser where the user is signed in to GitHub
  (Claude in Chrome or the built-in browser after they sign in), without asking
  separately. No browser or sign-in — a list of steps with links for the user.
  The agent doesn't enter a password. After the steps — `check` again.
- **Confirmation** (`Confirmation needed …`) —
  deleting and renaming in a project that already has tasks, unlinking extra
  projects, the organization's issue types (shared by all its repositories),
  deleting and renaming decision labels (they are on tasks). Show the list to
  the user, after a "yes" — `fix --confirm`. In a new project without tasks,
  deleting and renaming go without confirmation.
- **Error** — a `!` line with the reason (and a link to the UI if the step is
  done there): most often `gh` lacks a scope.

### UI steps — how to go through them

- **Workflow:** the link leads to a configured workflow
  (`<project>/workflows/<fullDatabaseId>`) or to the list `<project>/workflows`,
  where an unconfigured one is picked in the left menu. Edit → configure →
  **Save and turn on workflow**; `On` appears at the top right. In Set value
  `A value is required` — the `Status` option the workflow pointed at was
  deleted (options were replaced without ids): pick it again.
  - "Item added to project": trigger `issue, pull request` (default), Set
    value → `Status: Backlog`.
  - "Item closed", "Pull request merged": Set value → `Status: Done`.
  - "Auto-close issue": `Status: Done` → close the issue.
  - "Auto-add to project": the repository — this project's, filter
    `is:issue is:open`, Enter — the "See N existing items" counter should
    update. Without `is:open` an updated closed task (a not planned one too)
    comes back into the project. Auto-add doesn't add already existing tasks —
    `fix` adds them.
  - "Auto-add sub-issues to project": nothing to set — Save and turn on.
  - "Auto-archive items": filter `is:issue is:closed updated:<@today-2w`,
    Enter.
- **Sorting by Priority, board columns, table grouping:** the view → the
  `View` button on the right → `Sort by: Priority` / `Column by: Status` /
  `Group by: Status` → `Save view` → the dialog
  "Save display options for …?" → `Save`. Escape closes the dialog without
  saving: the sorting stays only in the URL (`?sortedBy…`), and the tab's
  unsaved marker lies — `check` verifies the result.
- **The organization's issue fields** (the organization has no `Priority`) —
  the organization settings via the link from the step, then `fix` again.

### Details the script exists for

- **A workflow can't be turned on via the API, and its target can't be read:**
  `ProjectV2Workflow` returns only `name`, `number`, `fullDatabaseId`,
  `enabled`; there is no mutation to turn it on. An unconfigured workflow isn't
  in the list at all (for a new project — "Item closed", "Pull request merged",
  "Auto-close issue").
- **The "Item closed" target is seen from the result:** a closed task not in
  Done — the workflow is off or points at a deleted `Status` option. `fix` sets
  Done and leaves a step to check the target in the UI.
- **`Status` options are renamed keeping the same id**
  (`updateProjectV2Field`, `singleSelectOptions[].id`): task values and the
  "Item closed" target are kept, recoloring too. Replacing options without
  ids gives new ids — task statuses vanish, "Item closed" sets the deleted
  `Done`.
- **The template** — the elves project (`miroshnik/6`): everything the API
  lacks is configured there once. A copy (`copyProjectV2`) carries over views
  with their settings, fields and configured workflows, except auto-add; it
  doesn't carry over tasks, collaborators or the repository link. The template
  is unavailable (someone else's account) or `--template none` — the project is
  created from scratch (`createProjectV2`) and brought up via the API:
  `Todo / In Progress / Done` → the canon with the same ids, `View 1` →
  `Table`, the rest is created; the table's grouping is a UI step.
- **The view filter is empty:** `iteration:@current` without an Iteration field
  silently hides tasks from the board.
- **`Priority` is the organization's issue field** (`isIssueField`), not a
  project field of the same name. The API reads the sorting (`sortByFields`)
  but doesn't set it; the board grouping and the table grouping too
  (`verticalGroupByFields`, `groupByFields`).
- **A view's columns are set** (`updateProjectV2View`,
  `configuration.visibleFieldIds` in order) and read (`fields` of the view; a
  roadmap without configured columns gives the default ones).
- **A project that has been used** — it has tasks.

## Task and PR commands — details

When to call each command and its syntax — `SKILL.md` (a call error prints the
corrected command: section "A call error"); a command's summary — `github
<command> --help`. Here — what each one checks, sets and prints.

### task new

Without `--body` the description is a skeleton in the project
language: the scenarios and questions sections (an epic — only questions);
`--type` and `task status` take a name in any language of the dictionary. A
board in another language of the dictionary (the language changed without
`fix`, the script runs from another project's checkout) — the task is kept in
the board's language; no manifest — a refusal (section "What is checked"). One `createIssue` mutation: the organization's issue type (in
a personal account an Epic gets the `epic` label, created if missing; Task and
Bug get no label there), the project, the epic (sub-issue), the milestone by
title among open ones, `Priority` in an organization (`Medium` by default).
Then `Status: Backlog` — by itself, without waiting for the workflow — and
blocked by. A subtask's title gets the epic's prefix (`<Prefix> · …`) if it
lacks it; the epic's `Priority` is raised to the subtask's if the subtask is
more urgent. Everything is checked before creating — an error (code 2) doesn't
leave a half-made task: `--epic` is an open epic, the milestone exists, the
blockers exist (closed ones are skipped), there is no open task with the same
title, the type is enabled, `Priority` is one of the options. A personal
account keeps neither `Priority` nor the Task and Bug types: `--priority` and
`--type Task|Bug` are taken alike — the task is created, a `○` line says what
isn't kept (#682). `--labels` — the task's labels in the same
mutation: a decision from the default branch — by name (`billing`), a new
decision — `kind:name` (`capability:export`, the label is `export`, the line
«new decision»: it will appear in the task's PR); no decision
label — created with the kind's color; a regular label must exist, otherwise an
error before creating. With `--epic` the decision labels are added to the epic
too (the union of its subtasks; GitHub's limit of 100 — "pr labels"). A slice label by name (`api`) is a regular task label,
not passed to the epic; `kind:name` with a slice label's name is an error
before creating: a decision with that name isn't marked by a label. A section
of a topic in the default branch (by name or `kind:name`, not a topic itself)
— an error before creating with the topic to pass instead: the label is the
topic's. A question
without ✅ in the description's questions section — the `questions` label in
the same mutation (created if missing), a `+` line names the open questions;
none open — no label. Prints `Created #N …`, `+` lines and the next step.
No estimate (#835) and no branch type: the type comes with the branch in
`task start --branch`. In a session with a
pinned task (`task status` below) — a second line «Next:»: the session runs
`owner/repo#N`, `#M` isn't taken here — the question to the owner «queue #M?»,
"yes" — a background subagent in its own worktree with the printed prompt (the
executor's, as in `task queue`): the session launches it at once and goes on
with its own task (#546; a session card waited for the owner's click). An
epic — instead: once its subtasks are created,
the question «run the dispatcher on epic #M?», "yes" — `task queue
--epic M` in this session.

### task show

The task in one output instead of `gh issue view` per piece
(the description, then the epic, its subtasks, the PR and its checks): the
title and link; the type, the state if closed, `Status`, the actual,
`Priority`, milestone and labels in one line; the epic with its open
questions and other open tasks (`- question k. …`, `- task #M «…»`); an
epic's open subtasks; open blockers; each PR with its state and its head's
checks (`checks: 2 ✅, 1 ⏳ (e2e), 1 ❌ (lint)`; skipped and neutral — ✅,
cancelled — ❌, of a check's reruns — the latest, as `ci-wait` reads it:
standard `scripts#check-run-state`; GitHub hasn't linked the PR yet
— found by the branch or «Closes #N», as `task close` does; an epic has no PR
line); the questions — open and answered numbers with the `task answer`
command; a comment that looks like an answer to an open question — a `?`
line at it (`? k: answer in a comment of @login <time> — check it and task
answer N k "<answer>"`; the epic's — under its `- question k. …`): an item
`k.` of a comment (`k. ✅ …` or without ✅) — to the open question k, free
text without numbered items — to each open one; the comments of the task,
then of its epic (`Comments: n`, `Epic #M comments: n`, the latest 100):
the author, the time in UTC and the whole text, indented; the flow's own —
est's actual and, on old tasks, its estimate (by their markers: a human's
«Estimate: …» isn't one), the epic refresh's report and the script's fixes,
«closed by PR» — one line with the kind (`— flow: actual`), without the text; State — whole
(`— State:`), a handoff; State and an external blocker's reason aren't
answers (#651: an answer in a comment was lost — the executor asked again or
answered auto over it); then the description as is. Read-only, one GraphQL
query (plus the recent PRs when none is linked).

### task answer

The answer at question `k` of the questions section, not
a rewrite of the description by hand (`gh issue edit --body-file`): ✅ (with
`--auto` — the auto mark, `✅ auto` in `en`) after the item's number and
`**Answer:** …` at its end — on the same line for a one-line item, otherwise
on a line of its own; est strips the answer from the description size. The
numbering and the rest of the description don't change; the answer's line
breaks become spaces. Open questions left — an `○` line with their numbers;
none — the questions label is removed. Refused before any change (code 2): no
questions section, no question `k`, the question already has ✅ (a changed
answer — `task edit --replace`), an empty answer.

Open questions go to the user before the plan, code and subagents: an answer
may change the scope and the approach. A question of my own in auto mode goes
into the questions section with ✅ auto before code, not into chat: a
decision in chat gets lost.

### task edit

An edit of the description in one call (#670), not `gh issue view --json
body`, a file and `gh issue edit --body-file`: `--replace <old> <new>` — the
text must occur exactly once; `--add "## <section>" "<item>"` — at the end of
the section (it ends at a heading of its level or higher, or `---`: a
signature after it isn't in it), the section by its heading or its bare name
(`Scenarios` — the heading `## Scenarios`); the canon's section the description
lacks (questions, scenarios, any language) — created at the description's end,
before a signature after `---`; an item without a list marker gets the one of
the section's last top-level item — `- [ ]` after a checklist, the next
number after a numbered list, its bullet, otherwise `- `, in the questions
section `1.` (`task answer` finds a question by its number); `--check
"<text>"` — `- [ ]` → `- [x]` of the one unchecked item containing the text.
Several edits — in order, each sees the previous one's result, one write.
Refused before any change (code 2), none of the call's edits written: a text
not found or found twice, another section missing (the error names the
description's sections) or two of them, no or two unchecked items, an edit
missing a value. Questions — `task answer`.

### A call error — the corrected command

A command's call error (code 2) is two lines on stderr: what was wrong and the
whole command to run instead — `bun --no-env-file <script> …` with the call's
other arguments, not «see `--help`» (#841): an option the command doesn't take —
the one it means (`--parent` → `--epic`, `--label` → `--labels`, a typo within
two letters), a gone one (`--branch-type`) — without it and its value; a text
that starts with a dash — after `--`; an option without its value — `<name>`
in its place, a value that starts with a dash — glued by `=`; `task new`
without `--title` — with it (the call's argument, otherwise `<title>`), `task
edit` without the number — `<N>` first. No correction — the line names the
command's options, the second is its synopsis. The outputs' next steps are
ready commands with the task's number too: `task show`'s `Questions:` line —
the answer to the first open question, `task start` — the answer in auto mode
and, without scenarios, `task edit N --add "## <scenarios>" "<scenario>"`.

### task start

Taking a task in one call (#666) instead of ~11 flow turns: `project check`
once per session (green — `✅ project check: …` and the marker
`~/.config/elves/project-checks/<CLAUDE_CODE_SESSION_ID>`, the next call of
the session — `= project check — done in this session`; ❌ — the report and
code 1); the task as `task show` prints it; then the stops before any change,
code 1: its blockers by `task queue`'s rules (`! #N is blocked — …`: an open
*blocked by*, another repository's too, and the `external blocker` label with
its reason; a blocker merged into the batch of this session's executor
doesn't hold — its branch is cut from the batch; past the batch, `--main`, it
holds); open questions of the task or its epic (`! open questions — …`: asked
in one message, auto mode — `task answer --auto`, then `task start` again);
the task in work elsewhere (`! #N is in work elsewhere — …`: an open PR of it,
into a batch branch too, or a branch `*/N-*` locally or on origin that isn't
the current one) — continue that work or wait for its merge. Then `task
status N "In progress" --branch` (below: the pin, the epic, the rename) and
the next lines: `Session name: «#N <title>»`, `Branch:`, the number of
scenarios (none — an `○` line: a code task gets them before code) and, in
Claude Code (`CLAUDECODE=1`), `ToolSearch select:…` with the app tools the
flow calls in a task (session title, PR monitor, `TaskStop`, archive) — one
load, not one per call; the last — `task next`'s `Next:` (the task's work,
then `task finish`). An epic, a closed task, a `--branch` not of this task
— code 2. `task status` stays for other status changes. `--resume` — an
executor's restart (#709; the assignment's restart line names it): the task's
branch and open PR are the previous executor's work to continue, not a stop;
the current branch isn't renamed, `Branch: continue …` names what to continue
(in its worktree, or switched to here); nothing to continue, or with
`--branch` — code 2. The assignment's lead takes the task with `task start
--branch`; the fix of a red release keeps `task status --branch`: its new
branch is cut beside the task's merged one, which `task start` would stop on.
A separate call, no pipeline: `| tail` returns its own exit code and hides
the stop (code 1) or the refusal (code 2).

### task next

The one entry of a task (#842): the agent chose among 17 commands by "when
to call what" tables and remembered exit codes (`task finish` 0…5, `pr
premerge` 0…3); the sequence now lives in the script. Read-only, by the
facts, in this order — the first that holds is the step:

1. An epic — the owner's question «run the dispatcher on epic #N?», then
   `task queue --epic N`.
2. Closed: not done (not planned, a duplicate) — `none`; its tail over (the
   board's Done and the actual field, without a board — closed as completed
   and est's actual comment) — `none`; an open PR of it or the checkout's task
   branch with commits not in the base — `task finish` (it reopens the task);
   closed by a merged PR — the steps after the merge below; closed without a
   PR — `task actualize` and its subagent in the same turn when the epic
   refresh is due, then `task close`.
3. Open questions of the task or its epic — auto mode (`"auto": true` in the
   current directory's manifest): `task answer N k "<answer>" --auto` by the
   recommendation, one without a clear one — the owner's; outside auto — the
   owner's answers, asked in one message.
4. A merged PR and nothing pending (no open PR, no task branch here with
   commits past it): into a batch branch — the dispatcher's release (its
   release merged — the refresh and `task close`); otherwise the deploy not
   awaited (`task finish`'s mark) — `task finish N` in the background; the
   epic has other open tasks and no refresh report — `task finish N` (the
   mechanics and the subagent's prompt), its prompt printed — wait for the
   subagent; then `task close N`.
5. An open PR — into the default branch: red checks — the fix (`gh pr checks`,
   the checks before a commit, `git commit`, `task finish`); running or none
   yet — `task finish N` in the background; green — `pr premerge <PR>`, and
   once it passed on this head (its mark `premerges/` of `~/.config/elves`:
   the head and the time; a new head or a base moved since — premerge again)
   — the merge `gh pr merge <PR> --rebase` as a separate call, outside auto —
   after the owner's «yes». Into a batch branch — no CI: premerge, then the
   merge.
6. No PR: the checkout isn't on the task's branch — its branch elsewhere
   (local or on GitHub) — continue there; none — `task start N --branch
   <type>/N-<slug>`. On it: uncommitted changes — the checks before a commit
   and `git commit`; commits past `origin/<base>` (the batch's — as `task
   finish` picks the base) — `task finish N` in the background; none — the
   task's code and tests, then the same.

Output — `#N «title»: <state>` and `Next: <step>`; a wait is named with whom
it waits for (`Next: waits for the owner — …`, `waits for the dispatcher —
…`), no steps — `Next: none — …`. Without `<N>` — the checkout's task branch,
otherwise the session's pin (its repository is in it). Exit `0` — nothing for
the caller (none, the dispatcher's release), `1` — a step, `2` — an error.

Every task command ends with the same `Next:` — `task show`, `task answer`
and `task edit` by the description as written, `task start`, `task status`,
`task drop`, `task finish`, `task close`, `pr premerge`; their exit — done
`0`, stopped on a step `1`, an error `2`: the step is told by the `Next:`
text, not by the code. `task new`, `task queue`, `task resume`, `task
actualize` and `batch release` name their own steps: they start outside a
task's path.

### task finish

The tail of a task from its committed branch to its close in one resumable
command (#668) instead of ≈19 flow turns at the peak context. Each call does
what is ready within `--timeout` (an hour by default), prints the state and
`Next:`, and a repeat goes on from there: the state is GitHub's and git's,
plus two marks in `~/.config/elves/finishes/` — the merge's deploy passed,
the refresh prompt printed (a repeat doesn't print it for a second
subagent). Before the merge: uncommitted changes or no commits past
`origin/<base>` — code 1; the task branch pushed (origin has the same
commits rebased — `--force-with-lease` on its head; commits that aren't
here — code 1), no `-u`; the PR into the dispatcher's batch branch, otherwise
— and when that batch is released (its release PR merged, its branch gone
from origin, #768) — the default branch; commits of the branch already in
the base by their changes (a released batch's, rebased with other SHAs) —
code 1 before the PR: `git rebase origin/<base>` drops them, otherwise the
PR's title and decision labels would be theirs; the title — `--title`, otherwise the first commit of the
branch type, a conventional commit; the body — `spec-diff` and `Closes #N`
(an existing PR — the body updated); `pr labels`; a PR it opened in Claude
Code (`CLAUDECODE=1`, #866) — code 1 with the step `set_monitor` with
`auto_fix: false` and the PR's url (Auto-fix wants the base merged in on a
conflict), a repeat finds the PR open and goes on; `ci-wait pr` (none into a
batch): FAIL, a conflict — code 1 with the step; `pr premerge` — stopped
(code 1 with its step: the fix, or the red base's bug). Then the merge
command, code 1: the merge stays a separate `gh pr merge
<PR> --rebase` — the owner's permission rule matches it. After the merge:
into a batch — code 0, nothing more (the release does it); otherwise
`ci-wait merged`, the refresh's mechanics and its prompt (code 1 — the
subagent), and `task close` once its report is on the epic (no epic or no
other open tasks — right away). A task reopened after its merge (#813): an
open PR of the task or the checkout's task branch with commits not in the
base (`git cherry`; the merged PR's own branch — commits past its pushed
head) is the tail, not the merged PR — the latest merged PR is the one
awaited after the merge; closed with such work — reopened and «In progress»
(not planned — code 1 with `gh issue reopen`). Out of time — code 1 and the
same command again. Every stop is code 1 (#842: before it — 1, 3, 4 and 5 by
kind): the step is the automaton's `Next:` line, the one `task next` prints.
A session runs it in the background — once before the merge and once
after; a subagent — `--timeout 240` (540 with the hour cache,
`skills/ci-wait/reference.md`), again while its `Next:` says so. The separate commands stay for manual
work.

### task status

Sets `Status` (a task outside the project is added). A
subtask going In progress moves its epic from Backlog to In progress too.
Hints: the epic is closed but a subtask is in work again — reopen the epic and
its milestone; all subtasks are closed — close the epic and set it to Done.
In progress pins the task to the session: the file
`~/.config/elves/sessions/<CLAUDE_CODE_SESSION_ID>` (or in
`$ELVES_CONFIG_DIR`) with the line `owner/repo#N`. Another task In progress in
the same session — a refusal (code 2) before any changes, in one line: the
pinned task, the question to the owner «queue #M?» with its executor's prompt
(as `task new` above) and the file path. The same task again, an epic, Backlog
and Done — no refusal; a task handed out to an executor of this session (`task
queue --assignment`, below) — neither a pin nor a refusal, an `○` line: the
executor is a subagent with the session's id. No command removes the pin:
a mistaken one is removed by a human, by deleting the file. A line not of the
form `owner/repo#N` isn't a pin — for `est` either
(`tests/standards/scripts/session-pin`): In progress replaces it with the task, an `○`
line. `est` counts the actual by the pin: the whole session goes to this task.
No variable (not Claude Code) — the line `○ session not recognized …`, the
status is set, no guard. A dispatcher session (`task queue` below) — no pin:
the line `○ dispatcher session: #N isn't pinned …`.

### task status --branch

`task status --branch <type>/<N>-<slug>` — only with In progress, not for
an epic: the current branch of a worktree tool (`claude/<slug>-<hash>`)
becomes the task branch together with its section in `.git/config`
(upstream) — `+ branch <old> → <new>`. The name is checked by the canon before
any changes (`[<area>/]<type>/<N>-<slug>`, the slug — Latin kebab-case),
otherwise code 2. `.git/config` is shared by all worktrees of the repository,
and another checkout's git holds its lock: a bare `git branch -m` renames the
ref, not the section, with code 128, and its repeat no longer finds the old
name (#438). The script repeats the step that failed on the lock (~10 s);
still locked — a `!` line with the lock file, its age and the command that
finishes the rename, code 1; the lock isn't removed — another process holds
it. Already on the task branch — `=`; a branch already on origin (`main`, a
pushed one), a detached HEAD, a directory that isn't a checkout of the
repository — an `○` line, the branch is left alone.

### pr labels

Decision labels from the PR's changed files (API):
`tests/capabilities|standards|architecture/<topic>/…` — the topic's label (a
section's file `<topic>/<section>.*` too), a code
file — the label of the model module from the PR head (the longest matching
directory), `tests/lib` and files outside modules aren't decisions. A
mechanical edit doesn't change a decision and gives no label: a deleted file,
a rename without content changes, an exceptions file of a decision folder that
spec reads as an exception (`exceptions/*.json`; a
copy of the spec rule `exceptionFile`) — a decision touched only that way
comes out as an `○` line (a label is needed — set it by hand). A decision whose
name belongs to a slice label (module `web` and the app label `web`) — also an
`○` line: a slice label isn't set as a decision label. It labels the tasks from
"Closes #N" (the PR–task link; right after the PR is created GitHub hasn't set
it yet — the PR's tasks by the one rule of the script: the task branch's number
and the PR body's keywords as GitHub understands them, so a fix PR into a batch
with `Refs #N` labels its task by the branch; none at all — an error). A
batch's release PR (the batch branch into the default one) — an `○` line, no
labels (#650): its tasks got theirs from their PRs into the batch, the
release's diff would give each the whole batch's, and a red release names its
guilty task by them. It creates a missing label with the kind's color; it doesn't
remove an earlier label of a decision missing from the diff — an `=` line. The
task's epic gets the same labels — the union of its subtasks; same with
`task new --epic --labels`. GitHub puts at most 100 labels on an issue, and a
mutation past that fails as a whole (#569): the room is 100 minus the labels
the task (the epic) already has. Everything fits — everything is set; it
doesn't — only the decisions whose statements the PR changes: the topic's
`<topic>.md` or a section's `<section>.md` edited in content or the folder named in the spec section of the PR
body (spec-diff output — the lists, the summary, the move, harness checks;
exceptions don't count), alphabetically, as many as fit. A codemod over every
test changes no statement: test bodies and code only — an `○` line without a
label, what didn't fit — an `○` line too; code 0. `task new --epic --labels`
has no PR yet to choose by (#574): the epic gets the task's decisions
alphabetically, as many as fit, the rest — `○` lines, code 0 — the task is
already created by then.

### pr premerge

First the decision labels (#733): the PR changes decisions (`pr labels`'
rule) whose labels its tasks or their epics lack — `❌`, code 1 and the
command `pr labels <N>`, then `premerge` again: on every path to the merge,
by hand and through `task finish`, into a batch too; a label past GitHub's
limit on an issue doesn't hold it. A batch's release PR — no labels, no check.

Then red on base (#844), for a PR with files in `tests/` (the PR's files, read
once with the labels): "a check is red first" is a mechanism, not the
executor's word. The base and the PR head are fetched, `spec-red` of the
`spec` skill (next to this skill, a process) runs the PR's added tests on the
base code — a temporary worktree at the merge-base with the head's `tests/` —
and its lines are printed as they are: an added test green there, or an
existing-behavior mark on a test red there — `❌`, code 1, the test is fixed
in the PR; spec-red's error — code 2. On every path to the merge: before
"CI checked this merge" and before "on the fresh `origin/<batch>`". No
spec skill — an `○` line. Details — `skills/spec/reference.md`, "spec-red".

Before merging a green PR, from a repository checkout: CI
checked the merge with the default branch as it was at the time of the run,
and without a merge queue the branch moves ahead. Didn't move — `✅ merge`,
nothing is built. Moved — the PR head (fetched by its SHA, not by
`refs/pull/<N>/head`: GitHub creates that ref up to minutes late, #505) merged
with a fresh `origin/<base>` in a temporary worktree (`git merge`, like
GitHub's merge-ref; the worktree is always removed), dependencies by the
merge's lockfile (the manager — `packageManager`, otherwise the lockfile,
otherwise `.yarnrc.yml` — Yarn, otherwise npm,
`tests/standards/scripts/package-manager`; the install —
`bun install --frozen-lockfile`, `pnpm install --frozen-lockfile`,
`yarn install --frozen-lockfile`, `npm ci`; no lockfile — no install) and the
project's fast checks — the `package.json` scripts that exist, in CI order
until the first red: `typecheck` (a semantic conflict of two PRs: one removed a
function, the other calls it — seconds, #292), then `test:spec` — standards and
architecture, where two green PRs break ("registry + invariant"), not the
whole `test`. None of them — an `○` line, merge. The merge has `tests/standards`
or `tests/architecture` but no `test:spec` — an `○` line that they aren't
checked on the merge, with a pointer to the project's `check` (it requires the
script and names the line, #442); the merge isn't stopped. GitHub doesn't store what CI
checked, so "moved" is judged by time (REST): the earliest check suite of the
PR head against the branch's last event (Activity API); an event within a
minute before the check suite also counts as moved (the merge-ref is built
earlier); no checks or the event wasn't read — it is checked. Codes (#842 —
done, a step, an error; the step is told by the last line, `Next:`, as `task
next` prints it): `0` — merge: `Next:` — the merge command, and the mark
`premerges/<owner>__<repo>__<PR>.json` of `~/.config/elves` (the head, the
time) lets `task next` name the merge while the head is the same and the base
hasn't moved; `1` — don't merge: red `typecheck` (compiler errors), `test:spec`
(lines of failed tests) or a conflict (files) — fix the root cause in the PR:
rebase onto `origin/<base>`, edit, `push --force-with-lease`, `ci-wait` again;
or **`main` is red, not this PR** — `Next:` names its bug's wait (below, "Red
main"); `2` — couldn't check (not a checkout, PR not open, the PR head not on
origin, dependency install failed) — don't merge either, investigate.

A PR into a batch branch (#649) — first the batch's release PR (REST,
`pulls?head=<owner>:<batch>`): open — code `1` and the wait for its close
(`wait-ci.sh issue <R>`: a subagent — a regular call with `--timeout 540`, a
session — a background command), then `premerge` again: a merge into the batch
now would change what the release's CI checked. Open and red with the PR of
one of its tasks (the task branch or `Closes #N` — the release's `Closes #N`)
— the guilty task's fix (#650): an `○` line, the check goes on as usual; a
live executor's PR (its task isn't in the release) and any PR while the
release is green or running — held, as above. Merged — code `1` and the
move: `gh pr edit <N> --base <T>`, a rebase onto `origin/<T>` (the batch's
commits are there already, rebased, with other SHAs — GitHub's rebase merge
would replay them), `push --force-with-lease`, `premerge` again (into the
default branch — `ci-wait` first).
`T` — the dispatcher's next batch (its session's marker: a subagent shares
the id), without one — the default branch: the task leaves the batch — the
full CI, after the merge the deploy wait, the epic refresh and `task close`.
A release closed without a merge, or none — the check by git (#676): a PR
into a batch branch runs no CI, nor does the batch branch — the base's red
checks and the CI's time aren't read; the head on a fresh `origin/<batch>`
(`git merge-base --is-ancestor`) — `✅ merge` without checks: the
executor's checks before a commit checked this tree; the batch moved on past
it — the fast checks on the merge, as above, a red or a conflict — the fix,
then `premerge` again, no `ci-wait`. On the merge path any
PR whose commits are in `origin/<base>` already by their changes (`git cherry`
`-` lines) — code `1`, the rebase onto it drops them: a PR moved off a released
batch carries the batch's commits from before the release's rebase — GitHub
moves such PRs into the default branch itself when it deletes the merged
release's head (a repository that deletes head branches on merge).

### Red main

The merge is red (#282) — the failed check is also run on bare
`origin/<base>` in its own temporary worktree: red with the same — «`main` is
red» (code `1`, `Next:` — its bug's wait; before #842 — a code of its own, `3`);
the PR breaks beyond it (failed tests and compiler errors of the merge that
aren't on `main`, ignoring run time and position in the file) — code `1` with
them. A red check on the default branch's last commit — a check-run (the last
run of each name: `failure`, `timed_out`, `startup_failure`; a cancelled one
isn't red) or a host status (`failure`, `error`) — the same «`main` is red» before
checking the merge; checks not read — an `○` line, the check goes on. The
base's checks are its own runs (#732): a check-run of another branch's run on
the same SHA (its check suite's `head_branch` — a batch branch pushed at the
tip of `main`) and a red run that started after every cancelled run of its
check suite had finished (an aggregate like `ci-ok` of a superseded run; a
fail-fast job started before them and stays red) aren't red — an `○` line
each, not counted; `wait-ci.sh merged` likewise waits only for the runs of
the PR's base. The spec
publish job (`spec-publish`, `<job> / spec-publish`) isn't a check of `main`:
red, it is an `○` line and not counted (#443). With
«`main` is red» the session doesn't merge and doesn't fix it in its PR: one bug for
everyone — an open issue titled «`<base>` is red…» (REST
search) that names the failed check (or script) — the whole name: `test` isn't
in "test:spec" (#338); open ones about another check — the line
`○ … about another check: don't wait`. Found — a
line with the number and the wait command `wait-ci.sh issue <N>` (the `ci-wait`
skill, as a background command: its completion wakes the session), then
`premerge` again; for a failed check that none of them names — a hint to find
an open bug on the failed test (under another title) or the command
`task new --type Bug` with the title
«`<base>` is red: <check | typecheck | test:spec>» (`--priority Urgent` in an
organization; add the failed test's decision label), the question to the owner
whether to queue the bug and the same wait. A PR that closes any open «`<base>` is red…» bug (`Closes #N`
in the body) is a fix, without matching the check: the same breakage is named
by a script one time and by a CI check another; a red `main` doesn't stop it
(an `○` line), its red merge is code `1`, as usual.

A task's own regression (#699) has no «`<base>` is red…» bug: the bug is the
reopened task, and its fix is a PR that closes it. So a PR whose `Closes #N`
names a task of the red push — `Refs #N` or `Closes #N` in the commits of the
red commit's check suite (`before`..the commit; without `before` — the commit
itself), or `Closes #N` of the PR merged by them (a batch's release) — is a
fix as well: the line «this PR fixes red `<base>`: it closes #N, whose commit …
made it red», the check goes on as usual. A PR of another task — «`main` is red», as
before. A red GitHub Actions job names its first failed step next to the check
in parentheses, in the reason and the bug title: a step without a test
(install, network) has no decision label, the bug goes by the check and the
step.

### task resume

A background wait (`ci-wait`) dies with the app's process,
and a session resumed after a restart doesn't know it (#433). The command reads
the task pinned to the session (`task status` above; the repository is in the
pin, not the checkout) and its PRs — linked, otherwise by the task branch, as in
`task close`: an open PR — `wait-ci.sh pr <PR>` as a background command; only a
merged one and the task is open — `wait-ci.sh merged <PR>` where the merge
deploys, then `task close N`; no PR or the task is closed — an `○` line; no pin
— nothing, without a request to GitHub; a line not of the form `owner/repo#N` —
an `○` line with the file path, code 0. Read-only. The Claude Code
`SessionStart` hook runs it with the session id from its input (`check
--hook`, `claude/CLAUDE.md`) — the machine's skill, otherwise the project's. In a
dispatcher session — or one with its own task and executors (#546) — it first
says to continue the stopped executors (#528):
they stopped with the app's process, their transcripts are intact, and the
app names them in its notification — each is continued with `SendMessage` by
its id, with its context in its own worktree (the task branch, uncommitted
work), then the queue command, if the session ran one; the hand-outs
(`dispatchers/<id>.tasks`, "task queue") stay; then its own task's wait. A new executor — only for one that can't be continued, with the
same prompt: a task In progress it continues in the worktree of its branch
(the assignment's restart line), not in a new one — git won't give the branch
to a second worktree.

### hook guard

The Claude Code `PreToolUse` hook (#839) — `install -g` puts it into
`~/.claude/settings.json`, one handler per row of `scripts/bypasses.ts` with its
`if` rule. The input on stdin is the Bash call; a bypass of a flow command in it
— `gh issue view <N>` of the session repository's task (→ `task show`),
`gh issue edit <N> --body…` (→ `task edit`), `gh run watch`, `gh pr checks
--watch` (→ `wait-ci.sh pr <N>` as a background command) — gets a deny
(`permissionDecision: "deny"`) whose reason ends with the command to run
instead. A compound command is split as Claude Code's `if` splits it (`&&`, `|`,
`;`, `$(…)`, backticks); a heredoc body, text in quotes and a comment aren't
commands. Not a bypass: another repository — `--repo`, `GH_REPO`, an issue URL,
a `cd` into another checkout, a directory without a GitHub origin — and a read
the flow has no command for (`--json`, `--web`, `gh pr checks` without
`--watch`). Code 0 always: the hook's own error lets the call through; no
network — `git remote get-url` per directory. A new bypass — a row of
`bypasses.ts` and its cases in `tests/capabilities/github/github-guard`.

### task queue

The dispatcher: "do all tasks of epic #M", "fix all High bugs", the owner's
"yes" to «run the dispatcher on epic #M?» (`AGENTS.md`, "Task
tracking") — any session; one with its own task keeps it pinned, and its task
is `=` in the queue. The rules are a model in code, `scripts/queue.ts`: a
task's state by its facts, the transitions between the states, the
dispatcher's step; why each rule is so — the decision
`tests/capabilities/github/github-queue` and its tests, one per transition.

- `task queue` — the queue: `+` ready tasks, each with an indented line — its
  executor's prompt, «Task #N …» in the project language (`est` links the
  subagent's work by it); `=` in work, `○` not ready, with the reason; `Next:` —
  the dispatcher's step. `--epic N` — the epic's open sub-issues; `--tasks
  N,M,…` — the owner's group: every queue after an answer, and after the app
  restarts (`task resume`), hands out only them, a new batch after a release —
  only from those still open; a task created meanwhile (by an executor, by the
  epic refresh) joins only by the owner's word — `task queue --tasks` with it;
  otherwise the repository's open tasks (the first 100 of the search). `--type`,
  `--priority` — only in an organization.
- `task queue --assignment N` — the executor's first call, read-only on GitHub:
  its whole assignment — by the canon, in the project's mode (`"auto"` in
  `.agents/elves.json` of the checkout), into the batch or past it, a red
  release's fix; the script prints it, this reference doesn't retell it.
  `--session` — the prompt of an app executor session, called by the
  dispatcher itself; `--main` — past the batch (below).

The queue marks the session as a dispatcher: `dispatchers/<CLAUDE_CODE_SESSION_ID>`
in the configuration directory — the queue command, then a line `batch
<owner/repo> <branch>` per batch (`task resume` reads only the command). The
executors are subagents with the session's id: without the marker their `task
status` would pin their tasks, and `est` would take the whole session as one
task. The assignment records the hand-out — a line `owner/repo#N <worktree>`
(the checkout it's called in; `@session` for an app session, `@main` past the
batch) in `dispatchers/<id>.tasks` — in any session but one pinned to N: a
session with its own task, or none yet, launches an executor on the owner's
"yes" too. A hand-out lasts for the session. A restart while the previous
executor or its subagent is alive — `!` lines with each live worktree, no
hand-out, code 1: the answer «waits for the previous executor».

#### A task's states

| State | The queue reads it by | Line |
|---|---|---|
| `notReady` | an epic; Status Done while open; a blocker that holds — open and not merged into this batch (another repository's — `owner/repo#N`), or closed by its PR's merge before its `task close`; the `external blocker` label (the reason — the latest `External blocker: …` comment); ready while the batch's release is open — held | `○` with the reason |
| `ready` | open, not an epic, not in work, nothing holds it | `+` with the prompt; by `Priority`, then the number |
| `handedOut` | handed out to an executor of this session (a subagent, an app session), or In progress (the board, or by the facts: the task branch on origin, a session pin) without a PR | `=` |
| `prOpen` | an open PR — linked, or by the task branch or `Closes #N` among the recent PRs | `=` with the PR's link |
| `inBatch` | its PR merged into the batch branch, no open PR — GitHub links a PR to a task only by a merge into the default branch, so the queue finds it by the branch or `Closes #N` | `=` till the release |
| `releaseOpen` | merged into the batch, the batch's release PR open | `=` |
| `releaseRed` | the same, the release's checks red | `=` |
| `released` | merged into the default branch, its tail not over: by its own PR — the executor's (the deploy, the epic refresh, `task close`), by the batch's release — the dispatcher's | `=` — of its own PR only |
| `closed` | closed, `task close` passed (Status Done, the actual), or closed without a merge | none |

A hand-out is `=` for the whole session: an executor's answer doesn't make its
task ready again — merged closes it, a question waits for the owner, waits for
subagents answers again, failed isn't restarted. A hand-out past the batch
(`@main`) — `=` with «past the batch».

#### Transitions

| From | Event | To | By |
|---|---|---|---|
| `notReady` | `unblocked` | `ready` | GitHub |
| `notReady` | `releaseMerged` | `ready` | dispatcher |
| `ready` | `handOut` | `handedOut` | dispatcher |
| `ready` | `blocked` | `notReady` | owner |
| `ready` | `releaseOpened` | `notReady` | dispatcher |
| `handedOut` | `prOpened` | `prOpen` | executor |
| `handedOut` | `closedWithoutPr` | `closed` | executor |
| `prOpen` | `mergedIntoBatch` | `inBatch` | executor |
| `prOpen` | `mergedIntoBase` | `released` | executor |
| `prOpen` | `fixMerged` | `releaseOpen` | executor |
| `inBatch` | `releaseOpened` | `releaseOpen` | dispatcher |
| `releaseOpen` | `checksRed` | `releaseRed` | GitHub |
| `releaseOpen` | `releaseMerged` | `released` | dispatcher |
| `releaseRed` | `fixOpened` | `prOpen` | executor |
| `releaseRed` | `fixMerged` | `releaseOpen` | executor |
| `released` | `taskClosed` | `closed` | executor |

`released` → `closed` of a release — the dispatcher's `task close` of each task
after the deploy and the epic refresh (`batch release` below); a task without a
PR is closed as completed by its executor, then its refresh and `task close`.

#### The executor

| From | Event | To | The dispatcher's step |
|---|---|---|---|
| `working` | `answeredMerged` | `answered` | task queue again |
| `working` | `answeredQuestion` | `answered` | the question to the owner; the answer — ✅ in the task and to the same executor with SendMessage |
| `answered` | `continued` | `working` | the executor goes on in its context (SendMessage; after the app restarts — task resume) |
| `working` | `answeredWaits` | `waitsForSubagents` | no restart: its subagents' answers wake it, it answers again |
| `waitsForSubagents` | `woken` | `working` | wait for its answer |
| `working` | `answeredFailed` | `failed` | a comment in the task with what stopped, no restart |

The script reads an executor by its worktree: locked by a live process (Claude
Code locks a running agent's worktree; a lock whose pid is gone doesn't hold)
or HEAD moved in the last 15 minutes (a continued executor isn't locked again)
— `working`; a subagent of it without a worktree of its own at work in it
(Claude Code's subagent metadata of this session and of the sessions with
hand-outs, at any depth; its transcript written in the last 15 minutes) —
`waitsForSubagents`; otherwise — `answered`: failed only its answer tells.
Alive — `working` or `waitsForSubagents`: a restart's assignment refuses, its
worktree stays. The previous executor of a task — its hand-outs in any
session's `dispatchers/*.tasks` and a worktree on the task branch; its
subagents' — by `parentAgentId`, at any depth.

#### `Next:` — the dispatcher's step

The first of these the queue's tasks call for: a state's step is the `step` of
its first transition with one in `queue.ts`; the open release is the batch's,
whatever the group.

| Step | When | The dispatcher |
|---|---|---|
| `fix` | the release PR is red | the guilty task's fix (`batch release` below): its executor with the printed prompt; not named by the labels — `batch release` names it |
| `releaseSteps` | the release PR is open | its steps — `batch release` prints them; no new executors till its merge, the live executors' PRs wait for it |
| `handOut` | a task is ready | each — a background executor while fewer than the machine's run |
| `wait` | an executor of the batch at work (`handedOut`, `prOpen`, `released` of its own PR) | wait for the answers; outside auto each merge waits for the owner's «yes» |
| `release` | nothing ready, every task of the batch merged into it | `batch release`; tasks past the batch don't hold it |
| `waitPast` | only tasks past the batch in work | wait for their answers |
| `empty` | nothing ready, nothing in work | the summary (merged, questions, the not ready ones, new tasks outside the queue) and the last line; a group's end — no new batch |

Something merged into the batch while executors are at work — the owner's word
«release» runs the same `batch release`: the live executors go on, their PRs
wait for the release.

#### The dispatcher in Claude Code

An executor — `Agent` with `isolation: "worktree"` and `run_in_background:
true`, the prompt — the indented line as is; at most the machine's executors at
once, the owner's number replaces it (subagents share the machine: `Next:`
names its capacity — `slot --capacity`, `machine.json` or the cores and memory,
without the slot skill — 3); a task in work (`=`) isn't launched again;
another project's task — an app session in its folder: `start_session` with
`cwd` the project folder and `use_worktree` true, its prompt — the lines of
`--assignment N --session` before `Next:` as is; it works as a session of its
project, by its mode, and the end of each of its turns comes as the app's note.
Before each launch — `get_usage`: a window of `plan.windows` at 85% and
more — any but the window of a model the executors don't run on (`Weekly ·
<model>`; theirs — the dispatcher's own unless the launch names another) — no
new executors, the running ones finish, then `Remaining: N tasks, the limit:
<its label> <percent>%, extra usage <percent>% of <monthly limit>` (or `extra
usage off`). Extra usage doesn't lift the stop: money past the plan is the
owner's decision; after the owner's «yes» to it — launches until
`plan.extraUsage.percentUsed` is at 85%, then `Remaining: N tasks, the limit:
extra usage <percent>%`. `not_applicable` (an API key, Bedrock, Vertex, a
gateway) — no plan limits: executors by the machine's capacity; `unavailable`
— asked again if its note says that helps, otherwise no new executors, the
running ones finish, `Remaining: N tasks, limits unavailable`. An
answer arrives as the subagent's notification; after each — `task queue`
again, the answer handled by the executor's table above. A merge question
outside auto — the owner's «yes» to the same executor, the merge is its. The
owner's restart — the refused assignment's «waits for the previous executor»:
wait for its answer, not a third executor. Failed on an external blocker — it's
recorded ("Dependencies" above), the queue holds the task till it's lifted.
After the app restarts — `task resume`. Queue empty and nothing running — the
summary, the last line and, in auto mode, archiving; a session with its own
task — after it. A running executor isn't stopped (`TaskStop`) to archive the
session: its answer comes first.

Archiving: an executor session whose task closed — the dispatcher archives it in
an auto project, not one still working in the background or awaiting the
owner's answer; outside auto the owner closes it. Closed — `task close` passed:
the PR merged, the deploy green, the actual written. Auto — `"auto": true` in
`.agents/elves.json` of the session's project. An archived session leaves the
list, and the owner wouldn't read its question; one with live background work —
the app refuses ("still has live work"). The step is the queue's last line; in
Claude Code — `archive_session` with the session's id, refused — not retried
(`claude/CLAUDE.md`).

#### Executors' worktrees

Before the queue, in the repository's checkout, the queue removes what finished
executors left — an agent's worktree (`.claude/worktrees/agent-*`) detached, on
a `worktree-agent-*` branch or on a closed task's branch, its executor not
alive, its task not live (open, or closed by its PR's merge before `task
close`), clean and merged: no commits outside `origin/<base>` by `git cherry`,
or its HEAD in a merged PR of its closed task — into the default branch or a
batch its merged release PR shipped (a release rewrites the task's commits past
`git cherry`). Removed with its branch — a `+` line; uncommitted changes,
unmerged commits or a subagent at work in it — left, an `○` line with the
reason; a `worktree-agent-*` branch without a worktree — the same by its
commits. A session's worktree is never touched. The dispatcher doesn't remove
an executor's worktree itself (`git worktree remove` after a clean `git
status`): a subagent without a worktree of its own leaves no trace in `git
status`, and its directory would go from under it.

Claude Code's own cleanup doesn't replace this (its documentation, "Worktrees"
and "Claude directory", checked 2026-11-17): a subagent's worktree goes at its
end only without changes; one with commits waits for the periodic sweep, which
removes it once older than `cleanupPeriodDays` (365 on the machine: `est fact`
and `est period` read the transcripts it also removes) and keeps one with
unpushed commits — an executor's subagent's commits, carried into the task
branch, stay unpushed on its own branch. The queue removes by the task's facts
— merged and closed — not by age.

#### A batch project

`"batch": true` in `.agents/elves.json` of the dispatcher's checkout (`install`
and `update` carry it over): the dispatcher's tasks go into the default branch
with one release — one full CI run and one deploy — instead of each its own,
and a task PR into the batch runs no CI (`skills/spec/ci.md`, "Batches").

- **The batch branch** `batch/<YYYY-MM-DD>-<k>` (not `release/*`: git-flow
  projects have it): the first queue with a ready task creates it from a fresh
  `origin/<base>` — `k`, the first free number of the day on origin, in the
  marker and among the recent PRs' branches — and pushes it without a local
  branch, a `+` line; nothing ready — no branch, an `○` line. The next queues
  take the same (the marker). Released (its release PR merged) or gone from
  origin — the next one starts with a ready task; a released batch branch
  still on origin is deleted without an open PR into it (`+`), kept with one
  (`○`) till its executor moves the PR (`pr premerge`). No session id, not a
  checkout of the repository, git failed — no batch: the executors go into the
  default branch.
- **An executor of the batch** — the task branch `exec/<type>/<N>-<slug>` from
  `origin/<batch>` (the area `exec`: a preview host that builds every pushed
  branch decides by its name — Vercel: `"git": {"deploymentEnabled":
  {"exec/**": false}}` in `vercel.json`), the PR `--base <batch>`, the merge
  right after the checks before a commit and `pr premerge` (it checks against
  the PR's base) — no CI, no deploy, no epic refresh and no `task close`: it
  refuses a task merged only into a batch branch; `task actualize` names the
  batch PR as what shipped. A task without a PR isn't in the batch — its
  refresh and close are its executor's. The task's stacks don't wait for the
  release: the assignment names `task-env down <N>` before the answer, `task
  finish` of a PR merged into the batch and the queue take down those of tasks
  merged into it; `task close` at the release finds them gone.
- **Past the batch** — the owner's word «past the batch»: `--assignment N
  --main` (with `--session` too) — the branch from `origin/<base>`, the PR into
  it with the full CI, the deploy, the refresh and `task close`; the hand-out
  keeps `@main` (a restart keeps the way, `task finish` opens the PR into the
  default branch), the release doesn't wait for it; a task of a red release
  refuses `--main` — its fix is the batch's. A session outside the dispatcher
  (one task, a hotfix) — into the default branch.

### batch release

The release of the dispatcher's batch — one full CI run and one deploy for the
batch. From the dispatcher's checkout of the repository, outside the sandbox:
`batch release` (the session's batch, from its marker) or `batch release
batch/<YYYY-MM-DD>-<k>`. The batch's tasks — every PR merged into the batch
branch (a query by the base, not the recent PRs: a task missed is one the
release doesn't close): the task branch's number and `Closes #N` of its body.
The rules are the queue's model, `scripts/queue.ts`: the release's state by
its PR and its checks, the transitions, the step; why each rule is so — the
decision `tests/capabilities/github/github-release` and its tests, one per
transition.

#### The release's states

| State | `batch release` reads it by | It does |
|---|---|---|
| `none` | no release PR of the batch | nothing merged into the batch — refuses; otherwise the decision labels of each task's PR into the batch by `pr labels`' rule — a label its task or epic lacks is set (`+`), a PR not read — `!` with `pr labels <PR>`; the batch rebased onto a fresh `origin/<base>` in a temporary worktree (always removed) and pushed `--force-with-lease` against the SHA read — on it already, `=`; a conflict — `!` with the files, the branch unchanged, no PR, code 1: rebase it by hand in the checkout, then again; the PR into the default branch (`opened`); open PRs into the batch — `○`: not in the release, their executors go on, their `pr premerge` holds the merge till the release, then moves the PR |
| `open` | the release PR open, its checks running, none yet or green | `=`; its title and body rebuilt from the PRs merged into the batch now and its head (a red release's fix merged after it opened, its `Closes #M`) — the same, `=`, otherwise a PATCH and a `+` line naming the tasks added |
| `red` | the release PR open, a check `fail` or `cancel` | `!` with the checks; its body rebuilt as `open`'s; the guilty task (below) |
| `merged` | the release PR merged | the batch executors' worktrees and branches removed (the queue's rule) |

#### Transitions

| From | Event | To | By | Step |
|---|---|---|---|---|
| `none` | `opened` | `open` | batch release | — |
| `open` | `checksRed` | `red` | GitHub | — |
| `open` | `merged` | `merged` | dispatcher | `checks` |
| `red` | `fixMerged` | `open` | executor | `fix` |
| `merged` | `nextBatch` | `none` | dispatcher | `close` |

`batch release` makes its own transition (`opened`) and prints `Next:` — the
step of the state it leaves the release in: a state's step is the `step` of
its first transition with one. `nextBatch` — the queue starts the next batch
from the merged default branch, and the session's batch is that one, without
a release.

| Step | `Next:` |
|---|---|
| `checks` | its steps (below): its checks, `pr premerge`, the merge |
| `fix` | the fix of the red release (below), by the model's choice |
| `close` | the closing steps (below) |

The release PR: the title — a conventional commit by the heaviest task type
(`feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`) and
«release of `<batch>` — #N, …» in the project language; the body — the lead
with the tasks' PRs, the batch's `spec-diff` (`--base origin/<base> --head <the
rebased batch>`; not installed or failed — a line, the body without it) and
`Closes #N` of each task: the merge closes them, and `task close` finds the
release PR linked. The committer of the rebase — the machine's git identity,
none (CI) — `elves`.

Its steps: `wait-ci.sh pr <R>` as a background command; PASS — `pr premerge
<R>`, code 0 — `gh pr merge <R> --rebase` (outside auto on the owner's «yes»);
FAIL — `batch release` again: a red release. After the merge — `batch release`
again, then a dispatcher that goes on runs `task queue` at once (the next batch
from the merged default branch, a group's only from its tasks still open; the
live executors' PRs go into it), one that stops doesn't (they go into the
default branch). The closing steps: `wait-ci.sh merged <R>` where the merge
deploys and, in the same turn, the epic refresh — `task actualize` with all the
batch's tasks, one refresh per epic — after both `task close N` of each task:
GitHub closed them by `Closes`, close writes the actual and Done and removes the
branches. The release's waits and refresh are the dispatcher's, not the
tasks'.

A red release is fixed in the batch, not reverted: the full set runs first on
the release, the release PR stays open, the other tasks wait — no new
executors, their PRs held by `pr premerge`. Its checks — `checkStates` of its
head (REST), as `task show` and `ci-wait` read them: `fail` or `cancel` — red,
one running or none yet — its steps. The guilty task: the release's only task;
otherwise the files the failed GitHub Actions jobs' logs name (a failure line
of Bun, Vitest, Jest, Playwright or its file header above it, a compiler error)
— their decisions by the rule of `pr labels` against the decision labels of the
release's tasks: one task holds them — it; several (a topic's label: a section
has none) — the one whose PR into the batch changed the failed test's section
files, `tests/<root>/<topic>/<section>.*`; otherwise a bisect on the machine
(in CI a push into the batch branch starts no run): the batch's commits over its
merge-base with `origin/<base>` in blocks by `Refs #N` of the release's tasks
(a commit without one — the block before it), a temporary worktree (always
removed), dependencies by its lockfile, the check — the failed test files that
exist at the commit by the project's `test` script, a compiler error —
`typecheck`, neither named — the failed checks named like a script (the scripts
go through `slot`); first the head (green on the machine — the red isn't
reproduced, nobody is blamed) and the base (red — not the batch's), then
⌈log₂N⌉ runs — the first red block's task. Not named — a `!` line why. The
queue names the guilty task by the labels only; the bisect is `batch release`'s.

The fix — the model's choice (`redFix`), the first that holds; the text is
`fixSteps`', one for `batch release` and the queue:

| Fix | When | `Next:` |
|---|---|---|
| `wait` | a release task's fix PR is open into the batch — an `○` line, no search for the guilty task, no bisect | wait for its executor's answer |
| `guilty` | the guilty task named | its executor's fix with the printed prompt |
| `bisect` | not named by the labels — the queue | `batch release` names it: the bisect is its |
| `owner` | not named after the bisect | the dispatcher names it by the failed checks' logs (`gh pr checks <R>`) or asks the owner, then its fix — `task queue --assignment <N>` to its executor |

The guilty task's fix: its executor — continued with `SendMessage`, none alive
— a new one, with the printed prompt; its assignment is the fix's: a new task
branch `exec/fix/<N>-<slug>` from `origin/<batch>` (the task's earlier branch is
rebase-merged already), the PR into the batch with `Refs #N` after the checks
before a commit, no CI, `pr premerge` lets it through the red release. After
its merge — the full run again on the same release PR (`fixMerged`): `batch
release` prints its steps, no second PR.

### task drop

Closes as not planned (with `--duplicate-of` — as a
duplicate with a link) and removes it from the project: otherwise "Item closed"
would put it in Done and into the epic's actual. It doesn't touch a completed
one.

### task actualize

The epic refresh, right after the merge: it doesn't
depend on the deploy and runs in parallel with it, while the session at peak
context neither assembles the assignment nor reads `reference.md`. The
mechanics — itself, `+` lines (#435: the subagent collected it with ~35 calls
a run): blocked by on done tasks (closed, or this one with its PR merged) is
removed, the `questions` label without open questions in the section, a
milestone of the epic's tasks without open tasks is closed (the task's and the
epic's — by `task close`); the fixes — one line in a comment on the epic. Then
the subagent's prompt — the two lines after `Next:`, pass them as is: «Task #N
(epic #M)» (`subagentPrompt` of the dictionary; `est` links the subagent's
work to the task by it in any language) and the command of its whole
assignment, `task actualize N --assignment` — read-only, the subagent's first
call, outside the sandbox: the texts of the epic and its open tasks (its
sub-issues, not a list in its description) and the PR files run to tens of KB,
and the session would copy them into the subagent call as output tokens. In
the assignment, in the project language: the task and its merged PR (the link,
otherwise the branch or "Closes #N" among recent PRs) with its files, the epic
and its open tasks with their texts, the copies of links in text and the
answers to open questions in comments (`k. ✅ …`) the script found — named, not
edited, the checks by meaning 1, 3 and 5 from section "Epic refresh on task
close", what may be changed (only GitHub tasks; the task, the epic and their
milestone are closed by `task close`), the result — always a comment on the
epic «Refresh after #N, result: …», «the block is current» too (`task close`
waits for it) — and the answer form. A PR's diff — its `git log -p` command
(rebase-merged commits carry `Refs #N`), not `gh pr diff`.

The edits — one file, `task actualize N --apply <file>` (#669), its format and
an example in the assignment: JSON `{ "report": "…", "edits": [ … ] }`, each
edit one action on the epic or its open task (`task`) — `replace` … `with`
(`""` removes a copy of a link), `add` an `item` into a section, `check` an
item, `answer` k with `text` (`auto`), `unblock` a blocker, `close` `done` or
`not needed` (as `task drop`), `new` — a task of the epic (`body`;
`epic: false` — outside it), its number in the report as `#new1`.
Every edit is checked before any write — the description edits in order, each
on the result of the previous one, as `task edit`; a shipped task, the epic's
close, a missing text or question, a blocker that isn't there — the whole file
is refused with each such edit named, nothing changed; a file without
`report` — too. Then all are applied, the `questions` label goes from a task
left without open questions, and the report is posted on the epic. No epic, or no open tasks in the epic other than
this one — the line `○ refresh not needed`, no subagent. The order after the
merge — fewer turns (measurement #285: the extra
turns were `gh pr view` for the SHA and reading the wait result): in one turn,
as separate calls, — `task actualize N` and a background
`wait-ci.sh merged <PR>` (where the merge deploys or runs CI on `main`; the
script takes the merge SHA from the PR itself), in Claude Code — also
`ToolSearch` for the `archive_session` schema if it isn't loaded yet; next — in
the background the subagent with the assignment, if a refresh is needed; a wait
notification with code 0 — `task close N` right away, don't read the output
file (not 0 — the `RESULT:` line in it); the subagent hasn't reported yet —
close refuses before any change: close again after its answer; then the last
line of the answer and archiving — in one turn. A dispatcher's executor runs
the subagent not in the background and waits for its answer in the same turn,
before `task close` and its own answer (its assignment, #628): once it answers,
its worktree without changes is removed, and a background subagent is left
without a directory.

Several tasks — shipped together, a batch's release (#676): `task actualize N
M …` (the release's `Next:` names all its tasks) groups them by epic — one
refresh per epic, not per merge into the batch: the mechanics, the prompt
«Task #N, #M (epic #E)» and `task actualize N M --assignment` (the tasks of
one epic; of several — a refusal); a task without an epic — the `○` line. In
the assignment a released task's PRs are its own into the batch, not the
release PR with the whole batch's files; the report — «Refresh after #N, #M,
result: …», one for them all.

### task close

The closing ritual in one call, not a step per turn at the
session's largest context. Only after the task's PR is merged (or a close
without a PR): a PR that is open or closed without a merge — an error before
any changes. GitHub sometimes doesn't link a merged PR to the task for hours —
then the task's PR is searched among the default branch's recent PRs by the
branch `<type>/<N>-<slug>` and "Closes #N" in the body: merged — the task is
closed with the comment «Closed by PR #M: GitHub didn't link the PR to the
task», none — a refusal
listing what was checked (no manual `gh issue close` needed). No PR at all and
the task open — the refusal also names the step a task without commits (a data
edit, a reconciliation, research) lacks: `gh issue close N --reason completed
--comment "<result>"`, then `task close N` again (#628). The epic has
open tasks besides this one and no report of the refresh on it — a comment
with «Refresh after #N, result:» in any language of the dictionary, case and
markup aside; the script's own «Refresh after #N, script: …» comes before the
subagent and isn't it — a refusal before any changes, with what to do: the
subagent is at work — wait for its answer, it wasn't launched — `task
actualize N`, it answered without the comment — post it (#571). A batch's
task closed by its release (#676) — by the epic: the release's tasks of the
epic (its `Closes #N` among the epic's sub-issues) have one refresh, a report
naming the task among them («Refresh after #N, #M, result:») is its; the
refusal names that set and `task actualize N M`. Order:
close the task if the merged PR didn't; a task of the scripts' own repository
(Elves) — the scripts' clone (the checkout the est script is in) catches up
with the merged `main`: `git pull --ff-only origin main`, the line
`+ clone <dir> <a> → <b>` (already there — `=`); a dispatcher's executors call
the clone's scripts, and nothing else updates it during a session; on another
branch or with uncommitted changes to tracked files — an `○` line, not touched
(untracked files don't count), a failed pull — a `!` line, the actual is by
the clone's code; another project's task, or the est script not in a git
checkout — no step; the actual — `est fact <N> --write` by
the est script next to it (`../est/scripts/est.ts`; missing — the line
`○ actual unavailable`, failed — its error as a `!` line, the
rest is done); `Status` Done; the last sub-issue closed — the epic is closed
and gets Done; no open tasks left in the task's (and the epic's) milestone —
the milestone is closed (REST); the task's stacks (the `task-env` skill) —
`task-env down <N>` by the script next to it (`../task-env/scripts/task-env.ts`;
missing — the line `○ task stacks: task-env is not installed`) in the
checkout: the dev and e2e stacks `<project>-<N>` and `<project>-<N>-e2e` go
with their volumes, its lines (`+`, `○`, `!`) are printed as is; no compose
file in the checkout — an `○` line, Docker isn't called; a failure — a `!`
line, the rest is done, and `task-env prune` finds the stack later; the merged
branches — per the "Right after a PR merge" item of section "Git, PRs and
merging — full rules" below: the branch of every merged PR of the task —
linked or found by the branch and "Closes #N", as above: a follow-up fix to a
merged PR is the same task, and GitHub doesn't link it — and the checkout's
task branch; the checkout moves off a removed branch to `origin/<base>`
detached, the local and remote branches are deleted; a branch without a
merged PR is merged only by `git cherry`; not merged or someone else's — an
`○` line, nothing is touched. After a batch's release (#649) the release PR
is the task's merged PR — `Closes #N` of its body links it: its head, the
batch branch, goes — while a live executor's PR is into it, kept, an `○` line
(deleting a PR's base closes it or moves it into the default branch past the
dispatcher; the queue deletes the branch later), — and so does the task's PR
into the batch (all the batch's PRs, by a query by the base), the checkout
moving to the default branch. The release merged without `Closes #N` (#819:
a red release's fix PR closed the task, merged into the batch after the
release PR opened, and the release went without a rebuild) — every batch of
the task's PRs released: no refusal, the release PR is the task's merged PR,
as if GitHub had linked it — the task is closed with the comment «Closed by
PR #R…»; a batch not released yet — the refusal, as before. A PR of the task
on another task's branch (`Closes #M` in a fix PR of #G) — after the actual
the line `○ #M was done in PR #X on the branch of #G …`: the work went in
#G's session, an actual of M unavailable is in #G's. The directory
isn't a checkout of the repository — neither stacks nor branches are touched
(an `○` line: both are named by the checkout's `origin`); a checkout — the
`owner/repo` of its `origin` equals the task's repository, case aside, not a
URL substring: `elves-tools` isn't a checkout of `elves` (standard
`origin-repo`, the same for `pr premerge`). The command doesn't delete the
session's worktree — the `Next` hint; an agent's (`.claude/worktrees/agent-*`,
a dispatcher's executor) — an `○` line: the dispatcher's next `task queue`
removes it. `--no-git` — without the git step, the
stacks still go. The last output line — the end-of-session steps: the last
line of the answer, one of three
(wording in the project language — `AGENTS.md`, "Language"):
`All done. The session can be closed.`; the owner has something to decide —
`All done, but there are questions: …` with the questions themselves;
something remains — `Remaining: …`. In auto mode after
`All done. The session can be closed.` — archiving the session where the agent
has the tool (the command doesn't read the manifest — the condition is stated
in words); after the other two lines — no. Information without a decision (an
observation, a deadline, a warning) isn't a question: the line and archiving
are the same.

## Git, PRs and merging — full rules

Principles — `AGENTS.md`, section "Git, PRs and merging"; here — the full
rules (the short form — `SKILL.md`, "Git, PRs and merging — mechanics").
Waiting for checks, the full SHA and a merge that deploys —
`skills/ci-wait/reference.md`.

- **Merge — rebase only:** `gh pr merge <N> --rebase`; other methods in the
  repository are turned off by `project fix` (item 11 of section "What is
  checked"). The branch's commits themselves land in `main` — each a
  conventional commit with `Refs #N`.
- **Branch only from a fresh `origin/main`** (`git fetch origin && git switch
  -c <branch> origin/main --no-track`): the local `main` and the git status
  snapshot at the session start are stale.
- **Tests go in the same commit as the code they cover:** a tests-only commit
  is red, and with a rebase merge it lands in `main` as is — a red commit in
  `main`'s history breaks `git bisect`.
- **Merge without a queue:** a PR is merged as soon as its own CI is green and
  GitHub merges it without a conflict; the branch needn't be up to date —
  GitHub merges a branch that fell behind: the default-branch ruleset
  (required checks, no strict) is set by `github project fix`. Rebase onto
  `origin/main` and `git push --force-with-lease` (not `--force`), with
  permission as usual, — only on a textual conflict or my own changes; after
  such a rebase — recheck what depends on shared state without a textual
  conflict: migration and decision numbering, shared lists.
  **Before merging — `github pr premerge <N>`** (after `ci-wait` PASS): if
  `main` moved after the PR's CI — `typecheck` and `test:spec` on the merge
  with a fresh `main`; code `1` — don't merge: fix the root cause, or —
  `main` is red by itself, its `Next:` says so — don't fix it in my PR: the
  «`main` is red…» bug, wait for it to close
  (`wait-ci.sh issue <N>`) and `premerge` again. A window remains: an
  incompatibility with a PR merged during the check itself shows up as red CI
  of the next PR (it checks the merge-ref on top of a fresh `main`) — fix the
  root cause. Someone else's branch rule with strict won't merge a branch that
  fell behind — then rebase, not `gh pr merge --admin` (a bypass — only on the
  owner's direct instruction).
- **Before a push** — `git branch --show-current` (my own branch, not the local
  `main`: after a series of checkouts and rebases a push went past the PR).
- **Merge in auto mode in Claude Code — as a separate call:**
  `gh pr merge <N> --rebase` — the whole command, without `cd`, a pipeline,
  `;` or `&&`. The app's permission classifier refuses a merge without human
  review; before the classifier it is decided by the narrow rule
  `Bash(gh pr merge *)` in `permissions.allow` of the machine settings
  (`~/.claude/settings.json`), but the rule must match each part of a compound
  command separately: a part without its own rule (`gh pr view`) hands the
  whole command to the classifier. The merge result is this call's exit code:
  `0` — merged. The rule is set by the owner: the agent doesn't widen its own
  permission settings, and the project's `"auto": true` doesn't bind the
  classifier. Refused even as a separate call — there is no rule: I don't retry
  the merge or push it through in another form; `Remaining: merge — from the
  owner` (a rule in the machine settings or a word in chat).
- **After such a merge `gh pr view` isn't needed:** the merge result is the
  exit code, the merge SHA is taken by `wait-ci.sh merged <N>` (an unmerged PR
  — ERROR), `task close <N>` reads the PR itself and refuses on an unmerged one
  before any changes. `gh pr view` isn't among the app's built-in read-only
  commands — the classifier decides it, and the classifier sees the session's
  calls but not their results or the rule the merge passed by: to it, this is a
  merge without review. If a read is still needed — a narrow query as a
  separate call (`gh pr view <N> --json state`); a wider query right after the
  merge (`--json state,mergedAt,mergeCommit`) was refused as
  `[Merge Without Review]`, its retry — as `[Auto-Mode Bypass]`: after a
  refusal I don't repeat the command or get the same thing in another form —
  `Remaining: … — from the owner` (their word in chat or a rule for the command
  in `permissions.allow` of the machine settings).
- **Right after a PR merge — I delete what was merged entirely, without
  asking** (a `github task close` step): the session's checkout off the merged
  branch —
  `git fetch --prune && git switch --detach origin/main && git branch -D <branch>`,
  the remote branch — `git push origin --delete <branch>` if the host didn't
  delete it, the task's Compose stacks with their volumes (`task-env down
  <N>`), my own worktrees and the session's other temporary resources.
  "Merged" — by the PR (`gh pr view <N> --json state` = `MERGED`) or
  `git cherry origin/main <branch>`, not `git branch --merged`: after a rebase
  merge the commits in `main` have different SHAs, git doesn't see that the
  branch is merged — the session panel and `git status` call for a second PR,
  and a push from it would resurrect the deleted remote branch. I don't touch
  others' branches or worktrees of live sessions, unmerged work — never. The
  next task — not in this session.
- `gh pr merge --delete-branch` from a worktree doesn't delete the local branch
  (an old gh fails with `'main' is already used by worktree`) — this isn't a
  merge error: I check `gh pr view <N> --json state`, I don't repeat the merge.

## Manual commands

What the skill's commands don't cover: editing an already created task and
milestones.

### Issue types

In an organization `project fix --confirm` checks and configures the types
(Task, Bug and Epic named in the project language, Feature disabled; needs the
`admin:org` scope). A personal account has no types — an epic is marked with
the `epic` label.

```bash
gh api -X PATCH repos/{owner}/{repo}/issues/<N> -f type=Bug     # change the type
gh issue list --json number,issueType --jq '.[]|select(.issueType.name=="Epic")'
```

### Priority on an existing task (organization)

```bash
# ids of the field and its options
gh api graphql -f query='{organization(login:"<org>"){issueFields(first:10){nodes{... on IssueFieldSingleSelect{id name options{id name}}}}}}'
# set it; issueId — the issue's node_id
gh api graphql -f query='mutation{setIssueFieldValue(input:{issueId:"<node_id>",issueFields:[{fieldId:"<field id>",singleSelectOptionId:"<option id>"}]}){issue{number}}}'
# read: issue.issueFieldValues{nodes{... on IssueFieldSingleSelectValue{field{... on IssueFieldSingleSelect{name}} name}}}
```

### Subtasks and dependencies on an existing task

```bash
SUB_ID=$(gh api repos/{owner}/{repo}/issues/<subtask> --jq .id)     # id, not the number!
gh api repos/{owner}/{repo}/issues/<epic>/sub_issues -X POST -F sub_issue_id=$SUB_ID
gh api repos/{owner}/{repo}/issues/<epic>/sub_issues                # list of subtasks
BY_ID=$(gh api repos/{owner}/{repo}/issues/<blocker> --jq .id)      # id, not the number!
gh api repos/{owner}/{repo}/issues/<N>/dependencies/blocked_by -X POST -F issue_id=$BY_ID
gh api repos/{owner}/{repo}/issues/<N>/dependencies/blocked_by      # who blocks N
gh api repos/{owner}/{repo}/issues/<N>/dependencies/blocking        # whom N blocks
gh api -X DELETE repos/{owner}/{repo}/issues/<N>/dependencies/blocked_by/$BY_ID
```

### Milestones

```bash
gh api -X GET repos/{owner}/{repo}/milestones -f state=all           # list
gh api repos/{owner}/{repo}/milestones -f title="Billing · 1 · Design" -f description="Epic: #42"
gh issue edit <N> --milestone "Billing · 1 · Design"
gh api -X PATCH repos/{owner}/{repo}/milestones/<number> -f state=closed
```

### Numeric project fields

`Actual, h`, `Tokens, M`, `Cost, $` are set only by the `est` script
(`github task close` runs it), never by hand; an epic's — the sum of its
subtasks', `est fact <epic> --write`. Project, field and option IDs — `gh
project view` / `gh project field-list` (in the JSON of `gh project item-list` the keys of Cyrillic-named fields are
garbled — don't rely on them; `est` finds fields by exact name via GraphQL).
