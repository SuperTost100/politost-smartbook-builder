/** Declarative function plot rendered to SVG deterministically. */
export interface PlotSpec { title?: string; xRange: [number, number]; yRange: [number, number]; xLabel?: string; yLabel?: string;
  functions: { expr: string; label?: string; domain?: [number, number]; style?: 'solid' | 'dashed' }[];
  points?: { x: number; y: number; label?: string; open?: boolean }[];
  asymptotes?: { kind: 'vertical' | 'horizontal'; value: number; label?: string }[];
  annotations?: { x: number; y: number; text: string }[]; }
export function validatePlotSpec(_spec: unknown): { ok: true; spec: PlotSpec } | { ok: false; errors: string[] } { throw new Error('not implemented'); }
export function renderPlotSvg(_spec: PlotSpec): string { throw new Error('not implemented'); }
