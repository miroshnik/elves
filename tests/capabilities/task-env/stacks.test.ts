import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { composeEnv, hostProject, httpServices, projectName, PROXY, proxyHosts, proxyName, proxyPort, stackOf, taskAddress } from "../../../skills/task-env/scripts/task-env.ts";
import { elves, sandbox, type Sandbox } from "../../lib/elves.ts";
import { packageProject } from "../../lib/npm.ts";
import { exitOf, SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { tmpDir, writeTree } from "../../lib/spec.ts";
import { calls, COMPOSE, FAKE_GH, run, SCRIPT, untilAnswer } from "../../lib/task-env.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

/** Имя прокси по умолчанию — из скрипта скилла: compose-файл своего значения по умолчанию не держит (#396, вопрос 1). */
const DEFAULT_NAME = PROXY;

describe("check -g называет прокси на машине: работает или не запущен — с командой запуска; код check прокси не меняет", () => {
  let sb: Sandbox;
  let log: string;

  /**
   * docker песочницы — подставной: отвечает по FAKE_DOCKER как `docker ps` (running — контейнер прокси работает,
   * exited — остановлен, none — его нет, down — демон не отвечает) и пишет свои аргументы в журнал.
   */
  beforeEach(() => {
    sb = sandbox();
    log = path.join(sb.tmp, "docker.log");
    const script = [
      "#!/bin/sh",
      'printf \'%s\\n\' "$*" >> "$FAKE_DOCKER_LOG"',
      'case "$FAKE_DOCKER" in',
      "  running) echo running ;;",
      "  exited) echo exited ;;",
      "  down) echo 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?' >&2; exit 1 ;;",
      "esac",
    ].join("\n");
    writeFileSync(path.join(sb.bin, "docker"), script + "\n", { mode: 0o755 });
    expect(elves(sb, ["install", "-g"]).code).toBe(0);
  });
  afterEach(() => sb.cleanup());

  const check = (state: string, extra: Record<string, string> = {}) => elves(sb, ["check", "-g"], { env: { FAKE_DOCKER: state, FAKE_DOCKER_LOG: log, ...extra } });
  const START = "start: bun --no-env-file ~/.agents/skills/task-env/scripts/task-env.ts proxy up";

  it("`check -g` называет незапущенный прокси и команду его запуска", () => {
    for (const state of ["none", "exited"]) {
      const r = check(state);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`  proxy *.localhost: not running — ${START}`);
    }
  });

  it("прокси работает — строка «running» с его именем", () => {
    const r = check("running");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`  proxy *.localhost: running (${DEFAULT_NAME})`);
  });

  it("Docker не отвечает — строка «Docker unavailable» с причиной", () => {
    const r = check("down");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("  proxy *.localhost: Docker unavailable — Cannot connect to the Docker daemon");
  });

  it("на машине нет docker — строки о прокси нет", () => {
    spawnSync("rm", [path.join(sb.bin, "docker")]);
    const r = check("running");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Elves on the machine: up to date");
    expect(r.stdout).not.toContain("proxy");
  });

  it("ищет тот же проект Compose, что поднимает скилл: имя — из его скрипта, ELVES_PROXY его меняет", () => {
    expect(DEFAULT_NAME).toBeTruthy();
    check("running");
    check("running", { ELVES_PROXY: "other-proxy" });
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain(`label=com.docker.compose.project=${DEFAULT_NAME} `);
    expect(calls).toContain("label=com.docker.compose.project=other-proxy ");
  });

  it("хук SessionStart показывает строку прокси вместе с машиной", () => {
    const r = elves(sb, ["check", "--hook"], { env: { FAKE_DOCKER: "none", FAKE_DOCKER_LOG: log } });
    expect(r.code).toBe(0);
    // строки машины — с отступом под её заголовком: прокси среди них, другие строки машины (команда elves) — рядом
    expect(r.stdout).toMatch(/Elves on the machine: up to date[^\n]*\n(?: {2}[^\n]*\n)* {2}proxy \*\.localhost: not running/);
  });
});

// ----------------------------------------------------------------------------
// task-env check — правила изоляции compose-файла
// ----------------------------------------------------------------------------

let project: { dir: string; cleanup: () => void };
/** Проект Compose — каталог `proj`: имя проекта «proj», имена томов и сетей по умолчанию — `proj_<ключ>`. */
let proj: string;
function projectPerTest() {
  beforeEach(() => {
    project = tmpDir();
    proj = path.join(project.dir, "proj");
    mkdirSync(proj);
  });
  afterEach(() => project.cleanup());
}

/**
 * `task-env check <proj>` с настоящим `docker compose`: нормализацию compose-файла проверка берёт у Compose, и тест —
 * тоже; демон Docker для `config` не нужен. env — поверх окружения прогона.
 */
