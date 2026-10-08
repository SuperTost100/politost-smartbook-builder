// Adapted from politost-smartbook (AGPL-3.0)
const LEVELS: Record<string, number> = { facile: 1, medio: 2, difficile: 3 };

/** Difficulty as a three-step bar signal plus the word, so it reads without colour. */
export function DifficultyTag({ level }: { level: string }) {
  const n = LEVELS[level] ?? 0;
  return (
    <span className={`sb-diff sb-diff-${level}`}>
      <span className="sb-diff-bars" aria-hidden>
        {[1, 2, 3].map((i) => <i key={i} className={i <= n ? 'on' : undefined} />)}
      </span>
      {level}
    </span>
  );
}
