import { writeFile } from 'node:fs/promises';
import { fixtures, baselineRule, holdoutDigest, DEMO_WARNING } from '../server/lib/fixtures.mjs';
await writeFile(new URL('../public/fixture-data.json',import.meta.url),JSON.stringify({schemaVersion:1,clips:fixtures,baselineRule:baselineRule(),holdoutDigest:holdoutDigest(fixtures),warning:DEMO_WARNING},null,2)+'\n');
console.log('Synchronized public demo definitions with canonical server fixtures.');
