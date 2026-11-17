import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, setDefaultTimeout } from "bun:test";

import { codeOnly, invariant } from "../../../skills/spec/scripts/harness.ts";
import { clis } from "../../lib/cli.ts";
import type { Cli } from "../../lib/cli.ts";
import { elvesPackage } from "../../lib/elves.ts";
import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { tmpDir } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Отказ gh в песочнице Claude Code — как его печатает gh на macOS: проверка сертификата закрыта песочницей. */
const SANDBOX_TLS = 'Post "https://api.github.com/graphql": tls: failed to verify certificate: x509: OSStatus -26276';
/** Строка отказа скрипта до команды: одна на флоу (skills/github/scripts/command.ts, копия — wait-ci.sh). */
const REFUSAL = "gh doesn't work in the Claude Code sandbox (x509: OSStatus -26276) — run the whole command outside it, a separate call with dangerouslyDisableSandbox: ";

/**
 * Как скрипт доходит до gh: аргументы вызова, код отказа скрипта и, у установщика, — клон Elves, из которого он
 * выпускает релиз (`release` — только из клона). Скрипт на gh без строки — красный: проба или outside с причиной.
 */
const PROBES: Record<string, { args: string[]; code: number; clone?: true }> = {
  github: { args: ["task", "show", "1", "--repo", "octo/repo"], code: 2 },
  est: { args: ["fact", "1", "--repo", "octo/repo"], code: 2 },
  "spec-run": { args: ["--artifact", "spec-reports"], code: 2 },
  "wait-ci": { args: ["pr", "1", "--repo", "octo/repo", "--interval", "1", "--timeout", "60"], code: 3 },
  elves: { args: ["release"], code: 2, clone: true },
};

/** Скрипт и что печатает gh на отказе: у реестра — TLS песочницы, у нарушителя — другой отказ. */
interface Item {
  cli: Cli;
  stderr: string;
}

// вызов gh процессом: spawnSync("gh", …), execFileSync("gh", …), run(["gh", …]); в bash — $(gh …) и строка с gh
const TS_GH = /\b(?:spawnSync|execFileSync|execSync|spawn)\(\s*["']gh["']|\[\s*["']gh["']\s*,/;
const SH_GH = /\$\(gh\s|^\s*gh\s/m;
const callsGh = (cli: Cli) => {
  const text = readFileSync(path.join(ROOT, cli.file), "utf8");
  return cli.file.endsWith(".sh") ? SH_GH.test(text.replace(/^\s*#.*$/gm, "")) : TS_GH.test(codeOnly(text, cli.file));
};
const SCRIPTS = clis().filter(callsGh);

/** Команда строки отказа так, как её разберёт shell: кавычки проверяет сам shell. */
const words = (command: string) => execFileSync("sh", ["-c", `printf '%s\\0' ${command}`], { encoding: "utf8" }).split("\0").slice(0, -1);

/**
 * Скрипт с gh песочницы в PATH: строка о gh в выводе одна — отказ с командой этого же вызова, код — код отказа скрипта.
 * Установщик — из своего клона Elves (origin — пакет с одним коммитом, релизов нет: первый релиз доходит до
 * `gh release create`).
 */
function check(item: Item): void {
  const probe = PROBES[item.cli.name];
  if (!probe) throw new Error(`${item.cli.file} зовёт gh, а пробы нет — строка в PROBES (аргументы до первого вызова gh и код отказа) или outside с причиной (tests/standards/scripts/gh-sandbox)`);
  const { dir, cleanup } = tmpDir();
  try {
    const bin = path.join(dir, "bin");
    const [cwd, home, cfg] = ["cwd", "home", "cfg"].map((d) => path.join(dir, d)) as [string, string, string];
    for (const d of [bin, cwd, home, cfg]) mkdirSync(d);
    writeFileSync(path.join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' '${item.stderr.replaceAll("'", `'\\''`)}' >&2\nexit 1\n`, { mode: 0o755 });
    let script = path.join(ROOT, item.cli.file);
    if (probe.clone) {
      const up = elvesPackage(path.join(dir, "upstream"));
      execFileSync("git", ["clone", "-q", up.dir, path.join(dir, "clone")]);
      script = path.join(dir, "clone", "bin/elves.ts");
    }
    const [cmd, ...pre] = item.cli.run.slice(0, -1) as [string, ...string[]];
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, ELVES_CONFIG_DIR: cfg, CLAUDE_CODE_REMOTE: "", GH_REPO: "" };
    const r = spawnSync(cmd, [...pre, script, ...probe.args], { cwd, env, encoding: "utf8", timeout: 60_000 });
    // gh упал — строка о нём одна: отказ с командой, а не ошибка gh
    const failed = `${r.stdout}\n${r.stderr}`.split("\n").filter((l) => l.includes("x509") || l.includes("gh doesn't work"));
    expect(failed).toHaveLength(1);
    const [line] = failed as [string];
    expect(line).toContain(REFUSAL);
    const sh = item.cli.file.endsWith(".sh");
    const [runner, ...rest] = words(line.slice(line.indexOf(REFUSAL) + REFUSAL.length));
    expect(runner).toBe(sh ? "bash" : "bun");
    const flags = sh ? [] : ["--no-env-file"];
    expect(rest.slice(0, flags.length)).toEqual(flags);
    expect(realpathSync(rest[flags.length]!)).toBe(realpathSync(script));
    expect(rest.slice(flags.length + 1)).toEqual(probe.args);
    expect(r.status).toBe(probe.code);
  } finally {
    cleanup();
  }
}

describe("Скрипт флоу на отказе gh по TLS в песочнице печатает команду для запуска вне песочницы", () => {
  const github = SCRIPTS.find((c) => c.name === "github")!;
  invariant(it, {
    registry: "скрипты флоу, которые зовут gh",
    items: SCRIPTS.map((cli): Item => ({ cli, stderr: SANDBOX_TLS })),
    key: (i) => i.cli.name,
    name: (i) => `\`${i.cli.name}\` на отказе gh по TLS в песочнице печатает одну строку — команду целиком для запуска вне песочницы`,
    check,
    violator: { name: "скрипт печатает ошибку gh, а не команду: gh отказал не по TLS песочницы", item: { cli: github, stderr: "HTTP 401: Bad credentials (https://api.github.com/graphql)" } },
    outside: [{ item: "task-env", reason: "сначала Docker: в песочнице task-env останавливается на нём своей строкой — запуск вне песочницы (SKILL.md task-env, «Docker and the sandbox»), до gh не доходит" }],
    includes: ["github", "est", "spec-run", "wait-ci", "elves"],
  });
});
