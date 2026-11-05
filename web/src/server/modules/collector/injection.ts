const PATTERNS: RegExp[] = [
  /무조건\s*(통과|합격|채용|추천)/,
  /(이전|위|앞선|기존)\s*(의\s*)?(지시|지침|명령|프롬프트)(를|은|는|사항)?\s*(모두\s*)?(무시|잊)/,
  /시스템\s*프롬프트/,
  /(이력서|경력)(에|을|에서)?\s*(없는|허위|거짓).{0,12}(추가|작성|기재|써|넣)/,
  /없는\s*경력을?\s*(추가|작성|기재)/,
  /(통과|합격)\s*(시키|처리).{0,4}(라|세요|하라|할 것)/,
  /(판정|평가|결과)(을|를)?\s*(pass|통과|합격)(으로)?\s*(바꾸|변경|설정|하)/i,
  /ignore\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)/i,
  /disregard\s+(all\s+|the\s+)?(previous|prior|above)\s+(instructions?|prompts?)/i,
  /system\s+prompt/i,
  /you\s+are\s+now\s+(a|an|the)\b/i,
  /(always|must)\s+(pass|approve|accept)\s+(this|the)\s+(job|posting|candidate)/i,
  /add\s+(experience|skills?)\s+(that\s+)?(is|are)?\s*not\s+(in|on)\s+(the\s+)?resume/i,
];

export function detectInjection(text: string | undefined | null): { suspected: boolean; matches: string[] } {
  if (!text) return { suspected: false, matches: [] };
  const matches: string[] = [];
  for (const re of PATTERNS) {
    const m = re.exec(text);
    if (m) matches.push(m[0]);
  }
  return { suspected: matches.length > 0, matches };
}
