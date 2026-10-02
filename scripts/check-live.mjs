#!/usr/bin/env node
/** Read-only provider readiness probe. Never prints credentials or provider URLs.
 * Run in the authorized environment with existing exported variables.
 * Connectivity is not inference verification or release approval.
 */
import { Integrations } from '../server/lib/integrations.mjs';
const clients = new Integrations();
const configured=clients.readiness();
if(!configured.some(s=>s.configured)){
 console.log('LIVE UNVERIFIED: no provider configuration is available. No external calls made.');
 for(const r of configured)console.log(`${r.name}: ${r.status} — ${r.detail}`);
 process.exitCode=1;
}else{
 const readiness=await clients.check();
 for(const r of readiness)console.log(`${r.name}: ${r.status} — ${r.detail}`);
 const ready=readiness.every(r=>r.status==='ready');
 console.log(ready?'Connectivity checks passed. Actual video inference, rule generation, human-labeled evaluation, and live recording are still required.':'LIVE BLOCKED: resolve the unavailable provider before starting a live experiment.');
 if(!ready)process.exitCode=1;
}
