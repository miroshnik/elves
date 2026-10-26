# Claude Code prompt cache TTL

The API caches the start of each request (the prefix) and bills its re-read at
a tenth of the input price; a cache entry lives for its TTL after the last
request that read it. A request after a longer pause finds no cache and writes
the whole context again. In the flow pauses are routine — a CI wait of up to 9
minutes, a long test run, the human thinking over an answer — so the TTL
decides what a wait costs. Claude Code's reference: [prompt caching, "Cache
lifetime"](https://code.claude.com/docs/en/prompt-caching#cache-lifetime).

## Defaults

Claude Code picks the TTL per request, by bucket:

| Bucket | Subscription, within plan usage | Usage credits, API key, cloud provider |
| - | - | - |
| Main conversation | 1 hour | 5 minutes |
| Everything else: subagents, workflows, compaction | 5 minutes | 5 minutes |

So an executor subagent waiting for CI loses its cache on every wait longer than
5 minutes, and once a subscription goes over its plan's usage onto usage credits
the main session does too. Measured over two weeks in five projects: 568 such
turns, $842, $384 of it executor subagents after a CI wait (#665).

## Controls

| Bucket | Setting in `~/.claude/settings.json` | Variable |
| - | - | - |
| Main conversation | `promptCacheTtl` | `CLAUDE_CODE_PROMPT_CACHE_TTL` |
| Everything else | `subagentPromptCacheTtl` | `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` |

Values — `5m` or `1h`, Claude Code ignores any other; Claude Code 2.1.242 or
later. A variable wins over its setting; `ENABLE_PROMPT_CACHING_1H=1` asks for
the hour in both buckets below them, `FORCE_PROMPT_CACHING_5M=1` forces 5
minutes over everything. A variable can also sit in the `env` block of the
settings file.

## Price and when the hour pays off

A cache write costs 1.25× the input price with 5 minutes and 2× with the hour; a
read — 0.1× with either. A pause longer than 5 minutes (and shorter than an
hour) with the hour saves rewriting the context C: 1.25·C − 0.1·C = 1.15·C. The
hour costs 0.75× extra on every token written. It pays off when between such
pauses the session writes less than about 1.5 of its context — an agent's turn
adds a few thousand tokens to a context of 50–150 thousand, so one CI wait in
dozens of turns already covers it. It doesn't pay off in short bursts of work
that never pause past 5 minutes.

## What the flow does

The choice and its price are the owner's: the flow checks and recommends,
`~/.claude/settings.json` is changed only by a command the owner runs.

- `check -g` and the `SessionStart` hook name a bucket with no TTL chosen —
  setting or variable — in a `prompt cache TTL:` line with the command that sets
  the hour; `install -g` and `update -g` print the same line. An explicit `5m`
  is a choice too: no line. `claude` on PATH older than 2.1.242 — no line.
- The command (Bun, one line): sets the hour only for the keys that have no
  accepted value, copies the file first to `settings.json.bak` (taken —
  `.bak2`, `.bak3`…), keeps the other keys, prints what it set; a repeat
  changes nothing. The agent names it to the user and doesn't run it itself.
- To keep 5 minutes and silence the line — `"5m"` in the same keys.

## How to check

- `claude -p "hello" --output-format json` — `usage.cache_creation` of the
  result: `ephemeral_1h_input_tokens` is written for the hour,
  `ephemeral_5m_input_tokens` — for 5 minutes.
- A transcript: each assistant record of
  `~/.claude/projects/<path-with-dashes>/<session>.jsonl` (a subagent's —
  `<session>/subagents/agent-*.jsonl`) has the same fields in
  `message.usage.cache_creation`. A turn after a pause with a large
  `cache_creation_input_tokens` and a small `cache_read_input_tokens` — the
  cache expired.
- `/usage` in a session: the `Prompt cache (main)` line — hit ratio and
  whether the cache is warm.

Waits in a subagent — `docs/pr-checks.md`, "Rules".
