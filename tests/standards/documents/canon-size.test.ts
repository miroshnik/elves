import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";

import { invariant } from "../../../skills/spec/scripts/harness.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/** Документ флоу и его бюджет в словах: ядро канона грузится в каждую сессию и каждого субагента, SKILL.md — при каждом вызове скилла. */
interface Doc {
  file: string;
  text: string;
  limit: number;
}
/** Файлы ядра канона: оба грузятся в каждую сессию, поэтому бюджет у них общий. */
const CORE_FILES = ["AGENTS.md", "claude/CLAUDE.md"];
/** Половина прежних 3 000 + 700 слов (#846): правило с механизмом — строка, суждение — короткий список (canon-rules). */
const CORE_LIMIT = 1850;
const SKILL_LIMIT = 2500;
/** Лимит Agent Skills на описание скилла: длиннее — список скиллов его обрезает. */
const DESCRIPTION_LIMIT = 1024;

const CORE: Doc[] = [{ file: CORE_FILES.join(" + "), text: CORE_FILES.map(read).join("\n"), limit: CORE_LIMIT }];
const SKILLS: Doc[] = readdirSync(path.join(ROOT, "skills"))
  .map((name) => `skills/${name}/SKILL.md`)
  .filter((file) => existsSync(path.join(ROOT, file)))
  .map((file) => ({ file, text: read(file), limit: SKILL_LIMIT }));

/** Слова файла — всё, что между пробелами, как `wc -w`: в контекст попадает весь файл, блоки кода и frontmatter тоже. */
export const wordsOf = (text: string): number => text.split(/\s+/).filter(Boolean).length;

const frontmatter = (md: string): string | undefined => /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(md)?.[1];

/** Описание скилла — `description` из frontmatter SKILL.md, как его читает YAML; нет frontmatter или описания — null. */
export function descriptionOf(md: string): string | null {
  const fm = frontmatter(md);
  if (fm === undefined) return null;
  const data = Bun.YAML.parse(fm) as { description?: unknown } | null;
  return typeof data?.description === "string" ? data.description : null;
}

/**
 * Описание без кавычек, которое YAML обрезал: ` #` в нём начинает комментарий, и хвост с триггерами «When — …»
 * пропадает молча (так было у github: «do all tasks of epic #M»). Сырое значение строки `description:` — начало
 * прочитанного; в кавычках или блоком (`"`, `'`, `>`, `|`) комментария нет.
 */
