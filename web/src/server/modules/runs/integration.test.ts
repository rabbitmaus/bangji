import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../../context.js';
import { MemoryBlobStore, MemoryDocStore } from '../../stores/memory.js';
import registerRuns from './index.js';
import registerTailoring from '../tailoring/index.js';
import { setCollector } from './collectorAdapter.js';

const WS = 'ws1';
const sse = (res: http.ServerResponse, events: [string, object][]) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  events.forEach(([e, d], i) => res.write(`id: x:${i + 1}\nevent: ${e}\ndata: ${JSON.stringify({ runId: 'x', seq: i + 1, ...d })}\n\n`));
  res.end();
};

describe('runs + tailoring against fake evaluator', () => {
  const evalBodies: Record<string, any> = {};
  let evaluator: http.Server;
  let app: http.Server;
  let base = '';
  const store = new MemoryDocStore();
  const blobs = new MemoryBlobStore();

  beforeAll(async () => {
    evaluator = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : {};
        evalBodies[req.url!] = body;
        if (req.url === '/internal/evaluations') {
          return sse(res, [
            ['run.started', {}],
            ['executor.started', { itemKey: 'a1', executor: 'rule_gate' }],
            ['verdict.final', { itemKey: 'a1', decision: 'pass', source: 'ai', holdReasons: [], criteria: [{ id: 'qual:R1', label: 'Node.js 경험', source: 'ai', status: 'met' }], excerptSha256: 'h' }],
            ['verdict.final', { itemKey: 'b2', decision: 'hold', source: 'rule', holdReasons: ['detail_missing'], criteria: [] }],
            ['run.completed', { verdictCount: 2 }],
          ]);
        }
        if (req.url === '/internal/tailorings') {
          return sse(res, [
            ['tailoring.started', {}],
            ['draft.completed', { sentences: [{ sentenceId: 'S1', section: 'experience', text: 'Node.js로 API 개발', sourceFactIds: ['F1'], requirementIds: ['qual:R1'], changeType: 'rephrased', originalRefs: ['O1'] }] }],
            ['verification.result', { results: [{ sentenceId: 'S1', status: 'verified', reasons: [] }] }],
            ['approval.requested', { changes: [{ changeId: 'C-S1', kind: 'modified', sentenceId: 'S1', originalRefs: ['O1'], requiresDecision: true, reasons: [] }] }],
          ]);
        }
        if (req.url!.endsWith('/responses')) return sse(res, [['tailoring.completed', { markdown: '# done' }]]);
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((r) => evaluator.listen(0, '127.0.0.1', r));
    const evUrl = `http://127.0.0.1:${(evaluator.address() as AddressInfo).port}`;

    const ctx = {
      config: { evaluatorUrl: evUrl, limits: { maxItems: 20, maxDetails: 10, runSeconds: 60, modelCalls: 40 } },
      store, blobs, assertRunAllowed: () => undefined, assertBrowserSessionAllowed: () => undefined, releaseBrowserSession: () => undefined,
    } as unknown as AppContext;
    const a = express();
    a.use((req, _res, next) => { req.workspaceId = WS; next(); });
    a.use(express.json());
    const router = express.Router();
    a.use(router);
    a.use((err: any, _req: any, res: any, _next: any) => res.status(err.status ?? 500).json({ code: err.code, message: err.message }));
    await registerRuns(router, ctx);
    await registerTailoring(router, ctx);
    app = http.createServer(a);
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;

    await store.upsert({ id: 'contract:c1:v1', type: 'contract', workspaceId: WS, version: 1, source: { kind: 'demo' }, limits: {}, fields: [] });
    await store.upsert({
      id: 'resume:r1', type: 'resume', workspaceId: WS, resumeId: 'r1', careerYears: 3.5,
      sentences: [{ id: 'O1', text: 'Node.js 개발' }],
      facts: [{ id: 'F1', text: 'Node.js 개발', confirmed: true }, { id: 'F2', text: '미확인', confirmed: false }],
    });
    setCollector(async (c, ws, _contract, opts) => {
      const items = [
        { k: 'a1', fields: { company: 'A사', title: '백엔드', location: null, detailUrl: 'https://x/a1' }, detail: true },
        { k: 'b2', fields: { company: 'B사', title: '프론트', detailUrl: null }, detail: false },
      ];
      for (const it of items) {
        if (it.detail) await blobs.put(`snap/${it.k}.txt`, '상세 본문', 'text/plain');
        await c.store.upsert({
          id: `item:${opts.collectionRunId}:${it.k}`, type: 'item', workspaceId: ws, collectionRunId: opts.collectionRunId, itemKey: it.k,
          fields: it.fields, fieldErrors: [], detailStatus: it.detail ? 'ok' : 'detail_missing', listSnapshot: { blob: 'l', sha256: 'x' },
          detailSnapshot: it.detail ? { blob: `snap/${it.k}.txt`, sha256: 'y' } : undefined, injectionSuspected: false, injectionMatches: [],
        });
      }
      return { status: 'completed', contractId: 'c1', contractVersion: 1, items: [], skippedItems: 0, total: 2 };
    });
  });
  afterAll(() => { setCollector(undefined); evaluator.close(); app.close(); });

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const waitRun = async (id: string) => {
    for (let i = 0; i < 100; i++) {
      const r: any = await (await fetch(`${base}/api/runs/${id}`)).json();
      if (r.status !== 'running') return r;
      await new Promise((r2) => setTimeout(r2, 50));
    }
    throw new Error('run did not finish');
  };

  it('accepts UI criteria cards, calls the evaluator with its schema, stores verdicts', async () => {
    const res = await post('/api/runs', {
      contractId: 'c1', contractVersion: 1, resumeId: 'r1',
      criteria: [
        { id: 'k1', gate: 'rule', kind: 'location', label: '지역', value: '서울, 경기', required: true },
        { id: 'k2', gate: 'semantic', kind: 'semantic', label: 'Node', value: 'Node.js 백엔드', required: false },
      ],
    });
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as any;
    const run = await waitRun(id);
    expect(run.status).toBe('completed');

    const body = evalBodies['/internal/evaluations'];
    expect(body.conditions.rules).toEqual([{ id: 'k1', kind: 'region', required: true, allowed: ['서울', '경기'] }]);
    expect(body.conditions.semantic).toEqual([{ id: 'k2', text: 'Node.js 백엔드', required: false }]);
    expect(body.facts.map((f: any) => f.id)).toEqual(['F1']);
    expect(body.experienceYears).toBe(3.5);
    const a1 = body.items.find((i: any) => i.itemKey === 'a1');
    expect(a1).toMatchObject({ excerpt: '상세 본문', detailMissing: false, fields: { location: '' } });
    expect(body.items.find((i: any) => i.itemKey === 'b2').detailMissing).toBe(true);
    expect(body.limits).toHaveProperty('agentSeconds');

    expect(run.verdicts.map((v: any) => [v.itemKey, v.decision]).sort()).toEqual([['a1', 'pass'], ['b2', 'hold']]);
    expect(run.verdicts.find((v: any) => v.itemKey === 'a1').criteria[0].criterionId).toBe('qual:R1');
    expect(await store.get(WS, `crun:${run.run.collectionRunId}`)).toMatchObject({ status: 'completed' });

    // 같은 조건을 criteriaSetId로도 재평가할 수 있다.
    const setId = run.run.criteriaSetId;
    const again = await post('/api/runs', { contractId: 'c1', resumeId: 'r1', criteriaSetId: setId });
    expect(again.status).toBe(202);
    expect((await waitRun(((await again.json()) as any).id)).status).toBe('completed');

    // 맞춤 이력서: 평가기의 변경 ID(C-S1)로 결정하고 승인한다.
    const t = await post(`/api/runs/${id}/tailorings`, { itemKey: 'a1' });
    expect(t.status).toBe(202);
    const tid = ((await t.json()) as any).id;
    let doc: any;
    for (let i = 0; i < 100; i++) {
      doc = await (await fetch(`${base}/api/tailorings/${tid}`)).json();
      if (doc.status === 'awaiting_approval') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(doc.status).toBe('awaiting_approval');
    const tb = evalBodies['/internal/tailorings'];
    expect(tb).toMatchObject({ tailoringId: tid, posting: { itemKey: 'a1', company: 'A사' }, originalSentences: [{ id: 'O1' }] });
    expect(tb.requirements[0]).toMatchObject({ id: 'qual:R1', text: 'Node.js 경험' });
    expect(doc.changes[0]).toMatchObject({ changeId: 'C-S1', id: 'C-S1', type: 'modified' });

    const dec = await post(`/api/tailorings/${tid}/decisions`, { decisions: [{ changeId: 'C-S1', decision: 'accept' }], approve: true });
    expect(dec.status).toBe(200);
    expect(evalBodies[`/internal/tailorings/${tid}/responses`].decisions).toEqual([{ changeId: 'C-S1', decision: 'accept' }]);
    expect(((await dec.json()) as any).markdown).toBe('# done');
  });
});
