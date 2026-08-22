import { androidAssetLinks } from "@/lib/mobile-associations";

export function GET() {
  return Response.json(androidAssetLinks(), {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
