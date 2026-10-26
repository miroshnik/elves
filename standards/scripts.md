<!-- spec-doc: сгенерировано из названий тестов, руками не править -->
# scripts

Скрипты флоу — установщик `elves` и скрипты скиллов: как их запускают, что они отвечают на `--help`, где берут
общее (каталог конфигурации, манифест, временный worktree) и как разные скрипты одинаково отвечают на один вопрос —
ветка задачи, репозиторий чекаута, закрепление сессии, состояние чека.

Скилл не импортирует соседа (раздел `skill-imports`), поэтому один ответ живёт копиями в нескольких скриптах; раздел
такого вопроса держит копии одной таблицей случаев.

## check-run-state

Состояние check-run головы PR `github` и `ci-wait` читают одинаково: на вопрос «какое состояние у чека `<имя>`» по его
check-runs — status, conclusion и перезапуски — оба скрипта отвечают по одной таблице, а запросы `github` берут чеки
головы одним фрагментом.

Состояние чека читают три места: `task show` (✅, ⏳, ❌ у PR задачи), `project check` (требуемые чеки — зелёные на
каждом из последних влитых PR) и `wait-ci.sh` (PASS или FAIL ожидания). Правило жило в трёх копиях, связанных только
смыслом, и они разошлись (#492): из перезапусков `task show` брал лучший прогон, `project check` — любой зелёный,
`wait-ci.sh` — последний. Чек зелёный, потом красный на перезапуске — `task show` показывал ✅, а ожидание давало FAIL:
агент видит зелёный PR, который не влить. Теперь в `github.ts` правило одно — `checkStates`, его берут и `task show`, и
`project check`; копия — `CHECK_STATES` в `skills/ci-wait/scripts/wait-ci.sh`. Общего модуля нет: `github` и `ci-wait`
других скиллов не импортируют (стандарт `scripts#skill-imports`), а `wait-ci.sh` — bash и jq, импорта TypeScript у него нет.

### Правило

Состояния — корзины `gh pr checks`: `pass`, `skipping`, `pending`, `cancel`, `fail`.

- check-run не завершён (`queued`, `in_progress`, `waiting`) — `pending`;
- завершён: `success` — `pass`; `neutral` и `skipped` — `skipping`; `cancelled` — `cancel`; остальное (`failure`,
  `timed_out`, `action_required`, `startup_failure`, `stale`) — `fail`;
- перезапуски одного имени — решает последний check-run (больший id), а не лучший и не место в ответе API;
- одно имя у разных приложений — порознь: у каждого его последний check-run, а имя получает худшее из их состояний
  (`fail`, `cancel`, `pending`, `skipping`, `pass`) — упавший чек одного приложения не скрыть зелёным другого.

Что из состояния следует, решает читатель. `task show`: `pass` и `skipping` — ✅, `cancel` и `fail` — ❌. `wait-ci.sh`:
FAIL на `fail` и `cancel`. `project check` строже: требуемым он предлагает только `pass` — пропущенный по условию или
нейтральный чек ничего не проверил. Строгость — своя строка таблицы (`skipping` отдельно от `pass`), а не третья копия
правила.

Реестр копий — скрипты скиллов с правилом: `export function checkStates` в `.ts` и `CHECK_STATES='…'` в `.sh`. Каждая
отвечает по таблице в формате своего API и своим движком: `checkStates` — узлы `statusCheckRollup` GraphQL (перечисления
в верхнем регистре, id — `databaseId`, приложение — `checkSuite.app.databaseId`), `CHECK_STATES` — определение jq
`check_states` над check-runs REST, как в `wait-ci.sh`.

Выборка чеков головы — фрагмент `HEAD_CHECKS` в `github.ts`: каждый запрос `Q` со `statusCheckRollup` берёт его. Без id
прогона и приложения в выборке перезапуски не различить, и правило молча читало бы порядок ответа.

Вне правила. Статусы коммита (хостинг) GitHub сам сводит к последнему на контекст: `success` — `pass`, `pending` (и
`EXPECTED` GraphQL) — `pending`, остальное — `fail`. `github pr premerge` спрашивает другое — красный ли `main`: из
перезапусков он тоже берёт последний, но отменённый прогон и ждущий решения человека красным `main` не считает.

### github и ci-wait одинаково читают состояние check-run по одной таблице: status и conclusion, перезапуски одного имени

<details><summary>✅ 8 тестов</summary>

- ✅ реестр «скрипты скиллов с правилом checkStates / CHECK_STATES» не пуст
- ✅ реестр «скрипты скиллов с правилом checkStates / CHECK_STATES» находит ci-wait, github
- ✅ нарушитель не проходит: копия правила в одном из скриптов расходится с таблицей
- ✅ нарушитель не проходит: копия сводит одноимённые check-runs разных приложений в один
- ✅ ci-wait (skills/ci-wait/scripts/wait-ci.sh) читает состояние check-run по таблице
- ✅ github (skills/github/scripts/github.ts) читает состояние check-run по таблице
- ✅ чек зелёный, потом красный на перезапуске — task show и ci-wait оба называют его красным
- ✅ таблица ловит лучший прогон из перезапусков и сведение приложений в одно

</details>

### каждый запрос github с чеками головы PR берёт их одним фрагментом — с id прогона и приложением

<details><summary>✅ 7 тестов</summary>

- ✅ реестр «запросы github со statusCheckRollup» не пуст
- ✅ реестр «запросы github со statusCheckRollup» находит IssueShow, MergeRules, PrShow
- ✅ нарушитель не проходит: запрос со своей выборкой statusCheckRollup
- ✅ запрос IssueShow берёт чеки головы фрагментом HEAD_CHECKS
- ✅ запрос MergeRules берёт чеки головы фрагментом HEAD_CHECKS
- ✅ запрос PrShow берёт чеки головы фрагментом HEAD_CHECKS
- ✅ фрагмент выбирает то, что читает правило: имя, status, conclusion, id прогона и приложение

</details>

## cli-help

Скрипт флоу — установщик `elves` и исполняемый скрипт скилла — отвечает на `--help` и `-h` и у себя, и у каждой
своей команды: синтаксис и один-два примера в stdout, код 0, без сети, без внешних команд и без записи файлов.

Агент зовёт `--help`, чтобы не читать SKILL.md, а справка была только у части скриптов и только целиком: разбор сессий
в проектах (эпик #428) — `github task new --help` давал `Unknown option '--help'`, это 36 из 64 падений `task new`, а
SKILL.md агент читал руками, медиана — 8 раз за сессию. Справка — первое, что зовёт агент, поэтому она не идёт ни в
сеть, ни в git, ни в Docker: `--help` в чужом проекте и в песочнице агента должен отвечать сразу.

### Правило

- **Справка команды** (и скрипта без команд): первый абзац — синтаксис, его первая строка начинается со строки запуска
  (`github task new …`); затем что команда делает; затем `Examples:` и под ним один-два вызова этой команды — только
  с флагами из синтаксиса. Строка запуска — как в обзоре скрипта: у скрипта пакета под именем `elves` —
  `bun --no-env-file node_modules/.bin/elves spec-doc`, как в `package.json` и CI (стандарт `scripts#no-env-file`, #602): пример
  копируют как есть.
- **Справка скрипта с командами — обзор:** синтаксис каждой команды и строка `<скрипт> <command> --help` — где
  подробности.
- `--help` и `-h` — в любом месте аргументов; где аргументы уходят дальше — до них: у `task-env e2e` — до `--`, у
  `slot` — только первым аргументом.
- Справку печатает первое действие скрипта: у `elves` — до перезапуска из релиза (иначе `--help` шёл бы в сеть;
  справка — версии лаунчера и может отстать от релиза), у `wait-ci.sh` — встроенным `printf`.
- Команды скрипта — таблица справки (`HELP`): диспетчер берёт команду только из неё, и команда без справки не
  вызывается вовсе.

### Реестр

Скрипты — файлы со строкой `#!` в `skills/*/scripts/` и `bin/elves.ts`. Команды — строки синтаксиса в обзоре
каждого скрипта и вызовы в документах флоу: `…/scripts/github.ts task new` в блоке кода, `` `github task close <N>` ``
в тексте. Документ назвал команду, а справки у неё нет, — красный тест с именем документа.

### Песочница

Каждый запуск справки — с пустыми рабочим каталогом, HOME и TMPDIR, PATH только из заглушек (`gh`, `git`, `docker`,
`bun`, `sh` и др. записывают вызов в журнал), без кэша транспилятора Bun. `fetch` дочернего bun подменяет preload
(`tests/lib/cli-net.ts`): записывает обращение и отказывает, а прокси-переменные ведут на закрытый порт — обращение в
обход `fetch` падает сразу. Ловушку-сервер не поднимаем: в песочнице агента слушать порт нельзя (`fast-tests`). Вызов в
журнале, обращение к сети или новый файл — нарушение; что песочница их видит, проверяет отдельный тест со скриптом,
который делает все три.

### Почему таблица в каждом скрипте

Общего модуля у скриптов скиллов нет: `github`, `task-env`, `ci-wait` и `slot` других скиллов не импортируют (стандарт
`skill-imports`). Разбор
`--help` — десяток строк в каждом скрипте с командами; одинаковость поведения держит этот стандарт, а не общий код.

### Скрипты флоу отвечают на --help и -h: синтаксис с примером, код 0, без сети и без изменений

<details><summary>✅ 87 тестов</summary>

- ✅ реестр «скрипты флоу — установщик и исполняемые скрипты скиллов» не пуст (скрипты)
- ✅ реестр «скрипты флоу — установщик и исполняемые скрипты скиллов» находит bin/elves.ts, skills/github/scripts/github.ts, skills/est/scripts/est.ts, skills/task-env/scripts/task-env.ts, skills/ci-wait/scripts/wait-ci.sh, skills/slot/scripts/slot.ts, skills/spec/scripts/spec-doc.ts (скрипты)
- ✅ нарушитель не проходит (скрипты): справка в stderr с кодом 2
- ✅ нарушитель не проходит (скрипты): обзор без строки о справке команды
- ✅ dashboard --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ elves --help и -h — обзор команд, код 0, без сети и изменений
- ✅ est --help и -h — обзор команд, код 0, без сети и изменений
- ✅ github --help и -h — обзор команд, код 0, без сети и изменений
- ✅ precommit --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ slot --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ spec-break --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ spec-claims --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ spec-diff --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ spec-doc --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ spec-publish --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ spec-run --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ spec-shard --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ task-env --help и -h — обзор команд, код 0, без сети и изменений
- ✅ wait-ci --help и -h — обзор команд, код 0, без сети и изменений
- ✅ реестр «команды скриптов — из обзора каждого скрипта и из вызовов в документах флоу» не пуст (команды)
- ✅ реестр «команды скриптов — из обзора каждого скрипта и из вызовов в документах флоу» находит elves install, elves check, elves pack, elves spec-doc, elves slot, elves task-env up, elves task-env proxy up, github task new, github pr premerge, est fact, task-env proxy up, task-env check, wait-ci merged (команды)
- ✅ нарушитель не проходит (команды): без примеров
- ✅ нарушитель не проходит (команды): пример с флагом не из синтаксиса
- ✅ нарушитель не проходит (команды): команда без справки — обзор вместо её синтаксиса
- ✅ нарушитель не проходит (команды): скрипт пакета — справка без его строки запуска
- ✅ нарушитель не проходит (команды): обращение к сети
- ✅ нарушитель не проходит (команды): внешняя команда
- ✅ нарушитель не проходит (команды): запись файла
- ✅ нарушитель не проходит (команды): -h не то же, что --help
- ✅ elves check --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ elves install --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ elves pack --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ elves precommit --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ elves release --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ elves slot --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ elves spec-break --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ elves spec-claims --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ elves spec-diff --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ elves spec-doc --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ elves spec-publish --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ elves spec-run --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ elves spec-shard --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ elves task-env check --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ elves task-env down --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ elves task-env e2e --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ elves task-env proxy down --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ elves task-env proxy status --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ elves task-env proxy up --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ elves task-env prune --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ elves task-env up --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ elves update --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ est backtest --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ est cloud-import --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ est estimate --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ est fact --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ est history --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ est period --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ github batch release --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ github pr labels --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ github pr premerge --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ github project check --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ github project fix --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ github task actualize --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ github task answer --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ github task close --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ github task drop --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ github task edit --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ github task finish --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ github task new --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ github task queue --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ github task resume --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ github task show --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ github task start --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ github task status --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ task-env check --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ task-env down --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ task-env e2e --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ task-env proxy down --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ task-env proxy status --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ task-env proxy up --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ task-env prune --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ task-env up --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ wait-ci issue --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ wait-ci merged --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ wait-ci pr --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ wait-ci status --help и -h — синтаксис с примером, код 0, без сети и изменений
- ✅ песочница видит обращение к сети, внешнюю команду и запись файла
  > Песочница видит то, что проверка запрещает справке: без этого «без сети и изменений» было бы зелёным всегда.

</details>

## cloud-session

Скрипты скиллов, которые ходят в GitHub Projects, в облачной сессии выходят с объяснением, а не сбоем `gh`.

Облачной сессии Claude Code Projects v2 недоступны (403): скрипт без проверки падает непонятной ошибкой `gh`, и
агент ищет причину не там. Проверка — переменная `CLAUDE_CODE_REMOTE`, объяснение ведёт в `docs/cloud-sessions.md`.

### Скрипт с Projects v2 проверяет облачную сессию и объясняет, куда смотреть

<details><summary>✅ 1 тест</summary>

- ✅ скрипты скиллов Elves, которые ходят в Projects v2, проверяют облачную сессию и ссылаются на docs/cloud-sessions.md

</details>

#### примеры

<details><summary>✅ 4 теста</summary>

- ✅ скрипт с Projects v2 без проверки CLAUDE_CODE_REMOTE — нарушение
- ✅ проверка есть, а объяснение не ведёт в docs/cloud-sessions.md — нарушение
- ✅ проверка с объяснением — чисто; `gh project` — тоже Projects v2
- ✅ скрипт без Projects v2 — вне правила

</details>

## config-dir

Каталог личной конфигурации — `$ELVES_CONFIG_DIR`, иначе `~/.config/elves` — каждый скрипт вычисляет одним и тем же
выражением, поэтому скиллы видят одни и те же файлы.

В каталоге лежит то, что скиллы делят между собой: реестр репозиториев, цены и кэш `est`, закрепление задачи за
сессией `github` (`sessions/`), очередь `slot` (`slots/`). Общего модуля нет: `github` других скиллов не импортирует
(стандарт `scripts#skill-imports`). Одно решение в нескольких файлах держалось на комментарии «тот же, что у est»: другая
переменная или другой каталог по умолчанию в одном скрипте — и `github` закрепил бы сессию там, где `est` её не ищет,
молча.

### Правило

```
<окружение>.ELVES_CONFIG_DIR || path.join(<дом>, ".config", "elves")
```

— и никакого другого обращения к переменной или к пути по умолчанию в коде скрипта. `||`, а не `??`: пустая
переменная — тоже каталог по умолчанию. Остальные пути строятся от результата. Комментарии и текст справки
(`~/.config/elves`, `$ELVES_CONFIG_DIR`) — не обращение. Переменная читается через точку или в скобках
(`<окружение>["ELVES_CONFIG_DIR"]`): модуль `github` из `exports` пакета проходит тайпчек проекта с
`noPropertyAccessFromIndexSignature`, где поле индексной сигнатуры через точку — ошибка (стандарт `exports#consumer-typecheck`).

Реестр — скрипты скиллов и установщик, в коде которых названа переменная или путь по умолчанию. Скрипт, который
ушёл и от переменной, и от пути, из такого реестра выпал бы молча — известные места названы поимённо.

### Установщик — вне охвата

Установщик каталог не вычисляет, а готовит место по умолчанию: `install -g` с `ELVES_PRIVATE=<путь>` делает
`~/.config/elves` симлинком на личный чекаут —
`ELVES_CONFIG_DIR` он не читает намеренно. Переменная переопределяет каталог целиком: с ней скиллы смотрят туда, куда
она указывает, и симлинк им не нужен — на личный чекаут её направляют сразу. Заданы обе — симлинк в `~/.config/elves`
появится, но скиллы в него не заглянут.

### Каждый скрипт, которому нужен каталог личной конфигурации, берёт его из ELVES_CONFIG_DIR, иначе ~/.config/elves

<details><summary>✅ 8 тестов</summary>

- ✅ реестр «скрипты скиллов и установщик, которым нужен каталог личной конфигурации» не пуст
- ✅ реестр «скрипты скиллов и установщик, которым нужен каталог личной конфигурации» находит skills/est/scripts/est.ts, skills/github/scripts/github.ts, skills/slot/scripts/slot.ts, bin/elves.ts
- ✅ нарушитель не проходит: скрипт со своим путём каталога личной конфигурации
- ✅ нарушитель не проходит: скрипт читает ELVES_CONFIG_DIR, а каталог по умолчанию у него свой
- ✅ skills/est/scripts/est.ts берёт каталог из ELVES_CONFIG_DIR, иначе ~/.config/elves
- ✅ skills/github/scripts/github.ts берёт каталог из ELVES_CONFIG_DIR, иначе ~/.config/elves
- ✅ skills/slot/scripts/slot.ts берёт каталог из ELVES_CONFIG_DIR, иначе ~/.config/elves
- ✅ вне охвата: bin/elves.ts
  > установщик каталог не вычисляет, а готовит место по умолчанию: `install -g` с `ELVES_PRIVATE` делает `~/.config/elves` симлинком на личный чекаут; `ELVES_CONFIG_DIR` переопределяет каталог целиком — симлинк ей не нужен, скиллы смотрят туда, куда она указывает

</details>

#### примеры

<details><summary>✅ 5 тестов</summary>

- ✅ правило с окружением и домашним каталогом под любым именем — чисто
- ✅ переменная в скобках (env["ELVES_CONFIG_DIR"]) — то же правило, чисто
- ✅ пустая переменная — тоже каталог по умолчанию: `??` вместо `||` — нарушение
- ✅ правило есть, а рядом второй путь к каталогу — нарушение со строкой
- ✅ комментарий и текст справки (~/.config/elves, $ELVES_CONFIG_DIR) — не обращение к каталогу

</details>

## exception-files

Файл исключений папки решения (канон spec: «Исключения — только в `exceptions/` папки решения») каждый скрипт
распознаёт одинаково: на вопрос «файл исключений какой папки решения?» харнесс и `spec-diff` отвечают одно и то же,
`github pr labels` по тому же ответу решает, механическая ли правка.

Харнесс по ответу читает исключения и падает на файле не на месте, `spec-diff` показывает их в разделе «Исключения»
тела PR, `pr labels` не ставит за правку исключений метку решения. Копии правила расходились на краях: файл не JSON
в `exceptions/` харнесс считал ошибкой, а `pr labels` — механической правкой. Ошибка копии видна поздно: лишняя метка
у PR разбора долга, исключение, которого нет в теле PR.

### Правило

Папка решения — `tests/<вид>/<имя>`, вид — `capabilities`, `architecture`, `standards`.

- `<папка>/exceptions/<элемент>.json` — исключение папки;
- `<тема>/exceptions/<раздел>/<элемент>.json` — исключение раздела темы (эпик #685): его читает `exceptionsIn()` тестов
  раздела, `spec-diff` называет раздел в строке исключения;
- иной файл в каталоге — не `.json` или в каталоге глубже раздела — ошибка: исключение — JSON-файл;
- каталог `exceptions/` в подпапке папки решения — ошибка «только в `<папка>/exceptions/`»: каталог один на папку, его
  читает `exceptionsIn()` теста любой подпапки;
- скрытые файлы (`exceptions/.gitkeep`), файлы вне папок решений (`tests/lib`, `src`) и бывшие исключения названий
  (`names.exceptions/`, `names.exceptions.*`: названия — не исключения, #447) — не исключения.

Механическая правка в `pr labels` — файл, который spec читает исключением: ответ — папка без ошибки.

Внутри скилла spec правило одно — `exceptionFile` в `speclib.ts`; харнесс и `spec-diff` его импортируют. Между скиллами — копия в `github`: он других скиллов не импортирует
(стандарт `scripts#skill-imports`) и работает без `spec`. Реестр — скрипты скиллов, которые определяют `exceptionFile`, зовут его
или сами знают пути исключений (регулярка про `exceptions`, имя файла `exceptions.*`, путь `…/exceptions`). Копия отвечает
по одной таблице; остальные своего знания путей иметь не должны. Голое слово `"exceptions"` в коде — не знание пути:
так же называются поле и переменная.

### Файл исключений папки решения распознаётся одинаково в spec и github

<details><summary>✅ 11 тестов</summary>

- ✅ реестр «скрипты, распознающие файлы исключений» не пуст
- ✅ реестр «скрипты, распознающие файлы исключений» находит github/github, spec/harness, spec/spec-diff, spec/speclib
- ✅ нарушитель не проходит: pr labels до стандарта: каталог — любой файл на глубине папки
- ✅ нарушитель не проходит: spec-diff до стандарта: своя регулярка exceptions/
- ✅ github/github распознаёт файл исключений по таблице путей
- ✅ spec/harness распознаёт файл исключений правилом exceptionFile, без своего
- ✅ spec/spec-diff распознаёт файл исключений правилом exceptionFile, без своего
- ✅ spec/speclib распознаёт файл исключений по таблице путей
- ✅ файл исключений раздела харнесс, spec-diff и pr labels узнают одинаково
- ✅ pr labels: механическая правка — файл, который spec читает исключением
- ✅ таблица ловит расхождения pr labels до стандарта: не JSON, раздел, подпапка, скрытый файл

</details>

## no-env-file

Скрипт флоу под `bun` идёт с `--no-env-file`: env-файлы проекта — `.env`, `.env.<NODE_ENV>`, `.env.local` — в
его окружение не попадают и дальше командам не передаются.

Bun сам подгружает env-файлы рабочего каталога в окружение процесса, а скрипт флоу запускается из корня проекта. В
Node-проекте `.env.local` часто несёт прод-ключи из `vercel env pull`: с обёрткой slot они доходили до раннера тестов,
который раньше их не видел, — тесты «ключ не задан» краснели локально и были зелёными на CI, а тест с запросом во
внешний сервис ушёл бы туда с прод-ключом. То же у любого скрипта скилла: `task-env e2e` и `spec-break` передают
окружение команде, `github pr premerge` — проверкам, `gh` в `github`, `est` и `dashboard` берёт `GITHUB_TOKEN` из
`.env.local` вместо своей авторизации.

Флаг нужен на каждом вызове, а не только на внешнем: дочерний `bun` подгружает env-файлы каталога заново, а
загруженное родителем наследует — флаг вложенного вызова его уже не снимает.

### Правило

Вызов скрипта флоу через `bun` несёт `--no-env-file` сразу после `bun`:

- в документах флоу — `AGENTS.md`, `claude/CLAUDE.md`, `README.md`, `package.json`, `docs/*.md`, `*.md` скиллов —
  `bun <путь>/scripts/<скрипт>.ts`, которую агент копирует как есть;
- там же — скрипт пакета под `bun`: `bun --no-env-file node_modules/.bin/elves <скрипт>`, в `package.json` и CI
  одинаково (#596). `bun` читает bin сам, мимо его шебанга, и без флага подгрузит env-файлы каталога. На Yarn 2+ — пакет
  через bunx, `bunx @miroshnik/elves@"$(jq -r '.devDependencies["@miroshnik/elves"]' package.json)" <скрипт>`, и
  обёртка очереди — его `slot '<команда>'` (#608): bin `.ts` Yarn 2+ запускает Node-ом, мимо шебанга, при любом
  `nodeLinker`, а с PnP `node_modules` нет;
- шебанг bin пакета — через `sh`: `#!/bin/sh` и вторая строка `':' //; exec bun --no-env-file "$0" "$@"` — для `sh`
  запуск Bun с флагом, для TypeScript строка-выражение и комментарий. Голый `elves`, `node_modules/.bin/elves`, скрипт
  `package.json` у npm, pnpm, Bun и Yarn 1 и `bunx` — с ним и обёртка Yarn 2+ — идут через него, без env-файлов
  (#592); Yarn 2+ сам запускает bin мимо шебанга — Node-ом, и bin не запускается вовсе (#608). Не
  `#!/usr/bin/env bun` — Bun подгрузил бы их, и `elves slot '<команда>'` отдал бы ключи команде; не
  `#!/usr/bin/env -S bun --no-env-file` — `env -S` есть не везде (busybox), bin там не запустился бы вовсе;
- в коде скриптов скиллов и установщика — команда, которую скрипт печатает (`bun ${…}`, `bun .agents/skills/…`), и
  дочерний процесс `bun` (`spawn("bun", […])`, `process.execPath`);
- там же — скрипт пакета под `bun` в строках кода: подсказка, справка скрипта под именем `elves` и обзор
  `elves --help` (#602). Строка запуска — константы `PACKAGE_RUN` и `PACKAGE_BUNX`
  (`skills/spec/scripts/package-run.ts`) у установщика и справки: `bun --no-env-file node_modules/.bin/elves
  <скрипт>`, на Yarn 2+ — пакет через bunx (#608): справка — по `packageManager` проекта. Справку агент копирует как есть: форма та же, что в `package.json` и CI, и версия — пакета
  проекта, а голый `elves` в shell агента — глобальный пакет машины, если он вообще в PATH. Строки — литералы и шаблоны с `${…}`;
  комментарий и регулярное выражение — не вывод.

Маска разрешения (`Bash(bun *skills/…)`) — не вызов: `*` покрывает и флаг.

### Почему не `bunfig.toml`

`env = false` в `bunfig.toml` корня проекта отключает env-файлы любому `bun` в нём: Bun-проект перестал бы
подгружать `.env.test` в собственном `bun test` и `.env` в `bun run dev`. Флаг снимает только то, что добавлял сам
вызов скрипта флоу. `bun run <скрипт>` и `npm run` env-файлы скрипту `package.json` не передают (Bun 1.4.3).

### Вне охвата

`bunx` (`bunx @miroshnik/elves …`, запасной путь `bunx github:miroshnik/elves …`, хук `SessionStart`, джобы CI без
зависимостей проекта — `bunx @miroshnik/elves@<версия> spec-…`, `ci.md` скилла spec, #559; скрипты и обёртка очереди
проекта на Yarn 2+, #608) флаг не принимает — ни `bunx --no-env-file`, ни `bun --no-env-file x` (Bun 1.4.3), — но
запускает bin его шебангом: env-файлы снимает шебанг (#592; из скрипта Yarn 4 ключ `.env.local` до команды не доходит —
tests/capabilities/elves/install).

`elves slot --for $$` шима очереди `.agents/slot.sh`: `elves` только печатает переменные очереди, а команда идёт в
shell скрипта, без env-файлов Bun.

### Скрипты флоу под bun не подгружают env-файлы проекта: вызов несёт --no-env-file

<details><summary>✅ 124 теста</summary>

- ✅ реестр «документы флоу — AGENTS.md, claude/CLAUDE.md, README.md, package.json, docs/*.md, *.md скиллов» не пуст (документы)
- ✅ реестр «документы флоу — AGENTS.md, claude/CLAUDE.md, README.md, package.json, docs/*.md, *.md скиллов» находит skills/slot/SKILL.md, skills/github/SKILL.md, skills/task-env/SKILL.md, skills/spec/SKILL.md, docs/parallel-checkouts.md, package.json (документы)
- ✅ нарушитель не проходит (документы): команда скилла без флага
- ✅ нарушитель не проходит (документы): скрипт package.json без флага
- ✅ в AGENTS.md скрипты скиллов вызываются с --no-env-file
- ✅ в README.md скрипты скиллов вызываются с --no-env-file
- ✅ в claude/CLAUDE.md скрипты скиллов вызываются с --no-env-file
- ✅ в docs/ci-concurrency.md скрипты скиллов вызываются с --no-env-file
- ✅ в docs/cloud-sessions.md скрипты скиллов вызываются с --no-env-file
- ✅ в docs/judgment.md скрипты скиллов вызываются с --no-env-file
- ✅ в docs/parallel-checkouts.md скрипты скиллов вызываются с --no-env-file
- ✅ в docs/pr-checks.md скрипты скиллов вызываются с --no-env-file
- ✅ в docs/production.md скрипты скиллов вызываются с --no-env-file
- ✅ в docs/prompt-cache.md скрипты скиллов вызываются с --no-env-file
- ✅ в docs/testing.md скрипты скиллов вызываются с --no-env-file
- ✅ в package.json скрипты скиллов вызываются с --no-env-file
- ✅ в skills/ci-wait/SKILL.md скрипты скиллов вызываются с --no-env-file
- ✅ в skills/dashboard/SKILL.md скрипты скиллов вызываются с --no-env-file
- ✅ в skills/est/SKILL.md скрипты скиллов вызываются с --no-env-file
- ✅ в skills/est/reference.md скрипты скиллов вызываются с --no-env-file
- ✅ в skills/github/SKILL.md скрипты скиллов вызываются с --no-env-file
- ✅ в skills/github/reference.md скрипты скиллов вызываются с --no-env-file
- ✅ в skills/slot/SKILL.md скрипты скиллов вызываются с --no-env-file
- ✅ в skills/spec/SKILL.md скрипты скиллов вызываются с --no-env-file
- ✅ в skills/spec/canon.md скрипты скиллов вызываются с --no-env-file
- ✅ в skills/spec/checks.md скрипты скиллов вызываются с --no-env-file
- ✅ в skills/spec/ci.md скрипты скиллов вызываются с --no-env-file
- ✅ в skills/spec/migration.md скрипты скиллов вызываются с --no-env-file
- ✅ в skills/spec/reference.md скрипты скиллов вызываются с --no-env-file
- ✅ в skills/task-env/SKILL.md скрипты скиллов вызываются с --no-env-file
- ✅ в skills/task-env/reference.md скрипты скиллов вызываются с --no-env-file
- ✅ вызов скрипта пакета в документах флоу и package.json, который подгрузит env-файлы проекта, — нарушение no-env-file
  > bin пакета Bun без флага читает сам, мимо шебанга, — с env-файлами рабочего каталога, и `elves <скрипт>` отдавал
  > их ключи `gh`, `git` и проверяемой команде (#596). Голый bin идёт через шебанг — без них (#592).
- ✅ команда скрипта пакета, которую печатает код скриптов и установщика и которая подгрузит env-файлы проекта, — нарушение no-env-file
  > Команду, которую печатает код — подсказка харнесса, справка скрипта под именем `elves`, — агент копирует как есть:
  > `bun node_modules/.bin/elves …` без флага в ней Bun читает мимо шебанга bin и отдаёт ключи env-файлов проекта
  > проверяемой команде, как в package.json до #596.
- ✅ реестр «документы флоу — AGENTS.md, claude/CLAUDE.md, README.md, package.json, docs/*.md, *.md скиллов — и строки кода скриптов скиллов и установщика» не пуст (скрипт пакета)
- ✅ реестр «документы флоу — AGENTS.md, claude/CLAUDE.md, README.md, package.json, docs/*.md, *.md скиллов — и строки кода скриптов скиллов и установщика» находит README.md, skills/spec/SKILL.md, skills/spec/reference.md, skills/spec/ci.md, skills/spec/scripts/harness.ts, bin/elves.ts (скрипт пакета)
- ✅ нарушитель не проходит (скрипт пакета): скрипт package.json — bin под bun без флага
- ✅ нарушитель не проходит (скрипт пакета): команда скилла — bin под bun без флага
- ✅ нарушитель не проходит (скрипт пакета): подсказка кода — bin под bun без флага
- ✅ в AGENTS.md bin пакета под bun вызывается с --no-env-file
- ✅ в README.md bin пакета под bun вызывается с --no-env-file
- ✅ в bin/elves.ts bin пакета под bun вызывается с --no-env-file
- ✅ в claude/CLAUDE.md bin пакета под bun вызывается с --no-env-file
- ✅ в docs/ci-concurrency.md bin пакета под bun вызывается с --no-env-file
- ✅ в docs/cloud-sessions.md bin пакета под bun вызывается с --no-env-file
- ✅ в docs/judgment.md bin пакета под bun вызывается с --no-env-file
- ✅ в docs/parallel-checkouts.md bin пакета под bun вызывается с --no-env-file
- ✅ в docs/pr-checks.md bin пакета под bun вызывается с --no-env-file
- ✅ в docs/production.md bin пакета под bun вызывается с --no-env-file
- ✅ в docs/prompt-cache.md bin пакета под bun вызывается с --no-env-file
- ✅ в docs/testing.md bin пакета под bun вызывается с --no-env-file
- ✅ в package.json bin пакета под bun вызывается с --no-env-file
- ✅ в skills/ci-wait/SKILL.md bin пакета под bun вызывается с --no-env-file
- ✅ в skills/dashboard/SKILL.md bin пакета под bun вызывается с --no-env-file
- ✅ в skills/dashboard/scripts/dashboard.ts bin пакета под bun вызывается с --no-env-file
- ✅ в skills/dashboard/scripts/sessions.ts bin пакета под bun вызывается с --no-env-file
- ✅ в skills/est/SKILL.md bin пакета под bun вызывается с --no-env-file
- ✅ в skills/est/reference.md bin пакета под bun вызывается с --no-env-file
- ✅ в skills/est/scripts/est.ts bin пакета под bun вызывается с --no-env-file
- ✅ в skills/github/SKILL.md bin пакета под bun вызывается с --no-env-file
- ✅ в skills/github/reference.md bin пакета под bun вызывается с --no-env-file
- ✅ в skills/github/scripts/github.ts bin пакета под bun вызывается с --no-env-file
- ✅ в skills/github/scripts/locale.ts bin пакета под bun вызывается с --no-env-file
- ✅ в skills/slot/SKILL.md bin пакета под bun вызывается с --no-env-file
- ✅ в skills/slot/scripts/slot.ts bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/SKILL.md bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/canon.md bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/checks.md bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/ci.md bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/migration.md bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/reference.md bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/scripts/architecture.ts bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/scripts/c4.ts bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/scripts/eslint-config.ts bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/scripts/harness.ts bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/scripts/knip-hints.cjs bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/scripts/knip-hints.d.cts bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/scripts/package-run.ts bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/scripts/precommit.ts bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/scripts/spec-break.ts bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/scripts/spec-claims.ts bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/scripts/spec-diff.ts bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/scripts/spec-doc.ts bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/scripts/spec-publish.ts bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/scripts/spec-run.ts bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/scripts/spec-shard.ts bin пакета под bun вызывается с --no-env-file
- ✅ в skills/spec/scripts/speclib.ts bin пакета под bun вызывается с --no-env-file
- ✅ в skills/task-env/SKILL.md bin пакета под bun вызывается с --no-env-file
- ✅ в skills/task-env/reference.md bin пакета под bun вызывается с --no-env-file
- ✅ в skills/task-env/scripts/task-env.ts bin пакета под bun вызывается с --no-env-file
- ✅ справка скрипта пакета под именем elves называет вызов без env-файлов проекта
  > Справка скрипта под именем `elves` — первое, что агент копирует: синтаксис и примеры — со строкой запуска пакета.
- ✅ справка скрипта пакета elves \<скрипт> --help называет форму запуска, которая на Yarn 2+ с PnP находит bin пакета
  > На Yarn 2+ с PnP `node_modules/.bin/elves` нет, а bin `.ts` Yarn 2+ запускает Node-ом при любом `nodeLinker` (#608):
  > справка в проекте на Yarn 2+ называет форму его package.json — пакет через bunx, по `packageManager` скилла
  > github.
- ✅ реестр «bin из package.json» не пуст (bin пакета)
- ✅ реестр «bin из package.json» находит bin/elves.ts (bin пакета)
- ✅ нарушитель не проходит (bin пакета): шебанг env bun
- ✅ bin/elves.ts запускает Bun с --no-env-file сам — шебанг через sh
- ✅ реестр «код скриптов скиллов и установщика без комментариев» не пуст (код)
- ✅ реестр «код скриптов скиллов и установщика без комментариев» находит skills/github/scripts/github.ts, skills/task-env/scripts/task-env.ts, skills/spec/scripts/harness.ts, bin/elves.ts (код)
- ✅ нарушитель не проходит (код): подсказка с командой без флага
- ✅ нарушитель не проходит (код): дочерний bun без флага
- ✅ нарушитель не проходит (код): дочерний процесс того же bun без флага
- ✅ bin/elves.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/dashboard/scripts/dashboard.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/dashboard/scripts/sessions.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/est/scripts/est.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/github/scripts/github.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/github/scripts/locale.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/slot/scripts/slot.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/spec/scripts/architecture.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/spec/scripts/c4.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/spec/scripts/eslint-config.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/spec/scripts/harness.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/spec/scripts/knip-hints.cjs печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/spec/scripts/knip-hints.d.cts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/spec/scripts/package-run.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/spec/scripts/precommit.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/spec/scripts/spec-break.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/spec/scripts/spec-claims.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/spec/scripts/spec-diff.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/spec/scripts/spec-doc.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/spec/scripts/spec-publish.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/spec/scripts/spec-run.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/spec/scripts/spec-shard.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/spec/scripts/speclib.ts печатает и запускает скрипты флоу с --no-env-file
- ✅ skills/task-env/scripts/task-env.ts печатает и запускает скрипты флоу с --no-env-file

</details>

## old-name

Флоу переименован в Elves (эпик #542), и переход все установки прошли: старого имени `ai-dev` (и `AI_DEV_*`) в
файлах флоу нет. Оно возвращается по привычке — агенты знают `.agents/ai-dev.json` и `~/.config/ai-dev` из памяти и
транскриптов, — а скрипт или справочник со старым путём отправляет агента туда, где ничего нет.

### Правило

В файлах флоу (`bin/`, `skills/`, канон `AGENTS.md` и `claude/`, `docs/`, `README.md`, `package.json`) `ai-dev` и
`AI_DEV_` в любом регистре не встречаются — ни в тексте, ни в пути файла. Файлы флоу — те, что попадают в коммит:
отслеживаемые git и новые, без игнорируемых git, — их стандарт берёт у `git ls-files`, а не обходом каталога.

Одна строка — исключение: симлинки совместимости `~/.config/ai-dev` и `~/.claude/est`, которые снимает `update -g`
(capability `elves#update`). Стандарт требует, чтобы она была: когда снятие уйдёт, уйдёт и исключение.

### Что — история

Старое имя остаётся в истории, и её не переписывают: история git и сообщения коммитов, теги и списки изменений
релизов, закрытые задачи и PR, опубликованная спека — и её локальная сборка `docs/spec`: страницы `spec:doc` называют
старое имя в названиях тестов и описаниях решений, а git их игнорирует; обход каталога делал стандарт красным только
локально, в CI `docs/spec` появляется после тестов (#579). Тесты (`tests/`) — вне охвата: старое имя в них — данные.
Папка локального клона не переименовывается: по её пути Claude Code хранит транскрипты сессий, из которых `est` берёт
факт, и память.

### Старого имени ai-dev в файлах флоу нет

<details><summary>✅ 7 тестов</summary>

- ✅ реестр «файлы флоу со старым именем — bin, skills, канон, docs, README.md, package.json» не пуст
- ✅ реестр «файлы флоу со старым именем — bin, skills, канон, docs, README.md, package.json» находит bin/elves.ts
- ✅ нарушитель не проходит: скрипт читает прежний манифест
- ✅ нарушитель не проходит: справочник называет прежний каталог
- ✅ нарушитель не проходит: файл скилла под прежним именем
- ✅ нарушитель не проходит: установщик называет старое имя вне симлинков переименования
- ✅ в bin/elves.ts старого имени нет

</details>

### примеры

<details><summary>✅ 1 тест</summary>

- ✅ old-name не читает файлы, которые git игнорирует: сгенерированный docs/spec не делает стандарт красным

</details>

## origin-repo

Репозиторий чекаута `owner/repo` по URL его `origin` каждый скилл определяет одинаково: на вопросы «какой это
репозиторий?» и «это чекаут репозитория X?» `est`, `github` и `task-env` отвечают одно и то же.

`est` и `github` по `origin` находят репозиторий команды без `--repo`, `task-env prune` — спрашивает GitHub о задачах
стеков, `github task close` — решает, снимать ли стеки задачи с томами и удалять ли ветки, `pr premerge` — где проверять
слияние. Общего модуля нет: `github` и `task-env` других скиллов не импортируют (стандарт `scripts#skill-imports`, #252). Копии
разбора совпадали
буквально, но выражение искало `github.com` подстрокой: `notgithub.com/o/r` и локальное зеркало
`/srv/mirror/github.com/o/r.git` оно брало за GitHub, а `GitHub.com`, порт и `ssh.github.com` — нет. «Чекаут репозитория
X» решала подстрока URL: чекаут `miroshnik/ai-dev-tools` был чекаутом `miroshnik/ai-dev`, и `task close` снимал с томами
стеки чужого репозитория; `Miroshnik/AI-Dev` — нет, хотя GitHub регистр не различает.

### Правило

- `origin` на GitHub — хост ровно `github.com` или `ssh.github.com` (SSH через 443), без учёта регистра: scp-вид
  `git@github.com:o/r.git` и URL со схемой (`https://`, `ssh://`, `git://`) с учётными данными и портом. Путь — ровно
  `<owner>/<repo>`, `.git` и `/` на конце не входят в имя, регистр имени сохраняется. Другой хост, локальный путь, путь
  глубже корня репозитория, пустой `origin` — не GitHub.
- Разбор — функция `originRepo(url)` в скрипте скилла: `owner/repo` или `null`. Реестр — скрипты скиллов, которые её
  экспортируют; каждый отвечает по одной таблице.
- «Чекаут репозитория X» — `originRepo` его `origin` равен X без учёта регистра, не подстрока URL. Проверка — функция
  `checkoutOf(origin, repo)`; реестр — скрипты, которые её экспортируют.
- Имя стеков `task-env` (`projectName` — последний сегмент `origin`) — вне правила: это имя, а не репозиторий.

### Репозиторий чекаута по origin определяется одинаково во всех скиллах

<details><summary>✅ 12 тестов</summary>

- ✅ реестр «скрипты скиллов с разбором origin» не пуст (originRepo)
- ✅ реестр «скрипты скиллов с разбором origin» находит est, github, task-env (originRepo)
- ✅ нарушитель не проходит (originRepo): разбор до стандарта: github.com — подстрока, регистр хоста важен, порт не понят
- ✅ est разбирает origin по таблице
- ✅ github разбирает origin по таблице
- ✅ task-env разбирает origin по таблице
- ✅ реестр «скрипты скиллов с проверкой «чекаут репозитория X»» не пуст (checkoutOf)
- ✅ реестр «скрипты скиллов с проверкой «чекаут репозитория X»» находит github (checkoutOf)
- ✅ нарушитель не проходит (checkoutOf): проверка чекаута подстрокой URL origin
- ✅ github узнаёт чекаут репозитория по равенству owner/repo без учёта регистра
- ✅ таблица ловит расхождения разбора до стандарта: подстрока хоста, регистр хоста, порт, зеркало
- ✅ таблица ловит проверку чекаута подстрокой: регистр, префикс имени, конец владельца, не GitHub

</details>

## package-manager

Менеджер пакетов проекта во флоу определяет одна функция: на вопрос «какой менеджер пакетов у проекта» отвечает
`packageManager(dir)` скилла `github` по одной таблице случаев, а `pr premerge`, обёртка slot и раннер готовой строки
`test:spec` у `check` берут ответ у неё.

Ответ нужен трём местам. `pr premerge` ставит зависимости слияния и зовёт скрипты проекта (`projectCommands`);
установка оборачивает проверки `package.json` в очередь slot — на Yarn 2+ строкой у slot пакета через bunx: его shell
не подключает шим, а bin `.ts` он запускает Node-ом; `check` предлагает строку `test:spec` с `bun test` в проекте на
Bun, когда раннер не дают ни команда `test`, ни зависимости. Три копии правила были связаны только смыслом и разошлись: `packageManager: "pnpm@…"` и забытый
`bun.lock` — `premerge` звал `pnpm run`, а `check` предлагал `bun test`; забытый `.yarnrc.yml` переключал обёртку slot
на shell Yarn при любом менеджере, а `premerge` его не видел вовсе. Ошибка видна поздно и в чужом проекте: не та
команда установки на слиянии или не тот раннер в готовой строке. Копии здесь не нужны, в отличие от стандартов-копий
(`task-branch`): ответ нужен самому `github` и установщику `bin/elves.ts`, а установщик — не скилл и уже импортирует
`github.ts` (граф импортов скиллов — стандарт `scripts#skill-imports`).

### Правило

- менеджер — `packageManager` в `package.json` (`bun@`, `pnpm@`, `yarn@`, `npm@`): он сильнее файлов;
- без него — lockfile, по порядку: `bun.lock` и `bun.lockb` — bun, `pnpm-lock.yaml` — pnpm, `yarn.lock` — Yarn,
  `package-lock.json` — npm;
- без обоих — `.yarnrc.yml`: Yarn; ничего из этого — npm;
- Yarn 2+ — скрипты в своём shell: `yarn@2` и старше в `packageManager`, а Yarn по файлам — с `.yarnrc.yml`; версию
  решает `packageManager`: `yarn@1.22.22` с `.yarnrc.yml` — Yarn 1, `pnpm@…` с `.yarnrc.yml` — pnpm (#485, вопрос 1);
- lockfile, по которому `premerge` ставит зависимости, — свой у менеджера, иначе первый по порядку; ни одного — без
  установки.

Реестр ответов — скрипты скиллов, которые экспортируют `packageManager`; каждый сверяется с таблицей. Скрипт флоу
(`skills`, `bin`) не читает поле `packageManager` из `package.json` и не называет lockfile или `.yarnrc.yml` строкой
мимо этой функции: их место — тело `packageManager` в `github.ts`. Список lockfile в `est.ts` (`DIFF_EXCLUDE`) —
файлы вне счёта диффа, а не менеджер пакетов: это регулярка путей, правило её не касается.

### Менеджер пакетов проекта отвечает одна функция: packageManager в package.json сильнее lockfile, без обоих — npm, .yarnrc.yml — Yarn 2+

<details><summary>✅ 6 тестов</summary>

- ✅ реестр «скрипты скиллов с ответом на «какой менеджер пакетов у проекта»» не пуст
- ✅ реестр «скрипты скиллов с ответом на «какой менеджер пакетов у проекта»» находит skills/github/scripts/github.ts
- ✅ нарушитель не проходит: раннер test:spec до стандарта: bun.lock сильнее packageManager
- ✅ нарушитель не проходит: обёртка slot до стандарта: .yarnrc.yml — shell Yarn 2+ при любом менеджере
- ✅ skills/github/scripts/github.ts: менеджер пакетов проекта — по таблице правила
- ✅ таблица ловит расхождения копий до стандарта: забытый bun.lock у раннера test:spec, забытый .yarnrc.yml у обёртки slot

</details>

### Менеджер пакетов у premerge, обёртки slot и раннера test:spec у check — ответ packageManager

<details><summary>✅ 1 тест</summary>

- ✅ premerge, обёртка slot и раннер test:spec у check берут менеджер пакетов у неё: packageManager pnpm и забытые bun.lock и .yarnrc.yml — premerge зовёт pnpm, обёртка slot — через шим slot.sh, check не предлагает bun test

</details>

### Скрипт флоу не читает packageManager и не ищет lockfile мимо функции packageManager

<details><summary>✅ 6 тестов</summary>

- ✅ реестр «скрипты флоу, которые читают поле packageManager или называют lockfile» не пуст
- ✅ реестр «скрипты флоу, которые читают поле packageManager или называют lockfile» находит skills/github/scripts/github.ts
- ✅ нарушитель не проходит: скрипт флоу читает packageManager мимо этой функции
- ✅ нарушитель не проходит: скрипт флоу ищет lockfile мимо этой функции
- ✅ нарушитель не проходит: вторая функция packageManager в другом скрипте
- ✅ skills/github/scripts/github.ts: поле packageManager и lockfile — только в теле packageManager github

</details>

## pr-workflow-run

Прогон workflow на PR в базу установщик и `ci-wait` решают одинаково: на вопрос «запустит ли workflow прогон на PR в
базу `<ветка>`» по его `on:` обе копии отвечают по одной таблице — «да», «нет» или «не решить без диффа PR».

На вопрос отвечают два места. `ci-wait pr` ждёт прогон каждого workflow, который на PR в базу срабатывает (#356), — без
этого PASS приходил по одним чекам хостинга, и PR вливался без тестов. `check` проекта с пачками называет `❌` workflow,
который на PR в ветку пачки идёт (#676): PR задачи в неё CI не запускает — его ворота проверки перед коммитом и
`pr premerge`, полный CI — у выпуска пачки.
Правило жило в двух копиях, связанных только смыслом, и они разошлись (#657): ветки с отрицанием
(`branches: ['**', '!release/**']`), `?`, `+` и `[…]` установщик разбирал по шпаргалке шаблонов GitHub, а `pr_expects`
в `wait-ci.sh` считал «не решить без диффа PR» и workflow не ждал. Проект с таким фильтром получал `PASS` ожидания до
прогона CI на PR задачи — ровно тот мерж без тестов, от которого защищает #356. Теперь в `bin/elves.ts` правило одно —
`prRun`, его берёт `batchCi`; копия — `PR_RUN` в `skills/ci-wait/scripts/wait-ci.sh`. Общего модуля нет: `ci-wait`
других скиллов не импортирует, установщика тоже (стандарт `scripts#skill-imports`), а `wait-ci.sh` — bash и jq, импорта
TypeScript у него нет.

### Правило

- `on:` — строка или массив: прогон на PR есть, только если среди событий `pull_request`, фильтров у него нет; объект —
  ключ `pull_request` с фильтрами или `null` (без фильтров). `pull_request_target` идёт в базе, а не на голове PR, —
  «нет»; нет `pull_request` или нет `on:` — «нет»; `pull_request` не объект и не `null` — «не решить».
- Фильтр веток решает первым: `branches` не берёт базу или `branches-ignore` её берёт — «нет», какой бы ни был дифф.
- Шаблоны веток — по шпаргалке шаблонов GitHub: по порядку, `!` в начале снимает то, что взяли шаблоны до него, позднее
  положительное возвращает снятое; `!` не в начале — сам символ; `*` — что угодно, кроме `/`, `**` — что угодно; `?`,
  `+` и `[…]` — как в регулярке; остальное — само себя (`.` — точка). Шаблон, который не регулярка, ветку не берёт.
- Затем фильтр путей (`paths`, `paths-ignore`) и `types` без `synchronize` — «не решить»: пойдёт ли прогон, зависит от
  диффа PR и события.
- Остальное — «да».

Что делать с ответом, решает читатель, а не своя копия правила. `ci-wait pr` ждёт прогон на «да»; «нет» и «не решить» не
ждёт — ложный TIMEOUT хуже, а файл, который не разбирается, ждёт до правила (прогон-«пустышка» даст FAIL). `check`
проекта с пачками даёт строку `❌` на «да» в ветку пачки и на «не решить» — workflow может запуститься, строка так и
говорит; «нет» — строки нет: фильтр веток не пускает ветку пачки (`branches-ignore: ['batch/**']` шаблона), только
`push`, `pull_request_target`. На то же «нет» `ci-wait pr` прогона на PR в ветку пачки не ждёт.

Реестр копий — скрипты флоу с правилом: `export function prRun` в `.ts` установщика (`bin/`) и скиллов, `PR_RUN='…'` в
`.sh`. Каждая отвечает по таблице своим движком: `prRun` — регулярками JavaScript над значением `on:`, `PR_RUN` —
определение jq `pr_run($base)` над ним же, как в `wait-ci.sh`: одна запись регулярки в JS и в Oniguruma jq может
значить разное. Копия до стандарта — нарушитель: таблица ловит её расхождение по отрицанию, `?`, `+` и `[…]`.

### Прогон workflow на PR в базу решает одно правило: функция установщика и копия в wait-ci.sh — по одной таблице

<details><summary>✅ 7 тестов</summary>

- ✅ реестр «скрипты флоу с правилом prRun / PR_RUN» не пуст
- ✅ реестр «скрипты флоу с правилом prRun / PR_RUN» находит bin/elves.ts, skills/ci-wait/scripts/wait-ci.sh
- ✅ нарушитель не проходит: pr_expects до стандарта: отрицание и ?, +, […] в ветках — «не решить»
- ✅ bin/elves.ts отвечает на «прогон workflow на PR в базу» по таблице
- ✅ skills/ci-wait/scripts/wait-ci.sh отвечает на «прогон workflow на PR в базу» по таблице
- ✅ таблица ловит расхождение копий до стандарта: отрицание и ?, +, […] в ветках у pr_expects
- ✅ фильтр путей и types без synchronize — «не решить» у обеих копий

</details>

## project-manifest

Манифест установки `.agents/elves.json` во флоу читает одна функция: на вопрос «что в манифесте проекта» отвечает
`manifestOf(root)` модуля `locale.ts` скилла `github`, а язык, пачки и настройки установщика берутся из её ответа.

Манифест читали четыре копии: `readManifest` установщика `bin/elves.ts`, `projectLanguage` в `locale.ts`, `httpServices`
скилла `task-env` и `batchProject` в `github.ts` (#648). Связаны они были только смыслом и уже разошлись: `batchProject`
не называл ошибку битого файла, а копия установщика отдавала разобранный JSON как есть —
`null` в файле ронял бы её читателей. Пачки узнают двое — `check` (PR в ветку пачки без CI) и `task queue` (ветка пачки), — и
два своих условия разошлись бы так же: `check` сверял бы CI проекта, где очередь ветку пачки не ведёт (#653).
`locale.ts` уже импортируют `github.ts` и установщик; `task-env` других скиллов не импортирует (стандарт
`skill-imports`) и держит копию, которая отвечает по той же таблице.

### Правило

- Манифест — `.agents/elves.json` в корне (проекта, домашнего каталога для машины).
- Ответ — прочитанный файл (от корня, нет — `null`), его поля и ошибка: не JSON или не объект (`null`, массив) — полей
  нет, ошибка называет причину. `task-env` показывает её с именем файла, язык и установщик берут пустые поля.
- Реестр ответов — скрипты скиллов, которые экспортируют `manifestOf`; каждый сверяется с таблицей.
- Скрипт флоу (`skills`, `bin`) не разбирает манифест сам: объявление верхнего уровня, которое называет файл манифеста
  (`elves.json` строкой, константы `MANIFEST`, `MANIFESTS`) и зовёт
  `JSON.parse`, — красное с файлом и строкой; место разбора — тело `manifestOf`. Запись манифеста установщиком — не
  разбор: `install` пишет файл целиком.
- Проект с пачками — `batchProject` того же модуля: поле `batch` ровно `true`, `"true"` и `1` — не пачки (capability
  `update`).

### Манифест проекта читает одна функция: .agents/elves.json; не объект — без полей, с ошибкой

<details><summary>✅ 7 тестов</summary>

- ✅ реестр «скрипты скиллов с ответом на «что в манифесте проекта»» не пуст
- ✅ реестр «скрипты скиллов с ответом на «что в манифесте проекта»» находит skills/github/scripts/locale.ts, skills/task-env/scripts/task-env.ts
- ✅ нарушитель не проходит: batchProject до стандарта: битый и не объект — без ошибки
- ✅ нарушитель не проходит: readManifest установщика до стандарта: JSON как есть, без ошибки
- ✅ skills/github/scripts/locale.ts: манифест проекта — по таблице правила
- ✅ skills/task-env/scripts/task-env.ts: манифест проекта — по таблице правила
- ✅ таблица ловит расхождения копий до стандарта: не объект и битый файл у batchProject и readManifest

</details>

### Скрипт флоу не разбирает манифест мимо manifestOf

<details><summary>✅ 7 тестов</summary>

- ✅ реестр «скрипты флоу, которые называют файл манифеста» не пуст
- ✅ реестр «скрипты флоу, которые называют файл манифеста» находит skills/github/scripts/locale.ts, skills/task-env/scripts/task-env.ts, bin/elves.ts
- ✅ нарушитель не проходит: установщик разбирает манифест сам
- ✅ нарушитель не проходит: скрипт скилла разбирает манифест сам
- ✅ bin/elves.ts: манифест разбирает только manifestOf
- ✅ skills/github/scripts/locale.ts: манифест разбирает только manifestOf
- ✅ skills/task-env/scripts/task-env.ts: манифест разбирает только manifestOf

</details>

## session-pin

Закрепление задачи за сессией — файл `sessions/<id сессии>` в каталоге личной конфигурации (стандарт `scripts#config-dir`) со
строкой `owner/repo#N` — каждый скилл разбирает одинаково: на вопрос «за какой задачей эта сессия?» `github`, `est` и
`dashboard` отвечают одно и то же.

Пишет закрепление `github task status`, читают трое: `github` — держит сессию за одной задачей и называет ожидание для
перезапуска в `task resume` (хук `SessionStart`), `est` — отдаёт закреплённую сессию задаче в факте целиком, `dashboard` —
показывает сессии задач «В работе». Общего модуля нет: `github` других скиллов не импортирует (стандарт
`skill-imports`). Три копии разбора расходились на краях: строку не по форме `est`
пропускал, `dashboard` брал ключом как есть, `task resume` падал с кодом 2. Другая запись в `task status` — и `est`
молча терял бы привязку сессий в факте, `dashboard` — сессии задач, хук — ожидание для перезапуска.

### Правило

- `owner/repo#N` — задача: репозиторий `owner/repo` как записан (регистр, точка, дефис, подчёркивание), `N` — номер
  целиком; пробелы и перевод строки по краям файла не в счёт;
- всё другое — не закрепление: пустой файл, номер без репозитория, лишний сегмент пути, хвост за номером, пробел
  внутри, вторая строка, ссылка на задачу. Сессия с таким файлом свободна для всех трёх: `est` и `dashboard` её не
  привязывают, `task resume` пишет строку ○ с путём файла (код 0), `task status` перезаписывает файл задачей.

Разбор — функция `sessionPin(text)` в скрипте скилла: `{ slug, number }` или `null`. Реестр — скрипты скиллов, которые
её экспортируют; каждый отвечает по одной таблице. Строку пишет `pinLine(slug, number)` в `github` — каждая копия
читает её как ту же задачу. Скрипт, который читает каталог `sessions/` (сегмент под каталогом конфигурации или
`PINS_DIR` `est`), разбирает строку через `sessionPin`. `dashboard` своей копии не держит: он и так импортирует `est` и
без него не работает — каталог читает `loadPins` `est`.

### Закрепление разбирается одинаково в github, est и dashboard: owner/repo#N — задача, другое — не закрепление

<details><summary>✅ 7 тестов</summary>

- ✅ реестр «скрипты скиллов с разбором закрепления» не пуст
- ✅ реестр «скрипты скиллов с разбором закрепления» находит est, github
- ✅ нарушитель не проходит: разбор без якорей: задача — первое owner/repo#N в строке
- ✅ est: owner/repo#N — задача, другое — не закрепление
- ✅ github: owner/repo#N — задача, другое — не закрепление
- ✅ строку, которую пишет github task status, каждая копия разбирает как ту же задачу
- ✅ таблица ловит расхождения разбора без якорей: лишний сегмент пути, хвост за номером, вторая строка

</details>

### Скрипт, читающий каталог sessions/, разбирает закрепление через sessionPin

<details><summary>✅ 6 тестов</summary>

- ✅ реестр «скрипты скиллов, которые читают каталог закреплений sessions/» не пуст
- ✅ реестр «скрипты скиллов, которые читают каталог закреплений sessions/» находит skills/est/scripts/est.ts, skills/github/scripts/github.ts
- ✅ нарушитель не проходит: скрипт берёт строку файла закрепления как есть
- ✅ нарушитель не проходит: скрипт обходит PINS_DIR est своим разбором
- ✅ skills/est/scripts/est.ts разбирает закрепление через sessionPin
- ✅ skills/github/scripts/github.ts разбирает закрепление через sessionPin

</details>

## skill-imports

Скрипт скилла импортирует код другого скилла только по списку зависимостей стандарта: на вопрос «без какого соседа
скилл не загрузится?» отвечает список, и импорт вне списка не проходит.

Почему у правила копии в нескольких скриптах, а не общий модуль, семь стандартов-копий (`config-dir`, `task-branch`,
`origin-repo`, `session-pin`, `exception-files`, `spec-publish-job`, `cli-help`) объясняли одной фразой: «скилл ставится
каталогом и работает один, `github` переживает отсутствие `est` — импорт между скиллами это сломал бы». Механики за
фразой не было: импорт `est` в `github` ради другой функции не ловил никто — `github` перестал бы работать без `est`, а
следующий стандарт-копия был бы обоснован неправдой. И фраза уже была неточна: `est` и `spec` без `github` не работают.
Теперь стандарты-копии ссылаются сюда, а граф держит проверка. Цена ошибки — скилл, поставленный без зависимости, падает
на загрузке; установщик ставит все скиллы вместе, и ошибка проявится, только когда скилл поставят отдельно.

### Правило

- Импорт другого скилла — относительный путь из каталога `skills/<скилл>` в `skills/<сосед>`: `import … from`,
  `export … from`, `import "…"`, `import()` и `require()`. `import type` — тоже: без соседа скилл не проходит typecheck.
  Комментарий — не импорт.
- Скилл импортирует ровно соседей из своего списка (`DEPENDS` в тесте). Импорт вне списка — красный с файлом и строкой
  импорта; зависимость без импорта — тоже: список — граф, а не запас, и имена тестов показывают его как есть. Новый
  скилл — строка в списке, без неё красный.
- Импорт мимо каталога скиллов (`../../../tests/…`) — красный: у поставленного скилла этого файла нет.
- Запуск соседнего скрипта процессом — не импорт: `github` зовёт `est`, `task-env` и `wait-ci.sh` по пути рядом с собой,
  а без них печатает строку ○ и работает дальше (`task close` без `est` — `○ actual unavailable`).

### Граф и его причины

- `github`, `task-env`, `ci-wait`, `slot` других скиллов не импортируют. `github` — основа: от него зависят `est`, `spec`
  и `dashboard`, импорт обратно замкнул бы цикл; `task-env`, `ci-wait` и `slot` — самостоятельные инструменты, `github`
  зовёт их процессом. Поэтому правило, общее с ними, живёт копией в каждом скрипте, а одинаковость копий держит
  стандарт-копия.
- `est` и `spec` импортируют `github` — только `locale.ts`: имена, которые скрипты пишут в GitHub и разбирают обратно,
  одни на весь флоу (AGENTS.md, «Language»), вторая таблица разошлась бы с первой молча. `spec` — ещё и
  `github.ts`: `precommit` зовёт скрипты проекта его менеджером пакетов (`projectCommands`), а ответ о менеджере во флоу
  один (стандарт `scripts#package-manager`, #671).
- `dashboard` импортирует `est`, `github` и `task-env`: он показывает их данные — факт и реестр `est`, закрепления сессий,
  вопросы задач, адреса стеков — и без них не работает (#463).

Новое ребро — решение: строка в `DEPENDS` и причина здесь. Скиллу без зависимостей нужна функция соседа — копия под
стандартом-копией, а не импорт.

### Скрипт скилла импортирует другой скилл только по списку зависимостей стандарта

<details><summary>✅ 13 тестов</summary>

- ✅ реестр «скиллы» не пуст
- ✅ реестр «скиллы» находит dashboard, est, github, spec
- ✅ нарушитель не проходит: `github` импортирует `est`
- ✅ нарушитель не проходит: в списке у `est` зависимость `github`, а импорта нет
- ✅ нарушитель не проходит: скрипт скилла импортирует файл вне каталога скиллов
- ✅ нарушитель не проходит: скилла нет в списке зависимостей
- ✅ `ci-wait` не импортирует другие скиллы
- ✅ `dashboard` импортирует из других скиллов `est`, `github`, `task-env` — и только их
- ✅ `est` импортирует из других скиллов `github` — и только их
- ✅ `github` не импортирует другие скиллы
- ✅ `slot` не импортирует другие скиллы
- ✅ `spec` импортирует из других скиллов `github` — и только их
- ✅ `task-env` не импортирует другие скиллы

</details>

#### примеры

<details><summary>✅ 3 теста</summary>

- ✅ `import type`, `export … from`, `import()` и `require()` чужого скилла — его импорт
- ✅ файл своего скилла, комментарий и путь к соседнему скрипту для запуска процессом — не импорт другого скилла
- ✅ место нарушения — файл и строка импорта

</details>

## spec-publish-job

Публикацию спеки среди чеков `github` и `ci-wait` узнают одинаково: на вопрос «check-run `<имя>` — публикация спеки?»
оба скрипта отвечают по одной таблице, а job публикации во фрагментах CI скилла `spec` и в CI Elves назван так, что
правило его узнаёт.

Job публикации выкладывает документацию в ветку `spec` и ничего не проверяет (#443): `github pr premerge` не считает
его красный красным `main`, `wait-ci.sh` его не ждёт и не даёт по нему FAIL. Правило живёт в двух копиях —
`SPEC_PUBLISH` в `skills/github/scripts/github.ts` (регулярка JS) и `SPEC_PUBLISH` в `skills/ci-wait/scripts/wait-ci.sh`
(строка для `test()` jq), а имя job задают фрагменты `skills/spec/ci.md` и `.github/workflows/ci.yml`. Общего модуля
нет: `github` и `ci-wait` других скиллов не импортируют (стандарт `scripts#skill-imports`), а `wait-ci.sh` — bash и jq, импорта
TypeScript у него нет. Без проверки
копии связаны только комментариями: поправленная одна копия или переименованный во фрагменте job — тесты каждого
скрипта зелёные, а ложный «`main` красный» (код 3 и ложный баг) или FAIL ожидания после мержа возвращаются.

### Правило

- `spec-publish` — публикация: job так называется во фрагментах `ci.md`;
- `<job> / spec-publish` — публикация: тот же job в реюзабельном workflow, `<job>` — job вызывающего, вложенный
  вызов — несколько сегментов;
- другое имя — чек: `spec`, `test:spec`, `test-spec`, хвост за именем (`spec-publish-x`), другое начало
  (`x-spec-publish`), публикация не последним сегментом (`a / spec-publish / b`), job с матрицей
  (`spec-publish (1)` — GitHub дописывает значения матрицы к имени).

Реестр копий — скрипты скиллов с `SPEC_PUBLISH`: `export const SPEC_PUBLISH` в `.ts` и `SPEC_PUBLISH='…'` в `.sh`.
Каждая отвечает по таблице своим движком: регулярка — `RegExp.test` JS, строка `.sh` — `test()` jq, как в
`wait-ci.sh`: одна запись регулярки в двух движках может значить разное.

Реестр job — job в `.github/workflows/*.yml` и в YAML-фрагментах `skills/**/*.md` и `docs/*.md` (`tests/lib/yaml-fragments`),
шаг которых запускает `spec-publish.ts`, его же из пакета проекта (`elves spec-publish`) или скрипт `spec:publish`. Имя его check-run — `name` job, без него — ключ job,
с матрицей — с дописанными значениями; его узнаёт публикацией каждая копия.

### github и ci-wait одинаково узнают публикацию спеки по имени check-run: `spec-publish` и `<job> / spec-publish` — публикация, другое имя — чек

<details><summary>✅ 7 тестов</summary>

- ✅ реестр «скрипты скиллов с правилом SPEC_PUBLISH» не пуст
- ✅ реестр «скрипты скиллов с правилом SPEC_PUBLISH» находит ci-wait, github
- ✅ нарушитель не проходит: копия правила в одном из скриптов расходится с таблицей
- ✅ нарушитель не проходит: правило без якорей узнаёт публикацией хвост и середину имени
- ✅ ci-wait (skills/ci-wait/scripts/wait-ci.sh) узнаёт публикацию спеки по таблице
- ✅ github (skills/github/scripts/github.ts) узнаёт публикацию спеки по таблице
- ✅ таблица ловит расхождения копий без якорей и без реюзабельного workflow

</details>

### job публикации во фрагментах CI скилла spec и в CI Elves назван так, что оба скрипта узнают его публикацией

<details><summary>✅ 6 тестов</summary>

- ✅ реестр «job публикации спеки в .github/workflows и YAML-фрагментах skills/**/*.md и docs/*.md» не пуст
- ✅ реестр «job публикации спеки в .github/workflows и YAML-фрагментах skills/**/*.md и docs/*.md» находит .github/workflows/ci.yml jobs.spec-publish, skills/spec/ci.md jobs.spec-publish, skills/spec/ci.md jobs.spec-publish (2)
- ✅ нарушитель не проходит: job публикации переименован во фрагменте
- ✅ .github/workflows/ci.yml jobs.spec-publish: check-run «spec-publish» — публикация для github и ci-wait
- ✅ skills/spec/ci.md jobs.spec-publish (2): check-run «spec-publish» — публикация для github и ci-wait
- ✅ skills/spec/ci.md jobs.spec-publish: check-run «spec-publish» — публикация для github и ci-wait

</details>

#### примеры

<details><summary>✅ 4 теста</summary>

- ✅ переименованный job — ошибка с файлом, строкой и копиями, которые его не узнают
- ✅ имя check-run — name job, без него — ключ, с матрицей — с её значениями
- ✅ шаг со скриптом пакета — elves spec-publish из node_modules или пакет версии проекта через bunx — тоже публикация
- ✅ публикация в тексте и job без шага публикации — не элементы; неразборный фрагмент с публикацией — ошибка

</details>

## task-branch

Ветку задачи `<type>/<N>-<slug>` (AGENTS.md, «Session and branch») каждый скилл разбирает одинаково: на вопрос «ветка задачи
N?» `est`, `github` и `task-env` отвечают одно и то же.

`est` по ветке привязывает PR к задаче в факте, `github` — находит PR, с которым GitHub задачу не связал, и удаляет
влитую ветку в `task close`, `task-env` — называет по номеру стек задачи и его адреса. Общего модуля нет: `github` и
`task-env` других скиллов не импортируют (стандарт `scripts#skill-imports`). Две копии правила расходились на краях: `Fix/12-x` `est`
считал веткой #12, а `github` нет; `wip/7-x` — наоборот. Ошибка одной копии видна поздно — чужой PR в факте или не та
ветка в `task close`.

### Правило

`[<область>/]<type>/<N>-<slug>`, где

- `type` — из списка канона: `feat fix docs refactor perf test chore ci build research`, без учёта регистра (`Fix/12-x` —
  ветка #12, тип `fix`); другое слово (`wip/7-x`) — не ветка задачи;
- `область` — один сегмент (`backend/fix/263-…`), глубже (`a/b/fix/12-x`) — не ветка задачи;
- `N` — номер задачи, за ним дефис и слаг; число в слаге (`fix/128-api-409-on-retry`) — не номер.

Разбор — функция `taskBranch(branch)` в скрипте скилла: `{ type, issue }` или `null`. Реестр — скрипты скиллов, которые
её экспортируют; каждый отвечает по одной таблице. Нестрогие эвристики `est` для веток вне канона (`issue-7-login`) —
вне правила: они живут поверх `taskBranch` и о каноне не судят.

### Ветка задачи разбирается одинаково во всех скиллах

<details><summary>✅ 7 тестов</summary>

- ✅ реестр «скрипты скиллов с разбором ветки задачи» не пуст
- ✅ реестр «скрипты скиллов с разбором ветки задачи» находит est, github
- ✅ нарушитель не проходит: разбор до стандарта: тип — любое слово, регистр важен, префикс любой глубины
- ✅ est разбирает ветку задачи по таблице канона
- ✅ github разбирает ветку задачи по таблице канона
- ✅ task-env разбирает ветку задачи по таблице канона
- ✅ таблица ловит расхождения разбора до стандарта: регистр, тип вне списка, глубокий префикс, дата

</details>

## temp-worktree

Временный worktree в скриптах флоу заводит и убирает одна функция — `inTempWorktree` в
`skills/github/scripts/github.ts`: каталог во временной папке, `git worktree add --detach` на ревизии, работа в нём и
снятие всегда — и при ошибке внутри: `worktree remove --force`, каталог, `worktree prune`.

Временное дерево нужно трём командам `github`: `pr premerge` проверяет слияние головы PR со свежей базой и голую базу,
`batch release` ребейзит ветку пачки на базу (#649), бисект красного выпуска проверяет границы задач (#650). До
стандарта у каждой была своя копия «каталог, `add`, работа, снятие в `finally`», связанная с другими только смыслом, а
каждая новая команда на временном дереве добавляла копию (бисект — третья, #675). Копия, забывшая `finally` или
`prune`, оставляет в чекауте пользователя зарегистрированный worktree во временном каталоге: его видит `git worktree
list`, а уборка `task queue` берёт только worktree агентов (`.claude/worktrees/agent-*`).

### Правило

- Скрипт флоу (`skills`, `bin`) зовёт `git worktree add` только в `inTempWorktree`; команде нужно временное дерево —
  она зовёт функцию и работает в каталоге, который та даёт.
- Функция снимает дерево всегда: работа вернула значение, бросила ошибку или `add` не прошёл. Не прошёл `add` — ошибка
  `GhError` с причиной git, чекаут не меняется.
- Вложенные деревья — вложенные вызовы: `pr premerge` проверяет голую базу во втором дереве, пока первое со слиянием
  ещё есть.

Рядом в тех же командах — копии того же рода, теперь тоже по одной: скрипты `package.json` дерева (`scriptsOf`),
проверка дерева «зависимости по его lockfile, затем скрипты проекта» (`checkTree` — у `pr premerge` и бисекта), обёртки
`git` и `why` (последняя строка stderr, иначе код) — по одной на файл.

### Проверка

Реестр — места с `worktree add` в скриптах флоу: в коде `.ts` и `.js` — аргументы git `"worktree", "add"` вне
комментариев, в `.sh` — `git … worktree add` вне строк-комментариев; место — файл и функция верхнего уровня, в которой
вызов. Место вне `inTempWorktree` в `github.ts` — нарушение; нарушитель — копия до стандарта: `bisectRelease`,
`cmdBatchRelease` и `cmdPrPremerge` со своим `add`. Поведенческая проверка — настоящий git во временном репозитории:
ошибка внутри временного дерева и несработавший `add` не меняют `git worktree list` чекаута, а временного каталога не
остаётся.

Временное дерево понадобится установщику или скрипту другого скилла — он берёт функцию импортом из `github.ts`
(установщик его уже импортирует, скилл — по списку зависимостей стандарта `scripts#skill-imports`), а не своей копией.

### Временный worktree заводит и убирает одна функция

<details><summary>✅ 1 тест</summary>

- ✅ ошибка внутри временного worktree не оставляет его в git worktree list чекаута

</details>

#### скрипты флоу зовут worktree add только в ней: копия до стандарта — нарушитель

<details><summary>✅ 8 тестов</summary>

- ✅ реестр «места с worktree add в скриптах флоу» не пуст
- ✅ реестр «места с worktree add в скриптах флоу» находит skills/github/scripts/github.ts › inTempWorktree
- ✅ нарушитель не проходит: копия до стандарта в bisectRelease
- ✅ нарушитель не проходит: копия до стандарта в cmdBatchRelease
- ✅ нарушитель не проходит: копия до стандарта в cmdPrPremerge
- ✅ worktree add в skills/github/scripts/github.ts › inTempWorktree — в функции временного worktree
- ✅ в копии до стандарта места — в bisectRelease, cmdBatchRelease и cmdPrPremerge, и каждое — нарушение
- ✅ место — вызов git с worktree add в коде и в shell; комментарий и другие подкоманды worktree — не место

</details>
