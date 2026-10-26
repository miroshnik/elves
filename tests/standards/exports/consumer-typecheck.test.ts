import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, setDefaultTimeout } from "bun:test";

import { REPO } from "../../lib/elves.ts";
import { packageProject } from "../../lib/npm.ts";
import { exitOf, SPAWN_TIMEOUT } from "../../lib/spawn.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

/**
 * tsconfig проекта-потребителя: как у `bun init` (режим сборщика, `.ts` в импортах), и все проверки, что TypeScript
 * держит выключенными по умолчанию, — включены. Опция, которой здесь нет, — та, что проект может включить, а модули
 * пакета не проходят.
 */
const TSCONFIG = {
  compilerOptions: {
    lib: ["ESNext"],
    target: "ESNext",
    module: "Preserve",
    moduleDetection: "force",
    moduleResolution: "bundler",
    allowImportingTsExtensions: true,
    verbatimModuleSyntax: true,
    erasableSyntaxOnly: true,
    noEmit: true,
    allowJs: true,
    checkJs: true,
    types: ["bun"],
    skipLibCheck: true,
    strict: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    noImplicitOverride: true,
    noPropertyAccessFromIndexSignature: true,
    noImplicitReturns: true,
    noFallthroughCasesInSwitch: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
    noUncheckedSideEffectImports: true,
    allowUnreachableCode: false,
    allowUnusedLabels: false,
  },
  include: ["tests"],
};

/** Модули пакета из `exports` — все, кроме `package.json`: новый экспорт попадает в проверку сам. */
const EXPORTS = Object.keys((JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")) as { exports: Record<string, unknown> }).exports)
  .filter((k) => k !== "./package.json")
  .map((k) => `@miroshnik/elves/${k.slice(2)}`);

/**
 * Проект с пакетом `@miroshnik/elves` из tarball, как из реестра, и тестом, который импортирует каждый модуль из
 * `exports`; типы Bun и Node — ссылками на пакеты Elves (своих зависимостей у временного проекта нет, сети тест не
 * берёт). Возвращает каталог.
 */
function consumer(): string {
  // тип модуля, а не `export *`: так берётся и `export =` (knip-hints), а тайпчек проверяет файл модуля целиком
  const test = EXPORTS.map((m, i) => `export type M${i} = typeof import("${m}");\n`).join("");
  const dir = packageProject("consumer-typecheck", { "tsconfig.json": JSON.stringify(TSCONFIG, null, 2) + "\n", "tests/exports.test.ts": test });
  for (const dep of ["@types/bun", "@types/node", "bun-types", "undici-types"]) {
    const at = path.join(dir, "node_modules", dep);
    mkdirSync(path.dirname(at), { recursive: true });
    symlinkSync(path.join(REPO, "node_modules", dep), at);
  }
  return dir;
}

describe("Пакет @miroshnik/elves в тайпчеке проекта", () => {
  /**
   * Условие `types` в `exports` ведёт тайпчекер к исходнику `.ts`, а исходник из `node_modules` TypeScript проверяет с
   * опциями проекта: `skipLibCheck` пропускает только `.d.ts`. Модуль, что не проходит строгую опцию, красит тайпчек
   * проекта, который её включил, ошибками в чужом файле (#647).
   */
  it("модули из exports пакета проходят тайпчек проекта-потребителя со строгими опциями", () => {
    const dir = consumer();
    const r = spawnSync(process.execPath, ["check", "--no-pretty", "--all"], { cwd: dir, encoding: "utf8" });
    const output = (r.stdout ?? "") + (r.stderr ?? "");
    expect(output.split("\n").filter((l) => /error TS\d+/.test(l))).toEqual([]);
    expect({ code: exitOf(r), output }).toMatchObject({ code: 0 });
  });
});
