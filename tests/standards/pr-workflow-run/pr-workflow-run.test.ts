import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, setDefaultTimeout } from "bun:test";

import { invariant } from "../../../skills/spec/scripts/harness.ts";
import { exitOf, SPAWN_TIMEOUT } from "../../lib/spawn.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Ответ на «прогон workflow на PR в базу»: да, нет, не решить без диффа PR. */
type Run = "yes" | "no" | "unknown";

/** Ответ копии: значение `on:` workflow и базовая ветка PR. */
type Read = (on: unknown, base: string) => Run;

/** Копия правила: файл и как она отвечает. */
interface Copy {
  file: string;
  read: Read;
}

/** `PR_RUN` `.sh` — определение jq `pr_run($base)` над значением `on:`, тем же движком, что `wait-ci.sh`. */
const viaJq =
  (program: string): Read =>
  (on, base) => {
    const r = spawnSync("jq", ["-n", "--argjson", "on", JSON.stringify(on), "--arg", "base", base, `${program} $on | pr_run($base)`], { encoding: "utf8", timeout: SPAWN_TIMEOUT });
    if (r.status !== 0) throw new Error(`jq не разобрал правило: ${exitOf(r)} ${r.stderr.trim()}`);
    return JSON.parse(r.stdout) as Run;
  };

/** Копия `.sh` без строки в одинарных кавычках — ошибка на первом вопросе, а не пропуск в реестре. */
const unreadable =
  (file: string): Read =>
  () => {
    throw new Error(`${file}: PR_RUN не строкой в одинарных кавычках — правило не прочитать`);
  };

/**
 * Скрипты флоу с правилом: `export function prRun` в `.ts`, `PR_RUN=` в `.sh` — установщика (`bin/`) и скиллов
 * (`skills/<скилл>/scripts/`); новая копия попадает под таблицу сама.
 */
async function copies(): Promise<Copy[]> {
  const dirs = ["bin", ...readdirSync(path.join(ROOT, "skills")).sort().map((s) => `skills/${s}/scripts`)];
  const out: Copy[] = [];
  for (const dir of dirs) {
    let files: string[];
    try {
      files = readdirSync(path.join(ROOT, dir))
        .filter((f) => /\.(ts|sh)$/.test(f))
        .sort();
    } catch {
      continue;
    }
    for (const f of files) {
      const file = `${dir}/${f}`;
      const text = readFileSync(path.join(ROOT, file), "utf8");
      if (f.endsWith(".ts") && /^export function prRun\b/m.test(text)) {
        const mod = await import(pathToFileURL(path.join(ROOT, file)).href);
        out.push({ file, read: mod.prRun });
      } else if (f.endsWith(".sh") && /^PR_RUN=/m.test(text)) {
        const m = /^PR_RUN='([^']*)'$/m.exec(text);
        out.push({ file, read: m ? viaJq(m[1]!) : unreadable(file) });
      }
    }
  }
  return out;
}

// база PR задачи — main; PR задачи пачки — в ветку пачки той формы, что даёт task queue
const MAIN = "main";
const BATCH = "batch/2026-01-01-1";
const pr = (filter: unknown) => ({ pull_request: filter, push: { branches: [MAIN] } });

