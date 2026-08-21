export function hasExactSameOrigin(request: Pick<Request, "headers" | "url">) {
  const suppliedOrigin = request.headers.get("origin");
  if (!suppliedOrigin) return false;
  try {
    return suppliedOrigin === new URL(request.url).origin;
  } catch {
    return false;
  }
}
