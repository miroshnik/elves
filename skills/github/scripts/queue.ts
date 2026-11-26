/**
 * The dispatcher's queue as a model (#843): the states of a task in the queue and of its executor, the transitions
 * between them and the dispatcher's step; the batch's release on the same model (#867). Pure — the facts come from
 * github.ts (GitHub, git, the session's hand-outs), the model reads nothing itself; `task queue` prints its `+`, `=`,
 * `○` lines and its `Next:` from it, `batch release` — its step. Why each rule is so — the decisions
 * `tests/capabilities/github/github-queue.md`, `github-release.md` and the tests next to them, one per transition.
 */

/** A task's state in the dispatcher's queue, in the order of its way. */
export const QUEUE_STATES = ["notReady", "ready", "handedOut", "prOpen", "inBatch", "releaseOpen", "releaseRed", "released", "closed"] as const;
export type QueueState = (typeof QUEUE_STATES)[number];

/**
 * An executor's state: at work; answered — merged or a question, its turn is over; waits for its subagents — their
 * answers wake it, it answers again; failed — its answer says so. The script reads only the first three
 * (`executorOf`): failed differs from answered by the answer, which the dispatcher gets.
 */
export const EXECUTOR_STATES = ["working", "answered", "waitsForSubagents", "failed"] as const;
export type ExecutorState = (typeof EXECUTOR_STATES)[number];

/** Who makes a transition happen. */
export type Actor = "dispatcher" | "executor" | "GitHub" | "owner";

/**
 * The dispatcher's step after a queue — `Next:`, the first of these its tasks call for: an executor past the batch for a
 * bug on red main the open release waits for (#886), the fix of a red release, the open release's steps, executors for
 * the ready tasks, the wait for the executors of the batch, the batch's release, the wait for those past the batch,
 * nothing left.
 */
export const STEPS = ["handOutPast", "fix", "releaseSteps", "handOut", "wait", "release", "waitPast", "empty"] as const;
export type Step = (typeof STEPS)[number];

/** A transition of a task: from a state by an event to a state; `step` — the dispatcher's `Next:` while the task waits for it. */
export interface Transition {
  from: QueueState;
  event: string;
  to: QueueState;
  by: Actor;
  step?: Step;
}

/**
 * The transitions of a task in the queue — the table `reference.md` ("task queue") shows. A state's step for the
 * dispatcher is the `step` of its first transition with one: what it does or waits for to move the task on.
 */
export const TRANSITIONS: readonly Transition[] = [
  { from: "notReady", event: "unblocked", to: "ready", by: "GitHub" },
  { from: "notReady", event: "releaseMerged", to: "ready", by: "dispatcher" },
  { from: "ready", event: "handOut", to: "handedOut", by: "dispatcher", step: "handOut" },
  { from: "ready", event: "blocked", to: "notReady", by: "owner" },
  { from: "ready", event: "releaseOpened", to: "notReady", by: "dispatcher" },
  { from: "handedOut", event: "prOpened", to: "prOpen", by: "executor", step: "wait" },
  { from: "handedOut", event: "closedWithoutPr", to: "closed", by: "executor" },
  { from: "prOpen", event: "mergedIntoBatch", to: "inBatch", by: "executor", step: "wait" },
  { from: "prOpen", event: "mergedIntoBase", to: "released", by: "executor" },
  { from: "prOpen", event: "fixMerged", to: "releaseOpen", by: "executor" },
  { from: "inBatch", event: "releaseOpened", to: "releaseOpen", by: "dispatcher", step: "release" },
  { from: "releaseOpen", event: "checksRed", to: "releaseRed", by: "GitHub", step: "releaseSteps" },
  { from: "releaseOpen", event: "premergeRed", to: "releaseRed", by: "dispatcher" },
  { from: "releaseOpen", event: "releaseMerged", to: "released", by: "dispatcher" },
  { from: "releaseRed", event: "fixOpened", to: "prOpen", by: "executor", step: "fix" },
  { from: "releaseRed", event: "fixMerged", to: "releaseOpen", by: "executor" },
  { from: "released", event: "taskClosed", to: "closed", by: "executor", step: "wait" },
];

/** The state a task moves to from `from` by `event`; no such transition — null. */
export function transition(from: QueueState, event: string): QueueState | null {
  return TRANSITIONS.find((t) => t.from === from && t.event === event)?.to ?? null;
}

