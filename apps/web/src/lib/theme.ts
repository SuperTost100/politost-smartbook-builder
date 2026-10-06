import { useCallback, useSyncExternalStore } from 'react';

const KEY = 'smartbuilder.theme';
type Theme = 'light' | 'dark';

function current(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

const listeners = new Set<() => void>();
function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useTheme(): [Theme, () => void] {
  const theme = useSyncExternalStore(subscribe, current, () => 'light' as Theme);
  const toggle = useCallback(() => {
    const next: Theme = current() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* storage unavailable */
    }
    listeners.forEach((l) => l());
  }, []);
  return [theme, toggle];
}
