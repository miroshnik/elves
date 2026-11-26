import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, setDefaultTimeout } from "bun:test";

import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { tmpDir, writeTree } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const scripts = (JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
const bunfig = readFileSync(path.join(ROOT, "bunfig.toml"), "utf8");
const preloads = (Bun.TOML.parse(bunfig) as { test?: { preload?: string[] } }).test?.preload ?? [];

/** Тест проекта-образца: пишет в журнал $PROBE_LOG, что видит его дочерний процесс в JEST_WORKER_ID (`-` — ничего). */
const PROBE = `import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { it } from "bun:test";
it("проба", () => {
  const child = spawnSync(process.execPath, ["-e", "console.log(process.env.JEST_WORKER_ID ?? '-')"], { encoding: "utf8" });
  appendFileSync(process.env.PROBE_LOG!, child.stdout.trim() + "\\n");
});
`;

/**
 * Проект-образец со скриптами `package.json` и `bunfig.toml` Elves — preload и скилы клона — и пробой на каждом уровне:
 * быстром (два файла), медленном и в стандартах. → вывод команды и журнал проб.
 */
function sample(cmd: string[], env: Record<string, string | undefined> = {}): { out: string; log: string[] } {
  const { dir, cleanup } = tmpDir();
  try {
    writeTree(dir, {
      "package.json": JSON.stringify({ private: true, scripts }),
      "bunfig.toml": bunfig,
      "tests/capabilities/x/x.test.ts": PROBE,
      "tests/capabilities/x/y.test.ts": PROBE,
      "tests/capabilities/x/x.slow.test.ts": PROBE,
      "tests/standards/s/s.test.ts": PROBE,
      "probe.log": "",
    });
    symlinkSync(path.join(ROOT, "skills"), path.join(dir, "skills"));
    for (const p of preloads) {
      mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      symlinkSync(path.join(ROOT, p), path.join(dir, p));
    }
    const log = path.join(dir, "probe.log");
    // без очереди машины: прогон теста сам в слоте или в CI
    const vars: Record<string, string | undefined> = { ...process.env, ELVES_SLOT: "parallel-workers", PROBE_LOG: log, ...env };
    for (const [k, v] of Object.entries(vars)) if (v === undefined) delete vars[k];
    const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd: dir, encoding: "utf8", env: vars });
    return { out: r.stdout + r.stderr, log: readFileSync(log, "utf8").split("\n").filter(Boolean) };
  } finally {
    cleanup();
  }
}

/** Число воркеров по шапке `bun test`: «bun test v1.4.5 (…) 3x PARALLEL»; без --parallel — null. */
const workers = (out: string) => out.match(/^bun test v\S+.*?\b(\d+)x PARALLEL\b/m)?.[1] ?? null;

describe("Тесты Elves идут в воркерах bun test --parallel: число воркеров — из ELVES_SLOT_CPUS, дочерний процесс прогона не видит JEST_WORKER_ID", () => {
  /** Без переменной — голый `--parallel`: bun берёт по ядрам, в CI — по ядрам раннера. */
  it("скрипты test, test:slow, test:spec и spec:doc запускают bun test --parallel с числом воркеров из ELVES_SLOT_CPUS, без него — по ядрам", () => {
    const levels = ["test", "test:slow", "test:spec", "spec:doc"];
    const got = (env: Record<string, string | undefined>) => Object.fromEntries(levels.map((s) => [s, workers(sample(["bun", "run", s], env).out)]));
    expect(got({ ELVES_SLOT_CPUS: "3" })).toEqual(Object.fromEntries(levels.map((s) => [s, "3"])));
    expect(got({ ELVES_SLOT_CPUS: undefined })).toEqual(Object.fromEntries(levels.map((s) => [s, String(navigator.hardwareConcurrency)])));
  });

  /** Воркер ставит JEST_WORKER_ID, и дочерний `playwright test` принимает прогон за Jest и не идёт. */
  it("дочерний процесс прогона под --parallel не видит JEST_WORKER_ID: его убирает preload из bunfig.toml", () => {
    const { out, log } = sample(["bun", "test", "--parallel=2", "tests/capabilities/x/x.test.ts", "tests/capabilities/x/y.test.ts"]);
    expect(workers(out)).toBe("2");
    expect(log).toEqual(["-", "-"]);
  });
});
