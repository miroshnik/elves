import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { recommend, record, summarize, type RunRecord } from "../../../skills/slot/scripts/slot.ts";
import { exitOf, NO_LOAD_WAIT, SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { tmpDir } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

const SLOT = fileURLToPath(new URL("../../../skills/slot/scripts/slot.ts", import.meta.url));
/** Ждать события дольше этого — ошибка с объяснением, а не таймаут теста без него. */
const PATIENCE = 30_000;

let dir: string;
let cleanup: () => void;
let config: string;
/** Журнал прогонов очереди теста: билет ложится в каталог личной конфигурации — журнал рядом. */
let log: string;

beforeEach(() => {
  ({ dir, cleanup } = tmpDir());
  config = path.join(dir, "config");
  mkdirSync(config);
  // два слота — как у машины до 24 ядер: тест не зависит от ядер машины, на которой идёт
  writeFileSync(path.join(config, "machine.json"), JSON.stringify({ slots: 2 }));
  log = path.join(config, "runs.jsonl");
});
afterEach(() => cleanup());

/** Окружение slot: своя очередь в каталоге теста; прогон самого теста — не в слоте и не в CI. */
function envOf() {
  const env: Record<string, string | undefined> = { ...process.env, ELVES_CONFIG_DIR: config, TMPDIR: path.join(dir, "tmp"), ...NO_LOAD_WAIT };
  for (const k of ["CI", "ELVES_SLOT", "ELVES_SLOT_CPUS", "CLAUDE_TMPDIR"]) delete env[k];
  return env;
}
const run = (args: string[]) => spawnSync("bun", ["--no-env-file", SLOT, ...args], { cwd: dir, env: envOf(), encoding: "utf8", timeout: PATIENCE });
const runs = (): RunRecord[] => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

/** Ждёт, пока в журнале станет n записей. */
async function logged(n: number) {
  for (const t0 = Date.now(); runs().length < n; await Bun.sleep(20)) if (Date.now() - t0 > PATIENCE) throw new Error(`в журнале ${runs().length} записей, а не ${n}`);
  return runs();
}

/** Запись журнала теста: прогон без соседей, секунда, без ожидания. */
const rec = (over: Partial<RunRecord>): RunRecord => ({
  at: Date.parse("2026-10-28T10:00:00Z"),
  wait: 0,
  ms: 1000,
  neighbors: 0,
  queued: 0,
  slots: 2,
  cores: 16,
  load: [1, 1],
  mem: 0.5,
  cmd: "bun test",
  cwd: "/p",
  code: 0,
  ...over,
});

describe("Журнал прогонов — ожидание, длительность и нагрузка каждого прогона очереди", () => {
  it("slot пишет в журнал ожидание, длительность и нагрузку прогона", async () => {
    const alone = run(["sleep 0.2"]);
    expect(exitOf(alone)).toBe(0);
    const first = runs()[0]!;
    expect(first).toMatchObject({ neighbors: 0, queued: 0, slots: 2, cores: os.availableParallelism(), cmd: "sleep 0.2", cwd: realpathSync(dir), code: 0 });
    expect(first.wait).toBeGreaterThanOrEqual(0);
    expect(first.ms).toBeGreaterThanOrEqual(200);
    expect(first.load).toHaveLength(2);
    expect(first.mem).toBeWithin(0, 1.01);

    // сосед в слоте — в записи его видно
    const holder = spawn("bun", ["--no-env-file", SLOT, "touch started; while [ ! -f release ]; do sleep 0.02; done"], { cwd: dir, env: envOf() });
    try {
      for (const t0 = Date.now(); !existsSync(path.join(dir, "started")); await Bun.sleep(10)) if (Date.now() - t0 > PATIENCE) throw new Error("сосед не стартовал");
      expect(exitOf(run(["exit 3"]))).toBe(3);
      expect(runs()[1]).toMatchObject({ neighbors: 1, cmd: "exit 3", code: 3 });
    } finally {
      writeFileSync(path.join(dir, "release"), "");
      await new Promise((r) => holder.on("exit", r));
    }
    await logged(3);

    // скрипт package.json: команду идёт shell скрипта — конец прогона пишется, когда shell вышел
    const script = spawnSync("sh", ["-c", `eval "$(bun --no-env-file '${SLOT}' --for $$)" && sleep 0.3`], { cwd: dir, env: { ...envOf(), npm_lifecycle_script: "sleep 0.3" }, encoding: "utf8", timeout: PATIENCE });
    expect(exitOf(script)).toBe(0);
    const shell = (await logged(4))[3]!;
    expect(shell).toMatchObject({ cmd: "sleep 0.3", neighbors: 0 });
    expect(shell.ms).toBeGreaterThanOrEqual(300);
    expect(shell.code).toBeUndefined();
  });

  it("журнал ограничен по размеру — остаются последние прогоны", () => {
    const file = path.join(dir, "runs.jsonl");
    for (let i = 0; i < 100; i++) record(file, rec({ at: i }), 4000);
    const kept = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as RunRecord);
    expect(statSync(file).size).toBeLessThanOrEqual(4000);
    expect(kept.length).toBeGreaterThan(5);
    expect(kept.at(-1)!.at).toBe(99);
    expect(kept.map((r) => r.at)).toEqual(kept.map((_, i) => 100 - kept.length + i));
  });

  it("сводка журнала показывает ожидание и длительность по числу соседей", () => {
    expect(run(["--log"]).stdout).toBe("slot: the run log is empty — no runs through the queue yet\n");
    const lines = [
      ...Array.from({ length: 9 }, () => rec({})),
      rec({ ms: 4000 }),
      ...Array.from({ length: 4 }, () => rec({ neighbors: 1, wait: 5000, ms: 3000, load: [12, 14] })),
      rec({ neighbors: 1, wait: 90_000, ms: 3000, load: [20, 20], at: Date.parse("2026-10-29T10:00:00Z") }),
    ];
    writeFileSync(log, `${lines.map((l) => JSON.stringify(l)).join("\n")}\nnot json\n`);
    const r = run(["--log"]);
    expect(exitOf(r)).toBe(0);
    expect(r.stdout).toBe(summarize(lines));
    expect(r.stdout).toBe(
      [
        "slot: 15 runs 2026-10-28 — 2026-10-29; now 2 slots, 16 cores",
        "",
        "neighbors  runs  wait p50    wait p90  run p50  run p90",
        "0            10     0.0 s       0.0 s    1.0 s    1.0 s",
        "1             5     5.0 s  1 min 30 s    3.0 s    3.0 s",
        "",
        "load/core  runs    wait p50    wait p90  run p50  run p90",
        "< 0.25       10       0.0 s       0.0 s    1.0 s    1.0 s",
        "0.75–1        4       5.0 s       5.0 s    3.0 s    3.0 s",
        "≥ 1           1  1 min 30 s  1 min 30 s    3.0 s    3.0 s",
        "",
      ].join("\n"),
    );
  });
});

