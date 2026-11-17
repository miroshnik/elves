#!/usr/bin/env bun
/**
 * est — task actuals from Claude Code transcripts.
 *
 * Subcommands:
 *   est fact     — actual (the agent's active hours) from Claude Code transcripts for an issue
 *   est period   — summary of all the repo's sessions over a period, not tied to tasks: the flow before and after
 *
 * Runs on Bun (`bun est.ts …`), only `node:` APIs + the `gh` CLI. The source of truth is GitHub (the comment with the
 * HTML marker <!-- fact {...} --> and, where the repository has a board, the project field "Actual, h"). Without --write
 * nothing is written to GitHub.
 * Cache formats in ~/.config/elves/cache are compatible with the former est.py.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import locale from "../../github/scripts/locale.ts";
import type { Names, Plural } from "../../github/scripts/locale.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const HOME = os.homedir();
// The skill's personal state (repository registry, prices, cache) lives in an agent-neutral directory:
// $ELVES_CONFIG_DIR, otherwise ~/.config/elves — one expression in all scripts (the Elves config-dir standard):
// github pins a task to a session in the same directory.
export const EST_DIR = process.env.ELVES_CONFIG_DIR || path.join(HOME, ".config", "elves");
export const REGISTRY_PATH = path.join(EST_DIR, "repos.json");
const CACHE_DIR = path.join(EST_DIR, "cache");
// The actual's source: local Claude Code transcripts (~/.claude/projects). Other agents' sessions (#836) and Claude
// Code cloud sessions (#837) aren't read.
const PROJECTS_DIR = path.join(HOME, ".claude", "projects");
// Session pinning to tasks: `github task status` "In progress" writes <state directory>/sessions/<session id> with the
// line owner/repo#N — direct evidence "this session worked on this task", stronger than any feature in the transcript.
export const PINS_DIR = path.join(EST_DIR, "sessions");

function ensureConfigDir(): void {
  mkdirSync(EST_DIR, { recursive: true });
}

// Project fields by dictionary key (`fields` in the github skill's locales): "Actual, h" and its Russian name are
// one field, a name in any language; comments are written in the project language (`locale.projectLanguage`), parsed
// in any.
export const FIELD_FACT = "actual";
export const FIELD_STATUS = "status";
export const FIELD_TOK = "tokens"; // optional fields: present in the project — filled in, absent — skipped
export const FIELD_USD = "cost";

/** Key of a project field by its name in any dictionary language; not an est field — null. */
function fieldKey(name: string | undefined): string | null {
  if (name === "Status") return FIELD_STATUS;
  for (const n of locale.everyNames()) {
    if (name === n.fields.actual) return FIELD_FACT;
    if (name === n.fields.tokens) return FIELD_TOK;
    if (name === n.fields.cost) return FIELD_USD;
  }
  return null;
}
/** Names in the project language of the current directory. */
const projectNames = (): Names => locale.names(locale.projectLanguage());
/** Field name in output: as in the project; no field — in the project language. */
function fieldShown(meta: Meta, key: string): string {
  const n = projectNames();
  const byKey: Record<string, string> = { [FIELD_FACT]: n.fields.actual, [FIELD_TOK]: n.fields.tokens, [FIELD_USD]: n.fields.cost, [FIELD_STATUS]: "Status" };
  return meta.fields[key]?.name ?? byKey[key] ?? key;
}

// Anthropic public API rates, $ per 1M tokens: (input, output, cache read).
// Cache write = input × 1.25 (TTL 5 min) or × 2 (TTL 1 h). The key is the model id without the date: a date after the
// key in the model id (-YYYYMMDD, on Vertex AI @YYYYMMDD) doesn't change the rate, another continuation is another
// version (claude-opus-5-5 with the key claude-opus-5), it has no price until it is in the price list (#345).
// This is the API equivalent: on a subscription this money isn't charged, but the value is comparable between tasks.
// Override/extension — <state directory>/prices.json in the same format:
// {"<model id>": [input, output, cache_read]}.
export const PRICES_DATE = "2026-10-06";
type Price = [number, number, number];
export const PRICES: Record<string, Price> = {
  "claude-fable-5-1": [10.0, 50.0, 0.25],
  "claude-mythos-5-1": [10.0, 50.0, 0.25],
  "claude-fable-5": [10.0, 50.0, 1.0],
  "claude-mythos-5": [10.0, 50.0, 1.0],
  "claude-opus-5-5": [4.0, 20.0, 0.2],
  "claude-opus-5": [5.0, 25.0, 0.5],
  "claude-opus-4-8": [5.0, 25.0, 0.5],
  "claude-opus-4-7": [5.0, 25.0, 0.5],
  "claude-opus-4-6": [5.0, 25.0, 0.5],
  "claude-sonnet-5-5": [2.0, 10.0, 0.2],
  "claude-sonnet-5": [2.0, 10.0, 0.2],
  "claude-sonnet-4-6": [3.0, 15.0, 0.3],
  "claude-haiku-4-5": [1.0, 5.0, 0.1],
};
// speed=fast; cache read — ×0.1 of input; for other models a fast rate isn't published
const FAST_PRICES: Record<string, Price> = { "claude-opus-5-5": [8.0, 40.0, 0.8], "claude-opus-5": [10.0, 50.0, 1.0] };
const PRICES_PATH = path.join(EST_DIR, "prices.json");
let pricesCache: Record<string, Price> | null = null;

/**
 * Model version — its id without the date: `claude-haiku-4-5-20251001` and `claude-opus-4-5@20251101` —
 * `claude-haiku-4-5`, `claude-opus-4-5`.
 */
const modelVersion = (model: string) => model.replace(/[-@]\d{8}$/, "");

/** A model's rate in the table: by the whole id, otherwise by version; a prefix of another version doesn't count. */
const priceIn = (table: Record<string, Price>, model: string): Price | null =>
  Object.hasOwn(table, model) ? table[model]! : Object.hasOwn(table, modelVersion(model)) ? table[modelVersion(model)]! : null;

/** (input, output, cache read) $/M for the model, or null if the model isn't in the price list. */
export function priceFor(model: string, fast = false, table?: Record<string, Price>): Price | null {
  if (!table) {
    if (pricesCache === null) {
      const t: Record<string, Price> = { ...PRICES };
      const extra = loadJson<Record<string, unknown>>(PRICES_PATH, {});
      for (const [k, v] of Object.entries(extra)) {
        if (Array.isArray(v) && v.length === 3) t[k] = [Number(v[0]), Number(v[1]), Number(v[2])];
      }
      pricesCache = t;
    }
    table = pricesCache;
  }
  return (fast ? priceIn(FAST_PRICES, model) : null) ?? priceIn(table, model);
}

/** Cost of one model response in $; vals = (input, output, cache write 5m, cache write 1h, cache read). */
export function usageCost(model: string, vals: [number, number, number, number, number], fast = false, table?: Record<string, Price>): number | null {
  const p = priceFor(model, fast, table);
  if (!p) return null;
  const [pin, pout, pcr] = p;
  const [i, o, cw5, cw1, cr] = vals;
  return (i * pin + o * pout + cw5 * pin * 1.25 + cw1 * pin * 2.0 + cr * pcr) / 1e6;
}

// Task types = conventional commit types + research (a spike without code). The same words are
// branch prefixes: <type>/<issue>-<slug> (an area prefix is allowed: <area>/<type>/<issue>-<slug>).
export const EST_TYPES = ["feat", "fix", "docs", "refactor", "perf", "test", "chore", "ci", "build", "research"] as const;
// the same copy — TASK_TYPES and TASK_BRANCH_RE in skills/github/scripts/github.ts and skills/task-env/scripts/task-env.ts:
// no shared module: github and task-env import no other skill (tests/standards/scripts/skill-imports); the standard
// tests/standards/scripts/task-branch keeps the parsing identical
const BRANCH_CONV_RE = new RegExp("^(?:[\\p{L}\\p{N}_.-]+/)?(" + EST_TYPES.join("|") + ")/(\\d{1,6})-", "iu");
const PR_PAGE = 50;
const PR_MAX = 500;
const ISSUES_MAX = 500; // how many closed issues the index of closing commits keeps
const SESSION_CACHE_V = 25; // transcript cache format version (changed — reparse); 11 = session name history
// (title_hist), 12 = cloud sessions, 13 = all session directories (cwds), 14 = PR repository on pr-link, 16 = git and
// gh listing hashes — only own ones, 17 = shell keywords in a listing, 18 = agent number on a record (task fan-out),
// 19 = a subagent's branch in its own worktree — from that checkout, not gitBranch, 20 = a record in the session's
// folder on the branch of its subagent's worktree — neutral, 21 = the scope of a record and a hash — a subagent's own
// worktree, 22 = waits for input on records and wait calls (calls, perm), 23 = a response's output — by its final
// record, not the first partial one, 24 = the kinds of a response's tool calls (call_kinds)
const PROJECT_META_TTL = 86400; // a day: reread the cache of project/field ids
const OPEN_PRS_TTL = 3600; // an hour: the list of open PRs (their branches are someone else's)
// Long-lived branches: "neutral" — by themselves they don't link a task, but inside an anchor window they count.
const BASE_BRANCHES = new Set(["main", "master", "develop", "dev", "staging", "production", "release"]);

// Repository registry — the personal file <state directory>/repos.json (not part of the skill's repo).
// Format: {"owner/repo": {"paths": ["/abs/path/to/checkout", ...],
//                         "project": {"owner": "<owner>", "number": <N>}}}
// Without an entry the repo is determined from git remote origin of the current directory, the project — by its
// link to the repository; paths are needed to find transcripts (~/.claude/projects).
type Registry = Record<string, { paths?: string[]; project?: { owner: string; number: number | string } }>;

// Files not counted in the diff: lock files, snapshots, minified code, build output.
const DIFF_EXCLUDE = new RegExp(
  "(^|/)(package-lock\\.json|pnpm-lock\\.yaml|yarn\\.lock|bun\\.lockb?|Cargo\\.lock|" +
    "poetry\\.lock|composer\\.lock|Gemfile\\.lock|go\\.sum|Podfile\\.lock)$" +
    "|(^|/)__snapshots__/|\\.snap$|\\.min\\.(js|css)$|(^|/)(dist|build)/|\\.generated\\.",
  "i",
);

export class EstError extends Error {}

/** The number exists, but not as an issue (usually it's a PR). */
export class NotAnIssue extends EstError {}

const errIs = (e: unknown, text: string) => String((e as Error).message ?? e).toLowerCase().includes(text.toLowerCase());

function die(msg: string, code = 1): never {
  console.error(`error: ${msg}`);
  process.exit(code);
}

// ----------------------------------------------------------------------------
// Utilities
// ----------------------------------------------------------------------------

/** ISO string (UTC, with Z or an offset) → epoch seconds. */
export function parseTs(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t / 1000;
}

const two = (n: number) => String(n).padStart(2, "0");

function fmtLocal(epoch: number): string {
  const d = new Date(epoch * 1000);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

export function fmtH(h: number | null | undefined, digits = 2): string {
  if (h === null || h === undefined) return "—";
  const s = h.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
  return s || "0";
}

export function plural(n: number, one: string, other: string): string {
  return Math.abs(n) === 1 ? one : other;
}

export function parseSince(s: string): number {
  const m = /^(\d+)([dhwm])$/.exec(s.trim());
  if (!m) throw new EstError(`invalid period «${s}», expected like 90d / 12w / 6m / 48h`);
  const secs: Record<string, number> = { h: 3600, d: 86400, w: 7 * 86400, m: 30 * 86400 };
  return parseInt(m[1]!, 10) * secs[m[2]!]!;
}

/**
 * round(x, nd) as in Python: to the nearest, and an exact half (0.125 → 0.12) — to even.
 * This way actuals match those computed by the former est.py; toFixed alone rounds a half up.
 */
export function pyRound(x: number, nd: number): number {
  const long = x.toFixed(nd + 30); // exact decimal expansion of the binary value
  const dot = long.indexOf(".");
  const tail = long.slice(dot + 1 + nd);
  if (/^50*$/.test(tail)) {
    const kept = Number(long.slice(0, dot + 1 + nd));
    const lastDigit = Number(nd > 0 ? long[dot + nd] : long[dot - 1]);
    if (lastDigit % 2 === 0) return kept;
    return Number((kept + Math.sign(x) * 10 ** -nd).toFixed(nd));
  }
  return Number(x.toFixed(nd));
}
const round2 = (x: number) => pyRound(x, 2);
const round1 = (x: number) => pyRound(x, 1);

/** Like json.dumps(ensure_ascii=False): separators ", " and ": " — markers stay readable and compatible. */
export function pyDumps(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(pyDumps).join(", ") + "]";
  return "{" + Object.entries(v as Record<string, unknown>).map(([k, x]) => JSON.stringify(k) + ": " + pyDumps(x)).join(", ") + "}";
}

export function loadJson<T>(file: string, dflt: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return dflt;
  }
}

export function saveJson(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  // each write has its own temp file: concurrent est runs (parallel sessions, sweep) write one cache (#347)
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, file);
}

function mtimeOf(file: string): number {
  return statSync(file).mtimeMs / 1000;
}

const sameMtime = (a: unknown, b: number) => typeof a === "number" && Math.abs(a - b) < 1e-3;