/** The transitions of an executor; `step` — what the dispatcher does after it. */
export interface ExecutorTransition {
  from: ExecutorState;
  event: string;
  to: ExecutorState;
  step: string;
}

/** The executor's way — by its answers; the dispatcher's reaction to each (the table of `reference.md`, "task queue"). */
export const EXECUTOR_TRANSITIONS: readonly ExecutorTransition[] = [
  { from: "working", event: "answeredMerged", to: "answered", step: "task queue again" },
  { from: "working", event: "answeredQuestion", to: "answered", step: "the question to the owner; the answer — ✅ in the task and to the same executor with SendMessage" },
  { from: "answered", event: "continued", to: "working", step: "the executor goes on in its context (SendMessage; after the app restarts — task resume)" },
  { from: "working", event: "answeredWaits", to: "waitsForSubagents", step: "no restart: its subagents' answers wake it, it answers again" },
  { from: "waitsForSubagents", event: "woken", to: "working", step: "wait for its answer" },
  { from: "working", event: "answeredFailed", to: "failed", step: "a comment in the task with what stopped, no restart" },
];

/** The state an executor moves to from `from` by `event`; no such transition — null. */
export function executorTransition(from: ExecutorState, event: string): ExecutorState | null {
  return EXECUTOR_TRANSITIONS.find((t) => t.from === from && t.event === event)?.to ?? null;
}

/** A blocker (blocked by) as the queue reads it. */
export interface BlockerFacts {
  /** `#N` of this repository, `owner/repo#N` of another. */
  ref: string;
  open: boolean;
  /** Its PR is merged into the dispatcher's batch branch — the dependent task's executor branches from it. */
  inBatch: boolean;
  /** Closed by its PR's merge into the default branch, its tail (the deploy, task close) not over — a hand-out of this session. */
  unclosed: boolean;
}

/** What the queue knows of a task — GitHub's facts and the session's hand-out; the texts a locale gives come rendered. */
export interface TaskFacts {
  number: number;
  open: boolean;
  /** The PR that merged it into the default branch, its tail not over: its own (its executor's tail) or the batch's release. */
  closedBy: { pr: number; release: boolean } | null;
  epic: boolean;
  /** Status Done while the issue is open — `Status «Done»`; otherwise null. */
  done: string | null;
  /** In progress — `«In progress»` and how it's read (by the facts: …); otherwise null. */
  inProgress: string | null;
  /** Its open PR: the number, its link and its base. */
  openPr: { number: number; url: string; base: string } | null;
  /** Its PR merged into the dispatcher's batch branch; none — null. */
  inBatch: number | null;
  /** Handed out to an executor of this session: a subagent or an app session, past the batch (`--main`) or not. */
  handOut: { executor: "subagent" | "session"; main: boolean } | null;
  /** A PR of it open or merged into another branch than the batch's. */
  pastBatch: boolean;
  blockers: BlockerFacts[];
  /**
   * An external blocker — its line, `label «…»: <reason>`; none — null. Read only when it decides: the reason is the
   * latest comment of a labeled task, and a task in work, blocked or Done isn't read for it.
   */
  external: (() => string) | null;
  /**
   * A bug about the red default branch — the title «<base> is red…» in a dictionary language, as `pr premerge` finds it
   * (#886): an open release's premerge waits for its close, and its merge into the batch would wait for that release.
   */
  mainRed: boolean;
}

/**
 * The blockers that hold a task, named — one rule for `task queue` and `task start` (#869): open and not merged into the
 * batch the executor branches from; closed by its PR's merge before its `task close` — the deploy it waits for may not
 * have happened (#769).
 */
export function holdingBlockers(blockers: BlockerFacts[]): string[] {
  return [...blockers.filter((x) => x.open && !x.inBatch).map((x) => x.ref), ...blockers.filter((x) => !x.open && x.unclosed).map((x) => `${x.ref} (merged, not closed by task close)`)];
}

/** The dispatcher's batch as the queue reads it. */
export interface BatchFacts {
  /** The batch branch; a project without batches — null. */
  batch: string | null;
  /** The default branch. */
  base: string;
  /**
   * The batch's release PR while it is open: its checks red or not, `pr premerge` red on its head or not (#884: CI green,
   * spec-red of a test marked existing behavior against the batch — red on the default branch's code); none open — null.
   */
  release: { number: number; red: boolean; premerge: boolean } | null;
}

