import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { capacity } from "../../../skills/slot/scripts/slot.ts";
import { elves, sandbox } from "../../lib/elves.ts";
import { exitOf, SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { tmpDir } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

const SLOT = fileURLToPath(new URL("../../../skills/slot/scripts/slot.ts", import.meta.url));
const GB = 2 ** 30;
/** Ждать события дольше этого — ошибка с объяснением, а не таймаут теста без него. */
const PATIENCE = 30_000;

let dir: string;
let cleanup: () => void;
let config: string;

beforeEach(() => {
  ({ dir, cleanup } = tmpDir());
  config = path.join(dir, "config");
  mkdirSync(config);
});
afterEach(() => cleanup());

/** Конфиг машины теста: `machine.json` в каталоге личной конфигурации. */
const machine = (value: unknown) => writeFileSync(path.join(config, "machine.json"), JSON.stringify(value));

/** Окружение slot: своя очередь и свой конфиг машины в каталоге теста; прогон самого теста — не в слоте и не в CI. */
function envOf() {
  const env: Record<string, string | undefined> = { ...process.env, ELVES_CONFIG_DIR: config, TMPDIR: path.join(dir, "tmp") };
  for (const k of ["CI", "ELVES_SLOT", "ELVES_SLOT_CPUS", "CLAUDE_TMPDIR"]) delete env[k];
  return env;
}
const run = (args: string[]) => spawnSync("bun", [SLOT, ...args], { cwd: dir, env: envOf(), encoding: "utf8", timeout: PATIENCE });

describe("Мощность машины — из конфига машины, иначе по ядрам и памяти", () => {
  it("без конфига машины слотов — по ядрам: не меньше двух, на 32 ядрах четыре", () => {
    expect([4, 8, 16, 24, 32, 64].map((cores) => capacity(cores, 64 * GB).slots)).toEqual([2, 2, 2, 3, 4, 8]);
    expect(capacity(32, 64 * GB).cpus).toBe(4);
    expect(capacity(16, 64 * GB).from.slots).toBe("16 cores");
  });

  it("число слотов из конфига машины заменяет умолчание, а все слоты вместе берут половину ядер", async () => {
    expect(capacity(16, 48 * GB, { slots: 4 })).toMatchObject({ slots: 4, cpus: 2, from: { slots: "machine.json" } });
    machine({ slots: 1 });
    const cpus = run(['echo "$ELVES_SLOT_CPUS"']);
    expect(exitOf(cpus)).toBe(0);
    expect(cpus.stdout.trim()).toBe(String(Math.max(1, Math.floor(os.availableParallelism() / 2))));
    // один слот: второй прогон ждёт, пока идёт первый
    const first = spawn("bun", [SLOT, "touch started; while [ ! -f release ]; do sleep 0.02; done"], { cwd: dir, env: envOf() });
    try {
      for (const t0 = Date.now(); !existsSync(path.join(dir, "started")); await Bun.sleep(10)) if (Date.now() - t0 > PATIENCE) throw new Error("первый не стартовал");
      let err = "";
      const second = spawn("bun", [SLOT, "touch second"], { cwd: dir, env: envOf() });
      second.stderr.on("data", (d) => (err += d));
      for (const t0 = Date.now(); !err.includes("slot: waiting for the machine queue"); await Bun.sleep(10)) if (Date.now() - t0 > PATIENCE) throw new Error(`второй не ждал: ${err}`);
      expect(existsSync(path.join(dir, "second"))).toBe(false);
      writeFileSync(path.join(dir, "release"), "");
      expect(await new Promise<number | null>((r) => second.on("exit", (code) => r(code)))).toBe(0);
      expect(existsSync(path.join(dir, "second"))).toBe(true);
    } finally {
      first.kill("SIGKILL");
    }
  });

  it("без конфига машины исполнителей — по ядрам и памяти, меньшее из двух", () => {
    expect(capacity(16, 48 * GB)).toMatchObject({ executors: 4, from: { executors: "16 cores, 48 GB" } });
    expect(capacity(16, 16 * GB).executors).toBe(2);
    expect(capacity(32, 128 * GB).executors).toBe(8);
    expect(capacity(2, 4 * GB).executors).toBe(1);
    expect(capacity(16, 48 * GB, { executors: 6 })).toMatchObject({ executors: 6, from: { executors: "machine.json" } });
  });

  it("неверное значение в конфиге машины — предупреждение и умолчание", () => {
    expect(capacity(16, 48 * GB, { slots: "many", executors: 0 })).toMatchObject({
      slots: 2,
      executors: 4,
      warnings: ['machine.json: slots must be a positive integer, got "many" — the default goes', "machine.json: executors must be a positive integer, got 0 — the default goes"],
    });
    machine({ slots: 2.5 });
    const r = run(['echo "$ELVES_SLOT_CPUS"']);
    expect(exitOf(r)).toBe(0);
    expect(r.stderr).toContain("slot: machine.json: slots must be a positive integer, got 2.5 — the default goes");
    writeFileSync(path.join(config, "machine.json"), "{ slots: 3");
    const broken = run(["--capacity"]);
    expect(exitOf(broken)).toBe(0);
    expect(JSON.parse(broken.stdout).warnings[0]).toStartWith("machine.json: ");
    expect(JSON.parse(broken.stdout).warnings[0]).toEndWith(" — the defaults go");
  });

  it("check -g печатает мощность машины", () => {
    const sb = sandbox();
    try {
      elves(sb, ["install", "-g"]);
      const c = capacity(os.availableParallelism(), os.totalmem());
      const bare = elves(sb, ["check", "-g"]);
      expect(bare.stdout).toContain(`  machine: slots ${c.slots} (${c.from.slots}), executors ${c.executors} (${c.from.executors}) — ~/.config/elves/machine.json replaces them`);
      mkdirSync(path.join(sb.home, ".config/elves"), { recursive: true });
      writeFileSync(path.join(sb.home, ".config/elves/machine.json"), JSON.stringify({ slots: 3, executors: "x" }));
      const set = elves(sb, ["check", "-g"]);
      expect(set.stdout).toContain(`  machine: slots 3 (machine.json), executors ${c.executors} (${c.from.executors})\n`);
      expect(set.stdout).toContain('  machine.json: executors must be a positive integer, got "x" — the default goes');
    } finally {
      sb.cleanup();
    }
  });
});
