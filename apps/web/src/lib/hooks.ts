import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';

export function useBookId(): string {
  return useParams().id as string;
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function useMediaQuery(query: string): boolean {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return m;
}

export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title ? `${title} · Smart Builder` : 'PoliTost Smart Builder';
  }, [title]);
}

/** Keeps the latest value in a ref, for event handlers that must not re-subscribe. */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
