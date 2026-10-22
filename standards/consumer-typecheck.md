<!-- spec-doc: сгенерировано из названий тестов, руками не править -->
# consumer-typecheck

Модули из `exports` пакета `@miroshnik/elves` проходят тайпчек проекта-потребителя с самыми строгими опциями
TypeScript: проект, который их импортирует, не получает ошибок в чужом файле, какие бы проверки он ни включил.

Условие `types` в `exports` ведёт тайпчекер проекта к исходнику `.ts` (стандарт `harness-load`), а исходник из
`node_modules` TypeScript проверяет с опциями проекта: `skipLibCheck` пропускает только `.d.ts`. Тайпчек Elves идёт со
своим `tsconfig.json` и строгих опций вроде `exactOptionalPropertyTypes` не видит, так что поломку замечал только
проект: тест стандарта, импортирующий `harness`, давал 7 ошибок в `harness.ts` и `architecture.ts` (#647). Обход у
проекта — отдельный проект тайпчека для `tests/` с ослабленной опцией — ослабляет проверку его собственного кода.

## Правило

- Модули из `exports` и всё, что они импортируют, проходят тайпчек с опциями, которые TypeScript держит выключенными:
  `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`,
  `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`,
  `noUncheckedSideEffectImports`, `allowUnreachableCode: false`, `allowUnusedLabels: false` — поверх `strict`.
- Необязательное поле, куда код передаёт значение, которого может не быть, объявлено с `| undefined`: обёртка передаёт
  своё необязательное `exceptions` в `invariant` как есть, и проект делает так же.
- Поле индексной сигнатуры (`process.env`, разобранный JSON, атрибуты XML) читается в скобках: `env["HOME"]`. Поля узла
  Babel, которые читает `speclib.ts`, объявлены в его типе.

## Проверка

Настоящий тайпчек проекта: пакет ставится `bun install` из tarball `npm pack`, как из реестра; `tsconfig.json` — как у
`bun init`, со всеми опциями правила; файл проекта импортирует каждый модуль из `exports` пакета — новый экспорт
попадает в проверку сам. `bun check` проекта — без ошибок.

Отвергнуто: включить эти опции в `tsconfig.json` Elves — они легли бы на все скрипты и тесты, а с проектом пакет делит
только `exports`; `bun check` с флагами по файлам Elves — не тот путь, что у проекта: разрешение через `exports` и
`node_modules` он не проходит.

## Пакет @miroshnik/elves в тайпчеке проекта

<details><summary>✅ 1 тест</summary>

- ✅ модули из exports пакета проходят тайпчек проекта-потребителя со строгими опциями
  > Условие `types` в `exports` ведёт тайпчекер к исходнику `.ts`, а исходник из `node_modules` TypeScript проверяет с
  > опциями проекта: `skipLibCheck` пропускает только `.d.ts`. Модуль, что не проходит строгую опцию, красит тайпчек
  > проекта, который её включил, ошибками в чужом файле (#647).

</details>
