// Adapted from politost-smartbook (AGPL-3.0)
import { useEffect, useRef, useState } from 'react';
import { CircleCheck, EyeOff, Lightbulb } from 'lucide-react';
import { ContentFlow } from './ContentFlow';

interface RevealBlockProps {
  content: string;
  variant?: 'hint' | 'solution';
  resolveAsset?: (src: string) => string | undefined;
}

const COPY = {
  hint: { show: 'Mostra suggerimento', title: 'Suggerimento', Icon: Lightbulb },
  solution: { show: 'Mostra soluzione', title: 'Soluzione', Icon: CircleCheck },
} as const;

/** A hint or solution that stays closed until asked, and can be closed again. */
export function RevealBlock({ content, variant = 'hint', resolveAsset }: RevealBlockProps) {
  const [open, setOpen] = useState(false);
  const showRef = useRef<HTMLButtonElement>(null);
  const hideRef = useRef<HTMLButtonElement>(null);
  const touched = useRef(false);
  const { show, title, Icon } = COPY[variant];

  useEffect(() => {
    if (!touched.current) return;
    (open ? hideRef : showRef).current?.focus();
  }, [open]);

  const toggle = (next: boolean) => {
    touched.current = true;
    setOpen(next);
  };

  return (
    <div className={`sb-reveal sb-reveal-${variant}${open ? ' sb-reveal-open' : ''}`}>
      {open ? (
        <div className="sb-reveal-panel" role="region" aria-label={title}>
          <div className="sb-reveal-head">
            <span className="sb-reveal-label"><Icon size={14} strokeWidth={1.75} aria-hidden />{title}</span>
            <button ref={hideRef} type="button" className="sb-btn sb-btn-ghost sb-btn-sm" onClick={() => toggle(false)}>
              <EyeOff size={14} strokeWidth={1.75} aria-hidden />
              Nascondi
            </button>
          </div>
          <div className="sb-reveal-body"><ContentFlow content={content} resolveAsset={resolveAsset} /></div>
        </div>
      ) : (
        <button ref={showRef} type="button" className="sb-btn sb-btn-secondary sb-btn-sm" aria-expanded={false} onClick={() => toggle(true)}>
          <Icon size={14} strokeWidth={1.75} aria-hidden />
          {show}
        </button>
      )}
    </div>
  );
}
