// Minimal zero-dependency XLSX (ZIP + XML) reader. Library only, no CLI.
// Handles exactly what the NDIS Support Catalogue needs: a ZIP central
// directory walk, deflate/store decompression, workbook/rels/sharedStrings
// parsing, and a dimension-aware sheet-to-string-grid reader.
//
// Exposes: readSheet(buffer, sheetName) -> string[][]

import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;

// --- ZIP -------------------------------------------------------------------

function findEndOfCentralDirectory(buf) {
  const maxCommentLen = 65535;
  const minPos = Math.max(0, buf.length - 22 - maxCommentLen);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new Error('xlsx: end-of-central-directory record not found (not a valid zip)');
}

// Returns Map<entryName, {compressionMethod, compressedSize, localHeaderOffset}>.
// Deliberately ignores ZIP64 extra fields and general-purpose-flag bit 3
// (data descriptors): the central directory's sizes are authoritative here
// (per xlsx.mjs spec — "fall back to central-directory sizes").
function readCentralDirectory(buf) {
  const eocdPos = findEndOfCentralDirectory(buf);
  const totalEntries = buf.readUInt16LE(eocdPos + 10);
  const cdOffset = buf.readUInt32LE(eocdPos + 16);

  const entries = new Map();
  let pos = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error(`xlsx: central directory entry ${i} has a bad signature (corrupt or ZIP64 file)`);
    }
    const compressionMethod = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const uncompressedSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
    entries.set(name, { compressionMethod, compressedSize, uncompressedSize, localHeaderOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntryData(buf, entry) {
  const lfhPos = entry.localHeaderOffset;
  if (buf.readUInt32LE(lfhPos) !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw new Error('xlsx: local file header signature mismatch (corrupt zip)');
  }
  const nameLen = buf.readUInt16LE(lfhPos + 26);
  const extraLen = buf.readUInt16LE(lfhPos + 28);
  const dataStart = lfhPos + 30 + nameLen + extraLen;
  const compressed = buf.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.compressionMethod === 0) return Buffer.from(compressed);
  if (entry.compressionMethod === 8) return inflateRawSync(compressed);
  throw new Error(`xlsx: unsupported zip compression method ${entry.compressionMethod}`);
}

function openZip(buf) {
  const central = readCentralDirectory(buf);
  return {
    has: (name) => central.has(name),
    read(name) {
      const entry = central.get(name);
      if (!entry) throw new Error(`xlsx: zip entry not found: ${name}`);
      return readEntryData(buf, entry);
    },
  };
}

// --- XML (hand-rolled, just enough for the OOXML pieces we need) -----------

function decodeXmlEntities(str) {
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&'); // must run last so decoded entities aren't re-decoded
}

function attr(tag, name) {
  const m = new RegExp(`${name}="([^"]*)"`).exec(tag);
  return m ? decodeXmlEntities(m[1]) : undefined;
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const strings = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    let text = '';
    const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let tm;
    while ((tm = tRe.exec(m[1]))) text += decodeXmlEntities(tm[1]);
    strings.push(text);
  }
  return strings;
}

function parseWorkbookSheets(xml) {
  const sheets = [];
  const re = /<sheet\b[^>]*\/?>/g;
  let m;
  while ((m = re.exec(xml))) {
    const name = attr(m[0], 'name');
    const rId = attr(m[0], 'r:id');
    if (name && rId) sheets.push({ name, rId });
  }
  return sheets;
}

function parseWorkbookRels(xml) {
  const map = new Map();
  const re = /<Relationship\b[^>]*\/?>/g;
  let m;
  while ((m = re.exec(xml))) {
    const id = attr(m[0], 'Id');
    const target = attr(m[0], 'Target');
    if (id && target) map.set(id, target);
  }
  return map;
}

// "C7" -> { col: 2 (0-based), row: 7 }
function parseCellRef(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) throw new Error(`xlsx: bad cell reference "${ref}"`);
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: parseInt(m[2], 10) };
}

// Parses <sheetData> rows into a dense string[][] grid. Cell references
// (e.g. C7) are used to place values at the right column index so gaps in
// sparse rows are preserved as ''; rows are placed by their `r` attribute so
// gaps between rows are preserved as [].
function parseSheetXml(xml, sharedStrings) {
  const rows = [];
  const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const rNum = attr(rm[1], 'r');
    const rowIndex = rNum ? parseInt(rNum, 10) - 1 : rows.length;
    const cells = [];

    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    let cellCursor = 0;
    while ((cm = cellRe.exec(rm[2]))) {
      const cellAttrs = cm[1];
      const cellContent = cm[2] ?? '';
      const ref = attr(cellAttrs, 'r');
      const type = attr(cellAttrs, 't');
      const colIndex = ref ? parseCellRef(ref).col : cellCursor;
      cellCursor = colIndex + 1;

      let value = '';
      if (type === 'inlineStr') {
        const t = /<t[^>]*>([\s\S]*?)<\/t>/.exec(cellContent);
        value = t ? decodeXmlEntities(t[1]) : '';
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(cellContent);
        const raw = v ? decodeXmlEntities(v[1]) : '';
        if (type === 's') {
          const idx = parseInt(raw, 10);
          value = Number.isInteger(idx) && sharedStrings[idx] !== undefined ? sharedStrings[idx] : '';
        } else {
          value = raw; // number / str / bool / error: kept as the raw string, caller decides how to parse
        }
      }
      cells[colIndex] = value;
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    rows[rowIndex] = cells;
  }
  for (let i = 0; i < rows.length; i++) if (rows[i] === undefined) rows[i] = [];
  return rows;
}

// --- public API --------------------------------------------------------

export function readSheet(buffer, sheetName) {
  const zip = openZip(buffer);

  if (!zip.has('xl/workbook.xml')) throw new Error('xlsx: xl/workbook.xml not found — not a valid xlsx file');
  const workbookXml = zip.read('xl/workbook.xml').toString('utf8');
  const relsXml = zip.has('xl/_rels/workbook.xml.rels')
    ? zip.read('xl/_rels/workbook.xml.rels').toString('utf8')
    : '';

  const sheets = parseWorkbookSheets(workbookXml);
  const rels = parseWorkbookRels(relsXml);

  const sheet = sheets.find((s) => s.name === sheetName);
  if (!sheet) {
    throw new Error(`xlsx: sheet "${sheetName}" not found (available: ${sheets.map((s) => s.name).join(', ')})`);
  }
  const target = rels.get(sheet.rId);
  if (!target) throw new Error(`xlsx: no relationship target for sheet "${sheetName}" (rId ${sheet.rId})`);
  const sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  if (!zip.has(sheetPath)) throw new Error(`xlsx: sheet part "${sheetPath}" not found in zip`);

  const sharedStrings = zip.has('xl/sharedStrings.xml')
    ? parseSharedStrings(zip.read('xl/sharedStrings.xml').toString('utf8'))
    : [];

  return parseSheetXml(zip.read(sheetPath).toString('utf8'), sharedStrings);
}
