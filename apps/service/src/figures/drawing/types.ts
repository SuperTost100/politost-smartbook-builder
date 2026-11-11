export type DrawingEngine = 'typst' | 'schemdraw';

/** Circuit symbol style of the book: American draws a zigzag resistor, European a rectangle. */
export type CircuitSymbols = 'american' | 'european';

export interface DrawingRequest {
  engine: DrawingEngine;
  /** Typst source (any engine file starts after the wrapper's defaults) or Python source that binds the drawing to `d`. */
  source: string;
  /** Default 'european'. Only changes drawings that contain circuit symbols. */
  symbols?: CircuitSymbols;
  /** Accessible name written into the SVG as its <title>. */
  title?: string;
  /** Default 20 000 ms. The Python engine needs about 2 s of that to start Pyodide. */
  timeoutMs?: number;
}

export interface DrawingSuccess {
  ok: true;
  /** The stored figure: transparent, dark ink, no text elements, tight viewBox. */
  svg: string;
  width: number;
  height: number;
  engine: DrawingEngine;
  /** Things that are allowed but worth knowing, for example a large file. */
  warnings: string[];
  renderMs: number;
}

export type DrawingFailureKind =
  /** The source is wrong: a compile error, a forbidden import, an SVG that breaks the rules. The message is meant for a repair turn. */
  | 'compile'
  | 'timeout'
  | 'memory'
  | 'output'
  /** The renderer process died without an answer. */
  | 'crash'
  /** The figure packages are not installed (run `npm run figure-packages`). Not the model's fault. */
  | 'setup';

export interface DrawingFailure {
  ok: false;
  kind: DrawingFailureKind;
  /** Short and plain: the position of the error in the model's own source, the engine's message, and the offending line. */
  error: string;
  /** 1-based, in the model's source, when the engine gave a position. */
  line?: number;
  column?: number;
}

export type DrawingResult = DrawingSuccess | DrawingFailure;
