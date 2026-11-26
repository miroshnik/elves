---
paths:
  - "**/package.json"
---

# Bun's built-in tools instead of packages

A rule Claude Code loads with `package.json` files. A project of the flow is
on Bun — the canon's stack: Claude Code, Bun, GitHub — and uses what Bun has
built in: databases, object storage, Redis, `.env` and the rest, not the
packages they replace. A package is one more dependency to update, audit and
keep compatible; Bun's own tool comes with the runtime.

- **Before adding a dependency — the table.** A package of its first column
  goes into no `package.json` of the project: the second column is what to
  use, the third — Bun's page on it.
- **`elves check` holds it by this table.** A package of the table in any
  dependency section of any `package.json` of the project — a `❌` line with
  the package, its replacement and the page. Moving the code to the built-in
  is a task of its own in the project, not an edit in the session that saw
  the line.
- **Next.js — the exception, for now.** Its server runs under Node, where
  Bun's built-ins don't exist: a `package.json` with `next` in its
  dependencies keeps these packages, and `check` names them in `○` lines,
  without `❌`. Moving such an app to Bun's fullstack server is the next
  step, not yet the rule.
- **Playwright — its runner under Bun.** Bun has no browser runner, so
  e2e is Playwright, but `bun --bun playwright test` runs the runner, its
  config, fixtures and factories (`tests/lib`) under Bun, with the
  built-ins of the table: a package with `@playwright/test` is no
  exception, Next.js is the only one. Without `--bun` the bin goes under
  Node by its shebang. The package of the specs is `"type": "module"`:
  Playwright under Bun registers no loader of its own and loads a
  CommonJS package's `.ts` specs as JavaScript — type syntax fails with
  «N errors building …»; an ES module Bun loads itself, stripping the
  types. Under Bun `--only-changed` doesn't follow a spec's imports —
  `docs/testing.md`, "Run and result". `elves check` holds both: a
  package with `@playwright/test` without `"type": "module"` and its
  script with `playwright test` not under `bun --bun` — `❌` lines with
  the step.

| Package | Bun's built-in | Bun docs |
|---|---|---|
| `pg`, `postgres`, `mysql2`, `mariadb` | `Bun.sql` | [SQL](https://bun.com/docs/runtime/sql) |
| `better-sqlite3` | `bun:sqlite` | [SQLite](https://bun.com/docs/runtime/sqlite) |
| `@aws-sdk/client-s3` | `Bun.s3` | [S3](https://bun.com/docs/runtime/s3) |
| `ioredis`, `redis` | `Bun.redis` | [Redis](https://bun.com/docs/runtime/redis) |
| `dotenv`, `dotenv-expand` | reading `.env` files | [Environment variables](https://bun.com/docs/runtime/environment-variables) |
| `bcrypt`, `bcryptjs`, `argon2` | `Bun.password` | [Hashing](https://bun.com/docs/runtime/hashing) |
| `node-fetch` | `fetch` | [Fetch](https://bun.com/docs/runtime/networking/fetch) |
| `glob`, `fast-glob` | `Bun.Glob` | [Glob](https://bun.com/docs/runtime/glob) |
| `rimraf`, `cross-env` | Bun Shell, `Bun.$` | [Shell](https://bun.com/docs/runtime/shell) |
| `ts-node`, `tsx` | running `.ts` files | [TypeScript](https://bun.com/docs/typescript) |
| `nodemon` | `bun --watch` | [Watch mode](https://bun.com/docs/runtime/watch-mode) |
