import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { BYPASSES } from "../../../skills/github/scripts/bypasses.ts";
import { sources } from "../../../skills/spec/scripts/harness.ts";
import { PACKAGE_BUNX } from "../../../skills/spec/scripts/package-run.ts";
import { bareClone, BIN, elves, elvesPackage, bunxPackage, bunxServesPackages, loadedAtStart, npmPackage, REPO, sandbox, snapshot, type ElvesPackage, type Sandbox } from "../../lib/elves.ts";
import { npmRegistry, type Registry } from "../../lib/registry.ts";
import { tmpDir, writeTree } from "../../lib/spec.ts";
import { SPAWN_TIMEOUT, unprivilegedOwns } from "../../lib/spawn.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

const SKILLS = ["ci-wait", "est", "github", "slot", "spec", "task-env"];
/** Версия пакета релиза, которым ставится флоу, — `2026.1015.1` у тега `v2026.10.15.1`. */
const VERSION = "2026.1015.1";

let sb: Sandbox;
let tmp: string;
let home: string;
let proj: string;
let env: Record<string, string>;

beforeEach(() => {
  sb = sandbox();
  ({ tmp, home, proj, env } = sb);
});
afterEach(() => sb.cleanup());

// пакет Elves этого клона (src), он же из npm версии VERSION (release — сам релиз, #557) и реестр npm с ней: один раз
// на файл
let packages: { dir: string; cleanup: () => void };
let src: ElvesPackage;
let release: { bin: string };
let registry: Registry;
beforeAll(async () => {
  packages = tmpDir();
  src = elvesPackage(path.join(packages.dir, "src"));
  release = { bin: npmPackage(path.join(packages.dir, "npm"), src.dir, VERSION, src.sha) };
  registry = await npmRegistry([VERSION]);
});
afterAll(() => {
  registry.stop();
  packages.cleanup();
});

function install(args: string[] = [], cwd = proj, extra: Record<string, string> = {}) {
  return elves(sb, ["install", ...args], { cwd, env: extra });
}

const read = (p: string) => readFileSync(p, "utf8");
const isLink = (p: string) => lstatSync(p).isSymbolicLink();
const gone = (p: string) => lstatSync(p, { throwIfNoEntry: false }) === undefined;

/**
 * Проект на bun со своей зависимостью — пакетом workspace по `file:`: lockfile есть, как у живого проекта, а реестр для
 * него не нужен.
 */
function bunProject(fields: Record<string, unknown> = {}) {
  writeTree(proj, {
    "package.json": JSON.stringify({ name: "app", private: true, dependencies: { "@app/util": "file:./util" }, ...fields }, null, 2) + "\n",
    "util/package.json": JSON.stringify({ name: "@app/util", version: "1.0.0" }) + "\n",
  });
  const r = spawnSync(process.execPath, ["install"], { cwd: proj, env, encoding: "utf8" });
  expect(r.status).toBe(0);
  expect(existsSync(path.join(proj, "bun.lock"))).toBe(true);
}

/**
 * Проект тонкий (#552): в репозитории — версия пакета `@miroshnik/elves` для харнесса, spec-скриптов и CI, манифест, шим
 * очереди и блок AGENTS.md; канон и скиллы — на машине. Обновление проекта — подъём версии, а не копия на тысячи строк.
 */
describe("В проект — тонкий флоу: версия пакета, манифест, шим slot и блок AGENTS.md, без копии флоу", () => {
  it("install в проект без флоу ставит devDependency пакета, .agents/elves.json, шим slot и блок AGENTS.md — без копии флоу", () => {
    bunProject();
    const r = elves(sb, ["install"], { bin: release.bin, env: registry.env });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`package.json, bun.lock — @miroshnik/elves ${VERSION} (bun install)`);
    const pkg = JSON.parse(read(path.join(proj, "package.json")));
    expect(pkg.devDependencies).toEqual({ "@miroshnik/elves": VERSION });
    expect(pkg.dependencies).toEqual({ "@app/util": "file:./util" });
    expect(read(path.join(proj, "bun.lock"))).toContain(`"@miroshnik/elves@${VERSION}"`);
    expect(JSON.parse(read(path.join(proj, "node_modules/@miroshnik/elves/package.json"))).version).toBe(VERSION);
    expect(JSON.parse(read(path.join(proj, ".agents/elves.json")))).toEqual({ auto: false, language: "en" });
    expect(read(path.join(proj, ".agents/slot.sh"))).toContain("elves slot --for $$");
    expect(read(path.join(proj, "AGENTS.md"))).toContain("Shared rules — `~/.agents/elves/AGENTS.md` on the machine");
    expect(readdirSync(path.join(proj, ".agents")).sort()).toEqual(["elves.json", "slot.sh"]);
  });

  /**
   * Облачные сессии флоу не поддерживает (#837, capability `elves#cloud-session`): хук SessionStart облачной сессии в
   * `.claude/settings.json` установка больше не кладёт — ни тонкому проекту, ни клону Elves, — а свои настройки проекта
   * не трогает.
   */
  it("Установка в проект не ставит облачный хук", () => {
    expect(install().code).toBe(0);
    // без auto в настройках — только правила ask (#840), хуков нет
    expect(Object.keys(JSON.parse(read(path.join(proj, ".claude/settings.json"))))).toEqual(["permissions"]);
    const settings = JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo мой хук" }] }] } });
    writeTree(proj, { ".claude/settings.json": settings });
    expect(install(["--auto"]).code).toBe(0);
    expect(read(path.join(proj, ".claude/settings.json"))).toBe(settings);
    const clone = bareClone(path.join(tmp, "clone"));
    expect(install([], clone).code).toBe(0);
    expect(existsSync(path.join(clone, ".claude"))).toBe(false);
  });

  /** Lockfile проекта установка не заводит: без него менеджер пакетов не запускается, команда — строкой. */
  it("без lockfile — только версия в package.json и команда установки зависимостей; lockfile не появляется", () => {
    writeTree(proj, { "package.json": JSON.stringify({ name: "app", private: true }, null, 2) + "\n" });
    const r = elves(sb, ["install"], { bin: release.bin, env: registry.env });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`package.json — @miroshnik/elves ${VERSION}; no lockfile — install the dependencies: npm install`);
    expect(JSON.parse(read(path.join(proj, "package.json"))).devDependencies).toEqual({ "@miroshnik/elves": VERSION });
    expect(readdirSync(proj).sort()).toEqual([".agents", ".claude", ".git", ".worktreeinclude", "AGENTS.md", "package.json"]);
  });

  it("менеджер пакетов не поставил пакет (нет сети) — версия в package.json, предупреждение с командой, код 0", () => {
    bunProject();
    const r = elves(sb, ["install"], { bin: release.bin, env: { npm_config_registry: "http://127.0.0.1:9/" } });
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/^!! package\.json — @miroshnik\/elves 2026\.1015\.1, but bun\.lock isn't updated: bun install — .*; run it yourself$/m);
    expect(JSON.parse(read(path.join(proj, "package.json"))).devDependencies).toEqual({ "@miroshnik/elves": VERSION });
  });

  /** Ни скриптов, ни тестов на JS — закреплять нечего; канон и скиллы проекту дают машина и блок AGENTS.md. */
  it("проект без package.json — без devDependency: манифест, шим и блок AGENTS.md", () => {
    expect(elves(sb, ["install"], { bin: release.bin }).code).toBe(0);
    expect(readdirSync(proj).sort()).toEqual([".agents", ".claude", ".git", ".worktreeinclude", "AGENTS.md"]);
    expect(readdirSync(path.join(proj, ".agents")).sort()).toEqual(["elves.json", "slot.sh"]);
  });

  /** Клон — не релиз: версии, которую закрепить, у него нет (#558, вопрос 5). */
  it("установщик не релиз (клон) — devDependency не трогает: предупреждение с причиной", () => {
    writeTree(proj, { "package.json": JSON.stringify({ name: "app", private: true }, null, 2) + "\n" });
    const r = install();
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("!! package.json — @miroshnik/elves isn't added: this installer isn't a release (a clone or no releases yet)");
    expect(JSON.parse(read(path.join(proj, "package.json")))).toEqual({ name: "app", private: true });
  });

  it("в AGENTS.md проекта — блок со ссылкой на канон машины: свой текст проекта на месте, повторная установка блок не дублирует", () => {
    writeFileSync(path.join(proj, "AGENTS.md"), "# Проект\n\nСвои правила.\n");
    install();
    install();
    const text = read(path.join(proj, "AGENTS.md"));
    expect(text.match(/<!-- elves:begin/g)).toHaveLength(1);
    expect(text).toContain("`~/.agents/elves/AGENTS.md`");
    expect(text).toContain("# Проект\n\nСвои правила.\n");
  });

  /**
   * Подпись файлов установки — команда из npm (#559): пакет из npm — сам релиз, а `bunx github:miroshnik/elves` —
   * запасной путь в docs/installation.md.
   */
  it("блок AGENTS.md, шим очереди и блок .gitignore подписаны командой из npm — bunx @miroshnik/elves install, а не bunx github:", () => {
    writeFileSync(path.join(proj, ".gitignore"), ".agents/\n");
    expect(install().code).toBe(0);
    for (const file of ["AGENTS.md", ".agents/slot.sh", ".gitignore"]) {
      const text = read(path.join(proj, file));
      expect(text).toContain("`bunx @miroshnik/elves install`");
      expect(text).not.toContain("github:");
    }
  });

  /** Блок прошлой версии — по-русски; маркеры begin и end у него те же: по ним установка его находит и заменяет. */
  it("блок прошлой версии по-русски в AGENTS.md проекта установка заменяет английским, а не ставит второй", () => {
    const old = [
      "<!-- elves:begin — ставит `npx -y github:miroshnik/elves install`, руками не править -->",
      "Общие правила — `.agents/elves/AGENTS.md`: прочитай до начала работы (справочники — `.agents/elves/docs/`).",
      "Скиллы — `.agents/skills/`.",
      "<!-- elves:end -->",
    ].join("\n");
    writeFileSync(path.join(proj, "AGENTS.md"), `${old}\n\n# Проект\n\nСвои правила.\n`);
    install();
    install();
    const text = read(path.join(proj, "AGENTS.md"));
    expect(text.match(/<!-- elves:begin/g)).toHaveLength(1);
    const block = /^<!-- elves:begin[^]*?<!-- elves:end -->/.exec(text)?.[0] ?? "";
    expect(block).toContain("Shared rules — `~/.agents/elves/AGENTS.md`");
    expect(block).not.toMatch(/\p{Script=Cyrillic}/u);
    expect(text).toEndWith("<!-- elves:end -->\n\n# Проект\n\nСвои правила.\n");
  });

  it("без AGENTS.md в проекте — файл создаётся с одним блоком", () => {
    install();
    expect(read(path.join(proj, "AGENTS.md"))).toMatch(/^<!-- elves:begin[^]*<!-- elves:end -->\n$/);
  });

  /**
   * bunx ставит пакет в node_modules своего каталога и запускает его bin по шебангу — так же, как `bun add` пакета из
   * `bun pm pack`: только файлы из `files`, TypeScript в node_modules Bun стирает сам. Кеш bun — свой, в песочнице.
   */
  it("через bunx из пакета Elves: bin из node_modules под Bun ставит тонкий флоу", () => {
    const bunEnv = { ...env, BUN_INSTALL_CACHE_DIR: path.join(tmp, "bun-cache") };
    const pack = spawnSync(process.execPath, ["pm", "pack", "--destination", tmp, "--quiet"], { cwd: REPO, env: bunEnv, encoding: "utf8" });
    expect(pack.status).toBe(0);
    const tgz = pack.stdout.trim().split("\n").pop()!;
    const bunx = path.join(tmp, "bunx");
    writeTree(bunx, { "package.json": "{}\n" });
    expect(spawnSync(process.execPath, ["add", "--silent", tgz], { cwd: bunx, env: bunEnv, encoding: "utf8" }).status).toBe(0);
    const r = spawnSync(path.join(bunx, "node_modules/.bin/elves"), ["install"], { cwd: proj, env, encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(JSON.parse(read(path.join(proj, ".agents/elves.json")))).toEqual({ auto: false, language: "en" });
    expect(read(path.join(proj, ".agents/slot.sh"))).toContain("elves slot --for $$");
    expect(read(path.join(proj, "AGENTS.md"))).toContain("`~/.agents/elves/AGENTS.md`");
  });

  it("корень установки — корень git-репозитория, даже при запуске из подкаталога", () => {
    mkdirSync(path.join(proj, "src/app"), { recursive: true });
    expect(install([], path.join(proj, "src/app")).code).toBe(0);
    expect(existsSync(path.join(proj, ".agents/elves.json"))).toBe(true);
    expect(existsSync(path.join(proj, "src/app/.agents"))).toBe(false);
  });
});

