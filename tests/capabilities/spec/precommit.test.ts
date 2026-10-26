import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { detailsOf, summaryOf, verdict } from "../../../skills/spec/scripts/precommit.ts";
import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { gitRepo, runScript, tmpDir, writeTree } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

let dir: string;
let cleanup: () => void;
beforeEach(() => {
  ({ dir, cleanup } = tmpDir());
  gitRepo(dir);
});
afterEach(() => cleanup());

/** Сводка `bun test`, как он её печатает в конце прогона. */
const BUN_SUMMARY = (pass: number, fail: number) => `printf ' ${pass} pass\\n ${fail} fail\\nRan ${pass + fail} tests across 1 file.\\n'`;

/** Проект на Bun с этими скриптами package.json. */
function project(scripts: Record<string, string>) {
  writeTree(dir, { "package.json": JSON.stringify({ name: "app", packageManager: "bun@1.4.4", scripts }) });
}

/** Ждёт файл другой проверки до 5 с: обе проверки идут разом — дождутся друг друга, по очереди — первая упадёт. */
const meet = (mine: string, other: string) => `touch ${mine}; i=0; while [ ! -f ${other} ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done; [ -f ${other} ]`;

describe("Проверки перед коммитом — одним вызовом со сводкой по каждой", () => {
  it("проверки перед коммитом идут одним вызовом и печатают сводку по каждой", () => {
    project({
      lint: meet("lint.started", "typecheck.started"),
      typecheck: meet("typecheck.started", "lint.started"),
      "test:spec": BUN_SUMMARY(7, 0),
      test: `${BUN_SUMMARY(3, 0)}; echo >args.txt`,
      build: "echo build >build.txt",
    });
    const r = runScript("precommit", [], dir);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines.filter((l) => l.startsWith("✅")).map((l) => l.split(" — ")[0]).sort()).toEqual(["✅ lint", "✅ test --changed=origin/main", "✅ test:spec", "✅ typecheck"]);
    expect(r.stdout).toContain("✅ test:spec — 7 passed");
    expect(r.stdout).toContain("✅ test --changed=origin/main — 3 passed");
    expect(lines.at(-1)).toBe("precommit: all 4 green");
    // аргумент затронутого дошёл до скрипта test; build — не проверка перед коммитом
    expect(readFileSync(`${dir}/args.txt`, "utf8").trim()).toBe("--changed=origin/main");
    expect(() => readFileSync(`${dir}/build.txt`)).toThrow();
  });

  it("--base — база затронутых тестов: ветка пачки вместо origin/main", () => {
    project({ test: `${BUN_SUMMARY(1, 0)}; echo >args.txt` });
    const r = runScript("precommit", ["--base", "origin/batch/2026-01-02-1"], dir);
    expect(r.code).toBe(0);
    expect(readFileSync(`${dir}/args.txt`, "utf8").trim()).toBe("--changed=origin/batch/2026-01-02-1");
  });

  it("скрипта нет в package.json — строка ○, а не провал", () => {
    project({ typecheck: "true" });
    const r = runScript("precommit", [], dir);
    expect(r.code).toBe(0);
    for (const s of ["lint", "test:spec", "test"]) expect(r.stdout).toContain(`○ ${s} — no such script in package.json`);
    expect(r.stdout).toContain("✅ typecheck — ok");
  });

  it("упавшая проверка печатает подробности только о себе", () => {
    project({
      lint: "echo 'lint: all fine, a long report'",
      typecheck: "echo 'src/a.ts(3,1): error TS2322: wrong type'; exit 2",
      "test:spec": `echo '(pass) a standard holds'; ${BUN_SUMMARY(5, 0)}`,
      test: `echo '(pass) a test that passed'; echo 'error: expect(received).toBe(expected)'; echo '(fail) the broken test'; ${BUN_SUMMARY(4, 1)}`,
    });
    const r = runScript("precommit", [], dir);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("❌ typecheck — code 2");
    expect(r.stdout).toContain("❌ test --changed=origin/main — 1 failed, 4 passed");
    expect(r.stdout).toContain("✅ lint — ok");
    expect(r.stdout).toContain("error TS2322: wrong type");
    expect(r.stdout).toContain("(fail) the broken test");
    // зелёных проверок и прошедших тестов в подробностях нет
    expect(r.stdout).not.toContain("a long report");
    expect(r.stdout).not.toContain("a standard holds");
    expect(r.stdout).not.toContain("a test that passed");
    expect(r.stdout.trim().split("\n").at(-1)).toBe("precommit: 2 of 4 failed — typecheck, test");
    // весь вывод упавшей — файлом
    const file = /the whole output: (\S+test\.log)/.exec(r.stdout)?.[1];
    expect(file).toBeDefined();
    expect(readFileSync(file!, "utf8")).toContain("a test that passed");
  });

  it("результат проверки берётся по сводке раннера, а не по коду выхода обёртки", () => {
    project({
      // обёртка потеряла код: `bun test | tail` без pipefail — 0 при упавшем тесте
      test: `${BUN_SUMMARY(2, 1)}; true`,
      // прогон оборвался до сводки, а обёртка вернула 0
      "test:spec": "echo 'tests/a.test.ts:'; exit 0",
    });
    const r = runScript("precommit", [], dir);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("❌ test --changed=origin/main — 1 failed, 2 passed (code 0 — the summary decides)");
    expect(r.stdout).toContain("❌ test:spec — no runner summary — the run didn't finish (code 0)");
  });

  it("без package.json — ошибка вызова, код 2", () => {
    const r = runScript("precommit", [], dir);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("no package.json");
  });
});

