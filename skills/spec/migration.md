# Migrating an old spec into tests — spec skill reference

A project with an old spec (OpenSpec, a requirements document, a technical
specification) moves to decisions with a check ("Specification — decisions",
`canon.md` next to this file). The migration is finished when every
requirement of the old spec has an **outcome**; then the old spec's corpus is
deleted. Wiring the tools — the "Wiring into a repository" section in
`SKILL.md`; here — how to sort out the requirements themselves: decisions that
the pilot migration (≈1050 requirements, 13 PRs) re-derived in every PR.

## Order

- An epic for the transition in the project repository; a subtask — a group
  of requirements (a domain, a capability), one PR per group. The first
  subtask — the `tests/` skeleton and CI, the last — deleting the corpus.
- Every group PR has an outcome table (template below) and `spec-diff` (a big
  PR — as a summary by folder, the full list — in the job summary).
- References to the old spec in code (`@see openspec/specs/…`, `design.md`)
  are rewritten to decisions group by group; the corpus is deleted last.

## Requirement outcomes

Each requirement has exactly one outcome:

| Outcome | When | What goes in the PR |
|---|---|---|
| re-verified by breaking | a test exists and catches the breakage (`spec-break` — ✅ `failed`) | the test name |
| added | no test, or `spec-break` — ❌ `didn't fail` | a new test: red first, then green |
| from code | the spec fell behind the code, the behavior has a decision trace (section below) | a test from code, the reason and the trace — in `<section>.md` |
| removed with a reason | a removal category (section below) or the requirement no longer applies | the reason — as a table row |
| home in another decision | a repeat of a general rule (standard) or of another capability's behavior | the test there, here — a link |
| test in a bug | the behavior diverges from the requirement, there is no decision trace | a task with a scenario; not pinned by a test |

"Covered" from the old spec or a coverage report isn't an outcome: an
inherited test is checked by breaking. In the pilot, false "covered" came to no
fewer than 165 per 3.6k breakages.

Template for the group PR body:

```markdown
### Migration: <group>

| Requirement | Outcome | Test · reason · task |
|---|---|---|
| <spec> · <requirement> | re-verified by breaking | `tests/capabilities/<name>` · <describe › it> |
| <spec> · <requirement> | removed with a reason | one-off data migration |
| <spec> · <requirement> | test in a bug | #N |

Total: re-verified N · added N · from code N · removed N · in another decision N · in a bug N.
```

The PR body is at most 65,536 characters: for a big group the body has the
total and the "removed", "from code" and "in a bug" rows (they are checked by
eye), the rest — as a PR comment.

## Check by breaking

`spec-break` (its section in `SKILL.md`): a breakage for one check — an edit
that must turn the test red; the group's plan — `--plan`, one breakage per run
(the first red test in an e2e serial group hides the rest), revert — always,
including after a session drop. The breakage is chosen by the requirement's
meaning: remove a permission check, return the wrong status, skip writing the
audit record — not a random line.

## Removal categories

The criterion is the canon's "A test is for a decision": a test is needed when
it's a decision, a breakage would go unnoticed and a mistake is costly. In a
migration these are removed without a test:

- **one-off data and schema migrations** — they ran once; their correctness
  lives in the migration itself and its rollback, not in a behavior test;
- **performance** — indexes, query plans, query counts — when the budget isn't
  a decision; if the budget is a decision, a targeted check stays (a
  performance budget);
