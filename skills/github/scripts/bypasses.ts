/**
 * Bypasses of the flow's commands — the one list the PreToolUse hook (`github hook guard`, #839) holds: a command the
 * flow does with its own, which the agent ran by hand. One row — the rule, the replacement, the reason; a new bypass is a
 * row here, its handler in the Elves plugin's `hooks/hooks.json` (Claude Code's `if` takes one rule; a test holds them
 * equal, #860) and its case in tests/capabilities/github/github-guard; the hook denies the call with the replacement in the
 * reason — the model makes a second call (question 1 of #839: a rewritten command would give output it didn't expect).
 *
 * A call of another repository (`--repo`, `GH_REPO`, a URL, a `cd` into another checkout) isn't a bypass: the flow's
 * commands are for the session repository's tasks. Data only, no imports: the installer reads the rules from here, and
 * `est usage` counts the bypasses in transcripts by them (#845).
 */
export interface Bypass {
  /**
   * Claude Code's permission rule — the hook handler's `if`: Claude Code runs the hook only for a call with a subcommand
   * it matches; the guard matches the same command words itself (an older Claude Code runs the hook on every call).
   */
  rule: string;
  /** Flags one of which the call has to have to be a bypass (`gh issue edit` without `--body` is a label, not the description). */
  when?: string[];
  /** The only flags a bypass may have besides the repository's: any other is a read the flow has no command for (`--json`). */
  only?: string[];
  /** The flow's command instead: `{github}` — the github script, `{wait-ci}` — the ci-wait script, `{n}` — the call's number. */
  use: string;
  /** Why the flow's command — the model reads it in the hook's reason, with the replacement. */
  reason: string;
}

/** Waiting for checks — the same reason for both watch commands. */
const WAIT =
  "CI and the deploy are waited for by ci-wait as a background command (run_in_background): the PR head's checks, the base's required checks and the workflows of the PR, with a timeout and an outcome; its completion wakes the session — `merged <N>` after the merge, `status <sha>` for a commit";

export const BYPASSES: Bypass[] = [
  {
    rule: "Bash(gh issue view *)",
    only: ["--comments", "-c"],
    use: "{github} task show {n}",
    reason: "a task is read by task show: the description, Status, the epic, blockers, the PRs with their checks, the questions and the comments in one output",
  },
  {
    rule: "Bash(gh issue edit *)",
    when: ["--body", "-b", "--body-file", "-F"],
    use: "{github} task edit {n} --replace '<old>' '<new>'",
    reason: "a task's description is edited by task edit in one call — --replace <old> <new>, --add <section> <item>, --check <item>, the rest of the description untouched; an answer to a question — task answer",
  },
  { rule: "Bash(gh run watch *)", use: "bash {wait-ci} pr <N>", reason: `${WAIT}; gh run watch sees one Actions run, not the host's statuses` },
  { rule: "Bash(gh pr checks *)", when: ["--watch"], use: "bash {wait-ci} pr {n}", reason: `${WAIT}; gh pr checks --watch right after a push takes «no checks yet» for passed` },
];
