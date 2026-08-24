import JSZip, { type JSZipObject } from "jszip";

export type XlsxImportLimits = {
  compressedSourceBytes: number;
  totalUncompressedBytes: number;
  entryUncompressedBytes: number;
  worksheetXmlBytes: number;
  sharedStringsXmlBytes: number;
  worksheetCount: number;
  zipEntryCount: number;
  cellCount: number;
  includedDataRows: number;
  compressionRatio: number;
  worksheetColumns: number;
};

export const XLSX_IMPORT_LIMITS: Readonly<XlsxImportLimits> = Object.freeze({
  compressedSourceBytes: 20 * 1024 * 1024,
  totalUncompressedBytes: 200 * 1024 * 1024,
  entryUncompressedBytes: 64 * 1024 * 1024,
  worksheetXmlBytes: 64 * 1024 * 1024,
  sharedStringsXmlBytes: 64 * 1024 * 1024,
  worksheetCount: 64,
  zipEntryCount: 2_048,
  cellCount: 2_000_000,
  includedDataRows: 25_000,
  compressionRatio: 100,
  worksheetColumns: 16_384,
});

export type ParsedXlsxSheet = {
  name: string;
  state: "included" | "ignored" | "obsolete" | "notes_review";
  rows: string[][];
};

export type XlsxImportLimitOverrides = Partial<XlsxImportLimits>;

export type XlsxImportErrorCode =
  | "malformed_archive"
  | "encrypted_entry"
  | "unsupported_compression"
  | "unsafe_entry_path"
  | "entry_count_exceeded"
  | "entry_size_exceeded"
  | "total_size_exceeded"
  | "compression_ratio_exceeded"
  | "worksheet_count_exceeded"
  | "cell_count_exceeded"
  | "row_count_exceeded"
  | "unsafe_xml";

export class XlsxImportError extends Error {
  readonly code: XlsxImportErrorCode;

  constructor(code: XlsxImportErrorCode) {
    super(code);
    this.name = "XlsxImportError";
    this.code = code;
  }
}

type ResolvedLimits = XlsxImportLimits;

type CentralDirectoryEntry = {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  flags: number;
  compressionMethod: number;
  localHeaderOffset: number;
  directory: boolean;
};

const textDecoder = new TextDecoder("utf-8", { fatal: true });
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const ZIP64_EXTRA_FIELD = 0x0001;

function fail(code: XlsxImportErrorCode): never {
  throw new XlsxImportError(code);
}

function resolveLimits(overrides: XlsxImportLimitOverrides | undefined): ResolvedLimits {
  const resolved: ResolvedLimits = { ...XLSX_IMPORT_LIMITS };
  if (!overrides) return resolved;
  for (const key of Object.keys(resolved) as Array<keyof ResolvedLimits>) {
    const candidate = overrides[key];
    if (candidate === undefined) continue;
    if (!Number.isSafeInteger(candidate) || candidate <= 0) fail("malformed_archive");
    resolved[key] = Math.min(candidate, XLSX_IMPORT_LIMITS[key]);
  }
  return resolved;
}

function decodeEntryName(bytes: Uint8Array, utf8: boolean) {
  try {
    if (utf8) return textDecoder.decode(bytes);
    return Array.from(bytes, (value) => String.fromCharCode(value)).join("");
  } catch {
    fail("unsafe_entry_path");
  }
}

function validateEntryName(name: string) {
  if (!name || name.includes("\0") || name.includes("\\") || name.startsWith("/")
    || /^[a-z]:/i.test(name) || name.includes("//")) {
    fail("unsafe_entry_path");
  }
  const parts = name.endsWith("/") ? name.slice(0, -1).split("/") : name.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) fail("unsafe_entry_path");
}

function containsZip64Extra(view: DataView, start: number, length: number) {
  let offset = start;
  const end = start + length;
  while (offset < end) {
    if (offset + 4 > end) fail("malformed_archive");
    const id = view.getUint16(offset, true);
    const size = view.getUint16(offset + 2, true);
    offset += 4;
    if (offset + size > end) fail("malformed_archive");
    if (id === ZIP64_EXTRA_FIELD) return true;
    offset += size;
  }
  return false;
}

function findEndOfCentralDirectory(view: DataView) {
  const minimum = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) !== EOCD_SIGNATURE) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + 22 + commentLength === view.byteLength) return offset;
  }
  fail("malformed_archive");
}

