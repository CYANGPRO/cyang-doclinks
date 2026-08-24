import "server-only";

import { NextResponse } from "next/server";
import type { RateLimitError } from "./rate-limit.ts";

export function rateLimitResponse(error: RateLimitError) {
  return NextResponse.json(
    { error: error.code, message: error.message },
    {
      status: error.status,
      headers: {
        "Cache-Control": "private, no-store, max-age=0, must-revalidate",
        "Retry-After": String(error.retryAfterSeconds),
      },
    },
  );
}
