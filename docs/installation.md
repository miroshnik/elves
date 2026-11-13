# Installation — what goes where, releases, the package in a project

The commands are in README, "Installation"; here — what they need and do: what goes into a project and onto the
machine, Claude Code's hook and the agent's sandbox, the project's mode and language, releases, the package in a
project and working on the flow from a clone.

## Requirements and commands

You need `git` and [Bun](https://bun.sh) ≥ 1.2 — the installer (`bunx`) and the skill scripts run under it; a project's CI on Node adds the `oven-sh/setup-bun` step; the `github`, `est` and `dashboard` skills need [`gh`](https://cli.github.com) with the `project` scope (`gh auth refresh -s project`); `task-env` needs Docker with Compose (Docker Desktop on macOS).

`install -g` puts the canon, skills and the hook for every agent the machine has, and the `elves` command on `PATH`; a global package does the same — `bun add -g @miroshnik/elves && elves install -g`. `install` in a project runs from the root of a git repository; the package version, the manifest, the shim and the `AGENTS.md` block are committed with the project. The fallback — straight from GitHub, any command: `bunx github:miroshnik/elves <command>` (section "Releases and the up-to-date check").

`check` exits 0 — up to date, 1 — behind (in a project also: git ignores flow files, the compose file breaks task isolation, standards or architecture without a `test:spec` script), 2 — can't check; it changes nothing. `update` brings the flow to the latest release. Without `-g` — the same for the project.

## Claude Code: the session hook and the agent's sandbox

Claude Code checks the machine and the project by itself: `install -g` sets up the `SessionStart` hook, and the `check` output lands at the start of every session; a session resumed after the app restarted also gets the wait of its task to restart — background waits die with the app's process. The same hook sets up the agent's Bash: in zsh a glob without matches and `====` go to the command as is, as in bash, and `timeout` works on macOS without coreutils (`bin/shims`); `check -g` run from the agent's Bash names it if the session didn't get that. With Docker on the machine `check -g` also names the `task-env` proxy of task addresses — running or not, with the command to start it; it doesn't change the exit code.

An agent's sandbox (Claude Code's Bash) doesn't let bunx write its cache `~/.bun/install/cache` — prefix the command with `BUN_INSTALL_CACHE_DIR="$TMPDIR/bun"` — nor the install write `.claude/skills`: then run the command in your own terminal — the refusal names it, and a repeat run finishes a cut-off install.

## The project's mode and language

`install` in a project asks in the terminal whether the agent should do tasks entirely by itself — answer the task's questions by recommendation, commit, push, fix CI and merge its own PR on green checks (default — no); without a terminal — `install --auto` or `--no-auto`, without the flag the previous answer stays. `check` names the mode. With auto, `install` prints a hint for Claude Code: the app rejects a merge without human review in this mode too, and the session merges its own PR by itself only with the `Bash(gh pr merge *)` rule in `permissions.allow` of `~/.claude/settings.json` — the owner adds it, `install` doesn't change the machine's permission settings.

`install` also asks for the **project language** the agent works in: dialog, tasks, prompts, documents; the flow itself is written in English. It is stored in `.agents/elves.json` as `language` — a BCP 47 code (`ru`, `en`, `pt-BR`), `en` by default. Without a terminal — `install --lang <code>`, without the flag the previous language stays; `update` keeps it, `check` and the hook name it. The manifest belongs in git: in a checkout without it the language is unknown, the `github` skill refuses to write names to GitHub, and `check` names a manifest that is missing or not committed. The flow isn't installed into an Elves clone — `install` writes only its manifest there: these two settings, `env` and `batch` carried over as in a project.

## What goes where

**Into a project** — thin: no copy of the flow, its agents get the canon and the skills from the machine. Committed with the project:

