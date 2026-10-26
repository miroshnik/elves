import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";

import type { ManifestRead } from "../../../skills/github/scripts/locale.ts";
import { codeOnly, invariant, source, sources } from "../../../skills/spec/scripts/harness.ts";
import type { SourceFile } from "../../../skills/spec/scripts/harness.ts";
import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { tmpDir, writeTree } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SKILLS = path.join(ROOT, "skills");
const OWNER = "skills/github/scripts/locale.ts";
const COPY = "skills/task-env/scripts/task-env.ts";

type Read = (root: string) => ManifestRead;

/** Ответ на «что в манифесте проекта»: скрипт скилла и его `manifestOf`. */
interface Reader {
  file: string;
  read: Read;
}

/** Скрипты скиллов, которые экспортируют `manifestOf`: новая копия попадает под таблицу сама. */
async function readers(): Promise<Reader[]> {
  const out: Reader[] = [];
  for (const skill of readdirSync(SKILLS).sort()) {
    const dir = path.join(SKILLS, skill, "scripts");
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    } catch {
      continue;
    }
    for (const f of files) {
      if (!/^export function manifestOf\(/m.test(readFileSync(path.join(dir, f), "utf8"))) continue;
      const mod = await import(pathToFileURL(path.join(dir, f)).href);
      out.push({ file: `skills/${skill}/scripts/${f}`, read: mod.manifestOf });
    }
  }
  return out;
}

const NEW = ".agents/elves.json";

/** Строка таблицы: файлы манифеста в корне и ответ — файл, поля, ошибка. */
interface Row {
  files: Record<string, string>;
  want: string;
  why: string;
}

/** Таблица правила: что лежит в корне и что в манифесте. */
const TABLE: Row[] = [
  { files: {}, want: "нет файла · {}", why: "манифеста нет" },
  { files: { [NEW]: '{"language":"en","batch":true}' }, want: `${NEW} · {"language":"en","batch":true}`, why: "манифест установки" },
  { files: { [NEW]: "{" }, want: `${NEW} · {} · ошибка`, why: "не JSON" },
  { files: { [NEW]: "null" }, want: `${NEW} · {} · ошибка`, why: "JSON, но не объект" },
  { files: { [NEW]: "[1]" }, want: `${NEW} · {} · ошибка`, why: "массив — не объект" },
];

const label = (row: Row) => Object.keys(row.files).map((f) => `${f} ${row.files[f]}`).join(" + ") || "пусто";
const show = (r: ManifestRead) => `${r.file ?? "нет файла"} · ${JSON.stringify(r.fields)}${r.error ? " · ошибка" : ""}`;

const fixtures = tmpDir();
afterAll(() => fixtures.cleanup());

/** Корень строки таблицы — каталог с её файлами манифеста. */
const roots = TABLE.map((row, i) => {
  const dir = path.join(fixtures.dir, String(i));
  writeTree(dir, { ...row.files, ".keep": "" });
  return dir;
});

/** Строки таблицы, на которые ответ расходится с правилом. */
function mismatches(read: Read): string[] {
  return TABLE.flatMap((row, i) => {
    const got = show(read(roots[i]!));
    return got === row.want ? [] : [`${label(row)}: ${got}, а по правилу — ${row.want} (${row.why})`];
  });
}

// копии до стандарта: batchProject github (#648) не называл ошибку, readManifest установщика отдавал JSON как есть
const parse = (root: string, file: string) => JSON.parse(readFileSync(path.join(root, file), "utf8"));
const newOnly: Read = (root) => {
  if (!existsSync(path.join(root, NEW))) return { file: null, fields: {} };
  try {
    return { file: NEW, fields: parse(root, NEW) ?? {} };
  } catch {
    return { file: NEW, fields: {} };
  }
};
const asIs: Read = (root) => {
  const file = existsSync(path.join(root, NEW)) ? NEW : undefined;
  try {
    return { file: file ?? null, fields: file ? parse(root, file) : {} };
  } catch {
    return { file: file ?? null, fields: {} };
  }
};

const registry = await readers();

