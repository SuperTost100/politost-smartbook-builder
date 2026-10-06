import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from './Icon';

interface ToastItem { id: number; text: string; tone: 'default' | 'danger'; action?: { label: string; to?: string; onClick?: () => void } }
interface ToastApi { toast: (text: string, opts?: { tone?: 'default' | 'danger'; action?: ToastItem['action']; ms?: number }) => void }

const Ctx = createContext<ToastApi>({ toast: () => {} });
export const useToast = () => useContext(Ctx).toast;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), []);
  const toast = useCallback<ToastApi['toast']>((text, opts) => {
    const id = ++seq.current;
    setItems((l) => [...l.slice(-3), { id, text, tone: opts?.tone ?? 'default', action: opts?.action }]);
    window.setTimeout(() => dismiss(id), opts?.ms ?? (opts?.tone === 'danger' ? 9000 : 5000));
  }, [dismiss]);
  const value = useMemo(() => ({ toast }), [toast]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="ui-toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`ui-toast${t.tone === 'danger' ? ' ui-toast--danger' : ''}`}>
            <span className="ui-grow">{t.text}</span>
            {t.action?.to && <Link className="ui-toast__action" to={t.action.to} onClick={() => dismiss(t.id)}>{t.action.label}</Link>}
            {t.action?.onClick && <button type="button" className="ui-toast__action" onClick={() => { t.action?.onClick?.(); dismiss(t.id); }}>{t.action.label}</button>}
            <button type="button" className="ui-toast__close" aria-label="Dismiss" onClick={() => dismiss(t.id)}><Icon name="x" size={14} /></button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
