import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, setDefaultTimeout } from "bun:test";

import { main } from "../../../skills/github/scripts/github.ts";
import { CLOUD_SIGNATURE, epicInProgress, FakeGitHub } from "../../lib/fake-github.ts";
import type { Recording } from "../../lib/fake-github.ts";
import { SPAWN_TIMEOUT } from "../../lib/spawn.ts";

setDefaultTimeout(SPAWN_TIMEOUT);

// Ответы GitHub — записанные с проекта Elves, `gh` подменён (как в github-task.test.ts): эпик #45 «В работе», #47 — его задача
const REC: Recording = epicInProgress(JSON.parse(readFileSync(new URL("../../lib/github-elves.json", import.meta.url), "utf8")));
const REPO = "miroshnik/elves";
/** Строка запуска скрипта в исправленной команде — та, что агент вставит как есть. */
const RUN = `bun --no-env-file ${fileURLToPath(new URL("../../../skills/github/scripts/github.ts", import.meta.url))} `;

function call(f: FakeGitHub, argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(argv, { gh: f.gh, out: (l) => out.push(l), err: (l) => err.push(l), sleep: () => {}, env: {} });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/** Аргументы исправленной команды — второй строки ошибки — так, как их разберёт shell: кавычки проверяет сам shell. */
function fixedArgs(err: string): string[] {
  const line = err.split("\n")[1] ?? "";
  expect(line).toStartWith(RUN);
  return execFileSync("sh", ["-c", `printf '%s\\0' ${line.slice(RUN.length)}`], { encoding: "utf8" }).split("\0").slice(0, -1);
}
const bodyOf = (f: FakeGitHub) => f.mutations.filter((m) => m.op === "UpdateIssue").at(-1)?.input.body;
const created = (f: FakeGitHub) => f.mutations.filter((m) => m.op === "CreateIssue").map((m) => m.input);

const BODY = "Экспорт счетов.\n\n## Что сделать\n\n- [ ] PDF-выгрузка\n\n## Сценарии\n\n- выгрузка в PDF\n";

describe("Ошибка вызова печатает исправленную команду целиком, а не отсылает к --help", () => {
  it("`task edit` с неизвестным флагом печатает исправленную команду целиком", () => {
    const f = new FakeGitHub(REC);
    f.issue(47).body = BODY;
    const r = call(f, ["task", "edit", "47", "--append", "## Сценарии", "выгрузка в CSV", "--chek", "PDF", "--repo", REPO]);
    expect(r.code).toBe(2);
    expect(r.err.split("\n")).toEqual(["error: task edit: no option --append — --add", `${RUN}task edit 47 --add '## Сценарии' 'выгрузка в CSV' --chek PDF --repo miroshnik/elves`]);
    expect(f.mutations).toEqual([]);
    // исправленная команда — снова с ошибкой в следующем флаге, исправленная — работает
    const next = call(f, fixedArgs(r.err));
    expect(next.err.split("\n")[0]).toBe("error: task edit: no option --chek — --check");
    const done = call(f, fixedArgs(next.err));
    expect(done.err).toBe("");
    expect(done.code).toBe(0);
    expect(bodyOf(f)).toBe(BODY.replace("- [ ] PDF", "- [x] PDF").replace("- выгрузка в PDF\n", "- выгрузка в PDF\n- выгрузка в CSV\n"));
  });

  it("`task new` без обязательного аргумента печатает команду с ним и остальными аргументами вызова", () => {
    const f = new FakeGitHub(REC);
    const r = call(f, ["task", "new", "--body", "Что сделать", "--epic", "45", "--repo", REPO]);
    expect(r.code).toBe(2);
    expect(r.err.split("\n")).toEqual(["error: task new: --title is required", `${RUN}task new --title '<title>' --body 'Что сделать' --epic 45 --repo miroshnik/elves`]);
    // заголовок аргументом — он и становится --title
    const positional = call(f, ["task", "new", "Экспорт счетов", "--body", "Что сделать", "--repo", REPO]);
    expect(positional.err.split("\n")).toEqual(["error: task new: the title is the value of --title, not an argument", `${RUN}task new --title 'Экспорт счетов' --body 'Что сделать' --repo miroshnik/elves`]);
    expect(f.mutations).toEqual([]);
    expect(call(f, fixedArgs(positional.err)).code).toBe(0);
    expect(created(f).map((m) => [m.title, m.body])).toEqual([["Экспорт счетов", "Что сделать"]]);
  });

  // 404 из 437 вызовов `task new` за 1–16 ноября передавали --branch-type — с #835 его нет
  it("`task new` с `--branch-type` печатает команду без него — тип ветки приходит с `task start --branch`", () => {
    const f = new FakeGitHub(REC);
    const r = call(f, ["task", "new", "--title", "Экспорт", "--branch-type", "feat", "--epic", "45", "--repo", REPO]);
    expect(r.code).toBe(2);
    expect(r.err.split("\n")).toEqual([
      "error: task new: --branch-type is gone — no estimate since #835, the branch type comes with task start --branch",
      `${RUN}task new --title 'Экспорт' --epic 45 --repo miroshnik/elves`,
    ]);
    expect(call(f, fixedArgs(r.err)).code).toBe(0);
    expect(created(f).map((m) => m.title)).toEqual(["GitHub · Экспорт"]);
  });

  it("опция под другим именем или с опечаткой — команда с той, что имелась в виду", () => {
    const f = new FakeGitHub(REC);
    const r = call(f, ["task", "new", "--title", "Экспорт", "--parent", "45", "--blocked-bu", "49", "--repo", REPO]);
    expect(r.err.split("\n")).toEqual(["error: task new: no option --parent — --epic; no option --blocked-bu — --blocked-by", `${RUN}task new --title 'Экспорт' --epic 45 --blocked-by 49 --repo miroshnik/elves`]);
    expect(call(f, ["pr", "labels", "57", "--rpeo", REPO]).err.split("\n")).toEqual(["error: pr labels: no option --rpeo — --repo", `${RUN}pr labels 57 --repo miroshnik/elves`]);
  });

  it("опция без близкой — строка с опциями команды и её синтаксис, без «--help»", () => {
    const r = call(new FakeGitHub(REC), ["task", "new", "--title", "Экспорт", "--frobnicate", "--repo", REPO]);
    expect(r.code).toBe(2);
    const [what, ...synopsis] = r.err.split("\n");
    expect(what).toBe("error: task new: no option --frobnicate; its options: --title, --body, --body-file, --type, --epic, --milestone, --blocked-by, --priority, --labels, --repo");
    expect(synopsis[0]).toStartWith('github task new --title "…"');
    expect(r.err).not.toContain("--help");
  });

  it("текст ответа с дефиса — команда с текстом после `--`, и она ставит ответ", () => {
    const f = new FakeGitHub(REC);
    f.issue(47).body = "## Вопросы\n\n1. Как продолжать?\n";
    const r = call(f, ["task", "answer", "47", "1", "--resume: продолжает ветку", "--auto", "--repo", REPO]);
    expect(r.code).toBe(2);
    expect(r.err.split("\n")).toEqual([
      "error: task answer: «--resume: продолжает ветку» starts with a dash — a text, not an option: after --",
      `${RUN}task answer 47 1 --auto --repo miroshnik/elves -- '--resume: продолжает ветку'`,
    ]);
    expect(call(f, fixedArgs(r.err)).code).toBe(0);
    expect(bodyOf(f)).toBe("## Вопросы\n\n1. ✅ авто Как продолжать? **Ответ:** --resume: продолжает ветку\n");
  });

  it("значение с дефиса — склеено с опцией через «=», опция без значения — с местом для него, флаг со значением — без него", () => {
    const f = new FakeGitHub(REC);
    const dash = call(f, ["task", "new", "--title", "Экспорт", "--body", "- [ ] PDF", "--repo", REPO]);
    expect(dash.err.split("\n")).toEqual(["error: task new: the value of --body starts with a dash — glued by =", `${RUN}task new --title 'Экспорт' '--body=- [ ] PDF' --repo miroshnik/elves`]);
    expect(call(f, fixedArgs(dash.err)).code).toBe(0);
    expect(created(f).map((m) => m.body)).toEqual(["- [ ] PDF"]);
    expect(call(f, ["task", "new", "--title", "--epic", "45", "--repo", REPO]).err.split("\n")).toEqual(["error: task new: --title without its value", `${RUN}task new --title '<title>' --epic 45 --repo miroshnik/elves`]);
    expect(call(f, ["task", "close", "47", "--no-git=yes", "--repo", REPO]).err.split("\n")).toEqual(["error: task close: --no-git is a flag, without a value", `${RUN}task close 47 --no-git --repo miroshnik/elves`]);
  });
});

describe("`task edit --add` — раздел по имени без «##», недостающий раздел канона создаётся", () => {
  const edit = (body: string, args: string[]) => {
    const f = new FakeGitHub(REC);
    f.issue(47).body = body;
    return { f, r: call(f, ["task", "edit", "47", ...args, "--repo", REPO]) };
  };

  it("`task edit --add` с именем раздела без «##» добавляет пункт в раздел с этим заголовком", () => {
    const { f, r } = edit(BODY, ["--add", "Сценарии", "выгрузка в CSV"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(bodyOf(f)).toBe(BODY.replace("- выгрузка в PDF\n", "- выгрузка в PDF\n- выгрузка в CSV\n"));
    expect(r.out).toBe("+ #47: description — 1 edit: added to «## Сценарии»");
  });

  it("`task edit --add` в раздел канона, которого в описании нет, создаёт его в конце описания", () => {
    const { f, r } = edit("Экспорт счетов.\n\n## Что сделать\n\n- [ ] PDF\n", ["--add", "## Сценарии", "выгрузка в PDF", "--add", "Вопросы", "Формат?"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    // первый вопрос — «1.»: task answer ищет вопрос по номеру
    expect(bodyOf(f)).toBe("Экспорт счетов.\n\n## Что сделать\n\n- [ ] PDF\n\n## Сценарии\n\n- выгрузка в PDF\n\n## Вопросы\n\n1. Формат?\n");
    expect(r.out).toBe("+ #47: description — 2 edits: added to «## Сценарии» — a new section, added to «## Вопросы» — a new section");
    // подпись облачного прокси остаётся последней
    const cloud = edit(`Что сделать.\n\n${CLOUD_SIGNATURE}`, ["--add", "## Сценарии", "выгрузка в PDF"]);
    expect(bodyOf(cloud.f)).toBe(`Что сделать.\n\n## Сценарии\n\n- выгрузка в PDF\n\n${CLOUD_SIGNATURE}`);
  });

  it("`task edit --add` в другой раздел, которого нет, отказывает и называет разделы описания", () => {
    const { f, r } = edit(BODY, ["--add", "## Готово, когда", "файл открывается"]);
    expect(r.code).toBe(2);
    expect(r.err).toBe("error: #47: --add — no section «## Готово, когда»; the description's sections: «## Что сделать», «## Сценарии»");
    expect(f.mutations).toEqual([]);
  });
});
