import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";

import { BYPASSES } from "../../../skills/github/scripts/bypasses.ts";
import type { Bypass } from "../../../skills/github/scripts/bypasses.ts";
import { main } from "../../../skills/github/scripts/github.ts";
import { invariant } from "../../../skills/spec/scripts/harness.ts";
import { tmpDir } from "../../lib/spec.ts";
import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

const SCRIPT = fileURLToPath(new URL("../../../skills/github/scripts/github.ts", import.meta.url));
/** Команды флоу в причине запрета — как их печатает хук: агент запускает их как есть. */
const GITHUB = `bun --no-env-file ${SCRIPT}`;
const WAIT_CI = `bash ${fileURLToPath(new URL("../../../skills/ci-wait/scripts/wait-ci.sh", import.meta.url))}`;

// чекаут сессии (acme/shop), чекаут другого репозитория (acme/site) и каталог без origin на GitHub
const tmp = tmpDir();
afterAll(() => tmp.cleanup());
function checkout(name: string, origin?: string) {
  const dir = path.join(tmp.dir, name);
  mkdirSync(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  if (origin) execFileSync("git", ["remote", "add", "origin", origin], { cwd: dir });
  return dir;
}
const SHOP = checkout("shop", "git@github.com:acme/shop.git");
const SITE = checkout("site", "https://github.com/acme/site.git");
const LOCAL = checkout("local", "/srv/mirror/acme/shop.git");

/** Вход хука PreToolUse для Bash-вызова — как его даёт Claude Code. */
const input = (command: string, cwd = SHOP) => JSON.stringify({ session_id: "s", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command, description: "…" }, cwd });

/** `github hook guard` на входе: код, вывод, причина запрета (null — вызов пропущен). Сети нет: `gh` бросает. */
function guard(stdin: string | (() => string), run?: Parameters<typeof main>[1]["run"]) {
  const out: string[] = [];
  const err: string[] = [];
  const gh = () => {
    throw new Error("хук не ходит в GitHub");
  };
  const code = main(["hook", "guard"], { gh, out: (l) => out.push(l), err: (l) => err.push(l), env: { HOME: tmp.dir }, stdin: typeof stdin === "string" ? () => stdin : stdin, run });
  const decision = out.length ? JSON.parse(out.join("\n")).hookSpecificOutput : null;
  return { code, out: out.join("\n"), err: err.join("\n"), decision, reason: (decision?.permissionDecisionReason as string | undefined) ?? null };
}
const reasonOf = (command: string, cwd = SHOP) => guard(input(command, cwd)).reason;

