import "server-only";

import { clubTime } from "@/lib/club-time/server";

/** Neutral filename: portable between clubs, without embedding subject identifiers. */
export async function subjectAccessExportResponse(payload: unknown): Promise<Response> {
  const club = await clubTime();
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="my-data-${club.today()}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
