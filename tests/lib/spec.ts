/**
 * Хелперы для тестов скилла spec: запуск скриптов через bun, временные каталоги, git-репозитории.
 * Не спека — в документацию не попадает.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SCRIPTS = fileURLToPath(new URL("../../skills/spec/scripts/", import.meta.url));

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Запустить spec-doc / spec-diff как пользователь: `bun <скрипт>.ts …`;
 * `env` — поверх окружения прогона (заглушка `gh` в PATH).
 */
export function runScript(
  name: "spec-doc" | "spec-diff" | "spec-publish" | "spec-run" | "spec-shard" | "spec-claims" | "spec-break" | "spec-red" | "precommit",
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Run {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, name + ".ts"), ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  if (r.error) throw r.error;
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

// `gh` для spec-run — внешний край, подменяется он. Три вызова `gh api` (REST GitHub Actions): артефакты репозитория с
// фильтром по имени — из artifacts.json; попытка прогона — из attempts.json, `{ "id/k": ответ }`, нет ключа — ошибка,
// как 404; прогон по id — из runs.json, `{ id: [ответ на каждый опрос…] }`, последний повторяется. Вызовы — в calls.
const FAKE_GH = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH/calls"
[ "$1" = api ] || { echo "fake gh: $*" >&2; exit 1; }
case "$2" in
  "repos/{owner}/{repo}/actions/artifacts?name="*)
    name="\${2#*name=}"
    jq -c --arg name "\${name%%&*}" '[.[] | select(.name == $name)] | { total_count: length, artifacts: . }' "$FAKE_GH/artifacts.json" ;;
  "repos/{owner}/{repo}/actions/runs/"*"/attempts/"*)
    run="\${2#*/runs/}"
    jq -ce --arg key "\${run%%/*}/\${2##*/}" '.[$key]' "$FAKE_GH/attempts.json" ;;
  "repos/{owner}/{repo}/actions/runs/"*)
    id="\${2##*/}"; n=$(cat "$FAKE_GH/n-$id" 2>/dev/null || echo 0); echo $((n + 1)) > "$FAKE_GH/n-$id"
    jq -ce --arg id "$id" --argjson n "$n" '.[$id] | (.[$n] // .[-1])' "$FAKE_GH/runs.json" ;;
  *) echo "fake gh: $*" >&2; exit 1 ;;
esac
`;

/** Артефакт в ответе `gh api …/actions/artifacts`: у прогона PR из форка head_repository_id — id форка. */
export interface GhArtifact {
  id: number;
  name: string;
  expired: boolean;
  /** когда выложен: ISO, как пишет GitHub */
  created_at?: string;
  workflow_run: { id: number; repository_id: number; head_repository_id: number };
}

/** Прогон в ответе `gh api …/actions/runs/<id>` (его последняя попытка) или попытка `…/runs/<id>/attempts/<k>`. */
export interface GhRun {
  id: number;
  status: string;
  conclusion: string | null;
  html_url: string;
  run_attempt?: number;
  run_started_at?: string;
  updated_at?: string;
}

export const ghRun = (id: number, status: string, conclusion: string | null = null, more: Partial<GhRun> = {}): GhRun => ({
  id,
  status,
  conclusion,
  html_url: `https://github.test/runs/${id}`,
  ...more,
});

/** Заглушка `gh` в каталоге `bin` с ответами `github`: окружение запуска скрипта и вызовы `gh` после него. */
export function fakeGh(bin: string, github: { artifacts: GhArtifact[]; runs?: Record<number, GhRun[]>; attempts?: Record<string, GhRun> }) {
  rmSync(bin, { recursive: true, force: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "gh"), FAKE_GH);
  chmodSync(path.join(bin, "gh"), 0o755);
  writeFileSync(path.join(bin, "artifacts.json"), JSON.stringify(github.artifacts));
  writeFileSync(path.join(bin, "runs.json"), JSON.stringify(github.runs ?? {}));
  writeFileSync(path.join(bin, "attempts.json"), JSON.stringify(github.attempts ?? {}));
  const log = path.join(bin, "calls");
  return {
    env: { PATH: `${bin}:${process.env.PATH}`, FAKE_GH: bin },
    calls: (): string[] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []),
  };
}

