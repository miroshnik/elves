#!/usr/bin/env bun
/**
 * spec-red — red on base (#844): the tests a PR adds fail on the base code. «A check is written before the code and is
 * red first» held on the agent's word: `spec-break` ran 22 times on ~500 merged PRs, and a migration found 165 tests
 * counted as coverage that caught no breakage. Here it is a mechanism: `github pr premerge` runs it once per PR, before
 * the merge.
 *
 *   bun spec-red.ts [--base origin/main] [--also REF] [--head HEAD] [--root DIR]
 *
 * The added tests — spec-diff's `added` by static parsing: a harness test only a run names isn't in it (an invariant
 * has its own violator), nor a renamed or moved one. The base — the merge-base of `--base` and the head. In a temporary
 * worktree at the base (`inTempWorktree` of the github skill) the `tests/` tree is the head's — the tests and their
 * helpers, the code is the base's; dependencies by the base's lockfile; the runner runs only the added tests' files,
 * filtered by the tests' full names, into a report. An added test must be red there: failed, or its file didn't load
 * (it imports what the PR adds). Green — ❌ with its name: it doesn't check the PR's change.
 *
 * A test of existing behavior (a migrated spec, a test «from code» by a decision's trace) — a mark in a comment right
 * before its `it` or its `describe`: `// spec-existing #N: reason`. It must be green on the base; red — ❌ «the mark
 * isn't needed» (a ratchet). A mark without the number or the reason, or not before a test — ❌.
 *
 * The second base `--also` (#892) — a PR into a batch: the base is the batch, its release's base is main, and a test of
 * the behavior another task of the batch brought is green on the batch, red on main. The added tests green on the base
 * run on the code of `--also` too (its merge-base with the head; the same commit — no second run): red there without
 * the mark — ✅, the test checks what the base adds to it; with the mark — ❌ «the mark isn't needed» against it, the
 * release would be red by it; green there too — the verdict as without the second base.
 *
 * The runner — by the file's import (`bun:test`, `vitest`, `@jest/globals`), otherwise by the project's dependencies
 * (Vitest, Jest), otherwise bun test in a Bun project. e2e (Playwright — the app runs from the task's stack, not from
 * the base code) and a runner not recognized — ○ lines, not checked.
 *
 * Interruption: a signal to the run's process group (Ctrl-C, a closed session) stops the runner, the worktree is
 * removed; a run killed without that chance (kill -9) left its worktree — the next run removes it (its pid is in the
 * directory name). Codes: 0 — every checked test passes, 1 — a ❌, 2 — a call error (arguments, git, dependencies, the
 * run didn't finish or was interrupted).
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { GhError, inTempWorktree, packageManager, projectCommands } from "../../github/scripts/github.ts";
import type { Io } from "../../github/scripts/github.ts";
import { summaryOf } from "./precommit.ts";
import { addedTests } from "./spec-diff.ts";
import * as L from "./speclib.ts";
import type { Existing, Test } from "./speclib.ts";

const USAGE = "spec-red [--base origin/main] [--also REF] [--head HEAD] [--root DIR]";
/** `--help`, `-h` (tests/standards/scripts/cli-help): the synopsis, what it does and examples; `elves` prints it under its name. */
export const HELP = `${USAGE}

Red on base: the tests the head adds (spec-diff, statically) run on the base code — a temporary worktree at the
merge-base with the head's tests/ — and must fail there; green — ❌ with the test's name. A test of existing behavior
carries a mark before its it or describe, // spec-existing #N: reason, and must be green there; red — ❌, the mark isn't
needed. --also REF — a second base, a batch's release base: an added test green on the base runs on its code too; red
there — it checks what the base adds to REF: passes without the mark, with the mark — ❌. Runners: bun test, Vitest, Jest;
e2e — not checked. Code 0 — every checked test passes, 1 — there is a ❌, 2 — a call error or the run didn't finish.

Examples:
  spec-red
  spec-red --base origin/batch/2026-11-16-1 --also origin/main --head 1a2b3c4`;

