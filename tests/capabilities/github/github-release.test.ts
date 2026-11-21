import { readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";

import {
  executorOf,
  FIXES,
  redFix,
  RELEASE_STATES,
  RELEASE_STEPS,
  RELEASE_TRANSITIONS,
  releaseRun,
  releaseStateOf,
  releaseStateStep,
  releaseTransition,
  worktreeRemovable,
} from "../../../skills/github/scripts/queue.ts";
import type { Fix, FixFacts, ReleaseFacts, ReleaseState, ReleaseTransition } from "../../../skills/github/scripts/queue.ts";
import { invariant } from "../../../skills/spec/scripts/harness.ts";

/** Состояния выпуска по-русски — для названий тестов. */
const STATE: Record<ReleaseState, string> = { none: "нет", open: "открыт", red: "красный", merged: "влит" };

/** Факты выпуска: PR выпуска нет, в пачку влит PR задачи — выпускать есть что; случай меняет только то, что делает его состояние. */
const facts = (more: Partial<ReleaseFacts> = {}): ReleaseFacts => ({ pr: null, merged: 1, ...more });
const OPEN = { merged: false, red: false, premerge: false };
const RED = { merged: false, red: true, premerge: false };
/** CI выпуска зелёный, `pr premerge` на его голове — ❌ (#884). */
const PREMERGE_RED = { merged: false, red: false, premerge: true };
const MERGED = { merged: true, red: false, premerge: false };

/**
 * Случай перехода выпуска — факты до события и после: `batch release` читает «до» как `from`, «после» — как `to`. Ключ —
 * исходное состояние и событие; переход таблицы без случая здесь — красный тест.
 */
const CASES: Record<string, { name: string; before: ReleaseFacts; after: ReleaseFacts }> = {
  "none opened": {
    name: "batch release открыл PR выпуска — влитое в пачку уходит в main одним PR: один полный CI и один деплой на пачку (#649)",
    before: facts(),
    after: facts({ pr: OPEN }),
  },
  "open checksRed": {
    name: "проверки выпуска красные — он чинится в пачке, а не откатывается: PR выпуска остаётся открытым (#650)",
    before: facts({ pr: OPEN }),
    after: facts({ pr: RED }),
  },
  "open premergeRed": {
    name: "CI зелёный, а pr premerge на голове выпуска — ❌ (spec-red против main) — выпуск красный, как по чекам: чинит виновная задача в пачке (#884)",
    before: facts({ pr: OPEN }),
    after: facts({ pr: PREMERGE_RED }),
  },
  "open merged": {
    name: "PR выпуска влит после зелёных проверок и pr premerge — его «Closes» закрыл задачи пачки, их хвост — у диспетчера (#649)",
    before: facts({ pr: OPEN }),
    after: facts({ pr: MERGED }),
  },
  "red fixMerged": {
    name: "починка виновной задачи влита в пачку — голова выпуска сдвинулась, полный прогон заново на том же PR, второго PR нет (#650)",
    before: facts({ pr: RED }),
    after: facts({ pr: OPEN, merged: 2 }),
  },
  "merged nextBatch": {
    name: "очередь начала следующую пачку из влитого main — у пачки сессии выпуска ещё нет, в неё ещё ничего не влито (#787)",
    before: facts({ pr: MERGED }),
    after: facts({ merged: 0 }),
  },
};

describe("Каждый переход выпуска пачки — факты до и после читаются его состояниями", () => {
  invariant<ReleaseTransition>(it, {
    registry: "переходы выпуска пачки (queue.ts)",
    items: RELEASE_TRANSITIONS,
    name: (t) => `«${STATE[t.from]}» → «${STATE[t.to]}» по ${t.event}: ${CASES[`${t.from} ${t.event}`]?.name ?? "случая нет"}`,
    key: (t) => `${t.from} ${t.event}`,
    check: (t) => {
      const c = CASES[`${t.from} ${t.event}`];
      if (!c) throw new Error(`${t.from} ${t.event}: нет случая в CASES`);
      expect({ before: releaseStateOf(c.before), after: releaseStateOf(c.after), table: releaseTransition(t.from, t.event) }).toEqual({ before: t.from, after: t.to, table: t.to });
    },
    violator: { name: "переход, которого факты не дают", item: { from: "red", event: "merged", to: "merged", by: "dispatcher" } },
  });

  it("событие, которого нет у состояния, выпуск не двигает", () => {
    expect(releaseTransition("red", "merged")).toBeNull();
    expect(releaseTransition("none", "checksRed")).toBeNull();
  });

  it("у каждого состояния выпуска есть переход в него и из него", () => {
    expect(RELEASE_STATES.filter((s) => !RELEASE_TRANSITIONS.some((t) => t.from === s) || !RELEASE_TRANSITIONS.some((t) => t.to === s))).toEqual([]);
  });
});

/** Случай починки красного выпуска — факты, по которым модель её выбирает; починка без случая — красный тест. */
const FIX_CASES: Record<Fix, { name: string; facts: FixFacts }> = {
  wait: {
    name: "PR починки задачи выпуска открыт в пачку — ждать ответа её исполнителя: виновную не ищут, бисекта нет (#650)",
    facts: { fixing: true, guilty: false, bisects: true, bisectable: true },
  },
  guilty: {
    name: "виновная названа — единственная задача выпуска, по меткам решений упавших тестов или бисектом: её исполнитель чинит в пачке (#650, #689)",
    facts: { fixing: false, guilty: true, bisects: false, bisectable: true },
  },
  bisect: {
    name: "очередь по меткам виновную не назвала — её называет batch release: бисект по границам задач на машине — его (#650)",
    facts: { fixing: false, guilty: false, bisects: false, bisectable: true },
  },
  owner: {
    name: "бисект виновную не назвал — диспетчер называет её по логам упавших проверок или спрашивает владельца (#650)",
    facts: { fixing: false, guilty: false, bisects: true, bisectable: true },
  },
};

describe("Починку красного выпуска выбирает модель — по фактам, первую, что выполнена", () => {
  invariant<Fix>(it, {
    registry: "починки красного выпуска (queue.ts)",
    items: FIXES,
    name: (x) => `починка ${x}: ${FIX_CASES[x]?.name ?? "случая нет"}`,
    key: (x) => x,
    check: (x) => {
      const c = FIX_CASES[x];
      if (!c) throw new Error(`${x}: нет случая в FIX_CASES`);
      expect(redFix(c.facts)).toBe(x);
    },
    violator: { name: "починка без случая", item: "revert" as Fix },
  });

  it("открытый PR починки важнее названной виновной: её исполнитель уже чинит", () => {
    expect(redFix({ fixing: true, guilty: true, bisects: false, bisectable: true })).toBe("wait");
  });

  /**
   * Бисект воспроизводит на машине упавшую проверку CI (#650); у выпуска, красного только по `pr premerge` (#884), все
   * чеки зелёные — тесты на каждой границе зелёные, бисект никого не назвал бы: не названа по меткам файла из строки ❌ —
   * диспетчер по строкам ❌ `pr premerge` или владелец, и у очереди тоже.
   */
  it("красный только по pr premerge — бисекта нет: метки виновную не назвали — диспетчер по строкам ❌ или владелец", () => {
    expect(redFix({ fixing: false, guilty: false, bisects: false, bisectable: false })).toBe("owner");
    expect(redFix({ fixing: false, guilty: false, bisects: true, bisectable: false })).toBe("owner");
    expect(redFix({ fixing: false, guilty: true, bisects: false, bisectable: false })).toBe("guilty");
  });
});

describe("Сценарии выпуска пачки на модели", () => {
  /**
   * Отказ и его текст — `cmdBatchRelease` (тест «batch release без влитых в пачку задач отказывает: выпускать нечего»
   * в github-task).
   */
  it("Выпуск без PR и без влитых задач отказывает", () => {
    expect(releaseRun(facts({ merged: 0 }))).toBeNull();
    // влитое есть — PR открывается, шаги — открытого
    expect(releaseRun(facts())).toEqual({ from: "none", to: "open", next: "checks" });
    // PR выпуска есть — его состояние, отказа нет: влитое в пачку уже в нём
    expect(releaseRun(facts({ pr: OPEN, merged: 0 }))).toEqual({ from: "open", to: "open", next: "checks" });
  });

  /**
   * Модель решает, что batch release в открытом выпуске его не двигает и печатает шаги открытого; тело по влитому сейчас
   * пересобирает `act.open` (тест «Задача, закрытая фикс-PR красного выпуска, закрывается выпуском пачки, как остальные»
   * в github-task), повтор без нового влитого тело не правит.
   */
  it("Открытый выпуск пересобирает тело и печатает свои шаги", () => {
    expect(releaseRun(facts({ pr: OPEN }))).toEqual({ from: "open", to: "open", next: "checks" });
    // открыт только что — те же шаги: проверки, pr premerge, мерж
    expect(releaseRun(facts())!.next).toBe(releaseRun(facts({ pr: OPEN }))!.next);
    // шаги открытого ведут к мержу; красный — переход GitHub, не шаг диспетчера
    expect(RELEASE_TRANSITIONS.filter((t) => t.from === "open" && t.step).map((t) => t.to)).toEqual(["merged"]);
  });

  /**
   * Модель решает, что шаг — починка и какая; виновную по меткам или бисектом называет `redRelease`, текст починки —
   * `fixSteps` (тесты «Next: очереди и шаги batch release на красном выпуске называют виновную задачу и её починку» и
   * «без однозначной метки бисект по границам задач называет первую красную» в github-task).
   */
  it("Красный выпуск называет виновную задачу и её починку", () => {
    expect(releaseRun(facts({ pr: RED }))).toEqual({ from: "red", to: "red", next: "fix" });
    // batch release бисектит: виновная названа — её починка, нет — диспетчер по логам или владелец
    expect(redFix({ fixing: false, guilty: true, bisects: true, bisectable: true })).toBe("guilty");
    expect(redFix({ fixing: false, guilty: false, bisects: true, bisectable: true })).toBe("owner");
    // очередь — только по меткам: не названа — batch release
    expect(redFix({ fixing: false, guilty: false, bisects: false, bisectable: true })).toBe("bisect");
    // починка влита — выпуск снова открыт, его шаги
    expect(releaseRun(facts({ pr: OPEN, merged: 2 }))!.next).toBe("checks");
  });

  /**
   * ❌ `pr premerge` на голове выпуска пишет его метку (#884); batch release и очередь читают её как красный выпуск, PR
   * починки в пачку пропускает `pr premerge` (тест «Выпуск пачки с зелёным CI и красным spec-red — красный выпуск: правка
   * виновной задачи проходит в пачку» в github-task).
   */
  it("Выпуск с зелёным CI и ❌ pr premerge — красный: шаг — починка, а после неё — тот же PR", () => {
    expect(releaseRun(facts({ pr: PREMERGE_RED }))).toEqual({ from: "red", to: "red", next: "fix" });
    // починка влита в пачку — голова выпуска сдвинулась, ❌ был у прежней головы: снова открыт, второго PR нет
    expect(releaseRun(facts({ pr: OPEN, merged: 2 }))).toEqual({ from: "open", to: "open", next: "checks" });
  });

  /**
   * Уборку worktree и текст шагов закрытия делает `act.merged` (тесты «выпуск убирает worktree и ветки исполнителей
   * пачки» и «batch release после мержа выпуска — одна актуализация на эпик задач пачки, затем task close каждой задачи»
   * в github-task).
   */
  it("Влитый выпуск убирает worktree исполнителей и печатает шаги закрытия", () => {
    expect(releaseRun(facts({ pr: MERGED }))).toEqual({ from: "merged", to: "merged", next: "close" });
    // задачу выпуска закрыл его мерж, её хвост — у диспетчера: worktree ответившего исполнителя убирается, живого — нет
    const quiet = { lock: null, guest: null, moved: null };
    expect(worktreeRemovable(executorOf(quiet).state, false)).toBe(true);
    expect(worktreeRemovable(executorOf({ ...quiet, lock: "claude agent agent-a1b2 (pid 4242)" }).state, false)).toBe(false);
    // открытая задача — живого PR в пачку — держит свой worktree и после выпуска
    expect(worktreeRemovable(executorOf(quiet).state, true)).toBe(false);
  });

  it("Строка `Next:` выпуска выводится из таблицы переходов", () => {
    /** Выпуск в каждом состоянии — его факты. */
    const BY_STATE: Record<ReleaseState, ReleaseFacts> = { none: facts(), open: facts({ pr: OPEN }), red: facts({ pr: RED }), merged: facts({ pr: MERGED }) };
    for (const [state, f] of Object.entries(BY_STATE) as [ReleaseState, ReleaseFacts][]) {
      const run = releaseRun(f)!;
      // batch release делает свой переход (by «batch release»), шаг — первого перехода с шагом из состояния, где он оставил выпуск
      const own = RELEASE_TRANSITIONS.find((t) => t.from === state && t.by === "batch release")?.to ?? state;
      const step = RELEASE_TRANSITIONS.find((t) => t.from === own && t.step)?.step;
      expect({ state, to: run.to, next: run.next }).toEqual({ state, to: own, next: step! });
      expect(releaseStateStep(run.to)).toBe(run.next);
    }
    // «нет» шага не даёт: batch release открывает выпуск сам
    expect(releaseStateStep("none")).toBeNull();
    // каждый шаг выпуска — шаг какого-то перехода, лишних нет
    expect(RELEASE_STEPS.filter((s) => !RELEASE_TRANSITIONS.some((t) => t.step === s))).toEqual([]);
  });
});

/**
 * Справка «batch release» показывает переходы и починки таблицами — строкой на переход модели и на починку: правка
 * таблицы в коде без справки, как и строка справки без перехода, — красный тест.
 */
describe("Справка github показывает таблицы модели выпуска пачки", () => {
  const REFERENCE = readFileSync(new URL("../../../skills/github/reference.md", import.meta.url), "utf8");
  /** Раздел справки `### batch release` — до следующего `### `. */
  const SECTION = REFERENCE.split(/^### /m).find((s) => s.startsWith("batch release\n")) ?? "";
  /** Строки таблицы под строкой-заголовком `header` — до пустой строки. */
  const table = (header: string) => {
    const lines = SECTION.split("\n");
    const at = lines.indexOf(header);
    return at < 0 ? [] : lines.slice(at + 2, lines.indexOf("", at));
  };

  it("Справка batch release — строка на каждый переход выпуска, лишних нет", () => {
    const expected = RELEASE_TRANSITIONS.map((t) => `| \`${t.from}\` | \`${t.event}\` | \`${t.to}\` | ${t.by} | ${t.step ? `\`${t.step}\`` : "—"} |`);
    expect(table("| From | Event | To | By | Step |")).toEqual(expected);
  });

  it("Справка batch release — строка на каждую починку красного выпуска, в порядке выбора", () => {
    expect(table("| Fix | When | `Next:` |").map((l) => /^\| `(\w+)` \|/.exec(l)?.[1])).toEqual([...FIXES]);
  });
});
