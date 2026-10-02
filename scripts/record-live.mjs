/** Read-only recording of an ALREADY COMPLETED genuine live run.
 * No reset, generate, evaluate, publish, replay, label, or other POST is allowed.
 * Existing provider receipts are shown as recorded evidence, never fresh calls.
 * npm install --no-save --package-lock=false playwright ; npx playwright install chromium
 * LIVE_BASE_URL=http://127.0.0.1:3000 node scripts/record-live.mjs
 */
import {chromium} from 'playwright';
import {mkdir,writeFile,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {verifyLiveRun} from './lib/verify-live-run.mjs';
const baseURL=process.env.LIVE_BASE_URL||'http://127.0.0.1:3000';
if(!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(baseURL))throw new Error('Use the authorized live server on loopback. This recorder does not expose a credentialed service or configure authentication.');
const response=await fetch(`${baseURL}/api/state`);if(!response.ok)throw new Error('Live server is unavailable.');
const state=await response.json();const proof=verifyLiveRun(state,{versionId:process.env.LIVE_VERSION_ID});
const out=path.resolve(process.env.LIVE_RECORD_DIR||'artifacts/live');await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
const context=await browser.newContext({viewport:{width:1440,height:1080},deviceScaleFactor:1,recordVideo:{dir:out,size:{width:1440,height:1080}},reducedMotion:'reduce'});
await context.route('**/api/**',route=>route.request().method()==='GET'?route.continue():route.abort('blockedbyclient'));
const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));const captions=[];const started=Date.now();let sequence=0;
const elapsed=()=>(Date.now()-started)/1000;
async function scene(text,seconds=9,name='scene'){const start=elapsed();await page.screenshot({path:path.join(out,`${String(++sequence).padStart(2,'0')}-${name}.png`),fullPage:false});await page.waitForTimeout(seconds*1000);captions.push({start,end:elapsed(),text})}
async function showClip(id){await page.locator(`[data-action="clip"][data-id="${id}"]`).click();await page.locator('#evidence-video').evaluate(v=>v.play());await page.waitForFunction(()=>document.querySelector('#evidence-video')?.currentTime>.3)}
try{
 await page.goto(baseURL,{waitUntil:'domcontentloaded'});await page.getByRole('heading',{name:'Teach your cameras what matters.'}).waitFor();
 await page.locator('[data-action="mode-live"]').click();await page.locator('.modal-close').click();
 await page.getByRole('button',{name:'Rule versions',exact:true}).click();await page.locator(`[data-action="select-version"][data-id="${proof.version.id}"]`).click();
 await scene(`ShowOnce — a recorded genuine live experiment.\nThis film inspects completed provider results; it does not imply fresh inference.`,10,'live-overview');
 await showClip(proof.train.find(c=>c.label).id);await scene('Real VAST corpus footage: the human-reviewed positive TRAIN example.\nThe event definition is based on visible evidence.',10,'positive');
 await showClip(proof.train.find(c=>!c.label).id);await scene('The hard-negative TRAIN example establishes the boundary.\nIts label was explicitly reviewed, separately from model predictions.',10,'negative');
 await page.locator('.rule-body').scrollIntoViewIfNeeded();await scene(`W&B generated this explicit version from TRAIN observations.\nModel: ${proof.summary.wandbModel}`,12,'rule');
 await page.locator('.scoreboard').scrollIntoViewIfNeeded();await scene(`${proof.summary.holdoutCount} human-reviewed HOLDOUT clips, separated by parent video.\n${proof.summary.holdoutPreviouslyEvaluated?'This reused set is a regression comparison, not unseen validation.':'This is a tiny illustrative evaluation, not production accuracy.'}`,12,'evaluation');
 await showClip(proof.held[0].id);await scene('Inspect the real holdout footage and stored Cosmos decision.\nExpected human labels were not sent in the prediction prompt.',10,'holdout-evidence');
 await page.locator('#ledger').scrollIntoViewIfNeeded();await scene('The published rule produced an evidence-linked live replay record.\nThe ledger preserves its exact version and decision.',10,'ledger');
 await page.locator(`[data-action="evidence"][data-id="${proof.events.find(e=>e.decision==='detected').id}"]`).click();await page.locator('.evidence-detail video').evaluate(v=>v.play());await scene('Actual replay footage and its original evidence interval.\nThe result retains the published rule snapshot.',12,'replay-video');
 await page.locator('.provider-receipt').scrollIntoViewIfNeeded();await scene('Provider receipt: model, response ID when returned, timestamp, and video hash.\nThese are application receipts, not cryptographic provider attestations.',12,'receipt');
 await page.getByRole('button',{name:'Back to studio',exact:true}).click();await page.getByRole('button',{name:'Activity log',exact:true}).click();await scene('The audit trail preserves genuine retrieval, rule generation, and evaluation.\nNo synthetic fixture result is used in this recording.',10,'audit');
 await page.getByRole('button',{name:'Done',exact:true}).click();await page.getByRole('button',{name:'Provider connections',exact:true}).click();await scene('VAST supplies indexed evidence. Cosmos observes video. W&B generates the rule.\nCredentials stay on the server; no operational alert was dispatched.',9,'providers');
 await page.getByRole('button',{name:'Done',exact:true}).click();await page.locator('#workspace').scrollIntoViewIfNeeded();await scene('Teach the event. Test its boundary. Keep the proof.\nA real small-scale experiment, with explicit limits.',8,'closing');
 if(errors.length)throw new Error(`Browser errors: ${errors.join('; ')}`);
 await writeFile(path.join(out,'live-recording-report.json'),JSON.stringify({recordedAt:new Date().toISOString(),captureType:'inspection-of-completed-live-run',newInferenceDuringCapture:false,...proof.summary,durationSeconds:elapsed(),javascriptErrors:errors,disclaimer:'Application receipts were validated for internal consistency. Recording makes no claim of independent cryptographic attestation or production accuracy.'},null,2));
 await writeFile(path.join(out,'live-evidence.json'),JSON.stringify({versions:[proof.version],evaluations:[proof.evaluation],ledger:proof.events,audit:state.audit,warning:'Contains real corpus context. Inspect for privacy before external sharing.'},null,2));
}catch(error){await page.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});throw error}
finally{
 const video=page.video();await context.close();await copyFile(await video.path(),path.join(out,'showonce-live.webm'));
 const stamp=s=>{const ms=Math.round(s*1000);return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`};
 await writeFile(path.join(out,'live-captions.srt'),captions.map((s,i)=>`${i+1}\n${stamp(s.start)} --> ${stamp(s.end)}\n${s.text}\n`).join('\n'));
 await browser.close();
}
