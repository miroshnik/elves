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
 *                          (an open question in the description) and the estimate (est)
 *   github task show     — the task in one output: the description, Status, estimate, the epic, blockers, PRs and
 *                          their checks, open questions, the comments of the task and its epic
 *   github task answer   — ✅ and the answer at a question of the questions section; none open — the label goes
 *   github task status   — Status in the project (and the epic's "In progress" once its first subtask is taken);
 *                          "In progress" pins the task to the session — another task in the same session is refused
 *                          with the question whether to queue it
 *   github task drop     — close without doing it and remove from the project
 *   github task actualize — after the merge, in parallel with the deploy: the epic refresh's mechanics and the
 *                          subagent's prompt (or "not needed"); --assignment — the subagent's whole assignment
 *   github task close    — after the merge and the deploy: the actual, "Done", the epic and the milestone, the task's
 *                          stacks (task-env) and the task's merged branches removed
 *   github task queue    — the dispatcher's ready tasks with the prompts of their executors (subagents);
 *                          --assignment — an executor's whole assignment (--cloud, --session — the prompt of a cloud
 *                          executor or an app executor session, printed by the dispatcher)
 *   github pr labels    — decision labels for the task from "Closes #N" by the PR diff, for its epic — the union
 *   github pr premerge   — before the merge: the default branch moved after the PR's CI — typecheck and test:spec on
 *                          the merge with it
 *
 * Runs on Bun (`bun github.ts …`), only `node:` APIs + the `gh` CLI. Check and fix are one function, `analyze`: each
 * discrepancy carries its own fix step, so `check` and `fix` don't diverge.
 * Decision labels are checked against the spec tree of the default branch; the architecture model is read by a
 * separate process of the same runtime (`modelModules`). Merging into the default branch — the `elves` ruleset:
 * required checks, green on the last merged PRs; the merge method — rebase only (a repository setting, REST).
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import locale from "./locale.ts";
import type { Names } from "./locale.ts";

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
  { name: N.views.table, layout: "TABLE_LAYOUT", columns: ["TITLE", STATUS, "LABELS", "ASSIGNEES", "SUB_ISSUES_PROGRESS", N.fields.estimate], groupBy: STATUS },
  { name: N.views.roadmap, layout: "ROADMAP_LAYOUT" },
];
/** A built-in column's name when the project has no such field yet (a column key is its type). */
const BUILTIN_COLUMNS: Record<string, string> = { TITLE: "Title", ASSIGNEES: "Assignees", LABELS: "Labels", SUB_ISSUES_PROGRESS: "Sub-issues progress" };
export const STATUS = "Status";
const statusOptions = () => [N.status.backlog, N.status.inProgress, N.status.done];
/** The template's colors of the Status options, in order — GitHub's colors of a new project's Todo / In Progress / Done. */
const STATUS_COLORS = ["GREEN", "YELLOW", "PURPLE"];
const numberFields = () => [N.fields.estimate, N.fields.actual, N.fields.tokens, N.fields.cost];
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
/**
 * The name `RULESET` had before the flow was renamed to Elves: a repository set up by an earlier fix has its ruleset
 * under it. Check finds it as its own (`RULESET` first), fix renames it with the same edit — not a second ruleset.
 */
const FORMER_RULESET = "ai-dev";
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
    out[n.fields.estimate] = N.fields.estimate;
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
  /** A subprocess (`est`, `git` of `task close`) — an external edge: replaced in tests. */
  run?: (cmd: string, args: string[], cwd?: string) => RunResult;
  /**
   * The project checkout: its language (`.agents/elves.json`) is the language of names, `task close` runs its git
   * steps in it; the current directory by default.
   */
  cwd?: string;
}

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function realRun(cmd: string, args: string[], cwd?: string): RunResult {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
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

export interface ProjectRef {
  id: string;
  number: number;
  title: string;
  url: string;
  closed: boolean;
}
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
  /** `RULESET`, or `FORMER_RULESET` until fix renames it. */
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
  /** Our own ruleset — this repository's `RULESET` (otherwise `FORMER_RULESET`), in any state. */
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
  openIssues: { id: string; number: number }[];
  labels: Label[];
  /** Tasks of old `kind:name` labels that merge into an already taken name: by label id. */
  labelIssues: Record<string, { id: string; number: number }[]>;
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
  /** The item doesn't apply (plan, no checks): a `➖` line with the reason instead of ✅/❌. */
  skip?: string;
}

export class GhError extends Error {}

// ----------------------------------------------------------------------------
// GraphQL
// ----------------------------------------------------------------------------

const REF = "id number title url closed";
/** Numbers of the label's open tasks in the "new decision" line; the rest as a count. */
const OPEN_SHOWN = 10;
/**
 * How many recent PRs task close looks at when the PR isn't linked to the task: it's called right after the merge, so
 * the PR is among them.
 */
const RECENT_PRS = 50;
/**
 * A PR head's checks for `checkStates` — the one selection of every query that reads them (`PR_SHOW`, `MergeRules`):
 * without the run's id and its app reruns can't be told apart (`tests/standards/check-run-state`).
 */
export const HEAD_CHECKS = `commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { __typename ... on CheckRun { name status conclusion databaseId checkSuite { app { databaseId } } } ... on StatusContext { context state } } } } } } }`;
/** A PR for task show: its state and the checks of its head. */
const PR_SHOW = `number state merged isDraft headRefName
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
    projectsV2(first: 20) { nodes { ${REF} } }
  }
}`,
  RepoIssues: `query RepoIssues($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id number } }
  }
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
    capabilities: object(expression: "HEAD:tests/capabilities") { ... on Tree { entries { name type } } }
    standards: object(expression: "HEAD:tests/standards") { ... on Tree { entries { name type } } }
    architecture: object(expression: "HEAD:tests/architecture") { ... on Tree { entries { name type } } }
    model: object(expression: "HEAD:${MODEL_PATH}") { ... on Blob { text } }
  }
}`,
  LabelIssues: `query LabelIssues($owner: String!, $name: String!, $label: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    label(name: $label) { issues(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id number } } }
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
 * A Claude Code cloud session (docs/cloud-sessions.md): its proxy closes GraphQL, `search/…` and Projects v2 — only the
 * REST of `repos/{owner}/{repo}/…` of the session's repositories.
 */
const inCloud = (io: Io) => io.env["CLAUDE_CODE_REMOTE"] === "true";
/** The commands with a REST path in the cloud (#603): the rest need GraphQL or the project and refuse there. */
const CLOUD_COMMANDS = ["task show", "task answer", "task new"];
/**
 * The commands that write the canon's names to GitHub in the project language or check the project against them
 * (#681, question 1): views, fields and `Status` options, a task's sections, statuses and comments, a decision label's
 * marker, the release PR's title. Without the project manifest the language is unknown — they refuse before any request
 * (`locale.missingManifest`); reading (`task show`, `task queue`, `pr premerge`) parses the names of every language and
 * goes on, `task drop` writes no names.
 */
const LANGUAGE_COMMANDS = ["project check", "project fix", "task new", "task answer", "task start", "task status", "task actualize", "task close", "pr labels", "batch release"];

/**
 * A REST request of the cloud's path: the payload — JSON on stdin (a description doesn't fit an argument); an error
 * response is an exception with its message, a missing resource (404) with `missing` — null; an empty answer (204) —
 * null.
 */
function rest(io: Io, route: string, o: { method?: string; payload?: unknown; missing?: boolean } = {}): Any {
  const what = `${o.method ?? "GET"} ${route}`;
  const out = io.gh(["api", ...(o.method ? ["-X", o.method] : []), route, ...(o.payload === undefined ? [] : ["--input", "-"])], o.payload === undefined ? undefined : JSON.stringify(o.payload));
  let res: Any;
  try {
    res = out.trim() ? JSON.parse(out) : null;
  } catch {
    throw new GhError(`${what}: the response is not JSON: ${out.slice(0, 200)}`);
  }
  if (res && !Array.isArray(res) && typeof res.message === "string" && res.id === undefined) {
    if (o.missing && String(res.status) === "404") return null;
    throw new GhError(`${what}: ${res.message}`);
  }
  return res;
}

/** A whole REST list: pages of 100 until a shorter one. */
function restList(io: Io, route: string): Any[] {
  const out: Any[] = [];
  for (let page = 1; page <= 100; page++) {
    const rows: Any[] = rest(io, `${route}${route.includes("?") ? "&" : "?"}per_page=100&page=${page}`) ?? [];
    out.push(...rows);
    if (rows.length < 100) break;
  }
  return out;
}

/** `owner/repo` of a REST `repository_url` (`https://api.github.com/repos/owner/repo`). */
const repoOfUrl = (url: string | undefined, slug: string) => /\/repos\/([^/]+\/[^/]+)$/.exec(url ?? "")?.[1] ?? slug;

/** A REST issue in the shape of the GraphQL answer: the state and its reason in upper case, labels with ids. */
function restIssueNode(i: Any): Any {
  return {
    id: i.node_id,
    databaseId: i.id,
    number: i.number,
    title: i.title,
    state: String(i.state).toUpperCase(),
    stateReason: i.state_reason ? String(i.state_reason).toUpperCase() : null,
    url: i.html_url,
    body: i.body ?? "",
    issueType: i.type?.name ? { name: i.type.name } : null,
    labels: { nodes: (i.labels ?? []).map((l: Any) => ({ id: l.node_id, name: l.name })) },
    milestone: i.milestone ? { id: i.milestone.node_id, number: i.milestone.number, title: i.milestone.title, open: i.milestone.open_issues ?? 0 } : null,
  };
}

/** The issue over REST (#603); not an issue (no such number, a PR) — null. */
function restIssue(io: Io, slug: string, number: number): Any {
  const i = rest(io, `repos/${slug}/issues/${number}`, { missing: true });
  return i && !i.pull_request ? restIssueNode(i) : null;
}

/** An issue in a REST list (sub-issues, blocked by) in the shape of the GraphQL answer. */
const restBrief = (x: Any, slug: string) => ({ id: x.node_id, databaseId: x.id, number: x.number, state: String(x.state).toUpperCase(), title: x.title, repository: { nameWithOwner: repoOfUrl(x.repository_url, slug) } });
const restSubIssues = (io: Io, slug: string, number: number) => ({ nodes: restList(io, `repos/${slug}/issues/${number}/sub_issues`).map((x) => restBrief(x, slug)) });

/** The issue's sub-issues, blocked by and epic over REST, in the shape of the GraphQL answer. */
function restLinks(io: Io, slug: string, number: number): { subIssues: Any; blockedBy: Any; parent: Any } {
  const parent = rest(io, `repos/${slug}/issues/${number}/parent`, { missing: true });
  return {
    subIssues: restSubIssues(io, slug, number),
    blockedBy: { nodes: restList(io, `repos/${slug}/issues/${number}/dependencies/blocked_by`).map((x) => restBrief(x, slug)) },
    parent: parent && restIssueNode(parent),
  };
}

/** The real `gh`: an exit code ≠ 0 is an exception with stderr. */
export function realGh(args: string[], stdin?: string): string {
  const r = spawnSync("gh", args, { input: stdin, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) {
    if ((r.error as NodeJS.ErrnoException).code === "ENOENT") throw new GhError("gh command not found; the gh CLI must be installed");
    throw new GhError(`gh ${args.slice(0, 2).join(" ")}: ${r.error.message}`);
  }
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

const ref = (p: Any): ProjectRef => ({ id: p.id, number: p.number, title: p.title, url: p.url, closed: !!p.closed });

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
    linked: (r.projectsV2?.nodes ?? []).filter(Boolean).map(ref),
  };
}

/** The repository's project: a linked one titled with the repository name, otherwise the first open linked one. */
const mainProject = (repo: State["repo"]) => repo.linked.find((p) => p.title === repo.name && !p.closed) ?? repo.linked.find((p) => !p.closed) ?? null;

