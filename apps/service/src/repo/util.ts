// Shared row helpers. Rows are loosely typed here and mapped to domain types by each repo module.
export type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const bool = (v: unknown) => v === 1 || v === true || v === 1n;
export const nullable = <T>(v: unknown): T | null => (v === null || v === undefined ? null : (v as T));
export const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');
