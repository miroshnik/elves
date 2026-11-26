import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { commandOf, namePattern, outcomesOf, runnerOf } from "../../../skills/spec/scripts/spec-red.ts";
import { makeTest, parseJunit } from "../../../skills/spec/scripts/speclib.ts";
import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { gitRepo, junitReport, runScript, SCRIPTS, tmpDir } from "../../lib/spec.ts";

// git и bun test — настоящие процессы во временном репозитории
setDefaultTimeout(SPAWN_TIMEOUT);

let dir: string;
let cleanup: () => void;
let repo: ReturnType<typeof gitRepo>;
beforeEach(() => {
  ({ dir, cleanup } = tmpDir());
  repo = gitRepo(dir);
  // база: в сложении ошибка — PR её чинит
  repo.commit({ "src/sum.ts": "export const sum = (a: number, b: number) => a - b;\n" }, "base");
  repo.git("switch", "-q", "-c", "feat/1-sum");
});
afterEach(() => cleanup());

const FIX = { "src/sum.ts": "export const sum = (a: number, b: number) => a + b;\n" };
const SUM_TEST = "tests/capabilities/sum/sum.test.ts";
/** Тестовый файл решения: импорт bun:test и кода, тела тестов — строками. */
const testFile = (body: string, imports = 'import { sum } from "../../../src/sum.ts";') => `import { describe, expect, it } from "bun:test";\n${imports}\n\n${body}\n`;
const red = (...args: string[]) => runScript("spec-red", ["--base", "main", ...args], dir);
const worktrees = () => repo.git("worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree "));

/**
 * «Проверка пишется до кода и сначала красная» держалась на слове агента: `spec-break` запускали 22 раза на ~500
 * влитых PR. Добавленный PR-ом тест гоняется на базовом коде — коде до PR с тестами PR — и должен там упасть: зелёный
 * на базе тест не проверяет то, что PR меняет.
 */
describe("Добавленный PR-ом тест красный на базовом коде", () => {
  it("Добавленный тест, зелёный на базовом коде, — ошибка с его названием", () => {
    repo.commit({ ...FIX, [SUM_TEST]: testFile('describe("сумма", () => {\n  it("ноль ничего не меняет", () => expect(sum(2, 0)).toBe(2));\n});') }, "pr");
    const r = red();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`❌ green on base: ${SUM_TEST}: сумма › ноль ничего не меняет — it doesn't check the PR's change`);
    expect(worktrees()).toHaveLength(1);
  });

  it("Добавленный тест, красный на базовом коде, проходит проверку", () => {
    repo.commit({ ...FIX, [SUM_TEST]: testFile('describe("сумма", () => {\n  it("складывает два числа", () => expect(sum(1, 2)).toBe(3));\n});') }, "pr");
    const r = red();
    expect(r.stdout).toContain("✅ 1 added test is red on base");
    expect(r.stdout).toContain("spec-red: every checked test passes");
    expect(r.code).toBe(0);
  });

  // describe условного запуска bun:test сканер не считал: тест искался в отчёте без группы — «not checked» (#885)
  it("spec-red находит в отчёте добавленный тест внутри `describe.if` и называет его красным на базе", () => {
    repo.commit({ ...FIX, [SUM_TEST]: testFile('describe.if(true)("сумма", () => {\n  it("складывает два числа", () => expect(sum(1, 2)).toBe(3));\n});') }, "pr");
    const r = red();
    expect(r.stdout).toContain("✅ 1 added test is red on base");
    expect(r.stdout).not.toContain("not checked");
    expect(r.code).toBe(0);
  });

  /** Тест импортирует то, что добавляет PR: на базе его файл не загружается — тест без кода PR не проходит. */
  it("Тестовый файл, который не загружается на базовом коде, считается красным", () => {
    const mul = "tests/capabilities/mul/mul.test.ts";
    repo.commit({ "src/mul.ts": "export const mul = (a: number, b: number) => a * b;\n", [mul]: testFile('it("умножает", () => expect(mul(2, 3)).toBe(6));', 'import { mul } from "../../../src/mul.ts";') }, "pr");
    const r = red();
    expect(r.stdout).toContain("✅ 1 added test is red on base");
    expect(r.code).toBe(0);
  });

  it("PR без добавленных тестов проходит проверку без запуска", () => {
    // тест уже был на базе; PR меняет его тело и код — новых требований нет
    repo.git("switch", "-q", "main");
    repo.commit({ [SUM_TEST]: testFile('it("складывает два числа", () => expect(sum(1, 1)).toBe(0));') }, "base test");
    repo.git("switch", "-q", "feat/1-sum");
    repo.git("rebase", "-q", "main");
    repo.commit({ ...FIX, [SUM_TEST]: testFile('it("складывает два числа", () => expect(sum(1, 2)).toBe(3));') }, "pr");
    const r = red();
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toStartWith("○ spec-red: the head adds no tests to tests/ against main");
    expect(r.stdout).toContain("nothing to run");
    expect(r.stdout).not.toContain("on the base code");
  });
});

