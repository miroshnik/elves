/**
 * The whole command ready for the shell (#841) and gh's refusal in the Claude Code sandbox (#868) — one for the flow's
 * scripts on `gh`: `github`, `est`, `spec-run` and the installer import it, `wait-ci.sh` keeps a copy of the pattern and
 * the line (tests/standards/scripts/gh-sandbox holds every script on gh to the same line).
 */

/** An argument for the shell: as is without the shell's special characters, otherwise quoted — single quotes first. */
export function shellArg(a: string): string {
  if (/^[\w@%+=:,./-]+$/.test(a)) return a;
  if (!a.includes("'")) return `'${a}'`;
  return /["$`\\!]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : `"${a}"`;
}

/** The command ready for the shell: the script under `bun --no-env-file` with the arguments — a hint is run as is. */
export const readyCommand = (script: string, args: readonly (string | number)[]) => ["bun", "--no-env-file", script, ...args.map(String)].map(shellArg).join(" ");

/**
 * gh's TLS failure in the sandbox: the sandbox closes the system's certificate check, and every gh call fails —
 * `tls: failed to verify certificate: x509: OSStatus -26276`. The part from `x509` goes into the refusal line.
 */
const SANDBOX_TLS = /x509:[^\n]*|OSStatus[^\n]*/;

/**
 * gh refused by the sandbox: not the script's request error (`GhError`, `EstError`) — no catch of one swallows it, and
 * the script's entry prints its one line. The message — gh's words from `x509`.
 */
export class SandboxRefusal extends Error {}

/** A failed gh call's stderr: the sandbox's TLS — the refusal to throw, otherwise null (the script's own error). */
export function sandboxRefusal(stderr: string): SandboxRefusal | null {
  const m = SANDBOX_TLS.exec(stderr);
  return m ? new SandboxRefusal(m[0].trim()) : null;
}

/**
 * The refusal's one line (#868): gh doesn't work in the sandbox, and the whole command to run outside it — the agent
 * runs it as is instead of guessing from gh's error.
 */
export const sandboxLine = (e: SandboxRefusal, command: string) =>
  `error: gh doesn't work in the Claude Code sandbox (${e.message}) — run the whole command outside it, a separate call with dangerouslyDisableSandbox: ${command}`;
