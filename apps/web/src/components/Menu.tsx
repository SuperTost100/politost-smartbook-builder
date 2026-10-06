import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

/** Button + popover list. Arrow keys move between items, Esc closes and returns focus. */
export function Menu({ label, button, children, align = 'left', buttonClass = 'ui-btn', rootClass = '' }: {
  label: string; rootClass?: string; button: ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; buttonClass?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    const first = root.current?.querySelector<HTMLElement>('[role="menuitem"]');
    first?.focus();
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const close = () => { setOpen(false); trigger.current?.focus(); };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    if (!items.length) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div className={`ui-menu ${rootClass}`} ref={root} onKeyDown={onKey}>
      <button ref={trigger} type="button" className={buttonClass} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} aria-label={label} onClick={() => setOpen((o) => !o)}>
        {button}
      </button>
      {open && <div id={id} role="menu" aria-label={label} className={`ui-menu__panel${align === 'right' ? ' ui-menu__panel--right' : ''}`}>{children(close)}</div>}
    </div>
  );
}
