import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { ruleRefs, scanUsage, usageSummary, usageTable } from "../../../skills/est/scripts/est.ts";
import type { Universe, UsageSession } from "../../../skills/est/scripts/est.ts";
import { exitOf, SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { tmpDir } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

const EST = fileURLToPath(new URL("../../../skills/est/scripts/est.ts", import.meta.url));
const jsonl = (records: unknown[]) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";
const NOW = Date.now() / 1000;
const DAY = 86_400;
/** Время записи: `days` дней назад. */
const ago = (days: number) => new Date((NOW - days * DAY) * 1000).toISOString();

let dir: string;
let cleanup: () => void;
beforeEach(() => ({ dir, cleanup } = tmpDir()));
afterEach(() => cleanup());

/** Вызов инструмента: имя и вход — `command` у Bash, `file_path` у Read, `skill` у Skill. */
type Tool = [name: string, input: Record<string, unknown>];
const bash = (command: string): Tool => ["Bash", { command }];
const read = (file_path: string): Tool => ["Read", { file_path }];
const skill = (name: string): Tool => ["Skill", { skill: name }];

let seq = 0;
/** Ход агента в каталоге `cwd` `days` дней назад: ответ модели с вызовами инструментов. */
const turn = (days: number, cwd: string, ...tools: Tool[]) => {
  const id = `msg_${++seq}`;
  return {
    type: "assistant", timestamp: ago(days), cwd, gitBranch: "main",
    message: { id, model: "claude-opus-5", usage: { input_tokens: 0, output_tokens: 10 }, content: tools.map(([name, input], k) => ({ type: "tool_use", id: `toolu_${id}_${k}`, name, input })) },
  };
};

/** Транскрипт сессии `sid` в каталоге проектов: верхний уровень и субагенты; путь к файлу. */
function session(projects: string, sid: string, top: unknown[], subagents: unknown[][] = []): string {
  mkdirSync(projects, { recursive: true });
  const file = path.join(projects, `${sid}.jsonl`);
  writeFileSync(file, jsonl(top));
  subagents.forEach((records, k) => {
    const sub = path.join(projects, sid, "subagents");
    mkdirSync(sub, { recursive: true });
    writeFileSync(path.join(sub, `agent-a${k + 1}.jsonl`), jsonl(records));
  });
  return file;
}

/** Флоу из двух скриптов и справок — вместо обзоров `--help` настоящих скриптов. */
const UNIVERSE: Universe = {
  commands: { github: ["task new", "task show", "task close"], est: ["fact", "usage"], slot: [""], elves: ["install", "check"] },
  refs: ["github/SKILL.md", "github/reference.md", "docs/testing.md"],
};

/** Сводка сессий репозитория o/r в каталоге /repo за последние 30 дней. */
const summary = (sessions: UsageSession[], universe = UNIVERSE, paths = ["/repo"]) => usageSummary(sessions.map((s) => ({ session: s, repo: "o/r", paths })), universe, NOW - 30 * DAY, NOW);

/** Строка таблицы по началу подписи — ячейки, разделённые двумя и более пробелами. */
const cells = (lines: string[] | string, label: string) => (typeof lines === "string" ? lines.split("\n") : lines).find((l) => l.startsWith(label))?.trim().split(/\s{2,}/);

describe("Отчёт использования флоу — что из команд и справок вызывали за период", () => {
  it("`est usage` считает вызовы подкоманд скриптов флоу в сессиях и их субагентах", () => {
    const projects = path.join(dir, ".claude", "projects");
    const github = '"$HOME/.agents/skills/github/scripts/github.ts"';
    session(path.join(projects, "-repo"), "11111111-0000-4000-8000-000000000845", [
      turn(2, "/repo", bash(`bun --no-env-file ${github} task start 845 --branch feat/845-usage`)),
      turn(2, "/repo", bash(`cd /repo && bun --no-env-file ~/.claude/skills/github/scripts/github.ts task show 845 | head -40`), bash("bunx @miroshnik/elves check -g")),
      turn(2, "/repo", bash("set -o pipefail; bun --no-env-file node_modules/.bin/elves task-env down 845 2>&1 | tail -3")),
      // до периода — не в счёт
      turn(40, "/repo", bash(`bun --no-env-file ${github} task close 845`)),
    ], [[
      turn(2, "/repo", bash("bun --no-env-file /opt/elves/skills/est/scripts/est.ts fact 845 --repo o/r")),
      turn(2, "/repo", bash("bash ~/.claude/skills/ci-wait/scripts/wait-ci.sh pr 77")),
      turn(2, "/repo", bash(`bun --no-env-file ${github} task show 845`)),
    ]]);
    // сессия другого репозитория реестра — только с --all-repos
    session(path.join(projects, "-site"), "22222222-0000-4000-8000-000000000845", [turn(3, "/site", bash(`bun --no-env-file ${github} task new --title x`))]);
    const cfg = path.join(dir, "elves");
    mkdirSync(cfg, { recursive: true });
    writeFileSync(path.join(cfg, "repos.json"), JSON.stringify({ "o/r": { paths: ["/repo"] }, "o/site": { paths: ["/site"] } }));
    // без gh: отчёт не ходит в сеть
    const env = { ...process.env, HOME: dir, ELVES_CONFIG_DIR: cfg, CLAUDE_CODE_REMOTE: "", PATH: path.dirname(process.execPath) + ":/usr/bin:/bin" };
    const run = (...args: string[]) => spawnSync(process.execPath, ["--no-env-file", EST, "usage", ...args], { encoding: "utf8", env, cwd: dir });

    const r = run("--repo", "o/r");
    expect(r.stderr).toBe("");
    expect(exitOf(r)).toBe(0);
    expect(r.stdout).toContain("== o/r: the flow's use over 30 days");
    expect(r.stdout).toContain("1 session, 1 subagent");
    // calls, of them in subagents, --help
    expect(cells(r.stdout, "  github task show")).toEqual(["github task show", "2", "1", "0"]);
    expect(cells(r.stdout, "  github task start")).toEqual(["github task start", "1", "0", "0"]);
    expect(cells(r.stdout, "  est fact")).toEqual(["est fact", "1", "1", "0"]);
    expect(cells(r.stdout, "  wait-ci pr")).toEqual(["wait-ci pr", "1", "1", "0"]);
    expect(cells(r.stdout, "  elves check")).toEqual(["elves check", "1", "0", "0"]);
    expect(cells(r.stdout, "  task-env down")).toEqual(["task-env down", "1", "0", "0"]);
    expect(cells(r.stdout, "  github task close")).toBeUndefined();
    expect(cells(r.stdout, "  github task new")).toBeUndefined();
    // команды — из обзоров --help настоящих скриптов: без вызова — кандидаты
    const idle = cells(r.stdout, "  commands:")!.join(" ");
    expect(idle).toContain("github task close");
    expect(idle).toContain("est period");
    expect(idle).not.toContain("github task show");

    const all = run("--all-repos");
    expect(all.stderr).toBe("");
    expect(all.stdout).toContain("== all registry repositories: the flow's use over 30 days");
    expect(all.stdout).toContain("2 sessions, 1 subagent");
    expect(cells(all.stdout, "  github task new")).toEqual(["github task new", "1", "0", "0"]);
  });

  it("`est usage` отдельно считает вызовы `--help` и их долю", () => {
    const github = "~/.agents/skills/github/scripts/github.ts";
    const file = session(dir, "33333333-0000-4000-8000-000000000845", [
      turn(1, "/repo", bash(`bun --no-env-file ${github} task new --help`), bash(`bun --no-env-file ${github} task new --title x --epic 833`)),
      turn(1, "/repo", bash("bun --no-env-file ~/.agents/skills/est/scripts/est.ts --help")),
      turn(1, "/repo", bash("bun --no-env-file ~/.agents/skills/est/scripts/est.ts fact 42 -h")),
      turn(1, "/repo", bash("bun --no-env-file ~/.agents/skills/slot/scripts/slot.ts --capacity")),
      turn(1, "/repo", bash(`bun --no-env-file ${github} task --help`)),
    ]);
    const u = summary([scanUsage(file)]);
    expect(u.calls["github task new"]).toEqual({ calls: 2, sub: 0, help: 1 });
    expect(u.calls["est fact"]).toEqual({ calls: 1, sub: 0, help: 1 });
    expect(u.calls["est"]).toEqual({ calls: 1, sub: 0, help: 1 }); // обзор скрипта
    expect(u.calls["github task"]).toEqual({ calls: 1, sub: 0, help: 1 }); // группа команд, а не неизвестная команда
    expect(u.calls["slot"]).toEqual({ calls: 1, sub: 0, help: 0 });
    expect(u.unknown).toEqual([]);
    expect([u.total, u.help]).toEqual([6, 4]);
    const lines = usageTable(u, "o/r");
    expect(cells(lines, "  github task new")).toEqual(["github task new", "2", "0", "1"]);
    expect(lines).toContain("--help: 4 of 6 calls (67 %)");
  });

  it("`est usage` называет команды без вызовов за период", () => {
    const github = "~/.agents/skills/github/scripts/github.ts";
    const file = session(dir, "44444444-0000-4000-8000-000000000845", [
      turn(40, "/repo", bash(`bun --no-env-file ${github} task close 845`)), // до периода
      turn(1, "/repo", bash(`bun --no-env-file ${github} task show 845`)),
      turn(1, "/repo", bash("bun --no-env-file ~/.agents/skills/est/scripts/est.ts usage --help")), // справка — тоже вызов
      turn(1, "/repo", bash("bun --no-env-file ~/.agents/skills/est/scripts/est.ts estimate 42")), // команды нет в --help
      turn(1, "/repo", skill("github")),
    ]);
    const u = summary([scanUsage(file)]);
    expect(u.idle).toEqual(["elves check", "elves install", "est fact", "github task close", "github task new", "slot"]);
    expect(u.unread).toEqual(["docs/testing.md", "github/reference.md"]);
    expect(u.unknown).toEqual(["est estimate"]);
    const lines = usageTable(u, "o/r");
    expect(cells(lines, "  est estimate (not in --help)")).toEqual(["est estimate (not in --help)", "1", "0", "0"]);
    expect(lines).toContain("  commands: elves check, elves install, est fact, github task close, github task new, slot");
    expect(lines).toContain("  references: docs/testing.md, github/reference.md");
  });

  it("`est usage` считает чтения справок флоу", () => {
    const home = path.join(dir, "home");
    const clone = path.join(dir, "clone"); // клон Эльфов: в нём есть скилл est
    const proj = path.join(dir, "proj");
    mkdirSync(path.join(clone, "skills", "est"), { recursive: true });
    writeFileSync(path.join(clone, "skills", "est", "SKILL.md"), "# est\n");
    const universe: Universe = {
      commands: {},
      refs: ["github/SKILL.md", "github/reference.md", "spec/canon.md", "docs/testing.md", "docs/pr-checks.md", "docs/judgment.md", "docs/production.md"],
    };
    const inProj = session(path.join(dir, "p"), "55555555-0000-4000-8000-000000000845", [
      turn(1, proj, read(`${home}/.agents/skills/github/reference.md`), read(`${home}/.agents/elves/docs/testing.md`)),
      turn(1, proj, read(`${clone}/docs/pr-checks.md`), read(`${clone}/.claude/worktrees/agent-x/docs/judgment.md`)),
      turn(1, proj, bash(`cat ${home}/.agents/skills/spec/canon.md | head -80`), bash("sed -n 1,40p node_modules/@miroshnik/elves/docs/production.md")),
      turn(1, proj, skill("github"), skill("pdf"), read(`${clone}/skills/github/SKILL.md`)),
      // документ самого проекта и файл не флоу — не справки
      turn(1, proj, read(`${proj}/docs/testing.md`), read(`${home}/.agents/skills/shadcn/SKILL.md`)),
    ]);
    // в клоне Эльфов его файлы — работа над флоу, а не справка
    const inClone = session(path.join(dir, "c"), "66666666-0000-4000-8000-000000000845", [turn(1, clone, read(`${clone}/skills/github/SKILL.md`), read(`${clone}/.claude/worktrees/agent-x/docs/testing.md`))]);
    const u = usageSummary(
      [{ session: scanUsage(inProj), repo: "o/proj", paths: [proj] }, { session: scanUsage(inClone), repo: "o/elves", paths: [clone] }],
      universe, NOW - 30 * DAY, NOW,
    );
    expect(u.reads).toEqual({ "github/reference.md": 1, "docs/testing.md": 1, "docs/pr-checks.md": 1, "docs/judgment.md": 1, "spec/canon.md": 1, "docs/production.md": 1, "github/SKILL.md": 2 });
    expect(u.unread).toEqual([]);
    expect(cells(usageTable(u, "o/proj"), "  github/SKILL.md")).toEqual(["github/SKILL.md", "2"]);
  });

  /** Справка с `paths:` — правило Claude Code (#846): грузится с подходящим файлом, чтения в транскрипте нет. */
  it("`est usage` не называет кандидатом справку с paths: — она грузится правилом Claude Code, без чтения", () => {
    const docs = fileURLToPath(new URL("../../../docs", import.meta.url));
    expect(ruleRefs(docs)).toContain("docs/testing.md");
    expect(ruleRefs(docs)).not.toContain("docs/installation.md");
    const universe: Universe = { commands: {}, refs: ["docs/testing.md", "docs/installation.md"], rules: ruleRefs(docs) };
    expect(usageSummary([], universe, NOW - 30 * DAY, NOW).unread).toEqual(["docs/installation.md"]);
  });

  it("`est usage` считает обходы по списку защитного хука", () => {
    const file = session(dir, "77777777-0000-4000-8000-000000000845", [
      turn(1, "/repo", bash("gh issue view 42"), bash("gh issue view 42 --comments"), bash("gh issue view 42 -R o/r")),
      turn(1, "/repo", bash("gh issue view 42 --json title"), bash("gh issue view 42 --repo other/x"), bash("gh issue view https://github.com/other/x/issues/42")), // чтение, которого у флоу нет, и другой репозиторий
      turn(1, "/repo", bash("gh issue edit 3 --body x"), bash("gh issue edit 3 --add-label y")),
      turn(1, "/repo", bash("gh pr checks 5 --watch"), bash("gh pr checks 5"), bash("cd /repo && gh run watch 123 | tail -5")),
      turn(1, "/repo", bash('gh pr create --body "не gh issue view 1"')),
    ]);
    const u = summary([scanUsage(file)]);
    expect(u.bypasses).toEqual({ "gh issue view": 3, "gh issue edit --body": 1, "gh pr checks --watch": 1, "gh run watch": 1 });
    expect(cells(usageTable(u, "o/r"), "  gh issue view")).toEqual(["gh issue view", "3"]);
  });
});