/**
 * Тест существующего поведения — перенос спеки, тест «из кода» по следу решения — был бы зелёным и до PR. Отметка в
 * файле теста, перед его `it` или `describe`, с номером задачи и причиной, как у исключений: такой тест обязан быть
 * зелёным на базе, красный — отметка лишняя (храповик).
 */
describe("Тест существующего поведения — отметка в файле с задачей и причиной", () => {
  it("Тест с отметкой существующего поведения проверку проходит", () => {
    const body = 'describe("сумма", () => {\n  // spec-existing #12: перенос спеки — вычитание из нуля было и до PR\n  it("ноль минус ноль — ноль", () => expect(sum(0, 0)).toBe(0));\n});';
    repo.commit({ ...FIX, [SUM_TEST]: testFile(body) }, "pr");
    const r = red();
    expect(r.stdout).toContain("✅ 1 existing-behavior test is green on base");
    expect(r.code).toBe(0);
  });

  it("Отметка у теста, красного на базе, — ошибка: отметка не нужна", () => {
    const body = '// spec-existing #12: перенос спеки\ndescribe("сумма", () => {\n  it("складывает два числа", () => expect(sum(1, 2)).toBe(3));\n});';
    repo.commit({ ...FIX, [SUM_TEST]: testFile(body) }, "pr");
    const r = red();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`❌ red on base, yet marked existing behavior (${SUM_TEST}:4) — the mark isn't needed, remove it: ${SUM_TEST}: сумма › складывает два числа`);
  });

  it("Отметка без номера задачи или причины и отметка не перед тестом — ошибка", () => {
    const body = '// spec-existing: перенос спеки\nit("ноль ничего не меняет", () => expect(sum(2, 0)).toBe(2));\n\n// spec-existing #12: перенос спеки\nconst one = 1;\nit("складывает два числа", () => expect(sum(one, 2)).toBe(3));';
    repo.commit({ ...FIX, [SUM_TEST]: testFile(body) }, "pr");
    const r = red();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`❌ ${SUM_TEST}:4: the spec-existing mark needs the task number and the reason`);
    expect(r.stdout).toContain(`❌ ${SUM_TEST}:7: the spec-existing mark isn't right before an it or a describe`);
  });
});

/**
 * PR в пачку проверяется против пачки, её выпуск — против main (#892). Тест поведения, которое в пачку принесла другая
 * её задача, против пачки зелёный, на коде main — красный: пометка spec-existing у него неверна против main и всплыла бы
 * только на выпуске. Вторая база `--also` — main: на ней идут только добавленные тесты, зелёные против пачки.
 */
describe("Вторая база: пометка spec-existing на PR в пачку сверяется с main", () => {
  const BATCH = "batch/2026-11-21-1";
  /** Пачка от main: задача А починила сложение; ветка задачи Б — от пачки, в ней только её тест. */
  function batchTask(body: string) {
    repo.git("switch", "-q", "-c", BATCH, "main");
    repo.commit(FIX, "task A");
    repo.git("switch", "-q", "-c", "feat/2-sum-test");
    repo.commit({ [SUM_TEST]: testFile(body) }, "task B");
    return runScript("spec-red", ["--base", BATCH, "--also", "main"], dir);
  }

  it("Добавленный тест, зелёный против пачки и красный на коде main, без пометки проходит, а с пометкой — ошибка: поведение добавляет выпуск", () => {
    const plain = batchTask('describe("сумма", () => {\n  it("складывает два числа", () => expect(sum(1, 2)).toBe(3));\n});');
    expect(plain.stdout).toContain("✅ 1 added test green on base is red on main — it checks what the base adds to main");
    expect(plain.stdout).toContain("spec-red: every checked test passes");
    expect(plain.code).toBe(0);
    expect(worktrees()).toHaveLength(1);

    repo.commit({ [SUM_TEST]: testFile('describe("сумма", () => {\n  // spec-existing #12: сложение принесла задача пачки\n  it("складывает два числа", () => expect(sum(1, 2)).toBe(3));\n});') }, "mark");
    const marked = runScript("spec-red", ["--base", BATCH, "--also", "main"], dir);
    expect(marked.code).toBe(1);
    expect(marked.stdout).toContain(`❌ red on main, yet marked existing behavior (${SUM_TEST}:5) — against main the mark isn't needed: the release adds the behavior, remove it: ${SUM_TEST}: сумма › складывает два числа`);
  });

  it("Добавленный тест, зелёный и против пачки, и на коде main, без пометки — ошибка green on base, с пометкой проходит", () => {
    const plain = batchTask('it("ноль и ноль — ноль", () => expect(sum(0, 0)).toBe(0));');
    expect(plain.code).toBe(1);
    expect(plain.stdout).toContain(`❌ green on base: ${SUM_TEST}: ноль и ноль — ноль — it doesn't check the PR's change`);

    repo.commit({ [SUM_TEST]: testFile('// spec-existing #12: ноль и ноль давали ноль и до пачки\nit("ноль и ноль — ноль", () => expect(sum(0, 0)).toBe(0));') }, "mark");
    const marked = runScript("spec-red", ["--base", BATCH, "--also", "main"], dir);
    expect(marked.stdout).toContain("✅ 1 existing-behavior test is green on base");
    expect(marked.code).toBe(0);
  });
});

