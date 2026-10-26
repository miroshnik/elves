import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, setDefaultTimeout } from "bun:test";

import { invariant, source } from "../../../skills/spec/scripts/harness.ts";
import type { SourceFile } from "../../../skills/spec/scripts/harness.ts";
import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { gitRepo, tmpDir, writeTree } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/** Старое имя флоу: `ai-dev` в путях, именах и прозе, `AI_DEV_*` в переменных — в любом регистре. */
const OLD = /(?<![\p{L}\d])ai[-_]dev/giu;
const hasOld = (s: string) => s.search(OLD) >= 0;

/**
 * Файлы флоу — то, что ставит install в проект и на машину (канон, справочники, скиллы), установщик, README и
 * package.json. Тесты — вне охвата: старое имя в них — данные.
 */
const FLOW = ["AGENTS.md", "claude", "docs", "skills", "bin", "README.md", "package.json"];

/** Единственная строка со старым именем: симлинки переименования, которые снимает `update -g` (capability `elves#update`). */
const KEPT = { file: "bin/elves.ts", line: 'const RENAME_LINKS = [".config/ai-dev", ".claude/est"];' };

/**
 * Файлы флоу от корня, по порядку, — те, что попадают в коммит: отслеживаемые git и новые, кроме игнорируемых git.
 * Обход каталога читал бы и сгенерированное: страницы `docs/spec` после локального `spec:doc` называют старое имя в
 * названиях тестов, а в CI их ещё нет (#579). Отслеживаемый файл, удалённый из рабочей копии, — уже не файл флоу.
 */
function flowFiles(root = ROOT): string[] {
  const r = spawnSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...FLOW], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ls-files в ${root} — ${String(r.stderr).trim() || r.error}`);
  return [...new Set(r.stdout.split("\0").filter(Boolean))].filter((f) => existsSync(path.join(root, f))).sort();
}

/** Старое имя в файле — `файл:строка — строка`, в пути — `файл (путь файла)`; строка KEPT не в счёт. */
function found(f: SourceFile): string[] {
  const out = hasOld(f.file) ? [`${f.file} (путь файла)`] : [];
  f.text.split("\n").forEach((line, i) => {
    if (hasOld(line) && !(f.file === KEPT.file && line.trim() === KEPT.line)) out.push(`${f.file}:${i + 1} — ${line.trim()}`);
  });
  return out;
}

const FILES: SourceFile[] = flowFiles()
  .map((file) => ({ file, text: read(file) }))
  .filter((f) => hasOld(f.file) || hasOld(f.text));

describe("Старого имени ai-dev в файлах флоу нет", () => {
  invariant(it, {
    registry: "файлы флоу со старым именем — bin, skills, канон, docs, README.md, package.json",
    items: FILES,
    key: (f) => f.file,
    name: (f) => `в ${f.file} старого имени нет`,
    check: (f) => {
      const out = found(f);
      if (out.length) throw new Error(`старое имя — новое имя (Elves, elves, ELVES_*):\n${out.join("\n")}`);
    },
    violator: [
      { name: "скрипт читает прежний манифест", item: source("skills/github/scripts/locale.ts", 'const auto = () => read(".agents/ai-dev.json").auto;\n') },
      { name: "справочник называет прежний каталог", item: source("README.md", "Prices — `~/.config/ai-dev/prices.json`.\n") },
      { name: "файл скилла под прежним именем", item: source("skills/x/scripts/ai-dev.ts", "export {};\n") },
      { name: "установщик называет старое имя вне симлинков переименования", item: source(KEPT.file, `${KEPT.line}\nconst MANIFEST = ".agents/ai-dev.json";\n`) },
    ],
    // симлинки переименования сняты со всех машин — строка KEPT уходит, а с ней и это
    includes: [KEPT.file],
  });
});

describe("примеры", () => {
  it("old-name не читает файлы, которые git игнорирует: сгенерированный docs/spec не делает стандарт красным", () => {
    const { dir, cleanup } = tmpDir();
    try {
      gitRepo(dir).commit({ ".gitignore": "docs/spec/\n", "AGENTS.md": "# Elves\n", "docs/gone.md": "ai-dev\n" });
      rmSync(path.join(dir, "docs/gone.md"));
      writeTree(dir, {
        "docs/guide.md": "The settings — `.agents/ai-dev.json`.\n",
        "docs/spec/README.md": "# ai-dev\n",
        "docs/spec/capabilities/install.md": "update переносит .agents/ai-dev.json\n",
        "tests/x.test.ts": 'const MANIFEST = ".agents/ai-dev.json";\n',
      });
      expect(flowFiles(dir)).toEqual(["AGENTS.md", "docs/guide.md"]);
    } finally {
      cleanup();
    }
  });
});
