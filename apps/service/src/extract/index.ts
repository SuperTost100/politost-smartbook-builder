// Source ingestion. Every format ends up as pages(resource_id, idx, label, text, quality) + pages_fts.
export { storeResource, detectKind } from './store.ts';
export { extractResource, renderPageImage, LIBREOFFICE_MISSING } from './extract.ts';
export { findPassage, searchPages } from './search.ts';
export { segmentQuestions } from './segment.ts';
export { ExtractError } from './errors.ts';
export { classifyPage, pageSignals } from './quality.ts';
export { isBlockedAddress, safeFetch } from './safe-fetch.ts';
export { htmlToMarkdown } from './html.ts';
