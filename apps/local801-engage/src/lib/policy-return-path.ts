import { safeReturnPath } from "./safe-return-path.ts";

export function safePolicyReturnPath(value: unknown) {
  const path = safeReturnPath(value);
  return path === "/privacy" || path.startsWith("/privacy?") ? "/" : path;
}