export function descriptionCut(md: string): boolean {
  const raw = /^description:[ \t]*(.*)$/m.exec(frontmatter(md) ?? "")?.[1]?.trim();
  if (!raw || /^["'>|]/.test(raw)) return false;
  return !(descriptionOf(md) ?? "").startsWith(raw);
}

/** Длина в символах (кодовых точках), не в байтах и не в UTF-16: «—» — один символ. */
export const charsOf = (s: string): number => [...s].length;

const overBudget = (d: Doc, hint: string) => {
  const words = wordsOf(d.text);
  if (words > d.limit) throw new Error(`${d.file}: ${words} слов при бюджете ${d.limit} — ${hint} (tests/standards/documents/canon-size)`);
};
const checkCore = (d: Doc) => overBudget(d, "вынести подробность целой темой в её md (docs/<тема>.md, reference.md скилла) со ссылкой отсюда; удалять — неиспользуемое по est usage");
const checkSkill = (d: Doc) => overBudget(d, "справку — целой темой в reference.md скилла или в --help, в SKILL.md — когда и что звать; удалять — неиспользуемое по est usage");

/**
 * Правило репозитория Elves на случай упора в бюджет: удаляется неиспользуемое — по отчёту `est usage` (#845), а бюджет —
 * потолок. Оно в `.claude/CLAUDE.md` клона, а не в каноне: канон грузится в каждый проект, а правят флоу только в Elves.
 */
export const BUDGET_RULE = ["`documents#canon-size`", "**Unused is deleted.**", "`est usage`"];
export const missingBudgetRule = (md: string): string[] => BUDGET_RULE.filter((part) => !md.includes(part));
const checkDescription = (d: Doc) => {
  const desc = descriptionOf(d.text);
  if (desc === null) throw new Error(`${d.file}: нет description во frontmatter (tests/standards/documents/canon-size)`);
  if (descriptionCut(d.text)) throw new Error(`${d.file}: описание без кавычек обрезано — « #» в YAML начинает комментарий; взять описание в двойные кавычки (tests/standards/documents/canon-size)`);
  const n = charsOf(desc);
  if (n > DESCRIPTION_LIMIT) throw new Error(`${d.file}: описание ${n} символов при лимите ${DESCRIPTION_LIMIT} — подробности в тело SKILL.md (tests/standards/documents/canon-size)`);
};

/** Куда ядро отправляет читателя: скилл `name` (``the `name` skill`` или ``skill `name` ``) или справочник `docs/<name>.md`. */
interface Pointer {
  kind: "skill" | "doc";
  name: string;
}
export function pointers(md: string): Pointer[] {
  const out = new Map<string, Pointer>();
  for (const m of md.matchAll(/`([a-z][\w-]*)`\s+skills?\b|\bskills?\s+`([a-z][\w-]*)`/g)) {
    const name = (m[1] ?? m[2])!;
    out.set(`skill:${name}`, { kind: "skill", name });
  }
  for (const m of md.matchAll(/`docs\/([\w-]+\.md)`/g)) out.set(`doc:${m[1]}`, { kind: "doc", name: m[1]! });
  return [...out.values()];
}
const pointerPath = (p: Pointer) => (p.kind === "skill" ? `skills/${p.name}/SKILL.md` : `docs/${p.name}`);

const filler = (words: number) => "слово ".repeat(words);
const canon = (words: number): Doc => ({ file: "AGENTS.md + claude/CLAUDE.md", text: filler(words), limit: CORE_LIMIT });
const skill = (words: number): Doc => ({ file: "skills/x/SKILL.md", text: filler(words), limit: SKILL_LIMIT });
const described = (description: string): Doc => ({ file: "skills/x/SKILL.md", text: `---\nname: x\ndescription: ${description}\n---\n`, limit: SKILL_LIMIT });

describe("Ядро канона и SKILL.md умещаются в бюджет слов, описание скилла — в лимит Agent Skills", () => {
  it("Канон и файл Claude Code вместе не длиннее половины прежнего бюджета", () => {
    expect(CORE_LIMIT).toBe((3000 + 700) / 2);
    expect(() => checkCore(canon(1851))).toThrow("1851 слов при бюджете 1850");
    expect(() => checkCore(canon(1850))).not.toThrow();
    expect(wordsOf(CORE[0]!.text)).toBeLessThanOrEqual(CORE_LIMIT);
  });

  it("SKILL.md длиннее 2 500 слов не проходит стандарт", () => {
    expect(() => checkSkill(skill(2501))).toThrow("2501 слов при бюджете 2500");
    expect(() => checkSkill(skill(2500))).not.toThrow();
  });

  it("описание скилла длиннее 1 024 символов не проходит стандарт", () => {
    expect(() => checkDescription(described(`"${"ё".repeat(1025)}"`))).toThrow("описание 1025 символов при лимите 1024");
    expect(() => checkDescription(described(`"${"ё".repeat(1024)}"`))).not.toThrow();
  });

  invariant(it, {
    registry: "ядро канона с бюджетом в словах",
    items: CORE,
    key: (d) => d.file,
    name: (d) => `${d.file} вместе не длиннее ${d.limit} слов`,
    check: checkCore,
    violator: { name: "канон длиннее 1 850 слов", item: canon(1851) },
    includes: ["AGENTS.md + claude/CLAUDE.md"],
  });

  invariant(it, {
    registry: "SKILL.md скиллов",
    rule: "бюджет слов",
    items: SKILLS,
    key: (d) => d.file,
    name: (d) => `${d.file} не длиннее ${d.limit} слов`,
    check: checkSkill,
    violator: { name: "SKILL.md длиннее 2 500 слов", item: skill(2501) },
    includes: ["skills/github/SKILL.md", "skills/spec/SKILL.md", "skills/est/SKILL.md", "skills/task-env/SKILL.md"],
  });

  invariant(it, {
    registry: "SKILL.md скиллов",
    rule: "описание",
    items: SKILLS,
    key: (d) => d.file,
    name: (d) => `${d.file}: описание целиком и не длиннее ${DESCRIPTION_LIMIT} символов`,
    check: checkDescription,
    violator: [
      { name: "описание скилла длиннее 1 024 символов", item: described(`"${"a".repeat(1025)}"`) },
      { name: "описание без кавычек, обрезанное комментарием YAML", item: described("When — do all tasks of epic #M, fix all bugs") },
    ],
    includes: ["skills/github/SKILL.md", "skills/task-env/SKILL.md", "skills/est/SKILL.md"],
  });

  it("описание в кавычках с « #» и многострочное без кавычек — не обрезаны", () => {
    expect(descriptionCut('---\nname: x\ndescription: "When — epic #M"\n---\n')).toBe(false);
    expect(descriptionCut("---\nname: x\ndescription: When — a run\n  is slow\n---\n")).toBe(false);
    expect(descriptionOf("---\nname: x\ndescription: When — a run\n  is slow\n---\n")).toBe("When — a run is slow");
  });

  it("бюджет — потолок, неиспользуемое удаляется по `est usage` — правило есть в .claude/CLAUDE.md клона Elves", () => {
    expect(missingBudgetRule(read(".claude/CLAUDE.md"))).toEqual([]);
    expect(missingBudgetRule("Budgets: this file ≤ 3,000 words.")).toEqual(BUDGET_RULE);
  });

  it("бюджет считается в словах всего файла — что между пробелами, блоки кода и frontmatter не исключаются", () => {
    expect(wordsOf("# Правило\n\n```bash\nbunx github:miroshnik/elves install\n```\n")).toBe(7);
    expect(wordsOf("  ёлка — палка\t\n")).toBe(3);
  });

  it("описание скилла — значение description во frontmatter в символах, а не в байтах", () => {
    const md = '---\nname: x\ndescription: "Когда — «всё»: ё"\nallowed-tools: Bash(bun *)\n---\n\n# x\n';
    expect(descriptionOf(md)).toBe("Когда — «всё»: ё");
    expect(charsOf(descriptionOf(md)!)).toBe(16);
    expect(descriptionOf("# x\n")).toBeNull();
  });

  it("указатель на скилл — `the `name` skill` или `skill `name``; команда скилла в бэктиках указателем не считается", () => {
    const md = "The `github` skill creates tasks; skill `est` estimates; `github project fix` turns it off; `docs/testing.md`.";
    expect(pointers(md)).toEqual([
      { kind: "skill", name: "github" },
      { kind: "skill", name: "est" },
      { kind: "doc", name: "testing.md" },
    ]);
  });

  invariant(it, {
    registry: "скиллы и справочники docs/, на которые ядро отправляет читателя",
    rule: "существуют",
    items: pointers(CORE_FILES.map(read).join("\n")),
    key: (p) => pointerPath(p),
    name: (p) => `${pointerPath(p)} есть в репозитории`,
    check: (p) => {
      if (!existsSync(path.join(ROOT, pointerPath(p)))) throw new Error(`ядро ссылается на ${pointerPath(p)}, а его нет — вынесенное потерялось (tests/standards/documents/canon-size)`);
    },
    violator: { name: "ссылка ядра на удалённый скилл", item: { kind: "skill" as const, name: "billing" } },
    includes: ["skills/github/SKILL.md", "skills/spec/SKILL.md"],
  });
});
