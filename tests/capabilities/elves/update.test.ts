import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { BYPASSES } from "../../../skills/github/scripts/bypasses.ts";
import locale from "../../../skills/github/scripts/locale.ts";
import { bareClone, elves, elvesPackage, bunxPackage, bunxServesPackages, copyPackage, npmPackage, pluginHooks, previousHooks, releaseMirror, REPO, runPluginHook, sandbox, snapshot, type ElvesPackage, type Sandbox } from "../../lib/elves.ts";
import { npmRegistry, type Registry } from "../../lib/registry.ts";
import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { gitRepo, tmpDir, writeTree } from "../../lib/spec.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

/** Скиллы Elves. */
const SKILLS = ["ci-wait", "est", "github", "slot", "spec", "task-env"];

// версии пакета Elves в npm: V1 — стоит в проекте, V2 — вышла новее
const V1 = "2026.1015.1";
const V2 = "2026.1016.0";

// пакеты Elves собираются один раз на файл: base — как этот клон, newer — Elves ушёл вперёд; v1 и v2 — пакеты из npm
// версий V1 и V2 (сами релизы, #557), и реестр npm с обеими
let packages: { dir: string; cleanup: () => void };
let base: ElvesPackage;
let newer: ElvesPackage;
let v1: { bin: string };
let v2: { bin: string };
let registry: Registry;
beforeAll(async () => {
  packages = tmpDir();
  base = elvesPackage(path.join(packages.dir, "base"));
  // новое правило в AGENTS.md, новый скилл, скилл ci-wait убран
  newer = elvesPackage(path.join(packages.dir, "newer"), {
    "AGENTS.md": readFileSync(path.join(REPO, "AGENTS.md"), "utf8") + "\nНовое правило.\n",
    "skills/fresh/SKILL.md": "---\nname: fresh\ndescription: новый скилл\n---\n",
    "skills/ci-wait": null,
  });
  v1 = { bin: npmPackage(path.join(packages.dir, "v1"), base.dir, V1, base.sha) };
  v2 = { bin: npmPackage(path.join(packages.dir, "v2"), base.dir, V2, base.sha) };
  registry = await npmRegistry([V1, V2]);
});
afterAll(() => {
  registry.stop();
  packages.cleanup();
});

const read = (p: string) => readFileSync(p, "utf8");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const short = (sha: string) => sha.slice(0, 7);
const manifest = (root: string) => path.join(root, ".agents/elves.json");

// правка .agents/elves.json руками: поля из fields заменяются, undefined — поле убирается
function editManifest(root: string, fields: Record<string, unknown>) {
  writeFileSync(manifest(root), JSON.stringify({ ...JSON.parse(read(manifest(root))), ...fields }, null, 2) + "\n");
}

// установка прошлой версией установщика: в .agents/elves.json нет SHA
const dropSha = (root: string) => editManifest(root, { sha: undefined });

// режим и язык проекта — последними строками check: язык новой установки без флага — en
const MODE_ASK = "  tasks: with permission\n  language: en\n";
const MODE_AUTO = "  tasks: entirely by itself\n  language: en\n";
// первая строка check в клоне Elves: сверять установку не с чем
const ABSENT = "Elves in the project: not installed — an Elves clone, the canon is at its root\n";

// хвост хука: отставший тонкий проект — задача сессии, машину — сама сессия
const PROJECT_BEHIND = "The project's flow is behind — update in the session's task";
const MACHINE_BEHIND = "The machine is behind — update -g";
// строка check: тонкий проект отстал — обновление в задаче сессии
const UPDATE_HERE = "Update in this session's task — @miroshnik/elves in package.json and the lockfile, a few lines: bunx @miroshnik/elves update";

const writePkg = (fields: Record<string, unknown>) => writeFileSync(path.join(sb.proj, "package.json"), JSON.stringify({ name: "x", private: true, ...fields }, null, 2) + "\n");
// шим очереди убран — тонкий проект отстал без смены версии
const dropShim = () => rmSync(path.join(sb.proj, ".agents/slot.sh"));
// версия пакета Elves в package.json проекта
const pinned = () => JSON.parse(read(path.join(sb.proj, "package.json"))).devDependencies?.["@miroshnik/elves"];

/**
 * Проект на bun со своей зависимостью — пакетом workspace по `file:`: lockfile есть, как у живого проекта, а реестр для
 * него не нужен.
 */
function bunProject() {
  writeTree(sb.proj, {
    "package.json": JSON.stringify({ name: "app", private: true, dependencies: { "@app/util": "file:./util" } }, null, 2) + "\n",
    "util/package.json": JSON.stringify({ name: "@app/util", version: "1.0.0" }) + "\n",
    ".gitignore": "node_modules/\n",
  });
  expect(spawnSync(process.execPath, ["install"], { cwd: sb.proj, env: sb.env, encoding: "utf8" }).status).toBe(0);
}

// машина с `install -g --link` из клона; origin клона — upstream, куда тест коммитит новое в main
function linkedClone() {
  mkdirSync(path.join(sb.home, ".claude"), { recursive: true });
  const up = copyPackage(base, path.join(sb.tmp, "upstream"));
  const clone = path.join(sb.tmp, "clone");
  git(sb.tmp, "clone", "-q", up.dir, clone);
  expect(elves(sb, ["install", "-g", "--link"], { bin: path.join(clone, "bin/elves.ts") }).code).toBe(0);
  return { up, clone };
}

/**
 * Тонкий проект (#552) держит версию пакета `@miroshnik/elves`: отстал — значит, вышел релиз новее. Обновление — подъём
 * версии, несколько строк package.json и lockfile, — идёт в ветке текущей задачи, без отдельной задачи и копии.
 */
