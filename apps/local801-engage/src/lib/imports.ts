import { z } from "zod";
import JSZip from "jszip";
import { createHash } from "node:crypto";

export const importKindSchema = z.enum([
  "current_roster",
  "new_hires",
  "membership_additions",
  "membership_drops",
  "legacy_cat",
]);

export type ImportKind = z.infer<typeof importKindSchema>;

export const canonicalRosterColumns = [
  "member_identifier",
  "employee_identifier",
  "local",
  "work_email",
  "home_email",
  "work_phone",
  "cell_phone",
  "home_phone",
  "first_name",
  "last_name",
  "membership_status",
  "department",
  "work_location",
  "classification",
  "hire_date",
  "job_status",
] as const;

export const knownColumnAliases: Record<string, (typeof canonicalRosterColumns)[number]> = {
  "member id": "member_identifier",
  "membership id": "member_identifier",
  "member identifier": "member_identifier",
  "employee id": "employee_identifier",
  "emplid": "employee_identifier",
  "employee identifier": "employee_identifier",
  "person id": "employee_identifier",
  local: "local",
  "local name": "local",
  "local #": "local",
  "local number": "local",
  email: "work_email",
  "work email": "work_email",
  "state email": "work_email",
  "home email": "home_email",
  "personal email": "home_email",
  "work phone": "work_phone",
  "cell phone": "cell_phone",
  "mobile phone": "cell_phone",
  "home phone": "home_phone",
  firstname: "first_name",
  "first name": "first_name",
  "preferred first name": "first_name",
  "preferred/first name": "first_name",
  lastname: "last_name",
  "last name": "last_name",
  member: "membership_status",
  type: "membership_status",
  "person type": "membership_status",
  "membership status": "membership_status",
  agency: "department",
  department: "department",
  location: "work_location",
  "work location": "work_location",
  "section name": "work_location",
  class: "classification",
  classification: "classification",
  "hire date": "hire_date",
  "mape hire date": "hire_date",
  "appointment employment status name": "job_status",
  "employment status": "job_status",
  "job status": "job_status",
};

const authoritativeIdentifierColumns: Array<(typeof canonicalRosterColumns)[number]> = [
  "member_identifier",
  "employee_identifier",
  "work_email",
];

export type ImportValidationError = {
  rowNumber: number;
  identifier: string | null;
  field: string;
  code:
    | "missing_identifier"
    | "duplicate_identifier"
    | "conflicting_record"
    | "missing_required_field"
    | "unsupported_file"
    | "empty_file"
    | "row_limit_exceeded";
  message: string;
};

export type ImportPreviewRow = {
  rowNumber: number;
  identifier: string | null;
  action: "create" | "update_candidate" | "reject";
  values: Record<string, string | null>;
};

export type ImportValidationSummary = {
  sourceFilename: string;
  importingUser: string;
  importedAt: string;
  totalRows: number;
  acceptedRows: number;
  rejectedRows: number;
  duplicateIdentifiers: number;
  missingIdentifiers: number;
  conflictingRecords: number;
  identifierColumns: string[];
  errors: ImportValidationError[];
  previewRows: ImportPreviewRow[];
  transactional: true;
  audit: {
    eventType: "import.preview";
    sourceFilename: string;
    actorId: string;
    counts: {
      totalRows: number;
      acceptedRows: number;
      rejectedRows: number;
    };
  };
};

export function normalizeHeader(header: string) {
  return header.trim().replace(/\s+/g, " ").toLowerCase();
}

export function mapHeaders(headers: string[]) {
  return headers.map((header) => ({
    source: header,
    normalized: normalizeHeader(header),
    mappedTo: knownColumnAliases[normalizeHeader(header)] ?? null,
  }));
}

export function shouldIncludeLocal801(localValue: string | null | undefined) {
  const normalized = String(localValue ?? "").trim().padStart(4, "0");
  return normalized === "0801";
}

