import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
test('source tree contains no active GitHub Actions workflow files',async()=>{
 let files=[];
 try{files=await readdir(new URL('../.github/workflows/',import.meta.url))}
 catch(error){if(error.code!=='ENOENT')throw error}
 assert.deepEqual(files.filter(name=>/\.ya?ml$/i.test(name)),[], 'GitHub Actions is not authorized for this project; keep executable workflows outside the source tree.');
});
