# Production: the read-only database, numbers, "didn't help" — for "Production and debugging"

A reference for the "Production and debugging" section of `AGENTS.md`: the
details and the reasons behind its rules.

- **Data and schema change via a migration in a PR**, rolled out by the
  regular deploy, not by hand.
- **Production numbers — first, is it the right database.** The first query
  checks it against the repository: the number of applied migrations, the
  columns of the latest migrations, the orders of magnitude of the tables. No
  match — stop and don't report the numbers: wrong numbers breed wrong
  decisions and wrong tasks.
- **"Didn't help" → production facts, not a third reproduction:** a local
  reproduction proves only that my environment is fine; the logs of the real
  request and the production data say what happened there.