/** *.jsonl recursively (like glob **\/*.jsonl), sorted. */
function walkJsonl(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const fn of names.sort()) {
      const full = path.join(d, fn);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (fn.endsWith(".jsonl")) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

const uniqSortedNums = (xs: number[]) => [...new Set(xs)].sort((a, b) => a - b);
const uniqSortedStrs = (xs: string[]) => [...new Set(xs)].sort();
const pad = (s: string, n: number, right = false) => (right ? s.padStart(n) : s.padEnd(n));

// ----------------------------------------------------------------------------
// gh
// ----------------------------------------------------------------------------

/** The network didn't come back over all the retries of a gh call: no point going further down the list (#353). */
export class NetworkError extends EstError {}

/** A network or GitHub server failure (timeout, dropped connection, 5xx) — not a request error: a retry may succeed. */
const NETWORK_FAILURE = /dial tcp|i\/o timeout|timed out|TLS handshake|connection reset|connection refused|broken pipe|unexpected EOF|no such host|network is unreachable|stream error|Client\.Timeout|deadline exceeded|HTTP 5\d\d|status code: 5\d\d/i;
/** The request didn't reach GitHub: the connection wasn't established. */
const NOT_SENT = /dial tcp|TLS handshake|no such host|network is unreachable/i;

/** Pauses before gh call retries on a network failure, ms: `ELVES_GH_RETRY_MS`, comma-separated, else 2, 5, 15 s. */
function retryPauses(): number[] {
  const env = process.env.ELVES_GH_RETRY_MS;
  return env === undefined ? [2000, 5000, 15000] : env.split(",").filter(Boolean).map(Number);
}

/**
 * A command; gh is retried with pauses on a network failure (#353). `idempotent: false` (a new comment) — retry only if
 * the request wasn't sent: otherwise GitHub may have accepted it, and a retry would duplicate the comment.
 */
function run(cmd: string[], stdin?: string, idempotent = true): string {
  const pauses = cmd[0] === "gh" ? retryPauses() : [];
  const what = `command ${cmd.slice(0, 3).join(" ")}…`;
  for (let attempt = 0; ; attempt++) {
    const r = spawnSync(cmd[0]!, cmd.slice(1), { input: stdin, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (r.error) {
      if ((r.error as NodeJS.ErrnoException).code === "ENOENT") throw new EstError(`command '${cmd[0]}' not found; the gh CLI must be installed`);
      throw new EstError(`${what}: ${r.error.message}`);
    }
    if (r.status === 0) return r.stdout;
    const err = (r.stderr || "").trim();
    const failed = `${what} exited with code ${r.status}: ${err.slice(0, 500)}`;
    if (!pauses.length || !NETWORK_FAILURE.test(err)) throw new EstError(failed);
    if (!idempotent && !NOT_SENT.test(err)) throw new EstError(`${failed} — network failure, but the request may have reached GitHub: no retry, so as not to post it twice; check and retry`);
    if (attempt >= pauses.length) throw new NetworkError(`${failed} — network failure, retries: ${pauses.length}`);
    console.error(`network failure, retry in ${pauses[attempt]! / 1000} s: ${what}`);
    Bun.sleepSync(pauses[attempt]!);
  }
}

function ghGraphql(query: string, variables: Record<string, unknown>): Any {
  const out = run(["gh", "api", "graphql", "--input", "-"], JSON.stringify({ query, variables }));
  const data = JSON.parse(out);
  if (data.errors && data.errors.length) {
    const msgs = data.errors.map((e: Any) => e.message ?? "").join("; ");
    if (!data.data) throw new EstError(`GraphQL: ${msgs}`);
    console.error(`GraphQL warning: ${msgs}`);
  }
  return data.data;
}

function ghRest(p: string, method = "GET", body?: unknown): Any {
  const cmd = ["gh", "api", "-X", method, p];
  let stdin: string | undefined;
  if (body !== undefined) {
    cmd.push("--input", "-");
    stdin = JSON.stringify(body);
  }
  const out = run(cmd, stdin, method !== "POST");
  return out.trim() ? JSON.parse(out) : null;
}

// ----------------------------------------------------------------------------
// Repository registry and projects
// ----------------------------------------------------------------------------

function loadRegistry(): Registry {
  ensureConfigDir();
  if (!existsSync(REGISTRY_PATH)) {
    saveJson(REGISTRY_PATH, {});
    console.error(`created the registry ${REGISTRY_PATH}`);
  }
  const reg = loadJson<unknown>(REGISTRY_PATH, null);
  if (!reg || typeof reg !== "object" || Array.isArray(reg)) throw new EstError(`the registry ${REGISTRY_PATH} is corrupted`);
  return reg as Registry;
}

// The checkout's GitHub repository by its origin — a copy of originRepo from skills/github/scripts/github.ts and skills/task-env/scripts/task-env.ts:
// no shared module: github and task-env import no other skill (tests/standards/scripts/skill-imports); the
// tests/standards/scripts/origin-repo standard keeps the parsing identical
const ORIGIN_RE = /^(?:[a-z][a-z\d+.-]*:\/\/(?:[^@/\s]+@)?(?:ssh\.)?github\.com(?::\d+)?\/|(?:[^@/\s:]+@)?(?:ssh\.)?github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i;

/** `owner/repo` of a GitHub origin URL (host github.com or ssh.github.com, any case, with a port), otherwise null. */
export function originRepo(url: string): string | null {
  const m = ORIGIN_RE.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

function detectRepo(): string {
  const r = spawnSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" });
  if (r.error) throw new EstError("git not found; pass --repo owner/repo");
  if (r.status !== 0) throw new EstError("couldn't determine the repository from git remote origin; pass --repo owner/repo");
  const url = r.stdout.trim();
  const repo = originRepo(url);
  if (!repo) throw new EstError(`couldn't parse the remote «${url}»; pass --repo owner/repo`);
  return repo;
}

function resolveRepo(arg?: string): string {
  const repo = arg || detectRepo();
  if (!/^[\p{L}\p{N}_.-]+\/[\p{L}\p{N}_.-]+$/u.test(repo)) throw new EstError(`invalid --repo format «${repo}», expected owner/repo`);
  return repo;
}

/** `repos/<owner>/<repo>` once per run, by any of its names: a GET by a renamed repository's former name follows the rename. */
const repoInfos = new Map<string, Any>();
function repoInfo(full: string): Any {
  const key = full.toLowerCase();
  if (!repoInfos.has(key)) {
    const info = ghRest(`repos/${full}`);
    repoInfos.set(key, info);
    if (typeof info?.full_name === "string") repoInfos.set(info.full_name.toLowerCase(), info);
  }
  return repoInfos.get(key);
}

/**
 * The repository's current name (#560): GitHub answers a renamed repository's former name with it. Reads by the former
 * name work, but a write (`gh api -X POST|PATCH`) gets HTTP 307, which gh doesn't repeat for a non-GET, and the registry
 * knows the repository by its current name. No such repository or no access — the name as given: the reads after it say
 * so; the network — an error, as for any other call.
 */
function canonicalRepo(full: string): string {
  try {
    const name = repoInfo(full)?.full_name;
    return typeof name === "string" && name ? name : full;
  } catch (e) {
    if (e instanceof NetworkError || !(e instanceof EstError)) throw e;
    return full;
  }
}

/** The repository of a command: `--repo` or the checkout's origin, under its current name. */
const repoOf = (arg?: string): string => canonicalRepo(resolveRepo(arg));

// ----------------------------------------------------------------------------
// Cache data types (compatible with est.py)
// ----------------------------------------------------------------------------

export interface PR {
  number: number;
  title: string | null;
  state: string | null;
  headRefName: string;
  baseRefName: string;
  body: string;
  mergedAt: number | null;
  updatedAt: number | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  mergeCommit: string | null;
  closing: number[];
  commits: { oid: string; at: number | null }[];
  commits_total: number;
  files: { path: string; a: number; d: number }[];
  why?: string;
}

/** A task row: with a board — its item, without one — the repository's issue (Repo.taskRows, #847). */
export interface Row {
  /** The board item; no board — null. */
  item_id: string | null;
  issue_id: string;
  number: number;
  title: string;
  state: string;
  stateReason: string | null;
  closedAt: number | null;
  createdAt: number | null;
  labels: string[];
  /** The organization's issue type ("Epic"); a personal account has no types — an epic has the `epic` label. */
  issueType?: string | null;
  /** Number of the task's epic (the sub-issue parent). */
  parent?: number | null;
  /** The recorded actual, h: the board's «Actual, h» field; no board — `h` of the «Actual» marker. */
  fact: number | null;
  /** The board's Status; no board — null. */
  status: string | null;
  fact_marker: Any | null;
}

/** The issue fields of a task row — in the board's items and in the repository's issues alike. */
const ROW_ISSUE_FIELDS = `id number title state stateReason closedAt createdAt issueType{name} parent{number}
              labels(first:15){nodes{name}} comments(last:25){nodes{databaseId body}}`;

/** A task row from an issue node (ROW_ISSUE_FIELDS); the actual and Status — the caller's: the board's fields or the marker. */
function issueRow(c: Any, itemId: string | null): Row {
  const row: Row = {
    item_id: itemId,
    issue_id: c.id,
    number: c.number,
    title: c.title,
    state: c.state,
    stateReason: c.stateReason ?? null,
    closedAt: parseTs(c.closedAt),
    createdAt: parseTs(c.createdAt),
    labels: c.labels.nodes.map((l: Any) => l.name),
    issueType: c.issueType?.name ?? null,
    parent: c.parent?.number ?? null,
    fact: null,
    status: null,
    fact_marker: null,
  };
  for (const cm of c.comments.nodes) {
    const fm = parseMarker(cm.body, "fact");
    if (fm) row.fact_marker = fm;
  }
  return row;
}

interface Meta {
  id: string;
  owner: string;
  number: number;
  title: string;
  /** Fields by key (FIELD_*): id, name in the project, options. */
  fields: Record<string, { id: string; name: string; options: Record<string, string> }>;
  fetched_at: number;
}

export interface OpenPrs {
  at: number;
  items: Record<string, { headRefName: string; closing: number[] }>;
}

export interface Closers {
  oid: Record<string, { issues: number[]; at: number | null }>;
  pr: Record<string, number[]>;
}

/** Summary of a Claude Code session, as in the sessions.json cache. */
export interface Session {
  sid: string;
  cwd: string | null;
  cwds?: string[]; // all record directories in order of appearance: a session may move to another repository mid-work
  n_human: number;
  ev: Any[][]; // [ts, branch, input, hint?, uidx?, agent? (0 — the session itself, k — the k-th subagent), scope?]
  // input — the record ends a wait for input (INPUT_HUMAN — a human prompt, INPUT_OTHER — other input: a command, a
  // coordinator's message to a subagent, a permission approved by the user), 0 — not; scope — k: the record is in the
  // k-th of the session's subagent worktrees (own checkouts); none — the session's
  calls?: Call[]; // wait calls (CI, after the merge, local checks) — the actual's split of waits
  perm?: boolean; // whether tool results carry the permission decision — a wait for the user's approval is told apart;
  // absent — no tool results
  prlinks: [number, number, string?][]; // [ts, PR number, PR repository owner/name — prRepository in Claude Code]
  commits: [number, string, number?][]; // [ts, hash, scope? — of the record whose output has it]
  first_refs: number[];
  first_urls: string[];
  usage: Any[][]; // [mid, model_idx, in, out, cw5, cw1, cr, fast]
  call_kinds?: number[]; // the kinds of each response's tool calls, by usage row: a mask over CALL_KINDS (kindBit), 0 —
  // no calls; absent — no response with calls
  models: string[];
  title: string; // the latest name
  title_refs: number[];
  title_urls: string[];
  title_hist?: [number, string][]; // (rename time, name) — in transcript order
  n_subagents: number;
  agents?: string[]; // ids of subagents by number (agent k — agents[k - 1]): the transcript's file name
  wt_branches?: string[][]; // branches of the session's subagent worktrees by scope (scope k — wt_branches[k - 1])
  source: string;
  routine: boolean;
  mtime?: number;
  v?: number;
  guest?: boolean; // a transcript from another registry repository's directory or the app's temp folder:
  // linked only by features of the task's repository
}

/** Turn context from which a turn is "tail": turns with such context were 20 % of turns and 45 % of tokens. */
export const TAIL_CTX = 400_000;

/** The subset of Repo the actual computation needs (in tests — a stub without GitHub). */
export interface FactRepo {
  full: string;
  prs(): Map<number, PR>;
  openPrs(): OpenPrs;
  closers(): Closers;
  sessions(): Session[];
  neutralBranches(): Set<string>;
  commitDiff(oid: string): number | null;
  /** Intervals of already recorded actuals: issue → sid (8 chars) → [(start, end)]; from the "Actual" markers. */
  recorded?(): Recorded;
  /** Session pinning to tasks: session id → `owner/repo#N` (loadPins); a session without a pin — by features. */
  pins?(): Map<string, string>;
}

export type Recorded = Map<number, Record<string, [number, number][]>>;

const PR_FIELDS = `number title state headRefName baseRefName body mergedAt updatedAt additions deletions changedFiles
        mergeCommit{oid} closingIssuesReferences(first:20){nodes{number}}
        commits(first:100){totalCount nodes{commit{oid authoredDate}}}
        files(first:100){nodes{path additions deletions}}`;

function packPr(p: Any): PR {
  return {
    number: p.number,
    title: p.title ?? null,
    state: p.state ?? null,
    headRefName: p.headRefName || "",
    baseRefName: p.baseRefName || "",
    body: p.body || "",
    mergedAt: parseTs(p.mergedAt),
    updatedAt: parseTs(p.updatedAt),
    additions: p.additions || 0,
    deletions: p.deletions || 0,
    changedFiles: p.changedFiles || 0,
    mergeCommit: p.mergeCommit?.oid ?? null,
    closing: (p.closingIssuesReferences?.nodes ?? []).map((n: Any) => n.number),
    commits: (p.commits?.nodes ?? []).map((c: Any) => ({ oid: c.commit.oid, at: parseTs(c.commit.authoredDate) })),
    commits_total: p.commits?.totalCount ?? 0,
    files: (p.files?.nodes ?? []).map((f: Any) => ({ path: f.path, a: f.additions, d: f.deletions })),
  };
}

const nowTs = () => Date.now() / 1000;

/** A repository + its GitHub project + caches. */
class Repo implements FactRepo {
  full: string;
  owner: string;
  name: string;
  paths: string[];
  otherPaths: string[];
  projectRef: { owner: string; number: number | string } | undefined;
  cacheDir: string;
  defaultBranch: string | null = null;
  optRefreshed = false;
  private meta_: Meta | null | undefined = undefined; // null — no board
  private prs_: Map<number, PR> | null = null;
  private open_: OpenPrs | null = null;
  private closers_: Closers | null = null;
  private sessions_: Session[] | null = null;
  private parsed_: Parsed | null = null;
  private rows_: Row[] | null = null;
  private recorded_: Recorded | null = null;
  private pins_: Map<string, string> | null = null;

  constructor(full: string, registry: Registry) {
    this.full = full;
    const [owner, name] = full.split("/") as [string, string];
    this.owner = owner;
    this.name = name;
    const cfg = registry[full] ?? {};
    this.paths = cfg.paths ?? [];
    // directories of other registry repositories: guest sessions are looked up there (a task started
    // from another repository's directory)
    this.otherPaths = uniqSortedStrs(Object.entries(registry).filter(([k]) => k !== full).flatMap(([, c]) => c.paths ?? [])).filter((x) => !this.paths.includes(x));
    this.projectRef = cfg.project;
    this.cacheDir = path.join(CACHE_DIR, full.replace("/", "__"));
  }

  // --- project ----------------------------------------------------------
  /**
   * The board (the repository's GitHub project): its id, field ids and Status options. Cached on disk (a day, with a
   * registry check). No board — no linked project and no `project` in the registry — null: the actual is then the
   * comment alone (#847); a network or GraphQL error stays an error, not "no board".
   */
  board(force = false): Meta | null {
    if (this.meta_ !== undefined && !force) return this.meta_;
    const file = path.join(this.cacheDir, "project.json");
    const cached = force ? null : loadJson<Meta | null>(file, null);
    if (cached && cached.fields?.[FIELD_FACT]?.name) {
      const fresh = nowTs() - (cached.fetched_at || 0) < PROJECT_META_TTL;
      const same = !this.projectRef || (cached.owner === this.projectRef.owner && cached.number === Number(this.projectRef.number));
      if (fresh && same) {
        this.meta_ = cached;
        return cached;
      }
    }
    const ref = this.findProject();
    if (!ref) {
      this.meta_ = null;
      return null;
    }
    const [owner, number] = ref;
    const q = `
        query($o:String!,$n:Int!){
          organization(login:$o){ projectV2(number:$n){ ...F } }
        }
        fragment F on ProjectV2 { id title number
          fields(first:50){ nodes{ __typename
            ... on ProjectV2Field{ id name dataType }
            ... on ProjectV2SingleSelectField{ id name dataType options{ id name } } } } }
        `;
    let pv: Any = null;
    try {
      pv = ghGraphql(q, { o: owner, n: number })?.organization?.projectV2 ?? null;
    } catch (e) {
      if (!(e instanceof EstError) || e instanceof NetworkError) throw e; // the network isn't "not an organization": otherwise a false "Could not resolve to a User"
      pv = null;
    }
    if (!pv) {
      const data = ghGraphql(q.replace("organization(login:$o)", "user(login:$o)"), { o: owner, n: number });
      pv = data?.user?.projectV2 ?? null;
    }
    if (!pv) throw new EstError(`project ${owner} #${number} not found`);
    const fields: Meta["fields"] = {};
    for (const f of pv.fields.nodes) {
      const key = fieldKey(f.name);
      if (key) {
        const options: Record<string, string> = {};
        for (const o of f.options ?? []) options[o.name] = o.id;
        fields[key] = { id: f.id, name: f.name, options };
      }
    }
    const missing = [FIELD_FACT, FIELD_STATUS].filter((k) => !fields[k]).map((k) => fieldShown({ fields } as Meta, k));
    if (missing.length) throw new EstError(`project ${owner} #${number} has no fields: ${missing.join(", ")}`);
    const meta: Meta = { id: pv.id, owner, number, title: pv.title, fields, fetched_at: nowTs() };
    saveJson(file, meta);
    this.meta_ = meta;
    return meta;
  }

  /** The board, which must be there: the fields are written only where it is. */
  projectMeta(force = false): Meta {
    const meta = this.board(force);
    if (!meta) throw new EstError(`repository ${this.full} has no board: no linked project and no entry in ${REGISTRY_PATH}`);
    return meta;
  }

  /** Task rows, once per run: with a board — its items, without one — the repository's issues (#847). */
  taskRows(): Row[] {
    if (this.rows_ === null) this.rows_ = this.board() ? this.projectItems() : this.repoIssues();
    return this.rows_;
  }

  /** Intervals of recorded actuals (the "Actual" marker, the iv field); a write in this run adds to them. */
  recorded(): Recorded {
    if (this.recorded_ === null) {
      this.recorded_ = new Map();
      for (const r of this.taskRows()) {
        const iv = r.fact_marker?.iv;
        if (iv && typeof iv === "object" && !Array.isArray(iv)) this.recorded_.set(r.number, iv);
      }
    }
    return this.recorded_;
  }

  /** Session pinning to tasks, once per run. */
  pins(): Map<string, string> {
    if (this.pins_ === null) this.pins_ = loadPins();
    return this.pins_;
  }

  /** The board's owner and number: from the registry, otherwise the project linked to the repository; neither — null. */
  private findProject(): [string, number] | null {
    if (this.projectRef) return [this.projectRef.owner, Number(this.projectRef.number)];
    const q = `query($o:String!,$r:String!){ repository(owner:$o,name:$r){
            projectsV2(first:5){ nodes{ number title owner{ ... on Organization{login} ... on User{login} } } } } }`;
    const nodes = ghGraphql(q, { o: this.owner, r: this.name }).repository.projectsV2.nodes;
    if (!nodes.length) return null;
    return [nodes[0].owner.login, nodes[0].number];
  }

  /** All board items with fields and the issue's latest comments. */
  private projectItems(): Row[] {
    const meta = this.projectMeta();
    const q = `
        query($id:ID!,$c:String){ node(id:$id){ ... on ProjectV2{
          items(first:100,after:$c){ pageInfo{hasNextPage endCursor} nodes{ id type
            content{ __typename ... on Issue{ ${ROW_ISSUE_FIELDS} } }
            fieldValues(first:20){ nodes{ __typename
              ... on ProjectV2ItemFieldNumberValue{ number field{ ... on ProjectV2Field{name} } }
              ... on ProjectV2ItemFieldSingleSelectValue{ name field{ ... on ProjectV2SingleSelectField{name} } } } } } } } } }
        `;
    const rows: Row[] = [];
    let cursor: string | null = null;
    for (;;) {
      const items: Any = ghGraphql(q, { id: meta.id, c: cursor }).node.items;
      for (const it of items.nodes) {
        const c = it.content ?? {};
        if (c.__typename !== "Issue") continue;
        const row = issueRow(c, it.id);
        for (const fv of it.fieldValues.nodes) {
          const key = fieldKey(fv.field?.name);
          if (key === FIELD_FACT) row.fact = fv.number ?? null;
          else if (key === FIELD_STATUS) row.status = fv.name ?? null;
        }
        rows.push(row);
      }
      if (!items.pageInfo.hasNextPage) break;
      cursor = items.pageInfo.endCursor;
    }
    return rows;
  }

  /** All of the repository's issues with their latest comments — without a board: the actual is `h` of the «Actual» marker, no Status. */
  private repoIssues(): Row[] {
    const q = `query($o:String!,$r:String!,$c:String){ repository(owner:$o,name:$r){
          issues(first:100,after:$c){ pageInfo{hasNextPage endCursor} nodes{ ${ROW_ISSUE_FIELDS} } } } }`;
    const rows: Row[] = [];
    let cursor: string | null = null;
    for (;;) {
      const conn: Any = ghGraphql(q, { o: this.owner, r: this.name, c: cursor }).repository.issues;
      for (const c of conn.nodes) {
        const row = issueRow(c, null);
        const h = row.fact_marker?.h;
        row.fact = typeof h === "number" ? h : null;
        rows.push(row);
      }
      if (!conn.pageInfo.hasNextPage) break;
      cursor = conn.pageInfo.endCursor;
    }
    return rows;
  }

  // --- PR ---------------------------------------------------------------
  /** Cache of merged PRs (incrementally by updatedAt). */
  prs(): Map<number, PR> {
    if (this.prs_ !== null) return this.prs_;
    const file = path.join(this.cacheDir, "prs.json");
    const cache = loadJson<Any>(file, { prs: {} });
    let prs = new Map<number, PR>();
    for (const [k, v] of Object.entries(cache.prs ?? {})) prs.set(Number(k), v as PR);
    if ([...prs.values()].some((v) => !("baseRefName" in v))) prs = new Map(); // old cache format — reread
    this.defaultBranch = cache.default_branch ?? null;
    const knownMax = prs.size ? Math.max(...[...prs.values()].map((v) => v.updatedAt || 0)) : 0;
    const q = `query($o:String!,$r:String!,$c:String){ repository(owner:$o,name:$r){ defaultBranchRef{name} pullRequests(first:${PR_PAGE},after:$c,states:[MERGED],orderBy:{field:UPDATED_AT,direction:DESC}){ pageInfo{hasNextPage endCursor} nodes{ ${PR_FIELDS} } } } }`;
    let cursor: string | null = null;
    let fetched = 0;
    let stop = false;
    while (!stop && fetched < PR_MAX) {
      const data = ghGraphql(q, { o: this.owner, r: this.name, c: cursor });
      this.defaultBranch = data.repository.defaultBranchRef?.name || this.defaultBranch;
      const conn = data.repository.pullRequests;
      for (const p of conn.nodes) {
        const packed = packPr(p);
        fetched++;
        if (prs.size && (packed.updatedAt || 0) <= knownMax && prs.has(packed.number)) {
          stop = true;
          break;
        }
        prs.set(packed.number, packed);
      }
      if (!conn.pageInfo.hasNextPage) break;
      cursor = conn.pageInfo.endCursor;
    }
    this.prs_ = prs;
    this.savePrs(cache);
    return prs;
  }

  private savePrs(cache?: Any): void {
    const file = path.join(this.cacheDir, "prs.json");
    const c = { ...(cache ?? loadJson<Any>(file, {})) };
    const obj: Record<string, PR> = {};
    for (const [k, v] of this.prs_!) obj[String(k)] = v;
    c.prs = obj;
    c.default_branch = this.defaultBranch;
    if (this.open_ !== null) c.open = this.open_;
    saveJson(file, c);
  }

  /** One PR (including unmerged ones) — from the cache or by a request. null — only if there's no such PR. */
  pr(number: number): PR | null {
    const prs = this.prs();
    const cached = prs.get(number);
    if (cached) return cached;
    const q = `query($o:String!,$r:String!,$n:Int!){ repository(owner:$o,name:$r){ pullRequest(number:$n){ ${PR_FIELDS} } } }`;
    let data: Any;
    try {
      data = ghGraphql(q, { o: this.owner, r: this.name, n: number });
    } catch (e) {
      if (e instanceof EstError && errIs(e, "Could not resolve to a PullRequest")) return null;
      throw e;
    }
    const p = data.repository.pullRequest;
    if (!p) return null;
    const packed = packPr(p);
    if (packed.state === "MERGED") {
      prs.set(number, packed);
      this.savePrs();
    }
    return packed;
  }

  /** Open PRs: {number: {headRefName, closing}} — their branches are foreign to other tasks (cached for an hour). */
  openPrs(): OpenPrs {
    if (this.open_ !== null) return this.open_;
    this.prs();
    const cache = loadJson<Any>(path.join(this.cacheDir, "prs.json"), {});
    const now = nowTs();
    const cached = cache.open as OpenPrs | undefined;
    if (cached && now - (cached.at || 0) < OPEN_PRS_TTL) {
      this.open_ = cached;
      return cached;
    }
    const q = `query($o:String!,$r:String!){ repository(owner:$o,name:$r){ pullRequests(states:[OPEN],first:100){
            nodes{ number headRefName closingIssuesReferences(first:20){nodes{number}} } } } }`;
    const data = ghGraphql(q, { o: this.owner, r: this.name });
    const items: OpenPrs["items"] = {};
    for (const p of data.repository.pullRequests.nodes) {
      items[String(p.number)] = { headRefName: p.headRefName || "", closing: p.closingIssuesReferences.nodes.map((n: Any) => n.number) };
    }
    this.open_ = { at: now, items };
    this.savePrs(cache);
    return this.open_;
  }

  neutralBranches(): Set<string> {
    this.prs();
    const s = new Set(BASE_BRANCHES);
    if (this.defaultBranch) s.add(this.defaultBranch);
    return s;
  }

  /**
   * Index of the closers of all the repo's closed issues (incrementally by updatedAt):
   * {"oid": {oid: {"issues": [...], "at": ts}}, "pr": {"N": [issues]}}.
   */
  closers(): Closers {
    if (this.closers_ !== null) return this.closers_;
    const file = path.join(this.cacheDir, "closers.json");
    const cache = loadJson<Any>(file, { issues: {} });
    const issues: Record<string, { updatedAt: number; closers: Any[] }> = { ...(cache.issues ?? {}) };
    const vals = Object.values(issues);
    const knownMax = vals.length ? Math.max(...vals.map((v) => v.updatedAt || 0)) : 0;
    const q = `query($o:String!,$r:String!,$c:String){ repository(owner:$o,name:$r){
          issues(states:[CLOSED],first:100,after:$c,orderBy:{field:UPDATED_AT,direction:DESC}){
            pageInfo{hasNextPage endCursor} nodes{ number updatedAt
              timelineItems(last:3,itemTypes:[CLOSED_EVENT]){ nodes{ ... on ClosedEvent{ closer{ __typename
                ... on Commit{ oid authoredDate } ... on PullRequest{ number repository{nameWithOwner} } } } } } } } } }`;
    let cursor: string | null = null;
    let fetched = 0;
    let stop = false;
    while (!stop && fetched < ISSUES_MAX) {
      const conn: Any = ghGraphql(q, { o: this.owner, r: this.name, c: cursor }).repository.issues;
      for (const n of conn.nodes) {
        fetched++;
        const upd = parseTs(n.updatedAt) || 0;
        const key = String(n.number);
        if (vals.length && upd <= knownMax && key in issues) {
          stop = true;
          break;
        }
        const closers: Any[] = [];
        for (const t of n.timelineItems.nodes) {
          const c = t?.closer ?? {};
          if (c.__typename === "Commit") closers.push({ type: "commit", oid: c.oid, at: parseTs(c.authoredDate) });
          else if (c.__typename === "PullRequest" && (c.repository?.nameWithOwner ?? this.full) === this.full) closers.push({ type: "pr", number: c.number });
        }
        issues[key] = { updatedAt: upd, closers };
      }
      if (!conn.pageInfo.hasNextPage) break;
      cursor = conn.pageInfo.endCursor;
    }
    saveJson(file, { issues });
    const oid: Closers["oid"] = {};
    const pr: Closers["pr"] = {};
    for (const [key, v] of Object.entries(issues)) {
      const num = Number(key);
      for (const c of v.closers) {
        if (c.type === "commit") {
          const d = (oid[c.oid] ??= { issues: [], at: c.at ?? null });
          if (!d.issues.includes(num)) d.issues.push(num);
        } else {
          const lst = (pr[String(c.number)] ??= []);
          if (!lst.includes(num)) lst.push(num);
        }
      }
    }
    this.closers_ = { oid, pr };
    return this.closers_;
  }

  /** Diff of a single commit (for an issue without a PR): lines without lock files/snapshots/minified code. Cached. */
  commitDiff(oid: string): number | null {
    const file = path.join(this.cacheDir, "commits.json");
    const cache = loadJson<Record<string, number>>(file, {});
    if (oid in cache) return cache[oid]!;
    let data: Any;
    try {
      data = ghRest(`repos/${this.full}/commits/${oid}`);
    } catch (e) {
      if (!(e instanceof EstError)) throw e;
      console.error(`warning: diff of commit ${oid.slice(0, 7)} not fetched: ${e.message}`);
      return null;
    }
    let n = 0;
    for (const f of data.files ?? []) if (!DIFF_EXCLUDE.test(f.filename || "")) n += (f.additions || 0) + (f.deletions || 0);
    cache[oid] = n;
    saveJson(file, cache);
    return n;
  }

  // --- transcripts -------------------------------------------------------
  /** Sessions for the actual: the repository's own (no routines), guests and pinned ones (selectSessions). */
  sessions(): Session[] {
    if (this.sessions_ === null) {
      const p = this.parsed();
      this.sessions_ = selectSessions(p.all, this.paths, p.guests, p.pinned);
    }
    return this.sessions_;
  }

  /** Sessions for a period summary: all of the repository's own and pinned ones, no guests (selectPeriodSessions). */
  periodSessions(): Session[] {
    const p = this.parsed();
    return selectPeriodSessions(p.all, this.paths, p.pinned);
  }

  private parsed(): Parsed {
    if (this.parsed_ === null) this.parsed_ = loadSessions(this);
    return this.parsed_;
  }
}

// ----------------------------------------------------------------------------
// Markers in comments
// ----------------------------------------------------------------------------

export function parseMarker(body: string | null | undefined, kind: string): Any | null {
  if (!body) return null;
  const m = new RegExp("<!--\\s*" + kind + "\\s+(\\{[\\s\\S]*?\\})\\s*-->").exec(body);
  if (!m) return null;
  try {
    return JSON.parse(m[1]!);
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------
// Claude Code transcripts
// ----------------------------------------------------------------------------

const encodePath = (p: string) => p.replace(/[^A-Za-z0-9]/g, "-");

const HASH_RE = /(?<![0-9a-zA-Z])[0-9a-f]{7,40}(?![0-9a-zA-Z])/g;
// "#N" — boundaries like \w in Python (letters and digits of any alphabet)
const ISSUE_REF_RE = /(?<![\p{L}\p{N}_/])#(\d{1,6})(?![\p{L}\p{N}_])/gu;
const ISSUE_URL_RE = /github\.com\/([\p{L}\p{N}_.-]+\/[\p{L}\p{N}_.-]+)\/issues\/(\d{1,6})(?!\d)/gu; // issue URL with the repo
// Not human prompts: notifications, service insertions, automatic routines (scheduled-task).
const SKIP_PROMPT_PREFIXES = ["<task-notification", "<\\task-notification", "<local-command", "<command-", "<system-reminder", "<\\system-reminder", "<bash-", "<scheduled-task", "<\\scheduled-task"];

const refsIn = (txt: string) => uniqSortedNums([...txt.matchAll(ISSUE_REF_RE)].map((m) => parseInt(m[1]!, 10)));
const urlsIn = (txt: string) => uniqSortedStrs([...txt.matchAll(ISSUE_URL_RE)].map((m) => `${m[1]}#${parseInt(m[2]!, 10)}`));

// Subagent assignment: a number or link right after the word "task" (`subagentPrompt.task` in any dictionary language:
// "Task #42") or at the very start is the task; after "epic" (`subagentPrompt.epic`, with any ending) and "PR" it isn't
const ISSUE_ALT = String.raw`#(\d{1,6})(?![\p{L}\p{N}_])|(?:https?:\/\/)?github\.com\/([\p{L}\p{N}_.-]+\/[\p{L}\p{N}_.-]+)\/issues\/(\d{1,6})(?!\d)`;
const TASK_WORDS = locale.every((n) => n.subagentPrompt.task).map(locale.escapeRe).join("|");
const EPIC_WORDS = locale.every((n) => n.subagentPrompt.epic).map((w) => `${locale.escapeRe(w)}\\p{L}*`).join("|");
const TASK_WORD_RE = new RegExp(String.raw`(?<![\p{L}\p{N}_])(?:${TASK_WORDS})\s+(?:${ISSUE_ALT})`, "iu");
const TASK_LEAD_RE = new RegExp(String.raw`^\s*(?:${ISSUE_ALT})`, "u");
const NOT_TASK_RE = new RegExp(String.raw`(?<![\p{L}\p{N}_])(?:${EPIC_WORDS}|PR)\s*[:—-]?\s*(?:${ISSUE_ALT})`, "giu");
// The repository after the task in a dispatcher executor's assignment — "Task #42 in o/r: …", "Task #42 «title» in o/r
// (epic #40): …" (`queue` of the github skill): the word before it is the one `queue.prompt` has in every dictionary
// language; the repository is followed by the epic or the colon. Each repository has its own numbers (#824).
const REPO_WORDS = locale.every((n) => /#\{number\}\s+(\p{L}+)\s+\{repo\}/u.exec(n.queue.prompt)?.[1] ?? "").filter(Boolean).map(locale.escapeRe).join("|");
const TASK_REPO_RE = REPO_WORDS ? new RegExp(String.raw`^(?:\s+«[^\n]*?»)?\s+(?:${REPO_WORDS})\s+([\p{L}\p{N}_.-]+\/[\p{L}\p{N}_.-]+)(?=\s*[(:])`, "iu") : null;

/**
 * The task from a subagent assignment: "Task #42 (epic #40). …" — 42, "#42 (epic #40): …" — 42, an issue link or the
 * repository after the number ("Task #42 in o/r: …" — a dispatcher's executor) — with the repository (`o/r#42`).
 * Without these signs — as before: exactly one number without links or exactly one link (and the number matching it),
 * not counting numbers after "epic" and "PR". The hint is hard (its own record — whole, someone else's — zero, branches
 * and windows aren't looked at), so when unclear there is none: "look at #42 and #39" — empty, records go by branch.
 */
function taskHintIn(txt: string): string {
  const key = (m: RegExpExecArray) => {
    if (!m[1]) return `${m[2]}#${parseInt(m[3]!, 10)}`;
    const repo = TASK_REPO_RE?.exec(txt.slice(m.index + m[0].length))?.[1];
    return repo ? `${repo}#${parseInt(m[1], 10)}` : String(parseInt(m[1], 10));
  };
  const m = TASK_WORD_RE.exec(txt) ?? TASK_LEAD_RE.exec(txt);
  if (m) return key(m);
  const rest = txt.replace(NOT_TASK_RE, " ");
  const nums = refsIn(rest);
  const urls = urlsIn(rest);
  if (urls.length === 1 && (!nums.length || (nums.length === 1 && nums[0] === parseInt(urls[0]!.split("#")[1]!, 10)))) return urls[0]!;
  if (nums.length === 1 && !urls.length) return String(nums[0]);
  return "";
}

function textOfContent(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const parts: string[] = [];
    for (const b of c) {
      if (b && typeof b === "object") {
        const o = b as Any;
        if (o.type === "text") parts.push(o.text || "");
        else if (typeof o.content === "string" || Array.isArray(o.content)) parts.push(textOfContent(o.content));
      } else if (typeof b === "string") parts.push(b);
    }
    return parts.join("\n");
  }
  return "";
}

// The app's insertion into the prompt text: Claude Code desktop (Code tab) puts it before the
// human's text. An unclosed one runs to the end of the text.
const REMINDER_RE = /<system-reminder>[\s\S]*?(?:<\/system-reminder>|$)/g;

/** Prompt text without <system-reminder> insertions: by it we decide if it's a human and look up the task number. */
function promptText(c: unknown): string {
  return textOfContent(c).replace(REMINDER_RE, "");
}

function isHumanPrompt(r: Any): boolean {
  if (r.type !== "user" || r.isSidechain || r.isMeta) return false;
  const origin = r.origin;
  if (origin && typeof origin === "object" && origin.kind && origin.kind !== "human") return false;
  const c = r.message?.content;
  if (Array.isArray(c) && c.some((b: Any) => b && typeof b === "object" && b.type === "tool_result")) return false;
  const txt = promptText(c).replace(/^\s+/, "");
  if (!txt) return false;
  return !SKIP_PROMPT_PREFIXES.some((p) => txt.startsWith(p));
}

interface Acc {
  cwd: string | null;
  cwds: string[];
  n_human: number;
  ev: Any[][];
  prlinks: [number, number, string?][];
  commits: Hash[];
  listed: Hash[]; // hashes from git listing output — only own ones go into commits (finishCommits)
  first_refs: number[] | null;
  first_urls: string[];
  usage: Any[][];
  kinds: number[]; // the kinds of each response's tool calls (Session.call_kinds), by usage row
  models: string[];
  mids: Map<string, number>; // a response's id → its row in usage
  title: string;
  titles: [number, string][];
  topCwds: Set<string>; // directories of the session's own (top-level) records
  checkouts: Map<string, Checkout | null>; // a subagent's directory outside them → its checkout (null — removed)
  switched: Map<string, Set<string>>; // the same directory → branches the subagent's git output switched to there
  written: number[]; // indexes in ev of records with gitBranch as written (in a session's directory)
  wtDirs: string[]; // the same directories in order of appearance: a record's and a hash's scope k — wtDirs[k - 1]
  wtBranches: string[][]; // branches of the worktree of scope k (finishWorktrees) — wtBranches[k - 1]
  calls: Call[]; // wait calls (Session.calls)
  perm: boolean | null; // whether tool results carry the permission decision (Session.perm); null — no tool results
}

/** A commit hash from a tool's output: [ts, hash, scope?] — scope as on a record (Session.ev), absent — the session's. */
type Hash = [number, string, number?];

const newAcc = (): Acc => ({ cwd: null, cwds: [], n_human: 0, ev: [], prlinks: [], commits: [], listed: [], first_refs: null, first_urls: [], usage: [], kinds: [], models: [], mids: new Map(), title: "", titles: [], topCwds: new Set(), checkouts: new Map(), switched: new Map(), written: [], wtDirs: [], wtBranches: [], calls: [], perm: null });

interface Checkout {
  root: string;
  branch: string;
}

/**
 * The checkout containing dir — its root and branch from its git files, without running git: `.git` is a directory
 * (the main checkout) or a `gitdir:` file (a linked worktree). A detached HEAD — "HEAD"; no such directory (the
 * worktree is already removed) or no checkout above it — null (no branch, neutral).
 */
function gitCheckout(dir: string): Checkout | null {
  if (!existsSync(dir)) return null;
  for (let d = dir; ; d = path.dirname(d)) {
    const dotGit = path.join(d, ".git");
    let gitDir: string | null = null;
    try {
      if (statSync(dotGit).isDirectory()) gitDir = dotGit;
      else {
        const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
        if (m) gitDir = path.resolve(d, m[1]!);
      }
    } catch {
      /* no .git here — look higher */
    }
    if (gitDir !== null) {
      try {
        const head = readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
        return { root: d, branch: /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1] ?? "HEAD" };
      } catch {
        return null;
      }
    }
    if (path.dirname(d) === d) return null;
  }
}

/** A subagent's record in its own worktree: its directory isn't one of the session's. */
const inOwnWorktree = (r: Any, acc: Acc, subagent: boolean) => subagent && !!r.cwd && !acc.topCwds.has(r.cwd);

/**
 * A record's branch. A subagent working in its own worktree — the branch of that worktree: Claude Code writes into a
 * subagent record's gitBranch the branch of another checkout (#490). The rest — gitBranch as written; it may be the
 * branch of a subagent's worktree too — finishWorktrees.
 */
function recordBranch(r: Any, acc: Acc, subagent: boolean): string {
  if (!inOwnWorktree(r, acc, subagent)) return r.gitBranch || "";
  if (!acc.checkouts.has(r.cwd)) acc.checkouts.set(r.cwd, gitCheckout(r.cwd));
  return acc.checkouts.get(r.cwd)?.branch ?? "";
}

/** The scope of a subagent's record in directory dir outside the session's ones: its number k in wtDirs. */
function wtScope(acc: Acc, dir: string): number {
  const k = acc.wtDirs.indexOf(dir);
  return k >= 0 ? k + 1 : acc.wtDirs.push(dir);
}

/**
 * Subagents' own worktrees after all of the session's transcripts are read; a subagent's directory inside the
 * session's own checkout isn't a worktree.
 *
 * A record in the session's directory on the branch of its subagent's own worktree — without a branch (neutral, #501):
 * Claude Code writes into gitBranch of the session's records — and of a subagent continued there after its worktree
 * was removed — the branch some agent's checkout had last, so a dispatcher's records get its executors' branches. A
 * worktree's branches — the one checked out now and those the subagent's git output switched to there (a removed
 * worktree leaves only the output).
 *
 * The scope of a record and of a hash in its output (#508): a worktree's number among the session's subagent
 * worktrees — directories of one checkout share it; the session's own checkout — none. The scope's branches — the
 * same as above: by them a PR the app bound to the session is the worktree's one.
 */
function finishWorktrees(acc: Acc): void {
  const roots = new Set<string>();
  for (const d of acc.topCwds) {
    const c = gitCheckout(d);
    if (c) roots.add(c.root);
  }
  const branchesOf = (d: string, c: Checkout | null) => [...(c ? [c.branch] : []), ...(acc.switched.get(d) ?? [])].filter((b) => b && b !== "HEAD");
  const foreign = new Set<string>();
  for (const [d, c] of acc.checkouts) if (!(c && roots.has(c.root))) for (const b of branchesOf(d, c)) foreign.add(b);
  if (foreign.size) for (const i of acc.written) if (foreign.has(acc.ev[i]![1])) acc.ev[i]![1] = "";
  const keys: string[] = [];
  const scopes = acc.wtDirs.map((d) => {
    const c = acc.checkouts.get(d) ?? null;
    if (c && roots.has(c.root)) return 0;
    const key = c?.root ?? d;
    let k = keys.indexOf(key) + 1;
    if (!k) {
      k = keys.push(key);
      acc.wtBranches.push([]);
    }
    const bs = acc.wtBranches[k - 1]!;
    for (const b of branchesOf(d, c)) if (!bs.includes(b)) bs.push(b);
    return k;
  });
  const rescope = (x: Any[], at: number) => {
    if (x[at] === undefined) return;
    const k = scopes[x[at] - 1]!;
    if (k) x[at] = k;
    else x.length = at;
  };
  for (const e of acc.ev) rescope(e, 6);
  for (const h of [...acc.commits, ...acc.listed]) rescope(h, 2);
}

function* jsonlRecords(file: string): Generator<Any> {
  const text = readFileSync(file, "utf8");
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      yield JSON.parse(line);
    } catch {
      continue;
    }
  }
}

/** Commit hashes from a tool's output (at most 60 per output, 5000 per session); scope — of the output's record. */
function collectHashes(into: Hash[], ts: number, txt: string, scope = 0): void {
  const seen = new Set<string>();
  for (const m of txt.matchAll(HASH_RE)) {
    const h = m[0];
    if (!seen.has(h) && seen.size < 60 && into.length < 5000) {
      seen.add(h);
      into.push(scope ? [ts, h, scope] : [ts, h]);
    }
  }
}

// ----------------------------------------------------------------------------
// Waits: for input (not the task's time) and of calls (the actual's split, #518)
// ----------------------------------------------------------------------------

/** A record's input mark (Session.ev[2]): a human prompt; other input — a command, a coordinator's message, an approval. */
export const INPUT_HUMAN = 1;
export const INPUT_OTHER = 2;

/**
 * A wait call: [start, end, kind, agent, slot queue s] — from the tool call to its result, a background command — to the
 * session's notification; kind — WAIT_KINDS[kind - 1]; agent — as on a record (Session.ev[5]).
 */
export type Call = [number, number, number, number, number];

/** Kinds of waits in the actual's split, in priority order: a moment inside two calls at once goes to the first one. */
export const WAIT_KINDS = ["ci", "merged", "checks"] as const;

// wait-ci of the ci-wait skill: `pr`, `status` — CI before the merge, `merged`, `issue` — after the merge and the deploy
// (and a red main's bug); `gh pr checks --watch` — the same CI wait by hand
const WAIT_CI_RE = /wait-ci(?:\.sh)?['"]?\s+(pr|status|merged|issue)\b/;
const GH_WATCH_RE = /\bgh\s+pr\s+checks\b[^;&|\n]*--watch\b/;
// local checks: typecheck, lint, test* and e2e as package scripts (options of the package manager before the name —
// `pnpm --filter web test`), the runners themselves, a command under slot (its script with a quoted command, slot.sh
// sourced) — reading slot's files isn't a check
const CHECKS_RE = /(?:^|[\s;&|(])(?:(?:bun|npm|pnpm|yarn)(?:\s+--?[\w-]+(?:[= ][^\s;&|-][^\s;&|]*)?){0,3}\s+(?:run\s+)?(?:typecheck|lint|test(?::[\w.-]+)?|e2e(?::[\w.-]+)?)(?![\w:-])|(?:npx\s+|bunx\s+)?(?:vitest|jest|tsc|eslint)(?![\w.-])|playwright\s+test\b|(?:\.|source)\s+\S*\/slot\.sh\b|slot\s+['"])|\/slot\.ts['"]?\s+['"]/;

/** The command without heredoc bodies: a file written by `cat <<EOF` or a `python3 - <<EOF` script isn't run by the shell. */
function withoutHeredocs(cmd: string): string {
  const out: string[] = [];
  let end: string | null = null;
  for (const line of cmd.split("\n")) {
    if (end !== null) {
      if (line.trim() === end) end = null;
      continue;
    }
    out.push(line);
    end = /<<-?\s*['"]?([\w-]+)['"]?/.exec(line)?.[1] ?? null;
  }
  return out.join("\n");
}

/** The kind of a wait call by its command (WAIT_KINDS index + 1); 0 — not a wait. */
export function waitKind(command: string): number {
  const cmd = withoutHeredocs(command);
  const ci = WAIT_CI_RE.exec(cmd);
  if (ci) return ci[1] === "pr" || ci[1] === "status" ? 1 : 2;
  if (GH_WATCH_RE.test(cmd)) return 1;
  return CHECKS_RE.test(cmd) ? 3 : 0;
}

// ----------------------------------------------------------------------------
// Turn kinds: the agent's work and the overhead around it (#664)
// ----------------------------------------------------------------------------

/**
 * Kinds of a turn by its tool calls: flow — the flow's overhead (its scripts, gh, git mechanics, CI waits); harness —
 * the agent app's own tools (the session, the plan, background tasks, subagents, ToolSearch); checks — lint,
 * typecheck, tests; work — the rest: reading, editing, search, other commands, a turn without calls.
 */
export const CALL_KINDS = ["work", "flow", "harness", "checks"] as const;
export type CallKind = (typeof CALL_KINDS)[number];

// the flow's skills whose scripts are its mechanics — run by their path: the machine's copy, a clone, a project's package
const FLOW_SKILLS = ["github", "est", "ci-wait", "slot", "task-env", "spec"];
const RUNNER = String.raw`(?:(?:bun|bunx|node|npx|tsx|bash|sh|zsh)(?:\s+-{1,2}[\w-]+(?:=\S+)?)*\s+)?['"]?(?:[^\s'"]*\/)?`;

/**
 * What a tool call is: the first row that matches wins, none — work. A row matches by the tool's name (`tool`) or by
 * one of the simple commands of the call's shell command (`cmd`, commandSegments). A new flow command — a row here.
 */
const CALL_RULES: ({ tool: RegExp; kind: CallKind } | { cmd: RegExp; kind: CallKind })[] = [
  { tool: /^(?:ToolSearch|TodoWrite|Task\w*|Agent|Skill|SendMessage|SubagentHandback|Monitor|ScheduleWakeup|BashOutput|KillShell|AskUserQuestion|EnterPlanMode|ExitPlanMode|EnterWorktree|ExitWorktree|ListSkills|SearchSkills|ListPlugins|SearchPlugins|update_plan)$/, kind: "harness" },
  { tool: /^mcp__ccd_/, kind: "harness" }, // the desktop app: the session's name and archive, the plan, the PR monitor
  { cmd: CHECKS_RE, kind: "checks" }, // before the flow's scripts: a check under slot is a check
  { cmd: new RegExp(String.raw`^${RUNNER}skills\/(?:${FLOW_SKILLS.join("|")})\/scripts\/`), kind: "flow" }, // wait-ci too
  { cmd: new RegExp(String.raw`^${RUNNER}bin\/elves\.ts\b`), kind: "flow" }, // the installer from a clone
  { cmd: /^(?:(?:bunx|npx)\s+(?:-\S+\s+)*@miroshnik\/elves|elves)(?:@\S*)?(?:\s|$)/, kind: "flow" }, // check, update
  { cmd: /^gh(?:\s|$)/, kind: "flow" },
  { cmd: /^git(?:\s+-[Cc]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+(?:grep|blame)\b/, kind: "work" }, // searching the code
  { cmd: /^git(?:\s|$)/, kind: "flow" },
];

// words before a command that don't change what it runs: `VAR=…`, shell keywords, `time`, `timeout 60`, `env`, `nohup`
const LEAD_RE = /^(?:[A-Za-z_]\w*=(?:'[^']*'|"(?:[^"\\]|\\.)*"|\S*)|(?:if|then|else|elif|do|while|until|!|\{|time|env|command|exec|nohup)(?=\s|$)|timeout\s+(?:-\S+\s+)*\S+)\s*/;

/**
 * A shell command's simple commands: split by `&&`, `||`, `;`, `|`, `&`, a newline, a parenthesis, `$(` and a backtick
 * outside quotes, without heredoc bodies and the leading words of LEAD_RE.
 */
export function commandSegments(command: string): string[] {
  const src = withoutHeredocs(command);
  const segs: string[] = [];
  let cur = "";
  let quote = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === "\\" && quote === '"') cur += c + (src[++i] ?? "");
      else {
        cur += c;
        if (c === quote) quote = "";
      }
    } else if (c === "'" || c === '"') {
      quote = c;
      cur += c;
    } else if (c === "\\") cur += c + (src[++i] ?? "");
    else if (";&|\n()`".includes(c) || (c === "$" && src[i + 1] === "(")) {
      segs.push(cur);
      cur = "";
    } else cur += c;
  }
  segs.push(cur);
  return segs
    .map((s) => {
      let x = s.trim();
      for (let m = LEAD_RE.exec(x); m?.[0]; m = LEAD_RE.exec(x)) x = x.slice(m[0].length);
      return x;
    })
    .filter(Boolean);
}

/** The kind of a tool call by its tool's name and its shell command, if it has one (CALL_RULES). */
export function callKind(tool: string, command?: unknown): CallKind {
  const segs = typeof command === "string" && command ? commandSegments(command) : [];
  for (const r of CALL_RULES) if ("tool" in r ? r.tool.test(tool) : segs.some((s) => r.cmd.test(s))) return r.kind;
  return "work";
}

/** The bit of a call's kind in a turn's mask (Session.call_kinds). */
const kindBit = (k: CallKind) => 1 << CALL_KINDS.indexOf(k);

/**
 * The kinds of a turn by the mask of its calls' kinds: the turn is split between them equally — a share of 1/n to each;
 * no calls — work.
 */
export function turnKinds(mask: number | undefined): CallKind[] {
  const ks = CALL_KINDS.filter((k) => (mask ?? 0) & kindBit(k));
  return ks.length ? ks : ["work"];
}

/** Turns by kind, zero. */
const noKinds = (): Record<CallKind, number> => ({ work: 0, flow: 0, harness: 0, checks: 0 });

/** Seconds a command waited in the machine queue: the `slot: waited 1 min 5 s` lines of its output, summed. */
export function slotWaitIn(txt: string): number {
  let s = 0;
  for (const m of txt.matchAll(/slot: waited (?:(\d+) min )?(\d+) s/g)) s += Number(m[1] ?? 0) * 60 + Number(m[2]);
  return s;
}

/** The slot queue of a background command — from its output file while it exists (the notification has no output). */
function outputSlotWait(file: string | null): number {
  if (!file) return 0;
  try {
    return statSync(file).size < 5e6 ? slotWaitIn(readFileSync(file, "utf8")) : 0;
  } catch {
    return 0;
  }
}

const tagIn = (txt: string, tag: string) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(txt)?.[1]?.trim() || null;

/**
 * The user's own permission decision in the dialog (not by the settings' rules or the classifier): the call waited for
 * the user's approval — a wait for input. A rule the user saved earlier (`user_permanent`) doesn't ask.
 */
const askedUser = (r: Any) => {
  const s = r.permissionDecision?.source;
  return typeof s === "string" && s.startsWith("user") && s !== "user_permanent";
};

/** Tools whose call is a question to the user: the result is their answer. */
const ASK_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

/**
 * Whether a user record that isn't a tool result ends a wait for input. Not input: a background command's notification
 * and a background subagent's hand-back — the session waited for its own work; a subagent's assignment and the
 * harness's insertions into its stream; the user's interrupt of the agent's work.
 * Input: at the session's top level — everything else (a human prompt, a command, the app's event, another session's
 * message); in a subagent — the coordinator's message (SendMessage: a dispatcher's executor waited for the owner's
 * answer) and the text of a continuation.
 */
function isInput(r: Any, subagent: boolean, first: boolean): boolean {
  const kind = r.origin && typeof r.origin === "object" ? r.origin.kind : undefined;
  const txt = promptText(r.message?.content).trimStart();
  if (kind === "task-notification" || txt.startsWith("<task-notification") || txt.startsWith("<\\task-notification")) return false;
  if (kind === "peer" && r.origin.handback) return false;
  if (txt.startsWith("[Request interrupted by user")) return false;
  if (!subagent) return true;
  if (first) return false;
  return kind === "coordinator" || !r.isMeta;
}

// Listing: git and gh commands that don't make commits but list them — including someone else's (neighbor worktrees,
// branches, log, fetch, PRs and issues via the API). The canon says to look at neighbors before work and after a
// merge, and a fresh hash of someone else's PR in such output close in time to its commit is a false anchor (#134).
// `gh pr view` isn't a listing: SKILL.md advises printing your PR's commits with it before `est fact`, it's an anchor.
const LIST_GIT = new Set(["worktree", "branch", "log", "show", "status", "fetch", "switch", "checkout", "rev-parse", "rev-list", "reflog", "for-each-ref", "show-ref", "cherry", "describe", "diff", "ls-remote", "remote", "name-rev", "merge-base", "shortlog", "blame", "ls-files", "ls-tree", "cat-file"]);
const LIST_GH = new Set(["issue", "run", "project", "label", "search", "pr list", "pr checks", "pr status", "pr diff", "repo view", "api"]);
// a shell around a listing: makes no commits; everything else (a script, bun, make…) may commit — not a listing
const LIST_SHELL = new Set(["cd", "pwd", "echo", "printf", "true", "set", "export", "read", "head", "tail", "grep", "rg", "sed", "awk", "cut", "tr", "sort", "uniq", "wc", "cat", "ls", "column", "jq", "date"]);
// shell keywords (#142): before a command they're stripped, and the command itself is checked (an `if`/`while`
// condition too); a `for … in …` and `case … in` header isn't a command; closing ones are skipped
const SHELL_PREFIX = new Set(["do", "then", "else", "elif", "if", "while", "until", "!", "{"]);
const SHELL_SKIP = new Set(["for", "case", "done", "fi", "esac", "}"]);

/**
 * The command is only a git and gh listing (with a shell around it): hashes in its output aren't anchors unless the
 * session made the commit itself.
 */
function gitListingOnly(cmd: string): boolean {
  if (/\bmutation\b/.test(cmd)) return false; // a GraphQL mutation may create a commit (createCommitOnBranch)
  let quotedSub = false;
  const bare = cmd.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, (q) => ((quotedSub ||= q[0] === '"' && /\$\(|`/.test(q)), "''"));
  if (quotedSub) return false; // "$(…)" — a command inside quotes is invisible to the parsing
  let list = false;
  const segs = bare.replace(/\d*[<>]+&?\s*[^\s;&|()]*/g, " ").replace(/\$\(|`/g, ";").split(/&&|\|\||[;|&\n()]/);
  for (const seg of segs) {
    const w = seg.trim().split(/\s+/).filter(Boolean);
    while (w.length && (SHELL_PREFIX.has(w[0]!) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!))) w.shift(); // VAR=… before the command
    if (!w.length || SHELL_SKIP.has(w[0]!)) continue;
    if (w[0] === "git") {
      let i = 1;
      while (i < w.length && w[i]!.startsWith("-")) i += w[i] === "-C" || w[i] === "-c" ? 2 : 1;
      if (!LIST_GIT.has(w[i] ?? "")) return false;
      list = true;
    } else if (w[0] === "gh") {
      if (!LIST_GH.has(w[1] ?? "") && !LIST_GH.has(`${w[1]} ${w[2]}`)) return false;
      if (w[1] === "api" && w.some((x) => /^(-X|--method)/.test(x))) return false; // PUT contents — a commit
      list = true;
    } else if (!LIST_SHELL.has(w[0]!)) return false;
  }
  return list;
}

/**
 * Listing hashes become anchors only if the same commit is in the session's own outputs (git commit, push, a script):
 * an own commit in `git log` extends the window, someone else's in `git worktree list` doesn't link. Then — by time.
 * Own — in the same checkout (#508): a commit a subagent made in its own worktree doesn't make the session's listing of
 * it an anchor, and the other way round.
 */
function finishCommits(acc: Acc): void {
  const key = (c: Hash) => `${c[2] ?? 0}:${c[1].slice(0, 7)}`;
  const own = new Map<string, string[]>();
  for (const c of acc.commits) own.set(key(c), [...(own.get(key(c)) ?? []), c[1]]);
  for (const c of acc.listed) if (hashMatches(c[1], own.get(key(c)) ?? [])) acc.commits.push(c);
  acc.commits.sort(byTs);
}

/**
 * Parse one jsonl (a session or its subagent) into the shared accumulator acc.
 *
 * Subagents (<sid>/subagents/**\/*.jsonl — Agent/Workflow) are part of the same session: their records go into the
 * timeline and give commit anchors, but the "human" prompts in them are assignments from the orchestrator, not from a
 * human, so n_human and the first prompt are taken only from the top level. On the other hand, a subagent's
 * assignment names the task ("Task #N (epic #M)", "#N" or an issue URL — taskHintIn): all records of that subagent
 * get the hint hint=N — this way the work of parallel subagents in a workflow is linked to their own tasks instead of
 * being split by commit order. agent — 0 for the session itself, k for the k-th subagent: the number goes into the
 * record, by it the actual computes task fan-out.
 */
function scanJsonl(file: string, acc: Acc, agent: number): void {
  const subagent = agent > 0;
  const commitToolIds = new Set<string>();
  const listingToolIds = new Set<string>();
  let hint = ""; // task hint for subagent records: "N" or "owner/repo#N"
  let hintDone = !subagent;
  let pending: string[] = []; // renames without a time: the time comes from the next record
  let lastTs: number | null = null;
  // tool calls: id → start, the wait kind (waitKind), the tool, whether it went to the background; a background
  // command's task id → its call id (the notification may name only the task)
  const calls = new Map<string, { at: number; kind: number; name: string; bg: boolean }>();
  const bgTask = new Map<string, string>();
  let firstUser = true; // a subagent's first user record is the assignment
  /** A background command's notification ends its call: the wait call — from the launch to it. */
  const notified = (txt: string, at: number) => {
    for (const part of txt.split("<task-notification>").slice(1)) {
      const id = tagIn(part, "tool-use-id") ?? bgTask.get(tagIn(part, "task-id") ?? "") ?? null;
      const call = id ? calls.get(id) : undefined;
      if (!call) continue;
      calls.delete(id!);
      if (call.kind) acc.calls.push([call.at, at, call.kind, agent, outputSlotWait(tagIn(part, "output-file"))]);
    }
  };
  for (const r of jsonlRecords(file)) {
    const t = r.type;
    const ts = r.timestamp ? parseTs(r.timestamp) : null;
    if (acc.cwd === null && r.cwd) acc.cwd = r.cwd;
    if (r.cwd && !acc.cwds.includes(r.cwd)) acc.cwds.push(r.cwd);
    if (r.cwd && !subagent) acc.topCwds.add(r.cwd);
    if (t === "custom-title" && !subagent) {
      // the session name by the "#<number> <task name>" convention links records to the task from the moment of the
      // rename (the first one — from the session start); Claude Code writes it without a time
      // Claude Code repeats the record during the session — only a change of name opens a period
      const title = String(r.customTitle || "");
      const prev = pending.length ? pending[pending.length - 1] : acc.titles.length ? acc.titles[acc.titles.length - 1]![1] : null;
      acc.title = title;
      if (title === prev) continue;
      if (ts !== null) acc.titles.push([ts, title]);
      else pending.push(title);
      continue;
    }
    if (ts !== null) {
      for (const title of pending) acc.titles.push([ts, title]);
      pending = [];
      lastTs = ts;
    }
    if (t === "pr-link") {
      const pr = r.prNumber;
      // a PR number without a repository is ambiguous: each repository has its own numbers
      const prRepo = String(r.prRepository || /github\.com\/([^/\s]+\/[^/\s]+)\/pull\//.exec(String(r.prUrl ?? ""))?.[1] || "");
      if (ts && Number.isInteger(pr)) acc.prlinks.push(prRepo ? [ts, pr, prRepo] : [ts, pr]);
      continue;
    }
    // a background command's notification enters the session's queue when the command ends — the end of its call; the
    // session may take it later or absorb it mid-turn without a record of its own
    if (t === "queue-operation" && r.operation === "enqueue" && ts !== null && typeof r.content === "string") notified(r.content, ts);
    if (t !== "user" && t !== "assistant") continue;
    if (ts === null) continue;
    const human = !subagent && isHumanPrompt(r);
    if (human) acc.n_human++;
    const msg = r.message ?? {};
    const content = msg.content;
    // A wait for input ends with this record (#518): a human prompt; a user record that isn't a tool result and isn't a
    // notification of the session's own work (isInput); a tool result the user approved in the permission dialog or
    // answered (AskUserQuestion)
    let input = human ? INPUT_HUMAN : 0;
    if (t === "user") {
      const results = Array.isArray(content) ? content.filter((b: Any) => b && typeof b === "object" && b.type === "tool_result") : [];
      if (results.length) {
        acc.perm = !!acc.perm || !!r.permissionDecision;
        if (askedUser(r) || results.some((b: Any) => ASK_TOOLS.has(calls.get(b.tool_use_id)?.name ?? ""))) input = INPUT_OTHER;
      } else {
        if (!human && isInput(r, subagent, firstUser)) input = INPUT_OTHER;
        notified(textOfContent(content), ts);
      }
      firstUser = false;
    }
    if (!hintDone && t === "user") {
      // a subagent's first prompt is the assignment from the orchestrator
      const txt = textOfContent(content);
      if (txt.trim()) {
        hintDone = true;
        hint = taskHintIn(txt);
      }
    }
    // Tokens: usage is duplicated on every record of one response (per content block) —
    // count it once per message.id. Input and cache are the same on every record, output_tokens is not: a subagent's
    // response is written while it streams, the first record has a partial count, the final one is the largest (#660).
    let uidx = -1;
    if (t === "assistant") {
      const u = msg.usage;
      const mid = msg.id;
      const model = msg.model;
      const seen = mid ? acc.mids.get(mid) : undefined;
      if (seen !== undefined && u && typeof u === "object") {
        const row = acc.usage[seen]!;
        row[3] = Math.max(row[3], Math.trunc(u.output_tokens || 0));
      } else if (u && typeof u === "object" && mid && model && model !== "<synthetic>") {
        acc.mids.set(mid, acc.usage.length);
        const cc = u.cache_creation ?? {};
        const cw = Math.trunc(u.cache_creation_input_tokens || 0);
        const cw1 = Math.trunc(cc.ephemeral_1h_input_tokens || 0);
        let cw5 = Math.trunc(cc.ephemeral_5m_input_tokens || 0);
        if (cw1 + cw5 === 0) cw5 = cw;
        if (!acc.models.includes(model)) acc.models.push(model);
        uidx = acc.usage.length;
        acc.usage.push([mid.slice(-12), acc.models.indexOf(model), Math.trunc(u.input_tokens || 0), Math.trunc(u.output_tokens || 0), cw5, cw1, Math.trunc(u.cache_read_input_tokens || 0), u.speed === "fast" ? 1 : 0]);
        acc.kinds.push(0);
      }
    }
    const kindRow = t === "assistant" && msg.id ? acc.mids.get(msg.id) : undefined; // the response's usage row: its calls' kinds
    const ownWt = inOwnWorktree(r, acc, subagent);
    const scope = ownWt ? wtScope(acc, r.cwd) : 0;
    if (!ownWt) acc.written.push(acc.ev.length);
    acc.ev.push([ts, recordBranch(r, acc, subagent), input, hint, uidx, agent, ...(scope ? [scope] : [])]);
    if (human && acc.first_refs === null) {
      const txt = promptText(content);
      acc.first_refs = refsIn(txt);
      acc.first_urls = urlsIn(txt);
    }
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      if (t === "assistant" && b.type === "tool_use") {
        const cmd = b.input && typeof b.input === "object" ? b.input.command : null;
        if (typeof cmd === "string" && cmd.includes("git commit")) commitToolIds.add(b.id);
        if (typeof cmd === "string" && gitListingOnly(cmd)) listingToolIds.add(b.id);
        if (b.id) calls.set(b.id, { at: ts, kind: typeof cmd === "string" ? waitKind(cmd) : 0, name: String(b.name ?? ""), bg: !!(b.input && typeof b.input === "object" && b.input.run_in_background) });
        if (kindRow !== undefined) acc.kinds[kindRow]! |= kindBit(callKind(String(b.name ?? ""), cmd));
      } else if (t === "user" && b.type === "tool_result") {
        // Hashes are taken from ANY tool_result, not only after `git commit`: a commit is often made by
        // a script (checks + commit + push), and the hash surfaces in its output. False anchors (old
        // hashes from git log) are cut off by ANCHOR_TOLERANCE — the hash must appear close in time to the
        // commit's authoredDate; fresh foreign ones from a git listing (neighbor worktrees) — by finishCommits.
        let txt = textOfContent(b.content);
        const tur = r.toolUseResult;
        if (tur && typeof tur === "object") txt += "\n" + String(tur.stdout ?? "") + "\n" + String(tur.stderr ?? "");
        // a wait call ends with its result; a command that went to the background — with its notification (notified)
        const call = calls.get(b.tool_use_id);
        const bgId = tur && typeof tur === "object" && tur.backgroundTaskId ? String(tur.backgroundTaskId) : null;
        if (call && (call.bg || bgId)) {
          if (bgId) bgTask.set(bgId, b.tool_use_id);
        } else if (call) {
          calls.delete(b.tool_use_id);
          if (call.kind) acc.calls.push([call.at, ts, call.kind, agent, slotWaitIn(txt)]);
        }
        if (!commitToolIds.has(b.tool_use_id) && !txt.includes("git") && txt.length > 20000) continue; // huge output without git — don't spend time on it
        collectHashes(listingToolIds.has(b.tool_use_id) ? acc.listed : acc.commits, ts, txt, scope);
        if (ownWt) {
          const set = acc.switched.get(r.cwd) ?? new Set<string>();
          for (const br of gitBranchesIn(txt)) set.add(br);
          if (set.size) acc.switched.set(r.cwd, set);
        }
      }
    }
  }
  // a rename at the very end: there are no records after it
  for (const title of pending) acc.titles.push([lastTs === null ? 0 : lastTs + 1, title]);
}

/** A session's subagent transcripts: <dir>/<sid>/subagents/**\/*.jsonl. */
function subagentFiles(file: string): string[] {
  const sdir = path.join(file.slice(0, -6), "subagents");
  let isDir = false;
  try {
    isDir = statSync(sdir).isDirectory();
  } catch {
    isDir = false;
  }
  return isDir ? walkJsonl(sdir) : [];
}

const byTs = (a: Any[], b: Any[]) => (a[0] as number) - (b[0] as number);

/** Compact summary of one session: the top-level jsonl + its subagents. */
export function parseSessionFile(file: string): Session {
  const acc = newAcc();
  scanJsonl(file, acc, 0);
  const subs = subagentFiles(file);
  for (const [k, sf] of subs.entries()) {
    try {
      scanJsonl(sf, acc, k + 1);
    } catch {
      continue;
    }
  }
  finishWorktrees(acc); // before sorting: written holds indexes in scan order
  acc.ev.sort(byTs);
  acc.prlinks.sort(byTs);
  finishCommits(acc);
  return {
    sid: path.basename(file).slice(0, -6),
    cwd: acc.cwd,
    cwds: acc.cwds,
    n_human: acc.n_human,
    ev: acc.ev,
    prlinks: acc.prlinks,
    commits: acc.commits,
    first_refs: acc.first_refs ?? [],
    first_urls: acc.first_urls,
    usage: acc.usage,
    ...kindsOf(acc),
    models: acc.models,
    title: acc.title,
    title_refs: refsIn(acc.title),
    title_urls: urlsIn(acc.title),
    title_hist: acc.titles,
    n_subagents: subs.length,
    agents: subs.map((f) => path.basename(f, ".jsonl")),
    ...(acc.wtBranches.length ? { wt_branches: acc.wtBranches } : {}),
    ...callsOf(acc),
    source: "claude",
    routine: acc.n_human < 3 && !acc.prlinks.length && !acc.commits.length,
  };
}

/** The kinds of the session's responses' calls (Session.call_kinds): absent — no response with calls. */
const kindsOf = (acc: Acc): Pick<Session, "call_kinds"> => (acc.kinds.some(Boolean) ? { call_kinds: acc.kinds } : {});

/** The session's wait calls (by start) and whether its tool results tell a wait for the user's approval apart. */
const callsOf = (acc: Acc): Pick<Session, "calls" | "perm"> => ({ ...(acc.calls.length ? { calls: acc.calls.sort(byTs) } : {}), ...(acc.perm !== null ? { perm: acc.perm } : {}) });

/**
 * Branches git switched to in this output, in order: `Switched to branch 'x'`, a commit line `[x abc1234]` or the
 * flow's rename `+ branch <old> → x` (`github task status --branch`; the same line — renameBranch in
 * skills/github/scripts/github.ts).
 */
function gitBranchesIn(txt: string): string[] {
  const re = /Switched to (?:a new )?branch '([^']+)'|^\[([^\s\]]+)(?: \(root-commit\))? [0-9a-f]{7,40}\]|^\+ branch \S+ → (\S+)/gm;
  return [...txt.matchAll(re)].map((m) => (m[1] ?? m[2] ?? m[3])!);
}

/** Session key in the "Actual" marker (iv) and in output — 8 chars of the id, the UUID start. */
export const sidKey = (sid: string) => sid.slice(0, 8);

/**
 * Key of an agent's intervals in the "Actual" marker: the session itself — sidKey, a subagent — `sidKey:<the end of
 * its id>`. Parallel subagents of one session work at the same time, so double counting is within one agent (#490);
 * a marker written before that has one key for the whole session.
 */
export function agentKey(s: Pick<Session, "sid" | "agents">, agent: number): string {
  if (!agent) return sidKey(s.sid);
  return `${sidKey(s.sid)}:${(s.agents?.[agent - 1] ?? String(agent)).slice(-8)}`;
}

/**
 * A session belongs to the repository if at least one of its records was made in its directory (or a worktree
 * inside): sessions are also started outside the project and then moved into it.
 */
export function inRepo(s: Session, paths: string[]): boolean {
  const cwds = s.cwds?.length ? s.cwds : [s.cwd];
  return cwds.some((c) => cwdMatches(c, paths));
}

function cwdMatches(cwd: string | null | undefined, paths: string[]): boolean {
  if (!cwd) return true; // unknown — don't discard
  return paths.some((p) => cwd === p || cwd.startsWith(p.replace(/\/+$/, "") + "/"));
}

/** Session mtime including subagents (their files are appended later than the top level). */
function sessionMtime(file: string): number {
  let m = mtimeOf(file);
  for (const sf of subagentFiles(file)) {
    try {
      m = Math.max(m, mtimeOf(sf));
    } catch {
      /* the file is gone — doesn't matter */
    }
  }
  return m;
}

function transcriptFiles(repo: Repo): string[] {
  return transcriptFilesIn(repo.paths);
}

/** Claude Code transcripts by work directory: ~/.claude/projects/<path-with-dashes>*\/*.jsonl. */
function transcriptFilesIn(paths: string[], projectsDir = PROJECTS_DIR): string[] {
  const encs = paths.map(encodePath);
  return transcriptFilesWhere((d) => encs.some((e) => d.startsWith(e)), projectsDir);
}

/** Claude Code transcripts in ~/.claude/projects directories whose name fits match. */
function transcriptFilesWhere(match: (dir: string) => boolean, projectsDir = PROJECTS_DIR): string[] {
  let dirs: string[];
  try {
    dirs = readdirSync(projectsDir).filter(match);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const d of dirs) {
    let names: string[];
    try {
      names = readdirSync(path.join(projectsDir, d));
    } catch {
      continue;
    }
    for (const fn of names) if (fn.endsWith(".jsonl")) files.push(path.join(projectsDir, d, fn));
  }
  return uniqSortedStrs(files);
}

/**
 * Transcript directory of the Claude app's temp folder (`…/Claude/scratch-workspaces/…`): a session without a chosen
 * folder works there. Having moved into a repository (change_directory), it keeps writing its transcript there until
 * the app moves it into the repository's directory — already after the task is closed.
 */
const isScratchDir = (dir: string) => dir.includes("-scratch-workspaces-");

/**
 * Repository name `owner/name` in text: in a URL, a pr-link, `git push` output (`…/owner/name.git`), but not as part
 * of another name.
 */
const slugRe = (slug: string) => new RegExp(`(?<![\\w.-])${reEscape(slug)}(?![\\w-]|\\.(?!git\\b)[\\w-])`, "i");

/**
 * Guest sessions: transcripts from other registry repositories' directories and the app's temp folders in which (or
 * in whose subagents) the task repository's name occurs — a conversation in one repository grew into a task of
 * another, a session without a folder moved into the task's repository. Without the repository's name there's no work
 * on its task there: a commit, push, PR and issue URL name it. The index is by mtime (indexFile), the text is read
 * once.
 */
export function guestTranscripts(slug: string, ownPaths: string[], otherPaths: string[], projectsDir = PROJECTS_DIR, indexFile?: string): string[] {
  const own = new Set(transcriptFilesIn(ownPaths, projectsDir));
  const re = slugRe(slug);
  const idx = indexFile ? loadJson<Record<string, { mtime: number; hit: boolean }>>(indexFile, {}) : {};
  let changed = false;
  const out: string[] = [];
  for (const f of uniqSortedStrs(transcriptFilesIn(otherPaths, projectsDir).concat(transcriptFilesWhere(isScratchDir, projectsDir)))) {
    if (own.has(f)) continue;
    let m: number;
    try {
      m = sessionMtime(f);
    } catch {
      continue;
    }
    let c = idx[f];
    if (!c || !sameMtime(c.mtime, m)) {
      const hit = [f, ...subagentFiles(f)].some((x) => {
        try {
          return re.test(readFileSync(x, "utf8"));
        } catch {
          return false;
        }
      });
      c = { mtime: m, hit };
      idx[f] = c;
      changed = true;
    }
    if (c.hit) out.push(f);
  }
  if (indexFile && changed) saveJson(indexFile, idx);
  return out;
}

/**
 * The session pin: `owner/repo#N` — the task, anything else — not a pin. github has the same parse: it imports no other
 * skill (tests/standards/scripts/skill-imports, tests/standards/scripts/session-pin).
 */
export function sessionPin(text: string): { slug: string; number: number } | null {
  const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(text.trim());
  return m ? { slug: m[1]!, number: Number(m[2]) } : null;
}

/**
 * Session pinning to tasks: the file is the session id, the line in it is the task `owner/repo#N` (sessionPin); anything
 * else (`.gitignore`) is skipped.
 */
export function loadPins(dir = PINS_DIR): Map<string, string> {
  const out = new Map<string, string>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const sid of names) {
    if (sid.startsWith(".")) continue;
    let pin: ReturnType<typeof sessionPin>;
    try {
      pin = sessionPin(readFileSync(path.join(dir, sid), "utf8"));
    } catch {
      continue;
    }
    if (pin) out.set(sid, `${pin.slug}#${pin.number}`);
  }
  return out;
}

/**
 * Transcripts of sessions pinned to the repository's tasks — in any ~/.claude/projects directory: a pin names the
 * session by id, and the id is its transcript's file name. A session started outside registry directories is found
 * too.
 */
export function pinnedTranscripts(slug: string, pins: Map<string, string>, projectsDir = PROJECTS_DIR): string[] {
  const prefix = slug.toLowerCase() + "#";
  const sids = new Set([...pins].filter(([, task]) => task.toLowerCase().startsWith(prefix)).map(([sid]) => sid));
  return sids.size ? transcriptFilesWhere(() => true, projectsDir).filter((f) => sids.has(path.basename(f, ".jsonl"))) : [];
}

/**
 * The repository's sessions from parsed transcripts: from its directories, guests and those pinned to its tasks. A
 * pinned one isn't discarded as a routine (few prompts, no PR or commits) and isn't marked a guest: `task status` named
 * its task.
 */
export function selectSessions(parsed: Record<string, Session>, paths: string[], guests: Set<string>, pinned: Set<string>): Session[] {
  const sessions: Session[] = [];
  for (const [f, s] of Object.entries(parsed)) {
    if (!s.ev.length) continue;
    if (pinned.has(f)) sessions.push(s);
    else if (s.routine) continue;
    else if (inRepo(s, paths)) sessions.push(s);
    else if (guests.has(f)) sessions.push({ ...s, guest: true });
  }
  return sessions;
}

/**
 * Sessions for a period summary: all from the repository's directories — including short ones without commits and
 * PRs, which the actual discards as routines — and those pinned to its tasks. No guests: their work is in their own
 * repository, here it's only a mention.
 */
export function selectPeriodSessions(parsed: Record<string, Session>, paths: string[], pinned: Set<string>): Session[] {
  return Object.entries(parsed)
    .filter(([f, s]) => s.ev.length && (pinned.has(f) || inRepo(s, paths)))
    .map(([, s]) => s);
}

/** The repository's parsed transcripts by file, and which of them are guests and pinned. */
interface Parsed {
  all: Record<string, Session>;
  guests: Set<string>;
  pinned: Set<string>;
}

/** Transcript parsing with an mtime cache (incremental). */
function loadSessions(repo: Repo): Parsed {
  if (!repo.paths.length) throw new EstError(`no local paths for ${repo.full} in ${REGISTRY_PATH} — nowhere to look for transcripts`);
  const file = path.join(repo.cacheDir, "sessions.json");
  const cache = loadJson<Record<string, Session>>(file, {});
  const out: Record<string, Session> = {};
  let changed = false;
  const guests = new Set(guestTranscripts(repo.full, repo.paths, repo.otherPaths, PROJECTS_DIR, path.join(repo.cacheDir, "guest-index.json")));
  const pinned = new Set(pinnedTranscripts(repo.full, repo.pins()));
  const files = uniqSortedStrs(transcriptFiles(repo).concat([...guests], [...pinned]));
  for (const f of files) {
    let mtime: number;
    try {
      mtime = sessionMtime(f);
    } catch {
      continue;
    }
    const c = cache[f];
    if (c && sameMtime(c.mtime, mtime) && c.v === SESSION_CACHE_V) {
      out[f] = c;
      continue;
    }
    let s: Session;
    try {
      s = parseSessionFile(f);
    } catch (e) {
      console.error(`skipped ${f}: ${(e as Error).message}`);
      continue;
    }
    s.mtime = mtime;
    s.v = SESSION_CACHE_V;
    out[f] = s;
    changed = true;
  }
  const same = Object.keys(cache).length === Object.keys(out).length && Object.keys(cache).every((k) => k in out);
  if (changed || !same) saveJson(file, out);
  return { all: out, guests, pinned };
}

// ----------------------------------------------------------------------------
// Linking a task to PRs/commits
// ----------------------------------------------------------------------------

/** Task branch by the canon — `[<area>/]<type>/<N>-<slug>`: type (lowercase) and number, otherwise null. */
export function taskBranch(branch: string | null | undefined): { type: string; issue: number } | null {
  const m = BRANCH_CONV_RE.exec(branch || "");
  return m ? { type: m[1]!.toLowerCase(), issue: parseInt(m[2]!, 10) } : null;
}

const branchTokens = (branch: string | null | undefined) => (branch || "").split(/[/_\-.]+/).filter(Boolean);
const isDigits = (s: string) => /^\d+$/.test(s);

/**
 * A branch by the <type>/N-slug convention — task N and only it: a number in the slug (a response code, a version)
 * isn't the number. Otherwise — the number as a separate token (issue-N-…, /N-…, -N-…), neighboring tokens not purely
 * numeric (so that dates like 2026-09-16 aren't caught).
 */
export function branchHasIssue(branch: string | null | undefined, n: number): boolean {
  const conv = taskBranch(branch);
  if (conv) return conv.issue === n;
  const toks = branchTokens(branch);
  const sn = String(n);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    const prev = i > 0 ? toks[i - 1]! : "";
    const nxt = i + 1 < toks.length ? toks[i + 1]! : "";
    if ([`issue${sn}`, `issues${sn}`, `gh${sn}`].includes(t.toLowerCase())) return true;
    if (t === sn) {
      if (isDigits(prev) || isDigits(nxt)) continue;
      if (n < 10 && !["issue", "issues", "gh"].includes(prev.toLowerCase())) continue; // single-digit numbers — only with an explicit issue-N
      return true;
    }
  }
  return false;
}

/**
 * Task number from a branch: <type>/N-slug (convention) or issue-N / issues/N.
 * Bare numbers elsewhere (release/2026-09) aren't counted as a number.
 */
export function branchIssueNumber(branch: string | null | undefined): number | null {
  const conv = taskBranch(branch);
  if (conv) return conv.issue;
  const m2 = /(?:^|[/_-])issues?[/_-]?(\d{1,6})(?:$|[/_-])/i.exec(branch || "");
  return m2 ? parseInt(m2[1]!, 10) : null;
}

/** Task type from a <type>/N-slug branch, if the branch follows the convention. */
export function branchType(branch: string | null | undefined): string | null {
  return taskBranch(branch)?.type ?? null;
}

const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const words = (pick: (n: Names) => string) => locale.every(pick).flatMap((s) => s.split(" "));
const CLOSING_WORDS = words((n) => n.est.closingWords).map(locale.escapeRe).join("|");

function closingRe(repo: Pick<Repo, "owner" | "name">, n: number): RegExp {
  return new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${CLOSING_WORDS})` +
      `[\\s:]*(?:#|https://github\\.com/${reEscape(repo.owner)}/${reEscape(repo.name)}/issues/)${n}(?!\\d)`,
    "iu",
  );
}

function fetchIssue(repo: Repo, number: number): Any {
  const q = `
    query($o:String!,$r:String!,$n:Int!){ repository(owner:$o,name:$r){ issue(number:$n){
      id number title body state stateReason closedAt createdAt url
      issueType{name}
      labels(first:20){nodes{name}}
      closedByPullRequestsReferences(first:20){nodes{number repository{nameWithOwner}}}
      timelineItems(first:100,itemTypes:[CROSS_REFERENCED_EVENT,CONNECTED_EVENT]){ nodes{ __typename
        ... on CrossReferencedEvent{ source{ __typename ... on PullRequest{ number repository{nameWithOwner} } } }
        ... on ConnectedEvent{ subject{ __typename ... on PullRequest{ number repository{nameWithOwner} } } } } }
      closedEvents: timelineItems(last:10,itemTypes:[CLOSED_EVENT]){ nodes{ __typename
        ... on ClosedEvent{ closer{ __typename ... on PullRequest{ number repository{nameWithOwner} } ... on Commit{ oid authoredDate } } } } }
      projectItems(first:10){ nodes{ id project{ id } } }
      comments(last:100){ nodes{ databaseId body author{login} } }
    } } }`;
  let data: Any;
  try {
    data = ghGraphql(q, { o: repo.owner, r: repo.name, n: number });
  } catch (e) {
    if (e instanceof EstError && errIs(e, "Could not resolve to an Issue")) throw new NotAnIssue(`#${number} is not an issue in ${repo.full}`);
    throw e;
  }
  const issue = data.repository.issue;
  if (!issue) throw new EstError(`issue #${number} not found in ${repo.full}`);
  // close events — into the common timeline list (the fact marker is looked for in the last 100 comments)
  issue.timelineItems.nodes.push(...(issue.closedEvents?.nodes ?? []));
  return issue;
}

/** The issue's item in the project; not in the project — null. */
function issueItemId(issue: Any, meta: Meta): string | null {
  for (const it of issue.projectItems?.nodes ?? []) if (it.project.id === meta.id) return it.id;
  return null;
}

type Closer = { oid: string; at: number | null };

/** What PR linking needs from a repository: the name, the PR cache and a PR by number. */
type LinkRepo = Pick<Repo, "full" | "owner" | "name" | "prs" | "pr">;

/** Issue → PRs (strong and weak links) and closing commits. */
export function resolveLinks(repo: LinkRepo, issue: Any): [PR[], Closer[], boolean] {
  const n: number = issue.number;
  const same = (o: Any) => (o?.repository?.nameWithOwner ?? repo.full) === repo.full;
  const strong = new Map<number, string>();
  const weak = new Map<number, string>();
  let closers: Closer[] = [];
  const add = (d: Map<number, string>, num: number | undefined, why: string) => {
    if (num && num !== n && !d.has(num)) d.set(num, why);
  };

  for (const p of issue.closedByPullRequestsReferences.nodes) if (same(p)) add(strong, p.number, "closed the issue");
  for (const t of issue.timelineItems.nodes) {
    const tn = t.__typename;
    if (tn === "CrossReferencedEvent") {
      const s = t.source ?? {};
      if (s.__typename === "PullRequest" && same(s)) add(weak, s.number, "mention");
    } else if (tn === "ConnectedEvent") {
      const s = t.subject ?? {};
      if (s.__typename === "PullRequest" && same(s)) add(strong, s.number, "linked by hand");
    } else if (tn === "ClosedEvent") {
      const c = t.closer ?? {};
      if (c.__typename === "PullRequest" && same(c)) add(strong, c.number, "closed the issue");
      else if (c.__typename === "Commit") closers.push({ oid: c.oid, at: parseTs(c.authoredDate) });
    }
  }

  const prs = repo.prs();
  const crx = closingRe(repo, n);
  const mention = new RegExp(`(?<![\\p{L}\\p{N}_/])#${n}(?!\\d)`, "u");
  const closerOids = new Set(closers.map((c) => c.oid));
  for (const [num, p] of prs) {
    if (p.closing.includes(n)) add(strong, num, "closingIssuesReferences");
    else if (p.mergeCommit && closerOids.has(p.mergeCommit)) add(strong, num, "the merge commit closed the issue");
    else if (p.commits.some((c) => closerOids.has(c.oid))) add(strong, num, "a PR commit closed the issue");
    else if (crx.test(p.body)) add(strong, num, `Closes #${n} in the PR body`);
    else if (branchHasIssue(p.headRefName, n)) add(strong, num, "number in the branch");
    else if (mention.test(p.body)) add(weak, num, "mention in the PR body");
  }
  for (const num of strong.keys()) weak.delete(num);
  // A mention in a PR that closes other tasks is someone else's work: otherwise a task without its own PR gets its
  // time (with splitting, though that task's actual is already recorded) and the type from its branch.
  for (const num of [...weak.keys()]) {
    const p = repo.pr(num);
    if (p && p.closing.length && !p.closing.includes(n)) weak.delete(num);
  }
  // Weak links are used only if there are no strong ones
  const [use, weakUsed] = strong.size ? [strong, false] : [weak, weak.size > 0];
  const prObjs: PR[] = [];
  for (const [num, why] of [...use.entries()].sort((a, b) => a[0] - b[0])) {
    const p = repo.pr(num);
    if (p) prObjs.push({ ...p, why });
  }
  // closing commits that belong to none of the found PRs
  const prOids = new Set<string>();
  for (const p of prObjs) {
    for (const c of p.commits) prOids.add(c.oid);
    if (p.mergeCommit) prOids.add(p.mergeCommit);
  }
  closers = closers.filter((c) => !prOids.has(c.oid));
  return [prObjs, closers, weakUsed];
}

// ----------------------------------------------------------------------------
// Computing the actual from transcripts
// ----------------------------------------------------------------------------

function diffSize(pr: PR): number {
  if (pr.files.length && pr.files.length >= Math.min(pr.changedFiles, 100)) {
    return pr.files.filter((f) => !DIFF_EXCLUDE.test(f.path)).reduce((s, f) => s + f.a + f.d, 0);
  }
  return pr.additions + pr.deletions;
}

const ANCHOR_TOLERANCE = 30 * 60; // a hash in tool output must be close in time to the commit's authoredDate

/** Index: the first 7 chars of an oid → [(oid, pr_number, authoredDate)] for prefix checks. */
function oidIndex(prs: Map<number, PR>): Map<string, [string, number, number | null][]> {
  const idx = new Map<string, [string, number, number | null][]>();
  for (const [num, p] of prs) {
    for (const c of p.commits) {
      const k = c.oid.slice(0, 7);
      if (!idx.has(k)) idx.set(k, []);
      idx.get(k)!.push([c.oid, num, c.at]);
    }
  }
  return idx;
}

const near = (ts: number, at: number | null) => at === null || at === undefined || Math.abs(ts - at) <= ANCHOR_TOLERANCE;

/** Short hash h is a prefix of one of oids (or vice versa). */
export function hashMatches(h: string, oids: Iterable<string>): boolean {
  for (const o of oids) if (o.startsWith(h) || h.startsWith(o)) return true;
  return false;
}

export interface Shared {
  unit: string;
  with: number[];
  k: number;
}

export interface Detail {
  sid: string;
  src: string;
  start: number;
  hours: number;
  prompts: number;
  rules: Record<string, number>;
  branches: Record<string, number>;
}

export interface Fact {
  issue: number;
  h: number | null;
  h_raw?: number | null;
  wall: number | null;
  cov: "full" | "partial" | "none";
  sessions: number;
  prompts: number;
  agents?: number; // subagents whose work is linked to the task (fan-out); absent — the actual predates the feature
  steps?: number; // task turns — model responses, one per message.id, subagents included; absent — the actual
  // predates the feature
  steps_agents?: number; // of them, subagents'
  tail?: number; // turns with context larger than TAIL_CTX — the most expensive
  preamble?: number; // context of the first top-level turn of the earliest session — the price of rules and tools
  ctx_end?: number; // context of the last top-level turn of the latest session
  kinds?: Record<CallKind, number>; // the turns by kind (CALL_KINDS, turnKinds): a turn of several — an equal share each
  rewrites?: number; // turns that rewrote the cache after a pause longer than its TTL (cacheRewrites)
  rewrite_usd?: number; // their cache write, $ — by a shared PR's share, like the tokens
  prs: number[];
  commits: number;
  diff: number;
  diff_na?: boolean;
  shared: Shared[];
  first?: number | null;
  last?: number | null;
  intervals: [number, number][];
  details: Detail[];
  tok: Any;
  usd: number | null;
  usd_partial?: string[];
  models?: Record<string, { mtok: number; usd: number | null }>;
  title?: string;
  weak_links?: boolean;
  links?: { pr: number; branch: string; why: string }[];
  type?: string | null;
  closers?: string[];
  epic?: boolean;
  is_pr?: boolean;
  subtasks?: Any[];
  sub_missing?: number;
  iv?: Record<string, [number, number][]>; // intervals by session (sid, 8 chars) — into the "Actual" marker
  taken?: { issue: number; h: number }[]; // not counted: already in another task's recorded actual
  overlap?: { issue: number; h: number }[]; // counted (pinning, branch, subagent, commit), but also in someone else's actual
  waits?: Waits; // the actual's split by waits, minutes (#518); absent — no time or an epic
  perm_unknown?: number; // linked sessions whose transcript doesn't tell a wait for the user's approval apart
}

/**
 * The actual's split, minutes: CI on the PR (`wait-ci pr`), after the merge and the deploy (`wait-ci merged`, `issue`),
 * local checks (typecheck, test*, lint, commands under slot), of them the slot queue, and the rest — the model and the
 * other tools. A moment inside calls of two kinds goes to the first by WAIT_KINDS; ci + merged + checks + rest = the
 * actual.
 */
export interface Waits {
  ci: number;
  merged: number;
  checks: number;
  slot: number;
  rest: number;
}

/**
 * Whether the interval from record j — the previous record of the same agent — to record i is the agent's time (#518):
 * it doesn't end with input (a wait for input isn't the task's time, however long), and it's no longer than gap or lies
 * inside a wait call of that agent (CI, checks — whole, however long). A longer pause outside a wait — the machine
 * asleep mid-call, a background process killed days later — isn't counted.
 */
export function agentTime(s: Pick<Session, "ev" | "calls">, i: number, j: number, gap: number): boolean {
  const ev = s.ev;
  if (j < 0 || ev[i]![2]) return false;
  const a = ev[j]![0] as number;
  const b = ev[i]![0] as number;
  if (b - a <= gap) return true;
  const k = ev[i]![5] ?? 0;
  return (s.calls ?? []).some((c) => c[3] === k && c[0] <= a + 1 && b <= c[1] + 1);
}

/** The split of the time `all` (merged intervals) worth h hours by the wait calls' intervals of each kind and the queue. */
export function splitWaits(all: [number, number][], byKind: [number, number][][], queue: [number, number][], h: number): Waits | null {
  const total = ivTotal(all);
  if (total <= 0 || h <= 0) return null;
  const min = (sec: number) => round1((sec / total) * h * 60); // seconds of the union → minutes of the actual (with shares)
  let taken: [number, number][] = [];
  const own = byKind.map((iv) => {
    const x = subtractIntervals(intersectIntervals(iv, all), taken);
    taken = mergeIntervals([...taken, ...x]);
    return x;
  });
  const [ci, merged, checks] = own.map((x) => min(ivTotal(x))) as [number, number, number];
  const slot = min(ivTotal(intersectIntervals(queue, own[2]!)));
  return { ci, merged, checks, slot, rest: Math.max(0, round1(h * 60 - ci - merged - checks)) };
}

type Anchor = [number, string, string, number, number]; // (ts, own|foreign, pr|commit, share, scope)

/**
 * For each record of the timeline — the index of the previous record of the same agent (the session itself or one
 * subagent), -1 — none. An interval of active time pairs records of one agent: parallel subagents' records interleave
 * in the session's timeline, and a neighbor there is usually another agent's (#490).
 */
function prevOfSameAgent(ev: Any[][]): number[] {
  const last = new Map<number, number>();
  return ev.map((e, i) => {
    const agent: number = e[5] ?? 0;
    const prev = last.get(agent) ?? -1;
    last.set(agent, i);
    return prev;
  });
}

/** Cache TTLs, s: a write to the 5-minute cache (cw5) and to the 1-hour one (cw1). */
const TTL_5M = 300;
const TTL_1H = 3600;

/**
 * Turns that rewrote the cache after a pause (#664): since the previous turn of the same agent more time passed than
 * the TTL of the cache the response writes — 5 minutes or an hour, by its cache_creation (cw5, cw1), — the cache
 * expired, and the context is written again at the price of a write instead of a read. The pause — between the turns'
 * requests: a request goes after the agent's record before the turn (a tool result, a prompt), and the cache's TTL
 * runs from the previous request. Index in ev of such a turn's first record → the rewritten tokens [cw5, cw1].
 */
export function cacheRewrites(s: Pick<Session, "ev" | "usage">, prev = prevOfSameAgent(s.ev)): Map<number, [number, number]> {
  const out = new Map<number, [number, number]>();
  const lastReq = new Map<number, number>(); // agent → its previous turn's request
  s.ev.forEach((e, i) => {
    const u = e.length > 4 && e[4] >= 0 ? s.usage?.[e[4]] : undefined;
    if (!u) return;
    const agent: number = e[5] ?? 0;
    const j = prev[i]!;
    const req: number = j >= 0 ? s.ev[j]![0] : e[0];
    const was = lastReq.get(agent);
    lastReq.set(agent, req);
    if (was === undefined) return;
    const cw5 = req - was > TTL_5M ? u[4] : 0;
    const cw1 = req - was > TTL_1H ? u[5] : 0;
    if (cw5 + cw1 > 0) out.set(i, [cw5, cw1]);
  });
  return out;
}

/**
 * Time window for linking: [a, z] (z exclusive if zOpen), only branch br (null — any one that isn't foreign)
 * or a neutral one; rule — "anchor" (own PR/commit) or "title" / "prompt" (the task is named in the session
 * name or in the first prompt — a weak link: it yields to an already recorded actual of another task); scope — only
 * records of the k-th subagent worktree (0 — any record).
 */
interface Win {
  a: number;
  z: number;
  zOpen: boolean;
  br: string | null;
  w: number;
  rule: string;
  scope: number;
}

export function computeFact(repo: FactRepo, number: number, prObjs: PR[], closers: Closer[], gapMin = 30): Fact {
  const prsAll = repo.prs();
  const openPrs = repo.openPrs().items;
  const cidx = repo.closers();
  const sessions = repo.sessions();
  const neutral = repo.neutralBranches();
  const pins = repo.pins?.() ?? new Map<string, string>();
  const gap = gapMin * 60.0;

  const ourPrs = new Set(prObjs.map((p) => p.number));

  // --- the task's "units" (PR, closing commit) and their share: one PR/commit for k tasks → 1/k ----------
  const issuesOfPr = (num: number) => {
    const s = new Set<number>([...(prsAll.get(num)?.closing ?? []), ...(cidx.pr[String(num)] ?? [])]);
    s.add(number);
    return s;
  };
  const issuesOfOid = (oid: string) => {
    const s = new Set<number>(cidx.oid[oid]?.issues ?? []);
    s.add(number);
    return s;
  };
  const others = (s: Set<number>) => [...s].filter((x) => x !== number).sort((a, b) => a - b);

  const shared: Shared[] = [];
  const prW = new Map<number, number>();
  for (const p of prObjs) {
    const iss = issuesOfPr(p.number);
    prW.set(p.number, 1.0 / iss.size);
    if (iss.size > 1) shared.push({ unit: `PR #${p.number}`, with: others(iss), k: iss.size });
  }
  const ourBranches = new Map<string, number>(); // branch → share
  for (const p of prObjs) {
    if (p.headRefName) ourBranches.set(p.headRefName, Math.max(ourBranches.get(p.headRefName) ?? 0, prW.get(p.number)!));
  }
  for (const p of Object.values(openPrs)) {
    if (p.closing.includes(number) && p.headRefName && !ourBranches.has(p.headRefName)) ourBranches.set(p.headRefName, 1.0);
  }
  const ourOid = new Map<string, [number | null, number]>(); // oid → (authoredDate, share)
  for (const p of prObjs) for (const c of p.commits) ourOid.set(c.oid, [c.at, prW.get(p.number)!]);
  for (const c of closers) {
    const iss = issuesOfOid(c.oid);
    ourOid.set(c.oid, [c.at, 1.0 / iss.size]);
    if (iss.size > 1) shared.push({ unit: locale.fill(projectNames().est.fact.commitUnit, { oid: c.oid.slice(0, 7) }), with: others(iss), k: iss.size });
  }

  const idx = oidIndex(prsAll); // commits of merged PRs (foreign anchors)
  const foreignClosers = new Map<string, [string, number | null][]>(); // closing commits of other issues: prefix → [(oid, at)]
  for (const [oid, info] of Object.entries(cidx.oid)) {
    if (!(info.issues ?? []).includes(number) && !ourOid.has(oid)) {
      const k = oid.slice(0, 7);
      if (!foreignClosers.has(k)) foreignClosers.set(k, []);
      foreignClosers.get(k)!.push([oid, info.at ?? null]);
    }
  }
  const branch2prs = new Map<string, Set<number>>();
  for (const [num, p] of prsAll) {
    if (p.headRefName) {
      if (!branch2prs.has(p.headRefName)) branch2prs.set(p.headRefName, new Set());
      branch2prs.get(p.headRefName)!.add(num);
    }
  }
  for (const [num, p] of Object.entries(openPrs)) {
    if (p.headRefName && !p.closing.includes(number)) {
      if (!branch2prs.has(p.headRefName)) branch2prs.set(p.headRefName, new Set());
      branch2prs.get(p.headRefName)!.add(-Number(num)); // an open PR: definitely not ours
    }
  }

  const isNeutral = (b: string) => b === "" || b === "HEAD" || neutral.has(b);
  const isOurBranch = (b: string) => !!b && !isNeutral(b) && (ourBranches.has(b) || branchHasIssue(b, number));
  const branchW = (b: string) => ourBranches.get(b) ?? 1.0;
  const isForeignBranch = (b: string) => {
    if (!b || isNeutral(b) || isOurBranch(b)) return false;
    const nums = branch2prs.get(b);
    if (nums && nums.size && ![...nums].some((x) => ourPrs.has(x))) return true;
    const bi = branchIssueNumber(b);
    return bi !== null && bi !== number;
  };

  /**
   * (own/foreign/neutral, share); a hash is an anchor only close in time to the commit date
   * (git commit output can also contain foreign hashes — from git log, rebase etc.).
   */
  const hashClass = (h: string, ts: number): [string, number] => {
    for (const [oid, [at, w]] of ourOid) if ((oid.startsWith(h) || h.startsWith(oid)) && near(ts, at)) return ["own", w];
    for (const [oid, num, at] of idx.get(h.slice(0, 7)) ?? []) if ((oid.startsWith(h) || h.startsWith(oid)) && !ourPrs.has(num) && near(ts, at)) return ["foreign", 0.0];
    for (const [oid, at] of foreignClosers.get(h.slice(0, 7)) ?? []) if ((oid.startsWith(h) || h.startsWith(oid)) && near(ts, at)) return ["foreign", 0.0];
    return ["neutral", 0.0];
  };

  const intervals: [number, number][] = []; // (a, b) without weight — for the union across sessions
  const tok = { in: 0.0, out: 0.0, cw: 0.0, cr: 0.0 }; // tokens of linked responses (with share)
  const byModel = new Map<string, { tok: number; usd: number; priced: boolean }>();
  const seenMids = new Set<string>();
  let rawTotal = 0.0;
  let weightedTotal = 0.0;
  const seenPrs = new Set<number>();
  const seenBranches = new Set<string>();
  const seenHashes = new Set<string>();
  let nSessions = 0;
  let nPrompts = 0;
  let nAgents = 0; // subagents whose work is linked to the task: a fan-out signal
  // turns — model responses, one per message.id; a task's price grows quadratically with their number
  let steps = 0;
  let stepsAgents = 0;
  let tail = 0;
  const kinds = noKinds(); // the turns by kind and the cache rewrites after a pause — the flow's overhead (#664)
  let rewrites = 0;
  let rewriteUsd = 0.0;
  let preamble: number | null = null;
  let preAt: number | null = null;
  let ctxEnd: number | null = null;
  let endAt: number | null = null;
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  const details: Detail[] = [];
  const iv: Record<string, [number, number][]> = {};
  // the task's time inside wait calls by kind (WAIT_KINDS) and in the slot queue — the actual's split
  const waitIv: [number, number][][] = WAIT_KINDS.map(() => []);
  const queueIv: [number, number][] = [];
  let permUnknown = 0;
  const takenS = new Map<number, number>(); // task → seconds given to its recorded actual
  const overlapS = new Map<number, number>();
  const recorded: Recorded = repo.recorded?.() ?? new Map();
  const sharedWith = new Set(shared.flatMap((x) => x.with)); // a shared PR/commit: an overlap is a share, not an error
  const ourKey = `${repo.full}#${number}`;
  const isOurKey = (k: string) => k.toLowerCase() === ourKey.toLowerCase();
  const hintOf = (e: Any[]): string => (e.length > 3 ? e[3] : "");
  const cmpAnchor = (a: Anchor, b: Anchor) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0) || a[3] - b[3];

  const sameRepo = (r: string) => r.toLowerCase() === repo.full.toLowerCase();
  const urlRefs = (urls: string[]) => urls.filter((u) => u.startsWith(repo.full + "#")).map((u) => parseInt(u.split("#")[1]!, 10));

  for (const s of sessions) {
    const ev = s.ev;
    if (!ev.length) continue;
    // A pinned session (github task status) goes whole to the task from the pin, with subagents (they have the same id)
    // and with the time before "In progress": it doesn't need the features below, foreign hashes, branches and numbers
    // in its outputs don't take the time away. Pinned to another task — not ours, whatever features of this one it
    // has. Without a pin — features. Except a subagent whose assignment names a task (the hint): an executor the
    // session queued (#546) — its records go to that task, not to the pin.
    const pin = pins.get(s.sid);
    // A guest is a transcript from another repository's directory: task numbers and branches there are its own. Its
    // branch is ours only if it's exactly our PR's branch; foreign — only if it's the branch of a foreign PR of our
    // repository.
    const guest = !!s.guest;
    // a subagent's task: with a repository — ours only if it's our repository (#824); without one — a task of the
    // session's repository: a guest's isn't ours, like its pr-link without a repository
    const ourHint = (h: string) => isOurKey(h) || (!guest && h === String(number));
    const pinnedElsewhere = pin !== undefined && !isOurKey(pin);
    if (pinnedElsewhere && !ev.some((e) => ourHint(hintOf(e)))) continue;
    const pinned = pin !== undefined;
    const ourBr = (b: string) => (guest ? !!b && ourBranches.has(b) : isOurBranch(b));
    const foreignBr = (b: string) => {
      if (!guest) return isForeignBranch(b);
      const nums = b && !isNeutral(b) && !ourBranches.has(b) ? branch2prs.get(b) : undefined;
      return !!nums?.size && ![...nums].some((x) => ourPrs.has(x));
    };
    // a guest's pr-link without a repository is ambiguous; with our repository — ours, with another — neither ours nor
    // foreign
    const links = s.prlinks.filter(([, , r]) => (r ? sameRepo(r) : !guest));
    // the app binds to the session a PR its subagent opened from its own worktree too: a PR from the branch of a
    // subagent's worktree is that worktree's anchor, like its commits (#508)
    const prScope = (pr: number) => {
      const head = prObjs.find((p) => p.number === pr)?.headRefName ?? prsAll.get(pr)?.headRefName ?? openPrs[String(pr)]?.headRefName;
      return head ? (s.wt_branches ?? []).findIndex((bs) => bs.includes(head)) + 1 : 0;
    };
    const anchors: Anchor[] = [];
    // a PR of our repository that isn't the task's is a foreign anchor: every PR of the repository is known here
    for (const [ts, pr] of links) {
      const own = ourPrs.has(pr);
      // Claude Code repeats the pr-link of the PR bound to the session even after the merge — that's the app's status,
      // not work: after the merge it's an anchor neither for its own task (otherwise it would take the time of the
      // following ones) nor for someone else's (otherwise it would cut off the window of the next task the session
      // was renamed for)
      const mergedAt = prsAll.get(pr)?.mergedAt ?? null;
      if (mergedAt !== null && ts > mergedAt) continue;
      anchors.push([ts, own ? "own" : "foreign", "pr", prW.get(pr) ?? 0.0, prScope(pr)]);
    }
    for (const [ts, h, scope] of s.commits) {
      const [cls, w] = hashClass(h, ts);
      if (cls === "own") seenHashes.add(h); // coverage — by commits of any scope
      if (cls !== "neutral") anchors.push([ts, cls, "commit", w, scope ?? 0]);
    }
    anchors.sort(cmpAnchor);
    // a guest is linked only by a feature of our repository; a number in the name — only together with it
    if (
      guest &&
      !pinned &&
      !anchors.some((a) => a[1] === "own") &&
      !ev.some((e) => ourBranches.has(e[1]) || ourHint(hintOf(e))) &&
      !urlRefs(s.first_urls ?? []).includes(number) &&
      !(s.title_hist ?? []).some(([, t]) => urlRefs(urlsIn(t)).includes(number))
    ) {
      continue;
    }
    for (const [, pr] of links) seenPrs.add(pr);
    for (const e of ev) if (e[1]) seenBranches.add(e[1]);
    const foreignTs = anchors.filter((a) => a[1] === "foreign").map((a) => a[0]);

    // windows by anchors: from the previous foreign anchor to our own; inside a window only records
    // on the anchor's branch or on a neutral branch (HEAD/empty/main…) count — foreign branches don't.
    // A session rename is a boundary too: before it, the session worked on the task from the previous name.
    // A commit in the output of a subagent in its own worktree and a PR from its branch open a window only for that
    // worktree's records, the branch and the tail are theirs too (#508): its checkout is a separate one, its branch and
    // commits tell about its records, not the session's.
    const renames = [...(s.title_hist ?? [])].map((t) => t[0]).sort((x, y) => x - y).slice(1); // the first one — from the session start
    const scopeOf = (e: Any[]): number => e[6] ?? 0;
    const windows: Win[] = [];
    let prevForeign = -1e18;
    for (const [ts, cls, kind, w, scope] of anchors) {
      if (cls === "foreign") {
        prevForeign = ts;
        continue;
      }
      const start = Math.max(prevForeign, ...renames.filter((t) => t <= ts));
      let end = ts;
      let brAt = "";
      for (const e of ev) {
        if (e[0] > ts) break;
        if (!isNeutral(e[1]) && (!scope || scopeOf(e) === scope)) brAt = e[1];
      }
      if (kind === "pr") {
        // the tail after a pr-link: while the branch is the same and there's no foreign anchor (fixes after review)
        const later = [...foreignTs, ...renames].filter((t) => t > ts);
        const nxtForeign = later.length ? Math.min(...later) : 1e18;
        for (const e of ev) {
          if (e[0] <= ts || (scope && scopeOf(e) !== scope)) continue;
          if (e[0] >= nxtForeign || e[1] !== brAt) break;
          end = e[0];
        }
      }
      windows.push({ a: start, z: end, zOpen: false, br: brAt, w, rule: "anchor", scope });
    }
    // The task is named in the session name or in the first prompt. A name applies from the moment of the rename
    // (the first one — from the session start): a session renamed for each next task gives the records of a
    // numberless branch to the task under whose name they were made, not to the last one. A name without a
    // number — the first prompt decides; no name — the first prompt for the whole session.
    const promptRefs = new Set<number>([...s.first_refs, ...urlRefs(s.first_urls ?? [])]);
    const titleRefs = (title: string) => new Set<number>([...refsIn(title), ...urlRefs(urlsIn(title))]);
    let hist: [number, Set<number>][] = [...(s.title_hist ?? [])].sort((x, y) => x[0] - y[0]).map(([t, title]) => [t, titleRefs(title)]);
    if (!hist.length && s.title) hist = [[-1e18, titleRefs(s.title)]];
    const segs: { a: number; z: number; refs: Set<number>; rule: string }[] = hist.length
      ? hist.map(([t, refs], k) => ({ a: k ? t : -1e18, z: k + 1 < hist.length ? hist[k + 1]![0] : 1e18, refs: refs.size ? refs : promptRefs, rule: refs.size ? "title" : "prompt" }))
      : [{ a: -1e18, z: 1e18, refs: promptRefs, rule: "prompt" }];
    for (const seg of segs) {
      if (!(seg.refs.size === 1 && seg.refs.has(number))) continue;
      // in the period — a PR of another repository: "#N" in the name is the number of its task, not ours
      if (s.prlinks.some(([t, , r]) => !!r && !sameRepo(r) && t >= seg.a && t < seg.z)) continue;
      // to the end of the period, the first foreign anchor in it or the first switch to a branch that is neither ours
      // nor neutral (the period's starting branch is allowed if it isn't foreign — the task was done on it)
      const later = foreignTs.filter((t) => t >= seg.a);
      let end = Math.min(seg.z, later.length ? Math.min(...later) : 1e18);
      let zOpen = end === seg.z && seg.z < 1e18; // a record at the moment of a rename already belongs to the next task
      let startBranch: string | null = null;
      for (const e of ev) {
        if (e[0] < seg.a) continue;
        if (e[0] >= end) break;
        const b: string = e[1];
        if (isNeutral(b) || ourBr(b)) continue;
        if (foreignBr(b) || (startBranch !== null && b !== startBranch)) {
          end = e[0];
          zOpen = false;
          break;
        }
        startBranch = b;
      }
      windows.push({ a: seg.a, z: end, zOpen, br: null, w: 1.0, rule: seg.rule, scope: 0 });
    }

    const attributed: number[] = []; // share (0 — not our record)
    const weak: string[] = []; // weak link rule ("title" / "prompt") or ""
    const rules: Record<string, number> = {};
    for (const e of ev) {
      const hint = hintOf(e);
      if (pinned) {
        // pinned here — all but an executor of another task; pinned elsewhere — only an executor of ours
        const ours = pinnedElsewhere ? ourHint(hint) : !hint || ourHint(hint);
        attributed.push(ours ? 1.0 : 0.0);
        weak.push("");
        const rule = pinnedElsewhere ? "subagent" : "pin";
        if (ours) rules[rule] = (rules[rule] ?? 0) + 1;
        continue;
      }
      const [ts, b] = [e[0] as number, e[1] as string];
      let w = 0.0;
      let weakRule = "";
      if (hint) {
        // a record of a subagent whose assignment names the task: ours — whole,
        // someone else's — not ours, whatever branches/windows there are
        if (ourHint(hint)) {
          w = 1.0;
          rules["subagent"] = (rules["subagent"] ?? 0) + 1;
        }
        attributed.push(w);
        weak.push("");
        continue;
      }
      if (ourBr(b)) {
        w = branchW(b);
        rules["branch"] = (rules["branch"] ?? 0) + 1;
      } else if (windows.length && !foreignBr(b)) {
        const ws = windows.filter((x) => x.a <= ts && (x.zOpen ? ts < x.z : ts <= x.z) && (x.br === null || b === x.br || isNeutral(b)) && (!x.scope || scopeOf(e) === x.scope));
        if (ws.length) {
          w = Math.max(...ws.map((x) => x.w));
          const anchored = ws.some((x) => x.rule === "anchor");
          const rule = anchored ? "anchor" : ws[0]!.rule;
          rules[rule] = (rules[rule] ?? 0) + 1;
          if (!anchored) weakRule = rule;
        }
      }
      attributed.push(w);
      weak.push(weakRule);
    }
    // A record already counted in a recorded actual of another task of this session (the marker stores intervals):
    // linked only by the name or the first prompt — not counted again; linked by pinning,
    // a branch, a subagent or its own commit — stays, but the overlap is printed (the other actual is probably wrong).
    // Intervals are compared within one agent of the session: parallel subagents work at the same time (agentKey).
    const sid8 = sidKey(s.sid);
    const prev = prevOfSameAgent(ev);
    const keyOf = (i: number) => agentKey(s, ev[i]![5] ?? 0);
    const othersBy = new Map<string, [number, [number, number][]][]>(); // agent key → (task, its recorded intervals)
    for (const [n, bySid] of recorded) {
      if (n === number) continue;
      for (const [k, ivs] of Object.entries(bySid)) {
        if ((k === sid8 || k.startsWith(sid8 + ":")) && ivs?.length) othersBy.set(k, [...(othersBy.get(k) ?? []), [n, ivs]]);
      }
    }
    if (othersBy.size) {
      const orig = [...attributed];
      // the hours given to another actual — the union of the records' intervals
      const sTaken = new Map<number, [number, number][]>();
      const sOverlap = new Map<number, [number, number][]>();
      const add = (m: Map<number, [number, number][]>, n: number, a: number, b: number) => m.set(n, [...(m.get(n) ?? []), [a, b]]);
      for (let i = 0; i < ev.length; i++) {
        if (!orig[i]) continue;
        const others = othersBy.get(keyOf(i));
        if (!others) continue;
        const t = ev[i]![0] as number;
        const j = prev[i]!;
        const pair = j >= 0 && (orig[j]! > 0 || !!ev[j]![2]) && agentTime(s, i, j, gap);
        const x = pair ? (ev[j]![0] + t) / 2 : t; // a record's interval — by the midpoint, a single one — by time
        const tol = pair ? 0 : 1; // marker boundaries are rounded to a second
        const hit = others.find(([, ivs]) => ivs.some(([a, b]) => a - tol <= x && x <= b + tol));
        if (!hit) continue;
        const a = pair ? (ev[j]![0] as number) : t;
        const rule = weak[i]!;
        if (rule) {
          attributed[i] = 0;
          add(sTaken, hit[0], a, t);
          if (--rules[rule]! <= 0) delete rules[rule];
        } else if (!sharedWith.has(hit[0])) {
          add(sOverlap, hit[0], a, t);
        }
      }
      const union = (ivs: [number, number][]) => mergeIntervals(ivs).reduce((acc, [a, b]) => acc + (b - a), 0);
      for (const [n, ivs] of sTaken) takenS.set(n, (takenS.get(n) ?? 0) + union(ivs));
      for (const [n, ivs] of sOverlap) overlapS.set(n, (overlapS.get(n) ?? 0) + union(ivs));
    }
    if (!attributed.some((w) => w > 0)) continue;
    // the interval to the previous record of the same agent counts only if that one is ours too
    // or it's the human prompt our segment started with, and if it's the agent's time (agentTime: not a wait for input)
    const next = new Array<number>(ev.length).fill(-1);
    for (let i = 0; i < ev.length; i++) if (prev[i]! >= 0) next[prev[i]!] = i;
    let sessRaw = 0.0;
    let sessW = 0.0;
    let prompts = 0;
    let sFirst: number | null = null;
    let sLast: number | null = null;
    const brs: Record<string, number> = {};
    const sessIv: [number, number][] = [];
    const ivBy = new Map<string, [number, number][]>(); // the same intervals by agent key — into the marker
    const ivAgent = new Map<number, [number, number][]>(); // the same by agent number — for its wait calls
    const sessAgents = new Set<number>();
    // (usage record, share, whether a subagent, its calls' kinds, the rewritten cache) for linked model responses
    const sessUsage: [Any[], number, boolean, number, [number, number] | undefined][] = [];
    const sUsage = s.usage ?? [];
    const rewritten = cacheRewrites(s, prev);
    const sModels = s.models ?? [];
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i]!;
      const [ts, b, human] = [e[0] as number, e[1] as string, e[2] === INPUT_HUMAN ? 1 : 0];
      const w = attributed[i]!;
      const k = next[i]!;
      if (human && !w && k >= 0 && attributed[k]! && ev[k]![0] - ts <= gap) prompts++;
      if (!w) continue;
      if (e.length > 4 && e[4] >= 0 && e[4] < sUsage.length) sessUsage.push([sUsage[e[4]]!, w, e[5] > 0, s.call_kinds?.[e[4]] ?? 0, rewritten.get(i)]);
      if (e[5] > 0) sessAgents.add(e[5]);
      prompts += human;
      sFirst = sFirst === null ? ts : sFirst;
      sLast = ts;
      const j = prev[i]!;
      if (j >= 0 && (attributed[j]! || ev[j]![2]) && agentTime(s, i, j, gap)) {
        const d = ts - ev[j]![0];
        intervals.push([ev[j]![0], ts]);
        sessIv.push([ev[j]![0], ts]);
        const ak = keyOf(i);
        ivBy.set(ak, [...(ivBy.get(ak) ?? []), [ev[j]![0], ts]]);
        const ag: number = e[5] ?? 0;
        ivAgent.set(ag, [...(ivAgent.get(ag) ?? []), [ev[j]![0], ts]]);
        sessRaw += d;
        sessW += d * w;
        const key = b || "?";
        brs[key] = (brs[key] ?? 0) + (d * w) / 3600;
      }
    }
    if (sessRaw < 60 && prompts === 0) continue; // less than a minute and no prompts (a random hash in output) — not counted as a session
    for (const [k, list] of ivBy) iv[k] = mergeIntervals([...(iv[k] ?? []), ...list]).map(([a, b]) => [Math.floor(a), Math.ceil(b)]);
    // a wait call is the task's wait as far as its agent's time is the task's
    for (const [a, z, kind, agent, queue] of s.calls ?? []) {
      const mine = ivAgent.get(agent);
      if (!mine || !kind || kind > WAIT_KINDS.length) continue;
      waitIv[kind - 1]!.push(...intersectIntervals([[a, z]], mine));
      if (queue > 0) queueIv.push(...intersectIntervals([[a, Math.min(z, a + queue)]], mine));
    }
    if (s.perm === false) permUnknown++;
    nSessions++;
    nPrompts += prompts;
    nAgents += sessAgents.size;
    rawTotal += sessRaw;
    weightedTotal += sessW;
    let sFirstTop: number | null = null; // context of the session's first and last top-level turns
    let sLastTop: number | null = null;
    for (const [u, w, sub, mask, rw] of sessUsage) {
      if (seenMids.has(u[0])) continue; // a resumed session copies the history — don't count twice
      seenMids.add(u[0]);
      const model: string = u[1] < sModels.length ? sModels[u[1]]! : "?";
      const vals: [number, number, number, number, number] = [u[2], u[3], u[4], u[5], u[6]];
      // a turn is whole for each task, only tokens are split by a shared PR's share
      const ctx = vals[0] + vals[2] + vals[3] + vals[4];
      steps++;
      if (sub) stepsAgents++;
      else {
        if (sFirstTop === null) sFirstTop = ctx;
        sLastTop = ctx;
      }
      if (ctx > TAIL_CTX) tail++;
      // a turn's kinds — whole for each task, like the turn; the rewrite's $ — by the share, like the tokens
      const ks = turnKinds(mask);
      for (const k of ks) kinds[k] += 1 / ks.length;
      if (rw) {
        rewrites++;
        rewriteUsd += (usageCost(model, [0, 0, rw[0], rw[1], 0], !!u[7]) ?? 0) * w;
      }
      tok.in += vals[0] * w;
      tok.out += vals[1] * w;
      tok.cw += (vals[2] + vals[3]) * w;
      tok.cr += vals[4] * w;
      if (!byModel.has(model)) byModel.set(model, { tok: 0.0, usd: 0.0, priced: true });
      const m = byModel.get(model)!;
      m.tok += vals.reduce((a, x) => a + x, 0) * w;
      const c = usageCost(model, vals, !!u[7]);
      if (c === null) m.priced = false;
      else m.usd += c * w;
    }
    firstTs = firstTs === null ? sFirst : Math.min(firstTs, sFirst!);
    lastTs = lastTs === null ? sLast : Math.max(lastTs, sLast!);
    if (sFirstTop !== null && (preAt === null || sFirst! < preAt)) (preAt = sFirst!), (preamble = sFirstTop);
    if (sLastTop !== null && (endAt === null || sLast! > endAt)) (endAt = sLast!), (ctxEnd = sLastTop);
    // intervals of parallel agents overlap: the session's hours and their split by branch — by the union, like the total
    const sessUnion = mergeIntervals(sessIv).reduce((acc, [a, b]) => acc + (b - a), 0);
    const par = sessRaw > 0 ? sessUnion / sessRaw : 0;
    const branches: Record<string, number> = {};
    for (const [k, v] of Object.entries(brs).sort((a, b) => b[1] - a[1])) branches[k] = round2(v * par);
    details.push({ sid: s.sid, src: s.source ?? "claude", start: sFirst!, hours: round2((sessW * par) / 3600), prompts, rules, branches });
  }

  const merged = mergeIntervals(intervals);
  const activeRaw = merged.reduce((s, [a, b]) => s + (b - a), 0); // without double counting across sessions
  const overlap = rawTotal > 0 ? activeRaw / rawTotal : 1.0;
  const active = (weightedTotal * overlap) / 3600;

  // coverage
  const prSeen = (p: PR) =>
    seenPrs.has(p.number) || (!!p.headRefName && seenBranches.has(p.headRefName)) || [...seenHashes].some((h) => hashMatches(h, p.commits.map((c) => c.oid)));
  const units = [...prObjs.map(prSeen), ...closers.map((c) => [...seenHashes].some((h) => hashMatches(h, [c.oid])))];
  let cov: Fact["cov"];
  if (nSessions === 0) cov = "none";
  else if (units.length && units.every(Boolean)) cov = "full";
  else cov = "partial";

  let diff = prObjs.reduce((s, p) => s + diffSize(p), 0);
  let diffNa = false;
  for (const c of closers) {
    const d = repo.commitDiff(c.oid);
    if (d === null) diffNa = true;
    else diff += d;
  }
  const res: Fact = {
    issue: number,
    h: cov !== "none" ? round2(active) : null,
    h_raw: cov !== "none" ? round2(activeRaw / 3600) : null,
    wall: firstTs !== null && cov !== "none" ? round1((lastTs! - firstTs) / 3600) : null,
    cov,
    sessions: nSessions,
    prompts: nPrompts,
    agents: nAgents,
    steps,
    steps_agents: stepsAgents,
    tail,
    kinds: roundKinds(kinds),
    rewrites,
    rewrite_usd: round2(rewriteUsd),
    ...(preamble !== null ? { preamble } : {}),
    ...(ctxEnd !== null ? { ctx_end: ctxEnd } : {}),
    prs: prObjs.map((p) => p.number),
    commits: prObjs.reduce((s, p) => s + (p.commits_total || p.commits.length), 0) + closers.length,
    diff,
    diff_na: diffNa,
    shared,
    first: firstTs,
    last: lastTs,
    intervals: merged,
    details: [...details].sort((a, b) => a.start - b.start),
    tok: null,
    usd: null,
    iv,
    taken: hoursByIssue(takenS),
    overlap: hoursByIssue(overlapS),
    perm_unknown: permUnknown,
  };
  Object.assign(res, cov !== "none" ? tokensResult(tok, byModel) : { tok: null, usd: null });
  // the split of the actual by waits
  const waits = res.h !== null ? splitWaits(merged, waitIv, queueIv, res.h) : null;
  if (waits) res.waits = waits;
  return res;
}

