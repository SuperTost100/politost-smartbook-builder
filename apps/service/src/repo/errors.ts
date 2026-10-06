import { HttpError } from '../server.ts';

export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} was not found. It may have been deleted.`, 'Reload the page.');
export const badInput = (message: string, action?: string, item?: string) => new HttpError(400, 'invalid', message, action, item);
export const conflict = (message: string, action = 'Reload to see the latest version, then reapply your edit.', item?: string) =>
  new HttpError(409, 'conflict', message, action, item);
