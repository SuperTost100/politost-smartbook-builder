/**
 * Compiled chapters reference figures as `assets/<file>`; the service keys its map by that path and may
 * also carry the bare file name. Try the reference as written, then both forms.
 */
export function resolveAssetFrom(assets: Record<string, string> | undefined, src: string): string | undefined {
  if (!assets) return undefined;
  const clean = src.replace(/^\.\//, '');
  const bare = clean.replace(/^assets\//, '');
  return assets[src] ?? assets[clean] ?? assets[`assets/${bare}`] ?? assets[bare];
}
