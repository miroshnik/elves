# Elves clone

The canon is this repository's `AGENTS.md` and `claude/CLAUDE.md`. Claude
Code loads it from the machine — `~/.claude/rules/elves.md` and
`elves-claude.md` (`bun bin/elves.ts install -g --link`: symlinks to the
clone). This file keeps Claude Code from reading the root `AGENTS.md` a
second time: without a `CLAUDE.md` it reads `AGENTS.md` itself. No such
rules on the machine — read both files yourself and ask the owner to run
that command.

## Rules of this repository

- **The repository is public.** No names, owners, paths or numbers of other
  repositories, no colleagues or clients — in files, git history or issues;
  examples are made up.
- **A skill is `SKILL.md` and `scripts/`** in TypeScript under Bun (Agent
  Skills; README, "Repository layout"); a repository's specifics are local
  configuration.
- **Every rule of the canon names its mechanism or is judgment** — the
  standard `documents#canon-rules`; the word budgets of the canon and
  `SKILL.md` are a ceiling, `documents#canon-size`.
- **Unused is deleted.** Monthly and before a new flow capability — the
  report `est usage`: a candidate gets a removal task or a «keep, because …»
  line in its decision's md.