/** Временный каталог; убирается в afterEach через возвращённый cleanup. */
export function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "spec-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Файлы репозитория `root` по путям `paths` — пути от корня, по порядку, — те, что попадают в коммит: отслеживаемые
 * git и новые, кроме игнорируемых git. Обход каталога читал бы и сгенерированное: страницы `docs/spec` после
 * локального `spec:doc`, которых в CI ещё нет (#579). Отслеживаемый файл, удалённый из рабочей копии, — уже не файл.
 */
export function committedFiles(root: string, paths: string[]): string[] {
  const r = spawnSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...paths], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ls-files в ${root} — ${String(r.stderr).trim() || r.error}`);
  return [...new Set(r.stdout.split("\0").filter(Boolean))].filter((f) => existsSync(path.join(root, f))).sort();
}

export function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

/**
 * Язык временного проекта — `.agents/elves.json` с полем `language`, как его ставит установка: скрипты spec пишут
 * на нём. Без манифеста проект — `en`.
 */
export function setLanguage(dir: string, language: string): void {
  writeTree(dir, { ".agents/elves.json": JSON.stringify({ language }) + "\n" });
}

/** Git-репозиторий во временном каталоге (init: false — уже готовый); commit пишет файлы (null — удалить) и возвращает SHA. */
export function gitRepo(dir: string, { init = true } = {}) {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  if (init) git("init", "-q", "-b", "main");
  return {
    git,
    commit(files: Record<string, string | null>, message = "step"): string {
      for (const [rel, content] of Object.entries(files)) {
        if (content === null) rmSync(path.join(dir, rel), { force: true });
        else writeTree(dir, { [rel]: content });
      }
      git("add", "-A");
      // автор и подпись — флагами, а не тремя git config: меньше сабпроцессов на тест
      git("-c", "user.email=spec@example.test", "-c", "user.name=spec", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", message);
      return git("rev-parse", "HEAD");
    },
  };
}

/**
 * `origin` тестового чекаута — локальный bare-репозиторий `…/<owner>/<repo>.git`; для скрипта он — `owner/repo` на
 * GitHub (стандарт origin-repo): `git remote get-url origin` отвечает `git@github.com:<owner>/<repo>.git`, остальной
 * git — настоящий. `insteadOf` не подходит: `get-url` его раскрывает.
 */
export function githubOrigin<R extends { status: number | null; stdout: string }>(run: (cmd: string, args: string[], cwd?: string, env?: Record<string, string>) => R) {
  return (cmd: string, args: string[], cwd?: string, env?: Record<string, string>): R => {
    const r = env ? run(cmd, args, cwd, env) : run(cmd, args, cwd);
    if (cmd !== "git" || args.join(" ") !== "remote get-url origin" || r.status !== 0) return r;
    const m = /([^/\s]+)\/([^/\s]+)\.git\s*$/.exec(r.stdout);
    return m ? { ...r, stdout: `git@github.com:${m[1]}/${m[2]}.git\n` } : r;
  };
}

const xmlAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * JUnit `bun test --reporter=junit` из краткого описания: файл → [describes…, имя, статус?]. Как у bun: файл — testsuite
 * верхнего уровня, describe — вложенный testsuite с атрибутом file, тест — testcase с file и line; упавший — `<failure>`,
 * пропущенный — `<skipped/>`, todo — `<skipped message="TODO"/>`. Путь файла — от `root`: отчёт другой машины тоже.
 */
export function junitReport(root: string, files: Record<string, [string[], string, string?][]>): string {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<testsuites name="bun test">'];
  for (const [rel, tests] of Object.entries(files)) {
    const file = xmlAttr(path.join(root, rel));
    out.push(`  <testsuite name="${file}" file="${file}" tests="${tests.length}" time="0">`);
    let open: string[] = [];
    tests.forEach(([describes, name, status], i) => {
      let same = 0;
      while (same < open.length && same < describes.length && open[same] === describes[same]) same++;
      for (; open.length > same; open.pop()) out.push(`${"  ".repeat(open.length + 1)}</testsuite>`);
      for (const d of describes.slice(same)) {
        open.push(d);
        out.push(`${"  ".repeat(open.length + 1)}<testsuite name="${xmlAttr(d)}" file="${file}" line="1" time="0">`);
      }
      const pad = "  ".repeat(open.length + 2);
      const attrs = `name="${xmlAttr(name)}" time="0" file="${file}" line="${i + 2}"`;
      const body = status === "failed" ? '<failure type="AssertionError" />' : status === "skipped" ? "<skipped />" : status === "todo" ? '<skipped message="TODO" />' : "";
      out.push(body ? `${pad}<testcase ${attrs}>${body}</testcase>` : `${pad}<testcase ${attrs} />`);
    });
    for (; open.length; open.pop()) out.push(`${"  ".repeat(open.length + 1)}</testsuite>`);
    out.push("  </testsuite>");
  }
  out.push("</testsuites>", "");
  return out.join("\n");
}
