// BANGJI_FAKE_MODEL=1일 때 토큰 없이 흐름을 확인하기 위한 결정적 대체 구현.
export const fakeModelEnabled = (): boolean => process.env.BANGJI_FAKE_MODEL === '1';

function dataBlock(prompt: string): string {
  return prompt.match(/<data>\n?([\s\S]*?)\n?<\/data>/)?.[1] ?? '';
}

const REGIONS = ['서울', '경기', '인천', '부산', '대구', '대전', '광주', '울산', '세종', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주'];

function fakeCriteria(text: string) {
  const ruleCards: unknown[] = [];
  const semanticCards: unknown[] = [];
  let n = 0;
  const id = () => `C${++n}`;
  if (/마감/.test(text)) ruleCards.push({ id: id(), kind: 'rule', criterion: 'deadline', label: '마감일이 지나지 않음', required: true, params: { notPast: true } });
  if (/경력|신입|년차|\d+\s*년/.test(text)) {
    const m = text.match(/(\d+)\s*년\s*(?:이상|이하|미만)?/);
    const params: Record<string, number> = {};
    // 이상·이하·미만이 없으면 '내 경력'으로 보고 공고 요구 연수와 비교한다.
    if (m && /이하|미만/.test(text)) params.maxYears = Number(m[1]);
    else if (m && /이상/.test(text)) params.minYears = Number(m[1]);
    else if (m) params.myYears = Number(m[1]);
    ruleCards.push({ id: id(), kind: 'rule', criterion: 'experience', label: '경력 연수', required: true, params });
  }
  const found = REGIONS.filter((r) => text.includes(r));
  if (/지역|근무지|재택|원격/.test(text) || found.length) {
    ruleCards.push({ id: id(), kind: 'rule', criterion: 'region', label: '근무 지역', required: true, params: { allowedRegions: found, allowRemote: /재택|원격/.test(text) } });
  }
  const types = ['정규직', '계약직', '인턴', '프리랜서'].filter((t) => text.includes(t));
  if (/고용|채용형태/.test(text) || types.length) {
    ruleCards.push({ id: id(), kind: 'rule', criterion: 'employment', label: '고용형태', required: true, params: { employmentTypes: types.length ? types : ['정규직'] } });
  }
  const topics = ['백엔드', '프론트엔드', '데이터', '데브옵스'].filter((t) => text.includes(t));
  const stack = ['Node.js', 'TypeScript', 'React', 'Redis', 'PostgreSQL', 'Docker', 'Java', 'Python', 'Spring'].filter((s) => text.toLowerCase().includes(s.toLowerCase()));
  if (stack.length || topics.length) semanticCards.push({ id: id(), kind: 'semantic', text: [...topics, ...stack].join(', '), required: true });
  if (!ruleCards.length && !semanticCards.length) semanticCards.push({ id: id(), kind: 'semantic', text: text.slice(0, 200), required: true });
  return { ruleCards, semanticCards };
}

function fakeFacts(data: string) {
  const sentences = data.split('\n').map((l) => l.match(/^(O\d+):\s*(.*)$/)).filter((m): m is RegExpMatchArray => !!m).map((m) => m[2].trim());
  const facts: unknown[] = [];
  let section = '';
  let n = 0;
  const add = (f: Record<string, unknown>) => facts.push({ id: `F${++n}`, skills: [], numbers: [], ...f });
  for (const s of sentences) {
    const head = s.match(/^\[(.+)\]$/);
    if (head) { section = head[1]; continue; }
    if (!s || !section || /^이메일|^전화|\[연락처\]/.test(s)) continue;
    if (section === '요약') { add({ category: 'summary', text: s, sourceSpan: s }); continue; }
    if (section === '경력') {
      const job = s.match(/^(.+?)\s*\|\s*(.+?)\s*\|\s*(\d{4})\.(\d{2})\s*~\s*(?:(\d{4})\.(\d{2})|현재)/);
      if (job) {
        add({ category: 'experience', text: s, org: job[1], role: job[2], sourceSpan: s,
          period: { start: `${job[3]}-${job[4]}`, end: job[5] ? `${job[5]}-${job[6]}` : 'present' } });
      } else {
        const skills = ['Node.js', 'Redis', 'TypeScript', 'React'].filter((k) => s.includes(k));
        add({ category: 'project', text: s.replace(/^-\s*/, ''), skills, numbers: s.match(/\d+\s*%/g) ?? [], sourceSpan: s.replace(/^-\s*/, '') });
      }
      continue;
    }
    if (section === '기술') { add({ category: 'skill', text: s, skills: s.split(/[,，]\s*/).map((x) => x.trim()).filter(Boolean), sourceSpan: s }); continue; }
    add({ category: /기사|자격/.test(s) ? 'certification' : 'education', text: s, sourceSpan: s });
  }
  return { facts };
}

function fakeNaming(data: string) {
  try {
    const list = JSON.parse(data) as { id: string; tag: string; repeatCount: number }[];
    const ranked = [...list].sort((a, b) => b.repeatCount - a.repeatCount);
    return { candidates: ranked.map((c, i) => ({ id: c.id, name: i === 0 ? '채용공고 목록' : `반복 영역 ${i + 1}`, reason: `${c.tag} 요소가 ${c.repeatCount}번 반복돼요`, rank: i + 1 })) };
  } catch {
    return { candidates: [] };
  }
}

export function fakeStructured(prompt: string): unknown {
  const data = dataBlock(prompt);
  if (prompt.includes('채용공고 선택 조건을 카드로')) return fakeCriteria(data);
  if (prompt.includes('이력서 원문에서 사실을')) return fakeFacts(data);
  if (prompt.includes('반복 구조로 찾은 영역 후보')) return fakeNaming(data);
  throw new Error('fake model: 지원하지 않는 프롬프트');
}

// 도우미용 결정적 응답. 설정 초안을 요청하는 프롬프트에는 json 블록을 포함한다.
export function fakeAssistantReply(prompt: string): string {
  if (/JSON만/.test(prompt) || !/<data>/.test(prompt)) {
    return '```json\n' + JSON.stringify({ containerSelector: 'ul.jobs', itemSelector: 'li.job', fields: [
      { name: '제목', selector: 'a.title', mapsTo: 'title' }, { name: '링크', selector: 'a.title', attr: 'href', mapsTo: 'link' },
    ] }) + '\n```';
  }
  return '목록 구조를 확인했어요. 아래 설정 초안을 확인해 주세요.\n```json\n' + JSON.stringify({ containerSelector: 'ul.jobs', itemSelector: 'li.job', fields: [
    { name: '제목', selector: 'a.title', mapsTo: 'title' }, { name: '링크', selector: 'a.title', attr: 'href', mapsTo: 'link' },
  ] }) + '\n```';
}