/** A run of the base longer than this is a hang, not a slow test: the run is stopped, code 2. */
const RUN_TIMEOUT_MS = 10 * 60_000;
/** The temporary worktree's directory prefix: `elves-red-<pid>-…` — the next run finds a killed run's worktree by it. */
const PREFIX = "red";
const STALE = /^elves-red-(\d+)-/;
const INTERRUPTS = new Set(["SIGINT", "SIGTERM", "SIGHUP"]);
/** A runner that catches the group's signal exits with 128 + its number: SIGHUP, SIGINT, SIGTERM. */
const INTERRUPTED_CODES = new Set([129, 130, 143]);

type Runner = "bun" | "vitest" | "jest" | "playwright";

/** A runner by the test file's import; the order — the more specific first. */
const IMPORTS: [RegExp, Runner][] = [
  [/\bfrom\s+["']bun:test["']/, "bun"],
  [/\bfrom\s+["']vitest["']/, "vitest"],
  [/\bfrom\s+["']@jest\/globals["']/, "jest"],
  [/\bfrom\s+["']@playwright\/test["']/, "playwright"],
];

class Failure extends Error {}
class Interrupted extends Error {}

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new Failure(`git ${args.join(" ")}: ${r.error.message}`);
  if (r.status !== 0) throw new Failure(`git ${args.join(" ")}: ${r.stderr.trim()}`);
  return r.stdout;
}

/** A process is alive: a signal 0 reaches it (EPERM — alive, of another user). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Worktrees of spec-red runs killed without a chance to remove theirs (kill -9): the pid in the directory name is dead.
 * A live run's worktree — a parallel premerge in another worktree of the checkout — stays.
 */
function removeStale(top: string): void {
  const dirs = git(["worktree", "list", "--porcelain"], top)
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length));
  let removed = false;
  for (const dir of dirs) {
    const m = STALE.exec(path.basename(dir));
    if (!m || alive(Number(m[1]))) continue;
    spawnSync("git", ["worktree", "remove", "--force", dir], { cwd: top });
    rmSync(dir, { recursive: true, force: true });
    removed = true;
    console.log(`spec-red: removed the worktree of an interrupted run — ${dir}`);
  }
  if (removed) spawnSync("git", ["worktree", "prune"], { cwd: top });
}

/** The project's dependencies — `dependencies` and `devDependencies` of its package.json. */
function depsOf(root: string): Set<string> {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
    return new Set([...Object.keys(pkg["dependencies"] ?? {}), ...Object.keys(pkg["devDependencies"] ?? {})]);
  } catch {
    return new Set();
  }
}

/** The file's runner: its import, otherwise e2e by the name, the project's Vitest or Jest, bun test in a Bun project. */
export function runnerOf(file: string, source: string, deps: Set<string>, manager: string): Runner | null {
  for (const [re, runner] of IMPORTS) if (re.test(source)) return runner;
  if (/\.e2e\.[cm]?[jt]sx?$/.test(file)) return "playwright";
  if (deps.has("vitest")) return "vitest";
  if (deps.has("jest")) return "jest";
  return manager === "bun" ? "bun" : null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * The name filter: the full names — describes and the name joined by a space, as bun test, Vitest and Jest match
 * `--test-name-pattern` — whole, any of them.
 */
export function namePattern(tests: Test[]): string {
  const names = [...new Set(tests.map((t) => [...t.describes, t.name].join(" ")))];
  return `^(?:${names.map(escapeRe).join("|")})$`;
}

/** A runner's binary in the project: `node_modules/.bin` of the root, then of the git top (a hoisted workspace). */
function binOf(name: string, root: string, top: string): string | null {
  return [root, top].map((d) => path.join(d, "node_modules", ".bin", name)).find((p) => existsSync(p)) ?? null;
}

/** The run's command: only the files, filtered by the names, the report — into `report`; the runner isn't installed — null. */
export function commandOf(runner: Exclude<Runner, "playwright">, files: string[], pattern: string, report: string, bin: (name: string) => string | null): string[] | null {
  if (runner === "bun") return ["bun", "test", ...files.map((f) => `./${f}`), "--test-name-pattern", pattern, "--reporter=junit", `--reporter-outfile=${report}`];
  const exe = bin(runner);
  if (!exe) return null;
  if (runner === "vitest") return [exe, "run", ...files, "--testNamePattern", pattern, "--reporter=json", `--outputFile=${report}`];
  return [exe, "--runTestsByPath", ...files, "--testNamePattern", pattern, "--json", `--outputFile=${report}`];
}

/** A process in the base's worktree; a signal of the group (the runner killed by it) — interrupted, a timeout — not finished. */
function run(cmd: string[], cwd: string): { status: number | null; out: string } {
  const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd, encoding: "utf8", timeout: RUN_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024 });
  if (r.signal && INTERRUPTS.has(r.signal)) throw new Interrupted(r.signal);
  if (r.status !== null && INTERRUPTED_CODES.has(r.status)) throw new Interrupted(`code ${r.status}`);
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") throw new Failure(`${cmd.join(" ")} didn't finish in ${RUN_TIMEOUT_MS / 60_000} min`);
  if (r.error) throw new Failure(`${cmd[0]} didn't start: ${r.error.message}`);
  return { status: r.status, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

const tail = (out: string, n = 15) => out.split("\n").filter((l) => l.trim()).slice(-n).join("\n");
const nameOf = (t: Test) => `${t.path}: ${[...t.describes, t.name].join(" › ")}`;
const sameTest = (a: Test, b: Test) => a.path === b.path && a.name === b.name && a.describes.length === b.describes.length && a.describes.every((d, i) => d === b.describes[i]);

/** An added test's outcome on the base: red, green, or not checked (with why). */
export type Outcome = { kind: "red"; loaded: boolean } | { kind: "green" } | { kind: "unchecked"; why: string };

/**
 * The outcome of each added test of a run: its record in the report — failed is red, passed is green, skipped is not
 * checked; no record — its file isn't in the report at all and the run failed: the file didn't load, red; otherwise
 * the test didn't run under its static name — not checked.
 */
export function outcomesOf(tests: Test[], reported: Test[], status: number | null, where = "base"): Outcome[] {
  const files = new Set(reported.map((t) => t.path));
  return tests.map((t): Outcome => {
    const found = reported.filter((r) => sameTest(r, t));
    if (found.length) {
      const s = found.map((r) => r.status).reduce(L.combineStatus);
      if (s === "failed") return { kind: "red", loaded: true };
      if (s === "passed") return { kind: "green" };
      return { kind: "unchecked", why: `${s} on ${where}` };
    }
    if (!files.has(t.path) && status !== 0) return { kind: "red", loaded: false };
    return { kind: "unchecked", why: "not in the run under this name (computed at run time?)" };
  });
}

const markAt = (t: Test, m: Existing) => `${t.path}:${m.line}`;

/** A checkout: its git top, the root's path in it (a workspace package) and the head. */
interface Checkout {
  top: string;
  prefix: string;
  head: string;
}

/**
 * The tests on the code of `base` with the head's `tests/`, in a temporary worktree: each run test's outcome and the ○
 * lines of the files not run. `where` — the base's name in the lines: «base» or the second base's ref.
 */
function runOn(c: Checkout, base: string, tests: Test[], where: string): { results: Map<Test, Outcome>; unchecked: string[] } {
  const files = [...new Set(tests.map((t) => t.path))].sort();
  const the = where === "base" ? "the base" : where;
  const results = new Map<Test, Outcome>();
  const unchecked: string[] = [];
  const io: Io = {
    gh: () => {
      throw new Error("spec-red: gh isn't needed");
    },
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    env: process.env,
    cwd: c.top,
  };
  inTempWorktree(io, `${PREFIX}-${process.pid}`, base, (dir) => {
    git(["restore", `--source=${c.head}`, "--worktree", "--", c.prefix ? `${c.prefix}/${L.TESTS}` : L.TESTS], dir);
    const root = path.join(dir, c.prefix);
    // dependencies by the lockfile of the root, in a workspace — of the git top
    const installIn = projectCommands(root).install ? root : dir;
    const install = projectCommands(installIn).install;
    const deps = depsOf(root);
    const manager = packageManager(root).name;
    const byRunner = new Map<Runner | null, string[]>();
    for (const f of files) {
      const r = runnerOf(f, readFileSync(path.join(root, f), "utf8"), deps, manager);
      byRunner.set(r, [...(byRunner.get(r) ?? []), f]);
    }
    for (const f of byRunner.get("playwright") ?? []) unchecked.push(`○ ${f}: e2e — not checked on ${where} (the app runs from the task's stack, not from the base code)`);
    for (const f of byRunner.get(null) ?? []) unchecked.push(`○ ${f}: the runner isn't recognized (no bun:test, vitest or @jest/globals import, no Vitest or Jest in package.json) — not checked`);
    const runnable = ([...byRunner] as [Runner | null, string[]][]).filter((e): e is [Exclude<Runner, "playwright">, string[]] => e[0] !== null && e[0] !== "playwright");
    if (!runnable.length) return;
    if (install) {
      const r = run(install, installIn);
      if (r.status !== 0) throw new Failure(`installing dependencies on ${the} failed (${install.join(" ")}):\n${tail(r.out)}`);
    }
    const reports = mkdtempSync(path.join(os.tmpdir(), "elves-red-report-"));
    try {
      for (const [runner, group] of runnable) {
        const ofGroup = tests.filter((t) => group.includes(t.path));
        const report = path.join(reports, `${runner}.${runner === "bun" ? "xml" : "json"}`);
        const cmd = commandOf(runner, group, namePattern(ofGroup), report, (name) => binOf(name, root, dir));
        if (!cmd) {
          for (const f of group) unchecked.push(`○ ${f}: ${runner} isn't installed on ${the} (node_modules/.bin/${runner}) — not checked`);
          continue;
        }
        const r = run(cmd, root);
        let reported: Test[] = [];
        if (existsSync(report)) reported = L.loadReport(report, root);
        // no test ran — no file loaded: bun test writes no report then, and its summary is there, red
        else if (r.status === 0 || summaryOf(r.out)?.passed !== 0) throw new Failure(`${runner} wrote no report — the run on ${the} didn't finish (code ${r.status}):\n${tail(r.out)}`);
        outcomesOf(ofGroup, reported, r.status, where).forEach((o, i) => results.set(ofGroup[i]!, o));
      }
    } finally {
      rmSync(reports, { recursive: true, force: true });
    }
  });
  return { results, unchecked };
}

export async function main(argv: string[]): Promise<number> {
  let opts;
  try {
    opts = parseArgs({
      args: argv,
      options: {
        base: { type: "string", default: "origin/main" },
        head: { type: "string", default: "HEAD" },
        also: { type: "string" },
        root: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (e) {
    console.error(`spec-red: ${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  const v = opts.values;
  if (v.help) return console.log(HELP), 0;
  // a signal to the group stops the runner too: the handler only keeps spec-red alive till the worktree is removed
  const hold = () => {};
  for (const s of INTERRUPTS) process.on(s, hold);
  try {
    const abs = path.resolve(v.root ?? process.cwd());
    const top = git(["rev-parse", "--show-toplevel"], abs).trim();
    const prefix = path.relative(top, abs).split(path.sep).join("/");
    removeStale(top);
    const head = git(["rev-parse", "--verify", `${v.head}^{commit}`], top).trim();
    const base = git(["merge-base", v.base!, head], top).trim();
    let added: Test[];
    try {
      added = addedTests(base, head, abs);
    } catch (e) {
      throw new Failure(`the added tests: ${(e as Error).message}`);
    }
    if (!added.length) {
      console.log(`○ spec-red: the head adds no tests to tests/ against ${v.base} (merge-base ${base.slice(0, 7)}) — nothing to run`);
      return 0;
    }
    const files = [...new Set(added.map((t) => t.path))].sort();
    console.log(`spec-red: ${added.length} added ${added.length > 1 ? "tests" : "test"} in ${files.length} ${files.length > 1 ? "files" : "file"} — on the base code ${base.slice(0, 7)} (merge-base with ${v.base}) with the head's tests/`);

    const bad: string[] = [];
    // the marks of the added tests' files: one without the number or the reason, or before no test, marks nothing
    const rel = (f: string) => (prefix ? `${prefix}/${f}` : f);
    for (const f of files) {
      for (const m of L.scanJs(f, git(["show", `${head}:${rel(f)}`], top)).existing) {
        if (m.issue === null || !m.reason) bad.push(`❌ ${f}:${m.line}: the spec-existing mark needs the task number and the reason — // spec-existing #N: reason`);
        else if (!m.attached) bad.push(`❌ ${f}:${m.line}: the spec-existing mark isn't right before an it or a describe — it marks nothing`);
      }
    }

    const checkout: Checkout = { top, prefix, head };
    const { results, unchecked } = runOn(checkout, base, added, "base");
    // the second base (#892): the tests green on the base run on its code too — a PR into a batch, the release's base
    const green = [...results].filter(([, o]) => o.kind === "green").map(([t]) => t);
    let also = new Map<Test, Outcome>();
    const second = v.also && green.length ? git(["merge-base", v.also, head], top).trim() : base;
    if (v.also && second !== base) {
      console.log(`spec-red: ${green.length} added ${green.length > 1 ? "tests" : "test"} green on base — on the code of ${v.also} too, ${second.slice(0, 7)} (merge-base with ${v.also})`);
      const r = runOn(checkout, second, green, v.also);
      also = r.results;
      unchecked.push(...r.unchecked);
    }

    let red = 0;
    let existing = 0;
    let ahead = 0;
    for (const [t, o] of results) {
      const mark = t.existing;
      const there = also.get(t);
      if (there?.kind === "unchecked") unchecked.push(`○ ${there.why} — not checked: ${nameOf(t)}`);
      if (o.kind === "unchecked") unchecked.push(`○ ${o.why} — not checked: ${nameOf(t)}`);
      else if (o.kind === "green" && there?.kind === "red" && mark)
        bad.push(`❌ red on ${v.also}, yet marked existing behavior (${markAt(t, mark)}) — against ${v.also} the mark isn't needed: the release adds the behavior, remove it: ${nameOf(t)}`);
      else if (o.kind === "green" && there?.kind === "red") ahead++;
      else if (o.kind === "green" && mark) existing++;
      else if (o.kind === "green")
        bad.push(`❌ green on base: ${nameOf(t)} — it doesn't check the PR's change: make it fail without the PR's code, or mark existing behavior right before its it or describe: // spec-existing #N: reason`);
      else if (mark) bad.push(`❌ red on base, yet marked existing behavior (${markAt(t, mark)}) — the mark isn't needed, remove it: ${nameOf(t)}`);
      else red++;
    }
    for (const l of [...unchecked, ...bad]) console.log(l);
    if (red) console.log(`✅ ${red} added ${red > 1 ? "tests are" : "test is"} red on base`);
    if (ahead) console.log(`✅ ${ahead} added ${ahead > 1 ? "tests" : "test"} green on base ${ahead > 1 ? "are" : "is"} red on ${v.also} — ${ahead > 1 ? "they check" : "it checks"} what the base adds to ${v.also}`);
    if (existing) console.log(`✅ ${existing} existing-behavior ${existing > 1 ? "tests are" : "test is"} green on base`);
    console.log(`spec-red: ${bad.length ? `${bad.length} ❌` : "every checked test passes"}${unchecked.length ? `, ${unchecked.length} not checked` : ""}`);
    return bad.length ? 1 : 0;
  } catch (e) {
    if (e instanceof Interrupted) {
      console.error(`spec-red: interrupted (${e.message}) — the worktree is removed`);
      return 2;
    }
    if (!(e instanceof Failure) && !(e instanceof GhError)) throw e;
    console.error(`spec-red: ${e.message}`);
    return 2;
  } finally {
    for (const s of INTERRUPTS) process.off(s, hold);
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
