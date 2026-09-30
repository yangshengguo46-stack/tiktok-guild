import { createInterface } from 'node:readline';

export function serveExecutionWorker(executor) {
  const abort = new AbortController();
  let active = Promise.resolve();
  const input = createInterface({ input: process.stdin });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    abort.abort(); input.close(); void executor.close().finally(() => process.exit(0));
  });
  input.on('line', (line) => {
    active = active.then(async () => {
      let id;
      try {
        const request = JSON.parse(line); id = request.id;
        const result = request.operation === 'prepare_web'
          ? await executor.prepareWeb(request)
          : request.operation === 'release_web'
            ? await executor.releaseWeb(request)
            : await executor.execute({ ...request, signal: abort.signal });
        process.stdout.write(`${JSON.stringify({ id, result })}\n`);
      } catch { process.stdout.write(`${JSON.stringify({ id, result: { verified: false, error_code: 'operator_error' } })}\n`); }
    });
  });
  input.on('close', () => { void active.finally(() => executor.close()); });
}
