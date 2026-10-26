/**
 * Хелперы для тестов скилла task-env: пути скрипта и compose-файла прокси, запуск команды, подставной gh задач — общие
 * для быстрого `task-env.test.ts` и медленного `task-env.slow.test.ts`. Не спека — в документацию не попадает.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SCRIPT = fileURLToPath(new URL("../../skills/task-env/scripts/task-env.ts", import.meta.url));
export const COMPOSE = fileURLToPath(new URL("../../skills/task-env/proxy/compose.yaml", import.meta.url));

export function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const r = spawnSync(cmd, args, { encoding: "utf8", env });
  if (r.error) throw r.error;
  return r;
}

/**
 * Подставной gh: `gh api repos/<репозиторий>/issues/<N>` — состояние задачи из FAKE_GH_STATES («41=closed 42=open»),
 * другого номера нет — 404; аргументы — в журнал FAKE_GH_LOG.
 */
export const FAKE_GH = [
  "#!/bin/sh",
  'printf \'%s\\n\' "$*" >> "$FAKE_GH_LOG"',
  'n="${2##*/}"',
  "for s in $FAKE_GH_STATES; do",
  '  if [ "${s%%=*}" = "$n" ]; then echo "{\\"number\\": $n, \\"state\\": \\"${s#*=}\\"}"; exit 0; fi',
  "done",
  'echo "gh: Not Found (HTTP 404)" >&2',
  "exit 1",
  "",
].join("\n");

/** Журнал подставной команды: строки вызовов. */
export const calls = (log: string) => readFileSync(log, "utf8").split("\n").filter(Boolean);

/** Ждать события дольше этого — ошибка с объяснением, а не таймаут теста без него. */
export const PATIENCE = 30_000;
/** Таймаут одного запроса в `untilAnswer`: неответ за это время — «ещё нет», а не ошибка. */
const ASK = 1_000;

/** Запрос через прокси на `127.0.0.1:<port>` с заголовком Host — так браузер приходит по адресу `*.localhost`. */
export async function proxyGet(port: string, host: string, timeout = PATIENCE) {
  const r = await fetch(`http://127.0.0.1:${port}/`, { headers: { Host: host }, signal: AbortSignal.timeout(timeout) });
  return { status: r.status, body: await r.text() };
}

/**
 * Ждёт ответа status по host: прокси узнаёт о контейнерах из событий Docker, а не сразу. Запрос, пока событие не
 * дошло, идёт на адрес остановленного контейнера (стек пересоздан, у e2e — с чистыми томами) и висит до таймаута
 * Traefik (504 через 30 с) — у каждого запроса свой короткий таймаут, неответ — «ещё нет», а не TimeoutError.
 */
export async function untilAnswer(port: string, host: string, status: number, patience = PATIENCE) {
  const deadline = Date.now() + patience;
  let last = { status: 0, body: "" };
  while (Date.now() < deadline) {
    try {
      last = await proxyGet(port, host, ASK);
    } catch (e) {
      if ((e as Error).name !== "TimeoutError") throw e;
      last = { status: 0, body: `no answer in ${ASK / 1000} s` };
    }
    if (last.status === status) return last;
    await Bun.sleep(100);
  }
  throw new Error(`${host}: за ${patience / 1000} с не дождались ${status}, последний ответ ${last.status} ${last.body.slice(0, 200)}`);
}