describe("Замер мощности — одна команда по 1…N копий разом", () => {
  it("замер гоняет команду по 1…N копий разом и называет слоты для machine.json", () => {
    expect(recommend([10, 12, 14, 20])).toBe(3);
    expect(recommend([10, 16, 12])).toBe(1);
    expect(recommend([10])).toBe(1);

    const r = run(["--measure", 'echo "$ELVES_SLOT_CPUS" >> cpus; sleep 0.1', "2"]);
    expect(exitOf(r)).toBe(0);
    expect(r.stdout).toMatch(/^1 at once: \d+\.\d s per run, \d+ cores each, load [\d.]+ → [\d.]+\n2 at once: .*\nslots: [12] — .* machine\.json: \{"slots": [12]\}\n$/);
    const half = Math.max(1, Math.floor(os.availableParallelism() / 2));
    expect(readFileSync(path.join(dir, "cpus"), "utf8")).toBe([half, Math.max(1, Math.floor(half / 2)), Math.max(1, Math.floor(half / 2))].map((c) => `${c}\n`).join(""));

    const failed = run(["--measure", "echo boom >&2; exit 3", "2"]);
    expect(exitOf(failed)).toBe(1);
    expect(failed.stderr).toContain("slot: a copy failed with code 3 — nothing to measure:\nboom");
    expect(exitOf(run(["--measure", "true", "0"]))).toBe(2);
  });
});
