import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { loadLimit } from "../../../skills/slot/scripts/slot.ts";
import { exitOf, SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { tmpDir } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

const SLOT = fileURLToPath(new URL("../../../skills/slot/scripts/slot.ts", import.meta.url));
/** Ждать события дольше этого — ошибка с объяснением, а не таймаут теста без него. */
const PATIENCE = 30_000;
/** Предел нагрузки, которого машина достигла всегда: средняя нагрузка не бывает меньше нуля. */
const OVERLOADED = 0;
/** Предел нагрузки, которого машина не достигает. */
const IDLE = 1_000_000;

let dir: string;
let cleanup: () => void;
let config: string;
let running: ChildProcess[];

beforeEach(() => {
  ({ dir, cleanup } = tmpDir());
  config = path.join(dir, "config");
  mkdirSync(config);
  running = [];
});
afterEach(() => {
  for (const p of running) if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
  cleanup();
});

/** Конфиг машины теста: два слота и предел нагрузки. */
const machine = (load: number, loadWait: number) => writeFileSync(path.join(config, "machine.json"), JSON.stringify({ slots: 2, load, loadWait }));

/** Окружение slot: своя очередь и конфиг машины в каталоге теста; предел нагрузки — из него, а не из окружения прогона. */
function envOf() {
  const env: Record<string, string | undefined> = { ...process.env, ELVES_CONFIG_DIR: config, TMPDIR: path.join(dir, "tmp") };
  for (const k of ["CI", "ELVES_SLOT", "ELVES_SLOT_CPUS", "ELVES_SLOT_LOAD", "CLAUDE_TMPDIR", "npm_lifecycle_script", "npm_lifecycle_event"]) delete env[k];
  return env;
}

/** `slot` фоном: stdout и stderr копятся, `closed` — процесс вышел и его потоки закрыты, их не держит никто из потомков. */
function start(args: string[]) {
  const proc = spawn("bun", ["--no-env-file", SLOT, ...args], { cwd: dir, env: envOf() });
  running.push(proc);
  let out = "";
  let err = "";
  let closed = false;
  proc.stdout.on("data", (d) => (out += d));
  proc.stderr.on("data", (d) => (err += d));
  proc.on("close", () => (closed = true));
  const done = new Promise<number | null>((r) => proc.on("exit", (code) => r(code)));
  return { out: () => out, err: () => err, closed: () => closed, done };
}

async function until(cond: () => boolean, what: string) {
  for (const t0 = Date.now(); !cond(); await Bun.sleep(10)) if (Date.now() - t0 > PATIENCE) throw new Error(`не дождался: ${what}`);
}

describe("Прогон во главе очереди ждёт нагрузку машины, но не дольше предела ожидания", () => {
  it("slot не стартует прогон, пока нагрузка машины выше предела, и печатает, что ждёт нагрузку", async () => {
    machine(OVERLOADED, 600);
    const r = start(["touch started"]);
    await until(() => r.err().includes("slot: waiting for the machine load — load "), `ждёт нагрузку; stderr: ${r.err()}`);
    expect(r.err()).toMatch(/ on \d+ cores, the limit 0 \(0 per core\); the run goes when it drops, at most in 10 min 0 s\n/);
    await Bun.sleep(500);
    expect(existsSync(path.join(dir, "started"))).toBe(false);
    // нагрузка ниже предела — владелец поднял предел, пока прогон ждёт: прогон идёт
    machine(IDLE, 600);
    expect(await r.done).toBe(0);
    expect(existsSync(path.join(dir, "started"))).toBe(true);
    expect(r.err()).not.toContain("overloaded");
  });

  it("прогон, пущенный после предела ожидания нагрузки, печатает нагрузку машины в начале и в конце", () => {
    machine(OVERLOADED, 1);
    const r = spawnSync("bun", ["--no-env-file", SLOT, "echo ran >&2"], { cwd: dir, env: envOf(), encoding: "utf8", timeout: PATIENCE });
    expect(exitOf(r)).toBe(0);
    const lines = r.stderr.split("\n");
    const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
    const begin = at(/^slot: the machine is overloaded — load [\d.]+ on \d+ cores, the limit 0 \(0 per core\); the run goes after 1 s of waiting for the load: its timeouts are the machine's load, not a defect/);
    const end = at(/^slot: the machine's load at the end of the run — load [\d.]+ on \d+ cores/);
    expect({ wait: at(/^slot: waiting for the machine load/) >= 0, begin, ran: at(/^ran$/), end }).toEqual({ wait: true, begin: lines.indexOf("ran") - 1, ran: lines.indexOf("ran"), end: lines.indexOf("ran") + 1 });
  });

  it("скрипт package.json, пущенный после предела ожидания, получает строку конца, когда его shell вышел", async () => {
    machine(OVERLOADED, 0);
    const shell = spawn("sleep", ["60"]);
    running.push(shell);
    const r = start(["--for", String(shell.pid)]);
    expect(await r.done).toBe(0);
    expect(r.out()).toMatch(/^export ELVES_SLOT=\d+-\d+ ELVES_SLOT_CPUS=\d+\n$/);
    expect(r.err()).toContain("slot: the machine is overloaded — ");
    // slot вышел, shell скрипта ещё идёт: конца прогона нет
    await Bun.sleep(600);
    expect(r.err()).not.toContain("at the end of the run");
    shell.kill("SIGKILL");
    await until(r.closed, "строка конца после выхода shell");
    expect(r.err()).toMatch(/slot: the machine's load at the end of the run — load [\d.]+ on \d+ cores/);
  });

  it("неверный предел — предупреждение и умолчание, ELVES_SLOT_LOAD заменяет предел машины", () => {
    expect(loadLimit()).toEqual({ perCore: 1, wait: 300_000, warnings: [] });
    expect(loadLimit({ load: 2, loadWait: 60 }, { ELVES_SLOT_LOAD: "0.5" })).toEqual({ perCore: 0.5, wait: 60_000, warnings: [] });
    expect(loadLimit({ load: -1, loadWait: 1.5 }, { ELVES_SLOT_LOAD: "many" })).toEqual({
      perCore: 1,
      wait: 300_000,
      warnings: [
        'ELVES_SLOT_LOAD must be a non-negative number, got "many" — the default goes',
        "machine.json: load must be a non-negative number, got -1 — the default goes",
        "machine.json: loadWait must be a non-negative integer, got 1.5 — the default goes",
      ],
    });
  });
});
