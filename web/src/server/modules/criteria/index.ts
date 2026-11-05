import express from 'express';
import { randomUUID } from 'node:crypto';
import { ApiError, type Doc, type RegisterModule } from '../../context.js';
import { runStructured } from '../copilot/client.js';
import { startSse, writeSse } from '../copilot/sse.js';
import { draftRequestSchema, draftSchema, saveRequestSchema, type RuleCard, type SemanticCard } from './schema.js';

export interface CriteriaSetDoc extends Doc {
  type: 'criteriaSet';
  criteriaSetId: string;
  version: number;
  ruleCards: RuleCard[];
  semanticCards: SemanticCard[];
  origin: 'model' | 'manual';
}

const PROMPT = (text: string) => `사용자가 적은 채용공고 선택 조건을 카드로 나눕니다.
- 규칙 카드(kind "rule"): 코드로 계산 가능한 기준만. criterion은 deadline(마감일), experience(경력 연수), region(지역), employment(고용형태) 중 하나.
  params: experience는 minYears/maxYears, region은 allowedRegions(시·도 이름)와 allowRemote, employment는 employmentTypes(정규직|계약직|인턴|프리랜서), deadline은 notPast:true.
- 의미 카드(kind "semantic"): 공고 본문을 읽고 판단해야 하는 기준(기술 스택, 업무 성격, 문화 등). text에 한 문장으로 쓴다.
- 각 카드에 id(C1, C2…), required(꼭 필요한 조건이면 true, 있으면 좋은 정도면 false)를 둡니다. 조건에 없는 내용은 만들지 않습니다.
<data>
${text}
</data>
출력 JSON 스키마: {"ruleCards":[{"id":string,"kind":"rule","criterion":string,"label":string,"required":boolean,"params":object}],"semanticCards":[{"id":string,"kind":"semantic","text":string,"required":boolean}]}`;

const mod: RegisterModule = (router, ctx) => {
  const json = express.json({ limit: '64kb' });

  router.post('/api/criteria/draft', json, async (req, res) => {
    const parsed = draftRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'validation_failed', '조건 문장을 1~2000자로 입력해 주세요');
    const workspaceId = req.workspaceId!;
    const { text, careerYears } = parsed.data;
    ctx.assertPrepAllowed?.(workspaceId);
    startSse(res);
    try {
      const draft = await runStructured(draftSchema, PROMPT(text), {
        workspaceId, onDelta: (t) => writeSse(res, 'assistant.delta', { text: t }),
      });
      const ruleCards = draft.ruleCards.map((c): RuleCard =>
        c.criterion === 'experience' && careerYears != null && c.params?.minYears == null && c.params?.maxYears == null
          ? { ...c, required: c.required ?? false, params: { ...(c.params ?? {}), myYears: careerYears } } : { ...c, required: c.required ?? false, params: c.params ?? {} });
      const semanticCards = draft.semanticCards.map((c) => ({ ...c, required: c.required ?? false }));
      const saved = await saveVersion(workspaceId, parsed.data.criteriaSetId, ruleCards, semanticCards, 'model');
      writeSse(res, 'criteria.draft', { criteriaSetId: saved.criteriaSetId, version: saved.version, etag: saved._etag, ruleCards, semanticCards });
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(500, 'internal', '조건을 나누지 못했어요', true);
      // manual: true면 UI가 조건 카드 직접 만들기로 넘어간다.
      writeSse(res, 'criteria.failed', { code: err.code, message: err.message, retryable: err.retryable, manual: true });
    } finally {
      res.end();
    }
  });

  // 사용자가 고친 카드를 새 버전으로 저장. 기존 버전을 고칠 때는 If-Match + ?version=n.
  router.put('/api/criteria/:id', express.json({ limit: '64kb' }), async (req, res) => {
    const parsed = saveRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'validation_failed', '조건 카드 형식이 올바르지 않아요');
    const workspaceId = req.workspaceId!;
    const id = String(req.params.id);
    const version = req.query.version ? Number(req.query.version) : undefined;
    const ifMatch = req.header('If-Match')?.replace(/^W\/|"/g, '');
    if (version != null) {
      if (!ifMatch) throw new ApiError(400, 'validation_failed', 'If-Match 헤더가 필요해요');
      const cur = await ctx.store.get<CriteriaSetDoc>(workspaceId, `criteria:${id}:v${version}`);
      if (!cur) throw new ApiError(404, 'not_found', '조건을 찾지 못했어요');
      // 실행이 이미 참조한 버전은 고치지 않고 새 버전으로 저장한다.
      const runs = await ctx.store.list<Doc>(workspaceId, 'evaluationRun', 'erun:');
      if (runs.some((r) => r.criteriaSetId === id && Number(r.criteriaVersion) === version)) {
        const saved = await saveVersion(workspaceId, id, parsed.data.ruleCards, parsed.data.semanticCards, 'manual');
        res.set('ETag', `"${saved._etag}"`).json(view(saved));
        return;
      }
      const next = await ctx.store.replaceIfMatch<CriteriaSetDoc>({ ...cur, ...parsed.data, origin: 'manual' }, ifMatch);
      res.set('ETag', `"${next._etag}"`).json(view(next));
      return;
    }
    const saved = await saveVersion(workspaceId, id, parsed.data.ruleCards, parsed.data.semanticCards, 'manual');
    res.set('ETag', `"${saved._etag}"`).json(view(saved));
  });

  router.get('/api/criteria/:id', async (req, res) => {
    const workspaceId = req.workspaceId!;
    const docs = await ctx.store.list<CriteriaSetDoc>(workspaceId, 'criteriaSet', `criteria:${String(req.params.id)}:`);
    if (!docs.length) throw new ApiError(404, 'not_found', '조건을 찾지 못했어요');
    const latest = docs.reduce((a, b) => (a.version >= b.version ? a : b));
    res.set('ETag', `"${latest._etag}"`).json(view(latest));
  });

  async function saveVersion(workspaceId: string, setId: string | undefined, ruleCards: RuleCard[], semanticCards: SemanticCard[], origin: 'model' | 'manual') {
    const criteriaSetId = setId ?? randomUUID().slice(0, 8);
    const existing = setId ? await ctx.store.list<CriteriaSetDoc>(workspaceId, 'criteriaSet', `criteria:${criteriaSetId}:`) : [];
    const version = existing.reduce((m, d) => Math.max(m, d.version), 0) + 1;
    return ctx.store.upsert<CriteriaSetDoc>({
      id: `criteria:${criteriaSetId}:v${version}`, type: 'criteriaSet', workspaceId, criteriaSetId, version, ruleCards, semanticCards, origin,
    });
  }
};

function view(d: CriteriaSetDoc) {
  return { criteriaSetId: d.criteriaSetId, version: d.version, etag: d._etag, ruleCards: d.ruleCards, semanticCards: d.semanticCards, origin: d.origin };
}

export default mod;
