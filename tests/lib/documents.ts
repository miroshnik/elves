/**
 * Документы флоу для стандартов документов: что ставит install и README — путь от корня и текст. Без процессов: тест,
 * который читает только документы, не получает таймаут запуска процессов. Не спека — в документацию не попадает.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Документы флоу — то, что ставит install (AGENTS.md, claude/, docs/*.md, *.md скиллов), и README: путь от корня и текст. */
export function flowDocs(root = ROOT): { file: string; text: string }[] {
  const docs = readdirSync(path.join(root, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`);
  const skills = readdirSync(path.join(root, "skills")).flatMap((s) => {
    const dir = path.join(root, "skills", s);
    return existsSync(path.join(dir, "SKILL.md")) ? readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => `skills/${s}/${f}`) : [];
  });
  return ["AGENTS.md", "claude/CLAUDE.md", "README.md", ...docs, ...skills].map((file) => ({ file, text: readFileSync(path.join(root, file), "utf8") }));
}
