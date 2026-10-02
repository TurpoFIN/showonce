import { createHash } from 'node:crypto';

export const DEMO_WARNING = 'Deterministic synthetic fixtures. No live video model was run. Scores are fixture agreement, not measured model accuracy.';
export const LIVE_WARNING = 'Small, human-labeled frozen holdout. Repeated evaluation is exploratory, not an independent production-accuracy estimate.';
export const FIXTURE_SOURCE = 'synthetic-fixture';
const rows = [
  ['train-positive-01', 'TRAIN', true, 'Stopped in the travel lane', 'positive', 'travel_lane', 0, 9],
  ['train-negative-01', 'TRAIN', false, 'Stopped on the shoulder', 'shoulder', 'shoulder', 0, 9],
  ['train-negative-02', 'TRAIN', false, 'Slow traffic is still moving', 'slow_traffic', 'travel_lane', 1.3, 12],
  ['holdout-01', 'HOLDOUT', true, 'Travel-lane stop', 'positive', 'travel_lane', 0, 9],
  ['holdout-02', 'HOLDOUT', false, 'Shoulder stop', 'shoulder', 'shoulder', 0, 9],
  ['holdout-03', 'HOLDOUT', false, 'Crawling queue', 'slow_traffic', 'travel_lane', 1.3, 12],
  ['holdout-04', 'HOLDOUT', true, 'Second travel-lane stop', 'positive', 'travel_lane', 0, 8.5],
  ['holdout-05', 'HOLDOUT', false, 'Brief pause', 'brief_pause', 'travel_lane', 0, 3],
  ['holdout-06', 'HOLDOUT', false, 'Vehicle passes through', 'moving', 'travel_lane', 4, 12],
  ['replay-01', 'REPLAY', true, 'New roadway stop', 'positive', 'travel_lane', 0, 9],
];
export const fixtures = rows.map(([id, split, label, title, scenario, lane, speedMps, durationSec], index) => {
  const moving = scenario === 'moving' || scenario === 'slow_traffic';
  const startSec = moving ? 0 : scenario === 'brief_pause' ? 4 : 12 - durationSec;
  const endSec = scenario === 'brief_pause' ? 7 : 12;
  return ({
  id, split, label, title, scenario, mode: 'demo', source: FIXTURE_SOURCE,
  originalVideo: `synthetic://${id}`, duration: 12, camera: 'SYNTHETIC CAM 04',
  videoUrl: `/clips/${id}.mp4`, posterUrl: `/clips/${id}.jpg`,
  features: { lane, speedMps, observedDurationSec: durationSec, stoppedDurationSec: moving ? 0 : durationSec, visible: true },
  evidence: { clipId: id, url: `/clips/${id}.mp4#t=${startSec},${endSec}`, startSec, endSec,
    summary: `${title}. Authored fixture: ${lane.replaceAll('_', ' ')}, ${speedMps} m/s, ${durationSec}s observation.` },
  timestamp: new Date(Date.UTC(2026, 9, 2, 14, index * 2)).toISOString(),
});
});
export function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function holdoutDigest(clips) {
  return digest(clips.filter(c => c.split === 'HOLDOUT').map(c => ({ id: c.id, originalVideo: c.originalVideo, label: c.label, features: c.features ?? null, contentDigest: c.contentDigest ?? null })).sort((a,b) => a.id.localeCompare(b.id)));
}
export function baselineRule() {
  return {
    definition: 'A visible vehicle remains stopped or nearly stopped for at least 8 seconds.',
    include: ['Vehicle visible throughout the observation', 'At least 8 seconds at or below 1.5 m/s'],
    exclude: ['Brief pauses under 8 seconds', 'Fast-moving vehicles'],
    thresholds: { minDurationSec: 8, maxSpeedMps: 1.5, travelLaneOnly: false },
    limitation: 'Positive-only baseline does not yet distinguish a shoulder stop or slow-moving queue.',
  };
}
export function correctedRule(previous, selected) {
  const rule = structuredClone(previous);
  const shoulder = selected.some(c => c.scenario === 'shoulder');
  const moving = selected.some(c => c.scenario === 'slow_traffic');
  if (shoulder) rule.thresholds.travelLaneOnly = true;
  if (moving) rule.thresholds.maxSpeedMps = 0.5;
  rule.definition = `A visible vehicle remains ${rule.thresholds.maxSpeedMps <= 0.5 ? 'stationary' : 'stopped or nearly stopped'}${rule.thresholds.travelLaneOnly ? ' in a travel lane' : ''} for at least ${rule.thresholds.minDurationSec} seconds.`;
  rule.include = ['Vehicle visible throughout the observation', `At least ${rule.thresholds.minDurationSec} seconds at or below ${rule.thresholds.maxSpeedMps} m/s`];
  if (rule.thresholds.travelLaneOnly) rule.include.push('Vehicle occupies an active travel lane');
  rule.exclude = ['Brief pauses under 8 seconds', 'Fast-moving vehicles'];
  if (rule.thresholds.travelLaneOnly) rule.exclude.push('Vehicles stopped on the shoulder');
  if (rule.thresholds.maxSpeedMps <= 0.5) rule.exclude.push('Slow-moving traffic that continues to advance');
  rule.limitation = 'Observable motion and lane occupancy only. No inference of intent, cause, illegality, or a crash.';
  return rule;
}
export function fixtureDecision(clip, rule) {
  const f = clip.features;
  const t = rule.thresholds;
  const checks = [
    [f.visible, 'Vehicle is visible'],
    [f.observedDurationSec >= t.minDurationSec, `${f.observedDurationSec}s observation; minimum ${t.minDurationSec}s`],
    [f.speedMps <= t.maxSpeedMps, `${f.speedMps} m/s motion; maximum ${t.maxSpeedMps} m/s`],
    [!t.travelLaneOnly || f.lane === 'travel_lane', `Location: ${f.lane.replaceAll('_', ' ')}`],
  ];
  return { predicted: checks.every(([pass]) => pass), reason: checks.map(([pass,text]) => `${pass ? 'Pass' : 'Fail'}: ${text}`).join(' · '), evidence: clip.evidence };
}
export function computeMetrics(results) {
  const total = results.length;
  const tp = results.filter(r => r.expected === true && r.predicted === true).length;
  const fp = results.filter(r => r.expected === false && r.predicted === true).length;
  const fn = results.filter(r => r.expected === true && r.predicted === false).length;
  const unknown = results.filter(r => r.predicted === null).length;
  const correct = results.filter(r => r.correct).length;
  return { total, correct, falsePositives: fp, falseNegatives: fn, unknown, agreement: total ? correct / total : null,
    precision: tp + fp ? tp / (tp + fp) : null, recall: tp + fn ? tp / (tp + fn) : null };
}