/** The release is red (#650, #884): by its checks or by `pr premerge` on its head — either refuses the merge, its fix is the batch's. */
export const releaseIsRed = (r: { red: boolean; premerge: boolean }) => r.red || r.premerge;

/** A task in work for the batch's release: a live executor of the batch holds it, one merged into it is settled, one past it doesn't hold. */
export type Role = "holds" | "settled" | "past";

/** A task's entry in the queue: its state, the line — its mark and text after the task's label — and its role for the release. */
export interface Entry {
  number: number;
  state: QueueState;
  /** `+` ready, `=` in work, `○` not ready; no line — null. */
  mark: "+" | "=" | "○" | null;
  why: string;
  role: Role | null;
}

/** A task's entry by its facts. */
export function entryOf(f: TaskFacts, b: BatchFacts): Entry {
  const entry = (state: QueueState, mark: Entry["mark"], why = "", role: Role | null = null): Entry => ({ number: f.number, state, mark, why, role });
  const closer = f.closedBy;
  // closed and its tail is nobody's in the queue: task close passed, or the batch's release closed it — batch release
  // prints its tail (the dispatcher's)
  if (!f.open && closer === null) return entry("closed", null);
  if (!f.open && closer!.release) return entry("released", null);
  if (f.epic) return entry("notReady", "○", `an epic: its tasks — task queue --epic ${f.number}`);
  const work = [
    closer === null ? "" : `PR #${closer.pr} merged and closed the issue — waits for the deploy and task close`,
    closer === null && f.inProgress !== null ? f.inProgress : "",
    f.openPr === null ? "" : `open PR #${f.openPr.number} ${f.openPr.url}`,
    f.inBatch === null ? "" : `PR #${f.inBatch} merged into ${b.batch} — the task closes with the batch's release`,
  ].filter(Boolean);
  if (!work.length && f.handOut?.executor === "session") work.push("handed out to an app executor session of this session (start_session) — the end of each of its turns comes as the app's note");
  else if (!work.length && f.handOut) work.push("handed out to an executor of this session");
  // a bug on red main past the batch: the release doesn't hold it, its premerge waits for it (#886)
  const waits = f.mainRed && b.release !== null ? `the release PR #${b.release.number} waits for its close` : "the release doesn't wait for it";
  if (b.batch !== null && f.handOut?.main && f.inBatch === null) work.push(`past the batch ${b.batch} (--main): its PR goes into ${b.base} with the full CI — ${waits}`);
  if (work.length) {
    const state: QueueState = closer !== null ? "released" : f.openPr !== null ? "prOpen" : f.inBatch !== null ? (b.release === null ? "inBatch" : releaseIsRed(b.release) ? "releaseRed" : "releaseOpen") : "handedOut";
    return entry(state, "=", work.join(", "), roleOf(f, b));
  }
  const blockers = holdingBlockers(f.blockers);
  if (f.done !== null) return entry("notReady", "○", `${f.done}, but the task is open`);
  if (blockers.length) return entry("notReady", "○", `blocked by ${blockers.join(", ")}`);
  if (f.external !== null) return entry("notReady", "○", f.external());
  if (b.release === null) return entry("ready", "+");
  // a bug on red main (#886): the release's premerge waits for its close, and held — or merged into the batch — it would
  // wait for the release: a circle; past the batch it goes into the default branch with the full CI
  if (f.mainRed) return entry("ready", "+", `a bug on red ${b.base}: the release of ${b.batch} (PR #${b.release.number}) waits for its close — past the batch (--main): its PR goes into ${b.base} with the full CI`, "past");
  return entry("notReady", "○", `ready, held: the release of ${b.batch} is open (PR #${b.release.number}) — no new executors till its merge`);
}

/**
 * The role of a task in work: merged into the batch with no open PR — settled; no batch — every one holds; with one — a
 * PR into the batch or a hand-out of the batch (not past it) holds, a PR into another branch, In progress without a
 * hand-out (the dispatcher's own task, another session's) and a hand-out past the batch don't.
 */
function roleOf(f: TaskFacts, b: BatchFacts): Role {
  if (f.inBatch !== null && f.openPr === null) return "settled";
  if (b.batch === null) return "holds";
  const holds = f.openPr !== null ? f.openPr.base === b.batch : f.inBatch === null && f.handOut !== null && !f.handOut.main && !f.pastBatch;
  return holds ? "holds" : "past";
}