/** Turns by kind to a tenth — the actual's, as its marker keeps them. */
const roundKinds = (k: Record<CallKind, number>): Record<CallKind, number> => ({ work: round1(k.work), flow: round1(k.flow), harness: round1(k.harness), checks: round1(k.checks) });

/** {task: seconds} → [{issue, h}] by task number; less than 0.01 h isn't shown. */
function hoursByIssue(m: Map<number, number>): { issue: number; h: number }[] {
  return [...m].sort((a, b) => a[0] - b[0]).map(([issue, sec]) => ({ issue, h: round2(sec / 3600) })).filter((x) => x.h > 0);
}

/** Fold tokens and cost into result fields: tok (integers), usd, usd_partial, models. */
function tokensResult(tok: { in: number; out: number; cw: number; cr: number }, byModel: Map<string, { tok: number; usd: number; priced: boolean }>): Partial<Fact> {
  const total = tok.in + tok.out + tok.cw + tok.cr;
  if (total <= 0) return { tok: null, usd: null };
  const t: Record<string, number> = { in: pyRound(tok.in, 0), out: pyRound(tok.out, 0), cw: pyRound(tok.cw, 0), cr: pyRound(tok.cr, 0), total: pyRound(total, 0) };
  const priced = [...byModel.values()].filter((m) => m.priced);
  const unpriced = [...byModel.entries()].filter(([, m]) => !m.priced).map(([n]) => n).sort();
  const usd = priced.length ? round2([...byModel.values()].reduce((s, m) => s + m.usd, 0)) : null;
  const models: Record<string, { mtok: number; usd: number | null }> = {};
  for (const [name, m] of [...byModel.entries()].sort((a, b) => b[1].tok - a[1].tok)) models[name] = { mtok: round2(m.tok / 1e6), usd: m.priced ? round2(m.usd) : null };
  return { tok: t, usd, usd_partial: unpriced, models };
}

