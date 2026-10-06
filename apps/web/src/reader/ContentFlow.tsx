// Adapted from politost-smartbook (AGPL-3.0)
import { Fragment, useMemo } from 'react';
import { parseContentBlocks, renderNumberedFormulaHtml, type FormulaRef, type InlineSegment } from '@politost/content-core';
import { FormulaTooltip } from './FormulaTooltip';
import { SmartbookFigure } from './SmartbookFigure';

interface ContentFlowProps {
  content: string;
  formulaIndex?: Map<string, FormulaRef>;
  resolveAsset?: (src: string) => string | undefined;
  onRefClick?: (e: React.MouseEvent) => void;
}

function InlineFlow({ segments, formulaIndex }: { segments: InlineSegment[]; formulaIndex?: Map<string, FormulaRef> }) {
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.type === 'text') {
          return <span key={i} className="content-flow-inline" dangerouslySetInnerHTML={{ __html: seg.html }} />;
        }
        if (seg.type === 'hover') {
          // Without an index (snippet previews) show the reference as plain text.
          if (!formulaIndex) return <span key={i} className="formula-missing">({seg.formulaId})</span>;
          return <FormulaTooltip key={i} formulaId={seg.formulaId} formulas={formulaIndex} />;
        }
        if (seg.type === 'link') {
          const link = (
            <button type="button" className="smartbook-ref" data-ref={seg.ref}>
              {seg.label}
            </button>
          );
          return seg.bold ? <strong key={i}>{link}</strong> : <span key={i}>{link}</span>;
        }
        return null;
      })}
    </>
  );
}

/** Renders smartbook text with inline refs, links and block formulas. */
export function ContentFlow({ content, formulaIndex, resolveAsset, onRefClick }: ContentFlowProps) {
  const blocks = useMemo(() => parseContentBlocks(content), [content]);

  return (
    <div className="content-flow" onClick={onRefClick}>
      {blocks.map((block, i) => {
        if (block.type === 'h3') {
          return (
            <h3 key={i} className="content-subheading">
              <InlineFlow segments={block.segments} formulaIndex={formulaIndex} />
            </h3>
          );
        }
        if (block.type === 'p') {
          return (
            <p key={i} className="content-paragraph">
              <InlineFlow segments={block.segments} formulaIndex={formulaIndex} />
            </p>
          );
        }
        if (block.type === 'ul') {
          return (
            <ul key={i} className="content-list">
              {block.items.map((item, j) => (
                <li key={j}>
                  <InlineFlow segments={item} formulaIndex={formulaIndex} />
                </li>
              ))}
            </ul>
          );
        }
        if (block.type === 'formula') {
          const f = formulaIndex?.get(block.formulaId);
          if (f) {
            return (
              <div
                key={i}
                className="numbered-formula"
                data-formula-id={f.id}
                dangerouslySetInnerHTML={{ __html: renderNumberedFormulaHtml(f, 'screen') }}
              />
            );
          }
          return (
            <p key={i} className="formula-missing" data-formula-id={block.formulaId}>
              Formula ({block.formulaId}) non disponibile
            </p>
          );
        }
        if (block.type === 'image') {
          return (
            <Fragment key={i}>
              <SmartbookFigure src={block.src} alt={block.alt} caption={block.caption} resolveAsset={resolveAsset} />
            </Fragment>
          );
        }
        return null;
      })}
    </div>
  );
}
