import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";

import { packageManager, projectCommands } from "../../../skills/github/scripts/github.ts";
import type { PackageManager } from "../../../skills/github/scripts/github.ts";
import { codeOnly, invariant, source, sources } from "../../../skills/spec/scripts/harness.ts";
import type { SourceFile } from "../../../skills/spec/scripts/harness.ts";
import { elves, sandbox } from "../../lib/elves.ts";
import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { tmpDir, writeTree } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SKILLS = path.join(ROOT, "skills");
const OWNER = "skills/github/scripts/github.ts";

type Answer = (dir: string) => PackageManager;

/** Ответ на «какой менеджер пакетов у проекта»: скрипт скилла и его `packageManager`. */
interface Copy {
  file: string;
  answer: Answer;
}

/** Скрипты скиллов, которые экспортируют `packageManager`: новый ответ попадает под таблицу сам. */
async function copies(): Promise<Copy[]> {
  const out: Copy[] = [];
  for (const skill of readdirSync(SKILLS).sort()) {
    const dir = path.join(SKILLS, skill, "scripts");
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    } catch {
      continue;
    }
    for (const f of files) {
      if (!/^export function packageManager\(/m.test(readFileSync(path.join(dir, f), "utf8"))) continue;
      const mod = await import(pathToFileURL(path.join(dir, f)).href);
      out.push({ file: `skills/${skill}/scripts/${f}`, answer: mod.packageManager });
    }
  }
  return out;
}

/** Строка таблицы: поле `packageManager` (`null` — нет `package.json`, `""` — без поля), файлы проекта и ответ. */
interface Row {
  field: string | null;
  files: string[];
  want: string;
  why: string;
}

/** Таблица правила: что лежит в проекте, на Bun ли он (а если нет — что это говорит) и lockfile Bun для установки. */
const TABLE: Row[] = [
  { field: "", files: ["bun.lock"], want: "Bun · bun.lock", why: "lockfile Bun" },
  { field: "", files: ["bun.lockb"], want: "Bun · bun.lockb", why: "бинарный lockfile Bun" },
  { field: "", files: ["bun.lock", "bun.lockb"], want: "Bun · bun.lock", why: "текстовый lockfile Bun сильнее бинарного" },
  { field: "", files: [], want: "Bun · без lockfile", why: "ни поля, ни lockfile: bun init поле не пишет" },
  { field: null, files: [], want: "Bun · без lockfile", why: "нет package.json" },
  { field: "bun@1.4.3", files: [], want: "Bun · без lockfile", why: "packageManager Bun без lockfile" },
  { field: "", files: ["pnpm-lock.yaml"], want: "не Bun: pnpm-lock.yaml · без lockfile", why: "lockfile pnpm" },
  { field: "", files: ["yarn.lock"], want: "не Bun: yarn.lock · без lockfile", why: "lockfile Yarn" },
  { field: "", files: ["npm-shrinkwrap.json", "package-lock.json"], want: "не Bun: npm-shrinkwrap.json, package-lock.json · без lockfile", why: "каждый lockfile другого менеджера — по порядку" },
  { field: "", files: ["bun.lock", "package-lock.json"], want: "не Bun: package-lock.json · bun.lock", why: "забытый lockfile npm рядом с lockfile Bun" },
  { field: "pnpm@10.1.0", files: ["bun.lock"], want: "не Bun: pnpm@10.1.0 · bun.lock", why: "packageManager другого менеджера при lockfile Bun" },
  { field: "yarn@4.9.1", files: [], want: "не Bun: yarn@4.9.1 · без lockfile", why: "Yarn 2+ в packageManager — тоже не Bun, без своей ветки" },
  { field: "npm@11.6.2", files: ["package-lock.json"], want: "не Bun: npm@11.6.2, package-lock.json · без lockfile", why: "поле и lockfile npm" },
  { field: "", files: [".yarnrc.yml"], want: "Bun · без lockfile", why: ".yarnrc.yml ничего не решает: веток Yarn 2+ нет" },
];

const label = (row: Row) => [row.field === null ? "без package.json" : row.field ? `packageManager ${row.field}` : "package.json", ...row.files].join(" + ");

const show = (pm: PackageManager) => `${pm.bun ? "Bun" : `не Bun: ${[pm.field, ...pm.foreign].filter(Boolean).join(", ")}`} · ${pm.lockfile ?? "без lockfile"}`;

const fixtures = tmpDir();
afterAll(() => fixtures.cleanup());

/** Проект строки таблицы — каталог с её package.json и файлами. */
const projects = TABLE.map((row, i) => {
  const dir = path.join(fixtures.dir, String(i));
  const files: Record<string, string> = Object.fromEntries(row.files.map((f) => [f, f === ".yarnrc.yml" ? "nodeLinker: node-modules\n" : "{}\n"]));
  if (row.field !== null) files["package.json"] = JSON.stringify(row.field ? { name: "x", packageManager: row.field } : { name: "x" });
  writeTree(dir, { ...files, ".keep": "" });
  return dir;
});

