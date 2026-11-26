import { describe, it } from "bun:test";

import { invariant } from "../../../skills/spec/scripts/harness.ts";
import { flowDocs } from "../../lib/documents.ts";

/**
 * Пример или строка конфига Vitest и Jest в документе: импорт их модуля, их команда и конфиг, их флаги. Название
 * раннера в прозе («отчёт Vitest — неизвестный формат») — не пример: так документ говорит, что раннера нет.
 */
const FOREIGN =
  /\bfrom\s+["'](?:vitest|@jest\/globals)["']|\bvitest\s+(?:run|list)\b|\b(?:vitest|jest)\.config\b|\bts-jest\b|\bvitest-blob\b|\bmaxWorkers\b|--changedSince\b|--passWithNoTests\b|--testPathIgnorePatterns\b/;

/** Строки документа с примером или конфигом Vitest и Jest: «номер: строка». */
function foreignLines(text: string): string[] {
  return text.split("\n").flatMap((line, i) => (FOREIGN.test(line) ? [`${i + 1}: ${line.trim().slice(0, 120)}`] : []));
}

describe("Справочники и `SKILL.md`: примеры — `bun test` и Playwright; строки конфигов Vitest и Jest (`maxWorkers`, `--changedSince`, `--passWithNoTests`) удалены", () => {
  invariant(it, {
    registry: "документы флоу — AGENTS.md, claude/CLAUDE.md, README.md, docs/*.md, *.md скиллов",
    items: flowDocs(),
    key: (d) => d.file,
    name: (d) => `в ${d.file} нет примеров и конфигов Vitest и Jest`,
    check: (d) => {
      const lines = foreignLines(d.text);
      if (lines.length) {
        throw new Error(`${d.file}: пример или конфиг Vitest и Jest — тесты проекта идут на bun test и Playwright (эпик #906, tests/standards/documents/one-stack):\n${lines.join("\n")}`);
      }
    },
    violator: { name: "справочник с примером Vitest", item: { file: "docs/x.md", text: '# Rule\n\n```ts\nimport { it } from "vitest";\n```\n' } },
    // SKILL.md и reference.md скилла spec называют Vitest и Jest в прозе — «неизвестный формат»: это не нарушение
    includes: ["docs/testing.md", "skills/spec/SKILL.md", "skills/spec/checks.md", "skills/spec/reference.md", "skills/spec/ci.md", "skills/slot/SKILL.md"],
  });
});
