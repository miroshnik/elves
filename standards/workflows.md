<!-- spec-doc: сгенерировано из названий тестов, руками не править -->
# workflows

Workflow GitHub Actions Elves и фрагменты CI в документах флоу, которые копируют проекты: их job, шаги и блоки
`concurrency`.

## artifact-hidden-files

Шаг `actions/upload-artifact`, чей путь скрытый — файл или каталог с точкой в начале имени (`.spec-*.json`,
`.spec-journal/`), — стоит с `include-hidden-files: true`. С v4.4 действие по умолчанию пропускает скрытые файлы: без
флага артефакт выходит пустым, шаг лишь предупреждает «No files were found», а падает следующая job — на
`download-artifact` — или идёт без отчёта.

Отчёты и журналы скилла `spec` (`.spec-report.json`, `.spec-playwright.json`, `.spec-journal/`, `.spec-meta/`) —
скрытые. Во фрагменте `skills/spec/ci.md` флаг стоял у журналов, но не у отчётов для `spec-diff` (#318): проект,
скопировавший фрагмент как есть, получал пустой `spec-reports`.

### Правило

Реестр — шаги `actions/upload-artifact` в `.github/workflows/*.yml` и в YAML-фрагментах (блоки кода `yaml`, `yml`)
файлов `skills/**/*.md` и `docs/*.md` — те же места, что у `ci-concurrency`: оттуда фрагменты копируют проекты. Путь
скрытый, если скрыта хоть одна его часть (`out/.cache/report.json`) в любой строке списка путей; `.` и `..` — не
скрытые, исключение `!…` ничего не загружает. Путь без скрытых частей флага не требует: что лежит внутри каталога,
по тексту не видно.

Фрагмент с `upload-artifact`, который не разбирается как YAML, — ошибка, а не пропуск: иначе его шаги выпали бы из
реестра молча.

### Каждая загрузка артефакта со скрытым путём — с include-hidden-files: true

<details><summary>✅ 15 тестов</summary>

- ✅ реестр «шаги actions/upload-artifact в .github/workflows и YAML-фрагментах skills/**/*.md и docs/*.md» не пуст
- ✅ реестр «шаги actions/upload-artifact в .github/workflows и YAML-фрагментах skills/**/*.md и docs/*.md» находит .github/workflows/ci.yml artifact «docs-spec», skills/spec/ci.md artifact «spec-journal-unit-${{ matrix.shard }}», skills/spec/ci.md artifact «spec-reports»
- ✅ нарушитель не проходит: отчёты .spec-*.json без include-hidden-files
- ✅ .github/workflows/ci.yml artifact «docs-spec» не теряет скрытые файлы
- ✅ skills/spec/ci.md artifact «docs-spec-${{ steps.tree.outputs.tree }}» не теряет скрытые файлы
- ✅ skills/spec/ci.md artifact «docs-spec» не теряет скрытые файлы
- ✅ skills/spec/ci.md artifact «playwright-blob-${{ matrix.shard }}» не теряет скрытые файлы
- ✅ skills/spec/ci.md artifact «spec-journal-e2e-${{ matrix.shard }}» не теряет скрытые файлы
- ✅ skills/spec/ci.md artifact «spec-journal-unit-${{ matrix.shard }}» не теряет скрытые файлы
- ✅ skills/spec/ci.md artifact «spec-junit-${{ matrix.shard }}» не теряет скрытые файлы
- ✅ skills/spec/ci.md artifact «spec-meta-spec» не теряет скрытые файлы
- ✅ skills/spec/ci.md artifact «spec-meta-unit-${{ matrix.shard }}» не теряет скрытые файлы
- ✅ skills/spec/ci.md artifact «spec-reports» не теряет скрытые файлы
- ✅ skills/spec/ci.md artifact «vitest-blob-${{ matrix.shard }}» не теряет скрытые файлы
- ✅ skills/spec/ci.md artifact «vitest-blob-spec» не теряет скрытые файлы

</details>

#### примеры

<details><summary>✅ 4 теста</summary>

- ✅ скрытый путь без include-hidden-files — ошибка с файлом и строкой
- ✅ скрытый каталог в середине пути и строка списка путей — тоже скрытые; ./ и исключение ! — нет
- ✅ путь без скрытых частей не требует include-hidden-files
- ✅ фрагмент с upload-artifact, который не разбирается, — ошибка, а не пропуск

</details>

## ci-concurrency

Блок `concurrency` с общей группой — не своей у PR или прогона — стоит с `queue: max`: иначе GitHub держит в группе
один ожидающий прогон и вытесняет его следующим, и прогон `main` получает статус cancelled.

Правило записано в `docs/ci-concurrency.md`, но без проверки каждый новый фрагмент повторял ошибку: правило (#6), job
деплоя без `queue: max` (#296), `spec-publish` и группа прогона `main` (#307) — трижды одно и то же. Проверка идёт по
тем местам, откуда ошибка расходится: workflow Elves и YAML-фрагменты справочников и скиллов, которые проекты
копируют.

### Правило

Реестр — блоки `concurrency` workflow и job в `.github/workflows/*.yml` и в YAML-фрагментах (блоки кода `yaml`,
`yml`) файлов `skills/**/*.md` и `docs/*.md`. Блок соблюдает правило, если у него `queue: max` или группа своя на
каждом событии `on:` его workflow:

- `github.run_id` — своя у прогона на любом событии;
- номер PR (`github.event.pull_request.number`, `github.event.number`) и `github.head_ref` — своя на `pull_request` и
  `pull_request_target`, вне PR пусто — работает запасное после `||`;
- `github.ref` — своя только на `pull_request` (`refs/pull/<N>/merge`); на `pull_request_target` это ветка базы, на
  push — ветка: общая;
- литерал и остальное — общая.

Группа своя, если своё хоть одно её выражение `${{ … }}`. Фрагмент без `on:` идёт под любым событием — проверяется и
на PR, и на push. Поэтому `ci-${{ github.event.pull_request.number || github.ref }}` своя в workflow только на
`pull_request` и общая, как только в `on:` есть push в `main`.

### «CI и деплой в одном workflow» — вне охвата

Вариант из `docs/ci-concurrency.md` для workflow, где CI и деплой ещё не разнесены, вытесняет ожидающий прогон
намеренно: `queue: max` несовместим с `cancel-in-progress` прогонов PR, а своя группа у прогона пустила бы деплои
`main` параллельно. Цена записана там же, рядом — совет разнести. Исключением с задачей он не стал: долга, который
задача сняла бы, нет — это описанный компромисс, а не нарушение.

### Каждый блок concurrency с общей группой — queue: max

<details><summary>✅ 14 тестов</summary>

- ✅ реестр «блоки concurrency в .github/workflows и YAML-фрагментах skills/**/*.md и docs/*.md» не пуст
- ✅ реестр «блоки concurrency в .github/workflows и YAML-фрагментах skills/**/*.md и docs/*.md» находит .github/workflows/ci.yml jobs.spec-publish.concurrency «spec-publish», docs/ci-concurrency.md concurrency «cd-${{ github.ref }}», docs/ci-concurrency.md jobs.deploy-dev.concurrency «deploy-dev», skills/spec/ci.md jobs.spec-publish.concurrency «spec-publish»
- ✅ нарушитель не проходит: прогон main в группе по PR с запасным github.ref
- ✅ нарушитель не проходит: job с общей группой без queue: max
- ✅ .github/workflows/ci.yml concurrency «ci-${{ github.event.pull_request.number || github.run_id }}» не вытесняет ожидающий прогон
- ✅ .github/workflows/ci.yml jobs.spec-publish.concurrency «spec-publish» не вытесняет ожидающий прогон
- ✅ .github/workflows/npm.yml concurrency «npm-publish» не вытесняет ожидающий прогон
- ✅ docs/ci-concurrency.md concurrency «cd-${{ github.ref }}» не вытесняет ожидающий прогон
- ✅ docs/ci-concurrency.md concurrency «ci-${{ github.event.pull_request.number || github.ref }}» не вытесняет ожидающий прогон
- ✅ docs/ci-concurrency.md jobs.deploy-dev.concurrency «deploy-dev» не вытесняет ожидающий прогон
- ✅ skills/spec/ci.md concurrency «ci-${{ github.event.pull_request.number || github.run_id }}» не вытесняет ожидающий прогон
- ✅ skills/spec/ci.md jobs.spec-publish.concurrency «spec-publish» (2) не вытесняет ожидающий прогон
- ✅ skills/spec/ci.md jobs.spec-publish.concurrency «spec-publish» не вытесняет ожидающий прогон
- ✅ вне охвата: docs/ci-concurrency.md concurrency «${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}»
  > вариант «CI и деплой в одном workflow» docs/ci-concurrency.md: queue: max несовместим с cancel-in-progress прогонов PR, а своя группа у прогона пустила бы деплои main параллельно; вытеснение ожидающего прогона — записанная цена варианта, там же сказано, что CI и деплой разносят

</details>

#### примеры

<details><summary>✅ 8 тестов</summary>

- ✅ общая группа без queue: max — ошибка с файлом и строкой
- ✅ общая группа с queue: max — блоком и строкой job — не вытесняет
- ✅ группа по PR с запасным github.ref в workflow только на pull_request — своя
- ✅ запасное run_id — своя группа у прогона main
- ✅ github.ref своя только у pull_request: у pull_request_target это ветка базы
- ✅ фрагмент без on: идёт под любым событием — группа по PR без запасного run_id общая
- ✅ concurrency в тексте скрипта и в прозе — не блок
- ✅ одинаковые блоки одного файла различает номер

</details>

## ci-timeouts

Каждая job workflow Elves и фрагмента CI, который копируют проекты, стоит с `timeout-minutes`, а шаг, который ставит
пакеты из сети, — ещё и со своим: без предела GitHub держит зависшую job до 6 часов, `ci-wait` агента ждёт её всё это время, а перезапуск — руками.

Прогон CI PR #662 20 минут висел на шаге `zsh` — `sudo apt-get update -qq && sudo apt-get install -y -qq zsh` без
единой строки вывода, пока его не отменили; соседний прогон в то же время прошёл этот шаг за секунды: зависло зеркало
apt раннера, а не код (#674). Предела не было ни у шага, ни у job.

### Правило

Реестр — `.github/workflows/*.yml` Elves и YAML-фрагменты CI, которые копируют проекты: блоки ```yaml в
`skills/**/*.md` и `docs/*.md` (общий реестр `tests/lib/yaml-fragments.ts`, как у `ci-concurrency`). Документ
разобран как YAML: якоря раскрыты, шаг под псевдонимом — шаг своей job. Фрагмент — список шагов без `jobs:` — идёт под
правило шага без правила job; job фрагмента без тела («… шаги как выше») — заглушка, не job.

- Job — с `timeout-minutes`: минут больше нуля или выражение `${{ … }}`. Запас — к обычному прогону: `tests` — 20
  минут при 5–6.
- Шаг, чей `run` ставит пакеты, — со своим `timeout-minutes`: системный менеджер (`apt-get`, `apt`, `dnf`, `yum`,
  `apk`, `zypper`, `brew`, `choco`, `snap` — `install`, `update`, `upgrade`, `add`), менеджер проекта (`bun`, `npm`,
  `pnpm`, `yarn` — `install`, `i`, `ci`, `add`), `pip install`, `playwright install`. Предела job мало: зависшее
  зеркало держало бы шаг до него, а свой предел валит шаг за минуты и называет его.

Шаги `uses:` (checkout, setup-bun, setup-node) своего предела не требуют — их держит предел job.

Фрагменты — в реестре (#684): проект, скопировавший фрагмент `skills/spec/ci.md` как есть, получал job без предела, а
`pnpm install` и `playwright install --with-deps` (браузеры и пакеты apt) — без своего; на зависшем зеркале — та же
6-часовая job, что у Elves до #674.

### Шаг zsh

Предел шага — 8 минут, внутри — три попытки, каждая команда `apt-get` — до 120 с (`timeout -k 5 120`): обычно шаг
идёт секунды, зависшую попытку снимает повтор, а не отмена и перезапуск прогона. Другое зеркало не ставим: зависание
было разовым — соседний прогон прошёл шаг на том же зеркале за секунды.

Первый предел — 40 с на команду — был туже разброса живого зеркала: на `main` после выпуска пачки (PR #693) все три
`apt-get update` упёрлись в него по ~50 с, и медленное зеркало стало красным прогоном. Предел команды — от зависания,
а не от медленного ответа: 120 с — с запасом к медленному, три попытки укладываются в предел шага.

Job `batch` лёгкого набора на PR в ветку пачки больше нет (#676): PR в пачку CI не запускает, окружение ставит одна
job `tests` — якоря для общего окружения двух наборов не нужны.

### Шаг, который ставит пакеты из сети, ограничен по времени и во фрагментах CI, которые копируют проекты: зависшее зеркало apt не держит прогон часами

<details><summary>✅ 10 тестов</summary>

- ✅ реестр «шаги установки пакетов в .github/workflows и YAML-фрагментах skills/**/*.md и docs/*.md» не пуст
- ✅ реестр «шаги установки пакетов в .github/workflows и YAML-фрагментах skills/**/*.md и docs/*.md» находит .github/workflows/ci.yml jobs.tests «zsh», .github/workflows/ci.yml jobs.tests «bun install --frozen-lockfile», skills/spec/ci.md jobs.unit «pnpm install --frozen-lockfile», skills/spec/ci.md jobs.e2e «pnpm exec playwright install --with-deps»
- ✅ нарушитель не проходит: шаг zsh прогона PR #662
- ✅ .github/workflows/ci.yml jobs.tests «bun install --frozen-lockfile» ограничен по времени
- ✅ .github/workflows/ci.yml jobs.tests «zsh» ограничен по времени
- ✅ skills/spec/ci.md jobs.e2e «pnpm exec playwright install --with-deps» ограничен по времени
- ✅ skills/spec/ci.md jobs.e2e «pnpm install --frozen-lockfile» ограничен по времени
- ✅ skills/spec/ci.md jobs.spec «pnpm install --frozen-lockfile» ограничен по времени
- ✅ skills/spec/ci.md jobs.test-spec «pnpm install --frozen-lockfile» ограничен по времени
- ✅ skills/spec/ci.md jobs.unit «pnpm install --frozen-lockfile» ограничен по времени

</details>

#### примеры

<details><summary>✅ 7 тестов</summary>

- ✅ шаг без своего предела — ошибка с файлом, job и шагом, даже если предел есть у job
- ✅ установка — системным менеджером с опциями до команды, менеджером проекта, pip и playwright
- ✅ сборка, тесты, публикация и проверка наличия — не установка
- ✅ шаг под псевдонимом якоря — шаг своей job со своим пределом; без имени — ключ по первой строке run
- ✅ фрагмент в Markdown — блок ```yaml; список шагов без jobs: — шаги без job, заглушка job без тела — не job
- ✅ одинаковые шаги одного файла в разных блоках различает номер
- ✅ предел — минут больше нуля или выражение; ноль и текст — не предел

</details>

### Каждая job ограничена по времени: зависший шаг не держит прогон до 6 часов, предела GitHub по умолчанию

<details><summary>✅ 15 тестов</summary>

- ✅ реестр «job в .github/workflows и YAML-фрагментах skills/**/*.md и docs/*.md» не пуст
- ✅ реестр «job в .github/workflows и YAML-фрагментах skills/**/*.md и docs/*.md» находит .github/workflows/ci.yml jobs.tests, .github/workflows/ci.yml jobs.spec-publish, .github/workflows/npm.yml jobs.publish, skills/spec/ci.md jobs.e2e, docs/ci-concurrency.md jobs.deploy-dev
- ✅ нарушитель не проходит: job tests прогона PR #662
- ✅ .github/workflows/ci.yml jobs.spec-publish ограничена по времени
- ✅ .github/workflows/ci.yml jobs.tests ограничена по времени
- ✅ .github/workflows/npm.yml jobs.publish ограничена по времени
- ✅ docs/ci-concurrency.md jobs.deploy-dev ограничена по времени
- ✅ skills/spec/ci.md jobs.e2e ограничена по времени
- ✅ skills/spec/ci.md jobs.spec ограничена по времени
- ✅ skills/spec/ci.md jobs.spec-diff ограничена по времени
- ✅ skills/spec/ci.md jobs.spec-publish (2) ограничена по времени
- ✅ skills/spec/ci.md jobs.spec-publish ограничена по времени
- ✅ skills/spec/ci.md jobs.test-spec ограничена по времени
- ✅ skills/spec/ci.md jobs.unit ограничена по времени
- ✅ пример: job без предела — ошибка с файлом и job

</details>
