// Adapted from politost-smartbook (AGPL-3.0)
import { useState } from 'react';
import { ContentFlow } from './ContentFlow';

interface RevealBlockProps {
  label: string;
  content: string;
  variant?: 'hint' | 'solution';
  resolveAsset?: (src: string) => string | undefined;
}

export function RevealBlock({ label, content, variant = 'hint', resolveAsset }: RevealBlockProps) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div className={`reveal-block reveal-${variant}`}>
      <button type="button" className="reveal-btn" onClick={() => setRevealed(true)} hidden={revealed}>
        {label}
      </button>
      <div className={`reveal-content ${revealed ? 'is-open' : ''}`}>
        <div className="reveal-header">
          <span>{label}</span>
          <button type="button" className="reveal-hide" onClick={() => setRevealed(false)}>
            Nascondi
          </button>
        </div>
        <ContentFlow content={content} resolveAsset={resolveAsset} />
      </div>
    </div>
  );
}