const fmtMtok = (n: number | null | undefined) => fmtH((n || 0) / 1e6, 2);

/** "Tokens: 12.3 M (input … · output … · cache write … · cache read …); cost at API rates ≈ $…". */
/**
 * "Turns: 250 (subagents 2, their turns 120), preamble 104K, context at the end 581K, turns with context > 400K —
 * 31 %."
 */
function stepsTxt(res: Fact, language = locale.projectLanguage()): string {
  const k = (v: number | null | undefined) => (v === null || v === undefined ? "—" : String(Math.round(v / 1000)));
  const n = res.steps ?? 0;
  const share = n ? Math.round(((res.tail ?? 0) / n) * 100) : 0;
  return locale.fill(locale.names(language).est.fact.steps, { n, agents: res.agents ?? 0, agentSteps: res.steps_agents ?? 0, preamble: k(res.preamble), end: k(res.ctx_end), tail: TAIL_CTX / 1000, share });
}

/**
 * "Overhead: flow turns 30, harness 12, checks 15 of 250; cache rewrites after a pause 4 — $2.10." — the turns of the
 * flow's overhead and the $ of the cache rewrites (#664), whole turns.
 */
function overheadTxt(res: Fact, language = locale.projectLanguage()): string {
  const k = res.kinds ?? noKinds();
  const m = (v: number) => String(Math.round(v));
  return locale.fill(locale.names(language).est.fact.overhead, { flow: m(k.flow), harness: m(k.harness), checks: m(k.checks), n: res.steps ?? 0, rewrites: res.rewrites ?? 0, usd: (res.rewrite_usd ?? 0).toFixed(2) });
}