/** A state's step for the dispatcher — of its first transition with one (`TRANSITIONS`); none — null. */
export const stateStep = (s: QueueState): Step | null => TRANSITIONS.find((t) => t.from === s && t.step)?.step ?? null;

/**
 * An entry's step: its state's; for a task past the batch — the wait after the release (`waitPast`), the hand-out before
 * the release's steps (`handOutPast`: the release waits for it, #886); no line — none.
 */
export function stepOf(e: Entry): Step | null {
  const step = e.mark === null ? null : stateStep(e.state);
  if (e.role !== "past") return step;
  return step === "wait" ? "waitPast" : step === "handOut" ? "handOutPast" : step;
}

/**
 * The dispatcher's step after the queue (`Next:`) — the first in `STEPS` of its entries' steps and the open release's
 * (red — the fix; otherwise its steps): a release isn't a task of the queue, a group without its tasks sees it too.
 */
export function queueStep(entries: Entry[], b: BatchFacts): Step {
  const release: Step | null = b.release === null ? null : stateStep(releaseIsRed(b.release) ? "releaseRed" : "releaseOpen");
  const steps = [...entries.map(stepOf), release];
  return STEPS.find((s) => steps.includes(s)) ?? "empty";
}

/** What the script reads of an executor's worktree. */
export interface ExecutorFacts {
  /** Locked by a live process (Claude Code locks a running agent's worktree) — the lock's reason; otherwise null. */
  lock: string | null;
  /** A subagent of it at work in its worktree without one of its own — the line naming it; none — null. */
  guest: string | null;
  /** HEAD moved recently (a commit, a switch) — the line; quiet or not read — null. */
  moved: string | null;
}

/** The executor's state by its worktree: locked or HEAD moved — at work; a subagent at work in it — waits for it; otherwise — answered. */
export function executorOf(f: ExecutorFacts): { state: ExecutorState; why: string | null } {
  if (f.lock !== null) return { state: "working", why: `locked by a live process — ${f.lock || "no reason"}` };
  if (f.guest !== null) return { state: "waitsForSubagents", why: f.guest };
  if (f.moved !== null) return { state: "working", why: f.moved };
  return { state: "answered", why: null };
}

/** An executor still alive: a restart waits for it, and its worktree stays. */
export const executorAlive = (s: ExecutorState) => s === "working" || s === "waitsForSubagents";

/** The queue may remove a finished agent's worktree: its executor isn't alive and its task isn't live (open, or its tail not over). */
export const worktreeRemovable = (executor: ExecutorState, taskLive: boolean) => !taskLive && !executorAlive(executor);

/**
 * The batch's release (#867) — the same model: its states, the transitions between them, the step of `batch release`.
 * Why each rule is so — the decision `tests/capabilities/github/github-release.md` and its tests, one per transition.
 */

/** The release of the batch: no PR yet, its PR open (its checks running, none yet or green), red, merged. */
export const RELEASE_STATES = ["none", "open", "red", "merged"] as const;
export type ReleaseState = (typeof RELEASE_STATES)[number];

/** The dispatcher's step after `batch release` — `Next:`: the release PR's checks and merge, the red one's fix, the merged one's closing steps. */
export const RELEASE_STEPS = ["checks", "fix", "close"] as const;
export type ReleaseStep = (typeof RELEASE_STEPS)[number];

/** A transition of the release; `by` "batch release" — the command makes it itself; `step` — `Next:` while the release waits for it. */
export interface ReleaseTransition {
  from: ReleaseState;
  event: string;
  to: ReleaseState;
  by: Actor | "batch release";
  step?: ReleaseStep;
}

/**
 * The release's transitions — the table `reference.md` ("batch release") shows. A state's step is the `step` of its
 * first transition with one; `merged` → `none` — the queue starts the next batch from the merged default branch, and
 * the session's batch is that one, without a release.
 */
export const RELEASE_TRANSITIONS: readonly ReleaseTransition[] = [
  { from: "none", event: "opened", to: "open", by: "batch release" },
  { from: "open", event: "checksRed", to: "red", by: "GitHub" },
  { from: "open", event: "premergeRed", to: "red", by: "dispatcher" },
  { from: "open", event: "merged", to: "merged", by: "dispatcher", step: "checks" },
  { from: "red", event: "fixMerged", to: "open", by: "executor", step: "fix" },
  { from: "merged", event: "nextBatch", to: "none", by: "dispatcher", step: "close" },
];

