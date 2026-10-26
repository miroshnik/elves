import { existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, setDefaultTimeout } from "bun:test";

import { GhError, inTempWorktree } from "../../../skills/github/scripts/github.ts";
import type { Io } from "../../../skills/github/scripts/github.ts";
import { codeOnly, invariant, source, sources } from "../../../skills/spec/scripts/harness.ts";
import type { SourceFile } from "../../../skills/spec/scripts/harness.ts";
import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { gitRepo, tmpDir } from "../../lib/spec.ts";

// git — настоящий процесс во временном репозитории
setDefaultTimeout(SPAWN_TIMEOUT);

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const ONE = { file: "skills/github/scripts/github.ts", fn: "inTempWorktree" };

/** Место с `worktree add` в скрипте флоу: файл, функция верхнего уровня, в которой вызов, и строки вызовов. */
interface Place {
  file: string;
  fn: string;
  lines: number[];
}

// аргументы git в коде — "worktree", "add" в любых кавычках; в shell — git … worktree add
const ARGV = /(["'`])worktree\1\s*,\s*(["'`])add\2/g;
const SHELL = /\bgit\b[^\n;|&]*?\bworktree\s+add\b/g;
// объявление верхнего уровня: функция или const/let; в shell — name() {
const TOP_TS = /^(?:export\s+)?(?:async\s+)?(?:function\*?\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=)/gm;
const TOP_SH = /^(?:function\s+)?(\w+)\s*\(\)\s*\{/gm;

/** Места с `worktree add` в файле — по функции верхнего уровня; комментарий — не место. */
function placesIn(f: SourceFile): Place[] {
  const sh = f.file.endsWith(".sh");
  const code = sh ? f.text.replace(/^[ \t]*#.*$/gm, (c) => " ".repeat(c.length)) : codeOnly(f.text, f.file);
  const tops = [...code.matchAll(sh ? TOP_SH : TOP_TS)].map((m) => ({ at: m.index!, name: (m[1] ?? m[2])! }));
  const out = new Map<string, Place>();
  for (const m of code.matchAll(sh ? SHELL : ARGV)) {
    const fn = tops.filter((t) => t.at < m.index!).at(-1)?.name ?? "(модуль)";
    const place = out.get(fn) ?? { file: f.file, fn, lines: [] };
    place.lines.push(code.slice(0, m.index).split("\n").length);
    out.set(fn, place);
  }
  return [...out.values()];
}

/** Скрипты shell флоу: `.sh` в `skills` и `bin`. */
function shellScripts(): SourceFile[] {
  return ["skills", "bin"].flatMap((dir) =>
    readdirSync(path.join(ROOT, dir), { recursive: true, encoding: "utf8" })
      .filter((rel) => rel.endsWith(".sh") && !rel.split(path.sep).includes("node_modules"))
      .map((rel) => source(path.join(dir, rel).split(path.sep).join("/"), readFileSync(path.join(ROOT, dir, rel), "utf8"))),
  );
}

/** Скрипты флоу — код установщика и скиллов, без vendor, и их shell. */
const flowScripts = () => [...sources(ROOT, ["skills", "bin"]).filter((f) => !f.file.includes("/vendor/")), ...shellScripts()];

const keyOf = (p: Place) => `${p.file} › ${p.fn}`;

function check(p: Place) {
  if (p.file !== ONE.file || p.fn !== ONE.fn) {
    throw new Error(`${p.file}:${p.lines.join(",")}: worktree add в ${p.fn} мимо ${ONE.fn} из ${ONE.file} — временный worktree заводит и убирает она (tests/standards/temp-worktree)`);
  }
}

// копия до стандарта (#675): у трёх команд github свой add и своё снятие в finally
const BEFORE = source(
  ONE.file,
  [
    "function bisectRelease(io: Io, head: string): Guilty | null {",
    '  const dir = mkdtempSync(path.join(os.tmpdir(), "elves-bisect-"));',
    "  try {",
    '    const add = git(io.cwd, "worktree", "add", "-q", "--detach", dir, head);',
    "    if (add.status !== 0) return stop(`git worktree add: ${why(add)}`);",
    "    return bisect(dir);",
    "  } finally {",
    '    git(io.cwd, "worktree", "remove", "--force", dir);',
    "    rmSync(dir, { recursive: true, force: true });",
    '    git(io.cwd, "worktree", "prune");',
    "  }",
    "}",
    "",
    "export function cmdBatchRelease(io: Io, old: string): number {",
    '  const dir = mkdtempSync(path.join(os.tmpdir(), "elves-release-"));',
    "  try {",
    '    const add = git(io.cwd, "worktree", "add", "-q", "--detach", dir, old);',
    "    if (add.status !== 0) throw new GhError(`git worktree add: ${why(add)}`);",
    "    return rebase(dir);",
    "  } finally {",
    '    git(io.cwd, "worktree", "remove", "--force", dir);',
    "    rmSync(dir, { recursive: true, force: true });",
    '    git(io.cwd, "worktree", "prune");',
    "  }",
    "}",
    "",
    "export function cmdPrPremerge(io: Io, base: string): number {",
    "  const dirs: string[] = [];",
    "  const worktree = (): string => {",
    '    const dir = mkdtempSync(path.join(os.tmpdir(), "elves-premerge-"));',
    "    dirs.push(dir);",
    '    const add = git(io.cwd, "worktree", "add", "-q", "--detach", dir, `origin/${base}`);',
    "    if (add.status !== 0) throw new GhError(`git worktree add: ${add.stderr.trim()}`);",
    "    return dir;",
    "  };",
    "  try {",
    "    return merge(worktree());",
    "  } finally {",
    "    for (const dir of dirs) {",
    '      git(io.cwd, "worktree", "remove", "--force", dir);',
    "      rmSync(dir, { recursive: true, force: true });",
    "    }",
    '    git(io.cwd, "worktree", "prune");',
    "  }",
    "}",
    "",
  ].join("\n"),
);

describe("Временный worktree заводит и убирает одна функция", () => {
  describe("скрипты флоу зовут worktree add только в ней: копия до стандарта — нарушитель", () => {
    invariant(it, {
      registry: "места с worktree add в скриптах флоу",
      items: flowScripts().flatMap(placesIn),
      key: keyOf,
      name: (p) => `worktree add в ${keyOf(p)} — в функции временного worktree`,
      check,
      violator: placesIn(BEFORE).map((p) => ({ name: `копия до стандарта в ${p.fn}`, item: p })),
      includes: [keyOf({ ...ONE, lines: [] })],
    });

    it("в копии до стандарта места — в bisectRelease, cmdBatchRelease и cmdPrPremerge, и каждое — нарушение", () => {
      const places = placesIn(BEFORE);
      expect(places.map((p) => p.fn)).toEqual(["bisectRelease", "cmdBatchRelease", "cmdPrPremerge"]);
      for (const p of places) expect(() => check(p)).toThrow(`worktree add в ${p.fn} мимо ${ONE.fn}`);
    });

    it("место — вызов git с worktree add в коде и в shell; комментарий и другие подкоманды worktree — не место", () => {
      const ts = source(
        "skills/x/scripts/x.ts",
        [
          "// git(io, dir, \"worktree\", \"add\", dir) — комментарий",
          "export function list(io: Io) {",
          '  return git(io, io.cwd, "worktree", "list", "--porcelain");',
          "}",
          "const add = (dir: string) => spawnSync('git', ['-C', dir, 'worktree', 'add', '--detach', dir]);",
        ].join("\n"),
      );
      const sh = source("skills/x/scripts/x.sh", ['# git worktree add "$dir" — комментарий', "setup() {", '  git -C "$repo" worktree add -q --detach "$dir" HEAD', "}"].join("\n"));
      expect([...placesIn(ts), ...placesIn(sh)].map((p) => `${keyOf(p)}:${p.lines.join(",")}`)).toEqual(["skills/x/scripts/x.ts › add:5", "skills/x/scripts/x.sh › setup:3"]);
    });
  });

  it("ошибка внутри временного worktree не оставляет его в git worktree list чекаута", () => {
    const { dir, cleanup } = tmpDir();
    try {
      const repo = gitRepo(dir);
      repo.commit({ "a.txt": "a\n" }, "init");
      const listed = () => repo.git("worktree", "list", "--porcelain");
      const before = listed();
      // свой префикс каталога: временные каталоги параллельных прогонов не мешают
      const prefix = `spec-${process.pid}`;
      const left = () => readdirSync(os.tmpdir()).filter((n) => n.startsWith(`elves-${prefix}-`));
      const io: Io = {
        gh: () => {
          throw new Error("gh не нужен");
        },
        out: () => {},
        err: () => {},
        env: {},
        cwd: dir,
      };
      let inside = "";
      expect(() =>
        inTempWorktree(io, prefix, "HEAD", (wt) => {
          inside = wt;
          expect(readFileSync(path.join(wt, "a.txt"), "utf8")).toBe("a\n");
          expect(listed().split("\n").filter((l) => l.startsWith("worktree "))).toHaveLength(2);
          throw new Error("сбой внутри");
        }),
      ).toThrow("сбой внутри");
      expect(inside).not.toBe("");
      expect({ list: listed(), dir: existsSync(inside), left: left() }).toEqual({ list: before, dir: false, left: [] });

      // add не прошёл — ошибка с причиной git, работа не идёт, чекаут тот же
      let ran = false;
      expect(() => inTempWorktree(io, prefix, "no-such-revision", () => (ran = true))).toThrow(GhError);
      expect({ ran, list: listed(), left: left() }).toEqual({ ran: false, list: before, left: [] });
    } finally {
      cleanup();
    }
  });
});
