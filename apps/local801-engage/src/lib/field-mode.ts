import { safeReturnPath } from "./safe-return-path.ts";

export type FieldModeContext = {
  enabled: boolean;
  scope: "assigned" | "authorized";
  focus: "all" | "attention" | "never-engaged" | "stale";
  limit: 25 | 50;
};

function scalar(value: unknown) {
  if (Array.isArray(value)) return scalar(value[0]);
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeFieldModeContext(input: Record<string, unknown>): FieldModeContext {
  const scope = scalar(input.scope) === "authorized" ? "authorized" : "assigned";
  const focusValue = scalar(input.focus);
  const focus = focusValue === "attention" || focusValue === "never-engaged" || focusValue === "stale"
    ? focusValue
    : "all";
  const limit = scalar(input.limit) === "50" ? 50 : 25;
  return {
    enabled: scalar(input.field) === "1",
    scope,
    focus,
    limit,
  };
}

export function fieldQueueHref(context: Pick<FieldModeContext, "scope" | "focus" | "limit">) {
  const params = new URLSearchParams({
    field: "1",
    scope: context.scope,
    focus: context.focus,
    limit: String(context.limit),
  });
  return `/outreach?${params.toString()}`;
}

export function fieldPersonHref(
  employeeHandle: string,
  context: Pick<FieldModeContext, "scope" | "focus" | "limit">,
) {
  const params = new URLSearchParams({
    field: "1",
    scope: context.scope,
    focus: context.focus,
    limit: String(context.limit),
  });
  return `/outreach/${encodeURIComponent(employeeHandle)}/field?${params.toString()}`;
}

export function fieldContactHref(
  employeeHandle: string,
  context: Pick<FieldModeContext, "scope" | "focus" | "limit">,
) {
  const params = new URLSearchParams({
    field: "1",
    scope: context.scope,
    focus: context.focus,
    limit: String(context.limit),
  });
  return `/outreach/${encodeURIComponent(employeeHandle)}/contact?${params.toString()}`;
}

export function outreachReturnPath(value: unknown) {
  const candidate = safeReturnPath(value);
  return candidate === "/outreach" || candidate.startsWith("/outreach?") ? candidate : "/outreach";
}

export function member360Href(employeeHandle: string, returnTo: unknown) {
  const params = new URLSearchParams({ returnTo: outreachReturnPath(returnTo) });
  return `/outreach/${encodeURIComponent(employeeHandle)}?${params.toString()}`;
}

export function member360ContactHref(employeeHandle: string, returnTo: unknown) {
  const params = new URLSearchParams({ returnTo: outreachReturnPath(returnTo) });
  return `/outreach/${encodeURIComponent(employeeHandle)}/contact?${params.toString()}`;
}

export function fieldContextFromOutreachReturnPath(returnTo: unknown) {
  const parsed = new URL(outreachReturnPath(returnTo), "https://engaging.local801.invalid");
  return normalizeFieldModeContext(Object.fromEntries(parsed.searchParams.entries()));
}

export function member360FieldHref(employeeHandle: string, returnTo: unknown) {
  return fieldPersonHref(employeeHandle, fieldContextFromOutreachReturnPath(returnTo));
}