export function neutralizeSpreadsheetFormula(value: unknown) {
  if (typeof value !== "string") return value;
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

export function classifyLegacyWorksheet(name: string) {
  const normalized = normalizeHeader(name);
  if (normalized.includes("obsolete") || normalized.includes("old template")) return "ignore_by_default";
  if (normalized.includes("note") || normalized.includes("narrative")) return "review_notes";
  if (normalized.includes("score") || normalized.includes("assessment")) return "review_scores";
  return "structured_review";
}

function stringifyCell(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object" && "text" in value && typeof value.text === "string") return value.text.trim() || null;
  if (typeof value === "object" && "result" in value) return stringifyCell(value.result);
  const text = String(value).trim();
  return text ? String(neutralizeSpreadsheetFormula(text)) : null;
}

function excelSerialDate(value: string) {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return null;
  const serial = Number(value);
  if (!Number.isFinite(serial) || serial < 1 || serial > 2_958_465) return null;
  const date = new Date(Math.round((serial - 25_569) * 86_400_000));
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function normalizedDate(value: string) {
  const serial = excelSerialDate(value);
  if (serial) return serial;
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return value;
  const us = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!us) return value;
  const [, month, day, year] = us;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return value;
  return date.toISOString().slice(0, 10);
}

function normalizedMembershipStatus(value: string) {
  const status = value.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (status === "member") return "member";
  if (["nonmember", "nonmem", "agencyfee", "fairshare"].includes(status)) return "nonmember";
  return "unknown";
}

function normalizedPhone(value: string) {
  const digits = value.replace(/\D/g, "");
  if (!digits || /^0+$/.test(digits)) return null;
  return value;
}

function normalizeCanonicalValue(column: (typeof canonicalRosterColumns)[number], value: unknown) {
  const text = stringifyCell(value);
  if (!text) return null;
  if (column === "hire_date") return normalizedDate(text);
  if (column === "membership_status") return normalizedMembershipStatus(text);
  if (column === "work_phone" || column === "cell_phone" || column === "home_phone") return normalizedPhone(text);
  return text;
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function xmlText(value: string) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

function cellColumn(ref: string) {
  const letters = ref.replace(/[^A-Z]/gi, "").toUpperCase();
  return letters.split("").reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function extractXmlTag(xml: string, tag: string) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return match ? xmlText(match[1].replace(/<[^>]+>/g, "")) : "";
}

async function rowsFromXlsx(buffer: ArrayBuffer) {
  const sheets = await sheetsFromXlsx(buffer);
  const selected = sheets.find((sheet) => sheet.state !== "obsolete" && sheet.state !== "ignored");
  return selected?.rows ?? [];
}

export type ParsedImportSheet = {
  name: string;
  state: "included" | "ignored" | "obsolete" | "notes_review";
  rows: string[][];
};

async function sheetsFromXlsx(buffer: ArrayBuffer): Promise<ParsedImportSheet[]> {
  const zip = await JSZip.loadAsync(buffer);
  const sharedStringsXml = await zip.file("xl/sharedStrings.xml")?.async("string");
  const sharedStrings = sharedStringsXml
    ? Array.from(sharedStringsXml.matchAll(/<si[^>]*>([\s\S]*?)<\/si>/g)).map((match) => extractXmlTag(match[1], "t"))
    : [];

  const workbookXml = await zip.file("xl/workbook.xml")?.async("string");
  const relsXml = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
  if (!workbookXml || !relsXml) return [];

  const sheets = Array.from(workbookXml.matchAll(/<sheet\b([^>]*)\/>/g)).map((match) => ({
    name: match[1].match(/\bname="([^"]+)"/)?.[1] ?? "Sheet",
    relId: match[1].match(/\br:id="([^"]+)"/)?.[1] ?? "",
  }));
  const rels = Object.fromEntries(
    Array.from(relsXml.matchAll(/<Relationship\b([^>]*)\/>/g)).map((match) => [
      match[1].match(/\bId="([^"]+)"/)?.[1] ?? "",
      match[1].match(/\bTarget="([^"]+)"/)?.[1] ?? "",
    ]),
  );
  return Promise.all(sheets.map(async (sheet) => {
    const target = rels[sheet.relId]?.replace(/^\//, "");
    const sheetPath = target?.startsWith("xl/") ? target : `xl/${target}`;
    const sheetXml = sheetPath ? await zip.file(sheetPath)?.async("string") : null;
    const rows = sheetXml
      ? Array.from(sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g))
          .map((rowMatch) => {
            const row: string[] = [];
            for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
              const attrs = cellMatch[1];
              const ref = attrs.match(/\br="([^"]+)"/)?.[1] ?? "";
              const index = ref ? cellColumn(ref) : row.length;
              const type = attrs.match(/\bt="([^"]+)"/)?.[1] ?? "";
              const raw = extractXmlTag(cellMatch[2], type === "inlineStr" ? "t" : "v");
              row[index] = type === "s" ? sharedStrings[Number(raw)] ?? "" : raw;
            }
            return row.map((value) => stringifyCell(value) ?? "");
          })
          .filter((row) => row.some((value) => value.trim()))
      : [];
    const classification = classifyLegacyWorksheet(sheet.name);
    return {
      name: sheet.name,
      state: classification === "ignore_by_default"
        ? "obsolete"
        : classification === "review_notes" || classification === "review_scores"
          ? "notes_review"
          : "included",
      rows,
    } as ParsedImportSheet;
  }));
}