/**
 * Песочница агента не пускает запись в `.claude/skills` (Seatbelt у Claude Code — EPERM): установка на машину
 * обрывается на симлинках, когда копии в `~/.agents/skills` уже легли. Тест закрывает каталог правами — отказ тот же
 * по сути (EACCES); под root права не запрещают ничего — установщик идёт от непривилегированного пользователя (#598).
 */
describe("Отказ в записи посреди установки — понятная строка вместо стека, повтор доводит установку", () => {
  const skillsDir = () => path.join(home, ".claude/skills");
  const lock = () => (mkdirSync(skillsDir(), { recursive: true }), unprivilegedOwns(skillsDir()), chmodSync(skillsDir(), 0o555));
  const install = (args: string[]) => elves(sb, ["install", ...args], { unprivileged: true });
  const update = () => elves(sb, ["update", "-g"], { unprivileged: true });
  // машина с Claude Code: симлинки скиллов ставятся в ~/.claude/skills
  beforeEach(() => (mkdirSync(path.join(home, ".claude"), { recursive: true }), unprivilegedOwns(tmp)));
  // каталог без права записи не удалить — права возвращаются до уборки песочницы
  afterEach(() => existsSync(skillsDir()) && chmodSync(skillsDir(), 0o755));

  it("нет права писать в ~/.claude/skills — install -g: код 2, строка с путём и командой для своего терминала, без стека", () => {
    lock();
    const r = install(["-g"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("~/.claude/skills/ci-wait");
    expect(r.stderr).toContain("bunx @miroshnik/elves install -g");
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });

  it("повтор после отказа на ~/.claude/skills доводит установку: скиллы признаны своими, симлинки на месте, предупреждения «isn't an Elves skill» нет", () => {
    lock();
    install(["-g"]);
    chmodSync(skillsDir(), 0o755);
    const r = install(["-g"]);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("isn't an Elves skill");
    for (const s of SKILLS) expect(readlinkSync(path.join(skillsDir(), s))).toBe(`../../.agents/skills/${s}`);
    expect(JSON.parse(read(path.join(home, ".agents/elves.json"))).skills).toEqual(SKILLS);
  });

  it("update -g: нет права писать в ~/.claude/skills — код 2, та же строка с командой update -g", () => {
    install(["-g"]);
    rmSync(path.join(skillsDir(), "spec"));
    chmodSync(skillsDir(), 0o555);
    const r = update();
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("~/.claude/skills/spec");
    expect(r.stderr).toContain("bunx @miroshnik/elves update -g");
  });

  it("симлинк, который уже ведёт куда надо, установка не пересоздаёт: ~/.claude/skills без права записи не мешает повтору без нового скилла", () => {
    install(["-g"]);
    chmodSync(skillsDir(), 0o555);
    expect(install(["-g"]).code).toBe(0);
    expect(update().code).toBe(0);
  });
});

/**
 * Файлы тонкого проекта коммитятся: без шима `.agents/slot.sh` в коммите скрипт package.json в CI и чужом чекауте падает
 * на `. .agents/slot.sh`, без манифеста другой чекаут не знает режима и языка (#558, вопрос 4). Исключение действует,
 * только если идёт после игнорирующего правила, — поэтому блок Elves в конце `.gitignore`.
 */
describe("Файлы флоу не игнорируются git проекта — иначе их нет в коммите, чужом чекауте и CI", () => {
  const gitignore = () => read(path.join(proj, ".gitignore"));
  // игнорируемые git файлы проекта — по одному, и внутри игнорируемых каталогов
  const ignored = () => execFileSync("git", ["ls-files", "--others", "--ignored", "--exclude-standard"], { cwd: proj, env, encoding: "utf8" }).split("\n").filter(Boolean).sort();

  it(".agents/ в .gitignore проекта — install дописывает в конец .gitignore блок Elves: манифест и шим не игнорируются, своё в .agents — как прежде, свои строки на месте, повтор блок не дублирует", () => {
    writeTree(proj, { ".gitignore": "node_modules/\n.agents/\n", ".agents/notes.md": "мои заметки\n" });
    const r = install();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(".gitignore");
    expect(ignored()).toEqual([".agents/notes.md"]);
    const text = gitignore();
    expect(text).toStartWith("node_modules/\n.agents/\n");
    expect(text).toContain("\n!/.agents/elves.json\n!/.agents/slot.sh\n");
    expect(text).toMatch(/\n# elves:begin[^\n]*\n[^]*\n# elves:end\n$/);
    install();
    expect(gitignore()).toBe(text);
  });

  /**
   * Шаблоны, которые прятали файлы копии (`CLAUDE.md`, `.claude/`, `vendor/`), тонкому проекту безразличны: его файлы —
   * не там; `.claude/settings.json` с правилами ask флоу пишет только проекту без auto (#840).
   */
  it("шаблоны CLAUDE.md, .claude/ и vendor/ тонкому проекту с auto не мешают — исключений не нужно", () => {
    writeTree(proj, { ".gitignore": "CLAUDE.md\n.claude/\nvendor/\n" });
    expect(install(["--auto"]).code).toBe(0);
    expect(gitignore()).toBe("CLAUDE.md\n.claude/\nvendor/\n");
    expect(ignored()).toEqual([]);
    expect(elves(sb, ["check"]).code).toBe(0);
  });

  /** Шапка блока прошлой версии — по-русски; маркеры begin и end у него те же: по ним установка его находит. */
  it("блок исключений копии прошлой версии с шапкой по-русски установка убирает — файлам тонкого проекта исключения не нужны", () => {
    const old = ["# elves:begin — файлы флоу, которые иначе игнорирует git; ставит `npx -y github:miroshnik/elves install`, руками не править", "!/.agents/elves/claude/CLAUDE.md", "# elves:end"].join("\n");
    writeTree(proj, { ".gitignore": `node_modules/\nCLAUDE.md\n\n${old}\n` });
    expect(install().code).toBe(0);
    expect(gitignore()).toBe("node_modules/\nCLAUDE.md\n");
  });

  it("ничего не игнорируется — .gitignore не создаётся и не меняется; ставший ненужным блок убирается", () => {
    install();
    expect(existsSync(path.join(proj, ".gitignore"))).toBe(false);
    writeFileSync(path.join(proj, ".gitignore"), "dist");
    install();
    expect(gitignore()).toBe("dist");
    writeFileSync(path.join(proj, ".gitignore"), "dist\n.agents/\n");
    install();
    expect(gitignore()).toContain("# elves:begin");
    writeFileSync(path.join(proj, ".gitignore"), gitignore().replace("dist\n.agents/\n", "dist\n"));
    install();
    expect(gitignore()).toBe("dist\n");
  });

  /**
   * Личные правила (core.excludesFile, `.git/info/exclude`) — не проекта. Исключение файла безвредно для всех, а
   * исключение каталога с `/<каталог>/*` спрятало бы остальное в нём у тех, у кого такого правила нет.
   */
  it("шаблон файла вне проекта (core.excludesFile) снимается исключением в .gitignore проекта; каталог, исключённый вне проекта, — ❌ с правилом, исключений на него в .gitignore проекта нет", () => {
    writeTree(home, { ".config/git/ignore": "slot.sh\n" });
    expect(install().code).toBe(0);
    expect(gitignore()).toContain("\n!/.agents/slot.sh\n");
    rmSync(path.join(proj, ".gitignore"));
    writeTree(home, { ".config/git/ignore": ".agents/\n" });
    const r = install();
    expect(r.code).toBe(0);
    expect(existsSync(path.join(proj, ".gitignore"))).toBe(false);
    expect(r.stderr).toContain("❌ .agents/ — ");
    expect(r.stderr).toContain(".config/git/ignore:1 «.agents/»");
    expect(ignored()).toEqual([".agents/elves.json", ".agents/slot.sh"]);
  });
});

/**
 * Тяжёлые проверки проекта идут очередью машины (capability `slot`). Обёртка — в самих скриптах `package.json`: их
 * зовёт любой — агент, человек в терминале, `github pr premerge`. `build` не оборачивается — его запускают хостинг и Docker, где
 * шима или пакета может не быть; watch — долгий, занял бы слот надолго.
 */
describe("Проверки проекта идут очередью машины: install оборачивает их скрипты package.json в шим slot", () => {
  const SCRIPTS = {
    build: "next build",
    dev: "next dev",
    lint: "eslint .",
    typecheck: "tsc --noEmit && tsc -p tsconfig.test.json --noEmit",
    test: "vitest run",
    "test:e2e": "playwright test",
    "test:watch": "vitest",
  };
  const pkgFile = () => path.join(proj, "package.json");
  const scripts = () => JSON.parse(read(pkgFile())).scripts;
  const slot = (cmd: string) => `. .agents/slot.sh && ${cmd}`;
  /** elves песочницы — bin этого клона: шим зовёт `elves slot` из PATH, как из node_modules/.bin проекта. */
  const elvesOnPath = () => symlinkSync(BIN, path.join(sb.bin, "elves"));

  it("установка оборачивает lint, typecheck, test и test:* в slot, build и watch — нет", () => {
    writeTree(proj, { "package.json": JSON.stringify({ name: "app", scripts: SCRIPTS }, null, 2) + "\n" });
    const r = install();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("package.json");
    expect(scripts()).toEqual({
      ...SCRIPTS,
      lint: slot("eslint ."),
      typecheck: slot(SCRIPTS.typecheck),
      test: slot("vitest run"),
      "test:e2e": slot("playwright test"),
    });
  });

  /**
   * Шим зовёт `elves slot` пакета проекта, в `if command -v elves`: без elves на PATH (CI до установки
   * зависимостей, чекаут без пакета) команда идёт как есть, сбой elves роняет скрипт его кодом — проверено в #552.
   */
  it("скрипты package.json тонкого проекта идут через шим slot: с elves на PATH — в слоте машины, без elves — как есть, сбой elves роняет скрипт с его кодом", () => {
    writeTree(proj, { "package.json": JSON.stringify({ scripts: { test: 'echo "slot=[$ELVES_SLOT_CPUS]"' } }) });
    install();
    const run = () => spawnSync("sh", ["-c", scripts().test], { cwd: proj, env, encoding: "utf8" });
    expect(run()).toMatchObject({ status: 0, stdout: "slot=[]\n" });
    elvesOnPath();
    expect(run()).toMatchObject({ status: 0, stdout: expect.stringMatching(/^slot=\[[1-9]\d*\]\n$/) });
    rmSync(path.join(sb.bin, "elves"));
    writeFileSync(path.join(sb.bin, "elves"), "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    expect(run()).toMatchObject({ status: 3, stdout: "" });
  });

  /** npm и bun дописывают аргументы к скрипту в конец его строки: `npm test -- <файл>` — так же и с обёрткой. */
  it("обёрнутый скрипт идёт как прежде: кавычки команды на месте, аргументы — в её конце", () => {
    writeTree(proj, { "package.json": JSON.stringify({ scripts: { test: `printf '%s|' "it's"` } }) });
    install();
    elvesOnPath();
    const r = spawnSync("sh", ["-c", `${scripts().test} 'a b'`], { cwd: proj, env, encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("it's|a b|");
  });

  /**
   * Bun сам подгружает env-файлы рабочего каталога: прод-ключи `.env.local` не должны дойти через slot до раннера
   * тестов, который без обёртки их не видел (tests/standards/scripts/no-env-file). Окружение песочницы — без `CI`: команда идёт
   * через слот, очередь — в её домашнем каталоге.
   */
  it("команда под slot не видит ключей env-файлов рабочего каталога", () => {
    writeTree(proj, {
      "package.json": JSON.stringify({ scripts: { test: `echo "[$ELVES_DOTENV|$ELVES_DOTENV_LOCAL|\${ELVES_SLOT_CPUS:+slot}]"` } }),
      ".env": "ELVES_DOTENV=dotenv\n",
      ".env.local": "ELVES_DOTENV_LOCAL=prod-key\n",
    });
    install();
    elvesOnPath();
    const r = spawnSync("sh", ["-c", scripts().test], { cwd: proj, env, encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("[||slot]\n");
  });

  it("повторная установка не оборачивает дважды, отступ и конец package.json — как были", () => {
    writeTree(proj, { "package.json": `{\n\t"name": "app",\n\t"scripts": {\n\t\t"test": "vitest run"\n\t}\n}` });
    install();
    const once = read(pkgFile());
    expect(once).toBe(`{\n\t"name": "app",\n\t"scripts": {\n\t\t"test": "${slot("vitest run")}"\n\t}\n}`);
    install();
    expect(read(pkgFile())).toBe(once);
  });

  /**
   * `bun` читает bin пакета сам, мимо шебанга: без `--no-env-file` Bun подгрузил бы env-файлы рабочего каталога, и
   * скрипт отдал бы их ключи дальше — `spec-break` проверяемой команде, `spec-run` и `spec-publish` — `gh` и `git`
   * (tests/standards/scripts/no-env-file, #596). Скрипт `package.json` идёт как у npm: `sh -c` в корне проекта,
   * `node_modules/.bin` первым в PATH.
   */
  it("скрипт spec из package.json тонкого проекта не видит ключей env-файлов рабочего каталога", () => {
    const probe = `sh -c 'echo "[$ELVES_DOTENV|$ELVES_DOTENV_LOCAL]" >> probe.txt; read x < f.txt; [ "$x" = ok ]'`;
    writeTree(proj, {
      "package.json": JSON.stringify({ scripts: { "spec:break": `bun --no-env-file node_modules/.bin/elves spec-break --file f.txt --find ok --replace no -- ${probe}` } }),
      "f.txt": "ok\n",
      ".env": "ELVES_DOTENV=dotenv\n",
      ".env.local": "ELVES_DOTENV_LOCAL=prod-key\n",
    });
    expect(install().code).toBe(0);
    const bin = path.join(proj, "node_modules/.bin");
    mkdirSync(bin, { recursive: true });
    symlinkSync(BIN, path.join(bin, "elves"));
    const r = spawnSync("sh", ["-c", scripts()["spec:break"]], { cwd: proj, env: { ...env, PATH: `${bin}:${env.PATH}` }, encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(read(path.join(proj, "probe.txt"))).toBe("[|]\n[|]\n");
  });

  /**
   * Yarn 2+ выполняет скрипты своим shell (`@yarnpkg/shell`): в нём нет `.`, `eval` и `export`, и подключить шим нечем.
   * Там команда остаётся строкой у slot пакета — knip её не видит, но проверки идут очередью. Пакет — через bunx
   * (`PACKAGE_BUNX`): bin `.ts` Yarn 2+ запускает Node-ом, мимо шебанга, а с PnP `node_modules` нет (#608); обёртка
   * до #608 — `elves slot` — переписывается. Вживую, настоящим Yarn, — install.slow.test.ts.
   */
  it("в проекте на Yarn 2+ скрипты пакета — через bunx, команда проверки — строкой у его slot: bin .ts Yarn запускает Node-ом, шим его shell не подключает", () => {
    const yarnSlot = (cmd: string) => `${PACKAGE_BUNX} slot '${cmd}'`;
    const markers: [Record<string, string>, string?][] = [[{ ".yarnrc.yml": "nodeLinker: node-modules\n" }], [{}, "yarn@4.9.1"]];
    for (const [files, packageManager] of markers) {
      rmSync(path.join(proj, ".yarnrc.yml"), { force: true });
      const specDoc = `${PACKAGE_BUNX} spec-doc .spec-report.xml`;
      writeTree(proj, { ...files, "package.json": JSON.stringify({ packageManager, scripts: { test: "vitest run", lint: slot("eslint ."), "test:e2e": "elves slot 'playwright test'", "spec:doc": specDoc } }) });
      install();
      expect(scripts()).toEqual({
        test: yarnSlot("vitest run"),
        lint: yarnSlot("eslint ."),
        "test:e2e": yarnSlot("playwright test"),
        "spec:doc": `${PACKAGE_BUNX} spec-doc .spec-report.xml`,
      });
      expect(elves(sb, ["check"]).code).toBe(0);
    }
    writeTree(proj, { "package.json": JSON.stringify({ packageManager: "yarn@1.22.22", scripts: { test: "vitest run" } }) });
    install();
    expect(scripts()).toEqual({ test: slot("vitest run") });
  });

  it("check называет обёртку прошлой установки несоответствием, update переписывает её", () => {
    writeTree(proj, { "package.json": JSON.stringify({ scripts: { lint: "eslint .", test: "vitest run" } }) });
    install();
    writeTree(proj, { "package.json": JSON.stringify({ scripts: { lint: scripts().lint, test: "elves slot 'vitest run'" } }) });
    const c = elves(sb, ["check"]);
    expect(c.code).toBe(1);
    expect(c.stdout).toMatch(/~ package\.json — [^\n]*previous install — knip doesn't see the command[^\n]*\btest\b/);
    expect(c.stdout).not.toMatch(/~ package\.json — [^\n]*\blint\b/);
    const u = elves(sb, ["update"]);
    expect(u.code).toBe(0);
    expect(scripts()).toEqual({ lint: slot("eslint ."), test: slot("vitest run") });
    expect(elves(sb, ["check"]).code).toBe(0);
  });

  /**
   * knip разбирает скрипты package.json: по скрипту `bun test` плагин Bun берёт входами файлы тестов и `preload` из
   * bunfig.toml, по бинарнику команды зависимость считается использованной. Команду строкой-аргументом knip не видел —
   * deadCode проекта краснел от установки флоу, а не от кода. knip — настоящий, из devDependencies Elves, под node.
   */
  it("после установки флоу knip видит команды обёрнутых скриптов: тесты bun test и preload — входы, бинарник команды — использованная зависимость", () => {
    writeTree(proj, {
      "package.json": JSON.stringify({ name: "app", private: true, type: "module", scripts: { lint: "eslint .", test: "bun test" }, devDependencies: { eslint: "^10.0.0", knip: "^6.41.0" } }),
      "bunfig.toml": '[test]\npreload = ["./tests/lib/setup.ts"]\n',
      "knip.json": JSON.stringify({ project: ["src/**/*.ts", "tests/**/*.ts"] }),
      "src/index.ts": "export const sum = (a: number, b: number): number => a + b;\n",
      "tests/sum.test.ts": 'import { expect, it } from "bun:test";\nimport { sum } from "../src/index.ts";\n\nit("сумма", () => expect(sum(1, 2)).toBe(3));\n',
      "tests/lib/setup.ts": 'process.env.TZ = "UTC";\n',
      "node_modules/eslint/package.json": JSON.stringify({ name: "eslint", version: "10.0.0", bin: { eslint: "bin/eslint.js" } }),
      "node_modules/eslint/bin/eslint.js": "",
    });
    symlinkSync(path.join(REPO, "node_modules/knip"), path.join(proj, "node_modules/knip"));
    symlinkSync(execFileSync("sh", ["-c", "command -v node"], { encoding: "utf8" }).trim(), path.join(sb.bin, "node"));
    expect(install().code).toBe(0);
    expect(scripts()).toMatchObject({ lint: slot("eslint ."), test: slot("bun test") });
    const knip = spawnSync("node", ["node_modules/knip/bin/knip.js", "--no-progress"], { cwd: proj, env, encoding: "utf8" });
    expect({ code: knip.status, out: knip.stdout + knip.stderr }).toEqual({ code: 0, out: "" });
  });

  it("check называет скрипт без slot несоответствием, update оборачивает и зовёт закоммитить package.json", () => {
    writeTree(proj, { "package.json": JSON.stringify({ scripts: { lint: "eslint .", test: "vitest run" } }) });
    install();
    expect(elves(sb, ["check"]).code).toBe(0);
    writeTree(proj, { "package.json": JSON.stringify({ scripts: { lint: scripts().lint, test: "vitest run" } }) });
    const c = elves(sb, ["check"]);
    expect(c.code).toBe(1);
    expect(c.stdout).toMatch(/~ package\.json — [^\n]*\btest\b/);
    expect(c.stdout).not.toMatch(/~ package\.json — [^\n]*\blint\b/);
    const u = elves(sb, ["update"]);
    expect(u.code).toBe(0);
    expect(scripts().test).toBe(slot("vitest run"));
    expect(u.stdout).toMatch(/\n {2}git add -A -- package\.json [^\n]*&& git commit/);
    expect(elves(sb, ["check"]).code).toBe(0);
  });


  /**
   * turbo 2 в strict env mode пропускает задачам только переменные, названные в turbo.json: без проброса раннер не
   * видит `ELVES_SLOT_CPUS` и берёт машину целиком, а вложенный скрипт в slot — `ELVES_SLOT` и ждёт собственный
   * слот. `globalPassThroughEnv`, а не `globalEnv`: в хэш кэша они не входят, а `ELVES_SLOT` у каждого прогона свой.
   * turbo.json правит владелец проекта (в нём бывают комментарии — JSONC), поэтому install и check только
   * предупреждают; отставанием флоу это не считается.
   */
  it("скрипт в slot зовёт turbo без проброса переменных очереди — install и check предупреждают готовой строкой для turbo.json, отставанием это не считается", () => {
    writeTree(proj, {
      "package.json": JSON.stringify({ scripts: { lint: "eslint .", test: "turbo run test --filter=web" } }),
      "turbo.json": `{\n  // кэш\n  "globalPassThroughEnv": ["SENTRY_*", "ELVES_SLOT_CPUS",],\n  "tasks": { "test": {} }\n}\n`,
    });
    const ready = `"globalPassThroughEnv": ["SENTRY_*", "ELVES_SLOT_CPUS", "ELVES_SLOT"]`;
    const i = install();
    expect(i.code).toBe(0);
    expect(i.stderr).toContain(`!! turbo.json — ELVES_SLOT doesn't reach the runner`);
    expect(i.stderr).toContain(ready);
    const c = elves(sb, ["check"]);
    expect(c.code).toBe(0);
    expect(c.stdout).toMatch(/up to date[^\n]*\n {2}! turbo\.json — ELVES_SLOT doesn't reach the runner: turbo in strict env mode/);
    expect(c.stdout).toContain(ready);
    expect(elves(sb, ["check", "--hook"]).stdout).toContain(ready);
  });

  it("предупреждения нет, если переменные очереди доходят до задач turbo — globalPassThroughEnv или globalEnv с масками, envMode loose, --env-mode=loose — или turbo зовёт скрипт вне очереди", () => {
    const warning = (scripts: Record<string, string>, turbo: string, file = "turbo.json") => {
      for (const f of ["turbo.json", "turbo.jsonc"]) rmSync(path.join(proj, f), { force: true });
      writeTree(proj, { "package.json": JSON.stringify({ scripts }), [file]: turbo });
      return /^!! turbo\.jsonc? — .*$/m.exec(install().stderr)?.[0] ?? null;
    };
    const test = { test: "npx turbo test" };
    expect(warning(test, `{ "tasks": {} }`)).toContain(`"globalPassThroughEnv": ["ELVES_SLOT", "ELVES_SLOT_CPUS"]`);
    expect(warning(test, `{ "globalPassThroughEnv": ["ELVES_SLOT", "ELVES_SLOT_CPUS"] }`)).toBeNull();
    expect(warning(test, `{ "globalEnv": ["ELVES_*"] }`)).toBeNull();
    expect(warning(test, `{ "globalPassThroughEnv": ["ELVES_*", "!ELVES_SLOT"] }`)).toContain(`"globalPassThroughEnv": ["ELVES_*", "ELVES_SLOT"]`);
    expect(warning(test, `{ "envMode": "loose" }`)).toBeNull();
    expect(warning({ test: "turbo run test --env-mode=loose" }, `{}`)).toBeNull();
    expect(warning({ test: "vitest run --turbo" }, `{}`)).toBeNull();
    expect(warning({ build: "turbo run build" }, `{}`)).toBeNull();
    expect(warning(test, `{ /* JSONC */ "tasks": {}, }`, "turbo.jsonc")).toMatch(/^!! turbo\.jsonc — /);
    expect(warning(test, `{ /* JSONC */ "globalPassThroughEnv": ["ELVES_SLOT", "ELVES_SLOT_CPUS"] }`, "turbo.jsonc")).toBeNull();
  });

  /**
   * Подъём стека — тяжёлая работа машины (capability `task-env#stacks`): `task-env up` ждёт очередь до здоровья
   * контейнеров, а свой `docker compose up` скрипта — нет. В шим его не обернуть: шим держит слот, пока идёт скрипт, а
   * `docker compose up` без `-d` идёт до Ctrl+C. Поэтому install и check называют скрипт с заменой, отставанием это не
   * считается.
   */
  it("скрипт package.json поднимает стек docker compose up мимо task-env — install и check называют его с заменой task-env up, отставанием это не считается", () => {
    writeTree(proj, {
      "package.json": JSON.stringify({
        scripts: {
          lint: "eslint .",
          "db:up": "docker compose -f compose.db.yaml up -d --wait",
          stack: "docker-compose up",
          "db:logs": "docker compose logs -f db",
          "stack:task": "elves task-env up",
        },
      }),
    });
    const line = "! package.json — db:up, stack — bring a stack up with docker compose up outside the machine queue (slot): its start chokes neighbors' runs — bring it up with `bun --no-env-file node_modules/.bin/elves task-env up`, it waits for the queue until the containers are healthy";
    const i = install();
    expect(i.code).toBe(0);
    expect(i.stderr).toContain(`!${line}\n`);
    const c = elves(sb, ["check"]);
    expect(c.code).toBe(0);
    expect(c.stdout).toContain(`  ${line}\n`);
    writeTree(proj, { "package.json": JSON.stringify({ scripts: { lint: "eslint .", "stack:task": "elves task-env up" } }) });
    expect(elves(sb, ["check"]).stdout).not.toContain("docker compose up");
  });
});

/**
 * В тонком проекте копии канона нет (#557): агент получает его с машины. Claude Code грузит `~/.claude/rules` без
 * диалога внешних импортов и во всех проектах машины.
 */
describe("На машину (-g) — канон, скиллы и хук: тонкий проект берёт канон с машины", () => {
  const canon = () => realpathSync(path.join(home, ".agents/elves/AGENTS.md"));

  it("скилл, которого больше нет в Elves, при переустановке удаляется; свой скилл на машине не трогается", () => {
    mkdirSync(path.join(home, ".claude"));
    install(["-g"]);
    const manifest = path.join(home, ".agents/elves.json");
    const m = JSON.parse(read(manifest));
    writeFileSync(manifest, JSON.stringify({ ...m, skills: [...m.skills, "old"] }));
    writeTree(home, { ".agents/skills/old/SKILL.md": "old", ".agents/skills/mine/SKILL.md": "mine" });
    symlinkSync("../../.agents/skills/old", path.join(home, ".claude/skills/old"));
    install(["-g"]);
    expect(existsSync(path.join(home, ".agents/skills/old"))).toBe(false);
    expect(existsSync(path.join(home, ".claude/skills/old"))).toBe(false);
    expect(read(path.join(home, ".agents/skills/mine/SKILL.md"))).toBe("mine");
  });

  it("чужой каталог с именем скилла Elves не перезаписывается — предупреждение", () => {
    writeTree(home, { ".agents/skills/spec/SKILL.md": "свой spec" });
    const r = install(["-g"]);
    expect(read(path.join(home, ".agents/skills/spec/SKILL.md"))).toBe("свой spec");
    expect(r.stderr).toContain(".agents/skills/spec");
  });

  it("в ~/.agents/elves.json — SHA Elves, из которого поставлено: у клона — его HEAD", () => {
    install(["-g"]);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
    expect(JSON.parse(read(path.join(home, ".agents/elves.json"))).sha).toBe(head);
  });

  /** Поля проекта (`env`, `batch`, `auto`, `language`) живут в `.agents/elves.json` проекта, у машины их не бывает. */
  it("install -g пишет в манифест машины только поля установки — source, sha, tag, clone и skills: поля проекта из прежнего манифеста не переносит", () => {
    install(["-g"]);
    const manifest = path.join(home, ".agents/elves.json");
    const env = { services: { web: 3000 } };
    writeFileSync(manifest, JSON.stringify({ ...JSON.parse(read(manifest)), env, batch: true, auto: true, language: "ru" }));
    install(["-g"]);
    const m = JSON.parse(read(manifest));
    expect(m.skills).toEqual(SKILLS);
    expect(Object.keys(m).filter((k) => !["source", "sha", "tag", "clone", "skills"].includes(k))).toEqual([]);
  });

  /**
   * bunx ставит пакет из GitHub архивом, без `.git`, и в `.bun-tag` оставляет лишь 7 знаков SHA: полный коммит виден
   * только в спецификаторе, по которому поставлено, — `package.json` каталога bunx рядом с node_modules.
   */
  it("из пакета bunx — SHA из спецификатора в package.json каталога bunx", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const bin = bunxPackage(path.join(tmp, "bunx"), src.dir, sha);
    expect(elves(sb, ["install", "-g"], { bin }).code).toBe(0);
    expect(JSON.parse(read(path.join(home, ".agents/elves.json"))).sha).toBe(sha);
  });

  /**
   * Пакет называется `@miroshnik/elves` (#556): bun кладёт зависимость по имени пакета — в `node_modules/@miroshnik/elves`,
   * спецификатор — под полным именем. Не узнай установщик SHA, пакет релиза счёл бы себя пускателем из main и
   * перезапускался бы снова и снова.
   */
  it("из пакета под scope @miroshnik — SHA из спецификатора под полным именем пакета", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const bin = bunxPackage(path.join(tmp, "bunx"), src.dir, sha, "@miroshnik/elves");
    expect(elves(sb, ["install", "-g"], { bin }).code).toBe(0);
    expect(JSON.parse(read(path.join(home, ".agents/elves.json"))).sha).toBe(sha);
  });

  it("install -g ставит канон в ~/.agents/elves и симлинки ~/.claude/rules/elves*.md", () => {
    mkdirSync(path.join(home, ".claude"));
    expect(install(["-g"]).code).toBe(0);
    expect(read(path.join(home, ".agents/elves/AGENTS.md"))).toBe(read(path.join(REPO, "AGENTS.md")));
    expect(read(path.join(home, ".agents/elves/claude/CLAUDE.md"))).toBe(read(path.join(REPO, "claude/CLAUDE.md")));
    expect(existsSync(path.join(home, ".agents/elves/docs/ci-concurrency.md"))).toBe(true);
    expect(isLink(path.join(home, ".agents/elves"))).toBe(false);
    expect(readlinkSync(path.join(home, ".claude/rules/elves.md"))).toBe("../../.agents/elves/AGENTS.md");
    expect(readlinkSync(path.join(home, ".claude/rules/elves-claude.md"))).toBe("../../.agents/elves/claude/CLAUDE.md");
    expect(isLink(path.join(home, ".agents/skills/spec"))).toBe(false);
    expect(readlinkSync(path.join(home, ".claude/skills/spec"))).toBe("../../.agents/skills/spec");
    expect(read(path.join(home, ".claude/settings.json"))).toContain("check --hook");
    // агентов, которых на машине нет, установка не заводит
    for (const p of [".codex", ".gemini", ".copilot", ".config/opencode", ".config/amp"]) expect(gone(path.join(home, p))).toBe(true);
    expect(existsSync(path.join(proj, ".agents"))).toBe(false);
  });

  /**
   * Справка, которую агент «читает по необходимости», за 1–16 ноября прочитана 12 раз на 69 сессий (#846): правило
   * Claude Code с `paths:` грузится само, когда агент читает или правит подходящий файл.
   */
  it("Справка с `paths:` ставится в правила машины и называет файлы, при которых грузится", () => {
    mkdirSync(path.join(home, ".claude"));
    const r = install(["-g"]);
    expect(r.code).toBe(0);
    const rule = path.join(home, ".claude/rules/elves-testing.md");
    expect(readlinkSync(rule)).toBe("../../.agents/elves/docs/testing.md");
    expect(read(rule)).toStartWith('---\npaths:\n  - "**/*.test.*"\n');
    expect(r.stdout).toContain(".claude/rules/elves-testing.md → .agents/elves/docs/testing.md (loads with **/*.test.*, **/*.spec.*");
    expect(readlinkSync(path.join(home, ".claude/rules/elves-ci-concurrency.md"))).toBe("../../.agents/elves/docs/ci-concurrency.md");
    // документ для человека — не правило: без paths: в правила машины не ставится
    expect(gone(path.join(home, ".claude/rules/elves-installation.md"))).toBe(true);
    // check -g называет недостающее правило справки отставанием, install -g ставит его снова
    rmSync(rule);
    const check = elves(sb, ["check", "-g"]);
    expect(check.code).toBe(1);
    expect(check.stdout).toContain(`+ ~/.claude/rules/elves-testing.md — loads with **/*.test.*`);
    expect(install(["-g"]).code).toBe(0);
    expect(isLink(rule)).toBe(true);
  });

  it("правило справки, которая больше не правило, обновление машины убирает; своё правило пользователя остаётся", () => {
    mkdirSync(path.join(home, ".claude"));
    install(["-g"]);
    symlinkSync("../../.agents/elves/docs/judgment.md", path.join(home, ".claude/rules/elves-judgment.md"));
    writeTree(home, { "rules/mine.md": "мои правила\n" });
    symlinkSync(path.join(home, "rules/mine.md"), path.join(home, ".claude/rules/elves-mine.md"));
    expect(elves(sb, ["check", "-g"]).stdout).toContain("- ~/.claude/rules/elves-judgment.md — the reference is no longer a rule");
    expect(install(["-g"]).code).toBe(0);
    expect(gone(path.join(home, ".claude/rules/elves-judgment.md"))).toBe(true);
    expect(read(path.join(home, ".claude/rules/elves-mine.md"))).toBe("мои правила\n");
  });

  it("старый симлинк install.sh ~/.claude/CLAUDE.md → claude/CLAUDE.md убирается — правила не грузятся дважды", () => {
    mkdirSync(path.join(home, ".claude"));
    symlinkSync(path.join(REPO, "claude/CLAUDE.md"), path.join(home, ".claude/CLAUDE.md"));
    install(["-g"]);
    expect(existsSync(path.join(home, ".claude/CLAUDE.md"))).toBe(false);
  });

  it("свой ~/.claude/CLAUDE.md пользователя остаётся", () => {
    writeTree(home, { ".claude/CLAUDE.md": "мои заметки\n" });
    install(["-g"]);
    expect(read(path.join(home, ".claude/CLAUDE.md"))).toBe("мои заметки\n");
  });

  // клон — копия пакета в песочнице, настоящий не трогаем
  it("--link из клона — канон и скиллы машины — симлинки на клон, правка в клоне видна сразу; путь клона — в ~/.agents/elves.json", () => {
    mkdirSync(path.join(home, ".claude"));
    const clone = elvesPackage(path.join(tmp, "clone"));
    expect(elves(sb, ["install", "-g", "--link"], { bin: clone.bin }).code).toBe(0);
    expect(realpathSync(path.join(home, ".agents/elves"))).toBe(realpathSync(clone.dir));
    expect(realpathSync(path.join(home, ".claude/rules/elves.md"))).toBe(realpathSync(path.join(clone.dir, "AGENTS.md")));
    expect(realpathSync(path.join(home, ".claude/rules/elves-claude.md"))).toBe(realpathSync(path.join(clone.dir, "claude/CLAUDE.md")));
    expect(realpathSync(path.join(home, ".agents/skills/spec"))).toBe(realpathSync(path.join(clone.dir, "skills/spec")));
    expect(realpathSync(path.join(home, ".claude/skills/spec"))).toBe(realpathSync(path.join(clone.dir, "skills/spec")));
    expect(realpathSync(JSON.parse(read(path.join(home, ".agents/elves.json"))).clone)).toBe(realpathSync(clone.dir));
    writeFileSync(path.join(clone.dir, "AGENTS.md"), "правка в клоне\n");
    expect(read(path.join(home, ".claude/rules/elves.md"))).toBe("правка в клоне\n");
  });

  /**
   * Канон клона Elves — его корень: Claude Code сам читает корневой AGENTS.md, если CLAUDE.md нет, а правила машины с
   * `--link` ведут в тот же клон. Клон поэтому не грузит канон сам — ни симлинком в `.claude/rules`, ни корневым
   * AGENTS.md: `.claude/CLAUDE.md` клона выключает чтение AGENTS.md. Клон песочницы получает файлы `.claude/`, которые
   * закоммичены в Elves.
   */
  it("в клоне elves с --link канон не грузится дважды", () => {
    mkdirSync(path.join(home, ".claude"));
    const clone = elvesPackage(path.join(tmp, "clone"));
    for (const rel of execFileSync("git", ["ls-files", "-z", ".claude"], { cwd: REPO, encoding: "utf8" }).split("\0").filter(Boolean)) {
      mkdirSync(path.dirname(path.join(clone.dir, rel)), { recursive: true });
      cpSync(path.join(REPO, rel), path.join(clone.dir, rel), { verbatimSymlinks: true });
    }
    expect(elves(sb, ["install", "-g", "--link"], { bin: clone.bin }).code).toBe(0);
    const loaded = loadedAtStart(home, clone.dir, tmp);
    const once = (rel: string) => loaded.filter((p) => p === realpathSync(path.join(clone.dir, rel)));
    expect(once("AGENTS.md")).toHaveLength(1);
    expect(once("claude/CLAUDE.md")).toHaveLength(1);
    expect(new Set(loaded).size).toBe(loaded.length);
  });

  /** Хук проверяет флоу в начале каждой сессии Claude Code; что он делает — capability `elves#update`. */
  it("с Claude Code — хук SessionStart в ~/.claude/settings.json запускает check --hook; свои настройки и хуки на месте, повторная установка хук не дублирует", () => {
    const mine = { hooks: [{ type: "command", command: "echo мой хук" }] };
    writeTree(home, { ".claude/settings.json": JSON.stringify({ model: "opus", hooks: { SessionStart: [mine], Stop: [mine] } }) });
    install(["-g"]);
    install(["-g"]);
    const s = JSON.parse(read(path.join(home, ".claude/settings.json")));
    expect(s.model).toBe("opus");
    expect(s.hooks.Stop).toEqual([mine]);
    expect(s.hooks.SessionStart[0]).toEqual(mine);
    const ours = s.hooks.SessionStart.filter((g: { hooks: { command: string }[] }) => g.hooks.some((h) => h.command.includes("elves check --hook")));
    expect(ours).toHaveLength(1);
    expect(ours[0].matcher).toContain("startup");
    expect(ours[0].hooks[0].timeout).toBeGreaterThan(0);
  });

  /**
   * Хук PreToolUse (#839, capability `github#github-guard`): обход команды флоу — `gh issue view` задачи, `gh run watch` —
   * запрещён с командой флоу в причине. Обработчик на каждое правило списка обходов: `if` Claude Code берёт одно правило;
   * команда — скрипт github машины по пути, без bunx и сети. Команду из settings.json запускаем, как Claude Code: через
   * shell, вход хука — на stdin.
   */
  it("Установка на машину ставит хук, проверка машины называет отсутствующий", () => {
    const mine = { matcher: "Edit", hooks: [{ type: "command", command: "echo мой хук" }] };
    writeTree(home, { ".claude/settings.json": JSON.stringify({ hooks: { PreToolUse: [mine] } }) });
    expect(install(["-g"]).code).toBe(0);
    expect(install(["-g"]).code).toBe(0);
    const file = path.join(home, ".claude/settings.json");
    const groups = JSON.parse(read(file)).hooks.PreToolUse;
    expect(groups[0]).toEqual(mine);
    expect(groups).toHaveLength(2);
    const guard = groups[1];
    const script = path.join(home, ".agents/skills/github/scripts/github.ts");
    expect(guard.matcher).toBe("Bash");
    expect(guard.hooks.map((h: { if: string }) => h.if)).toEqual(BYPASSES.map((b) => b.rule));
    for (const h of guard.hooks) expect(h).toEqual({ type: "command", if: h.if, command: `bun --no-env-file '${script}' hook guard`, timeout: 10 });

    // команда хука из settings.json запрещает `gh issue view` задачи репозитория сессии и называет task show скрипта машины
    execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/shop.git"], { cwd: proj });
    const stdin = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status && gh issue view 7" }, cwd: proj });
    const r = spawnSync("sh", ["-c", guard.hooks[0].command], { cwd: proj, env, input: stdin, encoding: "utf8" });
    expect(r.status).toBe(0);
    const decision = JSON.parse(r.stdout).hookSpecificOutput;
    expect(decision).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(decision.permissionDecisionReason).toEndWith(`Run instead: bun --no-env-file ${realpathSync(script)} task show 7`);

    // машина без хука — check -g называет его отставанием, install -g ставит снова
    writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [mine], SessionStart: JSON.parse(read(file)).hooks.SessionStart } }));
    const check = elves(sb, ["check", "-g"]);
    expect(check.code).toBe(1);
    expect(check.stdout).toContain("  ~ ~/.claude/settings.json — the PreToolUse hook: a bypass of a flow command (gh issue view of a task, gh run watch) denied with the flow's command\n");
    expect(check.stdout).not.toContain("the SessionStart hook");
    expect(install(["-g"]).code).toBe(0);
    expect(elves(sb, ["check", "-g"]).stdout).not.toContain("PreToolUse");
  });

  /**
   * Вывод хука с кодом 0 Claude Code кладёт в контекст сессии: `--silent` — первая установка пакета bunx печатает свой
   * прогресс в stderr, а хук сводит stderr в вывод.
   */
  it("команда хука — bunx --silent github:miroshnik/elves check --hook, вывод с ошибками и запасной echo при сбое bunx", () => {
    mkdirSync(path.join(home, ".claude"));
    install(["-g"]);
    const hooks = JSON.parse(read(path.join(home, ".claude/settings.json"))).hooks.SessionStart.flatMap((g: { hooks: { command: string }[] }) => g.hooks);
    expect(hooks[0].command).toMatch(/^bunx --silent github:miroshnik\/elves check --hook 2>&1 \|\| echo "elves check unavailable/);
  });

  /** Хук прошлой версии — с запасным текстом по-русски: установка узнаёт свой хук по команде `check --hook`. */
  it("хук прошлой версии с запасным текстом по-русски install -g заменяет, а не ставит второй", () => {
    const command = 'npx -y --loglevel=error github:miroshnik/elves check --hook 2>&1 || echo "elves check недоступен (код $?): работай по текущему флоу и скажи об этом"';
    const old = { matcher: "startup|resume|clear", hooks: [{ type: "command", command, timeout: 60 }] };
    writeTree(home, { ".claude/settings.json": JSON.stringify({ hooks: { SessionStart: [old] } }) });
    expect(install(["-g"]).code).toBe(0);
    const hooks = JSON.parse(read(path.join(home, ".claude/settings.json"))).hooks.SessionStart.flatMap((g: { hooks: { command: string }[] }) => g.hooks);
    expect(hooks).toHaveLength(1);
    expect(hooks[0].command).toContain("github:miroshnik/elves check --hook");
    expect(hooks[0].command).not.toMatch(/\p{Script=Cyrillic}/u);
  });

  it("без Claude Code на машине — хука нет, ~/.claude не создаётся", () => {
    mkdirSync(path.join(home, ".codex"));
    expect(install(["-g"]).code).toBe(0);
    expect(existsSync(path.join(home, ".claude"))).toBe(false);
  });

  it("ELVES_PRIVATE — ~/.config/elves становится симлинком на личную конфигурацию", () => {
    const priv = path.join(tmp, "private");
    mkdirSync(priv);
    install(["-g"], proj, { ELVES_PRIVATE: priv });
    expect(readlinkSync(path.join(home, ".config/elves"))).toBe(priv);
  });
});

/**
 * Скилл `dashboard` убран (#834): его вкладку «Сессии» повторяют боковая панель и уведомления приложения, «Оценку и
 * факт» — `est period`. Машина прошлой версии держит его каталог и ссылку Claude Code — обновление убирает их, как любой
 * скилл, которого в Elves больше нет; скрипты флоу его не зовут и не упоминают.
 */
describe("Скилла dashboard во флоу нет: установка его не ставит, обновление машины убирает", () => {
  const dashboard = () => [path.join(home, ".agents/skills/dashboard"), path.join(home, ".claude/skills/dashboard")];

  it("Установка на машину не ставит скилл `dashboard`", () => {
    mkdirSync(path.join(home, ".claude"));
    expect(install(["-g"]).code).toBe(0);
    expect(dashboard().filter((p) => !gone(p))).toEqual([]);
    expect(JSON.parse(read(path.join(home, ".agents/elves.json"))).skills).not.toContain("dashboard");
  });

  it("Обновление машины убирает скилл `dashboard`, поставленный прошлой версией", () => {
    mkdirSync(path.join(home, ".claude"));
    const prev = elvesPackage(path.join(tmp, "prev"), {
      "skills/dashboard/SKILL.md": "---\nname: dashboard\ndescription: страница сессий\n---\n",
      "skills/dashboard/scripts/dashboard.ts": "export {};\n",
    });
    expect(elves(sb, ["install", "-g"], { bin: prev.bin }).code).toBe(0);
    expect(readlinkSync(path.join(home, ".claude/skills/dashboard"))).toBe("../../.agents/skills/dashboard");
    expect(elves(sb, ["update", "-g"]).code).toBe(0);
    expect(dashboard().filter((p) => !gone(p))).toEqual([]);
    const check = elves(sb, ["check", "-g"]);
    expect(check.code).toBe(0);
    expect(check.stdout + check.stderr).not.toContain("dashboard");
  });

  it("Ни один скрипт флоу не импортирует и не называет `dashboard`", () => {
    expect(sources(REPO, ["bin", "skills"]).filter((f) => /\bdashboard\b/i.test(f.text)).map((f) => f.file)).toEqual([]);
  });
});

/**
 * Эльфы — для Claude Code (#848): за два месяца на машине нет сессий других агентов, кроме четырёх сессий Codex, а хуки,
 * пин сессии к задаче, факт из транскриптов, диспетчер и архивация сессии есть только у Claude Code. Файлов правил
 * других агентов установка не пишет; машина прошлой версии держит их симлинками на канон — обновление убирает свои и
 * оставляет чужие. Другому агенту — короткая инструкция `docs/other-agents.md`, на неё ссылается README.
 */
describe("Эльфы — для Claude Code: файлов правил других агентов установка не пишет, другому агенту — инструкция", () => {
  /** Каталоги агентов в домашнем и файлы правил, которые в них писала прошлая версия. */
  const OLD_RULES: Record<string, string> = {
    ".codex": ".codex/AGENTS.md",
    ".gemini": ".gemini/GEMINI.md",
    ".copilot": ".copilot/copilot-instructions.md",
    ".config/opencode": ".config/opencode/AGENTS.md",
    ".config/amp": ".config/amp/AGENTS.md",
  };
  const agentDirs = () => {
    for (const dir of Object.keys(OLD_RULES)) mkdirSync(path.join(home, dir), { recursive: true });
  };
  /** Файл правил, как его писала прошлая версия, — относительный симлинк на AGENTS.md канона машины. */
  const oldRules = (rel: string) => {
    const file = path.join(home, rel);
    symlinkSync(path.relative(path.dirname(file), path.join(home, ".agents/elves/AGENTS.md")), file);
  };

  it("Установка на машину не пишет файлы правил других агентов", () => {
    mkdirSync(path.join(home, ".claude"));
    mkdirSync(path.join(home, ".cursor"));
    agentDirs();
    const r = install(["-g"]);
    expect(r.code).toBe(0);
    for (const dir of [...Object.keys(OLD_RULES), ".cursor"]) expect(readdirSync(path.join(home, dir))).toEqual([]);
    expect(r.stdout + r.stderr).not.toMatch(/Codex|Gemini|Copilot|OpenCode|\bAmp\b|Cursor/);
  });

  it("Обновление машины убирает файлы правил других агентов, поставленные прошлой версией, и оставляет чужие", () => {
    mkdirSync(path.join(home, ".claude"));
    agentDirs();
    expect(install(["-g"]).code).toBe(0);
    // свои — симлинки прошлой версии на канон; чужие — файл с правилами пользователя и симлинк на его собственный
    oldRules(".gemini/GEMINI.md");
    oldRules(".copilot/copilot-instructions.md");
    writeTree(home, { ".config/amp/AGENTS.md": "мои правила\n", "rules/mine.md": "мои правила\n" });
    symlinkSync(path.join(home, "rules/mine.md"), path.join(home, ".config/opencode/AGENTS.md"));
    const before = elves(sb, ["check", "-g"]);
    expect(before.code).toBe(1);
    expect(before.stdout).toContain("  - ~/.gemini/GEMINI.md\n");
    expect(before.stdout).toContain("  - ~/.copilot/copilot-instructions.md\n");
    expect(before.stdout).not.toMatch(/opencode|amp/);
    const r = elves(sb, ["update", "-g"]);
    expect(r.code).toBe(0);
    expect(gone(path.join(home, ".gemini/GEMINI.md"))).toBe(true);
    expect(gone(path.join(home, ".copilot/copilot-instructions.md"))).toBe(true);
    expect(r.stdout).toContain("~/.gemini/GEMINI.md — removed: Elves is for Claude Code; another agent connects the canon itself — ~/.agents/elves/docs/other-agents.md\n");
    expect(existsSync(path.join(home, ".agents/elves/docs/other-agents.md"))).toBe(true);
    expect(read(path.join(home, ".config/amp/AGENTS.md"))).toBe("мои правила\n");
    expect(readlinkSync(path.join(home, ".config/opencode/AGENTS.md"))).toBe(path.join(home, "rules/mine.md"));
    expect(elves(sb, ["check", "-g"]).code).toBe(0);
  });

  it("README называет только Claude Code и ссылается на инструкцию для других агентов", () => {
    const readme = read(path.join(REPO, "README.md"));
    expect(readme).toContain("For Claude Code");
    expect(readme).not.toMatch(/\b(?:Codex|Gemini|Cursor|Copilot|OpenCode|Amp)\b/);
    expect(readme).not.toMatch(/all agents|every agent/i);
    expect(readme).toContain("](docs/other-agents.md)");
  });

  it("Обновление машины убирает `~/.codex/AGENTS.md`, поставленный прошлой версией: Codex убран в #836, а файл остался на машинах", () => {
    mkdirSync(path.join(home, ".claude"));
    writeTree(home, { ".codex/config.toml": 'model = "gpt-5"\n' });
    expect(install(["-g"]).code).toBe(0);
    oldRules(".codex/AGENTS.md");
    expect(elves(sb, ["update", "-g"]).code).toBe(0);
    expect(gone(path.join(home, ".codex/AGENTS.md"))).toBe(true);
    expect(readdirSync(path.join(home, ".codex"))).toEqual(["config.toml"]);
  });
});

/**
 * Команда `elves` в терминале (#632): `bunx @miroshnik/elves …` и `bun <клон>/bin/elves.ts …` — не команда, а каталог
 * глобальных bin Bun (`~/.bun/bin`) часто не в PATH. `install -g` кладёт её в `~/.local/bin` или в первый каталог PATH
 * внутри домашнего, куда можно писать: с `--link` — ссылкой на `bin/elves.ts` клона, иначе — шимом на релиз машины.
 * PATH песочницы — `~/.local/bin` и её bin: каталог вне домашнего, хоть в него и можно писать, установка не берёт.
 */
describe("Команда elves в терминале — install -g ставит её в каталог из PATH", () => {
  const commandPath = () => ({ PATH: `${path.join(home, ".local/bin")}:${sb.bin}` });
  const command = () => path.join(home, ".local/bin/elves");
  const run = (file: string, args: string[]) => spawnSync(file, args, { cwd: proj, env: { ...env, ...commandPath() }, encoding: "utf8" });

  it("install -g --link ставит elves ссылкой на bin/elves.ts клона в каталог из PATH", () => {
    const clone = elvesPackage(path.join(tmp, "clone"));
    const r = elves(sb, ["install", "-g", "--link"], { bin: clone.bin, env: commandPath() });
    expect(r.code).toBe(0);
    expect(isLink(command())).toBe(true);
    expect(realpathSync(command())).toBe(realpathSync(clone.bin));
    expect(r.stdout).toContain("~/.local/bin/elves — the elves command in the terminal: → ");
    // команда работает через ссылку: справка грузит скрипты скиллов из клона
    const help = run(command(), ["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("elves — the rules and skills of the Elves flow");
  });

  it("install -g пакетом ставит шим elves на версию машины", () => {
    const r = elves(sb, ["install", "-g"], { bin: release.bin, env: commandPath() });
    expect(r.code).toBe(0);
    expect(isLink(command())).toBe(false);
    expect(read(command())).toContain(`exec bunx --silent @miroshnik/elves@${VERSION} "$@"\n`);
    expect(r.stdout).toContain(`~/.local/bin/elves — the elves command in the terminal: bunx --silent @miroshnik/elves@${VERSION}\n`);
    // шим запускает пакет релиза машины через bunx
    const served = path.join(tmp, "served");
    npmPackage(path.join(served, `npm@${VERSION}`), src.dir, VERSION, src.sha);
    bunxServesPackages(sb, served);
    const help = run(command(), ["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("elves — the rules and skills of the Elves flow");
    // повтор — тот же шим, без строки о нём
    const again = elves(sb, ["install", "-g"], { bin: release.bin, env: commandPath() });
    expect(again.stdout).not.toContain("~/.local/bin/elves");
  });

  it("чужой elves в каталоге не перезаписывается и называется в выводе", () => {
    const mine = "#!/bin/sh\necho мой elves\n";
    writeTree(home, { ".local/bin/elves": mine });
    chmodSync(command(), 0o755);
    const r = install(["-g"], proj, commandPath());
    expect(r.code).toBe(0);
    expect(read(command())).toBe(mine);
    expect(r.stderr).toContain("!! ~/.local/bin/elves — someone else's elves (a script of the user's, a global package) — left as is");
    const c = elves(sb, ["check", "-g"], { env: commandPath() });
    expect(c.code).toBe(0);
    expect(c.stdout).toContain("  ! ~/.local/bin/elves — someone else's elves (a script of the user's, a global package) — left as is; the machine's command goes here once it's removed: bunx @miroshnik/elves update -g\n");
    // ссылка глобального пакета Bun — тоже чужая
    rmSync(command());
    const global = path.join(home, ".bun/install/global/node_modules/@miroshnik/elves/bin/elves.ts");
    writeTree(home, { [path.relative(home, global)]: "// глобальный пакет\n" });
    symlinkSync(global, command());
    expect(install(["-g"], proj, commandPath()).code).toBe(0);
    expect(readlinkSync(command())).toBe(global);
  });

  it("без подходящего каталога в PATH install -g не ставит команду, а check -g называет, как добавить каталог", () => {
    const zsh = { SHELL: "/bin/zsh" };
    const r = install(["-g"], proj, zsh);
    expect(r.code).toBe(0);
    expect(gone(path.join(home, ".local"))).toBe(true);
    expect(readdirSync(sb.bin)).not.toContain("elves");
    const line = `the elves command in the terminal isn't installed: PATH has no directory inside the home directory that can be written — add ~/.local/bin: mkdir -p ~/.local/bin && echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && PATH="$HOME/.local/bin:$PATH" bunx @miroshnik/elves update -g`;
    expect(r.stdout).toContain(`${line}\n`);
    const c = elves(sb, ["check", "-g"], { env: zsh });
    expect(c.code).toBe(0);
    expect(c.stdout).toContain(`  ! ~/.local/bin/elves — ${line}\n`);
  });
});

/**
 * Commit, push и мерж необратимы, поэтому по умолчанию они — по «да» владельца. Проект может разрешить агенту вести
 * задачу целиком самому: ответ хранится в манифесте проекта, а не на машине — его видят другой чекаут и любой
 * агент. Сам вопрос в терминале тестом не покрыт: псевдотерминала без зависимостей у Node нет.
 */
describe("Задача целиком без спроса — настройка проекта, по умолчанию «нет»", () => {
  const manifest = (root: string) => JSON.parse(read(path.join(root, ".agents/elves.json")));

  it("без терминала и без флага вопроса нет — у новой установки в .agents/elves.json auto: false", () => {
    const r = install();
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("Let the agent do tasks");
    expect(manifest(proj).auto).toBe(false);
  });

  it("--auto пишет auto: true, повторный install без флага его сохраняет, --no-auto возвращает false", () => {
    expect(install(["--auto"]).code).toBe(0);
    expect(manifest(proj).auto).toBe(true);
    expect(install().code).toBe(0);
    expect(manifest(proj).auto).toBe(true);
    expect(install(["--no-auto"]).code).toBe(0);
    expect(manifest(proj).auto).toBe(false);
  });

  it("install -g настройку не спрашивает и не хранит — в ~/.agents/elves.json поля auto нет", () => {
    const r = install(["-g"]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("Let the agent do tasks");
    expect(manifest(home).skills).toEqual(SKILLS);
    expect(manifest(home)).not.toHaveProperty("auto");
    expect(existsSync(path.join(proj, ".agents"))).toBe(false);
  });

  /** Клон Elves — сам канон: правила в его корне, копия флоу в нём — лишняя. Режим у него свой, как у проекта. */
  it("в клоне Elves install флоу не ставит — пишет в .agents/elves.json auto и language: с флагом — его значение, без флага и терминала — прежнее", () => {
    const clone = bareClone(path.join(tmp, "clone"));
    expect(install(["--auto"], clone).code).toBe(0);
    expect(manifest(clone)).toEqual({ auto: true, language: "en" });
    expect(install([], clone).code).toBe(0);
    expect(manifest(clone)).toEqual({ auto: true, language: "en" });
    expect(install(["--no-auto", "--lang", "ru"], clone).code).toBe(0);
    expect(manifest(clone)).toEqual({ auto: false, language: "ru" });
    expect(readdirSync(clone).sort()).toEqual([".agents", ".git", "package.json"]);
    expect(readdirSync(path.join(clone, ".agents"))).toEqual(["elves.json"]);
  });

  /**
   * Поля проекта — `env` (стек задачи) и `batch` (пачки диспетчера, эпик #645) — пишет сам проект, и клон Elves тоже: с
   * `"batch": true` Elves ведёт задачи пачками (#661). Установщик переносит их одним правилом для клона и тонкого
   * проекта — иначе смена режима или языка в клоне молча выключала бы пачки (#672).
   */
  it("install в клоне Elves с batch сохраняет batch в .agents/elves.json, как в тонком проекте", () => {
    const clone = bareClone(path.join(tmp, "clone"));
    const env = { http: { web: 3000 } };
    for (const root of [proj, clone]) {
      expect(install(["--auto"], root).code).toBe(0);
      writeFileSync(path.join(root, ".agents/elves.json"), JSON.stringify({ ...manifest(root), env, batch: true }, null, 2) + "\n");
      expect(install(["--no-auto", "--lang", "ru"], root).code).toBe(0);
      expect(manifest(root)).toEqual({ auto: false, language: "ru", env, batch: true });
    }
  });

  /**
   * Пакет — `@miroshnik/elves` (#556), до него назывался по репозиторию: `elves`. Клон или ветка, ещё не получившие
   * новое имя, — тот же клон: флоу в него не ставится, check не зовёт его
   * отставшим.
   */
  it("клон со старым именем пакета — elves — узнаётся как клон", () => {
    for (const name of ["elves"]) {
      const clone = bareClone(path.join(tmp, `clone-${name}`), name);
      expect(install(["--auto", "--lang", "ru"], clone).code).toBe(0);
      expect(manifest(clone)).toEqual({ auto: true, language: "ru" });
      expect(readdirSync(clone).sort()).toEqual([".agents", ".git", "package.json"]);
      const check = elves(sb, ["check"], { cwd: clone });
      expect(check.code).toBe(0);
      expect(check.stdout).toStartWith("Elves in the project: not installed — an Elves clone, the canon is at its root\n");
    }
  });
});

/**
 * Два правила канона Claude Code держит своей настройкой (#840): «commit, push и мерж — по „да“» в проекте без `auto` —
 * правила `permissions.ask` в `.claude/settings.json` проекта, их спрашивает само приложение, и в режиме разрешений
 * `auto` тоже; «свежему worktree скопировать `.env*.local`» — `.worktreeinclude`, по нему приложение копирует
 * игнорируемые git файлы в каждый новый worktree. Своими установка считает ровно свои строки: чужие правила и строки
 * проекта остаются.
 */
describe("Родные настройки Claude Code вместо правил канона: permissions.ask в проекте без auto и .worktreeinclude", () => {
  const ASK = ["Bash(git commit *)", "Bash(git push *)", "Bash(gh pr merge *)"];
  const settingsFile = () => path.join(proj, ".claude/settings.json");
  const settings = () => JSON.parse(read(settingsFile()));
  const include = () => read(path.join(proj, ".worktreeinclude"));

  it("Установка в проект без `auto` пишет правила `ask` на commit, push и мерж", () => {
    const r = install();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(".claude/settings.json — permissions.ask: git commit, git push and gh pr merge — Claude Code asks the owner");
    expect(settings()).toEqual({ permissions: { ask: ASK } });
    install();
    expect(settings()).toEqual({ permissions: { ask: ASK } });
    // свои настройки и правила проекта — на месте, правила флоу — после его правил
    const own = { model: "opus", permissions: { allow: ["Bash(ls)"], ask: ["Bash(rm *)", ASK[1]] } };
    writeTree(proj, { ".claude/settings.json": JSON.stringify(own) });
    install();
    expect(settings()).toEqual({ model: "opus", permissions: { allow: ["Bash(ls)"], ask: ["Bash(rm *)", ASK[1], ASK[0], ASK[2]] } });
    // правила — в коммите: другой чекаут спрашивает так же; .claude/ в .gitignore проекта снимается ровно с файла
    writeTree(proj, { ".gitignore": ".claude/\n", ".claude/settings.local.json": "{}\n" });
    install();
    const ignored = (p: string) => spawnSync("git", ["check-ignore", "-q", p], { cwd: proj, env }).status === 0;
    expect(ignored(".claude/settings.json")).toBe(false);
    expect(ignored(".claude/settings.local.json")).toBe(true);
  });

  it("Установка в проект с `auto` правил `ask` не пишет", () => {
    expect(install(["--auto"]).code).toBe(0);
    expect(existsSync(path.join(proj, ".claude"))).toBe(false);
    const own = JSON.stringify({ permissions: { ask: ["Bash(rm *)"] } });
    writeTree(proj, { ".claude/settings.json": own, ".gitignore": ".claude/\n" });
    expect(install().code).toBe(0);
    expect(read(settingsFile())).toBe(own);
    // с auto файл настроек — проекта, не флоу: игнорируемый остаётся игнорируемым
    expect(read(path.join(proj, ".gitignore"))).toBe(".claude/\n");
  });

  it("Смена режима на `auto` убирает правила `ask` флоу и оставляет чужие", () => {
    install();
    const s = settings();
    writeTree(proj, { ".claude/settings.json": JSON.stringify({ ...s, permissions: { allow: ["Bash(ls)"], ask: ["Bash(rm *)", ...s.permissions.ask] } }) });
    const r = install(["--auto"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(".claude/settings.json — removed permissions.ask");
    expect(settings()).toEqual({ permissions: { allow: ["Bash(ls)"], ask: ["Bash(rm *)"] } });
    // файл только с правилами флоу уходит целиком, пустой .claude/ — с ним
    rmSync(path.join(proj, ".claude"), { recursive: true });
    install(["--no-auto"]);
    expect(settings()).toEqual({ permissions: { ask: ASK } });
    install(["--auto"]);
    expect(existsSync(path.join(proj, ".claude"))).toBe(false);
  });

  it("Установка пишет `.worktreeinclude` с `.env*.local`, не трогая строки проекта", () => {
    expect(install(["--auto"]).code).toBe(0);
    expect(include()).toBe(".env*.local\n");
    writeTree(proj, { ".worktreeinclude": "# свои файлы\n.env\nconfig/secrets.json" });
    const r = install(["--auto"]);
    expect(r.stdout).toContain(".worktreeinclude — .env*.local: Claude Code copies the git-ignored local env files into a new worktree");
    expect(include()).toBe("# свои файлы\n.env\nconfig/secrets.json\n.env*.local\n");
    install();
    expect(include()).toBe("# свои файлы\n.env\nconfig/secrets.json\n.env*.local\n");
  });

  it("Проверка проекта называет отсутствующие правила `ask` и `.worktreeinclude`", () => {
    install();
    expect(elves(sb, ["check"]).code).toBe(0);
    rmSync(path.join(proj, ".claude"), { recursive: true });
    rmSync(path.join(proj, ".worktreeinclude"));
    const before = snapshot(proj);
    const c = elves(sb, ["check"]);
    expect(c.code).toBe(1);
    expect(c.stdout).toContain("  + .claude/settings.json — permissions.ask: git commit, git push and gh pr merge");
    expect(c.stdout).toContain("  + .worktreeinclude — .env*.local");
    expect(snapshot(proj)).toEqual(before);
    expect(elves(sb, ["update"]).code).toBe(0);
    expect(elves(sb, ["check"]).code).toBe(0);
    // режим, правленный в манифесте руками, — не отставание (capability `elves#update`): лишние правила check не зовёт,
    // update приводит их к режиму
    const file = path.join(proj, ".agents/elves.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(read(file)), auto: true }));
    expect(elves(sb, ["check"]).code).toBe(0);
    expect(elves(sb, ["update"]).code).toBe(0);
    expect(existsSync(path.join(proj, ".claude"))).toBe(false);
  });
});

/**
 * Флоу написан по-английски, а агент работает с человеком на языке проекта: диалог, задачи, промпты, документы. Язык —
 * настройка проекта, как auto: хранится в манифесте, его видят другой чекаут и любой агент.
 */
describe("Язык работы агента — настройка проекта: по умолчанию en", () => {
  const manifest = (root: string) => JSON.parse(read(path.join(root, ".agents/elves.json")));

  it("без терминала и без флага вопроса нет — у новой установки в .agents/elves.json language: en", () => {
    const r = install();
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("Project language the agent works in");
    expect(manifest(proj).language).toBe("en");
  });

  it("--lang ru пишет language: ru, повторный install без флага его сохраняет, --lang=pt-BR меняет", () => {
    expect(install(["--lang", "ru"]).code).toBe(0);
    expect(manifest(proj).language).toBe("ru");
    expect(install().code).toBe(0);
    expect(manifest(proj).language).toBe("ru");
    expect(install(["--lang=pt-BR"]).code).toBe(0);
    expect(manifest(proj).language).toBe("pt-BR");
  });

  it("не код языка, --lang без значения и --lang с -g — отказ с кодом 2, ничего не ставится", () => {
    for (const args of [["--lang", "русский"], ["--lang"], ["--lang=ru_RU"], ["-g", "--lang", "ru"]]) {
      const r = install(args);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--lang <code>");
    }
    expect(existsSync(path.join(proj, ".agents"))).toBe(false);
    expect(existsSync(path.join(home, ".agents"))).toBe(false);
  });

  it("--lang — флаг только install: у update и check он неизвестен", () => {
    install();
    expect(elves(sb, ["update", "--lang", "ru"]).code).toBe(2);
    expect(elves(sb, ["check", "--lang=ru"]).stderr).toContain("unknown flag: --lang=ru");
  });

  it("install -g язык не спрашивает и не хранит — в ~/.agents/elves.json поля language нет", () => {
    const r = install(["-g"]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("Project language the agent works in");
    expect(manifest(home)).not.toHaveProperty("language");
  });
});

/**
 * `auto` — настройка проекта, а мерж без ревью человека в Claude Code решают настройки разрешений машины: правило
 * `Bash(gh pr merge *)` действует на все её репозитории. Разрешение шире проекта владелец ставит своей рукой —
 * `install` его называет, а не пишет: иначе владелец узнаёт о правиле из отказа в конце первой задачи.
 */
describe("Мерж своего PR в Claude Code — правило разрешений владельца: install с auto подсказывает, а не ставит", () => {
  const RULE = "Bash(gh pr merge *)";

  it("install с auto называет правило разрешений на мерж и того, кто его ставит", () => {
    const r = install(["--auto"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Claude Code");
    expect(r.stdout).toContain(`"${RULE}"`);
    expect(r.stdout).toContain("permissions.allow");
    expect(r.stdout).toContain("~/.claude/settings.json");
    expect(r.stdout).toContain("the owner adds it");
    // режим остался с прошлой установки — подсказка та же: о правиле узнают не из отказа
    expect(install().stdout).toContain(RULE);
  });

  /** Последняя строка сессии — на языке проекта, из словаря скилла github; остальной текст подсказки — по-английски. */
  it("подсказка цитирует последнюю строку сессии на языке проекта: en — «Remaining: …», ru — «Осталось: …»", () => {
    expect(install(["--auto"]).stdout).toContain("the session ends with «Remaining: …»");
    const ru = install(["--auto", "--lang", "ru"]).stdout;
    expect(ru).toContain("the session ends with «Осталось: …»");
    expect(ru.replace("«Осталось: …»", "")).not.toMatch(/\p{Script=Cyrillic}/u);
  });

  it("install без auto о правиле разрешений молчит", () => {
    for (const args of [[], ["--no-auto"], ["-g"]]) {
      const r = install(args);
      expect(r.code).toBe(0);
      // правило ask на мерж (#840) — не подсказка: она — о permissions.allow машины
      expect(r.stdout + r.stderr).not.toContain("permissions.allow");
    }
    install(["--auto"]);
    // update и check идут с режимом манифеста — подсказка только у install
    for (const cmd of ["update", "check"]) expect(elves(sb, [cmd]).stdout).not.toContain("gh pr merge");
  });

  it("подсказка не меняет настройки машины", () => {
    const settings = JSON.stringify({ permissions: { allow: ["Bash(git status)"] } });
    writeTree(home, { ".claude/settings.json": settings });
    const before = snapshot(home);
    expect(install(["--auto"]).stdout).toContain(RULE);
    expect(snapshot(home)).toEqual(before);
    expect(read(path.join(home, ".claude/settings.json"))).toBe(settings);
  });
});

describe("Неверный вызов — код 2 с объяснением", () => {
  it("--link без -g — код 2: проект держит версию пакета, а не ссылку на локальный клон", () => {
    const r = install(["--link"]);
    expect(r.code).toBe(2);
    expect(existsSync(path.join(proj, ".agents"))).toBe(false);
  });

  it("--auto с -g или вместе с --no-auto — код 2: настройка одна и она у проекта", () => {
    for (const args of [["-g", "--auto"], ["-g", "--no-auto"], ["--auto", "--no-auto"]]) {
      const r = install(args);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("project setting");
      expect(r.stderr).not.toContain("unknown flag");
    }
    expect(existsSync(path.join(proj, ".agents"))).toBe(false);
    expect(existsSync(path.join(home, ".agents"))).toBe(false);
  });

  it("неизвестная команда — код 2 и справка", () => {
    const r = elves(sb, ["instal"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("install");
  });
});
