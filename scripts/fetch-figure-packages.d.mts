export const FIGURE_PACKAGES_DIR: string;
export interface TypstPackage { name: string; version: string; allowed: boolean; sha256: string }
export interface PythonWheel { file: string; sha256: string; url: string }
export const TYPST_PACKAGES: TypstPackage[];
export const PYTHON_WHEELS: PythonWheel[];
export function missingFigurePackages(): string[];
export function untar(gz: Buffer): Array<[string, Buffer]>;
export function ensureFigurePackages(options?: { log?: (message: string) => void }): Promise<string[]>;
