<!-- spec-doc: сгенерировано из названий тестов, руками не править -->
# documents

Документы флоу — канон, `SKILL.md` и справочники скиллов, `docs/`, README: их размер, язык, полнота и ссылки.

## canon-size

Ядро канона (`AGENTS.md`, у Claude Code ещё `claude/CLAUDE.md`) грузится в контекст на старте каждой сессии и
каждого субагента и заново читается на каждом ходу; 99 % токенов сессии — это чтение кэша. `SKILL.md` агент читает
при каждом вызове скилла — по замерам сессий в проектах (эпик #428) медиана 8 раз за сессию, а описание скилла стоит
в списке скиллов каждой сессии. Поэтому у них бюджет в словах: `AGENTS.md` ≤ 3 000, `claude/CLAUDE.md` ≤ 700, каждый
`SKILL.md` ≤ 2 500, описание скилла (`description` во frontmatter) ≤ 1 024 символов. Справочное — как писать спеку,
как устроен проект GitHub, флаги команд — живёт там, где его читают по делу: `reference.md` скилла, `--help` скрипта,
`docs/`; ядро и `SKILL.md` называют, когда и что звать и куда идти.

Файл упёрся в бюджет — подробность уходит целой темой в md этой темы (существующий `docs/<тема>.md` или
`reference.md` скилла, нет такого — новый `docs/<тема>.md`), в каноне остаются строка и ссылка; факт ради бюджета не
удаляется и не ужимается до потери причины, числа или условия. Правило записано в `AGENTS.md` («This file and skills»),
стандарт держит его наличие. Почему (#716): в пачке `batch/2026-10-26-1` и раньше (сжатие 10-14) исполнители на пределе
выкидывали причины и уточнения — «иначе Claude Code не кладёт вывод в контекст», «таймаут 60 с», «иначе чужая флака
станет моей регрессией», модель цены субагента; сверка всей истории канона вернула их в md тем.

Бюджет был в байтах (`AGENTS.md` ≤ 32 КиБ): после перевода канона на английский (10-09) байт на слово стало вдвое
меньше, и лимит ослаб вдвое — за две недели канон вырос на 46 % по словам, `SKILL.md` — в 2,4 раза, при зелёном
стандарте. Слова от языка почти не зависят. Слово — всё между пробелами, как `wc -w`; считается весь файл, блоки кода
и frontmatter тоже: в контекст попадает всё. 3 000 английских слов — около 18 КБ, далеко от 32 КиБ — бюджета Codex на
все `AGENTS.md` проекта.

1 024 символа — лимит Agent Skills на описание: длиннее — список скиллов его обрезает, и триггеры «When — …» в хвосте
пропадают. Символы — кодовые точки, не байты. Описание считается так, как его читает YAML: в описании без кавычек
` #` начинает комментарий и молча отрезает хвост (так было у `github`), поэтому такое описание — тоже нарушение.

Второе правило того же стандарта: каждый скилл и справочник `docs/`, куда ядро отправляет читателя, существует — иначе
вынесенное потеряется молча.

Отвергнуто: лимит в токенах (нет тарификатора без сети; слова ему почти пропорциональны), лимит на строки (длинная
строка стоит столько же, сколько короткие) и бюджет на `reference.md` — его читают по указателю, когда нужен.

### Ядро канона и SKILL.md умещаются в бюджет слов, описание скилла — в лимит Agent Skills

<details><summary>✅ 49 тестов</summary>

- ✅ канон длиннее 3 000 слов не проходит стандарт
- ✅ SKILL.md длиннее 2 500 слов не проходит стандарт
- ✅ описание скилла длиннее 1 024 символов не проходит стандарт
- ✅ реестр «файлы ядра канона с бюджетом в словах» не пуст
- ✅ реестр «файлы ядра канона с бюджетом в словах» находит AGENTS.md, claude/CLAUDE.md
- ✅ нарушитель не проходит: канон длиннее 3 000 слов
- ✅ AGENTS.md не длиннее 3000 слов
- ✅ claude/CLAUDE.md не длиннее 700 слов
- ✅ реестр «SKILL.md скиллов» не пуст (бюджет слов)
- ✅ реестр «SKILL.md скиллов» находит skills/github/SKILL.md, skills/spec/SKILL.md, skills/est/SKILL.md, skills/task-env/SKILL.md (бюджет слов)
- ✅ нарушитель не проходит (бюджет слов): SKILL.md длиннее 2 500 слов
- ✅ skills/ci-wait/SKILL.md не длиннее 2500 слов
- ✅ skills/dashboard/SKILL.md не длиннее 2500 слов
- ✅ skills/est/SKILL.md не длиннее 2500 слов
- ✅ skills/github/SKILL.md не длиннее 2500 слов
- ✅ skills/slot/SKILL.md не длиннее 2500 слов
- ✅ skills/spec/SKILL.md не длиннее 2500 слов
- ✅ skills/task-env/SKILL.md не длиннее 2500 слов
- ✅ реестр «SKILL.md скиллов» не пуст (описание)
- ✅ реестр «SKILL.md скиллов» находит skills/github/SKILL.md, skills/task-env/SKILL.md, skills/dashboard/SKILL.md (описание)
- ✅ нарушитель не проходит (описание): описание скилла длиннее 1 024 символов
- ✅ нарушитель не проходит (описание): описание без кавычек, обрезанное комментарием YAML
- ✅ skills/ci-wait/SKILL.md: описание целиком и не длиннее 1024 символов
- ✅ skills/dashboard/SKILL.md: описание целиком и не длиннее 1024 символов
- ✅ skills/est/SKILL.md: описание целиком и не длиннее 1024 символов
- ✅ skills/github/SKILL.md: описание целиком и не длиннее 1024 символов
- ✅ skills/slot/SKILL.md: описание целиком и не длиннее 1024 символов
- ✅ skills/spec/SKILL.md: описание целиком и не длиннее 1024 символов
- ✅ skills/task-env/SKILL.md: описание целиком и не длиннее 1024 символов
- ✅ описание в кавычках с « #» и многострочное без кавычек — не обрезаны
- ✅ канон, упёршийся в бюджет, выносит подробность в md её темы со ссылкой, а факт не удаляет — правило есть в AGENTS.md
- ✅ бюджет считается в словах всего файла — что между пробелами, блоки кода и frontmatter не исключаются
- ✅ описание скилла — значение description во frontmatter в символах, а не в байтах
- ✅ указатель на скилл — `the `name` skill` или `skill `name``; команда скилла в бэктиках указателем не считается
- ✅ реестр «скиллы и справочники docs/, на которые ядро отправляет читателя» не пуст (существуют)
- ✅ реестр «скиллы и справочники docs/, на которые ядро отправляет читателя» находит skills/est/SKILL.md, skills/github/SKILL.md, skills/spec/SKILL.md, docs/ci-concurrency.md, docs/parallel-checkouts.md (существуют)
- ✅ нарушитель не проходит (существуют): ссылка ядра на удалённый скилл
- ✅ docs/ci-concurrency.md есть в репозитории
- ✅ docs/cloud-sessions.md есть в репозитории
- ✅ docs/judgment.md есть в репозитории
- ✅ docs/parallel-checkouts.md есть в репозитории
- ✅ docs/pr-checks.md есть в репозитории
- ✅ docs/production.md есть в репозитории
- ✅ docs/testing.md есть в репозитории
- ✅ skills/est/SKILL.md есть в репозитории
- ✅ skills/github/SKILL.md есть в репозитории
- ✅ skills/slot/SKILL.md есть в репозитории
- ✅ skills/spec/SKILL.md есть в репозитории
- ✅ skills/task-env/SKILL.md есть в репозитории

</details>

## flow-english

Флоу — канон, справочники, скиллы и README — пишется по-английски: репозиторий публичный, а агент работает с
человеком на языке проекта (`language` в `.agents/elves.json`, capability `elves#install`). Поэтому в документах флоу нет
кириллицы — ни в прозе, ни в цитатах вывода скриптов, ни в путях и плейсхолдерах. Под правило попадает и
`package.json`: его описание показывают npm и npx.

Названия, которые скрипты пишут в GitHub, в документы и тесты проекта и разбирают оттуда, — разделы issue, статусы,
типы, метки, поля, комментарии, последняя строка сессии, документация и тесты `spec` — живут на языке проекта, и у них
один дом: `skills/github/locales/<язык>.json`, одни ключи у каждого языка. Канон называет английские, скрипты читают
словарь модулем `skills/github/scripts/locale.ts` по языку проекта: пишут на нём, а разбирают названия любого языка —
проект, сменивший язык, и задачи чужих репозиториев читаются без знания их языка. Словари модуль берёт статическим
импортом в карту, типизированную `Names`, а не чтением каталога: typecheck сверяет каждый словарь с типом, а модуль
грузится любым раннером проекта (`harness-load`). Файл языка вне карты скрипты молча не видели бы — стандарт держит, что
каждый файл `locales/` — язык модуля. И проверяет, что каждое название словаря скрипты читают по полному пути ключа
(`N.status.backlog`): название строкой в коде мимо словаря или мёртвый ключ — красный тест, а не тихая подмена
названия, которое агент пишет руками.

Сообщения установщика и скриптов скиллов — справка, подсказки, ошибки, вывод `check` и хука — часть флоу, а не
артефакт проекта: их читает агент любого проекта, поэтому они по-английски при любом языке проекта. Названия на языке
проекта скрипты берут из словаря, а комментарии в коде флоу — по-английски, как его документы: их читает тот, кто правит
скилл, а язык самого Elves — `ru`, и без проверки новый код снова получал бы русские комментарии. Значит, кириллицы в
коде скриптов нет вовсе — стандарт проверяет каждый файл кода скиллов и установщика целиком, с комментариями (словари
`skills/github/locales` — не код), а справку — запуском `--help`. Доки флоу цитируют вывод в «ёлочках»: по
цитате агент узнаёт исход и ищет строку. Цитата, которой скрипт не печатает, — тихий дрейф, поэтому каждая сверяется с
кодом: литеральные куски между подстановками (`<имя>`, `…`, `N`, `#`) есть в коде скриптов или в `en.json`. Цитату
из нескольких документов тест называет по первому в порядке путей, а не в порядке файловой системы: имя теста —
утверждение спеки, на macOS и в CI оно одно.

Правило языка проекта — `language` манифеста, без поля — `ru`, без манифеста — `en` — в том же модуле, и установщик
берёт язык им же. Своё правило у установщика разошлось бы с правилом скриптов молча — стандарт держит, что его нет.

Отвергнуто: русские названия таблицей в каноне или цитатами в справочниках — кириллица в документах флоу, и та же
таблица копией в каждом месте, где её цитируют. Сообщения скриптов на языке проекта — сотни строк словаря на каждый язык
ради читателя-агента, который понимает английский; на язык проекта переводит он сам, когда пишет человеку.

### Флоу написан по-английски: в его документах нет кириллицы

<details><summary>✅ 30 тестов</summary>

- ✅ реестр «документы флоу — AGENTS.md, claude/CLAUDE.md, README.md, package.json, docs/*.md, *.md скиллов» не пуст
- ✅ реестр «документы флоу — AGENTS.md, claude/CLAUDE.md, README.md, package.json, docs/*.md, *.md скиллов» находит AGENTS.md, claude/CLAUDE.md, README.md, package.json, docs/testing.md, skills/spec/SKILL.md, skills/github/reference.md
- ✅ нарушитель не проходит: справочник с русской цитатой вывода скрипта
- ✅ в AGENTS.md нет кириллицы
- ✅ в README.md нет кириллицы
- ✅ в claude/CLAUDE.md нет кириллицы
- ✅ в docs/ci-concurrency.md нет кириллицы
- ✅ в docs/cloud-sessions.md нет кириллицы
- ✅ в docs/judgment.md нет кириллицы
- ✅ в docs/parallel-checkouts.md нет кириллицы
- ✅ в docs/pr-checks.md нет кириллицы
- ✅ в docs/production.md нет кириллицы
- ✅ в docs/prompt-cache.md нет кириллицы
- ✅ в docs/testing.md нет кириллицы
- ✅ в package.json нет кириллицы
- ✅ в skills/ci-wait/SKILL.md нет кириллицы
- ✅ в skills/dashboard/SKILL.md нет кириллицы
- ✅ в skills/est/SKILL.md нет кириллицы
- ✅ в skills/est/reference.md нет кириллицы
- ✅ в skills/github/SKILL.md нет кириллицы
- ✅ в skills/github/reference.md нет кириллицы
- ✅ в skills/slot/SKILL.md нет кириллицы
- ✅ в skills/spec/SKILL.md нет кириллицы
- ✅ в skills/spec/canon.md нет кириллицы
- ✅ в skills/spec/checks.md нет кириллицы
- ✅ в skills/spec/ci.md нет кириллицы
- ✅ в skills/spec/migration.md нет кириллицы
- ✅ в skills/spec/reference.md нет кириллицы
- ✅ в skills/task-env/SKILL.md нет кириллицы
- ✅ в skills/task-env/reference.md нет кириллицы

</details>

### Код установщика и скриптов скиллов — сообщения и комментарии — по-английски

Сообщения установщика и скриптов скиллов — справка, подсказки, ошибки, вывод `check` и хука — часть флоу, а не
артефакт проекта: они по-английски при любом языке проекта. Названия на языке проекта скрипты берут из словаря
(`skills/github/locales`), а комментарии — по-английски, как документы флоу, поэтому кириллицы в коде скриптов нет
вовсе: файл сверяется целиком, с комментариями.

<details><summary>✅ 32 теста</summary>

- ✅ реестр «код скриптов скиллов и установщика — skills/*/scripts и bin» не пуст
- ✅ реестр «код скриптов скиллов и установщика — skills/*/scripts и bin» находит bin/elves.ts, skills/github/scripts/github.ts, skills/est/scripts/est.ts, skills/spec/scripts/harness.ts
- ✅ нарушитель не проходит: комментарий по-русски
- ✅ в bin/ai-dev.ts нет кириллицы
- ✅ в bin/elves.ts нет кириллицы
- ✅ в skills/dashboard/scripts/dashboard.ts нет кириллицы
- ✅ в skills/dashboard/scripts/sessions.ts нет кириллицы
- ✅ в skills/est/scripts/est.ts нет кириллицы
- ✅ в skills/github/scripts/github.ts нет кириллицы
- ✅ в skills/github/scripts/locale.ts нет кириллицы
- ✅ в skills/slot/scripts/slot.ts нет кириллицы
- ✅ в skills/spec/scripts/architecture.ts нет кириллицы
- ✅ в skills/spec/scripts/c4.ts нет кириллицы
- ✅ в skills/spec/scripts/eslint-config.ts нет кириллицы
- ✅ в skills/spec/scripts/harness.ts нет кириллицы
- ✅ в skills/spec/scripts/knip-hints.cjs нет кириллицы
- ✅ в skills/spec/scripts/knip-hints.d.cts нет кириллицы
- ✅ в skills/spec/scripts/package-run.ts нет кириллицы
- ✅ в skills/spec/scripts/precommit.ts нет кириллицы
- ✅ в skills/spec/scripts/spec-break.ts нет кириллицы
- ✅ в skills/spec/scripts/spec-claims.ts нет кириллицы
- ✅ в skills/spec/scripts/spec-diff.ts нет кириллицы
- ✅ в skills/spec/scripts/spec-doc.ts нет кириллицы
- ✅ в skills/spec/scripts/spec-exceptions.ts нет кириллицы
- ✅ в skills/spec/scripts/spec-publish.ts нет кириллицы
- ✅ в skills/spec/scripts/spec-run.ts нет кириллицы
- ✅ в skills/spec/scripts/spec-shard.ts нет кириллицы
- ✅ в skills/spec/scripts/speclib.ts нет кириллицы
- ✅ в skills/spec/scripts/vendor/babel-parser.cjs нет кириллицы
- ✅ в skills/spec/scripts/vendor/babel-parser.d.cts нет кириллицы
- ✅ в skills/task-env/scripts/task-env.ts нет кириллицы
- ✅ справка установщика и скриптов скиллов и их команд — на английском

</details>

### Строки вывода, которые цитируют доки флоу, скрипты печатают дословно

Доки флоу цитируют вывод скриптов — строки, по которым агент узнаёт исход, — и названия, которые скрипты пишут в
GitHub. Цитата, которой нет в коде, — дрейф: скрипт печатает иначе, и агент ищет строку, которой не будет. Цитата
сверяется по литеральным кускам между подстановками: каждый кусок со словом — в коде скриптов или в `en.json`.

<details><summary>✅ 207 тестов</summary>

- ✅ реестр «цитаты «…» в документах флоу» не пуст
- ✅ реестр «цитаты «…» в документах флоу» находит already newer, Actual (cloud), closed in 90 days without an actual: N
- ✅ нарушитель не проходит: цитата вывода, которого нет
- ✅ цитату «## Questions» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «### Task scenarios» из skills/spec/SKILL.md печатает или пишет скрипт
- ✅ цитату «#N \<title>» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «$ per 1M tokens» из skills/est/reference.md печатает или пишет скрипт
- ✅ цитату «+ manually: N h» из skills/est/SKILL.md печатает или пишет скрипт
- ✅ цитату «30 days» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «90 days» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «\<VAR> is declared» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «\<VAR> is read in the code» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «\<entry> is called by a capability test» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «\<module> imports \<package>» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «\<module> uses allowed package \<package>» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «\<title> — added» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «\<title> — removed» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «Actual (cloud): …» из skills/est/SKILL.md печатает или пишет скрипт
- ✅ цитату «Actual (cloud)» из skills/est/SKILL.md печатает или пишет скрипт
- ✅ цитату «Actual unavailable (cloud)» из skills/est/SKILL.md печатает или пишет скрипт
- ✅ цитату «Actual, h» из skills/est/SKILL.md печатает или пишет скрипт
- ✅ цитату «Actual» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «Added» из skills/spec/SKILL.md печатает или пишет скрипт
- ✅ цитату «All done, but there are questions…» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «All done. The session can be closed.» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «Architecture model» из skills/spec/SKILL.md печатает или пишет скрипт
- ✅ цитату «Base» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «Became tests» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «Bug» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «CI red» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «CI running» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «Changed» из skills/spec/SKILL.md печатает или пишет скрипт
- ✅ цитату «Closed by PR #M: GitHub didn't link the PR to the task» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «Closes #N» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «Cloud session … not imported — est cloud-import» из skills/est/SKILL.md печатает или пишет скрипт
- ✅ цитату «Cost by model» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «Cost, $» из skills/est/SKILL.md печатает или пишет скрипт
- ✅ цитату «Decided auto» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «Epic» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «Estimate and actual» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «Estimate, h» из skills/est/SKILL.md печатает или пишет скрипт
- ✅ цитату «Estimate: …» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «Estimate» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «Exceptions» из skills/spec/SKILL.md печатает или пишет скрипт
- ✅ цитату «Folder» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «Harness checks» из skills/spec/SKILL.md печатает или пишет скрипт
- ✅ цитату «Item closed» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «Moved into the tree» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «Next:» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «No estimate: …» из skills/est/SKILL.md печатает или пишет скрипт
- ✅ цитату «No estimate» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «Not counted again: N h already in the actual of #M» из skills/est/SKILL.md печатает или пишет скрипт
- ✅ цитату «Of them, from the harness» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «Outside the tree» из skills/spec/SKILL.md печатает или пишет скрипт
- ✅ цитату «Overlap with the actual of #M … — recompute #M» из skills/est/SKILL.md печатает или пишет скрипт
- ✅ цитату «Refresh after #N, #M, result: …» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «Refresh after #N, #M, result:» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «Refresh after #N, result: …» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «Refresh after #N, result:» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «Refresh after #N, script: …» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «Refresh» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «Regrouped into topics» из skills/spec/migration.md печатает или пишет скрипт
- ✅ цитату «Remaining: …» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «Removed» из skills/spec/SKILL.md печатает или пишет скрипт
- ✅ цитату «Sessions» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «Task #N (epic #M)» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «Task #N …» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «Task #N, #M (epic #E)» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «Task #N» из skills/est/SKILL.md печатает или пишет скрипт
- ✅ цитату «Task» из skills/est/SKILL.md печатает или пишет скрипт
- ✅ цитату «Tests beyond scenarios» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «The requested branch or commit was not found» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «Tokens, M» из skills/est/SKILL.md печатает или пишет скрипт
- ✅ цитату «Waiting for the owner» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «What it's made of» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «What the system does» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «What to do» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «Which rules the code obeys» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «`<base>` is red: \<check | typecheck | test:spec>» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «`<base>` is red…» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «`main` is red…» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «a mark belongs in one element's file» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «a proxy without the API?» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «actual unavailable» из skills/est/SKILL.md печатает или пишет скрипт
- ✅ цитату «after / before» из skills/est/reference.md печатает или пишет скрипт
- ✅ цитату «agent Bash: not set up» из claude/CLAUDE.md печатает или пишет скрипт
- ✅ цитату «agents» из skills/est/reference.md печатает или пишет скрипт
- ✅ цитату «all knip findings are of known kinds» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «all time» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «allowed: …» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «allowed» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «already newer» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «analogs» из skills/est/reference.md печатает или пишет скрипт
- ✅ цитату «appended to #N» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «architecture model» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «beyond scenarios» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «can be closed» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «can't listen on 127.0.0.1 …» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «client \<pkg> of storage \<s> is in container \<c>» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «closed by PR» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «closed in 90 days without an actual: N» из skills/est/SKILL.md печатает или пишет скрипт
- ✅ цитату «cloud, state not visible» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «code without a consumer» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «declare the external system» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «dependency \<a> → \<b> is within a container» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «deployable unit \<id> is container \<c>» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «deploy» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «directory \<dir> is in module \<module>» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «element files from fileOf exist» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «entry points» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «entry-point ids do not repeat in the registry» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «epic» из skills/est/reference.md печатает или пишет скрипт
- ✅ цитату «estimate» из skills/est/reference.md печатает или пишет скрипт
- ✅ цитату «exception: \<entry> (#N)» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «exception: \<key> (#N)» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «exceptions are \<element>.json files in the decision folder's exceptions/» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «exceptions are one file per element in exceptions/, not exceptions.ts» из skills/spec/SKILL.md печатает или пишет скрипт
- ✅ цитату «exceptions in \<file>: \<rules> (#N)» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «exceptions with a rule belong to the folder's invariant rules» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «filed #M» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «forms» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «from project …» из skills/est/reference.md печатает или пишет скрипт
- ✅ цитату «from the report» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «header \<H> … is read only by adapter \<a>» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «human reply» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «ids from the log are in the registry» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «is declared» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «is denied here (an agent's sandbox?)» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «is read» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «isn't read — names aren't exceptions any more, delete it» из skills/spec/SKILL.md печатает или пишет скрипт
- ✅ цитату «kept» из skills/est/reference.md печатает или пишет скрипт
- ✅ цитату «key \<K> of external system \<x> is read only by adapter \<a>» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «library \<m> is in containers \<c1, c2>» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «main tree … not fully checked — publishing skipped» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «marks with a rule belong to the folder's invariant rules» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «merge into the topic's label» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «merge» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «module \<m> is in container \<c>» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «move it to outside» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «mutations» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «new decision» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «no calls to unlisted binaries» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «no changes — … confirmed for …» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «no changes» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «no dependencies without an import» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «no duplicate exports» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «no enum members without a consumer» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «no exports without a consumer» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «no files without a consumer» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «no green run» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «no imports of unlisted packages» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «no knip configuration hints» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «no namespace members without a consumer» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «no price» из skills/est/SKILL.md печатает или пишет скрипт
- ✅ цитату «no references to missing catalog entries» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «no session» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «no types without a consumer» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «no unresolved imports» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «no unused catalog entries» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «none» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «not allowed: …» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «not allowed» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «not empty» из skills/spec/reference.md печатает или пишет скрипт
- ✅ цитату «not imported» из skills/est/SKILL.md печатает или пишет скрипт
- ✅ цитату «not installed» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «not written: …» из skills/est/SKILL.md печатает или пишет скрипт
- ✅ цитату «one record per element» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «outside scope: \<VAR>» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «outside scope: \<element>» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «outside scope: \<key>» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «outside scope: …» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «outside scope» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «past the batch» из skills/github/SKILL.md печатает или пишет скрипт
- ✅ цитату «perimeter» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «prompt cache TTL» из claude/CLAUDE.md печатает или пишет скрипт
- ✅ цитату «proxy …: routes not read» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «question: merge PR #N?» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «questions» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «queue #263?» из AGENTS.md печатает или пишет скрипт
- ✅ цитату «queue #M?» из claude/CLAUDE.md печатает или пишет скрипт
- ✅ цитату «queue #N?» из skills/github/SKILL.md печатает или пишет скрипт
- ✅ цитату «queue it?» из AGENTS.md печатает или пишет скрипт
- ✅ цитату «release of `<batch>` — #N, …» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «release» из skills/github/SKILL.md печатает или пишет скрипт
- ✅ цитату «remove from scope» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «remove the exception: delete \<file>» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «remove the exception» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «remove the mark in \<file>:\<line>» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «repo» из skills/est/reference.md печатает или пишет скрипт
- ✅ цитату «run the dispatcher on epic #M?» из AGENTS.md печатает или пишет скрипт
- ✅ цитату «silence» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «the block is current» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «this PR fixes red `<base>`: it closes #N, whose commit … made it red» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «turns» из skills/est/reference.md печатает или пишет скрипт
- ✅ цитату «unsplit: N h» из skills/est/reference.md печатает или пишет скрипт
- ✅ цитату «violator does not pass: …» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «waits for subagents» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «waits for the previous executor» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «working» из skills/dashboard/SKILL.md печатает или пишет скрипт
- ✅ цитату «workspace package \<path> is in the code roots» из skills/spec/checks.md печатает или пишет скрипт
- ✅ цитату «yes» из skills/github/reference.md печатает или пишет скрипт
- ✅ цитату «…» из skills/github/reference.md печатает или пишет скрипт
- ✅ вне охвата: api/DATABASE_URL is declared
  > пример названия с подставленным элементом: шаблон «{name} is declared» — в en.json
- ✅ вне охвата: host \<h> is only in adapter \<a>
  > название собрано из двух ключей en.json: hostName и inAdapter
- ✅ вне охвата: package \<p> of external system \<x> is only with adapter \<a>
  > название собрано из двух ключей en.json: packageName и withAdapter
- ✅ вне охвата: shared commit … (share 1/k)
  > строка собрана из двух ключей en.json: est.fact.shared и est.fact.commitUnit
- ✅ имя теста цитаты не зависит от порядка, в котором файловая система отдаёт документы

</details>

### Названия, которые пишут и разбирают скрипты, — в locales скилла github, у каждого языка одни ключи

<details><summary>✅ 361 тест</summary>

- ✅ у каждого языка те же ключи, что у en, и ни одного пустого названия
- ✅ в en.json нет кириллицы
- ✅ каждый файл skills/github/locales/*.json — язык модуля locale с этим словарём, en первым
  > Модуль `locale` берёт словари статическим импортом в карту, типизированную `Names`, — каталог `locales/` он не
  > читает: так tsc сверяет каждый словарь с типом, а модуль грузится любым раннером проекта
  > (tests/standards/exports/harness-load). Файл языка, которого нет в карте, молча не подхватился бы ни скриптами, ни typecheck.
- ✅ реестр «названия словаря skills/github/locales/en.json» не пуст
- ✅ реестр «названия словаря skills/github/locales/en.json» находит status.backlog, sections.questions, subagentPrompt.task, lastLine.done
- ✅ нарушитель не проходит: название, которого скрипты не читают
- ✅ название actualize.answer скрипты читают из словаря
- ✅ название actualize.answers скрипты читают из словаря
- ✅ название actualize.backlog скрипты читают из словаря
- ✅ название actualize.checks скрипты читают из словаря
- ✅ название actualize.comment скрипты читают из словаря
- ✅ название actualize.commentAnswer скрипты читают из словаря
- ✅ название actualize.copies скрипты читают из словаря
- ✅ название actualize.copy скрипты читают из словаря
- ✅ название actualize.epic скрипты читают из словаря
- ✅ название actualize.fetch скрипты читают из словаря
- ✅ название actualize.files скрипты читают из словаря
- ✅ название actualize.format скрипты читают из словаря
- ✅ название actualize.inWork скрипты читают из словаря
- ✅ название actualize.lead скрипты читают из словаря
- ✅ название actualize.linkWords скрипты читают из словаря
- ✅ название actualize.mechanics скрипты читают из словаря
- ✅ название actualize.milestone скрипты читают из словаря
- ✅ название actualize.noBody скрипты читают из словаря
- ✅ название actualize.noPr скрипты читают из словаря
- ✅ название actualize.openTask скрипты читают из словаря
- ✅ название actualize.openTasks скрипты читают из словаря
- ✅ название actualize.prs скрипты читают из словаря
- ✅ название actualize.report скрипты читают из словаря
- ✅ название actualize.scope скрипты читают из словаря
- ✅ название actualize.shipped скрипты читают из словаря
- ✅ название actualize.shippedTask скрипты читают из словаря
- ✅ название actualize.taskPr скрипты читают из словаря
- ✅ название actualize.taskStatus скрипты читают из словаря
- ✅ название actualize.unblocked скрипты читают из словаря
- ✅ название actualize.unlabeled скрипты читают из словаря
- ✅ название autoAnswer скрипты читают из словаря
- ✅ название comments.actual скрипты читают из словаря
- ✅ название comments.closedByPr скрипты читают из словаря
- ✅ название comments.externalBlocker скрипты читают из словаря
- ✅ название comments.state скрипты читают из словаря
- ✅ название est.answer скрипты читают из словаря
- ✅ название est.closingWords скрипты читают из словаря
- ✅ название est.cloud.actual скрипты читают из словаря
- ✅ название est.cloud.body скрипты читают из словаря
- ✅ название est.cloud.cost скрипты читают из словаря
- ✅ название est.cloud.fields скрипты читают из словаря
- ✅ название est.cloud.session скрипты читают из словаря
- ✅ название est.cloud.tokens скрипты читают из словаря
- ✅ название est.cloud.unavailable скрипты читают из словаря
- ✅ название est.estimate.analog скрипты читают из словаря
- ✅ название est.estimate.auto скрипты читают из словаря
- ✅ название est.estimate.body скрипты читают из словаря
- ✅ название est.estimate.correction скрипты читают из словаря
- ✅ название est.estimate.expert скрипты читают из словаря
- ✅ название est.estimate.expertOver скрипты читают из словаря
- ✅ название est.estimate.forecast скрипты читают из словаря
- ✅ название est.estimate.headline скрипты читают из словаря
- ✅ название est.estimate.k скрипты читают из словаря
- ✅ название est.estimate.labels скрипты читают из словаря
- ✅ название est.estimate.levelAll скрипты читают из словаря
- ✅ название est.estimate.levelRepo скрипты читают из словаря
- ✅ название est.estimate.noK скрипты читают из словаря
- ✅ название est.estimate.none скрипты читают из словаря
- ✅ название est.estimate.notInProject скрипты читают из словаря
- ✅ название est.estimate.otherProject скрипты читают из словаря
- ✅ название est.estimate.partial скрипты читают из словаря
- ✅ название est.estimate.partialCoverage скрипты читают из словаря
- ✅ название est.estimate.size скрипты читают из словаря
- ✅ название est.estimate.spread скрипты читают из словаря
- ✅ название est.estimate.tokCorrection скрипты читают из словаря
- ✅ название est.estimate.tokens скрипты читают из словаря
- ✅ название est.estimate.type скрипты читают из словаря
- ✅ название est.estimate.unknown скрипты читают из словаря
- ✅ название est.estimate.words скрипты читают из словаря
- ✅ название est.fact.and скрипты читают из словаря
- ✅ название est.fact.body скрипты читают из словаря
- ✅ название est.fact.cloudAgent скрипты читают из словаря
- ✅ название est.fact.cloudMissing скрипты читают из словаря
- ✅ название est.fact.commitUnit скрипты читают из словаря
- ✅ название est.fact.commits скрипты читают из словаря
- ✅ название est.fact.cost скрипты читают из словаря
- ✅ название est.fact.diff скрипты читают из словаря
- ✅ название est.fact.diffLines скрипты читают из словаря
- ✅ название est.fact.diffNa скрипты читают из словаря
- ✅ название est.fact.estimate скрипты читают из словаря
- ✅ название est.fact.noEstimate скрипты читают из словаря
- ✅ название est.fact.noPr скрипты читают из словаря
- ✅ название est.fact.overhead скрипты читают из словаря
- ✅ название est.fact.overlap скрипты читают из словаря
- ✅ название est.fact.prompts скрипты читают из словаря
- ✅ название est.fact.prs скрипты читают из словаря
- ✅ название est.fact.sessions скрипты читают из словаря
- ✅ название est.fact.shared скрипты читают из словаря
- ✅ название est.fact.steps скрипты читают из словаря
- ✅ название est.fact.subagents скрипты читают из словаря
- ✅ название est.fact.taken скрипты читают из словаря
- ✅ название est.fact.tokens скрипты читают из словаря
- ✅ название est.fact.tokensSplit скрипты читают из словаря
- ✅ название est.fact.unavailable скрипты читают из словаря
- ✅ название est.fact.unpriced скрипты читают из словаря
- ✅ название est.fact.waits скрипты читают из словаря
- ✅ название est.fact.waitsSlot скрипты читают из словаря
- ✅ название est.hours скрипты читают из словаря
- ✅ название est.manual скрипты читают из словаря
- ✅ название est.reason скрипты читают из словаря
- ✅ название est.stopWords скрипты читают из словаря
- ✅ название fields.actual скрипты читают из словаря
- ✅ название fields.cost скрипты читают из словаря
- ✅ название fields.estimate скрипты читают из словаря
- ✅ название fields.tokens скрипты читают из словаря
- ✅ название formerly.updateTask скрипты читают из словаря
- ✅ название issueTypes.bug скрипты читают из словаря
- ✅ название issueTypes.epic скрипты читают из словаря
- ✅ название issueTypes.task скрипты читают из словаря
- ✅ название labelMarkers.architecturePath скрипты читают из словаря
- ✅ название labelMarkers.decision скрипты читают из словаря
- ✅ название labelMarkers.slice скрипты читают из словаря
- ✅ название labels.epicDescription скрипты читают из словаря
- ✅ название labels.externalBlocker скрипты читают из словаря
- ✅ название labels.questions скрипты читают из словаря
- ✅ название labels.questionsDescription скрипты читают из словаря
- ✅ название lastLine.done скрипты читают из словаря
- ✅ название lastLine.questions скрипты читают из словаря
- ✅ название lastLine.remaining скрипты читают из словаря
- ✅ название mainRed.check скрипты читают из словаря
- ✅ название mainRed.checks скрипты читают из словаря
- ✅ название mainRed.step скрипты читают из словаря
- ✅ название mainRed.title скрипты читают из словаря
- ✅ название prSpecSection скрипты читают из словаря
- ✅ название queue.alive скрипты читают из словаря
- ✅ название queue.answer скрипты читают из словаря
- ✅ название queue.batchLead скрипты читают из словаря
- ✅ название queue.batchRefresh скрипты читают из словаря
- ✅ название queue.batchWait скрипты читают из словаря
- ✅ название queue.bypass скрипты читают из словаря
- ✅ название queue.cloud скрипты читают из словаря
- ✅ название queue.cloudBatch скрипты читают из словаря
- ✅ название queue.cloudClose скрипты читают из словаря
- ✅ название queue.cloudDispatcher скрипты читают из словаря
- ✅ название queue.cloudDoc скрипты читают из словаря
- ✅ название queue.cloudEpic скрипты читают из словаря
- ✅ название queue.cloudModeAsk скрипты читают из словаря
- ✅ название queue.cloudQuestion скрипты читают из словаря
- ✅ название queue.epic скрипты читают из словаря
- ✅ название queue.fixLead скрипты читают из словаря
- ✅ название queue.fixPrevious скрипты читают из словаря
- ✅ название queue.found скрипты читают из словаря
- ✅ название queue.git скрипты читают из словаря
- ✅ название queue.lead скрипты читают из словаря
- ✅ название queue.live скрипты читают из словаря
- ✅ название queue.merge скрипты читают из словаря
- ✅ название queue.modeAsk скрипты читают из словаря
- ✅ название queue.modeAuto скрипты читают из словаря
- ✅ название queue.prompt скрипты читают из словаря
- ✅ название queue.question скрипты читают из словаря
- ✅ название queue.refresh скрипты читают из словаря
- ✅ название queue.repeats скрипты читают из словаря
- ✅ название queue.resume скрипты читают из словаря
- ✅ название queue.session скрипты читают из словаря
- ✅ название queue.sessionBatchLead скрипты читают из словаря
- ✅ название queue.sessionEnd скрипты читают из словаря
- ✅ название queue.sessionFixLead скрипты читают из словаря
- ✅ название queue.sessionFound скрипты читают из словаря
- ✅ название queue.sessionIs скрипты читают из словаря
- ✅ название queue.sessionLead скрипты читают из словаря
- ✅ название queue.sessionName скрипты читают из словаря
- ✅ название queue.sessionQuestion скрипты читают из словаря
- ✅ название queue.sessionWait скрипты читают из словаря
- ✅ название queue.subagent скрипты читают из словаря
- ✅ название queue.subagents скрипты читают из словаря
- ✅ название queue.wait скрипты читают из словаря
- ✅ название regroupTask скрипты читают из словаря
- ✅ название release.lead скрипты читают из словаря
- ✅ название release.title скрипты читают из словаря
- ✅ название sections.questions скрипты читают из словаря
- ✅ название sections.scenarios скрипты читают из словаря
- ✅ название spec.architecture.allowedName скрипты читают из словаря
- ✅ название spec.architecture.allowedRegistry скрипты читают из словаря
- ✅ название spec.architecture.allowedViolator скрипты читают из словаря
- ✅ название spec.architecture.clientName скрипты читают из словаря
- ✅ название spec.architecture.clientViolator скрипты читают из словаря
- ✅ название spec.architecture.clientsRegistry скрипты читают из словаря
- ✅ название spec.architecture.containersRegistry скрипты читают из словаря
- ✅ название spec.architecture.containersViolator скрипты читают из словаря
- ✅ название spec.architecture.dirName скрипты читают из словаря
- ✅ название spec.architecture.dirViolator скрипты читают из словаря
- ✅ название spec.architecture.dirsRegistry скрипты читают из словаря
- ✅ название spec.architecture.edgeName скрипты читают из словаря
- ✅ название spec.architecture.edgeViolator скрипты читают из словаря
- ✅ название spec.architecture.edgesRegistry скрипты читают из словаря
- ✅ название spec.architecture.envNoun скрипты читают из словаря
- ✅ название spec.architecture.envRegistry скрипты читают из словаря
- ✅ название spec.architecture.headerNoun скрипты читают из словаря
- ✅ название spec.architecture.headersRegistry скрипты читают из словаря
- ✅ название spec.architecture.hostName скрипты читают из словаря
- ✅ название spec.architecture.hostPerimeter скрипты читают из словаря
- ✅ название spec.architecture.hostViolator скрипты читают из словаря
- ✅ название spec.architecture.hostsRegistry скрипты читают из словаря
- ✅ название spec.architecture.importsName скрипты читают из словаря
- ✅ название spec.architecture.importsRegistry скрипты читают из словаря
- ✅ название spec.architecture.importsViolator скрипты читают из словаря
- ✅ название spec.architecture.inAdapter скрипты читают из словаря
- ✅ название spec.architecture.inAdapters скрипты читают из словаря
- ✅ название spec.architecture.libraryName скрипты читают из словаря
- ✅ название spec.architecture.moduleName скрипты читают из словаря
- ✅ название spec.architecture.packageName скрипты читают из словаря
- ✅ название spec.architecture.packagePerimeter скрипты читают из словаря
- ✅ название spec.architecture.packageViolator скрипты читают из словаря
- ✅ название spec.architecture.packagesRegistry скрипты читают из словаря
- ✅ название spec.architecture.readName скрипты читают из словаря
- ✅ название spec.architecture.readNameMany скрипты читают из словаря
- ✅ название spec.architecture.readPerimeter скрипты читают из словаря
- ✅ название spec.architecture.readViolator скрипты читают из словаря
- ✅ название spec.architecture.unitName скрипты читают из словаря
- ✅ название spec.architecture.unitViolator скрипты читают из словаря
- ✅ название spec.architecture.unitsRegistry скрипты читают из словаря
- ✅ название spec.architecture.withAdapter скрипты читают из словаря
- ✅ название spec.architecture.withAdapters скрипты читают из словаря
- ✅ название spec.architecture.workspaceName скрипты читают из словаря
- ✅ название spec.architecture.workspaceRegistry скрипты читают из словаря
- ✅ название spec.architecture.workspaceViolator скрипты читают из словаря
- ✅ название spec.c4.calls скрипты читают из словаря
- ✅ название spec.c4.components скрипты читают из словаря
- ✅ название spec.c4.containerCount скрипты читают из словаря
- ✅ название spec.c4.containers скрипты читают из словаря
- ✅ название spec.c4.context скрипты читают из словаря
- ✅ название spec.c4.dependsOn скрипты читают из словаря
- ✅ название spec.c4.externalCount скрипты читают из словаря
- ✅ название spec.c4.intro скрипты читают из словаря
- ✅ название spec.c4.library скрипты читают из словаря
- ✅ название spec.c4.moduleCount скрипты читают из словаря
- ✅ название spec.c4.perimeter скрипты читают из словаря
- ✅ название spec.c4.summary скрипты читают из словаря
- ✅ название spec.c4.system скрипты читают из словаря
- ✅ название spec.c4.table скрипты читают из словаря
- ✅ название spec.c4.title скрипты читают из словаря
- ✅ название spec.c4.uses скрипты читают из словаря
- ✅ название spec.c4.viaModule скрипты читают из словаря
- ✅ название spec.c4.viaModules скрипты читают из словаря
- ✅ название spec.claims.called скрипты читают из словаря
- ✅ название spec.claims.describe скрипты читают из словаря
- ✅ название spec.claims.known скрипты читают из словаря
- ✅ название spec.claims.registry скрипты читают из словаря
- ✅ название spec.claims.unique скрипты читают из словаря
- ✅ название spec.diff.added скрипты читают из словаря
- ✅ название spec.diff.addedKind скрипты читают из словаря
- ✅ название spec.diff.architecture скрипты читают из словаря
- ✅ название spec.diff.base скрипты читают из словаря
- ✅ название spec.diff.becameTests скрипты читают из словаря
- ✅ название spec.diff.changed скрипты читают из словаря
- ✅ название spec.diff.checksTitle скрипты читают из словаря
- ✅ название spec.diff.deadCode скрипты читают из словаря
- ✅ название spec.diff.deadCodeNamed скрипты читают из словаря
- ✅ название spec.diff.empty скрипты читают из словаря
- ✅ название spec.diff.exceptionsTitle скрипты читают из словаря
- ✅ название spec.diff.extraFull скрипты читают из словаря
- ✅ название spec.diff.extraListed скрипты читают из словаря
- ✅ название spec.diff.extraMark скрипты читают из словаря
- ✅ название spec.diff.extraTitle скрипты читают из словаря
- ✅ название spec.diff.files скрипты читают из словаря
- ✅ название spec.diff.folder скрипты читают из словаря
- ✅ название spec.diff.fromReport скрипты читают из словаря
- ✅ название spec.diff.harnessCheck скрипты читают из словаря
- ✅ название spec.diff.harnessColumn скрипты читают из словаря
- ✅ название spec.diff.harnessGap скрипты читают из словаря
- ✅ название spec.diff.harnessNote скрипты читают из словаря
- ✅ название spec.diff.modelDependency скрипты читают из словаря
- ✅ название spec.diff.modelModule скрипты читают из словаря
- ✅ название spec.diff.modelPackage скрипты читают из словаря
- ✅ название spec.diff.modelTitle скрипты читают из словаря
- ✅ название spec.diff.moved скрипты читают из словаря
- ✅ название spec.diff.movedFolder скрипты читают из словаря
- ✅ название spec.diff.noScenarios скрипты читают из словаря
- ✅ название spec.diff.noSpecBase скрипты читают из словаря
- ✅ название spec.diff.noTest скрипты читают из словаря
- ✅ название spec.diff.notStatements скрипты читают из словаря
- ✅ название spec.diff.outsideFiles скрипты читают из словаря
- ✅ название spec.diff.outsideMark скрипты читают из словаря
- ✅ название spec.diff.partialReport скрипты читают из словаря
- ✅ название spec.diff.registry скрипты читают из словаря
- ✅ название spec.diff.registryNamed скрипты читают из словаря
- ✅ название spec.diff.regrouped скрипты читают из словаря
- ✅ название spec.diff.removed скрипты читают из словаря
- ✅ название spec.diff.removedKind скрипты читают из словаря
- ✅ название spec.diff.rule скрипты читают из словаря
- ✅ название spec.diff.ruleNamed скрипты читают из словаря
- ✅ название spec.diff.scenarios скрипты читают из словаря
- ✅ название spec.diff.summarized скрипты читают из словаря
- ✅ название spec.diff.summary скрипты читают из словаря
- ✅ название spec.diff.total скрипты читают из словаря
- ✅ название spec.diff.unchanged скрипты читают из словаря
- ✅ название spec.doc.architecture скрипты читают из словаря
- ✅ название spec.doc.capabilities скрипты читают из словаря
- ✅ название spec.doc.failing скрипты читают из словаря
- ✅ название spec.doc.failingCount скрипты читают из словаря
- ✅ название spec.doc.intro скрипты читают из словаря
- ✅ название spec.doc.mark скрипты читают из словаря
- ✅ название spec.doc.none скрипты читают из словаря
- ✅ название spec.doc.outside скрипты читают из словаря
- ✅ название spec.doc.outsideIntro скрипты читают из словаря
- ✅ название spec.doc.rules скрипты читают из словаря
- ✅ название spec.doc.skipped скрипты читают из словаря
- ✅ название spec.doc.skippedCount скрипты читают из словаря
- ✅ название spec.doc.standards скрипты читают из словаря
- ✅ название spec.doc.title скрипты читают из словаря
- ✅ название spec.doc.todo скрипты читают из словаря
- ✅ название spec.doc.variants скрипты читают из словаря
- ✅ название spec.harness.bad скрипты читают из словаря
- ✅ название spec.harness.badExample скрипты читают из словаря
- ✅ название spec.harness.codeFiles скрипты читают из словаря
- ✅ название spec.harness.elementFiles скрипты читают из словаря
- ✅ название spec.harness.env.declared скрипты читают из словаря
- ✅ название spec.harness.env.declaredName скрипты читают из словаря
- ✅ название spec.harness.env.inCode скрипты читают из словаря
- ✅ название spec.harness.env.readName скрипты читают из словаря
- ✅ название spec.harness.env.undeclared скрипты читают из словаря
- ✅ название spec.harness.env.unread скрипты читают из словаря
- ✅ название spec.harness.exception скрипты читают из словаря
- ✅ название spec.harness.exceptionFiles скрипты читают из словаря
- ✅ название spec.harness.exceptionJson скрипты читают из словаря
- ✅ название spec.harness.exceptionRules скрипты читают из словаря
- ✅ название spec.harness.good скрипты читают из словаря
- ✅ название spec.harness.ignoreNoReason скрипты читают из словаря
- ✅ название spec.harness.knip.binaries скрипты читают из словаря
- ✅ название spec.harness.knip.catalog скрипты читают из словаря
- ✅ название spec.harness.knip.catalogReferences скрипты читают из словаря
- ✅ название spec.harness.knip.dependencies скрипты читают из словаря
- ✅ название spec.harness.knip.duplicates скрипты читают из словаря
- ✅ название spec.harness.knip.enumMembers скрипты читают из словаря
- ✅ название spec.harness.knip.exports скрипты читают из словаря
- ✅ название spec.harness.knip.files скрипты читают из словаря
- ✅ название spec.harness.knip.hints скрипты читают из словаря
- ✅ название spec.harness.knip.known скрипты читают из словаря
- ✅ название spec.harness.knip.nsMembers скрипты читают из словаря
- ✅ название spec.harness.knip.types скрипты читают из словаря
- ✅ название spec.harness.knip.unlisted скрипты читают из словаря
- ✅ название spec.harness.knip.unresolved скрипты читают из словаря
- ✅ название spec.harness.lintExceptions скрипты читают из словаря
- ✅ название spec.harness.markOneElement скрипты читают из словаря
- ✅ название spec.harness.markRules скрипты читают из словаря
- ✅ название spec.harness.oneRecord скрипты читают из словаря
- ✅ название spec.harness.outside скрипты читают из словаря
- ✅ название spec.harness.outsideExample скрипты читают из словаря
- ✅ название spec.harness.registryFinds скрипты читают из словаря
- ✅ название spec.harness.registryNotEmpty скрипты читают из словаря
- ✅ название spec.harness.violator скрипты читают из словаря
- ✅ название spec.lint.allRules скрипты читают из словаря
- ✅ название spec.lint.noReason скрипты читают из словаря
- ✅ название spec.tests скрипты читают из словаря
- ✅ название status.backlog скрипты читают из словаря
- ✅ название status.done скрипты читают из словаря
- ✅ название status.inProgress скрипты читают из словаря
- ✅ название subagentPrompt.epic скрипты читают из словаря
- ✅ название subagentPrompt.task скрипты читают из словаря
- ✅ название updateCommit скрипты читают из словаря
- ✅ название updateTask скрипты читают из словаря
- ✅ название views.board скрипты читают из словаря
- ✅ название views.roadmap скрипты читают из словаря
- ✅ название views.table скрипты читают из словаря
- ✅ вне охвата: standardIssue
  > соглашение агента: issue «Standard · …» заводит он сам, скрипты название не разбирают

</details>

### Язык проекта у скриптов скиллов и у установщика — один модуль

Язык проекта — `language` в `.agents/elves.json`, без поля — `ru`, без манифеста — `en`: скрипты скиллов и
установщик берут его одним модулем `skills/github/scripts/locale.ts` — правило в одном месте.

<details><summary>✅ 2 теста</summary>

- ✅ установщик берёт язык и код языка модулем locale скилла github, своего правила у него нет
- ✅ манифест с языком — его язык, без поля — ru, битый — ru, без манифеста — en

</details>

## readme

README — витрина флоу для того, кто видит репозиторий впервые, и он не отстаёт от флоу: называет каждый скилл, каждую
команду установщика и скиллов с её подкомандами, каждый справочник `docs/`, а его ссылки и якоря ведут на существующее.

README читают первым, а правят последним: новый скилл или справочник появлялся в `skills/` и `docs/`, а README о нём
молчал (так было со `spec-break` и `parallel-checkouts.md`; пока подкоманды не сверялись — с `github task close` и
`est cloud-import`). Поэтому то, что можно перечислить из кода, README обязан назвать — иначе красный `bun test`.
Проза (мотивация, принципы, сравнение с OpenSpec) механически не проверяется, но принципы ссылаются на разделы
`AGENTS.md`: переименовал раздел — проверка ссылок покажет README, и его абзац сверяется заодно. Поменял смысл раздела,
на который ссылается принцип, — поправь и принцип.

Витрина открывается именем флоу: заголовок **Elves**, под ним слоган **Elves at work** (табличка «Men at work»), ниже —
строка, что это за флоу.

### README представляет флоу по имени

<details><summary>✅ 1 тест</summary>

- ✅ README начинается с заголовка Elves и слогана Elves at work

</details>

### README называет всё, что ставит флоу, и не ссылается на то, чего нет

<details><summary>✅ 95 тестов</summary>

- ✅ реестр «скиллы, команды установщика и скиллов, справочники docs/» не пуст
- ✅ реестр «скиллы, команды установщика и скиллов, справочники docs/» находит skills/spec, elves install, elves release, skills/spec/scripts/spec-break, skills/ci-wait/scripts/wait-ci, docs/pr-checks.md
- ✅ нарушитель не проходит: скилл, которого README не называет
- ✅ README: команда установщика check названа
- ✅ README: команда установщика install названа
- ✅ README: команда установщика pack названа
- ✅ README: команда установщика precommit названа
- ✅ README: команда установщика release названа
- ✅ README: команда установщика slot названа
- ✅ README: команда установщика spec-break названа
- ✅ README: команда установщика spec-claims названа
- ✅ README: команда установщика spec-diff названа
- ✅ README: команда установщика spec-doc названа
- ✅ README: команда установщика spec-exceptions названа
- ✅ README: команда установщика spec-publish названа
- ✅ README: команда установщика spec-run названа
- ✅ README: команда установщика spec-shard названа
- ✅ README: команда установщика task-env check названа
- ✅ README: команда установщика task-env down названа
- ✅ README: команда установщика task-env e2e названа
- ✅ README: команда установщика task-env proxy down названа
- ✅ README: команда установщика task-env proxy status названа
- ✅ README: команда установщика task-env proxy up названа
- ✅ README: команда установщика task-env prune названа
- ✅ README: команда установщика task-env up названа
- ✅ README: команда установщика update названа
- ✅ README: скилл ci-wait — со ссылкой на skills/ci-wait/SKILL.md
- ✅ README: скилл dashboard — со ссылкой на skills/dashboard/SKILL.md
- ✅ README: скилл est — со ссылкой на skills/est/SKILL.md
- ✅ README: скилл github — со ссылкой на skills/github/SKILL.md
- ✅ README: скилл slot — со ссылкой на skills/slot/SKILL.md
- ✅ README: скилл spec — со ссылкой на skills/spec/SKILL.md
- ✅ README: скилл task-env — со ссылкой на skills/task-env/SKILL.md
- ✅ README: скрипт dashboard скилла dashboard назван
- ✅ README: скрипт est скилла est назван
- ✅ README: скрипт github скилла github назван
- ✅ README: скрипт precommit скилла spec назван
- ✅ README: скрипт slot скилла slot назван
- ✅ README: скрипт spec-break скилла spec назван
- ✅ README: скрипт spec-claims скилла spec назван
- ✅ README: скрипт spec-diff скилла spec назван
- ✅ README: скрипт spec-doc скилла spec назван
- ✅ README: скрипт spec-exceptions скилла spec назван
- ✅ README: скрипт spec-publish скилла spec назван
- ✅ README: скрипт spec-run скилла spec назван
- ✅ README: скрипт spec-shard скилла spec назван
- ✅ README: скрипт task-env скилла task-env назван
- ✅ README: скрипт wait-ci скилла ci-wait назван
- ✅ README: справочник docs/ci-concurrency.md — со ссылкой
- ✅ README: справочник docs/cloud-sessions.md — со ссылкой
- ✅ README: справочник docs/judgment.md — со ссылкой
- ✅ README: справочник docs/parallel-checkouts.md — со ссылкой
- ✅ README: справочник docs/pr-checks.md — со ссылкой
- ✅ README: справочник docs/production.md — со ссылкой
- ✅ README: справочник docs/prompt-cache.md — со ссылкой
- ✅ README: справочник docs/testing.md — со ссылкой
- ✅ реестр «подкоманды скриптов скиллов» не пуст
- ✅ реестр «подкоманды скриптов скиллов» находит github task close, est cloud-import
- ✅ нарушитель не проходит: подкоманда, которой README не называет
- ✅ README: подкоманда est backtest названа
- ✅ README: подкоманда est cloud-import названа
- ✅ README: подкоманда est estimate названа
- ✅ README: подкоманда est fact названа
- ✅ README: подкоманда est history названа
- ✅ README: подкоманда est period названа
- ✅ README: подкоманда github batch release названа
- ✅ README: подкоманда github pr labels названа
- ✅ README: подкоманда github pr premerge названа
- ✅ README: подкоманда github project check названа
- ✅ README: подкоманда github project fix названа
- ✅ README: подкоманда github task actualize названа
- ✅ README: подкоманда github task answer названа
- ✅ README: подкоманда github task close названа
- ✅ README: подкоманда github task drop названа
- ✅ README: подкоманда github task edit названа
- ✅ README: подкоманда github task finish названа
- ✅ README: подкоманда github task new названа
- ✅ README: подкоманда github task queue названа
- ✅ README: подкоманда github task resume названа
- ✅ README: подкоманда github task show названа
- ✅ README: подкоманда github task start названа
- ✅ README: подкоманда github task status названа
- ✅ README: подкоманда task-env check названа
- ✅ README: подкоманда task-env down названа
- ✅ README: подкоманда task-env e2e названа
- ✅ README: подкоманда task-env proxy down названа
- ✅ README: подкоманда task-env proxy status названа
- ✅ README: подкоманда task-env proxy up названа
- ✅ README: подкоманда task-env prune названа
- ✅ README: подкоманда task-env up названа
- ✅ README: подкоманда wait-ci issue названа
- ✅ README: подкоманда wait-ci merged названа
- ✅ README: подкоманда wait-ci pr названа
- ✅ README: подкоманда wait-ci status названа
- ✅ относительные ссылки и якоря README ведут на существующие файлы и разделы

</details>

#### примеры

<details><summary>✅ 7 тестов</summary>

- ✅ ссылка на удалённый скилл — нарушение
- ✅ якорь на переименованный раздел AGENTS.md — нарушение
- ✅ якоря — как у GitHub: тире и пунктуация выпадают, пробел — дефис, повтор — с номером
- ✅ подкоманды — слова справки после имени скрипта до первого аргумента, без повторов
- ✅ подкоманда названа отдельно или в перечне через «|»; перечень без неё и слово вне кода — нарушение
- ✅ цифра в слове подкоманды — его часть: `e2e` из справки — подкоманда `e2e`, названная в перечне
- ✅ внешняя ссылка и ссылка в блоке кода — вне правила

</details>

## section-refs

Ссылка на раздел документа флоу по названию — `AGENTS.md, «First step of a session»` в выводе установщика,
`SKILL.md, «Cloud session»` в предупреждении `est`, `` `AGENTS.md`, "Task tracking" `` в справочнике — ведёт на
существующий заголовок.

Якорь-ссылку `[…](AGENTS.md#…)` в README сверяет стандарт `documents#readme`, указатели ядра на скиллы и `docs/` — `canon-size`;
ссылку текстом не сверяло ничего. Переименовал раздел — и ссылки на него в коде и документах молча ведут в никуда:
перевод заголовков на английский (#365) правил их руками в пяти скриптах, и следующий перевод правил бы снова.
Агент, которому вывод скрипта велит читать раздел, которого нет, ищет его по смыслу или идёт по памяти.

### Правило

Реестр — ссылки в документах флоу (`AGENTS.md`, `claude/CLAUDE.md`, `README.md`, `docs/*.md`, `*.md` скиллов), в
описаниях решений спеки (`tests/<вид>/<имя>/<имя>.md`) и в коде — установщике и скриптах скиллов: комментарии, JSDoc,
строки вывода. Перенос строки комментария (`*` JSDoc, `//`) ссылку не рвёт. Распознаются формы:

- `ФАЙЛ, "Раздел"`, `ФАЙЛ, section "Раздел"`, `ФАЙЛ (section "Раздел")`, кавычки `"…"` или `«…»`;
- `the "Раздел" section of ФАЙЛ` и `… section in ФАЙЛ`;
- ``the `github` skill, section "Раздел"`` — раздел `SKILL.md` этого скилла;
- в документе без файла — `section "Раздел"`, `the "Раздел" section`: раздел того же документа. Только в прямых
  кавычках: в `«…»` документы цитируют вывод скриптов и разделы сгенерированной спеки, а не свои заголовки.

Файл: `SKILL.md`, `reference.md` и прочие файлы скилла без его имени — файл того же скилла, что и ссылка
(`SKILL.md, «Cloud session»` в `est.ts` — `skills/est/SKILL.md`); с именем — `SKILL.md est`,
`reference.md of the github skill`; `README` — `README.md`, `CLAUDE.md` — `claude/CLAUDE.md`.

Инвариант — в файле есть раздел, который называется так: заголовок `#…` или жирное начало пункта списка
(`- **A decision is a topic with sections…**` — так разбит `canon.md` спеки). Название — начало заголовка до конца или
знака препинания: `"Task tracking"` находит `## Task tracking — structure`, `"Task"` — нет.

Ссылка в другой форме проверкой не видна — пиши в одной из перечисленных. Отвергнуто: разбирать любую кавычку рядом с
именем файла — это строки путей в коде (`["AGENTS.md", "claude/CLAUDE.md"]`) и цитаты вывода; и ссылаться якорем
`AGENTS.md#…` в коде — якорь меняется вместе с заголовком так же, а читать его человеку труднее.

### Ссылка на раздел документа флоу по названию ведёт на существующий заголовок

<details><summary>✅ 171 тест</summary>

- ✅ реестр «ссылки «файл + название раздела» в документах флоу и решений спеки, установщике и скриптах скиллов» не пуст
- ✅ реестр «ссылки «файл + название раздела» в документах флоу и решений спеки, установщике и скриптах скиллов» находит bin/elves.ts → AGENTS.md, «First step of a session», claude/CLAUDE.md → AGENTS.md, «First step of a session», skills/est/scripts/est.ts → skills/est/SKILL.md, «Cloud session», skills/github/scripts/github.ts → skills/github/SKILL.md, «Git, PRs and merging — mechanics», skills/github/reference.md → AGENTS.md, «Estimate and actual — the `est` skill», docs/ci-concurrency.md → AGENTS.md, «CI: parallel tasks», skills/spec/SKILL.md → skills/spec/SKILL.md, «Checks»
- ✅ нарушитель не проходит: ссылка на переименованный раздел AGENTS.md
- ✅ AGENTS.md: README.md, «Installation» — есть такой раздел
- ✅ AGENTS.md: README.md, «Repository layout» — есть такой раздел
- ✅ AGENTS.md: skills/github/SKILL.md, «Git, PRs and merging — mechanics» — есть такой раздел
- ✅ bin/elves.ts: AGENTS.md, «First step of a session» — есть такой раздел
- ✅ bin/elves.ts: AGENTS.md, «Language» — есть такой раздел
- ✅ bin/elves.ts: AGENTS.md, «What I do without asking and what needs a yes» — есть такой раздел
- ✅ bin/elves.ts: README.md, «Installation» — есть такой раздел
- ✅ bin/elves.ts: skills/spec/ci.md, «Batches» — есть такой раздел
- ✅ claude/CLAUDE.md: AGENTS.md, «First step of a session» — есть такой раздел
- ✅ claude/CLAUDE.md: docs/pr-checks.md, «Auto-fix» — есть такой раздел
- ✅ claude/CLAUDE.md: skills/task-env/SKILL.md, «Docker and the sandbox» — есть такой раздел
- ✅ docs/ci-concurrency.md: AGENTS.md, «CI: parallel tasks» — есть такой раздел
- ✅ docs/ci-concurrency.md: AGENTS.md, «Git, PRs and merging» — есть такой раздел
- ✅ docs/ci-concurrency.md: skills/spec/ci.md, «Batches» — есть такой раздел
- ✅ docs/cloud-sessions.md: AGENTS.md, «Session and branch — one task» — есть такой раздел
- ✅ docs/cloud-sessions.md: README.md, «Installation» — есть такой раздел
- ✅ docs/cloud-sessions.md: docs/cloud-sessions.md, «The brief» — есть такой раздел
- ✅ docs/cloud-sessions.md: skills/est/SKILL.md, «Cloud session» — есть такой раздел
- ✅ docs/cloud-sessions.md: skills/github/SKILL.md, «Dispatcher» — есть такой раздел
- ✅ docs/judgment.md: AGENTS.md, «Production and debugging» — есть такой раздел
- ✅ docs/judgment.md: AGENTS.md, «Tests and code» — есть такой раздел
- ✅ docs/parallel-checkouts.md: AGENTS.md, «Subagents and worktrees» — есть такой раздел
- ✅ docs/parallel-checkouts.md: docs/parallel-checkouts.md, «Shared `.git/config`» — есть такой раздел
- ✅ docs/parallel-checkouts.md: docs/testing.md, «e2e» — есть такой раздел
- ✅ docs/parallel-checkouts.md: skills/task-env/SKILL.md, «Checked on the machine» — есть такой раздел
- ✅ docs/parallel-checkouts.md: skills/task-env/SKILL.md, «Compose file isolation rules» — есть такой раздел
- ✅ docs/parallel-checkouts.md: skills/task-env/SKILL.md, «Local ports and task addresses» — есть такой раздел
- ✅ docs/parallel-checkouts.md: skills/task-env/SKILL.md, «Settings» — есть такой раздел
- ✅ docs/parallel-checkouts.md: skills/task-env/SKILL.md, «The proxy» — есть такой раздел
- ✅ docs/parallel-checkouts.md: skills/task-env/SKILL.md, «The task's stack» — есть такой раздел
- ✅ docs/pr-checks.md: AGENTS.md, «Git, PRs and merging» — есть такой раздел
- ✅ docs/pr-checks.md: skills/github/SKILL.md, «Git, PRs and merging — mechanics» — есть такой раздел
- ✅ docs/pr-checks.md: skills/github/reference.md, «batch release» — есть такой раздел
- ✅ docs/pr-checks.md: skills/github/reference.md, «task finish» — есть такой раздел
- ✅ docs/pr-checks.md: skills/spec/ci.md, «Batches» — есть такой раздел
- ✅ docs/production.md: AGENTS.md, «Production and debugging» — есть такой раздел
- ✅ docs/prompt-cache.md: docs/pr-checks.md, «Rules» — есть такой раздел
- ✅ docs/testing.md: AGENTS.md, «Specification — decisions» — есть такой раздел
- ✅ docs/testing.md: AGENTS.md, «Tests and code» — есть такой раздел
- ✅ docs/testing.md: AGENTS.md, «This file and skills» — есть такой раздел
- ✅ docs/testing.md: docs/testing.md, «Framework: three questions» — есть такой раздел
- ✅ docs/testing.md: docs/testing.md, «UI in the agent's browser» — есть такой раздел
- ✅ docs/testing.md: skills/spec/ci.md, «Batches» — есть такой раздел
- ✅ skills/ci-wait/SKILL.md: skills/spec/ci.md, «Batches» — есть такой раздел
- ✅ skills/dashboard/SKILL.md: skills/dashboard/SKILL.md, «Pitfalls» — есть такой раздел
- ✅ skills/dashboard/SKILL.md: skills/task-env/SKILL.md, «Local ports and task addresses» — есть такой раздел
- ✅ skills/dashboard/scripts/sessions.ts: AGENTS.md, «Epic refresh on task close» — есть такой раздел
- ✅ skills/est/SKILL.md: docs/cloud-sessions.md, «The brief» — есть такой раздел
- ✅ skills/est/SKILL.md: skills/est/SKILL.md, «Cloud session» — есть такой раздел
- ✅ skills/est/SKILL.md: skills/est/SKILL.md, «Period summary» — есть такой раздел
- ✅ skills/est/SKILL.md: skills/est/SKILL.md, «The estimate of a new task» — есть такой раздел
- ✅ skills/est/SKILL.md: skills/est/reference.md, «Actual — how sessions are found» — есть такой раздел
- ✅ skills/est/SKILL.md: skills/est/reference.md, «Actual — the comment» — есть такой раздел
- ✅ skills/est/SKILL.md: skills/est/reference.md, «Backtest» — есть такой раздел
- ✅ skills/est/SKILL.md: skills/est/reference.md, «Cloud session import» — есть такой раздел
- ✅ skills/est/SKILL.md: skills/est/reference.md, «Codex sessions» — есть такой раздел
- ✅ skills/est/SKILL.md: skills/est/reference.md, «Double counting and shared commits» — есть такой раздел
- ✅ skills/est/SKILL.md: skills/est/reference.md, «Estimate — the mechanics» — есть такой раздел
- ✅ skills/est/SKILL.md: skills/est/reference.md, «Linking — details» — есть такой раздел
- ✅ skills/est/SKILL.md: skills/est/reference.md, «Manual re-estimate» — есть такой раздел
- ✅ skills/est/SKILL.md: skills/est/reference.md, «Period summary» — есть такой раздел
- ✅ skills/est/SKILL.md: skills/est/reference.md, «Repository registry» — есть такой раздел
- ✅ skills/est/SKILL.md: skills/est/reference.md, «Tokens and cost» — есть такой раздел
- ✅ skills/est/SKILL.md: skills/est/reference.md, «Turn kinds and cache rewrites» — есть такой раздел
- ✅ skills/est/SKILL.md: skills/est/reference.md, «Unit and comment language» — есть такой раздел
- ✅ skills/est/SKILL.md: skills/est/reference.md, «Waits» — есть такой раздел
- ✅ skills/est/SKILL.md: skills/est/reference.md, «Writing and reruns» — есть такой раздел
- ✅ skills/est/reference.md: AGENTS.md, «Subagents and worktrees» — есть такой раздел
- ✅ skills/est/reference.md: skills/est/SKILL.md, «Cloud session» — есть такой раздел
- ✅ skills/est/reference.md: skills/est/reference.md, «Actual — the comment» — есть такой раздел
- ✅ skills/est/reference.md: skills/est/reference.md, «Turn kinds and cache rewrites» — есть такой раздел
- ✅ skills/est/reference.md: skills/est/reference.md, «Waits» — есть такой раздел
- ✅ skills/est/scripts/est.ts: skills/est/SKILL.md, «Cloud session» — есть такой раздел
- ✅ skills/est/scripts/est.ts: skills/est/reference.md, «Cloud session import» — есть такой раздел
- ✅ skills/github/SKILL.md: AGENTS.md, «Git, PRs and merging» — есть такой раздел
- ✅ skills/github/SKILL.md: AGENTS.md, «Language» — есть такой раздел
- ✅ skills/github/SKILL.md: AGENTS.md, «Session and branch — one task» — есть такой раздел
- ✅ skills/github/SKILL.md: AGENTS.md, «Task tracking» — есть такой раздел
- ✅ skills/github/SKILL.md: skills/github/reference.md, «Git, PRs and merging — full rules» — есть такой раздел
- ✅ skills/github/SKILL.md: skills/github/reference.md, «Manual commands» — есть такой раздел
- ✅ skills/github/SKILL.md: skills/github/reference.md, «Project check and fix» — есть такой раздел
- ✅ skills/github/SKILL.md: skills/github/reference.md, «Red main» — есть такой раздел
- ✅ skills/github/SKILL.md: skills/github/reference.md, «Task and PR commands» — есть такой раздел
- ✅ skills/github/SKILL.md: skills/github/reference.md, «task queue» — есть такой раздел
- ✅ skills/github/SKILL.md: skills/task-env/SKILL.md, «Checked on the machine» — есть такой раздел
- ✅ skills/github/reference.md: AGENTS.md, «Estimate and actual — the `est` skill» — есть такой раздел
- ✅ skills/github/reference.md: AGENTS.md, «Git, PRs and merging» — есть такой раздел
- ✅ skills/github/reference.md: AGENTS.md, «Language» — есть такой раздел
- ✅ skills/github/reference.md: AGENTS.md, «Session and branch — one task» — есть такой раздел
- ✅ skills/github/reference.md: AGENTS.md, «Task tracking» — есть такой раздел
- ✅ skills/github/reference.md: docs/cloud-sessions.md, «The brief» — есть такой раздел
- ✅ skills/github/reference.md: skills/github/SKILL.md, «Git, PRs and merging — mechanics» — есть такой раздел
- ✅ skills/github/reference.md: skills/github/reference.md, «Epic refresh on task close» — есть такой раздел
- ✅ skills/github/reference.md: skills/github/reference.md, «Git, PRs and merging — full rules» — есть такой раздел
- ✅ skills/github/reference.md: skills/github/reference.md, «Manual commands» — есть такой раздел
- ✅ skills/github/reference.md: skills/github/reference.md, «Milestones — sets of tasks» — есть такой раздел
- ✅ skills/github/reference.md: skills/github/reference.md, «Project (GitHub Projects)» — есть такой раздел
- ✅ skills/github/reference.md: skills/github/reference.md, «What is checked» — есть такой раздел
- ✅ skills/github/reference.md: skills/spec/ci.md, «Batches» — есть такой раздел
- ✅ skills/github/scripts/github.ts: AGENTS.md, «Open questions» — есть такой раздел
- ✅ skills/github/scripts/github.ts: AGENTS.md, «Project knowledge and handoff» — есть такой раздел
- ✅ skills/github/scripts/github.ts: AGENTS.md, «Session and branch» — есть такой раздел
- ✅ skills/github/scripts/github.ts: AGENTS.md, «Task tracking» — есть такой раздел
- ✅ skills/github/scripts/github.ts: docs/cloud-sessions.md, «The brief» — есть такой раздел
- ✅ skills/github/scripts/github.ts: skills/github/SKILL.md, «Git, PRs and merging — mechanics» — есть такой раздел
- ✅ skills/spec/SKILL.md: skills/spec/SKILL.md, «Checks» — есть такой раздел
- ✅ skills/spec/SKILL.md: skills/spec/SKILL.md, «Wiring into a repository» — есть такой раздел
- ✅ skills/spec/SKILL.md: skills/spec/SKILL.md, «spec-doc» — есть такой раздел
- ✅ skills/spec/SKILL.md: skills/spec/SKILL.md, «spec-exceptions» — есть такой раздел
- ✅ skills/spec/SKILL.md: skills/spec/ci.md, «Batches» — есть такой раздел
- ✅ skills/spec/SKILL.md: skills/spec/ci.md, «Shards by durations» — есть такой раздел
- ✅ skills/spec/SKILL.md: skills/spec/reference.md, «Limitations to know about» — есть такой раздел
- ✅ skills/spec/SKILL.md: skills/spec/reference.md, «Report formats» — есть такой раздел
- ✅ skills/spec/SKILL.md: skills/spec/reference.md, «Wiring into a repository» — есть такой раздел
- ✅ skills/spec/SKILL.md: skills/spec/reference.md, «Writing prose» — есть такой раздел
- ✅ skills/spec/SKILL.md: skills/spec/reference.md, «spec-break» — есть такой раздел
- ✅ skills/spec/SKILL.md: skills/spec/reference.md, «spec-diff output» — есть такой раздел
- ✅ skills/spec/SKILL.md: skills/spec/reference.md, «spec-doc output» — есть такой раздел
- ✅ skills/spec/SKILL.md: skills/spec/reference.md, «spec-exceptions» — есть такой раздел
- ✅ skills/spec/SKILL.md: skills/spec/reference.md, «spec-publish» — есть такой раздел
- ✅ skills/spec/SKILL.md: skills/spec/reference.md, «spec-run» — есть такой раздел
- ✅ skills/spec/canon.md: AGENTS.md, «Epic refresh on task close» — есть такой раздел
- ✅ skills/spec/canon.md: AGENTS.md, «Task tracking» — есть такой раздел
- ✅ skills/spec/canon.md: AGENTS.md, «Tests and code» — есть такой раздел
- ✅ skills/spec/checks.md: skills/spec/SKILL.md, «Checks» — есть такой раздел
- ✅ skills/spec/checks.md: skills/spec/SKILL.md, «Wiring into a repository» — есть такой раздел
- ✅ skills/spec/ci.md: docs/testing.md, «Run and result» — есть такой раздел
- ✅ skills/spec/ci.md: skills/spec/SKILL.md, «Wiring into a repository» — есть такой раздел
- ✅ skills/spec/ci.md: skills/spec/ci.md, «Shards by durations» — есть такой раздел
- ✅ skills/spec/migration.md: skills/spec/SKILL.md, «Wiring into a repository» — есть такой раздел
- ✅ skills/spec/reference.md: skills/spec/SKILL.md, «Reports for spec-doc» — есть такой раздел
- ✅ skills/spec/reference.md: skills/spec/canon.md, «A decision is a topic with sections; the topic folder is its home» — есть такой раздел
- ✅ skills/spec/reference.md: skills/spec/ci.md, «A project on bun test» — есть такой раздел
- ✅ skills/spec/reference.md: skills/spec/ci.md, «Shards by durations» — есть такой раздел
- ✅ skills/spec/reference.md: skills/spec/reference.md, «Report formats» — есть такой раздел
- ✅ skills/spec/reference.md: skills/spec/reference.md, «Wiring into the project's CI» — есть такой раздел
- ✅ skills/spec/reference.md: skills/spec/reference.md, «spec-diff: static parsing, not two reports» — есть такой раздел
- ✅ skills/spec/reference.md: skills/spec/reference.md, «spec-doc output» — есть такой раздел
- ✅ skills/spec/reference.md: skills/spec/reference.md, «spec-shard — CI shards by durations» — есть такой раздел
- ✅ skills/spec/scripts/precommit.ts: AGENTS.md, «Git, PRs and merging» — есть такой раздел
- ✅ skills/spec/scripts/precommit.ts: docs/testing.md, «Run and result» — есть такой раздел
- ✅ skills/task-env/SKILL.md: skills/dashboard/SKILL.md, «Pitfalls» — есть такой раздел
- ✅ skills/task-env/SKILL.md: skills/task-env/SKILL.md, «Checked on the machine» — есть такой раздел
- ✅ skills/task-env/SKILL.md: skills/task-env/SKILL.md, «Docker and the sandbox» — есть такой раздел
- ✅ skills/task-env/SKILL.md: skills/task-env/SKILL.md, «Local ports and task addresses» — есть такой раздел
- ✅ skills/task-env/SKILL.md: skills/task-env/reference.md, «A stack that didn't come up» — есть такой раздел
- ✅ skills/task-env/SKILL.md: skills/task-env/reference.md, «Checked on the machine» — есть такой раздел
- ✅ skills/task-env/SKILL.md: skills/task-env/reference.md, «Exit codes» — есть такой раздел
- ✅ skills/task-env/SKILL.md: skills/task-env/reference.md, «Labels of a task stack's service» — есть такой раздел
- ✅ skills/task-env/SKILL.md: skills/task-env/reference.md, «Override and compose files» — есть такой раздел
- ✅ skills/task-env/SKILL.md: skills/task-env/reference.md, «Stacks of closed tasks» — есть такой раздел
- ✅ skills/task-env/SKILL.md: skills/task-env/reference.md, «Taking a task's stacks down» — есть такой раздел
- ✅ skills/task-env/SKILL.md: skills/task-env/reference.md, «The proxy before the rename» — есть такой раздел
- ✅ skills/task-env/SKILL.md: skills/task-env/reference.md, «The proxy» — есть такой раздел
- ✅ skills/task-env/SKILL.md: skills/task-env/reference.md, «What the compose file check reads» — есть такой раздел
- ✅ skills/task-env/reference.md: skills/task-env/SKILL.md, «Docker and the sandbox» — есть такой раздел
- ✅ skills/task-env/reference.md: skills/task-env/SKILL.md, «Local ports and task addresses» — есть такой раздел
- ✅ skills/task-env/reference.md: skills/task-env/reference.md, «Labels of a task stack's service» — есть такой раздел
- ✅ skills/task-env/scripts/task-env.ts: skills/task-env/SKILL.md, «Docker and the sandbox» — есть такой раздел
- ✅ skills/task-env/scripts/task-env.ts: skills/task-env/SKILL.md, «Network subnets» — есть такой раздел
- ✅ tests/capabilities/elves/update.md: skills/spec/ci.md, «Batches» — есть такой раздел
- ✅ tests/capabilities/est/estimate-and-actual.md: docs/cloud-sessions.md, «The brief» — есть такой раздел
- ✅ tests/capabilities/github/github-task.md: skills/spec/ci.md, «Batches» — есть такой раздел
- ✅ tests/capabilities/spec/precommit.md: docs/testing.md, «Run and result» — есть такой раздел
- ✅ tests/capabilities/task-env/stacks.md: skills/task-env/SKILL.md, «Network subnets» — есть такой раздел
- ✅ tests/standards/documents/canon-size.md: AGENTS.md, «This file and skills» — есть такой раздел
- ✅ tests/standards/scripts/skill-imports.md: AGENTS.md, «Language» — есть такой раздел
- ✅ tests/standards/scripts/task-branch.md: AGENTS.md, «Session and branch» — есть такой раздел

</details>

#### примеры

<details><summary>✅ 9 тестов</summary>

- ✅ ссылка скрипта на раздел AGENTS.md по названию ведёт на существующий заголовок
- ✅ ссылка на переименованный раздел роняет проверку
- ✅ ссылка на SKILL.md без имени скилла ищет раздел в SKILL.md того же скилла
- ✅ формы ссылки: файл и раздел через запятую, «section» в скобках, раздел перед файлом; перенос строки комментария — не помеха
- ✅ раздел того же документа — `section "…"` в документе; в коде и в «…» — не ссылка
- ✅ пример формы в `…` документа — не ссылка; имя файла в `…` перед названием — ссылка
- ✅ строки путей в коде и заголовок в блоке кода — не ссылка и не раздел
- ✅ заголовок — название, за ним конец или знак препинания: «Task» не находит `## Task tracking`
- ✅ раздел — и жирное начало пункта списка; ссылка на скилл по имени ведёт в его SKILL.md

</details>