/** The state the release moves to from `from` by `event`; no such transition — null. */
export function releaseTransition(from: ReleaseState, event: string): ReleaseState | null {
  return RELEASE_TRANSITIONS.find((t) => t.from === from && t.event === event)?.to ?? null;
}

/**
 * What `batch release` knows of the release: its PR — merged, or open with its checks red or not and `pr premerge` red
 * on its head or not; none — null.
 */
export interface ReleaseFacts {
  pr: { merged: boolean; red: boolean; premerge: boolean } | null;
  /** The PRs with tasks merged into the batch branch: none — nothing to release. */
  merged: number;
}

/** The release's state by its facts. */
export function releaseStateOf(f: ReleaseFacts): ReleaseState {
  if (f.pr === null) return "none";
  return f.pr.merged ? "merged" : releaseIsRed(f.pr) ? "red" : "open";
}

/** A release state's step — of its first transition with one (`RELEASE_TRANSITIONS`); none — null. */
export const releaseStateStep = (s: ReleaseState): ReleaseStep | null => RELEASE_TRANSITIONS.find((t) => t.from === s && t.step)?.step ?? null;

/**
 * `batch release` by the facts: no PR and nothing merged into the batch — null, it refuses; otherwise the state it
 * reads (`from`), the one it leaves the release in by its own transition (`none` — opened; another — the same) and
 * `Next:` — the step of that one.
 */
export function releaseRun(f: ReleaseFacts): { from: ReleaseState; to: ReleaseState; next: ReleaseStep } | null {
  const from = releaseStateOf(f);
  if (from === "none" && f.merged === 0) return null;
  const to = RELEASE_TRANSITIONS.find((t) => t.from === from && t.by === "batch release")?.to ?? from;
  return { from, to, next: releaseStateStep(to)! };
}

/**
 * The fix of a red release, the first that holds: a fix PR of its task open into the batch — wait for it; the guilty
 * task named — its fix; not named by the labels — `batch release` names it by the bisect; not named after the bisect,
 * or red only by `pr premerge` (#884: nothing to bisect — the machine reproduces a check, and every check is green) —
 * the dispatcher by the failed checks' logs and the ❌ lines of `pr premerge`, or the owner.
 */
export const FIXES = ["wait", "guilty", "bisect", "owner"] as const;
export type Fix = (typeof FIXES)[number];

/** What the fix is chosen by. */
export interface FixFacts {
  /** A release task's fix PR is open into the batch. */
  fixing: boolean;
  /** The guilty task is named: the release's only task, by the labels, by the bisect. */
  guilty: boolean;
  /** The caller bisects — `batch release`; the queue names the guilty task by the labels only. */
  bisects: boolean;
  /** A check of the release's CI is red — the bisect reproduces it on the machine; red only by `pr premerge` — none (#884). */
  bisectable: boolean;
}

/** The fix of a red release by its facts (`FIXES`). */
export function redFix(f: FixFacts): Fix {
  if (f.fixing) return "wait";
  if (f.guilty) return "guilty";
  return f.bisects || !f.bisectable ? "owner" : "bisect";
}

/** What `pr premerge` knows of a PR into the batch while the batch's release is open. */
export interface IntoReleaseFacts {
  /** The PR is of a release task: its task branch or «Closes #N» — one of the release's «Closes #N». */
  ofRelease: boolean;
  /** A check of the release red (`fail`, `cancel`). */
  red: boolean;
  /** `pr premerge` red on the release's head (#884). */
  premerge: boolean;
  /** A check of the release still running, or none yet: the head moved. */
  running: boolean;
  /** A PR of a release task merged into the batch after the release opened — a fix merged, its head moved. */
  fixMerged: boolean;
}

/**
 * A PR into the batch while its release is open (#650, #902): it goes in as the red release's fix, otherwise it waits for
 * the release's close. The fix — a release task's PR while the release is red (`releaseIsRed`) or its full run goes
 * again after a fix merged: a red release's guilty tasks are fixed in parallel, the first one's merge moves the head, and
 * the run on it is running, not red — the other fixes waited for a close the release never reaches without them. Held —
 * a task not in the release (its place — the next batch) and any PR while the release is green or its first run goes:
 * the release is checked without it.
 */
export const fixGoesIn = (f: IntoReleaseFacts) => f.ofRelease && (releaseIsRed(f) || (f.running && f.fixMerged));
