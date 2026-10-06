// Adapted from politost-smartbook (AGPL-3.0)
interface SmartbookFigureProps {
  src: string;
  alt: string;
  caption?: string;
  resolveAsset?: (src: string) => string | undefined;
}

export function SmartbookFigure({ src, alt, caption, resolveAsset }: SmartbookFigureProps) {
  const url = resolveAsset?.(src);

  if (!url) {
    return (
      <figure className="smartbook-figure smartbook-figure-missing">
        <div className="smartbook-figure-placeholder" role="img" aria-label={alt}>
          Immagine non trovata: {src}
        </div>
        {caption && <figcaption>{caption}</figcaption>}
      </figure>
    );
  }

  return (
    <figure className="smartbook-figure">
      <img src={url} alt={alt} loading="lazy" decoding="async" />
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}
