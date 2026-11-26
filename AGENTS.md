# Shared rules for all projects

The Elves canon: each rule names the mechanism that holds it or stands in
"Judgment".

## This file and skills

- **Elves is for Claude Code, Bun and GitHub.** Bun's tools replace
  packages, except Next.js while its server runs under Node; Playwright,
  the e2e tool, runs under Bun: `elves check` gives ❌ to a project not on
  Bun, to a replaced package and to Playwright under Node.
- **The canon lives in Elves.** The rules, skills and references come from
  miroshnik/elves by `elves install -g`; a change to them from another
  project's session is a task in Elves without that project's names, not an
  edit of an Elves clone.
- **References load by themselves.** `elves install -g` links every
  reference with `paths:` into `~/.claude/rules`: Claude Code loads it with
  matching files.

## First step of a session

- **The SessionStart hook checks the flow.** Its `elves check --hook` lines
  say whether the machine or the project is behind and name the project's
  mode and language; I do what they say, tell the user what an update
  changed and re-read the updated files.

## Language

- **The project language.** I talk to the user and write issues, subagent
  prompts, documents, commit and PR descriptions and test names in the
  language the SessionStart hook names; code, identifiers and terms stay in
  English, and the names scripts parse back come exactly from the locales of
  the `elves:github` skill.

## What I do without asking and what needs a yes

- **Commit, push and merge ask in a project without auto.** `elves install`
  puts them into `permissions.ask` of the project's `.claude/settings.json`,
  so Claude Code asks the owner itself. With `"auto": true` in
  `.agents/elves.json` the whole task goes without asking, and I answer its
  questions by the recommendation with `github task answer --auto`, asking
  only without a clear recommendation, on a critical or a human's decision,
  or on a discrepancy that changes the scope.

## Task tracking

- **Tasks live in GitHub Issues.** Not in local lists, TODO files or the
  agent's task list: the `elves:github` skill creates and edits them, and the
  PreToolUse hook denies `gh issue view` and `gh issue edit --body` with the
  command to run instead.
- **`github task next` is the entry.** It prints the task's state and the
  one next step as a ready command, and every task command ends with the
  same `Next:` line; I run what it prints.
- **One session, one task.** `github task start` pins the task to the
  session and refuses another one with the question «queue #N?»: "yes" gives
  that task its own executor, "do it here" gets a one-sentence refusal and
  the question again. My own regression and a fix for a green PR are the
  same task.
- **Open questions first.** `github task start` stops on open questions of
  the task or its epic: I ask the user all of them in one message, each with
  options and a recommendation, and meanwhile do only what doesn't depend on
  them.
- **A big task is an epic with subtasks.** `github task new --epic` makes a
  subtask and `--blocked-by` a dependency — dependencies are GitHub links
  only, a blocker that isn't an issue is the `external blocker` label — and
  `github task queue` hands out no blocked task, `github task start` doesn't
  take one.
- **The dispatcher runs the queue.** "Do all tasks of epic #M" or "fix all
  High bugs" makes any session a dispatcher: `github task queue` prints each
  executor's prompt and, after each answer, the next step.
- **The actual comes from transcripts.** `github task close` writes it; the
  work is linked to the task by the session name, the branch, `Closes #N`
  and «Task #N», in the project language, at the start of every subagent's
  prompt.

## Git, PRs and merging

- **A branch from a fresh base.** The task branch `<type>/<N>-<slug>` starts
  from a fresh `origin/main`, and `github task start --branch` renames a
  branch a worktree tool named; into `main` only through a PR, on which
  `github project fix` sets the `elves` ruleset with required checks and
  the rebase-only merge.
- **Before a commit — `elves precommit`.** One call runs `lint`,
  `typecheck`, `test:spec` and the affected tests through the machine queue;
  the full run is CI's.
- **The tail — `github task finish <N>`.** From the push to the close: the
  PR, CI, `github pr premerge`, the merge command, the deploy, the epic
  refresh, the session's last line; I call it again while its `Next:` says
  so.

## Specification — decisions

- **Decisions with a deterministic check.** A project's spec is decisions
  held by checks — tests, lint rules, architecture checks — under
  `tests/capabilities`, `tests/architecture` and `tests/standards`: behavior
  without a check may change without agreement, code no decision claims is
  dead. The full canon is the `elves:spec` skill.
- **The check comes first, red.** A code task gets its scenarios, the future
  test names, before code, and `github pr premerge` runs the tests a PR adds
  on the base code (`spec-red`): one that passes there checks nothing.

## Subagents and worktrees

- **Heavy runs wait in the machine queue.** `elves install` wraps the
  project's `lint`, `typecheck`, `test` and `test:*` in `slot`; I run checks
  by those scripts, a full run in the background.
- **A task's services run in its own stack.** Apps, databases and e2e run in
  the task's Compose stack by `task-env up` and `task-env e2e`, not on a host
  port; `elves check` holds the compose file to the isolation rules, `github
  task close` takes the stack down.
- **A fresh worktree gets its files.** Claude Code copies `.env*.local` by
  the `.worktreeinclude` of `elves install`; dependencies I install.

## Judgment

- **Irreversible and external actions need a yes.** A deploy, a tag or a
  release, migrations and writes to live databases, external service
  settings, deleting others' data or unmerged remote branches and outgoing
  messages wait for the owner's "yes" to this action, this time; auto mode
  covers them only when the task names them, and an autonomous routine does
  exactly what its assignment names.
- **Secrets and protections need permission.** Before a token, a key, a
  bypass secret or a check disabled at the host or CI I say what will appear
  and where; a secret from chat is never stored, and I remind about its
  rotation.
- **Others' work isn't mine.** I don't touch, cancel or re-run others'
  branches, worktrees, stacks, CI runs or unmerged work.
- **A failed test gets its root cause fixed,** even when it is unrelated to
  my change or a rerun is green: no "pre-existing flake", timeouts or
  retries. A flake suspicion is the same run on the base branch, and a race
  goes by its real event, not a pause.
- **A run's result is the runner's summary,** not a wrapper's exit code.
- **A green check may hold wrong behavior.** An external API's contract goes
  by its schema or docs, intentionally different behavior in two places gets
  mirrored comments with the reason, and I check what reached the human —
  the delivered email, the page at the recipient — not my own output.
- **A mistake may look like a result.** Before a run I ask which of our
  mistakes would give the same outcome, a label is checked against what its
  number means, I edit exactly what was named, and "doesn't reproduce" comes
  with what I measured.
- **The production database is read-only.** Data and schema change by a
  migration in a PR, data the application manages never by direct DML, and
  before reporting production numbers the first query checks that the
  database is the project's.
- **"Didn't help" goes to production facts** — the logs of the real request
  and the production data, not a third reproduction.
- **A subagent gets a small unit:** about 50 turns, one decision or one
  file, because its price grows with the square of its turns; a file is read
  in one full read, independent tool calls go in one turn.
- **Commits in logical steps.** Each is a conventional commit with `Refs #N`
  and its tests; an issue doesn't repeat what GitHub keeps natively —
  sub-issues, blockers, the status, labels, the PR — and before creating a
  task I check that it doesn't exist.
- **Knowledge lives in the project.** Shared rules go into Elves, a
  project's own into its spec with the reason, an agreement from chat too:
  the agent's memory is a cache, not a source.
- **The stack stays.** I don't revisit it or add dependencies without
  asking; versions are the latest stable, a tool question goes to its
  official documentation first.
- **A pause leaves a State comment** in the issue: what is done, the branch,
  what is next and the blockers.
