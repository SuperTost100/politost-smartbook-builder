/** Checks for graph payloads: evaluates fn over the domain with the reader's expression rules. */
export function checkFunctionGraph(_payload: Record<string, unknown>): { ok: boolean; detail: string } { throw new Error('not implemented'); }
/** Numeric comparison of two expressions in x over sample points (for solution checks). */
export function numericallyEqual(_a: string, _b: string, _opts?: { vars?: string[]; domain?: [number, number] }): { ok: boolean; detail: string } { throw new Error('not implemented'); }