export async function rowsFromImportFile(file: File) {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".xls")) {
    throw Object.assign(new Error("Legacy .xls files are not accepted for preview import."), {
      code: "unsupported_file",
    });
  }
  if (lower.endsWith(".csv") || file.type.includes("csv")) {
    return parseCsv(await file.text());
  }
  if (lower.endsWith(".xlsx") || file.type.includes("spreadsheetml")) {
    return rowsFromXlsx(await file.arrayBuffer());
  }
  throw Object.assign(new Error("Only .xlsx and .csv files are accepted."), {
    code: "unsupported_file",
  });
}

export async function parseImportSheets(file: File): Promise<ParsedImportSheet[]> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".xls")) {
    throw Object.assign(new Error("Legacy .xls files are not accepted for preview import."), { code: "unsupported_file" });
  }
  if (lower.endsWith(".csv") || file.type.includes("csv")) {
    return [{ name: "CSV", state: "included", rows: parseCsv(await file.text()) }];
  }
  if (lower.endsWith(".xlsx") || file.type.includes("spreadsheetml")) {
    return sheetsFromXlsx(await file.arrayBuffer());
  }
  throw Object.assign(new Error("Only .xlsx and .csv files are accepted."), { code: "unsupported_file" });
}

export function stableRowHash(values: Record<string, string | null>) {
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b))));
  return createHash("sha256").update(canonical).digest("hex");
}

export function normalizeImportRow(headers: string[], cells: string[]) {
  const values: Record<string, string | null> = {};
  mapHeaders(headers).forEach((header, index) => {
    if (header.mappedTo) values[header.mappedTo] = normalizeCanonicalValue(header.mappedTo, cells[index]);
  });
  return values;
}

export function recognizedMappings(headers: string[]) {
  return mapHeaders(headers)
    .filter((header): header is typeof header & { mappedTo: (typeof canonicalRosterColumns)[number] } => Boolean(header.mappedTo))
    .map((header) => ({ sourceColumn: header.source, targetColumn: header.mappedTo, transform: null }));
}

function pickIdentifier(row: Record<string, string | null>) {
  for (const column of authoritativeIdentifierColumns) {
    const value = row[column];
    if (value) return { column, value: value.toLowerCase() };
  }
  return { column: null, value: null };
}

function conflictFields(current: Record<string, string | null>, next: Record<string, string | null>) {
  return ["first_name", "last_name", "membership_status", "department", "work_location", "classification", "hire_date", "job_status", "work_email", "home_email", "work_phone", "cell_phone", "home_phone"].filter(
    (field) => current[field] && next[field] && current[field] !== next[field],
  );
}