/** "Waits: CI 4 min · after the merge 4 · checks 6 (slot queue 1) · rest 15." — whole minutes. */
export function waitsTxt(w: Waits, language = locale.projectLanguage()): string {
  const n = locale.names(language);
  const m = (v: number) => String(Math.round(v));
  const slot = w.checks > 0 ? locale.fill(n.est.fact.waitsSlot, { slot: m(w.slot) }) : "";
  return locale.fill(n.est.fact.waits, { ci: m(w.ci), merged: m(w.merged), checks: m(w.checks), slot, rest: m(w.rest) });
}

function tokensTxt(res: Fact, language = locale.projectLanguage()): string {
  const t = res.tok;
  if (!t) return "";
  const n = locale.names(language);
  let s = locale.fill(n.est.fact.tokens, { total: fmtMtok(t.total) });
  if ("in" in t) s += locale.fill(n.est.fact.tokensSplit, { in: fmtMtok(t.in), out: fmtMtok(t.out), cw: fmtMtok(t.cw), cr: fmtMtok(t.cr) });
  if (res.usd !== null && res.usd !== undefined) {
    s += locale.fill(n.est.fact.cost, { usd: res.usd.toFixed(2) });
    const ms = Object.entries(res.models ?? {}).filter(([, m]) => m.usd);
    if (ms.length > 1) s += " (" + ms.map(([id, m]) => `${id} $${m.usd!.toFixed(2)}`).join(", ") + ")";
  }
  if (res.usd_partial?.length) s += locale.fill(n.est.fact.unpriced, { models: res.usd_partial.join(", ") });
  return s + ".";
}