describe("Сводка раннера — по его строкам итога", () => {
  it("сводка — по строкам итога bun test, Vitest, Jest и Playwright, ошибки вне тестов и неначатые — в упавших", () => {
    const cases: [string, string, { passed: number; bad: number }][] = [
      ["bun test", " 12 pass\n 1 fail\n 30 expect() calls\nRan 13 tests across 2 files. [1.2s]\n", { passed: 12, bad: 1 }],
      ["bun test без затронутых", "--changed: no changed files, nothing to run\n\n 0 pass\n 0 fail\nRan 0 tests across 0 files.\n", { passed: 0, bad: 0 }],
      ["bun test, ошибка вне тестов", " 3 pass\n 0 fail\n 1 error\nRan 3 tests across 1 file.\n", { passed: 3, bad: 1 }],
      ["bun test двумя прогонами одного скрипта", " 2 pass\n 0 fail\n 1 pass\n 1 fail\n", { passed: 3, bad: 1 }],
      ["Vitest", " Test Files  1 failed | 2 passed (3)\n      Tests  1 failed | 9 passed (10)\n   Duration  1.2s\n", { passed: 9, bad: 1 }],
      ["Vitest с ошибкой вне тестов", "      Tests  4 passed (4)\n     Errors  1 error\n", { passed: 4, bad: 1 }],
      ["Vitest --passWithNoTests без затронутых", "No test files found, exiting with code 0\n", { passed: 0, bad: 0 }],
      ["Jest", "Test Suites: 1 failed, 1 passed, 2 total\nTests:       2 failed, 5 passed, 7 total\n", { passed: 5, bad: 2 }],
      ["Playwright", "  1 failed\n  1 flaky\n  2 did not run\n  6 passed (12.3s)\n", { passed: 6, bad: 4 }],
      ["Playwright, прерван", "  1 interrupted\n  3 passed (2s)\n", { passed: 3, bad: 1 }],
    ];
    for (const [runner, output, summary] of cases) expect({ runner, summary: summaryOf(output) }).toEqual({ runner, summary });
  });

  it("цвета ANSI в выводе не мешают найти сводку", () => {
    expect(summaryOf("\x1b[32m 4 pass\x1b[0m\n\x1b[31m 0 fail\x1b[0m\n")).toEqual({ passed: 4, bad: 0 });
  });

  it("вывода без сводки — нет и сводки: прогон не кончился", () => {
    expect(summaryOf("bun test v1.4.4\n\ntests/a.test.ts:\n")).toBeNull();
    expect(verdict(true, "killed by SIGKILL", "tests/a.test.ts:\n")).toEqual({ ok: false, text: "no runner summary — the run didn't finish (killed by SIGKILL)" });
  });

  it("зелёная сводка с кодом не 0 — провал: ошибка вне тестов", () => {
    expect(verdict(true, 1, " 3 pass\n 0 fail\n")).toEqual({ ok: false, text: "3 passed, but code 1 — an error outside the tests" });
  });

  it("подробности — конец вывода без прошедших тестов", () => {
    const output = [...Array.from({ length: 200 }, (_, i) => `(pass) test ${i}`), ...Array.from({ length: 100 }, (_, i) => `line ${i}`), ""].join("\n");
    const details = detailsOf(output);
    expect(details[0]).toBe("… 20 lines above — in the file");
    expect(details.at(-1)).toBe("line 99");
    expect(details.some((l) => l.startsWith("(pass)"))).toBe(false);
  });
});
