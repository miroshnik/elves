import { describe, expect, it } from "bun:test";

import { invariant } from "../../../skills/spec/scripts/harness.ts";
import { documentsOf, FRAGMENT_FILES, readFragmentFile } from "../../lib/yaml-fragments.ts";

const WORKFLOWS = ".github/workflows";
const CI = `${WORKFLOWS}/ci.yml`;

interface Step {
  name?: string;
  run?: string;
  uses?: string;
  "timeout-minutes"?: unknown;
}

interface Job {
  steps?: Step[];
  "timeout-minutes"?: unknown;
}

/** Job workflow: файл, имя и её `timeout-minutes`; ключ — файл и путь YAML. */
interface JobItem {
  file: string;
  job: string;
  timeout: unknown;
  key: string;
}

/** Шаг, который ставит пакеты: файл, путь job (`jobs.<id>`, у списка шагов — `steps`), имя шага (или первая строка `run`) и его `timeout-minutes`. */
interface StepItem {
  file: string;
  where: string;
  step: string;
  timeout: unknown;
  key: string;
}

/**
 * Установка пакетов из сети: системный менеджер (`apt-get update`, `brew install`), менеджер проекта (`bun install`,
 * `npm ci`), `pip install`, `playwright install` — он ставит браузеры, с `--with-deps` и пакеты apt.
 */
const INSTALL =
  /\b(?:apt-get|apt|dnf|yum|apk|zypper|brew|choco|snap)\s+(?:-\S+\s+)*(?:install|update|upgrade|add)\b|\b(?:bun|npm|pnpm|yarn)\s+(?:install|i|ci|add)\b|\bpip3?\s+install\b|\bplaywright\s+install\b/;

/**
 * Job документа YAML; якоря раскрыты — шаг под псевдонимом стоит в своей job целиком. Фрагмент — список шагов, без
 * `jobs:` — одна безымянная job `steps`: правило шага без правила job. Job без тела — заглушка фрагмента («… шаги как
 * выше»), не job.
 */
function jobsOf(text: string): { where: string; job: Job; whole: boolean }[] {
  const doc = Bun.YAML.parse(text) as { jobs?: Record<string, Job | null> } | Step[] | null;
  if (Array.isArray(doc)) return [{ where: "steps", job: { steps: doc }, whole: false }];
  return Object.entries(doc?.jobs ?? {}).flatMap(([name, j]) => (j ? [{ where: `jobs.${name}`, job: j, whole: true }] : []));
}

/** С номером по порядку — одинаковые ключи одного файла. */
function numbered<T extends { key: string }>(items: T[]): T[] {
  const seen = new Map<string, number>();
  return items.map((x) => {
    const n = (seen.get(x.key) ?? 0) + 1;
    seen.set(x.key, n);
    return n > 1 ? { ...x, key: `${x.key} (${n})` } : x;
  });
}

const jobItems = (file: string, text: string): JobItem[] =>
  numbered(
    documentsOf(file, text).flatMap((d) =>
      jobsOf(d.text)
        .filter((j) => j.whole)
        .map(({ where, job }) => ({ file, job: where.slice("jobs.".length), timeout: job["timeout-minutes"], key: `${file} ${where}` })),
    ),
  );

/** Шаги установки пакетов. */
const installSteps = (file: string, text: string): StepItem[] =>
  numbered(
    documentsOf(file, text).flatMap((d) =>
      jobsOf(d.text).flatMap(({ where, job }) =>
        (job.steps ?? [])
          .filter((s) => typeof s?.run === "string" && INSTALL.test(s.run))
          .map((s) => {
            const step = s.name ?? s.run!.trim().split("\n")[0]!;
            return { file, where, step, timeout: s["timeout-minutes"], key: `${file} ${where} «${step}»` };
          }),
      ),
    ),
  );

/** Предел задан: минут больше нуля или выражение `${{ … }}`. */
const bounded = (t: unknown): boolean => (typeof t === "number" && t > 0) || (typeof t === "string" && /^\$\{\{.*\}\}$/.test(t.trim()));

function jobViolation(j: JobItem): string | null {
  if (bounded(j.timeout)) return null;
  return `${j.key} — без timeout-minutes: зависший шаг держит прогон до 6 часов, предела GitHub по умолчанию`;
}

function stepViolation(s: StepItem): string | null {
  if (bounded(s.timeout)) return null;
  return `${s.file} ${s.where}: шаг «${s.step}» ставит пакеты из сети без своего timeout-minutes — зависшее зеркало держит его до предела job`;
}

/** Проверка элемента реестра: нарушение — ошибка с его текстом. */
function throwing<T>(violation: (x: T) => string | null): (x: T) => void {
  return (x) => {
    const v = violation(x);
    if (v) throw new Error(v);
  };
}

const JOBS = FRAGMENT_FILES.flatMap((f) => jobItems(f, readFragmentFile(f)));
const STEPS = FRAGMENT_FILES.flatMap((f) => installSteps(f, readFragmentFile(f)));
const SPEC_CI = "skills/spec/ci.md";

const ZSH_662 = "      - name: zsh\n        run: command -v zsh || { sudo apt-get update -qq && sudo apt-get install -y -qq zsh; }\n";

