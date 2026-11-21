import { useEffect, useRef, useState, type RefObject } from 'react';
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

/**
 * A button that turns into a question in place ("Remove this block? Remove / Keep"). While it asks, focus is on the safe
 * answer, and when the question goes away without the action, focus is back on the button, because the control that had it
 * is gone from the page either way.
 */
export function useInlineConfirm() {
  const [asking, setAsking] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const was = useRef(false);
  useEffect(() => {
    if (asking) keepRef.current?.focus();
    else if (was.current) triggerRef.current?.focus();
    was.current = asking;
  }, [asking]);
  return { asking, ask: () => setAsking(true), dismiss: () => setAsking(false), keepRef, triggerRef };
}

/**
 * Focus `target` when `key` changes and the control that had focus went away with the change (focus is on the body): a run's
 * Cancel button once it is cancelled, a card's Delete button once the card is gone.
 */
export function useFocusWhenLost(target: RefObject<HTMLElement | null>, key: unknown) {
  // Not on the first render: a page that just opened leaves focus where the browser put it.
  const last = useRef(key);
  useEffect(() => {
    if (Object.is(last.current, key)) return;
    last.current = key;
    const at = document.activeElement;
    // Without preventScroll: the control that takes focus is brought into view, which on a phone can be far up the page.
    if (!at || at === document.body) target.current?.focus();
  }, [key, target]);
}
