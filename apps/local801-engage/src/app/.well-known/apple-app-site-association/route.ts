import { appleAppSiteAssociation } from "@/lib/mobile-associations";

export function GET() {
  return Response.json(appleAppSiteAssociation(), {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