describe("Манифест проекта читает одна функция: .agents/elves.json; не объект — без полей, с ошибкой", () => {
  invariant(it, {
    registry: "скрипты скиллов с ответом на «что в манифесте проекта»",
    items: registry,
    key: (r) => r.file,
    includes: [OWNER, COPY],
    name: (r) => `${r.file}: манифест проекта — по таблице правила`,
    check: (r) => {
      const wrong = mismatches(r.read);
      if (wrong.length) throw new Error(`${r.file}: manifestOf расходится с правилом:\n${wrong.join("\n")}`);
    },
    violator: [
      { name: "batchProject до стандарта: битый и не объект — без ошибки", item: { file: "skills/github/scripts/github.ts batchProject", read: newOnly } },
      { name: "readManifest установщика до стандарта: JSON как есть, без ошибки", item: { file: "bin/elves.ts readManifest", read: asIs } },
    ],
  });

  it("таблица ловит расхождения копий до стандарта: не объект и битый файл у batchProject и readManifest", () => {
    expect([...mismatches(newOnly), ...mismatches(asIs)].map((m) => m.slice(0, m.indexOf(": ")))).toEqual([`${NEW} {`, `${NEW} null`, `${NEW} [1]`, `${NEW} {`, `${NEW} null`, `${NEW} [1]`]);
  });
});

// файл манифеста в коде: имя строкой (целиком или концом пути) и константы установщика и копий
const NAMES = /["'`/]elves\.json["'`]|\bMANIFESTS?\b/;

/** Код файла без тел `manifestOf` — там разбор на своём месте; строки — на прежних номерах. */
function outsideReader(f: SourceFile): string {
  let code = codeOnly(f.text, f.file);
  for (let from = 0; ; ) {
    const start = code.slice(from).search(/^export function manifestOf\(/m);
    if (start < 0) return code;
    const at = from + start;
    const end = at + code.slice(at).search(/^\}/m) + 1;
    if (end <= at) return code;
    code = code.slice(0, at) + code.slice(at, end).replace(/[^\n]/g, " ") + code.slice(end);
    from = end;
  }
}

/** Объявления верхнего уровня: от строки без отступа до следующей такой, закрывающие скобки — со своим объявлением. */
function declarations(code: string): { line: number; text: string }[] {
  const lines = code.split("\n");
  const out: { line: number; text: string }[] = [];
  let start = 0;
  for (let i = 1; i <= lines.length; i++) {
    if (i < lines.length && !/^[^\s}\])]/.test(lines[i]!)) continue;
    out.push({ line: start + 1, text: lines.slice(start, i).join("\n") });
    start = i;
  }
  return out;
}

/** Объявления, которые называют файл манифеста и зовут JSON.parse, — свой разбор манифеста. */
const ownParses = (f: SourceFile) => declarations(outsideReader(f)).filter((d) => NAMES.test(d.text) && /\bJSON\.parse\(/.test(d.text));

describe("Скрипт флоу не разбирает манифест мимо manifestOf", () => {
  invariant(it, {
    registry: "скрипты флоу, которые называют файл манифеста",
    items: sources(ROOT, ["bin", "skills"]).filter((f) => /elves\.json|MANIFEST/.test(f.text) && NAMES.test(codeOnly(f.text, f.file))),
    key: (f) => f.file,
    includes: [OWNER, COPY, "bin/elves.ts"],
    name: (f) => `${f.file}: манифест разбирает только manifestOf`,
    check: (f) => {
      const own = ownParses(f);
      if (own.length) throw new Error(`свой разбор манифеста — возьми ответ у manifestOf (locale.ts скилла github):\n${own.map((d) => `${f.file}:${d.line}: ${d.text.split("\n")[0]!.trim()}`).join("\n")}`);
    },
    violator: [
      {
        name: "установщик разбирает манифест сам",
        item: source(
          "bin/elves.ts",
          'function readManifest(root: string): Manifest {\n  const file = path.join(root, MANIFEST);\n  try {\n    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};\n  } catch {\n    return {};\n  }\n}\n',
        ),
      },
      {
        name: "скрипт скилла разбирает манифест сам",
        item: source(
          "skills/github/scripts/github.ts",
          'function batchProject(io: Io): boolean {\n  const file = path.join(locale.projectRoot(io.cwd ?? process.cwd()), ".agents", "elves.json");\n  try {\n    return JSON.parse(readFileSync(file, "utf8"))?.batch === true;\n  } catch {\n    return false;\n  }\n}\n',
        ),
      },
    ],
  });
});
