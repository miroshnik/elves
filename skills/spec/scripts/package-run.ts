/**
 * The package's script as a command — one form for package.json, CI, the harness's hints and the help of
 * `elves <script>`: `bun` reads the bin itself, past its shebang, and without the flag would load the project's env
 * files into it — the script would pass their keys on to `gh`, `git` and the checked command
 * (tests/standards/scripts/no-env-file, #596); a step of GitHub Actions doesn't see `node_modules/.bin`, and `bunx elves`
 * without the package in node_modules would fetch someone else's `elves` from npm (#558, question 2). The installer
 * imports it, and so does the harness — a module of the package built for Node: constants without imports, the
 * installer's start doesn't load the harness's parser.
 */
export const PACKAGE_RUN = "bun --no-env-file node_modules/.bin/elves";

/**
 * The package of the project's version through bunx — where `node_modules/.bin/elves` isn't there: a CI job without
 * the project's dependencies (#597); bunx runs the bin by its shebang, under Bun without env files (#592). Needs `jq`
 * (`PACKAGE_TOOLS`). The first run fetches the package of that version into Bun's cache. The installer knows it in a
 * wrapper of a previous install too — the slot of a project on Yarn 2+ (#608, until #910).
 */
export const PACKAGE_BUNX = `bunx @miroshnik/elves@"$(jq -r '.devDependencies["@miroshnik/elves"]' package.json)"`;

/**
 * The utilities `PACKAGE_BUNX` and the skill's CI steps call besides bunx — of the machine and the GitHub runner, not
 * a project's package: the harness's `deadCode` doesn't count them as unlisted binaries. knip names `jq` so in
 * package.json scripts and, since 6.48, inside `$(…)` of workflow steps — its own list of global binaries has `curl`
 * and `gh`, but not `jq` (#903).
 */
export const PACKAGE_TOOLS: readonly string[] = ["jq"];
