// Helpers for extraction tests: temp data dir, minimal context, synthetic PDF and Office files.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import * as mupdf from 'mupdf';
import type { AppContext } from '../context.ts';
import type { Config } from '../config.ts';
import { Db, now } from '../db/db.ts';
import { Events } from '../events.ts';

export function makeCtx(): { ctx: AppContext; projectId: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'extract-test-'));
  const config: Config = { dataDir: dir, host: '127.0.0.1', port: 0, lan: false, dev: false, webDist: '', version: 'test' };
  const db = new Db(join(dir, 'test.sqlite'));
  const projectId = 'proj-1';
  db.insert('projects', { id: projectId, slug: 'p', title: 'T', subject: 'Analisi', created_at: now(), updated_at: now() });
  const ctx = { config, db, events: new Events(db) } as unknown as AppContext;
  return { ctx, projectId, dir };
}

/** A small text PDF with optional bookmarks; `outline` pages are 0-based. */
export function makePdf(pages: string[][], outline: { title: string; page: number }[] = []): Buffer {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font('Helvetica'));
  const resources = doc.addObject({ Font: { F1: font } });
  const esc = (s: string) => s.replace(/[\\()]/g, '\\$&');
  for (const lines of pages) {
    const body = 'BT /F1 14 Tf 72 760 Td 18 TL ' + lines.map((l) => `(${esc(l)}) Tj T*`).join(' ') + ' ET';
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, resources, body));
  }
  const it = doc.outlineIterator();
  for (const o of outline) {
    it.insert({ title: o.title, uri: doc.formatLinkURI({ type: 'Fit', chapter: 0, page: o.page, x: 0, y: 0, width: 0, height: 0, zoom: 0 }), open: true });
  }
  return Buffer.from(doc.saveToBuffer('compress').asUint8Array());
}

/** Minimal ZIP writer (stored entries) for building DOCX/PPTX fixtures. */
export function makeZip(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameB = Buffer.from(name);
    const data = Buffer.from(content);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameB.length, 26);
    parts.push(local, nameB, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nameB.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, nameB);
    offset += 30 + nameB.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

export function makeDocx(paragraphs: string[]): Buffer {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('');
  return makeZip({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  });
}
