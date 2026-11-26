// Preload прогона (bunfig.toml): воркер `bun test --parallel` ставит JEST_WORKER_ID, и дочерний `playwright test`
// принимает прогон за Jest и не идёт — причина в parallel-workers.md. Дочерние процессы наследуют окружение прогона.
delete process.env.JEST_WORKER_ID;