/** Строки таблицы, на которые ответ расходится с правилом. */
function mismatches(answer: Answer): string[] {
  return TABLE.flatMap((row, i) => {
    const got = show(answer(projects[i]!));
    return got === row.want ? [] : [`${label(row)}: ${got}, а по правилу — ${row.want} (${row.why})`];
  });
}

const has = (dir: string, ...files: string[]) => files.some((f) => existsSync(path.join(dir, f)));
// копии поверх правила, каждая со своим расхождением: lockfile Bun сильнее всего прочего — как раннер test:spec до
// #485; .yarnrc.yml — Yarn 2+ по файлам, как обёртка slot до #910
const bunByLockfile: Answer = (dir) => {
  const pm = packageManager(dir);
  return pm.lockfile ? { ...pm, bun: true, field: null, foreign: [] } : pm;
};
const yarnrcIsYarn: Answer = (dir) => {
  const pm = packageManager(dir);
  return has(dir, ".yarnrc.yml") ? { ...pm, bun: false, foreign: [...pm.foreign, ".yarnrc.yml"] } : pm;
};

/**
 * Команда npm, pnpm, Yarn или npx в коде скрипта флоу: строка, которая с неё начинается, — имя для spawn, элемент argv,
 * начало команды (`"npm"`, `["pnpm", "install"]`, `` `npx playwright` ``). «пакет из npm» в тексте справки и
 * `npm_lifecycle_script` (переменная окружения, её ставит и bun run) — не команда.
 */
