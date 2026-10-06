/** Editor blocks: a section split at blank lines, keeping ::: fenced blocks and $$ math whole. */
export interface Block { kind: 'heading' | 'paragraph' | 'formula' | 'math' | 'image' | 'list' | 'other'; text: string }
export function splitBlocks(_markdown: string): Block[] { throw new Error('not implemented'); }
export function joinBlocks(_blocks: Block[]): string { throw new Error('not implemented'); }