function inspectCentralDirectory(bytes: Uint8Array, limits: ResolvedLimits) {
  if (bytes.byteLength === 0 || bytes.byteLength > limits.compressedSourceBytes) {
    fail(bytes.byteLength === 0 ? "malformed_archive" : "total_size_exceeded");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  const disk = view.getUint16(eocd + 4, true);
  const directoryDisk = view.getUint16(eocd + 6, true);
  const diskEntries = view.getUint16(eocd + 8, true);
  const totalEntries = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (disk !== 0 || directoryDisk !== 0 || diskEntries !== totalEntries
    || totalEntries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    fail("malformed_archive");
  }
  if (totalEntries > limits.zipEntryCount) fail("entry_count_exceeded");
  if (directoryOffset + directorySize !== eocd || directoryOffset > eocd) fail("malformed_archive");

  const entries: CentralDirectoryEntry[] = [];
  const names = new Set<string>();
  const localOffsets = new Set<number>();
  let totalCompressed = 0;
  let totalUncompressed = 0;
  let worksheetEntries = 0;
  let cursor = directoryOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > eocd || view.getUint32(cursor, true) !== CENTRAL_DIRECTORY_SIGNATURE) {
      fail("malformed_archive");
    }
    const flags = view.getUint16(cursor + 8, true);
    const compressionMethod = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const entryDisk = view.getUint16(cursor + 34, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > eocd || entryDisk !== 0 || compressedSize === 0xffffffff
      || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff
      || containsZip64Extra(view, cursor + 46 + nameLength, extraLength)) {
      fail("malformed_archive");
    }
    if ((flags & 0x1) !== 0) fail("encrypted_entry");
    if (compressionMethod !== 0 && compressionMethod !== 8) fail("unsupported_compression");
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = decodeEntryName(nameBytes, (flags & 0x800) !== 0);
    validateEntryName(name);
    if (names.has(name) || localOffsets.has(localHeaderOffset)) fail("malformed_archive");
    names.add(name);
    localOffsets.add(localHeaderOffset);
    const directory = name.endsWith("/");
    if (!directory && uncompressedSize > limits.entryUncompressedBytes) fail("entry_size_exceeded");
    if (/^xl\/worksheets\/[^/]+\.xml$/i.test(name)) {
      worksheetEntries += 1;
      if (uncompressedSize > limits.worksheetXmlBytes) fail("entry_size_exceeded");
    }
    if (name.toLowerCase() === "xl/sharedstrings.xml" && uncompressedSize > limits.sharedStringsXmlBytes) {
      fail("entry_size_exceeded");
    }
    totalCompressed += compressedSize;
    totalUncompressed += uncompressedSize;
    if (!Number.isSafeInteger(totalCompressed) || !Number.isSafeInteger(totalUncompressed)
      || totalUncompressed > limits.totalUncompressedBytes) {
      fail("total_size_exceeded");
    }
    entries.push({ name, compressedSize, uncompressedSize, flags, compressionMethod, localHeaderOffset, directory });
    cursor = end;
  }
  if (cursor !== eocd) fail("malformed_archive");
  if (worksheetEntries > limits.worksheetCount) fail("worksheet_count_exceeded");
  if ((totalCompressed === 0 && totalUncompressed > 0)
    || (totalCompressed > 0 && totalUncompressed / totalCompressed > limits.compressionRatio)) {
    fail("compression_ratio_exceeded");
  }

  for (const entry of entries) {
    if (entry.localHeaderOffset + 30 > directoryOffset
      || view.getUint32(entry.localHeaderOffset, true) !== LOCAL_FILE_SIGNATURE) {
      fail("malformed_archive");
    }
    const localFlags = view.getUint16(entry.localHeaderOffset + 6, true);
    const localMethod = view.getUint16(entry.localHeaderOffset + 8, true);
    const nameLength = view.getUint16(entry.localHeaderOffset + 26, true);
    const extraLength = view.getUint16(entry.localHeaderOffset + 28, true);
    const dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;
    if (dataOffset + entry.compressedSize > directoryOffset
      || localFlags !== entry.flags || localMethod !== entry.compressionMethod
      || containsZip64Extra(view, entry.localHeaderOffset + 30 + nameLength, extraLength)) {
      fail("malformed_archive");
    }
    const localName = decodeEntryName(
      bytes.subarray(entry.localHeaderOffset + 30, entry.localHeaderOffset + 30 + nameLength),
      (localFlags & 0x800) !== 0,
    );
    if (localName !== entry.name) fail("malformed_archive");
  }
  return entries;
}

