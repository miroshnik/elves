#!/usr/bin/env bun
/**
 * github — the repository's GitHub project and tasks by the canon (AGENTS.md, "Task tracking"; the full rules are in
 * reference.md next to SKILL.md: types, decision labels, epics, the project, milestones, epic refresh).
 *
 * Subcommands:
 *   github project check — a check against the canon, item by item ✅/❌
 *   github project fix   — bring it to the canon: API, UI steps with links, deleting and renaming — with --confirm
 *   github task new      — a task in one command: type or label, project and Backlog, Priority, epic, blocked by,
 *                          milestone, decision labels (the decision's name, the kind by color), the questions label
 *                          (an open question in the description)
 *   github task show     — the task in one output: the description, Status, the epic, blockers, PRs and
 *                          their checks, open questions, the comments of the task and its epic
 *   github task answer   — ✅ and the answer at a question of the questions section; none open — the label goes
 *   github task edit     — the description edited in one call: a replacement, an item into a section, a checked item
 *   github task status   — Status in the project (and the epic's "In progress" once its first subtask is taken);
 *                          "In progress" pins the task to the session — another task in the same session is refused
 *                          with the question whether to queue it
 *   github task drop     — close without doing it and remove from the project
 *   github task actualize — after the merge, in parallel with the deploy: the epic refresh's mechanics and the
 *                          subagent's prompt (or "not needed"); --assignment — the subagent's whole assignment
 *   github task close    — after the merge and the deploy: the actual, "Done", the epic and the milestone, the task's
 *                          stacks (task-env) and the task's merged branches removed
 *   github task queue    — the dispatcher's ready tasks with the prompts of their executors (subagents);
 *                          --assignment — an executor's whole assignment (--session — the prompt of an app executor
 *                          session, printed by the dispatcher)
 *   github pr labels    — decision labels for the task from "Closes #N" by the PR diff, for its epic — the union
 *   github pr premerge   — before the merge: the default branch moved after the PR's CI — typecheck and test:spec on
 *                          the merge with it
 *   github hook guard    — Claude Code's PreToolUse hook: a bypass of a flow command (bypasses.ts) denied with the
 *                          flow's command instead
 *
 * Runs on Bun (`bun github.ts …`), only `node:` APIs + the `gh` CLI. Check and fix are one function, `analyze`: each
 * discrepancy carries its own fix step, so `check` and `fix` don't diverge.
 * Decision labels are checked against the spec tree of the default branch; the architecture model is read by a
 * separate process of the same runtime (`modelModules`). Merging into the default branch — the `elves` ruleset:
 * required checks, green on the last merged PRs; the merge method — rebase only (a repository setting, REST).
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import type { ParseArgsConfig } from "node:util";

import { linkedProjects, LINKED_PROJECTS, mainProject, PROJECT_REF as REF, projectRef as ref } from "./board.ts";
import type { ProjectRef } from "./board.ts";
import { BYPASSES } from "./bypasses.ts";
import type { Bypass } from "./bypasses.ts";
import { readyCommand, SandboxRefusal, sandboxLine, sandboxRefusal, shellArg } from "./command.ts";
import locale from "./locale.ts";
import type { Names } from "./locale.ts";
import { entryOf, executorAlive, executorOf, holdingBlockers, queueStep, redFix, releaseIsRed, releaseRun, worktreeRemovable } from "./queue.ts";
import type { BatchFacts, BlockerFacts, Entry, Fix, Step as QueueNext, ReleaseState, ReleaseStep, TaskFacts } from "./queue.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// ----------------------------------------------------------------------------
// Canon
// ----------------------------------------------------------------------------

/**
 * Canon names in the project language (`locales/<language>.json`, the `locale.ts` module): views, Status options,
 * fields, issue types, label markers, sections, comments. The language is the one of the project of the `io.cwd`
 * directory, `main` sets it; parsing — by the names of any dictionary language (`locale.every`).
 */
let N: Names = locale.names(locale.projectLanguage());

/**
 * Views as in the template: columns by `columnKey` in the template's order, the table grouped by Status. The roadmap's
 * columns aren't compared: the API gives it the default ones, it has no configured columns.
 */
interface CanonView {
  name: string;
  layout: string;
  columns?: string[];
  groupBy?: string;
}
const canonViews = (): CanonView[] => [
  { name: N.views.board, layout: "BOARD_LAYOUT", columns: ["TITLE", STATUS, "LABELS", "SUB_ISSUES_PROGRESS"] },
  { name: N.views.table, layout: "TABLE_LAYOUT", columns: ["TITLE", STATUS, "LABELS", "ASSIGNEES", "SUB_ISSUES_PROGRESS"], groupBy: STATUS },
  { name: N.views.roadmap, layout: "ROADMAP_LAYOUT" },
];
/** A built-in column's name when the project has no such field yet (a column key is its type). */
const BUILTIN_COLUMNS: Record<string, string> = { TITLE: "Title", ASSIGNEES: "Assignees", LABELS: "Labels", SUB_ISSUES_PROGRESS: "Sub-issues progress" };
export const STATUS = "Status";
const statusOptions = () => [N.status.backlog, N.status.inProgress, N.status.done];
/** The template's colors of the Status options, in order — GitHub's colors of a new project's Todo / In Progress / Done. */
const STATUS_COLORS = ["GREEN", "YELLOW", "PURPLE"];
const numberFields = () => [N.fields.actual, N.fields.tokens, N.fields.cost];
/**
 * The old estimate field (#835: tasks are no longer estimated) in any dictionary language: a project keeping it isn't a
 * discrepancy — an `○` line; `project fix --confirm` deletes it, and its table column goes with it.
 */
const isEstimateField = (name: string) => locale.every((n) => n.fields.estimate).includes(name);
const issueTypes = () => [N.issueTypes.task, N.issueTypes.bug, N.issueTypes.epic];
export const PRIORITY = "Priority";
/** Priority options from the most urgent; a new task gets Medium, an epic — no lower than its most urgent subtask. */
export const PRIORITIES = ["Urgent", "High", "Medium", "Low"] as const;
export const DEFAULT_PRIORITY = "Medium";
/** A personal account has no issue types — an epic is marked with a label, the only exception. */
export const EPIC_LABEL = "epic";
const epicLabel = () => ({ name: EPIC_LABEL, color: "8250DF", description: N.labels.epicDescription });
/** Open questions in the task description: `task new` sets it (creates it if missing), the last answer removes it. */
const questionsLabel = () => ({ name: N.labels.questions, color: "FBCA04", description: N.labels.questionsDescription });
/**
 * Decision labels: the name is the decision's name (a spec tree folder or a model module), the kind is the color.
 * Decisions of different kinds with one name are one label: the color of the senior kind (the order here), all of them
 * in the description. For architecture a decision is the rule `tests/architecture/<name>` or a module of the model
 * `tests/architecture/model.ts`.
 */
export const DECISIONS = {
  capability: { dir: "capabilities", color: "0E8A16" },
  standard: { dir: "standards", color: "1D76DB" },
  // not FBCA04: the "questions" label has it, and a decision label's kind shows only by color
  architecture: { dir: "architecture", color: "D93F0B" },
} as const;
export type DecisionKind = keyof typeof DECISIONS;
const DECISION_KINDS = Object.keys(DECISIONS) as DecisionKind[];
const MODEL_PATH = "tests/architecture/model.ts";
/**
 * GitHub puts at most this many labels on an issue: `addLabelsToLabelable` past it fails as a whole (#569). An issue's
 * labels are read all at once (`IssueRef`) — otherwise `pr labels` couldn't count the room.
 */
const ISSUE_LABEL_LIMIT = 100;
export const WORKFLOW_ADDED = "Item added to project";
export const WORKFLOW_CLOSED = "Item closed";
export const WORKFLOW_AUTO_ADD = "Auto-add to project";
const WORKFLOW_MERGED = "Pull request merged";
const WORKFLOW_AUTO_CLOSE = "Auto-close issue";
const WORKFLOW_SUB_ISSUES = "Auto-add sub-issues to project";
const WORKFLOW_ARCHIVE = "Auto-archive items";
/** The template's workflows, all on. */
const WORKFLOWS = [WORKFLOW_ADDED, WORKFLOW_CLOSED, WORKFLOW_MERGED, WORKFLOW_AUTO_CLOSE, WORKFLOW_AUTO_ADD, WORKFLOW_SUB_ISSUES, WORKFLOW_ARCHIVE];
/** The template's auto-archive filter: a task closed and untouched for two weeks leaves the board and the table. */
const ARCHIVE_FILTER = "is:issue is:closed updated:<@today-2w";
/** The template: a new project is its copy (views, fields, configured workflows except auto-add). */
export const DEFAULT_TEMPLATE = "miroshnik/6";
/**
 * The default-branch ruleset that fix sets: GitHub doesn't let a branch with a red required check be merged. It doesn't
 * require the branch to be up to date (strict is off): the next PR's CI shows that two green PRs are incompatible.
 */
export const RULESET = "elves";
/** A required check is green on each of this many last merged PRs with checks. */
export const STABLE_PRS = 10;
/** The repository admin role (`repositoryRoleDatabaseId`) bypasses the ruleset: direct push, `gh pr merge --admin`. */
const ADMIN_ROLE = 5;

/**
 * Status options of a new project and names in the dictionary's other languages → the name in the project language:
 * renaming with the same id keeps the tasks' values and the target of the "Item closed" workflow (replacing all the
 * options gives new ids).
 */
function statusAliases(): Record<string, string> {
  const out: Record<string, string> = { todo: N.status.backlog, "to do": N.status.backlog, doing: N.status.inProgress };
  for (const n of locale.everyNames()) {
    out[n.status.backlog.toLowerCase()] = N.status.backlog;
    out[n.status.inProgress.toLowerCase()] = N.status.inProgress;
    out[n.status.done.toLowerCase()] = N.status.done;
  }
  return out;
}
/** Issue types in any dictionary language (and `task`, `bug`, `epic`) → the type in the project language. */
function typeAliases(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of locale.everyNames()) {
    out[n.issueTypes.task.toLowerCase()] = N.issueTypes.task;
    out[n.issueTypes.bug.toLowerCase()] = N.issueTypes.bug;
    out[n.issueTypes.epic.toLowerCase()] = N.issueTypes.epic;
  }
  return out;
}
/** Project fields in any dictionary language → the field in the project language. */
function fieldAliases(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of locale.everyNames()) {
    out[n.fields.actual] = N.fields.actual;
    out[n.fields.tokens] = N.fields.tokens;
    out[n.fields.cost] = N.fields.cost;
  }
  return out;
}
// Built-in project fields; custom ones are everything else (TEXT, NUMBER, DATE, SINGLE_SELECT, ITERATION…).
const BUILTIN_FIELDS = new Set(["TITLE", "ASSIGNEES", "LABELS", "LINKED_PULL_REQUESTS", "MILESTONE", "REPOSITORY", "REVIEWERS", "PARENT_ISSUE", "SUB_ISSUES_PROGRESS", "CREATED", "UPDATED", "CLOSED", "TRACKS", "TRACKED_BY", "ISSUE_TYPE"]);
const NOT_DONE_REASONS = new Set(["NOT_PLANNED", "DUPLICATE"]);

// ----------------------------------------------------------------------------
// Model
// ----------------------------------------------------------------------------

export interface Io {
  /** `gh` with arguments and stdin → stdout; an error is an exception. An external edge: replaced in tests. */
  gh: (args: string[], stdin?: string) => string;
  out: (line: string) => void;
  err: (line: string) => void;
  env: Record<string, string | undefined>;
  /** A pause before re-reading (GitHub doesn't show additions right away); in tests — no waiting. */
  sleep?: (ms: number) => void;
  /**
   * A subprocess (`est`, `git` of `task close`) — an external edge: replaced in tests; `env` — variables on top of the
   * process's.
   */
  run?: (cmd: string, args: string[], cwd?: string, env?: Record<string, string>) => RunResult;
  /**
   * The project checkout: its language (`.agents/elves.json`) is the language of names, `task close` runs its git
   * steps in it; the current directory by default.
   */
  cwd?: string;
  /** The process's stdin whole — the hook's input of `hook guard`; in tests — the text. */
  stdin?: () => string;
}

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function realRun(cmd: string, args: string[], cwd?: string, env?: Record<string, string>): RunResult {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...(env ? { env: { ...process.env, ...env } } : {}) });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? "", stderr: r.error ? String(r.error.message) : (r.stderr ?? "") };
}

/** git in a directory: `io.run` (tests replace it), otherwise the real process — the file's one wrapper. */
function git(io: Io, cwd: string | undefined, ...args: string[]): RunResult {
  return (io.run ?? realRun)("git", args, cwd);
}

/** Why a process failed: the last line of its stderr, otherwise its exit code. */
function why(r: RunResult): string {
  return r.stderr.trim().split("\n").filter(Boolean).pop() ?? `code ${r.status}`;
}

const pause = (ms: number) => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

interface View {
  id: string;
  number: number;
  name: string;
  layout: string;
  filter: string | null;
  sortBy: string[];
  columnsBy: string[];
  groupBy: string[];
  /** The visible fields (`fields` of the view). */
  columns: { id: string; name: string; dataType: string }[];
}
interface Option {
  id: string;
  name: string;
  color: string;
  description: string;
}
interface Field {
  id: string;
  name: string;
  dataType: string;
  isIssueField: boolean;
  options: Option[] | null;
}
interface Workflow {
  id: string;
  number: number;
  /** The workflow address in the UI uses it, not number: `<project>/workflows/<fullDatabaseId>`. */
  fullDatabaseId: string | number;
  name: string;
  enabled: boolean;
}
interface Item {
  id: string;
  issue: { id: string; number: number; state: string; stateReason: string | null } | null;
  status: string | null;
}
interface Project extends ProjectRef {
  views: View[];
  fields: Field[];
  workflows: Workflow[];
  items: Item[];
}
interface Owner {
  org: boolean;
  id: string;
  login: string;
  issueTypes: { id: string; name: string; isEnabled: boolean }[];
  issueFields: { id: string; name: string; options: { id: string; name: string }[] }[];
}
interface Label {
  id: string;
  name: string;
  color: string;
  description: string | null;
  /** Open tasks with the label: how many in total and the numbers of the first OPEN_SHOWN. */
  open: { total: number; numbers: number[] };
}
/** Default-branch decisions by kind; the model didn't load — the reason, and then `architecture` has no modules. */
export interface Decisions {
  names: Record<DecisionKind, string[]>;
  /**
   * The sections of each topic folder by kind: topic → its section names (`<section>.md`, `<section>.test.ts`,
   * `<section>.e2e.ts`, `<section>.<part>.test.ts` at the topic root, the topic's own name excluded). A section has no
   * label of its own: its changes label the topic.
   */
  sections: Record<DecisionKind, Record<string, string[]>>;
  modelError: string | null;
}
/**
 * A PR head's check state — the buckets of `gh pr checks`: green, skipped or neutral, still running, cancelled, red
 * (`checkStates`).
 */
type CheckBucket = "pass" | "skipping" | "pending" | "cancel" | "fail";
interface Head {
  number: number;
  checks: Record<string, CheckBucket>;
}
interface Ruleset {
  id: string;
  name: string;
  enforcement: string;
  include: string[];
  strict: boolean;
  contexts: string[];
  bypassAdmin: boolean;
}
/** Merging into the default branch: its active rules with required checks and the checks of PR heads into it. */
export interface Merge {
  branch: string;
  /** Branch rules are unavailable on the plan (a private repository on Free) — the reason from GitHub. */
  unavailable: string | null;
  /** Active rules with required checks: a ruleset of any level and classic branch protection. */
  rules: { source: string; contexts: string[] }[];
  /** Our own ruleset — this repository's `RULESET`, in any state. */
  own: Ruleset | null;
  /** The last `STABLE_PRS` merged PRs with checks, oldest to newest. */
  merged: Head[];
  /** Open PRs whose checks have all finished: a check they don't have won't come. */
  open: Head[];
  /** Allowed PR merge methods (a repository setting): merge commit, squash, rebase. */
  methods: { merge: boolean; squash: boolean; rebase: boolean };
}
export interface State {
  repo: { id: string; name: string; nameWithOwner: string; owner: Owner; linked: ProjectRef[] };
  project: Project | null;
  /**
   * `unlisted` — the id of the project's item that the project's item list doesn't return, though the issue's own
   * `projectItems` has it (`markUnlisted`).
   */
  openIssues: { id: string; number: number; unlisted?: string }[];
  labels: Label[];
  decisions: Decisions;
  /** An empty repository (no default branch) — null. */
  merge: Merge | null;
}

interface Mutation {
  op: string;
  input: Record<string, unknown>;
}
/**
 * A fix step: `api` — fix does it; `confirm` — only with --confirm (deleting, renaming, the organization);
 * `ui` — by hand via the link. `sticky` — a UI step stays in the list even when fix has already removed the symptom.
 */
export interface Step {
  kind: "api" | "confirm" | "ui";
  text: string;
  mutations?: Mutation[];
  url?: string;
  sticky?: boolean;
}
export interface Check {
  key: string;
  title: string;
  problems: { text: string; steps: Step[] }[];
  /** Not a discrepancy but the state of things (a new decision's label): an `○` line, the item stays ✅. */
  notes: string[];
  /**
   * A note's `confirm` steps (the old estimate field, #835): `fix --confirm` does them, `fix` without it names them —
   * the item stays ✅ and the exit code doesn't depend on them.
   */
  cleanup: Step[];
  /** The item doesn't apply (plan, no checks): a `➖` line with the reason instead of ✅/❌. */
  skip?: string;
}

export class GhError extends Error {}

// ----------------------------------------------------------------------------
// GraphQL
// ----------------------------------------------------------------------------

/** Numbers of the label's open tasks in the "new decision" line; the rest as a count. */
const OPEN_SHOWN = 10;
/**
 * How many recent PRs task close looks at when the PR isn't linked to the task: it's called right after the merge, so
 * the PR is among them.
 */
const RECENT_PRS = 50;
/**
 * A PR head's checks for `checkStates` — the one selection of every query that reads them (`PR_SHOW`, `MergeRules`):
 * without the run's id and its app reruns can't be told apart (`tests/standards/scripts/check-run-state`).
 */
export const HEAD_CHECKS = `commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { __typename ... on CheckRun { name status conclusion databaseId checkSuite { app { databaseId } } } ... on StatusContext { context state } } } } } } }`;
/** A PR for task show: its state and the checks of its head. */
const PR_SHOW = `number state merged isDraft headRefName headRefOid baseRefName
        ${HEAD_CHECKS}`;
/** How many of an issue's latest comments task show prints (#651): GraphQL gives at most 100 per page. */
const COMMENTS_SHOWN = 100;
/** An issue's comments for task show: the author, the time, the text; how many there are. */
const COMMENTS_SHOW = `comments(last: ${COMMENTS_SHOWN}) { totalCount nodes { author { login } createdAt body } }`;
export const Q = {
  /** The repository's current name: GitHub answers a renamed repository's former name with it (`canonicalRepo`). */
  RepoName: `query RepoName($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { nameWithOwner }
}`,
  RepoState: `query RepoState($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    id name nameWithOwner
    owner {
      __typename id login
      ... on Organization {
        issueTypes(first: 50) { nodes { id name isEnabled } }
        issueFields(first: 50) { nodes { __typename ... on IssueFieldSingleSelect { id name options { id name } } } }
      }
    }
    ${LINKED_PROJECTS}
  }
}`,
  RepoIssues: `query RepoIssues($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id number } }
  }
}`,
  /** The project items of issues by their ids — as the issue sees them (`markUnlisted`), at most `NODES_PAGE` ids. */
  IssueItems: `query IssueItems($ids: [ID!]!) {
  nodes(ids: $ids) { ... on Issue { id projectItems(first: 20) { nodes { id isArchived project { id } } } } }
}`,
  OwnerProjects: `query OwnerProjects($login: String!, $query: String!) {
  repositoryOwner(login: $login) { ... on ProjectV2Owner { projectsV2(first: 20, query: $query) { nodes { ${REF} } } } }
}`,
  TemplateProject: `query TemplateProject($login: String!, $number: Int!) {
  repositoryOwner(login: $login) { ... on ProjectV2Owner { projectV2(number: $number) { ${REF} } } }
}`,
  ProjectState: `query ProjectState($id: ID!) {
  node(id: $id) {
    ... on ProjectV2 {
      ${REF}
      views(first: 50) {
        nodes {
          id number name layout filter
          sortByFields(first: 5) { nodes { direction field { ... on ProjectV2FieldCommon { name } } } }
          verticalGroupByFields(first: 5) { nodes { ... on ProjectV2FieldCommon { name } } }
          groupByFields(first: 5) { nodes { ... on ProjectV2FieldCommon { name } } }
          fields(first: 50) { nodes { ... on ProjectV2FieldCommon { id name dataType } } }
        }
      }
      fields(first: 100) {
        nodes {
          __typename
          ... on ProjectV2FieldCommon { id name dataType }
          ... on ProjectV2Field { isIssueField }
          ... on ProjectV2SingleSelectField { isIssueField options { id name color description } }
        }
      }
      workflows(first: 50) { nodes { id number fullDatabaseId name enabled } }
    }
  }
}`,
  IssueRef: `query IssueRef($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      id number title state stateReason url
      issueType { name }
      labels(first: ${ISSUE_LABEL_LIMIT}) { nodes { name } }
      parent { id number }
      subIssues(first: 100) { nodes { number state title } }
      blockedBy(first: 50) { nodes { number state repository { nameWithOwner } } }
      milestone { id number title issues(states: OPEN) { totalCount } }
      closedByPullRequestsReferences(first: 20, includeClosedPrs: true) { nodes { number state merged headRefName baseRefName } }
      projectItems(first: 20) { nodes { id project { id } status: fieldValueByName(name: "${STATUS}") { ... on ProjectV2ItemFieldSingleSelectValue { name } } } }
      issueFieldValues(first: 20) { nodes { __typename ... on IssueFieldSingleSelectValue { name field { ... on IssueFieldSingleSelect { name } } } } }
    }
  }
}`,
  // The epic refresh (task actualize): the text, links and milestone of the epic and of each of its open tasks; task
  // close — the refresh's report among the epic's comments
  TaskText: `query TaskText($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      id number title state body
      labels(first: 20) { nodes { id name } }
      milestone { number title state issues(states: OPEN) { totalCount } }
      blockedBy(first: 50) { nodes { id number state repository { nameWithOwner } } }
      comments(last: 50) { nodes { body url } }
      subIssues(first: 100) { nodes { number title state milestone { number title state issues(states: OPEN) { totalCount } } } }
    }
  }
}`,
  TaskContext: `query TaskContext($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    label(name: "${EPIC_LABEL}") { id }
    milestones(first: 100, states: OPEN) { nodes { id title } }
  }
}`,
  // HEAD is the default branch: labels are checked against what's already merged
  SpecDecisions: `query SpecDecisions($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    capabilities: object(expression: "HEAD:tests/capabilities") { ... on Tree { entries { name type object { ... on Tree { entries { name type } } } } } }
    standards: object(expression: "HEAD:tests/standards") { ... on Tree { entries { name type object { ... on Tree { entries { name type } } } } } }
    architecture: object(expression: "HEAD:tests/architecture") { ... on Tree { entries { name type object { ... on Tree { entries { name type } } } } } }
    model: object(expression: "HEAD:${MODEL_PATH}") { ... on Blob { text } }
  }
}`,
  RepoLabels: `query RepoLabels($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    labels(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id name color description issues(states: OPEN, first: ${OPEN_SHOWN}) { totalCount nodes { number } } } }
  }
}`,
  // the PR's head and base too: `pr labels` doesn't label from a batch's release PR (#650)
  PrChange: `query PrChange($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    pullRequest(number: $number) {
      number headRefOid headRefName baseRefName body
      closingIssuesReferences(first: 20) { nodes { number } }
      files(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { path changeType additions deletions } }
    }
  }
}`,
  ModelAt: `query ModelAt($owner: String!, $name: String!, $expression: String!) {
  repository(owner: $owner, name: $name) { object(expression: $expression) { ... on Blob { text } } }
}`,
  // Ref.rules — the rules of active rulesets (of the repository and the organization) that GitHub applies to the branch
  MergeRules: `query MergeRules($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    isPrivate mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed
    defaultBranchRef {
      name
      branchProtectionRule { requiredStatusCheckContexts }
      rules(first: 100) { nodes { type repositoryRuleset { name } parameters { ...StatusChecks } } }
    }
    rulesets(first: 100) {
      nodes {
        id name enforcement
        conditions { refName { include } }
        bypassActors(first: 50) { nodes { bypassMode repositoryRoleDatabaseId } }
        rules(first: 100) { nodes { type parameters { ...StatusChecks } } }
      }
    }
    merged: pullRequests(states: MERGED, last: 30) { nodes { ...Head } }
    open: pullRequests(states: OPEN, last: 30) { nodes { ...Head } }
  }
}
fragment StatusChecks on RuleParameters { ... on RequiredStatusChecksParameters { strictRequiredStatusChecksPolicy requiredStatusChecks { context } } }
fragment Head on PullRequest {
  number baseRefName
  ${HEAD_CHECKS}
}`,
  // The task's PR that GitHub didn't link to it (task close): the latest open and merged ones, newest first
  RecentPrs: `query RecentPrs($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    pullRequests(states: [OPEN, MERGED], first: ${RECENT_PRS}, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { number state merged headRefName headRefOid baseRefName body } }
  }
}`,
  // a batch's PRs (batch release, #649): into the batch branch — all of them, not the recent ones: a task missed is a task
  // the release doesn't close; and its release PR — the batch branch as the head, its head commit for its checks (#650)
  BatchPrs: `query BatchPrs($owner: String!, $name: String!, $batch: String!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    into: pullRequests(baseRefName: $batch, states: [OPEN, MERGED], first: 100) { nodes { number state merged headRefName headRefOid baseRefName body } }
    release: pullRequests(headRefName: $batch, states: [OPEN, MERGED], first: 10, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { number state merged headRefName headRefOid baseRefName body } }
  }
}`,
  // task show and task answer: the description, the epic with its description and subtasks, blocked by, the PRs with
  // their head's checks, Status and number fields of the project; the comments of the task and its epic (#651)
  IssueShow: `query IssueShow($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      id number title state stateReason url body
      issueType { name }
      labels(first: 20) { nodes { id name } }
      milestone { title }
      ${COMMENTS_SHOW}
      parent { number title body subIssues(first: 100) { nodes { number state title } } ${COMMENTS_SHOW} }
      subIssues(first: 100) { nodes { number state title } }
      blockedBy(first: 20) { nodes { number state title repository { nameWithOwner } } }
      closedByPullRequestsReferences(first: 20, includeClosedPrs: true) { nodes { ${PR_SHOW} } }
      projectItems(first: 20) {
        nodes {
          project { title }
          fieldValues(first: 50) {
            nodes {
              __typename
              ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
              ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { name } } }
            }
          }
        }
      }
      issueFieldValues(first: 20) { nodes { __typename ... on IssueFieldSingleSelectValue { name field { ... on IssueFieldSingleSelect { name } } } } }
    }
  }
}`,
  // a PR that GitHub didn't link to the task yet (task show)
  PrShow: `query PrShow($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${PR_SHOW} } }
}`,
  // the repository's branches on GitHub — a task's status by the facts without a board (#847): `query` filters by a
  // part of the name, a task's — `/N-`
  TaskBranches: `query TaskBranches($owner: String!, $name: String!, $query: String, $after: String) {
  repository(owner: $owner, name: $name) {
    refs(refPrefix: "refs/heads/", query: $query, first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { name } }
  }
}`,
  IssueSearch: `query IssueSearch($q: String!) {
  search(query: $q, type: ISSUE, first: 100) { nodes { ... on Issue { number title state } } }
}`,
  ProjectItems: `query ProjectItems($id: ID!, $after: String) {
  node(id: $id) {
    ... on ProjectV2 {
      items(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          content { __typename ... on Issue { id number state stateReason } }
          status: fieldValueByName(name: "${STATUS}") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
        }
      }
    }
  }
}`,
} as const;

// Mutations take one $input parameter: input has only the given keys (GitHub reads null in input as "erase").
const M: Record<string, [field: string, inputType: string, select: string]> = {
  LinkProject: ["linkProjectV2ToRepository", "LinkProjectV2ToRepositoryInput", "repository { id }"],
  UnlinkProject: ["unlinkProjectV2FromRepository", "UnlinkProjectV2FromRepositoryInput", "repository { id }"],
  CopyProject: ["copyProjectV2", "CopyProjectV2Input", `projectV2 { ${REF} }`],
  CreateProject: ["createProjectV2", "CreateProjectV2Input", `projectV2 { ${REF} }`],
  RenameProject: ["updateProjectV2", "UpdateProjectV2Input", "projectV2 { id }"],
  CreateView: ["createProjectV2View", "CreateProjectV2ViewInput", "projectV2View { id }"],
  UpdateView: ["updateProjectV2View", "UpdateProjectV2ViewInput", "projectV2View { id }"],
  DeleteView: ["deleteProjectV2View", "DeleteProjectV2ViewInput", "clientMutationId"],
  CreateField: ["createProjectV2Field", "CreateProjectV2FieldInput", "clientMutationId"],
  UpdateField: ["updateProjectV2Field", "UpdateProjectV2FieldInput", "clientMutationId"],
  DeleteField: ["deleteProjectV2Field", "DeleteProjectV2FieldInput", "clientMutationId"],
  AddIssueField: ["createProjectV2IssueField", "CreateProjectV2IssueFieldInput", "clientMutationId"],
  SetItemStatus: ["updateProjectV2ItemFieldValue", "UpdateProjectV2ItemFieldValueInput", "projectV2Item { id }"],
  AddItem: ["addProjectV2ItemById", "AddProjectV2ItemByIdInput", "item { id }"],
  DeleteItem: ["deleteProjectV2Item", "DeleteProjectV2ItemInput", "deletedItemId"],
  CreateIssueType: ["createIssueType", "CreateIssueTypeInput", "issueType { id }"],
  UpdateIssueType: ["updateIssueType", "UpdateIssueTypeInput", "issueType { id }"],
  CreateIssue: ["createIssue", "CreateIssueInput", "issue { id number title url projectItems(first: 10) { nodes { id project { id } } } }"],
  CreateLabel: ["createLabel", "CreateLabelInput", "label { id }"],
  UpdateLabel: ["updateLabel", "UpdateLabelInput", "label { id }"],
  DeleteLabel: ["deleteLabel", "DeleteLabelInput", "clientMutationId"],
  AddLabels: ["addLabelsToLabelable", "AddLabelsToLabelableInput", "clientMutationId"],
  RemoveLabels: ["removeLabelsFromLabelable", "RemoveLabelsFromLabelableInput", "clientMutationId"],
  AddBlockedBy: ["addBlockedBy", "AddBlockedByInput", "issue { id }"],
  RemoveBlockedBy: ["removeBlockedBy", "RemoveBlockedByInput", "issue { id }"],
  SetIssueField: ["setIssueFieldValue", "SetIssueFieldValueInput", "issue { id }"],
  CloseIssue: ["closeIssue", "CloseIssueInput", "issue { id state }"],
  ReopenIssue: ["reopenIssue", "ReopenIssueInput", "issue { id state }"],
  UpdateIssue: ["updateIssue", "UpdateIssueInput", "issue { id }"],
  AddComment: ["addComment", "AddCommentInput", "subject { id }"],
  CreateRuleset: ["createRepositoryRuleset", "CreateRepositoryRulesetInput", "ruleset { id }"],
  UpdateRuleset: ["updateRepositoryRuleset", "UpdateRepositoryRulesetInput", "ruleset { id }"],
};

/**
 * REST mutations — what GraphQL lacks: the repository's merge settings (`UpdateRepositoryInput` doesn't know them).
 * Input — `repo` and the request fields; `gh api -F` sends true/false as booleans.
 */
const REST: Record<string, (input: Record<string, unknown>) => string[]> = {
  UpdateRepository: ({ repo, ...fields }) => ["api", "-X", "PATCH", `repos/${repo}`, ...Object.entries(fields).flatMap(([k, v]) => ["-F", `${k}=${v}`])],
};

function mutationQuery(op: string): string {
  const spec = M[op];
  if (!spec) throw new GhError(`unknown mutation ${op}`);
  const [field, inputType, select] = spec;
  return `mutation ${op}($input: ${inputType}!) { ${field}(input: $input) { ${select} } }`;
}

/** A GraphQL query; partial data with errors — a warning, but for a mutation (strict) an error: no result received. */
export function graphql(io: Io, query: string, variables: Record<string, unknown>, strict = false): Any {
  const out = io.gh(["api", "graphql", "--input", "-"], JSON.stringify({ query, variables }));
  let res: Any;
  try {
    res = JSON.parse(out);
  } catch {
    throw new GhError(`gh api graphql: the response is not JSON: ${out.slice(0, 200)}`);
  }
  const errors: string[] = (res.errors ?? []).map((e: Any) => e.message ?? String(e));
  if (errors.length && (!res.data || strict)) throw new GhError(`GraphQL: ${errors.join("; ")}`);
  if (errors.length) io.err(`GraphQL warning: ${errors.join("; ")}`);
  return res.data;
}

function mutate(io: Io, m: Mutation): Any {
  const rest = REST[m.op];
  return rest ? restCall(io, rest(m.input)) : graphql(io, mutationQuery(m.op), { input: m.input }, true);
}

/** A REST request; an error response (realGh returns JSON even with a code ≠ 0) is an exception with its message. */
function restCall(io: Io, args: string[]): Any {
  // `-X PATCH repos/…` or GET `repos/…`
  const what = args.slice(1).filter((a) => !a.startsWith("-")).slice(0, 2).join(" ");
  const out = io.gh(args);
  let res: Any;
  try {
    res = JSON.parse(out);
  } catch {
    throw new GhError(`${what}: the response is not JSON: ${out.slice(0, 200)}`);
  }
  if (res?.message && res.id === undefined) throw new GhError(`${what}: ${res.message}`);
  return res;
}

/**
 * A Claude Code cloud session (#837): the flow doesn't support it — its proxy closes GraphQL and Projects v2, and a
 * half-working flow there is worse than none: `main` refuses with one line, before the help and the arguments.
 */
const CLOUD_REFUSAL = "the flow doesn't support Claude Code cloud sessions (CLAUDE_CODE_REMOTE=true) — run it in a local session";
/**
 * The commands that write the canon's names to GitHub in the project language or check the project against them
 * (#681, question 1): views, fields and `Status` options, a task's sections, statuses and comments, a decision label's
 * marker, the release PR's title. Without the project manifest the language is unknown — they refuse before any request
 * (`locale.missingManifest`); reading (`task show`, `task queue`, `pr premerge`) parses the names of every language and
 * goes on, `task drop` writes no names.
 */
const LANGUAGE_COMMANDS = ["project check", "project fix", "task new", "task answer", "task start", "task status", "task actualize", "task close", "task finish", "pr labels", "batch release"];

/**
 * A REST request with a payload: JSON on stdin (a body doesn't fit an argument); an error response is an exception with
 * its message; an empty answer (204) — null.
 */
function rest(io: Io, route: string, o: { method?: string; payload?: unknown } = {}): Any {
  const what = `${o.method ?? "GET"} ${route}`;
  const out = io.gh(["api", ...(o.method ? ["-X", o.method] : []), route, ...(o.payload === undefined ? [] : ["--input", "-"])], o.payload === undefined ? undefined : JSON.stringify(o.payload));
  let res: Any;
  try {
    res = out.trim() ? JSON.parse(out) : null;
  } catch {
    throw new GhError(`${what}: the response is not JSON: ${out.slice(0, 200)}`);
  }
  if (res && !Array.isArray(res) && typeof res.message === "string" && res.id === undefined) throw new GhError(`${what}: ${res.message}`);
  return res;
}

/** The real `gh`: an exit code ≠ 0 is an exception with stderr; the sandbox's TLS — `SandboxRefusal` (#868). */
export function realGh(args: string[], stdin?: string): string {
  const r = spawnSync("gh", args, { input: stdin, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) {
    if ((r.error as NodeJS.ErrnoException).code === "ENOENT") throw new GhError("gh command not found; the gh CLI must be installed");
    throw new GhError(`gh ${args.slice(0, 2).join(" ")}: ${r.error.message}`);
  }
  const refusal = r.status === 0 ? null : sandboxRefusal(r.stderr ?? "");
  if (refusal) throw refusal;
  // gh api graphql exits with 1 on GraphQL errors, but the JSON with errors is in stdout — let graphql() parse it
  if (r.status !== 0 && !r.stdout.trim().startsWith("{")) throw new GhError(`gh ${args.slice(0, 2).join(" ")}: ${(r.stderr || "").trim().slice(0, 500)}`);
  return r.stdout;
}

// ----------------------------------------------------------------------------
// Reading the state
// ----------------------------------------------------------------------------

function pages<T>(fetch: (after: string | null) => { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: T[] }): T[] {
  const out: T[] = [];
  let after: string | null = null;
  for (let i = 0; i < 100; i++) {
    const page = fetch(after);
    out.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }
  return out;
}

function loadRepo(io: Io, slug: string): State["repo"] {
  const [owner, name] = slug.split("/") as [string, string];
  const data = graphql(io, Q.RepoState, { owner, name });
  const r = data?.repository;
  if (!r) throw new GhError(`repository ${slug} not found or no access`);
  const o = r.owner;
  return {
    id: r.id,
    name: r.name,
    nameWithOwner: r.nameWithOwner,
    owner: {
      org: o.__typename === "Organization",
      id: o.id,
      login: o.login,
      issueTypes: (o.issueTypes?.nodes ?? []).filter(Boolean),
      issueFields: (o.issueFields?.nodes ?? []).filter((f: Any) => f && f.name).map((f: Any) => ({ id: f.id, name: f.name, options: f.options ?? [] })),
    },
    linked: linkedProjects(r.projectsV2),
  };
}

export function loadState(io: Io, slug: string): State {
  const [owner, name] = slug.split("/") as [string, string];
  const repo = loadRepo(io, slug);
  const openIssues = pages<State["openIssues"][number]>((after) => graphql(io, Q.RepoIssues, { owner, name, after }).repository.issues);
  const main = mainProject(repo);
  const project = main ? loadProject(io, main.id) : null;
  if (project) markUnlisted(io, project, openIssues);
  return { repo, project, openIssues, labels: loadLabels(io, slug), decisions: loadDecisions(io, slug), merge: loadMerge(io, slug) };
}

/** How many ids one `nodes(ids:)` query takes — GitHub's limit. */
const NODES_PAGE = 100;

/**
 * GitHub sometimes leaves an item out of `ProjectV2.items` that the issue has (#791): `issue.projectItems` returns it,
 * `AddItem` answers with that same item, and the list doesn't change until GitHub reindexes the project. An open issue
 * missing from the list is asked by its own `projectItems`: a live (not archived) item of this project marks it
 * `unlisted` — the task is in the project, it isn't added again.
 */
function markUnlisted(io: Io, project: Project, issues: State["openIssues"]): void {
  const listed = new Set(project.items.map((it) => it.issue?.id));
  const missing = issues.filter((i) => !listed.has(i.id));
  for (let k = 0; k < missing.length; k += NODES_PAGE) {
    const batch = missing.slice(k, k + NODES_PAGE);
    for (const n of graphql(io, Q.IssueItems, { ids: batch.map((i) => i.id) })?.nodes ?? []) {
      const item = (n?.projectItems?.nodes ?? []).find((it: Any) => it?.project?.id === project.id && !it.isArchived);
      const issue = batch.find((i) => i.id === n?.id);
      if (item && issue) issue.unlisted = item.id;
    }
  }
}

const statusChecks = (rule: Any): { strict: boolean; contexts: string[] } | null =>
  rule?.type === "REQUIRED_STATUS_CHECKS" ? { strict: !!rule.parameters?.strictRequiredStatusChecksPolicy, contexts: (rule.parameters?.requiredStatusChecks ?? []).map((c: Any) => c.context) } : null;

/** From the worst: a name reported by several apps gets the worst of their states. */
const WORST: CheckBucket[] = ["fail", "cancel", "pending", "skipping", "pass"];

/**
 * The state of each check of a PR head by name, from the `statusCheckRollup` contexts (`HEAD_CHECKS`) — the one rule
 * of `task show` and `project check`. A check-run: not completed — pending; success — pass; neutral, skipped —
 * skipping; cancelled — cancel; any other conclusion — fail. Reruns of one name — the last check-run of each app (the
 * largest `databaseId`), not the best one and not the order of the response; several apps — the worst of their states.
 * A commit status — GitHub already keeps the latest of a context: success — pass, pending and expected — pending,
 * otherwise fail. The copy — `CHECK_STATES` in ci-wait's `wait-ci.sh` (REST check-runs): both answer by one table,
 * `tests/standards/scripts/check-run-state`.
 */
export function checkStates(nodes: Any[]): Map<string, CheckBucket> {
  const app = (c: Any) => JSON.stringify([c.name, c.checkSuite?.app?.databaseId ?? null]);
  const last = new Map<string, Any>();
  for (const c of nodes) {
    if (c?.__typename === "CheckRun" && (!last.has(app(c)) || (last.get(app(c)).databaseId ?? 0) <= (c.databaseId ?? 0))) last.set(app(c), c);
  }
  const out = new Map<string, CheckBucket>();
  const put = (name: string, state: CheckBucket) => {
    const was = out.get(name);
    if (!was || WORST.indexOf(state) < WORST.indexOf(was)) out.set(name, state);
  };
  // in the order of the response: task show lists the names as GitHub gives them
  for (const c of nodes) {
    if (c?.__typename === "StatusContext") put(c.context, c.state === "SUCCESS" ? "pass" : c.state === "PENDING" || c.state === "EXPECTED" ? "pending" : "fail");
    if (c?.__typename !== "CheckRun" || last.get(app(c)) !== c) continue;
    const s = c.status !== "COMPLETED" ? "pending" : c.conclusion === "SUCCESS" ? "pass" : c.conclusion === "NEUTRAL" || c.conclusion === "SKIPPED" ? "skipping" : c.conclusion === "CANCELLED" ? "cancel" : "fail";
    put(c.name, s);
  }
  return out;
}

const rollupOf = (pr: Any): Any[] => pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];

/** A private repository on Free: GraphQL silently returns empty rules, REST — 403 "Upgrade to GitHub Pro…". */
function rulesetsUnavailable(io: Io, slug: string): string | null {
  const out = io.gh(["api", `repos/${slug}/rulesets`]);
  let res: Any;
  try {
    res = JSON.parse(out);
  } catch {
    throw new GhError(`gh api repos/${slug}/rulesets: the response is not JSON: ${out.slice(0, 200)}`);
  }
  return !Array.isArray(res) && /upgrade/i.test(res?.message ?? "") ? String(res.message) : null;
}

function loadMerge(io: Io, slug: string): Merge | null {
  const [owner, name] = slug.split("/") as [string, string];
  const r = graphql(io, Q.MergeRules, { owner, name })?.repository;
  const b = r?.defaultBranchRef;
  if (!b) return null;
  const heads = (nodes: Any[]): Head[] =>
    (nodes ?? []).filter((p) => p && p.baseRefName === b.name).map((p) => ({ number: p.number, checks: Object.fromEntries(checkStates(rollupOf(p))) })).filter((h) => Object.keys(h.checks).length);
  const bp = b.branchProtectionRule;
  const rules = (b.rules?.nodes ?? []).flatMap((x: Any) => {
    const sc = statusChecks(x);
    return sc ? [{ source: `ruleset ${q(x.repositoryRuleset?.name ?? "?")}`, contexts: sc.contexts }] : [];
  });
  if (bp?.requiredStatusCheckContexts?.length) rules.push({ source: "branch protection", contexts: bp.requiredStatusCheckContexts });
  const sets: Any[] = r.rulesets?.nodes ?? [];
  const o = sets.find((x) => x?.name === RULESET);
  const osc = o ? ((o.rules?.nodes ?? []).map(statusChecks).find(Boolean) ?? { strict: false, contexts: [] }) : null;
  return {
    branch: b.name,
    unavailable: r.isPrivate ? rulesetsUnavailable(io, slug) : null,
    rules,
    own: o
      ? {
          id: o.id,
          name: o.name,
          enforcement: o.enforcement,
          include: o.conditions?.refName?.include ?? [],
          ...osc!,
          bypassAdmin: (o.bypassActors?.nodes ?? []).some((a: Any) => a?.repositoryRoleDatabaseId === ADMIN_ROLE && a.bypassMode === "ALWAYS"),
        }
      : null,
    merged: heads(r.merged?.nodes).slice(-STABLE_PRS),
    open: heads(r.open?.nodes).filter((h) => Object.values(h.checks).every((c) => c !== "pending")),
    methods: { merge: !!r.mergeCommitAllowed, squash: !!r.squashMergeAllowed, rebase: !!r.rebaseMergeAllowed },
  };
}

function loadLabels(io: Io, slug: string): Label[] {
  const [owner, name] = slug.split("/") as [string, string];
  return pages<Any>((after) => graphql(io, Q.RepoLabels, { owner, name, after }).repository.labels).map(({ issues, ...l }) => ({
    ...l,
    open: { total: issues?.totalCount ?? 0, numbers: (issues?.nodes ?? []).map((i: Any) => i.number) },
  }));
}

/**
 * Architecture model modules and their directories: the model text goes to a temporary file, `modules` is printed by
 * a separate process of the same runtime (Bun strips types; the model doesn't need the spec skill's `import type`).
 * Didn't load — the reason as a string.
 */
export function modelModules(text: string): Record<string, string[]> | string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "github-model-"));
  try {
    writeFileSync(path.join(dir, "model.ts"), text);
    writeFileSync(
      path.join(dir, "modules.mjs"),
      'const m = await import("./model.ts");\n' +
        "const paths = (p) => (Array.isArray(p) ? p : [p]).map((x) => String(x).replace(/\\/+$/, \"\"));\n" +
        "console.log(JSON.stringify(Object.fromEntries(Object.entries(m.default?.modules ?? {}).map(([k, v]) => [k, paths(v?.path ?? [])]))));\n",
    );
    const r = spawnSync(process.execPath, ["--no-env-file", path.join(dir, "modules.mjs")], { encoding: "utf8", timeout: 30_000 });
    if (r.status !== 0) return ((r.stderr || r.error?.message || "").trim().split("\n").find((l) => /error/i.test(l)) ?? "the process exited with an error").trim().slice(0, 200);
    return JSON.parse(r.stdout) as Record<string, string[]>;
  } catch (e) {
    return (e as Error).message;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Default-branch decisions: spec tree folders by kind, and model modules for architecture. */
export function loadDecisions(io: Io, slug: string): Decisions {
  const [owner, name] = slug.split("/") as [string, string];
  const r = graphql(io, Q.SpecDecisions, { owner, name })?.repository ?? {};
  const dirs = (t: Any): string[] => (t?.entries ?? []).filter((e: Any) => e.type === "tree").map((e: Any) => e.name as string);
  const names = { capability: dirs(r.capabilities), standard: dirs(r.standards), architecture: dirs(r.architecture) };
  const topics = (t: Any): Record<string, string[]> =>
    Object.fromEntries((t?.entries ?? []).filter((e: Any) => e.type === "tree").map((e: Any) => [e.name, sectionNames(e.name, e.object?.entries ?? [])]));
  const sections = { capability: topics(r.capabilities), standard: topics(r.standards), architecture: topics(r.architecture) };
  let modelError: string | null = null;
  if (r.model) {
    const mods = modelModules(r.model.text ?? "");
    if (typeof mods === "string") modelError = mods;
    else names.architecture.push(...Object.keys(mods));
  }
  for (const k of DECISION_KINDS) names[k] = [...new Set(names[k])].sort();
  return { names, sections, modelError };
}

/**
 * A topic folder's sections — from the files at its root: `<section>.md` and the section's test files
 * (`<section>.test.ts`, `<section>.e2e.ts`, `<section>.<part>.test.ts`); `<topic>.md`, the mechanism (`eslint.ts`,
 * `rule.yml`) and subfolders aren't sections.
 */
export function sectionNames(topic: string, entries: { name: string; type: string }[]): string[] {
  const out = new Set<string>();
  for (const e of entries) {
    if (e.type !== "blob" || !/\.(md|(test|e2e)\.[cm]?[jt]sx?)$/.test(e.name)) continue;
    const section = e.name.split(".")[0]!;
    if (section && section !== topic) out.add(section);
  }
  return [...out].sort();
}

/** The topics of these kinds that have a section with this name; a topic of several kinds — once. */
export function sectionTopics(d: Decisions, name: string, kinds: DecisionKind[]): string[] {
  const out = new Set<string>();
  for (const k of DECISION_KINDS) if (kinds.includes(k)) for (const [topic, ss] of Object.entries(d.sections[k] ?? {})) if (ss.includes(name)) out.add(topic);
  return [...out].sort();
}

/** `capability:billing` → the decision's kind and name; anything else — null. The kind of a new decision in `--labels`. */
export function newDecision(label: string): { kind: DecisionKind; name: string } | null {
  const i = label.indexOf(":");
  const kind = label.slice(0, i) as DecisionKind;
  return i > 0 && DECISION_KINDS.includes(kind) && label.length > i + 1 ? { kind, name: label.slice(i + 1) } : null;
}

/**
 * A decision label is marked by its description `<marker> <paths>`: a regular label's color may match, and so may its
 * name. The marker is written in the project language and recognized in any dictionary language: fix rewrites a
 * description in another language rather than taking the label for a regular one.
 */
const decisionMark = () => `${N.labelMarkers.decision} `;
const decisionPath = (kind: DecisionKind, name: string) => (kind === "architecture" ? locale.fill(N.labelMarkers.architecturePath, { name }) : `tests/${DECISIONS[kind].dir}/${name}`);
/** The marker of any dictionary language the description starts with; none — null. */
const markOf = (description: string | null | undefined, marks: string[]) => marks.map((m) => `${m} `).find((m) => description?.startsWith(m)) ?? null;

/**
 * A decision label: the senior kind's color, the paths of all kinds in the description; GitHub won't accept one longer
 * than 100 characters — then the kinds.
 */
export function decisionLabel(name: string, kinds: DecisionKind[]): { name: string; color: string; description: string } {
  const ks = DECISION_KINDS.filter((k) => kinds.includes(k));
  const full = decisionMark() + ks.map((k) => decisionPath(k, name)).join("; ");
  return { name, color: DECISIONS[ks[0]!].color, description: full.length <= 100 ? full : decisionMark() + ks.join(", ") };
}

/** A decision label's kinds — by its description; a regular label — null. */
export function labelKinds(description: string | null | undefined): DecisionKind[] | null {
  const mark = markOf(description, locale.every((n) => n.labelMarkers.decision));
  if (!mark) return null;
  const parts = description!.slice(mark.length).split(/; |, /);
  return DECISION_KINDS.filter((k) => parts.some((p) => p === k || p.startsWith(`tests/${DECISIONS[k].dir}`)));
}

/**
 * A slice label is marked by its description `<slice marker> <slice>[ — note]` (the marker is `labelMarkers.slice` of
 * any dictionary language): a slice of the project's tasks (apps, teams), not a decision, though its name may match a
 * model module. The slice lives with the label, not in `.agents/elves.json`: `install` and `update` rewrite the
 * install manifest, and `check` reads everything through the API.
 */
function labelDimension(description: string | null | undefined): string | null {
  const mark = markOf(description, locale.every((n) => n.labelMarkers.slice));
  if (!mark) return null;
  return description!.slice(mark.length).split(" — ")[0]!.trim() || null;
}

/** Default-branch decisions by name: name → its kinds (the senior one first). */
function decisionsByName(d: Decisions): Map<string, DecisionKind[]> {
  const out = new Map<string, DecisionKind[]>();
  for (const k of DECISION_KINDS) for (const n of d.names[k]) out.set(n, [...(out.get(n) ?? []), k]);
  return out;
}

function loadProject(io: Io, id: string, withItems = true): Project {
  const p = graphql(io, Q.ProjectState, { id }).node;
  if (!p) throw new GhError(`project ${id} not found or no access (needs the project scope: gh auth refresh -s project)`);
  const items = withItems ? pages<Any>((after) => graphql(io, Q.ProjectItems, { id, after }).node.items) : [];
  return {
    ...ref(p),
    views: p.views.nodes.map((v: Any) => ({
      id: v.id,
      number: v.number,
      name: v.name,
      layout: v.layout,
      filter: v.filter ?? null,
      sortBy: (v.sortByFields?.nodes ?? []).map((s: Any) => s.field?.name).filter(Boolean),
      columnsBy: (v.verticalGroupByFields?.nodes ?? []).map((f: Any) => f?.name).filter(Boolean),
      groupBy: (v.groupByFields?.nodes ?? []).map((f: Any) => f?.name).filter(Boolean),
      columns: (v.fields?.nodes ?? []).filter((f: Any) => f?.id).map((f: Any) => ({ id: f.id, name: f.name, dataType: f.dataType })),
    })),
    fields: p.fields.nodes
      .filter((f: Any) => f && f.id)
      .map((f: Any) => ({ id: f.id, name: f.name, dataType: f.dataType, isIssueField: !!f.isIssueField, options: f.options ?? null })),
    workflows: p.workflows.nodes.filter(Boolean),
    items: items.map((it: Any) => ({
      id: it.id,
      issue: it.content?.__typename === "Issue" ? { id: it.content.id, number: it.content.number, state: it.content.state, stateReason: it.content.stateReason ?? null } : null,
      status: it.status?.name ?? null,
    })),
  };
}

// ----------------------------------------------------------------------------
// Checking against the canon
// ----------------------------------------------------------------------------

const nums = (xs: { number: number }[]) => xs.map((x) => `#${x.number}`).join(", ");
const q = (s: string) => `«${s}»`;

/**
 * All discrepancies with the canon by item; each has fix steps. No project — the board is optional (#847): an `○` line
 * instead of the project's items, `fix --create` connects one; the default-branch rule and the merge method are checked.
 */
export function analyze(s: State): Check[] {
  const p = s.project;
  const checks: Check[] = [];
  const add = (key: string, title: string) => {
    const c: Check = { key, title, problems: [], notes: [], cleanup: [] };
    checks.push(c);
    const note = (text: string, ...steps: Step[]) => (c.notes.push(text), c.cleanup.push(...steps));
    return Object.assign((text: string, ...steps: Step[]) => c.problems.push({ text, steps }), { note, skip: (why: string) => void (c.skip = why) });
  };

  const link = add("link", p ? `Project linked to the repository and named ${q(s.repo.name)}` : "Board (GitHub Projects) — optional");
  // the default-branch rule and the merge method don't depend on the project
  const merge = () => {
    if (!s.merge) return;
    analyzeMerge(s.merge, s.repo.id, add("merge", `Merge into ${s.merge.branch} — only with green required checks`));
    analyzeMethod(s.merge, s.repo.nameWithOwner, add("method", `PR merge method — rebase only`));
  };
  if (!p) {
    link.note("no board connected — tasks go without one, their status by the facts; connect one: github project fix --create");
    merge();
    return checks;
  }
  const used = p.items.length > 0;
  const guarded = (text: string, ...mutations: Mutation[]): Step => ({ kind: used ? "confirm" : "api", text, mutations });
  const api = (text: string, ...mutations: Mutation[]): Step => ({ kind: "api", text, mutations });
  const ui = (text: string, url: string): Step => ({ kind: "ui", text, url });

  if (p.title !== s.repo.name) link(`title ${q(p.title)}`, guarded(`rename project ${q(p.title)} → ${q(s.repo.name)}`, { op: "RenameProject", input: { projectId: p.id, title: s.repo.name } }));
  for (const other of s.repo.linked.filter((x) => x.id !== p.id)) {
    link(`another project is linked: ${q(other.title)} (${other.url})`, { kind: "confirm", text: `unlink project ${q(other.title)} from the repository`, mutations: [{ op: "UnlinkProject", input: { projectId: other.id, repositoryId: s.repo.id } }] });
  }

  // Columns: a built-in field by its type, the rest by name; a numeric field in another dictionary language is the same
  // column — the Fields item renames it keeping the id.
  const fieldAlias = fieldAliases();
  const columnKey = (f: { name: string; dataType: string }) => (BUILTIN_FIELDS.has(f.dataType) ? f.dataType : (fieldAlias[f.name] ?? f.name));
  const columnName = (key: string) => p.fields.find((f) => columnKey(f) === key)?.name ?? BUILTIN_COLUMNS[key] ?? key;
  // a field the project doesn't have yet is skipped: the step's text changes when it appears, and the next round sets it
  const columnFields = (keys: string[]) => keys.map((k) => p.fields.find((f) => columnKey(f) === k)).filter((f): f is Field => !!f);
  const configuration = (keys: string[]) => ({ visibleFieldIds: columnFields(keys).map((f) => f.id) });

  // Views: by name; missing — rename an extra one of the same layout or create one; extra ones — delete.
  const views = add("views", `Views ${canonViews().map((v) => q(v.name)).join(", ")} — the right layout, columns and grouping, no filter, no others`);
  const canonNames = new Set<string>(canonViews().map((v) => v.name));
  const spare = p.views.filter((v) => !canonNames.has(v.name));
  for (const c of canonViews()) {
    const v = p.views.find((x) => x.name === c.name);
    if (!v) {
      const cand = spare.find((x) => x.layout === c.layout);
      if (cand) {
        spare.splice(spare.indexOf(cand), 1);
        views(`missing ${q(c.name)}`, guarded(`rename view ${q(cand.name)} → ${q(c.name)}`, { op: "UpdateView", input: { viewId: cand.id, name: c.name } }));
      } else {
        const input = { projectId: p.id, name: c.name, layout: c.layout, ...(c.columns ? { configuration: configuration(c.columns) } : {}) };
        views(`missing ${q(c.name)}`, api(`create view ${q(c.name)} (${c.layout})`, { op: "CreateView", input }));
      }
      continue;
    }
    if (v.layout !== c.layout) views(`${q(c.name)} — ${v.layout}`, api(`${q(c.name)}: layout ${c.layout}`, { op: "UpdateView", input: { viewId: v.id, layout: c.layout } }));
    if (v.filter) views(`${q(c.name)} has filter ${q(v.filter)}`, api(`${q(c.name)}: remove filter ${q(v.filter)}`, { op: "UpdateView", input: { viewId: v.id, filter: "" } }));
    if (c.layout === "BOARD_LAYOUT" && v.layout === c.layout && v.columnsBy[0] !== STATUS) {
      views(`${q(c.name)} columns not by Status`, ui(`${q(c.name)}: View options → Column by → Status → Save`, `${p.url}/views/${v.number}`));
    }
    if (c.columns) {
      const have = v.columns.map(columnKey);
      const missing = c.columns.filter((k) => !have.includes(k)).map((k) => q(columnName(k)));
      // the old estimate field's column is that field's note, not a discrepancy of the view: it goes with the field
      const extra = v.columns.filter((f) => !c.columns!.includes(columnKey(f)) && !isEstimateField(f.name)).map((f) => q(f.name));
      if (missing.length || extra.length) {
        const why = [missing.length ? `missing ${missing.join(", ")}` : "", extra.length ? `extra ${extra.join(", ")}` : ""].filter(Boolean).join("; ");
        const set = columnFields(c.columns).map((f) => f.name).join(", ");
        views(`${q(c.name)} columns: ${why}`, api(`${q(c.name)}: columns ${set}`, { op: "UpdateView", input: { viewId: v.id, configuration: configuration(c.columns) } }));
      }
    }
    // the API reads the grouping but doesn't set it
    if (c.groupBy && v.layout === c.layout && v.groupBy[0] !== c.groupBy) {
      views(`${q(c.name)} not grouped by ${c.groupBy}`, ui(`${q(c.name)}: View options → Group by → ${c.groupBy} → Save`, `${p.url}/views/${v.number}`));
    }
  }
  for (const v of spare) views(`extra ${q(v.name)}`, guarded(`delete view ${q(v.name)}`, { op: "DeleteView", input: { viewId: v.id } }));

  // Status: options by name or by a known English name — with the same id; missing ones — new; colors — the template's,
  // descriptions are the project's own.
  const status = add("status", `${STATUS}: ${statusOptions().join(" → ")} (${STATUS_COLORS.join(", ")})`);
  const sf = p.fields.find((f) => f.name === STATUS && f.options);
  if (!sf) {
    status(`no ${STATUS} field`, api(`create field ${STATUS}`, { op: "CreateField", input: { projectId: p.id, dataType: "SINGLE_SELECT", name: STATUS, singleSelectOptions: statusOptions().map((name, i) => ({ name, color: STATUS_COLORS[i], description: "" })) } }));
  } else if (sf.options!.map((o) => o.name).join("\n") !== statusOptions().join("\n")) {
    const left = [...sf.options!];
    const take = (pred: (o: Option) => boolean) => {
      const i = left.findIndex(pred);
      return i < 0 ? null : left.splice(i, 1)[0]!;
    };
    const aliases = statusAliases();
    const next = statusOptions().map((name, i) => {
      const o = take((x) => x.name === name) ?? take((x) => aliases[x.name.toLowerCase()] === name);
      return o ? { id: o.id, name, color: STATUS_COLORS[i]!, description: o.description ?? "" } : { name, color: STATUS_COLORS[i]!, description: "" };
    });
    const drop = left.length ? `; delete ${left.map((o) => q(o.name)).join(", ")}` : "";
    status(`options: ${sf.options!.map((o) => o.name).join(", ") || "none"}`, guarded(`${STATUS}: ${statusOptions().join(", ")} (rename the existing ones keeping the id${drop})`, { op: "UpdateField", input: { fieldId: sf.id, singleSelectOptions: next } }));
  } else if (sf.options!.some((o, i) => o.color !== STATUS_COLORS[i])) {
    // recoloring keeps the ids — the tasks' values and the workflows' targets, no confirmation needed
    const next = sf.options!.map((o, i) => ({ id: o.id, name: o.name, color: STATUS_COLORS[i]!, description: o.description ?? "" }));
    status(`colors: ${sf.options!.map((o) => `${o.name} ${o.color}`).join(", ")}`, api(`${STATUS}: colors ${STATUS_COLORS.join(", ")} (keeping the id)`, { op: "UpdateField", input: { fieldId: sf.id, singleSelectOptions: next } }));
  }

  // Fields: three numeric ones; a field in another dictionary language is renamed with the same id (the tasks' values are
  // kept); no custom fields beyond the canon but the old estimate field (a note); in an organization Priority is an
  // issue field.
  const fields = add("fields", `Fields ${numberFields().map(q).join(", ")} (Number), no other custom ones`);
  const renamed = new Set<Field>();
  for (const name of numberFields()) {
    const f = p.fields.find((x) => x.name === name);
    const create: Mutation = { op: "CreateField", input: { projectId: p.id, dataType: "NUMBER", name } };
    const other = f ? undefined : p.fields.find((x) => x.dataType === "NUMBER" && !renamed.has(x) && fieldAlias[x.name] === name);
    if (other) {
      renamed.add(other);
      fields(`missing ${q(name)}`, guarded(`rename field ${q(other.name)} → ${q(name)} (task values are kept)`, { op: "UpdateField", input: { fieldId: other.id, name } }));
    } else if (!f) fields(`missing ${q(name)}`, api(`create field ${q(name)} (Number)`, create));
    else if (f.dataType !== "NUMBER") fields(`${q(name)} — ${f.dataType}`, { kind: "confirm", text: `recreate field ${q(name)} as Number (the field's values will be lost)`, mutations: [{ op: "DeleteField", input: { fieldId: f.id } }, create] });
  }
  const orgPriority = s.repo.owner.org ? s.repo.owner.issueFields.find((f) => f.name === PRIORITY) : undefined;
  const isCanon = (f: Field) => BUILTIN_FIELDS.has(f.dataType) || f.name === STATUS || numberFields().includes(f.name) || (s.repo.owner.org && f.isIssueField && f.name === PRIORITY);
  const ownPriority = p.fields.find((f) => f.name === PRIORITY && !f.isIssueField);
  for (const f of p.fields.filter((x) => !isCanon(x) && x !== ownPriority && !renamed.has(x))) {
    if (isEstimateField(f.name)) {
      fields.note(`${q(f.name)} — the old estimate field: tasks aren't estimated any more, fix --confirm deletes it`, { kind: "confirm", text: `delete field ${q(f.name)} (the old estimate)`, mutations: [{ op: "DeleteField", input: { fieldId: f.id } }] });
      continue;
    }
    fields(`extra ${q(f.name)} (${f.dataType}${f.isIssueField ? ", issue field" : ""})`, guarded(`delete field ${q(f.name)}`, { op: "DeleteField", input: { fieldId: f.id } }));
  }
  if (ownPriority && !s.repo.owner.org) fields(`extra ${q(PRIORITY)} — a personal account keeps no priority`, guarded(`delete field ${q(PRIORITY)}`, { op: "DeleteField", input: { fieldId: ownPriority.id } }));

  if (s.repo.owner.org) {
    const org = s.repo.owner.login;
    const prio = add("priority", `${PRIORITY} — the organization's issue field in the project, ${q(N.views.table)} and ${q(N.views.board)} are sorted by it`);
    const connected = p.fields.some((f) => f.isIssueField && f.name === PRIORITY);
    if (!connected) {
      const connect: Mutation[] = orgPriority ? [{ op: "AddIssueField", input: { projectId: p.id, issueFieldId: orgPriority.id } }] : [];
      if (ownPriority) {
        prio(`own project field ${q(PRIORITY)} instead of the issue field`, { kind: "confirm", text: `delete the own field ${q(PRIORITY)} and connect the issue field ${PRIORITY}`, mutations: [{ op: "DeleteField", input: { fieldId: ownPriority.id } }, ...connect] });
      } else if (orgPriority) {
        prio(`issue field ${PRIORITY} not connected`, api(`connect the issue field ${PRIORITY}`, ...connect));
      }
      if (!orgPriority) prio(`the organization has no issue field ${PRIORITY}`, ui(`create the issue field ${PRIORITY} (single select: Urgent, High, Medium, Low), then fix again`, `https://github.com/organizations/${org}/settings/issue-fields`));
    }
    for (const name of [N.views.table, N.views.board]) {
      const v = p.views.find((x) => x.name === name);
      if (v && v.sortBy[0] !== PRIORITY) prio(`${q(name)} not sorted by ${PRIORITY}`, ui(`${q(name)}: View options → Sort by → ${PRIORITY} → Save`, `${p.url}/views/${v.number}`));
    }

    const types = add("types", `Issue types of the organization: ${issueTypes().join(", ")} — and only these`);
    const t = s.repo.owner.issueTypes;
    const url = `https://github.com/organizations/${org}/settings/issue-types`;
    const claimed = new Set<string>();
    const aliases = typeAliases();
    for (const name of issueTypes()) {
      const exact = t.find((x) => x.name === name);
      if (exact) {
        claimed.add(exact.id);
        if (!exact.isEnabled) types(`${q(name)} disabled`, { kind: "confirm", text: `enable type ${q(name)}`, url, mutations: [{ op: "UpdateIssueType", input: { issueTypeId: exact.id, isEnabled: true } }] });
        continue;
      }
      const alias = t.find((x) => !claimed.has(x.id) && aliases[x.name.toLowerCase()] === name);
      if (alias) {
        claimed.add(alias.id);
        types(`missing ${q(name)}`, { kind: "confirm", text: `rename type ${q(alias.name)} → ${q(name)}`, url, mutations: [{ op: "UpdateIssueType", input: { issueTypeId: alias.id, name, isEnabled: true } }] });
      } else {
        types(`missing ${q(name)}`, { kind: "confirm", text: `create type ${q(name)}`, url, mutations: [{ op: "CreateIssueType", input: { ownerId: s.repo.owner.id, name, isEnabled: true, color: name === N.issueTypes.epic ? "PURPLE" : name === N.issueTypes.bug ? "RED" : "GRAY" } }] });
      }
    }
    for (const x of t.filter((x) => x.isEnabled && !claimed.has(x.id))) {
      types(`extra ${q(x.name)}`, { kind: "confirm", text: `disable type ${q(x.name)}`, url, mutations: [{ op: "UpdateIssueType", input: { issueTypeId: x.id, isEnabled: false } }] });
    }
  }

  // Workflows: the API doesn't turn them on or show the target — only the UI. An unconfigured one isn't in the list.
  const wf = add("workflows", `Workflows ${WORKFLOWS.map(q).join(", ")} are on`);
  const how: Record<string, string> = {
    [WORKFLOW_ADDED]: `Edit → Set value → ${STATUS}: ${N.status.backlog}`,
    [WORKFLOW_CLOSED]: `Edit → Set value → ${STATUS}: ${N.status.done}`,
    [WORKFLOW_MERGED]: `Edit → Set value → ${STATUS}: ${N.status.done}`,
    [WORKFLOW_AUTO_CLOSE]: `Edit → ${STATUS}: ${N.status.done}`,
    // is:open — otherwise an updated closed task (not planned too) comes back into the project
    [WORKFLOW_AUTO_ADD]: `Edit → repository ${s.repo.name}, filter is:issue is:open (Enter)`,
    [WORKFLOW_SUB_ISSUES]: "Edit",
    [WORKFLOW_ARCHIVE]: `Edit → filter ${ARCHIVE_FILTER} (Enter)`,
  };
  for (const name of WORKFLOWS) {
    const w = p.workflows.find((x) => x.name === name);
    if (w?.enabled) continue;
    // an unconfigured workflow isn't in the API — a link to the list, it's in the menu on the left there
    wf(`${q(name)} ${w ? "disabled" : "not configured"}`, ui(`${q(name)}: ${how[name]} → Save and turn on workflow`, `${p.url}/workflows${w ? `/${w.fullDatabaseId}` : ""}`));
  }

  // Tasks: statuses by the canon. Closed ones not in "Done" — a symptom of "Item closed" on a deleted Status option.
  const opt = (name: string) => sf?.options?.find((o) => o.name === name)?.id;
  const setStatus = (it: Item, name: string): Mutation => ({ op: "SetItemStatus", input: { projectId: p.id, itemId: it.id, fieldId: sf!.id, value: { singleSelectOptionId: opt(name) } } });
  const statusReady = !!(opt(N.status.backlog) && opt(N.status.done));
  const closedAdd = add("closed", `Closed tasks — in ${q(N.status.done)}, closed without being done — outside the project`);
  const issues = p.items.filter((it) => it.issue);
  // "Done" in another dictionary language is the same option: the Status item renames it, no need to move tasks
  const doneAlias = statusAliases();
  const notDone = issues.filter((it) => it.issue!.state === "CLOSED" && !NOT_DONE_REASONS.has(it.issue!.stateReason ?? "") && doneAlias[(it.status ?? "").toLowerCase()] !== N.status.done);
  if (notDone.length) {
    const steps: Step[] = [];
    if (statusReady) steps.push(api(`${STATUS} ${q(N.status.done)}: ${nums(notDone.map((it) => it.issue!))}`, ...notDone.map((it) => setStatus(it, N.status.done))));
    const closed = p.workflows.find((x) => x.name === WORKFLOW_CLOSED);
    // fix sets the statuses itself, and the workflow's target isn't visible from the API — check it in the UI, even
    // when the symptom is gone
    if (closed?.enabled) steps.push({ ...ui(`${q(WORKFLOW_CLOSED)}: check Set value → ${STATUS}: ${N.status.done}, otherwise Edit → ${N.status.done} → Save`, `${p.url}/workflows/${closed.fullDatabaseId}`), sticky: true });
    closedAdd(`not in ${q(N.status.done)}: ${nums(notDone.map((it) => it.issue!))}`, ...steps);
  }
  const dropped = issues.filter((it) => it.issue!.state === "CLOSED" && NOT_DONE_REASONS.has(it.issue!.stateReason ?? ""));
  if (dropped.length) closedAdd(`closed without being done, but in the project: ${nums(dropped.map((it) => it.issue!))}`, api(`remove from the project ${nums(dropped.map((it) => it.issue!))}`, ...dropped.map((it) => ({ op: "DeleteItem", input: { projectId: p.id, itemId: it.id } }))));

  const open = add("open", `Open tasks of the repository — in the project, with ${STATUS}`);
  const inProject = new Set(issues.map((it) => it.issue!.id));
  // the item the issue has but the project's list doesn't return — the task is in the project: AddItem would answer
  // with the same item and change nothing (#791)
  const outside = s.openIssues.filter((i) => !inProject.has(i.id));
  const unlisted = outside.filter((i) => i.unlisted);
  const missing = outside.filter((i) => !i.unlisted);
  if (missing.length) open(`not in the project: ${nums(missing)}`, api(`add to the project ${nums(missing)}`, ...missing.map((i) => ({ op: "AddItem", input: { projectId: p.id, contentId: i.id } }))));
  if (unlisted.length) open.note(`GitHub doesn't return the item in the project's list: ${unlisted.map((i) => `#${i.number} (${i.unlisted})`).join(", ")} — the issue's projectItems has it`);
  const noStatus = issues.filter((it) => it.issue!.state === "OPEN" && !it.status);
  if (noStatus.length) open(`without ${STATUS}: ${nums(noStatus.map((it) => it.issue!))}`, ...(statusReady ? [api(`${STATUS} ${q(N.status.backlog)}: ${nums(noStatus.map((it) => it.issue!))}`, ...noStatus.map((it) => setStatus(it, N.status.backlog)))] : []));

  // Decision labels: by the spec tree and the model of the default branch. Deleting, renaming by a guess, making a
  // regular label a decision one — only with --confirm: the label is on tasks. One extra and one missing of the same
  // kind — a renamed folder, not two decisions. A label without a decision on an open task is a new decision (task new
  // sets it before the PR): an ○ line, not deleted and not renamed by a guess — that would take it away from the task. A
  // slice label with a decision's name is a different slice of tasks: an ○ line, fix doesn't touch it, and the decision
  // stays without a label (the name is taken).
  const labels = add("labels", "Decision labels — the decision's name, the kind by color; by the spec tree and the model of the default branch");
  const d = s.decisions;
  if (d.modelError) labels(`model ${MODEL_PATH} doesn't load — module labels aren't checked: ${d.modelError}`);
  const want = decisionsByName(d);
  // the model wasn't read — it's unknown which modules exist: architecture labels aren't deleted or re-described
  const unsure = (kinds: DecisionKind[]) => !!d.modelError && kinds.includes("architecture");
  const taken = new Map(s.labels.map((l) => [l.name, l]));
  const orphans: { label: Label; kinds: DecisionKind[] }[] = [];
  const dimensions = new Map<string, string[]>();
  for (const l of s.labels) {
    const kinds = labelKinds(l.description);
    const w = want.get(l.name);
    if (!w) {
      if (kinds) orphans.push({ label: l, kinds });
      continue;
    }
    const dim = labelDimension(l.description);
    if (dim) {
      dimensions.set(dim, [...(dimensions.get(dim) ?? []), l.name]);
      continue;
    }
    const to = decisionLabel(l.name, w);
    if (!kinds) {
      labels(`label ${q(l.name)} isn't a decision label, but decision ${l.name} is in the default branch`, { kind: "confirm", text: `make ${q(l.name)} a decision label: color ${to.color}, description ${q(to.description)}`, mutations: [{ op: "UpdateLabel", input: { id: l.id, color: to.color, description: to.description } }] });
      continue;
    }
    const recolor = l.color.toLowerCase() !== to.color.toLowerCase();
    if (!recolor && (l.description === to.description || unsure(kinds))) continue;
    const text = recolor ? `label ${q(l.name)} is colored ${l.color}, not ${to.color}` : `label ${q(l.name)}: wrong decision kinds in the description`;
    labels(text, api(`${recolor ? "recolor" : "rewrite the description of"} label ${q(l.name)}: ${to.color}, ${q(to.description)}`, { op: "UpdateLabel", input: { id: l.id, color: to.color, description: to.description } }));
  }
  for (const [dim, names] of dimensions) {
    labels.note(`slice ${q(dim)}: labels ${names.map(q).join(", ")} aren't decision labels, decisions of the same name aren't labeled`);
  }
  const unlabeled = [...want.keys()].filter((n) => !taken.has(n));
  const sure = orphans.filter((o) => !unsure(o.kinds));
  for (const { label: l } of sure.filter((o) => o.label.open.total)) {
    const more = l.open.total - l.open.numbers.length;
    labels.note(`new decision ${q(l.name)}: not in the default branch yet, the label is on open tasks ${l.open.numbers.map((n) => `#${n}`).join(", ")}${more > 0 ? ` and ${more} more` : ""}`);
  }
  const live = sure.filter((o) => !o.label.open.total);
  const paired = new Set<string>();
  for (const kind of DECISION_KINDS) {
    const os = live.filter((o) => o.kinds.includes(kind) && !paired.has(o.label.id));
    const ms = unlabeled.filter((n) => want.get(n)!.includes(kind) && !paired.has(n));
    if (os.length !== 1 || ms.length !== 1) continue;
    const o = os[0]!.label;
    const to = decisionLabel(ms[0]!, want.get(ms[0]!)!);
    paired.add(o.id).add(to.name);
    labels(`label ${q(o.name)} without a decision, decision ${to.name} without a label`, { kind: "confirm", text: `rename label ${q(o.name)} → ${q(to.name)} (tasks keep it)`, mutations: [{ op: "UpdateLabel", input: { id: o.id, ...to } }] });
  }
  for (const { label: o } of live.filter((x) => !paired.has(x.label.id))) {
    labels(`label ${q(o.name)} without a decision in the default branch, no open tasks have it`, { kind: "confirm", text: `delete label ${q(o.name)}`, mutations: [{ op: "DeleteLabel", input: { id: o.id } }] });
  }
  const fresh = unlabeled.filter((n) => !paired.has(n)).map((n) => decisionLabel(n, want.get(n)!));
  if (fresh.length) {
    labels(`decisions without a label: ${fresh.map((x) => x.name).join(", ")}`, api(`create labels ${fresh.map((x) => q(x.name)).join(", ")}`, ...fresh.map((x) => ({ op: "CreateLabel", input: { repositoryId: s.repo.id, ...x } }))));
  }

  merge();
  return checks;
}

/**
 * The `RULESET` ruleset: the default branch, required checks without strict (the field is mandatory in the API),
 * bypass — admin (the owner's direct push).
 */
function rulesetInput(contexts: string[]): Record<string, unknown> {
  return {
    name: RULESET,
    target: "BRANCH",
    enforcement: "ACTIVE",
    conditions: { refName: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [{ type: "REQUIRED_STATUS_CHECKS", parameters: { requiredStatusChecks: { requiredStatusChecks: contexts.map((context) => ({ context })), strictRequiredStatusChecksPolicy: false } } }],
    bypassActors: [{ repositoryRoleDatabaseId: ADMIN_ROLE, bypassMode: "ALWAYS" }],
  };
}

/**
 * Merge: the canon rule "merge only with green checks" is held by GitHub, not by the agent's memory. Required checks
 * are those green on each of the last merged PRs; a check missing from a fresh head (the last merged PR, open ones with
 * finished checks) would hold the PR forever — it leaves the list rather than gets into it. Someone else's rule with
 * checks isn't duplicated; our own ruleset with strict is fixed: GitHub must merge a branch that fell behind.
 */
function analyzeMerge(m: Merge, repositoryId: string, merge: ((text: string, ...steps: Step[]) => void) & { skip: (why: string) => void }): void {
  if (m.unavailable) return merge.skip(`branch rules are unavailable: ${m.unavailable}`);
  const fresh = [...m.merged.slice(-1), ...m.open];
  const gone = (c: string) => fresh.find((h) => !(c in h.checks));
  const stable = Object.keys(m.merged[0]?.checks ?? {})
    // stricter than task show: a check skipped by a condition or neutral checked nothing — only pass makes it required
    .filter((c) => m.merged.every((h) => h.checks[c] === "pass") && !gone(c))
    .sort();
  const enforced = m.rules.some((r) => r.contexts.length);
  const list = (cs: string[]) => cs.map(q).join(", ");
  const none = `the last merged PRs have no common green check — nothing to make required`;
  const own = m.own;
  if (!own) {
    if (enforced) return;
    if (!stable.length) return merge.skip(none);
    const text = `create ruleset ${q(RULESET)} on ${m.branch}: required ${list(stable)}, bypass — admin`;
    const step: Step = { kind: "api", text, mutations: [{ op: "CreateRuleset", input: { sourceId: repositoryId, ...rulesetInput(stable) } }] };
    return merge(`no rule with required checks: a branch with a red check can be merged`, step);
  }
  const want = [...new Set([...own.contexts.filter((c) => !gone(c)), ...stable])].sort();
  const step: Step = { kind: "api", text: `ruleset ${q(RULESET)}: default branch, required ${list(want) || "—"}, bypass — admin`, mutations: [{ op: "UpdateRuleset", input: { repositoryRulesetId: own.id, ...rulesetInput(want) } }] };
  const why: string[] = [];
  if (own.enforcement !== "ACTIVE") why.push(`ruleset ${q(own.name)} — ${own.enforcement}, not in effect`);
  if (!own.include.includes("~DEFAULT_BRANCH")) why.push(`ruleset ${q(own.name)} is not on the default branch: ${own.include.join(", ") || "—"}`);
  if (own.strict) why.push(`ruleset ${q(own.name)}: strict is on — GitHub won't merge a branch that fell behind`);
  if (!own.bypassAdmin) why.push(`ruleset ${q(own.name)}: admin can't bypass — no direct push to ${m.branch}`);
  for (const c of own.contexts.filter((x) => gone(x))) why.push(`required ${q(c)} didn't come to PR #${gone(c)!.number} — the PR would wait for it forever`);
  const add = stable.filter((c) => !own.contexts.includes(c));
  if (add.length) why.push(`green on the last ${m.merged.length} merged PRs, but not required: ${list(add)}`);
  for (const w of why) merge(w, step);
  if (!why.length && !enforced && !want.length) merge.skip(none);
}

/**
 * The merge method is rebase only (the canon, "PR"): the merge rule is the same for all repositories —
 * `gh pr merge <N> --rebase`, the branch's own commits go into the default branch. The repository setting keeps the
 * rule constant: a PR can't be merged another way, and rebase isn't turned off. All causes — one request.
 */
function analyzeMethod(m: Merge, slug: string, method: (text: string, ...steps: Step[]) => void): void {
  const step: Step = {
    kind: "api",
    text: "keep only rebase: turn off merge commit and squash, turn on rebase",
    url: `https://github.com/${slug}/settings`,
    mutations: [{ op: "UpdateRepository", input: { repo: slug, allow_merge_commit: false, allow_squash_merge: false, allow_rebase_merge: true } }],
  };
  if (!m.methods.rebase) method("rebase is off — GitHub will refuse gh pr merge --rebase", step);
  if (m.methods.merge) method("merge commit is allowed", step);
  if (m.methods.squash) method("squash is allowed", step);
}

// ----------------------------------------------------------------------------
// Commands
// ----------------------------------------------------------------------------

function header(io: Io, s: State): void {
  io.out(`Project ${s.repo.nameWithOwner}: ${s.project ? s.project.url : "none"}`);
}

function report(io: Io, s: State, checks: Check[]): boolean {
  for (const c of checks) {
    if (c.skip) {
      io.out(`➖ ${c.title} — ${c.skip}`);
      continue;
    }
    io.out(`${c.problems.length ? "❌" : "✅"} ${c.title}`);
    for (const pr of c.problems) io.out(`   · ${pr.text}`);
    for (const n of c.notes) io.out(`   ○ ${n}`);
  }
  if (s.project && !s.repo.owner.org) io.out(`➖ ${PRIORITY} and issue types — a personal account has none`);
  return checks.every((c) => !c.problems.length);
}

export function cmdCheck(io: Io, slug: string): number {
  const s = loadState(io, slug);
  header(io, s);
  return report(io, s, analyze(s)) ? 0 : 1;
}

/** No project: link the owner's project of the same name, otherwise copy the template, otherwise create one. */
function ensureProject(io: Io, s: State, template: string | null): string {
  const found = graphql(io, Q.OwnerProjects, { login: s.repo.owner.login, query: s.repo.name })?.repositoryOwner?.projectsV2?.nodes ?? [];
  const same = found.find((p: Any) => p && p.title === s.repo.name && !p.closed);
  const link = (p: ProjectRef) => mutate(io, { op: "LinkProject", input: { projectId: p.id, repositoryId: s.repo.id } });
  if (same) {
    link(same);
    return `linked project ${q(same.title)} (${same.url})`;
  }
  if (template) {
    const [login, number] = template.split("/");
    let tpl: Any = null;
    try {
      tpl = graphql(io, Q.TemplateProject, { login, number: Number(number) })?.repositoryOwner?.projectV2 ?? null;
    } catch (e) {
      io.err(`template ${template} is unavailable: ${(e as Error).message}`);
    }
    if (tpl) {
      const copy = mutate(io, { op: "CopyProject", input: { projectId: tpl.id, ownerId: s.repo.owner.id, title: s.repo.name, includeDraftIssues: false } }).copyProjectV2.projectV2;
      link(copy);
      return `project ${q(s.repo.name)} — a copy of template ${template} (${copy.url}), linked`;
    }
    io.err(`template ${template} not found — the project is created from scratch`);
  }
  const created = mutate(io, { op: "CreateProject", input: { ownerId: s.repo.owner.id, title: s.repo.name, repositoryId: s.repo.id } }).createProjectV2.projectV2;
  return `created project ${q(s.repo.name)} (${created.url}), linked`;
}

/**
 * `create` — connect a board where there is none (#847, question 1: the board is optional, `install` connects none):
 * without it fix leaves the repository without one and fixes the rest.
 */
export function cmdFix(io: Io, slug: string, opts: { confirm: boolean; template: string | null; create: boolean }): number {
  const done: string[] = [];
  const failed: string[] = [];
  const tried = new Set<string>();
  const sticky: Step[] = [];
  let s = loadState(io, slug);
  // Rounds: a step may open the next one (a new Status field → the tasks' statuses); a step isn't done twice.
  for (let round = 0; round < 5; round++) {
    if (!s.project && opts.create) {
      try {
        done.push(ensureProject(io, s, opts.template));
      } catch (e) {
        failed.push(`project: ${(e as Error).message}`);
        break;
      }
      s = loadState(io, slug);
      if (!s.project) break;
      continue;
    }
    const all = analyze(s).flatMap((c) => [...c.problems.flatMap((pr) => pr.steps), ...(opts.confirm ? c.cleanup : [])]);
    sticky.push(...all.filter((st) => st.sticky));
    const steps = all
      .filter((st) => st.mutations?.length && (st.kind === "api" || (st.kind === "confirm" && opts.confirm)) && !tried.has(st.text));
    if (!steps.length) break;
    for (const st of steps) {
      // several discrepancies may share one step (editing the whole ruleset) — it's done once
      if (tried.has(st.text)) continue;
      tried.add(st.text);
      try {
        for (const m of st.mutations!) mutate(io, m);
        done.push(st.text);
      } catch (e) {
        failed.push(`${st.text}: ${(e as Error).message}${st.url ? ` — in the UI: ${st.url}` : ""}`);
      }
    }
    s = loadState(io, slug);
  }

  header(io, s);
  for (const d of done) io.out(`+ ${d}`);
  for (const f of failed) io.out(`! ${f}`);
  const checks = analyze(s);
  const left = [...sticky, ...checks.flatMap((c) => c.problems.flatMap((pr) => pr.steps))];
  const uniq = (xs: Step[]) => xs.filter((x, i) => xs.findIndex((y) => y.text === x.text) === i);
  const ui = uniq(left.filter((st) => st.kind === "ui"));
  const confirm = uniq(left.filter((st) => st.kind === "confirm" && !opts.confirm));
  if (ui.length) {
    io.out("UI steps — in the session's browser, without a browser — for the user; then check again:");
    ui.forEach((st, i) => io.out(`${i + 1}. ${st.text} — ${st.url}`));
  }
  if (confirm.length) {
    io.out("Confirmation needed from the user — then fix --confirm:");
    confirm.forEach((st, i) => io.out(`${i + 1}. ${st.text}${st.url ? ` (or in the UI: ${st.url})` : ""}`));
  }
  // not discrepancies: the project is by the canon without them, the exit code doesn't wait for them
  const cleanup = opts.confirm ? [] : uniq(checks.flatMap((c) => c.cleanup));
  if (cleanup.length) {
    io.out("Optional, on the user's confirmation — fix --confirm:");
    cleanup.forEach((st, i) => io.out(`${i + 1}. ${st.text}`));
  }
  io.out("Summary:");
  const ok = report(io, s, checks);
  return ok && !failed.length && !ui.length && !confirm.length ? 0 : 1;
}

// ----------------------------------------------------------------------------
// Tasks
// ----------------------------------------------------------------------------

interface Issue {
  id: string;
  number: number;
  title: string;
  state: string;
  stateReason: string | null;
  url: string;
  type: string | null;
  labels: string[];
  parent: { id: string; number: number } | null;
  subIssues: { number: number; state: string; title: string }[];
  /** The issues blocking this one (blocked by), closed ones and other repositories' included. */
  blockers: Blocker[];
  /** The task's milestone and the number of open tasks in it (including this one if it's open). */
  milestone: { id: string; number: number; title: string; open: number } | null;
  /** PRs that close the task ("Closes #N"), closed ones included: whether merged, head and base. */
  prs: { number: number; state: string; merged: boolean; head: string; base: string }[];
  items: { id: string; projectId: string; status: string | null }[];
  priority: string | null;
}

/**
 * A blocker (blocked by): GitHub links an issue of another repository too, of another owner as well — an external
 * blocker, its number alone would name a task of this repository.
 */
interface Blocker {
  number: number;
  state: string;
  repo: string;
}

/** A blocker in a line: of this repository — `#N`, of another — `owner/repo#N`. */
const blockerRef = (slug: string, b: { number: number; repo: string }) => (b.repo.toLowerCase() === slug.toLowerCase() ? `#${b.number}` : `${b.repo}#${b.number}`);

function loadIssue(io: Io, slug: string, number: number): Issue {
  const [owner, name] = slug.split("/");
  const i = graphql(io, Q.IssueRef, { owner, name, number })?.repository?.issue;
  if (!i) throw new GhError(`no issue #${number} in ${slug}`);
  return {
    id: i.id,
    number: i.number,
    title: i.title,
    state: i.state,
    stateReason: i.stateReason ?? null,
    url: i.url,
    type: i.issueType?.name ?? null,
    labels: (i.labels?.nodes ?? []).map((l: Any) => l.name),
    parent: i.parent ? { id: i.parent.id, number: i.parent.number } : null,
    subIssues: i.subIssues?.nodes ?? [],
    blockers: (i.blockedBy?.nodes ?? []).map((b: Any) => ({ number: b.number, state: b.state, repo: b.repository?.nameWithOwner ?? slug })),
    milestone: i.milestone ? { id: i.milestone.id, number: i.milestone.number, title: i.milestone.title, open: i.milestone.issues?.totalCount ?? 0 } : null,
    prs: (i.closedByPullRequestsReferences?.nodes ?? []).map((p: Any) => ({ number: p.number, state: p.state ?? "", merged: Boolean(p.merged), head: p.headRefName ?? "", base: p.baseRefName ?? "main" })),
    items: (i.projectItems?.nodes ?? []).map((it: Any) => ({ id: it.id, projectId: it.project.id, status: it.status?.name ?? null })),
    priority: (i.issueFieldValues?.nodes ?? []).find((v: Any) => v?.field?.name === PRIORITY)?.name ?? null,
  };
}

/** The repository's board: its project with Status by the canon. */
interface Board {
  project: Project;
  status: Field;
}

interface TaskCtx {
  slug: string;
  repo: State["repo"];
  /**
   * The board is optional (#847): no open project linked to the repository — null. The commands go the same way, a
   * board's step is an `○` line (`noBoard`), the status — by the facts (`factStatus`).
   */
  board: Board | null;
}

/** The repository's task context, once per command (`main` clears it): the board doesn't change while a command runs. */
const contexts = new Map<string, TaskCtx>();

/**
 * The repository and its board with Status by the canon. No board — a context without it (#847); a board with Status
 * not per the canon — run project fix first. If the Status options are not in the project language but in another
 * dictionary language (the script wasn't called from the project checkout; the language changed and there was no fix
 * yet), the task is handled in the board's language: `project check` checks the language, not every command.
 */
function taskContext(io: Io, slug: string): TaskCtx {
  const known = contexts.get(slug.toLowerCase());
  if (known) return known;
  const repo = loadRepo(io, slug);
  const main = mainProject(repo);
  let board: Board | null = null;
  if (main) {
    const project = loadProject(io, main.id, false);
    const status = project.fields.find((f) => f.name === STATUS && f.options);
    const onBoard = (n: Names) => !!status && [n.status.backlog, n.status.inProgress, n.status.done].every((name) => status.options!.some((o) => o.name === name));
    const names = onBoard(N) ? N : locale.everyNames().find(onBoard);
    if (!status || !names) throw new GhError(`the project's ${STATUS} is not per the canon — github project fix first`);
    N = names;
    board = { project, status };
  }
  const ctx = { slug, repo, board };
  contexts.set(slug.toLowerCase(), ctx);
  return ctx;
}

const isEpic = (i: Issue, org: boolean) => (org ? locale.every((n) => n.issueTypes.epic).includes(i.type ?? "") : i.labels.includes(EPIC_LABEL));
const itemIn = (board: Board, i: Pick<Issue, "items">) => i.items.find((it) => it.projectId === board.project.id) ?? null;

function setStatus(io: Io, board: Board, itemId: string, name: string): void {
  const optionId = board.status.options!.find((o) => o.name === name)!.id;
  mutate(io, { op: "SetItemStatus", input: { projectId: board.project.id, itemId, fieldId: board.status.id, value: { singleSelectOptionId: optionId } } });
}

/**
 * The task's item in the project; none — add it. The project may have added the task itself (projectV2Ids in
 * createIssue, auto-add) while reading doesn't show it yet: addProjectV2ItemById then answers "Content already
 * exists" — re-read after a pause.
 */
function ensureItem(io: Io, ctx: TaskCtx, board: Board, i: Pick<Issue, "id" | "number" | "items">): { id: string; added: boolean } {
  const it = itemIn(board, i);
  if (it) return { id: it.id, added: false };
  try {
    return { id: mutate(io, { op: "AddItem", input: { projectId: board.project.id, contentId: i.id } }).addProjectV2ItemById.item.id, added: true };
  } catch (e) {
    if (!/already exists/i.test((e as Error).message)) throw e;
  }
  for (let k = 0; k < 5; k++) {
    (io.sleep ?? pause)(1000);
    const again = itemIn(board, loadIssue(io, ctx.slug, i.number));
    if (again) return { id: again.id, added: false };
  }
  throw new GhError(`#${i.number} is already in the project, but its item isn't visible — retry: github task status ${i.number} <status>`);
}

/**
 * The task's Status on the board — its item, added if missing; no board (#847) — nothing is written: null, the
 * caller prints `noBoard`. `added` — the task wasn't on the board.
 */
function putStatus(io: Io, ctx: TaskCtx, i: Pick<Issue, "id" | "number" | "items">, name: string): { added: boolean } | null {
  if (!ctx.board) return null;
  const item = ensureItem(io, ctx, ctx.board, i);
  setStatus(io, ctx.board, item.id, name);
  return { added: item.added };
}

/** A board's step skipped (#847): the `○` line of the task with what isn't written and where the status comes from. */
const noBoard = (number: number, what: string) =>
  `○ #${number}: ${what} — no board (GitHub Projects): the status is by the facts — the task's branch on origin, an open PR or a session pin — in work, closed as completed — done`;

/** The task's branches on origin, or every branch — `refs/heads/*` of the repository on GitHub (`Q.TaskBranches`). */
function originBranches(io: Io, slug: string, number?: number): string[] {
  const [owner, name] = slug.split("/");
  return pages<Any>((after) => graphql(io, Q.TaskBranches, { owner, name, query: number === undefined ? null : `/${number}-`, after }).repository.refs)
    .map((r) => String(r?.name ?? ""))
    .filter((b) => number === undefined || isTaskBranch(b, number));
}

/** The tasks pinned to sessions on this machine (`<config directory>/sessions/*`), `owner/repo#N` in lower case. */
function machinePins(io: Io): Set<string> {
  const dir = path.join(configDir(io.env), "sessions");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => !f.startsWith(".")) : [];
  return new Set(files.flatMap((f) => [sessionPin(readFileSync(path.join(dir, f), "utf8"))].filter((p) => p !== null).map((p) => `${p!.slug}#${p!.number}`.toLowerCase())));
}

/** What puts a task in work without a board (#847): its branches on origin and the session pins of this machine. */
interface WorkFacts {
  branches: (number: number) => string[];
  pinned: (number: number) => boolean;
}

/**
 * The facts, read once: `many` — of many tasks (a queue): all the repository's branches in one listing; otherwise — a
 * task's own branches by its number. The pins — once.
 */
function workFacts(io: Io, slug: string, many = false): WorkFacts {
  let all: string[] | null = null;
  const own = new Map<number, string[]>();
  let pins: Set<string> | null = null;
  return {
    branches: (n) => (many ? (all ??= originBranches(io, slug)).filter((b) => isTaskBranch(b, n)) : (own.get(n) ?? own.set(n, originBranches(io, slug, n)).get(n)!)),
    pinned: (n) => (pins ??= machinePins(io)).has(`${slug}#${n}`.toLowerCase()),
  };
}

/**
 * A task's status by the facts — a repository without a board (#847): closed as completed — Done; closed otherwise (not
 * planned, a duplicate) — none: it isn't done; open — In progress with an open PR (`openPr`, the caller's: linked or
 * found), a task branch `*\/N-*` on origin or a session pin on this machine, otherwise Backlog. `why` — the fact.
 */
function factStatus(i: Pick<Issue, "number" | "state" | "stateReason">, openPr: number | undefined, facts: WorkFacts): { status: string | null; why: string } {
  if (i.state !== "OPEN") return i.stateReason === "COMPLETED" ? { status: N.status.done, why: "closed as completed" } : { status: null, why: "closed, not done" };
  if (openPr !== undefined) return { status: N.status.inProgress, why: `open PR #${openPr}` };
  const branch = facts.branches(i.number)[0];
  if (branch) return { status: N.status.inProgress, why: `branch ${branch} on origin` };
  if (facts.pinned(i.number)) return { status: N.status.inProgress, why: "a session pin" };
  return { status: N.status.backlog, why: "no task branch, open PR or session pin" };
}

/** The task's status — on the board, without one (#847) — by the facts. */
function taskStatus(ctx: TaskCtx, i: Issue, openPr: number | undefined, facts: () => WorkFacts): string | null {
  return ctx.board ? (itemIn(ctx.board, i)?.status ?? null) : factStatus(i, openPr, facts()).status;
}

/**
 * The personal configuration directory — `ELVES_CONFIG_DIR`, otherwise `~/.config/elves`: one expression for all
 * scripts (the Elves `scripts#config-dir` standard) rather than a shared module — github imports no other skill
 * (tests/standards/scripts/skill-imports).
 */
function configDir(env: Io["env"]): string {
  const home = env["HOME"] || os.homedir();
  return env["ELVES_CONFIG_DIR"] || path.join(home, ".config", "elves");
}

/** The session pin file — `<config directory>/sessions/<session id>`; the session isn't identified — null. */
function pinFile(io: Io): string | null {
  const id = io.env["CLAUDE_CODE_SESSION_ID"];
  return id ? path.join(configDir(io.env), "sessions", id) : null;
}

/**
 * The session pin: `owner/repo#N` — the task, anything else — not a pin. est has the same parse: github imports no other
 * skill (tests/standards/scripts/skill-imports, tests/standards/scripts/session-pin).
 */
export function sessionPin(text: string): { slug: string; number: number } | null {
  const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(text.trim());
  return m ? { slug: m[1]!, number: Number(m[2]) } : null;
}

/** The line `task status` writes into the pin file — sessionPin of every skill reads it back as the same task. */
export function pinLine(slug: string, number: number): string {
  return `${slug}#${number}\n`;
}

/**
 * The session pin: its file, the line and the task in it — the line isn't `owner/repo#N`, task null: not a pin; no file
 * or the session isn't identified — null.
 */
function pinnedTask(io: Io): { file: string; line: string; task: { slug: string; number: number } | null } | null {
  const file = pinFile(io);
  if (!file || !existsSync(file)) return null;
  const line = readFileSync(file, "utf8").trim();
  return { file, line, task: sessionPin(line) };
}

/**
 * Another task isn't taken in a session with a task (#546): the question to the owner whether to queue it, and its "yes"
 * — a background executor this session launches right away, with the prompt `executorPrompt`. Not a new session: a
 * session card waited for the owner's click, and its work fell out of this session's sight.
 */
function queueQuestion(slug: string, number: number, epic: number | null): string {
  return `the question to the owner «queue #${number}?» — yes: ${EXECUTOR_AGENT}, its prompt: ${executorPrompt(slug, number, epic)}`;
}

/** The refusal of another task in a session with a pinned one: the pinned task, the queue question, the pin's file. */
function anotherTask(runs: string, file: string, slug: string, number: number, epic: number | null): GhError {
  return new GhError(`the session runs ${runs}; #${number} isn't taken here — ${queueQuestion(slug, number, epic)} (pin: ${file} — a mistaken one is removed by a human)`);
}

/**
 * A session runs one task: the first one taken "In progress" is pinned to the session, another is refused before any
 * change. The key is the session id (a subagent has the same one, /clear changes it), not the checkout: session
 * worktrees are reused. No command removes the pin — a human removes a mistaken one by deleting the file. A task handed
 * out to an executor of this session (`handedOutFile`) isn't pinned and isn't refused: the executor is a subagent with
 * the session's id — in a dispatcher session and, since #546, in one with its own task.
 */
function pinTask(io: Io, slug: string, number: number, epic: number | null): void {
  const file = pinFile(io);
  if (!file) return io.out("○ session not recognized (no CLAUDE_CODE_SESSION_ID) — the task isn't pinned");
  const task = `${slug}#${number}`;
  const held = pinnedTask(io)?.task;
  const runs = held ? `${held.slug}#${held.number}` : null;
  if (runs === task) return;
  if (handedOut(io, slug).some((h) => h.number === number)) {
    return io.out(`○ #${number} is handed out to an executor of this session — not pinned: the executor is a subagent with the session's id, est links the work by «${N.subagentPrompt.task} #${number}» in the assignment`);
  }
  if (runs) throw anotherTask(runs, file, slug, number, epic);
  if (isDispatcher(io)) {
    return io.out(`○ dispatcher session: #${number} isn't pinned — its executor is a subagent with the session's id, est links the work by «${N.subagentPrompt.task} #${number}» in the assignment`);
  }
  const created = (f: string, text: string) => {
    try {
      writeFileSync(f, text, { flag: "wx" });
      return true;
    } catch (e) {
      if ((e as Any)?.code !== "EEXIST") throw e;
      return false;
    }
  };
  mkdirSync(path.dirname(file), { recursive: true });
  // the configuration directory may be a personal git checkout (ELVES_PRIVATE) — pins aren't committed into it
  created(path.join(path.dirname(file), ".gitignore"), "*\n");
  if (created(file, pinLine(slug, number))) return;
  const now = pinnedTask(io)!;
  // not a pin — the session is free for est too: the file takes the task
  if (!now.task) {
    writeFileSync(file, pinLine(slug, number));
    return io.out(`○ the session pin ${file} held «${now.line}», not owner/repo#N — replaced with ${task}`);
  }
  // pinned by a parallel call meanwhile
  const pinnedNow = `${now.task.slug}#${now.task.number}`;
  if (pinnedNow !== task) throw anotherTask(pinnedNow, file, slug, number, epic);
}

/**
 * The dispatcher marker — `<config directory>/dispatchers/<session id>` with the queue command (`task queue`): the
 * session hands tasks out to background subagents, and they share its id — a pin would refuse the second executor and
 * give est the whole session as one task. The session isn't identified — null.
 */
function dispatcherFile(io: Io): string | null {
  const id = io.env["CLAUDE_CODE_SESSION_ID"];
  return id ? path.join(configDir(io.env), "dispatchers", id) : null;
}

const isDispatcher = (io: Io) => {
  const file = dispatcherFile(io);
  return !!file && existsSync(file);
};

/**
 * The tasks handed out to the dispatcher's executors — `<marker>.tasks`, a line `owner/repo#N <worktree>` per `task
 * queue --assignment N` in the session (#513): the executor's first call, In progress comes later, after the task's
 * questions, and till then the queue gave the task out as ready. A separate file: executors append to it in parallel,
 * the queue rewrites the marker. It lives for the session: after the app restarts, the stopped executors are continued
 * with `SendMessage` (`task resume`) — dropped, it would make a task not yet In progress ready for a second executor.
 * The worktree — the checkout the executor called its assignment in (#533): the queue keeps it while the task is open.
 * An app executor session's (`--assignment N --session`, #624) — `SESSION_HANDOUT` in its place: the dispatcher printed
 * its prompt, the app makes the session's worktree later.
 * A task past the batch (`--assignment N --main`, #697) — `MAIN_HANDOUT` as the line's last word: its PR goes into the
 * default branch, the queue names it so and the batch's release doesn't wait for it; the fix of red main handed out into
 * the batch before its release opened — the same mark, a line `pr premerge` appends (#889, `markPastBatch`).
 */
const handedOutFile = (io: Io) => {
  const file = dispatcherFile(io);
  return file && `${file}.tasks`;
};

/** A hand-out: the task and its executor's worktree; the assignment called outside a checkout or a session one — null. */
interface HandOut {
  number: number;
  worktree: string | null;
  /** Who executes it: a subagent of this session; an app session (#624) — the end of each of its turns comes as the app's note. */
  executor: "subagent" | "session";
  /** Past the dispatcher's batch (#697): the PR into the default branch, the release doesn't wait for it. */
  main: boolean;
}

/** An app executor session's mark in place of the worktree (#624): a worktree is an absolute path, the app makes the session's after the hand-out. */
const SESSION_HANDOUT = "@session";
/** A hand-out past the batch (#697) — the line's last word, after the worktree or the executor's mark. */
const MAIN_HANDOUT = "@main";

/** The repository's tasks handed out to this dispatcher's executors (`handedOutFile`); a line without a worktree — `null`. */
function handedOut(io: Io, slug: string): HandOut[] {
  const file = handedOutFile(io);
  return file ? handOutsIn(file, slug) : [];
}

/**
 * The repository's hand-outs in a `<session id>.tasks` file; no file — none. A task's line past the batch — the mark
 * of each of its lines: `pr premerge` appends it to a hand-out of the batch (#889, `markPastBatch`).
 */
function handOutsIn(file: string, slug: string): HandOut[] {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n").map((l) => l.trim());
  const all = lines
    .filter((l) => l.startsWith(`${slug}#`))
    .map((l) => {
      const [number, ...rest] = l.slice(slug.length + 1).split(" ");
      const main = rest.at(-1) === MAIN_HANDOUT;
      const worktree = (main ? rest.slice(0, -1) : rest).join(" ").trim();
      const executor: HandOut["executor"] = worktree === SESSION_HANDOUT ? "session" : "subagent";
      return { number: Number(number), worktree: executor === "subagent" ? worktree || null : null, executor, main };
    })
    .filter((h) => Number.isInteger(h.number) && h.number > 0);
  const past = new Set(all.filter((h) => h.main).map((h) => h.number));
  return all.map((h) => ({ ...h, main: past.has(h.number) }));
}

/**
 * The hand-outs of `numbers` this dispatcher gave into its batch, marked past it (#889): the task's last line again with
 * `MAIN_HANDOUT` — appended, not rewritten: executors append to the file in parallel. Then `task finish`, a restart and
 * the queue lead the task into the default branch, as `--main`'s. Not handed out here or marked already — nothing. The
 * numbers marked.
 */
function markPastBatch(io: Io, slug: string, numbers: number[]): number[] {
  const file = handedOutFile(io);
  if (!file) return [];
  const handed = handOutsIn(file, slug);
  const marked: number[] = [];
  for (const n of numbers) {
    const last = handed.filter((h) => h.number === n).at(-1);
    if (!last || last.main) continue;
    const where = last.executor === "session" ? SESSION_HANDOUT : (last.worktree ?? "");
    appendFileSync(file, `${slug}#${n}${where ? ` ${where}` : ""} ${MAIN_HANDOUT}\n`);
    marked.push(n);
  }
  return marked;
}

/**
 * A batch branch (epic #645): the dispatcher's tasks merge into it, and it goes into the default branch with one release
 * — one full CI run and one deploy. `batch/<YYYY-MM-DD>-<k>` (question 4 of the epic): `release/*` is taken in git-flow
 * projects and gets mixed up with the flow's releases.
 */
const BATCH_BRANCH = /^batch\/(\d{4}-\d{2}-\d{2})-(\d+)$/;
const isBatchBranch = (branch: string) => BATCH_BRANCH.test(branch);

/**
 * The dispatcher's batch branches — the marker's lines `batch <owner/repo> <branch>` after the queue command
 * (`dispatcherFile`): the queue writes them, the executors' assignments read them — a subagent shares the session's id.
 * No marker — none.
 */
function batchesIn(file: string | null): { repo: string; branch: string }[] {
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((l) => /^batch (\S+\/\S+) (\S+)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => m !== null && isBatchBranch(m[2]!))
    .map((m) => ({ repo: m[1]!, branch: m[2]! }));
}

/** The repository's batch branch in this dispatcher session; none — null. */
function batchOf(io: Io, slug: string): string | null {
  return batchesIn(dispatcherFile(io)).find((b) => b.repo.toLowerCase() === slug.toLowerCase())?.branch ?? null;
}

/** The task is handed out past the batch (`--assignment N --main`, #697): its PR goes into the default branch. */
const handedPastBatch = (io: Io, slug: string, number: number) => handedOut(io, slug).some((h) => h.number === number && h.main);

/** The queue command of the dispatcher marker — its first line; the batch lines follow it. */
const queueCommandIn = (file: string) => readFileSync(file, "utf8").split("\n")[0]!.trim();

/** Today by the machine's clock — `YYYY-MM-DD`, the day of a batch branch's name. */
function localDay(): string {
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/**
 * The dispatcher's batch branch of the repository (epic #645). A batch project (`batchProject` of the locale module —
 * `"batch": true` in `.agents/elves.json` of the checkout's root: a project setting, not the owner's word on a run — a
 * batch saves only with the project's CI that runs nothing on a PR into a batch branch) without a batch in the marker
 * gets `start`, called by the queue only with a ready task to hand out (#787): a dispatcher with nothing to hand out
 * leaves no empty batch branch on origin. It creates the branch from a fresh origin/<base> and pushes it without a local
 * branch — the dispatcher's checkout stays where it is; `k` — the first free number of the day on origin, in the marker
 * and among the recent PRs' branches: a released batch's name taken again would read as released at once. The next
 * queues take the same one: the marker keeps it (`batchesIn`). Released — its release PR merged (#649), the branch may
 * still be on origin — or gone from origin: `start` too, its `+` line names the previous one. A released batch branch on
 * origin without an open PR into it goes (`dropReleased`). Not a batch project — null, no line; the session not
 * identified, the directory not the repository's checkout — a `○`/`!` line and null: the executors go into the default
 * branch, as without batches.
 * Origin not read — the kept one stays (a `!` line): a new batch next to it would split the dispatcher's tasks; a new
 * one not created — null.
 */
function dispatcherBatch(io: Io, slug: string, recent: Recent, file: string | null): { batch: string | null; start: (() => string | null) | null } {
  const none = { batch: null, start: null };
  if (!locale.batchProject(io.cwd ?? process.cwd())) return none;
  const base = recent.base;
  const off = `executors go into ${base}, as without batches`;
  if (!file) return io.out(`○ batch: true, but the session isn't recognized (no CLAUDE_CODE_SESSION_ID) — no batch branch: ${off}`), none;
  if (!checkoutOfRepo(io, originUrl(io), slug)) {
    return io.out(`! batch: true, but ${io.cwd ?? process.cwd()} isn't a checkout of ${slug} — no batch branch: ${off}; the dispatcher works in a checkout of ${slug}`), none;
  }
  const failed = (what: string, r: RunResult) => (io.out(`! ${what}: ${why(r)} — no batch branch: ${off}`), null);
  const kept = batchOf(io, slug);
  const listed = git(io, io.cwd, "ls-remote", "--heads", "origin");
  if (listed.status !== 0) {
    if (kept) return io.out(`! git ls-remote --heads origin: ${why(listed)} — the batch branch stays ${kept}`), { batch: kept, start: null };
    return failed("git ls-remote --heads origin", listed), none;
  }
  const heads = listed.stdout.split("\n").map((l) => (l.split("\t")[1] ?? "").trim().replace(/^refs\/heads\//, ""));
  dropReleased(io, recent, heads.filter(isBatchBranch));
  const keptRelease = kept ? releasePrOf(recent, kept) : undefined;
  if (kept && heads.includes(kept) && !keptRelease?.merged) return io.out(`○ batch branch ${kept} — the dispatcher's batch: the executors branch from it and merge into it`), { batch: kept, start: null };
  const start = () => {
    const fetched = git(io, io.cwd, "fetch", "-q", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`);
    if (fetched.status !== 0) return failed(`git fetch origin ${base}`, fetched);
    const parsed = git(io, io.cwd, "rev-parse", "--verify", `refs/remotes/origin/${base}^{commit}`);
    // an empty source of a refspec deletes the ref — the push goes only with the commit's SHA
    const sha = parsed.status === 0 ? parsed.stdout.trim() : "";
    if (!/^[0-9a-f]{40,64}$/.test(sha)) return failed(`git rev-parse origin/${base}`, parsed);
    const day = localDay();
    const named = [...heads, kept ?? "", ...recent.nodes.flatMap((p) => [p.headRefName ?? "", p.baseRefName ?? ""])];
    const taken = named.map((b) => BATCH_BRANCH.exec(b)).flatMap((m) => (m && m[1] === day ? [Number(m[2])] : []));
    const name = `batch/${day}-${Math.max(0, ...taken) + 1}`;
    const pushed = git(io, io.cwd, "push", "-q", "origin", `${sha}:refs/heads/${name}`);
    if (pushed.status !== 0) return failed(`git push origin ${name}`, pushed);
    const previous = !kept ? "" : keptRelease?.merged ? ` — ${kept} is released by PR #${keptRelease.number}` : ` — ${kept} is gone from origin (released)`;
    io.out(`+ batch branch ${name} from origin/${base} (${sha.slice(0, 7)}) pushed${previous}: the executors branch from it and merge into it`);
    return name;
  };
  return { batch: null, start };
}

/**
 * A PR in one shape (#650): a GraphQL node (`headRefName`, `headRefOid`), a REST row (`head.ref`, `merged_at`) or a
 * task's PR (`head` and `base` — strings) — the batch rules below read every source by one function each.
 */
interface PrRef {
  number: number;
  state: "OPEN" | "MERGED" | "CLOSED";
  merged: boolean;
  head: string;
  base: string;
  body: string;
  /** The head commit; not read — "". */
  sha: string;
}

function prRef(p: Any): PrRef {
  if (p.head && typeof p.head === "object") {
    const merged = Boolean(p.merged_at) || p.merged === true;
    return { number: p.number, state: p.state === "open" ? "OPEN" : merged ? "MERGED" : "CLOSED", merged, head: p.head.ref ?? "", base: p.base?.ref ?? "", body: p.body ?? "", sha: p.head.sha ?? "" };
  }
  const merged = Boolean(p.merged);
  return { number: p.number, state: p.state || (merged ? "MERGED" : "OPEN"), merged, head: p.headRefName ?? p.head ?? "", base: p.baseRefName ?? p.base ?? "", body: p.body ?? "", sha: p.headRefOid ?? "" };
}

/**
 * The batch's release PR (#649) — one rule for GraphQL's and REST's PRs: its head is the batch branch, its base the
 * default branch, open or merged — the first one of those given (they come newest first); none — undefined.
 */
function releaseOf(prs: Any[], batch: string, main: string): PrRef | undefined {
  return prs.map(prRef).find((p) => p.head === batch && p.base === main && p.state !== "CLOSED");
}
const releasePrOf = (recent: Recent, batch: string) => releaseOf(recent.nodes, batch, recent.base);

/**
 * The tasks of a PR (#650 — one rule): the task branch's number and «Closes #N» of its body — GitHub links a PR to a
 * task only by a merge into the default branch, so a batch's PRs are found by these; `why` — what each one is found by.
 */
function taskLinks(p: Any): { number: number; why: string }[] {
  const r = prRef(p);
  const branch = taskBranch(r.head);
  const out = branch ? [{ number: branch.issue, why: `branch ${r.head}` }] : [];
  for (const n of closingInBody(r.body)) if (!out.some((x) => x.number === n)) out.push({ number: n, why: `«Closes #${n}» in the body` });
  return out;
}
const prTasks = (p: Any) => taskLinks(p).map((x) => x.number);
/** The PR is the task's: its branch is the task branch, or its body has «Closes #N». */
const prOfTask = (p: Any, number: number) => prTasks(p).includes(number);

/**
 * The task's PRs merged into a batch branch (#696): its branch or «Closes #N» — GitHub doesn't link a PR to a task by a
 * merge into another branch. One condition for the queue (`batchPrOf`), the release's branches (`cmdTaskClose`) and
 * what the release shipped (`shippedBy`).
 */
const mergedIntoBatch = (nodes: Any[], batch: string, number: number): Any[] => nodes.filter((p) => p.merged && p.baseRefName === batch && prOfTask(p, number));

/** Open PRs into the branch — a live executor's into a batch branch. */
const openInto = (recent: Recent, branch: string): Any[] => recent.nodes.filter((p) => p.state === "OPEN" && p.baseRefName === branch);

/**
 * Released batch branches still on origin (#649) — their release PR merged: without an open PR into them they are
 * deleted, a `+` line — merged into the default branch, nothing is lost (`git push --delete`, as task close does with a
 * merged branch); with one — kept, an `○` line: the live executor's PR goes into the next batch or the default branch
 * first (`pr premerge` says where) — deleting its base closes it or moves it into the default branch past the
 * dispatcher.
 */
function dropReleased(io: Io, recent: Recent, batches: string[]): void {
  for (const b of batches) {
    const release = releasePrOf(recent, b);
    if (!release?.merged) continue;
    const open = openInto(recent, b);
    if (open.length) {
      io.out(`○ batch branch ${b} kept: released by PR #${release.number}, open PR ${open.map((p) => `#${p.number}`).join(", ")} into it — its executor moves it to the next batch or ${recent.base} first (pr premerge says where)`);
      continue;
    }
    const d = git(io, io.cwd, "push", "-q", "origin", "--delete", b);
    io.out(d.status === 0 ? `+ batch branch ${b} deleted: released by PR #${release.number}, no open PR into it` : `! git push origin --delete ${b}: ${d.stderr.trim()}`);
  }
}

/** A path without symbolic links (`/var` → `/private/var` on macOS) — a worktree's and a hand-out's compare so; gone — as is. */
function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** The epic prefix — the part of the title before " · ": the titles of the epic and all its subtasks start with it. */
export function epicPrefix(title: string): string | null {
  const i = title.indexOf(" · ");
  return i > 0 ? title.slice(0, i) : null;
}

/**
 * A new task; an optional field takes `undefined` — the command line passes an option not given as is, under a
 * project's `exactOptionalPropertyTypes` too (tests/standards/exports/consumer-typecheck).
 */
export interface NewTask {
  title: string;
  body: string;
  /** The issue type; not given — a task. A personal account keeps none but the epic's label: a line says so. */
  type?: string | undefined;
  epic?: number | undefined;
  milestone?: string | undefined;
  blockedBy: number[];
  priority?: string | undefined;
  /**
   * Labels: a decision by name or a new decision `kind:name` (no label — it's created with the kind's color), regular
   * ones — existing.
   */
  labels?: string[] | undefined;
}

/**
 * The task description skeleton without `--body` — canon sections in the project language: scenarios (an epic has
 * none — it has no code) and questions.
 */
export const taskTemplate = (type: string): string =>
  type === N.issueTypes.epic ? `${N.sections.questions}\n` : `${N.sections.scenarios}\n\n${N.sections.questions}\n`;

export function cmdTaskNew(io: Io, slug: string, task: NewTask): number {
  const [owner, name] = slug.split("/");
  // a repository without a board (#847) — its board's step an `○` line
  const ctx = taskContext(io, slug);
  const org = ctx.repo.owner.org;

  // All checks come before creating: a task mustn't appear half-made. The type — a name in any dictionary language.
  const type = typeAliases()[(task.type ?? N.issueTypes.task).toLowerCase()];
  if (!type) throw new GhError(`--type: ${issueTypes().join(", ")}`);
  const o = { ...task, type, body: task.body.trim() ? task.body : taskTemplate(type) };
  const issueType = org ? ctx.repo.owner.issueTypes.find((t) => t.name === o.type && t.isEnabled) : undefined;
  if (org && !issueType) throw new GhError(`the organization has no enabled type ${q(o.type)} — github project fix`);
  // a personal account keeps neither a priority nor a Task/Bug type (#682): the flags are taken alike — the task is
  // created, a ○ line says what wasn't kept; a priority is still checked: a typo is a typo in either account
  if (!org && o.priority && !(PRIORITIES as readonly string[]).includes(o.priority)) throw new GhError(`--priority: ${PRIORITIES.join(", ")}`);
  let priority: { fieldId: string; optionId: string; name: string } | null = null;
  if (org) {
    const f = ctx.repo.owner.issueFields.find((x) => x.name === PRIORITY);
    if (!f) throw new GhError(`the organization has no issue field ${PRIORITY} — github project fix`);
    const want = o.priority ?? DEFAULT_PRIORITY;
    const opt = f.options.find((x) => x.name === want);
    if (!opt) throw new GhError(`--priority: ${f.options.map((x) => x.name).join(", ")}`);
    priority = { fieldId: f.id, optionId: opt.id, name: want };
  }
  let title = o.title.trim();
  const epic = o.epic === undefined ? null : loadIssue(io, slug, o.epic);
  if (epic) {
    if (!isEpic(epic, org)) throw new GhError(`#${epic.number} is not an epic (${org ? `the type is not ${q(N.issueTypes.epic)}` : `no ${EPIC_LABEL} label`})`);
    if (epic.state !== "OPEN") throw new GhError(`epic #${epic.number} is closed`);
    const prefix = epicPrefix(epic.title);
    if (prefix && !title.startsWith(`${prefix} · `)) title = `${prefix} · ${title}`;
  }
  const blockers = o.blockedBy.map((n) => loadIssue(io, slug, n));
  const needCtx = !!o.milestone || (!org && o.type === N.issueTypes.epic);
  const repoCtx = needCtx ? graphql(io, Q.TaskContext, { owner, name }).repository : null;
  const milestone = o.milestone ? (repoCtx.milestones.nodes as { id: string; title: string }[]).find((m) => m.title === o.milestone) : undefined;
  if (o.milestone && !milestone) throw new GhError(`no open milestone ${q(o.milestone)}`);
  const found: Any[] = graphql(io, Q.IssueSearch, { q: `repo:${slug} is:issue is:open in:title "${title.replaceAll('"', "")}"` }).search.nodes;
  const dup = found.find((x) => x?.title === title);
  if (dup) throw new GhError(`an open task with this title already exists: #${dup.number}`);
  const wanted = [...new Set(o.labels ?? [])];
  // open questions in the description — the questions label: on GitHub it marks the task waiting for the owner's answers
  const open = questionItems(o.body).filter((x) => !x.answered).map((x) => x.k);
  const repoLabels = wanted.length || open.length ? loadLabels(io, slug) : [];
  const has = (n: string) => repoLabels.find((x) => x.name === n);
  // a decision by name comes from the default branch; `kind:name` — also a new one that isn't there yet; a decision
  // label — its name may be a section's, whose label is the topic's
  const decisions = wanted.some((l) => newDecision(l) || !has(l) || labelKinds(has(l)!.description)) ? loadDecisions(io, slug) : null;
  const inMain = decisions ? decisionsByName(decisions) : new Map<string, DecisionKind[]>();
  const plan = wanted.map((l) => {
    const dec = newDecision(l);
    const name = dec?.name ?? l;
    const label = has(name);
    const main = inMain.get(name) ?? [];
    // a section has no label of its own: its changes label the topic (#688) — before the task is created
    // a regular label of the repository with a section's name is a different label, not checked
    const among = dec ? [dec.kind] : label ? labelKinds(label.description) : DECISION_KINDS;
    const topics = decisions && among && !main.length ? sectionTopics(decisions, name, among) : [];
    if (topics.length) {
      throw new GhError(`${name} is a section of topic ${topics.map(q).join(", ")}: the label is the topic's, a section has none — --labels ${topics.join(" or ")}`);
    }
    const kinds = dec && !main.includes(dec.kind) ? [...main, dec.kind] : main;
    const dim = dec && label ? labelDimension(label.description) : null;
    if (dim) throw new GhError(`label ${q(name)} is slice ${q(dim)}, not a decision label: decision ${name} isn't labeled; the slice label — --labels ${name}`);
    if (!label && !kinds.length) {
      throw new GhError(`no label ${q(l)} in the repository and no decision ${l} in the default branch; a new decision — kind:name (${DECISION_KINDS.map((k) => `${k}:${l}`).join(", ")})`);
    }
    return { name, label, kinds, decision: dec !== null || (label ? labelKinds(label.description) !== null : true), fresh: dec && !main.includes(dec.kind) ? `${name} — new decision: ${decisionPath(dec.kind, name)} is not in the default branch yet` : null };
  });

  const done: string[] = [];
  // a new label of the repository — its id
  const createLabel = (label: { name: string; color: string; description: string }): string => mutate(io, { op: "CreateLabel", input: { repositoryId: ctx.repo.id, ...label } }).createLabel.label.id as string;
  // the issue's labels — their ids
  const labels: string[] = [];
  if (issueType) done.push(`type ${q(o.type)}`);
  if (!org && o.type === N.issueTypes.epic) {
    let labelId: string | undefined = repoCtx.label?.id;
    if (!labelId) {
      labelId = createLabel(epicLabel());
      done.push(`created label ${q(EPIC_LABEL)}`);
    }
    labels.push(labelId);
    done.push(`label ${q(EPIC_LABEL)} — the type in a personal account`);
  }
  if (plan.length) {
    for (const x of plan) {
      let id = x.label?.id;
      if (!id) {
        id = createLabel(decisionLabel(x.name, x.kinds));
        done.push(`created label ${q(x.name)}`);
      }
      labels.push(id);
    }
    // the decision will appear in this task's PR — the label says so instead of failing
    done.push(`labels: ${plan.map((x) => x.name).join(", ")}`, ...plan.flatMap((x) => (x.fresh ? [x.fresh] : [])));
  }
  if (open.length) {
    let id = has(N.labels.questions)?.id;
    if (!id) {
      id = createLabel(questionsLabel());
      done.push(`created label ${q(N.labels.questions)}`);
    }
    // `--labels` may name it too
    if (!labels.includes(id)) labels.push(id);
    done.push(`label ${q(N.labels.questions)} — open questions in the description: ${open.join(", ")}`);
  }
  const input: Record<string, unknown> = { repositoryId: ctx.repo.id, title, body: o.body, ...(ctx.board ? { projectV2Ids: [ctx.board.project.id] } : {}) };
  if (issueType) input["issueTypeId"] = issueType.id;
  if (labels.length) input["labelIds"] = labels;
  if (milestone) input["milestoneId"] = milestone.id;
  if (epic) input["parentIssueId"] = epic.id;
  if (priority) input["issueFields"] = [{ fieldId: priority.fieldId, singleSelectOptionId: priority.optionId }];
  const created: { id: string; number: number; title: string; url: string; projectItems?: Any } = mutate(io, { op: "CreateIssue", input }).createIssue.issue;
  // We set Status ourselves, without waiting for the "Item added to project" workflow.
  const listed = (created.projectItems?.nodes ?? []).map((it: Any) => ({ id: it.id, projectId: it.project.id, status: null }));
  const boarded = putStatus(io, ctx, { id: created.id, number: created.number, items: listed }, N.status.backlog) !== null;
  if (boarded) done.push(`project ${q(ctx.board!.project.title)}: ${STATUS} ${q(N.status.backlog)}`);
  if (priority) done.push(`${PRIORITY} ${q(priority.name)}`);
  if (epic) done.push(`subtask of epic #${epic.number}`);
  for (const b of blockers) {
    if (b.state !== "OPEN") {
      done.push(`#${b.number} is closed — doesn't block, skipped`);
      continue;
    }
    mutate(io, { op: "AddBlockedBy", input: { issueId: created.id, blockingIssueId: b.id } });
    done.push(`blocked by #${b.number}`);
  }
  if (milestone) done.push(`milestone ${q(milestone.title)}`);
  // the epic accumulates its subtasks' decision labels — up to GitHub's limit: the task is already created, a failure
  // here would leave the epic without its labels and without a line about them (#574)
  const decided = plan.filter((x) => x.decision).map((x) => x.name);
  const epicLabels = epic && decided.length ? putLabels(io, epic, `epic #${epic.number}`, decided, null, loadLabels(io, slug)) : [];
  // the epic — no lower than its most urgent open subtask
  if (epic && priority) {
    const rank = (p: string | null) => (p === null ? PRIORITIES.length : (PRIORITIES as readonly string[]).indexOf(p));
    if (rank(priority.name) < rank(epic.priority)) {
      mutate(io, { op: "SetIssueField", input: { issueId: epic.id, issueFields: [{ fieldId: priority.fieldId, singleSelectOptionId: priority.optionId }] } });
      done.push(`${PRIORITY} of epic #${epic.number}: ${epic.priority ?? "—"} → ${priority.name}`);
    }
  }

  io.out(`Created #${created.number} ${created.title} — ${created.url}`);
  for (const d of done) io.out(`+ ${d}`);
  if (!boarded) io.out(noBoard(created.number, `${STATUS} ${q(N.status.backlog)} isn't set`));
  if (!org && o.priority) io.out(`○ ${PRIORITY} ${q(o.priority)} isn't kept: a personal account has no issue fields`);
  if (!org && task.type !== undefined && o.type !== N.issueTypes.epic) io.out(`○ type ${q(o.type)} isn't kept: a personal account has no issue types, only an epic gets its label`);
  for (const l of epicLabels) io.out(l);
  if (o.type === N.issueTypes.epic) {
    // an epic's work goes to the dispatcher on the owner's "yes" (#546), not to a session card per subtask
    io.out(
      `Next: once its subtasks are created — the question to the owner «run the dispatcher on epic #${created.number}?»; ` +
        `yes — bun --no-env-file ${import.meta.path} task queue --epic ${created.number} --repo ${slug} in this session, its executors — ${EXECUTOR_AGENT}.`,
    );
    return 0;
  }
  // a session with a pinned task won't take a new one into work (pinTask): the owner decides whether to queue it
  const held = pinnedTask(io)?.task;
  if (held) io.out(`Next: the session runs ${held.slug}#${held.number}; #${created.number} isn't taken here — ${queueQuestion(slug, created.number, epic?.number ?? null)}`);
  return 0;
}

export function cmdTaskStatus(io: Io, slug: string, number: number, name: string, branch?: string, next = true): number {
  const code = setTaskStatus(io, slug, number, name, branch);
  // the command's last line — the automaton's step (#842); task start prints its own after its lines
  if (next) nextOfTask(io, slug, number);
  return code;
}

function setTaskStatus(io: Io, slug: string, number: number, name: string, branch?: string): number {
  // status: a name in any dictionary language; checked before reading the project; the option is in the board's language
  if (!statusAliases()[name.toLowerCase()]) throw new GhError(`status: ${statusOptions().join(", ")}`);
  if (branch !== undefined && statusAliases()[name.toLowerCase()] !== N.status.inProgress) throw new GhError(`--branch — only with ${q(N.status.inProgress)}: the branch is renamed when the task is taken into work`);
  if (branch !== undefined && (taskBranch(branch)?.issue !== number || !TASK_SLUG_RE.test(branch))) {
    throw new GhError(`--branch ${q(branch)}: expected a branch of #${number} by the canon — [<area>/]<type>/${number}-<slug>, type ${TASK_TYPES.join("|")}, slug — Latin kebab-case`);
  }
  const ctx = taskContext(io, slug);
  const status = statusAliases()[name.toLowerCase()]!;
  const issue = loadIssue(io, slug, number);
  const epicTask = isEpic(issue, ctx.repo.owner.org);
  if (branch !== undefined && epicTask) throw new GhError(`--branch: #${number} is an epic — an epic has no branch`);
  // an epic isn't pinned: its session plans and hands out work, and the first subtask also sets the epic "In progress"
  if (status === N.status.inProgress && !epicTask) pinTask(io, slug, number, issue.parent?.number ?? null);
  // no board (#847): the pin and the branch are the facts that put the task in work
  const put = putStatus(io, ctx, issue, status);
  io.out(put ? `+ #${issue.number}: ${STATUS} ${q(status)}${put.added ? " (added to the project)" : ""}` : noBoard(issue.number, `${STATUS} ${q(status)} isn't set`));
  const code = branch === undefined || renameBranch(io, slug, branch) ? 0 : 1;
  if (!issue.parent) return code;
  const epic = loadIssue(io, slug, issue.parent.number);
  const epicStatus = ctx.board ? (itemIn(ctx.board, epic)?.status ?? null) : null;
  if (ctx.board && status === N.status.inProgress && epic.state === "OPEN" && (epicStatus === null || epicStatus === N.status.backlog)) {
    putStatus(io, ctx, epic, N.status.inProgress);
    io.out(`+ epic #${epic.number}: ${STATUS} ${q(N.status.inProgress)} — the first subtask is taken`);
  }
  if (status === N.status.inProgress && epic.state === "CLOSED") io.out(`Next: epic #${epic.number} is closed, but a subtask is in work again — reopen it (and its milestone, if closed).`);
  if (status === N.status.done && epic.state === "OPEN" && epic.subIssues.length && epic.subIssues.every((x) => x.state === "CLOSED")) {
    io.out(`Next: all subtasks of epic #${epic.number} are closed — close the epic${ctx.board ? ` and set it to ${q(N.status.done)}` : ""}.`);
  }
  return code;
}

/**
 * The app's deferred tools the flow calls in a task in Claude Code (claude/CLAUDE.md): naming the session, the PR
 * monitor without auto-fix, stopping own background tasks and archiving the session — one `ToolSearch` loads them all,
 * not one per call (#666).
 */
export const APP_TOOLS = ["mcp__ccd_session_mgmt__set_session_title", "mcp__ccd_pr__set_monitor", "TaskStop", "mcp__ccd_session_mgmt__archive_session"];

/** The marker of `project check` done in this session: `<config directory>/project-checks/<session id>`, a repository per line. */
function projectCheckFile(io: Io): string | null {
  const id = io.env["CLAUDE_CODE_SESSION_ID"];
  return id ? path.join(configDir(io.env), "project-checks", id) : null;
}

/**
 * `project check` once per session (AGENTS.md, "Task tracking"): green — one line and the marker, the next `task start`
 * of the session skips it; ❌ — the full report, false. The session isn't identified — checked every time.
 */
function projectChecked(io: Io, slug: string): boolean {
  const file = projectCheckFile(io);
  const done = file && existsSync(file) ? readFileSync(file, "utf8").split("\n").map((l) => l.trim().toLowerCase()) : [];
  if (done.includes(slug.toLowerCase())) return io.out(`= project check — done in this session`), true;
  const s = loadState(io, slug);
  const checks = analyze(s);
  if (checks.some((c) => c.problems.length)) {
    header(io, s);
    report(io, s, checks);
    return false;
  }
  io.out(`✅ project check: ${s.repo.nameWithOwner} per the canon${s.project ? "" : " — no board (GitHub Projects): a task's status is by the facts"}`);
  if (file) {
    mkdirSync(path.dirname(file), { recursive: true });
    // the configuration directory may be a personal git checkout (ELVES_PRIVATE) — markers aren't committed into it
    writeFileSync(path.join(path.dirname(file), ".gitignore"), "*\n");
    appendFileSync(file, `${slug}\n`);
  }
  return true;
}

/**
 * Taking a task in one call (#666) instead of ~11 flow turns: `project check` (once per session), the task as `task
 * show` prints it, then the stops before any change — its blockers by the queue's rules (`holdsOf`, #869: an open
 * blocked by, the external blocker label; one merged into this executor's batch doesn't hold), open questions of the task or its epic (they are asked first,
 * AGENTS.md, "Task tracking"), parallel work (an open PR of the task or its branch `*\/N-*` that isn't this checkout's
 * — continue it or wait for its merge); then `task status N "In progress" --branch` and what the agent needs next:
 * the session name, the branch, the scenarios and, in
 * Claude Code, one `ToolSearch` line for the app tools the flow calls. Code 1 — stopped, the task isn't taken.
 * `resume` — an executor's restart (#709, the assignment's restart line): the task's branch and open PR are the
 * previous executor's work to continue, not a stop; the current branch isn't renamed — the work goes on in the branch's
 * worktree or the branch checked out here. Nothing to continue — refused before any change: a first take is `--branch`.
 */
export function cmdTaskStart(io: Io, slug: string, number: number, branch?: string, resume = false): number {
  if (resume && branch !== undefined) throw new GhError(`--resume continues the task's existing branch — without --branch`);
  if (branch !== undefined && (taskBranch(branch)?.issue !== number || !TASK_SLUG_RE.test(branch))) {
    throw new GhError(`--branch ${q(branch)}: expected a branch of #${number} by the canon — [<area>/]<type>/${number}-<slug>, type ${TASK_TYPES.join("|")}, slug — Latin kebab-case`);
  }
  if (!projectChecked(io, slug)) return io.out(`Next: github project fix, then task start ${number} again — the task isn't taken`), 1;
  const t = showTask(io, slug, number);
  if (t.epic) throw new GhError(`#${number} is an epic — it isn't taken into work: the question to the owner «run the dispatcher on epic #${number}?», then task queue --epic ${number}`);
  if (t.state !== "OPEN") throw new GhError(`#${number} is closed — reopen it first (gh issue reopen ${number}), then task start`);
  for (const line of t.lines) io.out(line);
  // a blocked task isn't taken (#869) — by the queue's rules: what task queue doesn't hand out, task start doesn't take
  const holds = holdsOf(io, slug, number, t.blockers, t.labels);
  if (holds.length) {
    io.out(`! #${number} is blocked — ${holds.join("; ")} — the task isn't taken till they're lifted`);
    return endWith(io, STEP.blocked(readyIn(slug), "", number), 1);
  }
  const asked = [t.open.length ? `#${number}: ${t.open.join(", ")}` : "", t.epicOpen?.ks.length ? `epic #${t.epicOpen.number}: ${t.epicOpen.ks.join(", ")}` : ""].filter(Boolean);
  if (asked.length) {
    // the answer's command ready — of the task's first open question, otherwise of the epic's (#841); the step — the
    // automaton's (#842)
    const at = t.open.length ? { number, k: t.open[0]! } : { number: t.epicOpen!.number, k: t.epicOpen!.ks[0]! };
    io.out(`! open questions — ${asked.join("; ")}: the answers first, then task start ${number} again — the task isn't taken`);
    return endWith(io, STEP.questions(readyIn(slug), "", at, locale.autoProject(io.cwd ?? process.cwd())), 1);
  }
  const current = git(io, io.cwd, "branch", "--show-current").stdout.trim();
  const mine = (head: string) => head !== "" && head === current;
  const prs = [...t.prs.filter((p) => !p.merged && p.state === "OPEN"), ...unlinkedPrs(io, slug, number).batched.filter((p) => !p.merged && p.state === "OPEN")];
  const others = taskBranchesHere(io, slug, number).filter((b) => b !== current);
  const parallel = [...new Set([...prs.filter((p) => !mine(p.head)).map((p) => `PR #${p.number} (${p.head})`), ...others.map((b) => `branch ${b}`)])];
  const here = isTaskBranch(current, number);
  if (resume && !parallel.length && !here) throw new GhError(`--resume: #${number} has no branch or open PR to continue — a first take: task start ${number} --branch <type>/${number}-<slug>`);
  if (parallel.length && !resume) {
    io.out(`! #${number} is in work elsewhere — ${parallel.join(", ")}: continue that work or wait for its merge — the task isn't taken a second time`);
    return endWith(io, { state: "", next: `continue that work — in its checkout (git worktree list) — or wait for its merge`, who: "agent" }, 1);
  }
  const code = cmdTaskStatus(io, slug, number, N.status.inProgress, branch, false);
  const now = git(io, io.cwd, "branch", "--show-current").stdout.trim();
  const scenarios = locale.scenarioItems(t.body);
  io.out(`Session name: «#${number} ${t.title}»`);
  if (resume && !here) io.out(`Branch: continue ${parallel.join(", ")} — checked out in another worktree (git worktree list): work in that one; in none — git switch it here`);
  else io.out(now ? `Branch: ${now}` : `Branch: none — the task branch from a fresh origin/<base>${branch ? `: ${branch}` : ""}`);
  io.out(
    scenarios?.length
      ? `Scenarios: ${scenarios.length} in ${q(N.sections.scenarios)} — the future it names`
      : `○ no scenarios in ${q(N.sections.scenarios)} — a code task gets them in the description before code: ${ready(["task", "edit", number, "--add", N.sections.scenarios, "<scenario>", "--repo", slug])}`,
  );
  if (io.env["CLAUDECODE"] === "1") io.out(`ToolSearch select:${APP_TOOLS.join(",")}`);
  nextOfTask(io, slug, number);
  return code;
}

export function cmdTaskDrop(io: Io, slug: string, number: number, duplicateOf?: number): number {
  const ctx = taskContext(io, slug);
  const issue = loadIssue(io, slug, number);
  if (issue.state === "CLOSED" && issue.stateReason === "COMPLETED") throw new GhError(`#${number} is closed as completed — drop is only for tasks not done`);
  const dup = duplicateOf === undefined ? null : loadIssue(io, slug, duplicateOf);
  if (issue.state === "OPEN") {
    mutate(io, { op: "CloseIssue", input: { issueId: issue.id, stateReason: dup ? "DUPLICATE" : "NOT_PLANNED", ...(dup ? { duplicateIssueId: dup.id } : {}) } });
    io.out(`+ #${number} closed: ${dup ? `duplicate of #${dup.number}` : "not planned"}`);
  }
  // "Item closed" would put a task closed without doing it into "Done" — it has no place in the project; no board
  // (#847) — nothing to remove: by the facts a task closed without being done isn't done
  const item = ctx.board ? itemIn(ctx.board, issue) : null;
  if (item) {
    mutate(io, { op: "DeleteItem", input: { projectId: ctx.board!.project.id, itemId: item.id } });
    io.out(`+ #${number} removed from project ${q(ctx.board!.project.title)}`);
  }
  if (!ctx.board) io.out(noBoard(number, "nothing to remove from a board"));
  return endWith(io, STEP.closed(""), 0);
}

// ----------------------------------------------------------------------------
// Reading a task and answering its questions
// ----------------------------------------------------------------------------

/** A task's PR for task show: its state and its head's checks (none yet — null); `why` — what an unlinked one was found by. */
interface ShownPr {
  number: number;
  state: string;
  merged: boolean;
  draft: boolean;
  head: string;
  /** The head commit and the base branch — what `task next` reads a PR's step by (#842). */
  sha: string;
  base: string;
  checks: { green: number; pending: string[]; red: string[] } | null;
  why?: string | undefined;
}

/** The head's checks by name (`checkStates`): green (pass, skipping), still running, red (cancel, fail). */
function shownPr(p: Any, why?: string): ShownPr {
  const by = [...checkStates(rollupOf(p))];
  const of = (...states: CheckBucket[]) => by.filter(([, v]) => states.includes(v)).map(([k]) => k);
  return {
    number: p.number,
    state: p.state ?? "",
    merged: Boolean(p.merged),
    draft: Boolean(p.isDraft),
    head: p.headRefName ?? "",
    sha: p.headRefOid ?? "",
    base: p.baseRefName ?? "main",
    checks: by.length ? { green: of("pass", "skipping").length, pending: of("pending"), red: of("cancel", "fail") } : null,
    why,
  };
}

function prLine(p: ShownPr): string {
  const done = p.merged || p.state === "CLOSED";
  const state = p.merged ? "merged" : p.state === "CLOSED" ? "closed without a merge" : p.draft ? "open (draft)" : "open";
  const c = p.checks;
  const checks = done
    ? ""
    : !c
      ? " — no checks yet"
      : ` — checks: ${[c.green ? `${c.green} ✅` : "", c.pending.length ? `${c.pending.length} ⏳ (${c.pending.join(", ")})` : "", c.red.length ? `${c.red.length} ❌ (${c.red.join(", ")})` : ""].filter(Boolean).join(", ")}`;
  return `PR #${p.number} ${state}${checks}${p.why ? ` (not linked: ${p.why})` : ""}`;
}

/**
 * A commit's checks over REST in the shape of `HEAD_CHECKS` (`checkStates` reads them): its check-runs and the hosting's
 * commit statuses; `runs` — the check-runs as REST gives them (their ids are the Actions jobs' ids). A batch's release
 * (#650).
 */
function restRollup(io: Io, slug: string, sha: string): { nodes: Any[]; runs: Any[] } {
  const runs: Any[] = rest(io, `repos/${slug}/commits/${sha}/check-runs?per_page=100`)?.check_runs ?? [];
  const statuses: Any[] = rest(io, `repos/${slug}/commits/${sha}/status`)?.statuses ?? [];
  const up = (v: unknown) => (v ? String(v).toUpperCase() : null);
  const nodes = [
    ...runs.map((c) => ({ __typename: "CheckRun", name: c.name, status: up(c.status), conclusion: up(c.conclusion), databaseId: c.id, checkSuite: { app: { databaseId: c.app?.id ?? null } } })),
    ...statuses.map((c) => ({ __typename: "StatusContext", context: c.context, state: up(c.state) })),
  ];
  return { nodes, runs };
}

/** A comment as task show prints it (#651): the author's login, the time in UTC, the text. */
interface ShownComment {
  author: string;
  at: string;
  body: string;
}

/** An issue's comments of the `COMMENTS_SHOW` answer: the printed ones, oldest first, and how many there are. */
function shownComments(c: Any): { total: number; nodes: ShownComment[] } {
  const nodes: ShownComment[] = (c?.nodes ?? []).filter(Boolean).map((x: Any) => ({
    author: x.author?.login ?? "ghost",
    at: x.createdAt ? `${String(x.createdAt).slice(0, 16).replace("T", " ")} UTC` : "",
    body: String(x.body ?? "").replace(/\r\n/g, "\n").trim(),
  }));
  return { total: c?.totalCount ?? nodes.length, nodes };
}

/**
 * The start of a comment the flow writes by a dictionary template, in any language of the dictionary: the template up
 * to its first colon, a placeholder — any text of the line; markup before it and case aside.
 */
function templateStart(pick: (n: Names) => string): RegExp {
  const heads = locale.every(pick).map((t) => {
    const end = t.indexOf(":");
    return (end < 0 ? t : t.slice(0, end + 1)).split(/\{\w+\}/).map(locale.escapeRe).join("[^\\n]*?");
  });
  return new RegExp(`^[\\s*_>#]*(?:${heads.join("|")})`, "iu");
}

/**
 * The flow's own comments — task show prints them in one line without the text (#651), by the kind: est's actual and
 * its estimate of old tasks (its `<!-- fact {…} -->` and `<!-- est {…} -->` markers: a human's «Estimate: …» isn't
 * one; est no longer estimates, #835, but the old comments stay on the tasks), the epic refresh's report and the
 * script's fixes, task close's «closed by PR».
 */
const FLOW_COMMENTS: [kind: string, re: RegExp][] = [
  ["estimate", /<!--\s*est\s+\{/],
  ["actual", /<!--\s*fact\s+\{/],
  ["epic refresh report", templateStart((n) => n.actualize.report)],
  ["epic refresh, the script's fixes", templateStart((n) => n.actualize.mechanics)],
  ["closed by PR", templateStart((n) => n.comments.closedByPr)],
];
/** The State comment — a handoff of the work (AGENTS.md, "Judgment"): printed in full, not an answer. */
const STATE_RE = new RegExp(`^[\\s*_>#]*(?:${locale.every((n) => n.comments.state).map(locale.escapeRe).join("|")})(?![\\p{L}\\p{N}_])`, "iu");
/** An external blocker's reason (`task queue` reads it): printed in full, not an answer. */
const EXTERNAL_BLOCKER_RE = templateStart((n) => n.comments.externalBlocker);

/** A comment's kind: the flow's own (`FLOW_COMMENTS`), State, an external blocker's reason, or a human's — null. */
function commentKind(c: ShownComment): string | null {
  const flow = FLOW_COMMENTS.find(([, re]) => re.test(c.body));
  return flow ? flow[0] : STATE_RE.test(c.body) ? "State" : EXTERNAL_BLOCKER_RE.test(c.body) ? "external blocker" : null;
}
const isFlowComment = (kind: string | null) => kind !== null && FLOW_COMMENTS.some(([k]) => k === kind);

/**
 * Comments that look like answers to the open questions (#651) — the canon checks the questions against the comments
 * before asking: an item `k.` of a comment (`k. ✅ …`, as the epic refresh reads it, or without ✅) — to the open
 * question k; free text without numbered items — to each open one, which one it answers is the agent's check. The
 * flow's own comments, State and an external blocker's reason don't answer. Broader than the epic refresh's
 * `commentAnswers` (`k. ✅` only) on purpose: here a flag is a check before asking, there an answer to move.
 */
function answerCandidates(open: number[], comments: ShownComment[]): Map<number, ShownComment[]> {
  const out = new Map<number, ShownComment[]>();
  for (const c of comments) {
    if (!c.body || commentKind(c) !== null) continue;
    const items = [...c.body.matchAll(/^\s*(\d+)[.)]\s+\S/gm)].map((m) => Number(m[1]));
    for (const k of items.length ? open.filter((k) => items.includes(k)) : open) out.set(k, [...(out.get(k) ?? []), c]);
  }
  return out;
}

/** The `?` line of a question with answer candidates in comments: who and when, and the command after the check. */
function answerLine(number: number, k: number, found: ShownComment[]): string {
  const who = found.map((c) => `@${c.author}${c.at ? ` ${c.at}` : ""}`).join(", ");
  return `? ${k}: answer in ${found.length > 1 ? "comments" : "a comment"} of ${who} — check it and task answer ${number} ${k} "<answer>"`;
}

/**
 * An issue's comments block: the count, then each comment — the flow's own in one line with the kind, State and the
 * rest with the whole text, indented.
 */
function commentLines(title: string, c: { total: number; nodes: ShownComment[] }): string[] {
  if (!c.nodes.length) return [`${title}: none`];
  const out = [`${title}: ${c.total}${c.total > c.nodes.length ? `, the last ${c.nodes.length} shown` : ""}`];
  for (const x of c.nodes) {
    const head = `- @${x.author}${x.at ? ` ${x.at}` : ""}`;
    const kind = commentKind(x);
    if (isFlowComment(kind)) {
      out.push(`${head} — flow: ${kind}`);
      continue;
    }
    out.push(`${head}${kind === "State" ? " — State" : ""}:`, ...(x.body ? x.body.split("\n").map((l) => (l.trim() ? `  ${l.trimEnd()}` : "")) : []));
  }
  return out;
}

/**
 * Everything needed to take a task into work in one output, instead of `gh issue view` per piece: the title, type,
 * state, Status and actual, the epic with its open questions and other open tasks, subtasks, open blockers, the PRs
 * with their checks (GitHub didn't link one yet — found by the branch or «Closes #N», as task close does), the
 * questions — open and answered, a comment that looks like an answer to an open one — a `?` line at the question, the
 * comments of the task and its epic (#651: an answer in a comment was lost — the executor asked again or answered
 * auto over it), and the description as is. Read-only.
 */
export function cmdTaskShow(io: Io, slug: string, number: number): number {
  const t = showTask(io, slug, number);
  for (const line of t.lines) io.out(line);
  // the last line — the automaton's step (#842), by the issue already read
  io.out(nextLine(nextOf(io, slug, number, t.issue)));
  return 0;
}

/** What `task show` prints and what `task start` decides by: the lines, open questions of the task and its epic, the PRs. */
interface ShownTask {
  lines: string[];
  title: string;
  state: string;
  epic: boolean;
  body: string;
  open: number[];
  epicOpen: { number: number; ks: number[] } | null;
  prs: ShownPr[];
  /** Its blockers (blocked by), closed ones and other repositories' included, and its labels — `task start`'s stop (#869). */
  blockers: Blocker[];
  labels: string[];
  /** The issue as `Q.IssueShow` read it — the automaton's facts (#842), not read twice. */
  issue: Any;
}

/** The field values of the task's item in the repository's project (IssueShow) — or of its first item. */
function itemValues(i: Any, name: string): Any[] {
  const items: Any[] = i?.projectItems?.nodes ?? [];
  return (items.find((it) => it.project?.title === name) ?? items[0])?.fieldValues?.nodes ?? [];
}

/** The type of an issue as `Q.IssueShow` reads it: its issue type; a personal account has none — an epic is the epic label. */
function shownType(i: Any): string | null {
  return i.issueType?.name ?? ((i.labels?.nodes ?? []).some((l: Any) => l.name === EPIC_LABEL) ? N.issueTypes.epic : null);
}

function showTask(io: Io, slug: string, number: number): ShownTask {
  const [owner, name] = slug.split("/");
  const i = graphql(io, Q.IssueShow, { owner, name, number })?.repository?.issue;
  if (!i) throw new GhError(`no issue #${number} in ${slug}`);
  const labels: string[] = (i.labels?.nodes ?? []).map((l: Any) => l.name);
  const type = shownType(i);
  const epic = type !== null && locale.every((n) => n.issueTypes.epic).includes(type);
  const items: Any[] = i.projectItems?.nodes ?? [];
  const values = itemValues(i, name!);
  const num = (field: (n: Names) => string) => values.find((v) => v?.__typename === "ProjectV2ItemFieldNumberValue" && locale.every(field).includes(v.field?.name));
  const status: string | null = values.find((v) => v?.field?.name === STATUS && v.name)?.name ?? null;
  const actual = num((n) => n.fields.actual);
  const priority: string | null = (i.issueFieldValues?.nodes ?? []).find((v: Any) => v?.field?.name === PRIORITY)?.name ?? null;
  const reason: Record<string, string> = { NOT_PLANNED: ": not planned", DUPLICATE: ": duplicate" };
  const shownLabels = labels.filter((l) => !(l === EPIC_LABEL && !i.issueType));
  // no board (#847) — the status by the facts, after the PRs: an open one is one of them
  const board = taskContext(io, slug).board !== null;
  const facts = [
    type,
    i.state === "CLOSED" ? `closed${reason[i.stateReason] ?? ""}` : null,
    !board ? "" : !items.length ? "not in the project" : status ? `${STATUS} ${q(status)}` : `no ${STATUS}`,
    actual ? `${q(actual.field.name)} ${actual.number}` : null,
    priority ? `${PRIORITY} ${priority}` : null,
    i.milestone ? `milestone ${q(i.milestone.title)}` : null,
    shownLabels.length ? `labels: ${shownLabels.join(", ")}` : null,
  ];
  const out = [`#${i.number} ${i.title} — ${i.url}`, ""];
  const epicComments = i.parent ? shownComments(i.parent.comments) : null;
  let epicOpen: ShownTask["epicOpen"] = null;
  let prs: ShownPr[] = [];
  if (i.parent) {
    const p = i.parent;
    const open = questionItems(p.body ?? "").filter((x) => !x.answered);
    epicOpen = { number: p.number, ks: open.map((x) => x.k) };
    const tasks: Any[] = (p.subIssues?.nodes ?? []).filter((x: Any) => x.state === "OPEN" && x.number !== number);
    const answers = answerCandidates(open.map((x) => x.k), epicComments!.nodes);
    out.push(`Epic #${p.number} ${q(p.title)} — open questions: ${open.length}, other open tasks: ${tasks.length}`);
    out.push(...open.flatMap((x) => [`- question ${x.text}`, ...(answers.has(x.k) ? [`  ${answerLine(p.number, x.k, answers.get(x.k)!)}`] : [])]), ...tasks.map((x) => `- task #${x.number} ${q(x.title)}`));
  }
  const subs: Any[] = i.subIssues?.nodes ?? [];
  if (subs.length) {
    const open = subs.filter((x) => x.state === "OPEN");
    out.push(`Subtasks: open ${open.length} of ${subs.length}`, ...open.map((x) => `- task #${x.number} ${q(x.title)}`));
  }
  const blockedBy: (Blocker & { title: string })[] = (i.blockedBy?.nodes ?? []).map((x: Any) => ({ number: x.number, state: x.state, repo: x.repository?.nameWithOwner ?? slug, title: x.title ?? "" }));
  const blockers = blockedBy.filter((x) => x.state === "OPEN");
  if (blockers.length) out.push(`Blocked by: ${blockers.map((x) => `${blockerRef(slug, x)} ${q(x.title)}`).join(", ")}`);
  // an epic has no PR of its own
  if (!epic) {
    prs = (i.closedByPullRequestsReferences?.nodes ?? []).filter(Boolean).map((p: Any) => shownPr(p));
    if (!prs.length && i.state === "OPEN") {
      for (const p of unlinkedPrs(io, slug, number).prs) {
        const pr = graphql(io, Q.PrShow, { owner, name, number: p.number })?.repository?.pullRequest;
        if (pr) prs.push(shownPr(pr, p.why));
      }
    }
    out.push(...(prs.length ? prs.map(prLine) : ["PR: none"]));
  }
  if (!board) {
    const fact = factStatus(i, prs.find((p) => p.state === "OPEN" && !p.merged)?.number, workFacts(io, slug));
    facts[2] = fact.status === null ? "no board — not done" : `no board — ${q(fact.status)} by the facts: ${fact.why}`;
  }
  out[1] = facts.filter(Boolean).join(" · ");
  const lines = (i.body ?? "").trimEnd().split(/\r?\n/);
  const questions = questionItems(i.body ?? "");
  const open = questions.filter((x) => !x.answered).map((x) => x.k);
  const answered = questions.filter((x) => x.answered).map((x) => x.k);
  out.push(
    !questions.length
      ? "Questions: none"
      : !open.length
        ? `Questions: all answered (${answered.join(", ")})`
        : `Questions: open ${open.join(", ")}${answered.length ? `; answered ${answered.join(", ")}` : ""} — ${ready(["task", "answer", number, open[0]!, "<answer>", "--repo", slug])}, auto mode — with --auto`,
  );
  const comments = shownComments(i.comments);
  const answers = answerCandidates(open, comments.nodes);
  out.push(...open.filter((k) => answers.has(k)).map((k) => answerLine(number, k, answers.get(k)!)));
  out.push(...commentLines("Comments", comments));
  if (epicComments) out.push(...commentLines(`Epic #${i.parent.number} comments`, epicComments));
  if (lines.join("").trim()) out.push("", ...lines);
  return { lines: out, title: i.title, state: i.state, epic, body: i.body ?? "", open, epicOpen, prs, blockers: blockedBy, labels, issue: i };
}

/** The answer's text on one line: `task answer` and the refresh's file of edits (#669). */
const answerText = (answer: string) => answer.trim().replace(/\s*\r?\n\s*/g, " ");

/**
 * The description with the answer at question k (`cmdTaskAnswer`, the refresh's file of edits — #669) and the numbers
 * of the questions still open; no such question, or it is answered — an error, nothing is written.
 */
export function answerInBody(number: number, body: string, k: number, answer: string, auto: boolean): { body: string; open: number[] } {
  const text = answerText(answer);
  if (!text) throw new GhError(`#${number}: question ${k} — the answer text is empty`);
  const lines = body.split(/\r?\n/);
  const questions = questionItems(body);
  if (!questions.length) throw new GhError(`#${number}: no ${q(N.sections.questions)} section with numbered questions`);
  const question = questions.find((x) => x.k === k);
  if (!question) throw new GhError(`#${number}: no question ${k} in ${q(N.sections.questions)}; questions: ${questions.map((x) => x.k).join(", ")}`);
  if (question.answered) throw new GhError(`#${number}: question ${k} is already answered (✅) — a changed answer: task edit ${number} --replace "<old>" "<new>"`);
  const reply = `**${N.est.answer}:** ${text}`;
  lines[question.first] = lines[question.first]!.replace(/^(\d+\.\s+)/, `$1${auto ? N.autoAnswer : "✅"} `);
  if (question.first === question.last) lines[question.first] += ` ${reply}`;
  else lines.splice(question.last + 1, 0, `${" ".repeat(`${k}. `.length)}${reply}`);
  const open = questions.filter((x) => !x.answered && x !== question).map((x) => x.k);
  return { body: lines.join(body.includes("\r\n") ? "\r\n" : "\n"), open };
}

/**
 * The answer at question k of the questions section, in place of rewriting the description by hand: ✅ (with --auto —
 * `autoAnswer`) after the item's number and «**Answer:** …» (`est.answer`: est strips it from the description size) at
 * its end — on the same line for a one-line item, otherwise on a line of its own; the numbering doesn't change, the
 * rest of the description stays as is. No open questions left — the questions label is removed. An answered question
 * is refused: a changed answer — `task edit --replace` (#670).
 */
export function cmdTaskAnswer(io: Io, slug: string, number: number, k: number, answer: string, auto: boolean): number {
  if (!answerText(answer)) throw new GhError("task answer: expected the answer text after the question number");
  const [owner, name] = slug.split("/");
  const i = graphql(io, Q.IssueShow, { owner, name, number })?.repository?.issue;
  if (!i) throw new GhError(`no issue #${number} in ${slug}`);
  const { body: next, open } = answerInBody(number, i.body ?? "", k, answer, auto);
  mutate(io, { op: "UpdateIssue", input: { id: i.id, body: next } });
  io.out(`+ #${number}: question ${k} — ✅ and the answer in the description`);
  if (open.length) io.out(`○ #${number}: open questions left: ${open.join(", ")}`);
  const label: Any[] = (i.labels?.nodes ?? []).filter((l: Any) => locale.every((n) => n.labels.questions).includes(l.name));
  if (!open.length && label.length) {
    mutate(io, { op: "RemoveLabels", input: { labelableId: i.id, labelIds: label.map((l) => l.id) } });
    io.out(`+ #${number}: label ${label.map((l) => q(l.name)).join(", ")} removed — no open questions left`);
  }
  // the next step by the description as written (#842): the next open question or, none left, the task's work
  io.out(nextLine(nextOf(io, slug, number, { ...i, body: next })));
  return 0;
}

/** One edit of `task edit`, in the order given: a replacement, an item into a section, a checked item. */
export type Edit = { kind: "replace"; old: string; next: string } | { kind: "add"; section: string; item: string } | { kind: "check"; text: string };

const EDIT_ARITY: Record<string, number> = { "--replace": 2, "--add": 2, "--check": 1 };
const EDIT_USAGE: Record<string, string> = { "--replace": "--replace <old> <new>", "--add": "--add <section> <item>", "--check": "--check <item text>" };

/**
 * `task edit`'s arguments: an edit takes two values (`--replace <old> <new>`, `--add <section> <item>`), which
 * `parseArgs` can't, and its values go as is — a text may start with `-`. A call error — the command corrected (#841):
 * an unknown option — the edit it means (an alias, a typo), no task number — `<N>` first; otherwise the synopsis.
 */
function parseEdits(args: string[]): { number: number; repo: string | undefined; edits: Edit[] } {
  let number: number | undefined;
  let repo: string | undefined;
  const edits: Edit[] = [];
  const usage = Object.values(EDIT_USAGE).join(", ");
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const arity = a === "--repo" ? 1 : EDIT_ARITY[a];
    if (arity === undefined) {
      if (a.startsWith("--")) {
        const to = meantOption(a, optionsOf("task edit"));
        throw new CallError(`task edit: no option ${a}${to ? ` — ${to}` : `; its edits: ${usage}`}`, to ? ["task", "edit", ...args.slice(0, i), to, ...args.slice(i + 1)] : null);
      }
      if (number !== undefined) throw new GhError(`extra arguments: ${a}`);
      number = issueNumber(a, "task edit");
      continue;
    }
    // a value that is an option's name — a value missing, not a text: `--replace <old> --repo …` lost its `<new>`
    const values = args.slice(i + 1, i + 1 + arity);
    if (values.length < arity || values.some((v) => v === "--repo" || Object.hasOwn(EDIT_ARITY, v))) throw new CallError(`task edit: ${a} expects ${arity} value${arity > 1 ? "s" : ""}${a === "--repo" ? "" : `: ${EDIT_USAGE[a]}`}`, null);
    i += arity;
    if (a === "--repo") repo = values[0];
    else if (a === "--replace") edits.push({ kind: "replace", old: values[0]!, next: values[1]! });
    else if (a === "--add") edits.push({ kind: "add", section: values[0]!, item: values[1]! });
    else edits.push({ kind: "check", text: values[0]! });
  }
  if (number === undefined) throw new CallError("task edit: expected an issue number — first, before the edits", ["task", "edit", "<N>", ...args]);
  if (!edits.length) throw new CallError(`task edit: expected edits — ${usage}`, null);
  return { number, repo, edits };
}

const CHECKLIST_RE = /^(\s*[-*+]\s+)\[ \](\s)/;
/** A top-level list item: a bullet or a number at the line's start. */
const LIST_ITEM_RE = /^(?:[-*+]|\d+\.)\s/;
/** A Markdown heading's level (`## …` — 2), not a heading — 0. */
const headingLevel = (line: string) => /^(#{1,6})\s/.exec(line)?.[1]?.length ?? 0;
/** The questions section's heading in any language of the dictionary: `questionItems` reads it, `task edit --add` numbers its first item. */
const QUESTIONS_SECTION_RE = new RegExp(`^(?:${locale.every((n) => n.sections.questions).map(locale.escapeRe).join("|")})\\s*$`);
/** The canon's sections of a description in any language of the dictionary: `task edit --add` creates a missing one. */
const CANON_SECTIONS = [...locale.every((n) => n.sections.questions), ...locale.every((n) => n.sections.scenarios)];

/** Where a new section goes: the description's end, before its footer — a thematic break with no heading after it (a signature). */
function sectionsEnd(lines: string[]): number {
  const at = lines.reduce((last, l, i) => (THEMATIC_BREAK_RE.test(l) ? i : last), -1);
  return at >= 0 && !lines.slice(at + 1).some((l) => headingLevel(l)) ? at : lines.length;
}

/**
 * The marker of an item added after `prev`, the section's last item: `- [ ]` after a checklist item, the next number,
 * its bullet; none — `none`.
 */
function itemMarker(prev: string | undefined, none: string): string {
  const numbered = /^(\d+)\.\s/.exec(prev ?? "");
  if (numbered) return `${Number(numbered[1]) + 1}. `;
  const bullet = /^([-*+]\s+)(\[[ xX]\]\s)?/.exec(prev ?? "");
  if (!bullet) return none;
  return bullet[2] ? `${bullet[1]}[ ] ` : bullet[1]!;
}

/**
 * The edits applied in order to the description, each to the result of the previous one; an edit that is ambiguous or
 * finds nothing — an error, so none is written. `--add` — after the section's last non-blank line (the section ends at
 * a heading of its level or higher, or a thematic break: a signature after it isn't the section's); an item
 * without a list marker gets the one of the section's last item: `- [ ]`, the next number, or `-`; the first one of the
 * questions section — `1.`: `task answer <N> <k>` finds a question by its number (#795).
 */
export function applyEdits(number: number, body: string, edits: Edit[]): { body: string; done: string[] } {
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  let text = body;
  const done: string[] = [];
  for (const e of edits) {
    if (e.kind === "replace") {
      const count = e.old ? text.split(e.old).length - 1 : 0;
      if (!count) throw new GhError(`#${number}: --replace ${q(clip(e.old))} — not found in the description`);
      if (count > 1) throw new GhError(`#${number}: --replace ${q(clip(e.old))} — found ${count} times, expected once: give a longer text`);
      text = text.replace(e.old, () => e.next);
      done.push(`replaced ${q(clip(e.old))}`);
      continue;
    }
    const lines = text.split(/\r?\n/);
    if (e.kind === "add") {
      const given = e.section.trim();
      // a bare name — the heading with that text (#841: «Questions» for «## Questions» — 18 refusals in two months)
      const at = lines.flatMap((l, i) => ((headingLevel(given) ? l.trim() === given : headingLevel(l) > 0 && l.replace(/^#{1,6}\s+/, "").trim() === given) ? [i] : []));
      const item = e.item.trim().replace(/\s*\r?\n\s*/g, " ");
      if (!at.length) {
        // a canon section the description lacks — the --add creates it (#841: «## Scenarios» of a task without one — 27 refusals)
        const heading = headingLevel(given) ? given : `## ${given}`;
        if (!CANON_SECTIONS.includes(heading)) {
          const sections = lines.filter((l) => headingLevel(l)).map((l) => q(l.trim()));
          throw new GhError(`#${number}: --add — no section ${q(given)}; the description's sections: ${sections.length ? sections.join(", ") : "none"}`);
        }
        const line = `${LIST_ITEM_RE.test(item) ? "" : QUESTIONS_SECTION_RE.test(heading) ? "1. " : "- "}${item}`;
        const end = sectionsEnd(lines);
        const before = lines.slice(0, end);
        while (before.length && !before.at(-1)!.trim()) before.pop();
        const after = lines.slice(end);
        text = [...before, ...(before.length ? [""] : []), heading, "", line, ...(after.length ? ["", ...after] : [""])].join(eol);
        done.push(`added to ${q(heading)} — a new section`);
        continue;
      }
      if (at.length > 1) throw new GhError(`#${number}: --add — section ${q(given)} appears ${at.length} times`);
      const from = at[0]!;
      const heading = lines[from]!.trim();
      const level = headingLevel(heading);
      let end = from + 1;
      while (end < lines.length && !THEMATIC_BREAK_RE.test(lines[end]!) && !(headingLevel(lines[end]!) && headingLevel(lines[end]!) <= level)) end++;
      let last = end - 1;
      while (last > from && !lines[last]!.trim()) last--;
      // the section's last top-level item: a nested one under it isn't the list's
      const prev = lines.slice(from + 1, last + 1).filter((l) => LIST_ITEM_RE.test(l)).at(-1);
      const line = `${LIST_ITEM_RE.test(item) ? "" : itemMarker(prev, QUESTIONS_SECTION_RE.test(heading) ? "1. " : "- ")}${item}`;
      // a heading right before the item — a blank line between them, as the section's own items have
      lines.splice(last + 1, 0, ...(last === from ? ["", line] : [line]));
      done.push(`added to ${q(heading)}`);
    } else {
      const hits = lines.flatMap((l, i) => (CHECKLIST_RE.test(l) && l.includes(e.text) ? [i] : []));
      if (!hits.length) throw new GhError(`#${number}: --check ${q(clip(e.text))} — no unchecked item «- [ ] …» with it`);
      if (hits.length > 1) throw new GhError(`#${number}: --check ${q(clip(e.text))} — ${hits.length} unchecked items with it, expected one: give a longer text`);
      lines[hits[0]!] = lines[hits[0]!]!.replace(CHECKLIST_RE, "$1[x]$2");
      done.push(`checked ${q(clip(e.text))}`);
    }
    text = lines.join(eol);
  }
  return { body: text, done };
}

/**
 * An edit of the task's description in one call, in place of `gh issue view --json body`, a file and `gh issue edit
 * --body-file` (#670): the edits together or none — an error in any leaves the description untouched.
 */
export function cmdTaskEdit(io: Io, slug: string, number: number, edits: Edit[]): number {
  const [owner, name] = slug.split("/");
  const i = graphql(io, Q.IssueShow, { owner, name, number })?.repository?.issue;
  if (!i) throw new GhError(`no issue #${number} in ${slug}`);
  const { body, done } = applyEdits(number, i.body ?? "", edits);
  mutate(io, { op: "UpdateIssue", input: { id: i.id, body } });
  io.out(`+ #${number}: description — ${done.length} edit${done.length > 1 ? "s" : ""}: ${done.join(", ")}`);
  // the next step by the description as written (#842) — an added question is the next one
  io.out(nextLine(nextOf(io, slug, number, { ...i, body })));
  return 0;
}

// ----------------------------------------------------------------------------
// Closing a task in one command
// ----------------------------------------------------------------------------

/**
 * The five epic-refresh checks — from the skill's reference.md, the one place of the canon: the list between
 * "Five checks:" and "What was fixed", an item per check.
 */
/**
 * The dispatcher's selection: the epic's tasks or the repository's open ones, narrowed by type and Priority; an option
 * not given is `undefined`, as in `NewTask`.
 */
export interface QueueFilter {
  epic?: number | undefined;
  /**
   * The dispatcher's group (#698): the owner's chosen tasks — the queue hands out only them, a new batch after a release
   * only from those still open; tasks created meanwhile (by executors, the epic refresh) join it only by the owner's word.
   */
  tasks?: number[] | undefined;
  type?: string | undefined;
  priority?: string[] | undefined;
}

/** Executors at once without the slot skill: `slot` lets two heavy runs through, a third executor writes code meanwhile. */
export const QUEUE_EXECUTORS = 3;

/** The slot script next to the skill — laid out like est (`../slot/scripts/slot.ts`). */
const slotScript = (io: Io) => io.env["ELVES_SLOT_SCRIPT"] ?? path.resolve(import.meta.dir, "../../slot/scripts/slot.ts");

/**
 * How many executors run at once and where the number comes from: the machine's capacity — `slot --capacity` by
 * machine.json of the personal configuration, otherwise by the cores and memory (#779); a process, not an import
 * (tests/standards/scripts/skill-imports). No slot skill or it failed — QUEUE_EXECUTORS with the reason.
 */
function queueExecutors(io: Io): { n: number; from: string } {
  const script = slotScript(io);
  if (!existsSync(script)) return { n: QUEUE_EXECUTORS, from: "no slot skill" };
  // the script's environment — its personal configuration directory is slot's too (tests/standards/scripts/config-dir)
  const env = Object.fromEntries(Object.entries(io.env).filter((e): e is [string, string] => e[1] !== undefined));
  const r = (io.run ?? realRun)("bun", ["--no-env-file", script, "--capacity"], io.cwd, env);
  try {
    const c = JSON.parse(r.stdout) as { executors: number; from: { executors: string } };
    if (Number.isInteger(c.executors) && c.executors > 0) return { n: c.executors, from: c.from.executors };
  } catch {
    /* the number below, with the reason */
  }
  return { n: QUEUE_EXECUTORS, from: `slot --capacity: ${why(r)}` };
}

const priorityRank = (p: string | null) => PRIORITIES.indexOf((p ?? DEFAULT_PRIORITY) as (typeof PRIORITIES)[number]);

/**
 * The reason of an external blocker that isn't an issue (a release, a PR, another tracker — GitHub links only issues):
 * the label and the first line of the task's latest comment starting with `comments.externalBlocker` of any dictionary
 * language. The comments are read only for a labeled task.
 */
function externalBlocker(io: Io, slug: string, number: number, label: string): string {
  const marks = locale.every((n) => n.comments.externalBlocker);
  const comment = loadTaskText(io, slug, number)
    .comments.map((c) => c.body.trim())
    .filter((b) => marks.some((m) => b.startsWith(m)))
    .at(-1);
  if (comment === undefined) return `label ${q(label)}, no comment ${q(`${N.comments.externalBlocker} <reason>`)}`;
  const mark = marks.find((m) => comment.startsWith(m))!;
  return `label ${q(label)}: ${clip(comment.slice(mark.length).split(/\r?\n/)[0]!.trim())}`;
}

/** The task's external blocker label (`labels.externalBlocker` of any dictionary language); none — undefined. */
const externalLabelOf = (labels: string[]) => labels.find((l) => locale.every((n) => n.labels.externalBlocker).includes(l));

/**
 * A blocker as the queue's model reads it (queue.ts, `holdingBlockers`) — `task queue`'s and `task start`'s (#869):
 * merged into the batch — by `inBatch` (the batch's merged PRs; no batch — null); closed by its PR's merge, its task
 * close not run — by `awaiting` (a hand-out of this session, #769). Another repository's blocker is neither.
 */
function blockerFacts(slug: string, inBatch: ((n: number) => number | undefined) | null, awaiting: (n: number) => number | null): (b: Blocker) => BlockerFacts {
  const same = (b: Blocker) => b.repo.toLowerCase() === slug.toLowerCase();
  return (b) => ({
    ref: blockerRef(slug, b),
    open: b.state === "OPEN",
    inBatch: inBatch !== null && same(b) && inBatch(b.number) !== undefined,
    unclosed: b.state !== "OPEN" && same(b) && awaiting(b.number) !== null,
  });
}

/**
 * What holds a task from being taken (#869) — the queue's rules, so `task start` doesn't take what `task queue` doesn't
 * hand out: the blockers by `holdingBlockers` (one merged into the batch of this session's executor doesn't hold — its
 * branch is cut from the batch; a hand-out past the batch, `--main`, branches from the default one — it holds) and the
 * external blocker label with its reason. Nothing — none. The batch's PRs are read only for a blocker of this repository.
 */
function holdsOf(io: Io, slug: string, number: number, blockers: Blocker[], labels: string[]): string[] {
  const batch = handedPastBatch(io, slug, number) ? null : batchOf(io, slug);
  let recent: Recent | null = null;
  const inBatch = batch === null ? null : (n: number) => batchPrOf((recent ??= recentPrs(io, slug)), batch)(n);
  const held = holdingBlockers(blockers.map(blockerFacts(slug, inBatch, awaitingCloseOf(io, slug, handedOut(io, slug)))));
  const label = externalLabelOf(labels);
  return [held.length ? `blocked by ${held.join(", ")}` : "", label ? externalBlocker(io, slug, number, label) : ""].filter(Boolean);
}

/**
 * How the dispatcher launches an executor in Claude Code (#860): the Elves plugin's agent `elves:executor` — its own
 * worktree and the background are its definition (`agents/executor.md`: `isolation: worktree`, `background: true`), not
 * parameters of each call.
 */
const EXECUTOR_AGENT = 'the plugin\'s agent elves:executor (Agent with subagent_type: "elves:executor" — its own worktree, in the background)';

/**
 * The executor's prompt: the task first (`est` links the subagent's work by it), the whole assignment — from the script;
 * `main` — past the batch (`--main`): a bug on red main the open release waits for (#886).
 */
function executorPrompt(slug: string, number: number, epic: number | null, main = false): string {
  return locale.fill(N.queue.prompt, {
    task: N.subagentPrompt.task,
    number,
    repo: slug,
    epic: epic === null ? "" : locale.fill(N.queue.epic, { epicWord: N.subagentPrompt.epic, epic }),
    command: `bun --no-env-file ${import.meta.path} task queue --assignment ${number}${main ? " --main" : ""} --repo ${slug}`,
  });
}

/**
 * The dispatcher's step for its executor sessions — the app's (`start_session`: another project's task, #621). In auto
 * mode a session archives itself after the last line, but not always: it ended with a question whose
 * answer went to the dispatcher, or its last turn was the wait for the deploy. The queue is what the dispatcher reads
 * after each executor's answer, so its `Next:` names the step. Not archived: a session with live background work (the
 * app refuses), one awaiting the owner's answer (an archived session leaves the list, and the owner wouldn't read its
 * question), a project outside auto mode — the owner closes those.
 */
const SESSION_ARCHIVE =
  "an executor session whose task closed — the dispatcher archives it in an auto project where the agent has the tool, " +
  "not one still working in the background or awaiting the owner's answer; outside auto the owner closes it";

/**
 * The dispatcher's step outside auto (#667): an executor stops before its merge with «question: merge PR #N?» (its
 * assignment's `merge` line) — the owner's «yes» goes to the same executor; the dispatcher's request is the work's
 * scope, not a «yes» to each merge. The queue names it while executors are handed out or awaited.
 */
const MERGE_ASK =
  "the project is without auto: each executor's merge waits for the owner's «yes» — its answer «question: merge PR #N? …» goes to the owner, the «yes» to the same executor with SendMessage";

/**
 * A task's open PR: linked to it by GitHub, or one of the repository's recent ones by the task branch or `Closes #N` in
 * its body. The queue's «=» (the executor waits for its CI) and the epic refresh's «already going» (#636).
 */
function openPrOf(io: Io, slug: string, recent: Recent = recentPrs(io, slug)): (i: Issue) => number | undefined {
  const open = recent.nodes.filter((p) => p.state === "OPEN");
  return (i) => i.prs.find((p) => p.state === "OPEN")?.number ?? open.find((p) => prOfTask(p, i.number))?.number;
}

/** The repository's latest open and merged PRs (`Q.RecentPrs`, newest first) and its default branch. */
interface Recent {
  base: string;
  nodes: Any[];
}

function recentPrs(io: Io, slug: string): Recent {
  const [owner, name] = slug.split("/");
  const r = graphql(io, Q.RecentPrs, { owner, name })?.repository;
  return { base: r?.defaultBranchRef?.name ?? "main", nodes: (r?.pullRequests?.nodes ?? []).filter(Boolean) };
}

/**
 * The task's PR merged into the batch branch (#648): a linked one, or among the recent ones by the task branch and
 * «Closes #N» — GitHub links a PR to a task only by a merge into the default branch. None — undefined.
 */
function batchPrOf(recent: Recent, batch: string): (number: number, linked?: Issue["prs"]) => number | undefined {
  return (number, linked = []) => linked.find((p) => p.merged && p.base === batch)?.number ?? mergedIntoBatch(recent.nodes, batch, number)[0]?.number;
}

/**
 * The dispatcher's queue: its ready tasks go to background executors (subagents), K at a time; the queue is re-read
 * after each answer, so tasks that appeared meanwhile are picked up. A session with its own task dispatches too (#546:
 * the owner's "yes" to an epic's dispatcher becomes work at once, without a new session) — its pin stays, its task is
 * in work. Ready — open, not an epic, not in work, no open blockers (other repositories' too), no external blocker
 * label; order — Priority, then the number. In work (`=`) — "In progress", an open PR (linked, or by the task branch and
 * "Closes #N" among recent PRs) named with its link, or handed out to an executor of this session (`handedOutFile`);
 * a hand-out's task closed by its PR's merge stays in work and holds its dependents till `task close` (`awaitingCloseOf`, #769).
 * Marks the session as a dispatcher (`dispatcherFile`). A batch project (#648) — the batch branch first
 * (`dispatcherBatch`), its line in the marker: a task merged into it is `=` till the release, a blocker merged into it
 * doesn't hold. The batch's release (#649): nothing ready and every task of the batch merged into it — `Next:` names
 * `batch release`, a task past the batch (a PR into the default branch — #696) doesn't hold it;
 * its PR open — ready tasks are held (`○`), no new executors till its merge, but a bug on red main its premerge waits
 * for (#886) — `+` past the batch, its prompt with `--main`, its hand-out the first step; red (#650) — `Next:`
 * names its guilty task by the labels and the fix (`redRelease`, `fixSteps`), the bisect — `batch release`'s. Before the queue —
 * finished agents' worktrees (`pruneAgentWorktrees`) but those of executors whose handed-out tasks are open and those
 * a subagent still works in. The last line names archiving finished executor sessions (`SESSION_ARCHIVE`); outside auto
 * (#667) — while executors are handed out or awaited — the merge's wait for the owner's «yes» too (`MERGE_ASK`).
 * The rules are the model's (queue.ts, #843): the queue reads each task's facts, its entry — the state, the line and
 * the role for the release — is `entryOf`'s, the `Next:` step — `queueStep`'s by the transitions table; the texts of
 * the steps are here.
 */
export function cmdTaskQueue(io: Io, slug: string, o: QueueFilter): number {
  const want = o.type === undefined ? undefined : typeAliases()[o.type.toLowerCase()];
  if (o.type !== undefined && (!want || want === N.issueTypes.epic)) throw new GhError(`--type: ${N.issueTypes.task} or ${N.issueTypes.bug}`);
  const bad = (o.priority ?? []).filter((p) => !(PRIORITIES as readonly string[]).includes(p));
  if (bad.length) throw new GhError(`--priority: ${PRIORITIES.join(", ")}, not ${bad.join(", ")}`);
  const ctx = taskContext(io, slug);
  const org = ctx.repo.owner.org;
  if (!org && (o.type !== undefined || o.priority?.length)) throw new GhError("--type and --priority — only in an organization: a personal account has no issue types and no Priority");
  if (o.epic !== undefined && o.tasks !== undefined) throw new GhError("--epic or --tasks, not both: the group is the epic's open tasks or the ones named");
  let numbers: number[];
  /** The epic's sub-issues, closed ones included — a hand-out's task closed by a merge is among them (#769). */
  let subs: Set<number> | null = null;
  if (o.tasks !== undefined) {
    if (!o.tasks.length) throw new GhError("--tasks: the group's task numbers, comma-separated — --tasks 47,49");
    numbers = [...new Set(o.tasks)];
  } else if (o.epic !== undefined) {
    const epic = loadIssue(io, slug, o.epic);
    if (!isEpic(epic, org)) throw new GhError(`#${o.epic} is not an epic — --epic takes an epic`);
    if (epic.state !== "OPEN") throw new GhError(`epic #${o.epic} is closed`);
    numbers = epic.subIssues.filter((x) => x.state === "OPEN").map((x) => x.number);
    subs = new Set(epic.subIssues.map((x) => x.number));
  } else {
    const found = graphql(io, Q.IssueSearch, { q: `repo:${slug} is:issue is:open` }).search.nodes as Any[];
    if (found.length >= 100) io.out("○ the search gave 100 open tasks — the queue sees only them: narrow it with --epic");
    numbers = found.filter((x) => x?.state === "OPEN").map((x) => x.number);
  }
  const handed = handedOut(io, slug);
  // a hand-out's task closed by its PR's merge is in work till task close (#769): the open tasks don't name it
  if (o.tasks === undefined) {
    numbers = [...new Set([...numbers, ...handed.filter((h) => subs === null || subs.has(h.number)).map((h) => h.number)])];
  }
  const awaiting = awaitingCloseOf(io, slug, handed);
  const recent = recentPrs(io, slug);
  const openPr = openPrOf(io, slug, recent);
  const args = [o.epic !== undefined && `--epic ${o.epic}`, o.tasks !== undefined && `--tasks ${numbers.join(",")}`, o.type !== undefined && `--type ${o.type}`, o.priority?.length && `--priority ${o.priority.join(",")}`].filter(Boolean).join(" ");
  const file = dispatcherFile(io);
  // the kept batch before the readiness: a blocker merged into it doesn't hold a task of the same batch (#648); a new one
  // — after it, only with a task to hand out (#787): nothing is merged into a new batch yet, the readiness reads the same
  const dispatched = dispatcherBatch(io, slug, recent, file);
  let batch = dispatched.batch;
  /** The task's PRs — linked and found among the recent ones by the task branch or «Closes #N»: their state and base. */
  const prsOf = (i: Issue) => [
    ...i.prs.map((p) => ({ number: p.number, state: p.state, merged: p.merged, base: p.base })),
    ...recent.nodes.filter((p) => prOfTask(p, i.number)).map((p) => ({ number: p.number as number, state: p.state ?? "", merged: !!p.merged, base: p.baseRefName ?? "" })),
  ];
  const prBase = (i: Issue, pr: number) => prsOf(i).find((p) => p.number === pr)?.base;
  /** A PR of the task open or merged into another branch than the batch's — the task goes past the batch (#696). */
  const pastBatch = (i: Issue) => prsOf(i).some((p) => (p.state === "OPEN" || p.merged) && p.base !== batch);
  // the batch's release is open (#649) — no new executors till its merge: what merges into the batch now would change
  // the release its CI checked
  const release = batch === null ? undefined : releasePrOf(recent, batch);
  const releasing = release?.state === "OPEN" ? (release.number as number) : null;
  const checks = release && releasing !== null ? releaseChecks(io, slug, release) : null;
  /** The batch as the model reads it (queue.ts): the branch, the default one, the open release, its checks' red and pr premerge's (#884). */
  const batchFacts = (): BatchFacts => ({ batch, base: recent.base, release: releasing === null ? null : { number: releasing, red: checks?.state === "red", premerge: Boolean(checks?.premerge) } });
  /** Issue states the queue has read; a hand-out's task outside the queue is read when its worktree is up for removal. */
  const states = new Map<number, string>();
  const read = openOf(io, slug);
  const isOpen = (n: number) => (states.has(n) ? states.get(n) === "OPEN" : read(n));
  const facts = workFacts(io, slug, true);
  // the kept batch's merges: a task merged into it is `=` till the release (question 1 of epic #645); a blocker merged
  // into it doesn't hold its task — the executor branches from the batch (#648); outside it — another batch or not
  // merged — holds, as without batches
  const inBatch = batch === null ? null : batchPrOf(recent, batch);
  // a blocker closed by its PR's merge holds till its task close (#769): the deploy it waits for may not have happened
  const blocker = blockerFacts(slug, inBatch, awaiting);
  /** The queue's tasks, by number, with their entries (queue.ts). */
  const entries: { i: Issue; e: Entry }[] = [];
  for (const n of numbers.sort((a, b) => a - b)) {
    const i = loadIssue(io, slug, n);
    states.set(i.number, i.state);
    const closer = i.state === "OPEN" ? null : awaiting(i.number, i);
    // a hand-out closed by the batch's release (its «Closes #N»): its tail is batch release's, the queue has no line
    const released = i.state !== "OPEN" && closer === null && handed.some((h) => h.number === i.number) ? i.prs.find((p) => p.merged && isBatchBranch(p.head) && !isBatchBranch(p.base)) : undefined;
    const epic = isEpic(i, org);
    if (!epic && want && typeAliases()[(i.type ?? "").toLowerCase()] !== want) continue;
    if (!epic && o.priority?.length && !o.priority.includes(i.priority ?? DEFAULT_PRIORITY)) continue;
    const open = i.state === "OPEN";
    // no board (#847) — by the facts: the task branch on origin, a session pin; its open PR is a line of its own
    const fact = !open || epic || ctx.board ? null : factStatus(i, undefined, facts);
    const status = !open || epic ? null : ctx.board ? (itemIn(ctx.board, i)?.status ?? null) : fact!.status;
    const pr = open || closer !== null ? openPr(i) : undefined;
    const hand = handed.find((h) => h.number === i.number);
    const external = open && !epic ? externalLabelOf(i.labels) : undefined;
    const f: TaskFacts = {
      number: i.number,
      open,
      closedBy: closer !== null ? { pr: closer, release: false } : released ? { pr: released.number, release: true } : null,
      epic,
      done: status === N.status.done ? `${STATUS} ${q(status)}` : null,
      inProgress: status === N.status.inProgress ? `${q(N.status.inProgress)}${fact ? ` by the facts: ${fact.why}` : ""}` : null,
      openPr: pr === undefined ? null : { number: pr, url: `https://github.com/${slug}/pull/${pr}`, base: prBase(i, pr) ?? "" },
      inBatch: inBatch?.(i.number, i.prs) ?? null,
      handOut: hand ? { executor: hand.executor, main: hand.main } : null,
      pastBatch: pastBatch(i),
      blockers: i.blockers.map(blocker),
      external: external ? () => externalBlocker(io, slug, i.number, external) : null,
      mainRed: open && !epic && isMainRedBug(i.title, recent.base),
    };
    entries.push({ i, e: entryOf(f, batchFacts()) });
  }
  const readyOf = () => entries.filter((x) => x.e.state === "ready");
  // a new batch only with a task to hand out (#787): nothing is merged into it yet — the entries read the same
  if (dispatched.start) {
    if (readyOf().length) batch = dispatched.start();
    else io.out(`○ no new batch branch: nothing ready to hand out — a queue with a ready task starts it`);
  }
  const ready = readyOf().sort((a, b) => priorityRank(a.i.priority) - priorityRank(b.i.priority) || a.i.number - b.i.number);
  const line = ({ i, e }: (typeof entries)[number]) => `${e.mark} #${i.number} ${q(i.title)} — ${e.why}`;
  const running = entries.filter((x) => x.e.mark === "=").map(line);
  const waiting = entries.filter((x) => x.e.mark === "○").map(line);
  /** Of the tasks in work: merged into the batch and nothing else going — they wait only for the release (#649). */
  const settled = entries.filter((x) => x.e.role === "settled").map((x) => x.i.number);
  /** Tasks in work past the batch — named by the release's `Next:` (#696). */
  const past = entries.filter((x) => x.e.role === "past").map((x) => `#${x.i.number}`);
  if (file) {
    mkdirSync(path.dirname(file), { recursive: true });
    // the configuration directory may be a personal git checkout (ELVES_PRIVATE) — markers aren't committed into it
    writeFileSync(path.join(path.dirname(file), ".gitignore"), "*\n");
    // the batch lines after the queue command: other repositories' stay, this one's — the current batch
    const batches = [...batchesIn(file).filter((b) => b.repo.toLowerCase() !== slug.toLowerCase()), ...(batch ? [{ repo: slug, branch: batch }] : [])];
    writeFileSync(file, `bun --no-env-file ${import.meta.path} task queue ${args ? `${args} ` : ""}--repo ${slug}\n${batches.map((b) => `batch ${b.repo} ${b.branch}\n`).join("")}`);
  } else io.out("○ session not recognized (no CLAUDE_CODE_SESSION_ID) — not marked as a dispatcher: task status in the executors would pin their tasks");
  // the executor the dispatcher continues with SendMessage — an answered question, a restart — has no lock (#533)
  pruneExecutors(io, slug, handed, isOpen, awaiting);
  // a task merged into the batch waits for the release, its stack doesn't (#765): the executor didn't take it down — the queue does
  if (settled.length && checkoutOfRepo(io, originUrl(io), slug)) for (const n of settled) takeDownStacks(io, n, true);
  const group = o.tasks !== undefined ? `tasks ${numbers.map((n) => `#${n}`).join(", ")}` : null;
  const scope = [o.epic !== undefined ? `epic #${o.epic}` : group ?? "open tasks", want && `type ${q(want)}`, o.priority?.length && `Priority ${o.priority.join("|")}`].filter(Boolean).join(", ");
  io.out(`Queue ${slug} (${scope}): ready ${ready.length}, ${q(N.status.inProgress)} ${running.length}, not ready ${waiting.length}`);
  // a ready task past the batch — a bug on red main the open release waits for (#886): its line says so, its prompt — --main
  for (const { i, e } of ready) {
    io.out(`+ #${i.number} ${q(i.title)}${org ? ` (${i.priority ?? DEFAULT_PRIORITY})` : ""}${e.why ? ` — ${e.why}` : ""}`);
    io.out(`  ${executorPrompt(slug, i.number, i.parent?.number ?? null, e.role === "past")}`);
  }
  for (const line of running) io.out(line);
  for (const line of waiting) io.out(line);
  const releaseCommand = `bun --no-env-file ${import.meta.path} batch release --repo ${slug}`;
  // the owner's word «release» — the same command with live executors: they go on, their PRs wait for the release
  // (question 2 of epic #645)
  const now = settled.length ? `; the owner's word to release now — ${releaseCommand}: what is merged into ${batch} goes, the live executors go on, no new ones till its merge` : "";
  // outside auto an executor's merge is the owner's «yes» (#667)
  const ask = locale.autoProject(io.cwd ?? process.cwd()) ? "" : `; ${MERGE_ASK}`;
  const wait = () => [`Next: no ready tasks — wait for the executors' answers; after each — task queue again${ask}; ${SESSION_ARCHIVE}${now}.`];
  // the dispatcher's step — the model's (queue.ts: the first step the tasks' states call for by the transitions table)
  const next: Record<QueueNext, () => string[]> = {
    // a bug on red main while the release is open (#886): the release waits for its close — its executor past the batch
    // first; the release's own steps (red — its fix) batch release prints; the queue again only after an answer: the
    // hand-out is the executor's first call, till then the bug is still ready
    handOutPast: () => [
      `Next: each bug on red ${recent.base} above — ${EXECUTOR_AGENT} now, past the batch: the indented line is its whole prompt (--main: its PR goes into ${recent.base} with the full CI, into ${batch} its merge would wait for the release); ` +
        `the release of ${batch} — PR #${releasing} https://github.com/${slug}/pull/${releasing} — waits for its close: pr premerge refuses the release while ${recent.base} is red; ` +
        `no other new executors till its merge, its steps — ${releaseCommand} prints them; after each executor's answer — task queue again${ask}; ${SESSION_ARCHIVE}.`,
    ],
    // a red release (#650): its guilty task by the labels — the fix; the bisect is batch release's, the queue names it
    fix: () => fixSteps(slug, batch!, release!, checks!, redRelease(io, slug, batch!, recent.base, release!, recent, checks!, false), false),
    releaseSteps: () => [
      `Next: the release of ${batch} is open — PR #${releasing} https://github.com/${slug}/pull/${releasing}: no new executors till its merge, ` +
        `the live executors' PRs into ${batch} wait for it (pr premerge refuses the merge); its steps — ${releaseCommand} prints them; ` +
        `after each executor's answer — task queue again; ${SESSION_ARCHIVE}.`,
    ],
    handOut: () => {
      const executors = queueExecutors(io);
      return [
        `Next: each ready task above — ${EXECUTOR_AGENT} while fewer than ${executors.n} run (the machine's capacity: ${executors.from}; a number from the request replaces it); ` +
          `the indented line is its whole prompt. After each executor's answer — task queue again: new tasks get in${ask}; ${SESSION_ARCHIVE}${now}.`,
      ];
    },
    wait,
    release: () => [
      `Next: the batch ${batch} is complete — nothing ready, every task of the batch is merged into it: its release — ${releaseCommand}, ` +
        `once no executor of the batch is still at work${past.length ? `; past the batch — ${past.join(", ")}: they don't hold the release` : ""}; ${SESSION_ARCHIVE}.`,
    ],
    waitPast: wait,
    empty: () => {
      // the group is done (#698): no new batch — tasks created meanwhile join it only by the owner's word
      const done = group ? ` The group (${group}) has nothing left — no new batch: a task outside it joins only by the owner's word, task queue --tasks with it.` : "";
      return [
        `Queue is empty: nothing ready, nothing ${q(N.status.inProgress)}; ${SESSION_ARCHIVE}.${done} ` +
          "Then the dispatcher's summary (merged, questions, the not ready ones above) and the last line; a session with its own task — after it.",
      ];
    },
  };
  for (const l of next[queueStep(entries.map((x) => x.e), batchFacts())]()) io.out(l);
  return 0;
}

/**
 * The tasks merged into a batch branch (#649): each merged PR into it with its tasks (`prTasks`: the task branch's
 * number and «Closes #N» of its body) and the task branch's type; a PR without a task — none. By the PR number.
 */
function batchTasks(prs: Recent, batch: string): { pr: number; tasks: number[]; type: string | null }[] {
  return prs.nodes
    .filter((p) => p.merged && p.baseRefName === batch)
    .map((p) => ({ pr: p.number as number, tasks: prTasks(p), type: taskBranch(p.headRefName ?? "")?.type ?? null }))
    .filter((x) => x.tasks.length)
    .sort((a, b) => a.pr - b.pr);
}

/** A batch's PRs (`Q.BatchPrs`): its release PR first, then all the open and merged PRs into the batch branch. */
function batchPrs(io: Io, slug: string, batch: string): Recent {
  const [owner, name] = slug.split("/");
  const r = graphql(io, Q.BatchPrs, { owner, name, batch })?.repository;
  return { base: r?.defaultBranchRef?.name ?? "main", nodes: [...(r?.release?.nodes ?? []), ...(r?.into?.nodes ?? [])].filter(Boolean) };
}

/** A release title's conventional-commit type — the batch's heaviest task type. */
const RELEASE_TYPES = ["feat", "fix", "perf", "refactor", "docs", "test", "build", "ci", "chore"];

/** The tasks of the PRs merged into a batch (`batchTasks`), once each, by number. */
const tasksOf = (merged: { tasks: number[] }[]) => [...new Set(merged.flatMap((m) => m.tasks))].sort((a, b) => a - b);

/**
 * The release PR's title and body (#649) by the PRs merged into the batch (`batchTasks`): the title — a conventional
 * commit by the heaviest task type, the body — the lead with the tasks' PRs, the batch's spec-diff at `head`
 * (`specDiffOf`) and «Closes #N» of each task: the release's merge closes them.
 */
function releaseText(io: Io, batch: string, base: string, head: string, merged: ReturnType<typeof batchTasks>): { title: string; body: string } {
  const tasks = tasksOf(merged);
  const spec = specDiffOf(io, base, head);
  const types = merged.map((m) => m.type);
  const type = RELEASE_TYPES.find((t) => types.includes(t)) ?? "chore";
  const title = `${type}: ${locale.fill(N.release.title, { batch, tasks: tasks.map((n) => `#${n}`).join(", ") })}`;
  const lead = locale.fill(N.release.lead, { batch, prs: merged.map((m) => `#${m.pr} (${m.tasks.map((n) => `#${n}`).join(", ")})`).join(", ") });
  return { title, body: `${[lead, ...(spec ? [spec] : []), tasks.map((n) => `Closes #${n}`).join("\n")].join("\n\n")}\n` };
}

/**
 * The open release PR rebuilt at each repeat of `batch release` (#819): its body was built once, when the PR opened, by
 * the PRs merged into the batch then — a red release's fix PR merged after it (`Refs #<guilty>`, and «Closes #M» of a
 * task it did too) was left out, and the release's merge didn't close M. The title and body by `releaseText` from the
 * PRs merged into the batch now and its fetched head; the body the same — an `=` line, otherwise a PATCH and a `+` line
 * with the tasks added. The fetch failed — a `!` line, the PR as is. The release with the body it has now.
 */
function rebuildRelease(io: Io, slug: string, batch: string, base: string, release: PrRef, prs: Recent): PrRef {
  const fetched = git(io, io.cwd, "fetch", "-q", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`, `+refs/heads/${batch}:refs/remotes/origin/${batch}`);
  if (fetched.status !== 0) return io.out(`! git fetch origin ${base} ${batch}: ${why(fetched)} — the release PR #${release.number}'s body not rebuilt`), release;
  const merged = batchTasks(prs, batch);
  const head = git(io, io.cwd, "rev-parse", "--verify", `refs/remotes/origin/${batch}^{commit}`).stdout.trim();
  const { title, body } = releaseText(io, batch, base, head, merged);
  if (body.trim() === release.body.trim()) return io.out(`= the release PR #${release.number}: the body is current`), release;
  rest(io, `repos/${slug}/pulls/${release.number}`, { method: "PATCH", payload: { title, body } });
  const added = tasksOf(merged).filter((n) => !prTasks(release).includes(n));
  io.out(`+ the release PR #${release.number}: the title and body rebuilt by the PRs merged into ${batch} now${added.length ? ` — Closes ${added.map((n) => `#${n}`).join(", ")} added` : ""}`);
  return { ...release, body };
}

/** The spec-diff script next to the skill — laid out like est (`../spec/scripts/spec-diff.ts`). */
const specDiffScript = (io: Io) => io.env["ELVES_SPEC_DIFF"] ?? path.resolve(import.meta.dir, "../../spec/scripts/spec-diff.ts");

/**
 * The batch's spec section for the release PR body: the spec skill's spec-diff next to this script, by the sources at
 * the two revisions — the merge-base with origin/<base> and the rebased batch — as for a task's PR body. Missing or
 * failed — a line and null: the PR goes without it.
 */
function specDiffOf(io: Io, base: string, head: string, what = "the release PR"): string | null {
  const script = specDiffScript(io);
  if (!existsSync(script)) return io.out(`○ spec-diff is not installed (${script}) — ${what} without the spec section`), null;
  const r = (io.run ?? realRun)("bun", ["--no-env-file", script, "--base", `origin/${base}`, "--head", head], io.cwd);
  if (r.status !== 0) return io.out(`! spec-diff: ${why(r)} — ${what} without the spec section`), null;
  return r.stdout.trim() || null;
}

/** GitHub Actions — the app whose check-runs are jobs with a log (`actions/jobs/<check-run id>/logs`). */
const ACTIONS_APP = 15368;

/** The name a release red by `pr premerge` (#884) shows among its red checks. */
const PREMERGE_CHECK = "pr premerge";

/**
 * A release's checks (#650): red, still running (or none yet) or green; the red names and their latest Actions runs.
 * `premerge` (#884) — `pr premerge` red on its head: the files its ❌ lines name; not red — null.
 */
interface ReleaseChecks {
  state: "red" | "pending" | "green";
  red: string[];
  failed: Any[];
  premerge: string[] | null;
}

/** The release is red (#650, #884): a check, or `pr premerge` on its head — the model's `releaseIsRed`. */
const isRed = (c: ReleaseChecks) => releaseIsRed({ red: c.state === "red", premerge: c.premerge !== null });
/** The release's red names — its red checks, then `pr premerge` red on its head. */
const redNames = (c: ReleaseChecks) => [...c.red, ...(c.premerge ? [PREMERGE_CHECK] : [])];

/**
 * The release PR's checks (#650) by `checkStates` — the rule of `task show` and `ci-wait`: a red one (`fail`, `cancel` —
 * ci-wait's FAIL) — red; otherwise one still running or none yet (the head moved: a fix merged into the batch, the full
 * run starts again) — pending; otherwise green. `failed` — the latest GitHub Actions run of each red name: its job's
 * log names the failed files. Not read (REST failed, no head commit) — pending and an `○` line. `pr premerge` red on
 * the same head (#884, its mark — `markPremerge`) — `premerge`, whatever the checks: the merge is refused, and a fix
 * merged into the batch moves the head, the mark is of the old one.
 */
function releaseChecks(io: Io, slug: string, release: PrRef): ReleaseChecks {
  const mark = release.sha ? premergeMarkOf(io, slug, release.number) : {};
  const premerge = mark.red && mark.head === release.sha ? mark.red : null;
  const pending: ReleaseChecks = { state: "pending", red: [], failed: [], premerge };
  if (!release.sha) return pending;
  let rollup: { nodes: Any[]; runs: Any[] };
  try {
    rollup = restRollup(io, slug, release.sha);
  } catch (e) {
    if (!(e instanceof GhError)) throw e;
    return io.out(`○ the checks of the release PR #${release.number} not read: ${e.message}`), pending;
  }
  const by = [...checkStates(rollup.nodes)];
  const red = by
    .filter(([, v]) => v === "fail" || v === "cancel")
    .map(([k]) => k)
    .sort();
  const latest = new Map<string, Any>();
  for (const r of rollup.runs) if (red.includes(r.name) && r.app?.id === ACTIONS_APP && !(latest.get(r.name)?.id > r.id)) latest.set(r.name, r);
  if (!red.length) return { ...pending, state: !by.length || by.some(([, v]) => v === "pending") ? "pending" : "green" };
  return { state: "red", red, failed: [...latest.values()], premerge };
}

/** A test file's path — `x.test.ts`, `x.spec.tsx`, `x.e2e.ts` in any directory: Bun, Vitest, Jest, Playwright. */
const TEST_FILE = /((?:[\w.@-]+\/)*[\w.@-]+\.(?:test|spec|e2e)\.[cm]?[jt]sx?)\b/;
const isTestFile = (p: string) => new RegExp(`^${TEST_FILE.source}$`).test(p);

/** Terminal escape sequences: OSC (`ESC ] … BEL|ESC \\`, links), CSI (`ESC [ … letter`, colors, erasing), two-byte ones. */
const ANSI = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g;

/**
 * The files a failed job's log names (#650): a failed test's file — in its failure line (Vitest, Jest, Playwright) or in
 * the file header above it (Bun: `tests/…/x.test.ts:`), a compiler error's file — `a.ts(3,5): error TS…` (a `bun check`
 * block too, `asTsc`); failure lines — `FAILED_LINE`, as on the merge. Paths — the checkout's: the runner's workspace
 * prefix (`…/work/<repo>/<repo>/`), the log's timestamps and terminal escape sequences (`ANSI`: colors, erasing, OSC
 * links — #774) are cut.
 */
function failedFilesIn(log: string): string[] {
  const out: string[] = [];
  const rel = (p: string) => p.replace(/^.*?\/work\/[^/]+\/[^/]+\//, "").replace(/^\.\//, "");
  const header = new RegExp(`^\\s*/?${TEST_FILE.source}:$`);
  let current: string | null = null;
  for (const raw of asTsc(log.replace(ANSI, "")).split("\n")) {
    const line = raw
      .replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, "")
      .trimEnd();
    const file = header.exec(line);
    if (file) {
      current = rel(file[1]!);
      continue;
    }
    if (!FAILED_LINE.test(line)) continue;
    const found = /^\s*(\S+?)\(\d+,\d+\): error TS\d+/.exec(line)?.[1] ?? TEST_FILE.exec(line)?.[1] ?? current;
    if (found && !out.includes(rel(found))) out.push(rel(found));
  }
  return out;
}

/** The files the release's failed Actions jobs name in their logs (`failedFilesIn`); a log not read — an `○` line. */
function failedFilesOf(io: Io, slug: string, failed: Any[]): string[] {
  const out: string[] = [];
  for (const r of failed) {
    let log: string;
    try {
      // a runner's log has the terminal's escape sequences (colors, line erasing, links): gh prints it only with the flag (#774)
      log = io.gh(["api", `repos/${slug}/actions/jobs/${r.id}/logs`, "--allow-escape-sequences"]);
    } catch (e) {
      if (!(e instanceof GhError)) throw e;
      io.out(`○ the log of ${r.name} not read: ${e.message}`);
      continue;
    }
    for (const f of failedFilesIn(log)) if (!out.includes(f)) out.push(f);
  }
  return out;
}

/** The guilty task of a red release and what named it (#650). */
interface Guilty {
  number: number;
  why: string;
}

/**
 * The guilty task by the labels (#650): the failed files' decisions — `decisionsOfFiles`, the rule of `pr labels`, a
 * code file's module from the release head's model — against the decision labels of the release's tasks: `pr labels`
 * of each task's PR into the batch set them (it doesn't label from the release PR). One task holds them — it; several —
 * the one whose PR changed the failed test's section (`guiltyBySection`); otherwise null and an `○` line: the bisect decides.
 */
function guiltyByLabels(io: Io, slug: string, sha: string, issues: Issue[], files: string[], prsOf: (task: number) => number[]): Guilty | null {
  const changed = files.map((p) => ({ path: p, changeType: "MODIFIED", additions: 1, deletions: 1 }));
  const modules = files.some((f) => f.split("/")[0] !== "tests") ? modulesAt(io, slug, sha, "the release head") : {};
  const decisions = [...decisionsOfFiles(changed, modules).changed.keys()];
  const none = "no guilty task by the labels";
  if (!decisions.length) return io.out(`○ the failed files name no decision — ${none}`), null;
  const held = (i: Issue) => decisions.filter((d) => i.labels.includes(d));
  const holders = issues.filter((i) => held(i).length);
  const what = `the failed files' ${decisions.length > 1 ? "decisions" : "decision"} ${decisions.join(", ")}`;
  if (holders.length === 1) return { number: holders[0]!.number, why: `the label ${held(holders[0]!).join(", ")} — ${what}` };
  if (holders.length > 1) {
    const bySection = guiltyBySection(io, slug, holders, files, decisions, prsOf);
    if (bySection) return { number: bySection.number, why: `the label ${held(holders.find((i) => i.number === bySection.number)!).join(", ")} — ${what}; ${bySection.why}` };
  }
  io.out(`○ ${what} — ${holders.length ? `the labels of ${holders.map((i) => `#${i.number}`).join(", ")}: not one task` : "no task of the release has the label"} — ${none}`);
  return null;
}

/**
 * Several tasks hold the label of a failed test's topic (#689: a section has no label of its own, its changes label the
 * topic) — the guilty one of them is the task whose PR into the batch changed the files of the failed test's section,
 * `tests/<root>/<topic>/<section>.*`. A failed file not a section's (the topic's own, deeper, a code file), none or
 * several such tasks — null and an `○` line: the bisect decides.
 */
function guiltyBySection(io: Io, slug: string, holders: Issue[], files: string[], decisions: string[], prsOf: (task: number) => number[]): Guilty | null {
  const dirs = new Set<string>(DECISION_KINDS.map((k) => DECISIONS[k].dir));
  const prefixes = new Set<string>();
  for (const f of files) {
    const [root, dir, topic, name, ...rest] = f.split("/");
    const section = name?.split(".")[0];
    if (root === "tests" && dirs.has(dir!) && decisions.includes(topic!) && !rest.length && section && section !== topic) prefixes.add(`tests/${dir}/${topic}/${section}.`);
  }
  if (!prefixes.size) return null;
  const shown = [...prefixes].map((p) => `${p}*`).join(", ");
  const changed = holders.filter((i) => prsOf(i.number).some((n) => loadPrChange(io, slug, n).files.some((f) => [...prefixes].some((p) => f.path.startsWith(p)))));
  if (changed.length === 1) {
    const pr = prsOf(changed[0]!.number).map((n) => `#${n}`).join(", ");
    return { number: changed[0]!.number, why: `of ${holders.map((i) => `#${i.number}`).join(", ")} only its PR ${pr} into the batch changed the section's files ${shown}` };
  }
  io.out(`○ the section's files ${shown} — ${changed.length ? `changed by the PRs of ${changed.map((i) => `#${i.number}`).join(", ")}: not one task` : `no PR into the batch of ${holders.map((i) => `#${i.number}`).join(", ")} changed them`}`);
  return null;
}

/**
 * The bisect of a red release by the task boundaries (#650; question 1 of the task — on the machine, not in CI: a push
 * into the batch branch starts no run there, and a run per step there would be the full set). The batch's commits over
 * its merge-base with origin/<base> in blocks by «Refs #N» of the release's tasks (a commit without one — the block
 * before it); the check at a block's last commit in a temporary worktree (always removed), dependencies by its
 * lockfile: the failed test files there by the project's `test` script, a compiler error — `typecheck`, neither named —
 * the failed checks named like a script; the scripts go through `slot`, the machine queue. First the head — red on the
 * machine, otherwise the red isn't reproduced and nobody is blamed — and the base — green, otherwise the red isn't the
 * batch's; then ⌈log₂N⌉ runs: the first red block's task. One block — it, without runs.
 */
function bisectRelease(io: Io, slug: string, batch: string, base: string, tasks: number[], files: string[], red: string[]): Guilty | null {
  const stop = (line: string) => (io.out(`! bisect: ${line}`), null);
  const byLogs = "the guilty task by the failed checks' logs";
  if (!checkoutOfRepo(io, originUrl(io), slug)) return stop(`the current directory is not a checkout of ${slug} — ${byLogs}`);
  const fetched = git(io, io.cwd, "fetch", "-q", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`, `+refs/heads/${batch}:refs/remotes/origin/${batch}`);
  if (fetched.status !== 0) return stop(`git fetch origin ${base} ${batch}: ${why(fetched)}`);
  const mb = git(io, io.cwd, "merge-base", `refs/remotes/origin/${base}`, `refs/remotes/origin/${batch}`).stdout.trim();
  const listed = git(io, io.cwd, "log", "--reverse", "--first-parent", "--format=%H%x1f%B%x1e", `${mb}..refs/remotes/origin/${batch}`);
  if (!mb || listed.status !== 0) return stop(`the commits of ${batch} over origin/${base} not read: ${why(listed)}`);
  const blocks: { task: number | null; last: string; commits: number }[] = [];
  for (const record of listed.stdout.split("\x1e")) {
    const [sha = "", message = ""] = record.replace(/^\n/, "").split("\x1f");
    if (!sha.trim()) continue;
    const prev = blocks.at(-1);
    const task = [...message.matchAll(/\bRefs:?\s+#(\d+)\b/gi)].map((m) => Number(m[1])).find((n) => tasks.includes(n)) ?? prev?.task ?? null;
    if (prev && prev.task === task) Object.assign(prev, { last: sha.trim(), commits: prev.commits + 1 });
    else blocks.push({ task, last: sha.trim(), commits: 1 });
  }
  const named = (b: (typeof blocks)[number]) => (b.task === null ? "commits without Refs #N" : `#${b.task}`);
  if (!blocks.length) return stop(`no commits in ${batch} over origin/${base}`);
  io.out(`bisect: ${batch} over origin/${base} (${mb.slice(0, 7)}) — ${plural(blocks.length, "task block", "task blocks")}: ${blocks.map((b) => `${named(b)} (${plural(b.commits, "commit", "commits")})`).join(", ")}`);
  const first = blocks[0]!;
  if (blocks.length === 1) return first.task === null ? stop(`the batch's commits have no Refs #N of its tasks — ${byLogs}`) : { number: first.task, why: "the batch's only task block" };

  const bisect = (dir: string): Guilty | null => {
    // the check — chosen by the head's scripts: what the failed checks' logs name
    const scripts = scriptsOf(dir);
    const tests = files.filter(isTestFile);
    const plan = [...(files.some((f) => !isTestFile(f)) && scripts["typecheck"] ? [{ script: "typecheck", tests: false }] : []), ...(tests.length && scripts["test"] ? [{ script: "test", tests: true }] : [])];
    if (!plan.length) plan.push(...red.filter((n) => scripts[n]).map((n) => ({ script: n, tests: false })));
    if (!plan.length) return stop(`the failed checks ${red.join(", ")} name no test file or compiler error, and no package.json script is named like them — ${byLogs}`);
    const shown = plan.map((s) => [...projectCommands(dir).run(s.script), ...(s.tests ? tests : [])].join(" ")).join(", then ");
    io.out(`bisect: the check — ${shown}; the head, the base, then ${plural(Math.ceil(Math.log2(blocks.length)), "run", "runs")}`);
    /** The check at a commit: red, green, or why it didn't run. */
    const check = (sha: string): string => {
      const co = git(io, dir, "checkout", "-q", "--detach", sha);
      if (co.status !== 0) return `git checkout: ${why(co)}`;
      // a failed test not there yet fails nothing at this commit
      const present = tests.filter((f) => existsSync(path.join(dir, f)));
      const c = checkTree(io, dir, plan.flatMap((s) => (!s.tests ? [{ script: s.script }] : present.length ? [{ script: s.script, args: present }] : [])));
      if (c.install && c.install.result.status !== 0) return `${c.install.cmd}: ${why(c.install.result)}`;
      return c.red ? "red" : "green";
    };
    const probe = (k: number): string => {
      const sha = k < 0 ? mb : blocks[k]!.last;
      const r = check(sha);
      io.out(`○ ${k < 0 ? `the base ${sha.slice(0, 7)}` : `${sha.slice(0, 7)} — after ${named(blocks[k]!)}`}: ${r === "red" || r === "green" ? r : `not checked — ${r}`}`);
      return r;
    };
    const top = probe(blocks.length - 1);
    if (top === "green") return stop(`the head of ${batch} is green on the machine — the release's red isn't reproduced (the merge with origin/${base}, the CI's environment, an unstable test — by its cause): nobody is blamed, ${byLogs}`);
    if (top !== "red") return stop(`the head not checked — ${byLogs}`);
    const bottom = probe(-1);
    if (bottom === "red") return stop(`the base is red on the machine too — the red isn't the batch's (main or the machine): nobody in the batch is blamed`);
    if (bottom !== "green") return stop(`the base not checked — ${byLogs}`);
    let lo = -1;
    let hi = blocks.length - 1;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      const r = probe(mid);
      if (r === "red") hi = mid;
      else if (r === "green") lo = mid;
      else return stop(`a boundary not checked — ${byLogs}`);
    }
    const guilty = blocks[hi]!;
    if (guilty.task === null) return stop(`the first red block — commits without Refs #N up to ${guilty.last.slice(0, 7)} — ${byLogs}`);
    return { number: guilty.task, why: `the first red task block of the bisect (${guilty.last.slice(0, 7)})` };
  };
  try {
    return inTempWorktree(io, "bisect", blocks.at(-1)!.last, bisect);
  } catch (e) {
    // the temporary worktree not added — the only GhError of the bisect
    if (!(e instanceof GhError)) throw e;
    return stop(e.message);
  }
}

/**
 * A red release (#650) — what its fix is. A release task's PR into the batch is open — the fix is going (`fixing`):
 * wait for it, no bisect. Otherwise the guilty task: the release's only task, by the labels of the failed files'
 * decisions (`guiltyByLabels`) — the files the failed jobs' logs name and those of `pr premerge`'s ❌ lines (#884: a
 * spec-red test marked existing behavior against the batch, red on the default branch's code), otherwise the bisect
 * (`bisectRelease`) — `batch release`'s, of a red check only: red only by pr premerge, every test is green on the
 * machine; the queue (`bisect` false) names that command. Prints its lines.
 */
function redRelease(io: Io, slug: string, batch: string, base: string, release: PrRef, prs: Recent, checks: ReleaseChecks, bisect: boolean): { fixing: PrRef | null; guilty: (Guilty & { issue: Issue }) | null } {
  const tasks = prTasks(release);
  const fixing = openInto(prs, batch).map(prRef).find((p) => p.state === "OPEN" && prTasks(p).some((n) => tasks.includes(n))) ?? null;
  if (fixing) {
    io.out(`○ the fix PR #${fixing.number} (${prTasks(fixing).map((n) => `#${n}`).join(", ")}) into ${batch} is open — its executor goes on; after its merge the release's full run goes again on PR #${release.number}`);
    return { fixing, guilty: null };
  }
  const issues = tasks.map((n) => loadIssue(io, slug, n));
  const named = (): Guilty | null => {
    if (issues.length < 2) return issues.length ? { number: tasks[0]!, why: "the release's only task" } : null;
    const ci = checks.state === "red";
    const logs = ci ? failedFilesOf(io, slug, checks.failed) : [];
    if (ci) io.out(logs.length ? `○ the failed checks' logs name ${logs.join(", ")}` : `○ the failed checks' logs name no file`);
    // pr premerge red on the release's head (#884): the files of its ❌ lines — spec-red's tests, the merge's failures —
    // go by the labels as the logs' files do
    const premerge = checks.premerge ?? [];
    if (checks.premerge) io.out(premerge.length ? `○ the ❌ lines of pr premerge ${release.number} name ${premerge.join(", ")}` : `○ the ❌ lines of pr premerge ${release.number} name no file`);
    const files = [...new Set([...logs, ...premerge])];
    // a task's PRs merged into the batch — whose changed a failed test's section (#689)
    const merged = batchTasks(prs, batch);
    const prsOf = (n: number) => merged.filter((m) => m.tasks.includes(n)).map((m) => m.pr);
    // the bisect reproduces a red check of the CI on the machine; red only by pr premerge — nothing to reproduce (#884)
    return guiltyByLabels(io, slug, release.sha, issues, files, prsOf) ?? (bisect && ci ? bisectRelease(io, slug, batch, base, tasks, logs, checks.red) : null);
  };
  const guilty = named();
  if (!guilty) return { fixing: null, guilty: null };
  const issue = issues.find((i) => i.number === guilty.number) ?? loadIssue(io, slug, guilty.number);
  io.out(`guilty: #${guilty.number} ${q(issue.title)} — ${guilty.why}`);
  return { fixing: null, guilty: { ...guilty, issue } };
}

/**
 * The red release a task's fix is for (#650): the batch's release PR is open, has the task in its «Closes #N», and its
 * checks are red or `pr premerge` is red on its head (#884); otherwise null — the task's assignment is the batch's usual
 * one. `premerge` — red by pr premerge: the cause is in its ❌ lines, not only in the checks' logs.
 */
function fixOf(io: Io, slug: string, batch: string, number: number, prs = batchPrs(io, slug, batch)): { release: PrRef; red: string[]; ci: boolean; premerge: boolean } | null {
  const release = releasePrOf(prs, batch);
  if (release?.state !== "OPEN" || !prOfTask(release, number)) return null;
  const checks = releaseChecks(io, slug, release);
  return isRed(checks) ? { release, red: redNames(checks), ci: checks.state === "red", premerge: checks.premerge !== null } : null;
}

/**
 * The fix of a red release (#650) — `Next:` of `batch release` and of the queue, one text: the guilty task's executor
 * (continued, or a new one with the same prompt) fixes it in the batch by its assignment, then the release's full run
 * goes again on the same PR; the other tasks wait for the release. Which fix — the model's (`redFix`, queue.ts): the
 * fix going — its wait; the guilty task named — its fix; not named — `batch release` names it (the queue), or the logs
 * and the owner (after the bisect). Here — only its text.
 */
function fixSteps(slug: string, batch: string, release: PrRef, checks: ReleaseChecks, r: ReturnType<typeof redRelease>, bisects: boolean): string[] {
  const lead = `Next: the release PR #${release.number} https://github.com/${slug}/pull/${release.number} of ${batch} is red (${redNames(checks).join(", ")})`;
  /** Where the dispatcher reads the cause: the failed checks' logs, the ❌ lines of pr premerge (#884). */
  const sources = [checks.state === "red" && `the failed checks' logs (gh pr checks ${release.number})`, checks.premerge && `the ❌ lines of pr premerge ${release.number}`].filter(Boolean).join(" and ");
  const again =
    `after its merge into ${batch} — the release's full run again on the same PR #${release.number}: batch release prints its steps; ` +
    `the other tasks of the batch wait — no new executors till the release's merge; ${SESSION_ARCHIVE}.`;
  const command = `bun --no-env-file ${import.meta.path} batch release --repo ${slug}`;
  const text: Record<Fix, () => string[]> = {
    wait: () => [`${lead}: its fix PR #${r.fixing!.number} into ${batch} is open — wait for its executor's answer; ${again}`],
    guilty: () => {
      const g = r.guilty!;
      return [
        `${lead} — the guilty task #${g.number} ${q(g.issue.title)} fixes it in the batch: its executor — continued with SendMessage, the indented line its message; none alive — a new one, ${EXECUTOR_AGENT}, with it as the prompt. ` +
          `Its assignment (task queue --assignment ${g.number}) names the red release: a new task branch from origin/${batch}, the PR into ${batch} with Refs #${g.number}, the checks before a commit, no CI; ${again}`,
        `  ${executorPrompt(slug, g.number, g.issue.parent?.number ?? null)}`,
      ];
    },
    bisect: () => [
      `${lead} — the guilty task: ${command} names it (the labels of the failed tests' decisions, otherwise a bisect by the task boundaries on the machine — a background command) and prints its fix; ${again}`,
    ],
    owner: () => [
      `${lead} — the guilty task isn't named (the lines above say why): by ${sources} the dispatcher names it or asks the owner, then its fix — task queue --assignment <N> to its executor; ${again}`,
    ],
  };
  return text[redFix({ fixing: r.fixing !== null, guilty: r.guilty !== null, bisects, bisectable: checks.state === "red" })]();
}

/**
 * The release of the dispatcher's batch (#649, epic #645): what is merged into the batch branch goes into the default
 * branch by one PR — one full CI run and one deploy for the batch. The batch — the session's (its marker, `batchOf`) or
 * the one named. The rules are the model's (queue.ts, #867): the release's state by its PR and its checks, what the
 * command does in it and `Next:` — `releaseRun` by the transitions table; the actions and the texts are here.
 * `none` — `openRelease`; nothing merged into the batch — a refusal. `open` — its title and body rebuilt by what is
 * merged into the batch now (`rebuildRelease`, #819), then its steps again; `red` (#650) — the same, then its guilty
 * task and the fix in the batch (`redRelease`, `fixSteps`), the PR stays open; `merged` — the batch executors'
 * worktrees removed and the closing steps, for the tasks of its «Closes» and of the PRs merged into the batch.
 * Outside auto (#667) the release's merge in `Next:` waits for the owner's «yes», as the executors' merges do.
 */
export function cmdBatchRelease(io: Io, slug: string, named?: string): number {
  const batch = named ?? batchOf(io, slug);
  if (!batch) throw new GhError(`no batch branch of ${slug} in this session — a batch project's task queue starts it; or name it: batch release batch/<YYYY-MM-DD>-<k>`);
  if (!isBatchBranch(batch)) throw new GhError(`«${batch}» is not a batch branch — batch/<YYYY-MM-DD>-<k>`);
  if (!checkoutOfRepo(io, originUrl(io), slug)) throw new GhError(`the release runs from a checkout of ${slug}: the current directory is not one`);
  const prs = batchPrs(io, slug, batch);
  const base = prs.base;
  const link = (n: number) => `#${n} https://github.com/${slug}/pull/${n}`;
  const script = `bun --no-env-file ${import.meta.path}`;
  // the epic refresh — the release's, not each executor's (#676): one per epic of the batch's tasks, in the same turn as
  // the deploy wait; task close of each — after both, its refusal waits for its epic's report
  const closing = (pr: number, tasks: number[]) =>
    `where the merge deploys — bash ${waitCi()} merged ${pr} as a background command; in the same turn — the epic refresh, one per epic of the batch's tasks: ` +
    `${script} task actualize ${tasks.join(" ")} — it groups them by epic and prints each epic's subagent prompt (a background subagent each, a fresh context); ` +
    `after the deploy and the refreshes' reports — task close of each task of the batch, GitHub closed them by the release's «Closes»: ` +
    `${tasks.map((n) => `${script} task close ${n}`).join("; ")} — the batch branch ${batch} goes with them (while a live executor's PR is into it — kept, the dispatcher's task queue deletes it later)`;
  // outside auto the release's merge is the owner's «yes» too (#667): the dispatcher's request is the work's scope
  const yes = locale.autoProject(io.cwd ?? process.cwd()) ? "" : "the owner's «yes» (the project is without auto) — then ";
  const steps = (pr: number, tasks: number[]) =>
    `Next: the release PR ${link(pr)} — its checks: bash ${waitCi()} pr ${pr} as a background command; PASS — ${script} pr premerge ${pr}, code 0 — ${yes}gh pr merge ${pr} --rebase as a separate call. ` +
    `FAIL, or pr premerge ❌ (code 1 — the release is red by it) — ${script} batch release --repo ${slug} again: it names the guilty task and prints its fix in the batch, the release PR stays open. ` +
    `After the merge: ${script} batch release --repo ${slug} again — it removes the batch executors' worktrees and branches and prints the closing steps; ` +
    `the dispatcher goes on — task queue at once: it starts the next batch from the merged ${base} (a group — only from its tasks still open; nothing left — no new batch), and the live executors' PRs go into it (their pr premerge moves them); ` +
    `it stops — no queue: they go into ${base} with the full CI. Then ${closing(pr, tasks)}.`;
  const release = releasePrOf(prs, batch);
  const merged = batchTasks(prs, batch);
  // the open release's checks: red (#650), or pr premerge red on its head (#884) — its guilty task fixes it in the batch,
  // then the full run again on the same PR
  const checks = release && !release.merged ? releaseChecks(io, slug, release) : null;
  const run = releaseRun({ pr: release ? { merged: release.merged, red: checks?.state === "red", premerge: Boolean(checks?.premerge) } : null, merged: merged.length });
  if (!run) throw new GhError(`nothing is merged into ${batch} — nothing to release`);
  /** The open release after its line: its title and body rebuilt by what is merged into the batch now (#819). */
  const rebuilt = (line: string) => {
    io.out(line);
    const r = rebuildRelease(io, slug, batch, base, release!, prs);
    return { pr: r, tasks: prTasks(r) };
  };
  /** What the command does in the release's state: the release PR it leaves (opened, rebuilt, merged) and its tasks; a rebase conflict — null. */
  const act: Record<ReleaseState, () => { pr: PrRef; tasks: number[] } | null> = {
    none: () => {
      const opened = openRelease(io, slug, batch, base, prs, merged);
      return opened && { pr: opened, tasks: tasksOf(merged) };
    },
    open: () => rebuilt(`= the release PR ${link(release!.number)} of ${batch} is open`),
    red: () => rebuilt(`! the release PR ${link(release!.number)} of ${batch} is red: ${redNames(checks!).join(", ")}`),
    merged: () => {
      io.out(`○ ${batch} is released by PR ${link(release!.number)}`);
      // the batch executors' worktrees and branches go with the release (#698), as before the queue: a dispatcher that
      // stops runs no queue; git cherry — against a fresh origin/<base>, the release's commits are in it
      const fresh = git(io, io.cwd, "fetch", "-q", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`);
      if (fresh.status !== 0) io.out(`! git fetch origin ${base}: ${why(fresh)} — the executors' worktrees are checked against the local origin/${base}`);
      pruneExecutors(io, slug, handedOut(io, slug), openOf(io, slug));
      // a task merged into the batch past the release's «Closes» (#819: a fix PR merged, the release not rebuilt) — its
      // refresh and task close too: task close closes it as released by this PR
      return { pr: release!, tasks: tasksOf([{ tasks: prTasks(release!) }, ...merged]) };
    },
  };
  const left = act[run.from]();
  if (left === null) return 1;
  const { pr, tasks } = left;
  // `Next:` — the step of the state the command leaves the release in (queue.ts: the transitions table)
  const next: Record<ReleaseStep, () => string[]> = {
    checks: () => [steps(pr.number, tasks)],
    fix: () => fixSteps(slug, batch, pr, checks!, redRelease(io, slug, batch, base, pr, prs, checks!, true), true),
    close: () => [`Next: ${closing(pr.number, tasks)}.`],
  };
  for (const line of next[run.next]()) io.out(line);
  return 0;
}

/**
 * The release PR opened (`none` → `open`, #649): the tasks merged into the batch (`batchTasks`), the batch branch
 * rebased onto a fresh origin/<base> in a temporary worktree and pushed with `--force-with-lease` (on it already — no
 * rebase; a conflict — a `!` line and null, the branch unchanged), the PR into the default branch: the title — a
 * conventional commit by the heaviest task type, the body — the lead, the batch's spec-diff (`specDiffOf`) and «Closes
 * #N» of each task: the merge closes them, and `task close` finds the release PR linked. The live executors' open PRs
 * into the batch aren't in it (question 2 of epic #645 — they aren't stopped): `○` lines; their `pr premerge` holds the
 * merge till the release, then moves them on (`batchBase`). The PR opened.
 */
function openRelease(io: Io, slug: string, batch: string, base: string, prs: Recent, merged: ReturnType<typeof batchTasks>): PrRef | null {
  for (const p of openInto(prs, batch)) {
    const of = prTasks(p);
    io.out(`○ PR #${p.number}${of.length ? ` (${of.map((n) => `#${n}`).join(", ")})` : ""} into ${batch} is open — not in the release: its executor goes on, its pr premerge holds the merge till the release, then moves the PR to the next batch or ${base}`);
  }
  // the decision labels of the batch's tasks by their PRs' files, before the release PR (#733): a PR merged without them
  // gets them here — the release's own diff gives none
  for (const m of merged) {
    try {
      const plan = prLabelPlan(io, slug, m.pr);
      if (!("release" in plan)) for (const l of applyPrLabels(io, slug, plan, false)) io.out(l);
    } catch (e) {
      if (!(e instanceof GhError)) throw e;
      io.out(`! decision labels of PR #${m.pr} (${m.tasks.map((n) => `#${n}`).join(", ")}) not checked: ${e.message} — bun --no-env-file ${import.meta.path} pr labels ${m.pr}`);
    }
  }

  const fetched = git(io, io.cwd, "fetch", "-q", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`, `+refs/heads/${batch}:refs/remotes/origin/${batch}`);
  if (fetched.status !== 0) throw new GhError(`git fetch origin ${base} ${batch}: ${why(fetched)}`);
  const sha = (cwd: string | undefined, ref: string) => git(io, cwd, "rev-parse", "--verify", `${ref}^{commit}`).stdout.trim();
  const old = sha(io.cwd, `refs/remotes/origin/${batch}`);
  const onto = sha(io.cwd, `refs/remotes/origin/${base}`);
  let head = old;
  if (git(io, io.cwd, "merge-base", "--is-ancestor", onto, old).status === 0) io.out(`= ${batch} is on origin/${base} (${onto.slice(0, 7)}) — no rebase`);
  else {
    // the rebased head; a conflict — null
    const rebasedHead = inTempWorktree(io, "release", old, (dir) => {
      // the commits keep their authors; the committer — the machine's git identity, none (CI) — the flow's
      const who = git(io, dir, "config", "user.email").stdout.trim() ? [] : ["-c", "user.name=elves", "-c", "user.email=elves@localhost"];
      const rebased = git(io, dir, ...who, "rebase", "-q", onto);
      if (rebased.status === 0) return sha(dir, "HEAD");
      const files = git(io, dir, "diff", "--name-only", "--diff-filter=U").stdout.split("\n").filter(Boolean);
      git(io, dir, "rebase", "--abort");
      io.out(
        `! ${batch} doesn't rebase onto origin/${base}: ${files.length ? `a conflict — ${files.join(", ")}` : why(rebased)} — the branch is unchanged, no release PR. ` +
          `Rebase it by hand in the checkout: git switch --detach origin/${batch}, git rebase origin/${base}, resolve, git push --force-with-lease origin HEAD:${batch}; then batch release again`,
      );
      return null;
    });
    if (rebasedHead === null) return null;
    head = rebasedHead;
    const pushed = git(io, io.cwd, "push", "-q", `--force-with-lease=refs/heads/${batch}:${old}`, "origin", `${head}:refs/heads/${batch}`);
    if (pushed.status !== 0) throw new GhError(`git push --force-with-lease origin ${batch}: ${why(pushed)}`);
    io.out(`+ ${batch} rebased onto origin/${base} (${onto.slice(0, 7)}): ${old.slice(0, 7)} → ${head.slice(0, 7)}, pushed`);
  }

  const { title, body } = releaseText(io, batch, base, head, merged);
  const created = rest(io, `repos/${slug}/pulls`, { method: "POST", payload: { title, head: batch, base, body } });
  io.out(`+ the release PR #${created.number} https://github.com/${slug}/pull/${created.number}: ${title}`);
  return prRef(created);
}

/** A Claude Code agent's worktree (`isolation: "worktree"`): `<checkout>/.claude/worktrees/agent-<id>`, branch `worktree-agent-<id>`. */
const AGENT_WORKTREE = /[\\/]\.claude[\\/]worktrees[\\/]agent-[^\\/]+$/;
const AGENT_BRANCH = /^worktree-agent-/;
/** Claude Code's lock of an agent's worktree: `claude agent agent-<id> (pid N start …)` — N is the app's process (#899). */
const APP_LOCK = /^claude agent \S+ \(pid \d+\b/;

/** What `pruneAgentWorktrees` removes. */
interface PruneScope {
  /** An executor's worktree whose handed-out task is live — not touched (#533). */
  kept: (dir: string) => boolean;
  /** The task is closed and its tail over (#698): a task branch of it goes. */
  closed: (task: number) => boolean;
  /** The tasks handed out with the worktree — its executor's (#899: the app's lock of a closed one's is stale); none — []. */
  tasksOf?: (dir: string) => number[];
  /** Only the worktrees on these branches, loose branches not read — `task close`'s (#899); all — undefined. */
  branches?: Set<string>;
}

interface Worktree {
  path: string;
  head: string;
  /** The checked out branch; detached — null. */
  branch: string | null;
  /** The lock's reason ("" — locked without one); not locked — null. */
  locked: string | null;
  /** The directory is gone — `git worktree prune` business, not ours. */
  prunable: boolean;
}

/** `git worktree list --porcelain`: a block per worktree, an attribute per line (`worktree <path>`, `HEAD`, `branch`, `locked [reason]`). */
function worktreeList(text: string): Worktree[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => {
      const lines = block.split("\n");
      const attr = (key: string) => {
        const line = lines.find((l) => l === key || l.startsWith(`${key} `));
        return line === undefined ? null : line.slice(key.length + 1);
      };
      return { path: attr("worktree") ?? "", head: attr("HEAD") ?? "", branch: attr("branch")?.replace(/^refs\/heads\//, "") ?? null, locked: attr("locked"), prunable: attr("prunable") !== null };
    })
    .filter((w) => w.path);
}

/**
 * Whether a lock still holds: Claude Code locks a running agent's worktree — `claude agent agent-<id> (pid N start …)`
 * — and unlocks it when the agent finishes. Its process is gone (the app restarted, the agent died with it) — the lock
 * is stale. A lock without a pid is someone else's — it holds. The pid is the app's, alive the whole session: a lock
 * that outlived its agent — `pruneAgentWorktrees` (#899).
 */
function lockHolds(reason: string): boolean {
  const pid = /\bpid (\d+)\b/.exec(reason)?.[1];
  if (!pid) return true;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The dispatcher's executors' worktrees go (`pruneAgentWorktrees`) — before the queue and after the batch's release
 * (#698): an executor's whose handed-out task is open is kept (#533); an agent's on the task branch of a closed task goes
 * too — a batch executor ends on its task branch, and the release closes the task (GitHub, by its «Closes»).
 */
function pruneExecutors(io: Io, slug: string, handed: HandOut[], isOpen: (n: number) => boolean, awaiting = awaitingCloseOf(io, slug, handed)): void {
  const executors = handed.flatMap((h) => (h.worktree === null ? [] : [{ number: h.number, worktree: realPath(h.worktree) }]));
  // a task closed by its PR's merge, task close not run yet (#769): its executor waits for the deploy in that worktree
  const live = (n: number) => isOpen(n) || awaiting(n) !== null;
  const of = (dir: string) => executors.filter((h) => h.worktree === realPath(dir));
  pruneAgentWorktrees(io, slug, {
    kept: (dir) => of(dir).some((h) => live(h.number)),
    closed: (n) => !live(n),
    tasksOf: (dir) => of(dir).map((h) => h.number),
  });
}

/**
 * A handed-out task closed by its PR's merge, the tail not over (#769): «Closes #N» closes the issue at the merge into the
 * default branch, while its executor still waits for the deploy, runs the epic refresh and `task close`. The task's work
 * lives till `task close` — what it leaves (`tailOver`: Status Done and the actual), not the issue's state: till then the
 * queue keeps the executor's worktree, shows the task `=` and holds its dependents. A release PR's merge (its head — a
 * batch branch) isn't one: the batch's executors are done, the dispatcher closes their tasks. The closing PR's number;
 * otherwise — null. Read once per number; an issue not read — null.
 */
function awaitingCloseOf(io: Io, slug: string, handed: HandOut[]): (n: number, issue?: Issue) => number | null {
  const memo = new Map<number, number | null>();
  return (n, issue) => {
    if (!handed.some((h) => h.number === n)) return null;
    if (!memo.has(n)) {
      let pr: number | null = null;
      try {
        const i = issue ?? loadIssue(io, slug, n);
        const closer = i.state === "CLOSED" && i.stateReason === "COMPLETED" ? i.prs.find((p) => p.merged && !isBatchBranch(p.base) && !isBatchBranch(p.head)) : undefined;
        if (closer && !tailOver(io, slug, n)) pr = closer.number;
      } catch (e) {
        if (!(e instanceof GhError)) throw e;
      }
      memo.set(n, pr);
    }
    return memo.get(n)!;
  };
}

/** The issue's state, read once per command: open — true; not read (no such issue) — open, nothing is removed for it. */
function openOf(io: Io, slug: string): (n: number) => boolean {
  const states = new Map<number, boolean>();
  return (n) => {
    if (!states.has(n)) {
      try {
        states.set(n, loadIssue(io, slug, n).state === "OPEN");
      } catch (e) {
        if (!(e instanceof GhError)) throw e;
        states.set(n, true);
      }
    }
    return states.get(n)!;
  };
}

/**
 * Executors' worktrees go away with the dispatcher's next queue (#515): an executor can't remove its own — it works in it,
 * and `task close` leaves it detached on origin/<base>; its subagents leave theirs on `worktree-agent-*` branches.
 * Only agents' worktrees (`AGENT_WORKTREE`), detached or on a `worktree-agent-*` branch, not locked by a live process
 * (a running agent): clean and without commits outside origin/<base> (`git cherry` — a rebase merge gives new SHAs), or
 * clean with its HEAD in a merged PR of its closed task (`mergedByPr`, #816: a batch's release rewrites the commits
 * past `git cherry`) — removed with their branch, a `+` line each; uncommitted changes or unmerged commits — left, a `○` line with the
 * reason. A `worktree-agent-*` branch without a worktree — the same by its commits. A session's worktree, an agent's on
 * a task branch of an open task (`closed` — #698: a closed one's goes with its branch, as above), an executor's whose handed-out task is open (`kept`, #533: Claude Code unlocks
 * an agent's worktree when it ends its answer — a question too — and doesn't lock it again when the agent is continued
 * with `SendMessage` after a restart) — not touched, no line. A worktree a subagent of its agent works in without one
 * of its own (`guestWhy`, #571: the executor answered, its epic refresh still ran in its directory) — left, a `○` line
 * naming the subagent. The app's lock that outlived its agent (`staleLock`, #899) doesn't hold: removed or left by
 * the same rules, the line naming why the lock is stale. `branches` — only the worktrees on them, loose branches not
 * read (`task close`: `git branch -D` refuses a branch a worktree is on). The directory isn't a checkout of the
 * repository — nothing.
 */
function pruneAgentWorktrees(io: Io, slug: string, scope: PruneScope): void {
  const { kept, closed, tasksOf = () => [], branches } = scope;
  if (!checkoutOfRepo(io, originUrl(io), slug)) return;
  const listed = git(io, io.cwd, "worktree", "list", "--porcelain");
  if (listed.status !== 0) return;
  const all = worktreeList(listed.stdout);
  const here = git(io, io.cwd, "rev-parse", "--show-toplevel").stdout.trim();
  const base = git(io, io.cwd, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD").stdout.trim().replace(/^origin\//, "") || "main";
  const upstream = `origin/${base}`;
  /** Commits of the ref outside origin/<base> by patch (`git cherry`), or why they couldn't be counted. */
  const unmerged = (ref: string): string | null => {
    const r = git(io, io.cwd, "cherry", upstream, ref);
    if (r.status !== 0) return `git cherry ${upstream}: ${why(r)}`;
    const n = r.stdout.split("\n").filter((l) => l.startsWith("+")).length;
    return n ? `${plural(n, "commit", "commits")} not in ${upstream}` : null;
  };
  /** A batch branch's merged release PR (`releasePrOf`), read once per batch; not released or not read — null. */
  const releases = new Map<string, number | null>();
  const releasedBy = (batch: string): number | null => {
    if (!releases.has(batch)) {
      let pr: number | null = null;
      try {
        const release = releasePrOf(batchPrs(io, slug, batch), batch);
        pr = release?.merged ? release.number : null;
      } catch (e) {
        if (!(e instanceof GhError)) throw e;
      }
      releases.set(batch, pr);
    }
    return releases.get(batch)!;
  };
  /**
   * Merged by its PR (#816): a batch's release rebases the batch onto a fresh origin/<base>, and a task's commit reaches
   * the default branch rewritten twice — its patch differs there by context, and `git cherry` counts it unmerged. GitHub
   * names the PRs of a commit (`commits/<sha>/pulls`); one counts when it is merged, its head is the HEAD or a descendant
   * of it, its tasks are closed (`closed`), and its base is the default branch or a batch branch its merged release PR
   * shipped. The reason for the `+` line; none, or not read — null: `git cherry` decides.
   */
  const mergedByPr = (sha: string): string | null => {
    let pulls: Any[];
    try {
      pulls = rest(io, `repos/${slug}/commits/${sha}/pulls`) ?? [];
    } catch (e) {
      if (!(e instanceof GhError)) throw e;
      return null;
    }
    for (const p of pulls) {
      const r = prRef(p);
      const tasks = prTasks(p);
      if (!r.merged || !r.sha || !tasks.length || !tasks.every(closed)) continue;
      if (r.sha !== sha && git(io, io.cwd, "merge-base", "--is-ancestor", sha, r.sha).status !== 0) continue;
      const release = isBatchBranch(r.base) ? releasedBy(r.base) : null;
      if (r.base !== base && release === null) continue;
      const into = release === null ? r.base : `${r.base} (released by PR #${release})`;
      return `its HEAD is in PR #${r.number} merged into ${into}, ${tasks.map((n) => `#${n}`).join(", ")} closed`;
    }
    return null;
  };
  const deleteBranch = (branch: string) => {
    const d = git(io, io.cwd, "branch", "-D", branch);
    if (d.status !== 0) io.out(`! git branch -D ${branch}: ${why(d)}`);
    return d.status === 0;
  };
  /** A task branch whose task is closed (#698) — a batch executor's after the release. */
  const closedTaskBranch = (branch: string) => {
    const t = taskBranch(branch);
    return t !== null && closed(t.issue);
  };
  // the subagents of this session and of the machine's other sessions with hand-outs: their executors' worktrees are
  // here too — read once, when a worktree needs them
  let agents: Map<string, Subagent> | null = null;
  const agentsOf = () => (agents ??= subagentsOf(io, [io.env["CLAUDE_CODE_SESSION_ID"] ?? "", ...handOutFiles(io).map((h) => h.session)].filter(Boolean)));
  /**
   * The app's lock that outlived its agent (#899): Claude Code locks an agent's worktree with the pid of its own process
   * — the app's, alive the whole session, — and two batch executors that answered «waiting on my background work»
   * first, their result later, kept the lock past their end. Stale — every task of the worktree (its task branch's, its
   * hand-outs') closed and the agent's transcript quiet `QUIET_MINUTES`: the task says no work is left, the quiet — that
   * the agent isn't writing now; either alone is weaker. Why it's stale; it holds — null.
   */
  const staleLock = (w: Worktree): string | null => {
    if (w.locked === null || !APP_LOCK.test(w.locked)) return null;
    const own = w.branch === null ? undefined : taskBranch(w.branch)?.issue;
    const tasks = [...new Set([...(own === undefined ? [] : [own]), ...tasksOf(w.path)])].sort((a, b) => a - b);
    if (!tasks.length || !tasks.every(closed)) return null;
    const id = agentIdOf(w.path)!;
    const written = agentsOf().get(id)?.written ?? 0;
    const minutes = Math.floor((Date.now() - written) / 60_000);
    if (written === 0 || minutes < QUIET_MINUTES) return null;
    return `the app's lock is stale — ${tasks.map((n) => `#${n}`).join(", ")} closed, agent-${id}'s transcript quiet ${minutes} min`;
  };
  /** The worktrees whose live process's lock is stale (`staleLock`) — why. */
  const stale = new Map<string, string>();
  /** A lock held by a live process — its reason; none, of a process gone or outlived its agent — null. */
  const held = (w: Worktree) => {
    if (w.locked === null || !lockHolds(w.locked)) return null;
    const why = staleLock(w);
    if (why === null) return w.locked;
    stale.set(w.path, why);
    return null;
  };
  // a running agent (its lock) and a live hand-out's executor are passed silently; HEAD's move isn't read here: task
  // close itself detaches the worktree, a finished executor's HEAD moves last (the restart's check reads it — aliveWhy)
  const candidates = all
    .filter((w) => AGENT_WORKTREE.test(w.path) && w.path !== here && !w.prunable && (w.branch === null || AGENT_BRANCH.test(w.branch) || closedTaskBranch(w.branch)))
    .filter((w) => branches === undefined || (w.branch !== null && branches.has(w.branch)))
    .filter((w) => worktreeRemovable(executorOf({ lock: held(w), guest: null, moved: null }).state, kept(w.path)))
    .sort((a, b) => a.path.localeCompare(b.path));
  for (const w of candidates) {
    const executor = executorOf({ lock: null, guest: guestWhy(agentsOf(), agentIdOf(w.path)!), moved: null });
    if (!worktreeRemovable(executor.state, false)) {
      io.out(`○ worktree ${w.path} left: ${executor.why}`);
      continue;
    }
    const lock = stale.has(w.path) ? `; ${stale.get(w.path)}` : "";
    const status = git(io, w.path, "status", "--porcelain");
    if (status.status !== 0) {
      io.out(`! worktree ${w.path}: git status: ${why(status)}`);
      continue;
    }
    const dirty = status.stdout.split("\n").filter((l) => l.trim()).length;
    const cherry = unmerged(w.head);
    // git cherry first — local; the PR only for a clean worktree it counts unmerged: the API call is for the doubt alone
    const byPr = !dirty && cherry !== null ? mergedByPr(w.head) : null;
    const reasons = [dirty ? `${plural(dirty, "uncommitted file", "uncommitted files")}` : null, byPr ? null : cherry].filter((r): r is string => r !== null);
    if (reasons.length) {
      io.out(`○ worktree ${w.path} left: ${reasons.join(", ")}${lock}`);
      continue;
    }
    // a stale lock: its process is gone or outlived its agent, and a locked worktree isn't removed without double force
    // — which would drop the dirty check too
    if (w.locked !== null) git(io, io.cwd, "worktree", "unlock", w.path);
    const removed = git(io, io.cwd, "worktree", "remove", w.path);
    if (removed.status !== 0) {
      io.out(`! git worktree remove ${w.path}: ${why(removed)}`);
      continue;
    }
    const withBranch = w.branch !== null && deleteBranch(w.branch) ? ` with branch ${w.branch}` : "";
    io.out(`+ worktree ${w.path} removed${withBranch}: clean, ${byPr ?? `nothing outside ${upstream}`}${lock}`);
  }
  if (branches !== undefined) return;
  // a branch checked out anywhere — a locked worktree's included — isn't loose
  const checkedOut = new Set(all.map((w) => w.branch).filter(Boolean));
  const loose = git(io, io.cwd, "for-each-ref", "--format=%(refname:short)", "refs/heads/worktree-agent-*")
    .stdout.split("\n")
    .map((b) => b.trim())
    .filter((b) => b && !checkedOut.has(b))
    .sort();
  for (const branch of loose) {
    const reason = unmerged(branch);
    if (reason) io.out(`○ branch ${branch} left: ${reason}`);
    else if (deleteBranch(branch)) io.out(`+ branch ${branch} deleted: nothing outside ${upstream}`);
  }
}

/**
 * A worktree whose HEAD moved (a commit, a switch, a rebase) this recently still has an agent at work: Claude Code
 * doesn't lock the worktree of an agent continued after its answer (#533) — woken by its subagents' answers, the
 * executor of #545 worked unlocked (#565). The wait for CI is a Bash call of up to 9 minutes without commits.
 */
const QUIET_MINUTES = 15;

/** The agent id of an agent's worktree (`agent-<id>`); another directory — null. */
const agentIdOf = (dir: string) => (AGENT_WORKTREE.test(dir) ? path.basename(dir).slice("agent-".length) : null);

/** A Claude Code subagent by its metadata (`subagentsOf`). */
interface Subagent {
  /** The agent that launched it; one the session itself launched — null. */
  parent: string | null;
  /** It has a worktree of its own (`isolation: "worktree"`); without one it works in its parent's directory. */
  own: boolean;
  /** The last write of its transcript, ms; no transcript — 0. */
  written: number;
}

/**
 * The sessions' Claude Code subagents, by id (`agent-<id>` — its worktree's name too), from the subagent metadata
 * `<Claude Code configuration>/projects/<directory>/<session id>/subagents/agent-<id>.meta.json`: `parentAgentId` — the
 * agent that launched it, `worktreePath` named `agent-<id>` — its own worktree; the transcript `agent-<id>.jsonl` next to
 * it. No metadata — an empty map.
 */
function subagentsOf(io: Io, sessions: string[]): Map<string, Subagent> {
  const agents = new Map<string, Subagent>();
  const projects = path.join(io.env["CLAUDE_CONFIG_DIR"] || path.join(io.env["HOME"] || os.homedir(), ".claude"), "projects");
  let dirs: string[];
  try {
    dirs = readdirSync(projects);
  } catch {
    return agents;
  }
  for (const dir of dirs) {
    for (const session of new Set(sessions)) {
      const sub = path.join(projects, dir, session, "subagents");
      let names: string[];
      try {
        names = readdirSync(sub);
      } catch {
        continue;
      }
      for (const name of names) {
        const id = /^agent-(.+)\.meta\.json$/.exec(name)?.[1];
        if (!id) continue;
        try {
          const meta = JSON.parse(readFileSync(path.join(sub, name), "utf8"));
          const parent = meta?.parentAgentId;
          const worktree = meta?.worktreePath;
          agents.set(id, {
            parent: typeof parent === "string" && parent ? parent : null,
            own: typeof worktree === "string" && path.basename(worktree) === `agent-${id}`,
            written: statSync(path.join(sub, `agent-${id}.jsonl`), { throwIfNoEntry: false })?.mtimeMs ?? 0,
          });
        } catch {
          // the app is writing it — the agent has only just started, its worktree is locked
        }
      }
    }
  }
  return agents;
}

/**
 * A subagent at work in an agent's worktree without one of its own (#571): Claude Code runs a subagent launched without
 * `isolation: "worktree"` in its parent's directory — an executor's epic refresh, in the executor's worktree. The host
 * agent's descendants through such subagents, at any depth; at work — its transcript written less than `QUIET_MINUTES`
 * ago (a Bash call of up to 9 minutes writes nothing). The freshest is named; none — null.
 */
function guestWhy(agents: Map<string, Subagent>, host: string): string | null {
  const inside = new Set([host]);
  let fresh: { id: string; minutes: number } | null = null;
  for (let grew = true; grew; ) {
    grew = false;
    for (const [id, a] of agents) {
      if (a.own || a.parent === null || !inside.has(a.parent) || inside.has(id)) continue;
      inside.add(id);
      grew = true;
      const minutes = Math.max(0, Math.floor((Date.now() - a.written) / 60_000));
      if (a.written > 0 && minutes < QUIET_MINUTES && (!fresh || minutes < fresh.minutes)) fresh = { id, minutes };
    }
  }
  return fresh && `subagent agent-${fresh.id} works in it without a worktree of its own — its transcript written ${fresh.minutes} min ago, quiet after ${QUIET_MINUTES}`;
}

/**
 * Why a worktree is alive: a lock held by a live process, a subagent of its agent at work in it (`guestWhy`), or HEAD
 * moved less than `QUIET_MINUTES` ago; quiet — null.
 */
function aliveWhy(io: Io, w: Worktree, agents: Map<string, Subagent>): string | null {
  const lock = w.locked !== null && lockHolds(w.locked) ? w.locked : null;
  const id = agentIdOf(w.path);
  const guest = lock !== null || id === null ? null : guestWhy(agents, id);
  /** The worktree's own HEAD log: the time of its latest entry (`HEAD@{<unix time>}`) — read only when nothing else tells. */
  const moved = () => {
    const r = git(io, w.path, "reflog", "-1", "--date=unix", "--format=%gd");
    const at = Number(/@\{(\d+)\}/.exec(r.stdout)?.[1]);
    const minutes = Math.floor((Date.now() / 1000 - at) / 60);
    return r.status === 0 && at > 0 && minutes < QUIET_MINUTES ? `HEAD moved ${Math.max(0, minutes)} min ago (a commit or a switch), quiet after ${QUIET_MINUTES}` : null;
  };
  const executor = executorOf({ lock, guest, moved: lock !== null || guest !== null ? null : moved() });
  return executorAlive(executor.state) ? executor.why : null;
}

/** The sessions' hand-out files on the machine — `dispatchers/<session id>.tasks` in the configuration directory (`handedOutFile`). */
function handOutFiles(io: Io): { session: string; file: string }[] {
  const dir = path.join(configDir(io.env), "dispatchers");
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".tasks"))
      .map((f) => ({ session: f.slice(0, -".tasks".length), file: path.join(dir, f) }));
  } catch {
    return [];
  }
}

/**
 * The task's previous executor and its subagents still alive (#565): the `!` lines with each live worktree. The
 * executor of #545 answered «failed» while two of its background subagents were still working; their answers woke it,
 * and it merged the task — while a second executor, launched on the owner's restart, worked on the same branch. The
 * previous executor's worktrees — its hand-outs of the task in any dispatcher session (`dispatchers/*.tasks`) and a
 * worktree on the task branch, the caller's own aside; its subagents' — by Claude Code's metadata (`subagentsOf`), at any
 * depth. Alive — `aliveWhy`: a subagent without a worktree of its own keeps alive the worktree it works in. The directory
 * isn't a checkout of the repository — none: the script doesn't see the worktrees.
 */
function livePredecessors(io: Io, slug: string, number: number, own: string): string[] {
  if (!checkoutOfRepo(io, originUrl(io), slug)) return [];
  const listed = git(io, io.cwd, "worktree", "list", "--porcelain");
  if (listed.status !== 0) return [];
  const mine = realPath(own);
  const all = worktreeList(listed.stdout).filter((w) => !w.prunable && realPath(w.path) !== mine);
  const handOuts = handOutFiles(io).flatMap(({ session, file }) =>
    handOutsIn(file, slug)
      .filter((h) => h.number === number && h.worktree !== null)
      .map((h) => ({ session, worktree: realPath(h.worktree!) })),
  );
  const executors = all.filter((w) => handOuts.some((h) => h.worktree === realPath(w.path)) || (w.branch !== null && isTaskBranch(w.branch, number)));
  if (!executors.length) return [];
  const agents = subagentsOf(io, [...handOuts.map((h) => h.session), io.env["CLAUDE_CODE_SESSION_ID"] ?? ""].filter(Boolean));
  // the executors' agents and everything they launched
  const family = new Set(executors.map((w) => agentIdOf(w.path)).filter((id): id is string => id !== null));
  for (let grew = true; grew; ) {
    grew = false;
    for (const [id, { parent }] of agents) {
      if (parent !== null && family.has(parent) && !family.has(id)) {
        family.add(id);
        grew = true;
      }
    }
  }
  const lines: string[] = [];
  for (const w of all) {
    const parent = agents.get(agentIdOf(w.path) ?? "")?.parent;
    const role = executors.includes(w) ? "the previous executor" : parent && family.has(parent) ? `a subagent of agent-${parent}` : null;
    const why = role && aliveWhy(io, w, agents);
    if (why) lines.push(`! worktree ${w.path} (${role}): ${why}`);
  }
  return lines;
}

/**
 * The task's branches `[<area>/]<type>/<N>-<slug>`: local ones of the current directory's checkout and those on its origin
 * (`git ls-remote`: the executor's fresh worktree hasn't fetched a branch its predecessor pushed). The directory isn't a
 * checkout of the repository — none: the script doesn't see the branches and claims nothing.
 */
function taskBranchesHere(io: Io, slug: string, number: number): string[] {
  if (!checkoutOfRepo(io, originUrl(io), slug)) return [];
  const lines = (...args: string[]) => git(io, io.cwd, ...args).stdout.split("\n");
  const refs = [...lines("for-each-ref", "--format=%(refname)", "refs/heads/"), ...lines("ls-remote", "--heads", "origin").map((l) => l.split("\t")[1] ?? "")];
  return [...new Set(refs.map((r) => r.trim().replace(/^refs\/heads\//, "")).filter((b) => isTaskBranch(b, number)))].sort();
}

/**
 * The executor's whole assignment (`task queue --assignment N`): the task by the canon, what a subagent does otherwise, the
 * answer form. The restart line — only when it is true: the task is In progress and has a branch `<type>/N-<slug>`
 * (#511); printed always, it misled the executor of a Backlog task, who argued with it in the answer. The task is
 * recorded as handed out with the executor's worktree (`handedOutFile`): the queue no longer gives it out as ready and
 * keeps the worktree while the task is open, and `task status` in the executor doesn't pin it. In any identified
 * session, not only a dispatcher's (#546): a session with its own task, or none yet, launches an executor on the
 * owner's "yes" — unrecorded, its "In progress" would be refused by the session's pin or would pin the session to it.
 * A session pinned to this very task records nothing: the task is its own. A restart while the previous executor or its
 * subagent is alive (`livePredecessors`, #565) — no assignment and no hand-out: the `!` lines and the answer that
 * makes the dispatcher wait, code 1.
 * The epic refresh — in the same turn, not in the background, then `task close`, then the answer (#628): an executor of a
 * task without commits answered «waits for subagents» while its refresh ran, and its worktree without changes was
 * removed under the refresh subagent; a task without a PR is closed as completed first — `task close` needs it closed.
 * A task of the dispatcher's batch (#676) — merged into the batch after the checks before a commit and `pr premerge`,
 * without a CI wait (a PR into the batch runs no CI) and without the refresh: the executor's slot is free at the merge,
 * the full run, one refresh per epic and `task close` are the release's; a task without a PR isn't in the batch — its
 * refresh and close are the executor's, as outside a batch.
 * `session` — the prompt of an app executor session (`start_session`: another project's task, #624), printed by the
 * dispatcher: a session, not a subagent — by the canon of its project and its mode, named by the task, waits in the
 * background, the canon's last line; the subagent's lines say the opposite. `Next:` — how to start it. The batch's
 * release red with the task in it (#650, `fixOf`) — the fix's lead: the release PR and its failed checks, a new task
 * branch from the batch, not the task's earlier one (rebase-merged into the batch already) — no restart line. The
 * project's mode (#667, `autoProject` of the
 * checkout): auto — like a session in auto mode; outside auto the executor merged on green checks too, and the owner,
 * who hadn't said «yes» to that merge, learned of it from the dispatcher afterwards — now the lead's mode and the
 * `merge` line: up to `pr premerge` by itself, then the answer «question: merge PR #N?», the merge — on the owner's «yes»
 * the dispatcher forwards; an app session's lead names its mode itself.
 * `main` — past the dispatcher's batch (#697, the owner's word): the plain lead with the `bypass` line — the branch from
 * origin/<base>, the PR into it with the full CI, the deploy, the refresh and `task close`; the hand-out marked
 * (`MAIN_HANDOUT`) — a restart keeps the way, `task finish` opens the PR into the default branch, the queue names the task
 * «past the batch» and its release doesn't wait for it; a task of a red release refuses it — its fix is the batch's. A
 * bug on red main gets `--main` from the queue's prompt while the release is open (#886): its own bypass line — the
 * release waits for its close, a merge into the batch would wait for the release.
 */
export function cmdTaskAssignment(io: Io, slug: string, number: number, o: { session?: boolean; main?: boolean } = {}): number {
  const issue = loadIssue(io, slug, number);
  const file = handedOutFile(io);
  const own = pinnedTask(io)?.task;
  // the executor's worktree — the checkout it calls the assignment in: the queue keeps it while the task is open (#533)
  const top = git(io, io.cwd, "rev-parse", "--show-toplevel");
  const worktree = top.status === 0 ? top.stdout.trim() : "";
  const alive = worktree ? livePredecessors(io, slug, number, worktree) : [];
  if (alive.length) {
    for (const line of alive) io.out(line);
    io.out(locale.fill(N.queue.alive, { task: N.subagentPrompt.task, number, repo: slug }));
    return 1;
  }
  // the dispatcher's batch of the repository (#648): the task branch from it, the PR into it, the task open till the
  // release; the session's own task isn't the batch's — it goes into the default branch, as a session outside a dispatcher
  const dispatched = own?.slug === slug && own.number === number ? null : batchOf(io, slug);
  // past the batch (#697): the owner's word, or the task's earlier hand-out with it — a restart keeps the way
  const main = dispatched !== null && (Boolean(o.main) || handedPastBatch(io, slug, number));
  const batch = main ? null : dispatched;
  // the batch's PRs, its release's among them: the red release's fix and the default branch of a bug on red main
  const prs = dispatched === null ? null : batchPrs(io, slug, dispatched);
  // the batch's release is red and the task is in it (#650): its fix goes into the batch — not past it
  const fix = dispatched === null ? null : fixOf(io, slug, dispatched, number, prs!);
  if (fix && main) throw new GhError(`#${number} is in the red release PR #${fix.release.number} of ${dispatched}: its fix goes into the batch, and --main takes it past the batch — the assignment without --main`);
  if (file && !(own?.slug === slug && own.number === number)) {
    mkdirSync(path.dirname(file), { recursive: true });
    // the configuration directory may be a personal git checkout (ELVES_PRIVATE) — hand-outs aren't committed into it
    writeFileSync(path.join(path.dirname(file), ".gitignore"), "*\n");
    const where = [o.session ? SESSION_HANDOUT : worktree, main ? MAIN_HANDOUT : ""].filter(Boolean).join(" ");
    appendFileSync(file, `${slug}#${number}${where ? ` ${where}` : ""}\n`);
  }
  // the project's mode (#667): outside auto the executor's merge waits for the owner's «yes» — the dispatcher's request
  // is the work's scope, not a «yes» to each merge
  const auto = locale.autoProject(io.cwd ?? process.cwd());
  // a fix starts a new branch from the batch: the task's earlier branch is in the batch already — no restart line
  const inProgress = taskStatus(taskContext(io, slug), issue, issue.prs.find((p) => p.state === "OPEN")?.number, () => workFacts(io, slug)) === N.status.inProgress;
  const restart = fix || inProgress ? taskBranchesHere(io, slug, number) : [];
  const vars = {
    task: N.subagentPrompt.task,
    number,
    title: issue.title,
    repo: slug,
    epic: issue.parent ? locale.fill(N.queue.epic, { epicWord: N.subagentPrompt.epic, epic: issue.parent.number }) : "",
    script: `bun --no-env-file ${import.meta.path}`,
    taskEnv: `bun --no-env-file ${taskEnvScript(io)}`,
    waitCi: `bash ${waitCi()}`,
    inProgress: N.status.inProgress,
    done: N.lastLine.done,
    questions: N.sections.questions,
    branches: restart.map((b) => `\`${b}\``).join(", "),
    doneQuestions: N.lastLine.questions,
    remaining: N.lastLine.remaining,
    batch: batch ?? dispatched ?? "",
    release: fix?.release.number ?? "",
    checks: fix?.red.join(", ") ?? "",
    // where the fix's cause is read (#884): the failed checks' logs, the ❌ lines of pr premerge on the release's head
    cause: fix
      ? [fix.ci && N.queue.fixCauseChecks, fix.premerge && N.queue.fixCausePremerge]
          .filter((t): t is string => Boolean(t))
          .map((t) => locale.fill(t, { release: fix.release.number }))
          .join(", ")
      : "",
    previous: fix && restart.length ? locale.fill(N.queue.fixPrevious, { branches: restart.map((b) => `\`${b}\``).join(", ") }) : "",
    mode: auto ? N.queue.modeAuto : N.queue.modeAsk,
  };
  const resume = restart.length && !fix ? [N.queue.resume] : [];
  // the epic refresh in the same turn (`refresh`, #628) — the subagent's: a session runs it by the canon, with the deploy's
  // wait; in a batch (#676) — no CI wait (a PR into the batch runs none: the checks before a commit and pr premerge are
  // its gate), no deploy, no refresh and no `task close`: they are the release's, the subagent's and the session's alike;
  // the fix of a red release (#650) — its own lead, the rest as in the batch
  // the leads take the task with `task start --branch` (#709), a restart — `--resume` (the `resume` line); the fix's
  // leads keep `task status --branch`: the new branch is cut beside the task's merged one, which task start stops on
  const sessionLead = fix ? N.queue.sessionFixLead : batch ? N.queue.sessionBatchLead : N.queue.sessionLead;
  // past the batch as a bug on red main (#886): the queue's prompt, not the owner's word — the release waits for its close
  const bypass = main ? [prs && isMainRedBug(issue.title, prs.base) ? N.queue.bypassRedMain : N.queue.bypass] : [];
  const lines = o.session
    ? [sessionLead, ...bypass, ...resume, N.queue.sessionIs, N.queue.sessionName, batch ? N.queue.batchWait : N.queue.sessionWait, N.queue.repeats, N.queue.sessionFound, N.queue.sessionQuestion, N.queue.sessionEnd]
    : [
        fix ? N.queue.fixLead : batch ? N.queue.batchLead : N.queue.lead,
        ...bypass,
        ...resume,
        N.queue.subagent,
        N.queue.session,
        batch ? N.queue.batchWait : N.queue.wait,
        ...(auto ? [] : [N.queue.merge]),
        N.queue.git,
        N.queue.subagents,
        N.queue.live,
        batch ? N.queue.batchRefresh : N.queue.refresh,
        N.queue.repeats,
        N.queue.found,
        N.queue.question,
        N.queue.answer,
      ];
  for (const line of lines) io.out(locale.fill(line, vars));
  if (o.session) {
    io.out(
      `Next: the lines above — the executor session's prompt as is: start_session, initiation "user_asked", cwd — the folder of the ${slug} checkout on this machine (not a worktree), ` +
        `use_worktree true, background — the first line above; keep the session's id it returns. ` +
        `The end of each of its turns comes as the app's note, like an executor's answer — task queue again: in a queue of ${slug} the task is =; ${SESSION_ARCHIVE}.`,
    );
  }
  return 0;
}

function actualizeChecks(): string[] {
  const file = path.resolve(import.meta.dir, "../reference.md");
  const m = existsSync(file) ? /Five checks:\n\n([\s\S]*?)\n\nWhat was fixed/.exec(readFileSync(file, "utf8")) : null;
  const items = m ? m[1]!.split(/\n(?=\d\. )/) : [];
  if (items.length !== 5) throw new GhError(`the five epic-refresh checks not found in ${file}: expected a list of five between «Five checks:» and «What was fixed»`);
  return items;
}

/** The checks by meaning — the subagent's: 1 (whether done), 3, 5; the mechanics of 1, 2 and 4 is the script's. */
const MEANING_CHECKS = [0, 2, 4];

/**
 * ✅ that answers a question — at the start of its answer: after the item's number (`task answer`), at the start of an
 * item's line, after the end of the question or a sentence (`?`, `.`, `!`, a dash; closing quotes and markup included),
 * as answers by hand put it. ✅ inside the text — after a word, in parentheses, quotes or code (a recommendation naming
 * «✅ auto») — doesn't answer (#603).
 */
const ANSWER_MARK_RE = /(?:^\s*(?:\d+\.\s+)?|[?.!—–][»"'*_)`]*\s+)[*_(]*✅/;
/** A thematic break ends the questions section: a signature after `---` at the description's end isn't the last question's (#603). */
const THEMATIC_BREAK_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

/**
 * The items of the issue's questions section ("## Questions" in any language of the dictionary, up to the next section
 * or a thematic break): the number, the first line, all the item's non-empty lines and whether it is answered — ✅ at
 * the start of its answer (`ANSWER_MARK_RE`); `first` and `last` — the indexes of the item's first and last non-empty
 * line in the description's lines. `task actualize` removes the questions label from a task without open ones, `task
 * show` names them, `task answer` puts the answer into the item.
 */
function questionItems(body: string): { k: number; text: string; lines: string[]; answered: boolean; first: number; last: number }[] {
  const lines = body.split(/\r?\n/);
  const from = lines.findIndex((l) => QUESTIONS_SECTION_RE.test(l));
  if (from < 0) return [];
  const items: { first: number; last: number }[] = [];
  for (let i = from + 1; i < lines.length && !/^##\s/.test(lines[i]!) && !THEMATIC_BREAK_RE.test(lines[i]!); i++) {
    if (/^\d+\.\s/.test(lines[i]!)) items.push({ first: i, last: i });
    else if (items.length && lines[i]!.trim()) items.at(-1)!.last = i;
  }
  return items.map(({ first, last }) => {
    const item = lines.slice(first, last + 1).filter((l) => l.trim());
    return { k: parseInt(lines[first]!, 10), text: lines[first]!.trim(), lines: item, answered: item.some((l) => ANSWER_MARK_RE.test(l)), first, last };
  });
}

interface MilestoneRef {
  number: number;
  title: string;
  state: string;
  /** Open tasks in it. */
  open: number;
}

/** An issue as the epic refresh reads it: the text, labels with ids, blocked by, comments, sub-issues with milestones. */
interface TaskText {
  id: string;
  number: number;
  title: string;
  state: string;
  body: string;
  labels: { id: string; name: string }[];
  milestone: MilestoneRef | null;
  blockedBy: (Blocker & { id: string })[];
  comments: { body: string; url: string }[];
  subIssues: { number: number; title: string; state: string; milestone: MilestoneRef | null }[];
}

function loadTaskText(io: Io, slug: string, number: number): TaskText {
  const [owner, name] = slug.split("/");
  const i = graphql(io, Q.TaskText, { owner, name, number })?.repository?.issue;
  if (!i) throw new GhError(`no issue #${number} in ${slug}`);
  const milestone = (m: Any): MilestoneRef | null => (m ? { number: m.number, title: m.title, state: m.state, open: m.issues?.totalCount ?? 0 } : null);
  return {
    id: i.id,
    number: i.number,
    title: i.title,
    state: i.state,
    // the GitHub UI saves a description with CRLF
    body: (i.body ?? "").replace(/\r\n/g, "\n").trim(),
    labels: i.labels?.nodes ?? [],
    milestone: milestone(i.milestone),
    blockedBy: (i.blockedBy?.nodes ?? []).map((b: Any) => ({ id: b.id, number: b.number, state: b.state, repo: b.repository?.nameWithOwner ?? slug })),
    comments: i.comments?.nodes ?? [],
    subIssues: (i.subIssues?.nodes ?? []).map((x: Any) => ({ number: x.number, title: x.title, state: x.state, milestone: milestone(x.milestone) })),
  };
}

/**
 * The refresh's mechanics — what needs no judgment, so the subagent doesn't collect it (#435): blocked by on done tasks
 * (closed ones and this task, whose PR is merged) is removed — check 4; the questions label without open questions in
 * the section — check 2; a milestone of the epic's tasks without open tasks is closed — check 1, except the task's and
 * the epic's own: `task close` closes them, the task may still be open. The fixes — one line in a comment on the epic.
 * Several tasks shipped together (a batch's release, #676) — `numbers`, `merged` — those of them merged into the default
 * branch; the comment names them all.
 */
function refreshMechanics(io: Io, slug: string, r: { numbers: number[]; merged: number[]; epic: TaskText; open: TaskText[] }): void {
  const fixes: string[] = [];
  const tasks = [r.epic, ...r.open];
  for (const t of tasks) {
    // an external blocker is done only when closed: the merged task is of this repository
    const done = t.blockedBy.filter((b) => b.state === "CLOSED" || r.merged.some((n) => blockerRef(slug, b) === `#${n}`));
    if (!done.length) continue;
    for (const b of done) mutate(io, { op: "RemoveBlockedBy", input: { issueId: t.id, blockingIssueId: b.id } });
    io.out(`+ #${t.number}: blocked by ${done.map((b) => `${blockerRef(slug, b)} (${b.state === "CLOSED" ? "closed" : "merged"})`).join(", ")} removed`);
    fixes.push(locale.fill(N.actualize.unblocked, { task: t.number, blockers: done.map((b) => blockerRef(slug, b)).join(", ") }));
  }
  const questionLabels = locale.every((n) => n.labels.questions);
  for (const t of tasks) {
    const labels = t.labels.filter((l) => questionLabels.includes(l.name));
    if (!labels.length || questionItems(t.body).some((x) => !x.answered)) continue;
    mutate(io, { op: "RemoveLabels", input: { labelableId: t.id, labelIds: labels.map((l) => l.id) } });
    for (const l of labels) {
      io.out(`+ #${t.number}: label ${q(l.name)} removed — no open questions`);
      fixes.push(locale.fill(N.actualize.unlabeled, { task: t.number, label: l.name }));
    }
  }
  const own = r.epic.subIssues.filter((x) => r.numbers.includes(x.number)).map((x) => x.milestone?.number);
  const seen = new Set([...own, r.epic.milestone?.number]);
  for (const { milestone: m } of r.epic.subIssues) {
    if (!m || seen.has(m.number)) continue;
    seen.add(m.number);
    if (m.state !== "OPEN" || m.open > 0) continue;
    io.gh(["api", "-X", "PATCH", `repos/${slug}/milestones/${m.number}`, "-f", "state=closed"]);
    io.out(`+ milestone ${q(m.title)} closed: no open tasks left`);
    fixes.push(locale.fill(N.actualize.milestone, { title: m.title }));
  }
  if (!fixes.length) return;
  mutate(io, { op: "AddComment", input: { subjectId: r.epic.id, body: locale.fill(N.actualize.mechanics, { number: r.numbers.join(", #"), fixes: fixes.join("; ") }) } });
  io.out(`+ epic #${r.epic.number}: a comment with the script's fixes`);
}

/** A quoted line of an issue or a comment in the assignment: one line, at most 200 characters. */
const clip = (line: string) => (line.length > 200 ? `${line.slice(0, 199)}…` : line);

/**
 * Copies of links in text (check 4): in the epic — a list item that starts with the number of its sub-issue; in the
 * epic and its open tasks — "⛔" and a dependency phrase before `#N` (`linkWords` of any language). Named, not edited:
 * a line may carry meaning besides the copy.
 */
function linkCopies(epic: TaskText, open: TaskText[]): { number: number; line: string }[] {
  const subs = new Set(epic.subIssues.map((x) => x.number));
  const words = locale.every((n) => n.actualize.linkWords).flatMap((w) => w.split("|")).map((w) => w.trim()).filter(Boolean).map(locale.escapeRe);
  const phrase = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${words.join("|")})\\s*:?\\s*#\\d+`, "iu");
  const item = /^\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?#(\d+)(?!\d)/;
  const out: { number: number; line: string }[] = [];
  for (const t of [epic, ...open]) {
    for (const raw of t.body.split("\n")) {
      const listed = t === epic ? item.exec(raw) : null;
      if ((listed && subs.has(Number(listed[1]))) || raw.includes("⛔") || phrase.test(raw)) out.push({ number: t.number, line: clip(raw.trim()) });
    }
  }
  return out;
}

/**
 * Answers to open questions in comments (check 2): an item `k. ✅ …` of a comment for the open question k, the latest
 * wins. Named, not moved: a comment's numbering may be its own (answers to a concept, not to the section). Narrower than
 * task show's `answerCandidates` (an item `k.` without ✅, free text) on purpose: the refresh subagent moves what it's
 * given into the description, the executor taking the task only checks what task show flags.
 */
function commentAnswers(tasks: TaskText[]): { number: number; k: number; text: string; url: string }[] {
  const out: { number: number; k: number; text: string; url: string }[] = [];
  for (const t of tasks) {
    const open = new Set(questionItems(t.body).filter((x) => !x.answered).map((x) => x.k));
    if (!open.size) continue;
    const found = new Map<number, { text: string; url: string }>();
    for (const c of t.comments) for (const m of c.body.matchAll(/^\s*(\d+)\.\s*✅\s*(.+)$/gm)) if (open.has(Number(m[1]))) found.set(Number(m[1]), { text: clip(m[2]!.trim()), url: c.url });
    for (const [k, a] of [...found].sort(([x], [y]) => x - y)) out.push({ number: t.number, k, ...a });
  }
  return out;
}

/** A changed PR file in the assignment: the path, the kind of change unless it's an edit, the line counts. */
const fileLine = (f: PrFile) => `- ${f.path} (${f.changeType === "MODIFIED" ? "" : `${f.changeType.toLowerCase()}, `}+${f.additions} −${f.deletions})`;
/** An issue's description in the assignment — in a fence: its headings don't mix with the assignment's. */
const textBlock = (body: string) => (body ? `~~~~markdown\n${body}\n~~~~` : N.actualize.noBody);

/**
 * What a task shipped: its merged PRs — the linked ones, otherwise found by the task branch or «Closes #N» (into a batch
 * branch too). A batch's release among them (#676: its head is the batch branch) — in its place the task's own PRs
 * merged into the batch: the release carries the whole batch's files, the refresh of one epic needs its tasks'.
 * `released` — merged into the default branch, a release among them; merged only into a batch branch (#648) — not:
 * the task closes with the batch's release.
 */
function shippedBy(io: Io, slug: string, issue: Issue): { prs: Issue["prs"]; released: boolean } {
  const linked = issue.prs.filter((p) => p.merged);
  const found = linked.length ? null : unlinkedPrs(io, slug, issue.number);
  const merged = linked.length ? linked : [...found!.prs, ...found!.batched].filter((p) => p.merged);
  const prs = merged.flatMap((p) => {
    if (!isBatchBranch(p.head)) return [p];
    const own = mergedIntoBatch(batchPrs(io, slug, p.head).nodes, p.head, issue.number).map((x) => ({ number: x.number as number, state: x.state ?? "", merged: true, head: x.headRefName ?? "", base: p.head }));
    return own.length ? own : [p];
  });
  return { prs, released: merged.some((p) => !isBatchBranch(p.base)) };
}

/**
 * The epic refresh — right after the merge, in parallel with the deploy: the refresh doesn't depend on the deploy. The
 * command does the mechanics itself (`refreshMechanics`) and prints the subagent's prompt — two lines: «Task #N (epic
 * #M)» (`subagentPrompt.task` and the number: est ties the subagent's work to the task by it) and the command of its
 * whole assignment. The assignment (`--assignment`, read-only) is the subagent's first call: the texts of the epic and
 * its open tasks and the PR files run to tens of KB, and the session at peak context would copy them into the subagent
 * call as output tokens. In it — the task and its PR with its files, the epic and its open tasks with their texts, the
 * copies of links and the answers in comments the script found, the checks by meaning quoted from reference.md as is,
 * what may be changed and the answer form; under each open task — where a repeat finding of check 5 goes, by its Status
 * and open PR (#636); in the project language (the `actualize` keys). No epic, or no open tasks in it besides this one
 * — the checks by meaning have nothing to go through: a "not needed" line, no subagent. Several tasks — shipped together
 * (a batch's release, #676: `batch release` names them all) — grouped by their epics: one refresh per epic, its prompt
 * and its report name the epic's tasks («Task #N, #M», «Refresh after #N, #M, result: …»), and `task close` of each
 * accepts it; `--assignment` — the tasks of one epic, as its prompt names them. `--apply <file>` — the subagent's
 * edits and its report in one file (`applyRefresh`, #669), the same tasks as its assignment.
 */
export function cmdTaskActualize(io: Io, slug: string, numbers: number[], o: RefreshOptions = { assignment: false }): number {
  if (o.assignment && o.apply !== undefined) throw new GhError("--assignment or --apply, not both: the assignment is read-only, the file of edits is applied after it");
  const groups = new Map<number | null, Issue[]>();
  for (const n of [...new Set(numbers)]) {
    const issue = loadIssue(io, slug, n);
    const epic = issue.parent?.number ?? null;
    groups.set(epic, [...(groups.get(epic) ?? []), issue]);
  }
  if ((o.assignment || o.apply !== undefined) && groups.size > 1) {
    const by = [...groups].map(([epic, g]) => `${g.map((i) => `#${i.number}`).join(", ")} — ${epic === null ? "no epic" : `epic #${epic}`}`).join("; ");
    throw new GhError(`${o.apply === undefined ? "--assignment" : "--apply"} — the tasks of one epic, as its refresh prompt names them: ${by}`);
  }
  for (const [epic, group] of groups) refreshEpic(io, slug, epic, group, o);
  return 0;
}

/** One epic's refresh after its tasks shipped (`cmdTaskActualize`): the tasks of `group` — of this epic, or of none. */
function refreshEpic(io: Io, slug: string, epicNumber: number | null, group: Issue[], o: RefreshOptions): void {
  const numbers = group.map((i) => i.number);
  const tags = numbers.map((n) => `#${n}`).join(", ");
  const shipped = group.map((issue) => ({ issue, ...shippedBy(io, slug, issue) }));
  // merged only into a batch branch (#648): what shipped is in the batch, the task closes with its release; its
  // blocked-by links stay till then — a task of the same batch isn't held by them (task queue), one outside it is
  const held = shipped.every((s) => s.prs.length && !s.released);
  // task finish (#668) names the next step itself — the deploy is behind it, task close follows
  const later = o.finish
    ? ""
    : held
    ? `Next: no task close — ${tags} ${numbers.length > 1 ? "are" : "is"} merged into ${shipped[0]!.prs[0]!.base}: ${numbers.length > 1 ? "they close" : "it closes"} with the batch's release.`
    : `Next: ${numbers.map((n) => `task close ${n}`).join("; ")} — after the deploy, where the merge deploys.`;
  if (epicNumber === null) {
    if (o.apply !== undefined) throw new GhError(`--apply: ${tags} ${numbers.length > 1 ? "have" : "has"} no epic — there is nothing to refresh`);
    return io.out(`○ refresh not needed: ${tags} ${numbers.length > 1 ? "have" : "has"} no epic.${later && ` ${later}`}`);
  }
  const epic = loadTaskText(io, slug, epicNumber);
  const open = epic.subIssues.filter((x) => x.state === "OPEN" && !numbers.includes(x.number)).map((x) => loadTaskText(io, slug, x.number));
  // the file of edits (#669): the mechanics is done by the call that printed the prompt
  if (o.apply !== undefined) return applyRefresh(io, slug, o.apply, { numbers, epic, open });
  if (!o.assignment) refreshMechanics(io, slug, { numbers, merged: shipped.filter((s) => s.released).map((s) => s.issue.number), epic, open });
  if (!open.length) return io.out(`○ refresh not needed: epic #${epic.number} has no open tasks besides ${tags}.${later && ` ${later}`}`);
  // the board with its Status (and its language) — the assignment names where a repeat finding goes (#636)
  const ctx = o.assignment ? taskContext(io, slug) : null;
  const vars = { task: N.subagentPrompt.task, epicWord: N.subagentPrompt.epic, number: numbers.join(", #"), epic: epic.number, repo: slug };
  const lead = locale.fill(N.actualize.lead, vars);
  if (!o.assignment) {
    io.out(o.finish ? "The epic refresh's subagent — the two lines below are its whole prompt, pass them as is:" : "Next: a subagent in the background — the two lines below are its whole prompt, pass them as is.");
    io.out(lead);
    io.out(locale.fill(N.actualize.fetch, { command: `bun --no-env-file ${import.meta.path} task actualize ${numbers.join(" ")} --assignment --repo ${slug}` }));
    return;
  }
  const checks = actualizeChecks();
  // the diff — by git, not gh (#669): rebase-merged commits carry «Refs #N»; merged only into a batch — its branch
  const what = (s: (typeof shipped)[number]) =>
    s.prs.length
      ? locale.fill(N.actualize.prs, {
          list: s.prs.map((p) => `#${p.number}`).join(", "),
          command: `\`git log -p -E --grep '#${s.issue.number}([^0-9]|$)' origin/${s.released ? (s.prs.find((p) => !isBatchBranch(p.base))?.base ?? "main") : s.prs[0]!.base}\``,
        })
      : locale.fill(N.actualize.noPr, { command: `\`git log origin/main --grep '#${s.issue.number}'\`` });
  const tasks = shipped.map((s) => locale.fill(N.actualize.shippedTask, { number: s.issue.number, title: s.issue.title, shipped: what(s) })).join("; ");
  const lines = [lead, locale.fill(N.actualize.shipped, { repo: slug, tasks })];
  for (const p of shipped.flatMap((s) => s.prs)) {
    const files = loadPrChange(io, slug, p.number).files;
    if (files.length) lines.push(locale.fill(N.actualize.files, { pr: p.number }), ...files.map(fileLine));
  }
  lines.push("", locale.fill(N.actualize.epic, { ...vars, title: epic.title }), textBlock(epic.body), "", N.actualize.openTasks);
  const openPr = openPrOf(io, slug);
  const facts = workFacts(io, slug, true);
  /** Where a repeat finding of check 5 goes (#636): a task in Backlog takes it as an item, one already going doesn't. */
  const target = (n: number): string[] => {
    const i = loadIssue(io, slug, n);
    const pr = openPr(i);
    // no board (#847) — by the facts: its open PR is a mark of its own
    const status = taskStatus(ctx!, i, undefined, () => facts);
    const work = [status === N.status.inProgress ? locale.fill(N.actualize.taskStatus, { status }) : "", pr === undefined ? "" : locale.fill(N.actualize.taskPr, { pr })].filter(Boolean);
    if (work.length) return [locale.fill(N.actualize.inWork, { work: work.join(", ") })];
    return status === N.status.backlog ? [locale.fill(N.actualize.backlog, { status: locale.fill(N.actualize.taskStatus, { status }) })] : [];
  };
  for (const t of open) lines.push("", locale.fill(N.actualize.openTask, { number: t.number, title: t.title }), ...target(t.number), textBlock(t.body));
  const copies = linkCopies(epic, open);
  if (copies.length) lines.push("", N.actualize.copies, ...copies.map((c) => locale.fill(N.actualize.copy, c)));
  const answers = commentAnswers([epic, ...open]);
  if (answers.length) lines.push("", locale.fill(N.actualize.answers, { questions: N.sections.questions }), ...answers.map((a) => locale.fill(N.actualize.commentAnswer, a)));
  lines.push(
    "",
    N.actualize.checks,
    "",
    MEANING_CHECKS.map((i) => checks[i]!).join("\n"),
    "",
    locale.fill(N.actualize.scope, { ...vars, args: numbers.join(" "), script: `bun --no-env-file ${import.meta.path}` }),
    locale.fill(N.actualize.format, { report: locale.fill(N.actualize.report, { number: vars.number, text: "" }).trim() }),
    "~~~~json",
    refreshExample(epic, open),
    "~~~~",
    locale.fill(N.actualize.comment, { ...vars, report: locale.fill(N.actualize.report, { number: vars.number, text: "…" }), close: numbers.map((n) => `\`task close ${n}\``).join(", ") }),
    N.actualize.answer,
  );
  for (const line of lines) io.out(line);
}

/** `task actualize`'s modes: the mechanics and the prompt, the assignment (read-only), the file of edits (#669). */
interface RefreshOptions {
  assignment: boolean;
  finish?: boolean;
  /** The refresh subagent's file of edits: checked whole, applied all or none, the report posted on the epic. */
  apply?: string | undefined;
}

/** The actions of an edit in the refresh's file (#669): each edit is exactly one. */
const REFRESH_ACTIONS = ["replace", "add", "check", "answer", "unblock", "close", "new"] as const;
/** `#new1`, `#new2` in the report — the numbers of the tasks the file's `new` edits create, in their order. */
const NEW_REF_RE = /#new(\d+)(?!\d)/g;

/** The file's example in the assignment: on the epic's first open task — the subagent sees the shape, not a recipe. */
function refreshExample(epic: TaskText, open: TaskText[]): string {
  const task = (open[0] ?? epic).number;
  const lines = [
    `{ "task": ${task}, "replace": "<text found once in the description>", "with": "<new text, \\"\\" removes it>" }`,
    `{ "task": ${task}, "add": "## <section heading>", "item": "<item>" }`,
    `{ "task": ${task}, "check": "<text of an unchecked item>" }`,
    `{ "task": ${task}, "answer": 1, "text": "<answer>" }`,
    `{ "task": ${task}, "unblock": "#<N>" }`,
    `{ "task": ${task}, "close": "done" }`,
    `{ "new": "<title>", "body": "<description>" }`,
  ];
  return `{\n  "report": "<what you fixed; filed #new1>",\n  "edits": [\n${lines.map((l) => `    ${l}`).join(",\n")}\n  ]\n}`;
}

const asText = (v: unknown) => (typeof v === "string" ? v : "");

/** The refresh's file of edits: JSON `{ report, edits }`; not readable, not JSON or without a report — an error. */
function readRefreshFile(file: string): { report: string; edits: unknown[] } {
  let data: Any;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new GhError(`--apply ${file}: ${(e as Any)?.code === "ENOENT" ? "no such file" : `not JSON — ${(e as Error).message}`}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new GhError(`--apply ${file}: expected an object { "report": "…", "edits": [ … ] }`);
  const report = asText(data.report).trim().replace(/\s*\r?\n\s*/g, " ");
  if (!report) throw new GhError(`--apply ${file}: no «report» — the result after «${locale.fill(N.actualize.report, { number: "N", text: "" }).trim()}», «the block is current» too`);
  if (data.edits !== undefined && !Array.isArray(data.edits)) throw new GhError(`--apply ${file}: «edits» — a list`);
  return { report, edits: data.edits ?? [] };
}

/**
 * The refresh subagent's edits in one call (#669), in place of a `gh` call per edit (27 turns a refresh, ≈1800 direct
 * `gh` calls in two weeks across five projects): descriptions (`applyEdits`, `answerInBody` — in order, each on the
 * result of the previous one), blocked by removed, tasks closed as done or not needed, new tasks of the epic, and the
 * report on the epic — «Refresh after #N, result: …», which `task close` waits for. Every edit is checked before any
 * write: one that can't be done (no such text, a closed or foreign task, an answered question) — the whole file is
 * refused, each such edit named, nothing changed. The editable tasks — the epic and its open tasks besides the shipped
 * ones: those and their epic are closed by `task close`.
 */
function applyRefresh(io: Io, slug: string, file: string, r: { numbers: number[]; epic: TaskText; open: TaskText[] }): void {
  const { report, edits } = readRefreshFile(file);
  const tasks = new Map([r.epic, ...r.open].map((t) => [t.number, t]));
  const bodies = new Map<number, { body: string; done: string[] }>();
  const unblock: { t: TaskText; b: TaskText["blockedBy"][number] }[] = [];
  const close: { t: TaskText; how: "done" | "not needed" }[] = [];
  const created: NewTask[] = [];
  const problems: string[] = [];
  edits.forEach((raw, i) => {
    const at = `edit ${i + 1}`;
    try {
      const e: Any = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
      const actions = e ? REFRESH_ACTIONS.filter((a) => Object.hasOwn(e, a)) : [];
      if (!e || actions.length !== 1) throw new GhError(`expected one action of ${REFRESH_ACTIONS.join(", ")}${actions.length ? `, not ${actions.join(" and ")}` : ""}`);
      const action = actions[0]!;
      if (action === "new") {
        const title = asText(e.new).trim();
        if (!title) throw new GhError("«new» — the new task's title");
        created.push({ title, body: asText(e.body), epic: e.epic === false ? undefined : r.epic.number, blockedBy: [], labels: [] });
        return;
      }
      const n = Number(e.task);
      const t = tasks.get(n);
      if (!t) {
        const why = !Number.isInteger(n) || n <= 0 ? "«task» — the issue number" : r.numbers.includes(n) ? `#${n} shipped — task close closes it` : `#${n} is not an open task of epic #${r.epic.number}`;
        throw new GhError(`${why}; editable: ${[...tasks.keys()].map((x) => `#${x}`).join(", ")}`);
      }
      const now = bodies.get(n) ?? { body: t.body, done: [] };
      if (action === "replace" || action === "add" || action === "check") {
        if (action === "replace" && typeof e.with !== "string") throw new GhError(`#${n}: «replace» — and «with», the new text («""» removes it)`);
        if (action === "add" && !asText(e.item).trim()) throw new GhError(`#${n}: «add» — and «item», the item's text`);
        const edit: Edit =
          action === "replace" ? { kind: "replace", old: asText(e.replace), next: asText(e.with) } : action === "add" ? { kind: "add", section: asText(e.add), item: asText(e.item) } : { kind: "check", text: asText(e.check) };
        const res = applyEdits(n, now.body, [edit]);
        bodies.set(n, { body: res.body, done: [...now.done, ...res.done] });
      } else if (action === "answer") {
        const k = Number(e.answer);
        if (!Number.isInteger(k) || k <= 0) throw new GhError(`#${n}: «answer» — the question's number`);
        const res = answerInBody(n, now.body, k, asText(e.text), e.auto === true);
        bodies.set(n, { body: res.body, done: [...now.done, `question ${k} answered`] });
      } else if (action === "unblock") {
        const ref = typeof e.unblock === "number" ? `#${e.unblock}` : asText(e.unblock).trim().replace(/^(?=\d)/, "#");
        const b = t.blockedBy.find((x) => blockerRef(slug, x).toLowerCase() === ref.toLowerCase());
        if (!b) throw new GhError(`#${n} isn't blocked by ${ref || "—"}; blocked by: ${t.blockedBy.map((x) => blockerRef(slug, x)).join(", ") || "none"}`);
        if (unblock.some((u) => u.t === t && u.b === b)) throw new GhError(`#${n}: ${ref} is removed by an earlier edit`);
        unblock.push({ t, b });
      } else {
        if (e.close !== "done" && e.close !== "not needed") throw new GhError(`#${n}: «close» — «done» (part of what shipped) or «not needed»`);
        if (t === r.epic) throw new GhError(`epic #${n} — task close closes it with its last task`);
        if (close.some((c) => c.t === t)) throw new GhError(`#${n} is closed by an earlier edit`);
        close.push({ t, how: e.close });
      }
    } catch (err) {
      if (!(err instanceof GhError)) throw err;
      problems.push(`${at}: ${err.message}`);
    }
  });
  for (const m of report.matchAll(NEW_REF_RE)) if (Number(m[1]) < 1 || Number(m[1]) > created.length) problems.push(`report: ${m[0]} — the file has ${created.length} «new» edit${created.length === 1 ? "" : "s"}`);
  if (problems.length) throw new GhError(`--apply ${file}: nothing changed — ${problems.join("; ")}`);

  const questionLabels = locale.every((n) => n.labels.questions);
  for (const [n, { body, done }] of bodies) {
    const t = tasks.get(n)!;
    mutate(io, { op: "UpdateIssue", input: { id: t.id, body } });
    io.out(`+ #${n}: description — ${done.join(", ")}`);
    const labels = t.labels.filter((l) => questionLabels.includes(l.name));
    if (!labels.length || questionItems(body).some((x) => !x.answered)) continue;
    mutate(io, { op: "RemoveLabels", input: { labelableId: t.id, labelIds: labels.map((l) => l.id) } });
    io.out(`+ #${n}: label ${labels.map((l) => q(l.name)).join(", ")} removed — no open questions left`);
  }
  for (const { t, b } of unblock) {
    mutate(io, { op: "RemoveBlockedBy", input: { issueId: t.id, blockingIssueId: b.id } });
    io.out(`+ #${t.number}: blocked by ${blockerRef(slug, b)} removed`);
  }
  const numbers: number[] = [];
  for (const task of created) {
    // the new task's number — from its «Created #N» line: the report names it as #newK
    cmdTaskNew({ ...io, out: (l) => (numbers.push(...[/^Created #(\d+)/.exec(l)?.[1]].filter(Boolean).map(Number)), io.out(l)) }, slug, task);
  }
  const ctx = close.some((c) => c.how === "done") ? taskContext(io, slug) : null;
  for (const { t, how } of close) {
    if (how === "not needed") {
      cmdTaskDrop(io, slug, t.number);
      continue;
    }
    mutate(io, { op: "CloseIssue", input: { issueId: t.id, stateReason: "COMPLETED" } });
    const put = putStatus(io, ctx!, loadIssue(io, slug, t.number), N.status.done);
    io.out(`+ #${t.number} closed as done${put ? `: ${STATUS} ${q(N.status.done)}` : ""}`);
    if (!put) io.out(noBoard(t.number, `${STATUS} ${q(N.status.done)} isn't set`));
  }
  const text = report.replace(NEW_REF_RE, (_, k) => `#${numbers[Number(k) - 1] ?? `new${k}`}`);
  mutate(io, { op: "AddComment", input: { subjectId: r.epic.id, body: locale.fill(N.actualize.report, { number: r.numbers.join(", #"), text }) } });
  io.out(`+ epic #${r.epic.number}: the refresh report — ${q(clip(text))}`);
}

/**
 * The epic refresh's report (#571): the refresh subagent ends with a comment on the epic that starts with `report` —
 * «Refresh after #N, result: …» in any language of the dictionary, case and markup aside; the script's own comment
 * (`mechanics`) comes before the subagent and isn't it. The tasks shipped together (a batch's release, #676) have one
 * report on their epic — «Refresh after #N, #M, result: …»: it is each one's.
 */
function refreshReported(epic: { comments: { body: string }[] }, number: number): boolean {
  const SLOT = "\u0001";
  const heads = locale
    .every((n) => n.actualize.report)
    .map((t) => new RegExp(locale.escapeRe(locale.fill(t, { number: SLOT, text: "" }).trim().toLowerCase()).replace(SLOT, "(\\d+(?:,\\s*#\\d+)*)"), "gu"));
  const named = (m: RegExpMatchArray) => m[1]!.split(/,\s*#/).map(Number).includes(number);
  return epic.comments.some((c) => heads.some((h) => [...c.body.toLowerCase().matchAll(h)].some(named)));
}

/**
 * The epic's tasks a batch's release shipped together with this one (#676): «Closes #N» of the release PR's body among
 * the epic's sub-issues, this task among them, by number; the body not read — an `○` line and this task alone.
 */
function releasedWith(io: Io, slug: string, pr: number, number: number, epic: TaskText): number[] {
  let body = "";
  try {
    body = restCall(io, ["api", `repos/${slug}/pulls/${pr}`])?.body ?? "";
  } catch (e) {
    if (!(e instanceof GhError)) throw e;
    io.out(`○ the release PR #${pr} not read (${e.message}) — the epic refresh is looked for by #${number} alone`);
  }
  const subs = new Set(epic.subIssues.map((x) => x.number));
  return [...new Set([number, ...closingInBody(body).filter((n) => subs.has(n))])].sort((a, b) => a - b);
}

/**
 * The closing ritual after a PR merge — the actual, Status "Done", the epic, the milestone, taking down the task's
 * stacks, cleaning up the merged branch — in one call: the session did it one step per turn at its largest context.
 * The epic refresh (the canon's five checks) isn't here: it runs before close, in parallel with the deploy, by a
 * subagent with the `task actualize` assignment. Where the epic has open tasks besides this one, close refuses before
 * any change until the subagent's report is on the epic (`refreshReported`, #571): an executor closed its task and
 * answered while its refresh subagent still worked in its worktree — the dispatcher's next queue removed the worktree,
 * and the subagent was left without a directory. Close names the three lines, one of which ends the session's answer,
 * and archiving the session in auto mode — except a session with questions for the owner. A task merged only into a
 * batch branch (#648, question 1 of epic #645) — refused before any change: it stays In progress till the release, and
 * the generic refusal would send its executor to close the issue by hand as a task without a PR. After the release
 * (#649) the release PR is the task's merged PR — `Closes #N` of its body links it: the branches are its head, the batch
 * branch, — kept while a live executor's PR is into it — and the task's own PR into the batch. Its refresh is the epic's
 * (#676): one for the release's tasks of the epic (`releasedWith`), the report naming them is each one's; the refusal
 * names that set and its `task actualize`. Every batch of the task's PRs released, its «Closes» without the task (#819:
 * a red release's fix PR closed it, merged after the release PR opened, the release not rebuilt) — the release PR is the
 * task's merged PR, as if GitHub had linked it: closed with the comment that names it. A PR of the task on another
 * task's branch — an `○` line after the actual: the work went in that task's session.
 */
export function cmdTaskClose(io: Io, slug: string, number: number, o: { git: boolean }): number {
  const ctx = taskContext(io, slug);
  const issue = loadIssue(io, slug, number);
  // a merge into a batch branch isn't the task's merge (#648): it closes with the batch's release
  const linked = issue.prs.filter((p) => p.merged && !isBatchBranch(p.base));
  const closedNoPr = !issue.prs.length && issue.state === "CLOSED" && issue.stateReason === "COMPLETED";
  // GitHub may not link a merged PR to the task for hours: the task is open, no merged PR among the linked ones — we
  // look for the task's PR ourselves
  const found = !linked.length && issue.state === "OPEN" ? unlinkedPrs(io, slug, number) : null;
  const fresh = (found?.prs ?? []).filter((p) => !issue.prs.some((x) => x.number === p.number));
  const byPr = fresh.filter((p) => p.merged);
  // a batch's PRs (`Q.BatchPrs`) — read once for the release fallback, the actual's line and the branches
  const batchesRead = new Map<string, Recent>();
  const prsOfBatch = (b: string) => batchesRead.get(b) ?? batchesRead.set(b, batchPrs(io, slug, b)).get(b)!;
  const batched = linked.length || byPr.length ? [] : [...issue.prs, ...(found?.batched ?? [])].filter((p) => p.merged && isBatchBranch(p.base));
  // every batch of them released, the release's «Closes» without the task (#819: a red release's fix PR closed it, merged
  // into the batch after the release PR opened) — the release PR is its merged PR, as GitHub would have linked it
  const bases = [...new Set(batched.map((p) => p.base))];
  const released = bases.flatMap((b) => {
    const r = releasePrOf(prsOfBatch(b), b);
    const into = [...new Set(batched.filter((p) => p.base === b).map((p) => `#${p.number}`))];
    return r?.merged ? [{ number: r.number, state: "MERGED", merged: true, head: b, base: r.base, why: `the release of ${b}, PR ${into.join(", ")} merged into it` }] : [];
  });
  if (batched.length && released.length < bases.length) {
    const prs = [...new Set(batched.map((p) => `#${p.number}`))].join(", ");
    throw new GhError(
      `#${number} is too early to close: PR ${prs} merged into ${batched[0]!.base}, not into ${found?.base ?? "the default branch"} — ` +
        `the task closes with the batch's release (Closes #${number} in the release PR); till then it stays ${q(N.status.inProgress)}`,
    );
  }
  const unlinked = [...byPr, ...released];
  const merged = linked.length ? linked : unlinked;
  if (!merged.length && !closedNoPr) {
    const prs = [...issue.prs, ...fresh].map((p) => `#${p.number} ${p.state === "OPEN" ? "open" : "closed without a merge"}`).join(", ");
    const what = prs ? `PR ${prs}` : `the task is ${issue.state === "OPEN" ? "open" : "closed without being done"}, no merged PR`;
    const checked = found ? `; checked: the PR–task link, the branch <type>/${number}-<slug> and «Closes #${number}» in the body of the last ${RECENT_PRS} PRs into ${found.base}` : "";
    // no PR at all and the task open — a task without commits closes its issue itself, and its executor didn't know (#628)
    const noPr =
      !prs && issue.state === "OPEN"
        ? `; a task without a PR (a data edit, a reconciliation, research) — close the issue as completed with a result comment: gh issue close ${number} --repo ${slug} --reason completed --comment "<result>", then task close ${number} again`
        : "";
    throw new GhError(`#${number} is too early to close: ${what}${checked} — close after the PR is merged or the task is closed${noPr}`);
  }
  if (issue.parent) {
    const epic = loadTaskText(io, slug, issue.parent.number);
    // a batch's release (#676): its tasks of this epic are refreshed together — one refresh per epic, one report
    const release = merged.find((p) => isBatchBranch(p.head));
    const together = release ? releasedWith(io, slug, release.number, number, epic) : [number];
    const others = epic.subIssues.filter((x) => x.state === "OPEN" && !together.includes(x.number)).length;
    if (others && !refreshReported(epic, number)) {
      const tags = together.map((n) => `#${n}`).join(", ");
      const head = locale.fill(N.actualize.report, { number: together.join(", #"), text: "…" });
      const shipped = release ? `The release PR #${release.number} shipped ${tags} of the epic — one refresh for them. ` : "";
      throw new GhError(
        `#${number} is too early to close: the epic refresh hasn't reported — epic #${epic.number} has open tasks besides ${tags} (${others}), and no comment «${head}» on it. ` +
          `${shipped}The refresh subagent is at work — wait for its answer, then task close ${number} again; it wasn't launched — task actualize ${together.join(" ")} and the subagent with its prompt; ` +
          `it answered without the comment — post its result: gh issue comment ${epic.number} --repo ${slug} --body "${head}"`,
      );
    }
  }
  const wasOpen = issue.state === "OPEN";
  if (wasOpen) {
    // without the link the task doesn't see its PR — a comment names it
    if (unlinked.length) mutate(io, { op: "AddComment", input: { subjectId: issue.id, body: locale.fill(N.comments.closedByPr, { prs: unlinked.map((p) => `#${p.number}`).join(", ") }) } });
    mutate(io, { op: "CloseIssue", input: { issueId: issue.id, stateReason: "COMPLETED" } });
    io.out(
      unlinked.length
        ? `+ #${number} closed by PR ${unlinked.map((p) => `#${p.number} (${p.why})`).join(", ")}: GitHub didn't link the PR to the task`
        : `+ #${number} closed: PR ${merged.map((p) => `#${p.number}`).join(", ")} merged`,
    );
  }
  freshClone(io, slug);
  runFact(io, slug, number);
  // a task done in another task's PR (#819: «Closes #M» in a red release's fix PR, on the guilty task's branch) — its work
  // went in that task's session: the line names whose actual has it
  const intoReleased = [...new Set(merged.map((p) => p.head).filter(isBatchBranch))].flatMap((b) => mergedIntoBatch(prsOfBatch(b).nodes, b, number).map(prRef));
  for (const p of [...merged.map(prRef), ...intoReleased]) {
    const owner = taskBranch(p.head)?.issue;
    if (owner && owner !== number) io.out(`○ #${number} was done in PR #${p.number} on the branch of #${owner} (${p.head}): the work went in #${owner}'s session — an actual unavailable above is in #${owner}'s`);
  }
  // no board (#847): done by the facts — closed as completed; the actual is est's comment, the fields are a board's
  const put = putStatus(io, ctx, issue, N.status.done);
  io.out(put ? `+ #${number}: ${STATUS} ${q(N.status.done)}${put.added ? " (added to the project)" : ""}` : noBoard(number, `${STATUS} ${q(N.status.done)} isn't set`));
  closeMilestone(io, slug, issue, wasOpen);
  if (issue.parent) {
    const epic = loadIssue(io, slug, issue.parent.number);
    const open = epic.subIssues.filter((x) => x.state === "OPEN" && x.number !== number).length;
    if (epic.state === "OPEN" && epic.subIssues.length && !open) {
      mutate(io, { op: "CloseIssue", input: { issueId: epic.id, stateReason: "COMPLETED" } });
      const done = putStatus(io, ctx, epic, N.status.done);
      io.out(`+ epic #${epic.number} closed${done ? ` and in ${q(N.status.done)}` : ""}: all subtasks are closed`);
      closeMilestone(io, slug, epic, true);
    } else if (epic.state === "OPEN") io.out(`○ epic #${epic.number}: open subtasks ${open}`);
  }
  // stacks of task-env and branches are named by the checkout's origin: from someone else's checkout — another project's
  if (!checkoutOfRepo(io, originUrl(io), slug)) io.out(`○ ${o.git ? "branches and task stacks" : "task stacks"} left alone: the current directory is not a checkout of ${slug}`);
  else {
    takeDownStacks(io, number);
    if (o.git) {
      // a follow-up fix to a merged PR is the same task, and GitHub doesn't link it (Refs, not Closes): the branches are
      // those of every merged PR of the task — the linked ones and the ones found by the branch or «Closes #N»
      const all = found ?? unlinkedPrs(io, slug, number);
      const more = all.prs.filter((p) => p.merged && !merged.some((x) => x.number === p.number));
      // a released batch (#649): the release PR's head is the batch branch, it goes; so does the task's PR merged into
      // it — its branch, the checkout moving to the default branch. The batch's PRs — all of them, not the recent ones
      const shipped = [...merged, ...more];
      const batches = new Map([...new Set(shipped.map((p) => p.head).filter(isBatchBranch))].map((b) => [b, prsOfBatch(b)]));
      const ofTask = [...batches].flatMap(([b, prs]) =>
        mergedIntoBatch(prs.nodes, b, number).map((p) => ({ number: p.number as number, head: p.headRefName as string, base: all.base })),
      );
      // …but not while a live executor's PR is into it: deleting a PR's base closes it or moves it into the default
      // branch past the dispatcher
      const live = (head: string) => (batches.has(head) ? openInto(batches.get(head)!, head) : []);
      for (const b of batches.keys()) {
        if (!live(b).length) continue;
        io.out(`○ batch branch ${b} kept: open PR ${live(b).map((p) => `#${p.number}`).join(", ")} into it — its executor moves it to the next batch or ${all.base} first (pr premerge says where); then the dispatcher's task queue deletes the branch`);
      }
      cleanupBranches(io, slug, number, [...shipped, ...ofTask].filter((p) => !live(p.head).length));
    }
  }
  // the marks of task finish and pr premerge (#842) — nothing is left to resume
  rmSync(finishFile(io, slug, number), { force: true });
  return endWith(io, STEP.over(""), 0);
}

/** `task finish` without `--timeout`: an hour — a CI run or a deploy fits into one background call. */
export const FINISH_TIMEOUT = 3600;
/** Less time left than this — a wait isn't started: the call returns with its state and the same command — `task finish` again. */
const FINISH_MIN_WAIT = 30;
/** A PR title by the canon — a conventional commit: `type(scope)!: subject`. */
const CONVENTIONAL = /^[a-z]+(?:\([^)]*\))?!?: \S/;

/**
 * What `task finish` remembers between its calls, `<config directory>/finishes/<owner>__<repo>__<N>.json`: the deploy
 * of the merge passed (a repeat doesn't wait for it again) and the epic refresh's mechanics done with its prompt printed
 * (a repeat doesn't print it for a second subagent). The rest of its state is GitHub's and git's — read again each call.
 */
interface FinishMarks {
  deployed?: number;
  actualized?: string;
}
const finishFile = (io: Io, slug: string, number: number) => path.join(configDir(io.env), "finishes", `${slug.replace("/", "__")}__${number}.json`);
function finishMarks(io: Io, slug: string, number: number): FinishMarks {
  try {
    return JSON.parse(readFileSync(finishFile(io, slug, number), "utf8"));
  } catch {
    return {};
  }
}
function markFinish(io: Io, slug: string, number: number, marks: FinishMarks): void {
  const file = finishFile(io, slug, number);
  mkdirSync(path.dirname(file), { recursive: true });
  // the configuration directory may be a personal git checkout (ELVES_PRIVATE) — marks aren't committed into it
  writeFileSync(path.join(path.dirname(file), ".gitignore"), "*\n");
  writeFileSync(file, `${JSON.stringify({ ...finishMarks(io, slug, number), ...marks })}\n`);
}

/** A ci-wait run (`wait-ci.sh <mode> <N>`) for at most `seconds`: its code (0 PASS · 1 FAIL · 2 TIMEOUT · 3 ERROR) and RESULT line. */
function finishWait(io: Io, slug: string, mode: "pr" | "merged", pr: number, seconds: number): { code: number; result: string } {
  const r = (io.run ?? realRun)("bash", [waitCi(), mode, String(pr), "--repo", slug, "--timeout", String(seconds)], io.cwd);
  const lines = r.stdout.split("\n").filter((l) => l.trim());
  for (const line of lines.filter((l) => !l.startsWith("RESULT:")).slice(-5)) io.out(`  ${line}`);
  return { code: r.status ?? 3, result: lines.filter((l) => l.startsWith("RESULT:")).at(-1) ?? `RESULT: ERROR ${why(r)}` };
}

/**
 * The task branch on origin: already there — nothing; origin behind — a push; origin has the same commits rebased (a
 * conflict resolved by a rebase, every origin commit is in HEAD by its patch — `git cherry`) — `--force-with-lease` on
 * that very origin head; origin has commits that aren't here — someone else's work: a stop. No `-u`: the upstream is a
 * write to the `.git/config` shared with parallel worktrees (#438), and nothing here needs it. A reason — the stop.
 */
function pushTaskBranch(io: Io, branch: string): string | null {
  const rev = (ref: string) => git(io, io.cwd, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`).stdout.trim();
  git(io, io.cwd, "fetch", "-q", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
  const head = rev("HEAD");
  const remote = rev(`refs/remotes/origin/${branch}`);
  if (remote === head) return io.out(`= branch ${branch} is on origin (${head.slice(0, 7)})`), null;
  let lease: string[] = [];
  if (remote && git(io, io.cwd, "merge-base", "--is-ancestor", remote, head).status !== 0) {
    const cherry = git(io, io.cwd, "cherry", "HEAD", remote);
    if (cherry.status !== 0 || cherry.stdout.split("\n").some((l) => l.startsWith("+"))) {
      return `origin/${branch} has commits that aren't in this checkout — someone else's work or an older line: git log HEAD..origin/${branch}; take them (git rebase origin/${branch}) or, if they are yours and dropped on purpose, git push --force-with-lease yourself`;
    }
    lease = [`--force-with-lease=refs/heads/${branch}:${remote}`];
  }
  const pushed = git(io, io.cwd, "push", "-q", ...lease, "origin", `HEAD:refs/heads/${branch}`);
  if (pushed.status !== 0) return `git push origin ${branch}: ${why(pushed)}`;
  io.out(`+ branch ${branch} pushed${lease.length ? " (rebased: --force-with-lease)" : ""}: ${remote ? `${remote.slice(0, 7)} → ` : ""}${head.slice(0, 7)}`);
  return null;
}

/**
 * The tail of a task from its committed branch to its close in one resumable command (#668): the tail took a median
 * of 18 turns at the peak context, ≈19 of them the flow's own mechanics. Each call does what is ready within
 * `--timeout`, prints the state and the next step, and a repeat goes on from where it stopped — the state is GitHub's and
 * git's, plus two marks (`FinishMarks`). Before the merge: the branch pushed, the PR (the title — a conventional commit:
 * `--title`, otherwise the branch type's first commit; the body — spec-diff and `Closes #N`; an existing PR — its body
 * updated), decision labels (`pr labels`), a PR opened in Claude Code — a stop with the `set_monitor` step (Auto-fix off,
 * #866), the CI wait (ci-wait), `pr premerge` — then the merge command: the
 * merge stays a separate `gh pr merge <N> --rebase` call — the owner's permission rule in auto mode matches it
 * (claude/CLAUDE.md). After the merge (the task is open or already closed by «Closes #N» — the tail is over only by
 * `task close`'s Status Done and actual, #761): the deploy wait on the merge SHA, the epic refresh's mechanics and its subagent's
 * prompt, `task close` once its report is on the epic. A PR into a batch branch (#676): no CI to wait for, and
 * after its merge — nothing, the release does the rest. Codes (#842): 0 — finished (closed; merged into a batch), 1 —
 * stopped on a step — a fix (red CI, a conflict, a push refused, premerge red), the red base's bug, the merge, the refresh
 * subagent, out of time (the same command again): the automaton's `Next:` line (`STEP`) tells them, not the code.
 */
export function cmdTaskFinish(io: Io, slug: string, number: number, o: { timeout: number; title?: string | undefined }): number {
  const until = Date.now() + o.timeout * 1000;
  const left = () => Math.floor((until - Date.now()) / 1000);
  const again = `bun --no-env-file ${import.meta.path} task finish ${number}${o.timeout === FINISH_TIMEOUT ? "" : ` --timeout ${o.timeout}`}`;
  // a stop — the why and the automaton's step (#842): code 1, the step is told by the Next line, not by the code
  const stop = (why: string, step: NextStep) => (io.out(why), endWith(io, step, 1));
  const fix = (next: string): NextStep => ({ state: "", next, who: "agent" });
  const outOfTime = (what: string) => stop(`○ out of time (--timeout ${o.timeout}) — ${what}`, STEP.again("", again));
  const issue = loadIssue(io, slug, number);
  if (issue.state !== "OPEN") {
    // «Closes #N» of the PR closes the task at the merge (#761): a closed issue isn't a finished tail — task close's marks are
    const closer = issue.stateReason === "COMPLETED" ? (lastMerged(issue.prs.filter((p) => !isBatchBranch(p.base))) ?? null) : null;
    // a task reopened after its merge (#813): its open PR or its branch's unmerged work is the tail, not the merged PR
    const work = workPastMerge(io, slug, number, issue, closer);
    if (work) {
      if (issue.stateReason !== "COMPLETED") return stop(`! #${number} is closed as ${issue.stateReason ?? "not planned"}, but ${work}`, fix(`gh issue reopen ${number} --repo ${slug}, then ${again}`));
      mutate(io, { op: "ReopenIssue", input: { issueId: issue.id } });
      // no board (#847) — the task's work is the fact that puts it in work
      const put = putStatus(io, taskContext(io, slug), issue, N.status.inProgress) !== null;
      io.out(`+ #${number} reopened${put ? `, ${STATUS} ${q(N.status.inProgress)}` : ""}: ${work} — the task's merged PR isn't its finish`);
      return cmdTaskFinish(io, slug, number, { ...o, timeout: Math.max(0, left()) });
    }
    if (!closer || tailOver(io, slug, number)) return io.out(`= #${number} is closed — nothing to finish`), endWith(io, STEP.closed(""), 0);
    io.out(`○ #${number} is closed by the merge of PR #${closer.number}, the tail isn't over (no ${q(N.status.done)} with the actual) — going on`);
    return finishMerged(io, slug, number, issue.parent?.number ?? null, closer, { left, again, stop, outOfTime });
  }
  if (!checkoutOfRepo(io, originUrl(io), slug)) throw new GhError(`task finish runs from a checkout of ${slug}: the current directory is not one`);
  const found = unlinkedPrs(io, slug, number);
  const prs = [...issue.prs, ...found.prs, ...found.batched].filter((p, k, all) => all.findIndex((x) => x.number === p.number) === k);
  // the latest merged PR is the task's finish only without an open PR and without unmerged work on its branch (#813):
  // a task reopened after the merge goes on with its new branch — its push, its PR, its merge
  const merged = lastMerged(prs);
  const pending = prs.some((p) => p.state === "OPEN") || (merged && unmergedBranch(io, number, merged.base, merged.head));
  if (merged && !pending) return finishMerged(io, slug, number, issue.parent?.number ?? null, merged, { left, again, stop, outOfTime });

  const branch = git(io, io.cwd, "branch", "--show-current").stdout.trim();
  const open = prs.find((p) => p.state === "OPEN");
  if (open && open.head !== branch) return stop(`! PR #${open.number} of #${number} is on branch ${open.head}, the checkout — on ${branch || "a detached HEAD"}`, fix(`git switch ${open.head} (or continue in that PR's checkout), then ${again}`));
  if (!isTaskBranch(branch, number)) throw new GhError(`the checkout is on ${q(branch || "a detached HEAD")}, not on a branch of #${number} — task start ${number} --branch <type>/${number}-<slug>`);
  const dirty = git(io, io.cwd, "status", "--porcelain", "--untracked-files=no").stdout.trim();
  if (dirty) return stop(`! uncommitted changes in the checkout — the PR would go without them`, STEP.commit("", again));
  const base = open?.base ?? finishBase(io, slug, number, found);
  const fetched = git(io, io.cwd, "fetch", "-q", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`);
  if (fetched.status !== 0) throw new GhError(`git fetch origin ${base}: ${why(fetched)}`);
  const commits = git(io, io.cwd, "log", "--reverse", "--format=%s", `origin/${base}..HEAD`).stdout.split("\n").filter((l) => l.trim());
  if (!commits.length) return stop(`! no commits on ${branch} past origin/${base} — nothing to put into a PR`, STEP.work("", again));
  // commits already in the base by their changes (#768) — a released batch's, rebased into the default branch with other
  // SHAs: the PR would take its title from them and its decision labels from their diff; a rebase drops them
  const applied = git(io, io.cwd, "cherry", `origin/${base}`, "HEAD").stdout.split("\n").filter((l) => l.startsWith("-")).length;
  if (applied) {
    return stop(
      `! ${applied} ${applied > 1 ? "commits" : "commit"} of ${branch} ${applied > 1 ? "are" : "is"} in origin/${base} already by the changes (a released batch's, a merged PR's) — the PR would take its title and decision labels from them`,
      fix(`git rebase origin/${base} (it drops them), then ${again} (it pushes the rebased branch with --force-with-lease)`),
    );
  }
  const refused = pushTaskBranch(io, branch);
  if (refused) return stop(`! ${refused}`, fix(`the fix the line above names, then ${again}`));

  const spec = specDiffOf(io, base, "HEAD", "the PR");
  const body = `${[...(spec ? [spec] : []), `Closes #${number}`].join("\n\n")}\n`;
  let pr: number;
  if (open) {
    pr = open.number;
    const now = restCall(io, ["api", `repos/${slug}/pulls/${pr}`]);
    if ((now.body ?? "").trim() === body.trim()) io.out(`= PR #${pr} into ${base}: the body is current`);
    else rest(io, `repos/${slug}/pulls/${pr}`, { method: "PATCH", payload: { body } }), io.out(`+ PR #${pr} into ${base}: the body updated — spec-diff and Closes #${number}`);
  } else {
    const type = taskBranch(branch)!.type;
    const title = o.title ?? commits.find((s) => s.startsWith(`${type}:`) || s.startsWith(`${type}(`) || s.startsWith(`${type}!:`)) ?? commits[0]!;
    if (!CONVENTIONAL.test(title)) throw new GhError(`the PR title ${q(title)} is not a conventional commit — task finish ${number} --title "<type>(<scope>): <subject>"`);
    const created = rest(io, `repos/${slug}/pulls`, { method: "POST", payload: { title, head: branch, base, body } });
    pr = created.number;
    io.out(`+ PR #${pr} into ${base}: ${title} — https://github.com/${slug}/pull/${pr}`);
  }
  try {
    cmdPrLabels(io, slug, pr);
  } catch (e) {
    if (!(e instanceof GhError)) throw e;
    io.out(`! pr labels ${pr}: ${e.message} — the PR goes on without them`);
  }
  // a PR opened in Claude Code (#866): Auto-fix off before anything waits on the PR — a repeat finds it open and goes on
  if (!open && io.env["CLAUDECODE"] === "1") {
    const then = isBatchBranch(base) ? `${again} — it runs pr premerge` : STEP.ciWait("", again).next;
    return stop(`○ PR #${pr} is new: the Claude Code app binds it to its CI monitor with Auto-fix on`, STEP.monitor("", `https://github.com/${slug}/pull/${pr}`, then));
  }
  if (!isBatchBranch(base)) {
    if (left() < FINISH_MIN_WAIT) return outOfTime(`PR #${pr} is up, its CI isn't awaited yet`);
    const ci = finishWait(io, slug, "pr", pr, left());
    if (ci.code === 2) return outOfTime(`the CI of PR #${pr} is still running (${ci.result})`);
    if (ci.code === 1) return stop(`❌ the CI of PR #${pr} is red — ${ci.result}`, STEP.ciRed("", pr, again));
    if (ci.code !== 0) {
      return stop(
        `❌ the CI of PR #${pr} didn't finish — ${ci.result}`,
        fix(`a conflict with ${base} — git fetch origin ${base}, git rebase origin/${base}, resolve, ${PRECOMMIT}, then ${again} (it pushes the rebased branch with --force-with-lease); otherwise — the reason above, then ${again}`),
      );
    }
    io.out(`✅ the CI of PR #${pr} is green`);
  }
  const premerge = premergeOf(io, slug, pr).code;
  if (premerge === MAIN_RED) return stop(`⛔ PR #${pr} isn't merged: ${base} is red by itself`, STEP.mainRed("", again));
  if (premerge !== 0) return stop(`❌ PR #${pr} isn't merged: pr premerge stopped (above)`, fix(`what premerge names, then ${again}`));
  return stop(`✅ PR #${pr} is ready to merge`, STEP.merge("", pr, locale.autoProject(io.cwd ?? process.cwd()), `${again}${isBatchBranch(base) ? "" : " — in the background: it waits for the deploy"}`));
}

/** The task's latest merged PR — the highest number: a task reopened after a merge has several (#813). */
function lastMerged<T extends { number: number; merged: boolean }>(prs: T[]): T | undefined {
  return prs.filter((p) => p.merged).sort((a, b) => b.number - a.number)[0];
}

/**
 * The checkout's branch of the task with commits that aren't in `origin/<base>` by their changes (`git cherry`: a
 * rebase merge gives other SHAs) — the work of a task reopened after its merge (#813); none — null. The merged PR's own
 * branch — by the commits past its pushed head while it is on origin: a squash merge has no commit-for-commit match.
 */
function unmergedBranch(io: Io, number: number, base: string, mergedHead?: string): string | null {
  const branch = git(io, io.cwd, "branch", "--show-current").stdout.trim();
  if (!isTaskBranch(branch, number)) return null;
  if (branch === mergedHead) {
    git(io, io.cwd, "fetch", "-q", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
    const past = git(io, io.cwd, "rev-list", "--count", `refs/remotes/origin/${branch}..HEAD`);
    if (past.status === 0) return Number(past.stdout.trim()) > 0 ? branch : null;
  }
  if (git(io, io.cwd, "fetch", "-q", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`).status !== 0) return null;
  const cherry = git(io, io.cwd, "cherry", `origin/${base}`, "HEAD");
  return cherry.status === 0 && cherry.stdout.split("\n").some((l) => l.startsWith("+")) ? branch : null;
}

/**
 * What a closed task still has after its merged PR (#813): an open PR of the task, or the checkout's task branch with
 * work its base hasn't got. Nothing — null; the checkout isn't the repository's — only the PR counts.
 */
function workPastMerge(io: Io, slug: string, number: number, issue: Issue, closer: Issue["prs"][number] | null): string | null {
  const open = issue.prs.find((p) => p.state === "OPEN");
  if (open) return `its PR #${open.number} is open`;
  const current = git(io, io.cwd, "branch", "--show-current").stdout.trim();
  if (!isTaskBranch(current, number) || !checkoutOfRepo(io, originUrl(io), slug)) return null;
  const base = closer?.base ?? unlinkedPrs(io, slug, number).base;
  const branch = unmergedBranch(io, number, base, closer?.head);
  return branch ? `branch ${branch} has commits that aren't in origin/${base}` : null;
}

/**
 * The base of the task's new PR: the dispatcher's batch branch (#648); a task past the batch (#697) — the default branch,
 * as outside a batch; the batch released (#768: its release PR merged, or its branch gone from origin) — the default
 * branch too: a released batch takes no more PRs, and the queue starts the next one only with a task to hand out (its
 * marker names it then).
 */
function finishBase(io: Io, slug: string, number: number, found: ReturnType<typeof unlinkedPrs>): string {
  const batch = handedPastBatch(io, slug, number) ? null : batchOf(io, slug);
  if (!batch) return found.base;
  const release = releasePrOf(found.recent, batch);
  if (release?.merged) return io.out(`○ ${batch} is released by PR #${release.number} — the PR goes into ${found.base}`), found.base;
  const listed = git(io, io.cwd, "ls-remote", "--heads", "origin", `refs/heads/${batch}`);
  if (listed.status === 0 && !listed.stdout.trim()) return io.out(`○ ${batch} is gone from origin (released) — the PR goes into ${found.base}`), found.base;
  return batch;
}

/**
 * The tail is over — what `task close` leaves (#761, question 1): Status Done and the actual written, not the issue's
 * state, which «Closes #N» sets at the merge. No board (#847) — done by the facts (closed as completed) and est's
 * actual comment (its `<!-- fact {…} -->` marker): the fields are a board's.
 */
function tailOver(io: Io, slug: string, number: number): boolean {
  const [owner, name] = slug.split("/");
  return tailOverOf(io, slug, graphql(io, Q.IssueShow, { owner, name, number })?.repository?.issue);
}

/** `tailOver` of an issue as `Q.IssueShow` reads it — `task next` has it read already (#842). */
function tailOverOf(io: Io, slug: string, i: Any): boolean {
  const name = slug.split("/")[1];
  if (!taskContext(io, slug).board) return i?.state === "CLOSED" && i.stateReason === "COMPLETED" && shownComments(i.comments).nodes.some((c) => commentKind(c) === "actual");
  const values = itemValues(i, name!);
  const done = values.some((v) => v?.field?.name === STATUS && locale.every((n) => n.status.done).includes(v.name));
  const actual = values.some((v) => v?.__typename === "ProjectV2ItemFieldNumberValue" && locale.every((n) => n.fields.actual).includes(v.field?.name));
  return done && actual;
}

/** `task finish` after the merge: the batch's — nothing; the default branch's — the deploy, the epic refresh, `task close`. */
function finishMerged(
  io: Io,
  slug: string,
  number: number,
  epicNumber: number | null,
  merged: Issue["prs"][number],
  f: { left: () => number; again: string; stop: (why: string, step: NextStep) => number; outOfTime: (what: string) => number },
): number {
  if (isBatchBranch(merged.base)) {
    io.out(`✅ PR #${merged.number} is merged into ${merged.base} — #${number} stays ${q(N.status.inProgress)} till the batch's release`);
    // the task's stacks don't wait for the release (#765): the executor is done, its stack only loads the machine
    if (checkoutOfRepo(io, originUrl(io), slug)) takeDownStacks(io, number);
    return endWith(io, STEP.release("", merged.base), 0);
  }
  const marks = finishMarks(io, slug, number);
  if (marks.deployed === merged.number) io.out(`= the checks and the deploy of the merge of PR #${merged.number} passed earlier`);
  else {
    if (f.left() < FINISH_MIN_WAIT) return f.outOfTime(`PR #${merged.number} is merged, its deploy isn't awaited yet`);
    const deploy = finishWait(io, slug, "merged", merged.number, f.left());
    if (deploy.code === 2) return f.outOfTime(`the checks or the deploy of the merge of PR #${merged.number} are still running (${deploy.result})`);
    if (deploy.code !== 0) {
      return f.stop(`❌ the merge of PR #${merged.number} is red — ${deploy.result}`, { state: "", next: `the failed check or deploy on the merge SHA: a fix is the same task — a new branch from a fresh origin/main, its PR with Refs #${number}; then ${f.again}`, who: "agent" });
    }
    io.out(`✅ the checks and the deploy of the merge of PR #${merged.number} passed`);
    markFinish(io, slug, number, { deployed: merged.number });
  }
  if (epicNumber !== null) {
    if (!marks.actualized) {
      cmdTaskActualize(io, slug, [number], { assignment: false, finish: true });
      markFinish(io, slug, number, { actualized: new Date().toISOString() });
    }
    const epic = loadTaskText(io, slug, epicNumber);
    const others = epic.subIssues.filter((x) => x.state === "OPEN" && x.number !== number).length;
    if (others && !refreshReported(epic, number)) {
      const head = locale.fill(N.actualize.report, { number, text: "…" });
      if (!marks.actualized) return f.stop(`○ the epic refresh: its subagent's prompt is above`, STEP.refreshSubagent("", f.again));
      return f.stop(`○ the epic refresh hasn't reported — no comment «${head}» on epic #${epicNumber}; its prompt was printed at ${marks.actualized}`, STEP.refreshWait("", slug, epicNumber, number, f.again));
    }
  }
  return cmdTaskClose(io, slug, number, { git: true });
}

/**
 * What a resumed session restarts: a background wait (ci-wait) dies with the app's process — at a restart four sessions
 * lost their waits in one minute, and the owner wrote "continue" 17 times (#433). The SessionStart hook runs this
 * command: the task pinned to the session (its repository is in the pin, not in the checkout) and its PRs name the
 * wait — an open PR's checks; a merged PR of an open task — the deploy and `task close`. The PR GitHub didn't link — by
 * the task branch, as in `task close`. No pin — no line and no request: the session has no task. Read-only on GitHub.
 * A dispatcher's executors stopped with the app's process, but their transcripts are intact (#528): each is continued
 * with `SendMessage` — its context and worktree, where the task branch and uncommitted work are; a new executor would get
 * a fresh worktree, and git won't give it the branch. So the hand-outs stay (`handedOutFile`): their tasks aren't ready.
 * A session with its own task and executors (#546) — the same lines, without the queue command if it ran none, and
 * then its own task's wait.
 */
export function cmdTaskResume(io: Io): number {
  const dispatcher = dispatcherFile(io);
  const queued = !!dispatcher && existsSync(dispatcher);
  if (queued || (dispatcher && existsSync(`${dispatcher}.tasks`))) {
    io.out(
      "Dispatcher session: its executors (background subagents) stopped with the app's process, their transcripts are intact — " +
        "continue each with SendMessage by its id from the app's notification, not a new executor: it goes on with its context in its own worktree" +
        (queued ? `; then re-read the queue: ${queueCommandIn(dispatcher!)} — their tasks stay = in it` : ""),
    );
    io.out(
      "Dispatcher session: a new executor — only for one that can't be continued, with the same prompt; " +
        `a task ${q(N.status.inProgress)} it continues in the worktree of the task's branch (\`git worktree list\`), not in a new one — its assignment says so: ` +
        "git won't give the branch to a second worktree, and uncommitted work stays in the old one",
    );
  }
  const pin = pinnedTask(io);
  if (!pin) return 0;
  // not a pin — the session has no task, as for est; the line names the file for a human
  if (!pin.task) return io.out(`○ the session pin ${pin.file} — «${pin.line}», not owner/repo#N: the session has no task`), 0;
  const { slug, number } = pin.task;
  const task = `session task ${slug}#${number}`;
  const issue = loadIssue(io, slug, number);
  if (issue.state !== "OPEN") return io.out(`○ ${task} is closed — no wait to restart`), 0;
  const live = (prs: Issue["prs"]) => prs.filter((p) => p.state === "OPEN" || p.merged);
  const prs = live(issue.prs).length ? live(issue.prs) : live(unlinkedPrs(io, slug, number).prs);
  const open = prs.filter((p) => p.state === "OPEN");
  // the task isn't done while a PR of it is open: a follow-up fix after a merge waits for its own checks
  for (const p of open) io.out(`Session task ${slug}#${number}: PR #${p.number} is open — a background wait dies with the app's process; restart it as a background command: bash ${waitCi()} pr ${p.number}`);
  const merged = prs.filter((p) => p.merged).sort((a, b) => b.number - a.number)[0];
  if (!open.length && merged)
    io.out(
      `Session task ${slug}#${number}: PR #${merged.number} is merged, the task is open — where the merge deploys, the deploy wait as a background command: bash ${waitCi()} merged ${merged.number}; ` +
        `then close the task: bun --no-env-file ${import.meta.path} task close ${number}`,
    );
  if (!prs.length) io.out(`○ ${task}: no PR — no wait to restart`);
  return 0;
}

// ----------------------------------------------------------------------------
// The task's next step — one automaton for the task's commands (#842)
// ----------------------------------------------------------------------------

/**
 * Who does the next step (#842): the agent — a command, or a wait it runs; the owner — an answer or a «yes» the agent
 * asks for and waits on; the dispatcher — a batch's release, its session's step; nobody — the task has no steps left.
 */
type NextWho = "agent" | "owner" | "dispatcher" | "none";

/** A task's state in one line and its one next step — a ready command, or whom it waits for and what (#842). */
export interface NextStep {
  state: string;
  next: string;
  who: NextWho;
}

const NEXT_LEAD: Record<NextWho, string> = { agent: "", owner: "waits for the owner — ", dispatcher: "waits for the dispatcher — ", none: "none — " };

/** The `Next:` line (#842): the owner's and the dispatcher's steps are named as waits, no steps — as none. */
const nextLine = (s: Pick<NextStep, "who" | "next">) => `Next: ${NEXT_LEAD[s.who]}${s.next}`;

/**
 * A command's end (#842): the step's `Next:` line and the code — the step is told by the text, not by the code: 0 — the
 * command did its part, 1 — it stopped on the step (a fix, a wait, the merge, the owner's answer); 2 is an error's.
 */
function endWith(io: Io, s: NextStep, code: number): number {
  io.out(nextLine(s));
  return code;
}

/** A step's command ready to run: the script, the arguments and the repository — `task next` runs from anywhere. */
type Ready = (...args: (string | number)[]) => string;
const readyIn =
  (slug: string): Ready =>
  (...args) =>
    ready([...args, "--repo", slug]);

/** The checks before a commit (AGENTS.md, "Git, PRs and merging") — one wording in every step that commits. */
const PRECOMMIT = "the checks before a commit (elves precommit)";

/**
 * The automaton's steps (#842), each worded once: `task next` picks one by the facts, and the commands that reach the same
 * point — `task finish`, `pr premerge`, `task start`, `task answer`, `task close` — end with that step, not with a
 * wording of their own. `finish`, `again` — the command that goes on after the step.
 */
const STEP = {
  epic: (r: Ready, number: number): NextStep => ({
    state: "an epic — it isn't taken into work",
    next: `the question «run the dispatcher on epic #${number}?»; «yes» — ${r("task", "queue", "--epic", number)}`,
    who: "owner",
  }),
  closed: (state: string): NextStep => ({ state, next: "the task has no steps left", who: "none" }),
  /** The last line of a session's answer after its task's close — in the project language (AGENTS.md, "Language"). */
  over: (state: string): NextStep => ({
    state,
    next:
      `the task's steps are over; the last line of the answer is one of three: ${q(N.lastLine.done)}; ` +
      `the owner has something to decide — ${q(`${N.lastLine.questions} …`)} with the questions themselves, without ${q(N.lastLine.done)}; ` +
      `something remains — ${q(`${N.lastLine.remaining} …`)}. ` +
      // the command doesn't read the mode (auto) or the session's background tasks: the session knows them, the step is spelled out in words
      `In auto mode after ${q(N.lastLine.done)} — archive the session where the agent has the tool, ` +
      `first stopping its own background tasks still running (a wait, a watcher over its output, a subagent): a live one blocks archiving; ` +
      `after the other two lines — don't. ` +
      `Information without a decision (an observation, a deadline, a warning) isn't a question: the line and archiving are as with ${q(N.lastLine.done)}`,
    who: "none",
  }),
  questions: (r: Ready, state: string, at: { number: number; k: number }, auto: boolean): NextStep =>
    auto
      ? { state, next: `each open question answered by its recommendation — ${r("task", "answer", at.number, at.k, "<answer>", "--auto")}; one without a clear recommendation — the owner's`, who: "agent" }
      : { state, next: `the answers to the open questions — asked in one message, each with options and a recommendation; each answer — ${r("task", "answer", at.number, at.k, "<answer>")}`, who: "owner" },
  take: (r: Ready, state: string, number: number): NextStep => ({ state, next: r("task", "start", number, "--branch", `<type>/${number}-<slug>`), who: "agent" }),
  blocked: (r: Ready, state: string, number: number): NextStep => ({
    state,
    next: `the blockers lifted: a blocker issue closed, the external blocker label removed; then ${r("task", "start", number, "--branch", `<type>/${number}-<slug>`)}`,
    who: "owner",
  }),
  elsewhere: (state: string, branches: string[]): NextStep => ({
    state,
    next: `continue on ${branches.join(", ")} — in its worktree (git worktree list), in none — git switch ${branches[0]}: the task isn't taken a second time`,
    who: "agent",
  }),
  work: (state: string, finish: string): NextStep => ({ state, next: `the task's code and tests — the scenarios are their it names; ${PRECOMMIT}, git commit; then ${finish}`, who: "agent" }),
  commit: (state: string, finish: string): NextStep => ({ state, next: `${PRECOMMIT}, git commit, then ${finish}`, who: "agent" }),
  finish: (state: string, finish: string): NextStep => ({ state, next: `${finish} in the background — it pushes the branch, opens the PR, waits for its CI and runs pr premerge`, who: "agent" }),
  ciWait: (state: string, finish: string): NextStep => ({ state, next: `${finish} in the background — it waits for the CI, then runs pr premerge`, who: "agent" }),
  /**
   * Auto-fix of a PR just opened in Claude Code off (#866, claude/CLAUDE.md "Auto-fix is off"): the app binds the new PR
   * to its CI monitor with Auto-fix on, and its conflict event wants the base merged in — the rebase merge breaks.
   * `then` — the same `task finish` with what it does next: into a batch — premerge, otherwise the CI wait.
   */
  monitor: (state: string, url: string, then: string): NextStep => ({
    state,
    // an executor subagent's PR isn't bound to its session: the app refuses it — nothing to turn off there
    next: `set_monitor with auto_fix: false and the PR's url ${url} — Auto-fix's conflict event wants the base merged in; refused as not bound to this session — nothing to turn off; then ${then}`,
    who: "agent",
  }),
  ciRed: (state: string, pr: number, again: string): NextStep => ({ state, next: `the failed check's log (gh pr checks ${pr}), the root cause fixed, ${PRECOMMIT}, git commit, then ${again}`, who: "agent" }),
  premerge: (r: Ready, state: string, pr: number): NextStep => ({ state, next: `${r("pr", "premerge", pr)} — a separate call: the checks on the merge with the base`, who: "agent" }),
  merge: (state: string, pr: number, auto: boolean, then: string): NextStep => {
    const merge = `gh pr merge ${pr} --rebase — a separate call, no cd or pipeline (the owner's permission rule matches it); then ${then}`;
    return auto ? { state, next: merge, who: "agent" } : { state, next: `the «yes» to the merge of PR #${pr} (the project is without auto), then ${merge}`, who: "owner" };
  },
  /** `release` — the batch of a release PR (#886): its bug's executor goes past the batch first. */
  mainRed: (state: string, again: string, release: string | null = null): NextStep => ({
    state,
    next:
      (release ? `the bug's executor past the batch — task queue with the bug in its group prints its prompt with --main (into ${release} its merge would wait for this release); then ` : "") +
      `the close of the bug on the red base — its wait above (wait-ci.sh issue <N>, a background command), then ${again}`,
    who: "agent",
  }),
  release: (state: string, batch: string): NextStep => ({
    state,
    next: `the release of ${batch} (batch release): the CI, the deploy, the epic refresh and task close are the release's — nothing more for the task`,
    who: "dispatcher",
  }),
  deploy: (state: string, finish: string): NextStep => ({ state, next: `${finish} in the background — it waits for the deploy of the merge, then the epic refresh and task close`, who: "agent" }),
  refresh: (state: string, finish: string): NextStep => ({ state, next: `${finish} — it does the epic refresh's mechanics and prints its subagent's prompt`, who: "agent" }),
  refreshSubagent: (state: string, again: string): NextStep => ({ state, next: `the subagent in the background with that prompt; after its answer — ${again}`, who: "agent" }),
  refreshWait: (state: string, slug: string, epic: number, number: number, again: string): NextStep => {
    const head = locale.fill(N.actualize.report, { number, text: "…" });
    return {
      state,
      next: `the subagent is at work — wait for its answer, then ${again}; it wasn't launched — task actualize ${number} prints its prompt again; it answered without the comment — post its result: gh issue comment ${epic} --repo ${slug} --body "${head}"`,
      who: "agent",
    };
  },
  close: (r: Ready, state: string, number: number): NextStep => ({ state, next: r("task", "close", number), who: "agent" }),
  again: (state: string, again: string): NextStep => ({ state, next: `${again} — it goes on from here`, who: "agent" }),
};

/**
 * `pr premerge`'s verdict on a PR's head (#842): `<config directory>/premerges/<owner>__<repo>__<PR>.json` — the head and
 * the time; passed — `task next` names the merge while the head is the same and the base hasn't moved since, otherwise
 * premerge again. ❌ (code 1, #884) — `red`, the files its lines name: a batch's release red by it is red
 * (`releaseChecks`), its guilty task goes by them; another verdict — no mark, the next premerge decides.
 */
const premergeFile = (io: Io, slug: string, pr: number) => path.join(configDir(io.env), "premerges", `${slug.replace("/", "__")}__${pr}.json`);
interface PremergeMark {
  head?: string;
  at?: string;
  /** ❌ on this head — the files its lines name; passed — none. */
  red?: string[];
}
function markPremerge(io: Io, slug: string, pr: number, head: string, red?: string[]): void {
  const file = premergeFile(io, slug, pr);
  mkdirSync(path.dirname(file), { recursive: true });
  // the configuration directory may be a personal git checkout (ELVES_PRIVATE) — marks aren't committed into it
  writeFileSync(path.join(path.dirname(file), ".gitignore"), "*\n");
  writeFileSync(file, `${JSON.stringify({ head, at: new Date().toISOString(), ...(red ? { red } : {}) })}\n`);
}
function premergeMarkOf(io: Io, slug: string, pr: number): PremergeMark {
  try {
    return JSON.parse(readFileSync(premergeFile(io, slug, pr), "utf8")) ?? {};
  } catch {
    return {};
  }
}
function premergePassed(io: Io, slug: string, pr: { number: number; sha: string; base: string }): boolean {
  const mark = premergeMarkOf(io, slug, pr.number);
  if (!mark.head || !mark.at || mark.red || mark.head !== pr.sha) return false;
  try {
    const moved = restCall(io, ["api", `repos/${slug}/activity?ref=${encodeURIComponent(`refs/heads/${pr.base}`)}&per_page=1`])[0]?.timestamp ?? null;
    return !moved || Date.parse(moved) <= Date.parse(mark.at);
  } catch (e) {
    if (!(e instanceof GhError)) throw e;
    return false;
  }
}

/** A task's PR as `task next` reads it: linked (with its checks) or found by the branch or «Closes #N», into a batch too. */
type NextPr = { number: number; state: string; merged: boolean; head: string; base: string; sha: string; checks: ShownPr["checks"] };

/**
 * The task's state and its one next step by the facts (#842) — the knowledge of the sequence lives here, not in SKILL.md:
 * the task (an epic, closed, its tail over), the open questions of the task and its epic, its PRs (linked, found by the
 * branch or «Closes #N», into a batch) with their checks, the premerge and finish marks, the batch's release, the epic
 * refresh's report, the checkout's task branch — its changes and commits past the base. Read-only.
 */
export function taskNext(io: Io, slug: string, number: number): NextStep & { title: string } {
  const [owner, name] = slug.split("/");
  const i = graphql(io, Q.IssueShow, { owner, name, number })?.repository?.issue;
  if (!i) throw new GhError(`no issue #${number} in ${slug}`);
  return { title: i.title, ...nextOf(io, slug, number, i) };
}

function nextOf(io: Io, slug: string, number: number, i: Any): NextStep {
  const r = readyIn(slug);
  const auto = locale.autoProject(io.cwd ?? process.cwd());
  const finish = r("task", "finish", number);
  const type = shownType(i);
  if (type !== null && locale.every((n) => n.issueTypes.epic).includes(type)) return STEP.epic(r, number);
  const linked: NextPr[] = (i.closedByPullRequestsReferences?.nodes ?? []).filter(Boolean).map((p: Any) => shownPr(p));
  const inRepo = checkoutOfRepo(io, originUrl(io), slug);
  const current = inRepo ? git(io, io.cwd, "branch", "--show-current").stdout.trim() : "";
  const here = isTaskBranch(current, number);
  // the epic refresh (`task close` refuses without its report): the epic has other open tasks and no report on it
  const others = (i.parent?.subIssues?.nodes ?? []).filter((x: Any) => x.state === "OPEN" && x.number !== number).length;
  const reported = !i.parent || !others || refreshReported({ comments: shownComments(i.parent.comments).nodes }, number);
  const afterMerge = (pr: { number: number }, state: string): NextStep => {
    const marks = finishMarks(io, slug, number);
    if (marks.deployed !== pr.number) return STEP.deploy(`${state}, its deploy isn't awaited yet`, finish);
    if (reported) return STEP.close(r, `${state}, deployed${i.parent ? `, the refresh of epic #${i.parent.number} done` : ""}`, number);
    const s = `${state}, deployed, the refresh of epic #${i.parent.number} hasn't reported`;
    return marks.actualized ? STEP.refreshWait(`${s} — its prompt printed at ${marks.actualized}`, slug, i.parent.number, number, finish) : STEP.refresh(s, finish);
  };
  let found: ReturnType<typeof unlinkedPrs> | null = null;
  const recent = () => (found ??= unlinkedPrs(io, slug, number));

  if (i.state !== "OPEN") {
    if (i.stateReason !== "COMPLETED") return STEP.closed(`closed as ${String(i.stateReason ?? "not planned").toLowerCase().replace("_", " ")} — not done`);
    if (tailOverOf(io, slug, i)) return STEP.closed("closed, its tail is over — done, the actual written");
    // a task reopened after its merge (#813) — task finish reopens it and goes on with that work
    const closer = lastMerged(linked.filter((p) => !isBatchBranch(p.base)));
    const open = linked.find((p) => p.state === "OPEN");
    const branch = !open && here ? unmergedBranch(io, number, closer?.base ?? recent().base, closer?.head) : null;
    if (open || branch) return { state: `closed, but ${open ? `its PR #${open.number} is open` : `branch ${branch} has commits that aren't in the base`}`, next: `${finish} — it reopens the task and goes on with that work`, who: "agent" };
    if (closer) return afterMerge(closer, `closed by the merge of PR #${closer.number} into ${closer.base}`);
    // closed as completed without a PR: the refresh and the close are the executor's (#628)
    if (!reported)
      return { state: `closed without a PR, the refresh of epic #${i.parent.number} hasn't reported`, next: `${r("task", "actualize", number)} — its subagent in this turn, not in the background; after its answer — ${r("task", "close", number)}`, who: "agent" };
    return STEP.close(r, "closed without a PR, its close not done (the actual)", number);
  }

  const open = questionItems(i.body ?? "").filter((x) => !x.answered).map((x) => x.k);
  const epicOpen = i.parent ? questionItems(i.parent.body ?? "").filter((x) => !x.answered).map((x) => x.k) : [];
  if (open.length || epicOpen.length) {
    const asked = [open.length ? `#${number}: ${open.join(", ")}` : "", epicOpen.length ? `epic #${i.parent.number}: ${epicOpen.join(", ")}` : ""].filter(Boolean).join("; ");
    return STEP.questions(r, `open questions — ${asked}`, open.length ? { number, k: open[0]! } : { number: i.parent.number, k: epicOpen[0]! }, auto);
  }

  const prs: NextPr[] = [...linked];
  for (const p of [...recent().prs, ...recent().batched]) if (!prs.some((x) => x.number === p.number)) prs.push({ ...p, sha: "", checks: null });
  const pr = prs.find((p) => p.state === "OPEN");
  const merged = lastMerged(prs);
  if (merged && !pr && !(here && unmergedBranch(io, number, merged.base, merged.head))) {
    if (!isBatchBranch(merged.base)) return afterMerge(merged, `PR #${merged.number} merged into ${merged.base}`);
    const release = releasePrOf(recent().recent, merged.base);
    const into = `PR #${merged.number} merged into ${merged.base}`;
    // the release merged without «Closes #N» of the task (#819) — task close finds it by the batch
    if (release?.merged) return reported ? STEP.close(r, `${into}, released by PR #${release.number}`, number) : STEP.refresh(`${into}, released by PR #${release.number}, the epic refresh hasn't reported`, finish);
    return STEP.release(`${into} — ${q(N.status.inProgress)} till the batch's release`, merged.base);
  }
  if (pr) {
    const shown = pr.sha ? pr : { ...pr, ...shownPr(graphql(io, Q.PrShow, { owner: slug.split("/")[0], name: slug.split("/")[1], number: pr.number })?.repository?.pullRequest ?? { number: pr.number }) };
    const into = `PR #${pr.number} into ${pr.base}`;
    const batch = isBatchBranch(pr.base);
    // a PR into a batch runs no CI (#676): its gate — the checks before a commit and pr premerge
    if (!batch) {
      const c = shown.checks;
      if (c?.red.length) return STEP.ciRed(`${into}: CI red — ${c.red.join(", ")}`, pr.number, finish);
      if (!c || c.pending.length) return STEP.ciWait(`${into}: ${c ? `CI running — ${c.pending.join(", ")}` : "no checks yet"}`, finish);
    }
    const ci = batch ? "no CI into a batch" : "CI green";
    if (premergePassed(io, slug, { number: pr.number, sha: shown.sha, base: pr.base }))
      return STEP.merge(`${into}: ${ci}, pr premerge passed on its head`, pr.number, auto, `${finish}${batch ? "" : " in the background — it waits for the deploy"}`);
    return STEP.premerge(r, `${into}: ${ci}, pr premerge not run on its head`, pr.number);
  }

  if (!here) {
    // the task's branches — local ones and GitHub's (not git ls-remote: task next runs outside a checkout too)
    const local = inRepo ? git(io, io.cwd, "for-each-ref", "--format=%(refname:short)", "refs/heads/").stdout.split("\n").map((l) => l.trim()) : [];
    const branches = [...new Set([...local.filter((b) => isTaskBranch(b, number)), ...originBranches(io, slug, number)])].sort();
    if (branches.length) return STEP.elsewhere(`in work on ${branches.join(", ")}, not in this checkout${inRepo ? ` (${current || "a detached HEAD"})` : ""}`, branches);
    return STEP.take(r, "open — no task branch or PR", number);
  }
  if (git(io, io.cwd, "status", "--porcelain", "--untracked-files=no").stdout.trim()) return STEP.commit(`branch ${current}: uncommitted changes`, finish);
  const base = finishBase({ ...io, out: () => {} }, slug, number, recent());
  git(io, io.cwd, "fetch", "-q", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`);
  const cherry = git(io, io.cwd, "cherry", `origin/${base}`, "HEAD");
  const commits = cherry.status === 0 ? cherry.stdout.split("\n").filter((l) => l.startsWith("+")).length : 0;
  if (commits) return STEP.finish(`branch ${current}: ${plural(commits, "commit", "commits")} past origin/${base}, no PR`, finish);
  return STEP.work(`branch ${current}: no commits past origin/${base} yet`, finish);
}

/**
 * `task next [<N>]` (#842): one entry instead of choosing among the commands by tables — the task's state in one line and
 * its one next step, a ready command; a step that waits for the owner or the dispatcher is named so. Code 0 — nothing for
 * the caller (no steps; the dispatcher's release), 1 — a step.
 */
export function cmdTaskNext(io: Io, slug: string, number: number): number {
  const s = taskNext(io, slug, number);
  io.out(`#${number} ${q(s.title)}: ${s.state}`);
  return endWith(io, s, s.who === "none" || s.who === "dispatcher" ? 0 : 1);
}

/** The step a task command ends with (#842): `task next`'s, printed as the command's last line. */
function nextOfTask(io: Io, slug: string, number: number): void {
  io.out(nextLine(taskNext(io, slug, number)));
}

// canon task types — a copy of EST_TYPES and BRANCH_CONV_RE from skills/est/scripts/est.ts (and in skills/task-env/scripts/task-env.ts):
// no shared module: github imports no other skill (tests/standards/scripts/skill-imports); the tests/standards/scripts/task-branch
// standard keeps the parsing identical
const TASK_TYPES = ["feat", "fix", "docs", "refactor", "perf", "test", "chore", "ci", "build", "research"];
const TASK_BRANCH_RE = new RegExp("^(?:[\\p{L}\\p{N}_.-]+/)?(" + TASK_TYPES.join("|") + ")/(\\d{1,6})-", "iu");

/** A task branch by the canon — `[<area>/]<type>/<N>-<slug>`: the type (lowercased) and the number, otherwise null. */
export function taskBranch(branch: string): { type: string; issue: number } | null {
  const m = TASK_BRANCH_RE.exec(branch);
  return m ? { type: m[1]!.toLowerCase(), issue: parseInt(m[2]!, 10) } : null;
}
const isTaskBranch = (branch: string, number: number) => taskBranch(branch)?.issue === number;
/** The slug of a branch `task status --branch` creates: Latin kebab-case after `<N>-` (AGENTS.md, "Git, PRs and merging"). */
const TASK_SLUG_RE = /\/\d{1,6}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Attempts to write the shared `.git/config` while another checkout's git holds its lock: 20 with 0.5 s between — ~10 s. */
const CONFIG_LOCK_TRIES = 20;
const CONFIG_LOCK_PAUSE_MS = 500;
const CONFIG_LOCKED = /could not lock config file (.+)$/m;
/**
 * An attempt doesn't wait inside git (#905): git 2.56 itself retries a locked config for `core.configLockTimeout`,
 * 1 s by default, before "could not lock config file" — 20 attempts would take ~30 s instead of ~10 (git 2.52 and Apple
 * Git 2.54 answer at once, an older git ignores the unknown key); the pauses between attempts are the only wait.
 */
const NO_CONFIG_LOCK_WAIT = ["-c", "core.configLockTimeout=0"];

/**
 * The worktree tool's branch (`claude/<slug>-<hash>`) becomes the task branch — `task status N "In progress" --branch`.
 * `git branch -m` renames the ref, then the branch's section in `.git/config` (upstream): the config is shared by all
 * worktrees of the repository, another checkout's git holds its lock — the ref is renamed, the section is not, code 128,
 * and a repeated `git branch -m` no longer finds the old name (#438). So the step that failed on the lock is repeated —
 * the whole rename or, once the ref is renamed, `git config --rename-section`; still locked — the command that finishes
 * it, the lock isn't removed: another process holds it. A branch already on origin (main, a pushed one) is renamed
 * together with its PR, by hand — left alone. Returns false when something is left undone.
 */
function renameBranch(io: Io, slug: string, target: string): boolean {
  const has = (ref: string) => git(io, io.cwd, "rev-parse", "--verify", "--quiet", ref).status === 0;
  if (!checkoutOfRepo(io, originUrl(io), slug)) return (io.out(`○ branch left alone: the current directory is not a checkout of ${slug}`), true);
  const current = git(io, io.cwd, "branch", "--show-current").stdout.trim();
  if (!current) {
    const base = git(io, io.cwd, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD").stdout.trim() || "origin/main";
    return (io.out(`○ branch left alone: HEAD is detached — a task branch from a fresh ${base}: git fetch origin && git switch -c ${target} ${base} --no-track`), true);
  }
  if (current === target) return (io.out(`= branch ${target}`), true);
  if (has(`refs/remotes/origin/${current}`)) return (io.out(`○ branch ${current} is already on origin — left alone: a pushed branch is renamed together with its PR, by hand`), true);
  let renamed = false;
  let lock = "";
  for (let k = 0; k < CONFIG_LOCK_TRIES; k++) {
    if (k) (io.sleep ?? pause)(CONFIG_LOCK_PAUSE_MS);
    const args = renamed ? ["config", "--rename-section", `branch.${current}`, `branch.${target}`] : ["branch", "-m", current, target];
    const r = git(io, io.cwd, ...NO_CONFIG_LOCK_WAIT, ...args);
    // a branch without a section (no upstream) — nothing to rename in the config; est reads the `+ branch` line as a
    // switch of the checkout's branch (gitBranchesIn in skills/est/scripts/est.ts) — the format is shared
    if (r.status === 0 || (renamed && /no such section/.test(r.stderr))) {
      return (io.out(`+ branch ${current} → ${target}${k ? ` (.git/config was locked: ${k} retries)` : ""}`), true);
    }
    const locked = CONFIG_LOCKED.exec(r.stderr);
    if (!locked) return (io.out(`! git ${args.join(" ")}: ${why(r)}`), false);
    lock = `${path.resolve(io.cwd ?? process.cwd(), locked[1]!.trim())}.lock`;
    renamed ||= !has(`refs/heads/${current}`) && has(`refs/heads/${target}`);
  }
  let age = "";
  try {
    age = ` (${Math.round((Date.now() - statSync(lock).mtimeMs) / 1000)} s)`;
  } catch {
    // released right after the last attempt — the command below finishes the rename anyway
  }
  const what = renamed ? `renamed to ${target}, its section in .git/config is not` : `${current} is not renamed`;
  const finish = renamed ? `git config --rename-section branch.${current} branch.${target}` : `git branch -m ${current} ${target}`;
  io.out(`! branch ${what}: ${lock} is held by another git process${age} — not removed; finish: ${finish}`);
  return false;
}

/**
 * The task's PRs that GitHub didn't link to it: among the latest open and merged PRs into the default branch — the
 * task's branch or "Closes #N" in the body (as `pr labels` does before the link appears). `why` — what it was found by.
 * `batched` — the same into a batch branch (#648): GitHub never links those, and they don't close the task — the
 * batch's release does.
 */
function unlinkedPrs(io: Io, slug: string, number: number): { base: string; prs: UnlinkedPr[]; batched: UnlinkedPr[]; recent: Recent } {
  const recent = recentPrs(io, slug);
  const { base, nodes } = recent;
  const prs: UnlinkedPr[] = [];
  const batched: UnlinkedPr[] = [];
  for (const p of nodes) {
    const into: string = p.baseRefName ?? "";
    if (into !== base && !isBatchBranch(into)) continue;
    const head: string = p.headRefName ?? "";
    const why = taskLinks(p).find((x) => x.number === number)?.why;
    if (why) (into === base ? prs : batched).push({ number: p.number, state: p.state ?? "", merged: Boolean(p.merged), head, base: into, why });
  }
  return { base, prs, batched, recent };
}

type UnlinkedPr = Issue["prs"][number] & { why: string };

/**
 * The est script next to the skill (`../est/scripts/est.ts`: the project copy, `~/.agents/skills` and the clone are
 * laid out this way).
 */
const estScript = (io: Io) => io.env["ELVES_EST"] ?? path.resolve(import.meta.dir, "../../est/scripts/est.ts");

/** The origin URL of the current directory's checkout; not a checkout or no origin — "". */
function originUrl(io: Io): string {
  const remote = git(io, io.cwd, "remote", "get-url", "origin");
  return remote.status === 0 ? remote.stdout : "";
}

/** The task-env script next to the skill — laid out like est (`../task-env/scripts/task-env.ts`). */
const taskEnvScript = (io: Io) => io.env["ELVES_TASK_ENV"] ?? path.resolve(import.meta.dir, "../../task-env/scripts/task-env.ts");

/**
 * The task's stacks (task-env, epic #392) live until someone takes them down — `task close` does: `task-env down <N>`
 * in the checkout takes the dev and e2e stacks down with their volumes and prints a line per stack (`+`, `○`, `!`) —
 * printed as is; it failed without a line — its error as a `!` line. A failure doesn't stop the close: a stack left
 * behind is found by `task-env prune`. Docker doesn't work in the Claude Code sandbox — task close is an unsandboxed
 * call (SKILL.md). A batch's task (#765) closes only with the release — its stack goes at the merge into the batch:
 * `task finish` of the executor, and the dispatcher's `task queue` as insurance (`quiet`: only `+` and `!` lines).
 */
function takeDownStacks(io: Io, number: number, quiet = false): void {
  const script = taskEnvScript(io);
  if (!existsSync(script)) return quiet ? undefined : io.out(`○ task stacks: task-env is not installed (${script})`);
  const r = (io.run ?? realRun)("bun", ["--no-env-file", script, "down", String(number)], io.cwd);
  // quiet — the queue's insurance (#765): a stack already down (`○`) is said nothing of, each queue would repeat it
  const lines = r.stdout.split("\n").filter((l) => l.trim() && !(quiet && l.startsWith("○")));
  for (const line of lines) io.out(line);
  if (r.status !== 0 && !lines.length) io.out(`! task-env down: ${why(r)}`);
}

/** est with arguments: its output without the marker is printed as is, a failure — its last error line as a `!` line. */
function runEst(io: Io, est: string, args: string[]): void {
  const r = (io.run ?? realRun)("bun", ["--no-env-file", est, ...args], io.cwd);
  for (const line of r.stdout.split("\n")) if (line.trim() && !line.startsWith("<!--")) io.out(line);
  if (r.status !== 0) io.out(`! est ${args[0]}: ${why(r)}`);
}

/**
 * The scripts' clone catches up with the merged main before the actual (#517): a dispatcher's executors call the
 * scripts of the machine's clone, and nothing updates the clone during a session — a later executor's actual was
 * computed by the est from before the fixes earlier executors had merged. Only for a task of the scripts' own
 * repository: another project's merge doesn't change the scripts. The clone is the checkout the est script is in (an
 * installed copy isn't a checkout — nothing to do, no line); it moves only fast-forward, on the default branch and
 * without uncommitted changes to tracked files — another branch or an edit is someone's work in progress. Untracked
 * files don't count: the clone holds the sessions' worktrees, and a fast-forward that would overwrite one refuses itself.
 */
function freshClone(io: Io, slug: string): void {
  const est = estScript(io);
  if (!existsSync(est)) return;
  const top = git(io, path.dirname(est), "rev-parse", "--show-toplevel");
  if (top.status !== 0) return;
  const dir = top.stdout.trim();
  const origin = git(io, dir, "remote", "get-url", "origin");
  if (origin.status !== 0 || !checkoutOfRepo(io, origin.stdout, slug)) return;
  const base = git(io, dir, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD").stdout.trim().replace(/^origin\//, "") || "main";
  const branch = git(io, dir, "branch", "--show-current").stdout.trim();
  const left = (reason: string) => io.out(`○ clone ${dir} left alone: ${reason} — the actual is by its code`);
  if (branch !== base) return left(branch ? `on branch ${branch}, not ${base}` : `HEAD is detached, not on ${base}`);
  const status = git(io, dir, "status", "--porcelain", "--untracked-files=no");
  if (status.status !== 0 || status.stdout.trim()) return left("uncommitted changes");
  const head = () => git(io, dir, "rev-parse", "--short", "HEAD").stdout.trim();
  const before = head();
  const pull = git(io, dir, "pull", "--ff-only", "--no-rebase", "--quiet", "origin", base);
  if (pull.status !== 0) return io.out(`! clone ${dir}: git pull --ff-only origin ${base}: ${why(pull)} — the actual is by its code`);
  const after = head();
  io.out(after === before ? `= clone ${dir} ${after}` : `+ clone ${dir} ${before} → ${after}`);
}

/** The actual — `task close`. */
function runFact(io: Io, slug: string, number: number): void {
  const est = estScript(io);
  if (!existsSync(est)) return io.out(`○ actual unavailable: est is not installed (${est}) — est fact ${number} --write after installing it`);
  runEst(io, est, ["fact", String(number), "--repo", slug, "--write"]);
}

/** GraphQL has no milestone mutation — REST. wasOpen — the task was open when read: the open count includes it. */
function closeMilestone(io: Io, slug: string, issue: Issue, wasOpen: boolean): void {
  const m = issue.milestone;
  if (!m) return;
  const open = m.open - (wasOpen ? 1 : 0);
  if (open > 0) return io.out(`○ milestone ${q(m.title)}: open tasks ${open}`);
  io.gh(["api", "-X", "PATCH", `repos/${slug}/milestones/${m.number}`, "-f", "state=closed"]);
  io.out(`+ milestone ${q(m.title)} closed: no open tasks left`);
}

/**
 * Merged branches go away (SKILL.md, "Git, PRs and merging — mechanics", the "Right after a PR merge" item): the branch
 * of each merged PR of the task — a task may have two, its PR and a follow-up fix to it (#473) — and the checkout's task
 * branch; the checkout moves off a removed branch to origin/<base> detached, the local and remote branches are deleted.
 * "Merged" — the PR is merged; a branch without a merged PR — `git cherry`: another merged PR of the task doesn't make
 * it merged. Not merged or someone else's — left alone. An agent's worktree on a merged branch — a dispatcher's
 * executor's (#899: `git branch -D` refuses a branch a worktree is on) — goes first with its branch, by the queue's rule
 * (`pruneAgentWorktrees`). That the directory is the repository's checkout, the caller checks.
 */
function cleanupBranches(io: Io, slug: string, number: number, prs: { head: string; base: string }[]): void {
  const current = git(io, io.cwd, "branch", "--show-current").stdout.trim();
  // a merged branch → the base it went into: each merged PR's head once
  const merged = new Map<string, string>();
  for (const p of prs) if (p.head && !merged.has(p.head)) merged.set(p.head, p.base || "main");
  const loose = current && !merged.has(current) && isTaskBranch(current, number) ? current : "";
  if (!merged.size && !loose) return io.out("○ the task branch not found — branches left alone");
  git(io, io.cwd, "fetch", "--prune", "origin");
  if (loose) {
    const base = prs[0]?.base || "main";
    const cherry = git(io, io.cwd, "cherry", `origin/${base}`, loose);
    if (cherry.status !== 0 || cherry.stdout.split("\n").some((l) => l.startsWith("+"))) io.out(`○ branch ${loose} is not merged into origin/${base} — left alone`);
    else merged.set(loose, base);
  }
  if (!merged.size) return;
  pruneAgentWorktrees(io, slug, { kept: () => false, closed: (n) => n === number, branches: new Set(merged.keys()) });
  for (const [branch, base] of merged) {
    if (current === branch) {
      const sw = git(io, io.cwd, "switch", "--detach", `origin/${base}`);
      if (sw.status !== 0) {
        io.out(`! git switch --detach origin/${base}: ${sw.stderr.trim()}`);
        continue;
      }
      io.out(`+ checkout — on origin/${base} (detached)`);
    }
    if (git(io, io.cwd, "branch", "--list", branch).stdout.trim()) {
      const d = git(io, io.cwd, "branch", "-D", branch);
      io.out(d.status === 0 ? `+ local branch ${branch} deleted` : `! git branch -D ${branch}: ${d.stderr.trim()}`);
    }
    if (git(io, io.cwd, "ls-remote", "--heads", "origin", branch).stdout.trim()) {
      const d = git(io, io.cwd, "push", "origin", "--delete", branch);
      io.out(d.status === 0 ? `+ remote branch ${branch} deleted` : `! git push origin --delete ${branch}: ${d.stderr.trim()}`);
    } else io.out(`○ remote branch ${branch} is already gone`);
  }
  const top = git(io, io.cwd, "rev-parse", "--show-toplevel").stdout.trim();
  const common = git(io, io.cwd, "rev-parse", "--git-common-dir").stdout.trim();
  if (!top || !common || path.resolve(io.cwd ?? process.cwd(), common) === path.join(top, ".git")) return;
  // an agent's worktree — an executor's: it can't remove the worktree it works in, the dispatcher's queue does (#515)
  if (AGENT_WORKTREE.test(top)) io.out(`○ agent worktree ${top}: the dispatcher's next task queue removes it`);
  else io.out(`Next: remove worktree ${top} from the main checkout: git worktree remove ${top}`);
}

// ----------------------------------------------------------------------------
// Decision labels by PR
// ----------------------------------------------------------------------------

/** The labels the task doesn't have — in one mutation; returns them comma-separated (nothing to add — empty). */
function addLabels(io: Io, issue: Pick<Issue, "id" | "labels">, names: string[], all: Label[]): string {
  const missing = names.filter((n) => !issue.labels.includes(n));
  if (!missing.length) return "";
  mutate(io, { op: "AddLabels", input: { labelableId: issue.id, labelIds: missing.map((n) => all.find((l) => l.name === n)!.id) } });
  issue.labels.push(...missing);
  return missing.join(", ");
}

/** A changed PR file (`PullRequestChangedFile`): the kind of change and the line counts. */
export interface PrFile {
  path: string;
  changeType: string;
  additions: number;
  deletions: number;
}

/**
 * Which decision folder's exceptions file is it? A copy of the spec skill's `exceptionFile` rule (`speclib.ts`):
 * github imports no other skill (tests/standards/scripts/skill-imports) and works without spec; the
 * `tests/standards/scripts/exception-files` standard checks both copies against one table. The `exceptions/` directory of a
 * `tests/<kind>/<name>` folder, a `.json` file — the folder's exception, in `exceptions/<section>/` — the topic
 * section's; another file in the directory, a deeper directory and a directory in a subfolder — an error; outside
 * decision folders and hidden ones — null.
 */
export function exceptionFile(p: string): { folder: string; dir: string; section?: string; error?: string } | null {
  const parts = p.split("/");
  if (parts[0] !== "tests" || parts.length < 4 || !DECISION_KINDS.some((k) => DECISIONS[k].dir === parts[1])) return null;
  const folder = parts.slice(0, 3).join("/");
  const inner = parts.slice(3);
  if (inner.some((s) => s.startsWith("."))) return null;
  const at = inner.findIndex((s, i) => i < inner.length - 1 && s === "exceptions");
  if (at < 0) return null;
  const dir = "exceptions";
  if (at > 0) return { folder, dir, error: "the exceptions directory is in a subfolder" };
  const section = inner.length === 3 ? { dir: `${dir}/${inner[1]}`, section: inner[1]! } : { dir };
  if (inner.length > 3 || !p.endsWith(".json")) return { folder, ...section, error: "an exception is not a .json file" };
  return { folder, ...section };
}

/**
 * A mechanical edit doesn't change a decision: the file is deleted, renamed without content changes, or it's an
 * exceptions file of a decision folder that spec reads as an exception (`exceptionFile` without an error): a file in
 * `exceptions/` (the exceptions ratchet). It gives no decision label — otherwise with mass
 * edits a task gets labels of decisions it didn't change.
 */
function mechanical(f: PrFile): boolean {
  if (f.changeType === "DELETED") return true;
  if (f.changeType === "RENAMED" && f.additions === 0 && f.deletions === 0) return true;
  const x = exceptionFile(f.path);
  return !!x && !x.error;
}

/**
 * Decisions the diff touches: a spec tree folder is the decision itself, a code file — the model module with the
 * longest matching directory (a nested module is more precise than the enclosing one). `tests/lib` and files outside
 * modules aren't decisions. `changed` — decision name → its kinds in the diff, at least one of the decision's files
 * edited in content; `mechanical` — decisions touched only by a mechanical edit. Names in alphabetical order.
 */
export function decisionsOfFiles(files: PrFile[], modules: Record<string, string[]>): { changed: Map<string, DecisionKind[]>; mechanical: string[] } {
  const out = new Map<string, { kinds: Set<DecisionKind>; changed: boolean }>();
  const add = (name: string, kind: DecisionKind, f: PrFile) => {
    const d = out.get(name) ?? { kinds: new Set(), changed: false };
    d.kinds.add(kind);
    d.changed ||= !mechanical(f);
    out.set(name, d);
  };
  const byDir = Object.fromEntries(DECISION_KINDS.map((k) => [DECISIONS[k].dir, k])) as Record<string, DecisionKind>;
  for (const f of files) {
    const parts = f.path.split("/");
    if (parts[0] === "tests") {
      const kind = byDir[parts[1] ?? ""];
      if (kind && parts.length > 3) add(parts[2]!, kind, f);
      continue;
    }
    let best: [string, number] | null = null;
    for (const [m, dirs] of Object.entries(modules)) {
      for (const d of dirs) if ((f.path === d || f.path.startsWith(d + "/")) && (!best || d.length > best[1])) best = [m, d.length];
    }
    if (best) add(best[0], "architecture", f);
  }
  const names = [...out.keys()].sort();
  return {
    changed: new Map(names.filter((n) => out.get(n)!.changed).map((n) => [n, DECISION_KINDS.filter((k) => out.get(n)!.kinds.has(k))])),
    mechanical: names.filter((n) => !out.get(n)!.changed),
  };
}

/**
 * Decisions whose statements the PR changes — who gets a label when not all of them fit on an issue (#569): a codemod
 * over every test (a test runner change) rewrites the bodies and changes no statement, and a decision label means "the
 * task changes the decision". A statement is a `.md` at the topic folder's root (`<topic>.md`, a section's `<section>.md`) edited in content, or the folder named in
 * the spec section of the PR body (spec-diff output): a list line or a summary row starting with the folder — removed,
 * changed and added tests, the move into the tree, harness checks, scenarios that became tests. Exceptions aren't
 * statements (`mechanical`): their blocks are skipped. The section heading and block titles — in any dictionary
 * language: the body is in the project's language, and the script may run from another project with --repo.
 */
function statementDecisions(files: PrFile[], body: string): Set<string> {
  const dirs = new Set<string>(DECISION_KINDS.map((k) => DECISIONS[k].dir));
  const out = new Set<string>();
  for (const f of files) {
    // the topic's `<topic>.md` and a section's `<section>.md` — the topic's statements (#688)
    const [root, dir, name, file, ...rest] = f.path.split("/");
    if (root === "tests" && dirs.has(dir!) && file?.endsWith(".md") && !rest.length && !mechanical(f)) out.add(name!);
  }
  const heads = locale.every((n) => n.prSpecSection);
  const exceptions = locale.every((n) => n.spec.diff.exceptionsTitle).map((t) => `**${t}`);
  let inSection = false;
  let skip = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (heads.includes(line)) [inSection, skip] = [true, false];
    else if (/^##\s/.test(line)) inSection = false;
    else if (!inSection) continue;
    else if (/^#{3,}\s/.test(line)) skip = false;
    else if (line.startsWith("**")) skip = exceptions.some((t) => line.startsWith(t));
    else if (!skip) {
      const m = /^(?:[-*]\s+(?:✅\s+)?|\|\s*)`tests\/([^`/]+)\/([^`/]+)[^`]*`/.exec(line);
      if (m && dirs.has(m[1]!)) out.add(m[2]!);
    }
  }
  return out;
}

/**
 * The decision labels an issue doesn't have, as many as fit (`ISSUE_LABEL_LIMIT`): all of them fit — all; otherwise only
 * the decisions whose statements the PR changes (`statementDecisions`), in alphabetical order, as many as there's room
 * for; no PR yet (`task new --epic`, `statements` null) — any of them, alphabetically (#574). What isn't set — `○` lines:
 * a mutation past the limit would fail and leave the issue without a single label. Returns the lines to print.
 */
function putLabels(io: Io, issue: Issue, who: string, want: string[], statements: Set<string> | null, all: Label[]): string[] {
  const { add, lines } = labelsToAdd(issue, who, want, statements);
  const added = addLabels(io, issue, add, all);
  if (added) lines.push(`+ ${who}: ${added}`);
  return lines;
}

/**
 * What `putLabels` would set on the issue — the decision labels it lacks, as many as fit — and its `○` lines: `pr
 * premerge` refuses while it isn't empty (#733), a label past GitHub's limit doesn't hold the merge.
 */
function labelsToAdd(issue: Pick<Issue, "labels">, who: string, want: string[], statements: Set<string> | null): { add: string[]; lines: string[] } {
  const lines: string[] = [];
  const missing = want.filter((n) => !issue.labels.includes(n));
  const room = Math.max(0, ISSUE_LABEL_LIMIT - issue.labels.length);
  let add = missing;
  if (missing.length > room) {
    const named = statements ? missing.filter((n) => statements.has(n)) : [...missing].sort();
    const bodies = statements ? missing.filter((n) => !statements.has(n)) : [];
    add = named.slice(0, room);
    const which = statements ? "only decisions whose <topic>.md, <section>.md or test names the PR changes" : "alphabetically, as many as fit";
    const without = bodies.length ? `; test bodies and code only, no label: ${bodies.join(", ")}` : "";
    lines.push(`○ ${who}: ${missing.length} new decision labels, room for ${room} (GitHub puts at most ${ISSUE_LABEL_LIMIT} on an issue, it has ${issue.labels.length}) — ${which}${without}`);
    if (named.length > room) lines.push(`○ ${who}: no room — not set: ${named.slice(room).join(", ")}`);
  }
  return { add, lines };
}

/**
 * Tasks the PR closes, by its body — as GitHub understands them: a keyword (close, fix, resolve in any form) before
 * each `#N`; "Closes #1, #2" closes only #1.
 */
function closingInBody(body: string): number[] {
  const out: number[] = [];
  for (const m of body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+#(\d+)\b/gi)) if (!out.includes(Number(m[1]))) out.push(Number(m[1]));
  return out;
}

/** The PR and all its changed files (`PrChange`, page by page), the default branch (`base`): `pr labels` and the epic refresh's assignment. */
function loadPrChange(io: Io, slug: string, number: number): { head: Any; files: PrFile[]; base: string } {
  const [owner, name] = slug.split("/") as [string, string];
  let head: Any = null;
  let base = "main";
  const files = pages<PrFile>((after) => {
    const repo = graphql(io, Q.PrChange, { owner, name, number, after })?.repository;
    const pr = repo?.pullRequest;
    if (!pr) throw new GhError(`no PR #${number} in ${slug}`);
    head ??= pr;
    base = repo.defaultBranchRef?.name ?? base;
    return pr.files;
  });
  return { head, files, base };
}

/**
 * The model's modules at a revision (`Q.ModelAt`) — what a code file's decision is (`decisionsOfFiles`); no model — none,
 * a model that doesn't load — none and a warning.
 */
function modulesAt(io: Io, slug: string, rev: string, what: string): Record<string, string[]> {
  const [owner, name] = slug.split("/") as [string, string];
  const model = graphql(io, Q.ModelAt, { owner, name, expression: `${rev}:${MODEL_PATH}` })?.repository?.object;
  if (!model) return {};
  const m = modelModules(model.text ?? "");
  if (typeof m !== "string") return m;
  io.err(`warning: model ${MODEL_PATH} of ${what} doesn't load — modules not counted: ${m}`);
  return {};
}

/** Decision labels from the PR's diff for its tasks and their epics (`prLabelPlan`, `applyPrLabels`). */
export function cmdPrLabels(io: Io, slug: string, number: number): number {
  const plan = prLabelPlan(io, slug, number);
  if ("release" in plan) {
    io.out(
      `○ PR #${number} is the release of the batch ${plan.release}: its tasks got their decision labels from their PRs into the batch — ` +
        `the release's diff would give each task the whole batch's, and a red release names its guilty task by them: no labels`,
    );
    return 0;
  }
  const { closes, want } = plan;
  if (!closes.length) throw new GhError(`PR #${number} has no «Closes #N» and no task branch — nowhere to put the labels`);
  io.out(`PR #${number} → ${closes.map((n) => `#${n}`).join(", ")}: ${want.join(", ") || "no decisions in the diff"}`);
  for (const l of plan.skipped) io.out(`○ ${l} — only a mechanical edit (a deletion, a rename without changes, exceptions): no label`);
  for (const x of plan.dimensions) io.out(`○ ${x.name} — label ${q(x.name)} is slice ${q(x.dim)}, not a decision label: not set`);
  for (const l of applyPrLabels(io, slug, plan, true)) io.out(l);
  return 0;
}

/** A PR's decision labels (`prLabelPlan`): its tasks, the decisions its diff changes, the repository's labels. */
interface LabelPlan {
  closes: number[];
  want: string[];
  decided: Map<string, DecisionKind[]>;
  skipped: string[];
  dimensions: { name: string; dim: string }[];
  all: Label[];
  statements: Set<string>;
}

/**
 * What `pr labels` puts and where — one rule for it, `pr premerge` (#733: a PR doesn't merge without its labels) and
 * `batch release` (it sets the missing ones). The tasks — GitHub's link; right after the PR is created there is none
 * yet — the PR's tasks by the one rule (`taskLinks`: the task branch, «Closes #N» of the body): a fix PR into a batch
 * branch has «Refs #N» (#650). A batch's release PR — its batch (#650): its tasks got theirs from their PRs into the
 * batch, the release's diff would give each task the whole batch's — and a red release names its guilty task by them.
 */
function prLabelPlan(io: Io, slug: string, number: number, change = loadPrChange(io, slug, number)): LabelPlan | { release: string } {
  const { head, files, base } = change;
  if (isBatchBranch(head.headRefName ?? "") && releaseOf([head], head.headRefName, base)) return { release: head.headRefName };
  let closes: number[] = (head.closingIssuesReferences?.nodes ?? []).map((x: Any) => x.number);
  if (!closes.length) closes = prTasks(head);
  // modules come from the PR head: the PR may add a module or move its directory
  const modules = modulesAt(io, slug, head.headRefOid, "the PR head");
  const { changed: decided, mechanical: skipped } = decisionsOfFiles(files, modules);
  const all = decided.size ? loadLabels(io, slug) : [];
  // a slice label with a decision's name is a different slice of tasks: it isn't set as a decision label
  const dimensions = all.flatMap((l) => {
    const dim = decided.has(l.name) ? labelDimension(l.description) : null;
    return dim ? [{ name: l.name, dim }] : [];
  });
  const want = [...decided.keys()].filter((n) => !dimensions.some((x) => x.name === n));
  return { closes, want, decided, skipped, dimensions, all, statements: statementDecisions(files, head.body ?? "") };
}

/**
 * The PR's decision labels on its tasks and their epics (`prLabelPlan`): a label the repository lacks is created first.
 * Returns the lines to print — `verbose` (`pr labels`) adds the labels that stay; `batch release` — only what it sets.
 */
function applyPrLabels(io: Io, slug: string, plan: LabelPlan, verbose: boolean): string[] {
  const { closes, want, all, statements } = plan;
  if (!want.length) return [];
  const lines: string[] = [];
  const fresh = want.filter((l) => !all.some((x) => x.name === l));
  const repoId = fresh.length ? loadRepo(io, slug).id : "";
  for (const l of fresh) {
    const label = decisionLabel(l, plan.decided.get(l)!);
    const created = mutate(io, { op: "CreateLabel", input: { repositoryId: repoId, ...label } }).createLabel.label;
    all.push({ id: created.id, ...label, open: { total: 0, numbers: [] } });
    lines.push(`+ created label ${q(l)}`);
  }
  const isDecision = (n: string) => labelKinds(all.find((x) => x.name === n)?.description) !== null;
  const epics = new Map<number, Issue>();
  for (const n of closes) {
    const issue = loadIssue(io, slug, n);
    lines.push(...putLabels(io, issue, `#${n}`, want, statements, all));
    // earlier labels aren't removed: the task may have touched the decision in another PR too
    if (verbose) for (const l of issue.labels.filter((x) => isDecision(x) && !want.includes(x))) lines.push(`= #${n}: ${l} — the decision is not in the PR diff, the label stays`);
    if (issue.parent && !epics.has(issue.parent.number)) epics.set(issue.parent.number, loadIssue(io, slug, issue.parent.number));
  }
  for (const epic of epics.values()) lines.push(...putLabels(io, epic, `epic #${epic.number}`, want, statements, all));
  return lines;
}

/**
 * The decision labels the PR's tasks and their epics lack (#733): `<who>: <labels>` each, none — empty. In batch
 * 2026-10-26-1 four executors merged their PRs into the batch without `pr labels`, the dispatcher found it after the
 * release — `pr premerge` refuses such a merge, on every path to it: by hand and through `task finish`. `change` —
 * the PR's files already read (premerge reads them once: the GraphQL quota is shared by all sessions).
 */
function missingPrLabels(io: Io, slug: string, number: number, change = loadPrChange(io, slug, number)): string[] {
  const plan = prLabelPlan(io, slug, number, change);
  if ("release" in plan || !plan.closes.length || !plan.want.length) return [];
  const out: string[] = [];
  const epics = new Set<number>();
  const check = (issue: Issue, who: string) => {
    const { add } = labelsToAdd(issue, who, plan.want, plan.statements);
    if (add.length) out.push(`${who}: ${add.join(", ")}`);
  };
  for (const n of plan.closes) {
    const issue = loadIssue(io, slug, n);
    check(issue, `#${n}`);
    if (issue.parent && !epics.has(issue.parent.number)) {
      epics.add(issue.parent.number);
      check(loadIssue(io, slug, issue.parent.number), `epic #${issue.parent.number}`);
    }
  }
  return out;
}

// ----------------------------------------------------------------------------
// Checking the merge before merging
// ----------------------------------------------------------------------------

/**
 * The project's fast checks — these `package.json` scripts, those that exist, in CI order: types (a semantic conflict
 * of two PRs, seconds), then standards and architecture — minutes, not the whole `test`.
 */
export const PREMERGE_SCRIPTS = ["typecheck", "test:spec"];
/**
 * The PR's task for task-env in the temporary worktree (#759) — a copy of `TASK_VAR` and `FAILED_VAR` of the task-env
 * script: the github skill imports no other skill (tests/standards/scripts/skill-imports). `ELVES_TASK` — the number of the
 * PR's branch: `up` on a detached HEAD takes that task's stack; `ELVES_TASK_ENV_FAILED` — the file a stack that didn't
 * come up appends its reason to.
 */
const STACK_TASK_VAR = "ELVES_TASK";
const STACK_FAILED_VAR = "ELVES_TASK_ENV_FAILED";
/**
 * Spec roots whose checks `test:spec` runs — standards and architecture (the spec skill): there two green PRs break
 * main. A tree with them and without the script — premerge names what isn't checked on the merge, the project's
 * `check` (bin/elves.ts) requires the script (#442).
 */
export const SPEC_ROOTS = ["tests/standards", "tests/architecture"];
/** The spec roots the tree in dir has. */
export const specRoots = (dir: string) => SPEC_ROOTS.filter((d) => statSync(path.join(dir, d), { throwIfNoEntry: false })?.isDirectory());
/**
 * GitHub builds the merge-ref before the event that creates the check suite: main moving within this minute counts as
 * having moved.
 */
const MERGE_REF_SLACK_MS = 60_000;
const INSTALL: Record<PackageManager["name"], string[]> = { bun: ["bun", "install", "--frozen-lockfile"], pnpm: ["pnpm", "install", "--frozen-lockfile"], yarn: ["yarn", "install", "--frozen-lockfile"], npm: ["npm", "ci"] };
/**
 * Failure lines: a test — bun `(fail)`, Vitest `FAIL` and `×`, Jest `●`, Playwright `✘`; a compiler error —
 * `error TS2304:`.
 */
const FAILED_LINE = /^\s*(\(fail\)|FAIL\s|×|✗|✘|●\s)|\berror TS\d+:/;
/**
 * A `bun check` error under an agent (`CLAUDECODE=1`) — a block `<error file="a.ts" line="3" column="5" code="TS2304">`
 * with the text on the next line; it is brought to a tsc line without a TTY, `a.ts(3,5): error TS2304: …`.
 */
const BUN_CHECK_ERROR = /<error file="([^"]+)" line="(\d+)" column="(\d+)" code="(TS\d+)">\n([^\n]*)/g;
const asTsc = (out: string) => out.replace(BUN_CHECK_ERROR, "$1($2,$3): error $4: $5");

/** The project's package manager: its command, Yarn 2+ and the lockfile dependencies are installed from. */
export interface PackageManager {
  name: "bun" | "pnpm" | "yarn" | "npm";
  /** Yarn 2+: package.json scripts run in its own shell (`@yarnpkg/shell`) — without `.`, `eval` and `export`. */
  berry: boolean;
  /** The manager's own lockfile, otherwise the first one in order; none — null. */
  lockfile: string | null;
  /** The version `packageManager` declares (`bun@1.4.3` — `1.4.3`); no field or no version — null. */
  version: string | null;
}

/**
 * The project's package manager in dir — the one answer of the flow: `pr premerge` (`projectCommands`), the slot
 * wrapper and the `test:spec` runner of the project's `check` (bin/elves.ts) take it here,
 * `tests/standards/scripts/package-manager`. The manager — `packageManager` in package.json, otherwise the lockfile in the
 * order below, otherwise `.yarnrc.yml` — Yarn, otherwise npm. Yarn 2+ — `yarn@2+` in `packageManager`, Yarn by the
 * files — with `.yarnrc.yml`: `packageManager` decides the version too.
 */
export function packageManager(dir: string): PackageManager {
  const lockfiles = [["bun.lock", "bun"], ["bun.lockb", "bun"], ["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["package-lock.json", "npm"]] as const;
  const has = (file: string) => existsSync(path.join(dir, file));
  let field = "";
  try {
    field = String(JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"))?.packageManager ?? "");
  } catch {
    // no package.json or not JSON — no field
  }
  const declared = /^(bun|pnpm|yarn|npm)@((\d*)(?:\.\d+)*)/.exec(field);
  const found = lockfiles.filter(([file]) => has(file));
  const yarnrc = has(".yarnrc.yml");
  const name = (declared?.[1] as PackageManager["name"] | undefined) ?? found[0]?.[1] ?? (yarnrc ? "yarn" : "npm");
  const berry = name === "yarn" && (declared ? Number(declared[3]) >= 2 : yarnrc);
  return { name, berry, lockfile: (found.find(([, pm]) => pm === name) ?? found[0])?.[0] ?? null, version: declared?.[2] || null };
}

/**
 * The project's commands in a directory: the package manager — `packageManager`; dependencies are installed from the
 * lockfile without changing it, no lockfile — no install.
 */
export function projectCommands(dir: string): { install: string[] | null; run: (script: string) => string[] } {
  const pm = packageManager(dir);
  return { install: pm.lockfile ? INSTALL[pm.name] : null, run: (script) => [pm.name, "run", script] };
}

/**
 * A temporary worktree of the checkout at a revision (tests/standards/scripts/temp-worktree): a directory in the temp folder,
 * `git worktree add --detach`, `work` in it, and the removal always — an error inside too: `worktree remove --force`,
 * the directory, `worktree prune`. The flow's scripts add a worktree only here: a copy that forgot the `finally` or the
 * `prune` left a worktree registered in the user's checkout. Not added — a GhError with git's reason.
 */
export function inTempWorktree<T>(io: Io, prefix: string, rev: string, work: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(os.tmpdir(), `elves-${prefix}-`));
  try {
    const add = git(io, io.cwd, "worktree", "add", "-q", "--detach", dir, rev);
    if (add.status !== 0) throw new GhError(`git worktree add: ${why(add)}`);
    return work(dir);
  } finally {
    git(io, io.cwd, "worktree", "remove", "--force", dir);
    rmSync(dir, { recursive: true, force: true });
    git(io, io.cwd, "worktree", "prune");
  }
}

/** The tree's package.json scripts; no package.json — none. */
function scriptsOf(dir: string): Record<string, unknown> {
  const pkg = path.join(dir, "package.json");
  return existsSync(pkg) ? (JSON.parse(readFileSync(pkg, "utf8")).scripts ?? {}) : {};
}

/** A red script of a tree's check: its name, the command line and the result. */
interface TreeRed {
  script: string;
  cmd: string;
  result: RunResult;
}

/**
 * A tree's check — `pr premerge` on the merge and on bare origin/<base>, the bisect of a red release at a boundary:
 * dependencies by its lockfile (`projectCommands`), then the steps — a project script with its arguments (the test
 * files; npm — after `--`) — in order, up to the first red one, `env` — on top of the process's. `install` — its command
 * and result, no lockfile — null; failed — no step ran.
 */
function checkTree(io: Io, dir: string, steps: { script: string; args?: string[] }[], env?: Record<string, string>): { install: { cmd: string; result: RunResult } | null; ran: string[]; red: TreeRed | null } {
  const run = io.run ?? realRun;
  const cmds = projectCommands(dir);
  const install = cmds.install ? { cmd: cmds.install.join(" "), result: run(cmds.install[0]!, cmds.install.slice(1), dir) } : null;
  const ran: string[] = [];
  if (install && install.result.status !== 0) return { install, ran, red: null };
  for (const s of steps) {
    const args = s.args ?? [];
    const argv = [...cmds.run(s.script), ...(args.length && packageManager(dir).name === "npm" ? ["--"] : []), ...args];
    const result = env ? run(argv[0]!, argv.slice(1), dir, env) : run(argv[0]!, argv.slice(1), dir);
    ran.push(s.script);
    if (result.status !== 0) return { install, ran, red: { script: s.script, cmd: argv.join(" "), result } };
  }
  return { install, ran, red: null };
}

const tail = (r: RunResult, n = 20) => `${r.stdout}\n${r.stderr}`.split("\n").filter((l) => l.trim()).slice(-n);
/**
 * A failure line without the run time (bun `[1.2ms]`, Vitest `12ms`) and the compiler error position (`a.ts(3,5):` —
 * tsc without a TTY; a PR edit higher up in the file shifts it) — one failure on the merge and on main.
 */
const failure = (l: string) => l.trim().replace(/\s*\[[\d.]+\s*m?s\]$/, "").replace(/\s+[\d.]+\s*m?s$/, "").replace(/^(\S+?)\(\d+,\d+\)(?=:)/, "$1");

/**
 * Waiting for the bug to close — the ci-wait script next to it (`../ci-wait`: the project copy, `~/.agents/skills` and
 * the clone are laid out this way). A function, not a value at load: `import.meta.dir` is Bun's, and a project's test
 * loads this module from the package under Node and Vitest too (`exports` of the Elves package.json).
 */
const waitCi = () => path.resolve(import.meta.dir, "../../ci-wait/scripts/wait-ci.sh");
// a red check outcome: cancelled (a rerun, a new commit) and waiting for a human's decision aren't red
const RED_RUN = new Set(["failure", "timed_out", "startup_failure"]);
const RED_STATUS = new Set(["failure", "error"]);

/**
 * The spec publish job (the `spec` skill, `ci.md`; `<job> / spec-publish` — the same job in a reusable workflow) —
 * publishing the documentation, not a check of the branch: its red isn't a red main (#443). A copy — in ci-wait's
 * `wait-ci.sh` (`SPEC_PUBLISH`): both answer by one table, `tests/standards/scripts/spec-publish-job`.
 */
export const SPEC_PUBLISH = /^(?:.+ \/ )?spec-publish$/;

/**
 * Red checks of the default branch's last commit — check-runs (the last run of each name) and hosting statuses;
 * `publish` — the red spec publish jobs, apart; `steps` — the failed step of a red GitHub Actions job by its name
 * (#699: a step without a test — install, network — names the bug by the check and the step).
 * The base's checks are its own runs (#732): a check-run whose check suite is a run of another branch on the same SHA
 * (a batch branch pushed at the tip of main) isn't the base's — `foreign`, with the branch; a suite without
 * `head_branch` counts as the base's. A red run that started after every cancelled run of its suite had finished —
 * an aggregate (`ci-ok` with `if: always()`) of a superseded run — isn't red either: `aggregates`; a job that failed
 * while its siblings were cancelled (fail-fast) started before them and stays red. `runs` — the red check-run of each
 * red name that is one (the rest are statuses): whether the PR fixes it reads its app and check suite (`prFixes`).
 */
function redChecksOf(
  io: Io,
  slug: string,
  base: string,
): { sha: string; names: string[]; publish: string[]; steps: Map<string, string>; foreign: { name: string; branch: string }[]; aggregates: string[]; runs: Map<string, Any> } {
  const ref = encodeURIComponent(base);
  const status = restCall(io, ["api", `repos/${slug}/commits/${ref}/status`]);
  const sha = String(status.sha ?? "");
  const branchOf = new Map<number, string>();
  if (sha) {
    try {
      for (const x of restCall(io, ["api", `repos/${slug}/commits/${sha}/check-suites?per_page=100`]).check_suites ?? []) if (x.head_branch) branchOf.set(x.id, x.head_branch);
    } catch (e) {
      if (!(e instanceof GhError)) throw e;
    }
  }
  const latest = new Map<string, Any>();
  const others = new Map<string, Any>();
  for (const r of restCall(io, ["api", `repos/${slug}/commits/${ref}/check-runs?per_page=100`]).check_runs ?? []) {
    const branch = branchOf.get(r.check_suite?.id);
    const into = branch && branch !== base ? others : latest;
    if (!into.has(r.name) || into.get(r.name).id < r.id) into.set(r.name, r);
  }
  const isRed = (r: Any) => r.status === "completed" && RED_RUN.has(r.conclusion);
  const foreign = [...others.values()]
    .filter((r) => isRed(r) && !latest.has(r.name) && !SPEC_PUBLISH.test(r.name))
    .map((r) => ({ name: r.name as string, branch: branchOf.get(r.check_suite.id)! }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const cancelledIn = (suite: unknown) => [...latest.values()].filter((c) => c.check_suite?.id === suite && c.status === "completed" && c.conclusion === "cancelled");
  const aggregate = (r: Any) => {
    const cancelled = r.check_suite?.id === undefined ? [] : cancelledIn(r.check_suite.id);
    return !!r.started_at && cancelled.length > 0 && cancelled.every((c) => c.completed_at && Date.parse(c.completed_at) <= Date.parse(r.started_at));
  };
  const reds = [...latest.values()].filter(isRed);
  const aggregates = reds.filter((r) => !SPEC_PUBLISH.test(r.name) && aggregate(r)).map((r) => r.name as string).sort();
  const names = [
    ...reds.filter((r) => !aggregates.includes(r.name)).map((r) => r.name as string),
    ...(status.statuses ?? []).filter((x: Any) => RED_STATUS.has(x.state)).map((x: Any) => x.context as string),
  ];
  const red = [...new Set(names)].sort();
  const steps = new Map<string, string>();
  for (const r of reds) {
    if (aggregates.includes(r.name) || SPEC_PUBLISH.test(r.name) || r.app?.id !== ACTIONS_APP) continue;
    const step = failedStepOf(io, slug, r.id);
    if (step) steps.set(r.name, step);
  }
  const runs = new Map(reds.filter((r) => !aggregates.includes(r.name)).map((r) => [r.name as string, r]));
  return { sha, names: red.filter((n) => !SPEC_PUBLISH.test(n)), publish: red.filter((n) => SPEC_PUBLISH.test(n)), steps, foreign, aggregates, runs };
}

/**
 * A file taken by a workflow's `paths` (#893) — GitHub's filter pattern cheat sheet, as `prRun` of the installer reads
 * branches: in order, `!` at the start drops what the patterns before it took, a later positive one takes it back; `*`
 * — anything but `/`, `**` — anything; `?`, `+` and `[…]` — as in a regex. A pattern that isn't a regex takes nothing.
 */
function pathsTake(patterns: string[], file: string): boolean {
  let taken = false;
  for (const p of patterns) {
    const negated = p.startsWith("!");
    let re: RegExp;
    try {
      re = new RegExp(`^${(negated ? p.slice(1) : p).replace(/[.^$(){}|\\]/g, "\\$&").replace(/\*\*?/g, (m) => (m === "**" ? ".*" : "[^/]*"))}$`);
    } catch {
      continue;
    }
    if (re.test(file)) taken = !negated;
  }
  return taken;
}

/** The `paths` of a workflow's `push` and `pull_request` (`on:` of its YAML), together; neither has them — null. */
function workflowPaths(on: unknown): string[] | null {
  if (!on || typeof on !== "object" || Array.isArray(on)) return null;
  let out: string[] | null = null;
  for (const event of ["push", "pull_request"]) {
    const filter = (on as Record<string, unknown>)[event];
    if (!filter || typeof filter !== "object" || Array.isArray(filter) || !Object.hasOwn(filter, "paths")) continue;
    out = [...(out ?? []), ...[(filter as Record<string, unknown>)["paths"]].flat().filter((x): x is string => typeof x === "string")];
  }
  return out;
}

/**
 * The red checks of the base's last commit (`sha`) the PR fixes itself (#893): a check green on its head — fixed; a
 * check not on the head or skipped there (a scheduled job, a job for the default branch only) — by the `paths` of its
 * workflow's `push` and `pull_request` (question 1 of #893): the PR changes a file they take — fixed. Red, running or
 * cancelled on the head — not fixed, no line. Not decided — a GitHub Actions check-run whose workflow has no `paths`
 * or isn't read, another app's check, a host status not on the head — a line in `notes`: it stays red. The workflow —
 * its run by the check suite (REST), its file at `sha`. `fixed` — name → how.
 */
function prFixes(io: Io, slug: string, number: number, head: string, files: string[], sha: string, base: string, names: string[], runs: Map<string, Any>): { fixed: Map<string, string>; notes: string[] } {
  const fixed = new Map<string, string>();
  const notes: string[] = [];
  const at = `the head of PR #${number} (${head.slice(0, 7)})`;
  const green = (name: string) => `${name} is green on the head of PR #${number} (${head.slice(0, 7)})`;
  const undecided =(name: string, why: string) => notes.push(`○ ${name} doesn't run on PR #${number}, and ${why} — whether the PR fixes it isn't decided: counted as red ${base}`);
  const read = <T,>(f: () => T): T | string => {
    try {
      return f();
    } catch (e) {
      if (!(e instanceof GhError)) throw e;
      return e.message;
    }
  };
  const onHead = read(() => {
    const latest = new Map<string, Any>();
    for (const r of restCall(io, ["api", `repos/${slug}/commits/${head}/check-runs?per_page=100`]).check_runs ?? []) if (!latest.has(r.name) || latest.get(r.name).id < r.id) latest.set(r.name, r);
    return latest;
  });
  if (typeof onHead === "string") {
    notes.push(`○ checks of ${at} not read (${onHead}) — whether the PR fixes red ${base} is unknown`);
    return { fixed, notes };
  }
  let statuses: Map<string, string> | string | null = null;
  const workflows = new Map<number, { path: string; paths: string[] | null } | string>();
  const workflowOf = (suite: number) => {
    if (!workflows.has(suite)) {
      workflows.set(
        suite,
        read(() => {
          const run = (restCall(io, ["api", `repos/${slug}/actions/runs?check_suite_id=${suite}&per_page=1`]).workflow_runs ?? [])[0];
          if (!run?.path) throw new GhError(`no workflow run of check suite ${suite}`);
          const file = String(run.path);
          const got = restCall(io, ["api", `repos/${slug}/contents/${file.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`]);
          let wf: Any;
          try {
            wf = Bun.YAML.parse(Buffer.from(String(got.content ?? ""), "base64").toString("utf8"));
          } catch {
            throw new GhError(`${file} doesn't parse`);
          }
          return { path: file, paths: workflowPaths(wf?.on) };
        }),
      );
    }
    return workflows.get(suite)!;
  };
  for (const name of names) {
    const run = runs.get(name);
    if (!run) {
      // a host status: green on the head — fixed; no paths to read without a workflow
      statuses ??= read(() => new Map<string, string>((restCall(io, ["api", `repos/${slug}/commits/${head}/status`]).statuses ?? []).map((s: Any) => [String(s.context), String(s.state)])));
      const state = typeof statuses === "string" ? undefined : statuses.get(name);
      if (state === "success") fixed.set(name, green(name));
      else if (state === undefined) undecided(name, typeof statuses === "string" ? `the statuses of its head aren't read (${statuses})` : "it is a host status, not a GitHub Actions check — no workflow paths");
      continue;
    }
    const h = onHead.get(name);
    if (h?.status === "completed" && h.conclusion === "success") {
      fixed.set(name, green(name));
      continue;
    }
    if (h && !(h.status === "completed" && h.conclusion === "skipped")) continue;
    if (run.app?.id !== ACTIONS_APP || run.check_suite?.id === undefined) {
      undecided(name, "it isn't a GitHub Actions check — no workflow paths");
      continue;
    }
    const wf = workflowOf(run.check_suite.id);
    if (typeof wf === "string") undecided(name, `its workflow isn't read (${wf})`);
    else if (!wf.paths) undecided(name, `its workflow ${wf.path} has no paths for push or pull_request`);
    else {
      const taken = files.filter((f) => pathsTake(wf.paths!, f));
      const more = taken.length > 3 ? ` and ${taken.length - 3} more` : "";
      if (taken.length) fixed.set(name, `${name} doesn't run on PR #${number} — its workflow ${wf.path} runs for the paths ${wf.paths.join(", ")}, and the PR changes ${taken.slice(0, 3).join(", ")}${more}`);
    }
  }
  return { fixed, notes };
}

/** The first failed step of a GitHub Actions job (its check-run id is the job's); not read — null, the bug goes by the check. */
function failedStepOf(io: Io, slug: string, job: number): string | null {
  try {
    const steps: Any[] = restCall(io, ["api", `repos/${slug}/actions/jobs/${job}`]).steps ?? [];
    return steps.find((x) => RED_RUN.has(x.conclusion))?.name ?? null;
  } catch (e) {
    if (!(e instanceof GhError)) throw e;
    return null;
  }
}

/**
 * The tasks whose commits made the base red (#699) — «Refs #N» and «Closes #N» of the commits of the red push (its
 * check suite's `before`..`sha`; without one — the commit itself) and «Closes #N» of the PRs merged by them (a batch's
 * release). Not read — none: the PR then waits for the bug, as before.
 */
function guiltyTasksOf(io: Io, slug: string, sha: string): { number: number; sha: string }[] {
  const out: { number: number; sha: string }[] = [];
  const add = (text: string, at: string) => {
    for (const n of [...[...text.matchAll(/\bRefs:?\s+#(\d+)\b/gi)].map((m) => Number(m[1])), ...closingInBody(text)]) if (!out.some((x) => x.number === n)) out.push({ number: n, sha: at });
  };
  const read = <T,>(f: () => T, none: T): T => {
    try {
      return f();
    } catch (e) {
      if (!(e instanceof GhError)) throw e;
      return none;
    }
  };
  if (!sha) return out;
  const suites: Any[] = read(() => restCall(io, ["api", `repos/${slug}/commits/${sha}/check-suites?per_page=100`]).check_suites ?? [], []);
  const before: string | undefined = suites.map((x) => x.before).find((b) => b && !/^0+$/.test(b));
  const commits: Any[] = before ? read(() => restCall(io, ["api", `repos/${slug}/compare/${before}...${sha}`]).commits ?? [], []) : [];
  if (!commits.length) commits.push(...read(() => [restCall(io, ["api", `repos/${slug}/commits/${sha}`])], []));
  for (const c of commits) add(String(c.commit?.message ?? ""), String(c.sha ?? sha));
  const pulls: Any[] = read(() => restCall(io, ["api", `repos/${slug}/commits/${sha}/pulls`]) ?? [], []);
  for (const p of pulls) add(String(p.body ?? ""), sha);
  return out;
}

/**
 * Title prefixes of a bug about a red default branch — `mainRed.title` of each dictionary language, the project
 * language first.
 */
const mainRedPrefixes = (base: string) => [...new Set([N, ...locale.everyNames()].map((n) => locale.fill(n.mainRed.title, { base })))];

/** A bug about the red default branch by its title (`mainRedPrefixes`): `pr premerge` waits for it, the queue reads it (#886). */
const isMainRedBug = (title: string, base: string) => mainRedPrefixes(base).some((p) => title.startsWith(p));

/**
 * Open bugs about a red default branch — the title "<base> is red…" in any dictionary language (a search for each),
 * by number: the search lags, and a duplicate happens.
 */
function mainBugsOf(io: Io, slug: string, base: string): { number: number; title: string }[] {
  const found = new Map<number, Any>();
  for (const prefix of mainRedPrefixes(base)) {
    const q = `repo:${slug} is:issue is:open in:title "${prefix}"`;
    for (const i of restCall(io, ["api", `search/issues?q=${encodeURIComponent(q)}&per_page=20`]).items ?? []) found.set(i.number, i);
  }
  return [...found.values()].filter((i) => !i.pull_request && isMainRedBug(String(i.title), base)).sort((a, b) => a.number - b.number);
}

/**
 * The bug title "<base> is red…" names the check — the whole name after the prefix, not part of another one: `test`
 * isn't found in "test:spec", nor `main` in the prefix.
 */
function bugNames(base: string, title: string, check: string): boolean {
  const prefix = mainRedPrefixes(base).find((p) => title.startsWith(p)) ?? "";
  return new RegExp(`(?:^|[\\s,«"(])${locale.escapeRe(check)}(?=$|[\\s,;»")])`, "u").test(title.slice(prefix.length));
}

/**
 * A PR into a batch branch before its merge (#649; question 2 of epic #645 — the live executors aren't stopped by a
 * release). The batch's release PR is open — code 1 and the wait for its close: a merge into the batch now would change
 * the release its CI checked. Merged — code 1, the PR moves: into the dispatcher's next batch (the marker's, another
 * one than the base: the dispatcher went on — its queue started it), without one — into the default branch with the
 * full CI, the task leaving the batch; then a rebase onto it — the batch's commits are there already, rebased, with
 * other SHAs, and GitHub's rebase merge would replay them. No release (none, or closed without a merge) — null. The
 * open release red — by its checks or by `pr premerge` on its head (#884) — and the PR one of its task's (#650: the task
 * branch or «Closes #N» — `prTasks`, the release's «Closes #N») — the guilty task's fix: null, the PR is checked as
 * usual; a live executor's PR (its task isn't in the release) and any PR while the release is green or running — held.
 * Held but the fix of red main (#889: it closes an open «<base> is red…» bug — handed out into the batch before the
 * release opened) — code 1, the PR moves into the default branch: held, it would wait for the release, and the release
 * for the bug's close; its hand-out is marked past the batch (`markPastBatch`), the rebase takes only the task's
 * commits — the batch isn't released.
 */
function batchBase(io: Io, slug: string, number: number, pr: Any): number | null {
  const base: string = pr.base.ref;
  const main: string = pr.base.repo?.default_branch ?? "main";
  const owner = slug.split("/")[0]!;
  const rows: Any[] = restCall(io, ["api", `repos/${slug}/pulls?state=all&head=${encodeURIComponent(`${owner}:${base}`)}&per_page=10`]) ?? [];
  const release = releaseOf(rows, base, main);
  if (!release) return null;
  const tasks = prTasks(pr);
  /** The move to `target` — the base, the rebase, the push and what follows: a PR into a batch runs no CI (#676), into the default branch — the full CI. */
  const move = (target: string, rebase: string) =>
    `the PR moves to ${target}: gh pr edit ${number} --base ${target}, then git fetch origin ${target}, ${rebase}, git push --force-with-lease, ` +
    (target === main
      ? `ci-wait, pr premerge ${number} again; into ${main} the task leaves the batch: the full CI, after the merge — the deploy wait (bash ${waitCi()} merged ${number}), the epic refresh and task close ${tasks.length ? tasks.join(", ") : "<N>"}, as outside a batch`
      : `pr premerge ${number} again; in the batch ${target} the task waits for its release, as before: no CI wait, no deploy wait, no epic refresh and no task close`);
  if (release.state === "OPEN") {
    const ofRelease = tasks.filter((n) => prOfTask(release, n));
    const checks = ofRelease.length ? releaseChecks(io, slug, release) : null;
    // red by its checks or by pr premerge on its head (#884): the release waits for this fix, not the fix for the release
    if (checks && isRed(checks)) {
      io.out(
        `○ ${base} is being released — PR #${release.number} into ${main} is red (${redNames(checks).join(", ")}), and PR #${number} is of its task ${ofRelease.map((n) => `#${n}`).join(", ")}: ` +
          `the guilty task's fix goes into the batch — checking the PR as usual; after its merge the release's full run goes again on PR #${release.number}`,
      );
      return null;
    }
    const closes = closingInBody(pr.body ?? "");
    let bug: { number: number; title: string } | undefined;
    if (closes.length) {
      try {
        bug = mainBugsOf(io, slug, main).find((b) => closes.includes(b.number));
      } catch (e) {
        if (!(e instanceof GhError)) throw e;
        io.out(`○ open bug on red ${main} not found by search: ${e.message} — the PR is held as a task of the batch`);
      }
    }
    if (bug) {
      for (const n of markPastBatch(io, slug, tasks)) {
        io.out(`+ #${n}: the hand-out goes past the batch ${base} now (${MAIN_HANDOUT}) — task finish, a restart and task queue lead it into ${main}, not as a task of the release`);
      }
      io.out(
        `❌ don't merge: ${base} is being released — PR #${release.number} into ${main}, and PR #${number} closes bug #${bug.number} «${bug.title}» on red ${main}, whose close the release waits for: ` +
          `held, the bug would wait for the release — ${move(main, `git rebase --onto origin/${main} origin/${base} (only the task's commits: the batch's go with its release)`)}`,
      );
      return 1;
    }
    io.out(
      `❌ don't merge: ${base} is being released — PR #${release.number} into ${main}: a merge into the batch now would change the release its CI checked. ` +
        `Wait for the release to close — bash ${waitCi()} issue ${release.number} (a subagent — a regular call with --timeout 540, again on TIMEOUT; a session — a background command), ` +
        `then pr premerge ${number} again`,
    );
    return 1;
  }
  const next = batchOf(io, slug);
  const target = next && next !== base ? next : main;
  io.out(`❌ don't merge: ${base} is released by PR #${release.number} — ${move(target, `git rebase origin/${target} (the batch's commits are in it already — the rebase drops them)`)}`);
  return 1;
}

/**
 * The spec skill's red-on-base script next to this skill (`../spec/scripts/spec-red.ts`, laid out like est): a process,
 * not an import (tests/standards/scripts/skill-imports).
 */
const specRedScript = (io: Io) => io.env["ELVES_SPEC_RED"] ?? path.resolve(import.meta.dir, "../../spec/scripts/spec-red.ts");

/**
 * Red on base (#844) before the merge: spec-red on the PR head against origin/<base> in the checkout — the added tests
 * run on the base code and must fail there, a test of existing behavior carries its mark. A PR into a batch — `also`,
 * the default branch, its release's base (#892): a test green on the batch and red on main checks the batch's change —
 * no mark, the mark would make the release red. Its lines as they are; code 0 — on, 1 — don't merge, its error —
 * premerge's error: it couldn't check. No spec skill — an ○ line, not a hold. A batch's release (#884) — the fix isn't
 * the release PR's: the guilty task fixes the test in the batch.
 */
function redOnBase(io: Io, base: string, head: string, recheck: string, release: boolean, also: string | null): number {
  const script = specRedScript(io);
  if (!existsSync(script)) {
    io.out(`○ red on base isn't checked: the spec skill isn't installed (${script})`);
    return 0;
  }
  const r = (io.run ?? realRun)("bun", ["--no-env-file", script, "--base", `origin/${base}`, ...(also ? ["--also", `origin/${also}`] : []), "--head", head], io.cwd);
  for (const l of `${r.stdout}\n${r.stderr}`.split("\n").filter((l) => l.trim())) io.out(l);
  if (r.status === 0) return 0;
  if (r.status !== 1) throw new GhError(`red on base isn't checked: spec-red — code ${r.status} (above); ${recheck}`);
  const fix = release ? "the release is red: its guilty task fixes the test in the batch (batch release names it), not in the release PR" : `fix the test in the PR, push, ${recheck}`;
  io.out(`❌ don't merge: an added test is green on the base code or its existing-behavior mark is wrong (above) — ${fix}`);
  return 1;
}

/**
 * Before merging a green PR: main moved after its CI — the PR head merged with a fresh main in a temporary worktree and
 * the fast checks (`typecheck`, then `test:spec`, as in CI); didn't move — the CI checked exactly this merge. GitHub
 * doesn't keep what the CI checked (the merge-ref is rebuilt), so by time: the head's earliest check suite against the
 * last event of the default branch (REST: the GraphQL quota is shared by all sessions). The unknown is checked. A red
 * main isn't this PR: a red check on main's last commit or a merge red by the same thing as bare main — unless the PR
 * fixes it (its bug, its guilty task, the red checks themselves — `prFixes`, #893). Code 0 —
 * merge, 1 — don't merge (the PR breaks it), 3 — main is red. A PR into a batch branch runs no CI (#676) and the batch
 * branch none either: what was checked is the head itself — the executor's checks before a commit; so by git, not by
 * time: the head on a fresh origin/<batch> — merge, the batch moved on past it — the fast checks on the merge, as for a
 * moved main. Before all of it — red on base (#844) for a PR with files in `tests/`: its added tests fail on the base
 * code (`redOnBase`).
 * The command's exit (#842) — done, a step or an error: 0 — merge, 1 — don't merge (the PR's fix or the red base's bug —
 * the `Next:` line says which), 2 — couldn't check; `MAIN_RED` is the verdict's, `task finish` tells it apart.
 */
export function cmdPrPremerge(io: Io, slug: string, number: number): number {
  const v = premergeOf(io, slug, number);
  const again = `bun --no-env-file ${import.meta.path} ${v.task ? `task finish ${v.task}` : `pr premerge ${number}`}`;
  if (v.code === 0) {
    const then = v.task ? `${again}${isBatchBranch(v.base) ? "" : " — in the background: it waits for the deploy"}` : "the deploy wait and task close of its tasks";
    return endWith(io, STEP.merge("", number, locale.autoProject(io.cwd ?? process.cwd()), then), 0);
  }
  // the batch's release on red main (#886): its bug's executor past the batch, then premerge of the release again — its
  // «Closes #N» are the batch's tasks, not a task of the release's own
  if (v.code === MAIN_RED) return endWith(io, v.release ? STEP.mainRed("", `bun --no-env-file ${import.meta.path} pr premerge ${number}`, v.release) : STEP.mainRed("", again), 1);
  // a batch's release red by premerge (#884): its mark makes the release red — the guilty task fixes it in the batch
  if (v.code === 1 && v.release) {
    const release = `bun --no-env-file ${import.meta.path} batch release --repo ${slug}`;
    return endWith(io, { state: "", next: `${release} again — the release is red by pr premerge (its ❌ lines above): it names the guilty task and prints its fix in the batch, the release PR stays open`, who: "agent" }, 1);
  }
  return endWith(io, { state: "", next: `${v.code === 2 ? "the reason above" : "what the ❌ line above names"}, then ${again}`, who: "agent" }, v.code === 2 ? 2 : 1);
}

/**
 * The files `pr premerge`'s ❌ lines name (#884) — spec-red's (a test green on the base, a mark wrong there: the test
 * file) and the merge's failed lines (a compiler error's file, a test file): a red release's guilty task goes by them,
 * as by the failed jobs' logs.
 */
function premergeFiles(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (!line.startsWith("❌") && !FAILED_LINE.test(line)) continue;
    const found = /^\s*(\S+?)\(\d+,\d+\): error TS\d+/.exec(line)?.[1] ?? TEST_FILE.exec(line)?.[1];
    if (found && !out.includes(found)) out.push(found);
  }
  return out;
}

/** The verdict «the base is red by itself, not this PR» — `pr premerge` exits with 1 and the bug's wait (#842). */
const MAIN_RED = 3;

/**
 * `pr premerge`'s verdict (0 · 1 · 2 · `MAIN_RED`), the PR's base and task, the batch it releases (`releaseHead`); its
 * mark (`markPremerge`): passed — the mark `task next` names the merge by; ❌ — the mark with the files its lines name
 * (#884): a release red by it is red for the queue and `batch release`; another verdict — none, the head isn't decided.
 */
function premergeOf(io: Io, slug: string, number: number): { code: number; base: string; task: number | null; release: string | null } {
  const pr = restCall(io, ["api", `repos/${slug}/pulls/${number}`]);
  if (pr.state !== "open") throw new GhError(`PR #${number} is not open — nothing to merge`);
  const lines: string[] = [];
  const code = premergeVerdict({ ...io, out: (l) => (lines.push(l), io.out(l)) }, slug, number, pr);
  if (code === 0) markPremerge(io, slug, number, pr.head.sha);
  else if (code === 1) markPremerge(io, slug, number, pr.head.sha, premergeFiles(lines));
  else rmSync(premergeFile(io, slug, number), { force: true });
  return { code, base: pr.base.ref, task: taskBranch(String(pr.head?.ref ?? ""))?.issue ?? closingInBody(pr.body ?? "")[0] ?? null, release: releaseHead(pr) };
}

/** The batch a PR releases — its head a batch branch, its base not one (#649); another PR — null. REST's PR. */
function releaseHead(pr: Any): string | null {
  const head = String(pr.head?.ref ?? "");
  return isBatchBranch(head) && !isBatchBranch(String(pr.base?.ref ?? "")) ? head : null;
}

function premergeVerdict(io: Io, slug: string, number: number, pr: Any): number {
  const head: string = pr.head.sha;
  const base: string = pr.base.ref;
  const closes = closingInBody(pr.body ?? "");
  const batch = isBatchBranch(base);
  const main: string = pr.base.repo?.default_branch ?? "main";
  if (batch) {
    const code = batchBase(io, slug, number, pr);
    if (code !== null) return code;
  }
  // what the PR's fix goes through again: a PR into a batch has no CI to wait for (#676)
  const recheck = batch ? `pr premerge ${number} again` : "ci-wait again";
  // the decision labels — not up to the executor's memory (#733): a PR doesn't merge without the labels of the decisions
  // it changes
  const change = loadPrChange(io, slug, number);
  const unlabeled = missingPrLabels(io, slug, number, change);
  if (unlabeled.length) {
    io.out(`❌ don't merge: PR #${number} changes decisions without their labels — ${unlabeled.join("; ")}: bun --no-env-file ${import.meta.path} pr labels ${number}, then pr premerge ${number} again`);
    return 1;
  }

  /** The base and the PR head in the checkout — once: red on base and the merge check below need them. */
  let fetchedPr = false;
  const fetchPr = () => {
    if (fetchedPr) return;
    if (!checkoutOfRepo(io, originUrl(io), slug)) throw new GhError(`the merge check runs from a checkout of ${slug}: the current directory is not one`);
    // a PR into a batch — its release's base too: red on base checks the existing-behavior marks against it (#892)
    for (const ref of batch ? [base, main] : [base]) {
      const fetched = git(io, io.cwd, "fetch", "-q", "origin", ref);
      if (fetched.status !== 0) throw new GhError(`git fetch origin ${ref}: ${fetched.stderr.trim()}`);
    }
    // the head — by its SHA, not refs/pull/<N>/head: GitHub creates that ref up to minutes after the PR, when CI has
    // already passed (#505), while a reachable commit (the head branch, refs/pull/<N>/merge) it gives by SHA
    const got = git(io, io.cwd, "fetch", "-q", "origin", head);
    if (got.status !== 0) throw new GhError(`PR head ${head} not fetched from origin (${why(got)}) — was the PR updated? ${recheck}`);
    fetchedPr = true;
  };

  // «red first» (#844): the PR's added tests fail on the base code — once per PR, on every path to the merge, before
  // «CI checked this merge» and «on the fresh origin/<batch>» below; a PR without files in tests/ adds no test
  if (change.files.some((f) => f.changeType !== "DELETED" && /(?:^|\/)tests\//.test(f.path))) {
    fetchPr();
    const code = redOnBase(io, base, head, recheck, releaseHead(pr) !== null, batch ? main : null);
    if (code !== 0) return code;
  }

  /**
   * A red main: don't merge and don't fix it in your PR — one bug for everyone, the others wait for it to close.
   * `red` — the failed checks (or the script), `what` — how to name them in the bug title, `say` — in the lines. A PR
   * that closes this bug is the fix: null, the check goes as usual. `fixes` — the red checks the PR fixes itself
   * (`prFixes`, #893): all of them — null too; some — the bug is waited for the rest.
   */
  const mainRed = (
    lead: string,
    why: string,
    sha: string,
    red: string[],
    what: (names: string[]) => string,
    { say = what, stepped = false, fixes }: { say?: (names: string[]) => string; stepped?: boolean; fixes?: (names: string[]) => { fixed: Map<string, string>; notes: string[] } } = {},
  ): number | null => {
    let bugs: { number: number; title: string }[] = [];
    try {
      bugs = mainBugsOf(io, slug, base);
    } catch (e) {
      if (!(e instanceof GhError)) throw e;
      io.out(`○ open bug on red ${base} not found by search: ${e.message}`);
    }
    // the fix is a PR that closes any of the open bugs, without matching the failed check (unlike the wait below): one
    // red main is named sometimes by the script (test:spec on bare main), sometimes by a CI check — matching would
    // keep the fix from merging
    const fix = bugs.find((b) => closes.includes(b.number));
    if (fix) {
      io.out(`○ ${base} is red — ${why}; the PR closes bug #${fix.number} about it — checking the PR as usual`);
      return null;
    }
    // the fix of the task whose commit made the base red (#699): its PR closes that task — the bug is the reopened
    // task, not a «<base> is red…» issue; another task's PR still waits
    const guilty = closes.length ? guiltyTasksOf(io, slug, sha).find((g) => closes.includes(g.number)) : undefined;
    if (guilty) {
      io.out(`○ ${base} is red — ${why}; this PR fixes red ${base}: it closes #${guilty.number}, whose commit ${guilty.sha.slice(0, 7)} made it red — checking the PR as usual`);
      return null;
    }
    // the PR fixes the red checks itself (#893): a release's own task fixed what made main red, and a bug on it could
    // close only by this very merge — a circle
    const own = fixes?.(red);
    if (own && own.fixed.size === red.length) {
      io.out(`○ ${base} is red — ${why}; this PR fixes red ${base}: ${[...own.fixed.values()].join("; ")} — checking the PR as usual`);
      return null;
    }
    io.out(lead);
    for (const l of own?.notes ?? []) io.out(l);
    for (const how of own?.fixed.values() ?? []) io.out(`○ ${how}: this PR fixes it — ${base} stays red by the rest`);
    const open = red.filter((n) => !own?.fixed.has(n));
    // wait for a bug whose title names the failed check (unlike the fix above): a bug about another check won't make
    // main green
    const named = (b: { title: string }) => open.some((n) => bugNames(base, b.title, n));
    for (const b of bugs.filter((b) => !named(b))) io.out(`○ #${b.number} «${b.title}» — about another check: don't wait`);
    const wait = (n: string) => `wait for it to close — bash ${waitCi()} issue ${n} as a background command, then pr premerge ${number} again`;
    const bug = bugs.find(named);
    if (bug) io.out(`bug on red ${base} — #${bug.number} «${bug.title}»: ${wait(String(bug.number))}`);
    const unnamed = open.filter((n) => !bugs.some((b) => bugNames(base, b.title, n)));
    if (unnamed.length) {
      const priority = pr.base?.repo?.owner?.type === "Organization" ? " --priority Urgent" : "";
      const title = `${locale.fill(N.mainRed.title, { base })}: ${what(unnamed)}`;
      const label = stepped
        ? "find an open one on the failed test or step or file one (label — the failed test's decision; a step without a test — install, network — is named by the check and the step, no decision label)"
        : "find an open one on the failed test or file one (label — the failed test's decision)";
      io.out(`no bug on red ${base} about ${say(unnamed)} — ${label} and ask the owner whether to queue it: bun --no-env-file ${import.meta.path} task new --type ${N.issueTypes.bug}${priority} --title ${JSON.stringify(title)}; ${wait("<N>")}`);
    }
    // the batch's release (#886): the bug merged into the batch would wait for this very release — it goes past the batch
    const release = releaseHead(pr);
    if (release) {
      io.out(
        `○ PR #${number} is the release of ${release}: the bug on red ${base} goes past the batch — the dispatcher's task queue (the bug in its group) hands it out with --main, ` +
          `its PR into ${base} with the full CI: into ${release} its merge would wait for this release`,
      );
    }
    io.out(`⛔ don't merge: ${base} is red, not this PR — don't fix it in your PR`);
    return MAIN_RED;
  };

  // a batch branch and a PR into it run no CI (#676): neither a red check of the base nor the PR's CI by time — git below
  if (!batch) {
    try {
      const red = redChecksOf(io, slug, base);
      for (const branch of new Set(red.foreign.map((x) => x.branch))) {
        const runs = red.foreign.filter((x) => x.branch === branch);
        io.out(`○ ${runs.map((x) => x.name).join(", ")} red on the last commit of ${base} (${red.sha.slice(0, 7)}) in a run of branch ${branch}, not of ${base}: not counted`);
      }
      if (red.aggregates.length) {
        io.out(`○ ${red.aggregates.join(", ")} red on the last commit of ${base} (${red.sha.slice(0, 7)}) after cancelled jobs of its run — the verdict of a cancelled run, not a check of ${base}: not counted`);
      }
      if (red.publish.length) {
        io.out(`○ ${red.publish.join(", ")} red on the last commit of ${base} (${red.sha.slice(0, 7)}) — publishing the documentation, not a check of ${base}: not counted`);
      }
      if (red.names.length) {
        const checks = (names: string[]) => `${names.length > 1 ? "checks" : "check"} ${names.join(", ")}`;
        // in the bug title — in the project language
        // a failed step of an Actions job — next to its check (#699): «CI (step Install zsh)»
        const stepOf = (n: string, step: (name: string) => string) => (red.steps.has(n) ? `${n} (${step(red.steps.get(n)!)})` : n);
        const titled = (names: string[]) => locale.fill(names.length > 1 ? N.mainRed.checks : N.mainRed.check, { names: names.map((n) => stepOf(n, (name) => locale.fill(N.mainRed.step, { name }))).join(", ") });
        const said = (names: string[]) => checks(names.map((n) => stepOf(n, (name) => `step ${name}`)));
        const why = `${said(red.names)} of the last commit of ${base} (${red.sha.slice(0, 7)})`;
        const files = change.files.map((f) => f.path);
        const fixes = (names: string[]) => prFixes(io, slug, number, head, files, red.sha, base, names, red.runs);
        const code = mainRed(`${base} is red: ${why}`, why, red.sha, red.names, titled, { say: said, stepped: red.steps.size > 0, fixes });
        if (code !== null) return code;
      }
    } catch (e) {
      if (!(e instanceof GhError)) throw e;
      io.out(`○ checks of the last commit of ${base} not read (${e.message}) — whether ${base} is red is unknown from the checks`);
    }

    const suites: string[] = (restCall(io, ["api", `repos/${slug}/commits/${head}/check-suites?per_page=100`]).check_suites ?? []).map((s: Any) => s.created_at).filter(Boolean);
    const ci = suites.sort()[0];
    let moved: string | null = null;
    let unread: string | null = null;
    try {
      moved = restCall(io, ["api", `repos/${slug}/activity?ref=${encodeURIComponent(`refs/heads/${base}`)}&per_page=1`])[0]?.timestamp ?? null;
    } catch (e) {
      if (!(e instanceof GhError)) throw e;
      unread = e.message;
    }
    const check = `checking the merge with origin/${base}`;
    if (!ci) io.out(`the head of PR #${number} has no checks — what CI checked is unknown: ${check}`);
    else if (unread) io.out(`○ movement of ${base} not read (${unread}) — ${check}`);
    else if (!moved || Date.parse(moved) <= Date.parse(ci) - MERGE_REF_SLACK_MS) {
      io.out(`✅ merge: ${base} hasn't moved since the CI of PR #${number} (CI since ${ci}, last movement of ${base} — ${moved ?? "none"}) — CI checked this merge`);
      return 0;
    } else io.out(`${base} moved after the CI of PR #${number} (CI since ${ci}, ${base} — ${moved}) — ${check}`);
  }

  fetchPr();
  // commits of the PR already in the base by their changes (#649): a live executor's PR moved off a released batch —
  // by GitHub too, deleting the merged release's head in a repository that deletes head branches — carries the batch's
  // commits from before the release's rebase, and GitHub's rebase merge would replay them
  const cherry = git(io, io.cwd, "cherry", `origin/${base}`, head);
  const applied = cherry.status === 0 ? cherry.stdout.split("\n").filter((l) => l.startsWith("-")).length : 0;
  if (applied) {
    io.out(
      `❌ don't merge: ${applied} ${applied > 1 ? "commits" : "commit"} of the PR ${applied > 1 ? "are" : "is"} in origin/${base} already by the changes (a released batch's, a merged PR's) — ` +
        `GitHub's rebase merge would replay them: git rebase origin/${base} (it drops them), push --force-with-lease, ${batch ? "" : "ci-wait, "}pr premerge ${number} again`,
    );
    return 1;
  }
  if (batch) {
    const tip = git(io, io.cwd, "rev-parse", "--verify", `refs/remotes/origin/${base}^{commit}`).stdout.trim();
    if (tip && git(io, io.cwd, "merge-base", "--is-ancestor", tip, head).status === 0) {
      io.out(`✅ merge: PR #${number} is on the fresh origin/${base} (${tip.slice(0, 7)}) — a PR into the batch runs no CI: the checks before a commit checked this tree`);
      return 0;
    }
    io.out(`${base} moved on past the head of PR #${number} (origin/${base} — ${tip.slice(0, 7) || "not read"}) — checking the merge with origin/${base}`);
  }

  const ON_MERGE = "on the merge";
  type Red = TreeRed & { failed: string[] };
  // the database of the PR's task stack (#759): the temporary worktree is on a detached HEAD, task-env takes the task
  // from ELVES_TASK — the number of the PR's branch — and appends a stack that didn't come up to ELVES_TASK_ENV_FAILED
  const task = taskBranch(String(pr.head?.ref ?? ""))?.issue;
  const failedFile = path.join(mkdtempSync(path.join(os.tmpdir(), "elves-premerge-stack-")), "failed");
  const stackEnv: Record<string, string> = { [STACK_FAILED_VAR]: failedFile, ...(task ? { [STACK_TASK_VAR]: String(task) } : {}) };
  /** A stack that didn't come up during a check — its reasons; none — null. */
  const stackFailed = () => (existsSync(failedFile) ? readFileSync(failedFile, "utf8").split("\n").filter(Boolean) : null);
  const unchecked = (where: string, script: string, lines: string[]) => {
    io.out(`❌ couldn't check: the stack of ${task ? `task #${task}` : "the PR's task (its branch has no task number)"} didn't come up for ${script} ${where} — ${lines.join("; ")}`);
    io.out(`the red ${script} isn't counted against ${base} or the PR: bring the stack up (task-env up${task ? ` ${task}` : " <N>"}) and pr premerge ${number} again`);
    return 2;
  };
  /**
   * The tree's fast checks (`scripts` — those that exist) with dependencies from its lockfile, up to the first red one;
   * none — null.
   */
  const checks = (dir: string, where: string, scripts: string[]): { ran: string[]; red: Red | null } | null => {
    const defined = scriptsOf(dir);
    const present = scripts.filter((s) => defined[s]);
    if (!present.length) return null;
    const { install, ran, red } = checkTree(io, dir, present.map((script) => ({ script })), stackEnv);
    if (install) {
      if (install.result.status !== 0) throw new GhError(`installing dependencies ${where} failed (${install.cmd}): ${tail(install.result, 5).join(" / ")}`);
      io.out(`+ dependencies${where === ON_MERGE ? "" : ` ${where}`}: ${install.cmd}`);
    }
    if (!red) return { ran, red: null };
    const failed = [...new Set(asTsc(`${red.result.stdout}\n${red.result.stderr}`).split("\n").filter((l) => FAILED_LINE.test(l)).map((l) => l.trim()))];
    return { ran, red: { ...red, failed } };
  };
  const breaks = (script: string) => `❌ don't merge: ${script} is red on the merge with origin/${base} — fix the root cause in the PR: rebase onto origin/${base}, edit, push --force-with-lease, ${recheck}`;
  try {
    return inTempWorktree(io, "premerge", `origin/${base}`, (dir) => {
      const short = (ref: string) => git(io, dir, "rev-parse", "--short=7", ref).stdout.trim();
      // like GitHub's merge-ref; a rebase merge without conflicts gives the same tree. A temporary merge doesn't need the
      // project's hooks
      const merge = git(io, dir, "-c", "user.name=elves", "-c", "user.email=elves@localhost", "-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "--no-verify", "--no-edit", head);
      if (merge.status !== 0) {
        const files = git(io, dir, "diff", "--name-only", "--diff-filter=U").stdout.split("\n").filter(Boolean);
        if (!files.length) throw new GhError(`git merge: ${merge.stderr.trim()}`);
        io.out(`❌ don't merge: a merge conflict with origin/${base} — ${files.join(", ")}; rebase onto origin/${base}, push --force-with-lease, ${recheck}`);
        return 1;
      }
      io.out(`+ merge of ${head.slice(0, 7)} with origin/${base} ${short("HEAD^1")} — no conflicts`);
      // standards without test:spec don't stop the merge: the project's check holds the script, here — that they weren't run
      const roots = specRoots(dir);
      if (roots.length && !scriptsOf(dir)["test:spec"]) io.out(`○ ${roots.join(", ")} aren't checked on the merge: the merge's package.json has no test:spec script — the project's check names the line to add (bunx github:miroshnik/elves check)`);
      const merged = checks(dir, ON_MERGE, PREMERGE_SCRIPTS);
      if (!merged) {
        io.out(`○ no fast checks: the merge's package.json has no ${PREMERGE_SCRIPTS.join(" or ")} scripts — step skipped`);
        io.out(`✅ merge: the merge with origin/${base} has no conflicts`);
        return 0;
      }
      const red = merged.red;
      if (!red) {
        io.out(`✅ merge: ${merged.ran.join(" and ")} ${merged.ran.length > 1 ? "are" : "is"} green on the merge with origin/${base}`);
        return 0;
      }
      io.out(`${red.cmd} failed:`);
      for (const l of (red.failed.length ? red.failed.slice(0, 20) : tail(red.result))) io.out(`  ${l.trim()}`);
      const down = stackFailed();
      if (down) return unchecked(ON_MERGE, red.script, down);

      // a red merge — is bare main red by the same thing: then it's not this PR that breaks it
      io.out(`checking bare origin/${base}: is it red by itself`);
      const bare = inTempWorktree(io, "premerge", `origin/${base}`, (bareDir) => checks(bareDir, `on origin/${base}`, [red.script])?.red);
      const bareDown = stackFailed();
      if (bareDown) return unchecked(`on origin/${base}`, red.script, bareDown);
      if (!bare) {
        io.out(breaks(red.script));
        return 1;
      }
      const onMain = new Set(bare.failed.map(failure));
      const own = red.failed.filter((l) => !onMain.has(failure(l)));
      // can't tell what failed — can't tell them apart: main is red, after its fix premerge checks the PR again
      if (own.length && bare.failed.length) {
        io.out(`${base} is red by itself, the PR breaks beyond it:`);
        for (const l of own.slice(0, 20)) io.out(`  ${l}`);
        io.out(breaks(red.script));
        return 1;
      }
      const reason = `${red.script} is red on bare origin/${base} too, with the same failures`;
      const code = mainRed(`${base} is red by itself: ${reason}`, reason, git(io, dir, "rev-parse", `origin/${base}`).stdout.trim(), [red.script], (names) => names.join(", "));
      if (code !== null) return code;
      io.out(breaks(red.script));
      return 1;
    });
  } finally {
    rmSync(path.dirname(failedFile), { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------------

/**
 * A call error with the call corrected (#841): what was wrong — one line, then the whole command to run instead; no
 * correction — the command's synopsis. `--help` was 9 % of the script's calls, and 124 of 136 `task new --help` and
 * 171 of 181 `task edit --help` came before the command's first call in the session: the syntax isn't guessed, and an
 * error sent to the help — a turn on the full context. A call is safe to try: its error is the command that works.
 */
class CallError extends GhError {
  readonly fixed: string[] | null;
  constructor(message: string, fixed: string[] | null) {
    super(message);
    this.fixed = fixed;
  }
}

/** The command ready for the shell: this script with the arguments (#841) — a hint is run as is, not assembled. */
const ready = (args: readonly (string | number)[]) => readyCommand(import.meta.path, args);

/** The synopsis of a command — the first paragraph of its help; an unknown one — the overview. */
const synopsisOf = (command: string) => (Object.hasOwn(HELP, command) ? HELP[command]!.split("\n\n")[0]! : OVERVIEW);

/** The options of a command — the flags of its synopsis: the help is their one list. */
const optionsOf = (command: string) => [...new Set(synopsisOf(command).match(/--[a-z][\w-]*/g) ?? [])];

/** Options the commands no longer take, each with its value: the call goes without it, the line says why. */
const GONE: Record<string, string> = { "--branch-type": "no estimate since #835, the branch type comes with task start --branch" };

/** The names agents reach for in place of an option (#841, the sessions' calls): `--parent 45` means `--epic 45`. */
const ALIASES: Record<string, string> = {
  "--parent": "--epic",
  "--label": "--labels",
  "--blocker": "--blocked-by",
  "--blockers": "--blocked-by",
  "--description": "--body",
  "--file": "--body-file",
  "--append": "--add",
};

/** Levenshtein distance — a typo in an option's name. */
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length]!;
}

/** The option of the command an unknown name means: an alias, otherwise the one nearest within two letters; none — null. */
function meantOption(name: string, own: string[]): string | null {
  const alias = ALIASES[name];
  if (alias && own.includes(alias)) return alias;
  const near = own.map((o) => ({ o, d: distance(name, o) })).filter((x) => x.d <= 2 && name.length > 4);
  const best = Math.min(...near.map((x) => x.d));
  const nearest = near.filter((x) => x.d === best);
  return nearest.length === 1 ? nearest[0]!.o : null;
}

/** A dash at a text's start — a text, not an option: an option is `--name` or `-x`. */
const isOptionName = (raw: string) => /^--?[a-z][\w-]*$/i.test(raw);

/**
 * The call error of `parseArgs` corrected (#841): an option the command doesn't know — the one it means (an alias, a
 * typo within two letters), a gone one (`GONE`) — dropped with its value, a text that starts with a dash — after `--`;
 * an option without its value — a placeholder, a value that starts with a dash — glued by `=`, a value of a flag —
 * the flag alone; a command without arguments — without them. Not figured out — the synopsis.
 */
function parseCallError(command: string, args: string[], config: ParseArgsConfig, first: string): CallError {
  const { tokens = [] } = parseArgs({ ...config, strict: false, tokens: true });
  const options = config.options ?? {};
  const own = optionsOf(command);
  const out: string[][] = args.map((a) => [a]);
  const tail: string[] = [];
  const said: string[] = [];
  let moving = false;
  for (const t of tokens) {
    if (t.kind === "option-terminator") continue;
    if (t.kind === "positional") {
      // the positionals after a text moved behind `--` follow it: their order is the command's
      if (moving) tail.push(args[t.index]!);
      else if (!config.allowPositionals) said.push(`it takes no argument ${q(clip(t.value))}`);
      if (moving || !config.allowPositionals) out[t.index] = [];
      continue;
    }
    const spec = options[t.name];
    if (!spec && !isOptionName(t.rawName)) {
      said.push(`${q(clip(args[t.index]!))} starts with a dash — a text, not an option: after --`);
      tail.push(args[t.index]!);
      out[t.index] = [];
      moving = true;
      continue;
    }
    if (!spec) {
      const gone = GONE[t.rawName];
      const to = gone ? null : meantOption(t.rawName, own);
      if (gone) {
        said.push(`${t.rawName} is gone — ${gone}`);
        out[t.index] = [];
        const next = tokens.find((x) => x.index === t.index + 1);
        if (!t.inlineValue && next?.kind === "positional") out[t.index + 1] = [];
      } else if (to) {
        said.push(`no option ${t.rawName} — ${to}`);
        out[t.index] = [t.inlineValue ? `${to}=${t.value}` : to];
      } else return new CallError(`${command}: no option ${t.rawName}; its options: ${own.join(", ")}`, null);
      continue;
    }
    // `--title --repo x`: the next option isn't the title — the value is missing
    const missing = t.value === undefined || (!t.inlineValue && t.value.startsWith("--") && Object.hasOwn(options, t.value.slice(2)));
    if (spec.type === "string" && missing) {
      said.push(`${t.rawName} without its value`);
      out[t.index] = [t.rawName, `<${t.name}>`];
    } else if (spec.type === "string" && !t.inlineValue && t.value!.startsWith("-")) {
      said.push(`the value of ${t.rawName} starts with a dash — glued by =`);
      out[t.index] = [`${t.rawName}=${t.value}`];
      out[t.index + 1] = [];
    } else if (spec.type === "boolean" && t.inlineValue) {
      said.push(`${t.rawName} is a flag, without a value`);
      out[t.index] = [t.rawName];
    }
  }
  if (!said.length) return new CallError(`${command}: ${first}`, null);
  return new CallError(`${command}: ${said.join("; ")}`, [...command.split(" "), ...out.flat(), ...(tail.length ? ["--", ...tail] : [])]);
}

/** `parseArgs` of a command's arguments; a call error — `CallError` with the call corrected (`parseCallError`). */
function parse<T extends ParseArgsConfig>(command: string, config: T): ReturnType<typeof parseArgs<T>> {
  try {
    return parseArgs(config);
  } catch (e) {
    if (!String((e as Any)?.code ?? "").startsWith("ERR_PARSE_ARGS_")) throw e;
    throw parseCallError(command, [...(config.args ?? [])], config, (e as Error).message.split("\n")[0]!);
  }
}

/** The arguments without the positional ones: a correction that moves them into an option. */
function withoutPositionals(args: string[], config: ParseArgsConfig): string[] {
  const { tokens = [] } = parseArgs({ ...config, args, strict: false, tokens: true });
  const drop = new Set(tokens.filter((t) => t.kind === "positional").map((t) => t.index));
  return args.filter((a, i) => !drop.has(i) && a !== "--");
}

/**
 * Help — `--help` or `-h` anywhere in the arguments (tests/standards/scripts/cli-help): a command's synopsis (the first
 * paragraph), what it does and examples; `github --help` — the synopses of all. The dispatcher takes only the commands
 * from here: a command without help can't be called.
 */
const HELP: Record<string, string> = {
  "project check": `github project check [--repo owner/repo]

Items ✅/❌; code 0 — everything per the canon, 1 — there are ❌. Decision labels — by the default branch's spec tree; a
new decision's label on an open task and a slice label («Slice: …») with a decision's name — an ○ line, not ❌. The
board (GitHub Projects) is optional: no project linked — an ○ line «no board connected», the default-branch rule and the
merge method are checked, code 0.

Examples:
  github project check
  github project check --repo acme/shop`,
  "project fix": `github project fix [--repo owner/repo] [--confirm] [--create [--template owner/N | none]]

Fixes via the API and prints UI steps with links; deleting and renaming in a project with tasks and organization
settings — only with --confirm (after the user's "yes"). The board is optional: no project — fix leaves it so and fixes
the rest; --create connects one — links the one of the same name, otherwise copies the template (${DEFAULT_TEMPLATE}),
otherwise creates one.

Examples:
  github project fix
  github project fix --create --template none`,
  "task new": `github task new --title "…" [--body "…" | --body-file F] [--type Task|Bug|Epic] [--epic N]
                [--milestone "…"] [--blocked-by N,N] [--priority Urgent|High|Medium|Low]
                [--labels <decision>,<kind>:<new decision>,<label>] [--repo owner/repo]

A task by the canon: type, project and Backlog, Priority, epic, blocked by, milestone, decision labels, the questions
label when the description has a question without ✅ (created if missing); prints what was created and the next
step. No board (GitHub Projects) — the task without one, an ○ line: its status is by the facts.

Examples:
  github task new --title "Billing · Export invoices to PDF" --epic 40 --body-file task.md
  github task new --title "Login fails on Safari" --type Bug --priority High --body "Steps: …"`,
  "task show": `github task show <N> [--repo owner/repo]

The task in one output: title, type, Status, actual, the epic with its open questions and tasks, subtasks, open
blockers, the PRs with their checks, open and answered questions (a comment that looks like an answer — a «?» line at
the question), the comments of the task and its epic (the flow's own — one line with the kind), the description;
read-only. No board (GitHub Projects) — the status by the facts: closed as completed — Done, closed otherwise — not
done; open — In progress with an open PR, a task branch */<N>-* on origin or a session pin on this machine, otherwise
Backlog.

Examples:
  github task show 42`,
  "task answer": `github task answer <N> <k> "<answer>" [--auto] [--repo owner/repo]

✅ and «**Answer:** …» at question k of the questions section (--auto — the auto mark), the numbering unchanged; no open
questions left — the questions label is removed; an answered question is refused (a changed answer — task edit --replace). A question is answered by ✅ at the
start of its answer, not by ✅ in its text.

Examples:
  github task answer 42 1 "Only PDF, no CSV yet"
  github task answer 42 2 "Medium, by recommendation" --auto`,
  "task edit": `github task edit <N> [--replace <old> <new>] [--add <section> <item>] [--check <item text>] … [--repo owner/repo]

An edit of the description in one call, not gh issue view --json body, a file and gh issue edit --body-file: --replace —
the text must occur exactly once; --add — an item at the end of the section «## …» or of the heading with that bare
name; the canon's questions or scenarios section the description lacks — created at its end (without a list marker —
the one of the section's last item: «- [ ]», the next number, its bullet; the questions section's first — «1.»); --check —
«- [ ]» → «- [x]» of the one unchecked item with the text. Several edits — in order, each sees the previous one's result,
written together; any not found or ambiguous — refused (code 2), the description untouched. Questions are answered by
task answer.

Examples:
  github task edit 42 --replace "PDF only" "PDF and CSV"
  github task edit 42 --add "## Scenarios" "export opens in Excel" --check "PDF export"`,
  "task start": `github task start <N> [--branch <type>/<N>-<slug> | --resume] [--repo owner/repo]

Taking a task into work in one call: project check (once per session — a marker in project-checks/<session id> of
~/.config/elves; ❌ — the report and code 1), the task as task show prints it, then the stops before any change, code 1:
its blockers by task queue's rules (an open blocked by, another repository's too, the external blocker label with its
reason; a blocker merged into the batch of this session's executor doesn't hold), open questions of the task or its
epic (ask the owner, then task start again), the task in work elsewhere (an open PR
of it — into a batch branch too — or a branch */<N>-* locally or on origin that isn't the current one). Then task
status N «In progress» --branch (the pin, the epic, the branch rename) and the next lines: the session name «#N <title>», the branch, the scenarios of the description,
in Claude Code (CLAUDECODE=1) one ToolSearch line with the app tools the flow calls (${APP_TOOLS.join(", ")}), and
task next's Next line. An epic
and a closed task — refused (code 2). --resume — an executor's restart: the task's branch and open PR are the previous
executor's work to continue, not a stop; the current branch isn't renamed, the Branch line names the one to continue;
nothing to continue — refused (code 2).

Examples:
  github task start 42 --branch feat/42-invoice-export
  github task start 42 --resume`,
  "task next": `github task next [<N>] [--repo owner/repo]

The one entry of a task (#842): by the facts — the task, its questions and its epic's, the checkout's task branch, its
changes and commits, the PR and its checks, pr premerge passed on its head, the batch, the deploy, the epic refresh, the
close — the state in one line and exactly one next step: a ready command; a step that waits for the owner (an answer, a
«yes» to the merge outside auto) or the dispatcher (a batch's release) is named so; a closed task — none. Without <N> —
the checkout's task branch, otherwise the session's pinned task. The other task commands end with the same Next line.
Read-only. Exit: 0 — nothing for the caller (no steps, the dispatcher's release), 1 — a step, 2 — an error.

Examples:
  github task next
  github task next 42`,
  "task finish": `github task finish <N> [--timeout S] [--title "<type>(<scope>): <subject>"] [--repo owner/repo]

The tail of a task from its committed branch to its close, resumable: each call does what is ready within --timeout
(default ${FINISH_TIMEOUT} s), prints the state and the Next line, a repeat goes on from there. Before the merge: the task
branch pushed (a rebased one — --force-with-lease), the PR into the dispatcher's batch branch or the default branch
(a released batch — the default branch; commits of the branch already in the base by their changes — a stop: git
rebase drops them; the title — --title, otherwise the branch type's first commit; the body — spec-diff and Closes #N; an existing PR —
its body updated), pr labels, a PR opened in Claude Code (CLAUDECODE=1) — a stop with the set_monitor step (auto_fix:
false and the PR's url: Auto-fix wants the base merged in on a conflict), the CI wait (ci-wait pr; none into a batch),
pr premerge, then the merge command — a
separate gh pr merge <PR> --rebase. After the merge: the deploy wait on the merge SHA (ci-wait merged), the epic
refresh's mechanics and its subagent's prompt (once), task close once the report is on the epic; merged into a batch —
nothing, the release does it. Marks between calls — finishes/ of ~/.config/elves. Exit: 0 finished, 1 stopped on a
step — its Next line names it (a fix, the red base's bug, the merge, the refresh subagent, out of time — the same
command again), 2 an error. A subagent — --timeout 240 (shorter than the cache TTL).

Examples:
  github task finish 42
  github task finish 42 --timeout 240 --title "feat(export): invoices as PDF"`,
  "task status": `github task status <N> <Backlog|In progress|Done> [--branch <type>/<N>-<slug>] [--repo owner/repo]

Status in the project (and the epic's In progress once its first subtask is taken). In progress pins the task to the
session (file sessions/<CLAUDE_CODE_SESSION_ID> in ~/.config/elves): another task in the same session — a refusal
(code 2) with the question to the owner whether to queue it and its executor's prompt; a task handed out to an
executor of this session (task queue --assignment) isn't pinned; a human removes the pin. --branch — the worktree
tool's branch becomes the task branch (git branch -m with its .git/config section); a .git/config locked by another
checkout — retried ~10 s, then a ! line with the command that finishes it (code 1). No board (GitHub Projects) — Status
isn't written, an ○ line: the pin and the branch are the facts the status is read by.

Examples:
  github task status 42 "In progress" --branch feat/42-invoice-export
  github task status 42 Backlog`,
  "task drop": `github task drop <N> [--duplicate-of M] [--repo owner/repo]

Closes the task without doing it (not planned) and removes it from the project; no board — nothing to remove: by the
facts a task closed without being done isn't done.

Examples:
  github task drop 42
  github task drop 42 --duplicate-of 17`,
  "task actualize": `github task actualize <N> [<M> …] [--assignment | --apply <file>] [--repo owner/repo]

Right after the merge, in parallel with the deploy: the epic refresh's mechanics (blocked by on done tasks, the questions
label without open questions, milestones without open tasks; a comment on the epic) and the subagent's prompt;
--assignment (read-only, the subagent's first call) — its whole assignment: the texts of the epic and its open tasks,
the PR files, copies of links and answers in comments, the checks by meaning; no epic or no open tasks in it —
"refresh not needed". A PR merged into a batch branch (batch/*) is what shipped too, but the blocked-by links on the
task stay till the batch's release. Several tasks — shipped together, a batch's release (batch release names them):
grouped by epic, one refresh per epic — its prompt and its report («Refresh after #N, #M, result: …») name the epic's
tasks, task close of each takes it; a released task's PRs — its own into the batch, not the release's; --assignment —
the tasks of one epic. --apply <file> — the subagent's edits in one JSON file { "report": "…", "edits": [ … ] }
(replace/with, add/item, check, answer/text, unblock, close done|not needed, new/body; the format — in the
assignment): every edit is checked first, one that can't be done refuses the whole file, nothing changed; then all
are applied and the report is posted on the epic — «Refresh after #N, result: …».

Examples:
  github task actualize 42
  github task actualize 42 --assignment
  github task actualize 42 --apply refresh.json
  github task actualize 42 43 47`,
  "task resume": `github task resume

The SessionStart hook runs it: the wait to restart for the task pinned to the session — an open PR's checks, a merged PR
of an open task — the deploy and task close; no pin — nothing (code 0). Read-only on GitHub; a session with executors —
its stopped executors continued with SendMessage, then the queue command (a dispatcher's); a new executor only for one
that can't be continued, in the worktree of its task's branch.

Examples:
  github task resume`,
  "task queue": `github task queue [--epic N | --tasks N,M,…] [--type Task|Bug] [--priority Urgent,High] [--repo owner/repo]
github task queue --assignment <N> [--session] [--main] [--repo owner/repo]

The dispatcher session's queue: ready tasks (open, not an epic, not in work, no open blockers — other repositories'
too —, no external blocker label) by Priority, then number, each with its executor's prompt; the rest — in work (=: In
progress, an open PR with its link, handed out to an executor of this session) and ○ lines with the reason (the
label's — from the latest «External blocker: …» comment). No board (GitHub Projects) — In progress by the facts: a task
branch */<N>-* on origin or a session pin on this machine. Marks the session as a dispatcher
(dispatchers/<CLAUDE_CODE_SESSION_ID> in ~/.config/elves, its first line — the queue command): task status in it doesn't pin — the executors are subagents
with the session's id; a session with a pinned task keeps it. Before the queue, in the repository's checkout —
finished agents' worktrees (.claude/worktrees/agent-*, detached or on worktree-agent-*, not locked by a live process —
the app's lock outlives its agent: stale once its tasks are closed and its transcript quiet ${QUIET_MINUTES} min —,
not an executor's whose handed-out task is open; on a task branch — when its task is closed): clean and merged (git
cherry, or its HEAD in a merged PR of its closed task into the default branch or a released batch) — removed with the branch (+),
otherwise left (○ with the reason), and so is one a subagent works in without a worktree of its own (its transcript
written in the last ${QUIET_MINUTES} min); loose worktree-agent-* branches — the same. --type and --priority — in an
organization. --assignment N (the executor's first call; read-only on GitHub) — its whole assignment; in a session
(not one pinned to N) it records the task as handed out with the executor's worktree (dispatchers/<id>.tasks). The
project's mode ("auto" in .agents/elves.json): auto — the task like a session in auto mode; outside auto — up to pr
premerge by itself, then the answer «question: merge PR #N?», the merge on the owner's «yes» the dispatcher forwards,
and Next: of the queue names that wait. A restart while the task's previous executor or its subagent is alive — a
worktree of it locked by a live process, with such a subagent at work or HEAD moved in the last ${QUIET_MINUTES} min —
code 1: ! lines and the answer that makes the dispatcher wait, no hand-out. --session — printed by the dispatcher: the
prompt of an app executor session
(start_session in the folder of another project, its own worktree) — a session by its project's canon and mode, named
by the task, waiting in the background, ending with the canon's last line — and how to start it; the hand-out has no
worktree, the task is = in the queue. A batch project ("batch": true in .agents/elves.json): the first queue with a ready
task pushes the dispatcher's batch branch batch/<YYYY-MM-DD>-<k> from a fresh origin/<base> (+), nothing ready — no branch
(○), the next ones take the same (○), it is kept in the marker; the assignment — the task branch from it and the PR
into it, merged after the checks before a commit and pr premerge: no CI wait (a PR into the batch runs no CI), no deploy, no epic refresh and no task close — the
release's, the task closes with it; a task merged into it is = in the queue, a blocker merged into it doesn't hold.
Nothing ready and every task of the batch merged into it — Next: names batch release, a task past the batch (a PR into
the default branch) doesn't hold it; its release PR open — ready tasks are held (○), no new executors; red (its
checks, or pr premerge on its head) — Next: names its guilty task by the labels and the fix with its executor's prompt (otherwise batch release names it), the
assignment of a task in a red release — the fix's (a new branch from the batch, the PR into it with Refs #N); released —
a new batch with a ready task, a released batch branch without an open PR into it is deleted (+).
--main — the owner's word «past the batch»: the assignment as in a project without batches (the branch from origin/<base>, the PR
into it with the full CI, the deploy, the epic refresh, task close), the hand-out marked — a restart keeps it, task
finish opens the PR into the default branch, the queue's = line says «past the batch» and the release doesn't wait for
it; a task of a red release refuses it. The same mark comes from pr premerge for the fix of red main handed out into the
batch before its release opened.
--tasks N,M,… — the dispatcher's group, the owner's chosen tasks (kept in the marker's queue command): only they are handed out, the batch's release —
once they are merged; after it a new batch — only from the group's tasks still open; nothing left — no new batch, the
last line says so. Tasks created meanwhile (by executors, the epic refresh) join only by the owner's word: task queue
--tasks with them.

Examples:
  github task queue --epic 40
  github task queue --tasks 47,49,52
  github task queue --type Bug --priority Urgent,High
  github task queue --assignment 42
  github task queue --assignment 42 --session
  github task queue --assignment 42 --main`,
  "task close": `github task close <N> [--no-git] [--repo owner/repo]

After the PR merge and the deploy (or a close without a PR) in one call: the actual (est fact --write), Status Done, the
epic and the milestone, the task's stacks taken down with their volumes (task-env down), the merged branches removed —
an agent's worktree on one first, by task queue's rule (--no-git — without git). The epic has other open tasks and no report of the refresh subagent on it («Refresh after
#N, result: …») — a refusal before any changes; so is a task merged only into a batch branch (batch/*): it closes with
the batch's release — then the release PR is its merged PR, and the batch branch goes too, kept while a live executor's
PR is into it; its refresh — one for the release's tasks of the epic, the report naming them («Refresh after #N, #M,
result: …»). The release merged without Closes #N (a red release's fix PR closed the task, merged into the batch after
the release PR opened) — no refusal: the task is closed as released by that PR, a comment names it; a task done in
another task's PR (on its branch) — an ○ line: the work went in that task's session, the actual too. No board (GitHub
Projects) — no Status and no fields: an ○ line, done by the facts (closed as completed), the actual — est's comment. A task of the scripts' own repository: before the actual the scripts'
clone catches up with origin (pull --ff-only; only on the default branch, without uncommitted changes). Docker and gh
don't work in an agent's sandbox — run it outside.

Examples:
  github task close 42
  github task close 42 --no-git`,
  "batch release": `github batch release [<batch branch>] [--repo owner/repo]

The dispatcher's batch (epic #645) into the default branch by one PR — one full CI run and one deploy: the batch branch
(the session's, from its marker, or the one named) rebased onto a fresh origin/<base> and pushed (--force-with-lease),
the PR into the default branch — a conventional-commit title, the body: spec-diff of the batch and «Closes #N» of each
task merged into it, before the PR — the decision labels its tasks' PRs into the batch change and their tasks or epics
lack (+ lines; a PR not read — a ! line with pr labels); Next: — ci-wait, pr premerge, the merge (outside auto — on the owner's «yes»), the deploy wait and the
epic refresh — one per epic of the batch's tasks (task actualize with all of them), then task close of each task. The live
executors' open PRs into the batch aren't in it: their pr premerge holds the merge till the release, then moves them to
the next batch or the default branch. The release PR open — its title and body rebuilt by the PRs merged into the batch
now (a red release's fix PR and the Closes #M of its body; the same — an = line), then its steps again; red — by its
checks or by pr premerge on its head (its mark, premerges/) — the guilty task (the release's only task, the labels of the
decisions of the files the failed jobs' logs and pr premerge's ❌ lines name, otherwise — a red check — a bisect by the
task boundaries on the machine: the head, the base, then log2 N runs of the project's test script on the failed test files) and its fix in
the batch, then the full run again on the same PR; merged — the closing steps, for the tasks of its Closes and of the PRs
merged into the batch. Nothing merged — a refusal; a rebase
conflict — a ! line, code 1, the branch unchanged. Merged — before the closing steps the batch executors' worktrees go
with their branches (agents' worktrees on a closed task's branch, clean and merged — as before the queue): a dispatcher
that stops runs no queue. From a checkout of the repository.

Examples:
  github batch release
  github batch release batch/2026-10-22-1`,
  "pr labels": `github pr labels <N> [--repo owner/repo]

Decision labels from the PR diff for the tasks from «Closes #N» (not linked yet — the task branch too) and their epics;
doesn't remove earlier ones. A decision touched only mechanically (a deletion, a rename without changes, exceptions) and
a decision with a slice label's name — an ○ line, no label. More than fit on an issue (GitHub allows
${ISSUE_LABEL_LIMIT}) — only decisions whose <topic>.md, <section>.md or test names (the PR body's spec section) the PR changes, as
many as fit; the rest — ○ lines. A batch's release PR — an ○ line, no labels: its tasks have theirs from their PRs into
the batch.

Examples:
  github pr labels 57`,
  "pr premerge": `github pr premerge <N> [--repo owner/repo]

Before gh pr merge, after ci-wait PASS: the default branch moved after the PR's CI — the PR head merged with it in a
temporary worktree and ${PREMERGE_SCRIPTS.join(", then ")} from package.json (those that exist, as in CI). Code 0 —
merge (the Next line — the merge command; the mark premerges/ of ~/.config/elves lets task next name it), 1 — don't
merge: red, a conflict, or main red by itself (the same check on bare main, a red check on its last commit — one bug
for it, the Next line names its wait), 2 — couldn't check (the stack of the PR's task didn't come up: the checks get
ELVES_TASK — the number of the PR's branch — for task-env up on the detached HEAD). A PR into a batch branch runs no
CI, so no ci-wait before it: the head on a fresh origin/<batch> — code 0 without checks (the checks before a commit
checked this tree), the batch moved on — the fast checks on the merge with it. The
batch's release PR open — code 1 and the wait for its close, but red (its checks, or pr premerge on its head) with the PR
of one of its tasks — the guilty task's fix, checked as usual; a PR closing an open «<base> is red…» bug — code 1 and
the move into the default branch, its hand-out marked past the batch (@main): the release waits for that bug; merged —
code 1 and the move: into the dispatcher's next batch or, without one, the default branch, then a rebase onto it. The
PR's commits already in the base by their changes (git cherry) — code 1 and a rebase. The PR changes decisions whose
labels its tasks or their epics lack (pr labels wasn't run) — code 1 and pr labels <N>, on every path to the merge. A PR
with files in tests/ — red on base first, on every path too (spec-red of the spec skill): an added test green on the
base code, or an existing-behavior mark on a test red there — code 1; into a batch — main the second base: a test green
on the batch and red on main goes without the mark, the mark on it — code 1. Code 1 leaves the mark with the files of
its ❌ lines: a batch's release with it is red — Next names batch release, its guilty task fixes it in the batch.

Examples:
  github pr premerge 57`,
  "hook guard": `github hook guard

Claude Code's PreToolUse hook runs it — install -g puts it into ~/.claude/settings.json, one handler per bypass with its
if rule: the Bash call from the hook's input on stdin, and a bypass of a flow command in it denied with the flow's
command in the reason — the session repository's gh issue view <N> (task show), gh issue edit <N> --body… (task edit),
gh run watch and gh pr checks --watch (wait-ci.sh pr <N> as a background command); the list — bypasses.ts next to this
script: the rule, the replacement, the reason. Inside a compound command too; another repository (--repo, GH_REPO, a
URL, a cd into another checkout) and a read the flow has no command for (--json, --web) pass, so does the hook's own
error: code 0 always, no network — git remote get-url only.

Examples:
  github hook guard`,
};

/** `github --help`: what the script is and the synopsis of each command. */
const OVERVIEW = [
  "github — the repository's GitHub project and tasks by the AGENTS.md canon",
  "",
  ...Object.values(HELP).map((h) => h.split("\n\n")[0]!.replace(/^/gm, "  ")),
  "",
  "github <command> --help — the command's details and examples; a call error prints the corrected command whole",
].join("\n");

/** The help the arguments ask for (`--help`, `-h`): of the command they start with, otherwise the overview; none — undefined. */
function helpOf(argv: string[]): string | undefined {
  if (!argv.some((a) => a === "--help" || a === "-h")) return undefined;
  const words = `${argv.join(" ")} `;
  const cmd = Object.keys(HELP).find((c) => words.startsWith(`${c} `));
  return cmd ? HELP[cmd] : OVERVIEW;
}

const issueNumber = (s: string | undefined, what: string): number => {
  const m = /^#?(\d+)$/.exec((s ?? "").trim());
  if (!m) throw new GhError(`${what}: expected an issue number, not «${s ?? ""}»`);
  return Number(m[1]);
};

// The checkout's GitHub repository by its origin — a copy of originRepo from skills/est/scripts/est.ts and skills/task-env/scripts/task-env.ts:
// no shared module: github imports no other skill (tests/standards/scripts/skill-imports); the tests/standards/scripts/origin-repo
// standard keeps the parsing identical
const ORIGIN_RE = /^(?:[a-z][a-z\d+.-]*:\/\/(?:[^@/\s]+@)?(?:ssh\.)?github\.com(?::\d+)?\/|(?:[^@/\s:]+@)?(?:ssh\.)?github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i;

/** `owner/repo` of a GitHub origin URL (host github.com or ssh.github.com, any case, with a port), otherwise null. */
export function originRepo(url: string): string | null {
  const m = ORIGIN_RE.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** A checkout with this origin URL is a checkout of `repo` (owner/name): the parsed origin equals it — GitHub ignores case. */
export function checkoutOf(origin: string, repo: string): boolean {
  return originRepo(origin)?.toLowerCase() === repo.toLowerCase();
}

function detectRepo(): string {
  const r = spawnSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" });
  const repo = r.status === 0 ? originRepo(r.stdout ?? "") : null;
  if (!repo) throw new GhError("couldn't determine the repository from git remote origin; pass --repo owner/repo");
  return repo;
}

/** Names already resolved by `canonicalRepo`, per Io: lowercase name → the current one. */
const canonicalNames = new WeakMap<Io, Map<string, string>>();

/**
 * The repository's current name `owner/repo` (#560): GitHub answers a renamed repository's former name with it. Reads by
 * the former name work — GraphQL and a REST GET follow the rename — but a REST write gets HTTP 307, which `gh` doesn't
 * repeat for a non-GET, and a hint with the former name sends the next command there: the commands work under the
 * current name. No such repository or no access — the name as given: the command's own reads say so.
 */
function canonicalRepo(io: Io, slug: string): string {
  let known = canonicalNames.get(io);
  if (!known) canonicalNames.set(io, (known = new Map()));
  const key = slug.toLowerCase();
  if (!known.has(key)) {
    const [owner, name] = slug.split("/");
    const out = io.gh(["api", "graphql", "--input", "-"], JSON.stringify({ query: Q.RepoName, variables: { owner, name } }));
    let current: unknown = null;
    try {
      current = JSON.parse(out)?.data?.repository?.nameWithOwner;
    } catch {
      current = null;
    }
    known.set(key, typeof current === "string" && current ? current : slug);
  }
  return known.get(key)!;
}

/**
 * The checkout with this origin is a checkout of `slug` (the current name): by the origin's name, and a clone made before
 * the repository's rename — by the name GitHub resolves its origin's name to (#560).
 */
function checkoutOfRepo(io: Io, origin: string, slug: string): boolean {
  if (checkoutOf(origin, slug)) return true;
  const repo = originRepo(origin);
  return repo !== null && canonicalRepo(io, repo).toLowerCase() === slug.toLowerCase();
}

/** Shell words before a command that aren't the command: keywords and prefixes (`do gh issue view $n` of a loop). */
const SHELL_LEAD = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "time", "command", "exec", "nohup"]);
/** gh flags of the bypassed commands that take a value: the word after one isn't the call's number (`-R o/r 42`). */
const GH_VALUE_FLAGS = new Set(["-R", "--repo", "-q", "--jq", "--json", "-t", "--template", "--title", "-b", "--body", "-F", "--body-file", "-m", "--milestone", "-i", "--interval", "--add-assignee", "--remove-assignee", "--add-label", "--remove-label", "--add-project", "--remove-project"]);

/**
 * The simple commands of a shell line, each — its words without quotes: split at `;`, `&`, `|`, `(`, `)` and newlines;
 * a command inside `$(…)` or backticks is one of its own, in double quotes too; a redirect with its target, a comment and
 * a heredoc's body aren't words. Best-effort, like Claude Code's own `if` filter: the guard matches the same commands.
 */
function shellCommands(s: string): string[][] {
  const cmds: string[][] = [];
  const closing = (i: number) => {
    let k = i + 1;
    while (k < s.length && s[k] !== "`") k += s[k] === "\\" ? 2 : 1;
    return k;
  };
  // from i to the end, or — nested — to its `)`: the index after it
  const scan = (start: number, nested: boolean): number => {
    let words: string[] = [];
    let word: string | null = null;
    let redirect = false;
    let depth = 0;
    const heredocs: { tag: string; tabs: boolean }[] = [];
    const end = () => {
      if (word !== null) {
        if (redirect) redirect = false;
        else words.push(word);
      }
      word = null;
    };
    const split = () => {
      end();
      if (words.length) cmds.push(words);
      words = [];
    };
    for (let i = start; i < s.length; i++) {
      const c = s[i]!;
      if (c === "\\") {
        if (s[i + 1] !== "\n") word = (word ?? "") + (s[i + 1] ?? "");
        i++;
      } else if (c === "'") {
        const j = s.indexOf("'", i + 1);
        word = (word ?? "") + s.slice(i + 1, j < 0 ? s.length : j);
        i = j < 0 ? s.length : j;
      } else if (c === '"') {
        let j = i + 1;
        let text = "";
        while (j < s.length && s[j] !== '"') {
          if (s[j] === "\\") {
            text += s[j + 1] ?? "";
            j += 2;
          } else if (s[j] === "$" && s[j + 1] === "(" && s[j + 2] !== "(") {
            j = scan(j + 2, true);
            text += "$(…)";
          } else if (s[j] === "`") {
            const k = closing(j);
            cmds.push(...shellCommands(s.slice(j + 1, k)));
            j = k + 1;
            text += "`…`";
          } else text += s[j++];
        }
        word = (word ?? "") + text;
        i = j;
      } else if (c === "`") {
        const k = closing(i);
        cmds.push(...shellCommands(s.slice(i + 1, k)));
        word = (word ?? "") + "`…`";
        i = k;
      } else if (c === "$" && s[i + 1] === "(" && s[i + 2] === "(") {
        // arithmetic, not a command
        const k = s.indexOf("))", i + 3);
        word = (word ?? "") + s.slice(i, k < 0 ? s.length : k + 2);
        i = k < 0 ? s.length : k + 1;
      } else if (c === "$" && s[i + 1] === "(") {
        i = scan(i + 2, true) - 1;
        word = (word ?? "") + "$(…)";
      } else if (c === "#" && word === null) {
        const j = s.indexOf("\n", i);
        i = (j < 0 ? s.length : j) - 1;
      } else if (c === "<" && s[i + 1] === "<" && s[i + 2] !== "<") {
        // a heredoc: its body — the lines after this one up to the tag — isn't commands
        end();
        i += 2;
        const tabs = s[i] === "-";
        if (tabs) i++;
        while (s[i] === " " || s[i] === "\t") i++;
        let tag = "";
        for (; i < s.length && !/[\s;&|()<>]/.test(s[i]!); i++) if (s[i] !== "'" && s[i] !== '"' && s[i] !== "\\") tag += s[i];
        heredocs.push({ tag, tabs });
        i--;
      } else if ((c === ">" || c === "<" || (c === "&" && s[i + 1] === ">")) && s[i + 1] !== "(") {
        // a redirect: its fd before it and its target after it aren't words
        if (word !== null && /^\d+$/.test(word)) word = null;
        else end();
        while (/[<>&|]/.test(s[i + 1] ?? "") && s[i + 2] !== "(") i++;
        redirect = true;
      } else if (c === "\n") {
        split();
        for (const h of heredocs) {
          let at = i + 1;
          for (;;) {
            const eol = s.indexOf("\n", at);
            const text = s.slice(at, eol < 0 ? s.length : eol);
            at = eol < 0 ? s.length : eol + 1;
            if ((h.tabs ? text.replace(/^\t+/, "") : text) === h.tag || eol < 0) break;
          }
          i = at - 1;
        }
        heredocs.length = 0;
      } else if (c === "(") {
        depth++;
        split();
      } else if (c === ")") {
        split();
        if (depth > 0) depth--;
        else if (nested) return i + 1;
      } else if (c === ";" || c === "&" || c === "|") split();
      else if (c === " " || c === "\t") end();
      else word = (word ?? "") + c;
    }
    split();
    return s.length;
  };
  scan(0, false);
  return cmds;
}

/** A bypass rule's command words: `Bash(gh issue view *)` — gh, issue, view. */
const ruleWords = (rule: string) => (/^Bash\((.+?)(?: \*)?\)$/.exec(rule)?.[1] ?? "").split(" ").filter(Boolean);

/** A gh call's repository (`--repo`, `GH_REPO`, the URL), its flags and its number: the issue, the PR, a `$n` of a loop. */
function ghCall(args: string[], env: string | null): { repo: string | null; flags: string[]; number: string | null } {
  let repo = env;
  const flags: string[] = [];
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (!a.startsWith("-") || a === "-") {
      positionals.push(a);
      continue;
    }
    const long = a.startsWith("--");
    const name = long ? a.split("=")[0]! : a.slice(0, 2);
    // a value in the same word: `--repo=o/r`, `-Ro/r`, `-R=o/r` (pflag takes all three)
    const inline = long ? (a.includes("=") ? a.slice(a.indexOf("=") + 1) : undefined) : a.length > 2 ? a.slice(2).replace(/^=/, "") : undefined;
    const value = GH_VALUE_FLAGS.has(name) ? (inline ?? args[++i]) : undefined;
    if (name === "-R" || name === "--repo") repo = value ?? null;
    else flags.push(name);
  }
  const first = positionals[0] ?? "";
  const url = /^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/(?:issues|pull)\/(\d+)/i.exec(first);
  if (url) return { repo: url[1]!, flags, number: url[2]! };
  return { repo: repo?.replace(/^(?:https?:\/\/)?github\.com\//i, "").replace(/(?:\.git)?\/?$/, "") ?? null, flags, number: /^(?:#?\d+|\$\{?\w+\}?)$/.test(first) ? first.replace(/^#/, "") : null };
}

/**
 * The first bypass of a flow command in a Bash call (`BYPASSES`) — the deny's reason with the flow's command, otherwise
 * null. Only the session repository's: the hook's `cwd` gives it by its origin, a call's `--repo`, `GH_REPO`, URL or a
 * `cd` before it — the repository the call is about; no GitHub origin — no tasks of the flow, nothing is a bypass.
 */
function bypassIn(io: Io, line: string, cwd: string): string | null {
  const origins = new Map<string, string | null>();
  const repoAt = (dir: string) => {
    if (!origins.has(dir)) {
      const r = git(io, dir, "remote", "get-url", "origin");
      origins.set(dir, r.status === 0 ? originRepo(r.stdout) : null);
    }
    return origins.get(dir)!;
  };
  const own = repoAt(cwd);
  if (!own) return null;
  let at: string | null = cwd;
  for (const words of shellCommands(line)) {
    let env: string | null = null;
    let w = words;
    while (w.length && (SHELL_LEAD.has(w[0]!) || /^[A-Za-z_]\w*=/.test(w[0]!))) {
      if (w[0]!.startsWith("GH_REPO=")) env = w[0]!.slice("GH_REPO=".length);
      w = w.slice(1);
    }
    if (w[0] === "cd") {
      const to = w[1];
      // `cd -`, an option or a variable — the directory is unknown: a call after it without --repo isn't a bypass
      at = at === null || (to !== undefined && /^-|[$`]/.test(to)) ? null : path.resolve(at, (to ?? "~").replace(/^~(?=\/|$)/, io.env["HOME"] ?? os.homedir()));
      continue;
    }
    for (const b of BYPASSES) {
      const cmd = ruleWords(b.rule);
      if (w.length < cmd.length || cmd.some((x, k) => (k === 0 ? path.basename(w[k]!) : w[k]) !== x)) continue;
      const call = ghCall(w.slice(cmd.length), env);
      const repo = call.repo ?? (at === null ? null : repoAt(at));
      if (repo?.toLowerCase() !== own.toLowerCase()) continue;
      const flag = b.when ? call.flags.find((f) => b.when!.includes(f)) : undefined;
      if (b.when && !flag) continue;
      if (b.only && call.flags.some((f) => !b.only!.includes(f))) continue;
      return denyReason(b, [...cmd, call.number, flag].filter(Boolean).join(" "), call.number);
    }
  }
  return null;
}

/** The deny's reason: the call, why the flow's command, and the command itself — ready to run. */
function denyReason(b: Bypass, call: string, number: string | null): string {
  const use = b.use
    .replace("{github}", `bun --no-env-file ${shellArg(import.meta.path)}`)
    .replace("{wait-ci}", shellArg(waitCi()))
    .replace("{n}", number ?? "<N>");
  return `Elves: \`${call}\` bypasses the flow's command — ${b.reason}. Run instead: ${use}`;
}

/**
 * Claude Code's PreToolUse hook (#839): the Bash call from the hook's input on stdin; a bypass of a flow command in it
 * (`bypassIn`) — a deny with the flow's command in the reason (`permissionDecision: "deny"`), Claude Code shows the
 * model the reason and the model makes the second call. Code 0 always and nothing on stdout but the decision: the hook's
 * own error — invalid input, git missing — lets the call through, the flow doesn't stop the work. No network: one
 * `git remote get-url` per directory.
 */
function cmdHookGuard(io: Io): number {
  try {
    const input = JSON.parse(io.stdin?.() ?? "") as { tool_name?: unknown; tool_input?: { command?: unknown }; cwd?: unknown };
    const command = input?.tool_input?.command;
    if (input?.tool_name !== "Bash" || typeof command !== "string") return 0;
    const reason = bypassIn(io, command, typeof input.cwd === "string" && input.cwd ? input.cwd : (io.cwd ?? process.cwd()));
    if (reason) io.out(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
  } catch {
    // the hook's own error lets the call through: the flow doesn't stop the work
  }
  return 0;
}

export function main(argv: string[], io: Io): number {
  // a cloud session — one line and code 2 before anything else (#837): not the help, not half a command
  if (io.env["CLAUDE_CODE_REMOTE"] === "true") return io.err(CLOUD_REFUSAL), 2;
  const help = helpOf(argv);
  if (help) return io.out(help), 0;
  // the PreToolUse hook (#839) — before the project's names: it writes none, and its own error lets the call through
  if (argv[0] === "hook") {
    if (argv.length === 2 && argv[1] === "guard") return cmdHookGuard(io);
    return io.err(`unknown command «${argv.join(" ")}»; expected hook guard — it reads the hook's input on stdin (github hook guard --help)`), 2;
  }
  N = locale.names(locale.projectLanguage(io.cwd ?? process.cwd()));
  contexts.clear();
  try {
    const [group, cmd, ...rest] = argv;
    if (!group) return io.out(OVERVIEW), 2;
    if (!Object.hasOwn(HELP, `${group} ${cmd ?? ""}`)) {
      io.err(`unknown command «${argv.slice(0, 2).join(" ")}»; expected ${Object.keys(HELP).join(", ")} (github --help)`);
      return 2;
    }
    // without the manifest a command that writes names would write the `en` ones into a project of another language
    // (#681): a repository without Elves refuses too (question 2) — one rule, no guessing by package.json
    const missing = LANGUAGE_COMMANDS.includes(`${group} ${cmd}`) ? locale.missingManifest(io.cwd ?? process.cwd()) : null;
    if (missing) {
      io.err(`${group} ${cmd} writes or checks the canon's names in the project language — ${missing}; a repository without Elves — install the flow: bunx @miroshnik/elves install --lang <project language>`);
      return 2;
    }
    // the repository — under its current name: --repo or origin may still name it as it was before a rename (#560)
    const repoOf = (v: string | undefined) => {
      const slug = v ?? detectRepo();
      if (!/^[\w.-]+\/[\w.-]+$/.test(slug)) throw new GhError(`invalid --repo «${slug}», expected owner/repo`);
      return canonicalRepo(io, slug);
    };
    const command = `${group} ${cmd}`;
    if (group === "pr") {
      const { values, positionals } = parse(command, { args: rest, allowPositionals: true, options: { repo: { type: "string" } } });
      if (positionals.length > 1) throw new GhError(`extra arguments: ${positionals.slice(1).join(" ")}`);
      const m = /^#?(\d+)$/.exec((positionals[0] ?? "").trim());
      if (!m) throw new GhError(`pr ${cmd}: expected a PR number, not «${positionals[0] ?? ""}»`);
      return (cmd === "premerge" ? cmdPrPremerge : cmdPrLabels)(io, repoOf(values.repo), Number(m[1]));
    }
    if (group === "batch") {
      const { values, positionals } = parse(command, { args: rest, allowPositionals: true, options: { repo: { type: "string" } } });
      if (positionals.length > 1) throw new GhError(`extra arguments: ${positionals.slice(1).join(" ")}`);
      return cmdBatchRelease(io, repoOf(values.repo), positionals[0]);
    }
    if (group === "task" && cmd === "edit") {
      const { number, repo, edits } = parseEdits(rest);
      return cmdTaskEdit(io, repoOf(repo), number, edits);
    }
    if (group === "task") {
      const config = {
        args: rest,
        allowPositionals: true,
        options: {
          repo: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
          "body-file": { type: "string" },
          type: { type: "string" },
          epic: { type: "string" },
          tasks: { type: "string" },
          milestone: { type: "string" },
          "blocked-by": { type: "string" },
          priority: { type: "string" },
          "duplicate-of": { type: "string" },
          labels: { type: "string" },
          branch: { type: "string" },
          "no-git": { type: "boolean", default: false },
          assignment: { type: "boolean", default: false },
          apply: { type: "string" },
          session: { type: "boolean", default: false },
          main: { type: "boolean", default: false },
          resume: { type: "boolean", default: false },
          auto: { type: "boolean", default: false },
          timeout: { type: "string" },
        },
      } satisfies ParseArgsConfig;
      const { values, positionals } = parse(command, config);
      // the task and its repository — from the session pin: the hook runs it from any directory
      if (cmd === "resume") {
        if (positionals.length) throw new GhError(`extra arguments: ${positionals.join(" ")} — task resume takes the task from the session pin`);
        return cmdTaskResume(io);
      }
      if (cmd === "next") {
        if (positionals.length > 1) throw new GhError(`extra arguments: ${positionals.slice(1).join(" ")}`);
        if (positionals.length) return cmdTaskNext(io, repoOf(values.repo), issueNumber(positionals[0], "task next"));
        // without a number — the session's task (#842): the checkout's task branch (an executor's, in its worktree), otherwise
        // the session pin — its repository is in it
        const branch = taskBranch(git(io, io.cwd, "branch", "--show-current").stdout.trim());
        if (branch) return cmdTaskNext(io, repoOf(values.repo), branch.issue);
        const pin = pinnedTask(io)?.task;
        if (pin) return cmdTaskNext(io, values.repo ? repoOf(values.repo) : pin.slug, pin.number);
        throw new GhError("task next: no task here — the checkout isn't on a task branch <type>/<N>-<slug> and the session has no pin: task next <N>");
      }
      const slug = repoOf(values.repo);
      if (cmd === "new") {
        // the title as an argument, or none — the command with --title and the call's other arguments (#841)
        if (!values.title?.trim()) {
          const title = positionals.join(" ").trim();
          throw new CallError(`task new: ${title ? "the title is the value of --title, not an argument" : "--title is required"}`, ["task", "new", "--title", title || "<title>", ...withoutPositionals(rest, config)]);
        }
        if (positionals.length) throw new GhError(`extra arguments: ${positionals.join(" ")}`);
        if (values.body !== undefined && values["body-file"]) throw new GhError("--body or --body-file, not both");
        const body = values["body-file"] ? readFileSync(values["body-file"], "utf8") : (values.body ?? "");
        const blockedBy = (values["blocked-by"] ?? "").split(",").filter((x) => x.trim()).map((x) => issueNumber(x, "--blocked-by"));
        const epic = values.epic === undefined ? undefined : issueNumber(values.epic, "--epic");
        const labels = (values.labels ?? "").split(",").map((x) => x.trim()).filter(Boolean);
        return cmdTaskNew(io, slug, { title: values.title, body, type: values.type, epic, milestone: values.milestone, blockedBy, priority: values.priority, labels });
      }
      if (cmd === "queue") {
        if (values.session && !values.assignment) throw new GhError("--session — only with --assignment <N>: the prompt of one task's app executor session");
        if (values.main && !values.assignment) throw new GhError("--main — only with --assignment <N>: one task's assignment past the batch");
        if (values.assignment) {
          if (positionals.length !== 1) throw new GhError("task queue --assignment <N>: one task number");
          return cmdTaskAssignment(io, slug, issueNumber(positionals[0], "task queue --assignment"), { session: values.session!, main: values.main! });
        }
        if (positionals.length) throw new GhError(`extra arguments: ${positionals.join(" ")} — the queue is chosen by --epic or --tasks, --type and --priority`);
        const priority = values.priority === undefined ? undefined : values.priority.split(",").map((x) => x.trim()).filter(Boolean);
        const tasks = values.tasks === undefined ? undefined : values.tasks.split(",").map((x) => x.trim()).filter(Boolean).map((x) => issueNumber(x, "--tasks"));
        return cmdTaskQueue(io, slug, { epic: values.epic === undefined ? undefined : issueNumber(values.epic, "--epic"), tasks, type: values.type, priority });
      }
      const number = issueNumber(positionals[0], `task ${cmd}`);
      if (cmd === "start") {
        if (positionals.length > 1) throw new GhError(`extra arguments: ${positionals.slice(1).join(" ")}`);
        return cmdTaskStart(io, slug, number, values.branch, values.resume!);
      }
      if (cmd === "finish") {
        if (positionals.length > 1) throw new GhError(`extra arguments: ${positionals.slice(1).join(" ")}`);
        const timeout = values.timeout === undefined ? FINISH_TIMEOUT : Number(values.timeout);
        if (!Number.isInteger(timeout) || timeout < 0) throw new GhError(`--timeout ${q(values.timeout ?? "")}: expected seconds, a whole number`);
        return cmdTaskFinish(io, slug, number, { timeout, title: values.title });
      }
      if (cmd === "status") return cmdTaskStatus(io, slug, number, positionals.slice(1).join(" "), values.branch);
      if (cmd === "answer") {
        const k = /^\d+$/.exec((positionals[1] ?? "").trim());
        if (!k) throw new GhError(`task answer: expected a question number, not «${positionals[1] ?? ""}»`);
        return cmdTaskAnswer(io, slug, number, Number(k[0]), positionals.slice(2).join(" "), values.auto!);
      }
      // several tasks — shipped together, a batch's release (#676): one refresh per epic of them
      if (cmd === "actualize") return cmdTaskActualize(io, slug, positionals.map((p) => issueNumber(p, "task actualize")), { assignment: values.assignment!, apply: values.apply });
      if (positionals.length > 1) throw new GhError(`extra arguments: ${positionals.slice(1).join(" ")}`);
      if (cmd === "show") return cmdTaskShow(io, slug, number);
      if (cmd === "close") return cmdTaskClose(io, slug, number, { git: !values["no-git"] });
      return cmdTaskDrop(io, slug, number, values["duplicate-of"] === undefined ? undefined : issueNumber(values["duplicate-of"], "--duplicate-of"));
    }
    const { values } = parse(command, { args: rest, options: { repo: { type: "string" }, confirm: { type: "boolean", default: false }, create: { type: "boolean", default: false }, template: { type: "string", default: DEFAULT_TEMPLATE } } });
    const slug = repoOf(values.repo);
    const template = values.template === "none" ? null : values.template!;
    if (template && !/^[\w.-]+\/\d+$/.test(template)) throw new GhError(`invalid --template «${template}», expected owner/N or none`);
    return cmd === "check" ? cmdCheck(io, slug) : cmdFix(io, slug, { confirm: values.confirm!, template, create: values.create! });
  } catch (e) {
    if (e instanceof CallError) {
      // one line of what was wrong and the command that works — not «see --help» (#841)
      io.err(`error: ${e.message}`);
      io.err(e.fixed ? ready(e.fixed) : synopsisOf(`${argv[0]} ${argv[1]}`));
      return 2;
    }
    if (e instanceof GhError) {
      io.err(`error: ${(e as Error).message}`);
      return 2;
    }
    // gh in the sandbox (#868): one line with this very call to run outside it, not gh's TLS error
    if (e instanceof SandboxRefusal) return io.err(sandboxLine(e, ready(argv))), 2;
    throw e;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2), { gh: realGh, out: (l) => console.log(l), err: (l) => console.error(l), env: process.env, stdin: () => readFileSync(0, "utf8") });
}
