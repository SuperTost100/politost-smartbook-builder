// Adapted from politost-smartbook (AGPL-3.0)
import { preprocessContent, type Exercise } from '@politost/content-core';
import { ContentFlow } from './ContentFlow';
import { DifficultyTag } from './DifficultyTag';
import { RevealBlock } from './RevealBlock';

export function ExerciseCard({ ex, resolveAsset }: { ex: Exercise; resolveAsset?: (src: string) => string | undefined }) {
  return (
    <article className="sb-ex" id={ex.id ? `ex-${ex.id}` : undefined}>
      <header className="sb-ex-head">
        {ex.id && <span className="sb-ex-id">{ex.id}</span>}
        {ex.chapter && <span className="sb-ex-ch">cap. {ex.chapter}</span>}
        {ex.difficulty && <DifficultyTag level={ex.difficulty} />}
      </header>
      <div className="sb-ex-q">
        <ContentFlow content={preprocessContent(ex.question)} resolveAsset={resolveAsset} />
      </div>
      {(ex.hint || ex.solution) && (
        <div className="sb-ex-actions">
          {ex.hint && <RevealBlock content={preprocessContent(ex.hint)} variant="hint" resolveAsset={resolveAsset} />}
          {ex.solution && <RevealBlock content={preprocessContent(ex.solution)} variant="solution" resolveAsset={resolveAsset} />}
        </div>
      )}
    </article>
  );
}
