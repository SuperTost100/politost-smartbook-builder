// Adapted from politost-smartbook (AGPL-3.0)
import { preprocessContent, type Exercise } from '@politost/content-core';
import { ContentFlow } from './ContentFlow';
import { RevealBlock } from './RevealBlock';

export function ExerciseCard({ ex, resolveAsset }: { ex: Exercise; resolveAsset?: (src: string) => string | undefined }) {
  return (
    <article className="exercise-card" id={ex.id ? `ex-${ex.id}` : undefined}>
      <header className="exercise-header">
        {ex.id && <span className="exercise-id">{ex.id}</span>}
        {ex.chapter && <span className="exercise-ch">Cap. {ex.chapter}</span>}
        {ex.difficulty && <span className={`difficulty difficulty-${ex.difficulty}`}>{ex.difficulty}</span>}
      </header>
      <div className="exercise-question">
        <ContentFlow content={preprocessContent(ex.question)} resolveAsset={resolveAsset} />
      </div>
      <div className="exercise-actions">
        {ex.hint && <RevealBlock label="Mostra suggerimento" content={preprocessContent(ex.hint)} variant="hint" resolveAsset={resolveAsset} />}
        {ex.solution && <RevealBlock label="Mostra soluzione" content={preprocessContent(ex.solution)} variant="solution" resolveAsset={resolveAsset} />}
      </div>
    </article>
  );
}
