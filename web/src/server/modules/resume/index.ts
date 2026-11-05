import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError, type Doc, type RegisterModule } from '../../context.js';
import { runStructured } from '../copilot/client.js';
import { startSse, writeSse } from '../copilot/sse.js';
import { computeCareerYears, maskContacts, splitSentences, verifySourceSpan, type OriginalSentence } from './logic.js';
import { SAMPLE_RESUME } from './sample.js';

const MAX_CHARS = 8000;
const ym = z.string().regex(/^\d{4}-\d{2}$/);

const modelFactSchema = z.object({
  id: z.string(),
  category: z.enum(['experience', 'project', 'skill', 'education', 'certification', 'summary']),
  text: z.string().min(1).max(400),
  org: z.string().optional(),
  role: z.string().optional(),
  period: z.object({ start: ym.optional(), end: z.union([ym, z.literal('present')]).optional() }).optional(),
  skills: z.array(z.string()).default([]),
  numbers: z.array(z.string()).default([]),
  sourceSpan: z.string(),
});
const modelOutputSchema = z.object({ facts: z.array(modelFactSchema).max(60) });

export interface ResumeFact extends z.infer<typeof modelFactSchema> {
  needsCheck: boolean;   // sourceSpan이 원문에 없으면 true(`확인 필요`)
  confirmed: boolean;    // 사용자가 확인한 사실만 이후 단계에서 쓴다
  origin: 'model' | 'user';
}
export interface ResumeDoc extends Doc {
  type: 'resume';
  resumeId: string;
  source: 'sample' | 'paste';
  sentences: OriginalSentence[];   // 원본 O1…(연락처는 [연락처]로 마스킹된 상태)
  facts: ResumeFact[];
  careerYears: number;
  consentModelTransmission: boolean;
}

const createSchema = z.object({
  text: z.string().max(MAX_CHARS).optional(),
  sample: z.boolean().optional(),
  consent: z.literal(true),
});
const factsPutSchema = z.object({
  facts: z.array(modelFactSchema.extend({
    needsCheck: z.boolean().default(false), confirmed: z.boolean().default(false), origin: z.enum(['model', 'user']).default('user'),
  })).max(80),
});

const PROMPT = (sentences: OriginalSentence[]) => `이력서 원문에서 사실을 구조화합니다. 원문에 없는 내용은 추가하지 않습니다.
category: experience|project|skill|education|certification|summary. period는 "YYYY-MM"(재직 중이면 end는 "present").
sourceSpan은 원문에서 그대로 베낀 짧은 구간(근거)입니다. numbers에는 원문에 있는 수치 표현만 넣습니다. id는 F1, F2…
<data>
${sentences.map((s) => `${s.id}: ${s.text}`).join('\n')}
</data>
출력 JSON 스키마: {"facts":[{"id":string,"category":string,"text":string,"org"?:string,"role"?:string,"period"?:{"start"?:"YYYY-MM","end"?:"YYYY-MM|present"},"skills":string[],"numbers":string[],"sourceSpan":string}]}`;

function annotate(facts: z.infer<typeof modelFactSchema>[], original: string): ResumeFact[] {
  return facts.map((f) => ({ ...f, needsCheck: !verifySourceSpan(original, f.sourceSpan), confirmed: false, origin: 'model' as const }));
}

export function careerYearsOf(facts: Pick<ResumeFact, 'category' | 'period' | 'confirmed'>[]): number {
  // 사용자가 확인한 사실만 경력 연수에 반영한다.
  return computeCareerYears(facts.filter((f) => f.confirmed === true && f.category === 'experience' && f.period).map((f) => f.period!));
}

const mod: RegisterModule = (router, ctx) => {
  router.get('/api/resumes/sample', (_req, res) => { res.json({ text: SAMPLE_RESUME }); });

  router.post('/api/resumes', express.json({ limit: '64kb' }), async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'validation_failed', '이력서는 8,000자까지 입력할 수 있고, 모델 전송 고지에 동의해야 해요');
    const raw = parsed.data.sample ? SAMPLE_RESUME : (parsed.data.text ?? '');
    if (!raw.trim()) throw new ApiError(400, 'validation_failed', '이력서 내용을 입력해 주세요');
    const workspaceId = req.workspaceId!;
    ctx.assertPrepAllowed?.(workspaceId);

    const masked = maskContacts(raw);
    const sentences = splitSentences(masked);
    const resumeId = randomUUID().slice(0, 8);
    startSse(res);
    writeSse(res, 'resume.sentences', { resumeId, sentences });
    let facts: ResumeFact[] = [];
    let failure: ApiError | undefined;
    try {
      const out = await runStructured(modelOutputSchema, PROMPT(sentences), {
        workspaceId, onDelta: (t) => writeSse(res, 'assistant.delta', { text: t }),
      });
      facts = annotate(out.facts.map((f) => ({ ...f, skills: f.skills ?? [], numbers: f.numbers ?? [] })), masked);
    } catch (e) {
      failure = e instanceof ApiError ? e : new ApiError(500, 'internal', '사실을 구조화하지 못했어요', true);
    }
    try {
      const doc = await ctx.store.upsert<ResumeDoc>({
        id: `resume:${resumeId}`, type: 'resume', workspaceId, resumeId,
        source: parsed.data.sample ? 'sample' : 'paste', sentences, facts,
        careerYears: careerYearsOf(facts), consentModelTransmission: true,
      });
      // manual: true면 UI가 사실 직접 입력으로 넘어간다.
      writeSse(res, 'resume.facts', { ...view(doc), etag: doc._etag, manual: !!failure, error: failure && { code: failure.code, message: failure.message } });
    } catch {
      writeSse(res, 'resume.failed', { code: 'internal', message: '이력서를 저장하지 못했어요', retryable: true });
    }
    res.end();
  });

  router.get('/api/resumes/:id', async (req, res) => {
    const doc = await ctx.store.get<ResumeDoc>(req.workspaceId!, `resume:${String(req.params.id)}`);
    if (!doc) throw new ApiError(404, 'not_found', '이력서를 찾지 못했어요');
    res.set('ETag', `"${doc._etag}"`).json(view(doc));
  });

  router.put('/api/resumes/:id/facts', express.json({ limit: '128kb' }), async (req, res) => {
    const parsed = factsPutSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'validation_failed', '사실 형식이 올바르지 않아요');
    const ifMatch = req.header('If-Match')?.replace(/^W\/|"/g, '');
    if (!ifMatch) throw new ApiError(400, 'validation_failed', 'If-Match 헤더가 필요해요');
    const doc = await ctx.store.get<ResumeDoc>(req.workspaceId!, `resume:${String(req.params.id)}`);
    if (!doc) throw new ApiError(404, 'not_found', '이력서를 찾지 못했어요');
    const original = doc.sentences.map((s) => s.text).join('\n');
    // 수정된 sourceSpan은 다시 검증한다. 사용자가 고쳐 쓴 사실은 origin 'user'.
    const facts: ResumeFact[] = parsed.data.facts.map((f) => ({ ...f, needsCheck: !verifySourceSpan(original, f.sourceSpan) && f.origin !== 'user' }));
    const next = await ctx.store.replaceIfMatch<ResumeDoc>({ ...doc, facts, careerYears: careerYearsOf(facts) }, ifMatch);
    res.set('ETag', `"${next._etag}"`).json({ ...view(next), etag: next._etag });
  });
};

function view(d: ResumeDoc) {
  return { resumeId: d.resumeId, source: d.source, sentences: d.sentences, facts: d.facts, careerYears: d.careerYears, etag: d._etag };
}

export default mod;