/**
 * Прогон, оборванный сигналом группе: добавленный тест пишет свой pid и ждёт, пока его не убьют. Файл pid — в `.git`
 * чекаута: вне коммитов и уходит с каталогом теста.
 */
async function interrupted(signal: NodeJS.Signals): Promise<number | null> {
  const pidFile = path.join(dir, ".git", "red-test.pid");
  rmSync(pidFile, { force: true });
  repo.commit({ ...FIX, [SUM_TEST]: testFile(`it("ждёт сигнала", async () => {\n  require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n  await Bun.sleep(30_000);\n});`) }, "pr");
  const p = spawn(process.execPath, [path.join(SCRIPTS, "spec-red.ts"), "--base", "main"], { cwd: dir, stdio: "ignore", detached: true });
  const exited = new Promise<number | null>((resolve) => p.on("exit", (code) => resolve(code)));
  // ждём реального события — прогон на базе идёт в worktree, — а не паузы
  for (let i = 0; i < 400 && !existsSync(pidFile); i++) await Bun.sleep(25);
  expect(worktrees()).toHaveLength(2);
  process.kill(-p.pid!, signal);
  return exited;
}

describe("Прогон на базе идёт во временном worktree чекаута", () => {
  it("Временный worktree убирается и после прерывания", async () => {
    const code = await interrupted("SIGINT");
    expect(code).toBe(2);
    expect(worktrees()).toHaveLength(1);

    // kill -9 не даёт убрать worktree — его убирает следующий запуск: pid прогона в имени каталога мёртв
    const killed = await interrupted("SIGKILL");
    expect(killed).toBeNull();
    const stale = worktrees()[1]!.slice("worktree ".length);
    expect(path.basename(stale)).toMatch(/^elves-red-\d+-/);
    repo.commit({ [SUM_TEST]: null }, "no tests");
    const r = red();
    expect(r.stdout).toContain(`spec-red: removed the worktree of an interrupted run — ${stale}`);
    expect(worktrees()).toHaveLength(1);
    expect(existsSync(stale)).toBe(false);
  });
});

/**
 * Раннер файла — bun test: импорт `bun:test` или тест проекта на Bun; e2e на базе не гоняется: приложение идёт из стека
 * задачи. Тесты проекта — bun test и Playwright (эпик #906): файл другого раннера не проверяется — строка ○.
 */
describe("Раннер добавленных тестов — тот, что у проекта", () => {
  it("bun test гоняет только файлы добавленных тестов по их полным именам; e2e и файл другого раннера не проверяются", () => {
    expect(runnerOf("tests/a.test.ts", 'import { it } from "bun:test";', false)).toBe("bun");
    expect(runnerOf("tests/a.test.ts", "it('x', () => {});", true)).toBe("bun");
    expect(runnerOf("tests/a.e2e.ts", 'import { test } from "../lib/fixtures";', true)).toBe("playwright");
    expect(runnerOf("tests/a.test.ts", 'import { it } from "vitest";', false)).toBeNull();
    expect(runnerOf("tests/a.test.ts", "it('x', () => {});", false)).toBeNull();

    const tests = [makeTest("tests/a.test.ts", ["сумма (целых)"], "1 + 2 = 3"), makeTest("tests/a.test.ts", [], "верхний")];
    const pattern = namePattern(tests);
    expect(pattern).toBe("^(?:сумма \\(целых\\) 1 \\+ 2 = 3|верхний)$");
    expect(new RegExp(pattern).test("сумма (целых) 1 + 2 = 3")).toBe(true);
    expect(commandOf(["tests/a.test.ts"], pattern, "/r/bun.xml")).toEqual(["bun", "test", "./tests/a.test.ts", "--test-name-pattern", pattern, "--reporter=junit", "--reporter-outfile=/r/bun.xml"]);

    // JUnit bun test: упавший — красный, прошедший — зелёный, файл без тестов в отчёте при красном прогоне — не загрузился
    const added = [makeTest("tests/a.test.ts", [], "падает"), makeTest("tests/a.test.ts", [], "проходит"), makeTest("tests/b.test.ts", [], "импортирует новое")];
    const report = parseJunit(junitReport("/w", { "tests/a.test.ts": [[[], "падает", "failed"], [[], "проходит"]], "tests/b.test.ts": [] }), "/w");
    expect(outcomesOf(added, report, 1)).toEqual([{ kind: "red", loaded: true }, { kind: "green" }, { kind: "red", loaded: false }]);
    // прогон зелёный, а теста нет под его именем — не проверен, а не красный
    expect(outcomesOf([added[2]!], [], 0)).toEqual([{ kind: "unchecked", why: "not in the run under this name (computed at run time?)" }]);
  });
});
