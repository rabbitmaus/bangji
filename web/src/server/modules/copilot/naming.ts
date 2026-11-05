import { z } from 'zod';
import { runStructured } from './client.js';

export interface RegionCandidate {
  id: string;
  tag: string;
  repeatCount: number;
  sampleTexts: string[];
  score?: number;
}
export interface NamedCandidate { id: string; name: string; reason: string; rank: number }

const schema = z.object({
  candidates: z.array(z.object({
    id: z.string(), name: z.string().min(1).max(40), reason: z.string().min(1).max(200), rank: z.number().int().min(1),
  })).min(1),
});

/** TRD 5.3. 실패하면 null을 돌려준다(호출자는 `구조 기반 추천` 라벨로 점수 순서를 쓴다). */
export async function nameCandidates(workspaceId: string, candidates: RegionCandidate[]): Promise<NamedCandidate[] | null> {
  if (!candidates.length) return [];
  const summary = candidates.map((c) => ({
    id: c.id, tag: c.tag, repeatCount: c.repeatCount, sampleTexts: c.sampleTexts.slice(0, 3).map((t) => t.slice(0, 120)),
  }));
  const prompt = `웹페이지에서 반복 구조로 찾은 영역 후보입니다. 각 후보에 짧은 한국어 이름(예: "채용공고 목록"), 이유 한 문장, 채용공고 목록일 가능성이 높은 순서의 순위(1이 가장 높음)를 붙이세요.
<data>
${JSON.stringify(summary)}
</data>
출력 JSON 스키마: {"candidates":[{"id":string,"name":string,"reason":string,"rank":number}]}`;
  try {
    const out = await runStructured(schema, prompt, { workspaceId });
    const ids = new Set(candidates.map((c) => c.id));
    return out.candidates.filter((c) => ids.has(c.id)).sort((a, b) => a.rank - b.rank);
  } catch {
    return null;
  }
}