function shouldRetainEntry(name: string) {
  const lower = name.toLowerCase();
  return lower === "xl/workbook.xml" || lower === "xl/_rels/workbook.xml.rels"
    || lower === "xl/sharedstrings.xml" || /^xl\/worksheets\/[^/]+\.xml$/i.test(name);
}

async function readEntry(
  object: JSZipObject,
  expectedBytes: number,
  limits: ResolvedLimits,
  total: { bytes: number },
  retain: boolean,
) {
  return new Promise<Buffer | null>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let entryBytes = 0;
    let settled = false;
    const stream = object.nodeStream("nodebuffer") as NodeJS.ReadableStream & { destroy(error?: Error): void };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error instanceof XlsxImportError ? error : new XlsxImportError("malformed_archive"));
    };
    stream.on("data", (value: Buffer | Uint8Array) => {
      if (settled) return;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      entryBytes += chunk.byteLength;
      total.bytes += chunk.byteLength;
      const limitError = entryBytes > limits.entryUncompressedBytes
        ? new XlsxImportError("entry_size_exceeded")
        : total.bytes > limits.totalUncompressedBytes
          ? new XlsxImportError("total_size_exceeded")
          : null;
      if (limitError) {
        rejectOnce(limitError);
        stream.destroy(limitError);
        return;
      }
      if (retain) chunks.push(chunk);
    });
    stream.on("error", rejectOnce);
    stream.on("end", () => {
      if (settled) return;
      if (entryBytes !== expectedBytes) {
        rejectOnce(new XlsxImportError("malformed_archive"));
        return;
      }
      settled = true;
      resolve(retain ? Buffer.concat(chunks, entryBytes) : null);
    });
  });
}

async function extractBoundedXml(bytes: Uint8Array, entries: CentralDirectoryEntry[], limits: ResolvedLimits) {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes, { createFolders: false });
  } catch {
    fail("malformed_archive");
  }
  const retained = new Map<string, Buffer>();
  const total = { bytes: 0 };
  for (const entry of entries) {
    if (entry.directory) continue;
    const object = zip.file(entry.name);
    if (!object) fail("malformed_archive");
    const keep = shouldRetainEntry(entry.name);
    const content = await readEntry(object, entry.uncompressedSize, limits, total, keep);
    if (content) retained.set(entry.name, content);
  }
  return retained;
}

function decodeXml(content: Buffer | undefined) {
  if (!content) return null;
  let xml: string;
  try {
    xml = textDecoder.decode(content);
  } catch {
    fail("malformed_archive");
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) fail("unsafe_xml");
  return xml;
}

function xmlText(value: string) {
  return value.replace(/&#(?:x([0-9a-f]+)|([0-9]+));/gi, (_match, hex: string | undefined, decimal: string | undefined) => {
    const codePoint = Number.parseInt(hex ?? decimal ?? "", hex ? 16 : 10);
    return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint) : "";
  }).replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"").replaceAll("&apos;", "'");
}

function attribute(source: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`(?:^|\\s)${escaped}=(?:"([^"]*)"|'([^']*)')`));
  return match ? xmlText(match[1] ?? match[2] ?? "") : "";
}

function textTags(source: string) {
  return Array.from(source.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g), (match) => xmlText(match[1].replace(/<[^>]+>/g, ""))).join("");
}

function valueTag(source: string) {
  const match = source.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
  return match ? xmlText(match[1].replace(/<[^>]+>/g, "")) : "";
}

function cellColumn(reference: string, limits: ResolvedLimits) {
  const match = reference.match(/^([A-Z]+)[1-9][0-9]*$/i);
  if (!match) fail("malformed_archive");
  const column = match[1].toUpperCase().split("").reduce(
    (sum, letter) => sum * 26 + letter.charCodeAt(0) - 64,
    0,
  ) - 1;
  if (column < 0 || column >= limits.worksheetColumns) fail("malformed_archive");
  return column;
}

function resolveWorksheetTarget(target: string) {
  if (!target || target.includes("\\") || target.includes("\0")) fail("malformed_archive");
  const withoutRoot = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
  const parts: string[] = [];
  for (const part of withoutRoot.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) fail("malformed_archive");
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  const resolved = parts.join("/");
  if (!/^xl\/worksheets\/[^/]+\.xml$/i.test(resolved)) fail("malformed_archive");
  return resolved;
}

function defaultSheetState(name: string): ParsedXlsxSheet["state"] {
  const normalized = name.trim().replace(/\s+/g, " ").toLowerCase();
  if (normalized.includes("obsolete") || normalized.includes("old template")) return "obsolete";
  if (normalized.includes("note") || normalized.includes("narrative")
    || normalized.includes("score") || normalized.includes("assessment")) return "notes_review";
  return "included";
}