export function loadState(io: Io, slug: string): State {
  const [owner, name] = slug.split("/") as [string, string];
  const repo = loadRepo(io, slug);
  const openIssues = pages<{ id: string; number: number }>((after) => graphql(io, Q.RepoIssues, { owner, name, after }).repository.issues);
  const main = mainProject(repo);
  const labels = loadLabels(io, slug);
  return { repo, project: main ? loadProject(io, main.id) : null, openIssues, labels, labelIssues: mergedIssues(io, slug, labels), decisions: loadDecisions(io, slug), merge: loadMerge(io, slug) };
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
 * `tests/standards/check-run-state`.
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
  const o = sets.find((x) => x?.name === RULESET) ?? sets.find((x) => x?.name === FORMER_RULESET);
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

/** Tasks of old labels whose name is taken (by another label or an old label earlier in the list) — fix merges them. */
function mergedIssues(io: Io, slug: string, labels: Label[]): State["labelIssues"] {
  const [owner, name] = slug.split("/") as [string, string];
  const seen = new Set(labels.filter((l) => !legacyDecision(l.name)).map((l) => l.name));
  const out: State["labelIssues"] = {};
  for (const l of labels) {
    const old = legacyDecision(l.name);
    if (!old) continue;
    if (seen.has(old.name)) out[l.id] = pages<{ id: string; number: number }>((after) => graphql(io, Q.LabelIssues, { owner, name, label: l.name, after }).repository.label.issues);
    seen.add(old.name);
  }
  return out;
}

function loadLabels(io: Io, slug: string): Label[] {
  // the cloud (#603) — REST: the labels without their open tasks (task new doesn't need them)
  if (inCloud(io)) return restList(io, `repos/${slug}/labels`).map((l) => ({ id: l.node_id, name: l.name, color: l.color, description: l.description ?? null, open: { total: 0, numbers: [] } }));
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
  const r = inCloud(io) ? restSpecTree(io, slug) : (graphql(io, Q.SpecDecisions, { owner, name })?.repository ?? {});
  const dirs = (t: Any): string[] => (t?.entries ?? []).filter((e: Any) => e.type === "tree").map((e: Any) => e.name as string);
  const names = { capability: dirs(r.capabilities), standard: dirs(r.standards), architecture: dirs(r.architecture) };
  let modelError: string | null = null;
  if (r.model) {
    const mods = modelModules(r.model.text ?? "");
    if (typeof mods === "string") modelError = mods;
    else names.architecture.push(...Object.keys(mods));
  }
  for (const k of DECISION_KINDS) names[k] = [...new Set(names[k])].sort();
  return { names, modelError };
}

/** SpecDecisions over the REST contents of the default branch — the cloud (#603): folders as `tree` entries, the model's text. */
function restSpecTree(io: Io, slug: string): Any {
  const dir = (kind: DecisionKind) => {
    const entries = rest(io, `repos/${slug}/contents/tests/${DECISIONS[kind].dir}`, { missing: true });
    return Array.isArray(entries) ? { entries: entries.map((e: Any) => ({ name: e.name, type: e.type === "dir" ? "tree" : "blob" })) } : null;
  };
  const model = rest(io, `repos/${slug}/contents/${MODEL_PATH}`, { missing: true });
  return { capabilities: dir("capability"), standards: dir("standard"), architecture: dir("architecture"), model: model?.content ? { text: Buffer.from(model.content, "base64").toString("utf8") } : null };
}

/**
 * `capability:billing` → the decision's kind and name; anything else — null. An old-form label or the kind of a new
 * decision in `--labels`.
 */
export function legacyDecision(label: string): { kind: DecisionKind; name: string } | null {
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

/** All discrepancies with the canon by item; each has fix steps. No project — only the linking item. */
export function analyze(s: State): Check[] {
  const p = s.project;
  const checks: Check[] = [];
  const add = (key: string, title: string) => {
    const c: Check = { key, title, problems: [], notes: [] };
    checks.push(c);
    return Object.assign((text: string, ...steps: Step[]) => c.problems.push({ text, steps }), { note: (text: string) => c.notes.push(text), skip: (why: string) => void (c.skip = why) });
  };

  const link = add("link", `Project linked to the repository and named ${q(s.repo.name)}`);
  // the default-branch rule and the merge method don't depend on the project
  const merge = () => {
    if (!s.merge) return;
    analyzeMerge(s.merge, s.repo.id, add("merge", `Merge into ${s.merge.branch} — only with green required checks`));
    analyzeMethod(s.merge, s.repo.nameWithOwner, add("method", `PR merge method — rebase only`));
  };
  if (!p) {
    link("no open project is linked to the repository", { kind: "api", text: `find, copy from the template or create project ${q(s.repo.name)} and link it to ${s.repo.nameWithOwner}` });
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
      const extra = v.columns.filter((f) => !c.columns!.includes(columnKey(f))).map((f) => q(f.name));
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

  // Fields: four numeric ones; a field in another dictionary language is renamed with the same id (the tasks' values are
  // kept); no custom fields beyond the canon; in an organization Priority is an issue field.
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
  const missing = s.openIssues.filter((i) => !inProject.has(i.id));
  if (missing.length) open(`not in the project: ${nums(missing)}`, api(`add to the project ${nums(missing)}`, ...missing.map((i) => ({ op: "AddItem", input: { projectId: p.id, contentId: i.id } }))));
  const noStatus = issues.filter((it) => it.issue!.state === "OPEN" && !it.status);
  if (noStatus.length) open(`without ${STATUS}: ${nums(noStatus.map((it) => it.issue!))}`, ...(statusReady ? [api(`${STATUS} ${q(N.status.backlog)}: ${nums(noStatus.map((it) => it.issue!))}`, ...noStatus.map((it) => setStatus(it, N.status.backlog)))] : []));

  // Decision labels: by the spec tree and the model of the default branch. Deleting, renaming by a guess, merging, making
  // a regular label a decision one — only with --confirm: the label is on tasks. One extra and one missing of the same
  // kind — a renamed folder, not two decisions. The old form `kind:name` → name — fix does it itself, decision or not:
  // tasks keep the label, there's no guess. A label without a decision on an open task is a new decision (task new sets
  // it before the PR): an ○ line, not deleted and not renamed by a guess — that would take it away from the task. A
  // slice label with a decision's name is a different slice of tasks: an ○ line, fix doesn't touch it, and the decision
  // stays without a label (the name is taken).
  const labels = add("labels", "Decision labels — the decision's name, the kind by color; by the spec tree and the model of the default branch");
  const d = s.decisions;
  if (d.modelError) labels(`model ${MODEL_PATH} doesn't load — module labels aren't checked: ${d.modelError}`);
  const want = decisionsByName(d);
  // the model wasn't read — it's unknown which modules exist: architecture labels aren't deleted or re-described
  const unsure = (kinds: DecisionKind[]) => !!d.modelError && kinds.includes("architecture");
  const taken = new Map(s.labels.filter((l) => !legacyDecision(l.name)).map((l) => [l.name, l]));
  const orphans: { label: Label; kinds: DecisionKind[] }[] = [];
  const dimensions = new Map<string, string[]>();
  for (const l of s.labels) {
    const old = legacyDecision(l.name);
    if (!old) continue;
    const to = decisionLabel(old.name, want.get(old.name) ?? [old.kind]);
    const into = taken.get(old.name);
    if (!into) {
      taken.set(old.name, { ...l, ...to });
      labels(`label ${q(l.name)} of the old form \`kind:name\``, api(`rename label ${q(l.name)} → ${q(old.name)} (tasks keep it)`, { op: "UpdateLabel", input: { id: l.id, ...to } }));
      continue;
    }
    const issues = s.labelIssues[l.id] ?? [];
    labels(`label ${q(l.name)} of the old form, label ${q(old.name)} already exists`, {
      kind: "confirm",
      text: `merge label ${q(l.name)} into ${q(old.name)}: ${issues.length ? `${nums(issues)} get ${q(old.name)}, ` : ""}the old one is deleted`,
      mutations: [...issues.map((i) => ({ op: "AddLabels", input: { labelableId: i.id, labelIds: [into.id] } })), { op: "DeleteLabel", input: { id: l.id } }],
    });
  }
  for (const l of s.labels) {
    if (legacyDecision(l.name)) continue;
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
  // the input carries `name: RULESET` — the same edit renames a ruleset under the former name
  const named = own.name === RULESET ? q(RULESET) : `${q(own.name)} → ${q(RULESET)}`;
  const step: Step = { kind: "api", text: `ruleset ${named}: default branch, required ${list(want) || "—"}, bypass — admin`, mutations: [{ op: "UpdateRuleset", input: { repositoryRulesetId: own.id, ...rulesetInput(want) } }] };
  const why: string[] = [];
  if (own.name !== RULESET) why.push(`ruleset ${q(own.name)} — the flow's former name: fix renames it to ${q(RULESET)}`);
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

export function cmdFix(io: Io, slug: string, opts: { confirm: boolean; template: string | null }): number {
  const done: string[] = [];
  const failed: string[] = [];
  const tried = new Set<string>();
  const sticky: Step[] = [];
  let s = loadState(io, slug);
  // Rounds: a step may open the next one (a new Status field → the tasks' statuses); a step isn't done twice.
  for (let round = 0; round < 5; round++) {
    if (!s.project) {
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
    const all = analyze(s).flatMap((c) => c.problems.flatMap((pr) => pr.steps));
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
  io.out("Summary:");
  const ok = report(io, s, checks);
  return ok && !failed.length && !ui.length && !confirm.length ? 0 : 1;
}

// ----------------------------------------------------------------------------
// Tasks
// ----------------------------------------------------------------------------

interface Issue {
  id: string;
  /** Read in the cloud (#603): the REST id (sub-issues and blocked by take it) and the issue's route — its writes go there. */
  databaseId?: number;
  rest?: string;
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
  if (inCloud(io)) return restLoadIssue(io, slug, number);
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

/** loadIssue in the cloud (#603) — the repository's REST: no project items, PRs and Priority (an issue field). */
function restLoadIssue(io: Io, slug: string, number: number): Issue {
  const i = restIssue(io, slug, number);
  if (!i) throw new GhError(`no issue #${number} in ${slug}`);
  const l = restLinks(io, slug, number);
  return {
    id: i.id,
    databaseId: i.databaseId,
    rest: `repos/${slug}/issues/${number}`,
    number: i.number,
    title: i.title,
    state: i.state,
    stateReason: i.stateReason,
    url: i.url,
    type: i.issueType?.name ?? null,
    labels: i.labels.nodes.map((x: Any) => x.name),
    parent: l.parent ? { id: l.parent.id, number: l.parent.number } : null,
    subIssues: l.subIssues.nodes.map((x: Any) => ({ number: x.number, state: x.state, title: x.title })),
    blockers: l.blockedBy.nodes.map((b: Any) => ({ number: b.number, state: b.state, repo: b.repository.nameWithOwner })),
    milestone: i.milestone,
    prs: [],
    items: [],
    priority: null,
  };
}

interface TaskCtx {
  slug: string;
  repo: State["repo"];
  project: Project;
  status: Field;
}

/**
 * The repository and its project with Status by the canon: without them a task can't be created by the canon — run
 * project fix first. If the Status options are not in the project language but in another dictionary language (the
 * script wasn't called from the project checkout; the language changed and there was no fix yet), the task is handled
 * in the board's language: `project check` checks the language, not every command.
 */
function taskContext(io: Io, slug: string): TaskCtx {
  const repo = loadRepo(io, slug);
  const main = mainProject(repo);
  if (!main) throw new GhError(`no project is linked to ${slug} — github project fix first`);
  const project = loadProject(io, main.id, false);
  const status = project.fields.find((f) => f.name === STATUS && f.options);
  const onBoard = (n: Names) => !!status && [n.status.backlog, n.status.inProgress, n.status.done].every((name) => status.options!.some((o) => o.name === name));
  const board = onBoard(N) ? N : locale.everyNames().find(onBoard);
  if (!status || !board) throw new GhError(`the project's ${STATUS} is not per the canon — github project fix first`);
  N = board;
  return { slug, repo, project, status };
}

const isEpic = (i: Issue, org: boolean) => (org ? locale.every((n) => n.issueTypes.epic).includes(i.type ?? "") : i.labels.includes(EPIC_LABEL));
const itemIn = (ctx: TaskCtx, i: Pick<Issue, "items">) => i.items.find((it) => it.projectId === ctx.project.id) ?? null;

function setStatus(io: Io, ctx: TaskCtx, itemId: string, name: string): void {
  const optionId = ctx.status.options!.find((o) => o.name === name)!.id;
  mutate(io, { op: "SetItemStatus", input: { projectId: ctx.project.id, itemId, fieldId: ctx.status.id, value: { singleSelectOptionId: optionId } } });
}

/**
 * The task's item in the project; none — add it. The project may have added the task itself (projectV2Ids in
 * createIssue, auto-add) while reading doesn't show it yet: addProjectV2ItemById then answers "Content already
 * exists" — re-read after a pause.
 */
function ensureItem(io: Io, ctx: TaskCtx, i: Pick<Issue, "id" | "number" | "items">): { id: string; added: boolean } {
  const it = itemIn(ctx, i);
  if (it) return { id: it.id, added: false };
  try {
    return { id: mutate(io, { op: "AddItem", input: { projectId: ctx.project.id, contentId: i.id } }).addProjectV2ItemById.item.id, added: true };
  } catch (e) {
    if (!/already exists/i.test((e as Error).message)) throw e;
  }
  for (let k = 0; k < 5; k++) {
    (io.sleep ?? pause)(1000);
    const again = itemIn(ctx, loadIssue(io, ctx.slug, i.number));
    if (again) return { id: again.id, added: false };
  }
  throw new GhError(`#${i.number} is already in the project, but its item isn't visible — retry: github task status ${i.number} <status>`);
}

/**
 * The personal configuration directory — `ELVES_CONFIG_DIR`, otherwise `~/.config/elves`: one expression for all
 * scripts (the Elves `config-dir` standard) rather than a shared module — github imports no other skill
 * (tests/standards/skill-imports). The flow's former names are read for the transition: `AI_DEV_CONFIG_DIR` — a
 * variable the owner may have set in the profile; `~/.config/ai-dev` — the directory of a machine before `update -g`
 * moved it, while the new one doesn't exist; a clean machine gets the new one. est
 * moves the old `~/.claude/est` into the directory only while the directory doesn't exist (est.ts, `ensureConfigDir`):
 * creating it here first would leave est without its registry and prices. Before the move the configuration is the
 * old directory: the pins move along with it.
 */
function configDir(env: Io["env"]): string {
  const home = env["HOME"] || os.homedir();
  const dir = env["ELVES_CONFIG_DIR"] || env["AI_DEV_CONFIG_DIR"] || [path.join(home, ".config", "elves"), path.join(home, ".config", "ai-dev")].find((d) => existsSync(d)) || path.join(home, ".config", "elves");
  if (existsSync(dir)) return dir;
  const legacy = path.join(home, ".claude", "est");
  // lstat: a symlink in place of the old directory — the move has already happened
  return lstatSync(legacy, { throwIfNoEntry: false })?.isDirectory() ? legacy : dir;
}

/** The session pin file — `<config directory>/sessions/<session id>`; the session isn't identified — null. */
function pinFile(io: Io): string | null {
  const id = io.env["CLAUDE_CODE_SESSION_ID"];
  return id ? path.join(configDir(io.env), "sessions", id) : null;
}

/**
 * The session pin: `owner/repo#N` — the task, anything else — not a pin. est has the same parse: github imports no other
 * skill (tests/standards/skill-imports, tests/standards/session-pin).
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
  return `the question to the owner «queue #${number}?» — yes: a background subagent in its own worktree, its prompt: ${executorPrompt(slug, number, epic)}`;
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
  // not a pin — the session is free for est and the dashboard too: the file takes the task
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
 * The worktree — the checkout the executor called its assignment in (#533): the queue keeps it while the task is open. A
 * cloud executor's (`--assignment N --cloud`, #609) — `CLOUD_HANDOUT` in its place: the dispatcher printed its brief,
 * there is no worktree, and the queue names the wait for the task's closing. An app executor session's (`--assignment N
 * --session`, #624) — `SESSION_HANDOUT`: the dispatcher printed its prompt, the app makes the session's worktree later.
 */
const handedOutFile = (io: Io) => {
  const file = dispatcherFile(io);
  return file && `${file}.tasks`;
};

/** A hand-out: the task and its executor's worktree; the assignment called outside a checkout, a cloud or a session one — null. */
interface HandOut {
  number: number;
  worktree: string | null;
  /**
   * Who executes it: a subagent of this session; a cloud session (#609) — the dispatcher waits for the task's closing; an
   * app session (#624) — the end of each of its turns comes as the app's note.
   */
  executor: "subagent" | "cloud" | "session";
}

/** A cloud executor's mark in place of the worktree: a worktree is an absolute path. */
const CLOUD_HANDOUT = "@cloud";
/** An app executor session's mark in place of the worktree (#624): the app makes the session's worktree after the hand-out. */
const SESSION_HANDOUT = "@session";

/** The repository's tasks handed out to this dispatcher's executors (`handedOutFile`); a line without a worktree — `null`. */
function handedOut(io: Io, slug: string): HandOut[] {
  const file = handedOutFile(io);
  return file ? handOutsIn(file, slug) : [];
}

/** The repository's hand-outs in a `<session id>.tasks` file; no file — none. */
function handOutsIn(file: string, slug: string): HandOut[] {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n").map((l) => l.trim());
  return lines
    .filter((l) => l.startsWith(`${slug}#`))
    .map((l) => {
      const [number, ...rest] = l.slice(slug.length + 1).split(" ");
      const worktree = rest.join(" ").trim();
      const executor: HandOut["executor"] = worktree === CLOUD_HANDOUT ? "cloud" : worktree === SESSION_HANDOUT ? "session" : "subagent";
      return { number: Number(number), worktree: executor === "subagent" ? worktree || null : null, executor };
    })
    .filter((h) => Number.isInteger(h.number) && h.number > 0);
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

/** The queue command of the dispatcher marker — its first line; the batch lines follow it. */
const queueCommandIn = (file: string) => readFileSync(file, "utf8").split("\n")[0]!.trim();

/** Today by the machine's clock — `YYYY-MM-DD`, the day of a batch branch's name. */
function localDay(): string {
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/**
 * The dispatcher's batch branch of the repository (epic #645). The first queue of a batch project (`batchProject` of
 * the locale module — `"batch": true` in `.agents/elves.json` of the checkout's root: a project setting, not the owner's
 * word on a run — a batch saves only with the project's CI that runs nothing on a PR into a batch branch)
 * creates it from a fresh origin/<base> and pushes it without a local branch — the dispatcher's checkout stays where it
 * is; `k` — the first free number of the day on origin, in the marker and among the recent PRs' branches: a released
 * batch's name taken again would read as released at once. The next queues take the same one: the marker keeps it
 * (`batchesIn`). Released — its release PR merged (#649), the branch may still be on origin — or gone from origin: the
 * next batch is `start`, called by the queue only with a ready task to hand out — a dispatcher that is done leaves no
 * empty batch branch on origin; its `+` line names the previous one. A released batch branch on origin without an open
 * PR into it goes (`dropReleased`). Not a batch project — null, no line; the session not identified, the directory not
 * the repository's checkout — a `○`/`!` line and null: the executors go into the default branch, as without batches.
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
    return io.out(`! batch: true, but ${io.cwd ?? process.cwd()} isn't a checkout of ${slug} — no batch branch: ${off}; the dispatcher works in the project folder`), none;
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
  // the first queue starts the batch at once; after a release — the queue, once it has a task to hand out
  return kept ? { batch: null, start } : { batch: start(), start: null };
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
 * project's `exactOptionalPropertyTypes` too (tests/standards/consumer-typecheck).
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
  /** The branch type (feat, fix, …) — also the estimate's type; a bug without it is fix, an epic has none. */
  branchType?: string | undefined;
}

/**
 * The task description skeleton without `--body` — canon sections in the project language: scenarios (an epic has
 * none — it has no code) and questions.
 */
export const taskTemplate = (type: string): string =>
  type === N.issueTypes.epic ? `${N.sections.questions}\n` : `${N.sections.scenarios}\n\n${N.sections.questions}\n`;

/**
 * Titles of the same task as `title`: itself and, for the project's flow update task (`updateTask` of a dictionary
 * language), its title before the flow's rename (`formerly.updateTask`) — an open update task of an earlier release is
 * the same task (#544).
 */
const sameTitles = (title: string): string[] => [title, ...locale.everyNames().filter((n) => n.updateTask === title).map((n) => n.formerly.updateTask)];

export function cmdTaskNew(io: Io, slug: string, task: NewTask): number {
  const [owner, name] = slug.split("/");
  // the cloud (#603): the repository's REST without the project — what it can't set, a line for a local session names
  const cloud = inCloud(io);
  const ctx = cloud ? null : taskContext(io, slug);
  const org = ctx ? ctx.repo.owner.org : rest(io, `repos/${slug}`).owner?.type === "Organization";

  // All checks come before creating: a task mustn't appear half-made. The type — a name in any dictionary language.
  const type = typeAliases()[(task.type ?? N.issueTypes.task).toLowerCase()];
  if (!type) throw new GhError(`--type: ${issueTypes().join(", ")}`);
  // the estimate needs the branch type: a bug's branch is fix/<N>-…, an epic has no branch and no estimate of its own
  const branchType = task.branchType?.trim().toLowerCase() || (type === N.issueTypes.bug ? "fix" : "");
  if (type === N.issueTypes.epic) {
    if (branchType) throw new GhError("an epic has no branch and isn't estimated — --branch-type is for a task or a bug");
  } else if (!branchType) throw new GhError(`--branch-type is required for a task: ${TASK_TYPES.join(", ")} — the type of its branch and of its estimate`);
  else if (!TASK_TYPES.includes(branchType)) throw new GhError(`--branch-type: ${TASK_TYPES.join(", ")}`);
  const o = { ...task, type, body: task.body.trim() ? task.body : taskTemplate(type) };
  // in the cloud the organization's types aren't readable (`orgs/…` — 403): the type goes by name, GitHub checks it
  const issueType = org && ctx ? ctx.repo.owner.issueTypes.find((t) => t.name === o.type && t.isEnabled) : undefined;
  if (org && ctx && !issueType) throw new GhError(`the organization has no enabled type ${q(o.type)} — github project fix`);
  // a personal account keeps neither a priority nor a Task/Bug type (#682): the flags are taken alike — the task is
  // created, a ○ line says what wasn't kept; a priority is still checked: a typo is a typo in either account
  if ((!org || !ctx) && o.priority && !(PRIORITIES as readonly string[]).includes(o.priority)) throw new GhError(`--priority: ${PRIORITIES.join(", ")}`);
  let priority: { fieldId: string; optionId: string; name: string } | null = null;
  if (org && ctx) {
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
  const restCtx = () => {
    const label = rest(io, `repos/${slug}/labels/${EPIC_LABEL}`, { missing: true });
    return { label: label && { id: label.node_id }, milestones: { nodes: restList(io, `repos/${slug}/milestones?state=open`).map((m) => ({ id: m.node_id, number: m.number, title: m.title })) } };
  };
  const repoCtx = !needCtx ? null : cloud ? restCtx() : graphql(io, Q.TaskContext, { owner, name }).repository;
  const milestone = o.milestone ? (repoCtx.milestones.nodes as { id: string; number?: number; title: string }[]).find((m) => m.title === o.milestone) : undefined;
  if (o.milestone && !milestone) throw new GhError(`no open milestone ${q(o.milestone)}`);
  // `search/issues` in the cloud is 403 («sessions are bound to their configured repositories») — a listing of the open ones
  const openIssues: Any[] | null = cloud ? restList(io, `repos/${slug}/issues?state=open`).filter((i) => !i.pull_request) : null;
  for (const same of sameTitles(title)) {
    const found: Any[] = openIssues ?? graphql(io, Q.IssueSearch, { q: `repo:${slug} is:issue is:open in:title "${same.replaceAll('"', "")}"` }).search.nodes;
    const dup = found.find((x) => x?.title === same);
    if (dup) throw new GhError(`an open task with this title already exists: #${dup.number}${same === title ? "" : ` (${q(same)} — its title before the flow's rename)`}`);
  }
  const wanted = [...new Set(o.labels ?? [])];
  // open questions in the description — the questions label: the dashboard and the queue find the task by it
  const open = questionItems(o.body).filter((x) => !x.answered).map((x) => x.k);
  const repoLabels = wanted.length || open.length ? loadLabels(io, slug) : [];
  const has = (n: string) => repoLabels.find((x) => x.name === n);
  // a decision by name comes from the default branch; `kind:name` — also a new one that isn't there yet
  const decisions = wanted.some((l) => legacyDecision(l) || !has(l)) ? loadDecisions(io, slug) : null;
  const inMain = decisions ? decisionsByName(decisions) : new Map<string, DecisionKind[]>();
  const plan = wanted.map((l) => {
    const dec = legacyDecision(l);
    const name = dec?.name ?? l;
    const label = has(name);
    const main = inMain.get(name) ?? [];
    const kinds = dec && !main.includes(dec.kind) ? [...main, dec.kind] : main;
    const dim = dec && label ? labelDimension(label.description) : null;
    if (dim) throw new GhError(`label ${q(name)} is slice ${q(dim)}, not a decision label: decision ${name} isn't labeled; the slice label — --labels ${name}`);
    if (!label && !kinds.length) {
      throw new GhError(`no label ${q(l)} in the repository and no decision ${l} in the default branch; a new decision — kind:name (${DECISION_KINDS.map((k) => `${k}:${l}`).join(", ")})`);
    }
    return { name, label, kinds, decision: dec !== null || (label ? labelKinds(label.description) !== null : true), fresh: dec && !main.includes(dec.kind) ? `${name} — new decision: ${decisionPath(dec.kind, name)} is not in the default branch yet` : null };
  });

  const done: string[] = [];
  // a new label of the repository — its id; in the cloud over REST
  const createLabel = (label: { name: string; color: string; description: string }): string =>
    ctx ? (mutate(io, { op: "CreateLabel", input: { repositoryId: ctx.repo.id, ...label } }).createLabel.label.id as string) : rest(io, `repos/${slug}/labels`, { method: "POST", payload: label }).node_id;
  // the issue's labels: GraphQL takes their ids, REST — their names
  const labels: { id: string; name: string }[] = [];
  if (issueType || (org && !ctx)) done.push(`type ${q(o.type)}`);
  if (!org && o.type === N.issueTypes.epic) {
    let labelId: string | undefined = repoCtx.label?.id;
    if (!labelId) {
      labelId = createLabel(epicLabel());
      done.push(`created label ${q(EPIC_LABEL)}`);
    }
    labels.push({ id: labelId, name: EPIC_LABEL });
    done.push(`label ${q(EPIC_LABEL)} — the type in a personal account`);
  }
  if (plan.length) {
    for (const x of plan) {
      let id = x.label?.id;
      if (!id) {
        id = createLabel(decisionLabel(x.name, x.kinds));
        done.push(`created label ${q(x.name)}`);
      }
      labels.push({ id, name: x.name });
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
    if (!labels.some((l) => l.id === id)) labels.push({ id, name: N.labels.questions });
    done.push(`label ${q(N.labels.questions)} — open questions in the description: ${open.join(", ")}`);
  }
  let created: { id: string; databaseId?: number; number: number; title: string; url: string; projectItems?: Any };
  if (ctx) {
    const input: Record<string, unknown> = { repositoryId: ctx.repo.id, title, body: o.body, projectV2Ids: [ctx.project.id] };
    if (issueType) input["issueTypeId"] = issueType.id;
    if (labels.length) input["labelIds"] = labels.map((l) => l.id);
    if (milestone) input["milestoneId"] = milestone.id;
    if (epic) input["parentIssueId"] = epic.id;
    if (priority) input["issueFields"] = [{ fieldId: priority.fieldId, singleSelectOptionId: priority.optionId }];
    created = mutate(io, { op: "CreateIssue", input }).createIssue.issue;
    // We set Status ourselves, without waiting for the "Item added to project" workflow.
    const listed = (created.projectItems?.nodes ?? []).map((it: Any) => ({ id: it.id, projectId: it.project.id, status: null }));
    const item = ensureItem(io, ctx, { id: created.id, number: created.number, items: listed }).id;
    setStatus(io, ctx, item, N.status.backlog);
    done.push(`project ${q(ctx.project.title)}: ${STATUS} ${q(N.status.backlog)}`);
  } else {
    const payload: Record<string, unknown> = { title, body: o.body };
    if (org) payload["type"] = o.type;
    if (labels.length) payload["labels"] = labels.map((l) => l.name);
    if (milestone) payload["milestone"] = milestone.number;
    const i = rest(io, `repos/${slug}/issues`, { method: "POST", payload });
    created = { id: i.node_id, databaseId: i.id, number: i.number, title: i.title, url: i.html_url };
    // REST has no parent in the issue's creation — the epic takes it as its sub-issue by the REST id
    if (epic) rest(io, `repos/${slug}/issues/${epic.number}/sub_issues`, { method: "POST", payload: { sub_issue_id: created.databaseId } });
  }
  if (priority) done.push(`${PRIORITY} ${q(priority.name)}`);
  if (epic) done.push(`subtask of epic #${epic.number}`);
  for (const b of blockers) {
    if (b.state !== "OPEN") {
      done.push(`#${b.number} is closed — doesn't block, skipped`);
      continue;
    }
    if (ctx) mutate(io, { op: "AddBlockedBy", input: { issueId: created.id, blockingIssueId: b.id } });
    else rest(io, `repos/${slug}/issues/${created.number}/dependencies/blocked_by`, { method: "POST", payload: { issue_id: b.databaseId } });
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
  if (!org && o.priority) io.out(`○ ${PRIORITY} ${q(o.priority)} isn't kept: a personal account has no issue fields`);
  if (!org && task.type !== undefined && o.type !== N.issueTypes.epic) io.out(`○ type ${q(o.type)} isn't kept: a personal account has no issue types, only an epic gets its label`);
  for (const l of epicLabels) io.out(l);
  const isEpicType = o.type === N.issueTypes.epic;
  if (!ctx) {
    // the project and the estimate (est reads the analogs' actuals from the project, it refuses in the cloud) — a local
    // session's commands; Priority — an issue field, GraphQL only
    const n = created.number;
    const local = [`github task status ${n} "${N.status.backlog}" (the project, ${STATUS})`, ...(isEpicType ? [] : [`est estimate ${n} --type ${branchType} --write (${q(N.fields.estimate)})`])];
    const want = org ? (o.priority ?? DEFAULT_PRIORITY) : null;
    if (want) local.push(`${PRIORITY} ${q(want)}${epic ? ` and no lower at epic #${epic.number}` : ""} — on the issue page`);
    io.out(`Next: the cloud has no GitHub Projects (docs/cloud-sessions.md) — a local session: ${local.join("; ")}.`);
  }
  if (isEpicType) {
    io.out(`Next: an epic isn't estimated — its ${q(N.fields.estimate)} is the sum of its subtasks' estimates.`);
    // an epic's work goes to the dispatcher on the owner's "yes" (#546), not to a session card per subtask
    io.out(
      `Next: once its subtasks are created — the question to the owner «run the dispatcher on epic #${created.number}?»; ` +
        `yes — bun --no-env-file ${import.meta.path} task queue --epic ${created.number} --repo ${slug} in this session, its executors — background subagents.`,
    );
    return 0;
  }
  if (ctx) runEstimate(io, slug, created.number, branchType);
  if (epic) io.out(`Next: ${q(N.fields.estimate)} of epic #${epic.number} — recompute as the sum of its subtasks' estimates.`);
  // a session with a pinned task won't take a new one into work (pinTask): the owner decides whether to queue it
  const held = pinnedTask(io)?.task;
  if (held) io.out(`Next: the session runs ${held.slug}#${held.number}; #${created.number} isn't taken here — ${queueQuestion(slug, created.number, epic?.number ?? null)}`);
  return 0;
}

export function cmdTaskStatus(io: Io, slug: string, number: number, name: string, branch?: string): number {
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
  const item = ensureItem(io, ctx, issue);
  setStatus(io, ctx, item.id, status);
  io.out(`+ #${issue.number}: ${STATUS} ${q(status)}${item.added ? " (added to the project)" : ""}`);
  const code = branch === undefined || renameBranch(io, slug, branch) ? 0 : 1;
  if (!issue.parent) return code;
  const epic = loadIssue(io, slug, issue.parent.number);
  const epicStatus = itemIn(ctx, epic)?.status ?? null;
  if (status === N.status.inProgress && epic.state === "OPEN" && (epicStatus === null || epicStatus === N.status.backlog)) {
    setStatus(io, ctx, ensureItem(io, ctx, epic).id, N.status.inProgress);
    io.out(`+ epic #${epic.number}: ${STATUS} ${q(N.status.inProgress)} — the first subtask is taken`);
  }
  if (status === N.status.inProgress && epic.state === "CLOSED") io.out(`Next: epic #${epic.number} is closed, but a subtask is in work again — reopen it (and its milestone, if closed).`);
  if (status === N.status.done && epic.state === "OPEN" && epic.subIssues.length && epic.subIssues.every((x) => x.state === "CLOSED")) {
    io.out(`Next: all subtasks of epic #${epic.number} are closed — close the epic and set it to ${q(N.status.done)}.`);
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
  io.out(`✅ project check: ${s.repo.nameWithOwner} per the canon`);
  if (file) {
    mkdirSync(path.dirname(file), { recursive: true });
    // the configuration directory may be a personal git checkout (ELVES_PRIVATE) — markers aren't committed into it
    writeFileSync(path.join(path.dirname(file), ".gitignore"), "*\n");
    appendFileSync(file, `${slug}\n`);
  }
  return true;
}

/** The numbered items of the description's scenarios section — the future `it` names; no section — null. */
export function scenarioItems(body: string, heading: string): string[] | null {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => l.trim().toLowerCase() === heading.toLowerCase());
  if (start < 0) return null;
  const end = lines.findIndex((l, k) => k > start && /^#{1,2}\s/.test(l));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .map((l) => /^\s*\d+[.)]\s+(.+)$/.exec(l)?.[1]?.trim())
    .filter((x): x is string => Boolean(x));
}

/**
 * Taking a task in one call (#666) instead of ~11 flow turns: `project check` (once per session), the task as `task
 * show` prints it, then the stops before any change — open questions of the task or its epic (they are asked first,
 * AGENTS.md, "Open questions"), parallel work (an open PR of the task or its branch `*\/N-*` that isn't this checkout's
 * — continue it or wait for its merge); then `task status N "In progress" --branch`, the estimate when the task has
 * none (`--branch` gives the type) and what the agent needs next: the session name, the branch, the scenarios and, in
 * Claude Code, one `ToolSearch` line for the app tools the flow calls. Code 1 — stopped, the task isn't taken.
 */
export function cmdTaskStart(io: Io, slug: string, number: number, branch?: string): number {
  if (branch !== undefined && (taskBranch(branch)?.issue !== number || !TASK_SLUG_RE.test(branch))) {
    throw new GhError(`--branch ${q(branch)}: expected a branch of #${number} by the canon — [<area>/]<type>/${number}-<slug>, type ${TASK_TYPES.join("|")}, slug — Latin kebab-case`);
  }
  if (!projectChecked(io, slug)) return io.out(`Next: github project fix, then task start ${number} again — the task isn't taken`), 1;
  const t = showTask(io, slug, number);
  if (t.epic) throw new GhError(`#${number} is an epic — it isn't taken into work: the question to the owner «run the dispatcher on epic #${number}?», then task queue --epic ${number}`);
  if (t.state !== "OPEN") throw new GhError(`#${number} is closed — reopen it first (gh issue reopen ${number}), then task start`);
  for (const line of t.lines) io.out(line);
  const asked = [t.open.length ? `#${number}: ${t.open.join(", ")}` : "", t.epicOpen?.ks.length ? `epic #${t.epicOpen.number}: ${t.epicOpen.ks.join(", ")}` : ""].filter(Boolean);
  if (asked.length) {
    io.out(`! open questions — ${asked.join("; ")}: ask the owner all of them in one message, with options and a recommendation (auto mode — task answer <N> <k> "<answer>" --auto by the recommendation), then task start ${number} again — the task isn't taken`);
    return 1;
  }
  const current = git(io, io.cwd, "branch", "--show-current").stdout.trim();
  const mine = (head: string) => head !== "" && head === current;
  const prs = [...t.prs.filter((p) => !p.merged && p.state === "OPEN"), ...(inCloud(io) ? [] : unlinkedPrs(io, slug, number).batched.filter((p) => !p.merged && p.state === "OPEN"))];
  const parallel = [...new Set([...prs.filter((p) => !mine(p.head)).map((p) => `PR #${p.number} (${p.head})`), ...taskBranchesHere(io, slug, number).filter((b) => b !== current).map((b) => `branch ${b}`)])];
  if (parallel.length) {
    io.out(`! #${number} is in work elsewhere — ${parallel.join(", ")}: continue that work or wait for its merge — the task isn't taken a second time`);
    return 1;
  }
  const code = cmdTaskStatus(io, slug, number, N.status.inProgress, branch);
  if (!t.estimate && branch !== undefined) runEstimate(io, slug, number, taskBranch(branch)!.type);
  const now = git(io, io.cwd, "branch", "--show-current").stdout.trim();
  const scenarios = scenarioItems(t.body, N.sections.scenarios);
  io.out(`Next: the session name — «#${number} ${t.title}»`);
  io.out(now ? `Branch: ${now}` : `Branch: none — the task branch from a fresh origin/<base>${branch ? `: ${branch}` : ""}`);
  io.out(scenarios?.length ? `Scenarios: ${scenarios.length} in ${q(N.sections.scenarios)} — the future it names` : `○ no scenarios in ${q(N.sections.scenarios)} — a code task gets them in the description before code`);
  if (io.env["CLAUDECODE"] === "1") io.out(`ToolSearch select:${APP_TOOLS.join(",")}`);
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
  // "Item closed" would put a task closed without doing it into "Done" — it has no place in the project
  const item = itemIn(ctx, issue);
  if (item) {
    mutate(io, { op: "DeleteItem", input: { projectId: ctx.project.id, itemId: item.id } });
    io.out(`+ #${number} removed from project ${q(ctx.project.title)}`);
  }
  if (issue.parent) io.out(`Next: ${q(N.fields.estimate)} of epic #${issue.parent.number} — recompute as the sum of the remaining subtasks.`);
  return 0;
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
  checks: { green: number; pending: string[]; red: string[] } | null;
  why?: string | undefined;
}

/** The head's checks by name (`checkStates`): green (pass, skipping), still running, red (cancel, fail). */
function shownPr(p: Any, why?: string): ShownPr {
  const by = [...checkStates(rollupOf(p))];
  const of = (...states: CheckBucket[]) => by.filter(([, v]) => states.includes(v)).map(([k]) => k);
  return { number: p.number, state: p.state ?? "", merged: Boolean(p.merged), draft: Boolean(p.isDraft), head: p.headRefName ?? "", checks: by.length ? { green: of("pass", "skipping").length, pending: of("pending"), red: of("cancel", "fail") } : null, why };
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

/** An issue's comments over REST (#651) in the shape of `COMMENTS_SHOW`: the latest `COMMENTS_SHOWN`, oldest first. */
function restComments(io: Io, slug: string, number: number): Any {
  const all = restList(io, `repos/${slug}/issues/${number}/comments`);
  return { totalCount: all.length, nodes: all.slice(-COMMENTS_SHOWN).map((c) => ({ author: c.user ? { login: c.user.login } : null, createdAt: c.created_at, body: c.body ?? "" })) };
}

/**
 * IssueShow in the cloud (#603) — the repository's REST in the shape of the GraphQL answer: the issue, its epic with the
 * epic's tasks, sub-issues, blocked by, the comments of both (#651); no project (Projects v2 — 403) and no Priority (an
 * issue field, GraphQL only).
 */
function restIssueShow(io: Io, slug: string, number: number): Any {
  const i = restIssue(io, slug, number);
  if (!i) return null;
  const l = restLinks(io, slug, number);
  const parent = l.parent && { ...l.parent, subIssues: restSubIssues(io, slug, l.parent.number), comments: restComments(io, slug, l.parent.number) };
  return { ...i, ...l, comments: restComments(io, slug, number), parent };
}

/**
 * The task's PRs in the cloud (#603): GraphQL's links to the task aren't there — the latest open and merged PRs into the
 * default branch by the task branch or «Closes #N» in the body, as `unlinkedPrs`; an open one's head checks — REST
 * check-runs and commit statuses in the shape of `HEAD_CHECKS`, for `checkStates`.
 */
function restPrs(io: Io, slug: string, number: number): Any[] {
  const prs: Any[] = rest(io, `repos/${slug}/pulls?state=all&sort=updated&direction=desc&per_page=${RECENT_PRS}`) ?? [];
  const mine = prs.filter((p) => p.base?.ref === p.base?.repo?.default_branch && (p.state === "open" || p.merged_at) && prOfTask(p, number));
  return mine.map((p) => {
    const open = p.state === "open";
    const nodes = open ? restRollup(io, slug, p.head.sha).nodes : [];
    return { number: p.number, state: open ? "OPEN" : "MERGED", merged: !open, isDraft: Boolean(p.draft), headRefName: p.head?.ref ?? "", commits: { nodes: [{ commit: { statusCheckRollup: nodes.length ? { contexts: { nodes } } : null } }] } };
  });
}

/**
 * A commit's checks over REST in the shape of `HEAD_CHECKS` (`checkStates` reads them): its check-runs and the hosting's
 * commit statuses; `runs` — the check-runs as REST gives them (their ids are the Actions jobs' ids). `task show` in the
 * cloud (#603) and a batch's release (#650).
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
 * The flow's own comments — task show prints them in one line without the text (#651), by the kind: est's estimate and
 * actual (its `<!-- est {…} -->` and `<!-- fact {…} -->` markers: a human's «Estimate: …» isn't one), the epic
 * refresh's report and the script's fixes, task close's «closed by PR».
 */
const FLOW_COMMENTS: [kind: string, re: RegExp][] = [
  ["estimate", /<!--\s*est\s+\{/],
  ["actual", /<!--\s*fact\s+\{/],
  ["epic refresh report", templateStart((n) => n.actualize.report)],
  ["epic refresh, the script's fixes", templateStart((n) => n.actualize.mechanics)],
  ["closed by PR", templateStart((n) => n.comments.closedByPr)],
];
/** The State comment — a handoff of the work (AGENTS.md, "Project knowledge and handoff"): printed in full, not an answer. */
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
 * state, Status and estimate, the epic with its open questions and other open tasks, subtasks, open blockers, the PRs
 * with their checks (GitHub didn't link one yet — found by the branch or «Closes #N», as task close does), the
 * questions — open and answered, a comment that looks like an answer to an open one — a `?` line at the question, the
 * comments of the task and its epic (#651: an answer in a comment was lost — the executor asked again or answered
 * auto over it), and the description as is. Read-only.
 */
export function cmdTaskShow(io: Io, slug: string, number: number): number {
  for (const line of showTask(io, slug, number).lines) io.out(line);
  return 0;
}

/** What `task show` prints and what `task start` decides by: the lines, open questions of the task and its epic, the PRs. */
interface ShownTask {
  lines: string[];
  title: string;
  state: string;
  epic: boolean;
  estimate: boolean;
  body: string;
  open: number[];
  epicOpen: { number: number; ks: number[] } | null;
  prs: ShownPr[];
}

function showTask(io: Io, slug: string, number: number): ShownTask {
  const [owner, name] = slug.split("/");
  const cloud = inCloud(io);
  const i = cloud ? restIssueShow(io, slug, number) : graphql(io, Q.IssueShow, { owner, name, number })?.repository?.issue;
  if (!i) throw new GhError(`no issue #${number} in ${slug}`);
  const labels: string[] = (i.labels?.nodes ?? []).map((l: Any) => l.name);
  // a personal account has no issue types: an epic is the epic label
  const type: string | null = i.issueType?.name ?? (labels.includes(EPIC_LABEL) ? N.issueTypes.epic : null);
  const epic = type !== null && locale.every((n) => n.issueTypes.epic).includes(type);
  const items: Any[] = i.projectItems?.nodes ?? [];
  const values: Any[] = (items.find((it) => it.project?.title === name) ?? items[0])?.fieldValues?.nodes ?? [];
  const num = (field: (n: Names) => string) => values.find((v) => v?.__typename === "ProjectV2ItemFieldNumberValue" && locale.every(field).includes(v.field?.name));
  const status: string | null = values.find((v) => v?.field?.name === STATUS && v.name)?.name ?? null;
  const estimate = num((n) => n.fields.estimate);
  const actual = num((n) => n.fields.actual);
  const priority: string | null = (i.issueFieldValues?.nodes ?? []).find((v: Any) => v?.field?.name === PRIORITY)?.name ?? null;
  const reason: Record<string, string> = { NOT_PLANNED: ": not planned", DUPLICATE: ": duplicate" };
  const shownLabels = labels.filter((l) => !(l === EPIC_LABEL && !i.issueType));
  const facts = [
    type,
    i.state === "CLOSED" ? `closed${reason[i.stateReason] ?? ""}` : null,
    cloud ? "no project in the cloud (docs/cloud-sessions.md)" : !items.length ? "not in the project" : status ? `${STATUS} ${q(status)}` : `no ${STATUS}`,
    cloud ? null : estimate ? `${q(estimate.field.name)} ${estimate.number}` : `no ${q(N.fields.estimate)}`,
    actual ? `${q(actual.field.name)} ${actual.number}` : null,
    priority ? `${PRIORITY} ${priority}` : null,
    i.milestone ? `milestone ${q(i.milestone.title)}` : null,
    shownLabels.length ? `labels: ${shownLabels.join(", ")}` : null,
  ];
  const out = [`#${i.number} ${i.title} — ${i.url}`, facts.filter(Boolean).join(" · ")];
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
  const blockers: Any[] = (i.blockedBy?.nodes ?? []).filter((x: Any) => x.state === "OPEN");
  if (blockers.length) out.push(`Blocked by: ${blockers.map((x) => `${blockerRef(slug, { number: x.number, repo: x.repository?.nameWithOwner ?? slug })} ${q(x.title)}`).join(", ")}`);
  // an epic has no PR of its own
  if (!epic) {
    prs = (cloud ? restPrs(io, slug, number) : (i.closedByPullRequestsReferences?.nodes ?? []).filter(Boolean)).map((p: Any) => shownPr(p));
    if (!cloud && !prs.length && i.state === "OPEN") {
      for (const p of unlinkedPrs(io, slug, number).prs) {
        const pr = graphql(io, Q.PrShow, { owner, name, number: p.number })?.repository?.pullRequest;
        if (pr) prs.push(shownPr(pr, p.why));
      }
    }
    out.push(...(prs.length ? prs.map(prLine) : ["PR: none"]));
  }
  const lines = (i.body ?? "").trimEnd().split(/\r?\n/);
  const questions = questionItems(i.body ?? "");
  const open = questions.filter((x) => !x.answered).map((x) => x.k);
  const answered = questions.filter((x) => x.answered).map((x) => x.k);
  out.push(
    !questions.length
      ? "Questions: none"
      : !open.length
        ? `Questions: all answered (${answered.join(", ")})`
        : `Questions: open ${open.join(", ")}${answered.length ? `; answered ${answered.join(", ")}` : ""} — task answer ${number} <k> "<answer>" [--auto]`,
  );
  const comments = shownComments(i.comments);
  const answers = answerCandidates(open, comments.nodes);
  out.push(...open.filter((k) => answers.has(k)).map((k) => answerLine(number, k, answers.get(k)!)));
  out.push(...commentLines("Comments", comments));
  if (epicComments) out.push(...commentLines(`Epic #${i.parent.number} comments`, epicComments));
  if (lines.join("").trim()) out.push("", ...lines);
  return { lines: out, title: i.title, state: i.state, epic, estimate: Boolean(estimate), body: i.body ?? "", open, epicOpen, prs };
}

/**
 * The answer at question k of the questions section, in place of rewriting the description by hand: ✅ (with --auto —
 * `autoAnswer`) after the item's number and «**Answer:** …» (`est.answer`: est strips it from the description size) at
 * its end — on the same line for a one-line item, otherwise on a line of its own; the numbering doesn't change, the
 * rest of the description stays as is. No open questions left — the questions label is removed. An answered question
 * is refused: a changed answer is edited by hand.
 */
export function cmdTaskAnswer(io: Io, slug: string, number: number, k: number, answer: string, auto: boolean): number {
  const text = answer.trim().replace(/\s*\r?\n\s*/g, " ");
  if (!text) throw new GhError("task answer: expected the answer text after the question number");
  const [owner, name] = slug.split("/");
  const cloud = inCloud(io);
  const i = cloud ? restIssue(io, slug, number) : graphql(io, Q.IssueShow, { owner, name, number })?.repository?.issue;
  if (!i) throw new GhError(`no issue #${number} in ${slug}`);
  const body: string = i.body ?? "";
  const lines = body.split(/\r?\n/);
  const questions = questionItems(body);
  if (!questions.length) throw new GhError(`#${number}: no ${q(N.sections.questions)} section with numbered questions`);
  const question = questions.find((x) => x.k === k);
  if (!question) throw new GhError(`#${number}: no question ${k} in ${q(N.sections.questions)}; questions: ${questions.map((x) => x.k).join(", ")}`);
  if (question.answered) throw new GhError(`#${number}: question ${k} is already answered (✅) — a changed answer is edited by hand`);
  const reply = `**${N.est.answer}:** ${text}`;
  lines[question.first] = lines[question.first]!.replace(/^(\d+\.\s+)/, `$1${auto ? N.autoAnswer : "✅"} `);
  if (question.first === question.last) lines[question.first] += ` ${reply}`;
  else lines.splice(question.last + 1, 0, `${" ".repeat(`${k}. `.length)}${reply}`);
  const next = lines.join(body.includes("\r\n") ? "\r\n" : "\n");
  if (cloud) rest(io, `repos/${slug}/issues/${number}`, { method: "PATCH", payload: { body: next } });
  else mutate(io, { op: "UpdateIssue", input: { id: i.id, body: next } });
  io.out(`+ #${number}: question ${k} — ✅ and the answer in the description`);
  const open = questions.filter((x) => !x.answered && x !== question).map((x) => x.k);
  if (open.length) return io.out(`○ #${number}: open questions left: ${open.join(", ")}`), 0;
  const label: Any[] = (i.labels?.nodes ?? []).filter((l: Any) => locale.every((n) => n.labels.questions).includes(l.name));
  if (label.length) {
    if (cloud) for (const l of label) rest(io, `repos/${slug}/issues/${number}/labels/${encodeURIComponent(l.name)}`, { method: "DELETE" });
    else mutate(io, { op: "RemoveLabels", input: { labelableId: i.id, labelIds: label.map((l) => l.id) } });
    io.out(`+ #${number}: label ${label.map((l) => q(l.name)).join(", ")} removed — no open questions left`);
  }
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
  type?: string | undefined;
  priority?: string[] | undefined;
}

/** How many executors run at once by default: `slot` lets two heavy runs through, a third executor writes code meanwhile. */
export const QUEUE_EXECUTORS = 3;

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

/** The executor's prompt: the task first (`est` links the subagent's work by it), the whole assignment — from the script. */
function executorPrompt(slug: string, number: number, epic: number | null): string {
  return locale.fill(N.queue.prompt, {
    task: N.subagentPrompt.task,
    number,
    repo: slug,
    epic: epic === null ? "" : locale.fill(N.queue.epic, { epicWord: N.subagentPrompt.epic, epic }),
    command: `bun --no-env-file ${import.meta.path} task queue --assignment ${number} --repo ${slug}`,
  });
}

/**
 * A cloud executor's brief and the dispatcher's steps after it (`task queue --assignment N --cloud`, #609). The brief —
 * without local paths and `#` but at its task: numbers in the title and the epic go without it. A batch project (#648,
 * question 1 of the task) — the cloud executor isn't in the batch: its PR goes into the default branch with the full CI,
 * as before, the brief and `Next:` say so. A cloud session can't message a local one, the dispatcher learns of its end
 * only by the task's closing, and GitHub closes a task only by a merge into the default branch — in a batch the task
 * stays open till the release, and the wait would never end. Outside auto (#667) — the merge on the owner's «yes» in
 * the cloud session: it can't message the dispatcher.
 */
function cloudBrief(io: Io, slug: string, issue: Issue, batch: string | null, auto: boolean): void {
  const number = issue.number;
  const vars = {
    task: N.subagentPrompt.task,
    number,
    title: issue.title.replace(/#(\d)/g, "$1"),
    repo: slug,
    epic: issue.parent ? locale.fill(N.queue.cloudEpic, { epicWord: N.subagentPrompt.epic, epic: issue.parent.number }) : "",
    actual: N.est.cloud.actual.replace(/:$/, ""),
    state: N.comments.state,
    questions: N.sections.questions,
    batch: batch ?? "",
    cloudMode: auto ? N.queue.modeAuto : N.queue.cloudModeAsk,
  };
  const lines = [N.queue.cloud, ...(batch ? [N.queue.cloudBatch] : []), N.queue.cloudDoc, N.queue.repeats, N.queue.cloudClose, N.queue.cloudDispatcher, N.queue.cloudQuestion];
  for (const line of lines) io.out(locale.fill(line, vars));
  io.out(
    `Next: the lines above — the cloud session's first prompt as is, the session started from the project folder (the cloud starts from main); ` +
      (batch ? `a cloud executor isn't in the batch ${batch} — its PR goes into the default branch with the full CI: the dispatcher learns of its end only by the task's closing; ` : "") +
      `then as a background command: bash ${waitCi()} issue ${number} — a cloud session can't message a local one (docs/cloud-sessions.md), the task's closing is the signal: ` +
      `PASS — bun --no-env-file ${import.meta.path} task close ${number} (the actual with --write, ${STATUS}, the merged branch), then archive the executor's session in an auto project where the agent has the tool; ` +
      `TIMEOUT — the task's ${q(N.sections.questions)} and its ${q(N.comments.state)} comment, the executor's session, then the same wait again`,
  );
}

/**
 * The dispatcher's step for its executor sessions — the app's (`start_session`: another project's task) and cloud ones
 * (#621). In auto mode a session archives itself after the last line, but not always: it ended with a question whose
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
  const merged = recent.nodes.filter((p) => p.merged && p.baseRefName === batch);
  return (number, linked = []) => linked.find((p) => p.merged && p.base === batch)?.number ?? merged.find((p) => prOfTask(p, number))?.number;
}

/**
 * The dispatcher's queue: its ready tasks go to background executors (subagents), K at a time; the queue is re-read
 * after each answer, so tasks that appeared meanwhile are picked up. A session with its own task dispatches too (#546:
 * the owner's "yes" to an epic's dispatcher becomes work at once, without a new session) — its pin stays, its task is
 * in work. Ready — open, not an epic, not in work, no open blockers (other repositories' too), no external blocker
 * label; order — Priority, then the number. In work (`=`) — "In progress", an open PR (linked, or by the task branch and
 * "Closes #N" among recent PRs) named with its link, or handed out to an executor of this session (`handedOutFile`).
 * Marks the session as a dispatcher (`dispatcherFile`). A batch project (#648) — the batch branch first
 * (`dispatcherBatch`), its line in the marker: a task merged into it is `=` till the release, a blocker merged into it
 * doesn't hold. The batch's release (#649): nothing ready and every task in work merged into the batch — `Next:` names
 * `batch release`; its PR open — ready tasks are held (`○`), no new executors till its merge; red (#650) — `Next:`
 * names its guilty task by the labels and the fix (`redRelease`, `fixSteps`), the bisect — `batch release`'s. Before the queue —
 * finished agents' worktrees (`pruneAgentWorktrees`) but those of executors whose handed-out tasks are open and those
 * a subagent still works in. The last line names archiving finished executor sessions (`SESSION_ARCHIVE`); outside auto
 * (#667) — while executors are handed out or awaited — the merge's wait for the owner's «yes» too (`MERGE_ASK`).
 */
export function cmdTaskQueue(io: Io, slug: string, o: QueueFilter): number {
  const want = o.type === undefined ? undefined : typeAliases()[o.type.toLowerCase()];
  if (o.type !== undefined && (!want || want === N.issueTypes.epic)) throw new GhError(`--type: ${N.issueTypes.task} or ${N.issueTypes.bug}`);
  const bad = (o.priority ?? []).filter((p) => !(PRIORITIES as readonly string[]).includes(p));
  if (bad.length) throw new GhError(`--priority: ${PRIORITIES.join(", ")}, not ${bad.join(", ")}`);
  const ctx = taskContext(io, slug);
  const org = ctx.repo.owner.org;
  if (!org && (o.type !== undefined || o.priority?.length)) throw new GhError("--type and --priority — only in an organization: a personal account has no issue types and no Priority");
  let numbers: number[];
  if (o.epic !== undefined) {
    const epic = loadIssue(io, slug, o.epic);
    if (!isEpic(epic, org)) throw new GhError(`#${o.epic} is not an epic — --epic takes an epic`);
    if (epic.state !== "OPEN") throw new GhError(`epic #${o.epic} is closed`);
    numbers = epic.subIssues.filter((x) => x.state === "OPEN").map((x) => x.number);
  } else {
    const found = graphql(io, Q.IssueSearch, { q: `repo:${slug} is:issue is:open` }).search.nodes as Any[];
    if (found.length >= 100) io.out("○ the search gave 100 open tasks — the queue sees only them: narrow it with --epic");
    numbers = found.filter((x) => x?.state === "OPEN").map((x) => x.number);
  }
  const recent = recentPrs(io, slug);
  const openPr = openPrOf(io, slug, recent);
  const args = [o.epic !== undefined && `--epic ${o.epic}`, o.type !== undefined && `--type ${o.type}`, o.priority?.length && `--priority ${o.priority.join(",")}`].filter(Boolean).join(" ");
  const file = dispatcherFile(io);
  // the batch branch before the readiness: a blocker merged into it doesn't hold a task of the same batch (#648); the
  // next one after a release — after it, only with a task to hand out (nothing is merged into a new batch yet)
  const dispatched = dispatcherBatch(io, slug, recent, file);
  let batch = dispatched.batch;
  const inBatch = batch === null ? null : batchPrOf(recent, batch);
  // the batch's release is open (#649) — no new executors till its merge: what merges into the batch now would change
  // the release its CI checked
  const release = batch === null ? undefined : releasePrOf(recent, batch);
  const releasing = release?.state === "OPEN" ? (release.number as number) : null;
  const handed = handedOut(io, slug);
  /** Issue states the queue has read; a hand-out's task outside the queue is read when its worktree is up for removal. */
  const states = new Map<number, string>();
  const isOpen = (n: number) => {
    if (!states.has(n)) states.set(n, loadIssue(io, slug, n).state);
    return states.get(n) === "OPEN";
  };
  const ready: Issue[] = [];
  const running: string[] = [];
  const waiting: string[] = [];
  /** Of the tasks in work: merged into the batch and nothing else going — they wait only for the release (#649). */
  let settled = 0;
  for (const n of numbers.sort((a, b) => a - b)) {
    const i = loadIssue(io, slug, n);
    states.set(i.number, i.state);
    if (i.state !== "OPEN") continue;
    const label = `#${i.number} ${q(i.title)}`;
    if (isEpic(i, org)) {
      waiting.push(`○ ${label} — an epic: its tasks — task queue --epic ${i.number}`);
      continue;
    }
    if (want && typeAliases()[(i.type ?? "").toLowerCase()] !== want) continue;
    if (o.priority?.length && !o.priority.includes(i.priority ?? DEFAULT_PRIORITY)) continue;
    const status = itemIn(ctx, i)?.status ?? null;
    // the task is in work: In progress, an open PR (the executor waits for its CI — #513: it was ○ and the dispatcher
    // lost it from both lists), or handed out to an executor of this session that hasn't set In progress yet
    const pr = openPr(i);
    // merged into the batch branch (question 1 of epic #645): open and In progress till the release — not given out again
    const merged = inBatch?.(i.number, i.prs);
    const work = [
      status === N.status.inProgress ? q(N.status.inProgress) : "",
      pr === undefined ? "" : `open PR #${pr} https://github.com/${slug}/pull/${pr}`,
      merged === undefined ? "" : `PR #${merged} merged into ${batch} — the task closes with the batch's release`,
    ].filter(Boolean);
    const hand = handed.find((h) => h.number === i.number);
    // a cloud executor's wait for the task's closing dies with the app's process: the line names it, task resume — the queue
    if (!work.length && hand?.executor === "cloud") work.push(`handed out to a cloud executor of this session, its wait — a background command: bash ${waitCi()} issue ${i.number}`);
    // an app executor session (#624): the app continues the dispatcher at the end of each of its turns
    else if (!work.length && hand?.executor === "session") work.push("handed out to an app executor session of this session (start_session) — the end of each of its turns comes as the app's note");
    else if (!work.length && hand) work.push("handed out to an executor of this session");
    if (work.length) {
      running.push(`= ${label} — ${work.join(", ")}`);
      // merged into the batch, no open PR of it: its executor is done, the task waits for the release
      if (merged !== undefined && pr === undefined) settled++;
      continue;
    }
    // a blocker merged into this batch's branch doesn't hold its task: the executor branches from the batch (#648); a
    // blocker outside it — merged into another batch or not merged — holds, as without batches
    const batched = (b: Blocker) => inBatch !== null && b.repo.toLowerCase() === slug.toLowerCase() && inBatch(b.number) !== undefined;
    const blockers = i.blockers.filter((b) => b.state === "OPEN" && !batched(b)).map((b) => blockerRef(slug, b));
    const external = i.labels.find((l) => locale.every((n) => n.labels.externalBlocker).includes(l));
    if (status === N.status.done) waiting.push(`○ ${label} — ${STATUS} ${q(status)}, but the task is open`);
    else if (blockers.length) waiting.push(`○ ${label} — blocked by ${blockers.join(", ")}`);
    else if (external) waiting.push(`○ ${label} — ${externalBlocker(io, slug, i.number, external)}`);
    else if (releasing !== null) waiting.push(`○ ${label} — ready, held: the release of ${batch} is open (PR #${releasing}) — no new executors till its merge`);
    else ready.push(i);
  }
  ready.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.number - b.number);
  if (dispatched.start) {
    if (ready.length) batch = dispatched.start();
    else io.out(`○ no new batch branch: the previous one is released, nothing ready to hand out — a queue with a ready task starts it`);
  }
  if (file) {
    mkdirSync(path.dirname(file), { recursive: true });
    // the configuration directory may be a personal git checkout (ELVES_PRIVATE) — markers aren't committed into it
    writeFileSync(path.join(path.dirname(file), ".gitignore"), "*\n");
    // the batch lines after the queue command: other repositories' stay, this one's — the current batch
    const batches = [...batchesIn(file).filter((b) => b.repo.toLowerCase() !== slug.toLowerCase()), ...(batch ? [{ repo: slug, branch: batch }] : [])];
    writeFileSync(file, `bun --no-env-file ${import.meta.path} task queue ${args ? `${args} ` : ""}--repo ${slug}\n${batches.map((b) => `batch ${b.repo} ${b.branch}\n`).join("")}`);
  } else io.out("○ session not recognized (no CLAUDE_CODE_SESSION_ID) — not marked as a dispatcher: task status in the executors would pin their tasks");
  appWorktreeWarning(io);
  // the executor the dispatcher continues with SendMessage — an answered question, a restart — has no lock (#533)
  const executors = handed.flatMap((h) => (h.worktree === null ? [] : [{ number: h.number, worktree: realPath(h.worktree) }]));
  pruneAgentWorktrees(io, slug, (dir) => executors.some((h) => h.worktree === realPath(dir) && isOpen(h.number)));
  const scope = [o.epic !== undefined ? `epic #${o.epic}` : "open tasks", want && `type ${q(want)}`, o.priority?.length && `Priority ${o.priority.join("|")}`].filter(Boolean).join(", ");
  io.out(`Queue ${slug} (${scope}): ready ${ready.length}, ${q(N.status.inProgress)} ${running.length}, not ready ${waiting.length}`);
  for (const i of ready) {
    io.out(`+ #${i.number} ${q(i.title)}${org ? ` (${i.priority ?? DEFAULT_PRIORITY})` : ""}`);
    io.out(`  ${executorPrompt(slug, i.number, i.parent?.number ?? null)}`);
  }
  for (const line of running) io.out(line);
  for (const line of waiting) io.out(line);
  const releaseCommand = `bun --no-env-file ${import.meta.path} batch release --repo ${slug}`;
  // the owner's word «release» — the same command with live executors: they go on, their PRs wait for the release
  // (question 2 of epic #645)
  const now = settled ? `; the owner's word to release now — ${releaseCommand}: what is merged into ${batch} goes, the live executors go on, no new ones till its merge` : "";
  // outside auto an executor's merge is the owner's «yes» (#667)
  const ask = locale.autoProject(io.cwd ?? process.cwd()) ? "" : `; ${MERGE_ASK}`;
  // a red release (#650): its guilty task by the labels — the fix; the bisect is batch release's, the queue names it
  const checks = release && releasing !== null ? releaseChecks(io, slug, release) : null;
  if (release && batch && checks?.state === "red") {
    for (const line of fixSteps(slug, batch, release, checks, redRelease(io, slug, batch, recent.base, release, openInto(recent, batch), checks, false), false)) io.out(line);
  } else if (releasing !== null) {
    io.out(
      `Next: the release of ${batch} is open — PR #${releasing} https://github.com/${slug}/pull/${releasing}: no new executors till its merge, ` +
        `the live executors' PRs into ${batch} wait for it (pr premerge refuses the merge); its steps — ${releaseCommand} prints them; ` +
        `after each executor's answer — task queue again; ${SESSION_ARCHIVE}.`,
    );
  } else if (ready.length) {
    io.out(
      `Next: each ready task above — a background subagent in its own worktree while fewer than ${QUEUE_EXECUTORS} run (a number from the request replaces it); ` +
        `the indented line is its whole prompt. After each executor's answer — task queue again: new tasks get in${ask}; ${SESSION_ARCHIVE}${now}.`,
    );
  } else if (running.length > settled) io.out(`Next: no ready tasks — wait for the executors' answers; after each — task queue again${ask}; ${SESSION_ARCHIVE}${now}.`);
  else if (settled) {
    io.out(
      `Next: the batch ${batch} is complete — nothing ready, every task in work is merged into it: its release — ${releaseCommand}, ` +
        `once no executor of this session is still at work; ${SESSION_ARCHIVE}.`,
    );
  } else {
    io.out(
      `Queue is empty: nothing ready, nothing ${q(N.status.inProgress)}; ${SESSION_ARCHIVE}. ` +
        "Then the dispatcher's summary (merged, questions, the not ready ones above) and the last line; a session with its own task — after it.",
    );
  }
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

/** The spec-diff script next to the skill — laid out like est (`../spec/scripts/spec-diff.ts`). */
const specDiffScript = (io: Io) => io.env["ELVES_SPEC_DIFF"] ?? path.resolve(import.meta.dir, "../../spec/scripts/spec-diff.ts");

/**
 * The batch's spec section for the release PR body: the spec skill's spec-diff next to this script, by the sources at
 * the two revisions — the merge-base with origin/<base> and the rebased batch — as for a task's PR body. Missing or
 * failed — a line and null: the PR goes without it.
 */
function specDiffOf(io: Io, base: string, head: string): string | null {
  const script = specDiffScript(io);
  if (!existsSync(script)) return io.out(`○ spec-diff is not installed (${script}) — the release PR without the spec section`), null;
  const r = (io.run ?? realRun)("bun", ["--no-env-file", script, "--base", `origin/${base}`, "--head", head], io.cwd);
  if (r.status !== 0) return io.out(`! spec-diff: ${why(r)} — the release PR without the spec section`), null;
  return r.stdout.trim() || null;
}

/** GitHub Actions — the app whose check-runs are jobs with a log (`actions/jobs/<check-run id>/logs`). */
const ACTIONS_APP = 15368;

/** A release's checks (#650): red, still running (or none yet) or green; the red names and their latest Actions runs. */
interface ReleaseChecks {
  state: "red" | "pending" | "green";
  red: string[];
  failed: Any[];
}

/**
 * The release PR's checks (#650) by `checkStates` — the rule of `task show` and `ci-wait`: a red one (`fail`, `cancel` —
 * ci-wait's FAIL) — red; otherwise one still running or none yet (the head moved: a fix merged into the batch, the full
 * run starts again) — pending; otherwise green. `failed` — the latest GitHub Actions run of each red name: its job's
 * log names the failed files. Not read (REST failed, no head commit) — pending and an `○` line.
 */
function releaseChecks(io: Io, slug: string, release: PrRef): ReleaseChecks {
  const pending: ReleaseChecks = { state: "pending", red: [], failed: [] };
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
  return { state: "red", red, failed: [...latest.values()] };
}

/** A test file's path — `x.test.ts`, `x.spec.tsx`, `x.e2e.ts` in any directory: Bun, Vitest, Jest, Playwright. */
const TEST_FILE = /((?:[\w.@-]+\/)*[\w.@-]+\.(?:test|spec|e2e)\.[cm]?[jt]sx?)\b/;
const isTestFile = (p: string) => new RegExp(`^${TEST_FILE.source}$`).test(p);

/**
 * The files a failed job's log names (#650): a failed test's file — in its failure line (Vitest, Jest, Playwright) or in
 * the file header above it (Bun: `tests/…/x.test.ts:`), a compiler error's file — `a.ts(3,5): error TS…` (a `bun check`
 * block too, `asTsc`); failure lines — `FAILED_LINE`, as on the merge. Paths — the checkout's: the runner's workspace
 * prefix (`…/work/<repo>/<repo>/`), the log's timestamps and colors are cut.
 */
function failedFilesIn(log: string): string[] {
  const out: string[] = [];
  const rel = (p: string) => p.replace(/^.*?\/work\/[^/]+\/[^/]+\//, "").replace(/^\.\//, "");
  const header = new RegExp(`^\\s*/?${TEST_FILE.source}:$`);
  let current: string | null = null;
  for (const raw of asTsc(log).split("\n")) {
    const line = raw
      .replace(/\u001b\[[\d;]*m/g, "")
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
      log = io.gh(["api", `repos/${slug}/actions/jobs/${r.id}/logs`]);
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
 * of each task's PR into the batch set them (it doesn't label from the release PR). One task holds them — it; none or
 * several — null and an `○` line: the bisect decides.
 */
function guiltyByLabels(io: Io, slug: string, sha: string, issues: Issue[], files: string[]): Guilty | null {
  const changed = files.map((p) => ({ path: p, changeType: "MODIFIED", additions: 1, deletions: 1 }));
  const modules = files.some((f) => f.split("/")[0] !== "tests") ? modulesAt(io, slug, sha, "the release head") : {};
  const decisions = [...decisionsOfFiles(changed, modules).changed.keys()];
  const none = "no guilty task by the labels";
  if (!decisions.length) return io.out(`○ the failed files name no decision — ${none}`), null;
  const held = (i: Issue) => decisions.filter((d) => i.labels.some((l) => l === d || legacyDecision(l)?.name === d));
  const holders = issues.filter((i) => held(i).length);
  const what = `the failed files' ${decisions.length > 1 ? "decisions" : "decision"} ${decisions.join(", ")}`;
  if (holders.length === 1) return { number: holders[0]!.number, why: `the label ${held(holders[0]!).join(", ")} — ${what}` };
  io.out(`○ ${what} — ${holders.length ? `the labels of ${holders.map((i) => `#${i.number}`).join(", ")}: not one task` : "no task of the release has the label"} — ${none}`);
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
 * decisions (`guiltyByLabels`), otherwise the bisect (`bisectRelease`) — `batch release`'s; the queue (`bisect` false)
 * names that command. Prints its lines.
 */
function redRelease(io: Io, slug: string, batch: string, base: string, release: PrRef, into: Any[], checks: ReleaseChecks, bisect: boolean): { fixing: PrRef | null; guilty: (Guilty & { issue: Issue }) | null } {
  const tasks = prTasks(release);
  const fixing = into.map(prRef).find((p) => p.state === "OPEN" && prTasks(p).some((n) => tasks.includes(n))) ?? null;
  if (fixing) {
    io.out(`○ the fix PR #${fixing.number} (${prTasks(fixing).map((n) => `#${n}`).join(", ")}) into ${batch} is open — its executor goes on; after its merge the release's full run goes again on PR #${release.number}`);
    return { fixing, guilty: null };
  }
  const issues = tasks.map((n) => loadIssue(io, slug, n));
  const named = (): Guilty | null => {
    if (issues.length < 2) return issues.length ? { number: tasks[0]!, why: "the release's only task" } : null;
    const files = failedFilesOf(io, slug, checks.failed);
    io.out(files.length ? `○ the failed checks' logs name ${files.join(", ")}` : `○ the failed checks' logs name no file`);
    return guiltyByLabels(io, slug, release.sha, issues, files) ?? (bisect ? bisectRelease(io, slug, batch, base, tasks, files, checks.red) : null);
  };
  const guilty = named();
  if (!guilty) return { fixing: null, guilty: null };
  const issue = issues.find((i) => i.number === guilty.number) ?? loadIssue(io, slug, guilty.number);
  io.out(`guilty: #${guilty.number} ${q(issue.title)} — ${guilty.why}`);
  return { fixing: null, guilty: { ...guilty, issue } };
}

/**
 * The red release a task's fix is for (#650): the batch's release PR is open, has the task in its «Closes #N», and its
 * checks are red; otherwise null — the task's assignment is the batch's usual one.
 */
function fixOf(io: Io, slug: string, batch: string, number: number): { release: PrRef; red: string[] } | null {
  const release = releasePrOf(batchPrs(io, slug, batch), batch);
  if (release?.state !== "OPEN" || !prOfTask(release, number)) return null;
  const checks = releaseChecks(io, slug, release);
  return checks.state === "red" ? { release, red: checks.red } : null;
}

/**
 * The fix of a red release (#650) — `Next:` of `batch release` and of the queue, one text: the guilty task's executor
 * (continued, or a new one with the same prompt) fixes it in the batch by its assignment, then the release's full run
 * goes again on the same PR; the other tasks wait for the release. The fix going — its wait; the guilty task not named
 * — `batch release` names it (the queue), or the logs (after the bisect).
 */
function fixSteps(slug: string, batch: string, release: PrRef, checks: ReleaseChecks, r: ReturnType<typeof redRelease>, bisected: boolean): string[] {
  const lead = `Next: the release PR #${release.number} https://github.com/${slug}/pull/${release.number} of ${batch} is red (${checks.red.join(", ")})`;
  const again =
    `after its merge into ${batch} — the release's full run again on the same PR #${release.number}: batch release prints its steps; ` +
    `the other tasks of the batch wait — no new executors till the release's merge; ${SESSION_ARCHIVE}.`;
  if (r.fixing) return [`${lead}: its fix PR #${r.fixing.number} into ${batch} is open — wait for its executor's answer; ${again}`];
  const g = r.guilty;
  if (g) {
    return [
      `${lead} — the guilty task #${g.number} ${q(g.issue.title)} fixes it in the batch: its executor — continued with SendMessage, the indented line its message; none alive — a new background subagent in its own worktree with it as the prompt. ` +
        `Its assignment (task queue --assignment ${g.number}) names the red release: a new task branch from origin/${batch}, the PR into ${batch} with Refs #${g.number}, the checks before a commit, no CI; ${again}`,
      `  ${executorPrompt(slug, g.number, g.issue.parent?.number ?? null)}`,
    ];
  }
  const command = `bun --no-env-file ${import.meta.path} batch release --repo ${slug}`;
  return [
    bisected
      ? `${lead} — the guilty task isn't named (the lines above say why): by the failed checks' logs (gh pr checks ${release.number}) the dispatcher names it or asks the owner, then its fix — task queue --assignment <N> to its executor; ${again}`
      : `${lead} — the guilty task: ${command} names it (the labels of the failed tests' decisions, otherwise a bisect by the task boundaries on the machine — a background command) and prints its fix; ${again}`,
  ];
}

/**
 * The release of the dispatcher's batch (#649, epic #645): what is merged into the batch branch goes into the default
 * branch by one PR — one full CI run and one deploy for the batch. The batch — the session's (its marker, `batchOf`) or
 * the one named. Its release PR open — its steps again, red (#650) — its guilty task and the fix in the batch
 * (`redRelease`, `fixSteps`), the PR stays open; merged — the closing steps. Otherwise: the tasks merged into
 * the batch (`batchTasks`; none — a refusal), the batch branch rebased onto a fresh origin/<base> in a temporary
 * worktree and pushed with `--force-with-lease` (on it already — no rebase; a conflict — a `!` line, code 1, the branch
 * unchanged), the PR into the default branch: the title — a conventional commit by the heaviest task type, the body —
 * the lead, the batch's spec-diff (`specDiffOf`) and «Closes #N» of each task: the merge closes them, and `task close`
 * finds the release PR linked. The live executors' open PRs into the batch aren't in it (question 2 of epic #645 — they
 * aren't stopped): `○` lines; their `pr premerge` holds the merge till the release, then moves them on (`batchBase`).
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
    `FAIL — ${script} batch release --repo ${slug} again: it names the guilty task and prints its fix in the batch, the release PR stays open. ` +
    `After the merge: the dispatcher goes on — task queue at once: it starts the next batch from the merged ${base}, and the live executors' PRs go into it (their pr premerge moves them); ` +
    `it stops — no queue: they go into ${base} with the full CI. Then ${closing(pr, tasks)}.`;
  const release = releasePrOf(prs, batch);
  if (release) {
    const tasks = prTasks(release);
    if (release.merged) {
      io.out(`○ ${batch} is released by PR ${link(release.number)}`);
      io.out(`Next: ${closing(release.number, tasks)}.`);
      return 0;
    }
    // a red release (#650): its guilty task fixes it in the batch, then the full run again on the same PR
    const checks = releaseChecks(io, slug, release);
    if (checks.state === "red") {
      io.out(`! the release PR ${link(release.number)} of ${batch} is red: ${checks.red.join(", ")}`);
      const r = redRelease(io, slug, batch, base, release, openInto(prs, batch), checks, true);
      for (const line of fixSteps(slug, batch, release, checks, r, true)) io.out(line);
      return 0;
    }
    io.out(`= the release PR ${link(release.number)} of ${batch} is open`);
    io.out(steps(release.number, tasks));
    return 0;
  }
  const merged = batchTasks(prs, batch);
  if (!merged.length) throw new GhError(`nothing is merged into ${batch} — nothing to release`);
  const tasks = [...new Set(merged.flatMap((m) => m.tasks))].sort((a, b) => a - b);
  for (const p of openInto(prs, batch)) {
    const of = prTasks(p);
    io.out(`○ PR #${p.number}${of.length ? ` (${of.map((n) => `#${n}`).join(", ")})` : ""} into ${batch} is open — not in the release: its executor goes on, its pr premerge holds the merge till the release, then moves the PR to the next batch or ${base}`);
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
    if (rebasedHead === null) return 1;
    head = rebasedHead;
    const pushed = git(io, io.cwd, "push", "-q", `--force-with-lease=refs/heads/${batch}:${old}`, "origin", `${head}:refs/heads/${batch}`);
    if (pushed.status !== 0) throw new GhError(`git push --force-with-lease origin ${batch}: ${why(pushed)}`);
    io.out(`+ ${batch} rebased onto origin/${base} (${onto.slice(0, 7)}): ${old.slice(0, 7)} → ${head.slice(0, 7)}, pushed`);
  }

  const spec = specDiffOf(io, base, head);
  const types = merged.map((m) => m.type);
  const type = RELEASE_TYPES.find((t) => types.includes(t)) ?? "chore";
  const title = `${type}: ${locale.fill(N.release.title, { batch, tasks: tasks.map((n) => `#${n}`).join(", ") })}`;
  const lead = locale.fill(N.release.lead, { batch, prs: merged.map((m) => `#${m.pr} (${m.tasks.map((n) => `#${n}`).join(", ")})`).join(", ") });
  const body = `${[lead, ...(spec ? [spec] : []), tasks.map((n) => `Closes #${n}`).join("\n")].join("\n\n")}\n`;
  const created = rest(io, `repos/${slug}/pulls`, { method: "POST", payload: { title, head: batch, base, body } });
  io.out(`+ the release PR ${link(created.number)}: ${title}`);
  io.out(steps(created.number, tasks));
  return 0;
}

/** A Claude Code agent's worktree (`isolation: "worktree"`): `<checkout>/.claude/worktrees/agent-<id>`, branch `worktree-agent-<id>`. */
const AGENT_WORKTREE = /[\\/]\.claude[\\/]worktrees[\\/]agent-[^\\/]+$/;
const AGENT_BRANCH = /^worktree-agent-/;
/** A session's worktree of the app: `<checkout>/.claude/worktrees/<name>`, not an agent's. */
const APP_WORKTREE = /[\\/]\.claude[\\/]worktrees[\\/](?!agent-)[^\\/]+$/;

/**
 * The app starts a cloud session from the branch in the starting session's record (`get_session` → `branch`), not from
 * git (#588): a session from the app's worktree has its `claude/<slug>-<hash>` there, never pushed — the clone fails, and
 * a detached checkout doesn't help, the record keeps the branch; a session in the project folder has none — `main`. The
 * dispatcher gets a `!` line, the queue still goes: subagent executors branch from origin/main in their own worktrees.
 */
function appWorktreeWarning(io: Io): void {
  const top = git(io, io.cwd, "rev-parse", "--show-toplevel").stdout.trim();
  if (!APP_WORKTREE.test(top)) return;
  const project = top.replace(/[\\/]\.claude[\\/]worktrees[\\/][^\\/]+$/, "");
  io.out(
    `! session in an app worktree ${top}: the app starts its cloud sessions from the branch in the session's record, not from main — ` +
      `cloud executors from it fail with «The requested branch or commit was not found»; a dispatcher with cloud executors — ` +
      `a session in the project folder ${project} without a worktree; subagent executors aren't affected`,
  );
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
 * is stale. A lock without a pid is someone else's — it holds.
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
 * Executors' worktrees go away with the dispatcher's next queue (#515): an executor can't remove its own — it works in it,
 * and `task close` leaves it detached on origin/<base>; its subagents leave theirs on `worktree-agent-*` branches.
 * Only agents' worktrees (`AGENT_WORKTREE`), detached or on a `worktree-agent-*` branch, not locked by a live process
 * (a running agent): clean and without commits outside origin/<base> (`git cherry` — a rebase merge gives new SHAs) —
 * removed with their branch, a `+` line each; uncommitted changes or unmerged commits — left, a `○` line with the
 * reason. A `worktree-agent-*` branch without a worktree — the same by its commits. A session's worktree, an agent's on
 * a task branch (its task isn't closed), an executor's whose handed-out task is open (`kept`, #533: Claude Code unlocks
 * an agent's worktree when it ends its answer — a question too — and doesn't lock it again when the agent is continued
 * with `SendMessage` after a restart) — not touched, no line. A worktree a subagent of its agent works in without one
 * of its own (`guestWhy`, #571: the executor answered, its epic refresh still ran in its directory) — left, a `○` line
 * naming the subagent. The directory isn't a checkout of the repository — nothing.
 */
function pruneAgentWorktrees(io: Io, slug: string, kept: (dir: string) => boolean): void {
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
  const deleteBranch = (branch: string) => {
    const d = git(io, io.cwd, "branch", "-D", branch);
    if (d.status !== 0) io.out(`! git branch -D ${branch}: ${why(d)}`);
    return d.status === 0;
  };
  const candidates = all
    .filter((w) => AGENT_WORKTREE.test(w.path) && w.path !== here && !w.prunable && (w.branch === null || AGENT_BRANCH.test(w.branch)))
    .filter((w) => (w.locked === null || !lockHolds(w.locked)) && !kept(w.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  // the subagents of this session and of the machine's other sessions with hand-outs: their executors' worktrees are here too
  const agents = candidates.length ? subagentsOf(io, [io.env["CLAUDE_CODE_SESSION_ID"] ?? "", ...handOutFiles(io).map((h) => h.session)].filter(Boolean)) : new Map<string, Subagent>();
  for (const w of candidates) {
    const guest = guestWhy(agents, agentIdOf(w.path)!);
    if (guest) {
      io.out(`○ worktree ${w.path} left: ${guest}`);
      continue;
    }
    const status = git(io, w.path, "status", "--porcelain");
    if (status.status !== 0) {
      io.out(`! worktree ${w.path}: git status: ${why(status)}`);
      continue;
    }
    const dirty = status.stdout.split("\n").filter((l) => l.trim()).length;
    const reasons = [dirty ? `${plural(dirty, "uncommitted file", "uncommitted files")}` : null, unmerged(w.head)].filter((r): r is string => r !== null);
    if (reasons.length) {
      io.out(`○ worktree ${w.path} left: ${reasons.join(", ")}`);
      continue;
    }
    // a stale lock: its process is gone, and a locked worktree isn't removed without double force — which would drop the dirty check too
    if (w.locked !== null) git(io, io.cwd, "worktree", "unlock", w.path);
    const removed = git(io, io.cwd, "worktree", "remove", w.path);
    if (removed.status !== 0) {
      io.out(`! git worktree remove ${w.path}: ${why(removed)}`);
      continue;
    }
    const withBranch = w.branch !== null && deleteBranch(w.branch) ? ` with branch ${w.branch}` : "";
    io.out(`+ worktree ${w.path} removed${withBranch}: clean, nothing outside ${upstream}`);
  }
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
  if (w.locked !== null && lockHolds(w.locked)) return `locked by a live process — ${w.locked || "no reason"}`;
  const id = agentIdOf(w.path);
  const guest = id === null ? null : guestWhy(agents, id);
  if (guest) return guest;
  // the worktree's own HEAD log: the time of its latest entry (`HEAD@{<unix time>}`)
  const r = git(io, w.path, "reflog", "-1", "--date=unix", "--format=%gd");
  const at = Number(/@\{(\d+)\}/.exec(r.stdout)?.[1]);
  const minutes = Math.floor((Date.now() / 1000 - at) / 60);
  return r.status === 0 && at > 0 && minutes < QUIET_MINUTES ? `HEAD moved ${Math.max(0, minutes)} min ago (a commit or a switch), quiet after ${QUIET_MINUTES}` : null;
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
 * makes the dispatcher wait, code 1. `cloud` — the brief of a cloud executor (#609), printed by the dispatcher: whole, `task
 * queue` refuses in the cloud; `#` only at its task (`est` links a cloud session by the only `#N` of its first
 * prompt — docs/cloud-sessions.md, "The brief"); no restart line — the cloud assigns its own branch. A cloud session
 * can't message a local one, so `Next:` gives the dispatcher the wait for the task's closing and the local close.
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
 * branch from the batch, not the task's earlier one (rebase-merged into the batch already) — no restart line; `cloud`
 * refused before the hand-out: a cloud executor isn't in the batch. The project's mode (#667, `autoProject` of the
 * checkout): auto — like a session in auto mode; outside auto the executor merged on green checks too, and the owner,
 * who hadn't said «yes» to that merge, learned of it from the dispatcher afterwards — now the lead's mode and the
 * `merge` line: up to `pr premerge` by itself, then the answer «question: merge PR #N?», the merge — on the owner's «yes»
 * the dispatcher forwards; a cloud executor asks in its session; an app session's lead names its mode itself.
 */
export function cmdTaskAssignment(io: Io, slug: string, number: number, o: { cloud?: boolean; session?: boolean } = {}): number {
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
  const batch = own?.slug === slug && own.number === number ? null : batchOf(io, slug);
  // the batch's release is red and the task is in it (#650): its fix goes into the batch — a cloud executor isn't in it
  const fix = batch === null ? null : fixOf(io, slug, batch, number);
  if (fix && o.cloud) {
    throw new GhError(`#${number} is in the red release PR #${fix.release.number} of ${batch}: its fix goes into the batch, and a cloud executor isn't in the batch — a subagent or an app executor session`);
  }
  if (file && !(own?.slug === slug && own.number === number)) {
    mkdirSync(path.dirname(file), { recursive: true });
    // the configuration directory may be a personal git checkout (ELVES_PRIVATE) — hand-outs aren't committed into it
    writeFileSync(path.join(path.dirname(file), ".gitignore"), "*\n");
    const where = o.cloud ? CLOUD_HANDOUT : o.session ? SESSION_HANDOUT : worktree;
    appendFileSync(file, `${slug}#${number}${where ? ` ${where}` : ""}\n`);
  }
  // the project's mode (#667): outside auto the executor's merge waits for the owner's «yes» — the dispatcher's request
  // is the work's scope, not a «yes» to each merge
  const auto = locale.autoProject(io.cwd ?? process.cwd());
  if (o.cloud) return cloudBrief(io, slug, issue, batch, auto), 0;
  // a fix starts a new branch from the batch: the task's earlier branch is in the batch already — no restart line
  const inProgress = itemIn(taskContext(io, slug), issue)?.status === N.status.inProgress;
  const restart = fix || inProgress ? taskBranchesHere(io, slug, number) : [];
  const vars = {
    task: N.subagentPrompt.task,
    number,
    title: issue.title,
    repo: slug,
    epic: issue.parent ? locale.fill(N.queue.epic, { epicWord: N.subagentPrompt.epic, epic: issue.parent.number }) : "",
    script: `bun --no-env-file ${import.meta.path}`,
    waitCi: `bash ${waitCi()}`,
    inProgress: N.status.inProgress,
    done: N.lastLine.done,
    questions: N.sections.questions,
    branches: restart.map((b) => `\`${b}\``).join(", "),
    doneQuestions: N.lastLine.questions,
    remaining: N.lastLine.remaining,
    batch: batch ?? "",
    release: fix?.release.number ?? "",
    checks: fix?.red.join(", ") ?? "",
    previous: fix && restart.length ? locale.fill(N.queue.fixPrevious, { branches: restart.map((b) => `\`${b}\``).join(", ") }) : "",
    mode: auto ? N.queue.modeAuto : N.queue.modeAsk,
  };
  const resume = restart.length && !fix ? [N.queue.resume] : [];
  // the epic refresh in the same turn (`refresh`, #628) — the subagent's: a session runs it by the canon, with the deploy's
  // wait; in a batch (#676) — no CI wait (a PR into the batch runs none: the checks before a commit and pr premerge are
  // its gate), no deploy, no refresh and no `task close`: they are the release's, the subagent's and the session's alike;
  // the fix of a red release (#650) — its own lead, the rest as in the batch
  const sessionLead = fix ? N.queue.sessionFixLead : batch ? N.queue.sessionBatchLead : N.queue.sessionLead;
  const lines = o.session
    ? [sessionLead, ...resume, N.queue.sessionIs, N.queue.sessionName, batch ? N.queue.batchWait : N.queue.sessionWait, N.queue.repeats, N.queue.sessionFound, N.queue.sessionQuestion, N.queue.sessionEnd]
    : [
        fix ? N.queue.fixLead : batch ? N.queue.batchLead : N.queue.lead,
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
/** A thematic break ends the questions section: the cloud proxy's signature after `---` isn't the last question's (#603). */
const THEMATIC_BREAK_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

/**
 * The items of the issue's questions section ("## Questions" in any language of the dictionary, up to the next section
 * or a thematic break): the number, the first line, all the item's non-empty lines and whether it is answered — ✅ at
 * the start of its answer (`ANSWER_MARK_RE`); `first` and `last` — the indexes of the item's first and last non-empty
 * line in the description's lines. The dashboard lists the open ones and the answers marked auto, `task actualize`
 * removes the questions label from a task without open ones, `task show` names them, `task answer` puts the answer
 * into the item.
 */
export function questionItems(body: string): { k: number; text: string; lines: string[]; answered: boolean; first: number; last: number }[] {
  const section = new RegExp(`^(?:${locale.every((n) => n.sections.questions).map(locale.escapeRe).join("|")})\\s*$`);
  const lines = body.split(/\r?\n/);
  const from = lines.findIndex((l) => section.test(l));
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
    const own = batchPrs(io, slug, p.head)
      .nodes.filter((x) => x.merged && x.baseRefName === p.head && prOfTask(x, issue.number))
      .map((x) => ({ number: x.number as number, state: x.state ?? "", merged: true, head: x.headRefName ?? "", base: p.head }));
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
 * accepts it; `--assignment` — the tasks of one epic, as its prompt names them.
 */
export function cmdTaskActualize(io: Io, slug: string, numbers: number[], o: { assignment: boolean } = { assignment: false }): number {
  const groups = new Map<number | null, Issue[]>();
  for (const n of [...new Set(numbers)]) {
    const issue = loadIssue(io, slug, n);
    const epic = issue.parent?.number ?? null;
    groups.set(epic, [...(groups.get(epic) ?? []), issue]);
  }
  if (o.assignment && groups.size > 1) {
    const by = [...groups].map(([epic, g]) => `${g.map((i) => `#${i.number}`).join(", ")} — ${epic === null ? "no epic" : `epic #${epic}`}`).join("; ");
    throw new GhError(`--assignment — the tasks of one epic, as its refresh prompt names them: ${by}`);
  }
  for (const [epic, group] of groups) refreshEpic(io, slug, epic, group, o);
  return 0;
}

/** One epic's refresh after its tasks shipped (`cmdTaskActualize`): the tasks of `group` — of this epic, or of none. */
function refreshEpic(io: Io, slug: string, epicNumber: number | null, group: Issue[], o: { assignment: boolean }): void {
  const numbers = group.map((i) => i.number);
  const tags = numbers.map((n) => `#${n}`).join(", ");
  const shipped = group.map((issue) => ({ issue, ...shippedBy(io, slug, issue) }));
  // merged only into a batch branch (#648): what shipped is in the batch, the task closes with its release; its
  // blocked-by links stay till then — a task of the same batch isn't held by them (task queue), one outside it is
  const held = shipped.every((s) => s.prs.length && !s.released);
  const later = held
    ? `Next: no task close — ${tags} ${numbers.length > 1 ? "are" : "is"} merged into ${shipped[0]!.prs[0]!.base}: ${numbers.length > 1 ? "they close" : "it closes"} with the batch's release.`
    : `Next: ${numbers.map((n) => `task close ${n}`).join("; ")} — after the deploy, where the merge deploys.`;
  if (epicNumber === null) return io.out(`○ refresh not needed: ${tags} ${numbers.length > 1 ? "have" : "has"} no epic. ${later}`);
  const epic = loadTaskText(io, slug, epicNumber);
  const open = epic.subIssues.filter((x) => x.state === "OPEN" && !numbers.includes(x.number)).map((x) => loadTaskText(io, slug, x.number));
  if (!o.assignment) refreshMechanics(io, slug, { numbers, merged: shipped.filter((s) => s.released).map((s) => s.issue.number), epic, open });
  if (!open.length) return io.out(`○ refresh not needed: epic #${epic.number} has no open tasks besides ${tags}. ${later}`);
  // the board with its Status (and its language) — the assignment names where a repeat finding goes (#636)
  const ctx = o.assignment ? taskContext(io, slug) : null;
  const vars = { task: N.subagentPrompt.task, epicWord: N.subagentPrompt.epic, number: numbers.join(", #"), epic: epic.number, repo: slug };
  const lead = locale.fill(N.actualize.lead, vars);
  if (!o.assignment) {
    io.out("Next: a subagent in the background — the two lines below are its whole prompt, pass them as is.");
    io.out(lead);
    io.out(locale.fill(N.actualize.fetch, { command: `bun --no-env-file ${import.meta.path} task actualize ${numbers.join(" ")} --assignment --repo ${slug}` }));
    return;
  }
  const checks = actualizeChecks();
  const what = (s: (typeof shipped)[number]) =>
    s.prs.length
      ? locale.fill(N.actualize.prs, { list: s.prs.map((p) => `#${p.number} (\`gh pr view ${p.number}\`, \`gh pr diff ${p.number}\`)`).join(", ") })
      : locale.fill(N.actualize.noPr, { command: `\`git log origin/main --grep '#${s.issue.number}'\`` });
  const tasks = shipped.map((s) => locale.fill(N.actualize.shippedTask, { number: s.issue.number, title: s.issue.title, shipped: what(s) })).join("; ");
  const lines = [lead, locale.fill(N.actualize.shipped, { repo: slug, tasks })];
  for (const p of shipped.flatMap((s) => s.prs)) {
    const files = loadPrChange(io, slug, p.number).files;
    if (files.length) lines.push(locale.fill(N.actualize.files, { pr: p.number }), ...files.map(fileLine));
  }
  lines.push("", locale.fill(N.actualize.epic, { ...vars, title: epic.title }), textBlock(epic.body), "", N.actualize.openTasks);
  const openPr = openPrOf(io, slug);
  /** Where a repeat finding of check 5 goes (#636): a task in Backlog takes it as an item, one already going doesn't. */
  const target = (n: number): string[] => {
    const i = loadIssue(io, slug, n);
    const status = itemIn(ctx!, i)?.status ?? null;
    const pr = openPr(i);
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
    locale.fill(N.actualize.scope, { ...vars, questions: N.sections.questions, script: `bun --no-env-file ${import.meta.path}` }),
    locale.fill(N.actualize.comment, { ...vars, report: locale.fill(N.actualize.report, { number: vars.number, text: "…" }), close: numbers.map((n) => `\`task close ${n}\``).join(", ") }),
    N.actualize.answer,
  );
  for (const line of lines) io.out(line);
}

/**
 * The epic refresh's report (#571): the refresh subagent ends with a comment on the epic that starts with `report` —
 * «Refresh after #N, result: …» in any language of the dictionary, case and markup aside; the script's own comment
 * (`mechanics`) comes before the subagent and isn't it. The tasks shipped together (a batch's release, #676) have one
 * report on their epic — «Refresh after #N, #M, result: …»: it is each one's.
 */
function refreshReported(epic: TaskText, number: number): boolean {
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
 * names that set and its `task actualize`.
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
  const unlinked = fresh.filter((p) => p.merged);
  const merged = linked.length ? linked : unlinked;
  const batched = merged.length ? [] : [...issue.prs, ...(found?.batched ?? [])].filter((p) => p.merged && isBatchBranch(p.base));
  if (batched.length) {
    const prs = [...new Set(batched.map((p) => `#${p.number}`))].join(", ");
    throw new GhError(
      `#${number} is too early to close: PR ${prs} merged into ${batched[0]!.base}, not into ${found?.base ?? "the default branch"} — ` +
        `the task closes with the batch's release (Closes #${number} in the release PR); till then it stays ${q(N.status.inProgress)}`,
    );
  }
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
  const item = ensureItem(io, ctx, issue);
  setStatus(io, ctx, item.id, N.status.done);
  io.out(`+ #${number}: ${STATUS} ${q(N.status.done)}${item.added ? " (added to the project)" : ""}`);
  closeMilestone(io, slug, issue, wasOpen);
  if (issue.parent) {
    const epic = loadIssue(io, slug, issue.parent.number);
    const open = epic.subIssues.filter((x) => x.state === "OPEN" && x.number !== number).length;
    if (epic.state === "OPEN" && epic.subIssues.length && !open) {
      mutate(io, { op: "CloseIssue", input: { issueId: epic.id, stateReason: "COMPLETED" } });
      setStatus(io, ctx, ensureItem(io, ctx, epic).id, N.status.done);
      io.out(`+ epic #${epic.number} closed and in ${q(N.status.done)}: all subtasks are closed`);
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
      const batches = new Map([...new Set(shipped.map((p) => p.head).filter(isBatchBranch))].map((b) => [b, batchPrs(io, slug, b)]));
      const ofTask = [...batches].flatMap(([b, prs]) =>
        prs.nodes.filter((p) => p.merged && p.baseRefName === b && prOfTask(p, number)).map((p) => ({ number: p.number as number, head: p.headRefName as string, base: all.base })),
      );
      // …but not while a live executor's PR is into it: deleting a PR's base closes it or moves it into the default
      // branch past the dispatcher
      const live = (head: string) => (batches.has(head) ? openInto(batches.get(head)!, head) : []);
      for (const b of batches.keys()) {
        if (!live(b).length) continue;
        io.out(`○ batch branch ${b} kept: open PR ${live(b).map((p) => `#${p.number}`).join(", ")} into it — its executor moves it to the next batch or ${all.base} first (pr premerge says where); then the dispatcher's task queue deletes the branch`);
      }
      cleanupBranches(io, number, [...shipped, ...ofTask].filter((p) => !live(p.head).length));
    }
  }
  // three lines — in the project language: dashboard parses them
  io.out(
    `Next: the last line of the answer is one of three: ${q(N.lastLine.done)}; ` +
      `the owner has something to decide — ${q(`${N.lastLine.questions} …`)} with the questions themselves, without ${q(N.lastLine.done)}; ` +
      `something remains — ${q(`${N.lastLine.remaining} …`)}. ` +
      // the command doesn't read the mode (auto) or the session's background tasks: the session knows them, the step is spelled out in words
      `In auto mode after ${q(N.lastLine.done)} — archive the session where the agent has the tool, ` +
      `first stopping its own background tasks still running (a wait, a watcher over its output, a subagent): a live one blocks archiving; ` +
      `after the other two lines — don't. ` +
      `Information without a decision (an observation, a deadline, a warning) isn't a question: the line and archiving are as with ${q(N.lastLine.done)}`,
  );
  return 0;
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
  // not a pin — the session has no task, as for est and the dashboard; the line names the file for a human
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

// canon task types — a copy of EST_TYPES and BRANCH_CONV_RE from skills/est/scripts/est.ts (and in skills/task-env/scripts/task-env.ts):
// no shared module: github imports no other skill (tests/standards/skill-imports); the tests/standards/task-branch
// standard keeps the parsing identical
const TASK_TYPES = ["feat", "fix", "docs", "refactor", "perf", "test", "chore", "ci", "build", "research"];
const TASK_BRANCH_RE = new RegExp("^(?:[\\p{L}\\p{N}_.-]+/)?(" + TASK_TYPES.join("|") + ")/(\\d{1,6})-", "iu");

/** A task branch by the canon — `[<area>/]<type>/<N>-<slug>`: the type (lowercased) and the number, otherwise null. */
export function taskBranch(branch: string): { type: string; issue: number } | null {
  const m = TASK_BRANCH_RE.exec(branch);
  return m ? { type: m[1]!.toLowerCase(), issue: parseInt(m[2]!, 10) } : null;
}
const isTaskBranch = (branch: string, number: number) => taskBranch(branch)?.issue === number;
/** The slug of a branch `task status --branch` creates: Latin kebab-case after `<N>-` (AGENTS.md, "Session and branch"). */
const TASK_SLUG_RE = /\/\d{1,6}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Attempts to write the shared `.git/config` while another checkout's git holds its lock: 20 with 0.5 s between — ~10 s. */
const CONFIG_LOCK_TRIES = 20;
const CONFIG_LOCK_PAUSE_MS = 500;
const CONFIG_LOCKED = /could not lock config file (.+)$/m;

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
    const r = git(io, io.cwd, ...args);
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
function unlinkedPrs(io: Io, slug: string, number: number): { base: string; prs: UnlinkedPr[]; batched: UnlinkedPr[] } {
  const { base, nodes } = recentPrs(io, slug);
  const prs: UnlinkedPr[] = [];
  const batched: UnlinkedPr[] = [];
  for (const p of nodes) {
    const into: string = p.baseRefName ?? "";
    if (into !== base && !isBatchBranch(into)) continue;
    const head: string = p.headRefName ?? "";
    const why = taskLinks(p).find((x) => x.number === number)?.why;
    if (why) (into === base ? prs : batched).push({ number: p.number, state: p.state ?? "", merged: Boolean(p.merged), head, base: into, why });
  }
  return { base, prs, batched };
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
 * call (SKILL.md).
 */
function takeDownStacks(io: Io, number: number): void {
  const script = taskEnvScript(io);
  if (!existsSync(script)) return io.out(`○ task stacks: task-env is not installed (${script})`);
  const r = (io.run ?? realRun)("bun", ["--no-env-file", script, "down", String(number)], io.cwd);
  const lines = r.stdout.split("\n").filter((l) => l.trim());
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

/**
 * The estimate — `task new`, like the actual in `task close`: the script picks the analogs, the agent has no step of
 * its own. Fewer than two analogs in the repository — est prints "No estimate" and the task stays without one.
 */
function runEstimate(io: Io, slug: string, number: number, type: string): void {
  const est = estScript(io);
  if (!existsSync(est)) return io.out(`○ no estimate: est is not installed (${est})`);
  runEst(io, est, ["estimate", String(number), "--repo", slug, "--type", type, "--write"]);
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
 * it merged. Not merged or someone else's — left alone. That the directory is the repository's checkout, the caller
 * checks.
 */
function cleanupBranches(io: Io, number: number, prs: { head: string; base: string }[]): void {
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
function addLabels(io: Io, issue: Pick<Issue, "id" | "labels" | "rest">, names: string[], all: Label[]): string {
  const missing = names.filter((n) => !issue.labels.includes(n));
  if (!missing.length) return "";
  if (issue.rest) rest(io, `${issue.rest}/labels`, { method: "POST", payload: { labels: missing } });
  else mutate(io, { op: "AddLabels", input: { labelableId: issue.id, labelIds: missing.map((n) => all.find((l) => l.name === n)!.id) } });
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

// the former exceptions format — an array in one file: the harness's exceptions.ts
const LEGACY_EXCEPTIONS = /^exceptions\.(ts|mts|js|mjs|json)$/;

/**
 * Which decision folder's exceptions file is it? A copy of the spec skill's `exceptionFile` rule (`speclib.ts`):
 * github imports no other skill (tests/standards/skill-imports) and works without spec; the
 * `tests/standards/exception-files` standard checks both copies against one table. The `exceptions/` directory of a
 * `tests/<kind>/<name>` folder, a `.json` file — the folder's exception; another file in the directory and a directory
 * in a subfolder — an error; `exceptions.*` in a folder or a subfolder — the former format; outside decision folders
 * and hidden ones — null.
 */
export function exceptionFile(p: string): { folder: string; dir: string; legacy: boolean; error?: string } | null {
  const parts = p.split("/");
  if (parts[0] !== "tests" || parts.length < 4 || !DECISION_KINDS.some((k) => DECISIONS[k].dir === parts[1])) return null;
  const folder = parts.slice(0, 3).join("/");
  const inner = parts.slice(3);
  if (inner.some((s) => s.startsWith("."))) return null;
  const at = inner.findIndex((s, i) => (i < inner.length - 1 ? s === "exceptions" : LEGACY_EXCEPTIONS.test(s)));
  if (at < 0) return null;
  const dir = "exceptions";
  if (at === inner.length - 1) return { folder, dir, legacy: true };
  if (at > 0) return { folder, dir, legacy: false, error: "the exceptions directory is in a subfolder" };
  if (inner.length > 2 || !p.endsWith(".json")) return { folder, dir, legacy: false, error: "an exception is not a .json file" };
  return { folder, dir, legacy: false };
}

/**
 * A mechanical edit doesn't change a decision: the file is deleted, renamed without content changes, or it's an
 * exceptions file of a decision folder that spec reads as an exception (`exceptionFile` without an error): a file in
 * `exceptions/`, the former `exceptions.ts` (the exceptions ratchet). It gives no decision label — otherwise with mass
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
 * task changes the decision". A statement is the decision folder's `<name>.md` edited in content, or the folder named in
 * the spec section of the PR body (spec-diff output): a list line or a summary row starting with the folder — removed,
 * changed and added tests, the move into the tree, harness checks, scenarios that became tests. Exceptions aren't
 * statements (`mechanical`): their blocks are skipped. The section heading and block titles — in any dictionary
 * language: the body is in the project's language, and the script may run from another project with --repo.
 */
function statementDecisions(files: PrFile[], body: string): Set<string> {
  const dirs = new Set<string>(DECISION_KINDS.map((k) => DECISIONS[k].dir));
  const out = new Set<string>();
  for (const f of files) {
    const [root, dir, name, file, ...rest] = f.path.split("/");
    if (root === "tests" && dirs.has(dir!) && file === `${name}.md` && !rest.length && !mechanical(f)) out.add(name!);
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
  const lines: string[] = [];
  const missing = want.filter((n) => !issue.labels.includes(n));
  const room = Math.max(0, ISSUE_LABEL_LIMIT - issue.labels.length);
  let add = missing;
  if (missing.length > room) {
    const named = statements ? missing.filter((n) => statements.has(n)) : [...missing].sort();
    const bodies = statements ? missing.filter((n) => !statements.has(n)) : [];
    add = named.slice(0, room);
    const which = statements ? "only decisions whose <folder>.md or test names the PR changes" : "alphabetically, as many as fit";
    const without = bodies.length ? `; test bodies and code only, no label: ${bodies.join(", ")}` : "";
    lines.push(`○ ${who}: ${missing.length} new decision labels, room for ${room} (GitHub puts at most ${ISSUE_LABEL_LIMIT} on an issue, it has ${issue.labels.length}) — ${which}${without}`);
    if (named.length > room) lines.push(`○ ${who}: no room — not set: ${named.slice(room).join(", ")}`);
  }
  const added = addLabels(io, issue, add, all);
  if (added) lines.push(`+ ${who}: ${added}`);
  return lines;
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

/**
 * Decision labels from the PR's diff for its tasks and their epics. The tasks — GitHub's link; right after the PR is
 * created there is none yet — the PR's tasks by the one rule (`taskLinks`: the task branch, «Closes #N» of the body):
 * a fix PR into a batch branch has «Refs #N» (#650). A batch's release PR — no labels (#650): its tasks got theirs from
 * their PRs into the batch, the release's diff would give each task the whole batch's — and a red release names its
 * guilty task by them.
 */
export function cmdPrLabels(io: Io, slug: string, number: number): number {
  const { head, files, base } = loadPrChange(io, slug, number);
  if (isBatchBranch(head.headRefName ?? "") && releaseOf([head], head.headRefName, base)) {
    io.out(
      `○ PR #${number} is the release of the batch ${head.headRefName}: its tasks got their decision labels from their PRs into the batch — ` +
        `the release's diff would give each task the whole batch's, and a red release names its guilty task by them: no labels`,
    );
    return 0;
  }
  let closes: number[] = (head.closingIssuesReferences?.nodes ?? []).map((x: Any) => x.number);
  if (!closes.length) closes = prTasks(head);
  if (!closes.length) throw new GhError(`PR #${number} has no «Closes #N» and no task branch — nowhere to put the labels`);
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
  io.out(`PR #${number} → ${closes.map((n) => `#${n}`).join(", ")}: ${want.join(", ") || "no decisions in the diff"}`);
  for (const l of skipped) io.out(`○ ${l} — only a mechanical edit (a deletion, a rename without changes, exceptions): no label`);
  for (const x of dimensions) io.out(`○ ${x.name} — label ${q(x.name)} is slice ${q(x.dim)}, not a decision label: not set`);
  if (!want.length) return 0;

  const fresh = want.filter((l) => !all.some((x) => x.name === l));
  const repoId = fresh.length ? loadRepo(io, slug).id : "";
  for (const l of fresh) {
    const label = decisionLabel(l, decided.get(l)!);
    const created = mutate(io, { op: "CreateLabel", input: { repositoryId: repoId, ...label } }).createLabel.label;
    all.push({ id: created.id, ...label, open: { total: 0, numbers: [] } });
    io.out(`+ created label ${q(l)}`);
  }
  const isDecision = (n: string) => legacyDecision(n) !== null || labelKinds(all.find((x) => x.name === n)?.description) !== null;
  const statements = statementDecisions(files, head.body ?? "");
  const epics = new Map<number, Issue>();
  for (const n of closes) {
    const issue = loadIssue(io, slug, n);
    for (const l of putLabels(io, issue, `#${n}`, want, statements, all)) io.out(l);
    // earlier labels aren't removed: the task may have touched the decision in another PR too
    for (const l of issue.labels.filter((x) => isDecision(x) && !want.includes(x))) io.out(`= #${n}: ${l} — the decision is not in the PR diff, the label stays`);
    if (issue.parent && !epics.has(issue.parent.number)) epics.set(issue.parent.number, loadIssue(io, slug, issue.parent.number));
  }
  for (const epic of epics.values()) for (const l of putLabels(io, epic, `epic #${epic.number}`, want, statements, all)) io.out(l);
  return 0;
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
 * `tests/standards/package-manager`. The manager — `packageManager` in package.json, otherwise the lockfile in the
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
 * A temporary worktree of the checkout at a revision (tests/standards/temp-worktree): a directory in the temp folder,
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
 * files; npm — after `--`) — in order, up to the first red one. `install` — its command and result, no lockfile — null;
 * failed — no step ran.
 */
function checkTree(io: Io, dir: string, steps: { script: string; args?: string[] }[]): { install: { cmd: string; result: RunResult } | null; ran: string[]; red: TreeRed | null } {
  const run = io.run ?? realRun;
  const cmds = projectCommands(dir);
  const install = cmds.install ? { cmd: cmds.install.join(" "), result: run(cmds.install[0]!, cmds.install.slice(1), dir) } : null;
  const ran: string[] = [];
  if (install && install.result.status !== 0) return { install, ran, red: null };
  for (const s of steps) {
    const args = s.args ?? [];
    const argv = [...cmds.run(s.script), ...(args.length && packageManager(dir).name === "npm" ? ["--"] : []), ...args];
    const result = run(argv[0]!, argv.slice(1), dir);
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
 * `wait-ci.sh` (`SPEC_PUBLISH`): both answer by one table, `tests/standards/spec-publish-job`.
 */
export const SPEC_PUBLISH = /^(?:.+ \/ )?spec-publish$/;

/**
 * Red checks of the default branch's last commit — check-runs (the last run of each name) and hosting statuses;
 * `publish` — the red spec publish jobs, apart.
 */
function redChecksOf(io: Io, slug: string, base: string): { sha: string; names: string[]; publish: string[] } {
  const ref = encodeURIComponent(base);
  const latest = new Map<string, Any>();
  for (const r of restCall(io, ["api", `repos/${slug}/commits/${ref}/check-runs?per_page=100`]).check_runs ?? []) {
    if (!latest.has(r.name) || latest.get(r.name).id < r.id) latest.set(r.name, r);
  }
  const status = restCall(io, ["api", `repos/${slug}/commits/${ref}/status`]);
  const names = [
    ...[...latest.values()].filter((r) => r.status === "completed" && RED_RUN.has(r.conclusion)).map((r) => r.name as string),
    ...(status.statuses ?? []).filter((x: Any) => RED_STATUS.has(x.state)).map((x: Any) => x.context as string),
  ];
  const red = [...new Set(names)].sort();
  return { sha: String(status.sha ?? ""), names: red.filter((n) => !SPEC_PUBLISH.test(n)), publish: red.filter((n) => SPEC_PUBLISH.test(n)) };
}

/**
 * Title prefixes of a bug about a red default branch — `mainRed.title` of each dictionary language, the project
 * language first.
 */
const mainRedPrefixes = (base: string) => [...new Set([N, ...locale.everyNames()].map((n) => locale.fill(n.mainRed.title, { base })))];

/**
 * Open bugs about a red default branch — the title "<base> is red…" in any dictionary language (a search for each),
 * by number: the search lags, and a duplicate happens.
 */
function mainBugsOf(io: Io, slug: string, base: string): { number: number; title: string }[] {
  const prefixes = mainRedPrefixes(base);
  const found = new Map<number, Any>();
  for (const prefix of prefixes) {
    const q = `repo:${slug} is:issue is:open in:title "${prefix}"`;
    for (const i of restCall(io, ["api", `search/issues?q=${encodeURIComponent(q)}&per_page=20`]).items ?? []) found.set(i.number, i);
  }
  return [...found.values()].filter((i) => !i.pull_request && prefixes.some((p) => String(i.title).startsWith(p))).sort((a, b) => a.number - b.number);
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
 * open release red and the PR one of its task's (#650: the task branch or «Closes #N» — `prTasks`, the release's
 * «Closes #N») — the guilty task's fix: null, the PR is checked as usual; a live executor's PR (its task isn't in the
 * release) and any PR while the release is green or running — held.
 */
function batchBase(io: Io, slug: string, number: number, pr: Any): number | null {
  const base: string = pr.base.ref;
  const main: string = pr.base.repo?.default_branch ?? "main";
  const owner = slug.split("/")[0]!;
  const rows: Any[] = restCall(io, ["api", `repos/${slug}/pulls?state=all&head=${encodeURIComponent(`${owner}:${base}`)}&per_page=10`]) ?? [];
  const release = releaseOf(rows, base, main);
  if (!release) return null;
  if (release.state === "OPEN") {
    const ofRelease = prTasks(pr).filter((n) => prOfTask(release, n));
    const checks = ofRelease.length ? releaseChecks(io, slug, release) : null;
    if (checks?.state === "red") {
      io.out(
        `○ ${base} is being released — PR #${release.number} into ${main} is red (${checks.red.join(", ")}), and PR #${number} is of its task ${ofRelease.map((n) => `#${n}`).join(", ")}: ` +
          `the guilty task's fix goes into the batch — checking the PR as usual; after its merge the release's full run goes again on PR #${release.number}`,
      );
      return null;
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
  const tasks = prTasks(pr);
  // a PR into a batch runs no CI (#676): into the next batch — no ci-wait, into the default branch — the full CI
  const after =
    target === main
      ? `ci-wait, pr premerge ${number} again; into ${main} the task leaves the batch: the full CI, after the merge — the deploy wait (bash ${waitCi()} merged ${number}), the epic refresh and task close ${tasks.length ? tasks.join(", ") : "<N>"}, as outside a batch`
      : `pr premerge ${number} again; in the batch ${target} the task waits for its release, as before: no CI wait, no deploy wait, no epic refresh and no task close`;
  io.out(
    `❌ don't merge: ${base} is released by PR #${release.number} — the PR moves to ${target}: gh pr edit ${number} --base ${target}, ` +
      `then git fetch origin ${target}, git rebase origin/${target} (the batch's commits are in it already — the rebase drops them), git push --force-with-lease, ${after}`,
  );
  return 1;
}

/**
 * Before merging a green PR: main moved after its CI — the PR head merged with a fresh main in a temporary worktree and
 * the fast checks (`typecheck`, then `test:spec`, as in CI); didn't move — the CI checked exactly this merge. GitHub
 * doesn't keep what the CI checked (the merge-ref is rebuilt), so by time: the head's earliest check suite against the
 * last event of the default branch (REST: the GraphQL quota is shared by all sessions). The unknown is checked. A red
 * main isn't this PR: a red check on main's last commit or a merge red by the same thing as bare main. Code 0 —
 * merge, 1 — don't merge (the PR breaks it), 3 — main is red. A PR into a batch branch runs no CI (#676) and the batch
 * branch none either: what was checked is the head itself — the executor's checks before a commit; so by git, not by
 * time: the head on a fresh origin/<batch> — merge, the batch moved on past it — the fast checks on the merge, as for a
 * moved main.
 */
export function cmdPrPremerge(io: Io, slug: string, number: number): number {
  const pr = restCall(io, ["api", `repos/${slug}/pulls/${number}`]);
  if (pr.state !== "open") throw new GhError(`PR #${number} is not open — nothing to merge`);
  const head: string = pr.head.sha;
  const base: string = pr.base.ref;
  const closes = closingInBody(pr.body ?? "");
  const batch = isBatchBranch(base);
  if (batch) {
    const code = batchBase(io, slug, number, pr);
    if (code !== null) return code;
  }
  // what the PR's fix goes through again: a PR into a batch has no CI to wait for (#676)
  const recheck = batch ? `pr premerge ${number} again` : "ci-wait again";

  /**
   * A red main: don't merge and don't fix it in your PR — one bug for everyone, the others wait for it to close.
   * `red` — the failed checks (or the script), `what` — how to name them in the bug title. A PR that closes this bug is
   * the fix: null, the check goes as usual.
   */
  const mainRed = (lead: string, why: string, red: string[], what: (names: string[]) => string, say = what): number | null => {
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
    io.out(lead);
    // wait for a bug whose title names the failed check (unlike the fix above): a bug about another check won't make
    // main green
    const named = (b: { title: string }) => red.some((n) => bugNames(base, b.title, n));
    for (const b of bugs.filter((b) => !named(b))) io.out(`○ #${b.number} «${b.title}» — about another check: don't wait`);
    const wait = (n: string) => `wait for it to close — bash ${waitCi()} issue ${n} as a background command, then pr premerge ${number} again`;
    const bug = bugs.find(named);
    if (bug) io.out(`bug on red ${base} — #${bug.number} «${bug.title}»: ${wait(String(bug.number))}`);
    const unnamed = red.filter((n) => !bugs.some((b) => bugNames(base, b.title, n)));
    if (unnamed.length) {
      const priority = pr.base?.repo?.owner?.type === "Organization" ? " --priority Urgent" : "";
      const title = `${locale.fill(N.mainRed.title, { base })}: ${what(unnamed)}`;
      io.out(`no bug on red ${base} about ${say(unnamed)} — find an open one on the failed test or file one (label — the failed test's decision) and ask the owner whether to queue it: bun --no-env-file ${import.meta.path} task new --type ${N.issueTypes.bug}${priority} --title ${JSON.stringify(title)}; ${wait("<N>")}`);
    }
    io.out(`⛔ don't merge: ${base} is red, not this PR — don't fix it in your PR`);
    return 3;
  };

  // a batch branch and a PR into it run no CI (#676): neither a red check of the base nor the PR's CI by time — git below
  if (!batch) {
    try {
      const red = redChecksOf(io, slug, base);
      if (red.publish.length) {
        io.out(`○ ${red.publish.join(", ")} red on the last commit of ${base} (${red.sha.slice(0, 7)}) — publishing the documentation, not a check of ${base}: not counted`);
      }
      if (red.names.length) {
        const checks = (names: string[]) => `${names.length > 1 ? "checks" : "check"} ${names.join(", ")}`;
        // in the bug title — in the project language
        const titled = (names: string[]) => locale.fill(names.length > 1 ? N.mainRed.checks : N.mainRed.check, { names: names.join(", ") });
        const why = `${checks(red.names)} of the last commit of ${base} (${red.sha.slice(0, 7)})`;
        const code = mainRed(`${base} is red: ${why}`, why, red.names, titled, checks);
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

  if (!checkoutOfRepo(io, originUrl(io), slug)) throw new GhError(`the merge check runs from a checkout of ${slug}: the current directory is not one`);
  const fetched = git(io, io.cwd, "fetch", "-q", "origin", base);
  if (fetched.status !== 0) throw new GhError(`git fetch origin ${base}: ${fetched.stderr.trim()}`);
  // the head — by its SHA, not refs/pull/<N>/head: GitHub creates that ref up to minutes after the PR, when CI has
  // already passed (#505), while a reachable commit (the head branch, refs/pull/<N>/merge) it gives by SHA
  const got = git(io, io.cwd, "fetch", "-q", "origin", head);
  if (got.status !== 0) throw new GhError(`PR head ${head} not fetched from origin (${why(got)}) — was the PR updated? ${recheck}`);
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
  /**
   * The tree's fast checks (`scripts` — those that exist) with dependencies from its lockfile, up to the first red one;
   * none — null.
   */
  const checks = (dir: string, where: string, scripts: string[]): { ran: string[]; red: Red | null } | null => {
    const defined = scriptsOf(dir);
    const present = scripts.filter((s) => defined[s]);
    if (!present.length) return null;
    const { install, ran, red } = checkTree(io, dir, present.map((script) => ({ script })));
    if (install) {
      if (install.result.status !== 0) throw new GhError(`installing dependencies ${where} failed (${install.cmd}): ${tail(install.result, 5).join(" / ")}`);
      io.out(`+ dependencies${where === ON_MERGE ? "" : ` ${where}`}: ${install.cmd}`);
    }
    if (!red) return { ran, red: null };
    const failed = [...new Set(asTsc(`${red.result.stdout}\n${red.result.stderr}`).split("\n").filter((l) => FAILED_LINE.test(l)).map((l) => l.trim()))];
    return { ran, red: { ...red, failed } };
  };
  const breaks = (script: string) => `❌ don't merge: ${script} is red on the merge with origin/${base} — fix the root cause in the PR: rebase onto origin/${base}, edit, push --force-with-lease, ${recheck}`;
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

    // a red merge — is bare main red by the same thing: then it's not this PR that breaks it
    io.out(`checking bare origin/${base}: is it red by itself`);
    const bare = inTempWorktree(io, "premerge", `origin/${base}`, (bareDir) => checks(bareDir, `on origin/${base}`, [red.script])?.red);
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
    const code = mainRed(`${base} is red by itself: ${reason}`, reason, [red.script], (names) => names.join(", "));
    if (code !== null) return code;
    io.out(breaks(red.script));
    return 1;
  });
}

// ----------------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------------

/**
 * Help — `--help` or `-h` anywhere in the arguments (tests/standards/cli-help): a command's synopsis (the first
 * paragraph), what it does and examples; `github --help` — the synopses of all. The dispatcher takes only the commands
 * from here: a command without help can't be called.
 */
const HELP: Record<string, string> = {
  "project check": `github project check [--repo owner/repo]

Items ✅/❌; code 0 — everything per the canon, 1 — there are ❌. Decision labels — by the default branch's spec tree; a
new decision's label on an open task and a slice label («Slice: …») with a decision's name — an ○ line, not ❌.

Examples:
  github project check
  github project check --repo acme/shop`,
  "project fix": `github project fix [--repo owner/repo] [--confirm] [--template owner/N | none]

Fixes via the API and prints UI steps with links; deleting and renaming in a project with tasks and organization
settings — only with --confirm (after the user's "yes"). No project — links the one of the same name, otherwise copies
the template (${DEFAULT_TEMPLATE}), otherwise creates one.

Examples:
  github project fix
  github project fix --confirm --template none`,
  "task new": `github task new --title "…" --branch-type <type> [--body "…" | --body-file F] [--type Task|Bug|Epic] [--epic N]
                [--milestone "…"] [--blocked-by N,N] [--priority Urgent|High|Medium|Low]
                [--labels <decision>,<kind>:<new decision>,<label>] [--repo owner/repo]

A task by the canon: type, project and Backlog, Priority, epic, blocked by, milestone, decision labels, the questions
label when the description has a question without ✅ (created if missing); sets the estimate itself (est estimate
--write with --branch-type: feat, fix, docs, refactor, perf, test, chore, ci, build, research; a bug without it is
fix, an epic isn't estimated) and prints what was created and the next step. A Claude Code cloud session — over the
repository's REST, without the project: Status, the estimate and an organization's Priority — a line for a local session.

Examples:
  github task new --title "Billing · Export invoices to PDF" --branch-type feat --epic 40 --body-file task.md
  github task new --title "Login fails on Safari" --type Bug --priority High --body "Steps: …"`,
  "task show": `github task show <N> [--repo owner/repo]

The task in one output: title, type, Status, estimate, the epic with its open questions and tasks, subtasks, open
blockers, the PRs with their checks, open and answered questions (a comment that looks like an answer — a «?» line at
the question), the comments of the task and its epic (the flow's own — one line with the kind), the description;
read-only. A cloud session — over the repository's REST, without the project's fields; the PRs — by the task branch or
«Closes #N».

Examples:
  github task show 42`,
  "task answer": `github task answer <N> <k> "<answer>" [--auto] [--repo owner/repo]

✅ and «**Answer:** …» at question k of the questions section (--auto — the auto mark), the numbering unchanged; no open
questions left — the questions label is removed; an answered question is refused. A question is answered by ✅ at the
start of its answer, not by ✅ in its text. A cloud session — over the repository's REST.

Examples:
  github task answer 42 1 "Only PDF, no CSV yet"
  github task answer 42 2 "Medium, by recommendation" --auto`,
  "task start": `github task start <N> [--branch <type>/<N>-<slug>] [--repo owner/repo]

Taking a task into work in one call: project check (once per session — a marker in project-checks/<session id> of
~/.config/elves; ❌ — the report and code 1), the task as task show prints it, then the stops before any change, code 1:
open questions of the task or its epic (ask the owner, then task start again), the task in work elsewhere (an open PR
of it — into a batch branch too — or a branch */<N>-* locally or on origin that isn't the current one). Then task
status N «In progress» --branch (the pin, the epic, the branch rename), the estimate when the task has none (the type —
from --branch), and the next lines: the session name «#N <title>», the branch, the scenarios of the description and,
in Claude Code (CLAUDECODE=1), one ToolSearch line with the app tools the flow calls (${APP_TOOLS.join(", ")}). An epic
and a closed task — refused (code 2).

Examples:
  github task start 42 --branch feat/42-invoice-export`,
  "task status": `github task status <N> <Backlog|In progress|Done> [--branch <type>/<N>-<slug>] [--repo owner/repo]

Status in the project (and the epic's In progress once its first subtask is taken). In progress pins the task to the
session (file sessions/<CLAUDE_CODE_SESSION_ID> in ~/.config/elves): another task in the same session — a refusal
(code 2) with the question to the owner whether to queue it and its executor's prompt; a task handed out to an
executor of this session (task queue --assignment) isn't pinned; a human removes the pin. --branch — the worktree
tool's branch becomes the task branch (git branch -m with its .git/config section); a .git/config locked by another
checkout — retried ~10 s, then a ! line with the command that finishes it (code 1).

Examples:
  github task status 42 "In progress" --branch feat/42-invoice-export
  github task status 42 Backlog`,
  "task drop": `github task drop <N> [--duplicate-of M] [--repo owner/repo]

Closes the task without doing it (not planned) and removes it from the project.

Examples:
  github task drop 42
  github task drop 42 --duplicate-of 17`,
  "task actualize": `github task actualize <N> [<M> …] [--assignment] [--repo owner/repo]

Right after the merge, in parallel with the deploy: the epic refresh's mechanics (blocked by on done tasks, the questions
label without open questions, milestones without open tasks; a comment on the epic) and the subagent's prompt;
--assignment (read-only, the subagent's first call) — its whole assignment: the texts of the epic and its open tasks,
the PR files, copies of links and answers in comments, the checks by meaning; no epic or no open tasks in it —
"refresh not needed". A PR merged into a batch branch (batch/*) is what shipped too, but the blocked-by links on the
task stay till the batch's release. Several tasks — shipped together, a batch's release (batch release names them):
grouped by epic, one refresh per epic — its prompt and its report («Refresh after #N, #M, result: …») name the epic's
tasks, task close of each takes it; a released task's PRs — its own into the batch, not the release's; --assignment —
the tasks of one epic.

Examples:
  github task actualize 42
  github task actualize 42 --assignment
  github task actualize 42 43 47`,
  "task resume": `github task resume

The SessionStart hook runs it: the wait to restart for the task pinned to the session — an open PR's checks, a merged PR
of an open task — the deploy and task close; no pin — nothing (code 0). Read-only on GitHub; a session with executors —
its stopped executors continued with SendMessage, then the queue command (a dispatcher's); a new executor only for one
that can't be continued, in the worktree of its task's branch.

Examples:
  github task resume`,
  "task queue": `github task queue [--epic N] [--type Task|Bug] [--priority Urgent,High] [--repo owner/repo]
github task queue --assignment <N> [--cloud | --session] [--repo owner/repo]

The dispatcher session's queue: ready tasks (open, not an epic, not in work, no open blockers — other repositories'
too —, no external blocker label) by Priority, then number, each with its executor's prompt; the rest — in work (=: In
progress, an open PR with its link, handed out to an executor of this session) and ○ lines with the reason (the
label's — from the latest «External blocker: …» comment). Marks the session as a dispatcher
(dispatchers/<CLAUDE_CODE_SESSION_ID> in ~/.config/elves): task status in it doesn't pin — the executors are subagents
with the session's id; a session with a pinned task keeps it. Before the queue, in the repository's checkout —
finished agents' worktrees (.claude/worktrees/agent-*, detached or on worktree-agent-*, not locked by a live process,
not an executor's whose handed-out task is open): clean and merged (git cherry) — removed with the branch (+),
otherwise left (○ with the reason), and so is one a subagent works in without a worktree of its own (its transcript
written in the last ${QUIET_MINUTES} min); loose worktree-agent-* branches — the same. --type and --priority — in an
organization. --assignment N (the executor's first call; read-only on GitHub) — its whole assignment; in a session
(not one pinned to N) it records the task as handed out with the executor's worktree (dispatchers/<id>.tasks). The
project's mode ("auto" in .agents/elves.json): auto — the task like a session in auto mode; outside auto — up to pr
premerge by itself, then the answer «question: merge PR #N?», the merge on the owner's «yes» the dispatcher forwards (a
cloud executor asks in its session), and Next: of the queue names that wait. A
restart while the task's previous executor or its subagent is alive — a worktree of it locked by a live process, with
such a subagent at work or HEAD moved in the last ${QUIET_MINUTES} min — code 1: ! lines and the answer that makes the
dispatcher wait, no hand-out. --cloud — printed by the dispatcher: the brief of a cloud executor (claude.ai/code) —
whole, # only at its task — and the dispatcher's steps: a cloud session can't message a local one, so the dispatcher
waits for the task's closing (ci-wait issue N, background) and closes it locally; the hand-out has no worktree, and the
queue's = line names that wait. --session — printed by the dispatcher: the prompt of an app executor session
(start_session in the folder of another project, its own worktree) — a session by its project's canon and mode, named
by the task, waiting in the background, ending with the canon's last line — and how to start it; the hand-out has no
worktree, the task is = in the queue. A batch project ("batch": true in .agents/elves.json): the first queue pushes the
dispatcher's batch branch batch/<YYYY-MM-DD>-<k> from a fresh origin/<base> (+), the next ones take the same (○), it is
kept in the marker; the assignment — the task branch from it and the PR into it, merged after the checks before a
commit and pr premerge: no CI wait (a PR into the batch runs no CI), no deploy, no epic refresh and no task close — the
release's, the task closes with it; a task merged into it is = in the queue, a blocker merged into it doesn't hold; a
cloud executor isn't in the batch — its PR goes into the default branch. Nothing ready and every task in work merged
into the batch — Next: names batch release; its release PR open — ready tasks are held (○), no new executors; red —
Next: names its guilty task by the labels and the fix with its executor's prompt (otherwise batch release names it), the
assignment of a task in a red release — the fix's (a new branch from the batch, the PR into it with Refs #N; --cloud
refused); released — a new batch, a released batch branch without an open PR into it is deleted (+).

Examples:
  github task queue --epic 40
  github task queue --type Bug --priority Urgent,High
  github task queue --assignment 42
  github task queue --assignment 42 --cloud
  github task queue --assignment 42 --session`,
  "task close": `github task close <N> [--no-git] [--repo owner/repo]

After the PR merge and the deploy (or a close without a PR) in one call: the actual (est fact --write), Status Done, the
epic and the milestone, the task's stacks taken down with their volumes (task-env down), the merged branches removed
(--no-git — without git). The epic has other open tasks and no report of the refresh subagent on it («Refresh after
#N, result: …») — a refusal before any changes; so is a task merged only into a batch branch (batch/*): it closes with
the batch's release — then the release PR is its merged PR, and the batch branch goes too, kept while a live executor's
PR is into it; its refresh — one for the release's tasks of the epic, the report naming them («Refresh after #N, #M,
result: …»). A task of the scripts' own repository: before the actual the scripts'
clone catches up with origin (pull --ff-only; only on the default branch, without uncommitted changes). Docker and gh
don't work in an agent's sandbox — run it outside.

Examples:
  github task close 42
  github task close 42 --no-git`,
  "batch release": `github batch release [<batch branch>] [--repo owner/repo]

The dispatcher's batch (epic #645) into the default branch by one PR — one full CI run and one deploy: the batch branch
(the session's, from its marker, or the one named) rebased onto a fresh origin/<base> and pushed (--force-with-lease),
the PR into the default branch — a conventional-commit title, the body: spec-diff of the batch and «Closes #N» of each
task merged into it; Next: — ci-wait, pr premerge, the merge (outside auto — on the owner's «yes»), the deploy wait and the
epic refresh — one per epic of the batch's tasks (task actualize with all of them), then task close of each task. The live
executors' open PRs into the batch aren't in it: their pr premerge holds the merge till the release, then moves them to
the next batch or the default branch. The release PR open — its steps again; red — the guilty task (the release's only
task, the labels of the decisions of the files the failed jobs' logs name, otherwise a bisect by the task boundaries on
the machine: the head, the base, then log2 N runs of the project's test script on the failed test files) and its fix in
the batch, then the full run again on the same PR; merged — the closing steps. Nothing merged — a refusal; a rebase
conflict — a ! line, code 1, the branch unchanged. From a checkout of the repository.

Examples:
  github batch release
  github batch release batch/2026-10-22-1`,
  "pr labels": `github pr labels <N> [--repo owner/repo]

Decision labels from the PR diff for the tasks from «Closes #N» (not linked yet — the task branch too) and their epics;
doesn't remove earlier ones. A decision touched only mechanically (a deletion, a rename without changes, exceptions) and
a decision with a slice label's name — an ○ line, no label. More than fit on an issue (GitHub allows
${ISSUE_LABEL_LIMIT}) — only decisions whose <folder>.md or test names (the PR body's spec section) the PR changes, as
many as fit; the rest — ○ lines. A batch's release PR — an ○ line, no labels: its tasks have theirs from their PRs into
the batch.

Examples:
  github pr labels 57`,
  "pr premerge": `github pr premerge <N> [--repo owner/repo]

Before gh pr merge, after ci-wait PASS: the default branch moved after the PR's CI — the PR head merged with it in a
temporary worktree and ${PREMERGE_SCRIPTS.join(", then ")} from package.json (those that exist, as in CI). Code 0 —
merge, 1 — don't merge (red, conflict), 2 — couldn't check, 3 — main is red by itself (the same check on bare main, a
red check on its last commit): don't merge, one bug for it — wait for it to close. A PR into a batch branch runs no
CI, so no ci-wait before it: the head on a fresh origin/<batch> — code 0 without checks (the checks before a commit
checked this tree), the batch moved on — the fast checks on the merge with it. The
batch's release PR open — code 1 and the wait for its close, but red with the PR of one of its tasks — the guilty task's
fix, checked as usual; merged — code 1 and the move: into the dispatcher's next
batch or, without one, the default branch, then a rebase onto it. The PR's commits already in the base by their
changes (git cherry) — code 1 and a rebase.

Examples:
  github pr premerge 57`,
};

/** `github --help`: what the script is and the synopsis of each command. */
const OVERVIEW = [
  "github — the repository's GitHub project and tasks by the AGENTS.md canon",
  "",
  ...Object.values(HELP).map((h) => h.split("\n\n")[0]!.replace(/^/gm, "  ")),
  "",
  "github <command> --help — the command's details and examples",
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
// no shared module: github imports no other skill (tests/standards/skill-imports); the tests/standards/origin-repo
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

export function main(argv: string[], io: Io): number {
  const help = helpOf(argv);
  if (help) return io.out(help), 0;
  N = locale.names(locale.projectLanguage(io.cwd ?? process.cwd()));
  try {
    const [group, cmd, ...rest] = argv;
    if (!group) return io.out(OVERVIEW), 2;
    if (!Object.hasOwn(HELP, `${group} ${cmd ?? ""}`)) {
      io.err(`unknown command «${argv.slice(0, 2).join(" ")}»; expected ${Object.keys(HELP).join(", ")} (github --help)`);
      return 2;
    }
    if (inCloud(io) && group === "task" && cmd === "close") {
      const n = /^#?(\d+)$/.exec(rest.find((a) => !a.startsWith("--")) ?? "")?.[1] ?? "<N>";
      io.err(`cloud session: task close is unavailable to it — no GitHub Projects in the cloud (docs/cloud-sessions.md). The actual — the ${q(N.est.cloud.actual.replace(/:$/, ""))} comment printed by est fact ${n}; ${q(N.status.done)} is set by the project's workflow ${q(WORKFLOW_CLOSED)}; the cloud's branch and container are temporary, nothing to clean up.`);
      return 2;
    }
    if (inCloud(io) && !CLOUD_COMMANDS.includes(`${group} ${cmd}`)) {
      io.err(`cloud session: GitHub GraphQL and Projects are unavailable to it (403, docs/cloud-sessions.md) — ${group} ${cmd} runs in a local session; in the cloud — ${CLOUD_COMMANDS.join(", ")} over the repository's REST`);
      return 2;
    }
    // without the manifest a command that writes names would write the `en` ones into a project of another language
    // (#681): a repository without Elves refuses too (question 2) — one rule, no guessing by package.json
    const missing = LANGUAGE_COMMANDS.includes(`${group} ${cmd}`) ? locale.missingManifest(io.cwd ?? process.cwd()) : null;
    if (missing) {
      io.err(`${group} ${cmd} writes or checks the canon's names in the project language — ${missing}; a repository without Elves — install the flow: bunx @miroshnik/elves install --lang <project language>`);
      return 2;
    }
    // the repository — under its current name: --repo or origin may still name it as it was before a rename (#560); the
    // cloud has no GraphQL, and its session is bound to its repositories by their names
    const repoOf = (v: string | undefined) => {
      const slug = v ?? detectRepo();
      if (!/^[\w.-]+\/[\w.-]+$/.test(slug)) throw new GhError(`invalid --repo «${slug}», expected owner/repo`);
      return inCloud(io) ? slug : canonicalRepo(io, slug);
    };
    if (group === "pr") {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { repo: { type: "string" } } });
      if (positionals.length > 1) throw new GhError(`extra arguments: ${positionals.slice(1).join(" ")}`);
      const m = /^#?(\d+)$/.exec((positionals[0] ?? "").trim());
      if (!m) throw new GhError(`pr ${cmd}: expected a PR number, not «${positionals[0] ?? ""}»`);
      return (cmd === "premerge" ? cmdPrPremerge : cmdPrLabels)(io, repoOf(values.repo), Number(m[1]));
    }
    if (group === "batch") {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { repo: { type: "string" } } });
      if (positionals.length > 1) throw new GhError(`extra arguments: ${positionals.slice(1).join(" ")}`);
      return cmdBatchRelease(io, repoOf(values.repo), positionals[0]);
    }
    if (group === "task") {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          repo: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
          "body-file": { type: "string" },
          type: { type: "string" },
          epic: { type: "string" },
          milestone: { type: "string" },
          "blocked-by": { type: "string" },
          priority: { type: "string" },
          "duplicate-of": { type: "string" },
          labels: { type: "string" },
          "branch-type": { type: "string" },
          branch: { type: "string" },
          "no-git": { type: "boolean", default: false },
          assignment: { type: "boolean", default: false },
          cloud: { type: "boolean", default: false },
          session: { type: "boolean", default: false },
          auto: { type: "boolean", default: false },
        },
      });
      // the task and its repository — from the session pin: the hook runs it from any directory
      if (cmd === "resume") {
        if (positionals.length) throw new GhError(`extra arguments: ${positionals.join(" ")} — task resume takes the task from the session pin`);
        return cmdTaskResume(io);
      }
      const slug = repoOf(values.repo);
      if (cmd === "new") {
        if (positionals.length) throw new GhError(`extra arguments: ${positionals.join(" ")}`);
        if (!values.title?.trim()) throw new GhError("--title is required");
        if (values.body !== undefined && values["body-file"]) throw new GhError("--body or --body-file, not both");
        const body = values["body-file"] ? readFileSync(values["body-file"], "utf8") : (values.body ?? "");
        const blockedBy = (values["blocked-by"] ?? "").split(",").filter((x) => x.trim()).map((x) => issueNumber(x, "--blocked-by"));
        const epic = values.epic === undefined ? undefined : issueNumber(values.epic, "--epic");
        const labels = (values.labels ?? "").split(",").map((x) => x.trim()).filter(Boolean);
        return cmdTaskNew(io, slug, { title: values.title, body, type: values.type, epic, milestone: values.milestone, blockedBy, priority: values.priority, labels, branchType: values["branch-type"] });
      }
      if (cmd === "queue") {
        if (values.cloud && !values.assignment) throw new GhError("--cloud — only with --assignment <N>: the brief of one task's cloud executor");
        if (values.session && !values.assignment) throw new GhError("--session — only with --assignment <N>: the prompt of one task's app executor session");
        if (values.cloud && values.session) throw new GhError("--cloud or --session, not both: a cloud executor or an app session");
        if (values.assignment) {
          if (positionals.length !== 1) throw new GhError("task queue --assignment <N>: one task number");
          return cmdTaskAssignment(io, slug, issueNumber(positionals[0], "task queue --assignment"), { cloud: values.cloud!, session: values.session! });
        }
        if (positionals.length) throw new GhError(`extra arguments: ${positionals.join(" ")} — the queue is chosen by --epic, --type and --priority`);
        const priority = values.priority === undefined ? undefined : values.priority.split(",").map((x) => x.trim()).filter(Boolean);
        return cmdTaskQueue(io, slug, { epic: values.epic === undefined ? undefined : issueNumber(values.epic, "--epic"), type: values.type, priority });
      }
      const number = issueNumber(positionals[0], `task ${cmd}`);
      if (cmd === "start") {
        if (positionals.length > 1) throw new GhError(`extra arguments: ${positionals.slice(1).join(" ")}`);
        return cmdTaskStart(io, slug, number, values.branch);
      }
      if (cmd === "status") return cmdTaskStatus(io, slug, number, positionals.slice(1).join(" "), values.branch);
      if (cmd === "answer") {
        const k = /^\d+$/.exec((positionals[1] ?? "").trim());
        if (!k) throw new GhError(`task answer: expected a question number, not «${positionals[1] ?? ""}»`);
        return cmdTaskAnswer(io, slug, number, Number(k[0]), positionals.slice(2).join(" "), values.auto!);
      }
      // several tasks — shipped together, a batch's release (#676): one refresh per epic of them
      if (cmd === "actualize") return cmdTaskActualize(io, slug, positionals.map((p) => issueNumber(p, "task actualize")), { assignment: values.assignment! });
      if (positionals.length > 1) throw new GhError(`extra arguments: ${positionals.slice(1).join(" ")}`);
      if (cmd === "show") return cmdTaskShow(io, slug, number);
      if (cmd === "close") return cmdTaskClose(io, slug, number, { git: !values["no-git"] });
      return cmdTaskDrop(io, slug, number, values["duplicate-of"] === undefined ? undefined : issueNumber(values["duplicate-of"], "--duplicate-of"));
    }
    const { values } = parseArgs({ args: rest, options: { repo: { type: "string" }, confirm: { type: "boolean", default: false }, template: { type: "string", default: DEFAULT_TEMPLATE } } });
    const slug = repoOf(values.repo);
    const template = values.template === "none" ? null : values.template!;
    if (template && !/^[\w.-]+\/\d+$/.test(template)) throw new GhError(`invalid --template «${template}», expected owner/N or none`);
    return cmd === "check" ? cmdCheck(io, slug) : cmdFix(io, slug, { confirm: values.confirm!, template });
  } catch (e) {
    if (e instanceof GhError || (e as Any)?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      io.err(`error: ${(e as Error).message}`);
      return 2;
    }
    throw e;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2), { gh: realGh, out: (l) => console.log(l), err: (l) => console.error(l), env: process.env });
}
