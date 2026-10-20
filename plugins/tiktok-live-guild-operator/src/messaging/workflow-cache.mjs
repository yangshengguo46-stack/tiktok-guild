import { GuildError } from '../errors.mjs';
export function createWorkflowCache({ workflows = new Map(), maxWorkflows = 256, workflowTtlMs = 30 * 60_000 } = {}) {
  if (!Number.isSafeInteger(maxWorkflows) || maxWorkflows <= 0 || !Number.isFinite(workflowTtlMs) || workflowTtlMs <= 0) throw new TypeError('Workflow bounds must be positive.');
  const timestamps = new Map();
  const prune = () => {
    const now = Date.now();
    for (const [key, at] of timestamps) if (now - at >= workflowTtlMs) { workflows.delete(key); timestamps.delete(key); }
  };
  return {
    set(key, value) {
      prune();
      if (!workflows.has(key) && workflows.size >= maxWorkflows) throw new GuildError('workflow_capacity', 'The workflow limit is reached; complete existing workflows or wait for expiry.');
      workflows.set(key, value); timestamps.set(key, Date.now());
    },
    get(key) { prune(); return workflows.get(key); },
    delete(key) { workflows.delete(key); timestamps.delete(key); }
  };
}
