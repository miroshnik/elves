# Claude Code

What only Claude Code has; `elves install -g` links it with `AGENTS.md`
into `~/.claude/rules`.

- **The app's tools load at once.** `github task start` prints one
  `ToolSearch` line for the tools the flow calls: `set_session_title` names
  the session `#<N> <task title>`; in auto mode `archive_session` with `self`
  is the last action after the "can be closed" line, once `TaskStop` stopped
  my own background tasks, and a dispatcher archives an executor session with
  its id; a refused archive is left to the owner.
- **Transcripts are the actuals.** `est` reads them in `~/.claude/projects/`,
  so `~/.claude/settings.json` needs `"cleanupPeriodDays": 365`, or the
  history is cleaned before the task closes.
- **Auto-fix is off.** Its conflict event wants the base merged in, which
  breaks the rebase merge: right after `gh pr create` I call `set_monitor`
  with `auto_fix: false` and the PR's url, and on a conflict I rebase onto a
  fresh `origin/main`.
- **CI waits are background commands.** `ci-wait` runs with
  `run_in_background`, and its completion wakes the session; the PreToolUse
  hook denies `gh run watch` and `gh pr checks --watch`, and I put no
  `Monitor`, watcher loop or `ScheduleWakeup` on top — an armed wakeup keeps
  `archive_session` refused.
- **A merge in auto mode is a separate call.** `gh pr merge <N> --rebase`
  without `cd`, `|` or `;`, as `github task finish` prints it: otherwise the
  owner's `Bash(gh pr merge *)` rule doesn't match and the classifier
  rejects the merge.
- **gh fails in the sandbox.** Inside the Bash sandbox `gh` fails on TLS
  (`x509: OSStatus -26276`), so a skill script that calls `gh` or Docker runs
  at once as a separate call with `dangerouslyDisableSandbox`.
- **Another task is a background executor.** On "yes" to «queue #N?» it is
  `Agent` with `isolation: "worktree"`, `run_in_background: true` and the
  prompt `github task queue` printed, not a session card (`spawn_task`,
  `start_session`); the executor isn't stopped, and my last line comes after
  its answer.

## Judgment

- **A subagent that writes gets `isolation: worktree`.** Without it the
  agent inherits its parent's checkout, and the paths in its prompt lead into
  its worktree; one cut off by a limit leaves
  uncommitted work in its worktree, so `git status` there comes before
  resuming.