function composeCheck(env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, "check", proj], { cwd: project.dir, encoding: "utf8", env: { ...process.env, ...env } });
  return { code: exitOf(r), stdout: r.stdout, stderr: r.stderr };
}

const composeFile = (yaml: string, name = "compose.yaml") => writeTree(proj, { [name]: yaml });

/** PATH без docker: bun скрипт запускает по полному пути, docker ищется в PATH. */
function noDockerPath() {
  const bin = path.join(project.dir, "bin");
  mkdirSync(bin, { recursive: true });
  return bin;
}

describe("task-env check называет каждое нарушение правил изоляции compose-файла строкой ❌ с правилом и сервисом", () => {
  projectPerTest();

  it("container_name — нарушение: строка с сервисом и именем, код 1", () => {
    composeFile("services:\n  db:\n    image: postgres\n    container_name: pg\n  app:\n    image: app\n");
    const r = composeCheck();
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("❌ compose.yaml: service db — container_name pg: a second task stack can't start; remove it, Compose names containers by the project\n");
  });

  it("фиксированный порт хоста — нарушение, и с IP хоста; порт, выданный Docker (127.0.0.1::5433, 5434), и сервис без ports — нет", () => {
    composeFile(
      [
        "services:",
        "  db:",
        "    image: postgres",
        '    ports: ["5432:5432", "127.0.0.1::5433", "5434", "127.0.0.1:8080:80", "53:53/udp"]',
        "  app:",
        "    image: app",
        "",
      ].join("\n"),
    );
    const r = composeCheck();
    expect(r.code).toBe(1);
    expect(r.stdout).toBe(
      [
        "❌ compose.yaml: service db — fixed host port 5432:5432: two task stacks contend for it; publish 127.0.0.1::5432 or drop ports",
        "❌ compose.yaml: service db — fixed host port 127.0.0.1:8080:80: two task stacks contend for it; publish 127.0.0.1::80 or drop ports",
        "❌ compose.yaml: service db — fixed host port 53:53/udp: two task stacks contend for it; publish 127.0.0.1::53/udp or drop ports",
        "",
      ].join("\n"),
    );
  });

  it("том или сеть с name: или external — нарушение с сервисами, которые их берут; имя, которое Compose даёт сам (proj_<ключ>), — нет", () => {
    composeFile(
      [
        "services:",
        "  db:",
        "    image: postgres",
        "    volumes: [data:/var/lib/postgresql/data, cache:/cache, shared:/shared, own:/own]",
        "    networks: [default, back]",
        "  app:",
        "    image: app",
        "    volumes: [shared:/shared]",
        "    networks: [back, edge]",
        "volumes:",
        "  data: { name: pgdata }",
        "  cache: { external: true }",
        "  shared: { name: proj_shared }",
        "  own: {}",
        "networks:",
        "  default: { name: devnet }",
        "  back: { external: true, name: traefik }",
        "  edge: {}",
        "",
      ].join("\n"),
    );
    const r = composeCheck();
    expect(r.code).toBe(1);
    expect(r.stdout).toBe(
      [
        "❌ compose.yaml: volume cache (service db) — external: task stacks share it, down -v of one wipes another's data; drop external",
        "❌ compose.yaml: volume data (service db) — name pgdata: task stacks share it, down -v of one wipes another's data; remove name, Compose prefixes it by the project",
        "❌ compose.yaml: network back (services app, db) — external: task stacks share it and reach each other's services; drop external",
        "❌ compose.yaml: network default (service db) — name devnet: task stacks share it and reach each other's services; remove name, Compose prefixes it by the project",
        "",
      ].join("\n"),
    );
  });

  it("абсолютный путь к коду в volumes и build — нарушение, ~ тоже; относительный путь, именованный том и ресурс машины (сокет Docker, /etc/localtime) — нет", () => {
    composeFile(
      [
        "services:",
        "  app:",
        "    build: { context: /work/app, dockerfile: /work/app/Dockerfile }",
        "    volumes:",
        "      - /work/app/src:/app/src",
        "      - ~/code/lib:/app/lib",
        "      - ./src:/app/src2",
        "      - node_modules:/app/node_modules",
        "      - /var/run/docker.sock:/var/run/docker.sock",
        "      - /etc/localtime:/etc/localtime:ro",
        "  web:",
        "    build: ./web",
        "volumes:",
        "  node_modules: {}",
        "",
      ].join("\n"),
    );
    const r = composeCheck();
    expect(r.code).toBe(1);
    expect(r.stdout).toBe(
      [
        "❌ compose.yaml: service app — build context: absolute path /work/app: builds code outside the task's worktree; use a path relative to the compose file",
        "❌ compose.yaml: service app — build dockerfile: absolute path /work/app/Dockerfile: builds code outside the task's worktree; use a path relative to the compose file",
        "❌ compose.yaml: service app — volumes: absolute path /work/app/src: mounts code outside the task's worktree; use a path relative to the compose file",
        "❌ compose.yaml: service app — volumes: absolute path ~/code/lib: mounts code outside the task's worktree; use a path relative to the compose file",
        "",
      ].join("\n"),
    );
  });

  /** Сервисы в profiles `config` без профиля не показывает, override-файл Compose берёт сам — проверка видит оба. */
  it("сервис в profiles и правка из compose.override.yaml проверяются наравне с остальными", () => {
    composeFile("services:\n  app:\n    image: app\n  search:\n    image: elasticsearch\n    profiles: [heavy]\n    container_name: es\n");
    composeFile("services:\n  app:\n    ports: ['3000:3000']\n", "compose.override.yaml");
    const r = composeCheck();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("❌ compose.yaml: service search — container_name es:");
    expect(r.stdout).toContain("❌ compose.yaml: service app — fixed host port 3000:3000:");
  });

  it("строка называет compose-файл под тем именем, что лежит в проекте: docker-compose.yml", () => {
    composeFile("services:\n  db:\n    image: postgres\n    container_name: pg\n", "docker-compose.yml");
    const r = composeCheck();
    expect(r.code).toBe(1);
    expect(r.stdout).toStartWith("❌ docker-compose.yml: service db — container_name pg:");
  });

  it("чистый compose-файл — код 0, ни одной строки ❌", () => {
    composeFile(
      [
        "services:",
        "  db:",
        "    image: postgres",
        '    ports: ["127.0.0.1::5432"]',
        "    volumes: [data:/var/lib/postgresql/data, ./init:/docker-entrypoint-initdb.d]",
        "  app:",
        "    build: .",
        "volumes:",
        "  data: {}",
        "",
      ].join("\n"),
    );
    const r = composeCheck();
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("❌");
  });
});

