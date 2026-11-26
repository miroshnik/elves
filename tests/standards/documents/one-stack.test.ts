import { describe, expect, it } from "bun:test";

import { invariant } from "../../../skills/spec/scripts/harness.ts";
import { flowDocs } from "../../lib/documents.ts";

/**
 * Пример или строка конфига Vitest и Jest в документе: импорт их модуля, их команда и конфиг, их флаги. Название
 * раннера в прозе («отчёт Vitest — неизвестный формат») — не пример: так документ говорит, что раннера нет.
 */
const FOREIGN =
  /\bfrom\s+["'](?:vitest|@jest\/globals)["']|\bvitest\s+(?:run|list)\b|\b(?:vitest|jest)\.config\b|\bts-jest\b|\bvitest-blob\b|\bmaxWorkers\b|--changedSince\b|--passWithNoTests\b|--testPathIgnorePatterns\b/;

/**
 * Команда или конфиг npm, pnpm и Yarn как менеджера пакетов проекта: `npx <пакет>`, `pnpm <команда>`, `yarn <команда>`,
 * `npm run|ci|i|install|exec|test|start`, `pnpm-workspace.yaml`, `pnpm/action-setup`, `.yarnrc.yml`, `cache: pnpm`.
 * npm как реестр пакета (`npm publish`, «из npm») и название менеджера в прозе («проект на npm, pnpm или Yarn») — не
 * пример: так документ говорит, откуда пакет и что флоу таких проектов не держит.
 */
const FOREIGN_PM = /\bnpx\s+[\w@.-]|\b(?:pnpm|yarn)\s+(?!(?:or|and|nor)\b)[a-z@.:-]|\bpnpm[-/]|\.yarnrc\b|\bnpm\s+(?:run|ci|i|install|exec|test|start)\b|\bcache:\s*(?:pnpm|yarn|npm)\b/;

/** Строки документа, где есть `re`: «номер: строка». */
function linesOf(text: string, re: RegExp): string[] {
  return text.split("\n").flatMap((line, i) => (re.test(line) ? [`${i + 1}: ${line.trim().slice(0, 120)}`] : []));
}

describe("Справочники и `SKILL.md`: примеры — `bun test` и Playwright; строки конфигов Vitest и Jest (`maxWorkers`, `--changedSince`, `--passWithNoTests`) удалены", () => {
  invariant(it, {
    registry: "документы флоу — AGENTS.md, claude/CLAUDE.md, README.md, docs/*.md, *.md скиллов",
    items: flowDocs(),
    key: (d) => d.file,
    name: (d) => `в ${d.file} нет примеров и конфигов Vitest и Jest`,
    check: (d) => {
      const lines = linesOf(d.text, FOREIGN);
      if (lines.length) {
        throw new Error(`${d.file}: пример или конфиг Vitest и Jest — тесты проекта идут на bun test и Playwright (эпик #906, tests/standards/documents/one-stack):\n${lines.join("\n")}`);
      }
    },
    violator: { name: "справочник с примером Vitest", item: { file: "docs/x.md", text: '# Rule\n\n```ts\nimport { it } from "vitest";\n```\n' } },
    // SKILL.md и reference.md скилла spec называют Vitest и Jest в прозе — «неизвестный формат»: это не нарушение
    includes: ["docs/testing.md", "skills/spec/SKILL.md", "skills/spec/checks.md", "skills/spec/reference.md", "skills/spec/ci.md", "skills/slot/SKILL.md"],
  });
});

describe("Справочники и `SKILL.md`: команды проекта — `bun run`, `bunx`, `bun install`; без `npm run`, `npx`, `pnpm`, `yarn`. npm как реестр, откуда ставится `@miroshnik/elves`, остаётся.", () => {
  invariant(it, {
    registry: "документы флоу — AGENTS.md, claude/CLAUDE.md, README.md, docs/*.md, *.md скиллов",
    items: flowDocs(),
    key: (d) => d.file,
    name: (d) => `в ${d.file} команды проекта — bun и bunx, без npm, pnpm и Yarn`,
    check: (d) => {
      const lines = linesOf(d.text, FOREIGN_PM);
      if (lines.length) {
        throw new Error(`${d.file}: команда или конфиг npm, pnpm и Yarn — менеджер пакетов проекта Bun (эпик #906, tests/standards/documents/one-stack):\n${lines.join("\n")}`);
      }
    },
    violator: [
      { name: "шаг CI на pnpm", item: { file: "skills/x/ci.md", text: "```yaml\n      - uses: pnpm/action-setup@v6\n      - run: pnpm install --frozen-lockfile\n```\n" } },
      { name: "пример npx и npm run", item: { file: "docs/x.md", text: "```bash\nnpx playwright test\nnpm run build\n```\n" } },
      { name: "обёртка Yarn 2+", item: { file: "skills/x/SKILL.md", text: "On Yarn 2+ — `yarn dlx @miroshnik/elves slot`, `.yarnrc.yml` decides the shell.\n" } },
    ],
    // ci.md — шаблон CI, installation.md — пакет из npm (реестр), slot — обёртка проверок: там были pnpm, npx и Yarn 2+
    includes: ["docs/installation.md", "docs/testing.md", "skills/spec/ci.md", "skills/spec/SKILL.md", "skills/slot/SKILL.md", "skills/github/reference.md"],
  });

  it("npm как реестр и менеджер в прозе — не команда проекта: npm publish, «из npm», «проект на npm, pnpm или Yarn»", () => {
    const prose = ["CI publishes to npm with `elves pack <tag>`, then `npm publish`.", "A project on npm, pnpm or Yarn isn't on Bun.", "`bun install` moves pnpm and Yarn lockfiles into Bun's."];
    expect(prose.flatMap((t) => linesOf(t, FOREIGN_PM))).toEqual([]);
  });
});
