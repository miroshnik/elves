import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";

import { exceptionsIn, invariant } from "../../../skills/spec/scripts/harness.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/** Файлы канона: грузятся в каждую сессию Claude Code из `~/.claude/rules`. */
const CANON = ["AGENTS.md", "claude/CLAUDE.md"];
/** Раздел суждений: правила без механизма. */
const JUDGMENT = "Judgment";
/** Потолок списка суждений: рост — признак, что проза возвращается (canon-rules.md). */
const JUDGMENT_LIMIT = 16;

/** Правило канона — пункт списка с жирным именем: файл, раздел `##`, имя без точки в конце и текст пункта целиком. */
export interface Rule {
  file: string;
  section: string;
  name: string;
  text: string;
}

/**
 * Правила файла канона и проза вне них. Пункт — строка `- ` и строки продолжения с отступом; имя — жирное начало
 * без знака препинания в конце. Абзац вне списка (кроме вступления под заголовком файла) и пункт без имени — проза.
 */
export function rulesOf(file: string, md: string): { rules: Rule[]; loose: string[] } {
  const rules: Rule[] = [];
  const loose: string[] = [];
  let section = "";
  let item: string[] | null = null;
  let intro = true;
  const close = () => {
    if (!item) return;
    const text = item.join(" ").replace(/\s+/g, " ").trim();
    const name = /^- \*\*(.+?)\*\*/.exec(text)?.[1]?.replace(/[\s.,:;]+$/, "");
    if (name) rules.push({ file, section, name, text });
    else loose.push(`${file}: пункт без имени — ${text.slice(0, 80)}`);
    item = null;
  };
  for (const line of md.split("\n")) {
    if (/^#{1,6}\s/.test(line)) {
      close();
      if (/^##\s/.test(line)) (section = line.replace(/^##\s+/, "").trim()), (intro = false);
    } else if (line.startsWith("- ")) close(), (item = [line]);
    else if (item && /^\s+\S/.test(line)) item.push(line.trim());
    else if (!line.trim()) close();
    else if (!intro) close(), loose.push(`${file}: абзац вне правил — ${line.trim().slice(0, 80)}`);
  }
  close();
  return { rules, loose };
}

/** Чем держится правило: вид механизма, его имя в тексте правила и где в коде он есть (файл и строка в нём). */
interface Mechanism {
  kind: "хук" | "скрипт" | "установщик" | "настройка" | "ruleset" | "скилл";
  name: string;
  where: string;
  find: string;
}
type Holder = Mechanism | "judgment";

const hook = (name: string, where: string, find: string): Mechanism => ({ kind: "хук", name, where, find });
const script = (name: string, where: string, find: string): Mechanism => ({ kind: "скрипт", name, where, find });
const installer = (name: string, find: string): Mechanism => ({ kind: "установщик", name, where: "bin/elves.ts", find });
const GITHUB = "skills/github/scripts/github.ts";
const BYPASSES = "skills/github/scripts/bypasses.ts";

/**
 * Таблица «правило → механизм»: имя правила канона → механизм, который его держит, или суждение. Правило без строки,
 * строка без правила и механизм, которого нет в коде, — красный тест.
 */
export const HOLDERS: Record<string, Holder> = {
  "The canon lives in Elves": installer("elves install -g", "function installRules"),
  "References load by themselves": installer("elves install -g", "function pathRules"),
  "The SessionStart hook checks the flow": hook("SessionStart", "bin/elves.ts", "const HOOK_COMMAND"),
  "The project language": hook("SessionStart", "bin/elves.ts", "const modeLines"),
  "Commit, push and merge ask in a project without auto": { kind: "настройка", name: "permissions.ask", where: "bin/elves.ts", find: "const ASK_RULES" },
  "Tasks live in GitHub Issues": hook("PreToolUse", BYPASSES, 'rule: "Bash(gh issue view *)"'),
  "`github task next` is the entry": script("github task next", GITHUB, "export function taskNext"),
  "One session, one task": script("github task start", GITHUB, "isn't taken here"),
  "Open questions first": script("github task start", GITHUB, "! open questions —"),
  "A big task is an epic with subtasks": script("github task queue", GITHUB, "no open blockers"),
  "The dispatcher runs the queue": script("github task queue", GITHUB, "task queue --assignment"),
  "The actual comes from transcripts": script("github task close", GITHUB, "est fact --write"),
  "A branch from a fresh base": { kind: "ruleset", name: "github project fix", where: GITHUB, find: 'RULESET = "elves"' },
  "Before a commit — `elves precommit`": script("elves precommit", "skills/spec/scripts/precommit.ts", "test:spec"),
  "The tail — `github task finish <N>`": script("github task finish", GITHUB, "task finish <N>"),
  "Decisions with a deterministic check": { kind: "скилл", name: "`spec`", where: "skills/spec/canon.md", find: "No check — no decision" },
  "The check comes first, red": script("spec-red", GITHUB, "const specRedScript"),
  "Heavy runs wait in the machine queue": installer("slot", "function packageScripts"),
  "A task's services run in its own stack": installer("elves check", "function composeCheck"),
  "A fresh worktree gets its files": installer(".worktreeinclude", "const WORKTREE_INCLUDE"),
  "Irreversible and external actions need a yes": "judgment",
  "Secrets and protections need permission": "judgment",
  "Others' work isn't mine": "judgment",
  "A failed test gets its root cause fixed": "judgment",
  "A run's result is the runner's summary": "judgment",
  "A green check may hold wrong behavior": "judgment",
  "A mistake may look like a result": "judgment",
  "The production database is read-only": "judgment",
  '"Didn\'t help" goes to production facts': "judgment",
  "A subagent gets a small unit": "judgment",
  "Commits in logical steps": "judgment",
  "Knowledge lives in the project": "judgment",
  "The stack stays": "judgment",
  "A pause leaves a State comment": "judgment",
  "The app's tools load at once": script("github task start", GITHUB, "ToolSearch select:"),
  "Transcripts are the actuals": installer("elves check -g", "function cleanupLines"),
  "Auto-fix is off": script("github task finish", GITHUB, "set_monitor with auto_fix: false"),
  "CI waits are background commands": hook("PreToolUse", BYPASSES, 'rule: "Bash(gh run watch *)"'),
  "A merge in auto mode is a separate call": script("github task finish", GITHUB, "separate gh pr merge <PR> --rebase"),
  // каждый скрипт на gh держит строку — стандарт tests/standards/scripts/gh-sandbox
  "gh fails in the sandbox": script("the flow's scripts on `gh`", "skills/github/scripts/command.ts", "export const sandboxLine"),
  "Another task is a background executor": script("github task queue", GITHUB, "task queue --assignment"),
  "A subagent that writes gets `isolation: worktree`": "judgment",
};

/** Нарушение правила: текст ошибки, держится — null. `file` — текст файла репозитория или null, если его нет. */
export function unheld(rule: Rule, holders: Record<string, Holder>, file: (rel: string) => string | null): string | null {
  const holder = holders[rule.name];
  const at = `${rule.file}, «${rule.name}»`;
  if (!holder) return `${at}: механизм не назван — строка в HOLDERS, перенос в «${JUDGMENT}» или удаление (tests/standards/documents/canon-rules)`;
  if (holder === "judgment") return rule.section === JUDGMENT ? null : `${at}: суждение вне раздела «${JUDGMENT}» (раздел «${rule.section}»)`;
  if (rule.section === JUDGMENT) return `${at}: в «${JUDGMENT}» — правило с механизмом ${holder.name}: только суждения`;
  if (!rule.text.includes(holder.name)) return `${at}: текст правила не называет механизм ${holder.name}`;
  const code = file(holder.where);
  if (code === null) return `${at}: механизма нет — нет файла ${holder.where}`;
  if (!code.includes(holder.find)) return `${at}: механизма нет — в ${holder.where} не найдено «${holder.find}»`;
  return null;
}

const repoFile = (rel: string) => (existsSync(path.join(ROOT, rel)) ? read(rel) : null);
const PARSED = CANON.map((file) => rulesOf(file, read(file)));
const RULES = PARSED.flatMap((p) => p.rules);
const describeHolder = (r: Rule) => {
  const h = HOLDERS[r.name];
  return !h ? "механизм не назван" : h === "judgment" ? `суждение раздела ${JUDGMENT}` : `держит ${h.kind} ${h.name}`;
};

describe("У каждого правила канона назван механизм, или оно в списке суждений", () => {
  invariant(it, {
    registry: "правила канона — пункты AGENTS.md и claude/CLAUDE.md",
    items: RULES,
    key: (r) => r.name,
    name: (r) => `${r.file}: правило «${r.name}» — ${describeHolder(r)}`,
    check: (r) => {
      const err = unheld(r, HOLDERS, repoFile);
      if (err) throw new Error(err);
    },
    exceptions: exceptionsIn(),
    violator: [
      { name: "правило без механизма вне суждений", item: { file: "AGENTS.md", section: "Task tracking", name: "Tasks are estimated", text: "- **Tasks are estimated.** By eye." } },
      { name: "суждение вне раздела Judgment", item: { file: "AGENTS.md", section: "Task tracking", name: "The stack stays", text: "- **The stack stays.** …" } },
      { name: "правило, чей текст не называет механизм", item: { file: "AGENTS.md", section: "Task tracking", name: "Tasks live in GitHub Issues", text: "- **Tasks live in GitHub Issues.** By hand." } },
    ],
    includes: ["One session, one task", "The tail — `github task finish <N>`", "Others' work isn't mine", "CI waits are background commands"],
  });

  invariant(it, {
    registry: "строки таблицы «правило → механизм»",
    rule: "строка — правило канона",
    items: Object.keys(HOLDERS),
    key: (name) => name,
    name: (name) => `строка «${name}» таблицы механизмов — правило канона`,
    check: (name) => {
      if (!RULES.some((r) => r.name === name)) throw new Error(`«${name}»: правила с таким именем в каноне нет — убрать строку из HOLDERS (tests/standards/documents/canon-rules)`);
    },
    violator: { name: "строка удалённого правила", item: "Estimate before work" },
    includes: ["The canon lives in Elves"],
  });

  it("в каноне нет прозы вне правил — только вступление под заголовком файла", () => {
    expect(PARSED.flatMap((p) => p.loose)).toEqual([]);
  });

  it("список суждений короткий — не длиннее 16 пунктов", () => {
    const judged = RULES.filter((r) => r.section === JUDGMENT).map((r) => r.name);
    expect(judged.length).toBeGreaterThan(0);
    expect(judged.length).toBeLessThanOrEqual(JUDGMENT_LIMIT);
  });

  // spec-existing #846: примеры на выдуманном каноне проверяют разбор и проверку самого стандарта — они приходят с тестом
  describe("примеры", () => {
    const md = [
      "# Rules",
      "",
      "The intro.",
      "",
      "## Tasks",
      "",
      "- **One session, one task.** `github task start`",
      "  refuses another one.",
      "- no name here",
      "",
      "A loose paragraph.",
      "",
      "## Judgment",
      "",
      "- **The stack stays,** always.",
    ].join("\n");

    it("правило — пункт с жирным именем и строками продолжения; пункт без имени и абзац вне списка — проза", () => {
      const { rules, loose } = rulesOf("AGENTS.md", md);
      expect(rules.map((r) => [r.section, r.name])).toEqual([
        ["Tasks", "One session, one task"],
        ["Judgment", "The stack stays"],
      ]);
      expect(rules[0]!.text).toBe("- **One session, one task.** `github task start` refuses another one.");
      expect(loose).toEqual(["AGENTS.md: пункт без имени — - no name here", "AGENTS.md: абзац вне правил — A loose paragraph."]);
    });

    it("правило держится, когда его текст называет механизм, а механизм есть в коде; суждение — только в разделе Judgment", () => {
      const holders: Record<string, Holder> = { "One session, one task": script("github task start", GITHUB, "isn't taken here"), "The stack stays": "judgment" };
      const code = (rel: string) => (rel === GITHUB ? "… isn't taken here …" : null);
      const [held, judged] = rulesOf("AGENTS.md", md).rules;
      expect(unheld(held!, holders, code)).toBeNull();
      expect(unheld(judged!, holders, code)).toBeNull();
      expect(unheld(held!, holders, () => "")).toContain("не найдено «isn't taken here»");
      expect(unheld({ ...judged!, section: "Tasks" }, holders, code)).toContain("суждение вне раздела «Judgment»");
      expect(unheld({ ...held!, section: "Judgment" }, holders, code)).toContain("только суждения");
    });
  });
});
