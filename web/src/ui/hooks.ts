import { useCallback, useEffect, useRef, useState } from 'react';
import type { EventEnvelope } from './api';

export function useHashRoute(): [string, (to: string) => void] {
  const get = () => window.location.hash.replace(/^#/, '') || '/';
  const [route, setRoute] = useState(get);
  useEffect(() => {
    const on = () => setRoute(get());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = useCallback((to: string) => {
    window.location.hash = to;
  }, []);
  return [route, go];
}

export function usePersisted<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const s = sessionStorage.getItem(key);
      return s ? (JSON.parse(s) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T | ((p: T) => T)) => {
      setValue((prev) => {
        const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
        try {
          sessionStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        return next;
      });
    },
    [key],
  );
  return [value, set];
}

/**
 * GET SSE를 EventSource로 읽는다. 이벤트의 seq로 중복을 버린다(TRD 8.3).
 * 재연결은 브라우저가 Last-Event-ID로 처리한다.
 */
export function useEventStream(
  url: string | null,
  events: string[],
  onEvent: (name: string, data: EventEnvelope) => void,
  terminal: string[] = [],
) {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const [connected, setConnected] = useState(false);
  const eventsKey = events.join('|');
  const terminalKey = terminal.join('|');
  useEffect(() => {
    if (!url) return;
    let lastSeq = -1;
    const es = new EventSource(url, { withCredentials: true });
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    const names = eventsKey ? eventsKey.split('|') : [];
    const ends = terminalKey ? terminalKey.split('|') : [];
    const listeners = names.map((name) => {
      const l = (ev: MessageEvent) => {
        let data: EventEnvelope;
        try {
          data = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (typeof data.seq === 'number') {
          if (data.seq <= lastSeq && name !== 'draft.delta' && name !== 'assistant.delta') return;
          if (name !== 'draft.delta' && name !== 'assistant.delta') lastSeq = data.seq;
        }
        handler.current(name, data);
        if (ends.includes(name)) {
          es.close();
          setConnected(false);
        }
      };
      es.addEventListener(name, l as EventListener);
      return [name, l] as const;
    });
    return () => {
      listeners.forEach(([n, l]) => es.removeEventListener(n, l as EventListener));
      es.close();
      setConnected(false);
    };
  }, [url, eventsKey, terminalKey]);
  return connected;
}

export function newKey(): string {
  return crypto.randomUUID();
}

export function download(filename: string, text: string, type = 'text/markdown;charset=utf-8') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