- `@miroshnik/elves` in `devDependencies` of `package.json` — the exact version of the release, the project's package manager updates its lockfile: the harness and the skills' scripts at the project's version for its tests and CI, colleagues and the cloud session (section "The package in a project"); a project without `package.json` has nothing to pin.
- `.agents/elves.json` — `auto` — whether the agent runs a task entirely by itself, without a "yes" for commit, push and merge, `language` — the project language, `env` — the task stack settings of `task-env`, and `batch` — whether a dispatcher merges its tasks into a batch branch instead of `main` (`github task queue`).
- `.agents/slot.sh` — the machine queue's shim the `package.json` checks source (the `slot` skill).
- A block at the top of the project's `AGENTS.md` linking to the canon on the machine, `~/.agents/elves/AGENTS.md` — for the agents that read the project's file.
- The cloud session's `SessionStart` hook in `.claude/settings.json` (your own settings and hooks stay): in a Claude Code cloud session (`CLAUDE_CODE_REMOTE=true`) it installs a fresh Bun and the flow onto the session's machine and runs `check --hook`, outside the cloud it exits at once — no setup script in the environment is needed (`docs/cloud-sessions.md`).
- Updating — `update` bumps the package version: `package.json` and the lockfile, a few lines in the branch of the current task, committed with it.
- The manifest, the shim, `AGENTS.md` and `.claude/settings.json`, if the project's git ignores them (`.agents/` or `.claude/` in `.gitignore`), are un-ignored by `install` and `update` with exceptions — an Elves block at the end of `.gitignore`, committed with them; what an exception can't un-ignore (a directory excluded by a personal rule), and anything ignored until `update` runs — `❌` in the output of the install and of `check`.

