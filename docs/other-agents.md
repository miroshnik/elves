# Other agents — the canon and the skills without Claude Code

Elves is for Claude Code: the installer, the hook and the scripts are built and tested there. Another agent can still work by the canon and run the skills' scripts — here is what to connect by hand and what stays out of reach.

## What to connect

- **The canon.** `bunx @miroshnik/elves install -g` puts it into `~/.agents/elves/` on any machine: `AGENTS.md`, `docs/` and `claude/CLAUDE.md` — Claude Code's part, skip it. Make `~/.agents/elves/AGENTS.md` your agent's global rules: a symlink to it from the agent's global rules file (its documentation names the path) or an import there; a copy goes stale with the next `update -g`. A thin project's `AGENTS.md` carries a block with the same path, so an agent that reads it finds the canon too.
- **The skills** — in `~/.agents/skills/<name>/`, the path of the [Agent Skills](https://agentskills.io) standard: an agent that supports it finds them by itself, another reads the `SKILL.md` it needs.
- **The scripts** run under Bun without the project's env files: `bun --no-env-file ~/.agents/skills/<name>/scripts/<script>.ts …`, in a project with the package — `bun --no-env-file node_modules/.bin/elves <script>`. `github` and `est` need `gh` with the `project` scope.
- **The first step of a session** has no hook: run `bunx @miroshnik/elves check -g` and `check` yourself before the task (`AGENTS.md`, "First step of a session").

## What doesn't work without Claude Code

- **Hooks.** The `SessionStart` hook — the flow check at the start, the wait of a resumed session's task, the agent's Bash setup (`bin/shims`) — is Claude Code's.
- **The session pinned to its task.** `github task status` pins the task by Claude Code's session id; without it — `○ session not recognized …`: nothing stops a second task in the same session.
- **The actual from transcripts.** `est` reads only Claude Code's transcripts: a task done by another agent closes without an actual.
- **The dispatcher with subagents.** `github task queue` hands tasks to background subagents of Claude Code, each in its own worktree; with another agent, run each task in a session of its own.
- **Naming and archiving the session.** The name `#<number> <task title>` and archiving after the last line are Claude Code's tools: name and close the session yourself.