describe("Тонкий проект сверяется с версией пакета и обновляется в задаче сессии", () => {
  it("версия пакета проекта — как у релиза установщика: актуально, код 0", () => {
    writePkg({});
    expect(elves(sb, ["install"], { bin: v1.bin }).code).toBe(0);
    const r = elves(sb, ["check"], { bin: v1.bin });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("in the project: up to date (v2026.10.15.1)");
  });

  it("check тонкого проекта называет отставание версии пакета и строку для текущей задачи; check ничего не меняет", () => {
    writePkg({});
    elves(sb, ["install", "--lang", "ru"], { bin: v1.bin });
    const before = snapshot(sb.proj);
    const r = elves(sb, ["check"], { bin: v2.bin });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("in the project: behind — installed v2026.10.15.1, latest v2026.10.16\n");
    expect(r.stdout).toContain(`  ~ package.json — @miroshnik/elves ${V1} → ${V2}\n`);
    expect(r.stdout).toContain(`\n${UPDATE_HERE}\n`);
    expect(r.stdout).not.toContain("task new");
    expect(snapshot(sb.proj)).toEqual(before);
  });

  /** Строку агент запускает как есть: команда — пакет из npm, он сам релиз (#559); `github:` — только запасной пускатель. */
  it("check называет команду обновления из npm — bunx @miroshnik/elves update, а не github:", () => {
    writePkg({});
    elves(sb, ["install"], { bin: v1.bin });
    const r = elves(sb, ["check"], { bin: v2.bin });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(": bunx @miroshnik/elves update\n");
    expect(r.stdout).not.toContain("github:");
  });

  /** Подъём версии — три строки: версия в package.json и две строки bun.lock — версия workspace и запись пакета. */
  it("update в тонком проекте поднимает версию пакета в package.json и bun.lock — три строки; коммит — в задаче сессии; после него check — актуально", () => {
    bunProject();
    expect(elves(sb, ["install", "--lang", "ru"], { bin: v1.bin, env: registry.env }).code).toBe(0);
    gitRepo(sb.proj, { init: false }).commit({}, "chore: флоу Elves");
    const u = elves(sb, ["update"], { bin: v2.bin, env: registry.env });
    expect(u.code).toBe(0);
    expect(JSON.parse(read(path.join(sb.proj, "package.json"))).devDependencies).toEqual({ "@miroshnik/elves": V2 });
    expect(read(path.join(sb.proj, "bun.lock"))).toContain(`"@miroshnik/elves@${V2}"`);
    expect(git(sb.proj, "diff", "--numstat").split("\n")).toEqual(["2\t2\tbun.lock", "1\t1\tpackage.json"]);
    expect(u.stdout).toContain(`Commit it with the session's task:\n  git add -A -- package.json bun.lock && git commit -m "chore(agents): флоу Elves v2026.10.16"\n`);
    expect(elves(sb, ["check"], { bin: v2.bin }).code).toBe(0);
  });

  it("флоу в проекте не стоит — «not installed», код 0, ничего не создаётся", () => {
    const r = elves(sb, ["check"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("in the project: not installed");
    expect(existsSync(path.join(sb.proj, ".agents"))).toBe(false);
  });

  /** Настройку задаёт только `install` (capability `elves#install`): `update` идёт без терминала и флагов — из сессии агента. */
  it("update настройку сохраняет: auto true остаётся true, у установки прошлой версии без поля — false", () => {
    elves(sb, ["install", "--auto"]);
    expect(elves(sb, ["update"], { bin: newer.bin }).code).toBe(0);
    expect(JSON.parse(read(manifest(sb.proj)))).toEqual({ auto: true, language: "en" });
    editManifest(sb.proj, { auto: undefined });
    expect(elves(sb, ["update"], { bin: newer.bin }).code).toBe(0);
    expect(JSON.parse(read(manifest(sb.proj))).auto).toBe(false);
  });

  /** Язык задаёт только `install`: язык проекта после обновления не меняется. */
  it("update язык сохраняет: language ru остаётся ru", () => {
    elves(sb, ["install", "--lang", "ru"]);
    expect(elves(sb, ["update"], { bin: newer.bin }).code).toBe(0);
    expect(JSON.parse(read(manifest(sb.proj)))).toEqual({ auto: false, language: "ru" });
  });

  /** `env` — настройка стека задачи (скилл task-env: HTTP-сервисы и их порты): её пишет проект, установщик переносит. */
  it("`install` и `update` сохраняют `env` в `.agents/elves.json`", () => {
    const env = { http: { web: 3000, admin: 5173 } };
    elves(sb, ["install"]);
    editManifest(sb.proj, { env });
    expect(elves(sb, ["update"], { bin: newer.bin }).code).toBe(0);
    expect(JSON.parse(read(manifest(sb.proj)))).toEqual({ auto: false, language: "en", env });
    expect(elves(sb, ["install", "--lang", "ru"]).code).toBe(0);
    expect(JSON.parse(read(manifest(sb.proj)))).toEqual({ auto: false, language: "ru", env });
  });

  /**
   * `batch` — пачки диспетчера (эпик #645, вопрос 6): настройку пишет проект, `task queue` по ней собирает задачи в ветку
   * пачки. Установщик, переписывая манифест, её не теряет — иначе первый `update` молча возвращал бы проект к PR каждой
   * задачи в `main`.
   */
  it("`install` и `update` сохраняют `batch` в `.agents/elves.json`", () => {
    elves(sb, ["install"]);
    editManifest(sb.proj, { batch: true });
    expect(elves(sb, ["check"]).stdout).toContain("in the project: up to date");
    expect(elves(sb, ["update"], { bin: newer.bin }).code).toBe(0);
    expect(JSON.parse(read(manifest(sb.proj)))).toEqual({ auto: false, language: "en", batch: true });
    expect(elves(sb, ["install", "--lang", "ru"]).code).toBe(0);
    expect(JSON.parse(read(manifest(sb.proj)))).toEqual({ auto: false, language: "ru", batch: true });
  });

  /** Язык — последней строкой: в начале сессии агент видит, на каком языке работать, не читая манифест. */
  it("check называет язык проекта", () => {
    elves(sb, ["install", "--lang", "ru"]);
    expect(elves(sb, ["check"])).toMatchObject({ code: 0, stdout: expect.stringMatching(/\n {2}language: ru\n$/) });
  });

  /** Режим — последней строкой: в начале сессии агент видит, вести ли задачу целиком самому. */
  it("check называет режим проекта: auto true — «tasks: entirely by itself», иначе — «tasks: with permission»; поле, правленное руками, и установка без поля отставанием не считаются", () => {
    elves(sb, ["install"]);
    const check = () => elves(sb, ["check"]);
    expect(check().stdout).toEndWith(MODE_ASK);
    editManifest(sb.proj, { auto: true });
    expect(check()).toMatchObject({ code: 0, stdout: expect.stringMatching(/in the project: up to date[^\n]*\n {2}tasks: entirely by itself\n {2}language: en\n$/) });
    editManifest(sb.proj, { auto: undefined });
    expect(check()).toMatchObject({ code: 0, stdout: expect.stringMatching(/in the project: up to date[^\n]*\n {2}tasks: with permission\n {2}language: en\n$/) });
    editManifest(sb.proj, { auto: true });
    dropShim();
    const behind = check();
    expect(behind.code).toBe(1);
    expect(behind.stdout).toEndWith(`${UPDATE_HERE}\n${MODE_AUTO}`);
    expect(elves(sb, ["install", "-g"]).code).toBe(0);
    expect(elves(sb, ["check", "-g"]).stdout).not.toContain("tasks:");
  });

  /** Клон Elves — сам канон: сверять и обновлять в нём нечего, а режим сессии в нём знать нужно. */
  it("в клоне Elves check и хук называют режим, клон остаётся «not installed»: релиз не ищут, поставить флоу не зовут, update флоу в клон не ставит", () => {
    const clone = copyPackage(base, path.join(sb.tmp, "clone")).dir;
    // установщик — пакет bunx из main, релизы недоступны: поиск релиза дал бы код 2
    const bin = bunxPackage(path.join(sb.tmp, "bunx/main"), base.dir, null);
    const run = (...args: string[]) => elves(sb, args, { cwd: clone, bin, env: { ELVES_REPO: path.join(sb.tmp, "nowhere") } });
    expect(run("check")).toMatchObject({ code: 0, stdout: ABSENT + MODE_ASK });
    expect(elves(sb, ["install", "--auto"], { cwd: clone }).code).toBe(0);
    expect(run("check")).toMatchObject({ code: 0, stdout: ABSENT + MODE_AUTO });
    const hook = run("check", "--hook");
    expect(hook.code).toBe(0);
    expect(hook.stdout).toContain(ABSENT + MODE_AUTO);
    expect(hook.stdout).not.toContain("install it");
    expect(elves(sb, ["update"], { cwd: clone }).code).toBe(0);
    expect(snapshot(path.join(clone, ".agents"))).toEqual({ "elves.json": JSON.stringify({ auto: true, language: "en" }, null, 2) + "\n" });
  });

  /** Флоу до перехода на Bun ставился через npx: его команду носят блок AGENTS.md и блок исключений .gitignore. */
  it("блоки AGENTS.md и .gitignore со старой командой npx — отстаёт; update переписывает оба на bunx; после него check — актуально", () => {
    writeFileSync(path.join(sb.proj, ".gitignore"), ".agents/\n");
    elves(sb, ["install"]);
    const files = [path.join(sb.proj, "AGENTS.md"), path.join(sb.proj, ".gitignore")];
    for (const f of files) {
      const text = read(f);
      expect(text).toContain("`bunx @miroshnik/elves install`");
      writeFileSync(f, text.replace("`bunx @miroshnik/elves install`", "`npx -y github:miroshnik/elves install`"));
    }
    const c = elves(sb, ["check"]);
    expect(c.code).toBe(1);
    expect(c.stdout).toContain("  ~ AGENTS.md\n");
    expect(elves(sb, ["update"]).code).toBe(0);
    for (const f of files) expect(read(f)).not.toContain("npx");
    expect(elves(sb, ["check"]).code).toBe(0);
  });

  /**
   * Облачные сессии флоу не поддерживает (#837, capability `elves#cloud-session`), а прошлая версия клала тонкому проекту
   * хук SessionStart облачной сессии в `.claude/settings.json` (#610). Установка узнаёт его, как узнавала, чтобы
   * заменить: в команде — проверка облака и `check --hook`. Свои настройки и хуки проекта остаются; файл, где был только
   * этот хук, уходит, и пустой `.claude/` с ним; изменение — в строке `git add`, как прочие файлы флоу.
   */
  it("Обновление проекта убирает облачный хук, поставленный прошлой версией", () => {
    const PREVIOUS = {
      matcher: "startup|resume|clear",
      hooks: [
        {
          type: "command",
          command:
            '[ "$CLAUDE_CODE_REMOTE" = true ] || exit 0; [ -e "$HOME/.claude/rules/elves.md" ] || { npm i -g bun@latest @miroshnik/elves && elves install -g; } >/dev/null 2>&1 || { echo "Elves cloud hook: the flow isn\'t installed (exit $?) — run: npm i -g bun@latest @miroshnik/elves && elves install -g"; exit 0; }; elves check --hook 2>&1 || echo "elves check unavailable (exit $?): work by the current flow and say so"',
          timeout: 120,
        },
      ],
    };
    const mine = { hooks: [{ type: "command", command: "echo мой хук" }] };
    const own = { permissions: { allow: ["Bash(ls)"] }, hooks: { SessionStart: [mine], Stop: [mine] } };
    const file = path.join(sb.proj, ".claude/settings.json");
    const repo = gitRepo(sb.proj, { init: false });
    const add = (out: string) => /git add -A -- [^&\n]+/.exec(out)?.[0] ?? "";
    // с auto: без него в файле и правила ask флоу (#840), а тест — об одном хуке
    elves(sb, ["install", "--auto"]);
    repo.commit({ ".claude/settings.json": JSON.stringify({ ...own, hooks: { ...own.hooks, SessionStart: [mine, PREVIOUS] } }, null, 2) + "\n" }, "chore: флоу Elves");
    const c = elves(sb, ["check"]);
    expect(c.code).toBe(1);
    expect(c.stdout).toContain("  ~ .claude/settings.json — the cloud session's SessionStart hook of a previous version: the flow doesn't support cloud sessions\n");
    let u = elves(sb, ["update"]);
    expect(u.code).toBe(0);
    expect(JSON.parse(read(file))).toEqual(own);
    expect(add(u.stdout)).toContain(".claude/settings.json");
    expect(elves(sb, ["check"]).code).toBe(0);
    // в файле — только облачный хук: файл уходит, удаление — в коммите обновления
    repo.commit({ ".claude/settings.json": JSON.stringify({ hooks: { SessionStart: [PREVIOUS] } }, null, 2) + "\n" }, "chore: хук прошлой версии");
    expect(elves(sb, ["check"]).stdout).toContain("  - .claude/settings.json — the cloud session's SessionStart hook of a previous version");
    u = elves(sb, ["update"]);
    expect(u.code).toBe(0);
    expect(existsSync(path.join(sb.proj, ".claude"))).toBe(false);
    execFileSync("sh", ["-c", add(u.stdout)], { cwd: sb.proj, env: sb.env });
    expect(repo.git("diff", "--cached", "--name-status")).toBe("D\t.claude/settings.json");
    expect(elves(sb, ["check"]).code).toBe(0);
  });
});

/**
 * Файл тонкого проекта, который игнорирует git, в коммит не попадёт — CI и чужой чекаут без шима падают на `. .agents/slot.sh`.
 * Это несоответствие флоу, как отставание: чинит тот же `update` — в задаче сессии (capability `elves#install` — как).
 */
describe("Файл флоу, который игнорирует git проекта, — несоответствие: check его называет, update снимает исключением", () => {
  it("check: код 1, ❌ с путём и правилом, команда update — в задаче сессии; check ничего не меняет", () => {
    elves(sb, ["install"]);
    writeFileSync(path.join(sb.proj, ".gitignore"), ".agents/\n");
    const before = snapshot(sb.proj);
    const r = elves(sb, ["check"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("in the project: up to date");
    expect(r.stdout).toContain("git ignores flow files");
    expect(r.stdout).toContain("  ❌ .agents/ — .gitignore:1 «.agents/»\n");
    expect(r.stdout).toContain("Fix in this session's task: bunx @miroshnik/elves update — adds exceptions to .gitignore\n");
    expect(r.stdout).not.toContain("task new");
    expect(r.stdout).toEndWith(MODE_ASK);
    expect(snapshot(sb.proj)).toEqual(before);
  });

  it("update дописывает исключения, подсказка коммита включает .gitignore и файлы флоу; после него check — актуально", () => {
    elves(sb, ["install"]);
    writeFileSync(path.join(sb.proj, ".gitignore"), ".agents/\n");
    const u = elves(sb, ["update"]);
    expect(u.code).toBe(0);
    const add = /git add -A -- [^&\n]+/.exec(u.stdout)?.[0] ?? "";
    expect(add).toContain(".gitignore");
    execFileSync("sh", ["-c", add], { cwd: sb.proj, env: sb.env });
    const staged = git(sb.proj, "diff", "--cached", "--name-only").split("\n");
    expect(staged).toEqual(expect.arrayContaining([".gitignore", ".agents/elves.json", ".agents/slot.sh"]));
    expect(elves(sb, ["check"])).toMatchObject({ code: 0, stdout: expect.stringContaining("in the project: up to date") });
  });

  /** Сторож от перекоррекции: свои правки .gitignore проекта в коммит флоу не уходят. */
  it("ничего не игнорируется — подсказка коммита update без .gitignore", () => {
    elves(sb, ["install"]);
    writeFileSync(path.join(sb.proj, ".gitignore"), "dist/\n");
    dropShim();
    const add = /git add -A -- [^&\n]+/.exec(elves(sb, ["update"]).stdout)?.[0] ?? "";
    expect(add).toContain(".agents/slot.sh");
    expect(add).not.toContain(".gitignore");
  });

  it("каталог флоу исключён правилом вне проекта — check: ❌ с правилом и «fix the rule», без команды update: её исключение не поможет", () => {
    elves(sb, ["install"]);
    writeFileSync(path.join(sb.home, ".gitconfig"), `[core]\n\texcludesFile = ${path.join(sb.home, "personal-ignore")}\n`);
    writeFileSync(path.join(sb.home, "personal-ignore"), ".agents/\n");
    const r = elves(sb, ["check"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("  ❌ .agents/ — ~/personal-ignore:1 «.agents/»: the directory is excluded outside the project");
    expect(r.stdout).toContain("fix the rule");
    expect(r.stdout).not.toContain("elves update");
    expect(r.stdout).not.toContain("task new");
  });
});

/**
 * Манифест — язык и режим проекта (#681): без него скилл github языка не знает и не пишет имена в GitHub. Так поймано: в
 * проекте на ru `.agents/` не в git, свежий worktree остался без манифеста, а check говорил «not installed — install
 * it», хотя пакет Elves стоял в devDependencies, и молчал, что манифест в основном чекауте не закоммичен.
 */
describe("Манифест проекта — на месте и в git: без него язык проекта неизвестен", () => {
  /** Коммит всего проекта, кроме `keep`: файлы остаются в каталоге, но не в git. */
  function commitAll(message: string, ...keep: string[]) {
    git(sb.proj, "add", "-A");
    for (const rel of keep) git(sb.proj, "rm", "--cached", "-q", "--", rel);
    git(sb.proj, "-c", "user.email=spec@example.test", "-c", "user.name=spec", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
  }
  const MISSING = (root: string) =>
    `Elves in the project: ❌ no .agents/elves.json in ${root} — the project language is unknown: copy the manifest from the main checkout (the first line of git worktree list) or commit it there — @miroshnik/elves is in package.json, the github skill refuses to write names without it\n`;
  const UNTRACKED =
    "  ❌ .agents/elves.json — not in git: another checkout and a fresh worktree don't see it, the github skill refuses to write names there; bunx @miroshnik/elves update puts it into the commit\n";

  it("check проекта с пакетом Elves в devDependencies и без манифеста — ❌ манифест отсутствует, а не not installed", () => {
    writePkg({ devDependencies: { "@miroshnik/elves": V1 } });
    expect(elves(sb, ["check"])).toMatchObject({ code: 1, stdout: MISSING(realpathSync(sb.proj)) });
    const hook = elves(sb, ["check", "--hook"]);
    expect(hook.code).toBe(0);
    expect(hook.stdout).toContain(MISSING(realpathSync(sb.proj)));
    expect(hook.stdout).toContain("No project manifest in this checkout — copy it from the main checkout before the task");
    expect(hook.stdout).not.toContain("install it");
  });

  /** update записал бы манифест с языком по умолчанию — en в проекте на ru: то же, от чего отказывает скилл github. */
  it("update проекта с пакетом Elves и без манифеста — отказ, код 2: манифест с языком по умолчанию не пишется", () => {
    writePkg({ devDependencies: { "@miroshnik/elves": V1 } });
    const before = snapshot(sb.proj);
    const u = elves(sb, ["update"]);
    expect(u.code).toBe(2);
    expect(u.stderr).toContain(`update: no .agents/elves.json in ${realpathSync(sb.proj)} — the project language is unknown`);
    expect(u.stderr).toContain("a project the flow never installed — bunx @miroshnik/elves install --lang <project language>");
    expect(snapshot(sb.proj)).toEqual(before);
  });

  it("check проекта с манифестом не в git — ❌ с причиной: другой чекаут и свежий worktree его не увидят", () => {
    writePkg({});
    expect(elves(sb, ["install", "--lang", "ru"]).code).toBe(0);
    commitAll("chore: флоу Elves", ".agents/elves.json");
    const r = elves(sb, ["check"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toStartWith("Elves in the project: up to date");
    expect(r.stdout).toContain(UNTRACKED);
    expect(r.stdout).toEndWith("  tasks: with permission\n  language: ru\n");
    expect(elves(sb, ["check", "--hook"]).stdout).toContain("The project manifest isn't in git — update names it in its commit line");
    // update называет манифест в строке коммита; закоммичен — check актуален
    const add = /git add -A -- [^&\n]+/.exec(elves(sb, ["update"]).stdout)?.[0] ?? "";
    expect(add).toContain(".agents/elves.json");
    execFileSync("sh", ["-c", add], { cwd: sb.proj, env: sb.env });
    commitAll("chore: манифест Elves");
    expect(elves(sb, ["check"])).toMatchObject({ code: 0, stdout: expect.not.stringContaining("not in git") });
  });

  /** Сторож от перекоррекции: в репозитории без коммитов другого чекаута ещё нет — сразу после install строки нет. */
  it("репозиторий без коммитов — манифест вне git check не называет: другого чекаута ещё нет", () => {
    expect(elves(sb, ["install"]).code).toBe(0);
    expect(elves(sb, ["check"])).toMatchObject({ code: 0, stdout: expect.not.stringContaining("not in git") });
  });
});

/**
 * check проекта с compose-файлом зовёт скрипт task-env под тем же bun, тот — `docker compose config`: в PATH песочницы
 * — docker прогона. Плагин compose docker ищет в каталоге своей конфигурации, а HOME у песочницы свой — DOCKER_CONFIG
 * ведёт в настоящий.
 */
function withDocker() {
  symlinkSync(execFileSync("sh", ["-c", "command -v docker"], { encoding: "utf8" }).trim(), path.join(sb.bin, "docker"));
  sb.env.DOCKER_CONFIG = process.env.DOCKER_CONFIG || path.join(os.homedir(), ".docker");
}

const composeFile = (yaml: string) => writeFileSync(path.join(sb.proj, "compose.yaml"), yaml);
const CONTAINER_NAME = "services:\n  db:\n    image: postgres\n    container_name: pg\n";
const COMPOSE_VIOLATION = "  ❌ compose.yaml: service db — container_name pg: a second task stack can't start; remove it, Compose names containers by the project\n";

describe("check проекта держит compose-файл правил изоляции стеков задач: нарушение — строка ❌ с правилом и сервисом", () => {
  it("нарушения — строки ❌ скрипта task-env, код 1 и при актуальном флоу; check ничего не меняет", () => {
    withDocker();
    elves(sb, ["install"]);
    composeFile(CONTAINER_NAME);
    const before = snapshot(sb.proj);
    const r = elves(sb, ["check"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("in the project: up to date");
    expect(r.stdout).toContain(COMPOSE_VIOLATION);
    expect(r.stdout).toEndWith(MODE_ASK);
    expect(snapshot(sb.proj)).toEqual(before);
  });

  it("флоу отстал — строки ❌ compose-файла идут вместе со списком изменений, код 1", () => {
    withDocker();
    elves(sb, ["install"]);
    composeFile(CONTAINER_NAME);
    dropShim();
    const r = elves(sb, ["check"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("in the project: behind");
    expect(r.stdout).toContain(COMPOSE_VIOLATION);
    expect(r.stdout).toEndWith(MODE_ASK);
  });

  /** Без docker в PATH: начни check скрипт в проекте без compose-файла — была бы строка ○ «docker not found». */
  it("проект без compose-файла — ни строки сверх обычных, скрипт не запускается; чистый compose-файл — тоже ни строки; код 0", () => {
    elves(sb, ["install"]);
    const upToDate = /^Elves in the project: up to date \([^)\n]+\)\n {2}tasks: with permission\n {2}language: en\n$/;
    expect(elves(sb, ["check"])).toMatchObject({ code: 0, stdout: expect.stringMatching(upToDate) });
    withDocker();
    composeFile("services:\n  db:\n    image: postgres\n    ports: ['127.0.0.1::5432']\n");
    expect(elves(sb, ["check"])).toMatchObject({ code: 0, stdout: expect.stringMatching(upToDate) });
  });

  it("адрес сервиса из env.http по короткому имени — строка ! скрипта task-env, код по-прежнему 0", () => {
    withDocker();
    elves(sb, ["install"]);
    const settings = path.join(sb.proj, ".agents/elves.json");
    writeFileSync(settings, JSON.stringify({ ...JSON.parse(readFileSync(settings, "utf8")), env: { http: { web: 3000 } } }));
    composeFile("services:\n  web:\n    image: app\n  worker:\n    image: app\n    environment: { API_URL: 'http://web:3000' }\n");
    const r = elves(sb, ["check"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("  ! compose.yaml: service worker — environment API_URL: the short name web of an env.http service may reach another task's stack; use the container name ${COMPOSE_PROJECT_NAME}-web-1\n");
    expect(r.stdout).not.toContain("the task isolation rules hold");
    expect(r.stdout).toEndWith(MODE_ASK);
  });

  it("без Docker — строка ○ «not checked» с причиной, код по-прежнему 0", () => {
    elves(sb, ["install"]);
    composeFile(CONTAINER_NAME);
    const noDocker = elves(sb, ["check"]);
    expect(noDocker.code).toBe(0);
    expect(noDocker.stdout).toContain("  ○ compose.yaml: not checked — docker not found\n");
    expect(noDocker.stdout).toEndWith(MODE_ASK);
  });
});

// решение в корне спеки — папка темы с тестом раздела, как у проекта
function decision(rel: string) {
  mkdirSync(path.join(sb.proj, rel), { recursive: true });
  writeFileSync(path.join(sb.proj, rel, "rules.test.ts"), "");
}
// обёртка slot, которую ставит install: скрипт подключает шим и берёт слот своим shell, команда — как есть
const inSlot = (cmd: string) => `. .agents/slot.sh && ${cmd}`;
const NO_TEST_SPEC = (roots: string) => `  ❌ package.json: no test:spec script — pr premerge doesn't run ${roots} on the merge with a moved main; `;
// готовые строки скриптов: test:spec, а если test гоняет те же корни — и test без них
const ADD_SPEC = (spec: string) => `add to "scripts": "test:spec": ${JSON.stringify(spec)}\n`;
const PUT_PAIR = (spec: string, test: string) => `put in "scripts" — test without them, they don't run twice: "test:spec": ${JSON.stringify(spec)}, "test": ${JSON.stringify(test)}\n`;

/**
 * Без скрипта `test:spec` `pr premerge` проверяет слияние с ушедшим main одним typecheck или ничем, а стандарты и
 * архитектура — там, где ломают два зелёных PR, — не идут: в одном проекте 89 запусков premerge ничего не проверили,
 * в другом стандарт покраснел на main сразу после мержа (#442).
 */
describe("check проекта со стандартами или архитектурой требует скрипт test:spec — быструю проверку pr premerge", () => {
  it("проект со стандартами без скрипта test:spec — check называет нарушение и строку для package.json", () => {
    writePkg({ scripts: { test: "bun test" } });
    elves(sb, ["install"]);
    decision("tests/standards/naming");
    const before = snapshot(sb.proj);
    const r = elves(sb, ["check"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("in the project: up to date");
    const spec = inSlot("bun test tests/standards");
    const test = inSlot("bun test --path-ignore-patterns='tests/standards/**'");
    expect(r.stdout).toContain(NO_TEST_SPEC("tests/standards") + PUT_PAIR(spec, test));
    expect(r.stdout).toEndWith(MODE_ASK);
    expect(snapshot(sb.proj)).toEqual(before);
    // готовые строки как есть в package.json — актуально: они уже в очереди slot, update их не переписывает
    const pkg = JSON.parse(read(path.join(sb.proj, "package.json")));
    writePkg({ ...pkg, scripts: { ...pkg.scripts, "test:spec": spec, test } });
    const fixed = elves(sb, ["check"]);
    expect(fixed.code).toBe(0);
    expect(fixed.stdout).not.toContain("test:spec");
  });

  // тесты проекта — bun test (эпик #906): раннер test:spec не выбирается ни по test, ни по зависимостям
  it("test:spec — bun test по корням спеки, что есть, какой бы раннер ни был в test и в зависимостях", () => {
    elves(sb, ["install"]);
    const cases: [fields: Record<string, unknown>, roots: string[], files: string[], cmd: string][] = [
      [{ devDependencies: { jest: "^30.0.0" } }, ["tests/architecture/layers"], [], "bun test tests/architecture"],
      [{ packageManager: "bun@1.4.3" }, ["tests/standards/naming", "tests/architecture/layers"], [], "bun test tests/standards tests/architecture"],
      [{}, ["tests/standards/naming"], ["bun.lock"], "bun test tests/standards"],
      [{ devDependencies: { vitest: "^4.0.0" } }, ["tests/standards/naming"], ["bun.lock"], "bun test tests/standards"],
      [{}, ["tests/standards/naming"], [], "bun test tests/standards"],
      [{ devDependencies: { vitest: "^4.0.0" }, scripts: { test: inSlot("jest --ci") } }, ["tests/standards/naming"], [], "bun test tests/standards"],
      [{ devDependencies: { jest: "^30.0.0" }, scripts: { test: inSlot("vitest run") } }, ["tests/standards/naming"], [], "bun test tests/standards"],
    ];
    for (const [fields, roots, files, cmd] of cases) {
      rmSync(path.join(sb.proj, "tests"), { recursive: true, force: true });
      rmSync(path.join(sb.proj, "bun.lock"), { force: true });
      writePkg(fields);
      for (const rel of roots) decision(rel);
      for (const f of files) writeFileSync(path.join(sb.proj, f), "{}\n");
      const r = elves(sb, ["check"]);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain(NO_TEST_SPEC(roots.map((d) => d.split("/").slice(0, 2).join("/")).join(", ")));
      expect(r.stdout).toContain(`"test:spec": ${JSON.stringify(inSlot(cmd))}`);
    }
  });

  /**
   * Стандарты и архитектура идут один раз — в `test:spec`, своём джобе CI; `test` их не повторяет (скилл `spec`,
   * `checks.md`): один `test:spec` без исключения — те же тесты дважды. Исключение дописывается к фильтру, который у
   * `test` уже есть, — уровень `test:slow` держит там свои файлы.
   */
  it("рядом со строкой test:spec — исключение тех же корней из test фильтром раннера: стандарты не идут дважды", () => {
    elves(sb, ["install"]);
    decision("tests/standards/naming");
    const words = `${ADD_SPEC(inSlot("bun test tests/standards")).trimEnd()}; exclude tests/standards from test with the runner's filter — they don't run twice\n`;
    const cases: [test: string | undefined, line: string][] = [
      ["bun test", PUT_PAIR(inSlot("bun test tests/standards"), inSlot("bun test --path-ignore-patterns='tests/standards/**'"))],
      // фильтр медленного уровня остаётся, исключение корней — следом
      ["bun test --path-ignore-patterns='**/*.slow.test.ts'", PUT_PAIR(inSlot("bun test tests/standards"), inSlot("bun test --path-ignore-patterns='**/*.slow.test.ts' --path-ignore-patterns='tests/standards/**'"))],
      // test корни уже не гоняет или его нет — одна строка test:spec
      ["bun test --path-ignore-patterns='tests/standards/**'", ADD_SPEC(inSlot("bun test tests/standards"))],
      [undefined, ADD_SPEC(inSlot("bun test tests/standards"))],
      // test — не вызов bun test: фильтр не к чему дописать — словами
      ["turbo run test", words],
      ["vitest run", words],
    ];
    for (const [test, line] of cases) {
      writePkg(test === undefined ? {} : { scripts: { test: inSlot(test) } });
      const r = elves(sb, ["check"]);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain(NO_TEST_SPEC("tests/standards") + line);
    }
  });

  it("проект без стандартов и архитектуры — check не требует test:spec", () => {
    writePkg({ scripts: { test: "bun test" } });
    elves(sb, ["install"]);
    decision("tests/capabilities/export");
    const r = elves(sb, ["check"]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("test:spec");
  });
});

// строка ○: test гоняет корни спеки, которые уже гоняет test:spec, — готовая строка test без них
const REPEATS = (roots: string, test: string) => `  ○ package.json: test repeats test:spec — runs ${roots} a second time; put in "scripts": "test": ${JSON.stringify(test)}\n`;

/**
 * С `test:spec` стандарты и архитектура идут и в `test`, если он их не исключает: замер #470 — во всех трёх проектах с
 * `test:spec` локальный прогон перед коммитом гонял стандарты дважды, в одном это 76 с из 142 с `test`. Это лишнее
 * время, а не дыра в проверке: строка `○`, код выхода и признак нехватки `test:spec` прежние (#487).
 */
describe("check проекта с test:spec называет test, который повторяет стандарты и архитектуру", () => {
  beforeEach(() => {
    elves(sb, ["install"]);
    decision("tests/standards/naming");
  });
  const withSpec = (test: string) => writePkg({ scripts: { "test:spec": inSlot("bun test tests/standards tests/architecture"), test: inSlot(test) } });

  it("проект с test:spec, test — одиночный вызов раннера без корней спеки — check выводит строку ○ с готовой строкой test без них", () => {
    decision("tests/architecture/layers");
    withSpec("bun test");
    const before = snapshot(sb.proj);
    const r = elves(sb, ["check"]);
    expect(r.stdout).toContain(REPEATS("tests/standards, tests/architecture", inSlot("bun test --path-ignore-patterns='tests/standards/**' --path-ignore-patterns='tests/architecture/**'")));
    expect(snapshot(sb.proj)).toEqual(before);
  });

  it("готовая строка test дописывает исключение к фильтру, который в test уже есть, и остаётся под обёрткой slot", () => {
    const cases: [test: string, line: string][] = [
      ["bun test --path-ignore-patterns='**/*.slow.test.ts'", inSlot("bun test --path-ignore-patterns='**/*.slow.test.ts' --path-ignore-patterns='tests/standards/**'")],
      ["bun test --timeout=10000", inSlot("bun test --timeout=10000 --path-ignore-patterns='tests/standards/**'")],
    ];
    for (const [test, line] of cases) {
      withSpec(test);
      expect(elves(sb, ["check"]).stdout).toContain(REPEATS("tests/standards", line));
    }
  });

  it("test называет все корни спеки — строки нет", () => {
    decision("tests/architecture/layers");
    // называет один корень из двух — строка о другом
    withSpec("bun test --path-ignore-patterns='tests/standards/**'");
    expect(elves(sb, ["check"]).stdout).toContain(REPEATS("tests/architecture", inSlot("bun test --path-ignore-patterns='tests/standards/**' --path-ignore-patterns='tests/architecture/**'")));
    withSpec("bun test --path-ignore-patterns='tests/standards/**' --path-ignore-patterns='tests/architecture/**'");
    expect(elves(sb, ["check"]).stdout).not.toContain("○");
  });

  it("test не одиночный вызов bun test — turbo, цепочка команд или другой раннер — check молчит", () => {
    for (const test of ["turbo run test", "bun test && tsc --noEmit", "bun test | tee test.log", "vitest run"]) {
      withSpec(test);
      const r = elves(sb, ["check"]);
      expect(r.code).toBe(0);
      expect(r.stdout).not.toContain("○");
    }
  });

  it("строка ○ о повторе стандартов не меняет код выхода check", () => {
    withSpec("bun test");
    const r = elves(sb, ["check"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toStartWith("Elves in the project: up to date");
    expect(r.stdout).toEndWith(REPEATS("tests/standards", inSlot("bun test --path-ignore-patterns='tests/standards/**'")) + MODE_ASK);
  });
});

// строка check проекта с пачками: workflow, который запускается (или может запуститься) на PR в ветку пачки
const BATCHES_DOC = "~/.agents/skills/spec/ci.md, «Batches»";
const RUNS = (file: string, how = "runs") =>
  `  ❌ .github/workflows/${file}: on.pull_request ${how} on a PR into a batch branch — its gate is the checks before a commit and pr premerge, the full CI is the release's; add branches-ignore: ['batch/**'] (${BATCHES_DOC})\n`;
// фильтр путей, types без synchronize: без диффа PR и события не решить — может запуститься
const MAY_RUN = "may run (by the PR's diff or event)";
const UP_TO_DATE = /^Elves in the project: up to date \([^)\n]+\)\n {2}tasks: with permission\n {2}language: en\n$/;
// фрагмент ci.md «Batches»: on: без ветки пачки, джобы полного набора без условия по базе
const BATCHES_CI = /\n## Batches[^]*?```yaml\n([^]*?)```/.exec(read(path.join(REPO, "skills/spec/ci.md")))![1]!;
const workflow = (file: string, yaml: string) => writeTree(sb.proj, { [`.github/workflows/${file}`]: yaml });
const JOBS = "jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bun test\n";
// CI проекта без пачек: полный набор на PR в любую базу
const ANY_PR = `on:\n  pull_request:\n  push:\n    branches: [main]\n${JOBS}`;

/**
 * Пачку включает `"batch": true` в `.agents/elves.json` (эпик #645, вопрос 6). PR задачи в ветку пачки CI не запускает
 * (#676): его ворота — проверки перед коммитом у исполнителя и `github pr premerge`, полный CI — один прогон на PR выпуска
 * в main и на сам main (скилл spec, `ci.md`, «Batches»). Workflow, который идёт на PR в ветку пачки, повторяет то, что
 * исполнитель уже прогнал, и держит его слот, — `check` называет его строкой `❌`; фильтр путей и `types` без
 * `synchronize` — тоже: без диффа PR не решить, а запуститься он может.
 */
describe("check проекта с пачками сверяет, что PR в ветку пачки CI не запускает", () => {
  beforeEach(() => {
    elves(sb, ["install"]);
    editManifest(sb.proj, { batch: true });
  });

  it("check проекта с batch называет ❌ workflow, который запускается на PR в ветку пачки", () => {
    const cases: [on: string, file: string, how: string | null][] = [
      ["on:\n  pull_request:\n  push:\n    branches: [main]\n", "ci.yml", "runs"],
      ["on: [push, pull_request]\n", "ci.yml", "runs"],
      ["on:\n  pull_request:\n    branches: [main, 'batch/**']\n", "ci.yml", "runs"],
      ["on:\n  pull_request:\n    branches: ['batch/*']\n", "ci.yml", "runs"],
      ["on:\n  pull_request:\n", "ci.yaml", "runs"],
      ["on:\n  pull_request:\n    paths: ['src/**']\n", "ci.yml", MAY_RUN],
      ["on:\n  pull_request:\n    types: [labeled]\n", "ci.yml", MAY_RUN],
      // ветку пачки не пускает или на PR не идёт — строки нет
      ["on:\n  pull_request:\n    branches-ignore: ['batch/**']\n  push:\n    branches: [main]\n", "ci.yml", null],
      ["on:\n  pull_request:\n    branches: [main]\n", "ci.yml", null],
      ["on:\n  pull_request:\n    branches: ['**', '!batch/**']\n", "ci.yml", null],
      ["on:\n  pull_request:\n    branches-ignore: ['batch/**']\n    paths: ['src/**']\n", "ci.yml", null],
      ["on:\n  push:\n    branches: [main]\n", "ci.yml", null],
      ["on: pull_request_target\n", "ci.yml", null],
    ];
    for (const [on, file, how] of cases) {
      rmSync(path.join(sb.proj, ".github"), { recursive: true, force: true });
      workflow(file, on + JOBS);
      const before = snapshot(sb.proj);
      const r = elves(sb, ["check"]);
      if (how) {
        expect(r.code).toBe(1);
        expect(r.stdout).toEndWith(RUNS(file, how) + MODE_ASK);
      } else expect(r).toMatchObject({ code: 0, stdout: expect.stringMatching(UP_TO_DATE) });
      expect(snapshot(sb.proj)).toEqual(before);
    }
    // каждый такой workflow — своя строка, по имени файла
    rmSync(path.join(sb.proj, ".github"), { recursive: true, force: true });
    workflow("lint.yml", `on: pull_request\n${JOBS}`);
    workflow("ci.yml", ANY_PR);
    expect(elves(sb, ["check"]).stdout).toEndWith(RUNS("ci.yml") + RUNS("lint.yml") + MODE_ASK);
  });

  it("CI по фрагменту ci.md «Batches» и CI самого Elves — ни строки сверх обычных, код 0", () => {
    // workflow нет вовсе — на PR в ветку пачки ничего не идёт
    expect(elves(sb, ["check"])).toMatchObject({ code: 0, stdout: expect.stringMatching(UP_TO_DATE) });
    workflow("ci.yml", BATCHES_CI);
    workflow("elves.yml", read(path.join(REPO, ".github/workflows/ci.yml")));
    // workflow не на pull_request — не сверяется
    workflow("deploy.yml", "on:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo deploy\n");
    expect(elves(sb, ["check"])).toMatchObject({ code: 0, stdout: expect.stringMatching(UP_TO_DATE) });
  });

  it("проект без batch — CI не сверяется", () => {
    workflow("ci.yml", ANY_PR);
    for (const batch of [undefined, false]) {
      editManifest(sb.proj, { batch });
      expect(elves(sb, ["check"])).toMatchObject({ code: 0, stdout: expect.stringMatching(UP_TO_DATE) });
    }
  });

  /**
   * Проект с пачками и `check`, и `task queue` узнают одной функцией — `batchProject` модуля locale скилла github: два
   * своих условия разошлись бы, и `check` сверял бы CI проекта, где очередь ветку пачки не ведёт, или наоборот.
   */
  it("batch, отличный от true, — не проект с пачками ни для check, ни для task queue", () => {
    workflow("ci.yml", ANY_PR);
    for (const batch of ["true", 1, "yes", {}, null]) {
      editManifest(sb.proj, { batch });
      expect(elves(sb, ["check"])).toMatchObject({ code: 0, stdout: expect.stringMatching(UP_TO_DATE) });
      expect(locale.batchProject(sb.proj)).toBe(false);
    }
    editManifest(sb.proj, { batch: true });
    expect(locale.batchProject(sb.proj)).toBe(true);
    expect(elves(sb, ["check"]).stdout).toContain(RUNS("ci.yml"));
  });
});

// основной фрагмент ci.md — первый YAML до разделов: его копирует проект, который спеку не публикует
const MAIN_CI = /^[^]*?```yaml\n([^]*?)```/.exec(read(path.join(REPO, "skills/spec/ci.md")))![1]!;

/**
 * Публикация спеки — по желанию проекта (#838): `check` её не ставит и не требует. CI `check` читает у проекта с
 * пачками, и CI по основному фрагменту `ci.md` — без job `spec-publish` — проходит без строк. Страховка от перегиба:
 * требования job публикации в `check` нет, тест держит, чтобы оно не появилось.
 */
describe("check и публикация спеки", () => {
  it("`check` не требует job публикации спеки", () => {
    elves(sb, ["install"]);
    workflow("ci.yml", MAIN_CI);
    expect(elves(sb, ["check"])).toMatchObject({ code: 0, stdout: expect.stringMatching(UP_TO_DATE) });
    // проект с пачками: on: — из фрагмента «Batches», джобы — основного
    editManifest(sb.proj, { batch: true });
    const on = /^on:\n(?: .*\n)+/m;
    workflow("ci.yml", MAIN_CI.replace(on, on.exec(BATCHES_CI)![0]));
    expect(elves(sb, ["check"])).toMatchObject({ code: 0, stdout: expect.stringMatching(UP_TO_DATE) });
  });
});

/**
 * Клон Elves — сам канон: установку `check` в нём не сверяет, но пачки ведёт и Elves (`"batch": true`, #661) — его CI
 * сверяется, как CI тонкого проекта (#672): PR в ветку пачки CI не запускает (#676). Иначе Elves с workflow, что идёт на
 * PR в ветку пачки, `check` в клоне называл бы зелёным. Клон без `batch` — CI не читается, как прежде.
 */
describe("check клона Elves с пачками сверяет CI, как в тонком проекте", () => {
  let clone: string;
  beforeEach(() => {
    clone = bareClone(path.join(sb.tmp, "clone"));
    expect(elves(sb, ["install"], { cwd: clone }).code).toBe(0);
    editManifest(clone, { batch: true });
  });
  const check = () => elves(sb, ["check"], { cwd: clone });
  const ci = (yaml: string) => writeTree(clone, { ".github/workflows/ci.yml": yaml });

  it("check проекта и клона Elves с batch называет ❌ workflow, который запускается на PR в ветку пачки", () => {
    ci(ANY_PR);
    expect(check()).toMatchObject({ code: 1, stdout: ABSENT + RUNS("ci.yml") + MODE_ASK });
    // тонкий проект — та же строка тем же правилом
    elves(sb, ["install"]);
    editManifest(sb.proj, { batch: true });
    workflow("ci.yml", ANY_PR);
    expect(elves(sb, ["check"])).toMatchObject({ code: 1, stdout: expect.stringContaining(RUNS("ci.yml") + MODE_ASK) });
  });

  it("check в клоне Elves с batch и CI по фрагменту ci.md «Batches» — без ❌ по пачкам", () => {
    // workflow нет вовсе — на PR в ветку пачки ничего не идёт
    expect(check()).toMatchObject({ code: 0, stdout: ABSENT + MODE_ASK });
    ci(BATCHES_CI);
    expect(check()).toMatchObject({ code: 0, stdout: ABSENT + MODE_ASK });
    ci(ANY_PR);
    editManifest(clone, { batch: undefined });
    expect(check()).toMatchObject({ code: 0, stdout: ABSENT + MODE_ASK });
  });
});

// строки стека проекта (эпик #906): правило канона — Эльфы для проектов на Bun; шаг — поле packageManager Bun этого прогона
const BUN_RULE = "Elves is for projects on Bun (the canon's stack: Claude Code, Bun, GitHub)";
const NOT_BUN = (field: string) =>
  `  ❌ package.json: the project isn't on Bun — "packageManager": ${JSON.stringify(field)}; ${BUN_RULE}; move it to Bun: "packageManager": "bun@${Bun.version}", bun install\n`;
const FOREIGN_LOCKFILE = (file: string) => `  ❌ ${file}: another package manager's lockfile — ${BUN_RULE}; bun install moves its versions into Bun's lockfile, then remove ${file}\n`;
const FOREIGN_RUNNER = (file: string, name: string, section: string) =>
  `  ❌ ${file}: ${name} in ${section} — ${BUN_RULE}; the tests run with bun test: move them to bun:test, remove ${name}\n`;
const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"];
// проект с чистого листа: package.json, lockfile и пакеты workspace прошлого случая убраны, флоу на месте
const fresh = () => {
  for (const f of ["package.json", "bun.lock", "packages", "node_modules", ...LOCKFILES]) rmSync(path.join(sb.proj, f), { recursive: true, force: true });
};

/**
 * Эльфы написаны, проверены и запускаются под одним стеком — Claude Code, Bun, GitHub (эпик #906): менеджер пакетов
 * проекта и его раннер тестов — Bun. Держит это `check`, а не текст README: проект на npm, pnpm или Yarn и с Vitest или
 * Jest проходил его молча, а `install` ставил флоу в такой проект. Несоответствие — строка `❌` и код 1, как compose-файл
 * и `test:spec`: переезд — задача проекта, `update` его не делает; `install` в проект не на Bun отказывает до изменений
 * теми же строками.
 */
describe("check проекта держит стек Bun: менеджер пакетов, lockfile и раннер тестов", () => {
  it("`elves check` проекта, у которого `packageManager` в `package.json` не `bun@…`, — строка ❌ «проект не на Bun» с правилом канона и шагом", () => {
    elves(sb, ["install"]);
    for (const field of ["pnpm@10.1.0", "yarn@4.9.1", "npm@11.6.2"]) {
      writePkg({ packageManager: field });
      const before = snapshot(sb.proj);
      const r = elves(sb, ["check"]);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain(NOT_BUN(field));
      expect(r.stdout).toEndWith(MODE_ASK);
      expect(snapshot(sb.proj)).toEqual(before);
    }
  });

  it("`elves check` проекта с лок-файлом другого менеджера (`package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`) — строка ❌ с файлом", () => {
    elves(sb, ["install"]);
    for (const file of LOCKFILES) {
      fresh();
      // и без поля packageManager, и рядом с полем Bun — lockfile другого менеджера
      for (const fields of [{}, { packageManager: "bun@1.4.3" }]) {
        writePkg(fields);
        writeTree(sb.proj, { [file]: "{}\n" });
        const r = elves(sb, ["check"]);
        expect(r.code).toBe(1);
        expect(r.stdout).toContain(FOREIGN_LOCKFILE(file));
        expect(r.stdout).not.toContain("the project isn't on Bun");
      }
    }
  });

  it("`elves check` проекта с `vitest` или `jest` в зависимостях любого `package.json` проекта — строка ❌ с пакетом и заменой — `bun test`", () => {
    elves(sb, ["install"]);
    writePkg({ packageManager: "bun@1.4.3", workspaces: ["packages/*"], devDependencies: { vitest: "^4.0.0" } });
    writeTree(sb.proj, {
      "bun.lock": "{}\n",
      "packages/web/package.json": JSON.stringify({ name: "@x/web", dependencies: { jest: "^30.0.0" } }),
      "packages/api/package.json": JSON.stringify({ name: "@x/api", peerDependencies: { vitest: "^4.0.0" }, optionalDependencies: { jest: "^30.0.0" } }),
      // установленный пакет и каталог, который git проекта игнорирует, — не пакеты проекта
      "node_modules/vitest/package.json": JSON.stringify({ name: "vitest", dependencies: { jest: "^30.0.0" } }),
      "dist/package.json": JSON.stringify({ devDependencies: { vitest: "^4.0.0" } }),
      ".gitignore": "dist/\n",
    });
    const r = elves(sb, ["check"]);
    expect(r.code).toBe(1);
    const lines = r.stdout.split("\n").filter((l) => l.includes(BUN_RULE));
    expect(lines.map((l) => l + "\n")).toEqual([
      FOREIGN_RUNNER("package.json", "vitest", "devDependencies"),
      FOREIGN_RUNNER("packages/api/package.json", "vitest", "peerDependencies"),
      FOREIGN_RUNNER("packages/api/package.json", "jest", "optionalDependencies"),
      FOREIGN_RUNNER("packages/web/package.json", "jest", "dependencies"),
    ]);
  });

  it("`elves install` в проект не на Bun — отказ до изменений (код 2) с той же причиной", () => {
    const cases: [fields: Record<string, unknown>, files: Record<string, string>, lines: string[]][] = [
      [{ packageManager: "pnpm@10.1.0" }, {}, [NOT_BUN("pnpm@10.1.0")]],
      [{}, { "yarn.lock": "" }, [FOREIGN_LOCKFILE("yarn.lock")]],
      [{ packageManager: "npm@11.6.2" }, { "package-lock.json": "{}\n" }, [NOT_BUN("npm@11.6.2"), FOREIGN_LOCKFILE("package-lock.json")]],
    ];
    for (const [fields, files, lines] of cases) {
      fresh();
      writePkg(fields);
      writeTree(sb.proj, files);
      const before = snapshot(sb.proj);
      const r = elves(sb, ["install", "--no-auto", "--lang", "en"]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("install: the project isn't on Bun — nothing is installed");
      expect(r.stderr).toEndWith(lines.join(""));
      expect(snapshot(sb.proj)).toEqual(before);
    }
  });

  // spec-existing #907: проект на Bun и до проверки стека проходил check без строк — тест держит, что она его не задевает
  it("Проект на Bun без чужих лок-файлов и раннеров — ни одной такой строки", () => {
    // поле packageManager Bun и проект `bun init`, у которого поля нет, — по lockfile Bun; пакет с Playwright — ES-модули
    // (#917), как у `bun init`
    for (const fields of [{ packageManager: "bun@1.4.3" }, {}]) {
      fresh();
      writePkg({ ...fields, type: "module", workspaces: ["packages/*"], devDependencies: { "@types/bun": "^1.4.2", "@playwright/test": "^1.63.0" } });
      writeTree(sb.proj, { "bun.lock": "{}\n", "packages/web/package.json": JSON.stringify({ name: "@x/web", devDependencies: { "@types/bun": "^1.4.2" } }) });
      expect(elves(sb, ["install"]).code).toBe(0);
      expect(elves(sb, ["check"])).toMatchObject({ code: 0, stdout: expect.stringMatching(UP_TO_DATE) });
    }
  });
});

// строки встроенных инструментов Bun (эпик #906): правило канона, замена и страница — из строки таблицы справки docs/bun.md
const BUILTIN_RULE = "Elves projects use Bun's built-in tools, not the packages they replace (~/.agents/elves/docs/bun.md)";
const BUILTIN = (file: string, name: string, section: string, builtin: string, docs: string) =>
  `  ❌ ${file}: ${name} in ${section} — Bun has it built in: ${builtin} (${docs}); ${BUILTIN_RULE}; moving to it is a task of its own in the project, not an edit in this session, then remove ${name}\n`;
const NEXT_KEEPS = (file: string, name: string, section: string, builtin: string, docs: string) =>
  `  ○ ${file}: ${name} in ${section} — Bun has it built in: ${builtin} (${docs}), but the package depends on next: Next.js's server runs under Node, its dependencies stay\n`;
const SQL = ["Bun.sql", "https://bun.com/docs/runtime/sql"] as const;
const REDIS = ["Bun.redis", "https://bun.com/docs/runtime/redis"] as const;
const ENV = ["reading .env files", "https://bun.com/docs/runtime/environment-variables"] as const;
// строки вывода check с правилом встроенных инструментов — ❌ и ○
const builtinLines = (stdout: string) => stdout.split("\n").filter((l) => l.includes("Bun has it built in")).map((l) => l + "\n");

/**
 * Таблица замен справки `docs/bun.md` — строки `` | `pkg`, `pkg` | замена | [страница](url) | ``. Разбор теста, а не
 * установщика: тест сверяет вывод check с таблицей справки — у проверки и справки одна таблица. Читается в тесте, а не
 * при загрузке файла: на базе без справки файл грузится, и остальные тесты идут.
 */
function replacements() {
  const md = readFileSync(path.join(REPO, "docs/bun.md"), "utf8");
  return md
    .split("\n")
    .filter((l) => l.startsWith("| `"))
    .map((l) => {
      const [packages = "", builtin = "", docs = ""] = l.split("|").slice(1, 4).map((c) => c.trim());
      return { packages: [...packages.matchAll(/`([^`]+)`/g)].map((m) => m[1]!), builtin: builtin.replaceAll("`", ""), docs: /\]\((https:[^)]+)\)/.exec(docs)?.[1] ?? "" };
    });
}

/**
 * Проект на Bun пользуется встроенными инструментами Bun — `Bun.sql`, `Bun.s3`, `Bun.redis` и прочими, — а не пакетами,
 * которые они заменяют (эпик #906, п. 1 и 4 дизайна). Держит это `check` по таблице замен справки `docs/bun.md`:
 * зависимость из таблицы — строка `❌` и код 1, переход — задача проекта, как переезд на Bun. Исключение — Next.js: его
 * сервер идёт под Node, встроенных инструментов Bun там нет.
 */
describe("check проекта держит встроенные инструменты Bun вместо пакетов, которые они заменяют", () => {
  it("`elves check` проекта с зависимостью, которую заменяет встроенный инструмент Bun, — строка ❌ с пакетом, заменой и шагом: задача проекта на переход, а не правка в текущей сессии", () => {
    writePkg({ packageManager: "bun@1.4.3", workspaces: ["packages/*"], dependencies: { pg: "^8.16.0", zod: "^4.1.0" }, devDependencies: { dotenv: "^17.2.0" } });
    writeTree(sb.proj, { "packages/api/package.json": JSON.stringify({ name: "@x/api", dependencies: { ioredis: "^5.8.0" }, optionalDependencies: { "@aws-sdk/client-s3": "^3.900.0" } }) });
    expect(elves(sb, ["install"]).code).toBe(0);
    const before = snapshot(sb.proj);
    const r = elves(sb, ["check"]);
    expect(r.code).toBe(1);
    expect(builtinLines(r.stdout)).toEqual([
      BUILTIN("package.json", "pg", "dependencies", ...SQL),
      BUILTIN("package.json", "dotenv", "devDependencies", ...ENV),
      BUILTIN("packages/api/package.json", "@aws-sdk/client-s3", "optionalDependencies", "Bun.s3", "https://bun.com/docs/runtime/s3"),
      BUILTIN("packages/api/package.json", "ioredis", "dependencies", ...REDIS),
    ]);
    expect(r.stdout).toEndWith(MODE_ASK);
    expect(snapshot(sb.proj)).toEqual(before);
  });

  it("Таблица замен — одна на проверку и справку, по документации Bun: например `pg`, `postgres`, `mysql2` → `Bun.sql`; `better-sqlite3` → `bun:sqlite`; `@aws-sdk/client-s3` → `Bun.s3`; `ioredis`, `redis` → `Bun.redis`; `dotenv` → чтение `.env` самим Bun; каждая строка таблицы — со ссылкой на страницу документации", () => {
    // справка — правило Claude Code, которое грузится с package.json: агент видит таблицу, когда добавляет зависимость
    expect(readFileSync(path.join(REPO, "docs/bun.md"), "utf8")).toStartWith('---\npaths:\n  - "**/package.json"\n---\n');
    const rows = replacements();
    const all = rows.flatMap((r) => r.packages);
    expect(Object.fromEntries(rows.flatMap((r) => r.packages.map((p) => [p, r.builtin])))).toMatchObject({
      pg: "Bun.sql",
      postgres: "Bun.sql",
      mysql2: "Bun.sql",
      "better-sqlite3": "bun:sqlite",
      "@aws-sdk/client-s3": "Bun.s3",
      ioredis: "Bun.redis",
      redis: "Bun.redis",
      dotenv: "reading .env files",
    });
    // пакет — в одной строке, у каждой строки — замена и страница документации Bun
    expect(new Set(all).size).toBe(all.length);
    for (const row of rows) {
      expect(row.packages.length).toBeGreaterThan(0);
      expect(row.builtin).not.toBe("");
      expect(row.docs).toMatch(/^https:\/\/bun\.com\/docs\/[a-z]/);
    }
    // check читает ту же таблицу: каждый её пакет — строка ❌ с заменой и страницей своей строки, в порядке таблицы
    writePkg({ dependencies: Object.fromEntries(all.map((p) => [p, "^1.0.0"])) });
    expect(elves(sb, ["install"]).code).toBe(0);
    const r = elves(sb, ["check"]);
    expect(r.code).toBe(1);
    expect(builtinLines(r.stdout)).toEqual(rows.flatMap((row) => row.packages.map((p) => BUILTIN("package.json", p, "dependencies", row.builtin, row.docs))));
  });

  it("Пакет проекта с `next` в зависимостях — исключение: его замены — строка ○ с причиной, без ❌", () => {
    const web = { name: "@x/web", dependencies: { next: "^16.0.0", pg: "^8.16.0", ioredis: "^5.8.0" }, devDependencies: { dotenv: "^17.2.0" } };
    // только пакет Next.js — строки ○, check проходит
    writePkg({ workspaces: ["packages/*"] });
    writeTree(sb.proj, { "packages/web/package.json": JSON.stringify(web) });
    expect(elves(sb, ["install"]).code).toBe(0);
    const r = elves(sb, ["check"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toStartWith("Elves in the project: up to date (");
    const keeps = [
      NEXT_KEEPS("packages/web/package.json", "pg", "dependencies", ...SQL),
      NEXT_KEEPS("packages/web/package.json", "ioredis", "dependencies", ...REDIS),
      NEXT_KEEPS("packages/web/package.json", "dotenv", "devDependencies", ...ENV),
    ];
    expect(builtinLines(r.stdout)).toEqual(keeps);
    expect(r.stdout).not.toContain("❌");
    // исключение — пакета с next, а не проекта: тот же pg в корне без next — ❌
    fresh();
    writePkg({ workspaces: ["packages/*"], dependencies: { pg: "^8.16.0" } });
    writeTree(sb.proj, { "packages/web/package.json": JSON.stringify(web) });
    const both = elves(sb, ["check"]);
    expect(both.code).toBe(1);
    expect(builtinLines(both.stdout)).toEqual([BUILTIN("package.json", "pg", "dependencies", ...SQL), ...keeps]);
  });

  // spec-existing #909: проект без пакетов таблицы и до проверки проходил check без строк — тест держит, что она его не задевает
  it("Проект без таких зависимостей — ни одной такой строки", () => {
    // похожие имена — не пакеты таблицы: типы, обёртки, другие клиенты; пакет Next.js без них — тоже без строк
    writePkg({ workspaces: ["packages/*"], dependencies: { zod: "^4.1.0", "pg-boss": "^11.0.0", "@upstash/redis": "^1.35.0", "@aws-sdk/client-dynamodb": "^3.900.0" }, devDependencies: { "@types/pg": "^8.15.0" } });
    writeTree(sb.proj, { "packages/web/package.json": JSON.stringify({ name: "@x/web", dependencies: { next: "^16.0.0", react: "^19.2.0" } }) });
    expect(elves(sb, ["install"]).code).toBe(0);
    expect(elves(sb, ["check"])).toMatchObject({ code: 0, stdout: expect.stringMatching(UP_TO_DATE) });
  });
});

// строки раннера Playwright (#917): правило — раздел справки docs/bun.md о Playwright
const PLAYWRIGHT_RULE = "Playwright's runner runs under Bun, its specs as ES modules (~/.agents/elves/docs/bun.md)";
const NOT_MODULE = (file: string, section: string) =>
  `  ❌ ${file}: @playwright/test in ${section} without "type": "module" — Playwright under Bun loads the package's .ts specs as JavaScript, and type syntax fails ("errors building"); ${PLAYWRIGHT_RULE}; "type": "module" in ${file}, its CommonJS files — .cjs\n`;
const UNDER_NODE = (file: string, script: string) =>
  `  ❌ ${file}: the script ${script} runs playwright test under Node, by its bin's shebang — the config, fixtures and factories don't get Bun's built-ins; ${PLAYWRIGHT_RULE}; bun --bun playwright test\n`;
// строки вывода check с правилом раннера Playwright
const playwrightLines = (stdout: string) => stdout.split("\n").filter((l) => l.includes(PLAYWRIGHT_RULE)).map((l) => l + "\n");
const PLAYWRIGHT_DEP = { "@playwright/test": "^1.63.0" };

/**
 * Спек Playwright с синтаксисом типов, которому нужны встроенные инструменты Bun: `Bun.sql` вместо `pg` и `.env`,
 * прочитанный самим Bun, вместо `dotenv` (эпик #906, п. 2 дизайна).
 */
const TYPED_SPEC = [
  'import { expect, test } from "@playwright/test";',
  "",
  'test("спек с синтаксисом типов видит встроенные инструменты Bun", () => {',
  '  const runtime: string = (globalThis as { Bun?: unknown }).Bun ? "bun" : "node";',
  '  expect(runtime).toBe("bun");',
  '  expect(typeof Bun.sql).toBe("function");',
  '  expect(process.env.E2E_FROM_DOTENV).toBe("from .env");',
  "});",
  "",
].join("\n");

/**
 * `bun --bun playwright test` — команда правила — во временном проекте с этим спеком: Playwright — из devDependencies
 * Elves (`node_modules` проекта — ссылка на них), кэш трансформаций — свой, без браузера.
 */
function playwrightUnderBun(pkg: Record<string, unknown>): { code: number | null; output: string } {
  const { dir, cleanup } = tmpDir();
  try {
    writeTree(dir, { "package.json": JSON.stringify({ name: "e2e", private: true, ...pkg }), "playwright.config.ts": 'export default { testDir: "e2e" };\n', ".env": "E2E_FROM_DOTENV=from .env\n", "e2e/typed.spec.ts": TYPED_SPEC });
    symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
    const env = { ...process.env, PWTEST_CACHE_DIR: path.join(dir, ".playwright-cache"), CI: "1" };
    const r = spawnSync(process.execPath, ["--bun", "playwright", "test", "--reporter=line"], { cwd: dir, encoding: "utf8", env });
    return { code: r.status, output: (r.stdout ?? "") + (r.stderr ?? "") };
  } finally {
    cleanup();
  }
}

/**
 * Браузерного раннера у Bun нет — e2e идут на Playwright, но его раннер идёт под Bun (`bun --bun`; эпик #906, п. 2
 * дизайна, #917): под Node по шебангу его bin конфиг, фикстуры и фабрики данных не видят встроенных инструментов Bun, и
 * пакет с `@playwright/test` держал бы `pg` и `dotenv` без возможной замены. Исключения для него нет — исключение стека
 * только Next.js. Держит это `check`: пакет с `@playwright/test` — `"type": "module"` (спеки CommonJS Playwright под Bun
 * грузит без снятия типов), а его скрипты запускают `playwright test` под `bun --bun`.
 */
describe("check проекта держит раннер Playwright под Bun: пакет его спеков — ES-модули, скрипты — bun --bun", () => {
  it('`elves check` пакета с `@playwright/test` без `"type": "module"` — строка ❌ с шагом: Playwright под Bun грузит его `.ts`-спеки как JavaScript, и синтаксис типов падает', () => {
    writePkg({ workspaces: ["packages/*"], devDependencies: PLAYWRIGHT_DEP });
    writeTree(sb.proj, {
      "packages/e2e/package.json": JSON.stringify({ name: "@x/e2e", type: "commonjs", dependencies: PLAYWRIGHT_DEP }),
      // пакет ES-модулей и пакет без Playwright — без строки
      "packages/web/package.json": JSON.stringify({ name: "@x/web", type: "module", devDependencies: PLAYWRIGHT_DEP }),
      "packages/api/package.json": JSON.stringify({ name: "@x/api" }),
    });
    expect(elves(sb, ["install"]).code).toBe(0);
    const before = snapshot(sb.proj);
    const r = elves(sb, ["check"]);
    expect(r.code).toBe(1);
    expect(playwrightLines(r.stdout)).toEqual([NOT_MODULE("package.json", "devDependencies"), NOT_MODULE("packages/e2e/package.json", "dependencies")]);
    expect(r.stdout).toEndWith(MODE_ASK);
    expect(snapshot(sb.proj)).toEqual(before);
    // пакеты — ES-модули: строк нет, check проходит
    writePkg({ type: "module", workspaces: ["packages/*"], devDependencies: PLAYWRIGHT_DEP });
    writeTree(sb.proj, { "packages/e2e/package.json": JSON.stringify({ name: "@x/e2e", type: "module", dependencies: PLAYWRIGHT_DEP }) });
    expect(elves(sb, ["check"])).toMatchObject({ code: 0, stdout: expect.stringMatching(UP_TO_DATE) });
  });

  it("Скрипт пакета с `@playwright/test`, который запускает `playwright test` не под `bun --bun`, — строка ❌ с шагом; под `bun --bun` и `bunx --bun` — без строки, в обёртке slot тоже", () => {
    writePkg({
      type: "module",
      scripts: {
        "test:e2e": "playwright test",
        e2e: "bunx playwright test --project=chromium",
        "e2e:list": "PLAYWRIGHT_JSON_OUTPUT_NAME=.spec-playwright.json node_modules/.bin/playwright test --list --reporter=json",
        "test:browser": "bun --bun playwright test",
        "e2e:ui": "bunx --bun playwright test --ui",
        "e2e:ci": "bun run build && bun --bun x playwright test --reporter=dot",
        // другие команды bin кода проекта не грузят
        "e2e:trace": "bunx playwright show-trace trace.zip",
        "e2e:browsers": "bunx playwright install --with-deps",
      },
      devDependencies: PLAYWRIGHT_DEP,
    });
    // install оборачивает test:* в шим slot — строка та же, команда под ним
    expect(elves(sb, ["install"]).code).toBe(0);
    expect(JSON.parse(read(path.join(sb.proj, "package.json"))).scripts).toMatchObject({ "test:e2e": ". .agents/slot.sh && playwright test", "test:browser": ". .agents/slot.sh && bun --bun playwright test" });
    const r = elves(sb, ["check"]);
    expect(r.code).toBe(1);
    expect(playwrightLines(r.stdout)).toEqual([UNDER_NODE("package.json", "test:e2e"), UNDER_NODE("package.json", "e2e"), UNDER_NODE("package.json", "e2e:list")]);
    // строка slot прошлой установки — команда в кавычках: под bun --bun — без строки, без него — строка
    writePkg({ type: "module", scripts: { "test:e2e": "elves slot 'bun --bun playwright test'", "test:smoke": "elves slot 'playwright test --grep @smoke'" }, devDependencies: PLAYWRIGHT_DEP });
    expect(playwrightLines(elves(sb, ["check"]).stdout)).toEqual([UNDER_NODE("package.json", "test:smoke")]);
  });

  // spec-existing #917: исключения для пакета с @playwright/test у проверки #909 не было — тест держит, что его и нет
  it("Пакет с `@playwright/test` — не исключение: его `pg` и `dotenv` — строки ❌, как в любом пакете; исключение стека — только пакет с `next`", () => {
    writePkg({ type: "module", scripts: { "test:e2e": "bun --bun playwright test" }, devDependencies: { ...PLAYWRIGHT_DEP, pg: "^8.16.0", dotenv: "^17.2.0" } });
    expect(elves(sb, ["install"]).code).toBe(0);
    const r = elves(sb, ["check"]);
    expect(r.code).toBe(1);
    expect(builtinLines(r.stdout)).toEqual([BUILTIN("package.json", "pg", "devDependencies", ...SQL), BUILTIN("package.json", "dotenv", "devDependencies", ...ENV)]);
    expect(playwrightLines(r.stdout)).toEqual([]);
  });

  /**
   * Почему пакет спеков — ES-модули: Playwright под Bun своего загрузчика не ставит и `.ts` пакета CommonJS отдаёт
   * загрузчику `.js` (замер — Playwright 1.63, Bun 1.4): Bun разбирает спек как JavaScript, «N errors building», ни одного
   * теста. ES-модуль Bun грузит сам и типы снимает. Playwright, починивший загрузку CommonJS под Bun, сделал бы тест
   * красным — тогда строка `"type": "module"` больше не нужна.
   */
  // spec-existing #917: поведение Playwright под Bun, а не кода Elves — тест держит причину строки ❌
  it('Раннер Playwright под Bun (`bun --bun playwright test`) в пакете `"type": "module"` грузит спек с синтаксисом типов, и тот видит `Bun.sql` и `.env`; в пакете CommonJS тот же спек не грузится — «errors building»', () => {
    const esm = playwrightUnderBun({ type: "module" });
    expect(esm.output).toContain("1 passed");
    expect(esm.code).toBe(0);
    const cjs = playwrightUnderBun({});
    expect(cjs.output).toContain("errors building");
    expect(cjs.output).not.toContain("passed");
    expect(cjs.code).not.toBe(0);
  });
});

describe("Копия на машине (-g) сверяется и обновляется так же — вместе с хуком SessionStart", () => {
  beforeEach(() => mkdirSync(path.join(sb.home, ".claude")));

  it("поставлено из того же Elves — актуально, код 0", () => {
    elves(sb, ["install", "-g"]);
    const r = elves(sb, ["check", "-g"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("on the machine: up to date");
  });

  it("Elves ушёл вперёд (новое правило, новый скилл) — check -g называет отставание канона и скиллов, код 1, ничего не меняет; update -g доводит канон, скиллы и хук машины до актуального", () => {
    elves(sb, ["install", "-g"]);
    const before = snapshot(sb.home);
    const r = elves(sb, ["check", "-g"], { bin: newer.bin });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`on the machine: behind — installed ${short(git(REPO, "rev-parse", "HEAD"))}, latest ${short(newer.sha)}`);
    expect(r.stdout).toContain("~ ~/.agents/elves/AGENTS.md");
    expect(r.stdout).toContain("+ ~/.agents/elves/skills/fresh/SKILL.md");
    expect(r.stdout).toContain("+ ~/.agents/skills/fresh\n");
    expect(r.stdout).toContain("bunx @miroshnik/elves update -g");
    expect(snapshot(sb.home)).toEqual(before);
    expect(elves(sb, ["update", "-g"], { bin: newer.bin }).code).toBe(0);
    expect(read(path.join(sb.home, ".claude/rules/elves.md"))).toContain("Новое правило.");
    expect(existsSync(path.join(sb.home, ".agents/skills/fresh"))).toBe(true);
    expect(existsSync(path.join(sb.home, ".claude/skills/elves/skills/fresh/SKILL.md"))).toBe(true);
    expect(existsSync(path.join(sb.home, ".agents/skills/ci-wait"))).toBe(false);
    expect(existsSync(path.join(sb.home, ".claude/skills/elves/skills/ci-wait"))).toBe(false);
    expect(JSON.parse(read(manifest(sb.home))).sha).toBe(newer.sha);
    expect(elves(sb, ["check", "-g"], { bin: newer.bin }).code).toBe(0);
  });

  /** Машина прошлого релиза: скиллы и хук, канона нет (#180) — канон на машине теперь часть установки (#557). */
  it("поставлено релизом без канона на машине — отстаёт: в списке канон и правила Claude Code; update -g их ставит", () => {
    elves(sb, ["install", "-g"]);
    for (const rel of [".agents/elves", ".claude/rules"]) rmSync(path.join(sb.home, rel), { recursive: true });
    const r = elves(sb, ["check", "-g"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("+ ~/.agents/elves/\n");
    expect(r.stdout).toContain("+ ~/.claude/rules/elves.md\n");
    expect(r.stdout).toContain("+ ~/.claude/rules/elves-claude.md\n");
    expect(elves(sb, ["update", "-g"]).code).toBe(0);
    expect(read(path.join(sb.home, ".claude/rules/elves.md"))).toBe(read(path.join(REPO, "AGENTS.md")));
    expect(elves(sb, ["check", "-g"]).code).toBe(0);
  });

  /**
   * Машина прошлой версии — до плагина (#860): копии скиллов в `~/.agents/skills`, ссылка на каждый в `~/.claude/skills`
   * и хуки в `~/.claude/settings.json`, в том числе хук ещё старше — через npx и с запасным текстом по-русски. Плагин
   * несёт и скиллы, и хуки: оставшись рядом с ним, хук сработал бы дважды, а скилл был бы и `spec`, и `elves:spec`.
   * Свои ссылки и хуки обновление узнаёт по цели и команде; хуки пользователя — и в той же группе — и чужие ссылки (так
   * `npx skills` ставит свои скиллы) остаются.
   */
  it("Обновление машины снимает прежние ссылки скиллов и хуки Эльфов, чужие хуки остаются", () => {
    elves(sb, ["install", "-g"]);
    // машина прошлой версии: копии скиллов, ссылки Claude Code на них, хуки в настройках
    rmSync(path.join(sb.home, ".claude/skills/elves"));
    for (const s of SKILLS) {
      rmSync(path.join(sb.home, ".agents/skills", s));
      cpSync(path.join(REPO, "skills", s), path.join(sb.home, ".agents/skills", s), { recursive: true });
      symlinkSync(`../../.agents/skills/${s}`, path.join(sb.home, ".claude/skills", s));
    }
    writeTree(sb.home, { ".agents/skills/find-skills/SKILL.md": "свой скилл\n" });
    symlinkSync("../../.agents/skills/find-skills", path.join(sb.home, ".claude/skills/find-skills"));
    const old = previousHooks(sb.home, BYPASSES.map((b) => b.rule).slice(0, 1));
    const npx = { type: "command", command: 'npx -y --loglevel=error github:miroshnik/elves check --hook 2>&1 || echo "elves check недоступен (код $?): работай по текущему флоу и скажи об этом"', timeout: 60 };
    const mine = { type: "command", command: "echo мой хук" };
    const file = path.join(sb.home, ".claude/settings.json");
    writeFileSync(file, JSON.stringify({ model: "opus", hooks: { SessionStart: [{ ...old.SessionStart, hooks: [...old.SessionStart.hooks, mine] }, { hooks: [npx] }], PreToolUse: [old.PreToolUse], Stop: [{ hooks: [mine] }] } }, null, 2) + "\n");
    const r = elves(sb, ["check", "-g"]);
    expect(r.code).toBe(1);
    for (const s of SKILLS) expect(r.stdout).toContain(`  - ~/.claude/skills/${s} — a skill link of a previous version: the Elves plugin gives elves:${s}\n`);
    expect(r.stdout).toContain("  ~ ~/.claude/settings.json — the SessionStart and PreToolUse hooks of a previous version");
    expect(r.stdout).not.toContain("find-skills");

    const u = elves(sb, ["update", "-g"]);
    expect(u.code).toBe(0);
    expect(u.stdout).toContain(".claude/settings.json — removed the SessionStart and PreToolUse hooks of a previous version");
    expect(readdirSync(path.join(sb.home, ".claude/skills")).sort()).toEqual(["elves", "find-skills"]);
    for (const s of SKILLS) expect(readlinkSync(path.join(sb.home, ".agents/skills", s))).toBe(`../elves/skills/${s}`);
    expect(read(path.join(sb.home, ".agents/skills/find-skills/SKILL.md"))).toBe("свой скилл\n");
    expect(JSON.parse(read(file))).toEqual({ model: "opus", hooks: { SessionStart: [{ matcher: old.SessionStart.matcher, hooks: [mine] }], Stop: [{ hooks: [mine] }] } });
    expect(elves(sb, ["check", "-g"]).code).toBe(0);
  });

  /**
   * Причина в строке о снятой ссылке скилла (#879) — то, что агент пересказывает пользователю после обновления: скилл
   * выпуска плагин даёт как `elves:<имя>`, а скилла, которого в выпуске нет, не даёт и плагин — причина та же, что у его
   * каталога `.agents/skills/<имя>`. Так же — в списке `check -g`. Выпуск — `newer`: скилла ci-wait в нём нет.
   */
  function previousLinks(...names: string[]) {
    elves(sb, ["install", "-g"]);
    // машина прошлой версии: до плагина каждый скилл ставился своей ссылкой в ~/.claude/skills
    for (const s of names) symlinkSync(`../../.agents/skills/${s}`, path.join(sb.home, ".claude/skills", s));
  }

  it("update -g убирает ссылку скилла, которого нет в выпуске, с причиной «Elves no longer has it», а не «the Elves plugin gives»", () => {
    previousLinks("ci-wait");
    const r = elves(sb, ["check", "-g"], { bin: newer.bin });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("  - ~/.claude/skills/ci-wait — a skill link of a previous version: Elves no longer has it\n");
    const u = elves(sb, ["update", "-g"], { bin: newer.bin });
    expect(u.code).toBe(0);
    expect(u.stdout).toContain(".claude/skills/ci-wait — removed: Elves no longer has it\n");
    expect(r.stdout + u.stdout).not.toContain("elves:ci-wait");
    expect(readdirSync(path.join(sb.home, ".claude/skills"))).toEqual(["elves"]);
  });

  // spec-existing #879: страховка от перекоррекции — причина у скилла выпуска была верной и до PR и остаётся прежней
  it("update -g убирает ссылку скилла выпуска с причиной «the Elves plugin gives elves:<name>»", () => {
    previousLinks("spec");
    const r = elves(sb, ["check", "-g"], { bin: newer.bin });
    expect(r.stdout).toContain("  - ~/.claude/skills/spec — a skill link of a previous version: the Elves plugin gives elves:spec\n");
    const u = elves(sb, ["update", "-g"], { bin: newer.bin });
    expect(u.code).toBe(0);
    expect(u.stdout).toContain(".claude/skills/spec — removed: the Elves plugin gives elves:spec\n");
    expect(readdirSync(path.join(sb.home, ".claude/skills"))).toEqual(["elves"]);
  });

  it("старая установка без SHA и без плагина — отстаёт; update -g ставит плагин и пишет SHA", () => {
    elves(sb, ["install", "-g"]);
    dropSha(sb.home);
    rmSync(path.join(sb.home, ".claude/skills/elves"));
    const r = elves(sb, ["check", "-g"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("installed without SHA");
    expect(r.stdout).toContain("+ ~/.claude/skills/elves — the Elves plugin");
    expect(elves(sb, ["update", "-g"]).code).toBe(0);
    expect(readlinkSync(path.join(sb.home, ".claude/skills/elves"))).toBe("../../.agents/elves");
    expect(JSON.parse(read(manifest(sb.home))).sha).toBe(git(REPO, "rev-parse", "HEAD"));
    expect(elves(sb, ["check", "-g"]).code).toBe(0);
  });

  /**
   * Команда elves машины (#632): её нет — машина отстала, `update -g` её ставит; другой `elves` раньше по PATH —
   * терминал зовёт его, а не команду машины: строка `!`, отставанием не считается — это настройка пользователя.
   */
  it("check -g называет отсутствующую команду elves или ведущую не туда", () => {
    const other = path.join(sb.tmp, "other");
    mkdirSync(other);
    const env = { PATH: `${other}:${path.join(sb.home, ".local/bin")}:${sb.bin}` };
    const command = path.join(sb.home, ".local/bin/elves");
    expect(elves(sb, ["install", "-g"], { env }).code).toBe(0);
    expect(existsSync(command)).toBe(true);
    const fresh = elves(sb, ["check", "-g"], { env });
    expect(fresh.code).toBe(0);
    expect(fresh.stdout).not.toContain("elves command");
    rmSync(command);
    const before = snapshot(sb.home);
    const missing = elves(sb, ["check", "-g"], { env });
    expect(missing.code).toBe(1);
    expect(missing.stdout).toContain("  + ~/.local/bin/elves — the elves command in the terminal\n");
    expect(missing.stdout).toContain("Update: bunx @miroshnik/elves update -g");
    expect(snapshot(sb.home)).toEqual(before);
    expect(elves(sb, ["update", "-g"], { env }).code).toBe(0);
    expect(existsSync(command)).toBe(true);
    expect(elves(sb, ["check", "-g"], { env }).code).toBe(0);
    writeFileSync(path.join(other, "elves"), "#!/bin/sh\necho другой elves\n", { mode: 0o755 });
    const shadowed = elves(sb, ["check", "-g"], { env });
    expect(shadowed.code).toBe(0);
    expect(shadowed.stdout).toContain(`  ! ${path.join(other, "elves")} — comes first on PATH: elves runs it, not ~/.local/bin/elves — remove it or put ~/.local/bin before ${other} in PATH\n`);
  });

  /**
   * bunx кладёт в `.bin` пакета относительную ссылку `../elves/bin/elves.ts`: `node_modules` в её строке нет, он в
   * разрешённом пути (#642). Хук SessionStart идёт через bunx — его `.bin` первым в PATH не делает машину отставшей.
   */
  it("check -g: elves из .bin пакета bunx — относительная ссылка на bin/elves.ts — не команда машины, машина не отстаёт", () => {
    const local = path.join(sb.home, ".local/bin");
    expect(elves(sb, ["install", "-g"], { env: { PATH: `${local}:${sb.bin}` } }).code).toBe(0);
    const modules = path.join(sb.tmp, "bunx-1/node_modules");
    mkdirSync(path.join(modules, "elves/bin"), { recursive: true });
    mkdirSync(path.join(modules, ".bin"));
    writeFileSync(path.join(modules, "elves/bin/elves.ts"), "// пакет bunx\n", { mode: 0o755 });
    symlinkSync("../elves/bin/elves.ts", path.join(modules, ".bin/elves"));
    const c = elves(sb, ["check", "-g"], { env: { PATH: `${path.join(modules, ".bin")}:${local}:${sb.bin}` } });
    expect(c.stdout).not.toContain("elves command");
    expect(c.stdout).not.toContain("comes first on PATH");
    expect(c.stdout).not.toContain("behind");
    expect(c.code).toBe(0);
  });
});

// Elves с релизами: upstream — git-репозиторий, откуда установщик берёт теги (ELVES_REPO); bunx песочницы отдаёт
// пакеты его коммитов — пускатель из main по `github:miroshnik/elves` и пакет каждого коммита по его SHA
function withReleases() {
  const up = copyPackage(base, path.join(sb.tmp, "upstream"));
  const pkgs = path.join(sb.tmp, "bunx");
  bunxServesPackages(sb, pkgs);
  const head = () => up.repo.git("rev-parse", "HEAD");
  const serveMain = () => {
    rmSync(path.join(pkgs, "main"), { recursive: true, force: true });
    bunxPackage(path.join(pkgs, head()), up.dir, head());
    return bunxPackage(path.join(pkgs, "main"), up.dir, null);
  };
  const bin = serveMain();
  return {
    up,
    /** пускатель bunx — пакет из main, каким его запускает `bunx github:miroshnik/elves` */
    bin,
    /** коммит в main upstream: bunx теперь отдаёт его */
    commit(files: Record<string, string | null>, message?: string) {
      const sha = up.repo.commit(files, message);
      serveMain();
      return sha;
    },
    /** пункты списка изменений, который `release --dry-run` владельца выпустил бы сейчас в GitHub Release */
    notes() {
      const clone = path.join(sb.tmp, "owner");
      if (!existsSync(clone)) git(sb.tmp, "clone", "-q", up.dir, clone);
      const r = elves(sb, ["release", "--dry-run"], { bin: path.join(clone, "bin/elves.ts") });
      expect(r.code).toBe(0);
      return r.stdout.split("\n").filter((l) => l.startsWith("- "));
    },
    /** релиз — тег на голову main (annotated — аннотированный); пакет его коммита bunx уже отдаёт по SHA */
    release(tag: string, { annotated = false } = {}) {
      const sha = head();
      if (annotated) up.repo.git("-c", "user.email=spec@example.test", "-c", "user.name=spec", "tag", "-a", "-m", tag, tag);
      else up.repo.git("tag", tag);
      return sha;
    },
    /** установщик — пускатель из main */
    run: (args: string[], env: Record<string, string> = {}) => elves(sb, args, { bin, env: { ELVES_REPO: up.dir, ...env } }),
  };
}

/**
 * Проект версией пакета и машина копией следуют за релизами Elves (теги vГГГГ.ММ.ДД), а не за main: коммит в main без
 * релиза их «отставшими» не делает. bunx ставит пакет из main один раз и дальше берёт его из кеша — он только пускатель:
 * находит последний релиз и перезапускается по его SHA, дальше и код, и файлы релиза, а проект получает его версию в npm.
 */
describe("Версия пакета проекта и копия на машине следуют за релизами Elves, а не за main", () => {
  const rule = (up: ElvesPackage, text: string) => ({ "AGENTS.md": read(path.join(up.dir, "AGENTS.md")) + `\n${text}\n` });

  it("install ставит проекту версию пакета последнего релиза, а не головы main", () => {
    const r = withReleases();
    r.release("v2026.10.05");
    r.commit(rule(r.up, "Правило из main."));
    writePkg({});
    expect(r.run(["install"]).code).toBe(0);
    expect(pinned()).toBe("2026.1005.0");
  });

  it("main ушёл вперёд, нового релиза нет — актуально, код 0", () => {
    const r = withReleases();
    r.release("v2026.10.05");
    writePkg({});
    r.run(["install"]);
    r.commit(rule(r.up, "Правило из main."));
    const c = r.run(["check"]);
    expect(c.code).toBe(0);
    expect(c.stdout).toContain("in the project: up to date (v2026.10.05)");
  });

  it("вышел релиз новее установленного — отстаёт, код 1: стоящий и свежий тег, версия пакета; check ничего не меняет", () => {
    const r = withReleases();
    r.release("v2026.10.05");
    writePkg({});
    r.run(["install"]);
    r.commit(rule(r.up, "Правило релиза."));
    r.release("v2026.10.12");
    const before = snapshot(sb.proj);
    const c = r.run(["check"]);
    expect(c.code).toBe(1);
    expect(c.stdout).toContain("in the project: behind — installed v2026.10.05, latest v2026.10.12");
    expect(c.stdout).toContain("  ~ package.json — @miroshnik/elves 2026.1005.0 → 2026.1012.0\n");
    expect(snapshot(sb.proj)).toEqual(before);
  });

  it("update ставит версию последнего релиза, а не головы main; подсказка коммита — с тегом; после него check — актуально", () => {
    const r = withReleases();
    r.release("v2026.10.05");
    writePkg({});
    r.run(["install"]);
    r.commit(rule(r.up, "Правило релиза."));
    r.release("v2026.10.12");
    r.commit(rule(r.up, "Правило из main."));
    const u = r.run(["update"]);
    expect(u.code).toBe(0);
    // проект на en (install без флага и терминала): описание коммита — по-английски
    expect(u.stdout).toContain("chore(agents): Elves flow v2026.10.12");
    expect(pinned()).toBe("2026.1012.0");
    expect(r.run(["check"]).code).toBe(0);
  });

  /** Аннотированный тег ls-remote отдаёт объектом тега — ставится коммит, на который он указывает. */
  it("последний релиз — по дате, затем по номеру патча; аннотированный тег — его коммит; чужие теги не в счёт", () => {
    const r = withReleases();
    r.release("v2026.10.05");
    r.commit(rule(r.up, "Патч."));
    const sha = r.release("v2026.10.05.1", { annotated: true });
    r.commit({ "skills/fresh/SKILL.md": "---\nname: fresh\ndescription: из main\n---\n" });
    r.release("v2026.09.30");
    r.up.repo.git("tag", "v9.0.0");
    writePkg({});
    r.run(["install"]);
    expect(pinned()).toBe("2026.1005.1");
    r.run(["install", "-g"]);
    expect(JSON.parse(read(manifest(sb.home)))).toMatchObject({ tag: "v2026.10.05.1", sha });
    expect(existsSync(path.join(sb.home, ".agents/skills/fresh"))).toBe(false);
  });

  it("машина копией (-g) — тоже по релизам: main ушёл вперёд — актуально", () => {
    mkdirSync(path.join(sb.home, ".claude"));
    const r = withReleases();
    r.release("v2026.10.05");
    expect(r.run(["install", "-g"]).code).toBe(0);
    r.commit(rule(r.up, "Правило из main."));
    const c = r.run(["check", "-g"]);
    expect(c.code).toBe(0);
    expect(c.stdout).toContain("on the machine: up to date (v2026.10.05)");
    expect(JSON.parse(read(manifest(sb.home))).tag).toBe("v2026.10.05");
  });

  /** Пускатель из кеша bunx старше main: по SHA головы ставится свежий main, а не он сам; версии в npm у main нет. */
  it("релизов ещё нет — пускатель перезапускается по SHA головы main: её файлы и SHA, без тега; версию пакета проекту не ставит", () => {
    const r = withReleases();
    const sha = r.commit({ "skills/fresh/SKILL.md": "---\nname: fresh\ndescription: из main\n---\n" });
    expect(r.run(["install", "-g"]).code).toBe(0);
    expect(existsSync(path.join(sb.home, ".agents/skills/fresh/SKILL.md"))).toBe(true);
    const m = JSON.parse(read(manifest(sb.home)));
    expect(m.sha).toBe(sha);
    expect(m.tag).toBeUndefined();
    writePkg({});
    const p = r.run(["install"]);
    expect(p.code).toBe(0);
    expect(p.stderr).toContain("@miroshnik/elves isn't added: this installer isn't a release");
    expect(pinned()).toBeUndefined();
  });

  /**
   * Пускатель в кеше bunx старше релиза: флаг или команду, которые появились позже, он сам бы отверг. Поэтому он
   * перезапускается до проверки команды и флагов.
   */
  it("устаревший пускатель не отвергает флаг, который знает релиз: перезапуск — до проверки флагов", () => {
    const r = withReleases();
    r.release("v2026.10.05");
    const text = read(r.bin);
    const stale = text.replace('"--auto", "--no-auto"]', '"--auto"]');
    expect(stale).not.toBe(text);
    writeFileSync(r.bin, stale);
    writePkg({});
    expect(r.run(["install", "--no-auto"]).code).toBe(0);
    expect(JSON.parse(read(manifest(sb.proj))).auto).toBe(false);
    expect(pinned()).toBe("2026.1005.0");
  });

  it("последний релиз не узнать (нет сети) — check: проверка недоступна, код 2; install и update — отказ, код 2; флоу не стоит — релиз не ищет", () => {
    const r = withReleases();
    const offline = { ELVES_REPO: path.join(sb.tmp, "nowhere") };
    const absent = r.run(["check"], offline);
    expect(absent.code).toBe(0);
    expect(absent.stdout).toContain("in the project: not installed");
    r.release("v2026.10.05");
    r.run(["install"]);
    const before = snapshot(sb.proj);
    const c = r.run(["check"], offline);
    expect(c.code).toBe(2);
    expect(c.stderr).toContain("in the project: check unavailable — can't find out the latest Elves release");
    for (const cmd of ["install", "update"]) {
      const u = r.run([cmd], offline);
      expect(u.code).toBe(2);
      expect(u.stderr).toContain("can't find out the latest Elves release");
    }
    expect(snapshot(sb.proj)).toEqual(before);
  });

  it("хук: последний релиз не узнать — код 0, в выводе — проверка недоступна", () => {
    const r = withReleases();
    r.release("v2026.10.05");
    r.run(["install"]);
    const h = r.run(["check", "--hook"], { ELVES_REPO: path.join(sb.tmp, "nowhere") });
    expect(h.code).toBe(0);
    expect(h.stdout).toContain("in the project: check unavailable — can't find out the latest Elves release");
  });
});

/**
 * Пакет из npm — `npm i -g`, `bun add -g` — сам релиз (#557): его версия — тег релиза (`ГГГГ.ММДД.N` ↔
 * `vГГГГ.ММ.ДД.N`), коммит — `gitHead`, который пишет `elves pack`. SHA в спецификаторе у него нет, и без этого
 * установщик счёл бы себя пускателем из main и перезапустился бы через `bunx github:` — установка шла бы из архива
 * GitHub, а не из npm, и по сети. `check` и `update` сверяют с последним релизом и
 * перезапускаются пакетом его версии из npm.
 */
describe("Пакет из npm — сам релиз: install -g ставит его версию, check -g и update -g — по последнему релизу пакета", () => {
  const rule = (up: ElvesPackage, text: string) => ({ "AGENTS.md": read(path.join(up.dir, "AGENTS.md")) + `\n${text}\n` });
  beforeEach(() => mkdirSync(path.join(sb.home, ".claude")));

  // ни GitHub, ни bunx: релиз установщик узнаёт только по самому пакету
  it("install -g из пакета npm ставит релиз своей версии, без перезапуска через bunx github:", () => {
    const r = withReleases();
    const sha = r.release("v2026.10.05");
    const bin = npmPackage(path.join(sb.tmp, "global"), r.up.dir, "2026.1005.0", sha);
    r.commit(rule(r.up, "Правило релиза."));
    r.release("v2026.10.12");
    rmSync(path.join(sb.bin, "bunx"));
    const u = elves(sb, ["install", "-g"], { bin, env: { ELVES_REPO: path.join(sb.tmp, "nowhere") } });
    expect(u).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(read(manifest(sb.home)))).toMatchObject({ tag: "v2026.10.05", sha });
    expect(read(path.join(sb.home, ".claude/rules/elves.md"))).not.toContain("Правило релиза.");
  });

  // машина поставлена глобальным пакетом v2026.10.05, вышел v2026.10.12 с новым правилом и скиллом — его пакет есть в
  // npm; env — окружение установщика сверх песочницы
  function behindLatest(env: Record<string, string> = {}) {
    const r = withReleases();
    const from = r.release("v2026.10.05");
    const bin = npmPackage(path.join(sb.tmp, "global"), r.up.dir, "2026.1005.0", from);
    const run = (args: string[]) => elves(sb, args, { bin, env: { ELVES_REPO: r.up.dir, ...env } });
    expect(run(["install", "-g"]).code).toBe(0);
    r.commit({ ...rule(r.up, "Правило релиза."), "skills/fresh/SKILL.md": "---\nname: fresh\ndescription: новый скилл\n---\n" }, "feat(agents): правило релиза\n\nRefs #7");
    const to = r.release("v2026.10.12");
    npmPackage(path.join(sb.tmp, "bunx", "npm@2026.1012.0"), r.up.dir, "2026.1012.0", to);
    return { run, to };
  }

  it("check -g называет отставание машины от последнего релиза пакета", () => {
    const { run } = behindLatest();
    const before = snapshot(sb.home);
    const c = run(["check", "-g"]);
    expect(c.code).toBe(1);
    expect(c.stdout).toContain("Elves on the machine: behind — installed v2026.10.05, latest v2026.10.12\n");
    expect(c.stdout).toContain("  ~ ~/.agents/elves/AGENTS.md\n");
    expect(c.stdout).toContain("  + ~/.agents/skills/fresh\n");
    expect(snapshot(sb.home)).toEqual(before);
  });

  it("update -g доводит канон, скиллы и хук машины до последнего релиза пакета", () => {
    const { run, to } = behindLatest();
    rmSync(path.join(sb.home, ".claude/skills/elves"));
    const u = run(["update", "-g"]);
    expect(u.code).toBe(0);
    expect(u.stdout).toContain("Elves v2026.10.05 → v2026.10.12, new releases: 1 — tell the user what changed:\n");
    expect(u.stdout).toContain("  - feat(agents): правило релиза (#7)\n");
    expect(read(path.join(sb.home, ".claude/rules/elves.md"))).toContain("Правило релиза.");
    expect(existsSync(path.join(sb.home, ".claude/skills/elves/skills/fresh/SKILL.md"))).toBe(true);
    expect(JSON.parse(read(manifest(sb.home)))).toMatchObject({ tag: "v2026.10.12", sha: to });
    const again = run(["check", "-g"]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("Elves on the machine: up to date (v2026.10.12)");
  });

  /** Команда elves машины (#632) — шим на её релиз: вышел новее — шим отстаёт вместе с каноном. */
  it("update -g переписывает шим elves на новую версию", () => {
    const { run } = behindLatest({ PATH: `${path.join(sb.home, ".local/bin")}:${sb.bin}` });
    const shim = path.join(sb.home, ".local/bin/elves");
    expect(read(shim)).toContain('exec bunx --silent @miroshnik/elves@2026.1005.0 "$@"\n');
    const c = run(["check", "-g"]);
    expect(c.code).toBe(1);
    expect(c.stdout).toContain("  ~ ~/.local/bin/elves — the elves command in the terminal\n");
    expect(run(["update", "-g"]).code).toBe(0);
    expect(read(shim)).toContain('exec bunx --silent @miroshnik/elves@2026.1012.0 "$@"\n');
    expect(read(shim)).not.toContain("2026.1005.0");
    expect(run(["check", "-g"]).code).toBe(0);
  });
});

/**
 * update говорит, что поменялось: агент передаёт это пользователю. Список релиза собирает та же функция, что заметки
 * GitHub Release, — из истории git того же репозитория, где теги. Тонкий проект — от релиза своей версии пакета.
 */
describe("update называет изменения каждого пропущенного релиза", () => {
  const rule = (up: ElvesPackage, text: string) => ({ "AGENTS.md": read(path.join(up.dir, "AGENTS.md")) + `\n${text}\n` });
  const block = (tag: string, items: string[]) => [`${tag} — https://github.com/miroshnik/elves/releases/tag/${tag}`, ...items.map((i) => `  ${i}`)].join("\n");

  it("update проекта перечисляет каждый релиз после его версии пакета от нового к старому: тег, ссылка и пункты — те же, что в заметках релиза", () => {
    const r = withReleases();
    r.release("v2026.10.05");
    writePkg({});
    r.run(["install"]);
    r.commit(rule(r.up, "Правило A."), "feat(agents): правило A\n\nRefs #7");
    const a = r.notes();
    r.release("v2026.10.08");
    r.commit({ "tests/x.test.ts": "// тест\n" }, "test: только тесты");
    r.commit(rule(r.up, "Правило B."), "fix(est): правка B\n\nRefs #8");
    const b = r.notes();
    r.release("v2026.10.12");
    r.commit(rule(r.up, "Правило из main."), "feat(agents): правило из main");
    const u = r.run(["update"]);
    expect(u.code).toBe(0);
    expect(a).toEqual(["- feat(agents): правило A (#7)"]);
    expect(b).toEqual(["- fix(est): правка B (#8)"]);
    expect(u.stdout).toContain(`Elves v2026.10.05 → v2026.10.12, new releases: 2 — tell the user what changed:\n${block("v2026.10.12", b)}\n${block("v2026.10.08", a)}\nCommit it with the session's task`);
    expect(u.stdout).not.toContain("только тесты");
    expect(u.stdout).not.toContain("правило из main");
  });

  it("пропущен один релиз — один блок; ничего нового — строка, что релиз уже стоял", () => {
    const r = withReleases();
    r.release("v2026.10.05");
    writePkg({});
    r.run(["install"]);
    r.commit(rule(r.up, "Правило A."), "feat(agents): правило A");
    r.release("v2026.10.12");
    const u = r.run(["update"]);
    expect(u.stdout).toContain(`Elves v2026.10.05 → v2026.10.12, new releases: 1 — tell the user what changed:\n${block("v2026.10.12", ["- feat(agents): правило A"])}\n`);
    const again = r.run(["update"]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("Elves v2026.10.12 was already installed — nothing changed");
  });

  it("релизов ещё нет — update -g называет коммиты флоу от стоявшего SHA до новой головы", () => {
    const r = withReleases();
    const from = r.up.repo.git("rev-parse", "HEAD");
    r.run(["install", "-g"]);
    r.commit({ "tests/x.test.ts": "// тест\n" }, "test: только тесты");
    const to = r.commit(rule(r.up, "Правило A."), "feat(agents): правило A\n\nRefs #7");
    const u = r.run(["update", "-g"]);
    expect(u.code).toBe(0);
    expect(u.stdout).toContain(`Elves ${short(from)} → ${short(to)} — tell the user what changed:\n  - feat(agents): правило A (#7)\n`);
    expect(u.stdout).not.toContain("только тесты");
  });

  it("установщик из клона — коммиты флоу после последнего релиза отдельным блоком «not in a release» над релизами", () => {
    const r = withReleases();
    r.release("v2026.10.05");
    writePkg({});
    r.run(["install"]);
    r.commit(rule(r.up, "Правило A."), "feat(agents): правило A");
    r.release("v2026.10.12");
    const head = r.commit(rule(r.up, "Правило B."), "feat(agents): правило B");
    const u = elves(sb, ["update"], { bin: r.up.bin, env: { ELVES_REPO: r.up.dir } });
    expect(u.code).toBe(0);
    expect(u.stdout).toContain(`Elves v2026.10.05 → ${short(head)}, new releases: 1 — tell the user what changed:\n${short(head)} — not in a release\n  - feat(agents): правило B\n${block("v2026.10.12", ["- feat(agents): правило A"])}\n`);
  });

  it("update -g копией на машине — тот же список", () => {
    mkdirSync(path.join(sb.home, ".claude"));
    const r = withReleases();
    r.release("v2026.10.05");
    r.run(["install", "-g"]);
    r.commit(rule(r.up, "Правило A."), "feat(agents): правило A\n\nRefs #7");
    r.release("v2026.10.12");
    const u = r.run(["update", "-g"]);
    expect(u.code).toBe(0);
    expect(u.stdout).toContain(`Elves v2026.10.05 → v2026.10.12, new releases: 1 — tell the user what changed:\n${block("v2026.10.12", ["- feat(agents): правило A (#7)"])}\n`);
  });

  it("список не узнать (версии пакета нет среди релизов, версия — не релиза, на машине нет SHA) — update всё равно завершается кодом 0, строка с причиной и ссылкой на релизы", () => {
    const r = withReleases();
    r.release("v2026.10.05");
    r.commit(rule(r.up, "Правило A."), "feat(agents): правило A");
    r.release("v2026.10.12");
    writePkg({ devDependencies: { "@miroshnik/elves": "2026.1001.0" } });
    r.run(["install"]);
    writePkg({ devDependencies: { "@miroshnik/elves": "2026.1001.0" } });
    const u = r.run(["update"]);
    expect(u.code).toBe(0);
    expect(u.stdout).toContain("Elves v2026.10.01 → v2026.10.12: changes unavailable — no release v2026.10.01 among the tags; releases: https://github.com/miroshnik/elves/releases\n");
    expect(pinned()).toBe("2026.1012.0");
    writePkg({ devDependencies: { "@miroshnik/elves": "^1.0.0" } });
    expect(r.run(["update"]).stdout).toContain("Elves ^1.0.0 → v2026.10.12: changes unavailable — @miroshnik/elves ^1.0.0 isn't a release version; releases:");
    r.run(["install", "-g"]);
    dropSha(sb.home);
    const machine = r.run(["update", "-g"]);
    expect(machine.code).toBe(0);
    expect(machine.stdout).toContain("Elves v2026.10.12 → v2026.10.12: changes unavailable — installed without SHA; releases: https://github.com/miroshnik/elves/releases\n");
  });
});

describe("Клон --link сверяется с origin/main, update подтягивает его, не трогая работу пользователя", () => {
  const RULE = "\nНовое правило.\n";

  it("клон на origin/main — актуально, код 0", () => {
    linkedClone();
    const r = elves(sb, ["check", "-g"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("up to date");
  });

  it("в main новое правило и новый скилл — отстаёт, код 1: в списке и правило — канон машины ведёт в клон, — и скилл; клон и ~/.agents не тронуты", () => {
    const { up, clone } = linkedClone();
    up.repo.commit({ "AGENTS.md": read(path.join(up.dir, "AGENTS.md")) + RULE, "skills/fresh/SKILL.md": "---\nname: fresh\n---\n" });
    const head = git(clone, "rev-parse", "HEAD");
    const before = snapshot(sb.home);
    const r = elves(sb, ["check", "-g"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("~ AGENTS.md");
    expect(r.stdout).toContain("+ skills/fresh/SKILL.md");
    expect(r.stdout).toContain("bunx @miroshnik/elves update -g");
    expect(git(clone, "rev-parse", "HEAD")).toBe(head);
    expect(git(clone, "status", "--porcelain")).toBe("");
    expect(snapshot(sb.home)).toEqual(before);
  });

  it("update -g — git pull --ff-only клона и ссылки на новый скилл; после него check — актуально", () => {
    const { up, clone } = linkedClone();
    const sha = up.repo.commit({ "AGENTS.md": read(path.join(up.dir, "AGENTS.md")) + RULE, "skills/fresh/SKILL.md": "---\nname: fresh\n---\n" });
    expect(elves(sb, ["update", "-g"]).code).toBe(0);
    expect(git(clone, "rev-parse", "HEAD")).toBe(sha);
    expect(realpathSync(path.join(sb.home, ".agents/skills/fresh"))).toBe(realpathSync(path.join(clone, "skills/fresh")));
    expect(realpathSync(path.join(sb.home, ".claude/skills/elves/skills/fresh"))).toBe(realpathSync(path.join(clone, "skills/fresh")));
    expect(elves(sb, ["check", "-g"]).code).toBe(0);
  });

  it("update -g называет коммиты флоу между старой и новой головой клона, тем же форматом, что заметки релиза", () => {
    const { up, clone } = linkedClone();
    const before = git(clone, "rev-parse", "HEAD");
    up.repo.commit({ "AGENTS.md": read(path.join(up.dir, "AGENTS.md")) + RULE }, "feat(agents): новое правило\n\nRefs #9");
    const after = up.repo.commit({ "tests/x.test.ts": "// тест\n" }, "test: только тесты");
    const u = elves(sb, ["update", "-g"]);
    expect(u.code).toBe(0);
    // путь клона — из манифеста, как его записал install: настоящий, без симлинков (/tmp → /private/tmp на macOS)
    const real = realpathSync(clone);
    expect(u.stdout).toContain(`clone ${real}: ${short(before)} → ${short(after)} — tell the user what changed:\n  - feat(agents): новое правило (#9)\n`);
    expect(u.stdout).not.toContain("только тесты");
    const again = elves(sb, ["update", "-g"]);
    expect(again.stdout).toContain(`clone ${real}: ${short(after)} → ${short(after)}, the flow hasn't changed\n`);
  });

  it("коммиты в main без файлов флоу — актуально, код 0", () => {
    const { up } = linkedClone();
    up.repo.commit({ "tests/x.test.ts": "// тест\n" });
    const r = elves(sb, ["check", "-g"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("up to date");
  });

  /**
   * Напоминание владельцу в сессии клона Elves: без релиза проекты этих правок не получат. Отставанием не считается —
   * код тот же.
   */
  it("в клоне Elves: в main после последнего релиза изменения флоу — строка «not in a release» с тегом, числом и командой релиза; код 0", () => {
    const { up, clone } = linkedClone();
    up.repo.git("tag", "v2026.10.05");
    up.repo.commit({ "AGENTS.md": read(path.join(up.dir, "AGENTS.md")) + RULE });
    up.repo.commit({ "tests/x.test.ts": "// тест\n" });
    up.repo.commit({ "bin/elves.ts": read(path.join(up.dir, "bin/elves.ts")) + "// правка установщика\n" });
    expect(elves(sb, ["update", "-g"]).code).toBe(0);
    const r = elves(sb, ["check", "-g"], { cwd: clone });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("not in a release: flow commits after v2026.10.05 — 2");
    expect(r.stdout).toContain(`${path.join(clone, "bin/elves.ts")} release`);
  });

  it("в клоне Elves: всё в релизе — строки «not in a release» нет; релизов ещё нет — так и сказано", () => {
    const { up, clone } = linkedClone();
    expect(elves(sb, ["check", "-g"], { cwd: clone }).stdout).toContain("not in a release: no releases yet");
    up.repo.git("tag", "v2026.10.05");
    up.repo.commit({ "tests/x.test.ts": "// тест\n" });
    expect(elves(sb, ["check", "-g"], { cwd: clone }).stdout).not.toContain("not in a release");
  });

  /** Релиз — шаг владельца в клоне Elves; в сессии проекта строка о нём — шум в каждом старте. */
  it("в проекте вывод хука не содержит строки о невыпущенных коммитах Elves", () => {
    const { up, clone } = linkedClone();
    up.repo.git("tag", "v2026.10.05");
    up.repo.commit({ "AGENTS.md": read(path.join(up.dir, "AGENTS.md")) + RULE });
    expect(elves(sb, ["update", "-g"]).code).toBe(0);
    expect(elves(sb, ["check", "--hook"], { cwd: clone }).stdout).toContain("not in a release: flow commits after v2026.10.05 — 1");
    const r = elves(sb, ["check", "--hook"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Elves on the machine (clone");
    expect(r.stdout).not.toContain("not in a release");
    expect(elves(sb, ["check", "-g"]).stdout).not.toContain("not in a release");
  });

  it("старая установка без SHA — check по git; update -g пишет SHA клона", () => {
    const { up } = linkedClone();
    dropSha(sb.home);
    const sha = up.repo.commit({ "skills/est/new.md": "# Новый справочник скилла\n" });
    const r = elves(sb, ["check", "-g"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("+ skills/est/new.md");
    expect(elves(sb, ["update", "-g"]).code).toBe(0);
    expect(JSON.parse(read(manifest(sb.home))).sha).toBe(sha);
  });

  it("update -g: в клоне изменения в отслеживаемых файлах — отказ с причиной, код 1, клон не тронут", () => {
    const { up, clone } = linkedClone();
    up.repo.commit({ "AGENTS.md": "новое\n" });
    writeFileSync(path.join(clone, "AGENTS.md"), "моя правка\n");
    const head = git(clone, "rev-parse", "HEAD");
    const r = elves(sb, ["update", "-g"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("AGENTS.md");
    expect(git(clone, "rev-parse", "HEAD")).toBe(head);
    expect(read(path.join(clone, "AGENTS.md"))).toBe("моя правка\n");
  });

  it("update -g: неотслеживаемые файлы в клоне не мешают", () => {
    const { up, clone } = linkedClone();
    const sha = up.repo.commit({ "AGENTS.md": "новое\n" });
    writeFileSync(path.join(clone, "notes.txt"), "мои заметки\n");
    expect(elves(sb, ["update", "-g"]).code).toBe(0);
    expect(git(clone, "rev-parse", "HEAD")).toBe(sha);
    expect(read(path.join(clone, "notes.txt"))).toBe("мои заметки\n");
  });

  it("update -g: клон не на main — отказ с причиной, код 1, клон не тронут", () => {
    const { up, clone } = linkedClone();
    up.repo.commit({ "AGENTS.md": "новое\n" });
    git(clone, "switch", "-q", "-c", "feature");
    const head = git(clone, "rev-parse", "HEAD");
    const r = elves(sb, ["update", "-g"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not on main");
    expect(git(clone, "rev-parse", "HEAD")).toBe(head);
  });

  it("git fetch не удался (нет сети, нет remote) — проверка недоступна, код 2", () => {
    const { clone } = linkedClone();
    git(clone, "remote", "set-url", "origin", path.join(sb.tmp, "nowhere"));
    const r = elves(sb, ["check", "-g"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("check unavailable");
  });
});

/**
 * Хук SessionStart — плагина Elves, его ставит `install -g` (#860). Вывод хука с кодом 0 Claude Code добавляет в
 * контекст сессии, с другим — нет, поэтому код хука всегда 0, а ошибка — в выводе. Хук идёт из установленного Elves —
 * копии машины, — а она лишь пускатель: находит последний релиз (ELVES_REPO — зеркало с тегом) и перезапускается его
 * пакетом, который отдаёт bunx песочницы.
 */
describe("В начале сессии Claude Code проверка идёт сама и старт сессии не срывает", () => {
  let mirror: string;
  beforeEach(() => {
    mkdirSync(path.join(sb.home, ".claude"), { recursive: true });
    mirror = releaseMirror(path.join(sb.tmp, "releases"), "v2026.10.05");
  });

  // команда хука SessionStart плагина машины — как её запускает Claude Code (runPluginHook)
  function runHook(input?: string, env: Record<string, string> = {}) {
    const command = pluginHooks(sb.home, "SessionStart").find((h) => h.command.includes("check --hook"))!.command;
    return runPluginHook(sb, command, { input, env: { ELVES_REPO: mirror, ...env } });
  }

  // bunx песочницы отдаёт пакет bin: `bunx … github:miroshnik/elves <команда>` → `bun <bin> <команда>`
  function bunxServes(bin: string) {
    rmSync(path.join(sb.bin, "bunx"), { force: true });
    const script = `#!/bin/sh\nwhile [ "$#" -gt 0 ]; do case "$1" in github:*) shift; break ;; *) shift ;; esac; done\nexec "${process.execPath}" "${bin}" "$@"\n`;
    writeFileSync(path.join(sb.bin, "bunx"), script, { mode: 0o755 });
  }

  it("команда хука — check --hook: машина и проект одним выводом, код 0, даже когда отстаёт", () => {
    elves(sb, ["install", "-g"]);
    elves(sb, ["install"]);
    dropShim();
    bunxServes(newer.bin);
    const r = runHook();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Elves on the machine: behind");
    expect(r.stdout).toContain("Elves in the project: behind");
  });

  /**
   * Машина с `--link`: плагин — клон, и хук идёт из него. Проект следует за релизами, а клон — это main без версии
   * пакета: сверь он проект сам, отставание версии пакета не нашлось бы. Поэтому хук и из клона — пускатель: последний
   * релиз, перезапуск его пакетом с меткой ELVES_LAUNCHED — пакет, который отдаёт bunx, сам не перезапускается. Прочие
   * команды клона (`check -g` из терминала) идут его же кодом.
   */
  it("хук плагина на машине с --link — тоже по последнему релизу, прочие команды клона — его кодом", () => {
    const { clone } = linkedClone();
    expect(realpathSync(path.join(sb.home, ".claude/skills/elves"))).toBe(realpathSync(clone));
    rmSync(path.join(sb.bin, "bunx"), { force: true });
    writeFileSync(path.join(sb.bin, "bunx"), '#!/bin/sh\necho "served $* release=$ELVES_RELEASE launched=$ELVES_LAUNCHED"\n', { mode: 0o755 });
    const r = runHook();
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^served --silent github:miroshnik\/elves#[0-9a-f]{40} check --hook release=v2026\.10\.05 launched=1\n/);
    const c = elves(sb, ["check", "-g"], { bin: path.join(clone, "bin/elves.ts"), env: { ELVES_REPO: mirror } });
    expect(c.stdout).toContain("Elves on the machine (clone");
    expect(c.stdout).not.toContain("served");
  });

  /** Имя флоу — Elves, и в адресе и команде тоже (`bunx @miroshnik/elves …`): прежнего имени в выводе нет. */
  it("check называет флоу Elves", () => {
    elves(sb, ["install", "-g"]);
    elves(sb, ["install"]);
    bunxServes(base.bin);
    const project = elves(sb, ["check"]).stdout;
    const machine = elves(sb, ["check", "-g"]).stdout;
    const hook = runHook().stdout;
    expect(project).toStartWith("Elves in the project: up to date");
    expect(machine).toStartWith("Elves on the machine: up to date");
    expect(hook).toStartWith("Elves flow (AGENTS.md, «First step of a session»):\nElves on the machine: up to date");
    expect(hook).toContain("\nElves in the project: up to date");
    expect(`${project}${machine}${hook}`).not.toContain("ai-dev");
  });

  /** Машина — скиллы в ~/.agents, ветку задачи её обновление не трогает; подъём версии проекта — несколько строк, задача сессии. */
  it("хук: тонкий проект отстал — update в задаче сессии; отстала только машина — update -g в сессии", () => {
    elves(sb, ["install", "-g"]);
    bunxServes(newer.bin);
    elves(sb, ["install"], { bin: newer.bin });
    dropShim();
    const thin = runHook().stdout;
    expect(thin).toContain(`${PROJECT_BEHIND}: it bumps the package version in package.json and the lockfile; tell the user what changed, commit it with the task.`);
    expect(thin).not.toContain("task new");
    elves(sb, ["install"], { bin: newer.bin });
    const machine = runHook().stdout;
    expect(machine).toContain(`${MACHINE_BEHIND}, tell the user what changed (update lists it), re-read what was updated.`);
    expect(machine).not.toContain(PROJECT_BEHIND);
  });

  it("в git-репозитории без флоу вывод хука зовёт поставить его в проект; вне git-репозитория строки про проект нет", () => {
    elves(sb, ["install", "-g"]);
    bunxServes(base.bin);
    const r = runHook();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Elves in the project: not installed — install it: bunx @miroshnik/elves install --lang <project language>");
    expect(elves(sb, ["check", "--hook"], { cwd: sb.tmp }).stdout).not.toContain("in the project");
  });

  it("вывод хука называет режим и язык проекта; в проекте без флоу строк режима и языка нет", () => {
    elves(sb, ["install", "-g"]);
    bunxServes(base.bin);
    expect(runHook().stdout).not.toMatch(/tasks:|language:/);
    elves(sb, ["install", "--auto"]);
    const r = runHook();
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Elves in the project: up to date[^\n]*\n {2}tasks: entirely by itself\n {2}language: en\n/);
  });

  /** Вывод check и хука — сообщение флоу агенту, а не артефакт проекта: по-английски при любом языке проекта. */
  it("check и хук называют язык и режим проекта по-английски", () => {
    elves(sb, ["install", "-g"]);
    bunxServes(base.bin);
    elves(sb, ["install", "--auto", "--lang", "ru"]);
    const mode = /Elves in the project: up to date[^\n]*\n {2}tasks: entirely by itself\n {2}language: ru\n/;
    const check = elves(sb, ["check"]);
    expect(check).toMatchObject({ code: 0, stdout: expect.stringMatching(mode) });
    const hook = runHook();
    expect(hook).toMatchObject({ code: 0, stdout: expect.stringMatching(mode) });
    expect(`${check.stdout}${hook.stdout}`).not.toMatch(/\p{Script=Cyrillic}/u);
    editManifest(sb.proj, { auto: false });
    expect(elves(sb, ["check"]).stdout).toEndWith("  tasks: with permission\n  language: ru\n");
  });

  it("вывод хука называет игнорируемый файл флоу и что update допишет исключения в .gitignore", () => {
    elves(sb, ["install", "-g"]);
    elves(sb, ["install"]);
    writeFileSync(path.join(sb.proj, ".gitignore"), ".agents/\n");
    bunxServes(base.bin);
    const r = runHook();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("❌ .agents/ — .gitignore:1 «.agents/»");
    expect(r.stdout).toContain("Fix in this session's task: bunx @miroshnik/elves update — adds exceptions to .gitignore");
    expect(r.stdout).toContain("Git ignores flow files — update adds exceptions to .gitignore, committed with the update");
    expect(r.stdout).not.toContain(MACHINE_BEHIND);
  });

  /** Правка compose-файла — не текущая задача сессии: в начале сессии задачи ещё нет, а «одна сессия — одна задача». */
  it("вывод хука называет нарушения compose-файла и что их правка — отдельная задача проекта; без нарушений подсказки нет", () => {
    withDocker();
    elves(sb, ["install", "-g"]);
    elves(sb, ["install"]);
    bunxServes(base.bin);
    composeFile(CONTAINER_NAME);
    const r = runHook();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(COMPOSE_VIOLATION);
    expect(r.stdout).toContain("The compose file breaks task isolation — each ❌ line names the rule and the service (the task-env skill); fixing it is a task of its own in the project.");
    expect(r.stdout).not.toContain(PROJECT_BEHIND);
    expect(r.stdout).not.toContain(MACHINE_BEHIND);
    composeFile("services:\n  db:\n    image: postgres\n");
    expect(runHook().stdout).not.toContain("compose");
  });

  it("вывод хука называет нехватку test:spec и что её добавление — отдельная задача проекта; со скриптом подсказки нет", () => {
    elves(sb, ["install", "-g"]);
    writePkg({});
    elves(sb, ["install"]);
    bunxServes(base.bin);
    decision("tests/standards/naming");
    const r = runHook();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(NO_TEST_SPEC("tests/standards") + ADD_SPEC(inSlot("bun test tests/standards")));
    expect(r.stdout).toContain("No test:spec script — pr premerge doesn't run standards and architecture on the merge; the ❌ line names the package.json scripts; adding them is a task of its own in the project.");
    expect(r.stdout).not.toContain("Behind —");
    writePkg({ scripts: { "test:spec": inSlot("bun test tests/standards") } });
    expect(runHook().stdout).not.toContain("test:spec");
  });

  /** Переезд на Bun — не текущая задача сессии: в начале сессии задачи ещё нет, а «одна сессия — одна задача». */
  it("вывод хука называет проект не на Bun и что переезд — отдельная задача проекта; у проекта на Bun подсказки нет", () => {
    elves(sb, ["install", "-g"]);
    elves(sb, ["install"]);
    bunxServes(base.bin);
    writePkg({ packageManager: "pnpm@10.1.0" });
    const r = runHook();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(NOT_BUN("pnpm@10.1.0"));
    expect(r.stdout).toContain("The project's stack isn't Bun's — each ❌ line names the file and the step; moving it to Bun is a task of its own in the project.");
    writePkg({ packageManager: "bun@1.4.3" });
    expect(runHook().stdout).not.toContain("isn't Bun's");
  });

  /**
   * Команду из вывода хука агент запускает в песочнице Bash: bunx там не пишет свой кеш `~/.bun/install/cache`, установка — в
   * `.claude/skills`. Хук идёт вне песочницы и её не видит — подсказка условная.
   */
  it("вывод хука с командой для запуска подсказывает песочницу Claude Code: кеш bunx — BUN_INSTALL_CACHE_DIR, отказ записи в .claude/ — команда в терминале владельца; без команды подсказки нет", () => {
    const hint = /In the Claude Code sandbox bunx can't write its cache ~\/\.bun\/install\/cache — prefix the command with BUN_INSTALL_CACHE_DIR="\$TMPDIR\/bun"; [^\n]*\.claude\/[^\n]*the owner runs the command in their terminal/;
    elves(sb, ["install", "-g"]);
    bunxServes(base.bin);
    expect(runHook().stdout).toMatch(hint);
    elves(sb, ["install"]);
    expect(runHook().stdout).not.toContain("sandbox");
    bunxServes(newer.bin);
    expect(runHook().stdout).toMatch(hint);
  });

  it("bunx недоступен — код хука 0, в выводе — что проверка недоступна", () => {
    elves(sb, ["install", "-g"]);
    rmSync(path.join(sb.bin, "bunx"), { force: true });
    const r = runHook();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Elves on the machine: check unavailable — can't run release v2026.10.05");
    expect(r.stdout).toContain("Check unavailable — work by the current flow and say so.");
  });

  /** Копия машины без релиза и без main, с которых перезапуститься, сама себя не сверяет: с собой она всегда «актуальна». */
  it("релиза не найти — копия машины себя не сверяет: проверка недоступна, код хука 0", () => {
    elves(sb, ["install", "-g"]);
    bunxServes(base.bin);
    const r = runHook(undefined, { ELVES_REPO: path.join(sb.tmp, "empty.git") });
    execFileSync("git", ["init", "-q", "--bare", path.join(sb.tmp, "empty.git")]);
    const empty = runHook(undefined, { ELVES_REPO: path.join(sb.tmp, "empty.git") });
    expect([r.code, empty.code]).toEqual([0, 0]);
    expect(r.stdout).toContain("Elves on the machine: check unavailable — can't find out the latest Elves release");
    expect(empty.stdout).toContain("Elves on the machine: check unavailable — no Elves release and no main to run from");
    expect(empty.stdout).not.toContain("up to date");
  });

  /** bun не запустился — команда хука плагина печатает запасную строку: код 0, и сессия знает, что проверки не было. */
  it("bun недоступен — код хука 0, в выводе — что проверка недоступна", () => {
    elves(sb, ["install", "-g"]);
    const shOnly = path.join(sb.tmp, "sh-only");
    mkdirSync(shOnly);
    symlinkSync(realpathSync(path.join(sb.bin, "sh")), path.join(shOnly, "sh"));
    const r = runHook(undefined, { PATH: shOnly });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/elves check unavailable \(exit 127\): work by the current flow and say so/);
  });

  it("check --hook: проверка недоступна — объяснение в stdout, код 0", () => {
    const { clone } = linkedClone();
    git(clone, "remote", "set-url", "origin", path.join(sb.tmp, "nowhere"));
    const r = elves(sb, ["check", "--hook"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("check unavailable");
  });

  /**
   * Фоновое ожидание (ci-wait) умирает с процессом приложения (#433): возобновлённой сессии хук называет, какое ожидание
   * перезапустить. Id сессии Claude Code передаёт во входе хука — JSON на stdin; задачу сессии и её PR знает скилл
   * github: хук зовёт его `task resume` и печатает ответ. Скилл — тот, что зовёт агент: одноимённый скилл машины у
   * Claude Code сильнее проектного, и команды в ответе называют его пути.
   */
  describe("возобновлённая сессия узнаёт из хука, какое ожидание перезапустить", () => {
    const SESSION = "0b1f6c1e-7a52-4f0e-9d3a-2c4e8a9b5d10";
    const input = JSON.stringify({ session_id: SESSION, hook_event_name: "SessionStart", source: "resume" });
    // скилл github — заглушка: печатает, кто она, свои аргументы и id сессии из окружения; ссылка машины на скилл копии
    // уступает ей место — копия, из которой идёт хук, остаётся как есть
    const fakeGithub = (root: string, who: string, code = 0) => {
      rmSync(path.join(root, ".agents/skills/github"), { recursive: true, force: true });
      writeTree(root, {
        ".agents/skills/github/scripts/github.ts": `console.log(\`${who} \${process.argv.slice(2).join(" ")} \${process.env.CLAUDE_CODE_SESSION_ID}\`);\nconsole.error("gh: boom");\nprocess.exit(${code});\n`,
      });
    };

    it("id сессии из входа хука — скиллу github машины: его ответ task resume в выводе хука; без входа — из CLAUDE_CODE_SESSION_ID", () => {
      elves(sb, ["install", "-g"]);
      bunxServes(base.bin);
      fakeGithub(sb.home, "fake-machine");
      const r = runHook(input);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`\nfake-machine task resume ${SESSION}\n`);
      expect(elves(sb, ["check", "--hook"], { env: { CLAUDE_CODE_SESSION_ID: SESSION } }).stdout).toContain(`\nfake-machine task resume ${SESSION}\n`);
    });

    // страховка от перегиба: хук не зовёт скилл на каждом старте вслепую — без сессии закрепления не найти
    it("без id сессии скилл github не зовётся", () => {
      elves(sb, ["install", "-g"]);
      bunxServes(base.bin);
      fakeGithub(sb.home, "fake-machine");
      expect(runHook().stdout).not.toContain("fake-machine");
      expect(runHook(JSON.stringify({ source: "startup" })).stdout).not.toContain("fake-machine");
    });

    it("скилл github упал — его вывод и строка ! с причиной, код хука 0", () => {
      elves(sb, ["install", "-g"]);
      bunxServes(base.bin);
      fakeGithub(sb.home, "fake-machine", 2);
      const r = runHook(input);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`\nfake-machine task resume ${SESSION}\n! the session's task — github task resume: gh: boom\n`);
    });
  });
});

/**
 * От переименования флоу в Elves (#544, #545) на машине остались симлинки совместимости `~/.config/ai-dev` → `elves`
 * и `~/.claude/est` → `~/.config/ai-dev`: их больше никто не читает, `update -g` их снимает. Каталог или файл под
 * этими именами — не флоу: он остаётся.
 */
describe("Симлинки переименования флоу на машине: update -g их снимает", () => {
  const gone = (rel: string) => lstatSync(path.join(sb.home, rel), { throwIfNoEntry: false }) === undefined;

  it("update -g снимает симлинки ~/.config/ai-dev и ~/.claude/est — каталог под этим именем остаётся", () => {
    mkdirSync(path.join(sb.home, ".claude"));
    elves(sb, ["install", "-g"]);
    const config = path.join(sb.home, ".config/elves");
    writeTree(config, { "repos.json": '{ "acme/shop": {} }\n' });
    const before = snapshot(config);
    symlinkSync("elves", path.join(sb.home, ".config/ai-dev"));
    symlinkSync(path.join(sb.home, ".config/ai-dev"), path.join(sb.home, ".claude/est"));
    const c = elves(sb, ["check", "-g"]);
    expect(c.code).toBe(1);
    for (const line of ["  - ~/.config/ai-dev\n", "  - ~/.claude/est\n"]) expect(c.stdout).toContain(line);
    expect(elves(sb, ["update", "-g"]).code).toBe(0);
    expect([gone(".config/ai-dev"), gone(".claude/est")]).toEqual([true, true]);
    expect(snapshot(config)).toEqual(before);
    expect(elves(sb, ["check", "-g"])).toMatchObject({ code: 0, stdout: expect.stringContaining("on the machine: up to date") });
    writeTree(path.join(sb.home, ".claude/est"), { "repos.json": "{}\n" });
    expect(elves(sb, ["update", "-g"]).code).toBe(0);
    expect(snapshot(path.join(sb.home, ".claude/est"))).toEqual({ "repos.json": "{}\n" });
    expect(elves(sb, ["check", "-g"]).code).toBe(0);
  });
});

/**
 * TTL кэша подсказок Claude Code (#665, docs/prompt-cache.md): субагенты по умолчанию пишут кэш на 5 минут, на докупе —
 * и основная сессия; пауза дольше (ожидание CI, долгий тест, раздумье человека) — и следующий ход пишет весь контекст
 * заново. Ключи `promptCacheTtl` и `subagentPromptCacheTtl` (Claude Code 2.1.242+) это снимают, но часовая запись
 * дороже — это выбор владельца, как и цена: `check -g` и хук называют незаданный TTL готовой командой, `install -g` и
 * `update -g` печатают ту же рекомендацию, а `~/.claude/settings.json` правит только команда, которую запускает он.
 */
describe("TTL кэша Claude Code: check -g, install -g и update -g рекомендуют час, settings.json правит владелец", () => {
  const TTL = "prompt cache TTL: ";
  const TTL_TAIL = "The prompt cache TTL line is the owner's choice and price — name its command to the user, don't run it yourself.";
  const settings = () => path.join(sb.home, ".claude/settings.json");
  // claude песочницы печатает версию, как `claude --version`
  const claude = (version: string) => writeFileSync(path.join(sb.bin, "claude"), `#!/bin/sh\necho '${version} (Claude Code)'\n`, { mode: 0o755 });
  // команда из строки рекомендации
  const command = (out: string) => {
    const m = /: (bun --no-env-file -e '[^'\n]*')/.exec(out.split("\n").find((l) => l.includes(TTL)) ?? "");
    expect(m).not.toBeNull();
    return m![1]!;
  };
  // команду запускает владелец — через shell, из каталога проекта, с HOME песочницы
  const run = (cmd: string) => spawnSync("sh", ["-c", cmd], { cwd: sb.proj, env: sb.env, encoding: "utf8" });
  // настройки Claude Code машины — свои у владельца, установка их не пишет
  beforeEach(() => {
    mkdirSync(path.join(sb.home, ".claude"));
    writeFileSync(settings(), "{}\n");
    claude("2.1.242");
  });

  it("check -g сообщает, что TTL кэша не задан, и печатает команду, которая ставит оба ключа", () => {
    elves(sb, ["install", "-g"]);
    const before = snapshot(sb.home);
    const r = elves(sb, ["check", "-g"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`\n  ${TTL}promptCacheTtl and subagentPromptCacheTtl aren't set in ~/.claude/settings.json — `);
    expect(r.stdout).toContain("~/.agents/elves/docs/prompt-cache.md");
    expect(existsSync(path.join(sb.home, ".agents/elves/docs/prompt-cache.md"))).toBe(true);
    expect(command(r.stdout)).toContain('["promptCacheTtl","subagentPromptCacheTtl"]');
    expect(snapshot(sb.home)).toEqual(before);
    // хук SessionStart — та же строка и хвост: выбор и команда — владельца, агент её не запускает
    const hook = elves(sb, ["check", "--hook"]);
    expect(hook.code).toBe(0);
    expect(command(hook.stdout)).toBe(command(r.stdout));
    expect(hook.stdout).toContain(TTL_TAIL);
  });

  it("check -g молчит о TTL, когда оба ключа заданы на час", () => {
    elves(sb, ["install", "-g"]);
    const s = JSON.parse(read(settings()));
    // задан один ключ — строка называет второй, и команда ставит только его
    writeFileSync(settings(), JSON.stringify({ ...s, promptCacheTtl: "1h" }));
    const one = elves(sb, ["check", "-g"]).stdout;
    expect(one).toContain(`  ${TTL}subagentPromptCacheTtl isn't set in ~/.claude/settings.json — `);
    expect(command(one)).toContain('["subagentPromptCacheTtl"]');
    writeFileSync(settings(), JSON.stringify({ ...s, promptCacheTtl: "1h", subagentPromptCacheTtl: "1h" }));
    const both = elves(sb, ["check", "-g"]);
    expect(both.code).toBe(0);
    expect(both.stdout).toContain("on the machine: up to date");
    expect(both.stdout).not.toContain(TTL);
    expect(elves(sb, ["check", "--hook"]).stdout).not.toContain("prompt cache TTL");
    // те же TTL переменными окружения Claude Code — тоже заданы
    writeFileSync(settings(), JSON.stringify(s));
    expect(elves(sb, ["check", "-g"], { env: { CLAUDE_CODE_PROMPT_CACHE_TTL: "1h", CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: "1h" } }).stdout).not.toContain(TTL);
  });

  it("команда из рекомендации сохраняет копию settings.json и не трогает другие ключи", () => {
    elves(sb, ["install", "-g"]);
    const s = { ...JSON.parse(read(settings())), model: "opus", permissions: { allow: ["Bash(git status)"] } };
    const original = JSON.stringify(s, null, 4) + "\n";
    writeFileSync(settings(), original);
    // копия прошлого раза у владельца остаётся: новая — со следующим суффиксом
    writeFileSync(`${settings()}.bak`, "прошлая копия\n");
    const r = run(command(elves(sb, ["check", "-g"]).stdout));
    expect(r.status).toBe(0);
    expect(read(`${settings()}.bak`)).toBe("прошлая копия\n");
    expect(read(`${settings()}.bak2`)).toBe(original);
    expect(r.stdout).toContain(`${settings()}.bak2`);
    expect(JSON.parse(read(settings()))).toEqual({ ...s, promptCacheTtl: "1h", subagentPromptCacheTtl: "1h" });
    expect(elves(sb, ["check", "-g"]).stdout).not.toContain(TTL);
  });

  it("повторный запуск команды из рекомендации ничего не меняет", () => {
    elves(sb, ["install", "-g"]);
    const cmd = command(elves(sb, ["check", "-g"]).stdout);
    expect(run(cmd).status).toBe(0);
    const before = snapshot(sb.home);
    const again = run(cmd);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('prompt cache TTL already set: {"promptCacheTtl":"1h","subagentPromptCacheTtl":"1h"}');
    expect(snapshot(sb.home)).toEqual(before);
  });

  it("install -g и update -g рекомендуют TTL и не меняют settings.json", () => {
    const first = elves(sb, ["install", "-g"]);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain(`\n${TTL}promptCacheTtl and subagentPromptCacheTtl aren't set in ~/.claude/settings.json — `);
    const before = read(settings());
    for (const cmd of [["install", "-g"], ["update", "-g"]]) {
      const r = elves(sb, cmd);
      expect(r.code).toBe(0);
      expect(command(r.stdout)).toBe(command(first.stdout));
      expect(read(settings())).toBe(before);
      expect(existsSync(`${settings()}.bak`)).toBe(false);
    }
  });

  it("Claude Code ниже 2.1.242 — рекомендации TTL нет", () => {
    claude("2.1.241");
    for (const cmd of [["install", "-g"], ["update", "-g"], ["check", "-g"], ["check", "--hook"]]) {
      const r = elves(sb, cmd);
      expect(r.code).toBe(0);
      expect(r.stdout).not.toContain("prompt cache TTL");
    }
    // та же машина с Claude Code 2.1.242 — рекомендация есть
    claude("2.1.242");
    expect(elves(sb, ["check", "-g"]).stdout).toContain(TTL);
  });
});

/**
 * Хранение транскриптов Claude Code (#865): факт задачи `est` берёт из транскриптов сессий в `~/.claude/projects/`, а
 * Claude Code удаляет те, что старше `cleanupPeriodDays`, — по умолчанию 30 дней. Правило канона «Transcripts are the
 * actuals» держит `check -g`: ключ меньше 365 или без него — строка с готовой командой владельца, `~/.claude/settings.json`
 * правит только она.
 */
describe("Хранение транскриптов Claude Code: check -g, install -g и update -g называют cleanupPeriodDays меньше 365, settings.json правит владелец", () => {
  const CLEANUP = "transcript cleanup: ";
  const CLEANUP_TAIL = "The transcript cleanup line is the owner's machine setting — name its command to the user, don't run it yourself.";
  const settings = () => path.join(sb.home, ".claude/settings.json");
  const setDays = (days: unknown) => writeFileSync(settings(), JSON.stringify({ ...JSON.parse(read(settings())), cleanupPeriodDays: days }));
  // команда из строки о транскриптах
  const command = (out: string) => {
    const m = /: (bun --no-env-file -e '[^'\n]*')/.exec(out.split("\n").find((l) => l.includes(CLEANUP)) ?? "");
    expect(m).not.toBeNull();
    return m![1]!;
  };
  // команду запускает владелец — через shell, из каталога проекта, с HOME песочницы
  const run = (cmd: string) => spawnSync("sh", ["-c", cmd], { cwd: sb.proj, env: sb.env, encoding: "utf8" });
  // настройки Claude Code машины — свои у владельца, установка их не пишет (#860)
  beforeEach(() => {
    mkdirSync(path.join(sb.home, ".claude"));
    writeFileSync(settings(), "{}\n");
  });

  // без ключа и меньше 365 — строка с командой, хук — та же строка и хвост: команду называют владельцу; 365 и
  // больше — строки нет; код check 0
  it("check -g называет cleanupPeriodDays меньше 365 строкой с командой владельца", () => {
    elves(sb, ["install", "-g"]);
    const before = snapshot(sb.home);
    const r = elves(sb, ["check", "-g"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`\n  ${CLEANUP}cleanupPeriodDays isn't set in ~/.claude/settings.json (Claude Code's default — 30 days) — `);
    expect(command(r.stdout)).toContain('keys=["cleanupPeriodDays"]');
    expect(snapshot(sb.home)).toEqual(before);
    const hook = elves(sb, ["check", "--hook"]);
    expect(hook.code).toBe(0);
    expect(command(hook.stdout)).toBe(command(r.stdout));
    expect(hook.stdout).toContain(CLEANUP_TAIL);
    // меньше 365 — та же строка со значением; не целое число дней — тоже
    for (const days of [30, 364, "365", 365.5]) {
      setDays(days);
      const out = elves(sb, ["check", "-g"]);
      expect(out.code).toBe(0);
      expect(out.stdout).toContain(`  ${CLEANUP}cleanupPeriodDays in ~/.claude/settings.json is ${JSON.stringify(days)}, under 365 — `);
      expect(command(out.stdout)).toBe(command(r.stdout));
    }
    for (const days of [365, 3650]) {
      setDays(days);
      const out = elves(sb, ["check", "-g"]);
      expect(out.code).toBe(0);
      expect(out.stdout).toContain("on the machine: up to date");
      expect(out.stdout).not.toContain(CLEANUP);
      const quiet = elves(sb, ["check", "--hook"]).stdout;
      expect(quiet).not.toContain(CLEANUP);
      expect(quiet).not.toContain(CLEANUP_TAIL);
    }
  });

  it("команда ставит 365, сохраняет копию settings.json и не трогает другие ключи; повтор ничего не меняет", () => {
    elves(sb, ["install", "-g"]);
    const s = { ...JSON.parse(read(settings())), cleanupPeriodDays: 30, model: "opus" };
    const original = JSON.stringify(s, null, 4) + "\n";
    writeFileSync(settings(), original);
    const cmd = command(elves(sb, ["check", "-g"]).stdout);
    const r = run(cmd);
    expect(r.status).toBe(0);
    expect(read(`${settings()}.bak`)).toBe(original);
    expect(JSON.parse(read(settings()))).toEqual({ ...s, cleanupPeriodDays: 365 });
    expect(elves(sb, ["check", "-g"]).stdout).not.toContain(CLEANUP);
    const before = snapshot(sb.home);
    const again = run(cmd);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('cleanupPeriodDays already set: {"cleanupPeriodDays":365}');
    expect(snapshot(sb.home)).toEqual(before);
  });

  it("install -g и update -g печатают ту же строку и не меняют settings.json", () => {
    const first = elves(sb, ["install", "-g"]);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain(`\n${CLEANUP}cleanupPeriodDays isn't set in ~/.claude/settings.json`);
    const before = read(settings());
    for (const cmd of [["install", "-g"], ["update", "-g"]]) {
      const r = elves(sb, cmd);
      expect(r.code).toBe(0);
      expect(command(r.stdout)).toBe(command(first.stdout));
      expect(read(settings())).toBe(before);
      expect(existsSync(`${settings()}.bak`)).toBe(false);
    }
  });
});
