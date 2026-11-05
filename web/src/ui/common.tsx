import { Children, cloneElement, Fragment, isValidElement, useCallback, useId, useState, type ReactNode } from 'react';
import { CheckCircle, Info, WarningCircle, XCircle } from '@phosphor-icons/react';
import { errorMessage, type CriteriaCard, type Decision } from './api';
import { UiIcon } from './design/primitives';

export interface WizardState {
  step: number;
  sourceKind: 'demo' | 'url';
  url: string;
  browserSessionId?: string;
  contractId?: string;
  contractVersion?: number;
  criteriaText: string;
  criteria: CriteriaCard[];
  resumeId?: string;
  resumeConfirmed?: boolean;
  resumeFacts?: { resumeId: string; facts: any[]; etag?: string; experienceYears?: number };
}

export const initialWizard: WizardState = {
  step: 1,
  sourceKind: 'demo',
  url: '',
  criteriaText: '',
  criteria: [],
};

export const DEMO_CRITERIA_TEXT =
  '마감 안 된 공고, 경력 3년으로 지원 가능, 서울·경기 또는 원격, 정규직, 백엔드·Node.js';

export const DECISION_TEXT: Record<Decision, string> = { pass: '통과', reject: '탈락', hold: '보류' };

export function DecisionBadge({ decision, manual }: { decision: Decision; manual?: boolean }) {
  return (
    <span className={`badge badge-${decision}`}>
      {decision} · {DECISION_TEXT[decision]}
      {manual ? ' (수동)' : ''}
    </span>
  );
}

export function Notice({ kind = 'info', children }: { kind?: 'info' | 'error' | 'warn' | 'ok'; children: ReactNode }) {
  const icon = { info: Info, error: XCircle, warn: WarningCircle, ok: CheckCircle }[kind];
  const label = { info: '안내', error: '오류', warn: '주의', ok: '완료' }[kind];
  return (
    <div className={`notice notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'} aria-atomic="true">
      <span className="notice-icon"><UiIcon icon={icon} size={20} /></span>
      <div className="notice-content"><span className="sr">{label}: </span>{children}</div>
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <span className="spinner-wrap" role="status" aria-atomic="true">
      <span className="spinner" aria-hidden="true" /> {label}
    </span>
  );
}

/** 비동기 동작의 진행·오류 상태를 한 곳에서 다룬다. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(errorMessage(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  /** 성공하면 true, 실패하면 오류를 표시하고 false를 돌려준다. */
  const runOk = useCallback(async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, setError, run, runOk };
}

interface FieldChildProps {
  children?: ReactNode;
  type?: string;
  required?: boolean;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean | 'true' | 'false' | 'grammar' | 'spelling';
}

export function Field({
  label, children, hint, error, required,
}: { label: string; children: ReactNode; hint?: ReactNode; error?: string; required?: boolean }) {
  const id = useId();
  const labelId = `${id}-label`;
  const hintId = hint && !error ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const connectControls = (nodes: ReactNode): ReactNode => Children.map(nodes, (child) => {
    if (!isValidElement<FieldChildProps>(child)) return child;
    if (typeof child.type === 'string' && ['input', 'textarea', 'select'].includes(child.type) && child.props.type !== 'hidden') {
      const describedBy = [child.props['aria-describedby'], hintId, errorId].filter(Boolean).join(' ') || undefined;
      return cloneElement(child, {
        'aria-labelledby': child.props['aria-labelledby'] ?? (child.props['aria-label'] ? undefined : labelId),
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : child.props['aria-invalid'],
        required: required ?? child.props.required,
      });
    }
    // Preserve wrapping labels while supporting native controls inside layout elements.
    if ((typeof child.type === 'string' || child.type === Fragment) && child.props.children) {
      return cloneElement(child, {}, connectControls(child.props.children));
    }
    return child;
  });
  return (
    <label className={`field${error ? ' field-invalid' : ''}`}>
      <span className="field-label" id={labelId}>{label}{required && <span className="field-required"> (필수)</span>}</span>
      {connectControls(children)}
      {hint && !error && <span className="hint" id={hintId}>{hint}</span>}
      {error && <span className="field-error" id={errorId}>{error}</span>}
    </label>
  );
}

export function fmtTime(s?: string): string {
  if (!s) return '-';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
}