export function validateImportRows(args: {
  rows: string[][];
  sourceFilename: string;
  importingUser: string;
  importedAt?: string;
  maxRows?: number;
}): ImportValidationSummary {
  const [headers, ...bodyRows] = args.rows;
  const importedAt = args.importedAt ?? new Date().toISOString();
  const errors: ImportValidationError[] = [];
  const previewRows: ImportPreviewRow[] = [];

  if (!headers?.length) {
    errors.push({
      rowNumber: 0,
      identifier: null,
      field: "file",
      code: "empty_file",
      message: "The import file does not contain a header row.",
    });
  }

  const mappedHeaders = mapHeaders(headers ?? []);
  const identifierColumns = mappedHeaders
    .filter((header) => header.mappedTo && authoritativeIdentifierColumns.includes(header.mappedTo))
    .map((header) => header.source);

  const seen = new Map<string, Record<string, string | null>>();
  const maxRows = args.maxRows ?? 10000;

  if (bodyRows.length > maxRows) {
    errors.push({
      rowNumber: 0,
      identifier: null,
      field: "file",
      code: "row_limit_exceeded",
      message: `The import contains ${bodyRows.length} rows, exceeding the configured limit of ${maxRows}.`,
    });
  }

  bodyRows.slice(0, maxRows).forEach((cells, index) => {
    const rowNumber = index + 2;
    const values: Record<string, string | null> = {};
    mappedHeaders.forEach((header, headerIndex) => {
      if (!header.mappedTo) return;
      values[header.mappedTo] = normalizeCanonicalValue(header.mappedTo, cells[headerIndex]);
    });

    if (values.local && !shouldIncludeLocal801(values.local)) return;

    const identifier = pickIdentifier(values);
    let action: ImportPreviewRow["action"] = "create";
    if (!identifier.value) {
      action = "reject";
      errors.push({
        rowNumber,
        identifier: null,
        field: "identifier",
        code: "missing_identifier",
        message: "Rows require an authoritative identifier; names are not used for merging.",
      });
    } else if (seen.has(identifier.value)) {
      action = "reject";
      const conflicts = conflictFields(seen.get(identifier.value) ?? {}, values);
      errors.push({
        rowNumber,
        identifier: identifier.value,
        field: identifier.column ?? "identifier",
        code: "duplicate_identifier",
        message: `Duplicate authoritative identifier '${identifier.value}' detected.`,
      });
      if (conflicts.length > 0) {
        errors.push({
          rowNumber,
          identifier: identifier.value,
          field: conflicts.join(","),
          code: "conflicting_record",
          message: `Duplicate identifier has conflicting values for ${conflicts.join(", ")}.`,
        });
      }
    } else {
      seen.set(identifier.value, values);
      action = "update_candidate";
    }

    previewRows.push({
      rowNumber,
      identifier: identifier.value,
      action,
      values,
    });
  });

  const rejectedRows = new Set(errors.map((error) => error.rowNumber).filter(Boolean)).size;
  const totalRows = previewRows.length;

  return {
    sourceFilename: args.sourceFilename,
    importingUser: args.importingUser,
    importedAt,
    totalRows,
    acceptedRows: totalRows - rejectedRows,
    rejectedRows,
    duplicateIdentifiers: errors.filter((error) => error.code === "duplicate_identifier").length,
    missingIdentifiers: errors.filter((error) => error.code === "missing_identifier").length,
    conflictingRecords: errors.filter((error) => error.code === "conflicting_record").length,
    identifierColumns,
    errors,
    previewRows: previewRows.slice(0, 50),
    transactional: true,
    audit: {
      eventType: "import.preview",
      sourceFilename: args.sourceFilename,
      actorId: args.importingUser,
      counts: {
        totalRows,
        acceptedRows: totalRows - rejectedRows,
        rejectedRows,
      },
    },
  };
}

export function validationErrorsToCsv(errors: ImportValidationError[]) {
  const header = ["rowNumber", "identifier", "field", "code", "message"];
  const escape = (value: unknown) => {
    const text = String(neutralizeSpreadsheetFormula(value ?? ""));
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [header.join(","), ...errors.map((error) => header.map((key) => escape(error[key as keyof ImportValidationError])).join(","))].join("\n");
}