/**
 * Sweep warning about double counting: the sum of task hours against the union of their intervals within each
 * session's agent (the key is like iv in the "Actual" marker — agentKey), summed over the keys. Parallel sessions and
 * parallel subagents legitimately run at the same time — an overlap between them isn't double counting; double
 * counting is when records of one agent went into the actuals of two tasks.
 */
export function sweepOverlapWarning(facts: { h: number; iv?: Record<string, [number, number][]> }[]): string | null {
  const total = facts.reduce((s, f) => s + f.h, 0);
  const bySession = new Map<string, [number, number][]>();
  for (const f of facts) for (const [sid, list] of Object.entries(f.iv ?? {})) bySession.set(sid, [...(bySession.get(sid) ?? []), ...list]);
  let unionSec = 0;
  for (const list of bySession.values()) unionSec += mergeIntervals(list).reduce((s, [a, b]) => s + (b - a), 0);
  const unionH = unionSec / 3600;
  if (total - unionH <= 0.05) return null;
  return `WARNING: intervals of one session in the actuals of different tasks: sum ${fmtH(total)} h against the union by session ${fmtH(unionH)} h — double counting ≈ ${fmtH(total - unionH)} h`;
}

export function mergeIntervals(iv: [number, number][]): [number, number][] {
  const sorted = [...iv].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Length of the union of intervals, s. */
const ivTotal = (iv: [number, number][]) => mergeIntervals(iv).reduce((s, [a, b]) => s + (b - a), 0);

/** The part of intervals a inside intervals b. */
export function intersectIntervals(a: [number, number][], b: [number, number][]): [number, number][] {
  const x = mergeIntervals(a);
  const y = mergeIntervals(b);
  const out: [number, number][] = [];
  for (let i = 0, j = 0; i < x.length && j < y.length; ) {
    const lo = Math.max(x[i]![0], y[j]![0]);
    const hi = Math.min(x[i]![1], y[j]![1]);
    if (lo < hi) out.push([lo, hi]);
    if (x[i]![1] < y[j]![1]) i++;
    else j++;
  }
  return out;
}

/** The part of intervals a outside intervals b. */
export function subtractIntervals(a: [number, number][], b: [number, number][]): [number, number][] {
  const y = mergeIntervals(b);
  const out: [number, number][] = [];
  for (const [a0, a1] of mergeIntervals(a)) {
    let lo = a0;
    for (const [b0, b1] of y) {
      if (b1 <= lo || b0 >= a1) continue;
      if (b0 > lo) out.push([lo, b0]);
      lo = Math.max(lo, b1);
      if (lo >= a1) break;
    }
    if (lo < a1) out.push([lo, a1]);
  }
  return out;
}

// ----------------------------------------------------------------------------
// The "Actual" comment
// ----------------------------------------------------------------------------

function findMarkerComment(issue: Any, kind: string): Any | null {
  for (const c of issue.comments.nodes) if (parseMarker(c.body, kind) !== null) return c;
  return null;
}

const alt = (xs: string[]) => xs.map(locale.escapeRe).join("|");
// "+ manually: N h" in any dictionary language: a human writes the line, the language may have changed
const MANUAL_WORDS = locale.every((n) => n.est.manual).map((m) => m.replace(/^\+\s*/, "").replace(/:$/, ""));
const MANUAL_RE = new RegExp(String.raw`^\+\s*(?:${alt(MANUAL_WORDS)}):\s*([\d.,]+)\s*(?:${alt(locale.every((n) => n.est.hours))})`, "iu");

/** The line "+ manually: N h" (`est.manual` in any dictionary language) a human added: its hours and the line. */
export function extractKeptLines(body: string | null | undefined): [number, string[]] {
  let manual = 0.0;
  const lines: string[] = [];
  for (const line of (body || "").split(/\r?\n/)) {
    const s = line.trim();
    const m = MANUAL_RE.exec(s);
    if (m) {
      manual = parseFloat(m[1]!.replace(",", "."));
      lines.push(s);
    }
  }
  return [manual, lines];
}

/** The agent whose sessions give the actual: local Claude Code sessions only (#836, #837). */
const AGENT = "Claude Code";

/**
 * The "Actual" comment in the project language (`language`, by default — of the current directory); the marker is the
 * same in all languages.
 */
export function factCommentBody(res: Fact, keptLines: string[], manual: number, language = locale.projectLanguage()): string {
  const n = locale.names(language);
  const count = (forms: Plural, x: number) => locale.count(language, forms, x);
  const h = res.h;
  let text: string;
  if (h === null) {
    text = n.est.fact.unavailable;
  } else {
    const na = res.agents ?? 0;
    const subagents = na ? ` ${count(n.est.fact.subagents, na)},` : "";
    const body = { h: fmtH(h), agents: AGENT, sessions: count(n.est.fact.sessions, res.sessions), prompts: count(n.est.fact.prompts, res.prompts), subagents, wall: fmtH(res.wall, 1), cov: res.cov };
    text = `${n.comments.actual} ${locale.fill(n.est.fact.body, body)}`;
  }
  text += res.prs.length ? locale.fill(n.est.fact.prs, { list: res.prs.map((p) => `#${p}`).join(", ") }) : n.est.fact.noPr;
  text += locale.fill(n.est.fact.diff, { commits: count(n.est.fact.commits, res.commits), diff: diffTxt(res, language) });
  if (res.shared?.length) text += " " + sharedTxt(res, language) + ".";
  for (const x of res.taken ?? []) text += locale.fill(n.est.fact.taken, { h: fmtH(x.h), issue: x.issue });
  for (const x of res.overlap ?? []) text += locale.fill(n.est.fact.overlap, { h: fmtH(x.h), issue: x.issue });
  if (res.tok) text += "\n" + tokensTxt(res, language);
  if (res.steps) text += "\n" + stepsTxt(res, language);
  if (res.steps && res.kinds) text += "\n" + overheadTxt(res, language);
  if (res.waits) text += "\n" + waitsTxt(res.waits, language);
  const marker: Record<string, unknown> = { v: 1, h, manual, wall: res.wall, cov: res.cov, sessions: res.sessions, prompts: res.prompts, agents: res.agents ?? 0, prs: res.prs, commits: res.commits, diff: res.diff };
  if (res.waits) marker.waits = res.waits; // minutes, by kind of wait
  if (res.tok) {
    marker.tok = res.tok;
    marker.usd = res.usd ?? null;
    if (res.models) marker.models = res.models;
  }
  if (res.steps) Object.assign(marker, { steps: res.steps, steps_agents: res.steps_agents ?? 0, tail: res.tail ?? 0, preamble: res.preamble ?? null, ctx_end: res.ctx_end ?? null });
  if (res.steps && res.kinds) Object.assign(marker, { kinds: res.kinds, rewrites: res.rewrites ?? 0, rewrite_usd: res.rewrite_usd ?? 0 });
  if (res.type) marker.type = res.type; // type from the branch by the <type>/N-slug convention
  if (res.shared?.length) {
    const sh: Record<string, number[]> = {};
    for (const s of res.shared) sh[s.unit] = s.with;
    marker.shared = sh;
  }
  if (res.iv && Object.keys(res.iv).length) marker.iv = res.iv; // by them the next computation sees what's already counted
  return [text, ...keptLines, `<!-- fact ${pyDumps(marker)} -->`].join("\n");
}

const diffTxt = (res: Fact, language = locale.projectLanguage()) => (res.diff_na ? locale.names(language).est.fact.diffNa : locale.fill(locale.names(language).est.fact.diffLines, { n: res.diff }));

/** "shared commit a9e2854 with #7, #8 (share 1/3)". */
const sharedTxt = (res: Fact, language = locale.projectLanguage()) =>
  (res.shared ?? []).map((s) => locale.fill(locale.names(language).est.fact.shared, { unit: s.unit, list: s.with.map((n) => `#${n}`).join(", "), k: s.k })).join("; ");

function upsertComment(repo: Repo, issue: Any, kind: string, body: string): string {
  const existing = findMarkerComment(issue, kind);
  if (existing) {
    ghRest(`repos/${repo.full}/issues/comments/${existing.databaseId}`, "PATCH", { body });
    return "updated";
  }
  ghRest(`repos/${repo.full}/issues/${issue.number}/comments`, "POST", { body });
  return "created";
}

function setNumberField(repo: Repo, issue: Any, fieldName: string, value: number): void {
  let meta = repo.projectMeta();
  let itemId = issueItemId(issue, meta);
  if (!itemId) {
    const q = "mutation($p:ID!,$c:ID!){ addProjectV2ItemById(input:{projectId:$p,contentId:$c}){ item{ id } } }";
    itemId = ghGraphql(q, { p: meta.id, c: issue.id }).addProjectV2ItemById.item.id;
  }
  const q = `mutation($p:ID!,$i:ID!,$f:ID!,$v:Float!){
      updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{number:$v}}){ projectV2Item{ id } } }`;
  try {
    ghGraphql(q, { p: meta.id, i: itemId, f: meta.fields[fieldName]!.id, v: Number(value) });
  } catch (e) {
    if (!(e instanceof EstError) || !(errIs(e, "not found") || errIs(e, "could not resolve"))) throw e;
    // stale cache of the project/field id — reread and retry once
    meta = repo.projectMeta(true);
    ghGraphql(q, { p: meta.id, i: itemId, f: meta.fields[fieldName]!.id, v: Number(value) });
  }
}

/** Set an optional number field if the project has it (otherwise false). */
function setOptionalNumberField(repo: Repo, issue: Any, fieldName: string, value: number): boolean {
  let meta = repo.projectMeta();
  if (!meta.fields[fieldName] && !repo.optRefreshed) {
    repo.optRefreshed = true;
    meta = repo.projectMeta(true); // the metadata cache may be older than the field
  }
  if (!meta.fields[fieldName]) return false;
  setNumberField(repo, issue, fieldName, value);
  return true;
}

// ----------------------------------------------------------------------------
// The fact command
// ----------------------------------------------------------------------------

function factForIssue(repo: Repo, number: number, gap: number, quiet = false): [Any, Fact] {
  let issue: Any;
  try {
    issue = fetchIssue(repo, number);
  } catch (e) {
    if (!(e instanceof NotAnIssue)) throw e;
    const pr = repo.pr(number);
    if (!pr) throw new EstError(`#${number} not found in ${repo.full} either as an issue or as a PR`);
    return factForPr(repo, pr, gap);
  }
  const labels: string[] = issue.labels.nodes.map((l: Any) => l.name);
  const itype = String(issue.issueType?.name ?? "").toLowerCase();
  // epic — by the issue type "Epic" in any dictionary language; the epic label is the fallback for repos without types
  if (locale.every((n) => n.issueTypes.epic.toLowerCase()).includes(itype) || labels.includes("epic")) return factForEpic(repo, issue, gap, quiet);
  const [prObjs, closers, weakUsed] = resolveLinks(repo, issue);
  const res = computeFact(repo, number, prObjs, closers, gap);
  res.title = issue.title;
  res.weak_links = weakUsed;
  res.links = prObjs.map((p) => ({ pr: p.number, branch: p.headRefName, why: p.why! }));
  res.type = res.links.map((l) => branchType(l.branch)).find((t) => t) ?? null;
  res.closers = closers.map((c) => c.oid.slice(0, 7));
  res.epic = false;
  return [issue, res];
}

/** The number turned out to be a PR, not an issue: compute the actual for the PR itself (no write). */
function factForPr(repo: Repo, pr: PR, gap: number): [Any, Fact] {
  const res = computeFact(repo, pr.number, [{ ...pr, why: "the PR itself" }], [], gap);
  res.title = pr.title || "";
  res.weak_links = false;
  res.links = [{ pr: pr.number, branch: pr.headRefName, why: "this is a PR, not an issue" }];
  res.closers = [];
  res.epic = false;
  res.is_pr = true;
  const pseudo = { number: pr.number, title: pr.title, labels: { nodes: [] }, comments: { nodes: [] }, projectItems: { nodes: [] }, id: null, is_pr: true };
  return [pseudo, res];
}

/**
 * An epic's actual = the sum of its subtasks' actuals: from the "Actual, h" field (+ "manually" from the marker), and
 * for subtasks without the field — from transcripts.
 */
function factForEpic(repo: Repo, issue: Any, gap: number, quiet = false): [Any, Fact] {
  const number: number = issue.number;
  let subs: Any[] = [];
  for (let page = 1; ; page++) {
    const chunk: Any[] = ghRest(`repos/${repo.full}/issues/${number}/sub_issues?per_page=100&page=${page}`) ?? [];
    subs = subs.concat(chunk);
    if (chunk.length < 100) break;
  }
  const rows = new Map(repo.taskRows().map((r) => [r.number, r]));
  const board = repo.board();
  let total = 0.0;
  let tokTotal = 0;
  let usdTotal = 0.0;
  let usdAny = false;
  const parts: Any[] = [];
  let missing = 0;
  for (const s of subs) {
    const row = rows.get(s.number);
    let h: number | null;
    let cov: string;
    let src: string;
    let sTok: number | undefined;
    let sUsd: number | null | undefined;
    if (row && row.fact !== null) {
      const fm = row.fact_marker ?? {};
      const manual = Number(fm.manual || 0);
      h = row.fact + manual;
      cov = fm.cov || "field";
      src = (board ? `field «${fieldShown(board, FIELD_FACT)}»` : "the «Actual» comment") + (manual ? ` + manually ${fmtH(manual)} h` : "");
      sTok = fm.tok?.total;
      sUsd = fm.usd;
    } else {
      const [, r] = factForIssue(repo, s.number, gap, true);
      h = r.h;
      cov = r.cov;
      src = "transcripts";
      sTok = r.tok?.total;
      sUsd = r.usd;
    }
    tokTotal += Math.trunc(sTok || 0);
    if (sUsd !== null && sUsd !== undefined) {
      usdTotal += Number(sUsd);
      usdAny = true;
    }
    parts.push({ issue: s.number, state: s.state, h, cov, src, title: s.title });
    if (h === null) missing++;
    else total += h;
  }
  void quiet;
  const res: Fact = {
    issue: number,
    title: issue.title,
    epic: true,
    h: subs.length && missing < subs.length ? round2(total) : null,
    wall: null,
    cov: subs.length && missing === 0 ? "full" : missing < subs.length ? "partial" : "none",
    sessions: 0,
    prompts: 0,
    prs: [],
    commits: 0,
    diff: 0,
    shared: [],
    intervals: [],
    subtasks: parts,
    sub_missing: missing,
    details: [],
    links: [],
    closers: [],
    weak_links: false,
    tok: tokTotal ? { total: tokTotal } : null,
    usd: usdAny ? round2(usdTotal) : null,
  };
  return [issue, res];
}

function printFact(repo: Repo, res: Fact): void {
  console.log(`== ${repo.full}#${res.issue}: ${res.title}`);
  if (res.is_pr) console.log(`WARNING: #${res.issue} is a PR, not an issue; the actual is computed for the PR itself, it can't be written`);
  if (res.epic) {
    console.log(`epic: ${res.subtasks!.length} ${plural(res.subtasks!.length, "subtask", "subtasks")}, without an actual: ${res.sub_missing}`);
    for (const p of res.subtasks!) console.log(`  #${pad(String(p.issue), 5)} ${pad(p.state, 6)} ${pad(fmtH(p.h), 6, true)} h  ${pad(p.cov, 7)} ${pad(p.title.slice(0, 50), 50)} [${p.src}]`);
    console.log(`epic actual: ${fmtH(res.h)} h (sum of the subtasks with an actual), coverage ${res.cov}`);
    if (res.tok) console.log(tokensTxt(res, "en"));
    return;
  }
  for (const l of res.links ?? []) console.log(`PR #${l.pr} (branch ${l.branch}) — ${l.why}` + (res.weak_links ? "  [WEAK LINK]" : ""));
  if (res.closers?.length) console.log("closed by commit: " + res.closers.join(", "));
  if (!res.links?.length && !res.closers?.length) console.log("no PRs or commits found — linking only by the branch / first prompt");
  if (res.shared?.length) console.log("WARNING: hours split between the tasks — " + sharedTxt(res));
  if (res.h === null) {
    console.log("actual unavailable: no sessions found (coverage none)");
  } else {
    const raw = res.shared?.length && res.h_raw !== null && res.h_raw !== undefined ? ` (unsplit: ${fmtH(res.h_raw)} h)` : "";
    console.log(`actual: ${fmtH(res.h)} h active in ${AGENT}${raw}; ${res.sessions} sess., ${res.prompts} prompts, wall ${fmtH(res.wall, 1)} h, coverage ${res.cov}`);
  }
  if (res.tok) console.log(tokensTxt(res, "en"));
  if (res.steps && res.kinds) console.log(overheadTxt(res, "en"));
  if (res.waits) console.log(waitsTxt(res.waits, "en"));
  // a wait for the user's approval is told apart by the permission decision on a tool result (Claude Code); without it
  // the wait is inside the call's time (#518)
  if (res.h !== null && res.perm_unknown) console.log(`○ waits for permission approval aren't told apart in ${res.perm_unknown} ${plural(res.perm_unknown, "session", "sessions")} (no permission decision in the transcript: an older Claude Code) — they're in the call time`);
  console.log(`secondary: PR ${res.prs.map((p) => `#${p}`).join(", ") || "none"}; commits ${res.commits}; diff ${diffTxt(res, "en")} (without lock files / snapshots / minified)`);
  for (const d of res.details) {
    const brs = Object.entries(d.branches).slice(0, 4).map(([b, h]) => `${b} ${h} h`).join(", ");
    const rules = Object.entries(d.rules).map(([k, v]) => `${k}:${v}`).join(", ");
    console.log(`  session ${sidKey(d.sid)} ${fmtLocal(d.start)}: ${d.hours} h, ${d.prompts} prompts [${rules}] — ${brs}`);
  }
  for (const x of res.taken ?? []) console.log(`WARNING: Not counted again: ${fmtH(x.h)} h already in the actual of #${x.issue} (linked by the session name / first prompt); if that actual is wrong — est fact ${x.issue} --write, then this task again`);
  for (const x of res.overlap ?? []) console.log(`WARNING: Overlap with the actual of #${x.issue}: ${fmtH(x.h)} h of this task (pinning, branch, subagent, commit) — recompute #${x.issue}: est fact ${x.issue} --write`);
}

/** Writes the actual (the comment and, where there's a board, its fields); returns the comment body. */
function writeFact(repo: Repo, issue: Any, res: Fact): string {
  if (res.is_pr) throw new EstError(`#${res.issue} is a PR, not an issue: an actual for a PR isn't written`);
  const existing = findMarkerComment(issue, "fact");
  const [manual, kept] = extractKeptLines(existing ? existing.body : "");
  const body = factCommentBody(res, kept, manual);
  const what = upsertComment(repo, issue, "fact", body);
  if (res.iv && Object.keys(res.iv).length) repo.recorded().set(res.issue, res.iv); // the sweep's next task sees this actual
  let msg = `«Actual» comment ${what}`;
  if (!repo.board()) {
    // the fields are the board's: without one the comment's marker holds the actual (#847)
    console.log(`${msg}; no project fields: the repository has no board — the actual is the comment`);
    return body;
  }
  if (res.h !== null) {
    setNumberField(repo, issue, FIELD_FACT, res.h);
    msg += `, field «${fieldShown(repo.projectMeta(), FIELD_FACT)}» = ${fmtH(res.h)}`;
  }
  const extra: [string, number | null][] = [
    [FIELD_TOK, res.tok ? round2(res.tok.total / 1e6) : null],
    [FIELD_USD, res.usd ?? null],
  ];
  for (const [fname, val] of extra) {
    if (val === null) continue;
    if (setOptionalNumberField(repo, issue, fname, val)) msg += `, «${fieldShown(repo.projectMeta(), fname)}» = ${fmtH(val)}`;
    else msg += ` (the project has no field «${fieldShown(repo.projectMeta(), fname)}» — skipped)`;
  }
  console.log(msg);
  return body;
}

const EPIC_TYPES = new Set(locale.every((n) => n.issueTypes.epic).map((t) => t.toLowerCase()));
/** An epic's row: the issue type "Epic" in any dictionary language, the `epic` label — for repos without types. */
const isEpicRow = (r: Row): boolean => r.labels.includes("epic") || EPIC_TYPES.has((r.issueType ?? "").toLowerCase());

/**
 * Actuals to recompute for a model (#345): closed tasks of the window whose spend (the actual marker, `models`)
 * includes this model version, newest first, then their closed epics — an epic's cost is the sum of its subtasks'
 * actuals.
 */
export function factsWithModel(rows: Row[], model: string, since: number, now: number): Row[] {
  const version = modelVersion(model);
  const done = (r: Row) => r.state === "CLOSED" && r.stateReason !== "NOT_PLANNED";
  const tasks = rows
    .filter((r) => done(r) && !isEpicRow(r) && (r.closedAt || 0) >= now - since)
    .filter((r) => Object.keys(r.fact_marker?.models ?? {}).some((m) => modelVersion(m) === version))
    .sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));
  const parents = new Set(tasks.map((r) => r.parent));
  return [...tasks, ...rows.filter((r) => done(r) && isEpicRow(r) && parents.has(r.number))];
}

