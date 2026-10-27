import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { descSize } from "../../../skills/est/scripts/est.ts";
import { main, realRun } from "../../../skills/github/scripts/github.ts";
import type { Io } from "../../../skills/github/scripts/github.ts";
import { asOrg, CLOUD_SIGNATURE, epicInProgress, FakeGitHub } from "../../lib/fake-github.ts";
import type { Recording } from "../../lib/fake-github.ts";
import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";
import { githubOrigin, gitRepo, tmpDir, writeTree } from "../../lib/spec.ts";

// модель архитектуры скилл читает отдельным процессом bun
setDefaultTimeout(SPAWN_TIMEOUT);

// Ответы GitHub — записанные с проекта Elves, `gh` подменён: мутации меняют запись так, как это сделал бы GitHub;
// поверх записи — сценарий тестов: эпик #45 «В работе», #42 и #49 в «Бэклоге» (epicInProgress)
const REC: Recording = epicInProgress(JSON.parse(readFileSync(new URL("../../lib/github-elves.json", import.meta.url), "utf8")));
const REPO = "miroshnik/elves";
const ORG = "acme/elves";

let pauses = 0;
/** Вызов скрипта task-env (снятие стеков задачи в `task close`) — подпроцесс bun, как est. */
const isTaskEnv = (args: string[]) => args.some((a) => /skills\/task-env\/scripts\/task-env\.ts$/.test(a));
/** Аргументы вызова task-env без пути к скрипту: флаги bun и команда. */
const taskEnvArgs = (args: string[]) => args.filter((a) => !isTaskEnv([a]));
// est — подпроцесс bun (внешний край): по умолчанию молчит и ничего не пишет, git — настоящий; тесты est подменяют его сами
const silentEst = (cmd: string, args: string[], cwd?: string) => (cmd === "bun" ? { status: 0, stdout: "", stderr: "" } : realRun(cmd, args, cwd));
// est по умолчанию — в каталоге вне git: рядом со скриптом лежал бы est клона, который прогоняет тесты, и task close
// подтягивал бы его (#517) — сетью и с правкой чужого чекаута; клон скриптов тестам подставляют их тесты
const { dir: OUTSIDE_GIT, cleanup: outsideGit } = tmpDir();
const OUTSIDE_EST = path.join(OUTSIDE_GIT, "skills/est/scripts/est.ts");
// spec-diff выпуска пачки — там же: процесс подменён, скрипт только должен быть
const OUTSIDE_SPEC = path.join(OUTSIDE_GIT, "skills/spec/scripts/spec-diff.ts");
writeTree(OUTSIDE_GIT, { "skills/est/scripts/est.ts": "", "skills/spec/scripts/spec-diff.ts": "" });
afterAll(outsideGit);
function task(f: FakeGitHub, args: string[], repo = REPO, io: Partial<Io> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(["task", ...args, "--repo", repo], { gh: f.gh, out: (l) => out.push(l), err: (l) => err.push(l), sleep: () => void pauses++, run: silentEst, ...io, env: { ELVES_EST: OUTSIDE_EST, ...io.env } });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const byOp = (f: FakeGitHub, op: string) => f.mutations.filter((m) => m.op === op).map((m) => m.input);
const optionId = (f: FakeGitHub, name: string) => f.field("Status").options.find((o: { name: string }) => o.name === name).id;
const statusSet = (f: FakeGitHub) => byOp(f, "SetItemStatus").map((m) => [f.items().find((it) => it.id === m.itemId)?.content.number, f.field("Status").options.find((o: { id: string }) => o.id === m.value.singleSelectOptionId).name]);

// Сессия агента: её id и каталог конфигурации скрипт берёт из окружения; каталог в тестах — временный
const SESSION = "0b1f6c1e-7a52-4f0e-9d3a-2c4e8a9b5d10";
const temp: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of temp.splice(0)) cleanup();
});
function scratch(): string {
  const { dir, cleanup } = tmpDir();
  temp.push(cleanup);
  return dir;
}
/** Каталог другого проекта — не чекаут репозитория задачи, но с манифестом: без него команды, что пишут имена, отказывают (#681). */
function elsewhere(): string {
  const dir = scratch();
  writeTree(dir, { ".agents/elves.json": '{ "language": "ru" }\n' });
  return dir;
}
const inSession = (config: string, id = SESSION): Partial<Io> => ({ env: { CLAUDE_CODE_SESSION_ID: id, ELVES_CONFIG_DIR: config } });
const pinFile = (config: string, id = SESSION) => path.join(config, "sessions", id);
const pinned = (config: string, id = SESSION) => readFileSync(pinFile(config, id), "utf8").trim();

describe("task new заводит задачу со всем сразу", () => {
  it("подзадача эпика: заголовок с префиксом эпика, в проекте в Бэклог, sub-issue, blocked by, следующий шаг — сумма оценок эпика", () => {
    const f = new FakeGitHub(REC);
    const r = task(f, ["new", "--branch-type", "feat", "--title", "Экспорт задач", "--body", "Что сделать", "--epic", "45", "--blocked-by", "#49"]);
    expect(r.code).toBe(0);
    expect(byOp(f, "CreateIssue")).toEqual([{ repositoryId: f.repo.id, title: "GitHub · Экспорт задач", body: "Что сделать", projectV2Ids: [f.project().id], parentIssueId: f.issue(45).id }]);
    expect(statusSet(f)).toEqual([[561, "Бэклог"]]);
    expect(byOp(f, "AddBlockedBy")).toEqual([{ issueId: f.issue(561).id, blockingIssueId: f.issue(49).id }]);
    expect(r.out.split("\n")).toEqual([
      "Created #561 GitHub · Экспорт задач — https://github.com/miroshnik/elves/issues/561",
      "+ project «elves»: Status «Бэклог»",
      "+ subtask of epic #45",
      "+ blocked by #49",
      "Next: «Оценка, ч» of epic #45 — recompute as the sum of its subtasks' estimates.",
    ]);
  });

  it("заголовок уже с префиксом эпика — префикс не удваивается", () => {
    const f = new FakeGitHub(REC);
    task(f, ["new", "--branch-type", "feat", "--title", "GitHub · Экспорт задач", "--epic", "45"]);
    expect(byOp(f, "CreateIssue")[0].title).toBe("GitHub · Экспорт задач");
  });

  it("закрытый блокер пропускается — он уже не блокирует", () => {
    const f = new FakeGitHub(REC);
    const r = task(f, ["new", "--branch-type", "feat", "--title", "Экспорт", "--blocked-by", "46,49"]);
    expect(byOp(f, "AddBlockedBy").map((m) => m.blockingIssueId)).toEqual([f.issue(49).id]);
    expect(r.out).toContain("+ #46 is closed — doesn't block, skipped");
  });

  it("тело задачи — из файла --body-file", () => {
    const f = new FakeGitHub(REC);
    const file = new URL("../../lib/github-elves.json", import.meta.url).pathname;
    task(f, ["new", "--branch-type", "feat", "--title", "Экспорт", "--body-file", file]);
    expect(byOp(f, "CreateIssue")[0].body).toBe(readFileSync(file, "utf8"));
  });

  // в личном аккаунте типов issue нет — эпик помечается меткой epic, это единственное исключение
  it("эпик в личном аккаунте — метка epic вместо типа; эпик не оценивается", () => {
    const f = new FakeGitHub(REC);
    const r = task(f, ["new", "--title", "Импорт · Импорт задач из CSV", "--type", "Эпик"]);
    expect(byOp(f, "CreateIssue")[0].labelIds).toEqual([f.taskContext.label.id]);
    expect(byOp(f, "CreateIssue")[0]).not.toHaveProperty("issueTypeId");
    expect(r.out).toContain("+ label «epic» — the type in a personal account");
    expect(r.out).toContain("Next: an epic isn't estimated — its «Оценка, ч» is the sum of its subtasks' estimates.");
  });

  it("метки epic в репозитории нет — создаёт её и ставит", () => {
    const f = new FakeGitHub(REC);
    f.taskContext.label = null;
    task(f, ["new", "--title", "Импорт · Импорт задач из CSV", "--type", "Эпик"]);
    expect(byOp(f, "CreateLabel")).toEqual([{ repositoryId: f.repo.id, name: "epic", color: "8250DF", description: "Эпик: большая задача с подзадачами" }]);
    expect(byOp(f, "CreateIssue")[0].labelIds).toEqual([f.taskContext.label.id]);
  });

  it("задача и баг в личном аккаунте — без типа и без меток", () => {
    const f = new FakeGitHub(REC);
    task(f, ["new", "--title", "Экспорт", "--type", "Баг"]);
    expect(byOp(f, "CreateIssue").map((m) => Object.keys(m).sort())).toEqual([["body", "projectV2Ids", "repositoryId", "title"]]);
  });

  // канон требует Priority у открытой задачи (#682): агент, который его ставит, не теряет вызов — задача создаётся,
  // строка ○ говорит, что личный аккаунт приоритет и тип не хранит
  it("task new в личном аккаунте с --priority — задача создаётся, строка ○: личный аккаунт не хранит приоритет", () => {
    const f = new FakeGitHub(REC);
    const r = task(f, ["new", "--branch-type", "feat", "--title", "Экспорт", "--priority", "High"]);
    expect(r.code).toBe(0);
    expect(byOp(f, "CreateIssue")[0]).not.toHaveProperty("issueFields");
    expect(r.out).toContain("○ Priority «High» isn't kept: a personal account has no issue fields");
  });

  it("task new в личном аккаунте с --type Bug — строка ○: личный аккаунт не хранит тип задачи", () => {
    const f = new FakeGitHub(REC);
    const r = task(f, ["new", "--title", "Падает экспорт", "--type", "Bug"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("○ type «Баг» isn't kept: a personal account has no issue types, only an epic gets its label");
    expect(task(f, ["new", "--branch-type", "feat", "--title", "Импорт"]).out).not.toContain("○ type");
  });

  it("milestone — по названию среди открытых", () => {
    const f = new FakeGitHub(REC);
    const m = f.milestone("GitHub · 1 · Проект");
    const r = task(f, ["new", "--branch-type", "feat", "--title", "Экспорт", "--milestone", "GitHub · 1 · Проект"]);
    expect(byOp(f, "CreateIssue")[0].milestoneId).toBe(m.id);
    expect(r.out).toContain("+ milestone «GitHub · 1 · Проект»");
  });

  /**
   * Заведённую задачу сессия с закреплённой задачей сама не возьмёт (`task status` откажет). Карточку новой сессии
   * запускал владелец кликом, и её работа выпадала из виду этой сессии (#546): теперь вывод велит спросить владельца,
   * ставить ли задачу в очередь, и даёт промпт исполнителя — на «да» сессия сразу запускает фонового субагента.
   */
  it("в сессии с закреплённой задачей «Next:» — вопрос владельцу, ставить ли новую задачу в очередь, и промпт её исполнителя", () => {
    const f = new FakeGitHub(REC);
    const io = inSession(scratch());
    expect(task(f, ["new", "--branch-type", "feat", "--title", "Импорт"], REPO, io).out).not.toContain("the session runs");
    task(f, ["status", "49", "В работе"], REPO, io);
    const r = task(f, ["new", "--branch-type", "feat", "--title", "Экспорт", "--epic", "45"], REPO, io);
    expect(r.code).toBe(0);
    const last = r.out.split("\n").at(-1)!;
    expect(last).toStartWith(
      "Next: the session runs miroshnik/elves#49; #562 isn't taken here — the question to the owner «queue #562?» — yes: a background subagent in its own worktree, " +
        "its prompt: Задача #562 в miroshnik/elves (эпик #45): ты исполнитель сессии-диспетчера. Задание целиком печатает `bun --no-env-file ",
    );
    expect(last).toContain("task queue --assignment 562 --repo miroshnik/elves`");
  });

  // эпик заводят — владельца спрашивают, запускать ли диспетчера на его задачи, а не раздают карточки сессий (#546)
  it("эпик заведён — «Next:» велит спросить владельца, запускать ли диспетчера на задачи эпика, и называет команду очереди", () => {
    const f = new FakeGitHub(REC);
    const r = task(f, ["new", "--title", "Импорт · Импорт задач из CSV", "--type", "Эпик"]);
    expect(r.code).toBe(0);
    expect(r.out.split("\n").at(-1)).toMatch(
      /^Next: once its subtasks are created — the question to the owner «run the dispatcher on epic #561\?»; yes — bun --no-env-file \S+github\.ts task queue --epic 561 --repo miroshnik\/elves in this session, its executors — background subagents\.$/,
    );
  });

  describe("ошибка до создания — задача не заводится наполовину", () => {
    const refused = (f: FakeGitHub, args: string[], message: string, repo = REPO) => {
      const r = task(f, ["new", "--branch-type", "feat", ...args], repo); // тип ветки верный — отказ из-за другого аргумента
      expect(r.code).toBe(2);
      expect(r.err).toContain(message);
      expect(f.mutations).toEqual([]);
    };

    it("--epic указывает не на эпик", () => refused(new FakeGitHub(REC), ["--title", "Экспорт", "--epic", "47"], "#47 is not an epic (no epic label)"));
    it("эпик закрыт", () => {
      const f = new FakeGitHub(REC);
      f.closed(45);
      refused(f, ["--title", "Экспорт", "--epic", "45"], "epic #45 is closed");
    });
    it("открытого milestone с таким названием нет", () => refused(new FakeGitHub(REC), ["--title", "Экспорт", "--milestone", "Нет такого"], "no open milestone «Нет такого»"));
    it("открытая задача с тем же заголовком уже есть — дубль не заводится", () => {
      const f = new FakeGitHub(REC);
      refused(f, ["--title", f.issue(49).title], "an open task with this title already exists: #49");
    });
    it("в личном аккаунте чужое значение --priority — ошибка, как в организации", () => refused(new FakeGitHub(REC), ["--title", "Экспорт", "--priority", "P1"], "--priority: Urgent, High, Medium, Low"));
    it("блокера нет в репозитории", () => refused(new FakeGitHub(REC), ["--title", "Экспорт", "--blocked-by", "999"], "no issue #999 in miroshnik/elves"));
    it("проекта нет — сначала project fix", () => {
      const f = new FakeGitHub(REC);
      f.unlinkAll();
      refused(f, ["--title", "Экспорт"], "no project is linked to miroshnik/elves — github project fix first");
    });
  });
});

/**
 * Оценку ставит сам `task new` — как `task close` пишет факт: агент скилл est для оценки не открывает и ничего не
 * выбирает. Ручной подбор аналогов и поправки шли до 10 минут (#381), а точнее механики не были: аналоги подбирает
 * скрипт, а по мере закрытия задач их факты сами становятся аналогами следующих оценок.
 */
describe("task new ставит оценку сам — по аналогам, которые подбирает скрипт", () => {
  const ESTIMATE = "Оценка: 0.5 ч, ≈ 20 млн токенов, ≈ $8 (тип feat, доверие A; прогноз по фактам аналогов). Аналоги (подбор скриптом): #12 (факт 0.4 ч); #14 (факт 0.5 ч); #20 (факт 1 ч). Поправка: ×1.";
  const STDOUT = `== miroshnik/elves#561: Экспорт\ncurrent «Оценка, ч»: —; status: Бэклог\ncomment:\n${ESTIMATE}\n<!-- est {"v": 2, "h": 0.5} -->\n«Estimate» comment created, field «Оценка, ч» = 0.5\n`;
  const est =
    (calls: string[][], r: { status: number; stdout?: string; stderr?: string } = { status: 0, stdout: STDOUT }) =>
    (cmd: string, args: string[]) => (calls.push([cmd, ...args]), { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" });

  it("задача с --branch-type — сразу est estimate <N> --type <тип ветки> --write; вывод est — в выводе task new, без маркера", () => {
    const f = new FakeGitHub(REC);
    const calls: string[][] = [];
    const r = task(f, ["new", "--title", "Экспорт", "--branch-type", "feat"], REPO, { run: est(calls) });
    expect(r.code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(3)).toEqual(["estimate", "561", "--repo", REPO, "--type", "feat", "--write"]);
    expect(calls[0]!.slice(0, 2)).toEqual(["bun", "--no-env-file"]);
    expect(calls[0]![2]).toMatch(/skills\/est\/scripts\/est\.ts$/);
    expect(r.out).toContain(ESTIMATE);
    expect(r.out).toContain("«Estimate» comment created, field «Оценка, ч» = 0.5");
    expect(r.out).not.toContain("<!--");
    expect(r.out).not.toContain("est estimate");
  });

  /**
   * Репозиторий переименовали (#560): GitHub отвечает на прежнее имя нынешним, чтения по прежнему имени проходят, а
   * запись est (`gh api -X POST`) получает редирект 307, который gh для не-GET не повторяет, — задача заводилась без
   * оценки. task new работает под нынешним именем и передаёт est его.
   */
  it("task new с --repo старого имени переименованного репозитория записывает оценку", () => {
    const f = new FakeGitHub(REC);
    f.formerNames = ["miroshnik/old-name"];
    const calls: string[][] = [];
    // est как настоящий: его запись по прежнему имени получает 307
    const run = (cmd: string, args: string[]) =>
      args.includes("miroshnik/old-name") ? (calls.push([cmd, ...args]), { status: 1, stdout: "", stderr: "error: command gh api -X… exited with code 1: gh: HTTP 307\n" }) : est(calls)(cmd, args);
    const r = task(f, ["new", "--title", "Экспорт", "--branch-type", "feat"], "miroshnik/old-name", { run });
    expect(r.code).toBe(0);
    expect(calls.map((c) => c.slice(3))).toEqual([["estimate", "561", "--repo", REPO, "--type", "feat", "--write"]]);
    expect(r.out).toContain("«Estimate» comment created, field «Оценка, ч» = 0.5");
    expect(r.out).not.toContain("! est estimate");
  });

  it("баг без --branch-type — оценка с типом fix: ветка бага — fix/<N>-…", () => {
    const f = new FakeGitHub(REC);
    const calls: string[][] = [];
    expect(task(f, ["new", "--title", "Экспорт падает", "--type", "Баг"], REPO, { run: est(calls) }).code).toBe(0);
    expect(calls[0]!.slice(3)).toEqual(["estimate", "561", "--repo", REPO, "--type", "fix", "--write"]);
  });

  it("эпик не оценивается: est не зовётся, «Next:» — оценка эпика есть сумма оценок подзадач", () => {
    const f = new FakeGitHub(REC);
    const calls: string[][] = [];
    const r = task(f, ["new", "--title", "Импорт · Импорт задач из CSV", "--type", "Эпик"], REPO, { run: est(calls) });
    expect(r.code).toBe(0);
    expect(calls).toEqual([]);
    expect(r.out).toContain("Next: an epic isn't estimated — its «Оценка, ч» is the sum of its subtasks' estimates.");
  });

  it("задача без --branch-type — ошибка до создания: тип ветки нужен оценке", () => {
    const f = new FakeGitHub(REC);
    const r = task(f, ["new", "--title", "Экспорт"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--branch-type is required for a task: feat, fix, docs, refactor, perf, test, chore, ci, build, research — the type of its branch and of its estimate");
    expect(f.mutations).toEqual([]);
  });

  it("тип ветки не из списка — ошибка до создания", () => {
    const f = new FakeGitHub(REC);
    const r = task(f, ["new", "--title", "Экспорт", "--branch-type", "feature"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--branch-type: feat, fix, docs, refactor, perf, test, chore, ci, build, research");
    expect(f.mutations).toEqual([]);
  });

  it("эпик с --branch-type — ошибка до создания: у эпика нет ветки и своей оценки", () => {
    const f = new FakeGitHub(REC);
    const r = task(f, ["new", "--title", "Импорт · Импорт задач из CSV", "--type", "Эпик", "--branch-type", "feat"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("an epic has no branch and isn't estimated — --branch-type is for a task or a bug");
    expect(f.mutations).toEqual([]);
  });

  it("est не установлен рядом — задача заведена, «○ no estimate: est is not installed», код 0", () => {
    const f = new FakeGitHub(REC);
    const calls: string[][] = [];
    const r = task(f, ["new", "--title", "Экспорт", "--branch-type", "feat"], REPO, { run: est(calls), env: { ELVES_EST: "/nowhere/est.ts" } });
    expect(r.code).toBe(0);
    expect(calls).toEqual([]);
    expect(r.out).toContain("○ no estimate: est is not installed (/nowhere/est.ts)");
    expect(statusSet(f)).toEqual([[561, "Бэклог"]]);
  });

  it("est упал — задача заведена, его ошибка строкой «! est estimate», код 0", () => {
    const f = new FakeGitHub(REC);
    const r = task(f, ["new", "--title", "Экспорт", "--branch-type", "feat"], REPO, { run: est([], { status: 1, stderr: "warning: x\nerror: GitHub is unavailable\n" }) });
    expect(r.code).toBe(0);
    expect(r.out).toContain("! est estimate: error: GitHub is unavailable");
    expect(statusSet(f)).toEqual([[561, "Бэклог"]]);
  });
});

const issueLabels = (f: FakeGitHub, n: number) => f.issue(n).labels.nodes.map((l: { name: string }) => l.name);

const CAP = "0E8A16";

/** Метка решения ставится при создании: по ней задачу находят из спеки, а `est` — аналоги по тому же решению. */
describe("task new ставит метки решений — по имени решения, новое решение — `вид:имя`", () => {
  it("--labels ставит метки решений по имени; метки нет — создаётся с цветом вида", () => {
    const f = new FakeGitHub(REC);
    Object.assign(f.tree, { capabilities: ["billing"], standards: ["audit"] });
    const audit = f.label("audit", "1D76DB", "Решение: tests/standards/audit");
    const r = task(f, ["new", "--branch-type", "feat", "--title", "Экспорт", "--labels", "billing,audit"]);
    expect(r.code).toBe(0);
    expect(byOp(f, "CreateLabel")).toEqual([{ repositoryId: f.repo.id, name: "billing", color: CAP, description: "Решение: tests/capabilities/billing" }]);
    const billing = f.labels.find((l) => l.name === "billing")!;
    expect(byOp(f, "CreateIssue")[0].labelIds).toEqual([billing.id, audit.id]);
    expect(issueLabels(f, 561)).toEqual(["billing", "audit"]);
    expect(r.out).toContain("+ created label «billing»");
    expect(r.out).toContain("+ labels: billing, audit");
  });

  it("новое решение — `вид:имя`: метка с именем, строка называет решение новым", () => {
    const f = new FakeGitHub(REC);
    const r = task(f, ["new", "--branch-type", "feat", "--title", "Экспорт", "--labels", "capability:export"]);
    expect(r.code).toBe(0);
    expect(byOp(f, "CreateLabel")).toEqual([{ repositoryId: f.repo.id, name: "export", color: CAP, description: "Решение: tests/capabilities/export" }]);
    expect(issueLabels(f, 561)).toEqual(["export"]);
    expect(r.out).toContain("+ export — new decision: tests/capabilities/export is not in the default branch yet");
  });

  it("метка не решения, которой нет в репозитории, — ошибка до создания задачи", () => {
    const f = new FakeGitHub(REC);
    const r = task(f, ["new", "--branch-type", "feat", "--title", "Экспорт", "--labels", "capability:export,срочно"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("no label «срочно» in the repository");
    expect(r.err).toContain("a new decision — kind:name");
    expect(byOp(f, "CreateIssue")).toEqual([]);
    expect(byOp(f, "CreateLabel")).toEqual([]);
  });

  it("task new --epic — метки решений задачи добавляются эпику", () => {
    const f = new FakeGitHub(REC);
    f.tree.capabilities = ["billing"];
    f.label("срочно", "B60205");
    const r = task(f, ["new", "--branch-type", "feat", "--title", "Экспорт", "--epic", "45", "--labels", "billing,срочно"]);
    expect(r.code).toBe(0);
    expect(issueLabels(f, 45)).toEqual(["epic", "billing"]);
    expect(r.out).toContain("+ epic #45: billing");
  });

  /**
   * GitHub ставит на issue не больше 100 меток, мутация сверх предела падает целиком (#569), а объединение меток подзадач
   * у эпика копится до предела. Задача к этому времени уже заведена: падение оставляло эпик без её меток и без строки о
   * них (#574). PR ещё нет — выбора по утверждениям нет: по алфавиту, сколько помещается.
   */
  it("эпик у предела меток — ставит эпику, что помещается, остальное печатает, не падает", () => {
    const f = new FakeGitHub(REC);
    Object.assign(f.tree, { capabilities: ["billing", "est"], standards: ["audit"] });
    // у эпика 99 меток: epic и 98 решений прежних подзадач
    for (let i = 0; i < 98; i++) f.labelIssue(45, `прежнее-${i}`);
    const r = task(f, ["new", "--branch-type", "feat", "--title", "Экспорт", "--epic", "45", "--labels", "est,billing,audit"]);
    expect(r.code).toBe(0);
    expect(issueLabels(f, 561)).toEqual(["est", "billing", "audit"]);
    expect(issueLabels(f, 45)).toHaveLength(100);
    expect(issueLabels(f, 45).at(-1)).toBe("audit");
    expect(r.out).toContain("+ epic #45: audit");
    expect(r.out).toContain("○ epic #45: 3 new decision labels, room for 1 (GitHub puts at most 100 on an issue, it has 99) — alphabetically, as many as fit");
    expect(r.out).toContain("○ epic #45: no room — not set: billing, est");
  });

  // метка-разрез (описание «Разрез: …») — разрез задач проекта, а не метка решения, хотя имя у них одно (#343)
  it("метка-разрез с именем решения: `вид:имя` — ошибка до создания, по имени — обычная метка задачи, эпику не передаётся", () => {
    const f = new FakeGitHub(REC);
    f.tree.model = `export default { modules: { api: { path: "apps/api" } } };\n`;
    const api = f.label("api", "C5DEF5", "Разрез: приложения — API-сервер");
    const refused = task(f, ["new", "--branch-type", "feat", "--title", "Экспорт", "--labels", "architecture:api"]);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("label «api» is slice «приложения», not a decision label: decision api isn't labeled; the slice label — --labels api");
    expect(f.mutations).toEqual([]);
    const r = task(f, ["new", "--branch-type", "feat", "--title", "Экспорт", "--epic", "45", "--labels", "api"]);
    expect(r.code).toBe(0);
    expect(byOp(f, "CreateIssue")[0].labelIds).toEqual([api.id]);
    expect(issueLabels(f, 45)).toEqual(["epic"]);
  });

  // у раздела нет своего лейбла — его правки помечают тему (#688): лейбл раздела задачу не найдёт
  it("task new --labels с именем раздела — ошибка до создания: лейбл у темы", () => {
    const f = new FakeGitHub(REC);
    f.tree.standards = ["forms"];
    f.tree.files = { "standards/forms": ["forms.md", "reset-button.md", "reset-button.test.ts"] };
    // прежний лейбл раздела ещё в репозитории — project fix его не слил
    f.label("reset-button", "1D76DB", "Решение: tests/standards/reset-button");
    for (const labels of ["reset-button", "standard:reset-button"]) {
      const r = task(f, ["new", "--branch-type", "feat", "--title", "Экспорт", "--labels", labels]);
      expect(r.code).toBe(2);
      expect(r.err).toContain("reset-button is a section of topic «forms»: the label is the topic's, a section has none — --labels forms");
    }
    f.labels.splice(0);
    expect(task(f, ["new", "--branch-type", "feat", "--title", "Экспорт", "--labels", "reset-button"]).err).toContain("--labels forms");
    expect(f.mutations).toEqual([]);
  });
});

/**
 * По метке «вопросы» задачу с открытыми вопросами видят дашборд и очередь, а `task answer` снимает её с последним ответом.
 * Ставили её руками: в пилоте #471 диспетчер — у шести задач, и раз промахнулся номером, поставив её на PR (#536).
 * Метку ставит `task new` по разделу вопросов в описании — той же мутацией, что заводит задачу.
 */
describe("task new ставит метку «вопросы», когда в описании есть открытый вопрос", () => {
  const OPEN = "Что сделать.\n\n## Вопросы\n\n1. ✅ Формат? **Ответ:** CSV.\n2. Кодировка?\n3. Разделитель?\n   - запятая\n";
  const QUESTIONS = { color: "FBCA04", description: "Есть открытые вопросы в разделе «## Вопросы»" };

  it("task new с открытым вопросом в описании ставит задаче метку «вопросы»", () => {
    const f = new FakeGitHub(REC);
    Object.assign(f.tree, { capabilities: ["billing"] });
    const billing = f.label("billing", CAP, "Решение: tests/capabilities/billing");
    const questions = f.label("вопросы", QUESTIONS.color, QUESTIONS.description);
    const r = task(f, ["new", "--branch-type", "feat", "--title", "Экспорт", "--body", OPEN, "--labels", "billing"]);
    expect(r.code).toBe(0);
    expect(byOp(f, "CreateLabel")).toEqual([]);
    expect(byOp(f, "CreateIssue")[0].labelIds).toEqual([billing.id, questions.id]);
    expect(issueLabels(f, 561)).toEqual(["billing", "вопросы"]);
    expect(r.out).toContain("+ label «вопросы» — open questions in the description: 2, 3");
  });

  it("task new без раздела вопросов или со всеми отвеченными вопросами метку не ставит", () => {
    const bodies = [[], ["--body", "Что сделать."], ["--body", "## Вопросы\n\n1. ✅ Формат? **Ответ:** CSV.\n2. ✅ авто Кодировка? **Ответ:** UTF-8.\n"]];
    for (const body of bodies) {
      const f = new FakeGitHub(REC);
      f.label("вопросы", QUESTIONS.color, QUESTIONS.description);
      const r = task(f, ["new", "--branch-type", "feat", "--title", "Экспорт", ...body]);
      expect(r.code).toBe(0);
      expect(byOp(f, "CreateIssue")[0]).not.toHaveProperty("labelIds");
      expect(issueLabels(f, 561)).toEqual([]);
      expect(r.out).not.toContain("вопросы");
    }
  });

  it("метки «вопросы» в репозитории нет — task new создаёт её и ставит", () => {
    const f = new FakeGitHub(REC);
    const r = task(f, ["new", "--branch-type", "feat", "--title", "Экспорт", "--body", OPEN]);
    expect(r.code).toBe(0);
    expect(byOp(f, "CreateLabel")).toEqual([{ repositoryId: f.repo.id, name: "вопросы", ...QUESTIONS }]);
    expect(issueLabels(f, 561)).toEqual(["вопросы"]);
    expect(r.out).toContain("+ created label «вопросы»");
  });
});

const HEAD = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
// модель в голове PR: модуль web — весь src, domain — его подкаталог и ещё один каталог
const MODEL = `export default { modules: {
  web: { path: "src", purpose: "приложение" },
  domain: { path: ["src/domain", "lib/domain"], purpose: "правила" },
} };
`;
function prLabels(f: FakeGitHub, number: number) {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(["pr", "labels", String(number), "--repo", REPO], { gh: f.gh, out: (l) => out.push(l), err: (l) => err.push(l), env: {} });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/**
 * Метки решений задачи ставит её PR: какие папки спеки и модули модели он меняет, те решения задача и трогала.
 * Эпик копит метки подзадач — по нему видно, каких решений касается вся большая задача.
 */
describe("pr labels ставит задаче метки решений по диффу PR, эпику — объединение", () => {
  it("задача из «Closes #N» получает метки решений по папкам спеки в диффе PR", () => {
    const f = new FakeGitHub(REC);
    f.label("billing", CAP, "Решение: tests/capabilities/billing");
    f.label("audit", "1D76DB", "Решение: tests/standards/audit");
    const files = ["tests/capabilities/billing/billing.test.ts", "tests/capabilities/billing/billing.md", "tests/standards/audit/eslint.ts", "tests/lib/fake.ts", "README.md"];
    f.prs[120] = { files, closes: [49], head: HEAD, model: null };
    const r = prLabels(f, 120);
    expect(r.code).toBe(0);
    expect(issueLabels(f, 49)).toEqual(["audit", "billing"]);
    expect(r.out).toContain("+ #49: audit, billing");
  });

  it("изменённый код — метка модуля модели из головы PR, путь модуля — самый длинный подходящий", () => {
    const f = new FakeGitHub(REC);
    f.prs[120] = { files: ["src/domain/invoice.ts", "src/web/page.tsx", "lib/domain/money.ts", "docs/readme.md"], closes: [49], head: HEAD, model: MODEL };
    expect(prLabels(f, 120).code).toBe(0);
    expect(issueLabels(f, 49)).toEqual(["domain", "web"]);
  });

  it("pr labels: файл раздела даёт лейбл его темы", () => {
    const f = new FakeGitHub(REC);
    const files = ["tests/standards/forms/reset-button.test.ts", "tests/standards/forms/reset-button.md", "tests/capabilities/orders/persistence.e2e.ts"];
    f.prs[120] = { files, closes: [49], head: HEAD, model: null };
    const r = prLabels(f, 120);
    expect(r.code).toBe(0);
    expect(r.out).toContain("PR #120 → #49: forms, orders");
    expect(issueLabels(f, 49)).toEqual(["forms", "orders"]);
    expect(f.labels.map((l) => l.name).sort()).toEqual(["forms", "orders"]);
  });

  it("метки решения нет в репозитории — создаётся с цветом вида", () => {
    const f = new FakeGitHub(REC);
    f.prs[120] = { files: ["tests/capabilities/billing/billing.test.ts"], closes: [49], head: HEAD, model: null };
    const r = prLabels(f, 120);
    expect(byOp(f, "CreateLabel")).toEqual([{ repositoryId: f.repo.id, name: "billing", color: CAP, description: "Решение: tests/capabilities/billing" }]);
    expect(r.out).toContain("+ created label «billing»");
  });

  it("прежняя метка решения, которого нет в диффе, — не снимается, строка в выводе", () => {
    const f = new FakeGitHub(REC);
    f.label("old", CAP, "Решение: tests/capabilities/old");
    f.label("срочно", "B60205");
    f.labelIssue(49, "old");
    f.labelIssue(49, "срочно");
    f.prs[120] = { files: ["tests/capabilities/billing/billing.test.ts"], closes: [49], head: HEAD, model: null };
    const r = prLabels(f, 120);
    expect(issueLabels(f, 49)).toEqual(["old", "срочно", "billing"]);
    expect(r.out).toContain("= #49: old — the decision is not in the PR diff, the label stays");
    expect(r.out).not.toContain("= #49: срочно");
  });

  // механическая правка решение не меняет: её метка — шум, который в проекте с массовыми правками чистят руками (#192)
  it("переименование файла в папке решения не даёт метку этого решения", () => {
    const f = new FakeGitHub(REC);
    const files = [
      { path: "tests/capabilities/billing/invoice.test.ts", changeType: "RENAMED", additions: 0, deletions: 0 },
      { path: "tests/capabilities/export/export.test.ts", changeType: "RENAMED", additions: 3, deletions: 1 },
    ];
    f.prs[120] = { files, closes: [49], head: HEAD, model: null };
    const r = prLabels(f, 120);
    expect(r.code).toBe(0);
    expect(issueLabels(f, 49)).toEqual(["export"]);
    expect(r.out).toContain("PR #120 → #49: export");
    expect(r.out).toContain("○ billing — only a mechanical edit");
  });

  it("правка только файлов `exceptions/` не даёт метку решения", () => {
    const f = new FakeGitHub(REC);
    f.label("audit", "1D76DB", "Решение: tests/standards/audit");
    const files = [
      { path: "tests/standards/audit/exceptions/importLegacy.json", changeType: "DELETED", additions: 0, deletions: 5 },
      { path: "tests/standards/audit/exceptions/createInvoice.json", changeType: "ADDED", additions: 5, deletions: 0 },
    ];
    f.prs[120] = { files, closes: [49], head: HEAD, model: null };
    const r = prLabels(f, 120);
    expect(r.code).toBe(0);
    expect(f.mutations).toEqual([]);
    expect(r.out).toContain("○ audit — only a mechanical edit");
  });

  // исключений названий больше нет (#447): удаление оставшегося каталога в папке каждого решения — не правка решений
  it("`pr labels`: удаление оставшихся файлов `names.exceptions/` не даёт метку решения", () => {
    const f = new FakeGitHub(REC);
    f.label("billing", CAP, "Решение: tests/capabilities/billing");
    const files = [{ path: "tests/capabilities/billing/names.exceptions/returns-201.json", changeType: "DELETED", additions: 0, deletions: 6 }];
    f.prs[120] = { files, closes: [49], head: HEAD, model: null };
    const r = prLabels(f, 120);
    expect(r.code).toBe(0);
    expect(f.mutations).toEqual([]);
    expect(r.out).toContain("○ billing — only a mechanical edit");
  });

  it("удалённые файлы не дают метку ни решению, ни модулю модели", () => {
    const f = new FakeGitHub(REC);
    const files = [
      { path: "tests/capabilities/legacy/legacy.test.ts", changeType: "DELETED", additions: 0, deletions: 40 },
      { path: "src/domain/old.ts", changeType: "DELETED", additions: 0, deletions: 12 },
      { path: "src/web/page.tsx", changeType: "MODIFIED", additions: 2, deletions: 2 },
    ];
    f.prs[120] = { files, closes: [49], head: HEAD, model: MODEL };
    const r = prLabels(f, 120);
    expect(issueLabels(f, 49)).toEqual(["web"]);
    expect(r.out).toContain("○ domain — only a mechanical edit");
    expect(r.out).toContain("○ legacy — only a mechanical edit");
  });

  // сторож от перекоррекции: механический файл не отменяет содержательную правку решения
  it("механическая правка рядом с содержательной в той же папке — метка решения ставится", () => {
    const f = new FakeGitHub(REC);
    const files = [
      { path: "tests/capabilities/billing/billing.test.ts", changeType: "MODIFIED", additions: 5, deletions: 0 },
      { path: "tests/capabilities/billing/exceptions/a.json", changeType: "MODIFIED", additions: 1, deletions: 0 },
    ];
    f.prs[120] = { files, closes: [49], head: HEAD, model: null };
    const r = prLabels(f, 120);
    expect(issueLabels(f, 49)).toEqual(["billing"]);
    expect(r.out).not.toContain("○ billing");
  });

  it("эпик задачи получает метки подзадачи — объединение", () => {
    const f = new FakeGitHub(REC);
    f.label("est", CAP, "Решение: tests/capabilities/est");
    f.labelIssue(45, "est");
    f.prs[120] = { files: ["tests/capabilities/billing/billing.test.ts", "tests/capabilities/est/est.test.ts"], closes: [47], head: HEAD, model: null };
    const r = prLabels(f, 120);
    expect(issueLabels(f, 47)).toEqual(["billing", "est"]);
    expect(issueLabels(f, 45)).toEqual(["epic", "est", "billing"]);
    expect(r.out).toContain("+ epic #45: billing");
  });

  // модуль web модели и метка-разрез web команды — одно имя, разный смысл: метка решения модулю не нужна (#343)
  it("модуль модели в диффе, его имя у метки-разреза — строка ○, метка-разрез задаче и эпику не ставится", () => {
    const f = new FakeGitHub(REC);
    f.label("web", "C5DEF5", "Разрез: приложения");
    f.prs[120] = { files: ["src/domain/invoice.ts", "src/web/page.tsx"], closes: [47], head: HEAD, model: MODEL };
    const r = prLabels(f, 120);
    expect(r.code).toBe(0);
    expect(issueLabels(f, 47)).toEqual(["domain"]);
    expect(issueLabels(f, 45)).toEqual(["epic", "domain"]);
    expect(r.out).toContain("PR #120 → #47: domain");
    expect(r.out).toContain("○ web — label «web» is slice «приложения», not a decision label: not set");
  });

  /**
   * GitHub ставит на issue не больше 100 меток, и мутация сверх предела падает целиком (#569): PR, задевший почти все
   * решения (смена раннера переписывает тела всех тестов), оставлял задачу без единой новой метки. Не помещается — метку
   * получают решения, чьи утверждения PR меняет: `<тема>.md`, `<раздел>.md` или имена тестов (раздел спеки тела PR), — по алфавиту,
   * сколько помещается.
   */
  it("решений в диффе больше, чем помещается меток, — ставит, что помещается, остальное печатает, не падает", () => {
    const f = new FakeGitHub(REC);
    // меток у задачи больше, чем отдаёт первая страница в 20
    for (let i = 0; i < 30; i++) f.labelIssue(49, `тема-${i}`);
    const names = Array.from({ length: 80 }, (_, i) => `d${String(i).padStart(2, "0")}`);
    // тела тестов 80 решений, у d79 — ещё и описание темы, у d72 — описание её раздела
    const files = [...names.map((n) => `tests/capabilities/${n}/${n}.test.ts`), "tests/capabilities/d79/d79.md", "tests/capabilities/d72/persistence.md"];
    // имена тестов меняют 72 решения — сводкой по папкам, как её пишет spec-diff
    const body = [
      "Closes #49",
      "",
      "## Спека (тесты)",
      "",
      "| Папка | Удалены | Изменены | Добавлены |",
      "|---|--:|--:|--:|",
      ...names.slice(0, 72).map((n) => `| \`tests/capabilities/${n}\` | 0 | 1 | 0 |`),
      "| **Всего** | 0 | 72 | 0 |",
    ].join("\n");
    f.prs[120] = { files, closes: [49], body, head: HEAD, model: null };
    const r = prLabels(f, 120);
    expect(r.code).toBe(0);
    expect(issueLabels(f, 49)).toHaveLength(100);
    expect(issueLabels(f, 49).slice(30)).toEqual(names.slice(0, 70));
    expect(r.out).toContain(
      "○ #49: 80 new decision labels, room for 70 (GitHub puts at most 100 on an issue, it has 30) — only decisions whose <topic>.md, <section>.md or test names the PR changes; test bodies and code only, no label: d73, d74, d75, d76, d77, d78",
    );
    expect(r.out).toContain("○ #49: no room — not set: d70, d71, d72, d79");
  });

  it("эпик у предела меток — новые решения подзадачи печатаются, а не роняют команду", () => {
    const f = new FakeGitHub(REC);
    // у эпика 99 меток: epic и 98 решений прежних подзадач
    for (let i = 0; i < 98; i++) f.labelIssue(45, `прежнее-${i}`);
    const files = ["tests/capabilities/billing/billing.test.ts", "tests/capabilities/est/est.test.ts", "tests/standards/audit/audit.test.ts"];
    const body = [
      "Closes #47",
      "",
      "## Спека (тесты)",
      "",
      "**Добавлены (2):**",
      "",
      "- `tests/standards/audit` · правило держит импорт",
      "- `tests/capabilities/billing` · счёт выставляется в конце месяца",
      "",
      // исключение — не утверждение решения
      "**Исключения — добавлено (1):**",
      "",
      "- `tests/capabilities/est` · importLegacy (#12) — старый импорт",
      "",
      "## Прочее",
      "",
      "- `tests/capabilities/est` · вне раздела спеки — не имя теста",
    ].join("\n");
    f.prs[120] = { files, closes: [47], body, head: HEAD, model: null };
    const r = prLabels(f, 120);
    expect(r.code).toBe(0);
    expect(issueLabels(f, 47)).toEqual(["audit", "billing", "est"]);
    expect(issueLabels(f, 45)).toHaveLength(100);
    expect(issueLabels(f, 45).at(-1)).toBe("audit");
    expect(r.out).toContain(
      "○ epic #45: 3 new decision labels, room for 1 (GitHub puts at most 100 on an issue, it has 99) — only decisions whose <topic>.md, <section>.md or test names the PR changes; test bodies and code only, no label: est",
    );
    expect(r.out).toContain("○ epic #45: no room — not set: billing");
  });

  // GitHub связывает PR с задачей не сразу после создания: pr labels зовут как раз тогда (#164)
  it("связь PR с задачей ещё не появилась — задачи берутся из «Closes #N» в теле PR", () => {
    const f = new FakeGitHub(REC);
    f.prs[120] = { files: ["tests/capabilities/billing/billing.test.ts"], closes: [], body: "Экспорт счетов.\n\nCloses #49, fixes #47, #45", head: HEAD, model: null };
    const r = prLabels(f, 120);
    expect(r.code).toBe(0);
    expect(issueLabels(f, 49)).toEqual(["billing"]);
    expect(issueLabels(f, 47)).toEqual(["billing"]);
    // «, #45» без ключевого слова GitHub не закрывает: задачи PR — только #49 и #47 (#45 — их эпик)
    expect(r.out).toContain("PR #120 → #49, #47: billing");
  });

  it("PR без «Closes #N» — ошибка, ничего не меняется", () => {
    const f = new FakeGitHub(REC);
    f.prs[120] = { files: ["tests/capabilities/billing/billing.test.ts"], closes: [], head: HEAD, model: null };
    const r = prLabels(f, 120);
    expect(r.code).toBe(2);
    expect(r.err).toContain("PR #120 has no «Closes #N»");
    expect(f.mutations).toEqual([]);
  });
});

describe("В организации задача получает тип issue и Priority, эпик — не ниже подзадачи", () => {
  const org = () => new FakeGitHub(asOrg(REC));

  it("тип issue организации и Priority Medium по умолчанию — в той же мутации, что и задача", () => {
    const f = org();
    const r = task(f, ["new", "--branch-type", "feat", "--title", "Экспорт"], ORG);
    expect(byOp(f, "CreateIssue")[0]).toMatchObject({ issueTypeId: "IT_1", issueFields: [{ fieldId: "IFSS_priority", singleSelectOptionId: "IFO_medium" }] });
    expect(r.out).toContain("+ type «Задача»");
    expect(r.out).toContain("+ Priority «Medium»");
  });

  it("task new в организации с --priority High — у задачи Priority High, как прежде", () => {
    const f = org();
    const r = task(f, ["new", "--branch-type", "fix", "--title", "Падает экспорт", "--type", "Bug", "--priority", "High"], ORG);
    expect(byOp(f, "CreateIssue")[0]).toMatchObject({ issueTypeId: "IT_2", issueFields: [{ fieldId: "IFSS_priority", singleSelectOptionId: "IFO_high" }] });
    expect(r.out).toContain("+ Priority «High»");
    expect(r.out).not.toContain("○");
  });

  it("подзадача срочнее эпика — Priority эпика поднимается до неё; не срочнее — эпик не трогается", () => {
    const f = org();
    f.setPriority(45, "Low");
    const r = task(f, ["new", "--branch-type", "feat", "--title", "Экспорт", "--epic", "45", "--priority", "High"], ORG);
    expect(byOp(f, "SetIssueField")).toEqual([{ issueId: f.issue(45).id, issueFields: [{ fieldId: "IFSS_priority", singleSelectOptionId: "IFO_high" }] }]);
    expect(r.out).toContain("+ Priority of epic #45: Low → High");
    task(f, ["new", "--branch-type", "feat", "--title", "Импорт", "--epic", "45", "--priority", "Medium"], ORG);
    expect(byOp(f, "SetIssueField")).toHaveLength(1);
  });

  it("выключенный тип или чужое значение Priority — ошибка до создания", () => {
    const f = org();
    f.repo.owner.issueTypes.nodes.find((t: { name: string }) => t.name === "Баг").isEnabled = false;
    expect(task(f, ["new", "--title", "Экспорт", "--type", "Баг"], ORG).err).toContain("the organization has no enabled type «Баг» — github project fix");
    expect(task(f, ["new", "--branch-type", "feat", "--title", "Экспорт", "--priority", "P1"], ORG).err).toContain("--priority: Urgent, High, Medium, Low");
    expect(f.mutations).toEqual([]);
  });
});

describe("task status двигает задачу по доске, эпик — следом", () => {
  it("подзадача «В работе» — эпик из Бэклог тоже «В работе»: взята первая подзадача", () => {
    const f = new FakeGitHub(REC);
    f.status(45, "Бэклог");
    const r = task(f, ["status", "47", "В работе"]);
    expect(r.code).toBe(0);
    expect(statusSet(f)).toEqual([[47, "В работе"], [45, "В работе"]]);
    expect(r.out).toContain("+ epic #45: Status «В работе» — the first subtask is taken");
  });

  it("эпик уже в работе — не трогается", () => {
    const f = new FakeGitHub(REC);
    f.status(45, "В работе");
    task(f, ["status", "47", "В работе"]);
    expect(statusSet(f)).toEqual([[47, "В работе"]]);
  });

  it("задача вне проекта — добавляется и получает статус", () => {
    const f = new FakeGitHub(REC);
    f.items().splice(f.items().indexOf(f.item(49)), 1);
    const r = task(f, ["status", "#49", "Бэклог"]);
    expect(byOp(f, "AddItem")).toEqual([{ projectId: f.project().id, contentId: f.issue(49).id }]);
    expect(r.out).toContain("+ #49: Status «Бэклог» (added to the project)");
  });

  it("последняя подзадача закрыта и в Готово — подсказка закрыть эпик", () => {
    const f = new FakeGitHub(REC);
    f.closed(47);
    const r = task(f, ["status", "47", "Готово"]);
    expect(r.out).toContain("Next: all subtasks of epic #45 are closed — close the epic and set it to «Готово».");
  });

  it("статус не из канона — ошибка, ничего не меняется", () => {
    const f = new FakeGitHub(REC);
    const r = task(f, ["status", "47", "Сделано"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("status: Бэклог, В работе, Готово");
    expect(f.mutations).toEqual([]);
  });
});

/**
 * Сессия ведёт одну задачу: по сессии `est` считает факт, а вторая задача в той же сессии отдаёт своё время первой.
 * Правило прозой не держалось, поэтому первая задача «В работе» закрепляется за сессией файлом
 * `<каталог конфигурации>/sessions/<CLAUDE_CODE_SESSION_ID>`, другой задаче скрипт отказывает до изменений. Закрепление
 * не снимает ни одна команда: ошибочное убирает человек, удалив файл.
 */
describe("task status берёт в работу одну задачу на сессию", () => {
  it("первая задача «В работе» закрепляется за сессией — файл sessions/<id сессии> в каталоге конфигурации называет owner/repo#N", () => {
    const f = new FakeGitHub(REC);
    const config = scratch();
    const r = task(f, ["status", "49", "В работе"], REPO, inSession(config));
    expect(r.code).toBe(0);
    expect(statusSet(f)).toEqual([[49, "В работе"]]);
    expect(pinned(config)).toBe("miroshnik/elves#49");
  });

  it("другая задача «В работе» в той же сессии — отказ (код 2) до изменений: закреплённая задача, вопрос владельцу о постановке в очередь с промптом исполнителя и файл закрепления — одной строкой", () => {
    const f = new FakeGitHub(REC);
    const config = scratch();
    task(f, ["status", "49", "В работе"], REPO, inSession(config));
    const r = task(f, ["status", "42", "В работе"], REPO, inSession(config));
    expect(r.code).toBe(2);
    expect(r.err.split("\n")).toHaveLength(1);
    expect(r.err).toStartWith(
      "error: the session runs miroshnik/elves#49; #42 isn't taken here — the question to the owner «queue #42?» — yes: a background subagent in its own worktree, " +
        "its prompt: Задача #42 в miroshnik/elves: ты исполнитель сессии-диспетчера. Задание целиком печатает `bun --no-env-file ",
    );
    expect(r.err).toContain("task queue --assignment 42 --repo miroshnik/elves`");
    expect(r.err).toEndWith(` (pin: ${pinFile(config)} — a mistaken one is removed by a human)`);
    expect(r.out).toBe("");
    expect(statusSet(f)).toEqual([[49, "В работе"]]);
    expect(f.mutations).toHaveLength(1);
    expect(pinned(config)).toBe("miroshnik/elves#49");
  });

  it("та же задача «В работе» повторно — без отказа", () => {
    const f = new FakeGitHub(REC);
    const config = scratch();
    task(f, ["status", "49", "В работе"], REPO, inSession(config));
    const r = task(f, ["status", "49", "В работе"], REPO, inSession(config));
    expect(r.code).toBe(0);
    expect(statusSet(f)).toEqual([[49, "В работе"], [49, "В работе"]]);
  });

  // строку не по форме est и дашборд не считают закреплением — сессия свободна и для github (tests/standards/scripts/session-pin)
  it("файл закрепления не по форме owner/repo#N — сессия свободна: «В работе» перезаписывает его задачей со строкой ○", () => {
    const f = new FakeGitHub(REC);
    const config = scratch();
    mkdirSync(path.join(config, "sessions"), { recursive: true });
    writeFileSync(pinFile(config), "49\n");
    const r = task(f, ["status", "42", "В работе"], REPO, inSession(config));
    expect(r.code).toBe(0);
    expect(r.out).toContain(`○ the session pin ${pinFile(config)} held «49», not owner/repo#N — replaced with miroshnik/elves#42`);
    expect(statusSet(f)).toEqual([[42, "В работе"]]);
    expect(pinned(config)).toBe("miroshnik/elves#42");
  });

  it("задача с тем же номером в другом репозитории — другая задача: отказ", () => {
    const config = scratch();
    task(new FakeGitHub(REC), ["status", "49", "В работе"], REPO, inSession(config));
    const other = new FakeGitHub(asOrg(REC));
    const r = task(other, ["status", "49", "В работе"], ORG, inSession(config));
    expect(r.code).toBe(2);
    expect(r.err).toContain("the session runs miroshnik/elves#49; #49 isn't taken here — the question to the owner «queue #49?»");
    expect(other.mutations).toEqual([]);
  });

  // сессия эпика планирует и раздаёт подзадачи, а статус эпику ставит и сама команда — с первой подзадачей
  it("эпик не закрепляется — после него сессия берёт подзадачу", () => {
    const f = new FakeGitHub(REC);
    const config = scratch();
    expect(task(f, ["status", "45", "В работе"], REPO, inSession(config)).code).toBe(0);
    expect(existsSync(pinFile(config))).toBe(false);
    expect(task(f, ["status", "47", "В работе"], REPO, inSession(config)).code).toBe(0);
    expect(pinned(config)).toBe("miroshnik/elves#47");
  });

  it("«Бэклог» и «Готово» другой задаче — без отказа: закрепляет только «В работе»", () => {
    const f = new FakeGitHub(REC);
    const config = scratch();
    task(f, ["status", "49", "В работе"], REPO, inSession(config));
    expect(task(f, ["status", "42", "Бэклог"], REPO, inSession(config)).code).toBe(0);
    expect(task(f, ["status", "42", "Готово"], REPO, inSession(config)).code).toBe(0);
    expect(statusSet(f)).toEqual([[49, "В работе"], [42, "Бэклог"], [42, "Готово"]]);
    expect(pinned(config)).toBe("miroshnik/elves#49");
  });

  it("закрепление не снимают ни «Готово», ни task close — другая задача после них всё равно отказ", () => {
    const f = new FakeGitHub(REC);
    const config = scratch();
    const io = inSession(config);
    task(f, ["status", "49", "В работе"], REPO, io);
    expect(task(f, ["status", "49", "Готово"], REPO, io).code).toBe(0);
    expect(task(f, ["status", "42", "В работе"], REPO, io).code).toBe(2);
    f.prs[77] = { files: [], closes: [49], head: "fix/49-x", base: "main", model: null, merged: true };
    expect(task(f, ["close", "49", "--no-git"], REPO, { ...io, run: () => ({ status: 0, stdout: "Факт: …\n", stderr: "" }) }).code).toBe(0);
    expect(task(f, ["status", "42", "В работе"], REPO, io).code).toBe(2);
    expect(pinned(config)).toBe("miroshnik/elves#49");
  });

  // ключ — id сессии, а не чекаут и не машина: параллельные сессии делят каталог конфигурации
  it("другая сессия с тем же каталогом конфигурации берёт другую задачу без отказа", () => {
    const f = new FakeGitHub(REC);
    const config = scratch();
    const neighbour = "7d9e2a44-1c3b-4e6f-8a70-5b2c9d1e3f08";
    task(f, ["status", "49", "В работе"], REPO, inSession(config));
    expect(task(f, ["status", "42", "В работе"], REPO, inSession(config, neighbour)).code).toBe(0);
    expect(pinned(config)).toBe("miroshnik/elves#49");
    expect(pinned(config, neighbour)).toBe("miroshnik/elves#42");
  });

  // id сессии даёт Bash-инструмент Claude Code; у другого агента его нет — статус важнее гарда
  it("CLAUDE_CODE_SESSION_ID нет — статус ставится, строка «session not recognized», файла нет", () => {
    const f = new FakeGitHub(REC);
    const config = scratch();
    const io = { env: { ELVES_CONFIG_DIR: config } };
    const r = task(f, ["status", "49", "В работе"], REPO, io);
    expect(r.code).toBe(0);
    expect(r.out).toContain("○ session not recognized (no CLAUDE_CODE_SESSION_ID) — the task isn't pinned");
    expect(task(f, ["status", "42", "В работе"], REPO, io).code).toBe(0);
    expect(statusSet(f)).toEqual([[49, "В работе"], [42, "В работе"]]);
    expect(existsSync(path.join(config, "sessions"))).toBe(false);
  });

  // каталог конфигурации бывает симлинком на личный чекаут (ELVES_PRIVATE при install -g)
  it("каталог конфигурации — чекаут git: закрепления в него не коммитятся — sessions/ закрыт своим .gitignore", () => {
    const f = new FakeGitHub(REC);
    const config = scratch();
    const repo = gitRepo(config);
    repo.commit({ "repos.json": "{}\n" }, "init");
    expect(task(f, ["status", "49", "В работе"], REPO, inSession(config)).code).toBe(0);
    expect(existsSync(pinFile(config))).toBe(true);
    expect(repo.git("status", "--porcelain", "--untracked-files=all")).toBe("");
  });
});

// чекаут сессии — worktree от origin/main с upstream, как его заводит инструмент: .git/config — общий с основным чекаутом
function worktree(name = REPO) {
  const { dir, cleanup } = tmpDir();
  temp.push(cleanup);
  const origin = path.join(dir, `${name}.git`);
  mkdirSync(path.dirname(origin), { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const main = path.join(dir, "main");
  mkdirSync(main);
  const repo = gitRepo(main);
  repo.commit({ "README.md": "x\n", ".agents/elves.json": '{ "language": "ru" }\n' }, "init");
  repo.git("remote", "add", "origin", origin);
  repo.git("push", "-q", "-u", "origin", "main");
  const work = path.join(dir, "wt");
  repo.git("worktree", "add", "-q", "--track", "-b", "claude/x-1", work, "origin/main");
  // путь блокировки — как его называет git: настоящий, без симлинков временного каталога (/var → /private/var на macOS)
  return { work, main, lock: path.join(realpathSync(main), ".git", "config.lock") };
}

/**
 * Ветку worktree (`claude/<слаг>-<хеш>`) агент переименовывал в ветку задачи сам, `git branch -m`, — и 11 раз получал
 * `could not lock config file .git/config` (#438): `.git/config` общий у всех worktree репозитория, его держит git
 * другого чекаута. git переименовывает ссылку, а секцию ветки в конфиге (upstream) — нет, код 128; повтор `git branch
 * -m` старого имени уже не находит. `task status N "В работе" --branch <ветка задачи>` переименовывает тем же вызовом,
 * что берёт задачу, и повторяет запись секции, пока конфиг занят.
 */
describe("task status --branch переименовывает ветку worktree в ветку задачи", () => {
  const config = (cwd: string, key: string) => {
    try {
      return execFileSync("git", ["config", "--get", key], { cwd, encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  };

  it("ветка worktree переименована в ветку задачи вместе с её настройкой — upstream остался у ветки", () => {
    const { work } = worktree();
    const f = new FakeGitHub(REC);
    const r = task(f, ["status", "49", "В работе", "--branch", "fix/49-config-lock"], REPO, { run: noEst, cwd: work });
    expect(r.code).toBe(0);
    expect(statusSet(f)).toEqual([[49, "В работе"]]);
    expect(git(work, "branch", "--show-current")).toBe("fix/49-config-lock");
    expect(config(work, "branch.fix/49-config-lock.merge")).toBe("refs/heads/main");
    expect(config(work, "branch.claude/x-1.merge")).toBe(null);
    expect(r.out).toContain("+ branch claude/x-1 → fix/49-config-lock");
  });

  // клон, сделанный до переименования репозитория, — его чекаут, хотя origin называет прежнее имя (#560)
  it("origin чекаута называет прежнее имя переименованного репозитория — это его чекаут: ветка переименована", () => {
    const { work } = worktree("miroshnik/old-name");
    const f = new FakeGitHub(REC);
    f.formerNames = ["miroshnik/old-name"];
    const r = task(f, ["status", "49", "В работе", "--branch", "fix/49-config-lock"], REPO, { run: noEst, cwd: work });
    expect(r.code).toBe(0);
    expect(git(work, "branch", "--show-current")).toBe("fix/49-config-lock");
    expect(r.out).toContain("+ branch claude/x-1 → fix/49-config-lock");
  });

  it("блокировка .git/config при переименовании ветки — повтор, ветка и её настройка переименованы", () => {
    const { work, lock } = worktree();
    writeFileSync(lock, "");
    let waits = 0;
    // git другого чекаута отпускает конфиг через две паузы
    const sleep = () => void (++waits === 2 && rmSync(lock));
    const r = task(new FakeGitHub(REC), ["status", "49", "В работе", "--branch", "fix/49-config-lock"], REPO, { run: noEst, cwd: work, sleep });
    expect(r.code).toBe(0);
    expect(waits).toBe(2);
    expect(git(work, "branch", "--show-current")).toBe("fix/49-config-lock");
    expect(config(work, "branch.fix/49-config-lock.merge")).toBe("refs/heads/main");
    expect(config(work, "branch.claude/x-1.merge")).toBe(null);
    expect(r.out).toContain("+ branch claude/x-1 → fix/49-config-lock (.git/config was locked: 2 retries)");
  });

  it("блокировка не снята за время повторов — ветка переименована, строка ! с файлом блокировки и командой, которая доделает настройку; код 1, блокировка не тронута", () => {
    const { work, lock } = worktree();
    writeFileSync(lock, "");
    let waits = 0;
    const f = new FakeGitHub(REC);
    const r = task(f, ["status", "49", "В работе", "--branch", "fix/49-config-lock"], REPO, { run: noEst, cwd: work, sleep: () => void waits++ });
    expect(r.code).toBe(1);
    expect(waits).toBe(19);
    expect(statusSet(f)).toEqual([[49, "В работе"]]);
    expect(git(work, "branch", "--show-current")).toBe("fix/49-config-lock");
    expect(existsSync(lock)).toBe(true);
    expect(r.out).toMatch(
      new RegExp(`^! branch renamed to fix/49-config-lock, its section in \\.git/config is not: ${lock.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is held by another git process \\(\\d+ s\\) — not removed; finish: git config --rename-section branch\\.claude/x-1 branch\\.fix/49-config-lock$`, "m"),
    );
  });

  it("ошибка git не из-за блокировки — без повторов: строка !, код 1", () => {
    const { work } = worktree();
    git(work, "branch", "fix/49-config-lock", "origin/main");
    let waits = 0;
    const r = task(new FakeGitHub(REC), ["status", "49", "В работе", "--branch", "fix/49-config-lock"], REPO, { run: noEst, cwd: work, sleep: () => void waits++ });
    expect(r.code).toBe(1);
    expect(waits).toBe(0);
    expect(git(work, "branch", "--show-current")).toBe("claude/x-1");
    expect(r.out).toContain("! git branch -m claude/x-1 fix/49-config-lock: fatal: a branch named 'fix/49-config-lock' already exists");
  });

  it("повторный вызов на ветке задачи — без изменений: строка =", () => {
    const { work } = worktree();
    const args = ["status", "49", "В работе", "--branch", "fix/49-config-lock"];
    task(new FakeGitHub(REC), args, REPO, { run: noEst, cwd: work });
    const r = task(new FakeGitHub(REC), args, REPO, { run: noEst, cwd: work });
    expect(r.code).toBe(0);
    expect(r.out).toContain("= branch fix/49-config-lock");
  });

  it("--branch не ветка этой задачи по канону — ошибка до изменений", () => {
    const { work } = worktree();
    for (const branch of ["fix/50-config-lock", "claude/x-2", "wip/49-config-lock", "fix/49-Конфиг", "fix/49-Config-Lock"]) {
      const f = new FakeGitHub(REC);
      const r = task(f, ["status", "49", "В работе", "--branch", branch], REPO, { run: noEst, cwd: work });
      expect(r.code).toBe(2);
      expect(r.err).toBe(`error: --branch «${branch}»: expected a branch of #49 by the canon — [<area>/]<type>/49-<slug>, type feat|fix|docs|refactor|perf|test|chore|ci|build|research, slug — Latin kebab-case`);
      expect(f.mutations).toEqual([]);
      expect(git(work, "branch", "--show-current")).toBe("claude/x-1");
    }
  });

  it("--branch не с «В работе» и у эпика — ошибка до изменений: ветку заводят, беря задачу в работу, у эпика ветки нет", () => {
    const { work } = worktree();
    const f = new FakeGitHub(REC);
    const backlog = task(f, ["status", "49", "Бэклог", "--branch", "fix/49-config-lock"], REPO, { run: noEst, cwd: work });
    expect(backlog.code).toBe(2);
    expect(backlog.err).toBe("error: --branch — only with «В работе»: the branch is renamed when the task is taken into work");
    const epic = task(f, ["status", "45", "В работе", "--branch", "fix/45-config-lock"], REPO, { run: noEst, cwd: work });
    expect(epic.code).toBe(2);
    expect(epic.err).toBe("error: --branch: #45 is an epic — an epic has no branch");
    expect(f.mutations).toEqual([]);
    expect(git(work, "branch", "--show-current")).toBe("claude/x-1");
  });

  it("текущая ветка уже есть на origin (main) или HEAD отсоединён — не трогается, строка ○", () => {
    const { work, main } = worktree();
    const onMain = task(new FakeGitHub(REC), ["status", "49", "В работе", "--branch", "fix/49-config-lock"], REPO, { run: noEst, cwd: main });
    expect(onMain.code).toBe(0);
    expect(onMain.out).toContain("○ branch main is already on origin — left alone: a pushed branch is renamed together with its PR, by hand");
    expect(git(main, "branch", "--show-current")).toBe("main");
    git(work, "switch", "-q", "--detach");
    const detached = task(new FakeGitHub(REC), ["status", "49", "В работе", "--branch", "fix/49-config-lock"], REPO, { run: noEst, cwd: work });
    expect(detached.code).toBe(0);
    expect(detached.out).toContain("○ branch left alone: HEAD is detached — a task branch from a fresh origin/main: git fetch origin && git switch -c fix/49-config-lock origin/main --no-track");
    expect(git(work, "branch", "--list", "fix/49-config-lock")).toBe("");
  });

  it("каталог — не чекаут репозитория задачи — ветка не трогается, строка ○", () => {
    const f = new FakeGitHub(REC);
    const r = task(f, ["status", "49", "В работе", "--branch", "fix/49-config-lock"], REPO, { run: noEst, cwd: elsewhere() });
    expect(r.code).toBe(0);
    expect(statusSet(f)).toEqual([[49, "В работе"]]);
    expect(r.out).toContain("○ branch left alone: the current directory is not a checkout of miroshnik/elves");
  });
});

/**
 * #666: начало задачи — медиана 11 ходов одного флоу: `project check`, `task show` задачи и эпика, проверка
 * параллельной работы, `task status --branch`, имя сессии, загрузка инструментов приложения по одному. `task start`
 * делает это одним вызовом и останавливается до изменений, когда брать задачу рано.
 */
describe("task start берёт задачу одним вызовом", () => {
  const BODY = "Что сделать.\n\n## Сценарии\n\n1. экспорт в PDF\n2. экспорт пустого счёта\n\n## Вопросы\n";
  // est — подпроцесс bun: вызовы записываются, git — настоящий во временном worktree
  function start(f: FakeGitHub, args: string[], o: { config?: string; cwd?: string; env?: Record<string, string> } = {}) {
    const est: string[][] = [];
    const run = githubOrigin((cmd: string, a: string[], cwd?: string) => (cmd === "bun" ? (est.push(a), { status: 0, stdout: "", stderr: "" }) : realRun(cmd, a, cwd)));
    const config = o.config ?? scratch();
    const r = task(f, ["start", ...args], REPO, { run, cwd: o.cwd ?? worktree().work, env: { CLAUDE_CODE_SESSION_ID: SESSION, ELVES_CONFIG_DIR: config, ...o.env } });
    return { ...r, est, config };
  }

  it("task start берёт задачу без открытых вопросов: статус «В работе», закрепление за сессией, ветка по типу и названию", () => {
    const f = new FakeGitHub(REC);
    f.issue(49).body = BODY;
    const { work } = worktree();
    const r = start(f, ["49", "--branch", "fix/49-invoice-export"], { cwd: work });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(statusSet(f)).toEqual([[49, "В работе"]]);
    expect(pinned(r.config)).toBe("miroshnik/elves#49");
    expect(git(work, "branch", "--show-current")).toBe("fix/49-invoice-export");
    expect(r.out).toContain("+ branch claude/x-1 → fix/49-invoice-export");
  });

  it("task start с открытыми вопросами задачи или эпика печатает их и не берёт задачу", () => {
    const own = new FakeGitHub(REC);
    own.issue(49).body = `${BODY}\n1. ✅ Формат? **Ответ:** PDF.\n2. Кодировка?\n`;
    const r = start(own, ["49", "--branch", "fix/49-invoice-export"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('Questions: open 2; answered 1 — task answer 49 <k> "<answer>" [--auto]');
    expect(r.out).toContain("! open questions — #49: 2: ask the owner all of them in one message");
    expect(own.mutations).toEqual([]);

    const epic = new FakeGitHub(REC);
    epic.issue(47).body = BODY;
    epic.issue(45).body = "Цель эпика.\n\n## Вопросы\n\n1. Сроки?\n";
    const e = start(epic, ["47", "--branch", "feat/47-invoice-export"]);
    expect(e.code).toBe(1);
    expect(e.out).toContain("- question 1. Сроки?");
    expect(e.out).toContain("! open questions — epic #45: 1:");
    expect(epic.mutations).toEqual([]);
    expect(existsSync(pinFile(e.config))).toBe(false);
  });

  it("task start находит открытый PR или ветку задачи и не берёт её второй раз", () => {
    const pr = new FakeGitHub(REC);
    pr.issue(49).body = BODY;
    pr.prs[80] = { files: [], closes: [49], head: "fix/49-other", base: "main", model: null };
    const r = start(pr, ["49", "--branch", "fix/49-invoice-export"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("! #49 is in work elsewhere — PR #80 (fix/49-other): continue that work or wait for its merge — the task isn't taken a second time");
    expect(pr.mutations).toEqual([]);

    const branch = new FakeGitHub(REC);
    branch.issue(49).body = BODY;
    const { work, main } = worktree();
    git(main, "branch", "fix/49-earlier");
    const b = start(branch, ["49", "--branch", "fix/49-invoice-export"], { cwd: work });
    expect(b.code).toBe(1);
    expect(b.out).toContain("! #49 is in work elsewhere — branch fix/49-earlier:");
    expect(branch.mutations).toEqual([]);
    expect(git(work, "branch", "--show-current")).toBe("claude/x-1");
  });

  /**
   * Перезапуск исполнителя (#709): ветка задачи — работа прежнего исполнителя, `task start` без флага остановился бы на
   * ней. С `--resume` ветка и PR — то, что продолжают: задача «В работе», текущая ветка не переименована, строка
   * `Branch:` называет, что продолжать; продолжать нечего или флаг вместе с `--branch` — отказ до изменений.
   */
  it("задание перезапуска исполнителя продолжает его ветку без отказа task start", () => {
    const f = new FakeGitHub(REC);
    f.issue(49).body = BODY;
    f.prs[80] = { files: [], closes: [49], head: "fix/49-earlier", base: "main", model: null };
    const { work, main } = worktree();
    git(main, "branch", "fix/49-earlier");
    const r = start(f, ["49", "--resume"], { cwd: work });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(statusSet(f)).toEqual([[49, "В работе"]]);
    expect(git(work, "branch", "--show-current")).toBe("claude/x-1");
    expect(r.out).not.toContain("is in work elsewhere");
    expect(r.out).toContain("Branch: continue PR #80 (fix/49-earlier), branch fix/49-earlier — checked out in another worktree (git worktree list): work in that one; in none — git switch it here");
    // оценки нет — тип берётся у продолжаемой ветки
    expect(r.est.map((a) => a.slice(2))).toEqual([["estimate", "49", "--repo", REPO, "--type", "fix", "--write"]]);

    const nothing = new FakeGitHub(REC);
    nothing.issue(49).body = BODY;
    const n = start(nothing, ["49", "--resume"]);
    expect(n.code).toBe(2);
    expect(n.err).toContain("--resume: #49 has no branch or open PR to continue — a first take: task start 49 --branch <type>/49-<slug>");
    expect(nothing.mutations).toEqual([]);
    const both = start(nothing, ["49", "--resume", "--branch", "fix/49-x"]);
    expect(both.code).toBe(2);
    expect(both.err).toContain("--resume continues the task's existing branch — without --branch");
  });

  it("task start печатает имя сессии, ветку, сценарии и строку загрузки инструментов", () => {
    const f = new FakeGitHub(REC);
    f.issue(49).body = BODY;
    const r = start(f, ["49", "--branch", "fix/49-invoice-export"], { env: { CLAUDECODE: "1" } });
    expect(r.code).toBe(0);
    const lines = r.out.split("\n");
    expect(lines.slice(-4)).toEqual([
      `Next: the session name — «#49 ${f.issue(49).title}»`,
      "Branch: fix/49-invoice-export",
      "Scenarios: 2 in «## Сценарии» — the future it names",
      "ToolSearch select:mcp__ccd_session_mgmt__set_session_title,mcp__ccd_pr__set_monitor,TaskStop,mcp__ccd_session_mgmt__archive_session",
    ]);
    // оценки у задачи нет — её ставит est с типом ветки
    expect(r.est.map((a) => a.slice(2))).toEqual([["estimate", "49", "--repo", REPO, "--type", "fix", "--write"]]);

    const bare = new FakeGitHub(REC);
    const n = start(bare, ["49", "--branch", "fix/49-invoice-export"]);
    expect(n.out).toContain("○ no scenarios in «## Сценарии» — a code task gets them in the description before code");
    expect(n.out).not.toContain("ToolSearch");
  });

  it("project check в task start идёт один раз за сессию", () => {
    const config = scratch();
    const first = start(new FakeGitHub(REC), ["49", "--branch", "fix/49-invoice-export"], { config });
    expect(first.out.split("\n")[0]).toBe("✅ project check: miroshnik/elves per the canon");
    const again = start(new FakeGitHub(REC), ["49", "--branch", "fix/49-invoice-export"], { config });
    expect(again.out.split("\n")[0]).toBe("= project check — done in this session");
    const other = start(new FakeGitHub(REC), ["49", "--branch", "fix/49-invoice-export"], { config, env: { CLAUDE_CODE_SESSION_ID: "7d9e2a44-1c3b-4e6f-8a70-5b2c9d1e3f08" } });
    expect(other.out.split("\n")[0]).toBe("✅ project check: miroshnik/elves per the canon");
  });

  it("task start эпика и задачи с --branch не по канону — отказ до изменений", () => {
    const f = new FakeGitHub(REC);
    const epic = start(f, ["45"]);
    expect(epic.code).toBe(2);
    expect(epic.err).toContain("#45 is an epic — it isn't taken into work");
    const wrong = start(f, ["49", "--branch", "fix/50-x"]);
    expect(wrong.code).toBe(2);
    expect(wrong.err).toContain("--branch «fix/50-x»: expected a branch of #49 by the canon");
    expect(f.mutations).toEqual([]);
  });
});

describe("task drop закрывает без выполнения и убирает из проекта", () => {
  // закрытую без выполнения «Item closed» запишет в «Готово» — поэтому её убирают из проекта
  it("закрывает как not planned и убирает из проекта", () => {
    const f = new FakeGitHub(REC);
    const itemId = f.item(49).id;
    const r = task(f, ["drop", "49"]);
    expect(r.code).toBe(0);
    expect(byOp(f, "CloseIssue")).toEqual([{ issueId: f.issue(49).id, stateReason: "NOT_PLANNED" }]);
    expect(byOp(f, "DeleteItem")).toEqual([{ projectId: f.project().id, itemId }]);
    expect(f.item(49)).toBeUndefined();
  });

  it("--duplicate-of — закрывает как дубль со ссылкой на оригинал", () => {
    const f = new FakeGitHub(REC);
    const r = task(f, ["drop", "49", "--duplicate-of", "42"]);
    expect(byOp(f, "CloseIssue")).toEqual([{ issueId: f.issue(49).id, stateReason: "DUPLICATE", duplicateIssueId: f.issue(42).id }]);
    expect(r.out).toContain("+ #49 closed: duplicate of #42");
  });

  it("подзадача эпика — подсказка пересчитать оценку эпика", () => {
    const f = new FakeGitHub(REC);
    expect(task(f, ["drop", "47"]).out).toContain("Next: «Оценка, ч» of epic #45 — recompute as the sum of the remaining subtasks.");
  });

  it("уже закрыта без выполнения, но в проекте — только убирает из проекта", () => {
    const f = new FakeGitHub(REC);
    f.closed(49, "NOT_PLANNED");
    task(f, ["drop", "49"]);
    expect(byOp(f, "CloseIssue")).toEqual([]);
    expect(byOp(f, "DeleteItem")).toHaveLength(1);
  });

  it("выполненную задачу не трогает — ошибка", () => {
    const f = new FakeGitHub(REC);
    const r = task(f, ["drop", "46"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("#46 is closed as completed — drop is only for tasks not done");
    expect(f.mutations).toEqual([]);
  });
});

/**
 * GitHub добавляет задачу в проект не мгновенно для чтения: ответ createIssue и чтение задачи могут ещё не показывать
 * элемент, а повторное добавление отвечает «Content already exists». Статус всё равно ставится — по элементу, который
 * станет виден после короткой паузы.
 */
describe("Статус ставится, даже если проект ещё не показал задачу", () => {
  it("createIssue ещё не показывает элемент, добавление — «уже есть»: task new всё равно ставит Бэклог", () => {
    const f = new FakeGitHub(REC);
    f.createIssueHidesItems = true;
    const r = task(f, ["new", "--branch-type", "feat", "--title", "Экспорт"]);
    expect(r.code).toBe(0);
    expect(statusSet(f)).toEqual([[561, "Бэклог"]]);
    expect(r.out).toContain("+ project «elves»: Status «Бэклог»");
  });

  it("задачу проект уже добавил, а чтение её ещё не показывает: task status перечитывает с паузой и ставит статус", () => {
    const f = new FakeGitHub(REC);
    f.issueRefLag[49] = 2; // не видно при первом чтении и при первом перечитывании после «уже есть»
    pauses = 0;
    const r = task(f, ["status", "49", "В работе"]);
    expect(r.code).toBe(0);
    expect(statusSet(f)).toEqual([[49, "В работе"]]);
    expect(pauses).toBe(2);
    expect(r.out).toContain("+ #49: Status «В работе»");
    expect(r.out).not.toContain("added to the project");
  });

  it("элемент так и не виден — понятная ошибка с тем, что повторить, а не падение", () => {
    const f = new FakeGitHub(REC);
    f.issueRefLag[49] = 100;
    const r = task(f, ["status", "49", "В работе"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("#49 is already in the project, but its item isn't visible — retry: github task status 49");
  });
});

/**
 * Ручного `gh` в сессиях больше, чем вызовов скриптов: `gh issue view` — ~1,1–1,2 тыс. на проект (медиана 4 на сессию),
 * и задачу собирали по частям — описание, эпик, его подзадачи, PR и его чеки. `task show` печатает это одним выводом.
 */
describe("task show печатает задачу одним выводом", () => {
  const BODY = "Задача одной командой.\n\n## Сценарии\n\n1. task new заводит задачу\n\n## Вопросы\n\n1. ✅ Формат? **Ответ:** CSV.\n2. Кодировка?\n3. Разделитель?\n";

  it("`task show` печатает задачу, её открытые вопросы, эпик и PR одним выводом", () => {
    const f = new FakeGitHub(REC);
    task(f, ["new", "--branch-type", "feat", "--title", "Экспорт счетов", "--epic", "45"]);
    const before = f.mutations.length;
    f.issue(47).body = BODY;
    f.issue(45).body = "Цель эпика.\n\n## Вопросы\n\n1. Сроки?\n2. ✅ Владелец? **Ответ:** я.\n";
    f.numbers[47] = { "Оценка, ч": 0.5 };
    f.blockedBy[47] = [49, 46];
    f.prs[80] = { files: [], closes: [47], head: "feat/47-task", base: "main", model: null, checks: { tests: "SUCCESS", "spec-publish": "SKIPPED", e2e: "IN_PROGRESS", lint: "FAILURE" } };
    const r = task(f, ["show", "47"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out.split("\n")).toEqual([
      "#47 GitHub · Задача одной командой — github task — https://github.com/miroshnik/elves/issues/47",
      "Status «В работе» · «Оценка, ч» 0.5",
      "Epic #45 «GitHub · Скилл github: проект и задачи по канону одной командой» — open questions: 1, other open tasks: 1",
      "- question 1. Сроки?",
      "- task #561 «GitHub · Экспорт счетов»",
      // закрытый блокер уже не блокирует
      "Blocked by: #49 «Стандарт · облачная сессия — скрипты скиллов с Projects v2 выходят с объяснением»",
      "PR #80 open — checks: 2 ✅, 1 ⏳ (e2e), 1 ❌ (lint)",
      'Questions: open 2, 3; answered 1 — task answer 47 <k> "<answer>" [--auto]',
      "Comments: none",
      "Epic #45 comments: none",
      "",
      ...BODY.trimEnd().split("\n"),
    ]);
    expect(f.mutations).toHaveLength(before);
  });

  /**
   * #651: канон велит сверить вопросы с тем, что уже ответено, — «комментарии, код», а `task show` комментариев не
   * запрашивал: ответ человека комментарием исполнитель не видел и спрашивал заново или отвечал «✅ авто» поверх него.
   */
  it("комментарии задачи и эпика — автор, дата и текст полностью", () => {
    const f = new FakeGitHub(REC);
    f.issue(47).body = "Что сделать.\n";
    f.comments[47] = [{ body: "Кодировку берём из файла.\r\n\r\nПример — во вложении.", url: "c1", author: "anna", createdAt: "2026-10-19T08:05:41Z" }];
    f.comments[45] = [{ body: "Сроки — к релизу.", url: "c2" }];
    const lines = task(f, ["show", "47"]).out.split("\n");
    expect(lines.slice(lines.indexOf("Questions: none"))).toEqual([
      "Questions: none",
      "Comments: 1",
      "- @anna 2026-10-19 08:05 UTC:",
      "  Кодировку берём из файла.",
      "",
      "  Пример — во вложении.",
      "Epic #45 comments: 1",
      "- @miroshnik 2026-10-20 12:00 UTC:",
      "  Сроки — к релизу.",
      "",
      "Что сделать.",
    ]);
  });

  it("служебные комментарии флоу — строкой без текста, «Состояние» — полностью", () => {
    const f = new FakeGitHub(REC);
    f.issue(47).body = "Что сделать.\n";
    const at = (h: number) => `2026-10-19T${String(h).padStart(2, "0")}:00:00Z`;
    f.comments[47] = [
      { body: 'Оценка: 0.5 ч (тип feat, доверие A; прогноз по фактам аналогов). Аналоги (подбор скриптом): #281 (факт 0.33 ч).\n<!-- est {"v": 1, "h": 0.5} -->', url: "c1", createdAt: at(9) },
      // человек начал словом оценки — маркера est нет: это его текст, а не комментарий флоу
      { body: "Оценка: по-моему, тут на час.", url: "c2", author: "anna", createdAt: at(10) },
      { body: "**Состояние:** парсер готов, дальше — вывод.\nВетка feat/47-task.", url: "c3", createdAt: at(11) },
      { body: "Закрыта по PR #80: GitHub не связал PR с задачей", url: "c4", createdAt: at(12) },
      { body: 'Факт: 0.41 ч активных в Claude Code (оценка 0.5 ч, ×0.82).\n+ вручную: 0.2 ч\n<!-- fact {"v": 1, "h": 0.41} -->', url: "c5", createdAt: at(13) },
    ];
    // отчёт актуализации — на любом языке словаря
    f.comments[45] = [
      { body: "Актуализация после #46, скрипт: у #47 снят blocked by на выполненных #46.", url: "c6", createdAt: at(14) },
      { body: "**Refresh after #46, result:** the block is up to date", url: "c7", createdAt: at(15) },
    ];
    const lines = task(f, ["show", "47"]).out.split("\n");
    expect(lines.slice(lines.indexOf("Comments: 5"), lines.indexOf(""))).toEqual([
      "Comments: 5",
      "- @miroshnik 2026-10-19 09:00 UTC — flow: estimate",
      "- @anna 2026-10-19 10:00 UTC:",
      "  Оценка: по-моему, тут на час.",
      "- @miroshnik 2026-10-19 11:00 UTC — State:",
      "  **Состояние:** парсер готов, дальше — вывод.",
      "  Ветка feat/47-task.",
      "- @miroshnik 2026-10-19 12:00 UTC — flow: closed by PR",
      "- @miroshnik 2026-10-19 13:00 UTC — flow: actual",
      "Epic #45 comments: 2",
      "- @miroshnik 2026-10-19 14:00 UTC — flow: epic refresh, the script's fixes",
      "- @miroshnik 2026-10-19 15:00 UTC — flow: epic refresh report",
    ]);
  });

  it("комментарий вида «k. ✅» к открытому вопросу помечен у вопроса строкой «ответ в комментарии»", () => {
    const f = new FakeGitHub(REC);
    f.issue(47).body = "## Вопросы\n\n1. ✅ Формат? **Ответ:** CSV.\n2. Кодировка?\n3. Разделитель?\n";
    f.issue(45).body = "## Вопросы\n\n1. Сроки?\n2. Владелец?\n";
    f.comments[47] = [
      // вопрос 1 уже отвечен — помечен только открытый 2
      { body: "1. ✅ CSV\n2. ✅ UTF-8", url: "c1", author: "anna", createdAt: "2026-10-19T08:05:00Z" },
      // «Состояние» и комментарий флоу — не ответы
      { body: "Состояние: жду ответа на вопрос 3.", url: "c2" },
      { body: 'Оценка: 0.5 ч.\n<!-- est {"v": 1} -->', url: "c3" },
    ];
    f.comments[45] = [{ body: "2. ✅ я", url: "c4", author: "anna", createdAt: "2026-10-18T10:00:00Z" }];
    const lines = task(f, ["show", "47"]).out.split("\n");
    expect(lines.slice(2, 6)).toEqual([
      "Epic #45 «GitHub · Скилл github: проект и задачи по канону одной командой» — open questions: 2, other open tasks: 0",
      "- question 1. Сроки?",
      "- question 2. Владелец?",
      '  ? 2: answer in a comment of @anna 2026-10-18 10:00 UTC — check it and task answer 45 2 "<answer>"',
    ]);
    const questions = lines.findIndex((l) => l.startsWith("Questions:"));
    expect(lines.slice(questions, questions + 3)).toEqual([
      'Questions: open 2, 3; answered 1 — task answer 47 <k> "<answer>" [--auto]',
      '? 2: answer in a comment of @anna 2026-10-19 08:05 UTC — check it and task answer 47 2 "<answer>"',
      "Comments: 3",
    ]);
  });

  it("комментарий свободным текстом при открытых вопросах помечен у каждого открытого вопроса: какой из них он отвечает, сверяет агент", () => {
    const f = new FakeGitHub(REC);
    f.issue(47).body = "## Вопросы\n\n1. Кодировка?\n2. ✅ Формат? **Ответ:** CSV.\n3. Разделитель?\n";
    f.comments[47] = [
      { body: "Делай через REST, кэш не нужен.", url: "c1", author: "anna", createdAt: "2026-10-19T08:05:00Z" },
      { body: "Согласен.", url: "c2", author: "boris", createdAt: "2026-10-19T09:30:00Z" },
    ];
    const lines = task(f, ["show", "47"]).out.split("\n");
    const questions = lines.findIndex((l) => l.startsWith("Questions:"));
    expect(lines.slice(questions + 1, questions + 3)).toEqual([
      '? 1: answer in comments of @anna 2026-10-19 08:05 UTC, @boris 2026-10-19 09:30 UTC — check it and task answer 47 1 "<answer>"',
      '? 3: answer in comments of @anna 2026-10-19 08:05 UTC, @boris 2026-10-19 09:30 UTC — check it and task answer 47 3 "<answer>"',
    ]);
  });

  it("блокер — issue другого репозитория: в «Blocked by» — с именем репозитория, а не номером, похожим на задачу этого", () => {
    const f = new FakeGitHub(REC);
    f.blockedBy[47] = [49, { repo: "acme/runtime", number: 46, state: "OPEN", title: "Падает при старте", id: "I_ext46" }];
    expect(task(f, ["show", "47"]).out.split("\n")).toContain("Blocked by: #49 «Стандарт · облачная сессия — скрипты скиллов с Projects v2 выходят с объяснением», acme/runtime#46 «Падает при старте»");
  });

  // #492: из перезапусков task show брал лучший прогон — ✅ у чека, на котором ожидание ci-wait даёт FAIL
  it("чек зелёный, потом красный на перезапуске — task show называет его красным, как ci-wait", () => {
    const f = new FakeGitHub(REC);
    f.prs[80] = { files: [], closes: [47], head: "feat/47-task", base: "main", model: null, checks: { tests: ["SUCCESS", "FAILURE"], lint: ["FAILURE", "SUCCESS"] } };
    expect(task(f, ["show", "47"]).out.split("\n")).toContain("PR #80 open — checks: 1 ✅, 1 ❌ (tests)");
  });

  it("эпик: тип из метки epic, его открытые подзадачи; строки PR у эпика нет", () => {
    const f = new FakeGitHub(REC);
    f.issue(45).body = "## Вопросы\n\n1. Сроки?\n";
    const lines = task(f, ["show", "45"]).out.split("\n");
    // у эпика в записи три подзадачи: #46 и #50 закрыты, открыта #47
    expect(lines.slice(1, 5)).toEqual(["Эпик · Status «В работе» · no «Оценка, ч»", "Subtasks: open 1 of 3", "- task #47 «GitHub · Задача одной командой — github task»", 'Questions: open 1 — task answer 45 <k> "<answer>" [--auto]']);
    expect(lines.some((l) => l.startsWith("PR"))).toBe(false);
  });

  it("GitHub ещё не связал PR с задачей — PR находится по ветке задачи; вопросов нет — «Questions: none»", () => {
    const f = new FakeGitHub(REC);
    f.prs[81] = { files: [], closes: [], head: "feat/49-cloud", base: "main", model: null };
    const lines = task(f, ["show", "49"]).out.split("\n");
    expect(lines).toContain("PR #81 open — no checks yet (not linked: branch feat/49-cloud)");
    expect(lines).toContain("Questions: none");
  });

  // #603: рекомендация вопроса 2 #598 называла «✅ авто» — task queue и task show сочли вопрос отвеченным
  it("вопрос с ✅ внутри текста — открытый: отвеченным его делает ✅ в начале ответа — после номера, после вопроса или в начале строки пункта", () => {
    const f = new FakeGitHub(REC);
    f.issue(47).body = [
      "## Вопросы",
      "",
      "1. Ответ — скриптом или руками (✅ авто, метка вопросов)? **Рекомендация:** скриптом — он ставит «✅ авто» и `✅ auto` сам.",
      "2. ✅ Кодировка? **Ответ:** UTF-8.",
      "3. Разделитель? ✅ авто: запятая.",
      "4. Порог тишины?",
      "   ✅ авто: 15 мин.",
      "5. Песочница — ✅ auto: проверено.",
    ].join("\n");
    expect(task(f, ["show", "47"]).out.split("\n")).toContain('Questions: open 1; answered 2, 3, 4, 5 — task answer 47 <k> "<answer>" [--auto]');
  });

  it("PR у задачи нет — «PR: none»; задачи нет — ошибка, код 2", () => {
    const f = new FakeGitHub(REC);
    expect(task(f, ["show", "49"]).out.split("\n")).toContain("PR: none");
    const r = task(f, ["show", "999"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("no issue #999 in miroshnik/elves");
  });
});

/**
 * `gh issue edit --body-file` в сессиях — 280 раз, чаще всего ради ✅ у вопроса: агент переписывал описание целиком, чтобы
 * поменять одну строку. `task answer` ставит ✅ и ответ у вопроса и снимает метку вопросов, когда открытых не осталось.
 */
describe("task answer ставит ответ у вопроса задачи", () => {
  const BODY = "Что сделать.\n\n## Вопросы\n\n1. ✅ Формат? **Ответ:** CSV.\n2. Кодировка?\n3. Разделитель?\n   - запятая\n   - точка с запятой\n\n## Готово, когда\n\n- файл открывается\n";
  const bodyOf = (f: FakeGitHub) => byOp(f, "UpdateIssue").at(-1)?.body;

  it("`task answer` ставит ✅ и ответ у вопроса, нумерация не меняется", () => {
    const f = new FakeGitHub(REC);
    f.issue(47).body = BODY;
    const r = task(f, ["answer", "47", "2", "UTF-8."]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(bodyOf(f)).toBe(BODY.replace("2. Кодировка?", "2. ✅ Кодировка? **Ответ:** UTF-8."));
    expect(r.out.split("\n")).toEqual(["+ #47: question 2 — ✅ and the answer in the description", "○ #47: open questions left: 3"]);
    expect(byOp(f, "RemoveLabels")).toEqual([]);
  });

  it("вопрос в несколько строк — ответ отдельной строкой в конце пункта, следующий раздел не тронут", () => {
    const f = new FakeGitHub(REC);
    f.issue(47).body = BODY;
    task(f, ["answer", "47", "3", "запятая"]);
    expect(bodyOf(f)).toBe(BODY.replace("3. Разделитель?\n   - запятая\n   - точка с запятой\n", "3. ✅ Разделитель?\n   - запятая\n   - точка с запятой\n   **Ответ:** запятая\n"));
  });

  it("ответ на последний открытый вопрос снимает метку вопросов", () => {
    const f = new FakeGitHub(REC);
    f.issue(42).body = "## Вопросы\n\n1. ✅ Формат? **Ответ:** CSV.\n2. Кодировка?\n";
    const r = task(f, ["answer", "42", "2", "UTF-8."]);
    expect(r.code).toBe(0);
    expect(byOp(f, "RemoveLabels")).toEqual([{ labelableId: f.issue(42).id, labelIds: ["LA_вопросы"] }]);
    expect(f.issue(42).labels.nodes).toEqual([]);
    expect(r.out.split("\n").at(-1)).toBe("+ #42: label «вопросы» removed — no open questions left");
  });

  it("`task answer --auto` помечает ответ «✅ авто»", () => {
    const f = new FakeGitHub(REC);
    f.issue(47).body = BODY;
    task(f, ["answer", "47", "2", "UTF-8:", "файлы из Excel", "--auto"]);
    expect(bodyOf(f)).toContain("\n2. ✅ авто Кодировка? **Ответ:** UTF-8: файлы из Excel\n");
  });

  describe("ошибка до изменений — описание не тронуто", () => {
    const refused = (args: string[], message: string, body: string | undefined = BODY) => {
      const f = new FakeGitHub(REC);
      f.issue(47).body = body;
      const r = task(f, ["answer", "47", ...args]);
      expect(r.code).toBe(2);
      expect(r.err).toContain(message);
      expect(f.mutations).toEqual([]);
    };
    it("вопрос уже с ✅ — ответ меняют руками", () => refused(["1", "TSV"], "#47: question 1 is already answered (✅)"));
    it("вопроса с таким номером нет — ошибка называет номера вопросов", () => refused(["9", "TSV"], "#47: no question 9 in «## Вопросы»; questions: 1, 2, 3"));
    it("раздела вопросов нет", () => refused(["1", "TSV"], "#47: no «## Вопросы» section with numbered questions", "Что сделать."));
    it("ответ пустой", () => refused(["2"], "task answer: expected the answer text after the question number"));
  });
});

/**
 * Правка описания — три хода: `gh issue view --json body`, правка в файле, `gh issue edit --body-file`; за две недели в
 * пяти проектах ≈ 2200 чтений описания и ≈ 480 `gh issue edit` (#670). `task edit` правит описание одним вызовом: замена
 * текста, пункт в раздел, отметка пункта — и отказывает целиком, если хоть одна правка неоднозначна.
 */
describe("task edit правит описание задачи одним вызовом", () => {
  const BODY = "Экспорт счетов.\n\n## Что сделать\n\n- [ ] PDF-выгрузка\n- [ ] CSV-выгрузка\n\n## Сценарии\n\n1. выгрузка в PDF\n\n## Вопросы\n\n1. ✅ Формат? **Ответ:** PDF.\n";
  const bodyOf = (f: FakeGitHub) => byOp(f, "UpdateIssue").at(-1)?.body;
  const edit = (args: string[], body = BODY) => {
    const f = new FakeGitHub(REC);
    f.issue(47).body = body;
    return { f, r: task(f, ["edit", "47", ...args]) };
  };

  it("task edit заменяет текст, который встречается в описании один раз", () => {
    const { f, r } = edit(["--replace", "Экспорт счетов.", "Экспорт счетов клиенту."]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(bodyOf(f)).toBe(BODY.replace("Экспорт счетов.", "Экспорт счетов клиенту."));
    expect(byOp(f, "UpdateIssue")).toHaveLength(1);
    expect(r.out.split("\n")).toEqual(["+ #47: description — 1 edit: replaced «Экспорт счетов.»"]);
  });

  describe("task edit отказывает, если текст не найден или встречается дважды, и ничего не меняет", () => {
    const refused = (args: string[], message: string) => {
      const { f, r } = edit(args);
      expect(r.code).toBe(2);
      expect(r.err).toContain(message);
      expect(f.mutations).toEqual([]);
    };
    it("замена: текста нет", () => refused(["--replace", "XML-выгрузка", "JSON"], "#47: --replace «XML-выгрузка» — not found in the description"));
    it("замена: текст встречается дважды", () => refused(["--replace", "-выгрузка", "-экспорт"], "#47: --replace «-выгрузка» — found 2 times, expected once: give a longer text"));
    it("пункт: раздела нет", () => refused(["--add", "## Готово, когда", "файл открывается"], "#47: --add — no section «## Готово, когда»"));
    it("отметка: пункта нет", () => refused(["--check", "XML"], "#47: --check «XML» — no unchecked item «- [ ] …» with it"));
    it("отметка: подходят два пункта", () => refused(["--check", "выгрузка"], "#47: --check «выгрузка» — 2 unchecked items with it, expected one: give a longer text"));
    it("без правок", () => refused([], "task edit: expected edits — --replace <old> <new>, --add <section> <item>, --check <item text>"));
    it("правке не хватает аргумента", () => refused(["--replace", "Экспорт"], "task edit: --replace expects 2 values: --replace <old> <new>"));
  });

  it("task edit добавляет пункт в раздел и отмечает пункт выполненным", () => {
    const { f, r } = edit(["--add", "## Что сделать", "XML-выгрузка", "--add", "## Сценарии", "выгрузка в CSV", "--check", "PDF"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    // вид пункта — по последнему пункту раздела: чек-лист — `- [ ]`, нумерованный — следующий номер
    expect(bodyOf(f)).toBe(
      BODY.replace("- [ ] PDF-выгрузка\n- [ ] CSV-выгрузка\n", "- [x] PDF-выгрузка\n- [ ] CSV-выгрузка\n- [ ] XML-выгрузка\n").replace("1. выгрузка в PDF\n", "1. выгрузка в PDF\n2. выгрузка в CSV\n"),
    );
    expect(r.out.split("\n")).toEqual(["+ #47: description — 3 edits: added to «## Что сделать», added to «## Сценарии», checked «PDF»"]);
  });

  it("несколько правок task edit в одном вызове применяются вместе или не применяются", () => {
    const together = edit(["--replace", "Экспорт счетов.", "Экспорт.", "--check", "CSV"]);
    expect(together.r.code).toBe(0);
    expect(byOp(together.f, "UpdateIssue")).toHaveLength(1);
    expect(bodyOf(together.f)).toBe(BODY.replace("Экспорт счетов.", "Экспорт.").replace("- [ ] CSV", "- [x] CSV"));
    // вторая правка не находит текст — первая тоже не записана
    const none = edit(["--replace", "Экспорт счетов.", "Экспорт.", "--check", "XML"]);
    expect(none.r.code).toBe(2);
    expect(none.f.mutations).toEqual([]);
    // правки идут по порядку: следующая видит текст предыдущей
    const chained = edit(["--add", "## Что сделать", "XML-выгрузка", "--check", "XML"]);
    expect(bodyOf(chained.f)).toContain("- [x] XML-выгрузка\n");
  });

  it("облачная сессия: task edit пишет описание через REST", () => {
    const f = Object.assign(new FakeGitHub(REC), { cloud: true });
    const body = `Что сделать.\n\n## Что сделать\n\n- [ ] PDF\n\n${CLOUD_SIGNATURE}`;
    f.issue(47).body = body;
    const r = task(f, ["edit", "47", "--add", "## Что сделать", "CSV"], REPO, { env: { CLAUDE_CODE_REMOTE: "true" } });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    // подпись прокси после `---` — не пункт раздела: новый пункт встаёт до неё
    expect(f.issue(47).body).toBe(body.replace("- [ ] PDF\n", "- [ ] PDF\n- [ ] CSV\n"));
    expect(f.mutations).toEqual([]);
  });
});

/**
 * Облачной сессии (claude.ai/code) прокси закрывает GraphQL, поиск и Projects v2 — остаётся REST `repos/<репозиторий>/…`.
 * Скрипт отказывал целиком, и в облачных сессиях #559 и #598 ответ на вопрос и новую задачу делали руками: формат
 * (✅ авто, метка вопросов, подзадача эпика) держался на внимательности агента (#603). Где REST хватает — он, чего нет
 * (поля проекта, оценка) — строка для локальной сессии.
 */
describe("Облачная сессия: task show, task answer и task new — через REST репозитория", () => {
  const CLOUD: Partial<Io> = { env: { CLAUDE_CODE_REMOTE: "true" } };
  const cloud = (rec = REC) => Object.assign(new FakeGitHub(rec), { cloud: true });
  const writes = (f: FakeGitHub, method: string) => f.rest.filter((x) => x.method === method);

  it("облачная сессия: `task show` — задача, эпик с вопросами, подзадачи, блокеры и PR с чеками через REST репозитория, без полей проекта", () => {
    const f = cloud();
    const BODY = "Что сделать.\n\n## Вопросы\n\n1. ✅ Формат? **Ответ:** CSV.\n2. Кодировка?\n";
    f.issue(47).body = BODY;
    f.issue(45).body = "Цель эпика.\n\n## Вопросы\n\n1. Сроки?\n2. ✅ Владелец? **Ответ:** я.\n";
    f.blockedBy[47] = [49, 46];
    // ветка облака — не по канону: PR находится по «Closes #47» в теле
    f.prs[80] = { files: [], closes: [47], head: "claude/export-k2", base: "main", model: null, checks: { tests: "SUCCESS", e2e: "IN_PROGRESS", lint: ["SUCCESS", "FAILURE"] } };
    f.prs[81] = { files: [], closes: [49], head: "feat/49-cloud", base: "main", model: null };
    const r = task(f, ["show", "47"], REPO, CLOUD);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out.split("\n")).toEqual([
      "#47 GitHub · Задача одной командой — github task — https://github.com/miroshnik/elves/issues/47",
      "no project in the cloud (docs/cloud-sessions.md)",
      "Epic #45 «GitHub · Скилл github: проект и задачи по канону одной командой» — open questions: 1, other open tasks: 0",
      "- question 1. Сроки?",
      "Blocked by: #49 «Стандарт · облачная сессия — скрипты скиллов с Projects v2 выходят с объяснением»",
      "PR #80 open — checks: 1 ✅, 1 ⏳ (e2e), 1 ❌ (lint)",
      'Questions: open 2; answered 1 — task answer 47 <k> "<answer>" [--auto]',
      "Comments: none",
      "Epic #45 comments: none",
      "",
      ...BODY.trimEnd().split("\n"),
    ]);
    expect(f.rest).toEqual([]);
    // эпик — его открытые подзадачи
    expect(task(f, ["show", "45"], REPO, CLOUD).out.split("\n").slice(1, 4)).toEqual(["Эпик · no project in the cloud (docs/cloud-sessions.md)", "Subtasks: open 1 of 3", "- task #47 «GitHub · Задача одной командой — github task»"]);
  });

  it("task show через REST печатает комментарии задачи и эпика", () => {
    const f = cloud();
    f.issue(47).body = "## Вопросы\n\n1. Кодировка?\n";
    f.comments[47] = [
      { body: "1. ✅ UTF-8", url: "c1", author: "anna", createdAt: "2026-10-19T08:05:00Z" },
      { body: 'Оценка: 0.5 ч.\n<!-- est {"v": 1} -->', url: "c2", createdAt: "2026-10-19T09:00:00Z" },
    ];
    f.comments[45] = [{ body: "Актуализация после #46, итог: блок актуален", url: "c3", createdAt: "2026-10-19T10:00:00Z" }];
    const r = task(f, ["show", "47"], REPO, CLOUD);
    expect(r.err).toBe("");
    const lines = r.out.split("\n");
    expect(lines.slice(lines.findIndex((l) => l.startsWith("Questions:")), lines.indexOf(""))).toEqual([
      'Questions: open 1 — task answer 47 <k> "<answer>" [--auto]',
      '? 1: answer in a comment of @anna 2026-10-19 08:05 UTC — check it and task answer 47 1 "<answer>"',
      "Comments: 2",
      "- @anna 2026-10-19 08:05 UTC:",
      "  1. ✅ UTF-8",
      "- @miroshnik 2026-10-19 09:00 UTC — flow: estimate",
      "Epic #45 comments: 1",
      "- @miroshnik 2026-10-19 10:00 UTC — flow: epic refresh report",
    ]);
  });

  it("облачная сессия: `task answer` ставит ✅ и ответ через REST, подпись прокси в конце описания в последний вопрос не попадает", () => {
    const f = cloud();
    const BODY = `Что сделать.\n\n## Вопросы\n\n1. Кодировка?\n2. Разделитель?\n\n${CLOUD_SIGNATURE}`;
    f.issue(47).body = BODY;
    const r = task(f, ["answer", "47", "2", "запятая", "--auto"], REPO, CLOUD);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const want = BODY.replace("2. Разделитель?", "2. ✅ авто Разделитель? **Ответ:** запятая");
    expect(writes(f, "PATCH")).toEqual([{ method: "PATCH", route: "repos/miroshnik/elves/issues/47", payload: { body: want } }]);
    // прокси не дописал вторую подпись: она уже в конце
    expect(f.issue(47).body).toBe(want);
    expect(r.out.split("\n")).toEqual(["+ #47: question 2 — ✅ and the answer in the description", "○ #47: open questions left: 1"]);
  });

  it("облачная сессия: ответ на последний открытый вопрос снимает метку вопросов через REST", () => {
    const f = cloud();
    f.issue(42).body = "## Вопросы\n\n1. ✅ Формат? **Ответ:** CSV.\n2. Кодировка?\n";
    const r = task(f, ["answer", "42", "2", "UTF-8."], REPO, CLOUD);
    expect(r.code).toBe(0);
    expect(writes(f, "DELETE")).toEqual([{ method: "DELETE", route: `repos/miroshnik/elves/issues/42/labels/${encodeURIComponent("вопросы")}`, payload: undefined }]);
    expect(f.issue(42).labels.nodes).toEqual([]);
    expect(r.out.split("\n").at(-1)).toBe("+ #42: label «вопросы» removed — no open questions left");
    expect(f.mutations).toEqual([]);
  });

  it("облачная сессия: `task new` заводит подзадачу эпика через REST — sub-issue, blocked by, метки решений и вопросов; Status и оценку называет строкой для локальной сессии", () => {
    const f = cloud();
    Object.assign(f.tree, { capabilities: ["billing"] });
    const questions = f.label("вопросы", "FBCA04", "Есть открытые вопросы в разделе «## Вопросы»");
    const calls: string[][] = [];
    const run = (cmd: string, args: string[]) => (calls.push([cmd, ...args]), { status: 0, stdout: "", stderr: "" });
    const body = "Что сделать.\n\n## Вопросы\n\n1. Формат?\n";
    const r = task(f, ["new", "--branch-type", "feat", "--title", "Экспорт", "--body", body, "--epic", "45", "--blocked-by", "49,46", "--labels", "billing"], REPO, { ...CLOUD, run });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(writes(f, "POST")).toEqual([
      { method: "POST", route: "repos/miroshnik/elves/labels", payload: { name: "billing", color: CAP, description: "Решение: tests/capabilities/billing" } },
      { method: "POST", route: "repos/miroshnik/elves/issues", payload: { title: "GitHub · Экспорт", body, labels: ["billing", "вопросы"] } },
      { method: "POST", route: "repos/miroshnik/elves/issues/45/sub_issues", payload: { sub_issue_id: 100561 } },
      { method: "POST", route: "repos/miroshnik/elves/issues/561/dependencies/blocked_by", payload: { issue_id: 100049 } },
      { method: "POST", route: "repos/miroshnik/elves/issues/45/labels", payload: { labels: ["billing"] } },
    ]);
    expect(f.issue(561).parent).toEqual({ id: f.issue(45).id, number: 45 });
    expect(f.blockedBy[561]).toEqual([49]);
    expect(issueLabels(f, 561)).toEqual(["billing", questions.name]);
    expect(f.mutations).toEqual([]);
    // est в облаке оценку не считает — её команда в строке для локальной сессии
    expect(calls).toEqual([]);
    expect(r.out.split("\n")).toEqual([
      "Created #561 GitHub · Экспорт — https://github.com/miroshnik/elves/issues/561",
      "+ created label «billing»",
      "+ labels: billing",
      "+ label «вопросы» — open questions in the description: 1",
      "+ subtask of epic #45",
      "+ blocked by #49",
      "+ #46 is closed — doesn't block, skipped",
      "+ epic #45: billing",
      'Next: the cloud has no GitHub Projects (docs/cloud-sessions.md) — a local session: github task status 561 "Бэклог" (the project, Status); est estimate 561 --type feat --write («Оценка, ч»).',
      "Next: «Оценка, ч» of epic #45 — recompute as the sum of its subtasks' estimates.",
    ]);
  });

  it("облачная сессия: `task new` в организации — тип issue по имени, Priority — строкой для локальной сессии", () => {
    const f = cloud(asOrg(REC));
    const r = task(f, ["new", "--branch-type", "fix", "--title", "Падает экспорт", "--type", "Баг", "--priority", "High"], ORG, CLOUD);
    expect(r.err).toBe("");
    expect(writes(f, "POST")).toEqual([{ method: "POST", route: "repos/acme/elves/issues", payload: { title: "Падает экспорт", type: "Баг", body: "## Сценарии\n\n## Вопросы\n" } }]);
    expect(r.out).toContain("+ type «Баг»");
    expect(r.out).toContain("; Priority «High» — on the issue page.");
    // чужое значение Priority — ошибка до создания
    expect(task(f, ["new", "--branch-type", "fix", "--title", "Падает импорт", "--priority", "P1"], ORG, CLOUD).err).toContain("--priority: Urgent, High, Medium, Low");
    expect(writes(f, "POST")).toHaveLength(1);
  });

  it("облачная сессия: дубль `task new` находит листингом открытых задач — поиск GitHub в облаке закрыт", () => {
    const f = cloud();
    const r = task(f, ["new", "--branch-type", "feat", "--title", f.issue(49).title], REPO, CLOUD);
    expect(r.code).toBe(2);
    expect(r.err).toContain("an open task with this title already exists: #49");
    expect(f.rest).toEqual([]);
  });

  it("облачная сессия: остальные команды отказывают с объяснением и называют команды с REST-путём", () => {
    for (const args of [["status", "49", "В работе"], ["queue"], ["drop", "49"]]) {
      const f = cloud();
      const r = task(f, args, REPO, CLOUD);
      expect(r.code).toBe(2);
      expect(r.err).toBe(`cloud session: GitHub GraphQL and Projects are unavailable to it (403, docs/cloud-sessions.md) — task ${args[0]} runs in a local session; in the cloud — task show, task answer, task edit, task new over the repository's REST`);
      expect(f.rest).toEqual([]);
    }
  });
});

/**
 * Закрытие после мержа шло фазами друг за другом: деплой, `task close`, актуализация блока субагентом, — медиана 8,5 мин
 * и 12 ходов на пиковом контексте, больше половины — ходы модели: прочитать справочник, собрать задание субагенту.
 * Актуализация от деплоя не зависит и идёт параллельно с ним, а задание печатает скрипт: агенту не нужен справочник.
 * Нет эпика или открытых задач в нём — актуализировать нечего, субагент не нужен.
 *
 * Субагент сам собирал то, что знает скрипт (#435): в одном проекте 248 запусков, ~35 вызовов на запуск, из них 40% —
 * `gh`. Механику — blocked by на выполненных задачах, метку вопросов без открытых вопросов, milestone без открытых задач
 * — делает `task actualize`; тексты задач эпика и файлы PR кладёт в задание, его печатает `--assignment` — первым
 * вызовом субагента: сессия на пиковом контексте не переписывает десятки КБ в вызов субагента.
 */
describe("task actualize делает механику актуализации блока и печатает задание субагенту", () => {
  const REFERENCE = readFileSync(new URL("../../../skills/github/reference.md", import.meta.url), "utf8");
  // пять проверок канона — список между «Five checks:» и «What was fixed» в справочнике
  const CHECKS = (/Five checks:\n\n([\s\S]*?)\n\nWhat was fixed/.exec(REFERENCE)?.[1] ?? "").split(/\n(?=\d\. )/);
  const LEAD = "Задача #46 (эпик #45): актуализация блока после мержа — открытые задачи эпика привести в соответствие с выкаченным.";
  const merged46 = (f: FakeGitHub, files: FakeGitHub["prs"][number]["files"] = []) => (f.prs[77] = { files, closes: [46], head: "feat/46-project-check", base: "main", model: null, merged: true });
  /** Подзадача эпика #45 — новая открытая задача (#561, #562, …: следующие за последней задачей записи). */
  const subtask = (f: FakeGitHub, title: string, ...more: string[]) => task(f, ["new", "--branch-type", "feat", "--title", title, "--epic", "45", ...more]).out.match(/^Created #(\d+)/)![1]!;

  it("сессия получает от скрипта короткий промпт субагенту: строка «Задача #N (эпик #M)» и команда, которая печатает задание", () => {
    const f = new FakeGitHub(REC);
    merged46(f);
    const r = task(f, ["actualize", "46"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const lines = r.out.split("\n");
    expect(lines.at(-3)).toBe("Next: a subagent in the background — the two lines below are its whole prompt, pass them as is.");
    // номер задачи — после слова «Задача»: est привязывает работу субагента к задаче, эпик после «эпик» — нет
    expect(lines.at(-2)).toBe(LEAD);
    expect(lines.at(-1)).toMatch(/^Задание целиком — тексты открытых задач эпика, файлы PR, .* печатает `bun --no-env-file \S+\/skills\/github\/scripts\/github\.ts task actualize 46 --assignment --repo miroshnik\/elves`: позови первым, вне песочницы/);
    // механике нечего править — ни мутаций, ни комментария к эпику
    expect(f.mutations).toEqual([]);
  });

  it("задание субагенту содержит тексты эпика и его открытых задач, файлы PR и проверки по смыслу — 1, 3 и 5", () => {
    const f = new FakeGitHub(REC);
    merged46(f, ["skills/github/scripts/github.ts", { path: "docs/old.md", changeType: "DELETED", additions: 0, deletions: 12 }]);
    f.issue(45).body = "Цель эпика: проект по канону.";
    f.issue(47).body = "Задача одной командой.\n\n## Сценарии\n\n1. task new заводит задачу";
    const closed = subtask(f, "Закрытая задача", "--body", "Текст закрытой задачи");
    f.closed(Number(closed));
    const before = f.mutations.length;
    const r = task(f, ["actualize", "46", "--assignment"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const lines = r.out.split("\n");
    expect(lines[0]).toBe(LEAD);
    expect(lines).toContain("Репозиторий miroshnik/elves. Выкачено: #46 «GitHub · Проект по канону — github project check и fix», PR #77, дифф — `git log -p -E --grep '#46([^0-9]|$)' origin/main`.");
    expect(r.out).toContain("Файлы PR #77:\n- skills/github/scripts/github.ts (+1 −1)\n- docs/old.md (deleted, +0 −12)");
    expect(r.out).toContain("## Эпик #45 «GitHub · Скилл github: проект и задачи по канону одной командой»\n~~~~markdown\nЦель эпика: проект по канону.\n~~~~");
    expect(r.out).toContain("## Открытые задачи эпика — его подзадачи (sub-issues), а не список в описании эпика");
    // под заголовком — куда идёт находка-повтор проверки 5 (#636): #47 в записи — «В работе»
    expect(r.out).toContain(
      "### #47 «GitHub · Задача одной командой — github task»\nСтатус «В работе» — задача уже идёт: находку-повтор того же рода сюда не дописывать, а завести новой задачей.\n" +
        "~~~~markdown\nЗадача одной командой.\n\n## Сценарии\n\n1. task new заводит задачу\n~~~~",
    );
    // закрытая задача эпика в задание не идёт
    expect(r.out).not.toContain("Текст закрытой задачи");
    // механику проверок 2 и 4 сделал скрипт — субагенту из пяти проверок канона остаются проверки по смыслу
    expect(CHECKS).toHaveLength(5);
    expect(CHECKS.every((c, i) => c.startsWith(`${i + 1}. **`))).toBe(true);
    for (const i of [0, 2, 4]) expect(r.out).toContain(CHECKS[i]!);
    for (const i of [1, 3]) expect(r.out).not.toContain(CHECKS[i]!);
    expect(r.out).toContain("#46, эпик #45 и их milestone не закрывать — это сделает task close после тебя");
    // итог — всегда, и «блок актуален» тоже: по нему task close видит, что актуализация закончена (#571)
    expect(r.out).toContain("Итог — всегда: «report» файла");
    expect(r.out).toContain("Скрипт пишет его комментарием к эпику #45 — «Актуализация после #46, итог: …»");
    // задание печатается, ничего не меняя
    expect(f.mutations.length).toBe(before);
  });

  it("blocked by на закрытой задаче снимает сам task actualize, на открытой — оставляет", () => {
    const f = new FakeGitHub(REC);
    merged46(f);
    f.blockedBy[47] = [46, 49];
    const r = task(f, ["actualize", "46"]);
    expect(byOp(f, "RemoveBlockedBy")).toEqual([{ issueId: f.issue(47).id, blockingIssueId: f.issue(46).id }]);
    expect(f.blockedBy[47]).toEqual([49]);
    expect(r.out).toContain("+ #47: blocked by #46 (closed) removed");
  });

  it("blocked by на влитой, но ещё открытой задаче — её PR влит — снимается тоже", () => {
    const f = new FakeGitHub(REC);
    f.prs[78] = { files: [], closes: [47], head: "feat/47-task", base: "main", model: null, merged: true };
    const next = subtask(f, "Экспорт", "--blocked-by", "47");
    expect(f.blockedBy[Number(next)]).toEqual([47]);
    const r = task(f, ["actualize", "47"]);
    expect(f.blockedBy[Number(next)]).toEqual([]);
    expect(r.out).toContain(`+ #${next}: blocked by #47 (merged) removed`);
  });

  it("blocked by на issue другого репозитория: закрытый снимается и назван с репозиторием, открытый с номером влитой задачи — остаётся", () => {
    const f = new FakeGitHub(REC);
    merged46(f);
    const other = (number: number, state: string) => ({ repo: "acme/runtime", number, state, title: "Падает при старте", id: `I_ext${number}` });
    f.blockedBy[47] = [other(7, "CLOSED"), other(46, "OPEN")];
    const r = task(f, ["actualize", "46"]);
    expect(byOp(f, "RemoveBlockedBy")).toEqual([{ issueId: f.issue(47).id, blockingIssueId: "I_ext7" }]);
    expect(r.out).toContain("+ #47: blocked by acme/runtime#7 (closed) removed");
    expect(byOp(f, "AddComment")[0].body).toContain("у #47 снят blocked by на выполненных acme/runtime#7");
  });

  it("метку вопросов у задачи эпика без открытых вопросов снимает сам task actualize, с открытым вопросом — оставляет", () => {
    const f = new FakeGitHub(REC);
    merged46(f);
    f.labelIssue(47, "вопросы");
    f.issue(47).body = "## Вопросы\n\n1. ✅ Формат?\n   Ответ: PDF.\n";
    // метку вопросов задаче с открытым вопросом ставит сам task new
    const other = Number(subtask(f, "Экспорт", "--body", "## Вопросы\n\n1. ✅ Формат? Ответ: PDF.\n2. Срок?\n"));
    // метка на английском (проект сменил язык) — тоже метка вопросов; раздела нет — открытых вопросов нет
    f.labelIssue(45, "questions");
    const r = task(f, ["actualize", "46"]);
    expect(byOp(f, "RemoveLabels")).toEqual([
      { labelableId: f.issue(45).id, labelIds: [f.labelId("questions")] },
      { labelableId: f.issue(47).id, labelIds: [f.labelId("вопросы")] },
    ]);
    expect(f.issue(47).labels.nodes).toEqual([]);
    expect(f.issue(other).labels.nodes).toEqual([{ name: "вопросы" }]);
    expect(r.out).toContain("+ #47: label «вопросы» removed — no open questions");
  });

  it("milestone задач эпика без открытых задач закрывает сам task actualize, milestone самой задачи оставляет task close", () => {
    const f = new FakeGitHub(REC);
    merged46(f);
    const own = f.milestone("GitHub · 0 · Проект");
    f.issueMilestones[46] = own.id;
    const done = Number(subtask(f, "Сделанная"));
    const stage = f.milestone("GitHub · 1 · Задачи");
    f.issueMilestones[done] = stage.id;
    f.closed(done);
    const later = f.milestone("GitHub · 2 · Дальше");
    f.issueMilestones[47] = later.id;
    const r = task(f, ["actualize", "46"]);
    expect(f.closedMilestones).toEqual([stage.number]);
    expect(r.out).toContain("+ milestone «GitHub · 1 · Задачи» closed: no open tasks left");
  });

  it("правки скрипта — одной строкой в комментарии к эпику; повторный запуск ничего не правит и не комментирует", () => {
    const f = new FakeGitHub(REC);
    merged46(f);
    f.blockedBy[47] = [46];
    f.labelIssue(47, "вопросы");
    const r = task(f, ["actualize", "46"]);
    expect(byOp(f, "AddComment")).toEqual([{ subjectId: f.issue(45).id, body: "Актуализация после #46, скрипт: у #47 снят blocked by на выполненных #46; у #47 снята метка «вопросы»: открытых вопросов нет." }]);
    expect(r.out).toContain("+ epic #45: a comment with the script's fixes");
    const before = f.mutations.length;
    task(f, ["actualize", "46"]);
    expect(f.mutations.length).toBe(before);
  });

  it("ответ на открытый вопрос в комментарии и копии связей в тексте задание называет, а не правит", () => {
    const f = new FakeGitHub(REC);
    merged46(f);
    f.issue(45).body = "Цель.\n\n## План\n\n- #46 «Проект»\n- [ ] #47 «Задача»\n- #12 чужая задача — не подзадача";
    f.issue(47).body = "Задача.\n\nПосле #46 — сначала проект.\n⛔ ждёт решения\n\n## Вопросы\n\n1. Формат?\n2. ✅ Срок? Ответ: неделя.\n3. Цвет?\n";
    f.comments[47] = [
      { body: "Ответы владельца:\n1. ✅ PDF\n2. ✅ месяц", url: "https://github.com/miroshnik/elves/issues/47#issuecomment-1" },
      { body: "1. ✅ PDF и CSV", url: "https://github.com/miroshnik/elves/issues/47#issuecomment-2" },
    ];
    expect(task(f, ["actualize", "46"]).out).not.toContain("+ ");
    expect(f.mutations).toEqual([]);
    const r = task(f, ["actualize", "46", "--assignment"]);
    expect(r.out).toContain("## Копии связей в тексте — убрать: связи держит GitHub (sub-issue, blocked by)\n- #45: «- #46 «Проект»»\n- #45: «- [ ] #47 «Задача»»\n- #47: «После #46 — сначала проект.»\n- #47: «⛔ ждёт решения»");
    // #12 — не подзадача эпика: пункт списка с ней — не копия связи
    expect(r.out).not.toContain("- #45: «- #12");
    // ответ — из последнего комментария; на уже отмеченный вопрос 2 и на вопрос без ответа 3 — ничего
    expect(r.out).toContain("- #47, вопрос 1: «PDF и CSV» — https://github.com/miroshnik/elves/issues/47#issuecomment-2");
    expect(r.out).not.toContain("вопрос 2");
    expect(r.out).not.toContain("вопрос 3");
    expect(f.mutations).toEqual([]);
  });

  it("у задачи без эпика скрипт пишет, что актуализация не нужна", () => {
    const f = new FakeGitHub(REC);
    const r = task(f, ["actualize", "49"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("○ refresh not needed: #49 has no epic. Next: task close 49 — after the deploy, where the merge deploys.");
  });

  it("в эпике нет открытых задач, кроме этой, — субагент без проверок по смыслу не нужен: механика и строка «актуализация не нужна»", () => {
    const f = new FakeGitHub(REC);
    f.prs[78] = { files: [], closes: [47], head: "feat/47-task", base: "main", model: null, merged: true };
    const stage = f.milestone("GitHub · 0 · Проект");
    f.issueMilestones[46] = stage.id;
    const r = task(f, ["actualize", "47"]);
    expect(r.code).toBe(0);
    expect(f.closedMilestones).toEqual([stage.number]);
    expect(r.out.split("\n").at(-1)).toBe("○ refresh not needed: epic #45 has no open tasks besides #47. Next: task close 47 — after the deploy, where the merge deploys.");
    expect(task(f, ["actualize", "47", "--assignment"]).out).toBe("○ refresh not needed: epic #45 has no open tasks besides #47. Next: task close 47 — after the deploy, where the merge deploys.");
  });

  it("задачи эпика в задании — его подзадачи (sub-issues): список задач в описании эпика туда не попадает", () => {
    const f = new FakeGitHub(REC);
    f.issue(45).body = "## План\n\n- #48 «GitHub · Старая задача из плана»\n- #49 «GitHub · Задача без эпика»";
    const r = task(f, ["actualize", "46", "--assignment"]);
    expect(r.out).toContain("### #47 «GitHub · Задача одной командой — github task»");
    expect(r.out).not.toContain("### #48");
    expect(r.out).not.toContain("### #49");
  });

  it("новая открытая подзадача эпика попадает в задание", () => {
    const f = new FakeGitHub(REC);
    subtask(f, "Экспорт счетов");
    const r = task(f, ["actualize", "47", "--assignment"]);
    expect(r.out).toContain("### #561 «GitHub · Экспорт счетов»");
    expect(r.out).not.toContain("### #47 ");
  });

  /** Строка задания сразу под заголовком открытой задачи эпика. */
  const underHeading = (out: string, heading: string) => {
    const lines = out.split("\n");
    expect(lines).toContain(heading);
    return lines[lines.indexOf(heading) + 1];
  };

  /**
   * Диспетчер эпика, 19.10.2026 (#636): проверка 5 после почти каждой закрытой задачи заводила новую задачу «Стандарт · …»
   * на следующий дубль рядом — семь задач по 0,5–1 ч за день, у каждой свой PR, CI, деплой и своя актуализация, которая
   * снова что-то находила. Находке того же рода есть место в открытой задаче эпика в Бэклоге: задание называет у открытых
   * задач, куда её дописать, а итог — куда она ушла.
   */
  it("находка-повтор дописывается в открытую задачу эпика того же рода в Бэклоге, а не заводит новую", () => {
    const f = new FakeGitHub(REC);
    merged46(f);
    f.status(47, "Бэклог");
    const before = f.mutations.length;
    const r = task(f, ["actualize", "46", "--assignment"]);
    expect(r.code).toBe(0);
    expect(underHeading(r.out, "### #47 «GitHub · Задача одной командой — github task»")).toBe(
      "Статус «Бэклог» — находку-повтор того же рода (тот же помощник, модуль или стандарт) дописать сюда пунктом в «Что сделать» (и сценарий, если нужен), новую задачу не заводить.",
    );
    // проверка 5 канона, которую задание цитирует: сначала открытая задача эпика того же рода в Бэклоге, затем — новая
    expect(CHECKS[4]!.replace(/\s+/g, " ")).toContain("First — an open task of the epic of the same kind (the same helper, module or standard) in Backlog: the finding is an item in its «What to do»");
    expect(r.out).toContain(CHECKS[4]!);
    // итог называет, куда ушла находка
    expect(r.out).toContain("что поправил, находку-повтор — с тем, куда она ушла: «дописано в #N» или «заведена #new1»;");
    expect(r.out.split("\n").at(-1)).toBe("Ответ — правки по строке с номерами задач (находка-повтор — «дописано в #N» или «заведена #M») и вопросы владельцу, если есть; иначе «Блок актуален».");
    expect(f.mutations.length).toBe(before);
  });

  it("задача того же рода в работе — находка заводит новую задачу", () => {
    const f = new FakeGitHub(REC);
    merged46(f);
    f.status(47, "В работе");
    // Бэклог, но PR уже открыт — задача тоже идёт
    const opened = subtask(f, "Экспорт счетов");
    f.prs[80] = { files: [], closes: [Number(opened)], head: `feat/${opened}-invoice-export`, base: "main", model: null };
    const r = task(f, ["actualize", "46", "--assignment"]);
    expect(r.code).toBe(0);
    expect(underHeading(r.out, "### #47 «GitHub · Задача одной командой — github task»")).toBe(
      "Статус «В работе» — задача уже идёт: находку-повтор того же рода сюда не дописывать, а завести новой задачей.",
    );
    expect(underHeading(r.out, `### #${opened} «GitHub · Экспорт счетов»`)).toBe("PR #80 открыт — задача уже идёт: находку-повтор того же рода сюда не дописывать, а завести новой задачей.");
    expect(CHECKS[4]!.replace(/\s+/g, " ")).toContain("one In progress or with an open PR is already going — a new task");
  });

  /**
   * Субагент обновления эпика — 27 ходов на обновление; в пяти проектах за две недели ≈ 1800 прямых вызовов `gh` (#669),
   * хотя задание уже содержит тексты эпика и его задач. Правки — одним файлом: `--apply` сверяет все до изменений,
   * применяет все или ни одной и сам пишет итог в эпик.
   */
  const refreshFile = (data: unknown) => {
    const file = path.join(scratch(), "refresh.json");
    writeFileSync(file, JSON.stringify(data));
    return file;
  };
  const BODY47 = "Задача.\n\nПосле #46 — сначала проект.\n\n## Что сделать\n\n- [ ] экспорт\n\n## Вопросы\n\n1. Формат?\n";

  it("actualize --apply применяет все правки файла и пишет комментарий в эпик", () => {
    const f = new FakeGitHub(REC);
    merged46(f);
    f.issue(47).body = BODY47;
    f.labelIssue(47, "вопросы");
    f.blockedBy[47] = [49];
    const extra = Number(subtask(f, "Лишняя"));
    const shipped = Number(subtask(f, "Уже сделана"));
    const file = refreshFile({
      report: "у #47 убрана копия связи, ответ на вопрос 1; заведена #new1",
      edits: [
        { task: 47, replace: "После #46 — сначала проект.\n\n", with: "" },
        { task: 47, add: "## Что сделать", item: "импорт" },
        { task: 47, check: "экспорт" },
        { task: 47, answer: 1, text: "CSV" },
        { task: 47, unblock: 49 },
        { task: extra, close: "not needed" },
        { task: shipped, close: "done" },
        { new: "Стандарт · одна выгрузка", branchType: "refactor" },
      ],
    });
    const r = task(f, ["actualize", "46", "--apply", file]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    // правки описания — по порядку, одной записью
    expect(byOp(f, "UpdateIssue").filter((m) => m.id === f.issue(47).id)).toEqual([
      { id: f.issue(47).id, body: "Задача.\n\n## Что сделать\n\n- [x] экспорт\n- [ ] импорт\n\n## Вопросы\n\n1. ✅ Формат? **Ответ:** CSV" },
    ]);
    expect(f.issue(47).labels.nodes).toEqual([]);
    expect(f.blockedBy[47]).toEqual([]);
    expect([f.issue(extra).state, f.issue(extra).stateReason]).toEqual(["CLOSED", "NOT_PLANNED"]);
    expect([f.issue(shipped).state, f.issue(shipped).stateReason]).toEqual(["CLOSED", "COMPLETED"]);
    const created = Number(/^Created #(\d+)/m.exec(r.out)![1]);
    expect(f.issue(created).parent).toEqual({ id: f.issue(45).id, number: 45 });
    // итог — комментарием в эпик, #new1 — номер заведённой задачи: по нему task close видит, что обновление закончено
    expect(byOp(f, "AddComment").at(-1)).toEqual({ subjectId: f.issue(45).id, body: `Актуализация после #46, итог: у #47 убрана копия связи, ответ на вопрос 1; заведена #${created}` });
    expect(r.out.split("\n").at(-1)).toBe(`+ epic #45: the refresh report — «у #47 убрана копия связи, ответ на вопрос 1; заведена #${created}»`);
    // без правок — только итог «блок актуален»
    const g = new FakeGitHub(REC);
    merged46(g);
    expect(task(g, ["actualize", "46", "--apply", refreshFile({ report: "блок актуален" })]).code).toBe(0);
    expect(g.mutations.map((m) => m.op)).toEqual(["AddComment"]);
  });

  it("actualize --apply с невыполнимой правкой ничего не меняет и называет её", () => {
    const f = new FakeGitHub(REC);
    merged46(f);
    f.issue(47).body = BODY47;
    f.closed(Number(subtask(f, "Закрытая")));
    const closed = f.mutations.length;
    const file = refreshFile({
      report: "заведена #new2",
      edits: [
        { task: 47, check: "экспорт" },
        { task: 47, replace: "XML-выгрузка", with: "JSON" },
        { task: 46, close: "done" },
        { task: 47, answer: 3, text: "CSV" },
        { task: 47, unblock: 49 },
        { task: 47, check: "импорт", close: "done" },
        { new: "Стандарт", branchType: "style" },
      ],
    });
    const r = task(f, ["actualize", "46", "--apply", file]);
    expect(r.code).toBe(2);
    expect(r.err).toBe(
      `error: --apply ${file}: nothing changed — ` +
        "edit 2: #47: --replace «XML-выгрузка» — not found in the description; " +
        "edit 3: #46 shipped — task close closes it; editable: #45, #47; " +
        "edit 4: #47: no question 3 in «## Вопросы»; questions: 1; " +
        "edit 5: #47 isn't blocked by #49; blocked by: none; " +
        "edit 6: expected one action of replace, add, check, answer, unblock, close, new, not check and close; " +
        "edit 7: «new» «Стандарт» — «branchType»: feat, fix, docs, refactor, perf, test, chore, ci, build, research; " +
        "report: #new2 — the file has 0 «new» edits",
    );
    expect(f.mutations.length).toBe(closed);
    // без итога файл не применяется: по нему task close видит конец обновления
    expect(task(f, ["actualize", "46", "--apply", refreshFile({ edits: [] })]).err).toContain("no «report»");
    expect(f.mutations.length).toBe(closed);
  });

  it("задание обновления содержит формат файла правок и всё о задачах эпика", () => {
    const f = new FakeGitHub(REC);
    merged46(f);
    f.issue(47).body = BODY47;
    const r = task(f, ["actualize", "46", "--assignment"]);
    expect(r.code).toBe(0);
    // применяет правки одна команда, gh субагенту не нужен: тексты задач — в задании, дифф — git log
    expect(r.out).toMatch(/и примени `bun --no-env-file \S+github\.ts task actualize 46 --apply <файл> --repo miroshnik\/elves`, вне песочницы/);
    expect(r.out).toContain("«report» — текст после «Актуализация после #46, итог:», в нём «#new1», «#new2» — номера новых задач. Пример:");
    const example = /~~~~json\n([\s\S]*?)\n~~~~/.exec(r.out)![1]!;
    const parsed = JSON.parse(example);
    expect(parsed.edits.map((e: Record<string, unknown>) => Object.keys(e).find((k) => k !== "task" && k !== "with" && k !== "item" && k !== "text" && k !== "branchType" && k !== "body"))).toEqual(["replace", "add", "check", "answer", "unblock", "close", "new"]);
    expect(parsed.edits[0].task).toBe(47);
    expect(r.out).toContain("~~~~markdown\n" + BODY47.trim() + "\n~~~~");
    expect(r.out).not.toMatch(/`gh \S/);
  });
});

/**
 * После мержа PR сессия делала ещё ≈21 ход на пиковом контексте — факт, статус, milestone, уборка ветки. `task close`
 * сворачивает это в один вызов; актуализацию блока до него делает субагент со свежим контекстом.
 */
describe("task close закрывает задачу одной командой", () => {
  const FACT = "Факт: 0.25 ч активных в Claude Code (оценка 0.25 ч, ×1.00). 1 сессия, 2 промпта, стена 0.3 ч, покрытие full. PR #77; 1 коммит, дифф 12 строк.";
  // est — подпроцесс (внешний край): в тестах подменяется, его вывод печатается как есть; снятие стеков task-env молчит,
  // git — настоящий
  const est =
    (calls: string[][], r: { status: number; stdout?: string; stderr?: string } = { status: 0, stdout: FACT + "\nкомментарий «Факт» создан\n" }) =>
    (cmd: string, args: string[], cwd?: string) =>
      cmd !== "bun"
        ? realRun(cmd, args, cwd)
        : isTaskEnv(args)
          ? { status: 0, stdout: "", stderr: "" }
          : (calls.push([cmd, ...args]), { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" });
  const mergedPr = (f: FakeGitHub, closes: number, head = `fix/${closes}-x`) => (f.prs[77] = { files: [], closes: [closes], head, base: "main", model: null, merged: true });

  it("PR задачи влит: задача закрыта, факт записан est, Status «Готово» — в выводе всё сделанное и следующий шаг", () => {
    const f = new FakeGitHub(REC);
    mergedPr(f, 49);
    const calls: string[][] = [];
    const r = task(f, ["close", "49", "--no-git"], REPO, { run: est(calls) });
    expect(r.code).toBe(0);
    expect(byOp(f, "CloseIssue")).toEqual([{ issueId: f.issue(49).id, stateReason: "COMPLETED" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(-5)).toEqual(["fact", "49", "--repo", REPO, "--write"]);
    expect(calls[0]!.slice(0, 2)).toEqual(["bun", "--no-env-file"]);
    expect(calls[0]![2]).toMatch(/skills\/est\/scripts\/est\.ts$/);
    expect(statusSet(f)).toEqual([[49, "Готово"]]);
    expect(r.out).toContain("+ #49 closed: PR #77 merged");
    expect(r.out).toContain(FACT);
    expect(r.out).toContain("+ #49: Status «Готово»");
    // у задачи нет эпика — актуализировать нечего, следующий шаг — конец сессии
    expect(r.out.split("\n").at(-1)).toStartWith("Next: the last line of the answer is one of three");
  });

  /** Итог актуализации эпика #45 после задачи — комментарий субагента к эпику. */
  const reported = (f: FakeGitHub, number: number, body = `Актуализация после #${number}, итог: блок актуален`) =>
    (f.comments[45] = [...(f.comments[45] ?? []), { body, url: `https://github.com/miroshnik/elves/issues/45#issuecomment-${number}` }]);

  /**
   * Актуализация блока идёт до `task close`, параллельно с деплоем, субагентом. Исполнитель диспетчера запустил её фоном,
   * не дождался, закрыл задачу и ответил (#571): следующий `task queue` убрал его worktree, а субагент работал в нём —
   * без каталога он не применил ни одной правки. Конец актуализации виден по её итогу — комментарию к эпику
   * «Актуализация после #N, итог: …»; комментарий механики скрипта пишется до субагента и итогом не считается.
   */
  it("актуализация эпика ещё не отчиталась — отказ с подсказкой дождаться", () => {
    const f = new FakeGitHub(REC);
    mergedPr(f, 46);
    reported(f, 46, "Актуализация после #46, скрипт: у #47 снят blocked by на выполненных #46.");
    // итог актуализации после другой задачи
    reported(f, 4);
    const calls: string[][] = [];
    const r = task(f, ["close", "46", "--no-git"], REPO, { run: est(calls) });
    expect(r.code).toBe(2);
    expect(r.err).toContain("#46 is too early to close: the epic refresh hasn't reported — epic #45 has open tasks besides #46 (1), and no comment «Актуализация после #46, итог: …» on it.");
    expect(r.err).toContain("The refresh subagent is at work — wait for its answer, then task close 46 again;");
    expect(f.mutations).toEqual([]);
    expect(calls).toEqual([]);
  });

  // без перегиба: итог на любом языке словаря и в разметке; «не нужна» — без эпика или без других открытых задач в нём
  it("итог актуализации в комментарии к эпику — задача закрыта, последняя строка — конец сессии", () => {
    const f = new FakeGitHub(REC);
    mergedPr(f, 46);
    reported(f, 46, "**Refresh after #46, result:** the block is current");
    const r = task(f, ["close", "46", "--no-git"], REPO, { run: est([]) });
    expect(r.code).toBe(0);
    expect(statusSet(f)).toEqual([[46, "Готово"]]);
    expect(r.out.split("\n").at(-1)).toStartWith("Next: the last line of the answer is one of three");
  });

  /**
   * Параллельных сессий много, и по хвосту каждой надо видеть, закончила она или чего-то ждёт. Подсказка приходит с
   * выводом `task close`: сессия на пиковом контексте, и канон от неё дальше всего. Исходов три: работа сделана, а
   * владельцу есть что решать — «Сессию можно закрывать» читалось бы как «решать нечего», и вопросы терялись.
   */
  it("последняя строка вывода называет три исхода конца сессии: всё сделано, всё сделано, но есть вопросы, осталось", () => {
    const f = new FakeGitHub(REC);
    mergedPr(f, 47);
    const last = task(f, ["close", "47", "--no-git"], REPO, { run: est([]) }).out.split("\n").at(-1)!;
    expect(last).toContain(
      "Next: the last line of the answer is one of three: «Всё сделано. Сессию можно закрывать.»; " +
        "the owner has something to decide — «Всё сделано, но есть вопросы: …» with the questions themselves, without «Всё сделано. Сессию можно закрывать.»; " +
        "something remains — «Осталось: …».",
    );
  });

  /**
   * В режиме auto сессия ведёт задачу целиком без спроса, и закрыть её — последний шаг, оставшийся человеку: после
   * строки «Всё сделано. Сессию можно закрывать.» сессия архивирует себя сама. Архивная сессия уходит из списка, и
   * вопросы в её последнем ответе владелец уже не прочтёт — после двух других строк архивации нет. Манифест команда
   * не читает — называет условие словами.
   */
  it("последняя строка вывода называет архивацию сессии в режиме auto — только после «Всё сделано. Сессию можно закрывать.»", () => {
    const f = new FakeGitHub(REC);
    mergedPr(f, 47);
    const last = task(f, ["close", "47", "--no-git"], REPO, { run: est([]) }).out.split("\n").at(-1)!;
    expect(last).toContain("In auto mode after «Всё сделано. Сессию можно закрывать.» — archive the session where the agent has the tool");
    expect(last).toContain("; after the other two lines — don't.");
  });

  /**
   * Живая фоновая задача сессии — ожидание, наблюдатель за его выводом, субагент — держит архивацию: «still has live
   * work», 24 отказа в 17 сессиях (#437). На строке «всё сделано» всё нужное уже завершилось, оставшееся — забытое;
   * его остановка сразу давала архивацию. Команда задач сессии не видит — называет шаг словами.
   */
  it("последняя строка вывода называет остановку своих фоновых задач перед архивацией в режиме auto", () => {
    const f = new FakeGitHub(REC);
    mergedPr(f, 47);
    const last = task(f, ["close", "47", "--no-git"], REPO, { run: est([]) }).out.split("\n").at(-1)!;
    expect(last).toContain(
      "archive the session where the agent has the tool, first stopping its own background tasks still running " +
        "(a wait, a watcher over its output, a subagent): a live one blocks archiving;",
    );
  });

  /**
   * «Есть вопросы» без вопроса — шум: наблюдение, срок, предупреждение владелец читает в отчёте, решать ему нечего.
   * Такая сессия заканчивает как обычно и в режиме auto архивирует себя.
   */
  it("последняя строка вывода не считает вопросом информацию без решения: строка и архивация — как у «всё сделано»", () => {
    const f = new FakeGitHub(REC);
    mergedPr(f, 47);
    const last = task(f, ["close", "47", "--no-git"], REPO, { run: est([]) }).out.split("\n").at(-1)!;
    expect(last).toContain("Information without a decision (an observation, a deadline, a warning) isn't a question: the line and archiving are as with «Всё сделано. Сессию можно закрывать.»");
  });

  it("PR открыт или закрыт без мержа — ошибка до изменений, ничего не тронуто", () => {
    const f = new FakeGitHub(REC);
    f.prs[78] = { files: [], closes: [49], head: "fix/49-x", model: null, merged: false, state: "OPEN" };
    const calls: string[][] = [];
    const r = task(f, ["close", "49", "--no-git"], REPO, { run: est(calls) });
    expect(r.code).toBe(2);
    expect(r.err).toContain("PR #78 open");
    expect(f.mutations).toEqual([]);
    expect(calls).toEqual([]);
  });

  // PR задачи, с которым GitHub её не связал: closedByPullRequestsReferences пуст, задача открыта
  const unlinkedPr = (f: FakeGitHub, pr: Partial<FakeGitHub["prs"][number]> = {}) => (f.prs[77] = { files: [], closes: [], head: "fix/49-x", base: "main", model: null, merged: true, ...pr });

  /**
   * GitHub бывает часами не связывает влитый PR с задачей по «Closes #N»: задача сама не закрывается, связи нет. PR
   * задачи тогда — среди последних PR основной ветки: по ветке `<type>/<N>-<slug>` или «Closes #N» в теле.
   */
  it("связи PR с задачей нет, влитый PR задачи найден по ветке — задача закрыта с комментарием о PR", () => {
    const f = new FakeGitHub(REC);
    unlinkedPr(f);
    const calls: string[][] = [];
    const r = task(f, ["close", "49", "--no-git"], REPO, { run: est(calls) });
    expect(r.code).toBe(0);
    expect(byOp(f, "AddComment")).toEqual([{ subjectId: f.issue(49).id, body: "Закрыта по PR #77: GitHub не связал PR с задачей" }]);
    expect(byOp(f, "CloseIssue")).toEqual([{ issueId: f.issue(49).id, stateReason: "COMPLETED" }]);
    expect(calls).toHaveLength(1);
    expect(statusSet(f)).toEqual([[49, "Готово"]]);
    expect(r.out).toContain("+ #49 closed by PR #77 (branch fix/49-x): GitHub didn't link the PR to the task");
  });

  it("связи нет, влитый PR с «Closes #N» в теле — задача закрыта по нему", () => {
    const f = new FakeGitHub(REC);
    unlinkedPr(f, { head: "export-invoices", body: "Экспорт счетов.\n\nCloses #49" });
    const r = task(f, ["close", "49", "--no-git"], REPO, { run: est([]) });
    expect(r.code).toBe(0);
    expect(byOp(f, "AddComment").map((c) => c.body)).toEqual(["Закрыта по PR #77: GitHub не связал PR с задачей"]);
    expect(r.out).toContain("+ #49 closed by PR #77 («Closes #49» in the body): GitHub didn't link the PR to the task");
  });

  it("связи нет и влитого PR задачи нет — отказ с перечнем проверенного", () => {
    const f = new FakeGitHub(REC);
    // чужие PR: ветка задачи с тем же хвостом номера, её «Closes», упоминание без ключевого слова, мерж не в основную ветку
    f.prs[70] = { files: [], closes: [], head: "fix/149-x", body: "Closes #149", model: null, merged: true };
    f.prs[71] = { files: [], closes: [], head: "docs/readme", body: "См. #49", model: null, merged: true };
    f.prs[72] = { files: [], closes: [], head: "fix/49-x", base: "release", model: null, merged: true };
    const calls: string[][] = [];
    const r = task(f, ["close", "49", "--no-git"], REPO, { run: est(calls) });
    expect(r.code).toBe(2);
    expect(r.err).toContain("#49 is too early to close: the task is open, no merged PR");
    expect(r.err).toContain("checked: the PR–task link, the branch <type>/49-<slug> and «Closes #49» in the body of the last 50 PRs into main");
    expect(f.mutations).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("связи нет, PR задачи по ветке открыт — отказ, ничего не тронуто", () => {
    const f = new FakeGitHub(REC);
    unlinkedPr(f, { merged: false, state: "OPEN" });
    const r = task(f, ["close", "49", "--no-git"], REPO, { run: est([]) });
    expect(r.code).toBe(2);
    expect(r.err).toContain("#49 is too early to close: PR #77 open");
    // без перегиба: у задачи есть PR — закрывать issue руками она не велит
    expect(r.err).not.toContain("gh issue close");
    expect(f.mutations).toEqual([]);
  });

  // исполнитель задачи без PR не знал, что `task close` ждёт закрытой задачи, и ждал сам (#628)
  it("task close задачи без PR и с открытым issue подсказывает закрыть issue", () => {
    const f = new FakeGitHub(REC);
    const calls: string[][] = [];
    const r = task(f, ["close", "49", "--no-git"], REPO, { run: est(calls) });
    expect(r.code).toBe(2);
    expect(r.err).toContain("#49 is too early to close: the task is open, no merged PR");
    expect(r.err).toContain(
      `a task without a PR (a data edit, a reconciliation, research) — close the issue as completed with a result comment: gh issue close 49 --repo ${REPO} --reason completed --comment "<result>", then task close 49 again`,
    );
    expect(f.mutations).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("задача закрыта без PR — факт и «Готово», задачу повторно не закрывает", () => {
    const f = new FakeGitHub(REC);
    f.closed(49);
    const calls: string[][] = [];
    const r = task(f, ["close", "49", "--no-git"], REPO, { run: est(calls) });
    expect(r.code).toBe(0);
    expect(byOp(f, "CloseIssue")).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(statusSet(f)).toEqual([[49, "Готово"]]);
  });

  it("est не установлен рядом — «actual unavailable: est is not installed», остальное сделано", () => {
    const f = new FakeGitHub(REC);
    mergedPr(f, 49);
    const calls: string[][] = [];
    const r = task(f, ["close", "49", "--no-git"], REPO, { run: est(calls), env: { ELVES_EST: "/nowhere/est.ts" } });
    expect(r.code).toBe(0);
    expect(calls).toEqual([]);
    expect(r.out).toContain("○ actual unavailable: est is not installed");
    expect(statusSet(f)).toEqual([[49, "Готово"]]);
  });

  it("est упал — его ошибка строкой «!», остальное сделано", () => {
    const f = new FakeGitHub(REC);
    mergedPr(f, 49);
    const r = task(f, ["close", "49", "--no-git"], REPO, { run: est([], { status: 1, stderr: "EstError: the repository has no paths in the registry\n" }) });
    expect(r.code).toBe(0);
    expect(r.out).toContain("! est fact: EstError: the repository has no paths in the registry");
    expect(statusSet(f)).toEqual([[49, "Готово"]]);
  });

  it("последняя подзадача — эпик закрыт и в «Готово»", () => {
    const f = new FakeGitHub(REC);
    mergedPr(f, 47);
    const r = task(f, ["close", "47", "--no-git"], REPO, { run: est([]) });
    expect(byOp(f, "CloseIssue").map((m) => m.issueId)).toEqual([f.issue(47).id, f.issue(45).id]);
    expect(statusSet(f)).toEqual([[47, "Готово"], [45, "Готово"]]);
    expect(r.out).toContain("+ epic #45 closed and in «Готово»: all subtasks are closed");
  });

  it("есть открытые подзадачи — эпик не трогается", () => {
    const f = new FakeGitHub(REC);
    mergedPr(f, 46);
    reported(f, 46);
    const r = task(f, ["close", "46", "--no-git"], REPO, { run: est([]) });
    expect(byOp(f, "CloseIssue")).toEqual([]);
    expect(statusSet(f)).toEqual([[46, "Готово"]]);
    expect(r.out).toContain("○ epic #45: open subtasks 1");
  });

  it("последняя открытая задача milestone — milestone закрыт", () => {
    const f = new FakeGitHub(REC);
    const m = f.milestone("Релиз 2026-10");
    f.issueMilestones[49] = m.id;
    mergedPr(f, 49);
    const r = task(f, ["close", "49", "--no-git"], REPO, { run: est([]) });
    expect(f.closedMilestones).toEqual([m.number]);
    expect(r.out).toContain("+ milestone «Релиз 2026-10» closed: no open tasks left");
  });

  it("в milestone остались открытые задачи — не закрыт", () => {
    const f = new FakeGitHub(REC);
    const m = f.milestone("Релиз 2026-10");
    f.issueMilestones[49] = m.id;
    f.issueMilestones[42] = m.id;
    mergedPr(f, 49);
    const r = task(f, ["close", "49", "--no-git"], REPO, { run: est([]) });
    expect(f.closedMilestones).toEqual([]);
    expect(r.out).toContain("○ milestone «Релиз 2026-10»: open tasks 1");
  });

  it("облачная сессия — объяснение со ссылкой на docs/cloud-sessions.md, код 2, без мутаций", () => {
    const f = new FakeGitHub(REC);
    mergedPr(f, 49);
    const r = task(f, ["close", "49"], REPO, { env: { CLAUDE_CODE_REMOTE: "true" } });
    expect(r.code).toBe(2);
    expect(r.err).toContain("docs/cloud-sessions.md");
    expect(r.err).toContain("est fact 49");
    expect(f.mutations).toEqual([]);
  });
});

// репозиторий задачи: bare origin с путём вида …/<slug>.git — для скрипта репозиторий GitHub slug, чекаут на ветке задачи;
// before — ветки, влитые в main до неё (первый PR задачи, когда чекаут — на ветке доправки)
function checkout(branch: string, { merged = true, slug = REPO, before = [] as string[] } = {}) {
  const { dir, cleanup } = tmpDir();
  const origin = path.join(dir, `${slug}.git`);
  mkdirSync(path.dirname(origin), { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const work = path.join(dir, "work");
  mkdirSync(work);
  const repo = gitRepo(work);
  // чекаут Elves: язык проекта — русский, как у записанного проекта GitHub
  repo.commit({ "README.md": "x\n", ".agents/elves.json": '{ "language": "ru" }\n' }, "init");
  repo.git("remote", "add", "origin", origin);
  repo.git("push", "-q", "-u", "origin", "main");
  for (const b of before) {
    repo.git("switch", "-q", "-c", b);
    repo.commit({ [`${b.replace(/\W/g, "-")}.txt`]: "b\n" }, b);
    repo.git("push", "-q", "-u", "origin", b);
    repo.git("switch", "-q", "main");
    repo.git("-c", "user.email=spec@example.test", "-c", "user.name=spec", "merge", "-q", "--no-ff", "-m", `merge ${b}`, b);
    repo.git("push", "-q", "origin", "main");
  }
  repo.git("switch", "-q", "-c", branch);
  repo.commit({ "a.txt": "a\n" }, "work");
  repo.git("push", "-q", "-u", "origin", branch);
  if (merged) {
    repo.git("switch", "-q", "main");
    repo.git("-c", "user.email=spec@example.test", "-c", "user.name=spec", "merge", "-q", "--no-ff", "-m", "merge", branch);
    repo.git("push", "-q", "origin", "main");
    repo.git("switch", "-q", branch);
  }
  return { work, origin, cleanup };
}
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
// git — настоящий во временном репозитории, его origin — репозиторий GitHub; est — подменён
const noEst = githubOrigin((cmd: string, args: string[], cwd?: string) =>
  cmd !== "bun" ? realRun(cmd, args, cwd) : { status: 0, stdout: isTaskEnv(args) ? "" : "Факт: …\n", stderr: "" },
);

/** Влитое убирается по правилу «влитое удаляю целиком» (скилл github, «Git, PRs and merging — mechanics»): чекаут — на origin/main, ветка — долой локально и на хостинге. */
describe("task close убирает влитое", () => {
  it("чекаут на ветке задачи, PR влит: после close — detach на origin/main, локальной и удалённой ветки нет", () => {
    const { work, origin, cleanup } = checkout("fix/49-x");
    try {
      const f = new FakeGitHub(REC);
      f.prs[77] = { files: [], closes: [49], head: "fix/49-x", base: "main", model: null, merged: true };
      const r = task(f, ["close", "49"], REPO, { run: noEst, cwd: work });
      expect(r.code).toBe(0);
      expect(git(work, "branch", "--show-current")).toBe("");
      expect(git(work, "rev-parse", "HEAD")).toBe(git(work, "rev-parse", "origin/main"));
      expect(git(work, "branch", "--list", "fix/49-x")).toBe("");
      expect(git(origin, "branch", "--list", "fix/49-x")).toBe("");
      expect(r.out).toContain("+ checkout — on origin/main (detached)");
      expect(r.out).toContain("+ local branch fix/49-x deleted");
      expect(r.out).toContain("+ remote branch fix/49-x deleted");
    } finally {
      cleanup();
    }
  });

  it("связи PR с задачей нет, влитый PR найден по ветке — ветка убрана", () => {
    const { work, origin, cleanup } = checkout("fix/49-x");
    try {
      const f = new FakeGitHub(REC);
      f.prs[77] = { files: [], closes: [], head: "fix/49-x", base: "main", model: null, merged: true };
      const r = task(f, ["close", "49"], REPO, { run: noEst, cwd: work });
      expect(r.code).toBe(0);
      expect(git(work, "branch", "--list", "fix/49-x")).toBe("");
      expect(git(origin, "branch", "--list", "fix/49-x")).toBe("");
      expect(r.out).toContain("+ remote branch fix/49-x deleted");
    } finally {
      cleanup();
    }
  });

  /**
   * Задача — один PR, а доправка к влитому PR — та же задача (канон): у задачи бывает два влитых PR. Доправку GitHub с
   * задачей не связывает — в её коммитах и теле «Refs #N», а не «Closes» — и close убирал одну ветку: ветку чекаута
   * (доправки), а ветку первого PR — ни локальную, ни удалённую (#435).
   */
  it("у задачи два влитых PR — task close удаляет обе их ветки, локальные и удалённые", () => {
    const { work, origin, cleanup } = checkout("docs/49-y", { before: ["feat/49-x"] });
    try {
      const f = new FakeGitHub(REC);
      f.prs[77] = { files: [], closes: [49], head: "feat/49-x", base: "main", model: null, merged: true };
      f.prs[78] = { files: [], closes: [], head: "docs/49-y", base: "main", body: "Refs #49", model: null, merged: true };
      const r = task(f, ["close", "49"], REPO, { run: noEst, cwd: work });
      expect(r.code).toBe(0);
      expect(git(work, "branch", "--show-current")).toBe("");
      expect(git(work, "rev-parse", "HEAD")).toBe(git(work, "rev-parse", "origin/main"));
      for (const b of ["feat/49-x", "docs/49-y"]) {
        expect(git(work, "branch", "--list", b)).toBe("");
        expect(git(origin, "branch", "--list", b)).toBe("");
        expect(r.out).toContain(`+ local branch ${b} deleted`);
        expect(r.out).toContain(`+ remote branch ${b} deleted`);
      }
    } finally {
      cleanup();
    }
  });

  /** «Влита» — по PR или `git cherry` (скилл github): ветка чекаута без влитого PR не убирается из-за чужого влитого PR. */
  it("ветка чекаута — задачи, но без влитого PR и не влита — не тронута, ветка влитого PR задачи убрана", () => {
    const { work, origin, cleanup } = checkout("fix/49-y", { merged: false, before: ["feat/49-x"] });
    try {
      const f = new FakeGitHub(REC);
      f.prs[77] = { files: [], closes: [49], head: "feat/49-x", base: "main", model: null, merged: true };
      const r = task(f, ["close", "49"], REPO, { run: noEst, cwd: work });
      expect(r.code).toBe(0);
      expect(r.out).toContain("○ branch fix/49-y is not merged into origin/main — left alone");
      expect(git(work, "branch", "--show-current")).toBe("fix/49-y");
      expect(git(origin, "branch", "--list", "fix/49-y")).toContain("fix/49-y");
      expect(git(work, "branch", "--list", "feat/49-x")).toBe("");
      expect(git(origin, "branch", "--list", "feat/49-x")).toBe("");
    } finally {
      cleanup();
    }
  });

  it("ветка не влита — не тронута, строка ○", () => {
    const { work, origin, cleanup } = checkout("fix/49-x", { merged: false });
    try {
      const f = new FakeGitHub(REC);
      f.closed(49);
      const r = task(f, ["close", "49"], REPO, { run: noEst, cwd: work });
      expect(r.code).toBe(0);
      expect(r.out).toContain("○ branch fix/49-x is not merged into origin/main — left alone");
      expect(git(work, "branch", "--show-current")).toBe("fix/49-x");
      expect(git(origin, "branch", "--list", "fix/49-x")).toContain("fix/49-x");
    } finally {
      cleanup();
    }
  });

  /** Имя проекта стеков — из `origin` чекаута (task-env): из чужого чекаута сняли бы стеки другого проекта. */
  it("текущий каталог — не чекаут репозитория задачи: ветки и стеки задачи не трогаются", () => {
    const { dir, cleanup } = tmpDir();
    try {
      writeTree(dir, { ".agents/elves.json": '{ "language": "ru" }\n' });
      const f = new FakeGitHub(REC);
      f.prs[77] = { files: [], closes: [49], head: "fix/49-x", base: "main", model: null, merged: true };
      const calls: string[][] = [];
      const run = (cmd: string, args: string[], cwd?: string) => (isTaskEnv(args) && calls.push(args), noEst(cmd, args, cwd));
      const r = task(f, ["close", "49"], REPO, { run, cwd: dir });
      expect(r.code).toBe(0);
      expect(r.out).toContain("○ branches and task stacks left alone: the current directory is not a checkout of miroshnik/elves");
      expect(calls).toEqual([]);
    } finally {
      cleanup();
    }
  });

  /** Чекаут узнаётся равенством owner/repo из origin (стандарт origin-repo), не подстрокой URL. */
  it("task close из чекаута репозитория с тем же префиксом имени (elves-tools при elves) — не чекаут задачи: ни стеки, ни ветки не трогаются", () => {
    const { work, origin, cleanup } = checkout("fix/49-x", { slug: "miroshnik/elves-tools" });
    try {
      const f = new FakeGitHub(REC);
      f.prs[77] = { files: [], closes: [49], head: "fix/49-x", base: "main", model: null, merged: true };
      const calls: string[][] = [];
      const run = (cmd: string, args: string[], cwd?: string) => (isTaskEnv(args) && calls.push(args), noEst(cmd, args, cwd));
      const r = task(f, ["close", "49"], REPO, { run, cwd: work });
      expect(r.code).toBe(0);
      expect(r.out).toContain("○ branches and task stacks left alone: the current directory is not a checkout of miroshnik/elves");
      expect(calls).toEqual([]);
      expect(git(work, "branch", "--show-current")).toBe("fix/49-x");
      expect(git(origin, "branch", "--list", "fix/49-x")).toContain("fix/49-x");
    } finally {
      cleanup();
    }
  });

  it("регистр owner/repo в origin не важен: из чекаута Miroshnik/Elves task close убирает ветку и снимает стеки задачи", () => {
    const { work, origin, cleanup } = checkout("fix/49-x", { slug: "Miroshnik/Elves" });
    try {
      const f = new FakeGitHub(REC);
      f.prs[77] = { files: [], closes: [49], head: "fix/49-x", base: "main", model: null, merged: true };
      const calls: string[][] = [];
      const run = (cmd: string, args: string[], cwd?: string) => (isTaskEnv(args) && calls.push(taskEnvArgs(args)), noEst(cmd, args, cwd));
      const r = task(f, ["close", "49"], REPO, { run, cwd: work });
      expect(r.code).toBe(0);
      expect(calls).toEqual([["--no-env-file", "down", "49"]]);
      expect(git(work, "branch", "--list", "fix/49-x")).toBe("");
      expect(git(origin, "branch", "--list", "fix/49-x")).toBe("");
    } finally {
      cleanup();
    }
  });

  /**
   * Исполнитель диспетчера работает в worktree агента и убрать его сам не может — он в нём. Подсказка «убери worktree из
   * основного чекаута» становилась просьбой к диспетчеру в конце ответа — у 16 исполнителей из 16 в пилоте #471: worktree
   * агента убирает следующий `task queue` диспетчера (#515), worktree сессии — по-прежнему подсказкой.
   */
  it("task close в worktree агента не просит убрать его руками — его уберёт следующий task queue диспетчера", () => {
    const closeIn = (name: string) => {
      const { work, cleanup } = checkout("fix/49-x");
      temp.push(cleanup);
      git(work, "switch", "-q", "main");
      const dir = path.join(realpathSync(work), ".claude/worktrees", name);
      git(work, "worktree", "add", "-q", dir, "fix/49-x");
      const f = new FakeGitHub(REC);
      f.prs[77] = { files: [], closes: [49], head: "fix/49-x", base: "main", model: null, merged: true };
      return { dir, out: task(f, ["close", "49"], REPO, { run: noEst, cwd: dir }).out.split("\n") };
    };
    const agent = closeIn("agent-a0008f7e219bfb5c5");
    expect(agent.out).toContain(`○ agent worktree ${agent.dir}: the dispatcher's next task queue removes it`);
    expect(agent.out.filter((l) => l.startsWith("Next: remove worktree"))).toEqual([]);
    const session = closeIn("bold-raman-12428f");
    expect(session.out).toContain(`Next: remove worktree ${session.dir} from the main checkout: git worktree remove ${session.dir}`);
  });
});

/**
 * Стек задачи (скилл task-env, эпик #392) живёт, пока его не снимут: `task close` снимает стеки задачи — dev и e2e с
 * томами — командой `task-env down <N>` в чекауте задачи. Что снято и что нет, печатает task-env; ошибка снятия
 * закрытие не валит — стек, который не сняли, найдёт `task-env prune`.
 */
describe("task close снимает стеки задачи", () => {
  type Answer = { status: number; stdout?: string; stderr?: string };
  /** task-env — подпроцесс bun (внешний край): ответ подменён, вызовы записаны; git — настоящий, est — молчит. */
  const taskEnv = (calls: { args: string[]; cwd?: string }[], r: Answer) => (cmd: string, args: string[], cwd?: string) =>
    cmd === "bun" && isTaskEnv(args) ? (calls.push({ args: taskEnvArgs(args), cwd }), { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }) : noEst(cmd, args, cwd);
  const DOWN = "+ stack elves-49: down, with its volumes\n+ stack elves-49-e2e: down, with its volumes\n";
  const merged = (f: FakeGitHub) => (f.prs[77] = { files: [], closes: [49], head: "fix/49-x", base: "main", model: null, merged: true });

  function close(args: string[], answer: Answer, env: Record<string, string> = {}) {
    const { work, cleanup } = checkout("fix/49-x");
    temp.push(cleanup);
    const f = new FakeGitHub(REC);
    merged(f);
    const calls: { args: string[]; cwd?: string }[] = [];
    const r = task(f, ["close", "49", ...args], REPO, { run: taskEnv(calls, answer), cwd: work, env });
    return { ...r, f, work, calls };
  }

  it("task close снимает стеки закрытой задачи вместе с томами — командой task-env down <N> в чекауте задачи", () => {
    const r = close([], { status: 0, stdout: DOWN });
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([{ args: ["--no-env-file", "down", "49"], cwd: r.work }]);
    expect(r.out).toContain(DOWN.trimEnd());
    expect(statusSet(r.f)).toEqual([[49, "Готово"]]);
  });

  it("ошибка снятия выводится строкой и не мешает закрытию задачи", () => {
    const failed = "! stack elves-49: not removed — permission denied while trying to connect to the docker API";
    const reported = close([], { status: 2, stdout: failed + "\n" });
    expect(reported.code).toBe(0);
    expect(reported.out).toContain(failed);
    expect(statusSet(reported.f)).toEqual([[49, "Готово"]]);
    expect(reported.out).toContain("+ local branch fix/49-x deleted");
    // task-env упал, ничего не сказав в stdout, — его ошибка строкой «!»
    const crashed = close([], { status: 1, stderr: "error: Cannot find module 'node:fs'\n" });
    expect(crashed.code).toBe(0);
    expect(crashed.out).toContain("! task-env down: error: Cannot find module 'node:fs'");
    expect(statusSet(crashed.f)).toEqual([[49, "Готово"]]);
  });

  it("--no-git стеки снимает: флаг — про ветки", () => {
    const r = close(["--no-git"], { status: 0, stdout: DOWN });
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([{ args: ["--no-env-file", "down", "49"], cwd: r.work }]);
    expect(git(r.work, "branch", "--show-current")).toBe("fix/49-x");
  });

  it("task-env не установлен рядом — строка ○, остальное сделано", () => {
    const r = close([], { status: 0, stdout: DOWN }, { ELVES_TASK_ENV: "/nowhere/task-env.ts" });
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.out).toContain("○ task stacks: task-env is not installed (/nowhere/task-env.ts)");
    expect(statusSet(r.f)).toEqual([[49, "Готово"]]);
  });
});

/**
 * Исполнители сессии-диспетчера зовут скрипты из клона машины, а клон за сессию никто не обновляет: исправления `est`,
 * влитые ранними исполнителями, поздние не получали — `task close` считал факт старым `est`, и его переписывали руками
 * (#517). Влитый PR меняет скрипты только у самого Elves — клон подтягивается перед фактом только у задачи репозитория
 * скриптов, и только перемоткой: другая ветка или правка в клоне — чья-то работа.
 */
describe("task close подтягивает клон скриптов до влитого main перед фактом", () => {
  const EST = "skills/est/scripts/est.ts";
  // клон скриптов машины: чекаут на main, est — рядом со скриптом; в origin уже влит PR с новым est
  function machineClone(slug = REPO) {
    const dir = scratch();
    const origin = path.join(dir, `${slug}.git`);
    mkdirSync(path.dirname(origin), { recursive: true });
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    const clone = path.join(dir, "clone");
    mkdirSync(clone);
    const repo = gitRepo(clone);
    repo.commit({ [EST]: "est до PR\n", "README.md": "x\n" }, "init");
    repo.git("remote", "add", "origin", origin);
    repo.git("push", "-q", "-u", "origin", "main");
    const other = path.join(dir, "other");
    execFileSync("git", ["clone", "-q", origin, other]);
    gitRepo(other, { init: false }).commit({ [EST]: "est из влитого PR\n" }, "fix(est)");
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: other });
    // путь клона — как его называет git: без симлинков временного каталога (/var → /private/var на macOS)
    return { clone: realpathSync(clone), repo, head: () => repo.git("rev-parse", "--short", "HEAD"), merged: git(other, "rev-parse", "--short", "HEAD") };
  }
  // est — подпроцесс bun (внешний край): записывает код est, которым считается факт, — файл в момент вызова; git — настоящий
  function close(clone: string) {
    const codes: string[] = [];
    const run = githubOrigin((cmd: string, args: string[], cwd?: string) => {
      if (cmd !== "bun") return realRun(cmd, args, cwd);
      if (!isTaskEnv(args)) codes.push(readFileSync(args[1]!, "utf8").trim());
      return { status: 0, stdout: "", stderr: "" };
    });
    const f = new FakeGitHub(REC);
    f.prs[77] = { files: [], closes: [49], head: "fix/49-x", base: "main", model: null, merged: true };
    const r = task(f, ["close", "49", "--no-git"], REPO, { run, env: { ELVES_EST: path.join(clone, EST) } });
    return { ...r, codes, f };
  }

  it("task close задачи Elves считает факт кодом из влитого main, а не из отставшего клона", () => {
    const m = machineClone();
    const before = m.head();
    const r = close(m.clone);
    expect(r.code).toBe(0);
    expect(r.codes).toEqual(["est из влитого PR"]);
    expect(m.head()).toBe(m.merged);
    expect(r.out).toContain(`+ clone ${m.clone} ${before} → ${m.merged}`);
    expect(statusSet(r.f)).toEqual([[49, "Готово"]]);
  });

  it("клон уже на влитом main — строка =, ничего не меняется", () => {
    const m = machineClone();
    m.repo.git("pull", "-q", "--ff-only", "origin", "main");
    const r = close(m.clone);
    expect(r.codes).toEqual(["est из влитого PR"]);
    expect(r.out).toContain(`= clone ${m.clone} ${m.merged}`);
  });

  // в клоне живут worktree сессий (.claude/worktrees) — неотслеживаемые файлы перемотку не держат
  it("неотслеживаемые файлы в клоне перемотке не мешают", () => {
    const m = machineClone();
    writeTree(m.clone, { ".claude/worktrees/x/a.txt": "a\n" });
    const r = close(m.clone);
    expect(r.codes).toEqual(["est из влитого PR"]);
    expect(m.head()).toBe(m.merged);
  });

  it("клон не на main — не трогается, строка ○; факт — его кодом", () => {
    const m = machineClone();
    m.repo.git("switch", "-q", "-c", "feat/1-x");
    const before = m.head();
    const r = close(m.clone);
    expect(r.code).toBe(0);
    expect(r.codes).toEqual(["est до PR"]);
    expect(m.head()).toBe(before);
    expect(r.out).toContain(`○ clone ${m.clone} left alone: on branch feat/1-x, not main — the actual is by its code`);
  });

  it("в клоне правка отслеживаемого файла — не трогается, строка ○", () => {
    const m = machineClone();
    writeTree(m.clone, { "README.md": "правка\n" });
    const before = m.head();
    const r = close(m.clone);
    expect(r.codes).toEqual(["est до PR"]);
    expect(m.head()).toBe(before);
    expect(r.out).toContain(`○ clone ${m.clone} left alone: uncommitted changes — the actual is by its code`);
  });

  it("main клона разошёлся с origin — перемотки нет, строка ! с ошибкой git; факт и «Готово» — как обычно", () => {
    const m = machineClone();
    m.repo.commit({ "local.txt": "l\n" }, "local");
    const before = m.head();
    const r = close(m.clone);
    expect(r.code).toBe(0);
    expect(r.codes).toEqual(["est до PR"]);
    expect(m.head()).toBe(before);
    const line = r.out.split("\n").find((l) => l.startsWith(`! clone ${m.clone}: git pull --ff-only origin main: `));
    expect(line).toEndWith(" — the actual is by its code");
    expect(statusSet(r.f)).toEqual([[49, "Готово"]]);
  });

  it("клон — чекаут другого репозитория: влитый PR задачи скриптов не меняет — не трогается, без строки", () => {
    const m = machineClone("miroshnik/elves-tools");
    const before = m.head();
    const r = close(m.clone);
    expect(r.codes).toEqual(["est до PR"]);
    expect(m.head()).toBe(before);
    expect(r.out).not.toMatch(/^[+=○!] clone /m);
  });
});

/**
 * Фоновое ожидание (ci-wait) умирает с процессом приложения: при перезапуске четыре сессии потеряли ожидания в одну
 * минуту, и владелец 17 раз писал «продолжай» (#433). Хук SessionStart зовёт `task resume` в возобновлённой сессии:
 * закреплённая задача и её PR называют, какое ожидание перезапустить, — готовой командой, без хода на поиски.
 */
describe("task resume называет, какое ожидание перезапустить закреплённой задаче сессии", () => {
  const WAIT = path.resolve(import.meta.dir, "../../../skills/ci-wait/scripts/wait-ci.sh");
  const GITHUB = path.resolve(import.meta.dir, "../../../skills/github/scripts/github.ts");
  const pr = (f: FakeGitHub, p: Partial<FakeGitHub["prs"][number]>) => (f.prs[77] = { files: [], closes: [49], head: "feat/49-x", base: "main", model: null, ...p });
  /** Сессия с закреплённой задачей #49: `task status` её и закрепляет. */
  function pinnedSession(f: FakeGitHub) {
    const io = inSession(scratch());
    task(f, ["status", "49", "В работе"], REPO, io);
    f.mutations.length = 0;
    return io;
  }

  it("возобновлённая сессия с открытым PR задачи получает команду перезапустить ожидание его чеков", () => {
    const f = new FakeGitHub(REC);
    const io = pinnedSession(f);
    pr(f, { state: "OPEN" });
    const r = task(f, ["resume"], REPO, io);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`Session task miroshnik/elves#49: PR #77 is open — a background wait dies with the app's process; restart it as a background command: bash ${WAIT} pr 77`);
    expect(f.mutations).toEqual([]);
  });

  it("возобновлённая сессия с влитым PR и открытой задачей получает команду закрыть задачу", () => {
    const f = new FakeGitHub(REC);
    const io = pinnedSession(f);
    pr(f, { merged: true });
    const r = task(f, ["resume"], REPO, io);
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      `Session task miroshnik/elves#49: PR #77 is merged, the task is open — where the merge deploys, the deploy wait as a background command: bash ${WAIT} merged 77; then close the task: bun --no-env-file ${GITHUB} task close 49`,
    );
    expect(f.mutations).toEqual([]);
  });

  it("сессия без закреплённой задачи подсказки не получает — и в GitHub не ходит", () => {
    const f = new FakeGitHub(REC);
    let calls = 0;
    const gh = (args: string[], stdin?: string) => (calls++, f.gh(args, stdin));
    expect(task(f, ["resume"], REPO, { ...inSession(scratch()), gh })).toEqual({ code: 0, out: "", err: "" });
    expect(task(f, ["resume"], REPO, { gh })).toEqual({ code: 0, out: "", err: "" });
    expect(calls).toBe(0);
  });

  it("PR, который GitHub не связал с задачей, находится по ветке задачи", () => {
    const f = new FakeGitHub(REC);
    const io = pinnedSession(f);
    pr(f, { closes: [], state: "OPEN" });
    expect(task(f, ["resume"], REPO, io).out).toContain(`PR #77 is open — a background wait dies with the app's process; restart it as a background command: bash ${WAIT} pr 77`);
  });

  it("открытый PR — ожидание его чеков, даже если у задачи уже есть влитый", () => {
    const f = new FakeGitHub(REC);
    const io = pinnedSession(f);
    pr(f, { merged: true });
    f.prs[78] = { files: [], closes: [49], head: "fix/49-y", base: "main", model: null, state: "OPEN" };
    expect(task(f, ["resume"], REPO, io).out).toBe(`Session task miroshnik/elves#49: PR #78 is open — a background wait dies with the app's process; restart it as a background command: bash ${WAIT} pr 78`);
  });

  it("у задачи нет PR или она закрыта — ждать нечего, строка ○", () => {
    const f = new FakeGitHub(REC);
    const io = pinnedSession(f);
    expect(task(f, ["resume"], REPO, io)).toMatchObject({ code: 0, out: "○ session task miroshnik/elves#49: no PR — no wait to restart" });
    pr(f, { state: "CLOSED" });
    expect(task(f, ["resume"], REPO, io).out).toBe("○ session task miroshnik/elves#49: no PR — no wait to restart");
    f.closed(49);
    expect(task(f, ["resume"], REPO, io)).toMatchObject({ code: 0, out: "○ session task miroshnik/elves#49 is closed — no wait to restart" });
  });

  // как в est и дашборде: строка не по форме — не закрепление (tests/standards/scripts/session-pin); путь файла — человеку
  it("закрепление не по форме owner/repo#N — у сессии нет задачи: строка ○ с путём файла, код 0, без запросов", () => {
    const f = new FakeGitHub(REC);
    const config = scratch();
    mkdirSync(path.join(config, "sessions"), { recursive: true });
    writeFileSync(pinFile(config), "49\n");
    let calls = 0;
    const gh = (args: string[], stdin?: string) => (calls++, f.gh(args, stdin));
    const r = task(f, ["resume"], REPO, { ...inSession(config), gh });
    expect(r).toEqual({ code: 0, out: `○ the session pin ${pinFile(config)} — «49», not owner/repo#N: the session has no task`, err: "" });
    expect(calls).toBe(0);
  });
});

/**
 * Задачи — на языке проекта (`language` в `.agents/elves.json` чекаута, канон, «Language»): каркас описания, статусы,
 * тип, задание субагенту и комментарии пишутся названиями словаря `skills/github/locales/<язык>.json`, а разбирается
 * название любого его языка. Доска не на языке проекта (язык сменили без fix, скрипт позван из чекаута другого проекта)
 * — задача ведётся на языке доски: язык сверяет `project check`. Без манифеста язык неизвестен — команды, что пишут
 * имена, отказывают (ниже).
 */
describe("Задачи — на языке проекта из .agents/elves.json чекаута", () => {
  /** Чекаут проекта с манифестом (null — без манифеста). */
  function checkoutWith(manifest: string | null): string {
    const dir = scratch();
    mkdirSync(path.join(dir, ".git"));
    if (manifest !== null) {
      mkdirSync(path.join(dir, ".agents"));
      writeFileSync(path.join(dir, ".agents/elves.json"), manifest);
    }
    return dir;
  }
  const EN = '{ "language": "en" }\n';
  /** Доска проекта Elves на английском — как после project fix в проекте на en. */
  function englishBoard(f: FakeGitHub): FakeGitHub {
    const ru: Record<string, string> = { Бэклог: "Backlog", "В работе": "In progress", Готово: "Done" };
    for (const o of f.field("Status").options) o.name = ru[o.name];
    for (const it of f.items()) if (it.status) it.status = { name: ru[it.status.name] };
    return f;
  }

  it("проект на en: task new пишет раздел ## Questions, est его читает", () => {
    const f = englishBoard(new FakeGitHub(REC));
    const r = task(f, ["new", "--branch-type", "feat", "--title", "Export"], REPO, { cwd: checkoutWith(EN) });
    expect(r.code).toBe(0);
    const body: string = byOp(f, "CreateIssue")[0].body;
    expect(body).toBe("## Scenarios\n\n## Questions\n");
    expect(statusSet(f)).toEqual([[561, "Backlog"]]);
    expect(r.out).toContain("+ project «elves»: Status «Backlog»");
    // est находит раздел: ответ, дописанный в нём после оценки, в размер описания не идёт
    expect(descSize(`${body}1. ✅ Format? **Answer:** PDF.\n`)).toBe(descSize(`${body}1. Format?\n`));
  });

  it("проект на en: task answer пишет ответ «**Answer:**», est не считает его в размер описания", () => {
    const f = new FakeGitHub(REC);
    const body = "## Scenarios\n\n## Questions\n\n1. Format?\n";
    f.issue(47).body = body;
    expect(task(f, ["answer", "47", "1", "PDF."], REPO, { cwd: checkoutWith(EN) }).code).toBe(0);
    const answered: string = byOp(f, "UpdateIssue")[0].body;
    expect(answered).toBe("## Scenarios\n\n## Questions\n\n1. ✅ Format? **Answer:** PDF.\n");
    expect(descSize(answered)).toBe(descSize(body));
  });

  it("эпик без --body — каркас только с разделом вопросов: эпик без кода, сценариев у него нет", () => {
    const f = new FakeGitHub(REC);
    task(f, ["new", "--title", "Экспорт", "--type", "Эпик"]);
    expect(byOp(f, "CreateIssue")[0].body).toBe("## Вопросы\n");
  });

  it("тело дано — пишется как есть, без каркаса", () => {
    const f = new FakeGitHub(REC);
    task(f, ["new", "--branch-type", "feat", "--title", "Экспорт", "--body", "Что сделать"]);
    expect(byOp(f, "CreateIssue")[0].body).toBe("Что сделать");
  });

  it("тип и статус — название любого языка словаря: --type Epic и task status Done в проекте на русском", () => {
    const f = new FakeGitHub(REC);
    expect(task(f, ["new", "--title", "Экспорт", "--type", "Epic"]).out).toContain("+ label «epic» — the type in a personal account");
    task(f, ["status", "47", "Done"]);
    expect(statusSet(f).at(-1)).toEqual([47, "Готово"]);
  });

  it("доска на русском, а язык проекта en — сменили без project fix: задача ведётся на языке доски", () => {
    const f = new FakeGitHub(REC);
    const r = task(f, ["status", "47", "Done"], REPO, { cwd: checkoutWith(EN) });
    expect(r.code).toBe(0);
    expect(statusSet(f)).toEqual([[47, "Готово"]]);
  });

  it("задание субагенту в проекте на en начинается с «Task #N (epic #M)» — по нему est привязывает работу к задаче", () => {
    const f = englishBoard(new FakeGitHub(REC));
    f.prs[77] = { files: [], closes: [46], head: "feat/46-project-check", base: "main", model: null, merged: true };
    const prompt = task(f, ["actualize", "46"], REPO, { cwd: checkoutWith(EN) }).out.split("\n");
    expect(prompt.at(-2)).toBe("Task #46 (epic #45): epic refresh after the merge — bring the epic's open tasks in line with what shipped.");
    const lines = task(f, ["actualize", "46", "--assignment"], REPO, { cwd: checkoutWith(EN) }).out.split("\n");
    expect(lines[0]).toBe("Task #46 (epic #45): epic refresh after the merge — bring the epic's open tasks in line with what shipped.");
    expect(lines).toContain("## Epic #45 «GitHub · Скилл github: проект и задачи по канону одной командой»");
    expect(lines).toContain("Status «In progress» — the task is already going: a repeat finding of the same kind isn't appended here but filed as a new task.");
    expect(lines.at(-1)).toBe("Answer — fixes one per line with task numbers (a repeat finding — «appended to #N» or «filed #M») and questions to the owner, if any; otherwise «The block is current».");
  });

  it("проект на en: правки скрипта в комментарии к эпику — по-английски", () => {
    const f = englishBoard(new FakeGitHub(REC));
    f.prs[77] = { files: [], closes: [46], head: "feat/46-project-check", base: "main", model: null, merged: true };
    f.blockedBy[47] = [46];
    task(f, ["actualize", "46"], REPO, { cwd: checkoutWith(EN) });
    expect(byOp(f, "AddComment").map((c) => c.body)).toEqual(["Refresh after #46, script: #47: blocked by done #46 removed."]);
  });

  it("проект на en: комментарий о PR, с которым GitHub не связал задачу, — по-английски", () => {
    const f = englishBoard(new FakeGitHub(REC));
    f.prs[77] = { files: [], closes: [], head: "fix/49-x", base: "main", model: null, merged: true };
    const noEst = () => ({ status: 0, stdout: "Actual: …\n", stderr: "" });
    const r = task(f, ["close", "49", "--no-git"], REPO, { run: noEst, cwd: checkoutWith(EN) });
    expect(r.code).toBe(0);
    expect(byOp(f, "AddComment").map((c) => c.body)).toEqual(["Closed by PR #77: GitHub didn't link the PR to the task"]);
    expect(statusSet(f)).toEqual([[49, "Done"]]);
    expect(r.out.split("\n").at(-1)).toContain("«All done. The session can be closed.»");
  });
});

/**
 * Без манифеста `.agents/elves.json` язык проекта неизвестен (#681, вопрос 1): команды, что пишут имена канона в GitHub
 * или сверяют с ними проект, отказывают кодом 2 до первого запроса — иначе задача проекта на ru получала бы английские
 * разделы, статусы и комментарии, метка решения — английский маркер, PR выпуска — английский заголовок. Чтение
 * разбирает имена любого языка словаря и идёт, как прежде.
 */
describe("Без манифеста команды, что пишут имена в GitHub, отказывают до первого запроса", () => {
  /** Чекаут без манифеста — свежий worktree проекта, чей `.agents/` не в git. */
  function bare(): string {
    const dir = scratch();
    mkdirSync(path.join(dir, ".git"));
    return dir;
  }

  it("task new без манифеста — отказ до создания задачи", () => {
    const f = new FakeGitHub(REC);
    let calls = 0;
    const gh = (args: string[], stdin?: string) => (calls++, f.gh(args, stdin));
    const dir = bare();
    const r = task(f, ["new", "--branch-type", "feat", "--title", "Экспорт"], REPO, { cwd: dir, gh });
    expect(r.code).toBe(2);
    expect(r.err).toStartWith(`task new writes or checks the canon's names in the project language — no .agents/elves.json in ${dir} — the project language is unknown`);
    expect(byOp(f, "CreateIssue")).toEqual([]);
    expect(calls).toBe(0);
  });

  it("каждая команда, что пишет имена канона или сверяет с ними проект, без манифеста — код 2 до первого запроса к GitHub", () => {
    const commands = [
      ["project", "check"],
      ["project", "fix", "--confirm"],
      ["task", "new", "--title", "Экспорт"],
      ["task", "answer", "47", "1", "PDF."],
      ["task", "status", "47", "Готово"],
      ["task", "actualize", "46"],
      ["task", "close", "49"],
      ["pr", "labels", "77"],
      ["batch", "release", "batch/2026-10-22-1"],
    ];
    const refused = commands.map((args) => {
      const f = new FakeGitHub(REC);
      const err: string[] = [];
      let calls = 0;
      const gh = (a: string[], stdin?: string) => (calls++, f.gh(a, stdin));
      const code = main([...args, "--repo", REPO], { gh, out: () => {}, err: (l) => err.push(l), env: {}, run: silentEst, cwd: bare() });
      return { command: args.slice(0, 2).join(" "), code, calls, refusal: err.join("\n").startsWith(`${args.slice(0, 2).join(" ")} writes or checks the canon's names`) };
    });
    expect(refused).toEqual(commands.map((args) => ({ command: args.slice(0, 2).join(" "), code: 2, calls: 0, refusal: true })));
  });

  it("чтение без манифеста — как прежде: task show разбирает имена любого языка", () => {
    const f = new FakeGitHub(REC);
    const r = task(f, ["show", "47"], REPO, { cwd: bare() });
    expect(r.code).toBe(0);
    expect(r.out).toStartWith("#47 ");
  });
});

/**
 * Сессия-диспетчер берёт не задачу, а очередь: «сделай все задачи эпика», «поправь все баги High». Готовые задачи уходят
 * фоновым исполнителям-субагентам по K сразу, после каждого ответа очередь читается заново — так подхватываются новые.
 */
describe("task queue раздаёт задачи эпика или фильтра исполнителям", () => {
  const created = (r: { out: string }) => Number(/^Created #(\d+)/.exec(r.out)![1]);
  const subtask = (f: FakeGitHub, repo: string, title: string, ...more: string[]) => created(task(f, ["new", "--branch-type", "feat", "--title", title, "--epic", "45", ...more], repo));
  /** Строки вывода без промптов исполнителей (у них отступ). */
  const heads = (out: string) => out.split("\n").filter((l) => !l.startsWith("  "));
  /**
   * Сессия диспетчера: без id сессии скрипт не пометил бы её диспетчером и сказал бы об этом строкой ○. Каталог — не
   * чекаут: в чекауте очередь убирает worktree агентов, а тест не трогает worktree репозитория, где его запустили.
   */
  const dispatcherIo = (config = scratch(), id = SESSION): Partial<Io> => ({ ...inSession(config, id), cwd: projectDir() });
  const queue = (f: FakeGitHub, args: string[], repo = REPO) => task(f, ["queue", ...args], repo, dispatcherIo());

  it("готовые задачи эпика — по Priority, затем по номеру, у каждой — промпт исполнителя «Задача #N»", () => {
    const f = new FakeGitHub(asOrg(REC));
    f.status(47, "Бэклог");
    f.setPriority(47, "High");
    const low = subtask(f, ORG, "Низкая", "--priority", "Low");
    const urgent = subtask(f, ORG, "Срочная", "--priority", "Urgent");
    const medium = subtask(f, ORG, "Обычная");
    const r = queue(f, ["--epic", "45"], ORG);
    expect(r.code).toBe(0);
    const lines = r.out.split("\n");
    expect(lines[0]).toBe("Queue acme/elves (epic #45): ready 4, «В работе» 0, not ready 0");
    expect(lines.filter((l) => l.startsWith("+ ")).map((l) => Number(/^\+ #(\d+)/.exec(l)![1]))).toEqual([urgent, 47, medium, low]);
    expect(lines[1]).toBe(`+ #${urgent} «GitHub · Срочная» (Urgent)`);
    expect(lines[2]).toStartWith(`  Задача #${urgent} в acme/elves (эпик #45): ты исполнитель сессии-диспетчера. Задание целиком печатает \`bun --no-env-file `);
    expect(lines[2]).toContain(`task queue --assignment ${urgent} --repo acme/elves\``);
    expect(lines.at(-1)).toStartWith("Next: each ready task above — a background subagent in its own worktree while fewer than 3 run");
  });

  it("не готовые — строкой ○ с причиной: blocked by открытой задачей, эпик; «В работе» — отдельной строкой", () => {
    const f = new FakeGitHub(REC);
    f.status(42, "Бэклог");
    f.status(47, "В работе");
    f.status(49, "Готово");
    const blocked = subtask(f, REPO, "Заблокирована", "--blocked-by", "47");
    const ready = subtask(f, REPO, "Готова");
    const r = queue(f, []);
    expect(r.code).toBe(0);
    expect(heads(r.out)).toEqual([
      "Queue miroshnik/elves (open tasks): ready 2, «В работе» 1, not ready 3",
      `+ #42 «${f.issue(42).title}»`,
      `+ #${ready} «GitHub · Готова»`,
      `= #47 «${f.issue(47).title}» — «В работе»`,
      `○ #45 «${f.issue(45).title}» — an epic: its tasks — task queue --epic 45`,
      `○ #49 «${f.issue(49).title}» — Status «Готово», but the task is open`,
      `○ #${blocked} «GitHub · Заблокирована» — blocked by #47`,
      expect.stringMatching(/^Next: each ready task above/),
    ]);
  });

  /**
   * В пилоте #471 задача с открытым PR, пока исполнитель ждал CI, была строкой ○ среди не готовых — ни `+`, ни `=` (#513):
   * работа по ней идёт, и строка `=` называет PR ссылкой — открытый PR находится связью или веткой задачи и «Closes #N».
   */
  it("задача с открытым PR в очереди — строка `=` со ссылкой на PR, а не пропадает", () => {
    const f = new FakeGitHub(REC);
    f.status(47, "В работе");
    const linked = subtask(f, REPO, "С PR");
    const branch = subtask(f, REPO, "С веткой");
    f.prs[200] = { files: [], closes: [linked], head: `feat/${linked}-pr`, model: null, state: "OPEN" };
    f.prs[201] = { files: [], closes: [], head: `fix/${branch}-branch`, model: null, state: "OPEN" };
    f.prs[202] = { files: [], closes: [47], head: "feat/47-export", model: null, state: "OPEN" };
    const r = queue(f, ["--epic", "45"]);
    expect(r.code).toBe(0);
    expect(heads(r.out)).toEqual([
      "Queue miroshnik/elves (epic #45): ready 0, «В работе» 3, not ready 0",
      `= #47 «${f.issue(47).title}» — «В работе», open PR #202 https://github.com/miroshnik/elves/pull/202`,
      `= #${linked} «GitHub · С PR» — open PR #200 https://github.com/miroshnik/elves/pull/200`,
      `= #${branch} «GitHub · С веткой» — open PR #201 https://github.com/miroshnik/elves/pull/201`,
      expect.stringMatching(/^Next: no ready tasks — wait for the executors' answers; after each — task queue again; /),
    ]);
  });

  /**
   * Исполнитель печатает задание первым вызовом (`--assignment`), а «В работе» ставит позже — после вопросов задачи; до
   * того очередь выдавала задачу готовой (#484 сразу после запуска, #513). Выдачу помнит сессия-диспетчер — субагент
   * делит её id: пока исполнитель не ответил, задача у него. Ответ «влито» закрывает задачу, после «вопрос» он ждёт ответа
   * владельца, после «сломалось» задачу не перезапускают — ни в одном случае она не готова для этой сессии.
   */
  it("задача, выданная исполнителю этой сессии-диспетчера, не среди готовых, пока он не ответил", () => {
    const f = new FakeGitHub(REC);
    f.status(47, "Бэклог");
    const config = scratch();
    expect(heads(task(f, ["queue", "--epic", "45"], REPO, dispatcherIo(config)).out)[1]).toBe(`+ #47 «${f.issue(47).title}»`);
    // задание исполнитель печатает из своего worktree; каталог не чекаут — веток задачи скрипт не ищет
    expect(task(f, ["queue", "--assignment", "47"], REPO, { ...inSession(config), cwd: scratch() }).code).toBe(0);
    expect(heads(task(f, ["queue", "--epic", "45"], REPO, dispatcherIo(config)).out)).toEqual([
      "Queue miroshnik/elves (epic #45): ready 0, «В работе» 1, not ready 0",
      `= #47 «${f.issue(47).title}» — handed out to an executor of this session`,
      expect.stringMatching(/^Next: no ready tasks — wait for the executors' answers; after each — task queue again; /),
    ]);
    // выдача — этой сессии: у другого диспетчера задача готова
    expect(heads(task(f, ["queue", "--epic", "45"], REPO, dispatcherIo(config, "5e1d0c9a-2b7f-4c3e-8a6d-1f0e9b8c7a65")).out)[1]).toBe(`+ #47 «${f.issue(47).title}»`);
    expect(f.mutations).toEqual([]);
  });

  /**
   * На «да» владельца исполнителя запускает и сессия без очереди (#546) — с закреплённой задачей или ещё без неё.
   * Субагент делит id сессии: без выдачи его «В работе» отказала бы закреплённая задача, а в сессии без задачи — его
   * задача закрепилась бы за сессией, и следующего исполнителя и задачу самой сессии отказало бы уже оно.
   */
  it("задание исполнителя в сессии с закреплённой задачей пишет выдачу: его «В работе» не закрепляется и не отказывает, закрепление сессии остаётся", () => {
    const f = new FakeGitHub(REC);
    f.status(47, "Бэклог");
    const config = scratch();
    task(f, ["status", "49", "В работе"], REPO, inSession(config));
    expect(task(f, ["queue", "--assignment", "47"], REPO, { ...inSession(config), cwd: scratch() }).code).toBe(0);
    const r = task(f, ["status", "47", "В работе"], REPO, inSession(config));
    expect(r.code).toBe(0);
    expect(r.out).toContain("○ #47 is handed out to an executor of this session — not pinned: the executor is a subagent with the session's id, est links the work by «Задача #47» in the assignment");
    expect(statusSet(f)).toEqual([[49, "В работе"], [47, "В работе"]]);
    expect(pinned(config)).toBe("miroshnik/elves#49");
    // не выданная задача — по-прежнему отказ
    expect(task(f, ["status", "42", "В работе"], REPO, inSession(config)).code).toBe(2);
  });

  it("задание исполнителя в сессии без задачи пишет выдачу: его «В работе» не закрепляет сессию, и она потом берёт свою задачу", () => {
    const f = new FakeGitHub(REC);
    f.status(47, "Бэклог");
    const config = scratch();
    expect(task(f, ["queue", "--assignment", "47"], REPO, { ...inSession(config), cwd: scratch() }).code).toBe(0);
    expect(task(f, ["status", "47", "В работе"], REPO, inSession(config)).code).toBe(0);
    expect(existsSync(pinFile(config))).toBe(false);
    expect(task(f, ["status", "49", "В работе"], REPO, inSession(config)).code).toBe(0);
    expect(pinned(config)).toBe("miroshnik/elves#49");
  });

  // без перегиба: сессия, закреплённая за этой же задачей, — её задача, а не выдача исполнителю
  it("задание в сессии, закреплённой за этой же задачей, выдачу не пишет", () => {
    const f = new FakeGitHub(REC);
    const config = scratch();
    task(f, ["status", "47", "В работе"], REPO, inSession(config));
    expect(task(f, ["queue", "--assignment", "47"], REPO, { ...inSession(config), cwd: scratch() }).code).toBe(0);
    expect(existsSync(path.join(config, "dispatchers", `${SESSION}.tasks`))).toBe(false);
  });

  /**
   * Внешний блокер (#512): issue другого репозитория — связью blocked by, GitHub даёт её и между организациями; блокер не
   * issue (релиз, PR, чужой трекер) — меткой «внешний блокер», причина — последний комментарий «Внешний блокер: …».
   * Иначе блокер жил в тексте описания, и очередь до конца сессии выдавала задачу готовой.
   */
  it("задача с внешним блокером — строка `○` с причиной, а не среди готовых", () => {
    const f = new FakeGitHub(REC);
    f.status(47, "Бэклог");
    const linked = subtask(f, REPO, "Ждёт релиза");
    const labeled = subtask(f, REPO, "Ждёт поставщика");
    const silent = subtask(f, REPO, "Без причины");
    // номер блокера совпадает с задачей этого репозитория — строка называет репозиторий
    f.blockedBy[linked] = [{ repo: "acme/runtime", number: 47, state: "OPEN", title: "Падает при старте", id: "I_ext47" }];
    f.labelIssue(labeled, "внешний блокер");
    f.comments[labeled] = [
      { body: "Внешний блокер: старая причина", url: "c1" },
      { body: "Внешний блокер: ответ поставщика по лицензии\nподробности — в письме", url: "c2" },
      { body: "Состояние: ждём", url: "c3" },
    ];
    f.labelIssue(silent, "внешний блокер");
    const r = queue(f, ["--epic", "45"]);
    expect(r.code).toBe(0);
    expect(heads(r.out)).toEqual([
      "Queue miroshnik/elves (epic #45): ready 1, «В работе» 0, not ready 3",
      `+ #47 «${f.issue(47).title}»`,
      `○ #${linked} «GitHub · Ждёт релиза» — blocked by acme/runtime#47`,
      `○ #${labeled} «GitHub · Ждёт поставщика» — label «внешний блокер»: ответ поставщика по лицензии`,
      `○ #${silent} «GitHub · Без причины» — label «внешний блокер», no comment «Внешний блокер: <reason>»`,
      expect.stringMatching(/^Next: each ready task above/),
    ]);
  });

  // без перегиба: до #512 зелёный — красный, если очередь держит задачу по закрытому блокеру или по комментарию без метки
  it("блокер снят — задача снова среди готовых", () => {
    const f = new FakeGitHub(REC);
    f.closed(47);
    const linked = subtask(f, REPO, "Ждала релиза");
    const labeled = subtask(f, REPO, "Ждала поставщика");
    f.blockedBy[linked] = [{ repo: "acme/runtime", number: 7, state: "CLOSED", title: "Падает при старте", id: "I_ext7" }];
    // метку сняли, комментарий с причиной остался — он сам задачу не держит
    f.comments[labeled] = [{ body: "Внешний блокер: ответ поставщика по лицензии", url: "c1" }];
    const r = queue(f, ["--epic", "45"]);
    expect(heads(r.out).slice(0, 3)).toEqual(["Queue miroshnik/elves (epic #45): ready 2, «В работе» 0, not ready 0", `+ #${linked} «GitHub · Ждала релиза»`, `+ #${labeled} «GitHub · Ждала поставщика»`]);
  });

  it("--type и --priority отбирают задачи в организации; в личном аккаунте — ошибка до чтения задач", () => {
    const f = new FakeGitHub(asOrg(REC));
    f.status(47, "Бэклог");
    const bug = created(task(f, ["new", "--title", "Падает", "--type", "Баг", "--priority", "High"], ORG));
    created(task(f, ["new", "--title", "Мелочь", "--type", "Баг", "--priority", "Low"], ORG));
    created(task(f, ["new", "--branch-type", "feat", "--title", "Срочная фича", "--priority", "Urgent"], ORG));
    const r = queue(f, ["--type", "bug", "--priority", "Urgent,High"], ORG);
    expect(r.code).toBe(0);
    expect(heads(r.out).slice(0, 2)).toEqual(["Queue acme/elves (open tasks, type «Баг», Priority Urgent|High): ready 1, «В работе» 0, not ready 1", `+ #${bug} «Падает» (High)`]);
    const personal = task(new FakeGitHub(REC), ["queue", "--type", "Bug"], REPO, dispatcherIo());
    expect(personal.code).toBe(2);
    expect(personal.err).toBe("error: --type and --priority — only in an organization: a personal account has no issue types and no Priority");
    expect(task(f, ["queue", "--priority", "P1"], ORG, dispatcherIo()).err).toBe("error: --priority: Urgent, High, Medium, Low, not P1");
  });

  /** Каталог с языком проекта, но не чекаут: ветки задачи скрипт не ищет — тест не зависит от веток репозитория, где его запустили. */
  const projectDir = () => {
    const dir = scratch();
    mkdirSync(path.join(dir, ".agents"));
    writeFileSync(path.join(dir, ".agents/elves.json"), '{ "language": "ru" }\n');
    return dir;
  };

  it("--assignment N — задание исполнителю: первая строка «Задача #N», отличия субагента, форма ответа", () => {
    const f = new FakeGitHub(REC);
    const r = task(f, ["queue", "--assignment", "47"], REPO, { cwd: projectDir() });
    expect(r.code).toBe(0);
    const lines = r.out.split("\n");
    expect(lines[0]).toStartWith("Задача #47 «GitHub · Задача одной командой — github task» в miroshnik/elves (эпик #45): ты исполнитель сессии-диспетчера — сделай задачу целиком по канону");
    expect(lines).toContain("Ты субагент, а не сессия:");
    expect(r.out).toContain("последнюю строку («Всё сделано. Сессию можно закрывать.») не пиши");
    expect(r.out).toContain("pr <PR> --timeout 540");
    expect(lines.at(-1)).toBe(
      "Ответ диспетчеру — одной строкой: `влито #<PR>` · `вопрос: <вопрос, варианты, рекомендация>` · `ждёт субагентов: <какие и что делают>` · `сломалось: <что и где остановилось>`.",
    );
    expect(f.mutations).toEqual([]);
  });

  /**
   * Исполнитель #545 ответил «сломалось», пока два его фоновых субагента ещё работали (#565): их ответы разбудили его, и он
   * довёл задачу до мержа, а владелец по отчёту уже решил её перезапустить — диспетчер запустил второго исполнителя на ту
   * же ветку, и CI, `pr premerge` и `project fix` прогнали оба. Ответ при живых субагентах выглядит провалом: задание
   * велит ждать их, а если ждать нельзя — ответить «ждёт субагентов», и это не «сломалось».
   */
  it("задание исполнителя запрещает ответ, пока его субагенты работают", () => {
    const r = task(new FakeGitHub(REC), ["queue", "--assignment", "47"], REPO, { cwd: projectDir() });
    expect(r.code).toBe(0);
    const lines = r.out.split("\n");
    expect(lines).toContain(
      "- пока работает хоть один твой субагент, ответ не отдавай: жди их ответов — фоновый субагент будит тебя своим ответом; " +
        "ответ при живых субагентах выглядит провалом, и диспетчер отдал бы задачу второму исполнителю рядом с тобой. " +
        "Ждать нельзя — ответь `ждёт субагентов: <какие и что делают>`: это не «сломалось», второго исполнителя не будет;",
    );
    expect(lines.at(-1)).toContain("· `ждёт субагентов: <какие и что делают>` ·");
  });

  /**
   * Исполнитель задачи без коммитов (правка данных в базе) запустил актуализацию фоновым субагентом и ответил «ждёт
   * субагентов» (#628): worktree без изменений среда убрала через минуту, субагент остался без каталога, итога на эпике
   * нет, и `task close` отказывал; без PR он отказывал ещё и из-за открытой задачи. Задание велит дождаться актуализации
   * в том же ходе, закрыть задачу и только потом отвечать, а задачу без PR — сначала закрыть как выполненную.
   */
  it("задание исполнителя: актуализация эпика — в том же ходе, до ответа диспетчеру", () => {
    const r = task(new FakeGitHub(REC), ["queue", "--assignment", "47"], REPO, { cwd: projectDir() });
    expect(r.code).toBe(0);
    const lines = r.out.split("\n");
    const refresh = lines.findIndex((l) => l.startsWith("- актуализация эпика"));
    expect(lines[refresh]).toMatch(
      /^- актуализация эпика — субагент, которого печатает `task actualize`, без своего worktree \(в твоём\) и не в фоне \(`run_in_background: false`\): его ответ — в том же ходе, затем `bun --no-env-file \S+github\.ts task close 47`, и только потом ответ диспетчеру: /,
    );
    expect(lines[refresh]).toContain(
      "у задачи без PR (правка данных, сверка, исследование) — сначала закрой issue как выполненную с итоговым комментарием: " +
        `\`gh issue close 47 --repo ${REPO} --reason completed --comment "<итог>"\`;`,
    );
    expect(refresh).toBeLessThan(lines.length - 1);
  });

  /**
   * Повторы в файлах, которые задача и так правит, исполнитель до PR не смотрел (#636): их находила актуализация уже после
   * мержа, когда дописать в задачу нельзя, и заводила новую — с её PR, CI, деплоем и своей актуализацией. Задание любого
   * исполнителя — субагента, сессии приложения, облачного — велит исправить их в том же PR.
   */
  it("задание исполнителя: повторы в файлах задачи — исправить в том же PR, а не заводить задачу", () => {
    const line =
      "- перед PR — повторы в файлах, которые задача и так правит: исправь в том же PR, новую задачу на них не заводи; повтор вне файлов задачи — дело актуализации эпика;";
    for (const kind of [[], ["--session"], ["--cloud"]]) {
      const r = task(new FakeGitHub(REC), ["queue", "--assignment", "47", ...kind], REPO, { ...inSession(scratch()), cwd: projectDir() });
      expect(r.code).toBe(0);
      expect(r.out.split("\n")).toContain(line);
    }
  });

  /**
   * Репозиторий переименовали (#560): подсказки печатали имя из --repo или origin как есть — прежнее, и команда по
   * подсказке шла по прежнему имени, где запись получает редирект 307. Скрипт берёт нынешнее имя у GitHub.
   */
  it("подсказки скриптов называют каноническое имя переименованного репозитория", () => {
    const f = new FakeGitHub(REC);
    f.formerNames = ["miroshnik/old-name"];
    f.status(47, "Бэклог");
    const epic = task(f, ["new", "--title", "Импорт · Импорт задач из CSV", "--type", "Эпик"], "miroshnik/old-name");
    const queued = queue(f, ["--epic", "45"], "miroshnik/old-name");
    const assignment = task(f, ["queue", "--assignment", "47"], "miroshnik/old-name", { cwd: projectDir() });
    for (const r of [epic, queued, assignment]) {
      expect(r.code).toBe(0);
      expect(r.out).not.toContain("old-name");
    }
    expect(epic.out).toContain(`task queue --epic ${created(epic)} --repo ${REPO} in this session`);
    expect(queued.out.split("\n")[0]).toStartWith(`Queue ${REPO} (epic #45)`);
    expect(queued.out).toContain(`task queue --assignment 47 --repo ${REPO}\``);
    expect(assignment.out.split("\n")[0]).toContain(`в ${REPO} (эпик #45)`);
  });

  // лимит «не больше трёх» — на исполнителей диспетчера; о своих субагентах задание молчало, и исполнитель #439 гадал (#516)
  it("задание исполнителя говорит, можно ли ему запускать пишущих субагентов", () => {
    const r = task(new FakeGitHub(REC), ["queue", "--assignment", "47"], REPO, { cwd: projectDir() });
    expect(r.code).toBe(0);
    expect(r.out.split("\n")).toContain(
      "- пишущих субагентов запускай по необходимости, без лимита: каждому — свой worktree и «Задача #47» в начале промпта (по нему `est` привяжет его работу); " +
        "их коммиты перенеси в свою ветку, их worktree и ветки после мержа убери сам — что не убралось, назови в ответе;",
    );
  });

  /**
   * Задание велело взять задачу через `task status --branch`, а вопросы и `task show` — отдельными ходами (#709): после
   * #666 это один вызов `task start --branch` — вопросы и проверка параллельной работы внутри него.
   */
  it("задание исполнителя велит взять задачу через task start", () => {
    const batch = scratch();
    writeTree(batch, { [`dispatchers/${SESSION}`]: `bun --no-env-file github.ts task queue --epic 45 --repo ${REPO}\nbatch ${REPO} batch/2026-10-22-1\n` });
    for (const [io, more] of [[inSession(scratch()), []], [inSession(scratch()), ["--session"]], [inSession(batch), []], [inSession(batch), ["--session"]]] as [Partial<Io>, string[]][]) {
      const r = task(new FakeGitHub(REC), ["queue", "--assignment", "47", ...more], REPO, { ...io, cwd: projectDir() });
      expect(r.code).toBe(0);
      const lead = r.out.split("\n")[0]!;
      expect(lead).toMatch(/`bun --no-env-file \S+github\.ts task start 47 --branch <тип>\/47-<slug>` \(вопросы задачи и её параллельная работа — в нём\)/);
      expect(lead).not.toContain("task status 47");
    }
  });

  // строка о перезапуске — факт о задаче, а не напоминание всем: исполнитель задачи из «Бэклога» разбирал, что она неправда (#511)
  it("задание исполнителю по задаче в «Бэклоге» без ветки не говорит, что задача уже в работе", () => {
    const { work, cleanup } = checkout("feat/48-other", { merged: false });
    try {
      const f = new FakeGitHub(REC);
      f.status(49, "Бэклог");
      const r = task(f, ["queue", "--assignment", "49"], REPO, { run: noEst, cwd: work });
      expect(r.code).toBe(0);
      expect(r.out).not.toContain("«В работе» и у неё есть ветка");
      expect(r.out).not.toContain("перезапуск");
      expect(r.out.split("\n")[1]).toBe("Ты субагент, а не сессия:");
    } finally {
      cleanup();
    }
  });

  // новый исполнитель получает свой worktree, а ветку задачи git ему не отдаст, пока она взята в старом, — там и
  // незакоммиченная работа прежнего (#528): продолжать её надо там, а не в своём
  it("задание исполнителю по задаче «В работе» с веткой `*/N-*` велит продолжить её работу в worktree ветки, а не в новом", () => {
    const { work, cleanup } = checkout("feat/47-export", { merged: false });
    const resume = (branch: string) =>
      new RegExp(
        `^Задача уже «В работе» и у неё есть ветка \`${branch}\` — это перезапуск: бери её \`bun --no-env-file \\S+github\\.ts task start 47 --resume\`, а не \`--branch\`, и продолжи её работу\\. ` +
          "Ветка взята в другом worktree \\(`git worktree list`\\) — работай в нём, а не в своём новом: в Claude Code — `EnterWorktree` с его путём; " +
          "незакоммиченное — `git status` там\\. Ни в одном worktree её нет — возьми её в свой\\.$",
      );
    try {
      const f = new FakeGitHub(REC);
      f.status(47, "В работе");
      const assignment = () => task(f, ["queue", "--assignment", "47"], REPO, { run: noEst, cwd: work }).out.split("\n");
      // прежний исполнитель запушил ветку, его worktree убран: локальной ветки нет, она есть на origin
      git(work, "switch", "-q", "main");
      git(work, "branch", "-q", "-D", "feat/47-export");
      expect(assignment()[1]).toMatch(resume("feat/47-export"));
      // прежний исполнитель не успел запушить: ветка только локальная
      git(work, "push", "-q", "origin", "--delete", "feat/47-export");
      git(work, "branch", "fix/47-local");
      expect(assignment()[1]).toMatch(resume("fix/47-local"));
    } finally {
      cleanup();
    }
  });

  it("сессия-диспетчер: task status «В работе» в ней задачу не закрепляет — исполнители-субагенты делят id сессии", () => {
    const f = new FakeGitHub(REC);
    const config = scratch();
    expect(task(f, ["queue", "--epic", "45"], REPO, dispatcherIo(config)).code).toBe(0);
    expect(readFileSync(path.join(config, "dispatchers", SESSION), "utf8")).toMatch(/ task queue --epic 45 --repo miroshnik\/elves\n$/);
    const r = task(f, ["status", "47", "В работе"], REPO, inSession(config));
    expect(r.code).toBe(0);
    expect(r.out).toContain("○ dispatcher session: #47 isn't pinned — its executor is a subagent with the session's id, est links the work by «Задача #47» in the assignment");
    expect(task(f, ["status", "49", "В работе"], REPO, inSession(config)).code).toBe(0);
    expect(statusSet(f).filter(([n]) => n !== 45)).toEqual([[47, "В работе"], [49, "В работе"]]);
    expect(existsSync(pinFile(config))).toBe(false);
  });

  // «да» владельца диспетчеру эпика — сразу работа в этой сессии, без новой (#546): её задача остаётся за ней
  it("сессия с закреплённой задачей ведёт очередь: её задача — строкой `=`, закрепление остаётся, вторую задачу она не берёт", () => {
    const f = new FakeGitHub(REC);
    f.status(42, "Бэклог");
    const config = scratch();
    task(f, ["status", "47", "В работе"], REPO, inSession(config));
    const r = task(f, ["queue", "--epic", "45"], REPO, dispatcherIo(config));
    expect(r.code).toBe(0);
    expect(heads(r.out)).toContain(`= #47 «${f.issue(47).title}» — «В работе»`);
    expect(existsSync(path.join(config, "dispatchers", SESSION))).toBe(true);
    expect(task(f, ["status", "47", "В работе"], REPO, inSession(config)).code).toBe(0);
    expect(pinned(config)).toBe("miroshnik/elves#47");
    expect(task(f, ["status", "42", "В работе"], REPO, inSession(config)).code).toBe(2);
  });

  // после перезапуска приложения сессия с задачей продолжает и своих исполнителей, и ожидание своей задачи
  it("строка возобновления сессии с закреплённой задачей и исполнителями велит продолжить их сообщением, а затем — ожидание её задачи", () => {
    const f = new FakeGitHub(REC);
    f.status(47, "Бэклог");
    const config = scratch();
    task(f, ["status", "49", "В работе"], REPO, inSession(config));
    task(f, ["queue", "--assignment", "47"], REPO, { ...inSession(config), cwd: scratch() });
    const lines = task(f, ["resume"], REPO, inSession(config)).out.split("\n");
    expect(lines[0]).toBe(
      "Dispatcher session: its executors (background subagents) stopped with the app's process, their transcripts are intact — " +
        "continue each with SendMessage by its id from the app's notification, not a new executor: it goes on with its context in its own worktree",
    );
    expect(lines[1]).toStartWith("Dispatcher session: a new executor — only for one that can't be continued");
    expect(lines.slice(2).join("\n")).toMatch(/session task miroshnik\/elves#49/i);
  });

  /**
   * Перезапуск приложения останавливает фоновых исполнителей, но их транскрипты целы, и приложение называет их в
   * уведомлении (#528). В пилоте #471 трое остановленных (#513, #515, #518) держали ветки задач в своих worktree с
   * незакоммиченными правками: новый исполнитель получил бы свежий worktree, ветку задачи git ему не отдал бы, а работа
   * осталась бы в старом. Диспетчер продолжил всех троих через `SendMessage` — каждый с целым контекстом в своём worktree.
   */
  it("строка возобновления сессии-диспетчера велит продолжить остановленных исполнителей сообщением, а не запускать новых", () => {
    const f = new FakeGitHub(REC);
    const config = scratch();
    task(f, ["queue", "--epic", "45"], REPO, dispatcherIo(config));
    const r = task(f, ["resume"], REPO, inSession(config));
    expect(r.code).toBe(0);
    expect(r.out.split("\n")[0]).toMatch(
      /^Dispatcher session: its executors \(background subagents\) stopped with the app's process, their transcripts are intact — continue each with SendMessage by its id from the app's notification, not a new executor: it goes on with its context in its own worktree; then re-read the queue: bun --no-env-file \S+github\.ts task queue --epic 45 --repo miroshnik\/elves — their tasks stay = in it$/,
    );
  });

  it("нового исполнителя задачи «В работе» строка отправляет в worktree её ветки", () => {
    const f = new FakeGitHub(REC);
    const config = scratch();
    task(f, ["queue", "--epic", "45"], REPO, dispatcherIo(config));
    const r = task(f, ["resume"], REPO, inSession(config));
    expect(r.code).toBe(0);
    expect(r.out.split("\n")[1]).toBe(
      "Dispatcher session: a new executor — only for one that can't be continued, with the same prompt; " +
        "a task «В работе» it continues in the worktree of the task's branch (`git worktree list`), not in a new one — its assignment says so: " +
        "git won't give the branch to a second worktree, and uncommitted work stays in the old one",
    );
  });

  // остановленного исполнителя продолжают сообщением, и выдача ему живёт: снятая, она вернула бы задачу в готовые, пока
  // он её ещё не взял «В работе», и диспетчер выдал бы её второму исполнителю
  it("после перезапуска приложения задача, выданная остановленному исполнителю, остаётся в работе: его продолжают сообщением", () => {
    const f = new FakeGitHub(REC);
    f.status(47, "Бэклог");
    const config = scratch();
    task(f, ["queue", "--epic", "45"], REPO, dispatcherIo(config));
    task(f, ["queue", "--assignment", "47"], REPO, { ...inSession(config), cwd: scratch() });
    expect(task(f, ["resume"], REPO, inSession(config)).code).toBe(0);
    expect(heads(task(f, ["queue", "--epic", "45"], REPO, dispatcherIo(config)).out)).toContain(`= #47 «${f.issue(47).title}» — handed out to an executor of this session`);
  });

  it("очередь пуста и в работе ничего — строка с последним шагом диспетчера", () => {
    const f = new FakeGitHub(REC);
    f.closed(47);
    const r = queue(f, ["--epic", "45"]);
    expect(r.code).toBe(0);
    expect(r.out.split("\n")).toEqual([
      "Queue miroshnik/elves (epic #45): ready 0, «В работе» 0, not ready 0",
      expect.stringMatching(
        /^Queue is empty: nothing ready, nothing «В работе»; .+\. Then the dispatcher's summary \(merged, questions, the not ready ones above\) and the last line; a session with its own task — after it\.$/,
      ),
    ]);
  });
});

/**
 * Пачка (эпик #645): диспетчер проекта с `"batch": true` собирает задачи своей группы в ветку пачки — исполнители
 * ветвятся от неё и вливают в неё после проверок перед коммитом, без CI (#676), а полный прогон, деплой и актуализация
 * эпиков — один раз на пачку, у её выпуска. Задача,
 * влитая в пачку, до выпуска открыта и «В работе» (вопрос 1 эпика); GitHub не связывает с задачей PR не в ветку по
 * умолчанию, поэтому PR пачки скрипт находит сам — по ветке задачи и «Closes #N».
 */
// Пачка диспетчера (эпик #645) — общее для её очереди и выпуска
const OTHER_SESSION = "5e1d0c9a-2b7f-4c3e-8a6d-1f0e9b8c7a65";
/** День в имени ветки пачки — по часам машины, как у скрипта. */
const day = () => {
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
};
const createdIn = (r: { out: string }) => Number(/^Created #(\d+)/.exec(r.out)![1]);
const subtaskOf45 = (f: FakeGitHub, title: string, ...more: string[]) => createdIn(task(f, ["new", "--branch-type", "feat", "--title", title, "--epic", "45", ...more]));
/** Строки вывода без промптов исполнителей (у них отступ). */
const headLines = (out: string) => out.split("\n").filter((l) => !l.startsWith("  "));
const marker = (config: string, id = SESSION) => path.join(config, "dispatchers", id);
/** Папка проекта диспетчера — чекаут на main с origin репозитория; `batch` — настройка проекта в .agents/elves.json. */
function batchProjectDir(batch: boolean) {
  const c = checkout("fix/49-x", { merged: false });
  temp.push(c.cleanup);
  git(c.work, "switch", "-q", "main");
  writeTree(c.work, { ".agents/elves.json": JSON.stringify({ language: "ru", ...(batch ? { batch: true } : {}) }) + "\n" });
  return c.work;
}
const remoteBatches = (work: string) =>
  git(work, "ls-remote", "--heads", "origin")
    .split("\n")
    .map((l) => l.split("\t")[1] ?? "")
    .filter((r) => r.startsWith("refs/heads/batch/"))
    .map((r) => r.slice("refs/heads/".length));
const queueIn = (f: FakeGitHub, work: string, config: string, id = SESSION) => task(f, ["queue", "--epic", "45"], REPO, { ...inSession(config, id), cwd: work, run: noEst });
/** PR задачи, влитый в ветку пачки: GitHub его с задачей не связывает — только ветка и «Closes #N» в теле. */
const batchPr = (number: number, head: string, base: string) => ({ files: [], closes: [], body: `Closes #${number}`, head, base, model: null, merged: true });

describe("task queue собирает задачи диспетчера в ветку пачки", () => {
  /** Каталог с языком проекта, но не чекаут: задание исполнителя не ищет веток задачи. */
  const projectDir = () => {
    const dir = scratch();
    writeTree(dir, { ".agents/elves.json": '{ "language": "ru" }\n' });
    return dir;
  };
  /** Маркер диспетчера с веткой пачки — как его оставляет очередь проекта с пачками. */
  function batchSession(branch: string): string {
    const config = scratch();
    writeTree(config, { [`dispatchers/${SESSION}`]: `bun --no-env-file github.ts task queue --epic 45 --repo ${REPO}\nbatch ${REPO} ${branch}\n` });
    return config;
  }

  it("первый запуск создаёт ветку пачки от origin/main, следующий берёт ту же", () => {
    const work = batchProjectDir(true);
    const f = new FakeGitHub(REC);
    f.status(47, "Бэклог");
    const config = scratch();
    const name = `batch/${day()}-1`;
    const main = git(work, "rev-parse", "origin/main");
    const first = queueIn(f, work, config);
    expect(first.code).toBe(0);
    expect(first.out.split("\n")[0]).toBe(`+ batch branch ${name} from origin/main (${main.slice(0, 7)}) pushed: the executors branch from it and merge into it`);
    expect(git(work, "ls-remote", "--heads", "origin", name)).toBe(`${main}\trefs/heads/${name}`);
    // ветка — только на origin: чекаут диспетчера остаётся на своей ветке
    expect(git(work, "branch", "--show-current")).toBe("main");
    expect(git(work, "branch", "--list", "batch/*")).toBe("");
    expect(readFileSync(marker(config), "utf8")).toEndWith(` task queue --epic 45 --repo ${REPO}\nbatch ${REPO} ${name}\n`);
    // main ушёл вперёд — следующий запуск берёт ту же ветку, а не заводит новую
    gitRepo(work, { init: false }).commit({ "b.txt": "b\n" }, "next");
    git(work, "push", "-q", "origin", "main");
    const second = queueIn(f, work, config);
    expect(second.out.split("\n")[0]).toBe(`○ batch branch ${name} — the dispatcher's batch: the executors branch from it and merge into it`);
    expect(remoteBatches(work)).toEqual([name]);
    // перезапуск приложения: очередь — первой строкой маркера, строка пачки в команду не попадает
    expect(task(f, ["resume"], REPO, inSession(config)).out.split("\n")[0]).toMatch(/re-read the queue: bun --no-env-file \S+github\.ts task queue --epic 45 --repo miroshnik\/elves — their tasks stay = in it$/);
    // другой диспетчер в тот же день — следующий номер
    expect(queueIn(f, work, scratch(), OTHER_SESSION).out.split("\n")[0]).toStartWith(`+ batch branch batch/${day()}-2 from origin/main`);
    // пачку выпустили, её ветку удалили — продолжающий диспетчер заводит новую от свежего main
    git(work, "push", "-q", "origin", "--delete", name);
    const third = queueIn(f, work, config);
    expect(third.out.split("\n")[0]).toBe(
      `+ batch branch batch/${day()}-3 from origin/main (${git(work, "rev-parse", "origin/main").slice(0, 7)}) pushed — ${name} is gone from origin (released): the executors branch from it and merge into it`,
    );
  });

  it("задание исполнителя ведёт ветку задачи от ветки пачки и PR в неё", () => {
    const name = `batch/${day()}-1`;
    const config = batchSession(name);
    const f = new FakeGitHub(REC);
    const lines = task(f, ["queue", "--assignment", "47"], REPO, { ...inSession(config), cwd: projectDir() }).out.split("\n");
    expect(lines[0]).toStartWith(`Задача #47 «${f.issue(47).title}» в ${REPO} (эпик #45): ты исполнитель сессии-диспетчера, задача идёт в пачку \`${name}\` — `);
    expect(lines[0]).toContain(`ветка от свежего origin/${name}, а не от main (\`git fetch origin ${name}\`, затем ветка задачи на \`origin/${name}\`)`);
    expect(lines[0]).toContain(`PR в пачку (\`gh pr create --base ${name}\`), \`pr premerge\`, мерж.`);
    expect(lines.at(-1)).toStartWith("Ответ диспетчеру — одной строкой: `влито #<PR>`");
    // сессия-исполнитель приложения — то же: ветка от пачки, PR в неё, без деплоя
    const session = task(f, ["queue", "--assignment", "47", "--session"], REPO, { ...inSession(config), cwd: projectDir() }).out.split("\n");
    expect(session[0]).toContain(`ты сессия-исполнитель сессии-диспетчера, задача идёт в пачку \`${name}\``);
    expect(session[0]).toContain(`PR в пачку (\`gh pr create --base ${name}\`)`);
    // пачка — репозитория диспетчера: задача другого проекта идёт в свой main
    const other = task(new FakeGitHub(asOrg(REC)), ["queue", "--assignment", "47", "--session"], ORG, { ...inSession(config), cwd: projectDir() }).out.split("\n");
    expect(other[0]).toContain("ветка от свежего origin/main, код и тесты, PR, зелёный CI");
  });

  /**
   * Пилот пачки (#676): исполнитель держал слот ещё на двух шагах после проверок перед коммитом — ожидании лёгкого CI на
   * PR в пачку, который повторял те же проверки в чистом окружении, и актуализации эпика после каждого мержа в пачку.
   * Теперь задача вливается в пачку сразу после проверок перед коммитом и `pr premerge`: CI — один полный прогон у
   * выпуска, актуализация — одна на эпик, тоже у выпуска.
   */
  it("задание исполнителя пачки — мерж в пачку после проверок перед коммитом и pr premerge, без ожидания CI и без актуализации эпика", () => {
    const name = `batch/${day()}-1`;
    const config = batchSession(name);
    const f = new FakeGitHub(REC);
    const assignment = (...more: string[]) => task(f, ["queue", "--assignment", "47", ...more], REPO, { ...inSession(config), cwd: projectDir() }).out.split("\n");
    const lines = assignment();
    expect(lines[0]).toContain(`код и тесты, проверки перед коммитом, PR в пачку (\`gh pr create --base ${name}\`), \`pr premerge\`, мерж.`);
    expect(lines[0]).toEndWith(
      "Ожидания CI, деплоя, актуализации эпика и `task close` нет: задача — «В работе» до выпуска пачки, его делает диспетчер — с одним полным прогоном CI и одной актуализацией на эпик.",
    );
    expect(lines[0]).not.toContain("зелёный CI");
    // CI не ждать: PR в пачку его не запускает — ворота у него проверки перед коммитом и pr premerge
    const wait = lines.find((l) => l.startsWith("- CI не жди"))!;
    expect(wait).toContain("проверки перед коммитом по канону (`elves precommit --base origin/<ветка пачки>`: `lint`, `typecheck`, `test:spec`, затронутые тесты — `docs/testing.md`) и `pr premerge`");
    expect(wait).toContain("после его кода 0 — `gh pr merge <PR> --rebase` без ожидания CI");
    // ни ожидания CI, ни актуализации, ни task close — кроме задачи без PR: она не в пачке, её закрывает исполнитель
    expect(lines.filter((l) => l.includes("wait-ci.sh"))).toEqual([]);
    const refresh = lines.find((l) => l.startsWith("- актуализация эпика и `task close` — не твои"))!;
    expect(refresh).toContain("обе — у выпуска пачки, одна актуализация на каждый эпик её задач, затем `task close` каждой, их делает диспетчер;");
    expect(refresh.slice(0, refresh.indexOf("без PR"))).not.toMatch(/task actualize|task close 47/);
    expect(lines.filter((l) => l !== refresh && /task actualize|task close 47/.test(l))).toEqual([]);
    // сессия-исполнитель приложения — так же: CI не ждёт, актуализации нет
    const session = assignment("--session");
    expect(session[0]).toContain(`код и тесты, проверки перед коммитом, PR в пачку (\`gh pr create --base ${name}\`), \`pr premerge\`, мерж. Ожидания CI, деплоя, актуализации эпика`);
    expect(session).toContain(wait);
    expect(session.filter((l) => /wait-ci\.sh|task actualize|task close 47/.test(l))).toEqual([]);
  });

  it("блокер, влитый в ветку пачки, не держит задачу той же пачки; блокер вне пачки держит", () => {
    const work = batchProjectDir(true);
    const f = new FakeGitHub(REC);
    const config = scratch();
    queueIn(f, work, config);
    const name = `batch/${day()}-1`;
    f.status(47, "В работе");
    const inside = subtaskOf45(f, "Ждёт влитую в пачку", "--blocked-by", "47");
    const outside = subtaskOf45(f, "Ждёт влитую в другую пачку", "--blocked-by", "49");
    f.prs[300] = batchPr(47, "feat/47-export", name);
    f.prs[301] = batchPr(49, "fix/49-x", "batch/2026-10-01-1");
    const lines = headLines(queueIn(f, work, config).out);
    expect(lines).toContain(`+ #${inside} «GitHub · Ждёт влитую в пачку»`);
    expect(lines).toContain(`○ #${outside} «GitHub · Ждёт влитую в другую пачку» — blocked by #49`);
  });

  it("в проекте без пачек очередь и задания — как раньше", () => {
    const work = batchProjectDir(false);
    const f = new FakeGitHub(REC);
    f.status(47, "Бэклог");
    const blocked = subtaskOf45(f, "Ждёт влитую в ветку пачки", "--blocked-by", "49");
    f.prs[301] = batchPr(49, "fix/49-x", `batch/${day()}-1`);
    const config = scratch();
    const r = queueIn(f, work, config);
    expect(r.code).toBe(0);
    expect(r.out.split("\n")[0]).toStartWith("Queue miroshnik/elves (epic #45): ");
    expect(headLines(r.out)).toContain(`○ #${blocked} «GitHub · Ждёт влитую в ветку пачки» — blocked by #49`);
    expect(remoteBatches(work)).toEqual([]);
    expect(readFileSync(marker(config), "utf8")).toMatch(/^bun --no-env-file \S+ task queue --epic 45 --repo miroshnik\/elves\n$/);
    const lead = task(f, ["queue", "--assignment", "47"], REPO, { ...inSession(config), cwd: projectDir() }).out.split("\n")[0];
    expect(lead).toContain("ветка от свежего origin/main, код и тесты, PR, зелёный CI, `pr premerge`, мерж, деплой, актуализация эпика");
    expect(lead).not.toContain("пачк");
  });

  it("задача, влитая в ветку пачки, — `=` в очереди, task close её до выпуска не закрывает", () => {
    const work = batchProjectDir(true);
    const f = new FakeGitHub(REC);
    const config = scratch();
    queueIn(f, work, config);
    const name = `batch/${day()}-1`;
    f.prs[300] = batchPr(47, "feat/47-export", name);
    const merged = `PR #300 merged into ${name} — the task closes with the batch's release`;
    // «В работе» до выпуска; статус сбили — влитая в пачку задача всё равно не готова: второй исполнитель сделал бы её заново
    f.status(47, "В работе");
    expect(headLines(queueIn(f, work, config).out)).toContain(`= #47 «${f.issue(47).title}» — «В работе», ${merged}`);
    f.status(47, "Бэклог");
    expect(headLines(queueIn(f, work, config).out)).toContain(`= #47 «${f.issue(47).title}» — ${merged}`);
    const close = task(f, ["close", "47", "--no-git"], REPO, { run: noEst, cwd: work });
    expect(close.code).toBe(2);
    expect(close.err).toBe(
      `error: #47 is too early to close: PR #300 merged into ${name}, not into main — the task closes with the batch's release (Closes #47 in the release PR); till then it stays «В работе»`,
    );
    expect(byOp(f, "CloseIssue")).toEqual([]);
    expect(f.issue(47).state).toBe("OPEN");
  });

  it("актуализация эпика видит PR, влитый в ветку пачки, и blocked by до выпуска не снимает", () => {
    const f = new FakeGitHub(REC);
    const name = `batch/${day()}-1`;
    f.prs[300] = { ...batchPr(47, "feat/47-export", name), files: ["skills/github/scripts/github.ts"] };
    // задача той же пачки её blocked by не ждёт (task queue), а вне пачки — ждёт до выпуска: связь остаётся
    subtaskOf45(f, "Ждёт влитую в пачку", "--blocked-by", "47");
    const r = task(f, ["actualize", "47"], REPO);
    expect(r.code).toBe(0);
    expect(byOp(f, "RemoveBlockedBy")).toEqual([]);
    const assignment = task(f, ["actualize", "47", "--assignment"], REPO).out;
    expect(assignment).toContain(`Выкачено: #47 «${f.issue(47).title}», PR #300, дифф — \`git log -p -E --grep '#47([^0-9]|$)' origin/${name}\`.`);
    expect(assignment).toContain("Файлы PR #300:\n- skills/github/scripts/github.ts");
    // задача без эпика: строка после актуализации не зовёт task close — задача закроется выпуском пачки
    const lone =createdIn(task(f, ["new", "--branch-type", "feat", "--title", "Без эпика"]));
    f.prs[301] = batchPr(lone, `feat/${lone}-x`, name);
    expect(task(f, ["actualize", String(lone)], REPO).out).toBe(`○ refresh not needed: #${lone} has no epic. Next: no task close — #${lone} is merged into ${name}: it closes with the batch's release.`);
  });

  /**
   * Пилот пачки (#697): владелец вёл #676 мимо пачки — PR в main с полным CI, пока пачка собиралась; задание вело её в
   * пачку, решение пришлось вписать в промпт руками. `--main` — задание проекта без пачек, выдача с пометкой.
   */
  it("task queue --assignment N --main ведёт задачу мимо пачки: ветка от origin/main, PR в main, деплой и task close", () => {
    const name = `batch/${day()}-1`;
    const config = batchSession(name);
    const f = new FakeGitHub(REC);
    const assignment = (...more: string[]) => task(f, ["queue", "--assignment", "47", ...more], REPO, { ...inSession(config), cwd: projectDir() }).out.split("\n");
    const lines = assignment("--main");
    expect(lines[0]).toContain("ветка от свежего origin/main, код и тесты, PR, зелёный CI, `pr premerge`, мерж, деплой, актуализация эпика");
    expect(lines[0]).not.toContain("пачк");
    expect(lines[1]).toBe(
      `- задача идёт мимо пачки диспетчера \`${name}\` — слово владельца: ветка задачи от свежего origin/main, а не от пачки, PR в ветку по умолчанию (не \`--base ${name}\`) с полным CI, деплой, актуализация эпика и \`task close\` — твои, как в проекте без пачек; выпуск пачки тебя не ждёт;`,
    );
    expect(lines.some((l) => l.includes("wait-ci.sh"))).toBe(true);
    expect(lines.find((l) => l.startsWith("- актуализация эпика —"))).toContain("task close 47");
    expect(readFileSync(path.join(config, "dispatchers", `${SESSION}.tasks`), "utf8")).toBe(`${REPO}#47 @main\n`);
    // перезапуск исполнителя — тем же заданием без --main: выдача помнит путь мимо пачки
    expect(assignment()[1]).toBe(lines[1]);
    // сессия-исполнитель приложения — так же
    const session = assignment("--session", "--main");
    expect(session[0]).toContain("ветка от свежего origin/main");
    expect(session[1]).toBe(lines[1]);
    // без --assignment флаг не принимается
    expect(task(f, ["queue", "--epic", "45", "--main"], REPO, inSession(config)).err).toBe("error: --main — only with --assignment <N>: one task's assignment past the batch");
  });

  it("задача, выданная с --main, в очереди — «мимо пачки» и выпуск пачки не держит", () => {
    const { work, f, config, name } = started();
    f.prs[300] = batchPr(47, "feat/47-export", name);
    const past = subtaskOf45(f, "Мимо пачки");
    task(f, ["queue", "--assignment", String(past), "--main"], REPO, { ...inSession(config), cwd: projectDir() });
    f.status(past, "В работе");
    const r = queueIn(f, work, config);
    expect(headLines(r.out)).toContain(`= #${past} «GitHub · Мимо пачки» — «В работе», past the batch ${name} (--main): its PR goes into main with the full CI — the release doesn't wait for it`);
    expect(r.out.split("\n").at(-1)).toMatch(
      new RegExp(`^Next: the batch ${name} is complete — nothing ready, every task of the batch is merged into it: its release — bun --no-env-file \\S+github\\.ts batch release --repo miroshnik/elves, once no executor of the batch is still at work; past the batch — #${past}: they don't hold the release; `),
    );
    // задача пачки ещё в работе — выпуск ждёт её, а не задачу мимо пачки
    const live = subtaskOf45(f, "Живой исполнитель");
    task(f, ["queue", "--assignment", String(live)], REPO, { ...inSession(config), cwd: projectDir() });
    f.status(live, "В работе");
    expect(queueIn(f, work, config).out.split("\n").at(-1)).toStartWith("Next: no ready tasks — wait for the executors' answers");
  });

  it("облачный исполнитель в проекте с пачками — PR в main, как раньше", () => {
    const name = `batch/${day()}-1`;
    const r = task(new FakeGitHub(REC), ["queue", "--assignment", "47", "--cloud"], REPO, { ...inSession(batchSession(name)), cwd: projectDir() });
    expect(r.code).toBe(0);
    const lines = r.out.split("\n");
    expect(lines[0]).toEndWith("код и тесты, PR, зелёный CI, мерж, деплой.");
    expect(lines[1]).toBe(
      `- PR — в ветку по умолчанию с полным CI, а не в ветку пачки диспетчера \`${name}\`: диспетчер узнаёт о твоём конце только по закрытию задачи, а мерж в пачку её не закрывает;`,
    );
    // `#` в брифе — только у его задачи (docs/cloud-sessions.md, «The brief»)
    expect([...lines.slice(0, -1).join("\n").matchAll(/#(\d+)/g)].map((m) => m[1])).toEqual(["47"]);
    expect(lines.at(-1)).toContain(`a cloud executor isn't in the batch ${name} — its PR goes into the default branch with the full CI: the dispatcher learns of its end only by the task's closing; `);
  });
});

/**
 * Исполнитель диспетчера убрать свой worktree не может — он в нём работает, а `task close` ставит его на origin/main
 * (#515). В пилоте #471 диспетчер 16 раз проверял `git status` и убирал worktree руками, ещё 4 worktree с ветками
 * `worktree-agent-*` оставили субагенты исполнителя. Их убирает следующий `task queue` диспетчера — только worktree
 * агентов (`.claude/worktrees/agent-*`, как их заводит Claude Code) на origin/main или на ветке `worktree-agent-*`.
 */
/**
 * Выпуск пачки (#649, эпик #645): влитое в ветку пачки уходит в main одним PR — один полный прогон и один деплой на
 * пачку. Диспетчер выпускает, когда задачи группы влиты и исполнителей нет или по слову владельца «релизим» — тогда
 * живые исполнители не останавливаются (вопрос 2 эпика): их PR в пачку ждут выпуска и уходят в следующую пачку
 * диспетчера, а без неё — в main. git — настоящий во временном репозитории, spec-diff — подменённый процесс.
 */
// Выпуск пачки — общее для выпуска и его красного прогона (#650)
const SPEC_SECTION = "## Спека (тесты)\n\n### Добавлено (1)\n\n- `capabilities/export` · экспорт › выгружает задачи";
/** Коммит одного файла: правка манифеста проекта с пачками (.agents/elves.json) в чекауте не закоммичена. */
function commitFile(work: string, file: string, message: string): string {
  writeTree(work, { [file]: `${message}\n` });
  git(work, "add", file);
  git(work, "-c", "user.email=spec@example.test", "-c", "user.name=spec", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
  return git(work, "rev-parse", "HEAD");
}
/** Задача влита в ветку пачки: её коммит поверх пачки — в ветке задачи и в ветке пачки на origin, как rebase-мерж её PR. */
function mergeIntoBatch(work: string, batch: string, branch: string, file: string, message: string): void {
  git(work, "fetch", "-q", "origin");
  git(work, "switch", "-q", "-c", branch, `origin/${batch}`);
  commitFile(work, file, message);
  git(work, "push", "-q", "origin", `HEAD:refs/heads/${branch}`, `HEAD:refs/heads/${batch}`);
  git(work, "switch", "-q", "main");
}
/** Процессы выпуска: git — настоящий, origin — репозиторий GitHub; spec-diff — раздел спеки, вызовы — в `calls`. */
const releaseRun = (calls: string[][]) =>
  githubOrigin((cmd: string, args: string[], cwd?: string) => {
    if (cmd === "bun" && args[1] === OUTSIDE_SPEC) return calls.push(args), { status: 0, stdout: `${SPEC_SECTION}\n`, stderr: "" };
    return cmd !== "bun" ? realRun(cmd, args, cwd) : { status: 0, stdout: "", stderr: "" };
  });
function release(f: FakeGitHub, work: string, config: string, calls: string[][] = [], run: Io["run"] = releaseRun(calls)) {
  const out: string[] = [];
  const err: string[] = [];
  const env = { ELVES_EST: OUTSIDE_EST, ELVES_SPEC_DIFF: OUTSIDE_SPEC, ...inSession(config).env };
  const code = main(["batch", "release", "--repo", REPO], { gh: f.gh, out: (l) => out.push(l), err: (l) => err.push(l), run, cwd: work, env });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
/** pr premerge исполнителя — в той же сессии: маркер диспетчера называет его пачку. */
function premergeIn(f: FakeGitHub, work: string, config: string, pr: number) {
  const out: string[] = [];
  const code = main(["pr", "premerge", String(pr), "--repo", REPO], { gh: f.gh, out: (l) => out.push(l), err: (l) => out.push(l), run: noEst, cwd: work, env: inSession(config).env! });
  return { code, out: out.join("\n") };
}
const posted = (f: FakeGitHub) => f.rest.filter((r) => r.method === "POST" && r.route === `repos/${REPO}/pulls`).map((r) => r.payload);
const pull = (n: number) => `#${n} https://github.com/${REPO}/pull/${n}`;
/** Проект с пачками и первый запуск очереди: ветка пачки на origin — `batch/<день>-1`; `files` — коммит в main до неё. */
function started(files: Record<string, string> = {}) {
  const work = batchProjectDir(true);
  if (Object.keys(files).length) {
    writeTree(work, files);
    git(work, "add", ...Object.keys(files));
    git(work, "-c", "user.email=spec@example.test", "-c", "user.name=spec", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "chore: проект");
    git(work, "push", "-q", "origin", "main");
  }
  const f = new FakeGitHub(REC);
  const config = scratch();
  queueIn(f, work, config);
  return { work, f, config, name: `batch/${day()}-1` };
}

describe("Выпуск пачки — один PR в main", () => {
  it("PR выпуска несёт spec-diff пачки и Closes каждой влитой задачи", () => {
    const { work, f, config, name } = started();
    mergeIntoBatch(work, name, "feat/47-export", "export.txt", "feat(github): экспорт");
    mergeIntoBatch(work, name, "fix/49-y", "fix.txt", "fix(github): поправка");
    f.prs[300] = batchPr(47, "feat/47-export", name);
    f.prs[301] = batchPr(49, "fix/49-y", name);
    // живой исполнитель: его PR в пачку открыт — в выпуск он не идёт
    const live = subtaskOf45(f, "Живой исполнитель");
    f.prs[302] = { ...batchPr(live, `feat/${live}-live`, name), merged: false };
    const calls: string[][] = [];
    const r = release(f, work, config, calls);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const head = git(work, "rev-parse", `origin/${name}`);
    expect(calls).toEqual([["--no-env-file", OUTSIDE_SPEC, "--base", "origin/main", "--head", head]]);
    const lead = `Выпуск пачки \`${name}\` одним PR: полный CI и деплой — один раз на пачку. PR задач, влитые в неё: #300 (#47), #301 (#49).`;
    // заголовок — conventional commit по самому тяжёлому типу задач пачки
    expect(posted(f)).toEqual([{ title: `feat: выпуск пачки ${name} — #47, #49`, head: name, base: "main", body: `${lead}\n\n${SPEC_SECTION}\n\nCloses #47\nCloses #49\n` }]);
    const lines = r.out.split("\n");
    expect(lines).toContain(`○ PR #302 (#${live}) into ${name} is open — not in the release: its executor goes on, its pr premerge holds the merge till the release, then moves the PR to the next batch or main`);
    expect(lines).toContain(`+ the release PR ${pull(303)}: feat: выпуск пачки ${name} — #47, #49`);
    const next = lines.at(-1)!;
    // проект без auto — мерж выпуска по «да» владельца (#667)
    expect(next).toMatch(
      new RegExp(
        `^Next: the release PR #303 \\S+ — its checks: bash \\S+wait-ci\\.sh pr 303 as a background command; PASS — bun --no-env-file \\S+github\\.ts pr premerge 303, code 0 — the owner's «yes» \\(the project is without auto\\) — then gh pr merge 303 --rebase as a separate call\\. `,
      ),
    );
    expect(next).toMatch(/after the deploy and the refreshes' reports — task close of each task of the batch, GitHub closed them by the release's «Closes»: bun --no-env-file \S+github\.ts task close 47; bun --no-env-file \S+github\.ts task close 49 — /);
    // spec-diff нет — PR выпуска без раздела спеки, строка об этом
    const bare = new FakeGitHub(REC);
    bare.prs[300] = batchPr(47, "feat/47-export", name);
    const out: string[] = [];
    const env = { ELVES_SPEC_DIFF: path.join(OUTSIDE_GIT, "нет.ts"), ...inSession(config).env };
    expect(main(["batch", "release", "--repo", REPO], { gh: bare.gh, out: (l) => out.push(l), err: (l) => out.push(l), run: releaseRun([]), cwd: work, env })).toBe(0);
    expect(out).toContain(`○ spec-diff is not installed (${path.join(OUTSIDE_GIT, "нет.ts")}) — the release PR without the spec section`);
    expect(posted(bare)[0].body).toBe(`Выпуск пачки \`${name}\` одним PR: полный CI и деплой — один раз на пачку. PR задач, влитые в неё: #300 (#47).\n\nCloses #47\n`);
  });

  it("ветка пачки перед PR ребейзится на origin/main", () => {
    const { work, f, config, name } = started();
    mergeIntoBatch(work, name, "feat/47-export", "export.txt", "feat(github): экспорт");
    f.prs[300] = batchPr(47, "feat/47-export", name);
    // после старта пачки в main влит хотфикс мимо неё
    const main = commitFile(work, "hotfix.txt", "fix: хотфикс");
    git(work, "push", "-q", "origin", "main");
    const before = git(work, "rev-parse", `origin/${name}`);
    const calls: string[][] = [];
    const r = release(f, work, config, calls);
    expect(r.code).toBe(0);
    const after = git(work, "ls-remote", "origin", `refs/heads/${name}`).split("\t")[0]!;
    expect(after).not.toBe(before);
    expect(git(work, "rev-parse", `${after}~1`)).toBe(main);
    expect(git(work, "log", "--format=%s", `${main}..${after}`)).toBe("feat(github): экспорт");
    expect(r.out).toContain(`+ ${name} rebased onto origin/main (${main.slice(0, 7)}): ${before.slice(0, 7)} → ${after.slice(0, 7)}, pushed`);
    // spec-diff — по ребейзнутой пачке; временный worktree убран
    expect(calls[0]!.at(-1)).toBe(after);
    expect(git(work, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree "))).toHaveLength(1);
    // повторный запуск: PR выпуска открыт — его шаги, второго PR нет
    const again = release(f, work, config);
    expect(again.out.split("\n")[0]).toBe(`= the release PR ${pull(301)} of ${name} is open`);
    expect(posted(f)).toHaveLength(1);
  });

  it("конфликт ребейза ветки пачки на origin/main — ветка не меняется, PR выпуска нет", () => {
    const { work, f, config, name } = started();
    mergeIntoBatch(work, name, "feat/47-export", "same.txt", "feat(github): экспорт");
    f.prs[300] = batchPr(47, "feat/47-export", name);
    commitFile(work, "same.txt", "fix: хотфикс");
    git(work, "push", "-q", "origin", "main");
    const before = git(work, "rev-parse", `origin/${name}`);
    const r = release(f, work, config);
    expect(r.code).toBe(1);
    expect(r.out.split("\n").at(-1)).toStartWith(`! ${name} doesn't rebase onto origin/main: a conflict — same.txt — the branch is unchanged, no release PR. Rebase it by hand in the checkout:`);
    expect(git(work, "ls-remote", "origin", `refs/heads/${name}`).split("\t")[0]).toBe(before);
    expect(posted(f)).toEqual([]);
    expect(git(work, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree "))).toHaveLength(1);
  });

  it("задачи группы влиты в пачку и исполнителей нет — последняя строка task queue называет выпуск", () => {
    const { work, f, config, name } = started();
    f.prs[300] = batchPr(47, "feat/47-export", name);
    const r = queueIn(f, work, config);
    expect(headLines(r.out)).toContain(`= #47 «${f.issue(47).title}» — «В работе», PR #300 merged into ${name} — the task closes with the batch's release`);
    expect(r.out.split("\n").at(-1)).toMatch(
      new RegExp(`^Next: the batch ${name} is complete — nothing ready, every task of the batch is merged into it: its release — bun --no-env-file \\S+github\\.ts batch release --repo miroshnik/elves, once no executor of the batch is still at work; `),
    );
    // живой исполнитель — ждать его; выпуск — словом владельца
    const live = subtaskOf45(f, "Живой исполнитель");
    f.status(live, "В работе");
    f.prs[301] = { ...batchPr(live, `feat/${live}-live`, name), merged: false };
    const last = queueIn(f, work, config).out.split("\n").at(-1)!;
    expect(last).toStartWith("Next: no ready tasks — wait for the executors' answers; after each — task queue again; ");
    expect(last).toMatch(new RegExp(`; the owner's word to release now — bun --no-env-file \\S+github\\.ts batch release --repo miroshnik/elves: what is merged into ${name} goes, the live executors go on, no new ones till its merge\\.$`));
  });

  it("task queue называет выпуск, когда задачи пачки влиты, а задача мимо пачки ещё в работе", () => {
    const { work, f, config, name } = started();
    f.prs[300] = batchPr(47, "feat/47-export", name);
    // мимо пачки: PR в main открыт; облачный исполнитель — без PR
    const hotfix = subtaskOf45(f, "Хотфикс мимо пачки");
    f.status(hotfix, "В работе");
    f.prs[301] = { ...batchPr(hotfix, `fix/${hotfix}-hotfix`, "main"), merged: false };
    const cloud = subtaskOf45(f, "Облачный исполнитель");
    expect(task(f, ["queue", "--assignment", String(cloud), "--cloud"], REPO, { ...inSession(config), cwd: work, run: noEst }).code).toBe(0);
    const r = queueIn(f, work, config);
    expect(headLines(r.out)).toContain(`= #${hotfix} «${f.issue(hotfix).title}» — «В работе», open PR #301 https://github.com/${REPO}/pull/301`);
    expect(r.out.split("\n").at(-1)).toMatch(
      new RegExp(
        `^Next: the batch ${name} is complete — nothing ready, every task of the batch is merged into it: its release — bun --no-env-file \\S+github\\.ts batch release --repo miroshnik/elves, once no executor of the batch is still at work; past the batch — #${hotfix}, #${cloud}: they don't hold the release; `,
      ),
    );
  });

  it("task queue не называет выпуск, пока исполнитель пачки работает", () => {
    const { work, f, config, name } = started();
    f.prs[300] = batchPr(47, "feat/47-export", name);
    // выдан субагенту, PR ещё нет — исполнитель пачки
    const live = subtaskOf45(f, "Исполнитель пачки");
    expect(task(f, ["queue", "--assignment", String(live)], REPO, { ...inSession(config), cwd: work, run: noEst }).code).toBe(0);
    const last = queueIn(f, work, config).out.split("\n").at(-1)!;
    expect(last).toStartWith("Next: no ready tasks — wait for the executors' answers; after each — task queue again; ");
    expect(last).not.toContain("is complete");
  });

  it("выпуск по слову владельца при живых исполнителях не запускает новых", () => {
    const { work, f, config, name } = started();
    mergeIntoBatch(work, name, "feat/47-export", "export.txt", "feat(github): экспорт");
    f.prs[300] = batchPr(47, "feat/47-export", name);
    const live = subtaskOf45(f, "Живой исполнитель");
    f.status(live, "В работе");
    f.prs[301] = { ...batchPr(live, `feat/${live}-live`, name), merged: false };
    const waiting = subtaskOf45(f, "Ждёт в очереди");
    expect(headLines(queueIn(f, work, config).out)).toContain(`+ #${waiting} «GitHub · Ждёт в очереди»`);
    // «релизим»: влитое в пачку уходит, живой исполнитель работает дальше
    const r = release(f, work, config);
    expect(r.code).toBe(0);
    expect(posted(f)[0].body).toEndWith("\n\nCloses #47\n");
    const lines = headLines(queueIn(f, work, config).out);
    expect(lines.filter((l) => l.startsWith("+ #"))).toEqual([]);
    expect(lines).toContain(`○ #${waiting} «GitHub · Ждёт в очереди» — ready, held: the release of ${name} is open (PR #302) — no new executors till its merge`);
    expect(lines).toContain(`= #${live} «GitHub · Живой исполнитель» — «В работе», open PR ${pull(301)}`);
    expect(lines.at(-1)).toStartWith(
      `Next: the release of ${name} is open — PR ${pull(302)}: no new executors till its merge, the live executors' PRs into ${name} wait for it (pr premerge refuses the merge); `,
    );
    // PR живого исполнителя в пачку, пока выпуск открыт, не вливается: выпуск проверен без него
    const held = premergeIn(f, work, config, 301);
    expect(held.code).toBe(1);
    expect(held.out).toMatch(new RegExp(`^❌ don't merge: ${name} is being released — PR #302 into main: a merge into the batch now would change the release its CI checked\\. Wait for the release to close — bash \\S+wait-ci\\.sh issue 302 `));
  });

  it("диспетчер продолжает — открытые PR задач в ветку пачки до её удаления уходят на новую ветку пачки", () => {
    const { work, f, config, name } = started();
    mergeIntoBatch(work, name, "feat/47-export", "export.txt", "feat(github): экспорт");
    f.prs[300] = batchPr(47, "feat/47-export", name);
    const live = subtaskOf45(f, "Живой исполнитель");
    f.status(live, "В работе");
    f.prs[301] = { ...batchPr(live, `feat/${live}-live`, name), merged: false };
    expect(release(f, work, config).code).toBe(0);
    // выпуск влит, GitHub закрыл его задачи по «Closes»; у диспетчера — следующая задача: очередь заводит новую пачку,
    // а выпущенная остаётся, пока в неё открыт PR живого исполнителя
    Object.assign(f.prs[302]!, { merged: true, state: "MERGED" });
    f.closed(47);
    subtaskOf45(f, "Следующая задача");
    const next = `batch/${day()}-2`;
    const q = queueIn(f, work, config);
    expect(q.out).toContain(`○ batch branch ${name} kept: released by PR #302, open PR #301 into it — its executor moves it to the next batch or main first (pr premerge says where)`);
    expect(q.out).toContain(`+ batch branch ${next} from origin/main (${git(work, "rev-parse", "--short=7", "origin/main")}) pushed — ${name} is released by PR #302: the executors branch from it and merge into it`);
    expect(readFileSync(marker(config), "utf8")).toEndWith(`\nbatch ${REPO} ${next}\n`);
    // task close задачи выпуска ветку пачки с открытым PR в неё не удаляет; актуализация эпика #47 — у выпуска, её отчёт есть
    f.comments[45] = [{ body: "Актуализация после #47, итог: блок актуален", url: "https://github.com/miroshnik/elves/issues/45#issuecomment-47" }];
    const close = task(f, ["close", "47"], REPO, { run: noEst, cwd: work });
    expect(close.code).toBe(0);
    expect(close.out).toContain(`○ batch branch ${name} kept: open PR #301 into it — its executor moves it to the next batch or main first (pr premerge says where); then the dispatcher's task queue deletes the branch`);
    expect(remoteBatches(work).sort()).toEqual([name, next]);
    // pr premerge исполнителя переводит его PR в новую пачку диспетчера
    const moved = premergeIn(f, work, config, 301);
    expect(moved.code).toBe(1);
    expect(moved.out).toBe(
      `❌ don't merge: ${name} is released by PR #302 — the PR moves to ${next}: gh pr edit 301 --base ${next}, then git fetch origin ${next}, git rebase origin/${next} (the batch's commits are in it already — the rebase drops them), git push --force-with-lease, pr premerge 301 again; in the batch ${next} the task waits for its release, as before: no CI wait, no deploy wait, no epic refresh and no task close`,
    );
    // PR переведён — следующая очередь удаляет выпущенную ветку
    f.prs[301]!.base = next;
    expect(queueIn(f, work, config).out).toContain(`+ batch branch ${name} deleted: released by PR #302, no open PR into it`);
    expect(remoteBatches(work)).toEqual([next]);
  });

  it("после мержа выпуска и деплоя task close закрывает каждую задачу пачки, ветка пачки и ветки её задач удаляются", () => {
    const { work, f, config, name } = started();
    mergeIntoBatch(work, name, "feat/47-export", "export.txt", "feat(github): экспорт");
    mergeIntoBatch(work, name, "fix/49-y", "fix.txt", "fix(github): поправка");
    f.prs[300] = batchPr(47, "feat/47-export", name);
    f.prs[301] = batchPr(49, "fix/49-y", name);
    expect(release(f, work, config).code).toBe(0);
    Object.assign(f.prs[302]!, { merged: true, state: "MERGED" });
    f.closed(47);
    f.closed(49);
    // в группе осталась задача, которой ещё рано: эпик открыт, раздавать нечего
    const blocked = subtaskOf45(f, "Ждёт блокера", "--blocked-by", "42");
    f.comments[45] = [{ body: "Актуализация после #47, итог: блок актуален", url: "https://github.com/miroshnik/elves/issues/45#issuecomment-47" }];
    const first = task(f, ["close", "47"], REPO, { run: noEst, cwd: work });
    expect(first.code).toBe(0);
    expect(first.out).toContain(`+ remote branch ${name} deleted`);
    expect(first.out).toContain("+ local branch feat/47-export deleted");
    expect(first.out).toContain("+ remote branch feat/47-export deleted");
    const second = task(f, ["close", "49"], REPO, { run: noEst, cwd: work });
    expect(second.code).toBe(0);
    expect(second.out).toContain(`○ remote branch ${name} is already gone`);
    expect(second.out).toContain("+ remote branch fix/49-y deleted");
    // задачи закрыл GitHub по «Closes» выпуска — close ставит «Готово» и факт
    expect(byOp(f, "CloseIssue").map((m) => m.issueId)).not.toContain(f.issue(47).id);
    expect(byOp(f, "CloseIssue").map((m) => m.issueId)).not.toContain(f.issue(49).id);
    expect(statusSet(f)).toContainEqual([47, "Готово"]);
    expect(statusSet(f)).toContainEqual([49, "Готово"]);
    expect(remoteBatches(work)).toEqual([]);
    expect(git(work, "ls-remote", "--heads", "origin", "feat/47-export", "fix/49-y")).toBe("");
    // диспетчеру раздавать нечего — пустой новой пачки на origin он не оставляет
    const q = queueIn(f, work, config);
    expect(headLines(q.out)).toContain(`○ #${blocked} «GitHub · Ждёт блокера» — blocked by #42`);
    expect(q.out).toContain("○ no new batch branch: the previous one is released, nothing ready to hand out — a queue with a ready task starts it");
    expect(remoteBatches(work)).toEqual([]);
    expect(readFileSync(marker(config), "utf8")).not.toContain("\nbatch ");
  });

  /**
   * Актуализация эпика — у выпуска, а не у каждого мержа в пачку (#676): исполнитель пачки её не зовёт. Выпуск выкатил
   * задачи нескольких эпиков — по одной актуализации на эпик: её задание называет задачи эпика и их PR в пачку (PR
   * выпуска несёт файлы всей пачки), один отчёт на эпике закрывает каждую из них.
   */
  it("batch release после мержа выпуска — одна актуализация на эпик задач пачки, затем task close каждой задачи", () => {
    const { work, f, config, name } = started();
    // задачи пачки: #47 и третья — эпика #45, #49 — без эпика; в эпике остаётся открытая задача — актуализировать есть что
    const third = subtaskOf45(f, "Третья задача пачки");
    const waiting = subtaskOf45(f, "Ждёт следующей пачки");
    mergeIntoBatch(work, name, "feat/47-export", "export.txt", "feat(github): экспорт");
    mergeIntoBatch(work, name, "fix/49-y", "fix.txt", "fix(github): поправка");
    mergeIntoBatch(work, name, `feat/${third}-third`, "third.txt", "feat(github): третья");
    f.prs[300] = batchPr(47, "feat/47-export", name);
    f.prs[301] = batchPr(49, "fix/49-y", name);
    f.prs[302] = batchPr(third, `feat/${third}-third`, name);
    expect(release(f, work, config).code).toBe(0);
    Object.assign(f.prs[303]!, { merged: true, state: "MERGED" });
    for (const n of [47, 49, third]) f.closed(n);
    // шаги после мержа: ожидание деплоя и в том же ходе — одна команда актуализации на все задачи выпуска, затем task close
    const next = release(f, work, config).out.split("\n").at(-1)!;
    expect(next).toMatch(new RegExp(`in the same turn — the epic refresh, one per epic of the batch's tasks: bun --no-env-file \\S+github\\.ts task actualize 47 49 ${third} — it groups them by epic`));
    expect(next.indexOf("task actualize")).toBeLessThan(next.indexOf("task close 47"));
    // актуализация группирует по эпикам: эпик #45 — один субагент на #47 и третью, у #49 эпика нет
    const r = task(f, ["actualize", "47", "49", String(third)], REPO);
    expect(r.code).toBe(0);
    const lines = r.out.split("\n");
    expect(lines.filter((l) => l.startsWith("Next: a subagent"))).toHaveLength(1);
    expect(lines).toContain(`Задача #47, #${third} (эпик #45): актуализация блока после мержа — открытые задачи эпика привести в соответствие с выкаченным.`);
    expect(lines).toContainEqual(expect.stringContaining(` task actualize 47 ${third} --assignment --repo ${REPO}\``));
    expect(lines).toContain("○ refresh not needed: #49 has no epic. Next: task close 49 — after the deploy, where the merge deploys.");
    // задание: что выкатила каждая задача — её PR в пачку, а не PR выпуска; одна строка отчёта на обе
    const assignment = task(f, ["actualize", "47", String(third), "--assignment"], REPO).out;
    expect(assignment).toContain(
      `Выкачено: #47 «${f.issue(47).title}», PR #300, дифф — \`git log -p -E --grep '#47([^0-9]|$)' origin/main\`; #${third} «${f.issue(third).title}», PR #302, дифф — \`git log -p -E --grep '#${third}([^0-9]|$)' origin/main\`.`,
    );
    expect(assignment).not.toContain("PR #303");
    expect(assignment).toContain(`### #${waiting} «GitHub · Ждёт следующей пачки»`);
    expect(assignment).toContain(`комментарием к эпику #45 — «Актуализация после #47, #${third}, итог: …»`);
    expect(assignment).toContain(`По нему \`task close 47\`, \`task close ${third}\` видит, что актуализация закончена`);
    expect(task(f, ["actualize", "47", "49", "--assignment"], REPO).err).toBe("error: --assignment — the tasks of one epic, as its refresh prompt names them: #47 — epic #45; #49 — no epic");
    // до отчёта task close отказывает — по эпику: называет задачи эпика из выпуска и их актуализацию
    const early = task(f, ["close", String(third)], REPO, { run: noEst, cwd: work });
    expect(early.code).toBe(2);
    expect(early.err).toStartWith(
      `error: #${third} is too early to close: the epic refresh hasn't reported — epic #45 has open tasks besides #47, #${third} (1), and no comment «Актуализация после #47, #${third}, итог: …» on it. ` +
        `The release PR #303 shipped #47, #${third} of the epic — one refresh for them. The refresh subagent is at work — `,
    );
    expect(early.err).toContain(`it wasn't launched — task actualize 47 ${third} and the subagent with its prompt;`);
    expect(byOp(f, "CloseIssue")).toEqual([]);
    // один отчёт на эпике — task close каждой задачи эпика его принимает
    f.comments[45] = [{ body: `Актуализация после #47, #${third}, итог: блок актуален`, url: "https://github.com/miroshnik/elves/issues/45#issuecomment-676" }];
    for (const n of [47, third, 49]) expect(task(f, ["close", String(n)], REPO, { run: noEst, cwd: work }).code).toBe(0);
    expect(statusSet(f)).toEqual(expect.arrayContaining([[47, "Готово"], [third, "Готово"], [49, "Готово"]]));
  });
});

/**
 * Группа диспетчера (#698): в пилоте пачки владелец выбрал пять задач и запретил брать новые, а очередь по эпику этого
 * не знала — после выпуска она завела бы новую пачку из любых готовых задач, и диспетчер остановился, только не
 * запуская её; worktree исполнителей пачки ждали следующего запуска очереди, которого не было.
 */
/**
 * Метки решений задач пачки (#733): в пачке четыре исполнителя влили PR без `pr labels`, диспетчер заметил это после
 * выпуска. Шаг не зависит от памяти исполнителя: `pr premerge` не вливает PR без меток решений, которые он меняет, а
 * выпуск сверяет метки задач пачки с файлами их PR и ставит недостающие до PR выпуска.
 */
describe("PR в пачку вливается только с метками решений, выпуск ставит недостающие", () => {
  const EXPORT_TEST = "tests/capabilities/export/export.test.ts";

  it("PR задачи в пачку меняет файл решения без pr labels — pr premerge отказывает с кодом 1 и называет команду pr labels", () => {
    const { work, f, config, name } = started();
    f.prs[300] = { ...batchPr(47, "feat/47-export", name), merged: false, files: [EXPORT_TEST] };
    const held = premergeIn(f, work, config, 300);
    expect(held.code).toBe(1);
    expect(held.out).toMatch(
      /^❌ don't merge: PR #300 changes decisions without their labels — #47: export; epic #45: export: bun --no-env-file \S+github\.ts pr labels 300, then pr premerge 300 again$/,
    );
    expect(prLabels(f, 300).code).toBe(0);
    expect(issueLabels(f, 47)).toContain("export");
    expect(premergeIn(f, work, config, 300).out).not.toContain("without their labels");
  });

  it("batch release: у задачи пачки нет метки решения, которое менял её PR, — метка ставится задаче и эпику, строка +", () => {
    const { work, f, config, name } = started();
    mergeIntoBatch(work, name, "feat/47-export", "export.txt", "feat(github): экспорт");
    mergeIntoBatch(work, name, "fix/49-y", "fix.txt", "fix(github): поправка");
    f.prs[300] = { ...batchPr(47, "feat/47-export", name), files: [EXPORT_TEST] };
    f.prs[301] = batchPr(49, "fix/49-y", name);
    const r = release(f, work, config);
    expect(r.code).toBe(0);
    const lines = r.out.split("\n");
    expect(lines).toContain("+ #47: export");
    expect(lines).toContain("+ epic #45: export");
    expect(issueLabels(f, 47)).toContain("export");
    expect(issueLabels(f, 49)).not.toContain("export");
    // метки — до PR выпуска
    expect(lines.indexOf("+ #47: export")).toBeLessThan(lines.findIndex((l) => l.startsWith("+ the release PR")));
    // метки уже стоят — выпуск их не трогает
    const again = started();
    mergeIntoBatch(again.work, again.name, "feat/47-export", "export.txt", "feat(github): экспорт");
    again.f.prs[300] = { ...batchPr(47, "feat/47-export", again.name), files: [EXPORT_TEST] };
    expect(prLabels(again.f, 300).code).toBe(0);
    const before = again.f.mutations.length;
    const quiet = release(again.f, again.work, again.config);
    expect(quiet.out.split("\n").filter((l) => /^\+ (#|epic)/.test(l))).toEqual([]);
    expect(again.f.mutations.length).toBe(before);
  });
});

describe("Группа диспетчера — пачки только из выбранных задач", () => {
  /** Проект с пачками и группа из двух задач эпика; третья задача эпика готова, но вне группы. */
  function grouped() {
    const work = batchProjectDir(true);
    const f = new FakeGitHub(REC);
    const config = scratch();
    const a = subtaskOf45(f, "Первая группы");
    const b = subtaskOf45(f, "Вторая группы");
    const outside = subtaskOf45(f, "Вне группы");
    const queue = () => task(f, ["queue", "--tasks", `${a},${b}`], REPO, { ...inSession(config), cwd: work, run: noEst });
    /** Задача влита в пачку, выпуск влит в main: GitHub закрыл задачу по «Closes». */
    const shipped = (n: number, batch: string, pr: number) => {
      mergeIntoBatch(work, batch, `feat/${n}-x`, `${n}.txt`, `feat(github): #${n}`);
      f.prs[pr] = batchPr(n, `feat/${n}-x`, batch);
      expect(release(f, work, config).code).toBe(0);
      Object.assign(f.prs[pr + 1]!, { merged: true, state: "MERGED" });
      f.closed(n);
    };
    return { work, f, config, a, b, outside, queue, shipped };
  }

  it("task queue с группой задач раздаёт только её и после выпуска новую пачку заводит только из её оставшихся задач", () => {
    const { config, f, a, b, outside, queue, shipped } = grouped();
    const first = queue();
    expect(first.code).toBe(0);
    const lines = headLines(first.out);
    expect(lines).toContain(`Queue ${REPO} (tasks #${a}, #${b}): ready 2, «В работе» 0, not ready 0`);
    expect(lines.filter((l) => l.startsWith("+ #"))).toEqual([`+ #${a} «GitHub · Первая группы»`, `+ #${b} «GitHub · Вторая группы»`]);
    expect(first.out).not.toContain(`#${outside} `);
    // группа — в команде очереди маркера: её перечитывает каждый запуск и task resume
    expect(readFileSync(marker(config), "utf8").split("\n")[0]).toMatch(new RegExp(` task queue --tasks ${a},${b} --repo ${REPO}$`));
    // первая задача выпущена — новая пачка только из второй, задача вне группы в неё не идёт
    shipped(a, `batch/${day()}-1`, 300);
    const next = queue();
    expect(headLines(next.out).filter((l) => l.startsWith("+ batch branch batch/"))[1]).toStartWith(`+ batch branch batch/${day()}-2 from origin/main`);
    expect(headLines(next.out).filter((l) => l.startsWith("+ #"))).toEqual([`+ #${b} «GitHub · Вторая группы»`]);
    expect(next.out).not.toContain(`#${outside} `);
    expect(f.issue(outside).state).toBe("OPEN");
  });

  it("группа пуста после выпуска — последняя строка без новой пачки", () => {
    const { work, a, b, outside, queue, shipped } = grouped();
    queue();
    shipped(a, `batch/${day()}-1`, 300);
    queue();
    shipped(b, `batch/${day()}-2`, 302);
    const r = queue();
    expect(r.code).toBe(0);
    expect(r.out).toContain("○ no new batch branch: the previous one is released, nothing ready to hand out — a queue with a ready task starts it");
    expect(r.out).not.toContain(`#${outside} `);
    expect(r.out.split("\n").at(-1)).toContain(
      `The group (tasks #${a}, #${b}) has nothing left — no new batch: a task outside it joins only by the owner's word, task queue --tasks with it.`,
    );
    expect(remoteBatches(work).filter((b) => b === `batch/${day()}-3`)).toEqual([]);
  });

  // без перегиба: группа задаётся либо эпиком, либо списком
  it("--tasks и --epic вместе — отказ", () => {
    const r = task(new FakeGitHub(REC), ["queue", "--tasks", "47", "--epic", "45"], REPO, { ...inSession(scratch()), cwd: scratch(), run: noEst });
    expect(r.code).toBe(2);
    expect(r.err).toBe("error: --epic or --tasks, not both: the group is the epic's open tasks or the ones named");
  });

  it("выпуск убирает worktree и ветки исполнителей пачки", () => {
    const { work, f, config, name } = started();
    const AUTHOR = ["-c", "user.email=spec@example.test", "-c", "user.name=spec", "-c", "commit.gpgsign=false"];
    /** Исполнитель пачки: worktree агента на ветке задачи от пачки, выдача в сессии диспетчера. */
    const executor = (n: number, id: string) => {
      const dir = path.join(realpathSync(work), ".claude/worktrees", `agent-${id}`);
      git(work, "fetch", "-q", "origin");
      git(work, "worktree", "add", "-q", "-b", `feat/${n}-x`, dir, `origin/${name}`);
      expect(task(f, ["queue", "--assignment", String(n)], REPO, { ...inSession(config), cwd: dir, run: noEst }).code).toBe(0);
      return dir;
    };
    const done = executor(47, "a1");
    writeTree(done, { "export.txt": "export\n" });
    git(done, "add", "-A");
    git(done, ...AUTHOR, "commit", "-q", "-m", "feat(github): экспорт");
    git(done, "push", "-q", "origin", `HEAD:refs/heads/${name}`, "HEAD:refs/heads/feat/47-x");
    f.prs[300] = batchPr(47, "feat/47-x", name);
    // живой исполнитель: задача открыта, его worktree выпуск не трогает
    const live = subtaskOf45(f, "Живой исполнитель");
    const alive = executor(live, "a2");
    expect(release(f, work, config).code).toBe(0);
    // GitHub влил выпуск rebase-мержем и закрыл задачу по «Closes»
    git(work, "fetch", "-q", "origin");
    git(work, "push", "-q", "origin", `refs/remotes/origin/${name}:refs/heads/main`);
    Object.assign(f.prs[301]!, { merged: true, state: "MERGED" });
    f.closed(47);
    const r = release(f, work, config);
    expect(r.code).toBe(0);
    const lines = r.out.split("\n");
    expect(lines).toContain(`+ worktree ${done} removed with branch feat/47-x: clean, nothing outside origin/main`);
    expect(lines.at(-1)).toStartWith("Next: where the merge deploys");
    const worktrees = git(work, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice("worktree ".length));
    expect(worktrees.sort()).toEqual([realpathSync(work), alive].sort());
    expect(git(work, "branch", "--list", "feat/47-x")).toBe("");
    expect(git(work, "branch", "--list", `feat/${live}-x`, "--format=%(refname:short)")).toBe(`feat/${live}-x`);
  });
});

/**
 * Красный выпуск (#650, вопрос 3 эпика #645): полный набор впервые идёт на выпуске, и его красный называет виновную
 * задачу — по меткам решений упавших тестов, иначе бисектом по границам задач на машине; чинит её она же — PR в ветку
 * пачки с «Refs #N» после проверок перед коммитом, без CI, затем полный прогон выпуска заново на том же PR, без revert'а. Остальные задачи
 * пачки ждут выпуска. git — настоящий во временном репозитории; чеки выпуска и лог его упавшей джобы — фейка GitHub.
 */
describe("Красный выпуск чинится в пачке", () => {
  const EXPORT_TEST = "tests/capabilities/export/export.test.ts";
  /** Лог упавшей джобы, как его пишет bun test в Actions: время у каждой строки, заголовок файла, строка падения без пути. */
  const bunLog = (file: string) =>
    [`${file}:`, "(pass) экспорт > пустой список [0.10ms]", "(fail) экспорт > выгружает задачи [1.00ms]", "", " 1 pass", " 1 fail"].map((l) => `2026-10-22T10:00:00.1234567Z ${l}`).join("\n");
  /** Задачи пачки по умолчанию: #47 меняет решение export, #49 — другое. */
  const TASKS: [number, string, string][] = [
    [47, "feat/47-export", "export.txt"],
    [49, "fix/49-y", "fix.txt"],
  ];
  /**
   * Выпуск пачки: задачи влиты в неё коммитами с «Refs #N» (PR — с 300-го, решение каждого — export у файла export.txt,
   * иначе своё), выпуск — следующим PR, его чек tests красный: упал тест решения export. `labels` — метки задачам ставит
   * pr labels их PR в пачку; без них PR задач решений не меняют (только свой файл): недостающие метки решений выпуск
   * ставит сам (#733); `files` — проект в main до пачки.
   */
  function redRelease(o: { labels?: boolean; files?: Record<string, string>; tasks?: [number, string, string][]; prFiles?: string[][]; failed?: string } = {}) {
    const s = started(o.files);
    const tasks = o.tasks ?? TASKS;
    tasks.forEach(([n, branch, file], k) => {
      mergeIntoBatch(s.work, s.name, branch, file, `feat(github): задача ${n}\n\nRefs #${n}`);
      s.f.prs[300 + k] = { ...batchPr(n, branch, s.name), files: o.prFiles?.[k] ?? (o.labels ? [file === "export.txt" ? EXPORT_TEST : `tests/capabilities/t${n}/t${n}.test.ts`] : [file]) };
    });
    if (o.labels) tasks.forEach((_, k) => expect(prLabels(s.f, 300 + k).code).toBe(0));
    expect(release(s.f, s.work, s.config).code).toBe(0);
    const pr = 300 + tasks.length;
    Object.assign(s.f.prs[pr]!, { checks: { tests: "FAILURE" }, logs: { tests: bunLog(o.failed ?? EXPORT_TEST) } });
    return { ...s, pr };
  }

  it("упавший тест решения с меткой одной задачи пачки называет её виновной", () => {
    const { work, f, config, name, pr } = redRelease({ labels: true });
    // метки задачам — от их PR в пачку; PR выпуска их не ставит: каждой задаче достались бы метки всей пачки
    expect(issueLabels(f, 47)).toContain("export");
    expect(issueLabels(f, 49)).not.toContain("export");
    const before = f.mutations.length;
    const labels = prLabels(f, pr);
    expect(labels.code).toBe(0);
    expect(labels.out).toBe(
      `○ PR #${pr} is the release of the batch ${name}: its tasks got their decision labels from their PRs into the batch — ` +
        "the release's diff would give each task the whole batch's, and a red release names its guilty task by them: no labels",
    );
    expect(f.mutations.length).toBe(before);
    const r = release(f, work, config);
    expect(r.code).toBe(0);
    const lines = r.out.split("\n");
    expect(lines[0]).toBe(`! the release PR ${pull(pr)} of ${name} is red: tests`);
    expect(lines).toContain(`○ the failed checks' logs name ${EXPORT_TEST}`);
    expect(lines).toContain(`guilty: #47 «${f.issue(47).title}» — the label export — the failed files' decision export`);
    // ни бисекта, ни второго PR выпуска
    expect(lines.filter((l) => l.startsWith("bisect"))).toEqual([]);
    expect(posted(f)).toHaveLength(1);
  });

  /** Тема export с разделами (#689): метка — у темы, раздел своей не имеет; упал тест раздела csv. */
  const CSV_TEST = "tests/capabilities/export/csv.test.ts";

  it("batch release: из двух задач с лейблом темы упавшего теста виновна та, чей PR менял файлы его раздела", () => {
    // обе задачи меняют тему export — обе с её меткой; раздел csv — только #49
    const { work, f, config } = redRelease({ labels: true, failed: CSV_TEST, prFiles: [["tests/capabilities/export/json.test.ts"], ["tests/capabilities/export/csv.md", CSV_TEST]] });
    expect(issueLabels(f, 47)).toContain("export");
    expect(issueLabels(f, 49)).toContain("export");
    const lines = release(f, work, config).out.split("\n");
    expect(lines).toContain(
      `guilty: #49 «${f.issue(49).title}» — the label export — the failed files' decision export; of #47, #49 only its PR #301 into the batch changed the section's files tests/capabilities/export/csv.*`,
    );
    expect(lines.filter((l) => l.startsWith("bisect") || l.startsWith("! bisect"))).toEqual([]);
  });

  it("batch release: файлы раздела не меняла ни одна задача — бисект по границам задач, как сейчас", () => {
    const { work, f, config } = redRelease({ labels: true, failed: CSV_TEST, prFiles: [["tests/capabilities/export/json.test.ts"], ["tests/capabilities/export/export.md"]] });
    const lines = release(f, work, config).out.split("\n");
    expect(lines).toContain("○ the section's files tests/capabilities/export/csv.* — no PR into the batch of #47, #49 changed them");
    expect(lines).toContain("○ the failed files' decision export — the labels of #47, #49: not one task — no guilty task by the labels");
    expect(lines).toContainEqual(expect.stringMatching(/^bisect: \S+ over origin\/main \([0-9a-f]{7}\) — 2 task blocks: #47 \(1 commit\), #49 \(1 commit\)$/));
    expect(lines.filter((l) => l.startsWith("guilty"))).toEqual([]);
  });

  it("без однозначной метки бисект по границам задач называет первую красную", () => {
    // проект: test — проверка, которую ломает broken.txt; её ломает #49, средняя из трёх задач пачки
    const files = {
      "package.json": JSON.stringify({ name: "x", private: true, scripts: { test: "sh check.sh" } }) + "\n",
      "bun.lock": "{}\n",
      "check.sh": '[ ! -e broken.txt ] || { echo "(fail) экспорт > выгружает задачи" >&2; exit 1; }\n',
      [EXPORT_TEST]: "// экспорт\n",
    };
    const tasks: [number, string, string][] = [
      [47, "feat/47-export", "export.txt"],
      [49, "fix/49-y", "broken.txt"],
      [42, "feat/42-z", "other.txt"],
    ];
    const { work, f, config, name, pr } = redRelease({ files, tasks });
    /** Процессы: git — настоящий, установка — подменена, скрипт проекта — настоящий sh в worktree бисекта; прогоны — в `runs`. */
    const runs: string[] = [];
    const run = githubOrigin((cmd: string, args: string[], cwd?: string) => {
      if (cmd === "bun" && args[0] === "install") return { status: 0, stdout: "", stderr: "" };
      if (cmd === "bun" && args[0] === "run") {
        runs.push(`${git(cwd!, "log", "-1", "--format=%s")}: ${args.slice(2).join(" ")}`);
        const script = JSON.parse(readFileSync(path.join(cwd!, "package.json"), "utf8")).scripts[args[1]!];
        return realRun("sh", ["-c", `${script} "$@"`, "sh", ...args.slice(2)], cwd);
      }
      return cmd !== "bun" ? realRun(cmd, args, cwd) : { status: 0, stdout: "", stderr: "" };
    });
    const r = release(f, work, config, [], run);
    expect(r.code).toBe(0);
    const lines = r.out.split("\n");
    // меток решения export у задач нет — бисект
    expect(lines).toContain("○ the failed files' decision export — no task of the release has the label — no guilty task by the labels");
    expect(lines).toContain(`bisect: the check — bun run test ${EXPORT_TEST}; the head, the base, then 2 runs`);
    // голова красная, база зелёная, затем ⌈log₂3⌉ = 2 прогона: после #47 — зелёный, после #49 — красный
    expect(runs).toEqual(["feat(github): задача 42", "chore: проект", "feat(github): задача 47", "feat(github): задача 49"].map((s) => `${s}: ${EXPORT_TEST}`));
    const probes = lines.filter((l) => /^○ ([0-9a-f]{7} — after #\d+|the base [0-9a-f]{7}): /.test(l)).map((l) => l.replace(/^○ [0-9a-f]{7} — |^○ the base [0-9a-f]{7}/, ""));
    expect(probes).toEqual(["after #42: red", ": green", "after #47: green", "after #49: red"]);
    expect(lines).toContainEqual(expect.stringMatching(new RegExp(`^guilty: #49 «${f.issue(49).title}» — the first red task block of the bisect \\([0-9a-f]{7}\\)$`)));
    expect(lines.at(-2)).toStartWith(`Next: the release PR ${pull(pr)} of ${name} is red (tests) — the guilty task #49 «${f.issue(49).title}» fixes it in the batch: `);
    // временный worktree бисекта убран
    expect(git(work, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree "))).toHaveLength(1);
  });

  it("починка — PR виновной задачи в ветку пачки с Refs #N, затем полный прогон выпуска заново", () => {
    const { work, f, config, name, pr } = redRelease({ labels: true });
    // исполнитель #47 открыл PR починки в пачку: новая ветка задачи, в теле — Refs #47
    f.prs[pr + 1] = { files: [EXPORT_TEST], closes: [], body: "Починка красного выпуска.\n\nRefs #47", head: "fix/47-red-release", base: name, model: null, merged: false };
    // метки PR починки — задаче по её ветке: «Closes #N» в теле нет
    expect(prLabels(f, pr + 1).out.split("\n")[0]).toBe(`PR #${pr + 1} → #47: export`);
    const fixing = release(f, work, config).out.split("\n");
    expect(fixing).toContain(`○ the fix PR #${pr + 1} (#47) into ${name} is open — its executor goes on; after its merge the release's full run goes again on PR #${pr}`);
    expect(fixing.filter((l) => l.startsWith("guilty") || l.startsWith("bisect"))).toEqual([]);
    expect(fixing.at(-1)).toStartWith(
      `Next: the release PR ${pull(pr)} of ${name} is red (tests): its fix PR #${pr + 1} into ${name} is open — wait for its executor's answer; ` +
        `after its merge into ${name} — the release's full run again on the same PR #${pr}: batch release prints its steps; the other tasks of the batch wait — no new executors till the release's merge; `,
    );
    // починка влита в пачку: голова выпуска сдвинулась — полный прогон заново на том же PR, второго PR выпуска нет
    mergeIntoBatch(work, name, "fix/47-red-release", "export-fix.txt", "fix(github): починка экспорта\n\nRefs #47");
    Object.assign(f.prs[pr + 1]!, { merged: true, state: "MERGED" });
    for (const tests of ["IN_PROGRESS", "SUCCESS"]) {
      f.prs[pr]!.checks = { tests };
      const again = release(f, work, config).out.split("\n");
      expect(again[0]).toBe(`= the release PR ${pull(pr)} of ${name} is open`);
      expect(again.at(-1)).toStartWith(`Next: the release PR ${pull(pr)} — its checks: bash `);
    }
    expect(posted(f)).toHaveLength(1);
    expect(f.prs[pr]!.body).toEndWith("Closes #47\nCloses #49\n");
  });

  it("задание починки называет PR выпуска и упавшие проверки, ветка — от ветки пачки, а не прежняя ветка задачи", () => {
    const { work, f, config, name, pr } = redRelease({ labels: true });
    // задача влита в пачку и «В работе», её ветка feat/47-export есть: без красного выпуска это был бы перезапуск
    f.status(47, "В работе");
    const assignment = (...more: string[]) => task(f, ["queue", "--assignment", "47", ...more], REPO, { ...inSession(config), cwd: work, run: noEst });
    const lines = assignment().out.split("\n");
    expect(lines[0]).toStartWith(
      `Задача #47 «${f.issue(47).title}» в ${REPO} (эпик #45): ты исполнитель сессии-диспетчера — починка в пачке \`${name}\`: её PR выпуска #${pr} красный (tests), а задача, уже влитая в пачку, названа виновной — `,
    );
    expect(lines[0]).toContain(
      `task status 47 "В работе" --branch fix/47-<slug>\`, новая ветка от свежего origin/${name} (\`git fetch origin ${name}\`, затем ветка на \`origin/${name}\`), а не от прежней ветки задачи \`feat/47-export\` — она уже в пачке, влита rebase-мержем, причина — по упавшим проверкам (\`gh pr checks ${pr}\`, их логи)`,
    );
    expect(lines[0]).toContain(`коммиты с \`Refs #47\`, проверки перед коммитом, PR в пачку (\`gh pr create --base ${name}\`, в теле \`Refs #47\`)`);
    expect(lines[0]).toEndWith(`Ожидания CI, деплоя, актуализации эпика и \`task close\` нет: после мержа диспетчер гонит выпуск заново — полный прогон на том же PR #${pr}.`);
    // строки перезапуска «продолжи её работу» на влитой ветке нет; CI на PR починки в пачку не идёт — не ждать
    expect(lines.filter((l) => l.startsWith("Задача уже «В работе»"))).toEqual([]);
    expect(lines.find((l) => l.startsWith("- CI не жди"))).toBeDefined();
    expect(lines.filter((l) => l.includes("wait-ci.sh"))).toEqual([]);
    // сессия-исполнитель приложения — та же починка; облачный исполнитель не в пачке — отказ
    expect(assignment("--session").out.split("\n")[0]).toContain(`ты сессия-исполнитель сессии-диспетчера — починка в пачке \`${name}\`: её PR выпуска #${pr} красный (tests)`);
    const cloud = assignment("--cloud");
    expect(cloud.code).toBe(2);
    expect(cloud.err).toBe(`error: #47 is in the red release PR #${pr} of ${name}: its fix goes into the batch, and a cloud executor isn't in the batch — a subagent or an app executor session`);
    // выпуск позеленел — задание обычное для пачки
    f.prs[pr]!.checks = { tests: "SUCCESS" };
    expect(assignment().out.split("\n")[0]).toContain(`задача идёт в пачку \`${name}\``);
  });

  it("Next: очереди и шаги batch release на красном выпуске называют виновную задачу и её починку", () => {
    const { work, f, config, name, pr } = redRelease({ labels: true });
    const title = f.issue(47).title;
    const queue = queueIn(f, work, config).out.split("\n");
    expect(queue).toContain(`guilty: #47 «${title}» — the label export — the failed files' decision export`);
    const next = queue.at(-2)!;
    expect(next).toStartWith(`Next: the release PR ${pull(pr)} of ${name} is red (tests) — the guilty task #47 «${title}» fixes it in the batch: its executor — continued with SendMessage, the indented line its message; `);
    expect(next).toContain(`Its assignment (task queue --assignment 47) names the red release: a new task branch from origin/${name}, the PR into ${name} with Refs #47, the checks before a commit, no CI; `);
    expect(next).toContain(`after its merge into ${name} — the release's full run again on the same PR #${pr}: batch release prints its steps; the other tasks of the batch wait — no new executors till the release's merge; `);
    // отступ — промпт её исполнителя, как у готовой задачи очереди
    expect(queue.at(-1)).toMatch(/^ {2}Задача #47 в miroshnik\/elves \(эпик #45\): ты исполнитель сессии-диспетчера\. Задание целиком печатает `bun --no-env-file \S+github\.ts task queue --assignment 47 --repo miroshnik\/elves`/);
    // batch release называет то же — одним текстом
    expect(release(f, work, config).out.split("\n").slice(-2)).toEqual(queue.slice(-2));
    // меток нет — очередь называет batch release: бисект — его
    const bare = redRelease();
    const last = queueIn(bare.f, bare.work, bare.config).out.split("\n").at(-1)!;
    expect(last).toMatch(
      new RegExp(`^Next: the release PR #${bare.pr} \\S+ of ${bare.name} is red \\(tests\\) — the guilty task: bun --no-env-file \\S+github\\.ts batch release --repo miroshnik/elves names it \\(the labels of the failed tests' decisions, otherwise a bisect by the task boundaries on the machine — a background command\\) and prints its fix; `),
    );
  });
});

describe("task queue убирает worktree исполнителей закрытых задач", () => {
  const AUTHOR = ["-c", "user.email=spec@example.test", "-c", "user.name=spec"];
  /** Чекаут диспетчера на main; worktree агентов — в его `.claude/worktrees`, как их заводит Claude Code (`isolation: "worktree"`). */
  function dispatcher() {
    const c = checkout("fix/49-x");
    temp.push(c.cleanup);
    // путь — как его называет git: без симлинков временного каталога (/var → /private/var на macOS)
    const work = realpathSync(c.work);
    git(work, "switch", "-q", "main");
    const add = (name: string, opts: string[] = ["--detach"], from = "origin/main") => {
      const dir = path.join(work, ".claude/worktrees", name);
      git(work, "worktree", "add", "-q", ...opts, dir, from);
      return dir;
    };
    const commit = (dir: string, file: string) => {
      writeTree(dir, { [file]: `${file}\n` });
      git(dir, "add", "-A");
      git(dir, ...AUTHOR, "commit", "-q", "-m", file);
      return git(dir, "rev-parse", "HEAD");
    };
    /** PR влит rebase-мержем, как на GitHub: в main — копия коммита с другим SHA. */
    const rebaseMerged = (sha: string) => {
      git(work, ...AUTHOR, "cherry-pick", sha);
      git(work, "push", "-q", "origin", "main");
    };
    /** Очередь диспетчера; его выдачи исполнителям — в каталоге конфигурации `config`, задачи — в `f`, его субагенты — в `claude`. */
    const queue = (f = new FakeGitHub(REC), config = scratch(), claude = scratch()) =>
      task(f, ["queue", "--epic", "45"], REPO, { env: { ...inSession(config).env, CLAUDE_CONFIG_DIR: claude }, run: noEst, cwd: work }).out.split("\n");
    /** Строки о worktree и ветках агентов — до заголовка очереди. */
    const cleanupLines = (out: string[]) => out.slice(0, out.findIndex((l) => l.startsWith("Queue ")));
    const worktrees = () =>
      git(work, "worktree", "list", "--porcelain")
        .split("\n")
        .filter((l) => l.startsWith("worktree "))
        .map((l) => l.slice("worktree ".length))
        .sort();
    const branches = () => git(work, "branch", "--list", "worktree-agent-*", "--format=%(refname:short)").split("\n").filter(Boolean);
    return { work, add, commit, rebaseMerged, queue, cleanupLines, worktrees, branches };
  }

  it("чистый worktree исполнителя закрытой задачи убирается со строкой о нём", () => {
    const d = dispatcher();
    // исполнитель закрыл задачу: task close поставил его worktree на origin/main
    const closed = d.add("agent-a0008f7e219bfb5c5");
    // субагент исполнителя: коммит на ветке worktree-agent-*, исполнитель перенёс его в свой PR, PR влит
    const sub = d.add("agent-af17f6db7baf535f7", ["-b", "worktree-agent-af17f6db7baf535f7"], "main");
    d.rebaseMerged(d.commit(sub, "budget.md"));
    const out = d.queue();
    expect(d.cleanupLines(out)).toEqual([
      `+ worktree ${closed} removed: clean, nothing outside origin/main`,
      `+ worktree ${sub} removed with branch worktree-agent-af17f6db7baf535f7: clean, nothing outside origin/main`,
    ]);
    expect(out[2]).toStartWith("Queue miroshnik/elves (epic #45): ");
    expect(d.worktrees()).toEqual([d.work]);
    expect(d.branches()).toEqual([]);
  });

  it("worktree с незакоммиченными изменениями или невлитыми коммитами остаётся, строка называет причину", () => {
    const d = dispatcher();
    const dirty = d.add("agent-a1");
    writeTree(dirty, { "draft.md": "черновик\n" });
    const ahead = d.add("agent-a2", ["-b", "worktree-agent-a2"], "main");
    d.commit(ahead, "work.md");
    d.commit(ahead, "more.md");
    const both = d.add("agent-a3", ["-b", "worktree-agent-a3"], "main");
    d.commit(both, "work.md");
    writeTree(both, { "README.md": "правка\n", "draft.md": "черновик\n" });
    expect(d.cleanupLines(d.queue())).toEqual([
      `○ worktree ${dirty} left: 1 uncommitted file`,
      `○ worktree ${ahead} left: 2 commits not in origin/main`,
      `○ worktree ${both} left: 2 uncommitted files, 1 commit not in origin/main`,
    ]);
    expect(d.worktrees()).toEqual([d.work, dirty, ahead, both].sort());
    expect(readFileSync(path.join(dirty, "draft.md"), "utf8")).toBe("черновик\n");
    expect(d.branches()).toEqual(["worktree-agent-a2", "worktree-agent-a3"]);
  });

  /**
   * Claude Code блокирует worktree работающего агента (`git worktree lock`, причина — `claude agent … (pid N …)`) и
   * снимает блокировку, когда агент закончил; после перезапуска приложения блокировку держит процесс, которого нет.
   * Worktree сессии и worktree агента на ветке задачи — чужая работа: задача не закрыта, их очередь не трогает.
   */
  it("worktree работающего агента, сессии и агента на ветке задачи не трогаются; блокировка процесса, которого нет, не держит", () => {
    const d = dispatcher();
    const running = d.add("agent-a1", ["--lock", "--reason", `claude agent agent-a1 (pid ${process.pid} start Wed Oct 14 11:43:51 2026)`, "-b", "worktree-agent-a1"], "main");
    const orphan = d.add("agent-a2", ["--detach", "--lock", "--reason", "claude agent agent-a2 (pid 99999999 start Wed Oct 14 11:43:51 2026)"]);
    const session = d.add("bold-raman-12428f");
    const taskBranch = d.add("agent-a3", ["-b", "feat/50-export"], "main");
    expect(d.cleanupLines(d.queue())).toEqual([`+ worktree ${orphan} removed: clean, nothing outside origin/main`]);
    expect(d.worktrees()).toEqual([d.work, running, session, taskBranch].sort());
    expect(d.branches()).toEqual(["worktree-agent-a1"]);
  });

  /**
   * Исполнитель, которого диспетчер ещё продолжит через `SendMessage`, держит чистый worktree на ветке `worktree-agent-*`
   * без блокировки (#533): ответив «вопрос» до «В работе» — блокировку Claude Code снял, когда он закончил ответ; на шаге
   * вопросов после перезапуска приложения — продолженному сообщением блокировку не ставят. Очередь убрала бы worktree с
   * веткой, а ответ владельца пришёл бы исполнителю без каталога. Выдача (`--assignment` в сессии-диспетчере) помнит
   * worktree исполнителя — каталог, где он позвал задание.
   */
  function handedOutTo(d: ReturnType<typeof dispatcher>) {
    const f = new FakeGitHub(REC);
    f.status(47, "Бэклог");
    const config = scratch();
    // очередь пометила сессию диспетчером; исполнитель позвал задание из своего worktree и ответил — блокировки нет
    d.queue(f, config);
    const executor = d.add("agent-a1", ["-b", "worktree-agent-a1"], "main");
    expect(task(f, ["queue", "--assignment", "47"], REPO, { ...inSession(config), run: noEst, cwd: executor }).code).toBe(0);
    return { f, config, executor };
  }

  it("task queue не убирает чистый worktree исполнителя, чья выданная задача открыта", () => {
    const d = dispatcher();
    const { f, config, executor } = handedOutTo(d);
    const out = d.queue(f, config);
    expect(d.cleanupLines(out)).toEqual([]);
    expect(out).toContain(`= #47 «${f.issue(47).title}» — handed out to an executor of this session`);
    expect(d.worktrees()).toEqual([d.work, executor].sort());
    expect(d.branches()).toEqual(["worktree-agent-a1"]);
  });

  // без перегиба: выдача держит worktree, пока задача открыта, — закрыл её исполнитель, worktree уходит
  it("worktree исполнителя закрытой задачи task queue убирает, как прежде", () => {
    const d = dispatcher();
    const { f, config, executor } = handedOutTo(d);
    f.closed(47);
    expect(d.cleanupLines(d.queue(f, config))).toEqual([`+ worktree ${executor} removed with branch worktree-agent-a1: clean, nothing outside origin/main`]);
    expect(d.worktrees()).toEqual([d.work]);
    expect(d.branches()).toEqual([]);
  });

  it("ветка worktree-agent-* без worktree: без невлитых коммитов удаляется, с невлитыми — остаётся строкой ○", () => {
    const d = dispatcher();
    // исполнитель завёл ветку задачи от свежего origin/main, ветка worktree-agent-* осталась без worktree
    git(d.work, "branch", "worktree-agent-a1", "main");
    const left = d.add("agent-a2", ["-b", "worktree-agent-a2"], "main");
    d.commit(left, "work.md");
    git(d.work, "worktree", "remove", left);
    expect(d.cleanupLines(d.queue())).toEqual(["+ branch worktree-agent-a1 deleted: nothing outside origin/main", "○ branch worktree-agent-a2 left: 1 commit not in origin/main"]);
    expect(d.branches()).toEqual(["worktree-agent-a2"]);
  });

  /**
   * Субагент без своего worktree работает в каталоге того, кто его запустил (#571): исполнитель закрыл задачу и ответил,
   * а его актуализация эпика ещё шла в его worktree — блокировки нет, HEAD на origin/main, правок нет, и очередь убрала
   * worktree: субагент остался без каталога, Bash отказывал в любой команде. Такого субагента называют метаданные
   * субагентов сессии — `parentAgentId` без своего `worktreePath`, на любую глубину, — а работает он, пока пишется его
   * транскрипт.
   */
  function executorWithSubagents(d: ReturnType<typeof dispatcher>) {
    // исполнитель закрыл задачу: task close поставил его worktree на origin/main
    const executor = d.add("agent-a1");
    const claude = scratch();
    const subagents = `projects/-work/${SESSION}/subagents`;
    const meta = (fields: Record<string, unknown>) => JSON.stringify({ agentType: "general-purpose", ...fields });
    /** Субагент сессии: метаданные и транскрипт, записанный `minutes` минут назад. */
    const subagent = (id: string, fields: Record<string, unknown>, minutes: number) => {
      writeTree(claude, { [`${subagents}/agent-${id}.meta.json`]: meta(fields), [`${subagents}/agent-${id}.jsonl`]: "{}\n" });
      const at = new Date(Date.now() - minutes * 60_000);
      utimesSync(path.join(claude, subagents, `agent-${id}.jsonl`), at, at);
    };
    subagent("a1", { worktreePath: executor, spawnDepth: 1 }, 0);
    return { executor, claude, subagent };
  }

  it("worktree исполнителя, в котором работает его субагент, не удаляется", () => {
    const d = dispatcher();
    const { executor, claude, subagent } = executorWithSubagents(d);
    // актуализация эпика — без своего worktree, её транскрипт пишется
    subagent("a7", { parentAgentId: "a1", spawnDepth: 2 }, 2);
    expect(d.cleanupLines(d.queue(undefined, undefined, claude))).toEqual([
      `○ worktree ${executor} left: subagent agent-a7 works in it without a worktree of its own — its transcript written 2 min ago, quiet after 15`,
    ]);
    expect(d.worktrees()).toEqual([d.work, executor].sort());
    // субагент актуализации затих, а работает его субагент — тоже без своего worktree, в том же каталоге
    subagent("a7", { parentAgentId: "a1", spawnDepth: 2 }, 30);
    subagent("a8", { parentAgentId: "a7", spawnDepth: 3 }, 0);
    expect(d.cleanupLines(d.queue(undefined, undefined, claude))).toEqual([
      `○ worktree ${executor} left: subagent agent-a8 works in it without a worktree of its own — its transcript written 0 min ago, quiet after 15`,
    ]);
  });

  // без перегиба: затихший субагент и субагент в своём worktree каталог исполнителя не держат
  it("субагент исполнителя затих или работает в своём worktree — worktree исполнителя убирается, как прежде", () => {
    const d = dispatcher();
    const { executor, claude, subagent } = executorWithSubagents(d);
    subagent("a7", { parentAgentId: "a1", spawnDepth: 2 }, 15);
    subagent("a9", { parentAgentId: "a1", worktreePath: path.join(d.work, ".claude/worktrees/agent-a9"), spawnDepth: 2 }, 0);
    expect(d.cleanupLines(d.queue(undefined, undefined, claude))).toEqual([`+ worktree ${executor} removed: clean, nothing outside origin/main`]);
    expect(d.worktrees()).toEqual([d.work]);
  });
});

/**
 * Владелец по ответу «сломалось» исполнителя #545 решил перезапустить задачу, а прежний исполнитель был жив: его разбудили
 * ответы двух его фоновых субагентов (#565). Диспетчер запустил второго, задание отправило его в worktree ветки задачи —
 * и два исполнителя шли параллельно. Прежний исполнитель мёртв, только когда ни один его worktree и ни один worktree его
 * субагентов не заблокирован живым процессом и не получает коммитов: продолженного агента Claude Code не блокирует
 * (#533), живым его видно по коммитам. Его субагентов называют метаданные субагентов Claude Code (`parentAgentId`).
 */
describe("task queue не выдаёт задачу второму исполнителю при живом прежнем", () => {
  /** Давнее время коммитов и переключений: worktree, которого с тех пор не трогали, затих. */
  const LONG_AGO = "2026-01-01T00:00:00Z";
  const quietGit = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_COMMITTER_DATE: LONG_AGO } }).trim();
  /** Блокировка, которую Claude Code ставит на worktree работающего агента. */
  const lock = (pid: number, agent: string) => `claude agent ${agent} (pid ${pid} start Thu Oct 15 10:10:30 2026)`;
  /** pid процесса, которого нет: блокировка осталась от приложения до перезапуска. */
  const DEAD = 99999999;

  /**
   * Задача #47 «В работе»: прежний исполнитель (agent-a1) взял её на ветку feat/47-export в своём worktree и позвал задание
   * оттуда, его субагент (agent-a2) и субагент субагента (agent-a5) — в своих worktree, о них — метаданные Claude Code;
   * новый исполнитель — agent-a3. Все затихли давно и без блокировок — живое каждый тест задаёт сам.
   */
  function restart() {
    const c = checkout("fix/49-x");
    temp.push(c.cleanup);
    // путь — как его называет git: без симлинков временного каталога (/var → /private/var на macOS)
    const work = realpathSync(c.work);
    git(work, "switch", "-q", "main");
    const add = (name: string, branch: string) => {
      const dir = path.join(work, ".claude/worktrees", name);
      quietGit(work, "worktree", "add", "-q", "-b", branch, dir, "main");
      return dir;
    };
    const f = new FakeGitHub(REC);
    f.status(47, "В работе");
    const config = scratch();
    const claude = scratch();
    const env = { ...inSession(config).env, CLAUDE_CONFIG_DIR: claude };
    const assignment = (cwd: string) => task(f, ["queue", "--assignment", "47"], REPO, { env, run: noEst, cwd });
    const previous = add("agent-a1", "feat/47-export");
    // без перегиба: первая выдача проходит
    expect(assignment(previous).code).toBe(0);
    const sub = add("agent-a2", "worktree-agent-a2");
    const deeper = add("agent-a5", "worktree-agent-a5");
    const meta = (worktreePath: string, parentAgentId: string, spawnDepth: number) => JSON.stringify({ agentType: "general-purpose", worktreePath, parentAgentId, spawnDepth });
    writeTree(claude, {
      [`projects/-work/${SESSION}/subagents/agent-a2.meta.json`]: meta(sub, "a1", 2),
      [`projects/-work/${SESSION}/subagents/agent-a5.meta.json`]: meta(deeper, "a2", 3),
    });
    const next = add("agent-a3", "worktree-agent-a3");
    const handOuts = () => readFileSync(path.join(config, "dispatchers", `${SESSION}.tasks`), "utf8").trim().split("\n");
    return { work, add, previous, sub, deeper, next, claude, again: () => assignment(next), handOuts };
  }

  it("task queue не выдаёт задачу повторно, пока жив worktree её прежнего исполнителя или его субагентов", () => {
    const r = restart();
    const refused = (line: (l: string) => boolean) => {
      const a = r.again();
      expect(a.code).toBe(1);
      const lines = a.out.split("\n");
      expect(lines.filter((l) => l.startsWith("! "))).toEqual([expect.anything()]);
      expect(line(lines[0]!)).toBe(true);
      expect(lines.slice(1)).toEqual([
        "Задача #47 в miroshnik/elves: у задачи жив прежний исполнитель или его субагент — строки `!` выше. Задачу не бери и ничего не меняй: " +
          "ответь диспетчеру одной строкой `ждёт прежнего исполнителя: <worktree и почему он жив>` — диспетчер перезапускает задачу, только когда " +
          "ни один worktree прежнего исполнителя и его субагентов не заблокирован живым процессом и не получает коммитов.",
      ]);
      // отказ выдачу не пишет: worktree нового исполнителя очередь уберёт, как любой затихший
      expect(r.handOuts()).toEqual([`miroshnik/elves#47 ${r.previous}`]);
    };
    // прежний исполнитель работает: Claude Code держит блокировку его worktree
    git(r.work, "worktree", "lock", "--reason", lock(process.pid, "agent-a1"), r.previous);
    refused((l) => l === `! worktree ${r.previous} (the previous executor): locked by a live process — ${lock(process.pid, "agent-a1")}`);
    // он ответил «сломалось» — блокировку сняли, — а его субагент ещё работает
    git(r.work, "worktree", "unlock", r.previous);
    git(r.work, "worktree", "lock", "--reason", lock(process.pid, "agent-a2"), r.sub);
    refused((l) => l === `! worktree ${r.sub} (a subagent of agent-a1): locked by a live process — ${lock(process.pid, "agent-a2")}`);
    // субагент ждёт своего субагента
    git(r.work, "worktree", "unlock", r.sub);
    git(r.work, "worktree", "lock", "--reason", lock(process.pid, "agent-a5"), r.deeper);
    refused((l) => l === `! worktree ${r.deeper} (a subagent of agent-a2): locked by a live process — ${lock(process.pid, "agent-a5")}`);
    // субагенты ответили и разбудили исполнителя: продолженного Claude Code не блокирует, а коммиты в его worktree идут
    git(r.work, "worktree", "unlock", r.deeper);
    git(r.previous, "-c", "user.email=spec@example.test", "-c", "user.name=spec", "commit", "-q", "--allow-empty", "-m", "work");
    refused((l) => l === `! worktree ${r.previous} (the previous executor): HEAD moved 0 min ago (a commit or a switch), quiet after 15`);
  });

  // субагент без своего worktree работает в каталоге прежнего исполнителя (#571): ни блокировки, ни коммитов — пишется его транскрипт
  it("прежний исполнитель затих, а его субагент без своего worktree работает в его каталоге — задание не выдаётся", () => {
    const r = restart();
    const subagents = path.join(r.claude, `projects/-work/${SESSION}/subagents`);
    writeTree(subagents, { "agent-a6.meta.json": JSON.stringify({ agentType: "general-purpose", parentAgentId: "a1", spawnDepth: 2 }), "agent-a6.jsonl": "{}\n" });
    const a = r.again();
    expect(a.code).toBe(1);
    expect(a.out.split("\n").filter((l) => l.startsWith("! "))).toEqual([
      `! worktree ${r.previous} (the previous executor): subagent agent-a6 works in it without a worktree of its own — its transcript written 0 min ago, quiet after 15`,
    ]);
    expect(r.handOuts()).toEqual([`miroshnik/elves#47 ${r.previous}`]);
  });

  // без перегиба: перезапуск, ради которого задание его и печатает, — прежний исполнитель затих; живые агенты других задач не держат
  it("прежний исполнитель и его субагенты затихли — задание выдаётся снова, живые агенты других задач его не держат", () => {
    const r = restart();
    // приложение перезапустилось: блокировку держит процесс, которого нет
    git(r.work, "worktree", "lock", "--reason", lock(DEAD, "agent-a1"), r.previous);
    git(r.work, "worktree", "lock", "--reason", lock(DEAD, "agent-a2"), r.sub);
    git(r.work, "worktree", "lock", "--reason", lock(DEAD, "agent-a5"), r.deeper);
    // исполнитель другой задачи работает
    const other = r.add("agent-a4", "feat/48-other");
    git(r.work, "worktree", "lock", "--reason", lock(process.pid, "agent-a4"), other);
    const a = r.again();
    expect(a.code).toBe(0);
    expect(a.out.split("\n").filter((l) => l.startsWith("! "))).toEqual([]);
    expect(a.out.split("\n")[1]).toStartWith("Задача уже «В работе» и у неё есть ветка `feat/47-export` — это перезапуск");
    expect(r.handOuts()).toEqual([`miroshnik/elves#47 ${r.previous}`, `miroshnik/elves#47 ${r.next}`]);
  });
});

/**
 * Облачную сессию приложение стартует с ветки из записи сессии, которая её запускает (`get_session` → `branch`), а не из
 * git (#588): у сессии из worktree приложения там её ветка `claude/<slug>-<hash>`, не запушенная, — клонирование падает
 * на «The requested branch or commit was not found», и снять ветку с checkout не помогает: запись её помнит. У сессии в
 * папке проекта ветки в записи нет — её облачные сессии стартуют с `main`.
 */
describe("task queue в worktree приложения: облачные исполнители из него не стартуют", () => {
  /** Чекаут проекта на main; worktree сессий приложения и агентов — в его `.claude/worktrees`. */
  function project() {
    const c = checkout("fix/49-x");
    temp.push(c.cleanup);
    // путь — как его называет git: без симлинков временного каталога (/var → /private/var на macOS)
    const work = realpathSync(c.work);
    git(work, "switch", "-q", "main");
    const add = (name: string, opts: string[]) => {
      const dir = path.join(work, ".claude/worktrees", name);
      git(work, "worktree", "add", "-q", ...opts, dir, "origin/main");
      return dir;
    };
    /** Строки очереди о worktree приложения, позванной из каталога `cwd`. */
    const warned = (cwd: string) =>
      task(new FakeGitHub(REC), ["queue", "--epic", "45"], REPO, { env: { ...inSession(scratch()).env, CLAUDE_CONFIG_DIR: scratch() }, run: noEst, cwd })
        .out.split("\n")
        .filter((l) => l.includes("app worktree"));
    return { work, add, warned };
  }

  it("task queue в сессии из worktree приложения печатает строку «!»: облачные исполнители из неё не стартуют — диспетчер запустить в папке проекта без worktree", () => {
    const p = project();
    const session = p.add("bold-raman-12428f", ["-b", "claude/bold-raman-12428f"]);
    // ветку сняли, как после task close, — запись сессии её помнит
    const detached = p.add("calm-turing-0a1b2c", ["--detach"]);
    for (const dir of [session, detached])
      expect(p.warned(path.join(dir, ".agents"))).toEqual([
        `! session in an app worktree ${dir}: the app starts its cloud sessions from the branch in the session's record, not from main — ` +
          `cloud executors from it fail with «The requested branch or commit was not found»; a dispatcher with cloud executors — ` +
          `a session in the project folder ${p.work} without a worktree; subagent executors aren't affected`,
      ]);
  });

  // без перегиба: worktree агента — не сессия приложения, папка проекта — то, что строка велит
  it("task queue в папке проекта и в worktree агента строки о worktree приложения не печатает", () => {
    const p = project();
    const agent = p.add("agent-a1", ["-b", "worktree-agent-a1"]);
    expect(p.warned(agent)).toEqual([]);
    expect(p.warned(p.work)).toEqual([]);
  });
});

/**
 * Облачный исполнитель (claude.ai/code) не может написать локальной сессии-диспетчеру (#609): `send_message` в локальную
 * сессию отказывает, а разрешение владельца на доверенном устройстве — на каждую облачную сессию. Сигнал диспетчеру —
 * закрытие задачи мержем: он ждёт его `ci-wait issue <N>` фоновой командой и закрывает задачу локально — поля проекта,
 * факт с `--write`, удаление влитой ветки облаку недоступны. Бриф — первый промпт облачной сессии — цельный: `task
 * queue` в облаке отказывает, задание по `--assignment` исполнитель не напечатает.
 */
describe("task queue --assignment N --cloud — бриф облачного исполнителя, диспетчер ждёт закрытия задачи", () => {
  const projectDir = () => {
    const dir = scratch();
    mkdirSync(path.join(dir, ".agents"));
    writeFileSync(path.join(dir, ".agents/elves.json"), '{ "language": "ru" }\n');
    return dir;
  };
  /** Бриф облачного исполнителя — строки до `Next:`; `Next:` — шаги диспетчера. */
  const brief = (f: FakeGitHub, config = scratch()) => {
    const r = task(f, ["queue", "--assignment", "47", "--cloud"], REPO, { ...inSession(config), cwd: projectDir() });
    expect(r.code).toBe(0);
    const lines = r.out.split("\n");
    return { prompt: lines.filter((l) => !l.startsWith("Next:")), next: lines.filter((l) => l.startsWith("Next:")).join("\n") };
  };

  it("облачный исполнитель влил PR задачи — диспетчер узнаёт об этом без владельца", () => {
    const f = new FakeGitHub(REC);
    f.status(47, "Бэклог");
    const config = scratch();
    const { prompt, next } = brief(f, config);
    expect(prompt).toContain("- диспетчер ждёт закрытия задачи и закрывает её локально — факт, статус, влитая ветка, архив этой сессии: сообщать ему не нужно, сессию не архивируй;");
    expect(next).toMatch(/; then as a background command: bash \S+\/skills\/ci-wait\/scripts\/wait-ci\.sh issue 47 — a cloud session can't message a local one \(docs\/cloud-sessions\.md\), the task's closing is the signal:/);
    // фоновое ожидание умирает с процессом приложения: очередь называет его у выданной облаку задачи, task resume — очередь
    const queued = task(f, ["queue", "--epic", "45"], REPO, { ...inSession(config), cwd: projectDir() }).out.split("\n");
    expect(queued.find((l) => l.startsWith("= #47 "))).toMatch(/ — handed out to a cloud executor of this session, its wait — a background command: bash \S+\/wait-ci\.sh issue 47$/);
    expect(f.mutations).toEqual([]);
  });

  // архив сессии исполнителя — как у сессий-исполнителей приложения (#621): только в проекте в режиме auto
  it("по закрытию задачи облачного исполнителя диспетчер закрывает её локально: факт с --write, Status, удаление влитой ветки, архив сессии исполнителя в проекте в режиме auto", () => {
    const { next } = brief(new FakeGitHub(REC));
    expect(next).toMatch(/: PASS — bun --no-env-file \S+\/skills\/github\/scripts\/github\.ts task close 47 \(the actual with --write, Status, the merged branch\), then archive the executor's session in an auto project where the agent has the tool;/);
  });

  // без перегиба: ветку облачной сессии назначает облако (`claude/<slug>`), она не по канону задачи — task close диспетчера убирает и её
  it("task close в чекауте диспетчера на main удаляет влитую ветку облачного исполнителя claude/<slug>", () => {
    const { work, origin, cleanup } = checkout("claude/vigilant-x");
    try {
      git(work, "switch", "-q", "main");
      const f = new FakeGitHub(REC);
      f.prs[77] = { files: [], closes: [49], head: "claude/vigilant-x", base: "main", model: null, merged: true };
      const r = task(f, ["close", "49"], REPO, { run: noEst, cwd: work });
      expect(r.code).toBe(0);
      expect(git(work, "branch", "--list", "claude/vigilant-x")).toBe("");
      expect(git(origin, "branch", "--list", "claude/vigilant-x")).toBe("");
      expect(r.out).toContain("+ remote branch claude/vigilant-x deleted");
    } finally {
      cleanup();
    }
  });

  it("облачный исполнитель не влил PR (вопрос, сбой) — диспетчер находит его вопрос или State-комментарий в задаче", () => {
    const { prompt, next } = brief(new FakeGitHub(REC));
    expect(prompt).toContain(
      "- вопрос без ясной рекомендации — в «## Вопросы» задачи и владельцу в этой сессии, код, который от него зависит, не начинай; остановился (вопрос, сбой, лимит) — комментарий «Состояние» в задачу.",
    );
    expect(next).toContain("; TIMEOUT — the task's «## Вопросы» and its «Состояние» comment, the executor's session, then the same wait again");
  });

  it("бриф облачного исполнителя из github task queue называет через решётку только номер своей задачи, эпик — без решётки", () => {
    const f = new FakeGitHub(REC);
    f.issue(47).title = "GitHub · доправка к #12 — github task";
    const { prompt } = brief(f);
    expect(prompt[0]).toStartWith("Задача #47 «GitHub · доправка к 12 — github task» в miroshnik/elves (эпик 45): ты облачный исполнитель сессии-диспетчера");
    expect(prompt.join("\n").match(/#\d+/g)).toEqual(["#47"]);
  });

  it("--cloud — только с --assignment", () => {
    const r = task(new FakeGitHub(REC), ["queue", "--epic", "45", "--cloud"], REPO, { cwd: projectDir() });
    expect(r.code).toBe(2);
    expect(r.err).toBe("error: --cloud — only with --assignment <N>: the brief of one task's cloud executor");
  });
});

/**
 * Другую задачу сессия отдавала карточкой новой сессии: её запускал владелец кликом, и сессия о ней больше не знала
 * (#546). Канон, скиллы и их скрипты — источник всего, что агент читает и что печатают команды, — её больше не
 * предлагают: только вопрос владельцу, ставить ли задачу в очередь (на новый эпик — запускать ли диспетчера), а «да» —
 * исполнитель, фоновый субагент этой же сессии.
 */
describe("Другая задача — вопрос о постановке в очередь, а не карточка новой сессии", () => {
  const ROOT = path.resolve(import.meta.dir, "../../..");
  /** Файлы канона, скиллов и скриптов: корневые документы и всё в каталогах. */
  const files = ["AGENTS.md", "README.md", "claude", "docs", "skills", "bin"].flatMap((p) =>
    statSync(path.join(ROOT, p)).isDirectory()
      ? readdirSync(path.join(ROOT, p), { recursive: true, withFileTypes: true })
          .filter((e) => e.isFile())
          .map((e) => path.relative(ROOT, path.join(e.parentPath, e.name)))
      : [p],
  );

  it("канон, скиллы и вывод скриптов не предлагают чип — только вопрос о постановке в очередь", () => {
    expect(files.length).toBeGreaterThan(40);
    expect(files.filter((f) => /\bchips?\b|чип/i.test(readFileSync(path.join(ROOT, f), "utf8")))).toEqual([]);
    const canon = readFileSync(path.join(ROOT, "AGENTS.md"), "utf8").replace(/\s+/g, " ");
    expect(canon).toContain("Another task — Backlog and the question «queue #263?»");
    expect(canon).toContain("A new epic — the question «run the dispatcher on epic #M?»");
    expect(canon).toContain("work outside the task — a Backlog task and the question «queue it?»");
  });
});

/**
 * Предел «не больше трёх» держит машину (#611): исполнители-субагенты делят её процессор, порты и очередь `slot`, а та
 * пускает две тяжёлые проверки. Облачный исполнитель идёт в своём контейнере и машину не нагружает — владелец решил:
 * облачных — до пяти сразу. Число из запроса владельца заменяет любой предел. Фраза одна во всех местах, где диспетчер
 * её читает: в каноне, в скилле `github` и его справочнике, в справочнике облачной сессии.
 */
describe("Предел исполнителей диспетчера — по месту исполнителя", () => {
  const ROOT = path.resolve(import.meta.dir, "../../..");
  const LIMIT = "at most 3 subagents and 5 cloud sessions at once, the owner's number replaces either";
  const PLACES = ["AGENTS.md", "skills/github/SKILL.md", "skills/github/reference.md", "docs/cloud-sessions.md"];

  it("канон и справочник github называют предел облачных исполнителей диспетчера — пять, локальных — три", () => {
    expect(PLACES.filter((f) => !readFileSync(path.join(ROOT, f), "utf8").replace(/\s+/g, " ").includes(LIMIT))).toEqual([]);
  });
});

/**
 * Задачу другого проекта диспетчер выдаёт сессией приложения (`start_session`) в папке проекта: субагент работает в
 * worktree репозитория диспетчера. Сессия-исполнитель в режиме auto архивирует себя сама после «Всё сделано. Сессию можно
 * закрывать.», но не всегда (#621): кончила вопросом владельцу, а ответ ушёл диспетчеру; последний ход — ожидание деплоя,
 * после которого строка не дошла до архивации. Завершённые сессии копились в списке, пока владелец не закрывал их руками.
 * Владелец решил: диспетчер архивирует их сам, если проект сессии в режиме auto. Сессию с живой фоновой работой — нет
 * (архивация ей отказала бы), с вопросом владельцу без ответа — тоже нет: архивная уходит из списка, и вопрос в её
 * последнем ответе владелец не прочтёт. Правило — одной фразой во всех местах, где его читает диспетчер: в каноне, в
 * скилле `github` и его справочнике; шаг называет `Next:` очереди — её диспетчер читает после каждого ответа исполнителя.
 */
describe("Диспетчер архивирует свои завершённые сессии-исполнители в режиме auto", () => {
  const ROOT = path.resolve(import.meta.dir, "../../..");
  const PLACES = ["AGENTS.md", "skills/github/SKILL.md", "skills/github/reference.md"];
  const ARCHIVE = "an executor session whose task closed — the dispatcher archives it in an auto project";
  const BUSY = "not one still working in the background or awaiting the owner's answer";
  const OWNER = "outside auto the owner closes it";
  const text = (file: string) => readFileSync(path.join(ROOT, file), "utf8").replace(/\s+/g, " ");
  const missing = (phrase: string) => PLACES.filter((f) => !text(f).includes(phrase));
  /** Каталог с языком проекта, но не чекаут: очередь не трогает worktree репозитория, где запущен тест. */
  const projectDir = () => {
    const dir = scratch();
    mkdirSync(path.join(dir, ".agents"));
    writeFileSync(path.join(dir, ".agents/elves.json"), '{ "language": "ru" }\n');
    return dir;
  };
  /** Последний шаг очереди диспетчера при каждом её исходе: есть готовые, только в работе, пусто. */
  const steps = () =>
    (["Бэклог", "В работе", null] as const).map((status) => {
      const f = new FakeGitHub(REC);
      if (status) f.status(47, status);
      else f.closed(47);
      const r = task(f, ["queue", "--epic", "45"], REPO, { ...inSession(scratch()), cwd: projectDir() });
      expect(r.code).toBe(0);
      return r.out.split("\n").at(-1)!;
    });

  it("Диспетчер в режиме auto архивирует сессию-исполнителя, чья задача закрыта, а сессия осталась в списке", () => {
    expect(missing(ARCHIVE)).toEqual([]);
    const [ready, running, empty] = steps();
    expect(ready).toStartWith("Next: each ready task above");
    expect(running).toStartWith("Next: no ready tasks");
    expect(empty).toStartWith("Queue is empty");
    expect([ready, running, empty].filter((l) => !l!.includes(ARCHIVE))).toEqual([]);
    // пустая очередь: сначала сессии-исполнители, потом итог диспетчера и его последняя строка
    expect(empty!.indexOf(ARCHIVE)).toBeLessThan(empty!.indexOf("the dispatcher's summary"));
  });

  it("Сессию-исполнителя проекта не в режиме auto диспетчер не архивирует — её закрывает владелец", () => {
    expect(missing(OWNER)).toEqual([]);
    expect(steps().filter((l) => !l.includes(OWNER))).toEqual([]);
  });

  it("Сессию, которая ждёт ответа владельца или ещё работает в фоне, диспетчер не архивирует", () => {
    expect(missing(BUSY)).toEqual([]);
    expect(steps().filter((l) => !l.includes(BUSY))).toEqual([]);
  });

  it("канон называет исполнителя задачи другого проекта — сессию приложения, а не пишет, что её ещё не выдают", () => {
    const files = ["AGENTS.md", "claude", "docs", "skills"].flatMap((p) =>
      statSync(path.join(ROOT, p)).isDirectory()
        ? readdirSync(path.join(ROOT, p), { recursive: true, withFileTypes: true })
            .filter((e) => e.isFile() && e.name.endsWith(".md"))
            .map((e) => path.relative(ROOT, path.join(e.parentPath, e.name)))
        : [p],
    );
    expect(files.length).toBeGreaterThan(10);
    expect(files.filter((f) => /aren't given out yet|a server flag/.test(text(f)))).toEqual([]);
    // ядро канона — в бюджете слов: исполнителей диспетчера по видам называет скилл `github`
    const skill = ["skills/github/SKILL.md", "skills/github/reference.md"];
    expect(skill.filter((f) => !text(f).includes("another project's task — an app session in its folder"))).toEqual([]);
  });

  it("claude/CLAUDE.md: сессию-исполнителя диспетчер архивирует archive_session по её id, отказ не повторяет", () => {
    expect(text("claude/CLAUDE.md")).toContain(
      "in auto mode `archive_session` with `self` archives it, ending the conversation: the last action, after the \"can be closed\" line. " +
        "Before it — `TaskStop` for each own background task still running: a live one gives \"still has live work\". " +
        "A dispatcher archives an executor session with its id. Refused — don't retry: the owner archives from the sidebar.",
    );
  });
});

/**
 * Задачу другого проекта диспетчер выдаёт сессией приложения (`start_session`) в папке проекта (#621), а задания для неё у
 * скриптов не было (#624): `--assignment N` печатает задание субагента — сессию не называть, CI ждать обычным вызовом,
 * последнюю строку не писать, — а сессии нужно обратное. При переезде четырёх проектов на тонкий флоу диспетчер писал
 * промпты сессий руками. `--assignment N --session` печатает диспетчер: промпт сессии — строки задания как есть, `Next:` —
 * как её запустить; выдача записана у диспетчера, и очередь не отдаёт задачу второму исполнителю.
 */
describe("task queue --assignment N --session — задание сессии-исполнителя приложения", () => {
  const projectDir = () => {
    const dir = scratch();
    mkdirSync(path.join(dir, ".agents"));
    writeFileSync(path.join(dir, ".agents/elves.json"), '{ "language": "ru" }\n');
    return dir;
  };
  /** Промпт сессии-исполнителя — строки до `Next:`; `Next:` — как диспетчеру её запустить. */
  const prompt = (f: FakeGitHub, config = scratch()) => {
    const r = task(f, ["queue", "--assignment", "47", "--session"], REPO, { ...inSession(config), cwd: projectDir() });
    expect(r.code).toBe(0);
    const lines = r.out.split("\n");
    return { lines: lines.filter((l) => !l.startsWith("Next:")), next: lines.filter((l) => l.startsWith("Next:")).join("\n") };
  };

  it("Задание сессии-исполнителя велит назвать сессию по задаче, ждать CI фоновой командой и закончить последней строкой по режиму проекта", () => {
    const f = new FakeGitHub(REC);
    const { lines } = prompt(f);
    expect(lines[0]).toStartWith(
      "Задача #47 «GitHub · Задача одной командой — github task» в miroshnik/elves (эпик #45): ты сессия-исполнитель сессии-диспетчера — " +
        "сделай задачу целиком по канону этого проекта, в его режиме (его печатает `check`; не в auto — коммит, пуш и мерж по «да» владельца):",
    );
    expect(lines).toContain("Ты сессия, а не субагент:");
    expect(lines).toContain("- назови сессию `#47 GitHub · Задача одной командой — github task` (`set_session_title`), как только взял задачу, — по имени `est` привяжет сессию к задаче;");
    expect(lines.find((l) => l.startsWith("- CI и деплой"))).toMatch(
      /^- CI и деплой жди фоновой командой — `bash \S+\/skills\/ci-wait\/scripts\/wait-ci\.sh pr <PR>` \(после мержа — `merged <PR>`\): её завершение будит сессию;/,
    );
    expect(lines.at(-1)).toBe(
      "- конец — последняя строка канона («Всё сделано. Сессию можно закрывать.» · «Всё сделано, но есть вопросы: …» · «Осталось: …»), " +
        "в режиме auto после «Всё сделано. Сессию можно закрывать.» — архивация сессии по канону: конец каждого твоего хода диспетчер читает как твой ответ.",
    );
    // строки субагента говорят сессии обратное: не называть, не в фоне, без последней строки, ответ одной строкой
    const text = lines.join("\n");
    for (const subagent of ["Ты субагент, а не сессия:", "не в фоне", "--timeout 540", "не пиши — это делает диспетчер", "Ответ диспетчеру — одной строкой"]) expect(text).not.toContain(subagent);
    expect(f.mutations).toEqual([]);
  });

  it("Задача, выданная сессии-исполнителю, в очереди диспетчера — в работе, а не готовая", () => {
    const f = new FakeGitHub(REC);
    f.status(47, "Бэклог");
    const config = scratch();
    const queue = () => task(f, ["queue", "--epic", "45"], REPO, { ...inSession(config), cwd: projectDir() }).out.split("\n").filter((l) => !l.startsWith("  "));
    expect(queue()[1]).toBe(`+ #47 «${f.issue(47).title}»`);
    prompt(f, config);
    expect(readFileSync(path.join(config, "dispatchers", `${SESSION}.tasks`), "utf8")).toBe("miroshnik/elves#47 @session\n");
    expect(queue().slice(0, 2)).toEqual([
      "Queue miroshnik/elves (epic #45): ready 0, «В работе» 1, not ready 0",
      `= #47 «${f.issue(47).title}» — handed out to an app executor session of this session (start_session) — the end of each of its turns comes as the app's note`,
    ]);
    expect(f.mutations).toEqual([]);
  });

  it("Next: задания сессии — start_session в папке проекта со своим worktree, промпт — строки задания как есть, по концу её хода — очередь", () => {
    const { lines, next } = prompt(new FakeGitHub(REC));
    expect(next).toStartWith(
      'Next: the lines above — the executor session\'s prompt as is: start_session, initiation "user_asked", cwd — the folder of the miroshnik/elves checkout on this machine (not a worktree), ' +
        "use_worktree true, background — the first line above; keep the session's id it returns. " +
        "The end of each of its turns comes as the app's note, like an executor's answer — task queue again: in a queue of miroshnik/elves the task is =; ",
    );
    expect(next).toContain("an executor session whose task closed — the dispatcher archives it in an auto project");
    // промпт сессии — без путей и шагов диспетчера
    expect(lines.filter((l) => /start_session|use_worktree/.test(l))).toEqual([]);
  });

  it("--session — только с --assignment и не вместе с --cloud", () => {
    const alone = task(new FakeGitHub(REC), ["queue", "--epic", "45", "--session"], REPO, { cwd: projectDir() });
    expect(alone.code).toBe(2);
    expect(alone.err).toBe("error: --session — only with --assignment <N>: the prompt of one task's app executor session");
    const both = task(new FakeGitHub(REC), ["queue", "--assignment", "47", "--cloud", "--session"], REPO, { cwd: projectDir() });
    expect(both.code).toBe(2);
    expect(both.err).toBe("error: --cloud or --session, not both: a cloud executor or an app session");
  });
});

/**
 * В проекте без auto исполнитель диспетчера мержил PR задачи сам на зелёных проверках (#667): задание велело «как сессия
 * в режиме auto», и владелец, не говоривший «да» этому мержу, узнавал о нём постфактум — из ответа исполнителя
 * диспетчеру. Владелец решил: режим проекта — его явное решение, а «сделай эпик» — просьба про объём работы, не согласие
 * на каждый мерж. Исполнитель сам ведёт коммиты, push в ветку задачи, PR, CI и `pr premerge`; перед `gh pr merge`
 * отвечает «вопрос: мерж PR #N?» с итогом premerge и мержит по «да» владельца, пересланному диспетчером. Облачный
 * исполнитель диспетчеру не пишет — спрашивает владельца в своей сессии; мерж выпуска пачки — тоже по «да».
 */
describe("Исполнитель диспетчера в проекте без auto мержит по «да» владельца", () => {
  const MERGE =
    "- проект без auto: коммиты, push в ветку задачи, PR, CI и `pr premerge` — сам; перед `gh pr merge` остановись и ответь диспетчеру `вопрос: мерж PR #<PR>? <итог pr premerge>`; " +
    "«да» владельца пришлёт сюда же диспетчер — тогда снова `pr premerge` (база могла уйти), мерж и шаги после него;";
  const ASK =
    "the project is without auto: each executor's merge waits for the owner's «yes» — its answer «question: merge PR #N? …» goes to the owner, the «yes» to the same executor with SendMessage";
  /** Каталог проекта, но не чекаут: режим — в его .agents/elves.json. */
  const projectIn = (auto: boolean) => {
    const dir = scratch();
    writeTree(dir, { ".agents/elves.json": JSON.stringify({ language: "ru", ...(auto ? { auto: true } : {}) }) + "\n" });
    return dir;
  };
  /** Задания исполнителей проекта: субагента, субагента пачки (маркер диспетчера с её веткой) и облачного. */
  const assignments = (auto: boolean) => {
    const cwd = projectIn(auto);
    const batch = scratch();
    writeTree(batch, { [`dispatchers/${SESSION}`]: `bun --no-env-file github.ts task queue --epic 45 --repo ${REPO}\nbatch ${REPO} batch/2026-10-22-1\n` });
    const lines = (io: Partial<Io>, ...more: string[]) => {
      const r = task(new FakeGitHub(REC), ["queue", "--assignment", "47", ...more], REPO, { ...io, cwd });
      expect(r.code).toBe(0);
      return r.out.split("\n");
    };
    return { plain: lines({}), batched: lines(inSession(batch)), cloud: lines({}, "--cloud") };
  };

  it("задание исполнителя в проекте без auto останавливает его перед мержем вопросом диспетчеру", () => {
    const { plain, batched, cloud } = assignments(false);
    expect(batched[0]).toContain("задача идёт в пачку `batch/2026-10-22-1`");
    for (const lines of [plain, batched]) {
      expect(lines[0]).toContain("по канону, в режиме проекта, без auto — мерж по «да» владельца: `");
      expect(lines[0]).not.toContain("в режиме auto");
      // вопрос о мерже — сразу за ожиданием CI, до строк о шагах после мержа
      expect(lines.indexOf(MERGE)).toBe(lines.findIndex((l) => l.startsWith("- CI ")) + 1);
    }
    // облачный исполнитель диспетчеру не пишет — спрашивает владельца в своей сессии
    expect(cloud[0]).toContain("по канону, в режиме проекта, без auto — мерж по «да» владельца в этой сессии: вопросы задачи");
    expect(cloud).not.toContain(MERGE);
  });

  it("задание исполнителя в auto-проекте мержит задачу на зелёных проверках без вопроса", () => {
    const { plain, batched, cloud } = assignments(true);
    for (const lines of [plain, batched, cloud]) {
      expect(lines[0]).toContain("по канону, как сессия в режиме auto: ");
      expect(lines.filter((l) => l.includes("по «да» владельца"))).toEqual([]);
    }
    expect(plain[0]).toContain("зелёный CI, `pr premerge`, мерж, деплой, актуализация эпика");
    expect(cloud[0]).toEndWith("зелёный CI, мерж, деплой.");
  });

  it("`task queue` в проекте без auto сообщает диспетчеру, что мерж каждой задачи ждёт «да» владельца", () => {
    /** Последний шаг очереди при каждом её исходе: есть готовые, только в работе, пусто. */
    const step = (auto: boolean, status: string | null) => {
      const f = new FakeGitHub(REC);
      if (status) f.status(47, status);
      else f.closed(47);
      const r = task(f, ["queue", "--epic", "45"], REPO, { ...inSession(scratch()), cwd: projectIn(auto) });
      expect(r.code).toBe(0);
      return r.out.split("\n").at(-1)!;
    };
    const steps = (auto: boolean) => [step(auto, "Бэклог"), step(auto, "В работе"), step(auto, null)] as const;
    const [ready, running, empty] = steps(false);
    expect(ready).toContain(`After each executor's answer — task queue again: new tasks get in; ${ASK}; `);
    expect(running).toContain(`wait for the executors' answers; after each — task queue again; ${ASK}; `);
    // очередь пуста — ничей мерж не ждёт
    expect(empty).not.toContain(ASK);
    expect(steps(true).filter((l) => l.includes("without auto"))).toEqual([]);
  });

  it("`batch release` в проекте без auto мержит выпуск по «да» владельца", () => {
    const { work, f, config, name } = started();
    mergeIntoBatch(work, name, "feat/47-export", "export.txt", "feat(github): экспорт");
    f.prs[300] = batchPr(47, "feat/47-export", name);
    /** Что стоит в шагах выпуска между `pr premerge` с кодом 0 и мержем. */
    const before = (r: { code: number; out: string }) => {
      expect(r.code).toBe(0);
      return / code 0 — (.*)gh pr merge \d+ --rebase as a separate call\. /.exec(r.out.split("\n").at(-1)!)?.[1];
    };
    expect(before(release(f, work, config))).toBe("the owner's «yes» (the project is without auto) — then ");
    // проект в режиме auto: PR выпуска открыт — те же шаги, мерж на зелёных проверках без вопроса
    writeTree(work, { ".agents/elves.json": JSON.stringify({ language: "ru", batch: true, auto: true }) + "\n" });
    expect(before(release(f, work, config))).toBe("");
  });
});

/**
 * #668: хвост задачи от `gh pr create` до конца — медиана 18 ходов на пиковом контексте, ≈19 из них — механика флоу:
 * push, PR со spec-diff и `pr labels`, ожидание CI, `pr premerge`, мерж, ожидание деплоя, `task actualize`, субагент,
 * `task close`. `task finish` делает её одной возобновляемой командой: каждый вызов — что готово, затем состояние и
 * следующий шаг; мерж остаётся отдельным вызовом `gh pr merge` — на него опирается правило разрешений владельца.
 */
describe("task finish доводит задачу от ветки до закрытия одной возобновляемой командой", () => {
  const SPEC = "## Спецификация\n\n+ экспорт счёта в PDF";
  const RESULT = ["RESULT: PASS", "RESULT: FAIL tests", "RESULT: TIMEOUT 3/5 done", "RESULT: ERROR conflict with main"];
  /** Чекаут на ветке задачи с одним коммитом, как после проверок перед коммитом. */
  function onBranch(branch = "feat/49-invoice-export", subject = "feat(github): экспорт счёта в PDF") {
    const { work, main } = worktree();
    git(work, "switch", "-q", "-c", branch, "--no-track", "origin/main");
    gitRepo(work, { init: false }).commit({ "export.txt": "pdf\n" }, subject);
    return { work, main };
  }
  /**
   * Вызов `task finish`: ci-wait — подпроцесс bash, его коды по очереди (`ci` — PR, `deploy` — мерж; кончились — PASS),
   * spec-diff и est — подпроцессы bun, git — настоящий.
   */
  function finish(f: FakeGitHub, args: string[], o: { cwd: string; ci?: number[]; deploy?: number[]; config?: string }) {
    const waits: string[][] = [];
    const est: string[][] = [];
    const run = githubOrigin((cmd: string, a: string[], cwd?: string) => {
      if (cmd === "bash") {
        waits.push(a.slice(1));
        const code = (a[1] === "pr" ? o.ci : o.deploy)?.shift() ?? 0;
        return { status: code, stdout: `12:00:00 +1m checks: 3/5 done\n${RESULT[code]}\n`, stderr: "" };
      }
      if (cmd === "bun") return a.some((x) => x.endsWith("spec-diff.ts")) ? { status: 0, stdout: `${SPEC}\n`, stderr: "" } : (isTaskEnv(a) || est.push(a), { status: 0, stdout: "", stderr: "" });
      return realRun(cmd, a, cwd);
    });
    const config = o.config ?? scratch();
    const r = task(f, ["finish", ...args], REPO, { run, cwd: o.cwd, env: { ELVES_CONFIG_DIR: config, ELVES_SPEC_DIFF: OUTSIDE_SPEC } });
    return { ...r, waits, est, config, last: r.out.split("\n").at(-1)! };
  }
  const created = (f: FakeGitHub) => f.rest.filter((x) => x.method === "POST" && x.route.endsWith("/pulls")).map((x) => x.payload);
  const merge = (f: FakeGitHub, pr: number) => Object.assign(f.prs[pr]!, { merged: true, state: "MERGED" });

  it("task finish от готовой ветки доводит задачу до команды мержа за один вызов при зелёном CI", () => {
    const f = new FakeGitHub(REC);
    const { work } = onBranch();
    const r = finish(f, ["49"], { cwd: work });
    expect(r.err).toBe("");
    expect(r.code).toBe(4);
    expect(created(f)).toEqual([{ title: "feat(github): экспорт счёта в PDF", head: "feat/49-invoice-export", base: "main", body: `${SPEC}\n\nCloses #49\n` }]);
    expect(git(work, "ls-remote", "--heads", "origin", "feat/49-invoice-export")).toStartWith(git(work, "rev-parse", "HEAD"));
    expect(r.out).toContain("PR #1 → #49: no decisions in the diff");
    expect(r.waits).toHaveLength(1);
    expect(r.waits[0]!.slice(0, 4)).toEqual(["pr", "1", "--repo", REPO]);
    expect(r.out).toContain("✅ merge: main hasn't moved since the CI of PR #1");
    expect(r.last).toStartWith("Next: the owner's «yes» (the project is without auto) — then gh pr merge 1 --rebase — a separate call");
  });

  it("повторный task finish продолжает с шага, на котором остановился", () => {
    const f = new FakeGitHub(REC);
    const { work } = onBranch();
    const first = finish(f, ["49"], { cwd: work, ci: [2] });
    expect(first.code).toBe(5);
    expect(first.out).toContain("○ out of time (--timeout 3600) — the CI of PR #1 is still running (RESULT: TIMEOUT 3/5 done)");
    const again = finish(f, ["49"], { cwd: work });
    expect(again.code).toBe(4);
    expect(created(f)).toHaveLength(1);
    expect(again.out).toContain("= branch feat/49-invoice-export is on origin");
    expect(again.out).toContain("= PR #1 into main: the body is current");
    // после мержа — деплой, и задача без эпика закрывается
    merge(f, 1);
    const after = finish(f, ["49"], { cwd: work });
    expect(after.code).toBe(0);
    expect(after.waits.map((w) => w.slice(0, 2))).toEqual([["merged", "1"]]);
    expect(statusSet(f)).toEqual([[49, "Готово"]]);
    expect(after.out).not.toContain("Next: task close");
  });

  it("task finish при красном CI останавливается с проверкой, которая упала", () => {
    const f = new FakeGitHub(REC);
    const { work } = onBranch();
    const r = finish(f, ["49"], { cwd: work, ci: [1] });
    expect(r.code).toBe(1);
    expect(r.out).toContain("❌ the CI of PR #1 is red — RESULT: FAIL tests");
    expect(r.last).toContain("the root cause fixed, the checks before a commit, git commit, then ");
    expect(r.out).not.toContain("gh pr merge");
    const conflict = finish(f, ["49"], { cwd: work, ci: [3] });
    expect(conflict.code).toBe(1);
    expect(conflict.last).toContain("a conflict with main — git fetch origin main, git rebase origin/main, resolve");
  });

  it("task finish при красном main останавливается без мержа и называет баг main", () => {
    const f = new FakeGitHub(REC);
    f.mainChecks = { tests: "FAILURE" };
    f.issue(42).title = "main красный: чек tests";
    const { work } = onBranch();
    const r = finish(f, ["49"], { cwd: work });
    expect(r.code).toBe(3);
    expect(r.out).toContain("bug on red main — #42 «main красный: чек tests»");
    expect(r.out).toContain("⛔ PR #1 isn't merged: main is red by itself");
    expect(r.out).not.toContain("gh pr merge");
  });

  /** #47 влит, в эпике #45 открыта и #46 — актуализация нужна. */
  function mergedInEpic(): FakeGitHub {
    const f = new FakeGitHub(REC);
    Object.assign(f.issue(46), { state: "OPEN", stateReason: null });
    f.issue(45).subIssues.nodes.find((x: { number: number }) => x.number === 46).state = "OPEN";
    f.prs[77] = { files: [], closes: [47], head: "feat/47-x", base: "main", model: null, merged: true };
    return f;
  }
  /** Итог актуализации эпика #45 после задачи — комментарий субагента к эпику. */
  const reported = (f: FakeGitHub, number: number) => (f.comments[45] = [...(f.comments[45] ?? []), { body: `Актуализация после #${number}, итог: блок актуален`, url: `https://github.com/miroshnik/elves/issues/45#issuecomment-${number}` }]);

  it("task finish после мержа ждёт деплой на SHA мержа и печатает промпт обновления эпика", () => {
    const f = mergedInEpic();
    const { work } = worktree();
    const config = scratch();
    const r = finish(f, ["47"], { cwd: work, config });
    expect(r.code).toBe(4);
    expect(r.waits.map((w) => w.slice(0, 2))).toEqual([["merged", "77"]]);
    expect(r.out).toContain("✅ the checks and the deploy of the merge of PR #77 passed");
    expect(r.out).toContain("The epic refresh's subagent — the two lines below are its whole prompt, pass them as is:");
    expect(r.last).toStartWith("Next: the subagent in the background with that prompt; after its answer — ");
    expect(byOp(f, "CloseIssue")).toEqual([]);
    // повтор до итога: деплой не ждёт снова, второго промпта нет
    const again = finish(f, ["47"], { cwd: work, config });
    expect(again.code).toBe(4);
    expect(again.waits).toEqual([]);
    expect(again.out).not.toContain("The epic refresh's subagent");
    expect(again.out).toContain("○ the epic refresh hasn't reported — no comment «Актуализация после #47, итог: …» on epic #45");
  });

  it("task finish закрывает задачу, когда комментарий обновления эпика на месте", () => {
    const f = mergedInEpic();
    const { work } = worktree();
    const config = scratch();
    expect(finish(f, ["47"], { cwd: work, config }).code).toBe(4);
    reported(f, 47);
    const r = finish(f, ["47"], { cwd: work, config });
    expect(r.code).toBe(0);
    expect(byOp(f, "CloseIssue")).toEqual([{ issueId: f.issue(47).id, stateReason: "COMPLETED" }]);
    expect(statusSet(f)).toEqual([[47, "Готово"]]);
    expect(r.est.map((a) => a.slice(2, 4))).toEqual([["fact", "47"]]);
    expect(r.last).toStartWith("Next: the last line of the answer is one of three");
    expect(existsSync(path.join(config, "finishes", "miroshnik__elves__47.json"))).toBe(false);
  });

  /**
   * #761: PR, который открыл `task finish`, несёт `Closes #N` — GitHub закрывает задачу в момент мержа, и второй вызов
   * видел закрытую задачу. Хвост завершён по тому, что ставит `task close`: Status «Готово» и записанный факт.
   */
  it("task finish задачи, которую закрыл Closes #N при мерже, продолжает хвост: деплой, актуализация эпика, task close", () => {
    const f = mergedInEpic();
    f.closed(47);
    const { work } = worktree();
    const config = scratch();
    const r = finish(f, ["47"], { cwd: work, config });
    expect(r.code).toBe(4);
    expect(r.out).toContain("○ #47 is closed by the merge of PR #77, the tail isn't over (no «Готово» with the actual) — going on");
    expect(r.waits.map((w) => w.slice(0, 2))).toEqual([["merged", "77"]]);
    expect(r.out).toContain("The epic refresh's subagent — the two lines below are its whole prompt, pass them as is:");
    reported(f, 47);
    const after = finish(f, ["47"], { cwd: work, config });
    expect(after.code).toBe(0);
    expect(statusSet(f)).toEqual([[47, "Готово"]]);
    expect(after.est.map((a) => a.slice(2, 4))).toEqual([["fact", "47"]]);
    // задачу уже закрыл GitHub — повторно её не закрывают
    expect(byOp(f, "CloseIssue")).toEqual([]);
  });

  it("task finish задачи, которую закрыл task close, — «nothing to finish» с кодом 0", () => {
    const f = mergedInEpic();
    f.closed(47);
    f.status(47, "Готово");
    f.numbers[47] = { "Оценка, ч": 0.5, "Факт, ч": 0.4 };
    const r = finish(f, ["47"], { cwd: worktree().work });
    expect(r.code).toBe(0);
    expect(r.out).toBe("= #47 is closed — nothing to finish");
    expect(r.waits).toEqual([]);
    expect(f.mutations).toEqual([]);
  });

  it("task finish задачи, закрытой без PR, хвост мержа не начинает", () => {
    for (const reason of ["COMPLETED", "NOT_PLANNED"]) {
      const f = new FakeGitHub(REC);
      f.closed(49, reason);
      const r = finish(f, ["49"], { cwd: worktree().work });
      expect(r.code).toBe(0);
      expect(r.out).toBe("= #49 is closed — nothing to finish");
      expect(r.waits).toEqual([]);
      expect(f.mutations).toEqual([]);
    }
    // отменённая задача со смерженным PR — тоже не хвост мержа
    const dropped = mergedInEpic();
    dropped.closed(47, "NOT_PLANNED");
    const r = finish(dropped, ["47"], { cwd: worktree().work });
    expect(r.out).toBe("= #47 is closed — nothing to finish");
    expect(r.waits).toEqual([]);
  });

  it("task finish с таймаутом возвращается до таймаута с состоянием и следующим шагом", () => {
    const f = new FakeGitHub(REC);
    const { work } = onBranch();
    const short = finish(f, ["49", "--timeout", "240"], { cwd: work, ci: [2] });
    expect(short.code).toBe(5);
    // ожидание CI — не дольше остатка вызова
    const waited = Number(short.waits[0]![short.waits[0]!.indexOf("--timeout") + 1]);
    expect(waited).toBeLessThanOrEqual(240);
    expect(waited).toBeGreaterThan(200);
    expect(short.last).toMatch(/^Next: bun --no-env-file \S+github\.ts task finish 49 --timeout 240 — it goes on from here$/);
    const none = finish(f, ["49", "--timeout", "0"], { cwd: work });
    expect(none.code).toBe(5);
    expect(none.waits).toEqual([]);
    expect(none.out).toContain("○ out of time (--timeout 0) — PR #1 is up, its CI isn't awaited yet");
  });

  it("task finish после мержа в ветку пачки — ничего не ждёт: остальное делает выпуск", () => {
    const f = new FakeGitHub(REC);
    f.prs[80] = { files: [], closes: [], body: "Closes #49", head: "feat/49-invoice-export", base: "batch/2026-10-26-1", model: null, merged: true };
    const r = finish(f, ["49"], { cwd: worktree().work });
    expect(r.code).toBe(0);
    expect(r.waits).toEqual([]);
    expect(r.out).toContain("✅ PR #80 is merged into batch/2026-10-26-1 — #49 stays «В работе» till the batch's release");
    expect(f.mutations).toEqual([]);
  });

  it("task finish не на ветке задачи и с незакоммиченной правкой — отказ до изменений", () => {
    const f = new FakeGitHub(REC);
    const other = finish(f, ["49"], { cwd: worktree().work });
    expect(other.code).toBe(2);
    expect(other.err).toContain("the checkout is on «claude/x-1», not on a branch of #49");
    const { work } = onBranch();
    writeFileSync(path.join(work, "README.md"), "changed\n");
    const dirty = finish(f, ["49"], { cwd: work });
    expect(dirty.code).toBe(1);
    expect(dirty.out).toContain("! uncommitted changes in the checkout");
    expect(created(f)).toEqual([]);
  });
});