describe("Обход команды флоу хук PreToolUse запрещает с готовой командой флоу", () => {
  it("`gh issue view` задачи своего репозитория хук запрещает и называет `task show`", () => {
    const r = guard(input("gh issue view 42"));
    expect(r.code).toBe(0);
    expect(r.decision).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(r.reason).toContain("`gh issue view 42`");
    expect(r.reason).toEndWith(`Run instead: ${GITHUB} task show 42`);
    // свой репозиторий — и по --repo, и по URL, без учёта регистра
    for (const call of ["gh issue view 42 --repo Acme/Shop", "gh issue view https://github.com/acme/shop/issues/42 --comments", "gh issue view '#42' -R acme/shop", "gh issue view 42 -R=github.com/acme/shop"]) {
      expect(reasonOf(call)).toEndWith(`Run instead: ${GITHUB} task show 42`);
    }
    // чтение, которого у task show нет, — не обход
    expect(reasonOf("gh issue view 42 --json body --jq .body")).toBeNull();
    expect(reasonOf("gh issue view 42 --web")).toBeNull();
  });

  it("`gh issue view` чужого репозитория хук пропускает", () => {
    for (const call of ["gh issue view 42 --repo acme/site", "gh issue view 42 -R=github.com/acme/site", "gh issue view https://github.com/acme/site/issues/42", "GH_REPO=acme/site gh issue view 42", `cd ${SITE} && gh issue view 42`, "cd - && gh issue view 42"]) {
      expect({ call, reason: reasonOf(call) }).toEqual({ call, reason: null });
    }
    // каталог без origin на GitHub — задач флоу нет
    expect(reasonOf("gh issue view 42", LOCAL)).toBeNull();
    // а `cd` в свой чекаут — снова свой
    expect(reasonOf(`cd ${SITE} && cd ${SHOP} && gh issue view 42`)).toEndWith(`${GITHUB} task show 42`);
  });

  it("`gh run watch` хук запрещает и называет `wait-ci`", () => {
    const run = reasonOf("gh run watch 1234567 --exit-status");
    expect(run).toContain("ci-wait as a background command (run_in_background)");
    expect(run).toEndWith(`Run instead: ${WAIT_CI} pr <N>`);
    expect(reasonOf("gh pr checks 57 --watch --interval 10")).toEndWith(`Run instead: ${WAIT_CI} pr 57`);
    // без --watch — разовое чтение чеков, не ожидание
    expect(reasonOf("gh pr checks 57")).toBeNull();
  });

  it("Обход внутри составной команды хук тоже ловит", () => {
    expect(reasonOf("git fetch -q origin && gh issue view 42 --comments 2>&1 | head -40")).toEndWith(`${GITHUB} task show 42`);
    expect(reasonOf("for n in 41 42; do gh issue view $n; done")).toEndWith(`${GITHUB} task show $n`);
    expect(reasonOf('echo "$(gh issue view 42)"')).toEndWith(`${GITHUB} task show 42`);
    expect(reasonOf("echo `gh pr checks 57 --watch`")).toEndWith(`${WAIT_CI} pr 57`);
    expect(reasonOf("ls -la; gh issue edit 42 --body-file body.md")).toContain(`${GITHUB} task edit 42 --replace`);
    // текст — не команда: тело PR в heredoc, строка в одинарных кавычках, комментарий
    const body = `gh pr create --title "docs: x" --body "$(cat <<'EOF'\nЗадача читается не через gh issue view 42, а "task show".\nEOF\n)"`;
    expect(reasonOf(body)).toBeNull();
    expect(reasonOf("cat > notes.md <<EOF\ngh run watch 1\nEOF\ngit add notes.md")).toBeNull();
    expect(reasonOf("echo 'gh issue view 42' # gh run watch")).toBeNull();
  });

  it("Ошибка самого хука команду не блокирует", () => {
    const silent = { code: 0, out: "", err: "", reason: null };
    expect(guard("не JSON")).toMatchObject(silent);
    expect(guard("")).toMatchObject(silent);
    expect(guard("null")).toMatchObject(silent);
    expect(
      guard(() => {
        throw new Error("stdin закрыт");
      }),
    ).toMatchObject(silent);
    // git нет — своего репозитория хук не знает, вызов идёт
    const noGit = () => {
      throw new Error("spawn git ENOENT");
    };
    expect(guard(input("gh issue view 42"), noGit)).toMatchObject(silent);
    // каталога из входа нет — тоже
    expect(guard(input("gh issue view 42", path.join(tmp.dir, "gone")))).toMatchObject(silent);
    // не Bash — не дело хука
    expect(guard(JSON.stringify({ tool_name: "Read", tool_input: { file_path: "x" }, cwd: SHOP }))).toMatchObject(silent);
    // процесс скрипта: вход не JSON — код 0, ни строки ни в stdout, ни в stderr
    const r = spawnSync("bun", ["--no-env-file", SCRIPT, "hook", "guard"], { input: "{", encoding: "utf8" });
    expect({ code: r.status, stdout: r.stdout, stderr: r.stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
  });
});

/**
 * Случаи каждого обхода: вызов, который хук запрещает, с началом замены в причине, и соседний вызов той же команды,
 * который он пропускает. Новое правило в bypasses.ts без строки здесь — красный тест.
 */
const CASES: Record<string, { deny: { call: string; use: string }[]; pass: string[] }> = {
  "Bash(gh issue view *)": { deny: [{ call: "gh issue view 7 -c", use: `${GITHUB} task show 7` }], pass: ["gh issue view 7 --json state --jq .state"] },
  "Bash(gh issue edit *)": { deny: [{ call: "gh issue edit 7 -b 'new body'", use: `${GITHUB} task edit 7 --replace '<old>' '<new>'` }], pass: ["gh issue edit 7 --add-label bug"] },
  "Bash(gh run watch *)": { deny: [{ call: "gh run watch", use: `${WAIT_CI} pr <N>` }], pass: ["gh run watch 1 --repo acme/site"] },
  "Bash(gh pr checks *)": { deny: [{ call: "gh pr checks --watch", use: `${WAIT_CI} pr <N>` }], pass: ["gh pr checks 7 --required"] },
};

describe("Каждое правило списка обходов — со своим запретом и пропуском", () => {
  invariant<Bypass>(it, {
    registry: "обходы команд флоу (bypasses.ts)",
    items: BYPASSES,
    name: (b) => `${b.rule}: обход хук запрещает с командой флоу, соседний вызов пропускает`,
    key: (b) => b.rule,
    check: (b) => {
      const cases = CASES[b.rule];
      if (!cases?.deny.length || !cases.pass.length) throw new Error(`${b.rule}: нет случаев запрета и пропуска в CASES`);
      for (const { call, use } of cases.deny) expect({ call, reason: reasonOf(call) }).toEqual({ call, reason: expect.stringContaining(`Run instead: ${use}`) });
      for (const call of cases.pass) expect({ call, reason: reasonOf(call) }).toEqual({ call, reason: null });
    },
    violator: { name: "правило без случаев в таблице", item: { rule: "Bash(gh issue close *)", use: "{github} task drop {n}", reason: "—" } },
  });
});