/**
 * Actuals to recompute after a change of the actual's definition (#518): closed tasks of the window with a recorded
 * actual, newest first, then their closed epics.
 */
export function factsRecorded(rows: Row[], since: number, now: number): Row[] {
  const done = (r: Row) => r.state === "CLOSED" && r.stateReason !== "NOT_PLANNED";
  const tasks = rows.filter((r) => done(r) && !isEpicRow(r) && r.fact !== null && (r.closedAt || 0) >= now - since).sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));
  const parents = new Set(tasks.map((r) => r.parent));
  return [...tasks, ...rows.filter((r) => done(r) && isEpicRow(r) && parents.has(r.number))];
}

/**
 * Why a recomputation doesn't overwrite a recorded actual: its transcripts are gone — fewer sessions than the marker
 * recorded (cleaned by cleanupPeriodDays) or none at all. null — overwrite.
 */
export function recomputeKept(fm: Any, res: Pick<Fact, "cov" | "sessions" | "epic">): string | null {
  if (res.epic) return null;
  if (res.cov === "none") return "no sessions found — transcripts gone";
  const was = typeof fm?.sessions === "number" ? fm.sessions : 0;
  return res.sessions < was ? `sessions ${was} → ${res.sessions} — transcripts gone` : null;
}

interface FactArgs {
  number?: number;
  repo?: string;
  write: boolean;
  gap: number;
  json: boolean;
  sweep: boolean;
  since: string;
  model?: string;
  recompute?: boolean;
}

