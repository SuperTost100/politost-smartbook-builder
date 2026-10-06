import type { CompiledBook } from './types.ts';
/** Plain ZIP .ptsb with ptsb.json { encrypted: false, access: 'public' }. */
export function packPtsb(_book: CompiledBook, _opts?: { createdAt?: string }): Uint8Array { throw new Error('not implemented'); }
/** Reopen with content-core readPtsb and compare against the compiled book. */
export function readBackPtsb(_bytes: Uint8Array, _book: CompiledBook): { ok: boolean; errors: string[]; warnings: string[] } { throw new Error('not implemented'); }
