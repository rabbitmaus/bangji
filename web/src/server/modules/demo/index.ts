import { readFile } from 'node:fs/promises';
import type { Request } from 'express';
import { ApiError, type RegisterModule } from '../../context.js';
import { DEMO_JOBS, deadlineText, esc } from './jobs.js';

const STYLE = `body{font-family:system-ui,'Noto Sans KR',sans-serif;margin:0;background:#f6f7f9;color:#1d2330}main{max-width:860px;margin:0 auto;padding:24px}
ul{list-style:none;padding:0;margin:0;display:grid;gap:12px}li{background:#fff;border:1px solid #dde1e8;border-radius:10px;padding:14px 16px;display:grid;grid-template-columns:1fr auto;gap:4px 16px}
.company{font-size:13px;color:#566}h3{font-size:19px;margin:0;grid-column:1}.meta{grid-column:1;display:flex;gap:12px;font-size:13px;color:#445}a{grid-column:2;grid-row:1 / span 2;align-self:center;color:#0b57d0}`;

const page = (title: string, inner: string) =>
  `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head><body>${inner}</body></html>`;

const SEED_FALLBACK = new URL('./seed-run.json', import.meta.url);

const mod: RegisterModule = (router, ctx) => {
  router.get('/demo/jobs', (req: Request, res) => {
    const variant = String(req.query.variant ?? '');
    let jobs = DEMO_JOBS;
    if (variant === 'empty') jobs = [];
    const lis = jobs.map((j) => `<li data-id="${j.id}">
  <span class="company">${esc(j.company)}</span>
  <h3>${esc(j.title)}</h3>
  <div class="meta"><span class="exp">${esc(j.experience)}</span>${j.location ? `<span class="loc">${esc(j.location)}</span>` : ''}<span class="type">${esc(j.employmentType)}</span><span class="deadline">${deadlineText(j.deadlineDays)}</span></div>
  <a href="/demo/jobs/${j.id}">상세 보기</a>
</li>`).join('\n');
    const list = `<ul data-list="jobs">${lis}</ul>`;
    let inner: string;
    if (variant === 'broken') inner = `<main><h1>채용 공고</h1><div class="board">${lis.replace(/<\/?li[^>]*>/g, '')}</div></main>`;
    else if (variant === 'shifted') inner = `<main><h1>채용 공고</h1><p>알림: 이번 주 새 공고</p><section><div class="wrap"><div class="banner">광고 영역</div>${list}</div></section></main>`;
    else inner = `<main><h1>채용 공고</h1>${list}</main>`;
    res.type('html').send(page('채용 공고 (데모)', inner));
  });

  router.get('/demo/jobs/:id', (req, res) => {
    const job = DEMO_JOBS.find((j) => j.id === req.params.id);
    if (!job) return res.status(404).type('html').send(page('없는 공고', '<main><p>공고를 찾을 수 없어요.</p></main>'));
    const body = job.body.length ? job.body.map((p) => `<p>${esc(p)}</p>`).join('') : '';
    res.type('html').send(page(job.title, `<main><article><span class="company">${esc(job.company)}</span><h1>${esc(job.title)}</h1>
<dl><dt>경력</dt><dd>${esc(job.experience)}</dd><dt>근무지</dt><dd>${esc(job.location || '미기재')}</dd><dt>고용형태</dt><dd>${esc(job.employmentType)}</dd><dt>마감일</dt><dd>${deadlineText(job.deadlineDays)}</dd></dl>
<section class="detail">${body}</section><p><a href="/demo/jobs">목록으로</a></p></article></main>`));
  });

  router.get('/api/demo/seed-run', async (_req, res, next) => {
    try {
      const doc = await ctx.store.get('demo-seed', 'seed-run').catch(() => undefined);
      if (doc) { const { _etag, ttl, ...rest } = doc as Record<string, unknown>; return res.json(rest); }
      const raw = await readFile(SEED_FALLBACK, 'utf8').catch(() => undefined);
      if (!raw) throw new ApiError(404, 'not_found', '데모 결과가 아직 없어요');
      res.json(JSON.parse(raw));
    } catch (e) { next(e); }
  });
};

export default mod;
