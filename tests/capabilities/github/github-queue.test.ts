import { readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";

import {
  entryOf,
  EXECUTOR_STATES,
  EXECUTOR_TRANSITIONS,
  executorOf,
  executorTransition,
  QUEUE_STATES,
  queueStep,
  stateStep,
  STEPS,
  transition,
  TRANSITIONS,
  worktreeRemovable,
} from "../../../skills/github/scripts/queue.ts";
import type { BatchFacts, ExecutorFacts, ExecutorState, ExecutorTransition, QueueState, TaskFacts, Transition } from "../../../skills/github/scripts/queue.ts";
import { invariant } from "../../../skills/spec/scripts/harness.ts";

/** Состояния по-русски — для названий тестов. */
const STATE: Record<QueueState, string> = {
  notReady: "не готова",
  ready: "готова",
  handedOut: "выдана",
  prOpen: "PR открыт",
  inBatch: "влита в пачку",
  releaseOpen: "выпуск открыт",
  releaseRed: "выпуск красный",
  released: "выпущена",
  closed: "закрыта",
};
const EXECUTOR: Record<ExecutorState, string> = { working: "работает", answered: "ответил", waitsForSubagents: "ждёт субагентов", failed: "упал" };

const BATCH = "batch/2026-11-17-1";
/** Факты задачи: открытая, без блокеров и PR, не выдана — готовая; случай меняет только то, что делает его состояние. */
const task = (more: Partial<TaskFacts> = {}): TaskFacts => ({
  number: 47,
  open: true,
  closedBy: null,
  epic: false,
  done: null,
  inProgress: null,
  openPr: null,
  inBatch: null,
  handOut: null,
  pastBatch: false,
  blockers: [],
  external: null,
  ...more,
});
/** Пачка диспетчера без открытого выпуска; без пачек — `NONE`. */
const batch = (more: Partial<BatchFacts> = {}): BatchFacts => ({ batch: BATCH, base: "main", release: null, ...more });
const NONE: BatchFacts = { batch: null, base: "main", release: null };
const RELEASE = { number: 80, red: false };
const RED = { number: 80, red: true };
const handOut = { executor: "subagent", main: false } as const;
const prInto = (base: string, number = 300) => ({ number, url: `https://github.com/acme/shop/pull/${number}`, base });
const blocker = (more: Partial<TaskFacts["blockers"][number]> = {}) => ({ ref: "#42", open: true, inBatch: false, unclosed: false, ...more });

type Facts = [TaskFacts, BatchFacts];
/**
 * Случай перехода — факты до события и после: очередь читает «до» как `from`, «после» — как `to`. Ключ — исходное
 * состояние и событие; переход таблицы без случая здесь — красный тест.
 */
const CASES: Record<string, { name: string; before: Facts; after: Facts }> = {
  "notReady unblocked": {
    name: "блокер закрыт — задача снова среди готовых (#512)",
    before: [task({ blockers: [blocker()] }), NONE],
    after: [task({ blockers: [blocker({ open: false })] }), NONE],
  },
  "notReady releaseMerged": {
    name: "выпуск влит — придержанная им готовая задача снова выдаётся (#649)",
    before: [task(), batch({ release: RELEASE })],
    after: [task(), batch({ batch: "batch/2026-11-17-2" })],
  },
  "ready handOut": {
    name: "задание исполнителю записало выдачу — задача в работе до его ответа, хотя «В работе» он ставит позже (#513)",
    before: [task(), NONE],
    after: [task({ handOut }), NONE],
  },
  "ready blocked": {
    name: "связь blocked by с открытой задачей — задача не готова",
    before: [task(), NONE],
    after: [task({ blockers: [blocker()] }), NONE],
  },
  "ready releaseOpened": {
    name: "открыт выпуск пачки — готовая задача придержана: влитое в пачку сейчас поменяло бы то, что проверил его CI (#649)",
    before: [task(), batch()],
    after: [task(), batch({ release: RELEASE })],
  },
  "handedOut prOpened": {
    name: "исполнитель открыл PR — задача в работе строкой со ссылкой на PR, пока он ждёт проверки, а не пропадает из обоих списков (#513)",
    before: [task({ handOut }), batch()],
    after: [task({ handOut, openPr: prInto(BATCH) }), batch()],
  },
  "handedOut closedWithoutPr": {
    name: "задача без PR закрыта исполнителем как выполненная — её актуализация и task close у него, не у выпуска (#628)",
    before: [task({ handOut }), batch()],
    after: [task({ handOut, open: false }), batch()],
  },
  "prOpen mergedIntoBatch": {
    name: "PR влит в пачку — задача «В работе» до выпуска и второй раз не выдаётся (вопрос 1 эпика #645)",
    before: [task({ handOut, openPr: prInto(BATCH) }), batch()],
    after: [task({ handOut, inBatch: 300 }), batch()],
  },
  "prOpen mergedIntoBase": {
    name: "PR влит в main и закрыл задачу «Closes» — она в работе до деплоя и task close, её зависимые ждут (#769)",
    before: [task({ handOut, openPr: prInto("main") }), NONE],
    after: [task({ handOut, open: false, closedBy: { pr: 300, release: false } }), NONE],
  },
  "prOpen fixMerged": {
    name: "починка красного выпуска влита в пачку — полный прогон выпуска заново на том же PR, без второго PR (#650)",
    before: [task({ handOut, inBatch: 300, openPr: prInto(BATCH, 310) }), batch({ release: RED })],
    after: [task({ handOut, inBatch: 310 }), batch({ release: RELEASE })],
  },
  "inBatch releaseOpened": {
    name: "batch release открыл PR выпуска — влитые задачи ждут его проверок и мержа (#649)",
    before: [task({ handOut, inBatch: 300 }), batch()],
    after: [task({ handOut, inBatch: 300 }), batch({ release: RELEASE })],
  },
  "releaseOpen checksRed": {
    name: "проверки выпуска красные — его задачи в красном выпуске, он чинится в пачке, а не откатывается (#650)",
    before: [task({ handOut, inBatch: 300 }), batch({ release: RELEASE })],
    after: [task({ handOut, inBatch: 300 }), batch({ release: RED })],
  },
  "releaseOpen releaseMerged": {
    name: "выпуск влит — его «Closes» закрыл задачи пачки, их хвост печатает batch release, строки в очереди нет (#649)",
    before: [task({ handOut, inBatch: 300 }), batch({ release: RELEASE })],
    after: [task({ handOut, inBatch: 300, open: false, closedBy: { pr: 80, release: true } }), batch({ batch: "batch/2026-11-17-2" })],
  },
  "releaseRed fixOpened": {
    name: "виновная задача открыла PR починки в пачку — её исполнитель продолжает, выпуск ждёт (#650)",
    before: [task({ handOut, inBatch: 300 }), batch({ release: RED })],
    after: [task({ handOut, inBatch: 300, openPr: prInto(BATCH, 310) }), batch({ release: RED })],
  },
  "releaseRed fixMerged": {
    name: "починка другой задачи выпуска влита — выпуск снова проверяется, задача ждёт его мержа (#650)",
    before: [task({ number: 49, handOut, inBatch: 301 }), batch({ release: RED })],
    after: [task({ number: 49, handOut, inBatch: 301 }), batch({ release: RELEASE })],
  },
  "released taskClosed": {
    name: "task close записал факт и «Готово» — задача уходит из очереди и не держит зависимые (#769)",
    before: [task({ handOut, open: false, closedBy: { pr: 300, release: false } }), NONE],
    after: [task({ handOut, open: false }), NONE],
  },
};

const transitionName = (t: Transition) => `«${STATE[t.from]}» → «${STATE[t.to]}» по ${t.event}: ${CASES[`${t.from} ${t.event}`]?.name ?? "случая нет"}`;

describe("Каждый переход задачи в очереди — факты до и после читаются его состояниями", () => {
  invariant<Transition>(it, {
    registry: "переходы задачи в очереди (queue.ts)",
    items: TRANSITIONS,
    name: transitionName,
    key: (t) => `${t.from} ${t.event}`,
    check: (t) => {
      const c = CASES[`${t.from} ${t.event}`];
      if (!c) throw new Error(`${t.from} ${t.event}: нет случая в CASES`);
      expect({ before: entryOf(...c.before).state, after: entryOf(...c.after).state, table: transition(t.from, t.event) }).toEqual({ before: t.from, after: t.to, table: t.to });
    },
    violator: { name: "переход, которого факты не дают", item: { from: "ready", event: "handOut", to: "prOpen", by: "dispatcher" } },
  });

  it("событие, которого нет у состояния, задачу не двигает", () => {
    expect(transition("closed", "handOut")).toBeNull();
    expect(transition("ready", "mergedIntoBatch")).toBeNull();
  });

  it("у каждого состояния есть переход в него или из него", () => {
    expect(QUEUE_STATES.filter((s) => !TRANSITIONS.some((t) => t.from === s || t.to === s))).toEqual([]);
  });
});

/** Что скрипт читает в worktree исполнителя в каждом состоянии; «упал» — только из ответа: по worktree он «ответил». */
const LOCK = "claude agent agent-a1b2 (pid 4242 start 1700000000)";
const GUEST = "subagent agent-c3d4 works in it without a worktree of its own — its transcript written 2 min ago, quiet after 15";
const MOVED = "HEAD moved 3 min ago (a commit or a switch), quiet after 15";
const EXECUTOR_CASES: Record<string, { name: string; before: ExecutorFacts; after: ExecutorFacts; reads?: ExecutorState }> = {
  "working answeredMerged": { name: "ответ «влито» снимает блокировку worktree — диспетчер читает очередь заново", before: { lock: LOCK, guest: null, moved: null }, after: { lock: null, guest: null, moved: null } },
  "working answeredQuestion": { name: "ответ-вопрос — вопрос владельцу, ответ — тому же исполнителю через SendMessage", before: { lock: LOCK, guest: null, moved: null }, after: { lock: null, guest: null, moved: null } },
  "answered continued": {
    name: "продолженный исполнитель работает без блокировки — его выдают сдвинутый HEAD и выдача задачи (#533, #565)",
    before: { lock: null, guest: null, moved: null },
    after: { lock: null, guest: null, moved: MOVED },
  },
  "working answeredWaits": {
    name: "ответ «ждёт субагентов» — его субагент работает в его каталоге, worktree не убирается (#571)",
    before: { lock: LOCK, guest: null, moved: null },
    after: { lock: null, guest: GUEST, moved: null },
  },
  "waitsForSubagents woken": { name: "ответ субагента будит исполнителя — он отвечает снова, без перезапуска (#565)", before: { lock: null, guest: GUEST, moved: null }, after: { lock: LOCK, guest: null, moved: null } },
  "working answeredFailed": {
    name: "ответ «сломалось» — комментарий в задаче, без перезапуска; по worktree он неотличим от ответившего",
    before: { lock: LOCK, guest: null, moved: null },
    after: { lock: null, guest: null, moved: null },
    reads: "answered",
  },
};

describe("Каждый переход исполнителя — по его ответу, и что скрипт читает до и после", () => {
  invariant<ExecutorTransition>(it, {
    registry: "переходы исполнителя (queue.ts)",
    items: EXECUTOR_TRANSITIONS,
    name: (t) => `исполнитель «${EXECUTOR[t.from]}» → «${EXECUTOR[t.to]}» по ${t.event}: ${EXECUTOR_CASES[`${t.from} ${t.event}`]?.name ?? "случая нет"}`,
    key: (t) => `${t.from} ${t.event}`,
    check: (t) => {
      const c = EXECUTOR_CASES[`${t.from} ${t.event}`];
      if (!c) throw new Error(`${t.from} ${t.event}: нет случая в EXECUTOR_CASES`);
      expect({ before: executorOf(c.before).state, after: executorOf(c.after).state, table: executorTransition(t.from, t.event), step: t.step.length > 0 }).toEqual({
        before: t.from,
        after: c.reads ?? t.to,
        table: t.to,
        step: true,
      });
    },
    violator: { name: "переход исполнителя без случая", item: { from: "failed", event: "restarted", to: "working", step: "a second executor" } },
  });

  it("у каждого состояния исполнителя есть переход", () => {
    expect(EXECUTOR_STATES.filter((s) => !EXECUTOR_TRANSITIONS.some((t) => t.from === s || t.to === s))).toEqual([]);
  });
});

describe("Сценарии очереди диспетчера на модели", () => {
  it("Готовая задача без блокеров при выдаче задания становится выданной", () => {
    const before = entryOf(task(), NONE);
    expect(before).toMatchObject({ state: "ready", mark: "+" });
    expect(queueStep([before], NONE)).toBe("handOut");
    const after = entryOf(task({ handOut }), NONE);
    expect(after).toEqual({ number: 47, state: "handedOut", mark: "=", why: "handed out to an executor of this session", role: "holds" });
    expect(transition("ready", "handOut")).toBe("handedOut");
    // выдана — среди «в работе»: следующий шаг диспетчера — ждать ответа исполнителя, а не выдать её второму
    expect(queueStep([after], NONE)).toBe("wait");
  });

  it("Задача с открытым PR в пачку — в работе и повторно не выдаётся", () => {
    // и без записи о выдаче — PR находится связью или веткой задачи и «Closes #N»: другой сессии она тоже не готова
    for (const f of [task({ handOut, openPr: prInto(BATCH) }), task({ openPr: prInto(BATCH) })]) {
      const e = entryOf(f, batch());
      expect(e).toMatchObject({ state: "prOpen", mark: "=", why: `open PR #300 https://github.com/acme/shop/pull/300`, role: "holds" });
      expect(queueStep([e], batch())).toBe("wait");
    }
    // открытый PR в main у задачи пачки выпуск не держит — она мимо пачки
    expect(entryOf(task({ openPr: prInto("main") }), batch()).role).toBe("past");
  });

  it("Задача, влитая в пачку, не держит зависимую задачу той же пачки и держит задачу вне её", () => {
    const merged = entryOf(task({ number: 42, handOut, inBatch: 300 }), batch());
    expect(merged).toMatchObject({ state: "inBatch", mark: "=", why: `PR #300 merged into ${BATCH} — the task closes with the batch's release`, role: "settled" });
    // исполнитель зависимой ведёт ветку от пачки — влитый в неё блокер у него уже есть
    expect(entryOf(task({ blockers: [blocker({ inBatch: true })] }), batch())).toMatchObject({ state: "ready", mark: "+" });
    // блокер влит в другую пачку или не влит — держит, как без пачек
    expect(entryOf(task({ blockers: [blocker()] }), batch())).toMatchObject({ state: "notReady", why: "blocked by #42" });
    // блокер закрыт мержем в main, task close не прошёл — держит до него (#769)
    expect(entryOf(task({ blockers: [blocker({ open: false, unclosed: true })] }), batch())).toMatchObject({ state: "notReady", why: "blocked by #42 (merged, not closed by task close)" });
  });

  it("Открытый выпуск держит готовые задачи до своего мержа", () => {
    const held = entryOf(task(), batch({ release: RELEASE }));
    expect(held).toMatchObject({ state: "notReady", mark: "○", why: `ready, held: the release of ${BATCH} is open (PR #80) — no new executors till its merge` });
    // шаг — выпуск, а не выдача: новых исполнителей до его мержа нет
    expect(queueStep([held, entryOf(task({ number: 42, handOut, inBatch: 300 }), batch({ release: RELEASE }))], batch({ release: RELEASE }))).toBe("releaseSteps");
    // выпуск — пачки, а не задачи: группа без его задач тоже ждёт его, а не «очередь пуста»
    expect(queueStep([held], batch({ release: RELEASE }))).toBe("releaseSteps");
    // выпуск влит — следующая пачка, задача снова готова
    const next = batch({ batch: "batch/2026-11-17-2" });
    expect(queueStep([entryOf(task(), next)], next)).toBe("handOut");
  });

  /**
   * Модель решает, что шаг — починка; виновную по меткам или бисектом называет `redRelease`, текст починки с заданием
   * виновной — `fixSteps` (тест «Next: очереди и шаги batch release на красном выпуске называют виновную задачу и её
   * починку» в github-task).
   */
  it("Красный выпуск называет виновную задачу и её починку", () => {
    const red = batch({ release: RED });
    const tasks = [entryOf(task({ handOut, inBatch: 300 }), red), entryOf(task({ number: 49, handOut, inBatch: 301 }), red)];
    expect(tasks.map((e) => e.state)).toEqual(["releaseRed", "releaseRed"]);
    // починка — первым шагом: раньше выдачи (готовые придержаны) и ожидания исполнителей
    const others = [entryOf(task({ number: 50 }), red), entryOf(task({ number: 51, handOut }), red)];
    expect(queueStep([...tasks, ...others], red)).toBe("fix");
    // и в группе без задач выпуска — починка, а не ожидание её исполнителей
    expect(queueStep(others, red)).toBe("fix");
    // починка виновной — её PR в пачку, затем полный прогон на том же PR выпуска
    expect(transition("releaseRed", "fixOpened")).toBe("prOpen");
    expect(entryOf(task({ handOut, inBatch: 300, openPr: prInto(BATCH, 310) }), red)).toMatchObject({ state: "prOpen", role: "holds" });
    expect(transition("prOpen", "fixMerged")).toBe("releaseOpen");
    expect(queueStep([entryOf(task({ handOut, inBatch: 310 }), batch({ release: RELEASE }))], batch({ release: RELEASE }))).toBe("releaseSteps");
  });

  it("Worktree работающего исполнителя не убирается", () => {
    const working = executorOf({ lock: LOCK, guest: null, moved: null });
    expect(working).toEqual({ state: "working", why: `locked by a live process — ${LOCK}` });
    // задача уже закрыта, worktree чистый — живого исполнителя это не отменяет
    expect(worktreeRemovable(working.state, false)).toBe(false);
    expect(worktreeRemovable(executorOf({ lock: null, guest: GUEST, moved: null }).state, false)).toBe(false);
    // ответивший — убирается, но не пока его задача жива: открыта или ждёт task close (#533, #769)
    const answered = executorOf({ lock: null, guest: null, moved: null }).state;
    expect(worktreeRemovable(answered, true)).toBe(false);
    expect(worktreeRemovable(answered, false)).toBe(true);
  });

  it("Строка `Next:` очереди выводится из таблицы переходов", () => {
    /** Задача в каждом состоянии со строкой — её факты. */
    const BY_STATE: Partial<Record<QueueState, Facts>> = {
      ready: [task(), batch()],
      handedOut: [task({ handOut }), batch()],
      prOpen: [task({ openPr: prInto(BATCH) }), batch()],
      inBatch: [task({ inBatch: 300 }), batch()],
      releaseOpen: [task({ inBatch: 300 }), batch({ release: RELEASE })],
      releaseRed: [task({ inBatch: 300 }), batch({ release: RED })],
      released: [task({ open: false, closedBy: { pr: 300, release: false } }), NONE],
    };
    for (const [state, [f, b]] of Object.entries(BY_STATE) as [QueueState, Facts][]) {
      // шаг состояния — шаг первого его перехода с шагом в таблице
      const step = TRANSITIONS.find((t) => t.from === state && t.step)?.step;
      expect({ state, step: queueStep([entryOf(f, b)], b) }).toEqual({ state, step: step! });
      expect(stateStep(state)).toBe(step!);
    }
    // не готовая и закрытая шага не дают: ждать нечего — очередь пуста
    expect(queueStep([entryOf(task({ blockers: [blocker()] }), NONE), entryOf(task({ open: false }), NONE)], NONE)).toBe("empty");
    // несколько задач — первый шаг в порядке STEPS: готовая раньше ожидания, ожидание исполнителя пачки — раньше выпуска
    expect(queueStep([entryOf(task({ handOut }), NONE), entryOf(task({ number: 49 }), NONE)], NONE)).toBe("handOut");
    expect(queueStep([entryOf(task({ inBatch: 300 }), batch()), entryOf(task({ number: 49, handOut }), batch())], batch())).toBe("wait");
    // задача мимо пачки выпуск не держит: влитое — к выпуску
    expect(queueStep([entryOf(task({ inBatch: 300 }), batch()), entryOf(task({ number: 49, handOut: { executor: "subagent", main: true } }), batch())], batch())).toBe("release");
    expect(STEPS.at(-1)).toBe("empty");
  });
});

/**
 * Справка «task queue» показывает переходы таблицей — строкой на переход модели: правка таблицы в коде без справки,
 * как и строка справки без перехода, — красный тест.
 */
describe("Справка github показывает таблицы переходов модели очереди", () => {
  const REFERENCE = readFileSync(new URL("../../../skills/github/reference.md", import.meta.url), "utf8");
  const rows = (text: string) => text.split("\n").filter((l) => /^\| `\w+` \| `\w+` \| `\w+` \|/.test(l));

  it("Справка task queue — строка на каждый переход задачи и исполнителя, лишних нет", () => {
    const expected = [...TRANSITIONS.map((t) => `| \`${t.from}\` | \`${t.event}\` | \`${t.to}\` | ${t.by} |`), ...EXECUTOR_TRANSITIONS.map((t) => `| \`${t.from}\` | \`${t.event}\` | \`${t.to}\` | ${t.step} |`)];
    expect(rows(REFERENCE)).toEqual(expected);
  });
});
