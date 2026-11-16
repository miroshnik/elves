import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { REPO, sandbox, type Sandbox } from "../../lib/elves.ts";
import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

/** Строка отказа — одна у всех скриптов флоу. */
const REFUSAL = "the flow doesn't support Claude Code cloud sessions (CLAUDE_CODE_REMOTE=true) — run it in a local session\n";

/** Скрипты флоу с командой, которая без отказа пошла бы в git, gh и транскрипты сессий. */
const SCRIPTS = [
  { file: "bin/elves.ts", args: ["check"] },
  { file: "skills/github/scripts/github.ts", args: ["task", "show", "1"] },
  { file: "skills/est/scripts/est.ts", args: ["fact", "1"] },
];

/** Скрипт процессом, как его зовёт агент, в песочнице: HOME и проект — временные, gh в PATH нет. */
function run(file: string, args: string[], remote: string) {
  const r = spawnSync(process.execPath, ["--no-env-file", path.join(REPO, file), ...args], { cwd: sb.proj, env: { ...sb.env, CLAUDE_CODE_REMOTE: remote }, encoding: "utf8" });
  return { file, code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("Облачная сессия Claude Code — вне флоу: скрипт флоу отказывает, а не работает вполсилы", () => {
  it("Скрипт флоу в облачной сессии отказывает одной строкой с кодом 2", () => {
    expect(SCRIPTS.map(({ file, args }) => run(file, args, "true"))).toEqual(SCRIPTS.map(({ file }) => ({ file, code: 2, stdout: "", stderr: REFUSAL })));
    // сторож от перекоррекции: облако — ровно `true`, иначе скрипт работает как обычно
    expect(run("bin/elves.ts", ["check"], "false")).toEqual({ file: "bin/elves.ts", code: 0, stdout: "Elves in the project: not installed\n", stderr: "" });
  });
});
