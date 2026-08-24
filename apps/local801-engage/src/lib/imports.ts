import { z } from "zod";
import { createHash } from "node:crypto";
import { parseXlsxImportSheets } from "./xlsx-import.ts";

export { XLSX_IMPORT_LIMITS, XlsxImportError, parseXlsxImportSheets } from "./xlsx-import.ts";

export const importKindSchema = z.enum([
  "current_roster",
  "new_hires",
  "recent_hires",
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
  "work_phone",
  "personal_email",
  "home_email",
  "cell_phone",
  "home_phone",
  "first_name",
  "preferred_name",
  "last_name",
  "membership_status",
  "department",
  "section",
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
  "work phone": "work_phone",
  "business phone": "work_phone",
  "home email": "home_email",
  "personal email": "personal_email",
  "cell phone": "cell_phone",
  "mobile phone": "cell_phone",
  "home phone": "home_phone",
  firstname: "first_name",
  "first name": "first_name",
  "preferred first name": "preferred_name",
  "preferred/first name": "preferred_name",
  lastname: "last_name",
  "last name": "last_name",
  member: "membership_status",
  type: "membership_status",
  "person type": "membership_status",
  "member type": "membership_status",
  "membership status": "membership_status",
  agency: "department",
  department: "department",
  "department name": "department",
  section: "section",
  "section name": "section",
  location: "work_location",
  "work location": "work_location",
  "location name": "work_location",
  "office name": "work_location",
  class: "classification",
  classification: "classification",
  "classification name": "classification",
  "hire date": "hire_date",
  "mape hire date": "hire_date",
  "job status": "job_status",
  "employment status": "job_status",
};

const authoritativeIdentifierColumns: Array<(typeof canonicalRosterColumns)[number]> = [
  "member_identifier",
  "employee_identifier",
  "work_email",
  "personal_email",
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
  const normalized = String(localValue ?? "").trim();
  return /(?:^|\D)0?801(?:\D|$)/.test(normalized);
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

export function normalizeImportDate(value: string | null | undefined) {
  const text = value?.trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const date = new Date(`${text}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text ? text : null;
  }
  if (/^\d{1,5}(?:\.\d+)?$/.test(text)) {
    const serial = Number(text);
    if (!Number.isFinite(serial) || serial < 1 || serial > 100_000) return null;
    const date = new Date(Date.UTC(1899, 11, 30) + Math.trunc(serial) * 86_400_000);
    const iso = date.toISOString().slice(0, 10);
    return iso >= "1900-01-01" && iso <= "2100-12-31" ? iso : null;
  }
  const slash = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!slash) return null;
  const iso = `${slash[3]}-${slash[1].padStart(2, "0")}-${slash[2].padStart(2, "0")}`;
  const date = new Date(`${iso}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : null;
}

export function normalizeMembershipStatus(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (normalized === "member") return "member";
  if (normalized === "nonmember") return "nonmember";
  if (normalized === "unknown") return "unknown";
  return null;
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
  return parseXlsxImportSheets(buffer);
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
    if (!header.mappedTo) return;
    const value = stringifyCell(cells[index]);
    values[header.mappedTo] = header.mappedTo === "hire_date"
      ? normalizeImportDate(value)
      : header.mappedTo === "membership_status"
        ? normalizeMembershipStatus(value)
        : value;
  });
  if (!values.first_name && values.preferred_name) values.first_name = values.preferred_name;
  if (!values.home_email && values.personal_email) values.home_email = values.personal_email;
  if (!values.personal_email && values.home_email) values.personal_email = values.home_email;
  // Local 801 uses Section Name as the operational work-location grouping.
  // Preserve section as its own field and make it authoritative for work_location.
  if (values.section) values.work_location = values.section;
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
    const values = normalizeImportRow(headers ?? [], cells);

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
