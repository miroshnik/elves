#!/usr/bin/env bun
/**
 * precommit — the checks before a commit in one call (AGENTS.md, "Git, PRs and merging"; docs/testing.md): the
 * project's `lint`, `typecheck`, `test:spec` and `test --changed=<base>`, all at once — each script is wrapped in the
 * machine queue by the flow install (the slot skill), so the queue decides how many go together. Each check ran as a
 * separate call, and on every round of fixes all of them again, with the runner's long output in the agent's context:
 * ≈ 15 turns per task (#671). Here — one line per check as it finishes, then the details of the failed ones only.
 *
 * A test check's result is the runner's summary, not the exit code (docs/testing.md, "Run and result"): `bun test` —
 * the `pass`/`fail` lines, Vitest — `Tests`, Jest — `Tests:`, Playwright — `passed`/`failed`/`flaky`/`did not run`/
 * `interrupted`. No summary — the run didn't finish, whatever the code; failed tests with code 0 (a wrapper that lost
 * it) — failed; a green summary with a code other than 0 — failed too: something broke outside the tests. `lint` and
 * `typecheck` have no summary — their code is the result. A missing script — an `○` line, not a failure.
 *
 * The scripts run by the project's package manager (`projectCommands` of the github skill — the one answer of the flow,
 * tests/standards/package-manager), from the git root. The details of a failed check — its output without the lines of
 * passed tests, the last DETAIL lines, and the file with the whole output.
 *
 * Codes: 0 — all green, 1 — a check failed, 2 — a call error (arguments, no package.json). Runs under Bun, only node:
 * APIs; a project runs it from its package as `elves precommit` (bin/elves.ts imports `main` and `HELP`).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { packageManager, projectCommands } from "../../github/scripts/github.ts";
import locale from "../../github/scripts/locale.ts";

const USAGE = "precommit [--base <ref>]";
/** `--help`, `-h` (tests/standards/cli-help): the synopsis, what it does and examples; `elves` prints it under its name. */
export const HELP = `${USAGE}

The checks before a commit in one call: the project's package.json scripts lint, typecheck, test:spec and test of what
the change affects (test --changed=<base>, by default origin/main; in a batch — origin/<batch branch>) — all at once,
each through the machine queue of its script. Prints a line per check as it finishes, then the details of the failed
ones only: their output without the passed tests and the file with the whole output. A test check's result is the
runner's summary (bun test, Vitest, Jest, Playwright), not the exit code: no summary — the run didn't finish. A script
the project doesn't have — an ○ line. Code 0 — all green, 1 — a check failed, 2 — a call error.

Examples:
  precommit
  precommit --base origin/batch/2026-10-26-1`;

/** Lines of a failed check's output in the details: the end, where the runner puts its failures and summary. */
const DETAIL = 80;

/** A check: the package.json script, its arguments, whether its result is a test runner's summary. */
interface Check {
  script: string;
  args: string[];
  tests: boolean;
}

const checksFor = (base: string): Check[] => [
  { script: "lint", args: [], tests: false },
  { script: "typecheck", args: [], tests: false },
  { script: "test:spec", args: [], tests: true },
  { script: "test", args: [`--changed=${base}`], tests: true },
];

/** A test runner's summary: bad — failed, errors, flaky, not run, interrupted; good — passed. */
export interface Summary {
  passed: number;
  bad: number;
}

// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
const sum = (text: string, re: RegExp) => [...text.matchAll(re)].reduce((n, m) => n + Number(m[1]), 0);

/**
 * The runner's summary in its output, or null — none: the run didn't finish. Several runs of one script (`bun test a &&
 * bun test b`) — their sum.
 */
export function summaryOf(output: string): Summary | null {
  const text = plain(output);
  // bun test: « 12 pass», « 1 fail», « 1 error» — lines of their own at the end
  if (/^ *\d+ pass$/m.test(text) || /^Ran \d+ tests? across/m.test(text))
    return { passed: sum(text, /^ *(\d+) pass$/gm), bad: sum(text, /^ *(\d+) fail$/gm) + sum(text, /^ *(\d+) errors?$/gm) };
  // Vitest: «      Tests  1 failed | 3 passed (4)», «     Errors  1 error»; Jest: «Tests:       1 failed, 3 passed, 4 total»
  const lines = [...text.matchAll(/^ *Tests:? +(.*\b(?:passed|failed|skipped|todo)\b.*)$/gm)].map((m) => m[1]!);
  if (lines.length) {
    const all = lines.join("\n");
    return { passed: sum(all, /(\d+) passed/g), bad: sum(all, /(\d+) failed/g) + sum(text, /^ *Errors +(\d+) errors?/gm) };
  }
  // Vitest with --passWithNoTests and nothing affected
  if (/^No test files found, exiting with code 0/m.test(text)) return { passed: 0, bad: 0 };
  // Playwright: «  3 passed (5.1s)», «  1 failed», «  1 flaky», «  2 did not run», «  1 interrupted»
  if (/^ +\d+ (?:passed|failed|flaky|did not run|interrupted)\b/m.test(text))
    return {
      passed: sum(text, /^ +(\d+) passed\b/gm),
      bad: ["failed", "flaky", "did not run", "interrupted"].reduce((n, w) => n + sum(text, new RegExp(`^ +(\\d+) ${w}\\b`, "gm")), 0),
    };
  return null;
}

