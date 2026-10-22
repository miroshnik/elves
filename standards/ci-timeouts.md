<!-- spec-doc: сгенерировано из названий тестов, руками не править -->
# ci-timeouts

Каждая job workflow Elves стоит с `timeout-minutes`, а шаг, который ставит пакеты из сети, — ещё и со своим: без
предела GitHub держит зависшую job до 6 часов, `ci-wait` агента ждёт её всё это время, а перезапуск — руками.

Прогон CI PR #662 20 минут висел на шаге `zsh` — `sudo apt-get update -qq && sudo apt-get install -y -qq zsh` без
единой строки вывода, пока его не отменили; соседний прогон в то же время прошёл этот шаг за секунды: зависло зеркало
apt раннера, а не код (#674). Предела не было ни у шага, ни у job.

## Правило

Реестр — `.github/workflows/*.yml` Elves, разобранные как YAML: якоря раскрыты, шаг под псевдонимом — шаг своей job.

- Job — с `timeout-minutes`: минут больше нуля или выражение `${{ … }}`. Запас — к обычному прогону: `tests` — 20
  минут при 5–6, `batch` — 15 при 3.
- Шаг, чей `run` ставит пакеты, — со своим `timeout-minutes`: системный менеджер (`apt-get`, `apt`, `dnf`, `yum`,
  `apk`, `zypper`, `brew`, `choco`, `snap` — `install`, `update`, `upgrade`, `add`), менеджер проекта (`bun`, `npm`,
  `pnpm`, `yarn` — `install`, `i`, `ci`, `add`), `pip install`, `playwright install`. Предела job мало: зависшее
  зеркало держало бы шаг до него, а свой предел валит шаг за минуты и называет его.

Шаги `uses:` (checkout, setup-bun, setup-node) своего предела не требуют — их держит предел job. YAML-фрагменты CI
скиллов и справочников, которые копируют проекты, — вне реестра: у их job предела нет, а `playwright install
--with-deps` ставит пакеты apt (#684).

## Шаг zsh

Предел шага — 8 минут, внутри — три попытки, каждая команда `apt-get` — до 120 с (`timeout -k 5 120`): обычно шаг
идёт секунды, зависшую попытку снимает повтор, а не отмена и перезапуск прогона. Другое зеркало не ставим: зависание
было разовым — соседний прогон прошёл шаг на том же зеркале за секунды.

Первый предел — 40 с на команду — был туже разброса живого зеркала: на `main` после выпуска пачки (PR #693) все три
`apt-get update` упёрлись в него по ~50 с, и медленное зеркало стало красным прогоном. Предел команды — от зависания,
а не от медленного ответа: 120 с — с запасом к медленному, три попытки укладываются в предел шага.

## Одно окружение у лёгкого и полного набора

Job `batch` (PR в ветку пачки) и `tests` (полный набор) ставят окружение одними шагами — checkout, setup-bun,
setup-node 24, zsh, `bun install`: шаги заданы якорями в `batch`, `tests` берёт их псевдонимами. Разойдутся Node или
zsh — лёгкий набор зелёный, а выпуск пачки красный. GitHub Actions разбирает якоря с сентября 2025 года, ключи слияния
`<<` — нет: якорь стоит у каждого шага. Composite action не взят: у его шагов нет `timeout-minutes`, предел шага zsh
держал бы только `timeout` в тексте команды.

## Шаг, который ставит пакеты из сети, ограничен по времени: зависшее зеркало apt не держит прогон часами

<details><summary>✅ 7 тестов</summary>

- ✅ реестр «шаги установки пакетов в .github/workflows» не пуст
- ✅ реестр «шаги установки пакетов в .github/workflows» находит .github/workflows/ci.yml jobs.batch «zsh», .github/workflows/ci.yml jobs.tests «zsh», .github/workflows/ci.yml jobs.batch «bun install --frozen-lockfile», .github/workflows/ci.yml jobs.tests «bun install --frozen-lockfile»
- ✅ нарушитель не проходит: шаг zsh прогона PR #662
- ✅ .github/workflows/ci.yml jobs.batch «bun install --frozen-lockfile» ограничен по времени
- ✅ .github/workflows/ci.yml jobs.batch «zsh» ограничен по времени
- ✅ .github/workflows/ci.yml jobs.tests «bun install --frozen-lockfile» ограничен по времени
- ✅ .github/workflows/ci.yml jobs.tests «zsh» ограничен по времени

</details>

### примеры

<details><summary>✅ 5 тестов</summary>

- ✅ шаг без своего предела — ошибка с файлом, job и шагом, даже если предел есть у job
- ✅ установка — системным менеджером с опциями до команды, менеджером проекта, pip и playwright
- ✅ сборка, тесты, публикация и проверка наличия — не установка
- ✅ шаг под псевдонимом якоря — шаг своей job со своим пределом; без имени — ключ по первой строке run
- ✅ предел — минут больше нуля или выражение; ноль и текст — не предел

</details>

## Каждая job ограничена по времени: зависший шаг не держит прогон до 6 часов, предела GitHub по умолчанию

<details><summary>✅ 8 тестов</summary>

- ✅ реестр «job в .github/workflows» не пуст
- ✅ реестр «job в .github/workflows» находит .github/workflows/ci.yml jobs.batch, .github/workflows/ci.yml jobs.tests, .github/workflows/ci.yml jobs.spec-publish, .github/workflows/npm.yml jobs.publish
- ✅ нарушитель не проходит: job tests прогона PR #662
- ✅ .github/workflows/ci.yml jobs.batch ограничена по времени
- ✅ .github/workflows/ci.yml jobs.spec-publish ограничена по времени
- ✅ .github/workflows/ci.yml jobs.tests ограничена по времени
- ✅ .github/workflows/npm.yml jobs.publish ограничена по времени
- ✅ пример: job без предела — ошибка с файлом и job

</details>

## Лёгкий и полный набор CI идут в одном окружении

<details><summary>✅ 1 тест</summary>

- ✅ job batch и tests ставят его одними шагами — до bun install включительно

</details>