describe("Проверить нечего или нечем — проверка молчит или говорит «не проверено», а не ошибку", () => {
  projectPerTest();

  it("проект без compose-файла — код 0, ни строки ❌ и ○, docker не нужен", () => {
    const r = composeCheck({ PATH: noDockerPath() });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/[❌○]/u);
    expect(r.stderr).toBe("");
  });

  it("без Docker — строка ○ «not checked» с причиной, код 2", () => {
    composeFile("services:\n  db:\n    image: postgres\n    container_name: pg\n");
    const r = composeCheck({ PATH: noDockerPath() });
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("○ compose.yaml: not checked — docker not found\n");
  });

  it("docker без плагина compose — «not checked» с ответом docker, код 2", () => {
    composeFile("services:\n  db:\n    image: postgres\n");
    const bin = noDockerPath();
    writeFileSync(path.join(bin, "docker"), "#!/bin/sh\necho \"docker: unknown command: docker $1\" >&2\nexit 1\n", { mode: 0o755 });
    const r = composeCheck({ PATH: `${bin}:/usr/bin:/bin` });
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("○ compose.yaml: not checked — docker compose config: docker: unknown command: docker compose\n");
  });

  it("config не разбирает файл (незаданная обязательная переменная) — «not checked» с ответом Compose, код 2", () => {
    composeFile("services:\n  db:\n    image: ${DB_IMAGE:?set DB_IMAGE}\n");
    const r = composeCheck();
    expect(r.code).toBe(2);
    expect(r.stdout).toMatch(/^○ compose\.yaml: not checked — docker compose config: [^\n]*DB_IMAGE[^\n]*\n$/);
  });
});

// ----------------------------------------------------------------------------
// Стек задачи — up, e2e, down
// ----------------------------------------------------------------------------

/**
 * Подставной docker: пишет аргументы в журнал FAKE_DOCKER_LOG; списки контейнеров, томов и сетей — пустые, FAKE_DOCKER=down
 * — демон не отвечает.
 */
const FAKE_DOCKER = [
  "#!/bin/sh",
  'printf \'%s\\n\' "$*" >> "$FAKE_DOCKER_LOG"',
  'if [ "$FAKE_DOCKER" = down ]; then echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2; exit 1; fi',
  "",
].join("\n");