**Onto the machine** (`-g`) — the canon, the skills and the hook: a thin project keeps no copy of the canon, its agents get it from the machine. `~/.agents/elves/` — `AGENTS.md`, `claude/CLAUDE.md`, `docs/*.md`; Claude Code — symlinks `~/.claude/rules/elves.md` and `elves-claude.md` (loaded in every project without the external-imports dialog), `~/.claude/skills` and the `SessionStart` hook in `~/.claude/settings.json`; the other agents — their global rule file linking to the canon (`~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, `~/.copilot/copilot-instructions.md`, `~/.config/opencode/AGENTS.md`, `~/.config/amp/AGENTS.md`; a file of your own stays) and `~/.agents/skills`. The `elves` command in the terminal — in `~/.local/bin`, or the first directory of `PATH` inside the home directory you can write to: with `--link` a symlink to the clone's `bin/elves.ts`, otherwise a shim to the machine's release (`bunx @miroshnik/elves@<version>`) that `update -g` rewrites; an `elves` of your own (a script, a global package) stays, and `check -g` names it, a command missing or of another release, an `elves` earlier on `PATH`, and — when `PATH` has no such directory — the command that adds `~/.local/bin`. A project that still has a copy loads the canon twice until it moves — the hook names it. Claude Code's prompt cache TTL is your choice: with `promptCacheTtl` or `subagentPromptCacheTtl` not set, `install -g`, `update -g`, `check -g` and the hook print a command that sets the hour and leaves the rest of `~/.claude/settings.json` alone — none of them edits the file (`docs/prompt-cache.md`). A Claude Code cloud session gets the same from the project's `SessionStart` hook — `npm i -g bun@latest @miroshnik/elves && elves install -g` (the image's Bun lags behind), then `check --hook`; the machine's hook isn't there (the cloud doesn't read `~/.claude/settings.json`), an environment's setup script with the same command is an optional faster start. In an Elves clone with `--link` the machine's canon is the clone; its `.claude/CLAUDE.md` keeps the root `AGENTS.md` from loading a second time.

**Personal configuration** — everything that depends on specific repositories (the registry for `est`, your own model prices, notes) — lives outside the flow, in `~/.config/elves`; another directory — the `ELVES_CONFIG_DIR` variable, read by all skill scripts. `ELVES_PRIVATE=<path>` with `install -g` makes `~/.config/elves` a symlink to a private checkout; with `ELVES_CONFIG_DIR` the symlink isn't needed — the variable points at the checkout itself.

## Releases and the up-to-date check

The machine's copy and a project's package version follow the flow **by releases** — tags `vYYYY.MM.DD` (a same-day patch is `.N`), not the head of `main`: a commit to the rules without a release doesn't make anyone "behind". The commands go through the npm package, and it is a release itself: `install` from it installs its own version without the network, `check` and `update` restart from the latest release's npm package. The fallback `bunx github:miroshnik/elves` installs the package from `main` once and then runs it from its cache, so that package is only a launcher: it finds the latest tag and restarts from it by its SHA; in a cloud session `github:` gives 403.

- `check` changes nothing: it compares the machine's copy and a project's package version with the latest release (the same install as a dry run, a list of differences), a `--link` clone — with `origin/main` after `git fetch`.
- `update`: the machine's copy — reinstalled from the latest release; a project — the package version raised to it; a clone — `git pull --ff-only` and links to new skills (a clone not on `main` or with edits — refused with a reason). It says what changed, and the agent tells the user: the machine's copy and a project — every release after the installed one (a project — after its package version), newest first, with the list of its GitHub Release; a clone — the flow commits it pulled. A project's update is committed into the current task's branch; no task branch — the agent doesn't commit it and says so.
- `release` — the owner's step: a date tag (UTC) on `origin/main` and a GitHub Release listing the flow and installer changes since the previous release (the same list `update` prints); nothing to release — refused.
- The npm package `@miroshnik/elves` — CI publishes every release tag (`.github/workflows/npm.yml`): `elves pack <tag>` sets the version (`vYYYY.MM.DD.N` → `YYYY.MMDD.N`, versions sort as tags) and builds for Node the modules a project imports, then `npm publish` by npm [trusted publishing](https://docs.npmjs.com/trusted-publishers) — OIDC, no token or secret, provenance included. The owner's step, once: a trusted publisher is set in the package settings on npmjs.com, so first a `0.0.0` stub published from the owner's machine; then the trusted publisher — GitHub Actions, `miroshnik/elves`, workflow `npm.yml` — no earlier than 2 days before the first release from CI (a new one expires without a successful publish within 2 days: delete it and create it again); after that release the stub may be `npm deprecate`d.

## The package in a project — the harness and the scripts at the project's version

With `@miroshnik/elves` in a project's `devDependencies`, `bun install` brings the flow at the project's version — for CI, colleagues and a cloud session too (npm works there, `github:` gives 403). Tests import `@miroshnik/elves/spec/harness`, `@miroshnik/elves/spec/architecture`, `@miroshnik/elves/spec/eslint-config` and `@miroshnik/elves/github`: Bun and the type checker take the TypeScript source, any runner on Node (Jest, Playwright, `node:test`, the project's `eslint.config.js`) — the build; the knip reporter `@miroshnik/elves/spec/knip-hints` is CommonJS as is, its `file` — the path for `knip --reporter`. The skills' scripts run from `node_modules/.bin` with the same arguments as the scripts themselves, under `bun --no-env-file` — in `package.json` and CI alike: `bun` reads the TypeScript bin `elves` itself, past its shebang, and without the flag it would get the project's env files (`.env.local` with production keys) and pass their keys on to `gh`, `git` and the checked command. On Yarn 2+ — `bunx @miroshnik/elves@"$(jq -r '.devDependencies["@miroshnik/elves"]' package.json)" <script>`, the form `install` writes there: Yarn 2+ runs a `.ts` bin by Node with any `nodeLinker`, and PnP has no `node_modules`.

```bash
bun --no-env-file node_modules/.bin/elves spec-doc …
bun --no-env-file node_modules/.bin/elves spec-diff …
bun --no-env-file node_modules/.bin/elves spec-publish …
bun --no-env-file node_modules/.bin/elves spec-run …
bun --no-env-file node_modules/.bin/elves spec-shard …
bun --no-env-file node_modules/.bin/elves spec-claims …
bun --no-env-file node_modules/.bin/elves spec-break …
bun --no-env-file node_modules/.bin/elves precommit
bun --no-env-file node_modules/.bin/elves task-env up …
bun --no-env-file node_modules/.bin/elves task-env e2e …
bun --no-env-file node_modules/.bin/elves task-env down …
bun --no-env-file node_modules/.bin/elves task-env prune
bun --no-env-file node_modules/.bin/elves task-env check …
bun --no-env-file node_modules/.bin/elves task-env proxy up
bun --no-env-file node_modules/.bin/elves task-env proxy down
bun --no-env-file node_modules/.bin/elves task-env proxy status
```

The project's own scripts and tests (the stack before the dev server, the e2e wrapper) bring the task's stack up with `elves task-env up` — the `task-env` skill at the project's version. The machine queue — `elves slot --for <PID>` of the shim `.agents/slot.sh`: it only prints the queue variables, the command runs in the script's own shell. A GitHub Actions step doesn't see `node_modules/.bin`, and `bunx elves` without the package in `node_modules` would fetch someone else's `elves` from npm; a job that doesn't install the project's dependencies — `bunx @miroshnik/elves@<version> <script>` (the `spec` skill's `ci.md`).

## Working on the flow itself — from a clone

```bash
git clone https://github.com/miroshnik/elves && cd elves
bun bin/elves.ts install -g --link   # symlinks to the clone instead of copies: edits show up immediately
bun bin/elves.ts release --dry-run   # what goes into the release; without --dry-run — cut it
```