/** Exit code: 1 — a sweep with --write failed to write something (#353). */
function cmdFact(args: FactArgs): number {
  const registry = loadRegistry();
  if (args.gap < 1) throw new EstError(`--gap must be ≥ 1 minute, got ${args.gap}`);
  if (args.sweep && args.number !== undefined) throw new EstError("an issue number and --sweep are incompatible: one or the other");
  if (args.model !== undefined && !args.sweep) throw new EstError("--model — only with --sweep: recomputing the recorded actuals with this model");
  if (args.recompute && !args.sweep) throw new EstError("--recompute — only with --sweep: recomputing the recorded actuals of the window");
  if (args.recompute && args.model !== undefined) throw new EstError("--recompute and --model are incompatible: --recompute takes every recorded actual of the window");
  const repo = new Repo(repoOf(args.repo), registry);
  // the board and its fields before the transcripts: a board without the fields — the error at once; no board — the
  // actual is the comment (#847)
  repo.board();
  if (args.sweep) {
    const since = parseSince(args.since);
    const now = nowTs();
    let rows: Row[];
    const recompute = args.model !== undefined || !!args.recompute;
    if (args.model !== undefined) {
      rows = factsWithModel(repo.taskRows(), args.model, since, now);
      console.log(`== ${repo.full}: closed with an actual on ${modelVersion(args.model)} in ${args.since} (with their epics): ${rows.length}`);
    } else if (args.recompute) {
      rows = factsRecorded(repo.taskRows(), since, now);
      console.log(`== ${repo.full}: closed with an actual in ${args.since} (with their epics): ${rows.length}`);
    } else {
      rows = repo.taskRows().filter((r) => r.state === "CLOSED" && r.fact === null && r.stateReason !== "NOT_PLANNED" && (r.closedAt || 0) >= now - since);
      rows.sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));
      console.log(`== ${repo.full}: closed without an actual in ${args.since}: ${rows.length}`);
    }
    const stats: Record<string, number> = { full: 0, partial: 0, none: 0 };
    let total = 0.0;
    let epicsTotal = 0.0;
    const counted: { h: number; iv?: Record<string, [number, number][]> }[] = [];
    // one task's error — a line, and on down the list; a network that didn't come back over the retries — stop: the
    // following ones would wait through the same retries (#353)
    const failed: number[] = [];
    let left: Row[] = [];
    const failure = (r: Row, what: string, e: unknown, i: number) => {
      if (!(e instanceof EstError)) throw e;
      console.log(`  #${r.number}: ${what}: ${e.message}`);
      failed.push(r.number);
      if (e instanceof NetworkError) left = rows.slice(i + 1);
      return e instanceof NetworkError;
    };
    for (const [i, r] of rows.entries()) {
      let issue: Any;
      let res: Fact;
      try {
        [issue, res] = factForIssue(repo, r.number, args.gap, true);
      } catch (e) {
        if (failure(r, "error", e, i)) break;
        continue;
      }
      stats[res.cov] = (stats[res.cov] ?? 0) + 1;
      const h = res.h;
      if (h !== null) {
        if (res.epic) epicsTotal += h; // an epic is the sum of its subtasks, not in the overall total (otherwise double counting)
        else {
          total += h;
          counted.push({ h, iv: res.iv });
        }
      }
      let extra = res.epic ? "epic" : res.prs.length ? "PR " + res.prs.map((p) => `#${p}`).join(", ") : "no PR";
      if (res.weak_links) extra += " (weak link)";
      if (res.shared?.length) extra += ` (share 1/${Math.max(...res.shared.map((s) => s.k))})`;
      // recomputing gives the whole actual by the current logic, not just one rate: the previous hours sit alongside so
      // the difference is visible before --write
      if (args.model !== undefined) extra += `; was ${fmtH(r.fact)} h, $${fmtH(r.fact_marker?.usd ?? null)} → $${fmtH(res.usd ?? null)}`;
      else if (args.recompute) extra += `; was ${fmtH(r.fact)} h`;
      // the recorded actual stays when its transcripts are gone: a recomputation would count only what's left of them
      const kept = args.recompute ? recomputeKept(r.fact_marker, res) : null;
      if (kept) extra += `; kept: ${kept}`;
      console.log(`  #${pad(String(r.number), 5)} ${pad(fmtH(h), 6, true)} h  ${pad(res.cov, 7)} ${pad(extra, 26)} ${r.title.slice(0, 50)}`);
      if (args.write && res.cov !== "none" && !kept) {
        let body: string;
        try {
          body = writeFact(repo, issue, res);
        } catch (e) {
          if (failure(r, "error writing", e, i)) break;
          continue;
        }
        // further in this same sweep an epic adds up its subtasks' actuals from the task rows — they need the
        // written one, not the previous one
        if (h !== null) r.fact = h;
        r.fact_marker = parseMarker(body, "fact");
      }
    }
    if (left.length) console.log(`the network didn't come back within the retries — sweep stopped, not processed: ${left.length}`);
    console.log(`total: full ${stats.full}, partial ${stats.partial}, none ${stats.none}; sum of hours ${fmtH(total)} (without epics; epics ${fmtH(epicsTotal)} h — the sum of their subtasks)`);
    const warning = sweepOverlapWarning(counted);
    if (warning) console.log(warning);
    if (!args.write) console.log("(nothing written without --write)");
    else if (failed.length || left.length) {
      const missed = [...failed, ...left.map((r) => r.number)];
      console.log(`not written: ${missed.length} — ${missed.map((n) => `#${n}`).join(", ")}`);
      const opts = `--repo ${repo.full}${args.gap === 30 ? "" : ` --gap ${args.gap}`}`;
      // a regular sweep takes only tasks without an actual — it would skip the written ones; a sweep by model or a
      // recomputation would recompute them too
      console.log(
        !recompute
          ? `retry: est fact --sweep --since ${args.since} ${opts} --write — it skips the written ones`
          : `retry task by task, in order (a sweep would recompute the written ones too): est fact <N> ${opts} --write — ${missed.map((n) => `#${n}`).join(", ")}`,
      );
      return 1;
    }
    return 0;
  }
  if (args.number === undefined) throw new EstError("pass an issue number or --sweep");
  const [issue, res] = factForIssue(repo, args.number, args.gap);
  if (args.json) {
    const out: Any = { ...res };
    delete out.details;
    delete out.intervals;
    delete out.iv;
    console.log(JSON.stringify(out, null, 1));
  } else {
    printFact(repo, res);
  }
  if (args.write) writeFact(repo, issue, res);
  else if (!args.json) console.log("(nothing written without --write)");
  return 0;
}

// ----------------------------------------------------------------------------
// The period command — summary of all the repo's sessions over a period, not tied to tasks
// ----------------------------------------------------------------------------

/** The model rate is separate from the flow: a model change changes a task's $ manyfold with the same flow. */
const TARIFF_NOTE = "the $ trend mixes the flow with the model rate: compare the flow by tokens and output";

/** $ shares by model, descending: [model, share 0…1]. */
function usdShares(byModel: Record<string, number>): [string, number][] {
  const total = Object.values(byModel).reduce((a, x) => a + x, 0);
  if (!(total > 0)) return [];
  return Object.entries(byModel)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([m, v]) => [m, v / total]);
}

/** «claude-opus-5 62 %, claude-fable-5-1 38 %, claude-haiku-4-5 <1 %». */
const sharesTxt = (shares: [string, number][]) => shares.map(([m, x]) => `${m} ${Math.round(x * 100) || "<1"} %`).join(", ");

/** A moment for --since/--until: 90d / 12w / 6m / 48h ago, a YYYY-MM-DD date (local midnight) or an ISO time. */
export function parseWhen(s: string, now = nowTs()): number {
  const v = s.trim();
  if (/^\d+[dhwm]$/.test(v)) return now - parseSince(v);
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (d) return new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3])).getTime() / 1000;
  const t = /^\d{4}-\d{2}-\d{2}T/.test(v) ? parseTs(v) : null;
  if (t === null) throw new EstError(`invalid date «${s}»: expected YYYY-MM-DD, an ISO time or 90d / 12w / 6m / 48h`);
  return t;
}

/** Periods [start, end): the i-th --until closes the i-th --since, without it — until now. */
export function parsePeriods(since: string[], until: string[], now = nowTs()): [number, number][] {
  if (!since.length) throw new EstError("pass --since: the start of the period (YYYY-MM-DD, an ISO time or 90d)");
  if (until.length > since.length) throw new EstError("--until without its --since: periods are pairs --since … [--until …] in order");
  return since.map((s, i) => {
    const a = parseWhen(s, now);
    const z = i < until.length ? parseWhen(until[i]!, now) : now;
    if (!(a < z)) throw new EstError(`period ${i + 1}: the end isn't after the start (${fmtLocal(a)} … ${fmtLocal(z)})`);
    return [a, z];
  });
}

/** Summary of the repository's sessions over the period [since, until): everything the agent did, not tied to tasks. */
export interface Period {
  since: number;
  until: number;
  sessions: number; // sessions with records in the period
  prs: number; // PRs merged in the period
  h: number; // agent hours, s: active time per session, summed
  machine: number; // machine hours, s: the union of active intervals of all sessions
  tok: number; // total tokens
  out: number; // of them output
  usd: number | null; // null — no model from the price list
  models: Record<string, number>; // $ by model from the price list
  unpriced: string[]; // models without a price
  steps: number; // turns — model responses, one per message.id
  kinds: Record<CallKind, { steps: number; usd: number }>; // the turns and their $ by kind (turnKinds): work and the
  // overhead around it — the flow, the harness, checks; a turn of several kinds — an equal share to each
  rewrites: number; // turns that rewrote the cache after a pause longer than its TTL (cacheRewrites)
  rewrite_usd: number; // their cache write, $
  agents: number; // subagents with records in the period
  prompts: number; // human prompts
}

/**
 * Period summary over all sessions — like the actual, but without linking: active time is the intervals between
 * neighboring records of one agent of a session that are the agent's time (agentTime: not a wait for input, no longer
 * than gap or inside a wait call), both ends in the period, a session's agents — by their union; tokens and cost — once
 * per model response (a resumed session copies the history); machine hours — the union of all sessions' time, their
 * ratio to agent hours is parallelism.
 */
export function periodSummary(sessions: Session[], prs: PR[], since: number, until: number, gapMin = 30): Period {
  const gap = gapMin * 60;
  const seen = new Set<string>();
  const all: [number, number][] = [];
  const byModel = new Map<string, number | null>();
  const kinds = Object.fromEntries(CALL_KINDS.map((k) => [k, { steps: 0, usd: 0 }])) as Period["kinds"];
  const res: Period = { since, until, sessions: 0, prs: 0, h: 0, machine: 0, tok: 0, out: 0, usd: null, models: {}, unpriced: [], steps: 0, kinds, rewrites: 0, rewrite_usd: 0, agents: 0, prompts: 0 };
  const inside = (t: number) => t >= since && t < until;
  for (const s of sessions) {
    const ev = s.ev;
    const prevOf = prevOfSameAgent(ev);
    const rewritten = cacheRewrites(s, prevOf); // by the previous turn, even one before the period
    const agents = new Set<number>();
    const own: [number, number][] = [];
    let touched = false;
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i]!;
      const t = e[0] as number;
      if (!inside(t)) continue;
      touched = true;
      if (e[2] === INPUT_HUMAN) res.prompts++;
      if (e[5] > 0) agents.add(e[5]);
      const j = prevOf[i]!;
      if (j >= 0 && ev[j]![0] >= since && agentTime(s, i, j, gap)) own.push([ev[j]![0], t]);
      const u = e.length > 4 && e[4] >= 0 ? s.usage?.[e[4]] : undefined;
      if (!u || seen.has(u[0])) continue;
      seen.add(u[0]);
      const model: string = s.models?.[u[1]] ?? "?";
      const vals: [number, number, number, number, number] = [u[2], u[3], u[4], u[5], u[6]];
      res.steps++;
      res.tok += vals.reduce((a, x) => a + x, 0);
      res.out += vals[1];
      const c = usageCost(model, vals, !!u[7]);
      const was = byModel.has(model) ? byModel.get(model)! : 0;
      byModel.set(model, c === null || was === null ? null : was + c);
      const ks = turnKinds(s.call_kinds?.[e[4]]);
      for (const k of ks) {
        res.kinds[k].steps += 1 / ks.length;
        res.kinds[k].usd += (c ?? 0) / ks.length;
      }
      const rw = rewritten.get(i);
      if (rw) {
        res.rewrites++;
        res.rewrite_usd += usageCost(model, [0, 0, rw[0], rw[1], 0], !!u[7]) ?? 0;
      }
    }
    if (touched) res.sessions++;
    res.agents += agents.size;
    // parallel agents of a session overlap: the session's time is their union
    const time = mergeIntervals(own);
    res.h += ivTotal(time);
    all.push(...time);
  }
  res.machine = mergeIntervals(all).reduce((a, [x, y]) => a + (y - x), 0);
  for (const [m, v] of byModel) {
    if (v === null) res.unpriced.push(m);
    else res.models[m] = v;
  }
  res.unpriced.sort();
  if (Object.keys(res.models).length) res.usd = Object.values(res.models).reduce((a, x) => a + x, 0);
  res.prs = prs.filter((p) => p.mergedAt !== null && inside(p.mergedAt)).length;
  return res;
}

/** Turn kinds in the period table. */
const KIND_LABEL: Record<CallKind, string> = { work: "work", flow: "flow", harness: "harness", checks: "check" };
const KINDS_NOTE =
  "Turn kinds: flow — the flow's scripts, gh, git, CI waits; harness — the app's tools, ToolSearch; check — lint, typecheck, tests; work — the rest; a turn of several kinds — an equal share to each. A cache rewrite — a turn after a pause longer than the TTL of its cache write (5 min or 1 h).";

/** Period table: totals, also per merged PR; for two periods the "after / before" ratio; then the $ share by model. */
export function periodTable(ps: Period[]): string[] {
  const when = (t: number) => {
    const s = fmtLocal(t);
    return s.endsWith(" 00:00") ? s.slice(0, 10) : s;
  };
  const heads = ps.map((p) => `${when(p.since)} … ${when(p.until)}`);
  const int = (v: number) => String(Math.round(v));
  const one = (v: number) => fmtH(v, 1);
  const hrs = (v: number) => fmtH(v, 2);
  const mln = (v: number) => fmtH(v / 1e6, 1);
  const thou = (v: number) => String(Math.round(v / 1e3));
  const usd = (v: number) => v.toFixed(2);
  const h = (p: Period) => p.h / 3600;
  const m = (p: Period) => p.machine / 3600;
  const perPr = (f: (p: Period) => number | null) => (p: Period) => {
    const v = f(p);
    return v === null || !p.prs ? null : v / p.prs;
  };
  type Line = [string, (p: Period) => number | null, (v: number) => string];
  // $ by kind and of the rewrites — while some model has a price, as the cost
  const kindSteps = (k: CallKind) => (p: Period) => p.kinds[k].steps;
  const kindUsd = (k: CallKind) => (p: Period) => (p.usd === null ? null : p.kinds[k].usd);
  const rewriteUsd = (p: Period) => (p.usd === null ? null : p.rewrite_usd);
  const lines: (Line | string)[] = [
    ["sessions", (p) => p.sessions, int],
    ["merged PRs", (p) => p.prs, int],
    ["agent hours (sum over sessions)", h, hrs],
    ["machine hours (union of sessions)", m, hrs],
    ["session parallelism", (p) => (p.machine ? p.h / p.machine : null), (v) => `×${one(v)}`],
    ["tokens, M", (p) => p.tok, mln],
    ["output, K", (p) => p.out, thou],
    ["cost, $", (p) => p.usd, usd],
    ["turns", (p) => p.steps, int],
    ...CALL_KINDS.map((k): Line => [`  ${KIND_LABEL[k]} turns`, kindSteps(k), int]),
    ...CALL_KINDS.map((k): Line => [`  ${KIND_LABEL[k]} turns, $`, kindUsd(k), usd]),
    ["cache rewrites after a pause > TTL", (p) => p.rewrites, int],
    ["  their cache write, $", rewriteUsd, usd],
    ["subagents", (p) => p.agents, int],
    ["human prompts", (p) => p.prompts, int],
    "per merged PR:",
    ["  agent hours", perPr(h), hrs],
    ["  machine hours", perPr(m), hrs],
    ["  tokens, M", perPr((p) => p.tok), mln],
    ["  output, K", perPr((p) => p.out), thou],
    ["  cost, $", perPr((p) => p.usd), usd],
    ["  turns", perPr((p) => p.steps), one],
    ...CALL_KINDS.map((k): Line => [`    ${KIND_LABEL[k]} turns`, perPr(kindSteps(k)), one]),
    ...CALL_KINDS.map((k): Line => [`    ${KIND_LABEL[k]} turns, $`, perPr(kindUsd(k)), usd]),
    ["  cache rewrites", perPr((p) => p.rewrites), one],
    ["    their cache write, $", perPr(rewriteUsd), usd],
    ["  subagents", perPr((p) => p.agents), one],
    ["  human prompts", perPr((p) => p.prompts), one],
    ["$ per 1M tokens", (p) => (p.usd !== null && p.tok ? p.usd / (p.tok / 1e6) : null), usd],
  ];
  const ratio = ps.length === 2;
  const ratioOf = (f: (p: Period) => number | null) => {
    const [a, b] = [f(ps[0]!), f(ps[1]!)];
    return a && b !== null ? `×${fmtH(b / a, 2)}` : "—";
  };
  const head = ["", ...heads, ...(ratio ? ["after / before"] : [])];
  const rows = lines.map((l) => (typeof l === "string" ? l : [l[0], ...ps.map((p) => {
    const v = l[1](p);
    return v === null ? "—" : l[2](v);
  }), ...(ratio ? [ratioOf(l[1])] : [])]));
  const widths = head.map((x, i) => Math.max(x.length, ...rows.map((r) => (typeof r === "string" ? 0 : r[i]!.length))));
  const fmt = (r: string[]) => r.map((x, i) => (i ? pad(x, widths[i]!, true) : pad(x, widths[0]!))).join("  ").trimEnd();
  const out = [fmt(head), ...rows.map((r) => (typeof r === "string" ? r : fmt(r)))];
  out.push("");
  ps.forEach((p, i) => {
    const shares = usdShares(p.models);
    const unpriced = p.unpriced.length ? `; no price (not in the price list): ${p.unpriced.join(", ")}` : "";
    out.push(`$ by model ${heads[i]}: ${shares.length ? sharesTxt(shares) : "—"}${unpriced}`);
  });
  out.push(`${TARIFF_NOTE}; $ per 1M tokens — the rate shift.`);
  out.push(KINDS_NOTE);
  return out;
}

interface PeriodArgs {
  repo?: string;
  periods: [number, number][];
  gap: number;
}

function cmdPeriod(args: PeriodArgs): void {
  const repo = new Repo(repoOf(args.repo), loadRegistry());
  const sessions = repo.periodSessions();
  const prs = [...repo.prs().values()];
  console.log(`== ${repo.full}: all of the repository's sessions over the period, without linking to tasks`);
  for (const line of periodTable(args.periods.map(([a, z]) => periodSummary(sessions, prs, a, z, args.gap)))) console.log(line);
}

// ----------------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------------

/**
 * Help — `--help` or `-h` anywhere in the arguments (tests/standards/scripts/cli-help): a command's synopsis (the first
 * paragraph), what it does and examples; `est --help` — the synopses of all. The dispatcher takes only the commands from
 * here: a command without help can't be called.
 */
const HELP: Record<string, string> = {
  fact: `est fact <N> [--repo o/r] [--write] [--gap 30] [--json]
est fact --sweep [--since 90d] [--repo o/r] [--write]
est fact --sweep --model <id> [--since 90d] [--repo o/r] [--write]
est fact --sweep --recompute [--since 90d] [--repo o/r] [--write]

The actual of a task from session transcripts: all of its time except waits for the user's input — a pause longer than
--gap minutes counts only inside a CI or checks wait — split by waits, tokens and cost; --write — the actual comment
and, where the repository has a board, its fields (github task close runs it). An epic — the sum of its subtasks.
--sweep — the actuals of closed tasks without one; with --model — recompute the recorded actuals with this model and
their epics; with --recompute — every recorded actual of the window and their epics (an actual whose transcripts are
gone stays).

Examples:
  est fact 42
  est fact --sweep --since 90d --write
  est fact --sweep --recompute --since 365d --write`,
  period: `est period --since DATE [--until DATE] [--since DATE [--until DATE]] [--repo o/r] [--gap 30]

All of the repo's sessions over the period: hours, tokens, cost, turns by kind (work, the flow's overhead, the harness,
checks) and cache rewrites after a pause; two periods — side by side, «after / before».

Examples:
  est period --since 2026-09-01
  est period --since 2026-08-01 --until 2026-09-01 --since 2026-09-01`,
};

/** `est --help`: what the script is and the synopsis of each command. */
const OVERVIEW = [
  "est — records the actual of tasks from local Claude Code transcripts and sums up a period's sessions.",
  "",
  ...Object.values(HELP).map((h) => h.split("\n\n")[0]!.replace(/^/gm, "  ")),
  "",
  "est <command> --help — the command's details and examples",
].join("\n");

/** The help the arguments ask for (`--help`, `-h`): of the command they start with, otherwise the overview; none — undefined. */
function helpOf(argv: string[]): string | undefined {
  if (!argv.some((a) => a === "--help" || a === "-h")) return undefined;
  const words = `${argv.join(" ")} `;
  const cmd = Object.keys(HELP).find((c) => words.startsWith(`${c} `));
  return cmd ? HELP[cmd] : OVERVIEW;
}

function intArg(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  if (!/^-?\d+$/.test(v)) throw new EstError(`${name}: expected an integer, got «${v}»`);
  return parseInt(v, 10);
}

/** The flow doesn't run in a Claude Code cloud session (#837): one line, before help and arguments. */
const CLOUD_REFUSAL = "the flow doesn't support Claude Code cloud sessions (CLAUDE_CODE_REMOTE=true) — run it in a local session";

export function main(argv: string[]): number {
  if (process.env.CLAUDE_CODE_REMOTE === "true") return console.error(CLOUD_REFUSAL), 2;
  const cmd = argv[0];
  const rest = argv.slice(1);
  const help = helpOf(argv);
  if (help) return console.log(help), 0;
  try {
    if (!cmd) return console.log(OVERVIEW), 2;
    if (!Object.hasOwn(HELP, cmd)) throw new EstError(`unknown command «${cmd}»; expected ${Object.keys(HELP).join(", ")} (est --help)`);
    if (cmd === "fact") {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { repo: { type: "string" }, write: { type: "boolean", default: false }, gap: { type: "string", default: "30" }, json: { type: "boolean", default: false }, sweep: { type: "boolean", default: false }, since: { type: "string", default: "90d" }, model: { type: "string" }, recompute: { type: "boolean", default: false } },
      });
      if (positionals.length > 1) throw new EstError(`extra arguments: ${positionals.slice(1).join(" ")}`);
      return cmdFact({ number: intArg(positionals[0], "issue number"), repo: values.repo, write: values.write, gap: intArg(values.gap, "--gap")!, json: values.json, sweep: values.sweep, since: values.since, model: values.model, recompute: values.recompute });
    }
    if (cmd === "period") {
      const { values } = parseArgs({ args: rest, options: { repo: { type: "string" }, since: { type: "string", multiple: true }, until: { type: "string", multiple: true }, gap: { type: "string", default: "30" } } });
      const gap = intArg(values.gap, "--gap")!;
      if (gap < 1) throw new EstError(`--gap must be ≥ 1 minute, got ${gap}`);
      cmdPeriod({ repo: values.repo, periods: parsePeriods(values.since ?? [], values.until ?? []), gap });
      return 0;
    }
    throw new EstError(`command «${cmd}» has help but no handler`);
  } catch (e) {
    if (e instanceof EstError) die(e.message);
    if (e && typeof e === "object" && (e as Any).code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") die((e as Error).message, 2);
    throw e;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
