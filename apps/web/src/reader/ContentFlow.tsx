// Adapted from politost-smartbook (AGPL-3.0), screen variant only.
import { Fragment, useMemo } from 'react';
import { parseContentBlocks, type ContentBlock, type FormulaRef, type InlineSegment } from '@politost/content-core';
import { Formula } from './Formula';
import { FormulaTooltip } from './FormulaTooltip';
import { SmartbookFigure } from './SmartbookFigure';

interface ContentFlowProps {
  content: string;
  formulaIndex?: Map<string, FormulaRef>;
  resolveAsset?: (src: string) => string | undefined;
  onRefClick?: (e: React.MouseEvent) => void;
}

interface RenderContext {
  formulaIndex?: Map<string, FormulaRef>;
  resolveAsset?: (src: string) => string | undefined;
}

function InlineFlow({ segments, ctx }: { segments: InlineSegment[]; ctx: RenderContext }) {
  return (
    <>
      {segments.map((seg, i) => {
        switch (seg.type) {
          case 'text':
            return <span key={i} className="content-flow-inline" dangerouslySetInnerHTML={{ __html: seg.html }} />;
          case 'strong':
            return <strong key={i}><InlineFlow segments={seg.children} ctx={ctx} /></strong>;
          case 'em':
            return <em key={i}><InlineFlow segments={seg.children} ctx={ctx} /></em>;
          case 'anchor':
            return seg.href ? (
              <a key={i} href={seg.href} target="_blank" rel="noopener noreferrer">
                <InlineFlow segments={seg.children} ctx={ctx} />
              </a>
            ) : (
              <InlineFlow key={i} segments={seg.children} ctx={ctx} />
            );
          case 'hover':
            // Without an index (snippet previews) show the reference as plain text.
            if (!ctx.formulaIndex) return <span key={i} className="formula-missing">({seg.formulaId})</span>;
            return <FormulaTooltip key={i} formulaId={seg.formulaId} formulas={ctx.formulaIndex} />;
          case 'link':
            return (
              <button key={i} type="button" className="smartbook-ref sb-link" data-ref={seg.ref}>
                <InlineFlow segments={seg.children} ctx={ctx} />
              </button>
            );
        }
      })}
    </>
  );
}

function Blocks({ blocks, ctx }: { blocks: ContentBlock[]; ctx: RenderContext }) {
  return blocks.map((block, i) => <Fragment key={i}>{renderBlock(block, ctx)}</Fragment>);
}

function renderBlock(block: ContentBlock, ctx: RenderContext) {
  switch (block.type) {
    case 'heading': {
      const Tag = block.level === 4 ? 'h4' : 'h3';
      return (
        <Tag className="content-subheading">
          <InlineFlow segments={block.segments} ctx={ctx} />
        </Tag>
      );
    }
    case 'p':
      return block.tight ? (
        <InlineFlow segments={block.segments} ctx={ctx} />
      ) : (
        <p className="content-paragraph">
          <InlineFlow segments={block.segments} ctx={ctx} />
        </p>
      );
    case 'math':
      return <div className="content-math" dangerouslySetInnerHTML={{ __html: block.html }} />;
    case 'list': {
      const items = block.items.map((item, j) => (
        <li key={j}>
          <Blocks blocks={item} ctx={ctx} />
        </li>
      ));
      return block.ordered ? (
        <ol className="content-list" start={block.start === 1 ? undefined : block.start}>{items}</ol>
      ) : (
        <ul className="content-list">{items}</ul>
      );
    }
    case 'quote':
      return (
        <blockquote className="content-quote">
          <Blocks blocks={block.blocks} ctx={ctx} />
        </blockquote>
      );
    case 'code':
      return (
        <pre className="content-code">
          <code>{block.text}</code>
        </pre>
      );
    case 'hr':
      return <hr className="content-rule" />;
    case 'formula': {
      const f = ctx.formulaIndex?.get(block.formulaId);
      if (f) return <Formula formula={f} />;
      return (
        <p className="formula-missing" data-formula-id={block.formulaId}>
          Formula ({block.formulaId}) non disponibile
        </p>
      );
    }
    case 'image':
      return <SmartbookFigure src={block.src} alt={block.alt} caption={block.caption} resolveAsset={ctx.resolveAsset} />;
  }
}

/** Renders smartbook text with inline refs, links and block formulas. */
export function ContentFlow({ content, formulaIndex, resolveAsset, onRefClick }: ContentFlowProps) {
  const blocks = useMemo(() => parseContentBlocks(content), [content]);
  return (
    <div className="content-flow sb-prose" onClick={onRefClick}>
      <Blocks blocks={blocks} ctx={{ formulaIndex, resolveAsset }} />
    </div>
  );
}