/** A finished check: ok, the line about it, its output. */
interface Outcome {
  check: Check;
  ok: boolean;
  line: string;
  output: string;
}

/** The verdict: by the summary for a test check (no summary — not finished), by the code for the rest. */
export function verdict(tests: boolean, code: number | string, output: string): { ok: boolean; text: string } {
  const exit = typeof code === "number" ? `code ${code}` : code;
  if (!tests) return code === 0 ? { ok: true, text: "ok" } : { ok: false, text: exit };
  const s = summaryOf(output);
  if (!s) return { ok: false, text: `no runner summary — the run didn't finish (${exit})` };
  const counts = `${s.bad ? `${s.bad} failed, ` : ""}${s.passed} passed`;
  if (s.bad) return { ok: false, text: counts + (code === 0 ? ` (${exit} — the summary decides)` : "") };
  if (code !== 0) return { ok: false, text: `${counts}, but ${exit} — an error outside the tests` };
  return { ok: true, text: counts };
}

/** The script's command with its arguments: npm passes them after `--`, the other managers — as is. */
function command(root: string, check: Check): string[] {
  const run = projectCommands(root).run(check.script);
  if (!check.args.length) return run;
  return packageManager(root).name === "npm" ? [...run, "--", ...check.args] : [...run, ...check.args];
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** One check: the script by the package manager, stdout and stderr together; the outcome line goes out as it finishes. */
function runCheck(root: string, check: Check): Promise<Outcome> {
  const [cmd, ...args] = command(root, check) as [string, ...string[]];
  const start = Date.now();
  return new Promise((resolve) => {
    let output = "";
    const done = (code: number | string) => {
      const v = verdict(check.tests, code, output);
      const name = [check.script, ...check.args].join(" ");
      const line = `${v.ok ? "✅" : "❌"} ${name} — ${v.text} [${seconds(Date.now() - start)}]`;
      process.stdout.write(line + "\n");
      resolve({ check, ok: v.ok, line, output });
    };
    const p = spawn(cmd, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    p.stdout.on("data", (d) => (output += d));
    p.stderr.on("data", (d) => (output += d));
    p.on("error", (e) => done(`not started: ${e.message}`));
    p.on("close", (code, signal) => done(code ?? `killed by ${signal}`));
  });
}

/**
 * The details of a failed check: its output without the lines of passed or skipped tests and without the package
 * manager's echo of the script's command (`$ …` of bun run, `> app@1.0.0 test` of npm), the last DETAIL lines.
 */
export function detailsOf(output: string): string[] {
  const lines = plain(output)
    .split("\n")
    .filter((l) => !/^\s*(?:\(pass\)|\(skip\)|\(todo\)|✓|√|ok \d)|^\$ |^> \S+@\S* /.test(l));
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  return lines.length > DETAIL ? [`… ${lines.length - DETAIL} lines above — in the file`, ...lines.slice(-DETAIL)] : lines;
}

class Fail extends Error {}

export async function main(argv: string[]): Promise<number> {
  let base: string;
  try {
    const { values } = parseArgs({ args: argv, options: { base: { type: "string" }, help: { type: "boolean", short: "h" } } });
    if (values.help) return console.log(HELP), 0;
    base = values.base ?? "origin/main";
    if (!base) throw new Fail("--base <ref>: a ref is needed");
  } catch (e) {
    console.error(`precommit: ${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  const root = locale.projectRoot(process.cwd());
  let scripts: Record<string, unknown>;
  try {
    scripts = (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, unknown> }).scripts ?? {};
  } catch (e) {
    console.error(`precommit: no package.json in ${root} to take the scripts from — ${(e as Error).message}`);
    return 2;
  }
  const all = checksFor(base);
  const present = all.filter((c) => typeof scripts[c.script] === "string");
  for (const c of all) if (!present.includes(c)) console.log(`○ ${c.script} — no such script in package.json`);
  if (!present.length) return console.log("precommit: no checks to run"), 0;
  const outcomes = await Promise.all(present.map((c) => runCheck(root, c)));
  const failed = outcomes.filter((o) => !o.ok);
  if (!failed.length) return console.log(`precommit: all ${outcomes.length} green`), 0;
  const dir = mkdtempSync(path.join(os.tmpdir(), "elves-precommit-"));
  for (const o of failed) {
    const file = path.join(dir, `${o.check.script.replace(/[^a-z0-9-]/gi, "-")}.log`);
    writeFileSync(file, o.output);
    console.log(`\n${o.line}\n${detailsOf(o.output).join("\n")}\nthe whole output: ${file}`);
  }
  console.log(`\nprecommit: ${failed.length} of ${outcomes.length} failed — ${failed.map((o) => o.check.script).join(", ")}`);
  return 1;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
