import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.mjs';

export function initialState() {
  return { schemaVersion: 1, mode: 'demo', versions: [], evaluations: [], ledger: [], audit: [], liveClips: [],
    liveHoldout: null, reingestJobs: [], counters: { version: 0, evaluation: 0, ledger: 0, audit: 0 } };
}
function validState(value) {
  const record = item => item !== null && typeof item === 'object' && !Array.isArray(item);
  if (!record(value) || value.schemaVersion !== 1 || !['demo', 'live'].includes(value.mode)) return false;
  for (const key of ['versions', 'evaluations', 'ledger', 'audit', 'liveClips', 'reingestJobs']) {
    if (!Array.isArray(value[key]) || !value[key].every(record)) return false;
  }
  if (!record(value.counters) || !['version', 'evaluation', 'ledger', 'audit'].every(key => Number.isSafeInteger(value.counters[key]) && value.counters[key] >= 0)) return false;
  if (value.liveHoldout !== null && (!record(value.liveHoldout) || !Array.isArray(value.liveHoldout.clips) ||
    !value.liveHoldout.clips.every(record) || !Array.isArray(value.liveHoldout.parentVideoIds) ||
    !value.liveHoldout.parentVideoIds.every(id => typeof id === 'string') || typeof value.liveHoldout.digest !== 'string')) return false;
  for (const key of ['versions', 'evaluations', 'ledger', 'audit', 'liveClips']) {
    const ids = value[key].map(item => item.id);
    if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) return false;
  }
  return true;
}
export class Store {
  constructor(file) { this.file = file; this.data = initialState(); this.queue = Promise.resolve(); }
  async load() {
    if (!this.file) return this;
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8'));
      if (!validState(value)) throw new Error('schema');
      this.data = value;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new AppError(500, 'STORE_UNREADABLE', 'Local state is unreadable. Restore a valid state file or move it aside before restarting.');
    }
    return this;
  }
  transaction(action) {
    const next = this.queue.then(async () => {
      const draft = structuredClone(this.data);
      const result = await action(draft);
      if (this.file) {
        await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
        const tmp = `${this.file}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify(draft, null, 2), { mode: 0o600 });
        await rename(tmp, this.file);
      }
      this.data = draft;
      return result;
    });
    this.queue = next.catch(() => {});
    return next;
  }
}
export function addAudit(state, action, details, source = 'local') {
  const item = { id: `audit-${++state.counters.audit}`, action, source, timestamp: new Date().toISOString(), ...details };
  state.audit.push(item);
  if (state.audit.length > 500) state.audit.shift();
  return item;
}
