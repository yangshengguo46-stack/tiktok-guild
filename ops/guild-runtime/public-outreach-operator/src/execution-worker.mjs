import { readFile } from 'node:fs/promises';
import { createProductionExecutor } from './production-executor.mjs';
import { serveExecutionWorker } from './worker-protocol.mjs';
const config = JSON.parse(await readFile(process.env.DEERFLOW_OUTREACH_EXECUTION_CONFIG, 'utf8'));
serveExecutionWorker(createProductionExecutor({ runtimeRoot: process.env.DEERFLOW_OUTREACH_RUNTIME_ROOT, config }));
