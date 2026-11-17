import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";

import { pathRules, pathsOf } from "../../../bin/elves.ts";
import { invariant } from "../../../skills/spec/scripts/harness.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
/** Справки флоу — `docs/*.md`: их копирует на машину установщик. */
const DOCS = readdirSync(path.join(ROOT, "docs")).filter((f) => f.endsWith(".md")).sort();
/** Справки, которые установщик ставит правилами Claude Code: с `paths:` во frontmatter. */
const RULED = new Set(pathRules(ROOT).map((r) => r.file));

describe("Справка docs/ для агента — правило Claude Code с paths:, а не чтение по необходимости", () => {
  invariant(it, {
    registry: "справки docs/",
    items: DOCS,
    key: (f) => `docs/${f}`,
    name: (f) => `docs/${f} — правило с paths:, установщик ставит его в правила машины`,
    check: (f) => {
      if (!RULED.has(f)) throw new Error(`docs/${f}: нет paths: во frontmatter — агент её не получит; файлы, с которыми она нужна, — в paths:, иначе удалить (tests/standards/documents/references)`);
    },
    violator: { name: "справка без paths:", item: "judgment.md" },
    outside: [
      { item: "docs/installation.md", reason: "установка для человека: на неё ведёт README, агент ставит флоу командой" },
      { item: "docs/other-agents.md", reason: "инструкция для агента не Claude Code (#848): у него нет ~/.claude/rules, путь к ней печатает установщик" },
      { item: "docs/prompt-cache.md", reason: "шаг владельца: команду печатает check -g, документ объясняет человеку цену выбора" },
    ],
    includes: ["docs/testing.md", "docs/ci-concurrency.md", "docs/parallel-checkouts.md"],
  });

  it("paths: — список шаблонов во frontmatter; без frontmatter или списка шаблонов нет", () => {
    expect(pathsOf('---\npaths:\n  - "**/*.test.*"\n  - tests/**\n---\n\n# Testing\n')).toEqual(["**/*.test.*", "tests/**"]);
    expect(pathsOf("# Testing\n\npaths:\n  - x\n")).toEqual([]);
    expect(pathsOf("---\ntitle: x\n---\n")).toEqual([]);
  });
});
