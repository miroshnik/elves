Примеры и конфиги в документах флоу — для одного стека: тесты проекта идут на `bun test`, e2e — на Playwright (эпик
#906). Ветки Vitest и Jest ушли из скриптов (#908): `spec-doc` и `spec-shard` не читают их отчёты, `spec-red` и
`precommit` их не запускают, `check` не предлагает их команды. Пример `import … from "vitest"`, строка
`maxWorkers` или флаг `--changedSince` в справочнике отправил бы агента настраивать раннер, которого флоу не держит, — и
агент повторял бы его в проекте.

Поэтому в документах флоу — каноне, `docs/`, `SKILL.md` и справочниках скиллов, README — нет импорта модулей Vitest и
Jest, их команд (`vitest run`, `vitest list`), конфигов (`vitest.config`, `jest.config`, `ts-jest`) и их флагов
(`maxWorkers`, `--changedSince`, `--passWithNoTests`, `--testPathIgnorePatterns`). Название раннера в прозе — не пример:
«отчёт Vitest или Jest — неизвестный формат» говорит, что раннера нет, и остаётся.

Так же с менеджером пакетов: он у проекта — Bun, ветки npm, pnpm и Yarn (с Yarn 2+) ушли из установщика и скриптов
(#910): `premerge` ставит зависимости `bun install` и зовёт скрипты `bun run`, обёртка slot — одна, шим. Поэтому в тех
же документах нет команд npm, pnpm и Yarn (`npm run`, `npm ci`, `npx …`, `pnpm …`, `yarn …`) и их конфигов
(`pnpm-workspace.yaml`, `pnpm/action-setup`, `.yarnrc.yml`, `cache: pnpm`): команды проекта — `bun run`, `bunx`,
`bun install`. npm как реестр, откуда ставится `@miroshnik/elves` (`npm publish`, «из npm»), и название менеджера в
прозе («проект на npm, pnpm или Yarn — не на Bun») остаются.

Отвергнуто: запретить само слово — проза, которая объясняет отказ, тоже стала бы нарушением; проверять только
`skills/spec` — та же строка в `docs/testing.md` или `skills/slot/SKILL.md` доходит до агента так же.
