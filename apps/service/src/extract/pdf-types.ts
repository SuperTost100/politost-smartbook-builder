import type { PageQuality } from '@smartbuilder/domain';

export interface OutlineFlat { title: string; level: number; /** 0-based */ page: number }

export interface ExtractedPage { idx: number; label: string; text: string; quality: PageQuality; score: number }

export interface ExtractedPdf { pages: ExtractedPage[]; outline: OutlineFlat[] }

export interface RenderedPage { png: Uint8Array; width: number; height: number; highlighted: boolean }

export type WorkerJob =
  | { op: 'extract'; file: string }
  | { op: 'render'; file: string; idx: number; scale: number; highlight?: string };
