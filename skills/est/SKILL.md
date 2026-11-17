---
name: est
description: Records the actual of GitHub tasks from local Claude Code session transcripts when a task is closed — the agent's active hours, tokens and cost in the «Actual, h», «Tokens, M», «Cost, $» fields and the actual comment (`github task close` runs it) — and sums up all of a repo's sessions over a period. When — a task is closed or a PR is merged (actual); when asked "how many hours did it take", "how much did it cost", for an actuals backfill or a recomputation (a model's rate fixed, the actual's definition changed); when comparing the flow before and after a change or spend over a period across all of a repo's sessions (`est period`).
allowed-tools: Bash(bun *skills/est/scripts/est.ts *) Bash(gh issue view *) Bash(gh pr view *)
---

# est — the actual from transcripts

The actual of a task is measured from Claude Code's transcripts, not reported
from memory — the flow is measured by it. Tasks have no
estimate: they take 15–30 minutes, and an estimate from analogs landed within
×0.5…×2 in only 48–67 % of tasks. The script `scripts/est.ts` does everything
deterministic (transcripts, GraphQL, project fields, the comment); the agent's
part is linking the work to the task (section "So the actual is found"). The
mechanics — `reference.md` next to this file; syntax and flags — `est --help`
and `est <command> --help`.

**Unit:** «Actual, h» (in the project language —
`locales/<language>.json` of the `github` skill) = the agent's active
hours on the task: all of its time except waits for the user's input (a
prompt, a command, a permission approved in the dialog, a dispatcher's
answer to its executor), however long; a wait for CI or checks counts whole,
another pause — up to 30 min (reference.md, "Waits"). Not person-hours, not
calendar time. Manual work outside the agent (> 0.5 h) the human
adds themselves as a line «+ manually: N h» in the actual
comment. The comment's language — reference.md, "Comment language".

**The source of the actual is the agent's transcripts** (local Claude Code
sessions), not memory and not a number by eye. A task done by an agent whose
transcripts `est` doesn't read has its actual "unavailable" until its source is
added. The flow doesn't run in a Claude Code cloud session
(`CLAUDE_CODE_REMOTE=true`): `est` answers there with one line and exit code 2.

**Project fields are set only by the script:** «Actual, h», «Tokens, M»,
«Cost, $» — `est fact --write` inside `github task close`; never touch them by
hand. The fields are where the repository has a board; without one the actual
is the comment alone.

Run: `bun --no-env-file <skill folder>/scripts/est.ts <subcommand> …` (Bun, no
dependencies) — the skill folder is the one holding this file (`~/.claude/skills/est`,
`~/.agents/skills/est` or an Elves clone; in Claude Code —
`${CLAUDE_SKILL_DIR}`); below abbreviated to `est`. `--repo
owner/repo` can be omitted when you work in the repository's folder (the
registry — reference.md, "Repository registry"). Without `--write` everything is
only printed — check what the script found before writing to GitHub; reruns
update the same comment (reference.md, "Writing and reruns").

## What to run when

| Moment | Action |
|---|---|
| PR merged / issue closed | `github task close <N>` — runs `est fact <N> --write` inside; recomputing the actual — `est fact <N> --write` |
| `est fact --sweep --since 90d` (without `--write`) prints «closed without an actual in <window>: N» | `est fact --sweep --since 90d --write` — fill in the actuals of closed tasks |
| A model's rate in the price list was fixed or added | `est fact --sweep --model <id> --write` — recompute the recorded actuals with it and their epics |
| The actual's definition changed (the counting of time, the split) | `est fact --sweep --recompute --since <window> --write` — every recorded actual of the window and their epics; an actual whose transcripts are gone stays |
| The actual says «Not counted again: N h already in the actual of #M» or «Overlap with the actual of #M … — recompute #M», and #M's actual is the wrong one | `est fact M --write`, then this task again — reference.md, "Double counting and shared commits" |
| `--write` ended with «not written: …» (exit code 1) | the command to retry it prints |
| Compare the flow before and after a change, spend over a period without tasks | `est period --since <before> --until <change> --since <change>` — section "Period summary" |

An epic's actual is the sum of its subtasks' actuals (`est fact <epic>` sums
them itself and says how many subtasks have no actual).

## Actual at closing