describe("Снять нечего или нечем — строка ○, а не ошибка; Docker не отвечает — строка ! с причиной", () => {
  projectPerTest();
  let bin: string;
  let log: string;
  let ghLog: string;
  beforeEach(() => {
    bin = noDockerPath();
    log = path.join(project.dir, "docker.log");
    ghLog = path.join(project.dir, "gh.log");
    writeFileSync(log, "");
    writeFileSync(ghLog, "");
    writeFileSync(path.join(bin, "gh"), FAKE_GH, { mode: 0o755 });
  });
  const fakeDocker = () => writeFileSync(path.join(bin, "docker"), FAKE_DOCKER, { mode: 0o755 });
  /** task-env в проекте proj (не репозиторий git: проект — «proj»); PATH — подставные docker и gh впереди. */
  function taskEnvIn(args: string[], env: Record<string, string> = {}) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: proj,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_DOCKER_LOG: log, FAKE_GH_LOG: ghLog, ...env },
    });
    return { code: exitOf(r), stdout: r.stdout, stderr: r.stderr };
  }

  it("в чекауте без compose-файла down Docker не зовёт — строка ○, код 0", () => {
    fakeDocker();
    const r = taskEnvIn(["down", "42"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe(`○ no compose file in ${realpathSync(proj)} — the project has no task stacks\n`);
    expect(calls(log)).toEqual([]);
  });

  it("у задачи нет стеков на машине — строка ○, Compose ничего не снимает", () => {
    composeFile("services:\n  db:\n    image: postgres\n");
    fakeDocker();
    const r = taskEnvIn(["down", "42"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe("○ stacks proj-42, proj-42-e2e: none on the machine\n");
    expect(calls(log).filter((c) => c.startsWith("compose"))).toEqual([]);
  });

  it("без Docker на машине — строка ○, код 0", () => {
    composeFile("services:\n  db:\n    image: postgres\n");
    const r = taskEnvIn(["down", "42"], { PATH: bin });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe("○ no Docker on the machine — no task stacks\n");
  });

  it("Docker не отвечает — строка ! с причиной, код 2", () => {
    composeFile("services:\n  db:\n    image: postgres\n");
    fakeDocker();
    const r = taskEnvIn(["down", "42"], { FAKE_DOCKER: "down" });
    expect(r.code).toBe(2);
    expect(r.stdout).toStartWith("! stacks proj-42, proj-42-e2e: not removed — Docker unavailable: Cannot connect to the Docker daemon");
  });

  it("prune: стеков задач проекта на машине нет — строка ○, GitHub не спрашивает", () => {
    fakeDocker();
    const r = taskEnvIn(["prune"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe("○ no stacks of proj tasks on the machine\n");
    expect(calls(ghLog)).toEqual([]);
  });
});

describe("Имя проекта стеков и адресов — из репозитория, а не из каталога", () => {
  let repo: { dir: string; cleanup: () => void };
  beforeEach(() => (repo = tmpDir()));
  afterEach(() => repo.cleanup());

  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  it("имя проекта — из репозитория, а не из каталога worktree", () => {
    const main = path.join(repo.dir, "Shop.App");
    mkdirSync(main);
    git(main, "init", "-q", "-b", "main");
    git(main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
    const worktree = path.join(repo.dir, "session-379-499083");
    git(main, "worktree", "add", "-q", "-b", "feat/42-x", worktree);
    // без remote — каталог основного чекаута, и из worktree тоже
    expect(projectName(worktree)).toBe("shop-app");
    // с remote — имя репозитория origin, в любой записи URL
    for (const url of ["git@github.com:acme/Shop_Front.git", "https://github.com/acme/Shop_Front", "https://github.com/acme/Shop_Front.git/"]) {
      spawnSync("git", ["remote", "remove", "origin"], { cwd: main });
      git(main, "remote", "add", "origin", url);
      expect(projectName(worktree), url).toBe("shop-front");
    }
  });
});

describe("Адреса задачи и маршруты прокси — для дашборда, без сокета Docker", () => {
  it("адрес задачи разбирается по схеме: сервис, номер, e2e, проект; другой хост — не адрес", () => {
    expect(taskAddress("web.42.shop.localhost")).toEqual({ service: "web", task: 42, e2e: false, project: "shop" });
    expect(taskAddress("web.e2e.42.shop.localhost")).toEqual({ service: "web", task: 42, e2e: true, project: "shop" });
    // номер — метка перед проектом: в имени сервиса бывают точки и цифры
    expect(taskAddress("web.1.42.shop.localhost")).toEqual({ service: "web.1", task: 42, e2e: false, project: "shop" });
    // адрес, который строит стек задачи, разбирается обратно
    expect(taskAddress(stackOf("shop", 42).host("web"))).toEqual({ service: "web", task: 42, e2e: false, project: "shop" });
    expect(taskAddress(stackOf("shop", 42, true).host("web"))).toEqual({ service: "web", task: 42, e2e: true, project: "shop" });
    // стек основного чекаута, API прокси, не *.localhost
    for (const host of [stackOf("shop", undefined).host("web"), `${PROXY}.localhost`, "web.42.shop.example"]) expect(taskAddress(host)).toBeNull();
  });

  it("проект в адресе — имя репозитория строчными буквами, цифрами и «-»", () => {
    expect(["task-env", "My_Shop", "shop.web", "--Shop--"].map(hostProject)).toEqual(["task-env", "my-shop", "shop-web", "shop"]);
  });

  describe("API прокси", () => {
    /** Подставной Traefik: `/api/http/routers` постранично (`X-Next-Page`, последняя страница называет 1) — только по хосту `fake-proxy.localhost`. */
    let routers: unknown[] = [];
    let status = 200;
    let server: ReturnType<typeof Bun.serve>;
    beforeAll(() => {
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(req) {
          const url = new URL(req.url);
          if (req.headers.get("host") !== "fake-proxy.localhost" || url.pathname !== "/api/http/routers") return new Response("404 page not found", { status: 404 });
          if (status !== 200) return new Response("internal error", { status });
          const [per, page] = [Number(url.searchParams.get("per_page") || 100), Number(url.searchParams.get("page") || 1)];
          return Response.json(routers.slice((page - 1) * per, page * per), { headers: { "X-Next-Page": String(page * per < routers.length ? page + 1 : 1) } });
        },
      });
    });
    afterAll(() => server.stop(true));
    beforeEach(() => {
      routers = [];
      status = 200;
    });
    const env = (name = "fake-proxy") => ({ ELVES_PROXY: name, ELVES_PROXY_PORT: String(server.port) });
    const router = (rule: string, o: Record<string, unknown> = {}) => ({ name: "r@docker", rule, service: "s", status: "enabled", entryPoints: ["web"], provider: "docker", ...o });

    it("API прокси отдаёт хосты включённых маршрутов точки входа web по адресу `<имя прокси>.localhost` на его порту, все страницы", async () => {
      routers = [
        ...Array.from({ length: 150 }, (_, i) => router(`Host(\`s${i}.7.shop.localhost\`)`)),
        router("Host(`off.7.shop.localhost`)", { status: "disabled" }),
        router("PathPrefix(`/ping`)", { entryPoints: ["traefik"], provider: "internal" }),
      ];
      const hosts = await proxyHosts(env());
      expect(hosts).toHaveLength(150);
      expect(hosts).toContain("s0.7.shop.localhost");
      expect(hosts).toContain("s149.7.shop.localhost");
    });

    it("прокси не запущен — хостов нет и ошибки нет; маршруты не прочитаны по другой причине — ошибка с ней", async () => {
      const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
      const port = String(closed.port);
      closed.stop(true);
      expect(await proxyHosts({ ELVES_PROXY: "fake-proxy", ELVES_PROXY_PORT: port })).toBeNull();
      // на порту прокси без API: чужой хост Traefik отдаёт 404
      await expect(proxyHosts(env("other-proxy"))).rejects.toThrow(/^proxy other-proxy: routes not read — .*HTTP 404/);
      status = 500;
      await expect(proxyHosts(env())).rejects.toThrow("HTTP 500");
    });
  });

  it("значения по умолчанию имени, порта и сети провайдера прокси — только в скрипте: compose-файл без них не собирается, `proxy up` передаёт их сам", () => {
    expect(readFileSync(COMPOSE, "utf8")).not.toMatch(/\$\{ELVES_PROXY\w*:-/);
    // docker — подставной: пишет в журнал, с какими именем и портом прокси его позвали; контейнер прокси — «running»
    const { dir, cleanup } = tmpDir();
    try {
      const log = path.join(dir, "docker.log");
      const fake = `#!/bin/sh\necho "$ELVES_PROXY $ELVES_PROXY_PORT $1 $2" >> "${log}"\ncase "$*" in *"project=${PROXY} "*) echo running ;; esac\nexit 0\n`;
      writeFileSync(path.join(dir, "docker"), fake, { mode: 0o755 });
      const up = run("bun", [SCRIPT, "proxy", "up"], { ...process.env, PATH: `${dir}:${process.env.PATH}`, ELVES_PROXY: "", ELVES_PROXY_PORT: "" });
      expect(exitOf(up), up.stdout + up.stderr).toBe(0);
      expect(readFileSync(log, "utf8")).toContain(`${PROXY} 80 compose -f`);
    } finally {
      cleanup();
    }
    const config = (env: NodeJS.ProcessEnv) => spawnSync("docker", ["compose", "-f", COMPOSE, "config", "--format", "json"], { encoding: "utf8", env });
    const bare = { ...process.env, ELVES_PROXY: "", ELVES_PROXY_PORT: "" };
    const none = config(bare);
    expect(exitOf(none)).not.toBe(0);
    expect(none.stderr).toContain("required variable ELVES_PROXY");
    const set = config(composeEnv(bare));
    expect(exitOf(set), set.stderr).toBe(0);
    const c = JSON.parse(set.stdout);
    expect([c.name, c.networks.proxy.name]).toEqual([PROXY, PROXY]);
    expect(c.services.traefik.ports).toEqual([expect.objectContaining({ host_ip: "127.0.0.1", published: "80", target: 80 })]);
    // сеть провайдера по умолчанию — своя сеть прокси
    expect(c.services.traefik.command).toContain(`--providers.docker.network=${PROXY}`);
    // API — роутер с именем прокси на точке входа web
    expect(c.services.traefik.labels[`traefik.http.routers.${PROXY}-api.rule`]).toBe(`Host(\`${PROXY}.localhost\`)`);
  });
});

describe("Прокси — `elves-proxy` на порту 80; настройки проекта — `.agents/elves.json`", () => {
  it("имя прокси — `elves-proxy`, ELVES_PROXY его меняет; порт — ELVES_PROXY_PORT, без неё — 80", () => {
    expect(proxyName({})).toBe("elves-proxy");
    expect(proxyName({ ELVES_PROXY: "other-proxy" })).toBe("other-proxy");
    expect(proxyPort({})).toBe("80");
    expect(proxyPort({ ELVES_PROXY_PORT: "8081" })).toBe("8081");
  });

  it("`env.http` — из `.agents/elves.json`; сообщение об ошибке называет файл", () => {
    const { dir, cleanup } = tmpDir();
    try {
      expect(httpServices(dir)).toEqual({});
      writeTree(dir, { ".agents/elves.json": JSON.stringify({ env: { http: { api: 8080 } } }) + "\n" });
      expect(httpServices(dir)).toEqual({ api: 8080 });
      writeTree(dir, { ".agents/elves.json": JSON.stringify({ env: { http: { api: "8080" } } }) + "\n" });
      expect(httpServices(dir)).toStartWith("env.http of .agents/elves.json: ");
    } finally {
      cleanup();
    }
  });
});

/**
 * Скрипты и тесты проекта — поднятие стека перед dev-сервером, обёртка e2e, тест изоляции compose — звали task-env по
 * пути в копию флоу, а тонкий проект копии не держит (#620): команда — бин пакета проекта, как `elves spec-doc` и
 * `elves slot`, версии проекта и без пути к файлу скилла, который ломается, когда пакет не поднят в корень node_modules.
 */
describe("Скрипты и тесты проекта зовут task-env бином пакета — elves task-env, без пути к файлу скилла", () => {
  it("elves task-env из node_modules/.bin проекта — команды task-env пакета версии проекта: справка под строкой запуска пакета", async () => {
    const proj = packageProject("task-env-bin");
    const bin = (...args: string[]) => spawnSync(process.execPath, ["--no-env-file", "node_modules/.bin/elves", ...args], { cwd: proj, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
    const RUN = "bun --no-env-file node_modules/.bin/elves task-env";
    const { HELP } = (await import(path.join(proj, "node_modules/@miroshnik/elves/skills/task-env/scripts/task-env.ts"))) as { HELP: Record<string, string> };
    const help = bin("task-env", "up", "--help");
    expect({ code: exitOf(help), stdout: help.stdout }).toEqual({ code: 0, stdout: `${HELP.up!.replace(/^( *)task-env /gm, `$1${RUN} `)}\n` });
    const overview = bin("task-env", "--help");
    expect(exitOf(overview)).toBe(0);
    for (const cmd of Object.keys(HELP)) expect(overview.stdout).toContain(`\n  ${RUN} ${cmd}`);
    expect(overview.stdout).toContain(`${RUN} <command> --help`);
    const check = bin("task-env", "check");
    expect({ code: exitOf(check), stdout: check.stdout }).toEqual({ code: 0, stdout: `no compose file in ${realpathSync(proj)} — nothing to check\n` });
  });
});

describe("Посреди ребейза и на отцеплённом HEAD в worktree — стек задачи, а не основного чекаута", () => {
  projectPerTest();
  let bin: string;
  let log: string;
  let wt: string;
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  /** Основной чекаут proj с compose-файлом и worktree на ветке feat/42-x; подставной docker пишет вызовы в журнал. */
  beforeEach(() => {
    bin = noDockerPath();
    log = path.join(project.dir, "docker.log");
    writeFileSync(log, "");
    // config отвечает пустым проектом, остальное — успех; все вызовы в журнале
    const config = 'case " $* " in *" config "*) echo \'{"services":{}}\';; esac';
    writeFileSync(path.join(bin, "docker"), FAKE_DOCKER.replace(/\n$/, `\n${config}\n`), { mode: 0o755 });
    writeFileSync(path.join(proj, "compose.yaml"), "services:\n  db:\n    image: postgres\n");
    git(proj, "init", "-q", "-b", "main");
    git(proj, "add", "-A");
    git(proj, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
    wt = path.join(project.dir, "session-1");
    git(proj, "worktree", "add", "-q", "-b", "feat/42-x", wt);
  });

  function taskEnvIn(cwd: string, args: string[], extra: Record<string, string> = {}) {
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_DOCKER_LOG: log, ELVES_SLOT: "test", ...extra };
    for (const k of ["ELVES_TASK", "ELVES_TASK_ENV_FAILED"]) if (!(k in extra)) delete env[k];
    const r = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd,
      encoding: "utf8",
      // внутри слота: подъём стека здесь не про очередь, и тест не встаёт в очередь машины
      env,
    });
    return { code: exitOf(r), stdout: r.stdout, stderr: r.stderr };
  }
  /** Ребейз ветки: HEAD отцеплен, ветка — в rebase-merge/head-name git-каталога worktree. */
  function midRebase() {
    git(wt, "checkout", "-q", "--detach");
    const dir = path.resolve(wt, git(wt, "rev-parse", "--git-path", "rebase-merge"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "head-name"), "refs/heads/feat/42-x\n");
  }

  it("up посреди ребейза ветки feat/42-x поднимает стек <project>-42", () => {
    midRebase();
    const r = taskEnvIn(wt, ["up"]);
    expect(calls(log).join("\n"), r.stdout + r.stderr).toContain("-p proj-42");
    expect(calls(log).join("\n")).not.toMatch(/-p proj( |$)/m);
  });

  it("up в связанном worktree на отцеплённом HEAD без ребейза — отказ, стек основного чекаута не тронут", () => {
    git(wt, "checkout", "-q", "--detach");
    const r = taskEnvIn(wt, ["up"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("has no task branch");
    expect(r.stdout).toContain("task-env up <N>");
    expect(calls(log)).toEqual([]);
  });

  it("down без номера посреди ребейза опускает стек задачи, а не основного чекаута", () => {
    midRebase();
    const r = taskEnvIn(wt, ["down"]);
    expect(r.stdout, r.stderr).toContain("proj-42");
    expect(r.stdout).not.toMatch(/stacks proj:|stack proj /);
  });

  it("down без номера в worktree на отцеплённом HEAD без ребейза — отказ, Docker не зовут", () => {
    git(wt, "checkout", "-q", "--detach");
    const r = taskEnvIn(wt, ["down"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("has no task branch");
    expect(calls(log)).toEqual([]);
  });

  /** pr premerge проверяет слияние во временном worktree на отцеплённом HEAD и даёт номер задачи PR (#759). */
  it("up на отцеплённом HEAD в worktree с ELVES_TASK поднимает стек задачи <project>-<N>", () => {
    git(wt, "checkout", "-q", "--detach");
    const r = taskEnvIn(wt, ["up"], { ELVES_TASK: "7" });
    expect(r.stdout + r.stderr).not.toContain("has no task branch");
    expect(calls(log).join("\n")).toContain("-p proj-7");
  });

  // страховка от перекоррекции #759: ELVES_TASK — для чекаута без ветки задачи, ветку он не перебивает
  it("страховка от перекоррекции: ветка задачи важнее ELVES_TASK", () => {
    taskEnvIn(wt, ["up"], { ELVES_TASK: "7" });
    expect(calls(log).join("\n")).toContain("-p proj-42");
    expect(calls(log).join("\n")).not.toContain("-p proj-7");
  });

  it("стек не поднялся — причина в файле ELVES_TASK_ENV_FAILED: pr premerge отличает «не смог проверить» от красной проверки", () => {
    git(wt, "checkout", "-q", "--detach");
    const file = path.join(project.dir, "failed");
    const r = taskEnvIn(wt, ["up"], { ELVES_TASK_ENV_FAILED: file });
    expect(r.code).toBe(2);
    expect(readFileSync(file, "utf8")).toMatch(/^task-env up: the worktree .* has no task branch/);
  });

  it("в основном чекауте без ветки задачи up по-прежнему поднимает стек <project>", () => {
    const r = taskEnvIn(proj, ["up"]);
    expect(r.stdout + r.stderr).not.toContain("has no task branch");
    expect(calls(log).join("\n")).toMatch(/-p proj( |$)/m);
  });
});

/**
 * Подъём стека — тяжёлая работа машины (#731): контейнеры с базами и брокером стартуют разом, и мимо очереди `slot` он
 * ронял чужие интеграционные прогоны. `up` и `e2e` берут место в очереди до конца `up --wait` — до здоровья
 * контейнеров, — а не на всю жизнь стека: команда `e2e` после подъёма идёт вне слота.
 */
describe("Подъём стека задачи — тяжёлая работа машины: идёт очередью slot до здоровья контейнеров", () => {
  projectPerTest();
  const SLOT = fileURLToPath(new URL("../../../skills/slot/scripts/slot.ts", import.meta.url));
  let bin: string;
  let log: string;
  let running: Bun.Subprocess[];
  beforeEach(() => {
    bin = noDockerPath();
    log = path.join(project.dir, "docker.log");
    writeFileSync(log, "");
    // config — пустой проект; на `up --wait` — сколько билетов в очереди, пока контейнеры «поднимаются»
    const docker = [
      'case " $* " in *" config "*) echo \'{"services":{}}\';; esac',
      'case " $* " in *" --wait "*) echo "tickets $(ls "$ELVES_CONFIG_DIR/slots" | wc -l | tr -d " ")" >> "$FAKE_DOCKER_LOG";; esac',
    ].join("\n");
    writeFileSync(path.join(bin, "docker"), FAKE_DOCKER + docker + "\n", { mode: 0o755 });
    writeFileSync(path.join(proj, "compose.yaml"), "services:\n  db:\n    image: postgres\n");
    running = [];
  });
  afterEach(() => {
    for (const p of running) p.kill("SIGKILL");
  });

  /** Своя очередь теста — в конфигурации и во временном каталоге: прогон самого теста в очереди машины не в счёт. */
  const env = (): NodeJS.ProcessEnv => {
    const e: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_DOCKER_LOG: log, ELVES_CONFIG_DIR: path.join(project.dir, "config"), TMPDIR: path.join(project.dir, "tmp") };
    for (const k of ["CI", "ELVES_SLOT", "ELVES_SLOT_CPUS", "CLAUDE_TMPDIR", "npm_lifecycle_script", "npm_lifecycle_event"]) delete e[k];
    return e;
  };
  /** Фоном; stdout и stderr — в файлы рядом с журналом, тест читает их по ходу. */
  function start(cmd: string, args: string[]) {
    const [out, err] = ["out", "err"].map((k) => path.join(project.dir, `${k}-${running.length}.log`)) as [string, string];
    const p = Bun.spawn([cmd, ...args], { cwd: proj, env: env(), stdout: Bun.file(out), stderr: Bun.file(err) });
    running.push(p);
    const text = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : "");
    return { out: () => text(out) + text(err), done: p.exited };
  }
  /**
   * Тяжёлый прогон в слоте, пока тест не отпустит: `started-<имя>` — начался, `release-<имя>` — закончить; каталог
   * теста убран — тоже: команда — потомок slot и пережила бы его.
   */
  const hold = (name: string) => start(process.execPath, [SLOT, `touch started-${name}; while [ ! -f release-${name} ] && [ -f compose.yaml ]; do sleep 0.02; done`]);
  const release = (name: string) => writeFileSync(path.join(proj, `release-${name}`), "");
  const started = (name: string) => existsSync(path.join(proj, `started-${name}`));
  async function until(what: string, ok: () => boolean) {
    for (const t0 = Date.now(); !ok(); await new Promise((r) => setTimeout(r, 20))) if (Date.now() - t0 > 20_000) throw new Error(`не дождались: ${what}`);
  }

  it("подъём стека задачи ждёт места в очереди, когда два тяжёлых прогона уже идут", async () => {
    hold("a");
    hold("b");
    await until("два прогона в слотах", () => started("a") && started("b"));
    const up = start(process.execPath, [SCRIPT, "up", "42"]);
    await until("task-env ждёт очередь", () => up.out().includes("slot: waiting for the machine queue"));
    expect(calls(log).filter((l) => / up /.test(` ${l} `))).toEqual([]);
    release("a");
    expect(await up.done, up.out()).toBe(0);
    // во время `up --wait` в очереди — оставшийся прогон и подъём стека
    expect(calls(log)).toContain("tickets 2");
    expect(calls(log).join("\n")).toMatch(/-p proj-42 [^\n]* up --detach --wait/);
    release("b");
  });

  it("подъём стека задачи отдаёт место в очереди, когда контейнеры стека здоровы", async () => {
    hold("a");
    await until("прогон в слоте", () => started("a"));
    // команда e2e сама идёт очередью: держи task-env слот и после подъёма — оба места заняты, и она ждала бы вечно
    const e2e = start(process.execPath, [SCRIPT, "e2e", "--", process.execPath, SLOT, "touch inner"]);
    const code = await Promise.race([e2e.done, new Promise((r) => setTimeout(() => r("ждёт"), 20_000))]);
    expect(code, e2e.out()).toBe(0);
    expect(existsSync(path.join(proj, "inner"))).toBe(true);
    expect(calls(log)).toContain("tickets 2");
    release("a");
  });
});

/**
 * Ожидание адреса в медленных тестах стеков (`untilAnswer`, #753): прокси, пока событие Docker о пересозданном стеке не
 * дошло, ведёт запрос на остановленный контейнер, и тот висит до таймаута Traefik. Здесь прокси — сервер, первый запрос
 * которого не отвечает никогда.
 */
describe("Ожидание адреса стека повторяет висящий запрос", () => {
  it("адрес стека, пересозданного с чистыми томами, тест дожидается, даже если первый запрос висит на остановленном контейнере", async () => {
    let asked = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => (++asked === 1 ? new Promise<Response>(() => {}) : new Response("ok")) });
    try {
      const r = await untilAnswer(String(server.port), "web.e2e.42.shop.localhost", 200, 5_000);
      expect(r).toEqual({ status: 200, body: "ok" });
      expect(asked).toBeGreaterThan(1);
    } finally {
      await server.stop(true);
    }
  });
});
