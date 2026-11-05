import type { Doc } from '../../context.js';

// UI 카드 {id,gate,kind,label,value,required} 와 저장 형태(ruleCards/semanticCards), 평가기 conditions 사이의 변환.
export interface UiCard { id: string; gate?: string; kind: string; label?: string; value?: string; required?: boolean }

const UI_TO_CRITERION: Record<string, string> = {
  deadline: 'deadline', experience: 'experience', location: 'region', region: 'region',
  employmentType: 'employment', employment: 'employment',
};
const EMPLOYMENT = ['정규직', '계약직', '인턴', '프리랜서'];
const split = (v: string) => v.split(/[,/·、\n]+/).map((s) => s.trim()).filter(Boolean);

export function isUiCard(c: any): c is UiCard {
  return !!c && typeof c === 'object' && typeof c.id === 'string' && typeof c.kind === 'string';
}

export function cardsToStored(cards: UiCard[]): { ruleCards: any[]; semanticCards: any[] } {
  const ruleCards: any[] = [];
  const semanticCards: any[] = [];
  for (const c of cards) {
    const required = c.required !== false;
    const criterion = UI_TO_CRITERION[c.kind];
    if (c.gate === 'semantic' || c.kind === 'semantic' || !criterion) {
      const text = String(c.value || c.label || '').trim().slice(0, 300);
      if (text) semanticCards.push({ id: c.id, kind: 'semantic', text, required });
      continue;
    }
    const value = String(c.value ?? '');
    const params: Record<string, unknown> = {};
    if (criterion === 'region') params.allowedRegions = split(value);
    if (criterion === 'employment') {
      const types = EMPLOYMENT.filter((t) => value.includes(t));
      params.employmentTypes = types.length ? types : [];
    }
    if (criterion === 'deadline') params.notPast = true;
    if (criterion === 'experience') {
      const n = value.match(/\d+(?:\.\d+)?/);
      if (n) params.minYears = Number(n[0]);
    }
    ruleCards.push({ id: c.id, kind: 'rule', criterion, label: String(c.label || value || c.kind).slice(0, 80), required, params });
  }
  return { ruleCards, semanticCards };
}

// 저장된 criteria 문서 -> 평가기 conditions.
export function toConditions(doc: Doc): { rules: any[]; semantic: any[] } {
  const rules = ((doc.ruleCards as any[]) ?? []).map((c) => {
    const p = c.params ?? {};
    const allowed = c.criterion === 'region' ? (p.allowedRegions ?? []) : c.criterion === 'employment' ? (p.employmentTypes ?? []) : [];
    const rule: Record<string, unknown> = { id: c.id, kind: c.criterion, required: c.required !== false, allowed };
    if (c.criterion === 'experience') {
      if (typeof p.minYears === 'number') rule.minYears = p.minYears;
      if (typeof p.maxYears === 'number') rule.maxYears = p.maxYears;
    }
    if (c.criterion === 'region' && typeof p.allowRemote === 'boolean') rule.allowRemote = p.allowRemote;
    return rule;
  });
  const semantic = ((doc.semanticCards as any[]) ?? []).map((c) => ({ id: c.id, text: c.text, required: c.required !== false }));
  return { rules, semantic };
}

export const confirmedFacts = (resume: any) => ((resume?.facts as any[]) ?? []).filter((f) => f.confirmed === true);