- **infrastructure outside the repository** — hosting, marketplace, service
  settings, branch rules: what's checkable is already held by `github project
  check` and the production smoke test in CI;
- **the process of the old spec itself** — formatting of requirements, change
  statuses, `proposal` and `tasks`;
- **unreachable defensive code** — a branch that can't be reached through an
  entry point: delete the code or remove the requirement rather than test it
  directly (mocks of your own modules are forbidden);
- **look, texts, impression** — a product document or acceptance in the issue
  (canon: "What can't be checked isn't called spec").

## "The spec fell behind the code"

Code isn't the source of what should be: it shows how the system works, not
how it should. The source of what should be is a decision and its trace: a
commit with an explanation, a decision in an issue, a change archive. Code only
shows which decision was implemented.

- **There is a trace** — a test from code; in the section's `<section>.md` —
  the reason and a link to the trace. The old spec's requirement is removed by
  this decision.
- **No trace** — what was intended can't be told from what is accidental: a
  decision task (often a Bug) with a scenario; the current behavior isn't
  pinned by a test. Removing what people use — only by a decision in that
  task.

In the pilot ≈10 % of requirements were handled this way.

## Parallel migration of neighboring decisions

- A section belongs to one PR at a time: tags and exceptions of the section
  are removed by its owner; a neighboring PR doesn't touch its files.
- Exceptions of cross-folder checks — in the folder of the decision they
  concern (canon: exceptions — in the topic folder's `exceptions/<section>/`). Names
  that aren't statements yet aren't exceptions: `spec-doc` warns about them
  without an exit code, they are rewritten when the folder is touched.

## Scripts and seeds

Logic at a module's top level can't be checked by a test: the import runs its
side effects, and mocking your own modules isn't allowed. The core of a script
or seed goes into a module (`lib`), the test — to the core; the script itself
is a thin wrapper: argument parsing and a call to the core.

## Deleting the corpus

The epic's last subtask: all groups have outcomes and no references to the old
spec are left in the code — the corpus is deleted in one PR, together with its
mentions in the project's rules. A before-and-after comparison — from the `est`
actuals (`est history`), as a separate task, once a sample accumulates.

## Regrouping decisions into topics

A project whose decisions are flat folders — a test file named after its
folder, `tests/<root>/<name>/<name>.test.ts` — regroups them into topics with
sections (canon: "The topic rule"). `elves check` names the regrouping task
while such a decision is left; CI stays green until then, and `spec-doc` shows
a flat decision as a topic of one section. One task, one PR, in this order:

1. **Topics by the rule.** For each root — its subjects: a product area in the
   user's words for capabilities, the kind of element whose registry the
   check walks for standards and architecture. Each former decision goes into
   the topic whose subject covers it; a quality goes into the topic of the
   elements it walks; a topic of one section is fine. The list "topic — its
   sections" goes into the task before the first move.
2. **`git mv` with the former names as section names.**
   `<name>/<name>.test.ts` → `<topic>/<name>.test.ts`, `<name>.md` →
   `<topic>/<name>.md` (the other `<name>.*` files alongside), another test
   file of the folder `<name>/<file>.test.ts` → `<topic>/<name>.<file>.test.ts`
   (by its own name it would be a section of its own), a helper file under the
   section's prefix (`<name>.preload.ts`, the ESLint fragment `<name>/eslint.ts` → `<topic>/<name>.eslint.ts`), `<name>/exceptions/*.json` → `<topic>/exceptions/<name>/`, a package
   subfolder `<name>/<package>/` → `<topic>/<package>/`. The moves go in a
   commit of their own, without content edits, so history follows the files
   and `pr labels` reads them as mechanical. Each topic gets `<topic>.md`: its
   first paragraph names the subject in one phrase. A section keeps the former
   decision's name — by it the label is merged (step 4); a topic that keeps
   the folder's own name gets a section with a name of its own, and its label
   stays. `spec-diff` shows the moves as «Regrouped into topics», not removed
   and added.
3. **Cross-references.** Every path `tests/<root>/<name>/…` — in code, marks,
   tool configs, CI fragments, docs and the README — is rewritten to the new
   one; a search for each former path finds nothing outside the history.
4. **Labels.** After the merge — `github project check`, then `project fix
   --confirm`: a label whose name is a section of exactly one topic of the
   same root is merged into the topic's label on every task, closed ones too,
   and deleted. A section is renamed only after that — it has no label.
