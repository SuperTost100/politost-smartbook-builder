import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

interface Props<T> {
  items: T[];
  rowHeight: number;
  height: number;
  selected: number;
  onSelect: (index: number) => void;
  renderRow: (item: T, index: number, selected: boolean, id: string) => ReactNode;
  label: string;
  overscan?: number;
}

/** Fixed-height windowed list with listbox keyboard support (arrows, Home, End, Page keys). */
export function VirtualList<T>({ items, rowHeight, height, selected, onSelect, renderRow, label, overscan = 6 }: Props<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const base = useId();
  const [top, setTop] = useState(0);

  const first = Math.max(0, Math.floor(top / rowHeight) - overscan);
  const last = Math.min(items.length, Math.ceil((top + height) / rowHeight) + overscan);

  const reveal = (i: number) => {
    const el = ref.current;
    if (!el) return;
    const y = i * rowHeight;
    if (y < el.scrollTop) el.scrollTop = y;
    else if (y + rowHeight > el.scrollTop + height) el.scrollTop = y + rowHeight - height;
  };
  useEffect(() => { reveal(selected); }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  const onKey = (e: React.KeyboardEvent) => {
    const page = Math.max(1, Math.floor(height / rowHeight) - 1);
    const map: Record<string, number> = { ArrowDown: selected + 1, ArrowUp: selected - 1, PageDown: selected + page, PageUp: selected - page, Home: 0, End: items.length - 1 };
    if (!(e.key in map)) return;
    e.preventDefault();
    onSelect(Math.max(0, Math.min(items.length - 1, map[e.key])));
  };

  return (
    <div
      ref={ref}
      role="listbox"
      aria-label={label}
      tabIndex={0}
      aria-activedescendant={selected >= 0 && selected < items.length ? `${base}-${selected}` : undefined}
      style={{ height, overflowY: 'auto', position: 'relative' }}
      onScroll={(e) => setTop(e.currentTarget.scrollTop)}
      onKeyDown={onKey}
    >
      <div style={{ height: items.length * rowHeight, position: 'relative' }}>
        {items.slice(first, last).map((item, k) => {
          const i = first + k;
          return (
            <div key={i} id={`${base}-${i}`} role="option" aria-selected={i === selected} style={{ position: 'absolute', top: i * rowHeight, left: 0, right: 0, height: rowHeight }} onClick={() => onSelect(i)}>
              {renderRow(item, i, i === selected, `${base}-${i}`)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
