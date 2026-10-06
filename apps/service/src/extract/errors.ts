/** User-facing failure. `status` follows HTTP so routes can map it directly (400 bad input, 404 missing, 422 unreadable). */
export class ExtractError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'invalid', readonly action?: string) {
    super(message);
    this.name = 'ExtractError';
  }
}
