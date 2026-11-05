#!/usr/bin/env node
// PRD 3.1 시나리오를 API로 실행해 M3·M4·M6과 보조 지표를 계산한다. 실행했을 때만 값이 나온다.
// 사용: BASE_URL=http://127.0.0.1:8080 node web/scripts/measure.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.BASE_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const PRESET = '마감 안 된 공고, 경력 3년으로 지원 가능, 서울·경기 또는 원격, 정규직, 백엔드·Node.js';
// PRD 3.1 라벨. 회사명으로 공고를 식별한다.
const LABELS = {
  청솔소프트: ['D1', 'pass'], 한결테크: ['D2', 'pass'], 다온랩: ['D3', 'pass'], 미르커머스: ['D4', 'reject'],
  대성시스템: ['D5', 'reject'], 새벽앱스: ['D6', 'reject'], 누리데이터: ['D7', 'hold'], 푸른길컴퍼니: ['D8', 'hold'],
};

let cookie = '';
async function api(method, url, { body, headers } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  return res;
}
const json = async (res, what) => {
  if (!res.ok) throw new Error(`${what} 실패: ${res.status} ${await res.text()}`);
  return res.json();
};
function sse(text) {
  return text.split('\n\n').flatMap((blk) => {
    const m = /event: (.+)\ndata: (.+)/.exec(blk);
    return m ? [{ event: m[1], data: JSON.parse(m[2]) }] : [];
  });
}
const timings = {};
async function timed(name, fn) {
  const t = Date.now();
  try { return await fn(); } finally { timings[name] = Date.now() - t; }
}

const origin = new URL(BASE);
const source = { kind: 'demo', startUrl: `${origin.origin}/demo/jobs`, allowedHosts: [origin.hostname] };

await json(await api('POST', '/api/guest'), 'guest');
if (!cookie) throw new Error('게스트 쿠키를 받지 못했다');

const session = await timed('browserSession', async () => json(await api('POST', '/api/browser-sessions', { body: { kind: 'demo' } }), 'browser-session'));
const recs = await timed('recommendations', async () => json(await api('GET', `/api/browser-sessions/${session.id ?? session.sessionId}/recommendations`), 'recommendations'));
const preview = await json(await api('POST', '/api/contracts/preview', {
  body: { source, container: 'ul[data-list="jobs"]' },
}), 'contract preview');
const contract = await timed('contract', async () => json(await api('POST', '/api/contracts', {
  body: { source, container: preview.container, item: preview.item, fields: preview.fields, limits: { maxItems: 20, maxDetails: 10, timeoutSeconds: 120 } },
}), 'contract'));

const resumeEvents = sse(await (await api('POST', '/api/resumes', { body: { sample: true, consent: true } })).text());
const facts = resumeEvents.find((e) => e.event === 'resume.facts')?.data;
if (!facts) throw new Error('resume.facts 이벤트가 없다');
await json(await api('PUT', `/api/resumes/${facts.resumeId}/facts`, {
  headers: { 'If-Match': facts.etag },
  body: { facts: facts.facts.map((f) => ({ ...f, confirmed: true, needsCheck: false })) },
}), 'resume facts');

const draftText = await timed('criteriaDraft', async () => (await api('POST', '/api/criteria/draft', { body: { text: PRESET, careerYears: facts.careerYears } })).text());
const draft = sse(draftText).find((e) => e.event === 'criteria.draft')?.data;
if (!draft) throw new Error('criteria.draft 이벤트가 없다');

const started = Date.now();
const runRes = await json(await api('POST', '/api/runs', {
  headers: { 'Idempotency-Key': `measure-${started}` },
  body: { contractId: contract.contractId, resumeId: facts.resumeId, criteriaSetId: draft.criteriaSetId },
}), 'run');
let run;
for (;;) {
  run = await json(await api('GET', `/api/runs/${runRes.runId}`), 'run poll');
  if (!['queued', 'running'].includes(run.status)) break;
  if (Date.now() - started > 300_000) throw new Error('실행 시간 초과');
  await new Promise((r) => setTimeout(r, 1000));
}
const latencyMs = Date.now() - started;

const rows = (run.verdicts ?? []).map((v) => {
  const company = v.fields?.company ?? v.item?.fields?.company;
  const [label, expected] = LABELS[company] ?? [v.itemKey, null];
  return { label, company, expected, actual: v.effectiveDecision ?? v.decision, v };
});

// 적격 공고 = 기대 판정이 pass(D1~D3). 이들이 reject되면 M3 위반이다.
const eligible = rows.filter((r) => r.expected === 'pass');
const eligibleRejected = eligible.filter((r) => r.actual === 'reject').map((r) => r.label);
const passRows = rows.filter((r) => r.actual === 'pass');
const quotes = passRows.flatMap((r) => (r.v.criteria ?? []).filter((c) => c.quote !== undefined));
const matched = quotes.filter((c) => c.quoteVerified === true).length;
const holds = rows.filter((r) => r.actual === 'hold').length;

const report = {
  measuredAt: new Date().toISOString(),
  baseUrl: BASE,
  fakeModel: process.env.BANGJI_FAKE_MODEL === '1' ? true : 'unknown(서버 설정 기준)',
  runStatus: run.status,
  recommendationCount: Array.isArray(recs) ? recs.length : (recs.recommendations?.length ?? null),
  itemCount: rows.length,
  unlabeledItems: rows.filter((r) => !r.expected).map((r) => r.v.itemKey),
  M3: { eligible: eligible.length, eligibleRejected: eligibleRejected.length, labels: eligibleRejected, target: 0 },
  M4: { passCitations: quotes.length, matched, rate: quotes.length ? matched / quotes.length : null, target: 1 },
  M6: { holds, total: rows.length, ratio: rows.length ? holds / rows.length : null, target: 0.3 },
  passPrecision: passRows.length ? passRows.filter((r) => r.expected === 'pass').length / passRows.length : null,
  perItem: rows.map((r) => ({ label: r.label, expected: r.expected, actual: r.actual, match: r.expected === r.actual })),
  runLatencyMs: latencyMs,
  modelCalls: run.run?.modelCalls ?? run.modelCalls ?? null,
  stepTimingsMs: timings,
};

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '../../docs/measurements');
await mkdir(outDir, { recursive: true });
const file = path.join(outDir, `${new Date().toISOString().slice(0, 10)}.json`);
await writeFile(file, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
console.error(`저장: ${file}`);
