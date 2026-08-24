const RETURN_BASE = "https://engaging.local801.invalid";
const CONTROL_OR_BACKSLASH = /[\\\u0000-\u001f\u007f]/;

export function safeReturnPath(value: unknown) {
  if (typeof value !== "string") return "/";
  const candidate = value.trim();
  if (!candidate.startsWith("/") || candidate.startsWith("//") || candidate.length > 2_048 || CONTROL_OR_BACKSLASH.test(candidate)) return "/";
  try {
    const parsed = new URL(candidate, RETURN_BASE);
    if (parsed.origin !== RETURN_BASE || parsed.pathname === "/sign-in" || parsed.pathname.startsWith("/api/")) return "/";
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "/";
  }
}
