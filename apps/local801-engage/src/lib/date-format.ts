const CAT_TIME_ZONE = "America/Chicago";
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const catDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "2-digit",
  day: "2-digit",
  year: "numeric",
  timeZone: CAT_TIME_ZONE,
});

const utcDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "2-digit",
  day: "2-digit",
  year: "numeric",
  timeZone: "UTC",
});

const catDateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  month: "2-digit",
  day: "2-digit",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: CAT_TIME_ZONE,
});

function parsedDate(value: string | Date) {
  if (value instanceof Date) return value;
  return DATE_ONLY.test(value) ? new Date(`${value}T00:00:00Z`) : new Date(value);
}

export function formatCatDate(value: string | Date | null | undefined, fallback = "Not recorded") {
  if (!value) return fallback;
  const date = parsedDate(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return typeof value === "string" && DATE_ONLY.test(value)
    ? utcDateFormatter.format(date)
    : catDateFormatter.format(date);
}

export function formatCatDateTime(value: string | Date | null | undefined, fallback = "Not recorded") {
  if (!value) return fallback;
  const date = parsedDate(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return catDateTimeFormatter.format(date);
}

export const __testing = { CAT_TIME_ZONE };