describe("Шаг, который ставит пакеты из сети, ограничен по времени и во фрагментах CI, которые копируют проекты: зависшее зеркало apt не держит прогон часами", () => {
  invariant(it, {
    registry: "шаги установки пакетов в .github/workflows и YAML-фрагментах skills/**/*.md и docs/*.md",
    items: STEPS,
    key: (s) => s.key,
    name: (s) => `${s.key} ограничен по времени`,
    check: throwing(stepViolation),
    violator: { name: "шаг zsh прогона PR #662", item: installSteps("ci.yml", `jobs:\n  tests:\n    timeout-minutes: 20\n    steps:\n${ZSH_662}`)[0]! },
    // шаги окружения полного набора: выпавший из разбора ушёл бы из реестра молча
    // и фрагмента, который проект копирует как есть
    includes: [
      `${CI} jobs.tests «zsh»`,
      `${CI} jobs.tests «bun install --frozen-lockfile»`,
      `${SPEC_CI} jobs.unit «pnpm install --frozen-lockfile»`,
      `${SPEC_CI} jobs.e2e «pnpm exec playwright install --with-deps»`,
    ],
  });

  describe("примеры", () => {
    it("шаг без своего предела — ошибка с файлом, job и шагом, даже если предел есть у job", () => {
      const [s] = installSteps("ci.yml", `jobs:\n  tests:\n    timeout-minutes: 20\n    steps:\n${ZSH_662}`);
      expect(stepViolation(s!)).toBe("ci.yml jobs.tests: шаг «zsh» ставит пакеты из сети без своего timeout-minutes — зависшее зеркало держит его до предела job");
    });

    it("установка — системным менеджером с опциями до команды, менеджером проекта, pip и playwright", () => {
      const runs = ["sudo apt-get -qq update", "apt install -y zsh", "brew install zsh", "npm ci", "npm i -g bun@latest", "pnpm install --frozen-lockfile", "pip3 install -r req.txt", "pnpm exec playwright install --with-deps"];
      expect(runs.filter((r) => !INSTALL.test(r))).toEqual([]);
    });

    it("сборка, тесты, публикация и проверка наличия — не установка", () => {
      const runs = ["bun run typecheck", "bun test", "npm publish", "command -v zsh", "apt-cache policy zsh", "bun --no-env-file bin/elves.ts pack v1"];
      expect(runs.filter((r) => INSTALL.test(r))).toEqual([]);
    });

    it("шаг под псевдонимом якоря — шаг своей job со своим пределом; без имени — ключ по первой строке run", () => {
      const yml = "jobs:\n  a:\n    steps:\n      - &deps\n        timeout-minutes: 5\n        run: |\n          bun install\n          bun run build\n  b:\n    steps:\n      - *deps\n";
      expect(installSteps("ci.yml", yml).map((s) => [s.key, s.timeout])).toEqual([
        ["ci.yml jobs.a «bun install»", 5],
        ["ci.yml jobs.b «bun install»", 5],
      ]);
    });

    it("фрагмент в Markdown — блок ```yaml; список шагов без jobs: — шаги без job, заглушка job без тела — не job", () => {
      const md =
        "# CI\n\n```yaml\n      - run: pnpm install\n```\n\n```yaml\njobs:\n  unit:\n    # … шаги как выше\n  e2e:\n    steps:\n      - run: pnpm install\n```\n";
      expect(installSteps("docs/x.md", md).map((s) => s.key)).toEqual(["docs/x.md steps «pnpm install»", "docs/x.md jobs.e2e «pnpm install»"]);
      expect(jobItems("docs/x.md", md).map((j) => j.key)).toEqual(["docs/x.md jobs.e2e"]);
      expect(stepViolation(installSteps("docs/x.md", md)[0]!)).toStartWith("docs/x.md steps: шаг «pnpm install» ставит пакеты из сети без своего timeout-minutes");
    });

    it("одинаковые шаги одного файла в разных блоках различает номер", () => {
      const job = "```yaml\njobs:\n  unit:\n    steps:\n      - run: pnpm install\n```\n";
      expect(installSteps("docs/x.md", job + "\n" + job).map((s) => s.key)).toEqual(["docs/x.md jobs.unit «pnpm install»", "docs/x.md jobs.unit «pnpm install» (2)"]);
    });

    it("предел — минут больше нуля или выражение; ноль и текст — не предел", () => {
      expect([5, "${{ inputs.timeout }}", 0, "5", undefined].map(bounded)).toEqual([true, true, false, false, false]);
    });
  });
});

describe("Каждая job ограничена по времени: зависший шаг не держит прогон до 6 часов, предела GitHub по умолчанию", () => {
  invariant(it, {
    registry: "job в .github/workflows и YAML-фрагментах skills/**/*.md и docs/*.md",
    items: JOBS,
    key: (j) => j.key,
    name: (j) => `${j.key} ограничена по времени`,
    check: throwing(jobViolation),
    violator: { name: "job tests прогона PR #662", item: jobItems("ci.yml", "jobs:\n  tests:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bun test\n")[0]! },
    includes: [`${CI} jobs.tests`, `${CI} jobs.spec-publish`, `${WORKFLOWS}/npm.yml jobs.publish`, `${SPEC_CI} jobs.e2e`, "docs/ci-concurrency.md jobs.deploy-dev"],
  });

  it("пример: job без предела — ошибка с файлом и job", () => {
    const [j] = jobItems("ci.yml", "jobs:\n  tests:\n    steps:\n      - run: bun test\n");
    expect(jobViolation(j!)).toBe("ci.yml jobs.tests — без timeout-minutes: зависший шаг держит прогон до 6 часов, предела GitHub по умолчанию");
  });
});