After the PR is merged and deployed (or the issue is closed without a PR) —
`github task close <N>` (the `github` skill: actual, status, epic, milestone,
branch in one call); the actual in it is computed by:

```bash
est fact <N> --repo <r> --write
```

The number is the **issue** number, not a PR's. The script finds the task's
sessions — first by pinning (the session in which `github task status` set the
task to In progress, with its subagents but another task's executors), the rest
by features (the PR's commits, the branch, `#N` in the session's name, first
prompt or a subagent's
assignment; reference.md, "Actual — how sessions are found"). It computes active
hours — including subagents and workflows — and writes a comment of five lines:
the actual (sessions, prompts, subagents, wall clock, coverage), the model spend,
turns with context, the flow's overhead turns with the $ of cache rewrites, and
the waits — CI, after the merge, checks with the slot
queue, the rest (reference.md, "Actual — the comment", "Waits"), plus the fields
«Actual, h», «Tokens, M», «Cost, $». Cost is the API equivalent at public rates,
not money charged; a model outside the price list gives tokens without a price
(reference.md, "Tokens and cost").

Coverage: `full` — all of the task's PRs are visible in transcripts; `partial` —
part of the work went past Claude Code (a second developer, another tool); `none`
— no sessions, the field isn't set, the comment says «actual unavailable».
Don't add a number by eye if the script found no actual — "no data" is worth
more than a made-up number.

Tasks we "won't do" and duplicates get no actual (they are no longer in the
project).

## Period summary — the flow before and after

A task's actual sees only the work linked to the task — you can't compare the
flow before and after a change by it. `est period` takes **all of the repo's
sessions over the period**, without linking:

```bash
est period --since 2026-08-01 --until 2026-09-05 --since 2026-09-05   # before the flow change and after
```

**$ is flow × model rate:** a model change changes $ per PR several-fold with
the same flow; the flow's effect shows in tokens, output and hours per PR, and
its overhead — in turns by kind and cache rewrites after a pause
(reference.md, "Turn kinds and cache rewrites").
Periods, columns and how to read them — reference.md, "Period summary".

## So the actual is found — linking work to the task

Without this the coverage will be `partial`/`none`, and the task's work is lost
from its actual (details — reference.md, "Linking — details"):

- the task is taken into work (`github task status <N> "In progress"`)
  in the session that does it: pinning links the whole session directly; the
  features below are a fallback for sessions without it and for sessions before it;
- the session is named `#<number> <task title>` — the name links to the task
  explicitly (stronger than the first prompt). A new task isn't this
  session's: `github task status` won't take a second one into work, a queued
  one goes to an executor — a subagent with «Task #N» in its assignment, its
  records go to task N, not to the session's pin;
- one session — one task; a branch by the convention `<type>/<issue>-<slug>`
  (`feat/42-invoice-export`) — the script takes from it both the task
  number and the type (the actual's marker);
- the task number (`#263` or a link) — in the session's first prompt (the only
  `#N` there: several numbers link it to no task) **and in the
  assignment of every subagent / workflow agent** that does this task, after the
  word «Task» or at the very start (`Task #263 (epic #250). …`, `#263 …`);
- `Closes #263` in the PR body; in a repo where tasks are closed by commits
  without a PR — `Closes #N` in the commit message;
- commit in logical steps, not one commit per PR;
- work in the session's folder, switching the branch, not in a neighboring
  worktree from the same session: work on a "foreign" branch doesn't get into the
  actual (coverage `none`);
- don't silence the output of `git commit`, `git push`, `git worktree add`,
  `gh pr create` with `-q`: a session is linked by the branch name and commit
  hashes in tool **outputs**; before `est fact` it helps to print
  `gh pr view <N> --json headRefName,mergeCommit,commits` in a separate call.

## Pitfalls

- Project fields are looked up by exact name via GraphQL; in the JSON of
  `gh project item-list` the keys of fields with Cyrillic names are mangled —
  don't rely on them.
- Claude Code transcripts live in `~/.claude/projects/<path-with-dashes>*/` and
  are cleaned up per `cleanupPeriodDays` (`settings.json` must have 365). The
  actual comment and the field are already the archive of the result; transcripts
  are needed only for recomputing.
- Sessions with < 3 prompts and no PR or commits (automatic routines) the script
  skips; if a task's actual is suspiciously small — check whether the work was in
  such a session or on someone else's branch.
