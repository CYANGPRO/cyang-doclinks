import type { NextRequest } from "next/server";
import { protectRequest } from "@/lib/authz.server";

export function proxy(request: NextRequest) {
  return protectRequest(request);
}

export const config = {
  matcher: [
    "/",
    "/audit/:path*",
    "/campaigns/:path*",
    "/cat-actions/:path*",
    "/directory/:path*",
    "/documents/:path*",
    "/email-broadcasts/:path*",
    "/follow-ups/:path*",
    "/imports/:path*",
    "/membership/:path*",
    "/new-hires/:path*",
    "/notifications/:path*",
    "/outreach/:path*",
    "/reports/:path*",
    "/settings/:path*",
    "/team/:path*",
    "/workload/:path*",
  ],
};