function parseWorksheet(xml: string, sharedStrings: string[], limits: ResolvedLimits, counters: { cells: number }) {
  const rows: string[][] = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = [];
    const body = rowMatch[1];
    const declaredCells = Array.from(body.matchAll(/<c\b/g)).length;
    counters.cells += declaredCells;
    if (counters.cells > limits.cellCount) fail("cell_count_exceeded");
    let sequentialColumn = 0;
    for (const cellMatch of body.matchAll(/<c\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1];
      const reference = attribute(attrs, "r");
      const column = reference ? cellColumn(reference, limits) : sequentialColumn;
      sequentialColumn = column + 1;
      if (column >= limits.worksheetColumns) fail("malformed_archive");
      const type = attribute(attrs, "t");
      const cellBody = cellMatch[2] ?? "";
      const raw = type === "inlineStr" ? textTags(cellBody) : valueTag(cellBody);
      if (type === "s") {
        if (!/^\d+$/.test(raw)) fail("malformed_archive");
        const shared = sharedStrings[Number(raw)];
        if (shared === undefined) fail("malformed_archive");
        row[column] = shared;
      } else {
        row[column] = raw;
      }
    }
    const normalized = row.map((value) => value?.trim() ?? "");
    if (normalized.some(Boolean)) rows.push(normalized);
  }
  return rows;
}

export async function parseXlsxImportSheets(
  source: ArrayBuffer | Uint8Array | Buffer,
  overrides?: XlsxImportLimitOverrides,
): Promise<ParsedXlsxSheet[]> {
  const limits = resolveLimits(overrides);
  const bytes = source instanceof Uint8Array
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    : new Uint8Array(source);
  const entries = inspectCentralDirectory(bytes, limits);
  const xmlEntries = await extractBoundedXml(bytes, entries, limits);
  const byLowerName = new Map(Array.from(xmlEntries, ([name, content]) => [name.toLowerCase(), { name, content }]));
  const workbookXml = decodeXml(byLowerName.get("xl/workbook.xml")?.content);
  const relationshipsXml = decodeXml(byLowerName.get("xl/_rels/workbook.xml.rels")?.content);
  if (!workbookXml || !relationshipsXml) fail("malformed_archive");
  const sharedStringsXml = decodeXml(byLowerName.get("xl/sharedstrings.xml")?.content);
  const sharedStrings = sharedStringsXml
    ? Array.from(sharedStringsXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g), (match) => textTags(match[1]))
    : [];

  const relationships = new Map<string, string>();
  for (const match of relationshipsXml.matchAll(/<Relationship\b([^>]*?)(?:\/\s*>|>)/g)) {
    const id = attribute(match[1], "Id");
    const target = attribute(match[1], "Target");
    const targetMode = attribute(match[1], "TargetMode");
    if (!id || !target || targetMode.toLowerCase() === "external" || relationships.has(id)) {
      fail("malformed_archive");
    }
    relationships.set(id, target);
  }

  const workbookSheets = Array.from(workbookXml.matchAll(/<sheet\b([^>]*?)(?:\/\s*>|>)/g), (match) => ({
    name: attribute(match[1], "name") || "Sheet",
    relationshipId: attribute(match[1], "r:id"),
  }));
  if (workbookSheets.length === 0 || workbookSheets.length > limits.worksheetCount) {
    fail(workbookSheets.length === 0 ? "malformed_archive" : "worksheet_count_exceeded");
  }
  const counters = { cells: 0 };
  let includedRows = 0;
  const result: ParsedXlsxSheet[] = [];
  const usedTargets = new Set<string>();
  for (const sheet of workbookSheets) {
    const relationshipTarget = relationships.get(sheet.relationshipId);
    if (!sheet.relationshipId || !relationshipTarget) fail("malformed_archive");
    const target = resolveWorksheetTarget(relationshipTarget);
    if (usedTargets.has(target.toLowerCase())) fail("malformed_archive");
    usedTargets.add(target.toLowerCase());
    const worksheetXml = decodeXml(byLowerName.get(target.toLowerCase())?.content);
    if (!worksheetXml) fail("malformed_archive");
    const state = defaultSheetState(sheet.name);
    const rows = parseWorksheet(worksheetXml, sharedStrings, limits, counters);
    if (state === "included") {
      includedRows += Math.max(0, rows.length - 1);
      if (includedRows > limits.includedDataRows) fail("row_count_exceeded");
    }
    result.push({ name: sheet.name, state, rows });
  }
  return result;
}