const FOREIGN_COMMAND = /["'`](?:npm|pnpm|yarn|npx)(?=["'`\s])/;
const foreignCommands = (f: SourceFile) => codeOnly(f.text, f.file).split("\n").flatMap((l, i) => (FOREIGN_COMMAND.test(l) ? [`${f.file}:${i + 1}: ${l.trim()}`] : []));

const registry = await copies();

describe("Скрипты флоу запускают команды проекта через `bun` и `bunx`: веток npm, pnpm и Yarn нет, `packageManager` скилла `github` различает только «Bun» и «не Bun» (для строки ❌ проверки).", () => {
  invariant(it, {
    registry: "скрипты скиллов с ответом на «какой менеджер пакетов у проекта»",
    rule: "packageManager",
    items: registry,
    key: (c) => c.file,
    includes: [OWNER],
    name: (c) => `${c.file}: менеджер пакетов проекта — Bun или не Bun, по таблице правила`,
    check: (c) => {
      const wrong = mismatches(c.answer);
      if (wrong.length) throw new Error(`${c.file}: packageManager расходится с правилом:\n${wrong.join("\n")}`);
    },
    violator: [
      { name: "lockfile Bun сильнее packageManager и lockfile другого менеджера", item: { file: "bin/elves.ts specScript", answer: bunByLockfile } },
      { name: ".yarnrc.yml — Yarn 2+ по файлам, как до #910", item: { file: "bin/elves.ts yarnShell", answer: yarnrcIsYarn } },
    ],
  });

  invariant(it, {
    registry: "скрипты флоу, где есть слова npm, pnpm, Yarn или npx",
    rule: "commands",
    items: sources(ROOT, ["bin", "skills"]).filter((f) => /\b(?:npm|pnpm|yarn|npx)\b/i.test(f.text)),
    key: (f) => f.file,
    includes: [OWNER, "bin/elves.ts", "skills/est/scripts/est.ts"],
    name: (f) => `${f.file}: команды проекта — bun и bunx, без npm, pnpm, Yarn и npx`,
    check: (f) => {
      const lines = foreignCommands(f);
      if (lines.length) throw new Error(`команда npm, pnpm, Yarn или npx — менеджер пакетов проекта Bun (эпик #906), команда — bun run, bunx, bun install:\n${lines.join("\n")}`);
    },
    violator: [
      { name: "установка зависимостей командой менеджера по lockfile", item: source("skills/github/scripts/github.ts", 'const INSTALL = { bun: ["bun", "install", "--frozen-lockfile"], npm: ["npm", "ci"] };\n') },
      { name: "обёртка Yarn 2+ и пример npx в справке", item: source("bin/elves.ts", 'const run = yarn ? "yarn dlx @miroshnik/elves" : `npx playwright test`;\n') },
    ],
  });

  it("таблица ловит расхождения копий поверх правила: забытые packageManager и lockfile другого менеджера при lockfile Bun, забытый .yarnrc.yml", () => {
    expect([...mismatches(bunByLockfile), ...mismatches(yarnrcIsYarn)].map((m) => m.split(":")[0])).toEqual([
      "package.json + bun.lock + package-lock.json",
      "packageManager pnpm@10.1.0 + bun.lock",
      "package.json + .yarnrc.yml",
    ]);
  });
});

describe("Менеджер пакетов у premerge и обёртки slot у check — ответ packageManager", () => {
  it("premerge и обёртка slot у check берут менеджер пакетов у неё: packageManager pnpm и забытые bun.lock и .yarnrc.yml — premerge зовёт bun, обёртка slot — через шим slot.sh, check — ❌ не на Bun", () => {
    const sb = sandbox();
    try {
      const pkg = (fields: Record<string, unknown>) => JSON.stringify({ name: "x", private: true, ...fields, scripts: { lint: "eslint ." } }, null, 2) + "\n";
      // в проект, который объявил pnpm, install отказывает — он не на Bun (#907): pnpm проект объявляет после установки,
      // скрипт оборачивает update — той же функцией
      writeTree(sb.proj, { "package.json": pkg({}), "tests/standards/naming/naming.test.ts": "" });
      const install = elves(sb, ["install"]);
      expect(install.code, install.stderr).toBe(0);
      writeTree(sb.proj, { "package.json": pkg({ packageManager: "pnpm@10.1.0" }), "bun.lock": "{}\n", ".yarnrc.yml": "nodeLinker: node-modules\n" });
      const update = elves(sb, ["update"]);
      expect(update.code, update.stderr).toBe(0);
      const scripts = JSON.parse(readFileSync(path.join(sb.proj, "package.json"), "utf8")).scripts;
      expect(scripts.lint).toBe(". .agents/slot.sh && eslint .");
      const check = elves(sb, ["check"]);
      expect(check.stdout).toContain(`"test:spec": ${JSON.stringify(". .agents/slot.sh && bun test tests/standards")}`);
      expect(check.stdout).toContain(`❌ package.json: the project isn't on Bun — "packageManager": "pnpm@10.1.0"`);
      const cmds = projectCommands(sb.proj);
      expect([cmds.install?.join(" "), cmds.run("test:spec").join(" ")]).toEqual(["bun install --frozen-lockfile", "bun run test:spec"]);
    } finally {
      sb.cleanup();
    }
  });
});

// поле packageManager из package.json — обращение к свойству, по ключу, деструктуризация; не вызов функции и не тип
const FIELD = /\.packageManager\b(?!\s*\()|\[\s*["'`]packageManager["'`]\s*\]|\b(?:const|let|var)\s*\{[^{}]*\bpackageManager\b[^{}]*\}\s*=/;
// lockfile или .yarnrc.yml строкой — целиком или концом пути
const LOCKFILE = /["'`/](?:bun\.lockb?|pnpm-lock\.yaml|yarn\.lock|npm-shrinkwrap\.json|package-lock\.json|\.yarnrc\.yml)["'`]/;
const touches = (code: string) => FIELD.test(code) || LOCKFILE.test(code);

/** Код файла без тела `packageManager` в github.ts — там поле и lockfile на своём месте; строки — на прежних номерах. */
function outsideAnswer(f: SourceFile): string {
  const code = codeOnly(f.text, f.file);
  if (f.file !== OWNER) return code;
  const start = code.search(/^export function packageManager\(/m);
  if (start < 0) return code;
  const end = start + code.slice(start).search(/^\}/m) + 1;
  return end <= start ? code : code.slice(0, start) + code.slice(start, end).replace(/[^\n]/g, " ") + code.slice(end);
}

describe("Скрипт флоу не читает packageManager и не ищет lockfile мимо функции packageManager", () => {
  invariant(it, {
    registry: "скрипты флоу, которые читают поле packageManager или называют lockfile",
    items: sources(ROOT, ["bin", "skills"]).filter((f) => /packageManager|lock|yarnrc/.test(f.text) && touches(codeOnly(f.text, f.file))),
    key: (f) => f.file,
    includes: [OWNER],
    name: (f) => `${f.file}: поле packageManager и lockfile — только в теле packageManager github`,
    check: (f) => {
      const code = outsideAnswer(f);
      if (!touches(code)) return;
      const lines = code.split("\n").flatMap((l, i) => (touches(l) ? [`${f.file}:${i + 1}: ${l.trim()}`] : []));
      throw new Error(`поле packageManager или lockfile мимо packageManager github — возьми ответ у неё:\n${lines.join("\n") || f.file}`);
    },
    violator: [
      {
        name: "скрипт флоу читает packageManager мимо этой функции",
        item: source("bin/elves.ts", 'const yarnShell = (root: string, pkg: { packageManager?: unknown }) => /^yarn@(?!1\\.)\\d/.test(String(pkg.packageManager ?? ""));\n'),
      },
      {
        name: "скрипт флоу ищет lockfile мимо этой функции",
        item: source("bin/elves.ts", 'const bun = ["bun.lock", "bun.lockb"].some((f) => existsSync(path.join(root, f)));\n'),
      },
      {
        name: "вторая функция packageManager в другом скрипте",
        item: source("skills/x/scripts/x.ts", 'export function packageManager(dir: string) {\n  return existsSync(path.join(dir, "yarn.lock")) ? "yarn" : "npm";\n}\n'),
      },
    ],
  });
});
