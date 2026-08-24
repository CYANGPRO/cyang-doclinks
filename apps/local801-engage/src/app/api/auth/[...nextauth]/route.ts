import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth-options";
import { productionAuthRuntimeEnabled } from "@/lib/production-launch-policy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const nextAuthHandler = NextAuth(authOptions);

async function guarded(request: Request, context: unknown) {
  if (!productionAuthRuntimeEnabled()) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404, headers: { "Cache-Control": "private, no-store" } });
  }
  return nextAuthHandler(request, context as never);
}

export const GET = guarded;
export const POST = guarded;