/** Таблица: `on:` workflow, база PR и ответ на «прогон на PR в эту базу». */
const TABLE: { on: unknown; base: string; run: Run; why: string }[] = [
  // формы on:
  { on: "pull_request", base: MAIN, run: "yes", why: "on: pull_request" },
  { on: ["push", "pull_request"], base: MAIN, run: "yes", why: "on: [push, pull_request]" },
  { on: pr(null), base: MAIN, run: "yes", why: "pull_request: без фильтров (null)" },
  { on: { pull_request: {} }, base: BATCH, run: "yes", why: "pull_request: {} — любая база" },
  { on: "push", base: MAIN, run: "no", why: "on: push" },
  { on: ["push", "workflow_dispatch"], base: MAIN, run: "no", why: "массив без pull_request" },
  { on: { push: { branches: [MAIN] } }, base: MAIN, run: "no", why: "только push" },
  { on: "pull_request_target", base: MAIN, run: "no", why: "pull_request_target — прогон в базе, не на голове PR" },
  { on: null, base: MAIN, run: "no", why: "нет on:" },
  { on: { pull_request: ["opened"] }, base: MAIN, run: "unknown", why: "pull_request — не объект и не null" },
  // ветки: * и **
  { on: pr({ branches: ["develop", "m*n"] }), base: MAIN, run: "yes", why: "ветки, пускающие базовую" },
  { on: pr({ branches: ["release/**"] }), base: MAIN, run: "no", why: "ветки без базовой" },
  { on: pr({ branches: ["release/*"] }), base: "release/a/b", run: "no", why: "* не пускает /" },
  { on: pr({ branches: ["release/**"] }), base: "release/a/b", run: "yes", why: "** пускает /" },
  { on: pr({ branches: ["v1.0"] }), base: "v1x0", run: "no", why: "точка — сама точка" },
  { on: pr({ branches: "main" }), base: MAIN, run: "yes", why: "шаблон строкой, а не списком" },
  { on: pr({ "branches-ignore": ["release/**"] }), base: MAIN, run: "yes", why: "branches-ignore без базовой" },
  { on: pr({ branches: [MAIN] }), base: BATCH, run: "no", why: "pull_request только в main — PR в ветку пачки без прогона" },
  { on: pr({ branches: [MAIN, "release/**"] }), base: BATCH, run: "no", why: "main и release/** — без ветки пачки" },
  { on: pr({ branches: [MAIN, "batch/**"] }), base: BATCH, run: "yes", why: "ветки с веткой пачки" },
  { on: pr({ branches: ["batch/*"] }), base: BATCH, run: "yes", why: "batch/* — ветка пачки без / после batch/" },
  { on: pr({ "branches-ignore": ["batch/**"] }), base: BATCH, run: "no", why: "branches-ignore с веткой пачки" },
  // ветки: отрицание, ?, +, […] — по шпаргалке шаблонов GitHub
  { on: pr({ branches: ["**", "!release/**"] }), base: MAIN, run: "yes", why: "отрицание снимает не базовую" },
  { on: pr({ branches: ["**", "!main"] }), base: MAIN, run: "no", why: "отрицание снимает базовую" },
  { on: pr({ branches: ["**", "!batch/*"] }), base: BATCH, run: "no", why: "отрицание снимает ветку пачки" },
  { on: pr({ branches: ["**", "!batch/**", "batch/2026-*"] }), base: BATCH, run: "yes", why: "позднее положительное возвращает снятое отрицанием" },
  { on: pr({ branches: ["re!ease"] }), base: "re!ease", run: "yes", why: "! не в начале — сам символ" },
  { on: pr({ branches: ["mains?"] }), base: MAIN, run: "yes", why: "? — ноль или один предыдущий символ" },
  { on: pr({ branches: ["v1+"] }), base: "v111", run: "yes", why: "+ — один или больше предыдущего символа" },
  { on: pr({ branches: ["release/v[0-9]"] }), base: "release/v2", run: "yes", why: "[…] — символ из диапазона" },
  { on: pr({ branches: ["release/v[0-9]"] }), base: "release/vx", run: "no", why: "[…] — символ вне диапазона" },
  { on: pr({ branches: ["[main"] }), base: MAIN, run: "no", why: "шаблон, который не разобрать, ветку не берёт" },
  // фильтр путей и types: без диффа PR и события не решить
  { on: pr({ paths: ["src/**"] }), base: MAIN, run: "unknown", why: "фильтр путей" },
  { on: pr({ "paths-ignore": ["docs/**"] }), base: MAIN, run: "unknown", why: "фильтр путей paths-ignore" },
  { on: pr({ types: ["labeled"] }), base: MAIN, run: "unknown", why: "types без synchronize" },
  { on: pr({ types: ["opened", "synchronize"] }), base: MAIN, run: "yes", why: "types с synchronize" },
  { on: pr({ branches: ["release/**"], paths: ["src/**"] }), base: MAIN, run: "no", why: "ветки без базовой решают раньше фильтра путей" },
  { on: pr({ branches: [MAIN], paths: ["src/**"] }), base: MAIN, run: "unknown", why: "ветки с базовой и фильтр путей" },
  { on: pr({ "branches-ignore": [MAIN], types: ["labeled"] }), base: MAIN, run: "no", why: "branches-ignore с базовой решает раньше types" },
];

