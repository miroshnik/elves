<!-- spec-doc: сгенерировано из названий тестов, руками не править -->
# tests

Тесты Elves: уровни прогона и устойчивость к нагрузке и сбоям машины.

## fast-tests

Локальный `test` — быстрый уровень: тесты, которым нужен Docker, живой сервер или сеть corepack, лежат в файлах
`*.slow.test.ts` и идут скриптом `test:slow`, CI гоняет оба уровня; повторы `gh` в тестах — без настоящих пауз.

Прогон тестов Elves вырос с 45 с (409 тестов, 2026-09-28) до 220–330 с (1 830 тестов). Замер 2026-10-14 под нагрузкой
машины: из 326 с стеки task-env с настоящим Docker шли 147 с, сервер dashboard — 45 с, из них 44 с — один тест ошибки
GitHub, который ждал настоящих пауз повторов `gh`. Перед коммитом `test` идёт каждый раз, а в песочнице агента нет ни
Docker, ни порта на 127.0.0.1 — эти тесты там шумят (#417).

### Уровни

- `test` — всё, кроме `*.slow.test.ts` и `tests/standards` (`--path-ignore-patterns`). Перед коммитом — затронутое
  правкой: `bun run test --changed=origin/main` и отдельным прогоном — папки решений, чьи скрипты правка меняет (тесты
  зовут их процессом, граф импортов их не видит); целиком — CI (`docs/testing.md`, #538).
- `test:spec` — только `tests/standards`, перед `test`: стандарты — статические проверки, им хватает одного прогона
  (скилл `spec`, `checks.md`); в `test` они шли бы второй раз — около 880 тестов, ~3 с (#479).
- `test:slow` — только `*.slow.test.ts`: локально — когда правка касается того, что они проверяют (стек и прокси
  task-env, сервер dashboard, проект на Yarn 2+ у install). CI гоняет все: его `spec:doc` идёт голым `bun test`, по всем файлам, — стандарты в нём
  один раз.

Медленный файл лежит в папке решения рядом с быстрым: `<имя>.slow.test.ts`. Для `spec-doc` это тоже главный файл папки,
как `.e2e.ts`: страница — сначала утверждения быстрого файла, затем медленного. Уровень — по имени файла: `bun test`
выбирает и пропускает файлы, а не describe.

Причина уровня проверяется в обе стороны: тест, который пробует демон Docker (`docker info`), запускает скрипт
сервером (`spawn`) и ходит к нему `fetch` или запускает процесс `corepack`, — в медленном файле; медленный файл без такой
причины — нарушение, иначе в `test:slow` уходило бы просто медленное или красное. corepack ставит менеджер пакетов по
`packageManager` проекта из сети — Yarn 2+ вживую (#608): без сети, в песочнице агента, тест шумел бы, как без Docker.

### Паузы повторов gh

Скрипты est и dashboard повторяют `gh` при сбое сети с паузами 2, 5 и 15 с (`ELVES_GH_RETRY_MS`). Preload прогона
(`bunfig.toml`) ставит `ELVES_GH_RETRY_MS=0,0,0`: повторов столько же, пауз нет; дочерние процессы наследуют окружение
прогона, и тест со сбоем сети не ждёт 22 с на каждый запрос.

### Отвергнуто

- `describe.skipIf` по переменной окружения: файл всё равно загружается, а пропущенные тесты попадают в отчёт
  пропущенными (#417).
- Отдельный каталог `tests/slow/`: решение распалось бы на две папки, а папка — дом решения.
- Бюджет времени на тест: под нагрузкой машины — ложные падения (`tests/standards/tests/spawn-timeout`).

### Локальный test — быстрый уровень: тесты с Docker, живым сервером и corepack — в файлах *.slow.test.ts скрипта test:slow, CI гоняет оба

<details><summary>✅ 15 тестов</summary>

- ✅ реестр «тесты Elves, которым нужен Docker, живой сервер или corepack» не пуст
- ✅ реестр «тесты Elves, которым нужен Docker, живой сервер или corepack» находит tests/capabilities/task-env/stacks.slow.test.ts, tests/capabilities/dashboard/serve.slow.test.ts, tests/capabilities/elves/install.slow.test.ts
- ✅ нарушитель не проходит: быстрый файл с пробой docker info
- ✅ tests/capabilities/dashboard/serve.slow.test.ts (живой сервер) — в медленном уровне
- ✅ tests/capabilities/elves/install.slow.test.ts (corepack) — в медленном уровне
- ✅ tests/capabilities/task-env/stacks.slow.test.ts (Docker) — в медленном уровне
- ✅ реестр «медленные тесты Elves» не пуст
- ✅ нарушитель не проходит: медленный файл без Docker, сервера и corepack
- ✅ tests/capabilities/dashboard/serve.slow.test.ts — медленный по причине: Docker, живой сервер или corepack
- ✅ tests/capabilities/elves/install.slow.test.ts — медленный по причине: Docker, живой сервер или corepack
- ✅ tests/capabilities/task-env/stacks.slow.test.ts — медленный по причине: Docker, живой сервер или corepack
- ✅ скрипт test не запускает тесты, которым нужен Docker, живой сервер или corepack: файлы *.slow.test.ts идут скриптом test:slow
- ✅ скрипт test не повторяет test:spec: стандарты Elves идут только скриптом test:spec
  > Стандарты — статические проверки, им хватает одного прогона: перед коммитом идут test:spec, затем test (#479).
- ✅ CI запускает и быстрый, и медленный уровень
- ✅ скрипты под тестом повторяют gh без настоящих пауз: прогон задаёт ELVES_GH_RETRY_MS=0,0,0, дочерние процессы его наследуют
  > Паузы — 2, 5 и 15 с на каждый сбой: тест ошибки GitHub в dashboard ждал их 44 с из 45.

</details>

#### примеры

<details><summary>✅ 4 теста</summary>

- ✅ проба docker info — Docker; spawn скрипта и fetch к нему — живой сервер; процесс corepack — corepack
- ✅ spawnSync с fetch, spawn без fetch, docker compose config без демона, слово corepack в тексте — причины нет
- ✅ CI с одним test без test:slow — медленный уровень не идёт
- ✅ уровни шагом только на push в main — PR их не гоняет

</details>

## spawn-no-jit

Тест, который запускает bun, на macOS запускает его без JIT (`BUN_JSC_useJIT=0`), — чтобы крэш macOS 27 при старте
процесса не ронял случайный зелёный тест.

На macOS 27 новый процесс bun изредка падает через несколько миллисекунд после старта: SIGTRAP в
`pthread_jit_write_protect_np` при первом переключении JIT-памяти на запись. Это гонка в системе, а не в bun
(oven-sh/bun#42687, метка `upstream:apple`), частота — примерно 1 на 20–100 тыс. запусков. До кода теста дело не
доходит: `spawnSync` отдаёт `status: null` и `signal: "SIGTRAP"`. Полный прогон запускает ~150 процессов bun, значит
краснеет 0,2–0,8 % прогонов, и тест каждый раз случайный.

### Почему без JIT, а не ретрай

Без JIT JSC не резервирует JIT-регион и не вызывает `pthread_jit_write_protect_np` — причины нет. Ретрай спрятал бы
любой крэш, а не только этот. Скорость не страдает: процессы в тестах короткие, полный прогон с дочерними bun без JIT
шёл 43 с, с JIT — 48,6 с.

### Почему preload и только macOS

JSC читает переменную при старте процесса. Preload из `bunfig.toml` ставит её в окружение прогона до первого теста, а
дочерние процессы наследуют окружение. Сам прогон стартовал раньше и идёт с JIT. На Linux, где идёт CI, бага нет — JIT
остаётся.

### Когда снять

Обход временный: фикс — oven-sh/WebKit#663. Когда выйдет релиз bun с ним, стандарт и preload убирает #146.

### Тест, который запускает bun, не падает от крэша macOS 27 при старте процесса: на macOS дочерний bun — без JIT

<details><summary>✅ 1 тест</summary>

- ✅ на macOS окружение прогона выключает JIT дочерним процессам, на других системах — не трогает
  > Прогон ставит `BUN_JSC_useJIT=0` в своё окружение до первого теста, дочерние процессы его наследуют. На других
  > системах бага нет, и JIT остаётся.

</details>

## spawn-timeout

Тест, который запускает процессы (git, node, bun), держит таймаут `SPAWN_TIMEOUT`, а не 5 с bun по умолчанию, — чтобы
нагрузка машины не роняла зелёные тесты.

Время такого теста — время его процессов, а оно растёт с нагрузкой: параллельные сессии агентов замедляют запуск node
и git в разы, и тест на секунду идёт 5–15 с, а установка через npm — до 45 с. Падение по таймауту тогда ложное —
гонки и ожидания событий нет, тест детерминирован; таймаут 2 мин ловит только зависание.

### Почему таймаут в каждом файле

Не один на прогон: ключа `timeout` у `bun test` в `bunfig.toml` нет (документация bun), `setDefaultTimeout` в
preload действует только на первый файл прогона (проверено на bun 1.4.2), а `--timeout` в скриптах `package.json`
не видит голый `bun test`. 2 мин — запас ×2,5 к установке через npm под нагрузкой ~70 на 16 ядрах (44–48 с; при
обычной нагрузке — 4,5 с).

### Тест, который запускает процессы, не падает от нагрузки машины: таймаут SPAWN_TIMEOUT

<details><summary>✅ 52 теста</summary>

- ✅ реестр «тесты Elves, которые запускают процессы» не пуст
- ✅ нарушитель не проходит: файл с node:child_process без таймаута
- ✅ tests/capabilities/ci-wait/wait.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/dashboard/serve.slow.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/elves/agent-shell.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/elves/install.real-project.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/elves/install.slow.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/elves/install.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/elves/release.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/elves/update.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/est/estimate-and-actual.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/github/github-premerge.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/github/github-project.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/github/github-task.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/slot/capacity.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/slot/queue.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/spec/precommit.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/spec/spec-break.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/spec/spec-claims.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/spec/spec-diff.parse-source.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/spec/spec-diff.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/spec/spec-doc.architecture.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/spec/spec-doc.names.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/spec/spec-doc.sequence.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/spec/spec-doc.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/spec/spec-harness.architecture.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/spec/spec-harness.claimed-code.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/spec/spec-harness.exceptions.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/spec/spec-harness.lint.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/spec/spec-harness.meta.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/spec/spec-harness.package.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/spec/spec-harness.sequence.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/spec/spec-harness.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/spec/spec-publish.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/spec/spec-shard.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/task-env/stacks.slow.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/capabilities/task-env/stacks.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/standards/documents/flow-english.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/standards/documents/readme.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/standards/exports/consumer-typecheck.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/standards/exports/harness-load.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/standards/scripts/check-run-state.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/standards/scripts/cli-help.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/standards/scripts/no-env-file.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/standards/scripts/old-name.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/standards/scripts/package-manager.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/standards/scripts/pr-workflow-run.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/standards/scripts/project-manifest.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/standards/scripts/spec-publish-job.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/standards/scripts/temp-worktree.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ tests/standards/tests/fast-tests.test.ts задаёт setDefaultTimeout(SPAWN_TIMEOUT)
- ✅ в реестр попадают установщик, скрипты spec и est

</details>

#### примеры

<details><summary>✅ 4 теста</summary>

- ✅ файл с node:child_process без таймаута — нарушение
- ✅ хелпер из модуля tests/lib, который запускает процессы сам или через другой модуль, — тоже нарушение
- ✅ с setDefaultTimeout(SPAWN_TIMEOUT) — чисто
- ✅ без процессов — вне правила: свой модуль без процессов, import type, пример кода в строке

</details>