const label = (row: (typeof TABLE)[number]) => `${row.why} (база ${row.base})`;

/** Строки таблицы, на которые копия отвечает не по правилу: почему строка такая, ответ копии и ответ правила. */
function mismatches(read: Read): { why: string; got: Run; want: Run }[] {
  return TABLE.flatMap((row) => {
    const got = read(row.on, row.base);
    return got === row.run ? [] : [{ why: row.why, got, want: row.run }];
  });
}

// pr_expects ci-wait до стандарта (#356): ветки с !, ?, +, […] — «не решить без диффа PR», workflow не ждётся
const before: Copy = {
  file: "wait-ci.sh до стандарта",
  read: viaJq(`def pr_run($base):
    def list: if type == "array" then . else [.] end;
    def rx: "^" + (split("**") | map(split("*") | map(gsub("(?<c>[.^$(){}|\\\\\\\\])"; "\\\\\\(.c)")) | join("[^/]*")) | join(".*")) + "$";
    def match_base: list | if any(.[]; tostring | test("[?+\\\\[!]")) then null else any(.[]; tostring | rx as $r | $base | test($r)) end;
    (if type == "string" or type == "array" then (if list | any(.[]; . == "pull_request") then {} else null end)
     elif type == "object" and has("pull_request") then (.pull_request | if . == null then {} else . end)
     else null end)
    | if . == null then "no"
      elif type != "object" then "unknown"
      elif has("branches") then (.branches | match_base) as $m | if $m == null then "unknown" elif $m | not then "no" else . end
      elif has("branches-ignore") then (.["branches-ignore"] | match_base) as $m | if $m == null then "unknown" elif $m then "no" else . end
      else . end
    | if type == "string" then .
      elif has("paths") or has("paths-ignore") then "unknown"
      elif has("types") and (.types | list | any(.[]; . == "synchronize") | not) then "unknown"
      else "yes" end;`),
};

const registry = await copies();
const INSTALLER = "bin/elves.ts";
const CI_WAIT = "skills/ci-wait/scripts/wait-ci.sh";

describe("Прогон workflow на PR в базу решает одно правило: функция установщика и копия в wait-ci.sh — по одной таблице", () => {
  invariant(it, {
    registry: "скрипты флоу с правилом prRun / PR_RUN",
    items: registry,
    key: (c) => c.file,
    includes: [INSTALLER, CI_WAIT],
    name: (c) => `${c.file} отвечает на «прогон workflow на PR в базу» по таблице`,
    check: (c) => {
      const wrong = mismatches(c.read).map((m) => `${m.why}: ${m.got}, а по правилу — ${m.want}`);
      if (wrong.length) throw new Error(`${c.file}: правило прогона workflow на PR расходится с таблицей:\n${wrong.join("\n")}`);
    },
    violator: { name: "pr_expects до стандарта: отрицание и ?, +, […] в ветках — «не решить»", item: before },
  });

  it("таблица ловит расхождение копий до стандарта: отрицание и ?, +, […] в ветках у pr_expects", () => {
    expect(mismatches(before.read).map((m) => m.why)).toEqual([
      "отрицание снимает не базовую",
      "отрицание снимает базовую",
      "отрицание снимает ветку пачки",
      "позднее положительное возвращает снятое отрицанием",
      "! не в начале — сам символ",
      "? — ноль или один предыдущий символ",
      "+ — один или больше предыдущего символа",
      "[…] — символ из диапазона",
      "[…] — символ вне диапазона",
      "шаблон, который не разобрать, ветку не берёт",
    ]);
  });

  it("фильтр путей и types без synchronize — «не решить» у обеих копий", () => {
    const rows = TABLE.filter((r) => /^фильтр путей|^types без synchronize/.test(r.why));
    expect(rows.map(label)).toEqual(["фильтр путей (база main)", "фильтр путей paths-ignore (база main)", "types без synchronize (база main)"]);
    const answers = Object.fromEntries(registry.map((c) => [c.file, rows.map((r) => c.read(r.on, r.base))]));
    expect(answers).toEqual({ [INSTALLER]: ["unknown", "unknown", "unknown"], [CI_WAIT]: ["unknown", "unknown", "unknown"] });
  });
});
