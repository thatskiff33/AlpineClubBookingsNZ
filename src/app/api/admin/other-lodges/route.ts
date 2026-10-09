import { NextResponse } from "next/server";
import {
  otherLodgeOrderBy,
  otherLodgeSelect,
  serializeOtherLodgeForAdmin,
  type AdminOtherLodgesResponse,
} from "@/lib/other-lodges";
import { prisma } from "@/lib/prisma";
import { loadServerNzSettings } from "@/lib/servernz-settings";
import { readStoredServerVersion } from "@/lib/servernz-version-check";
import { requireAdmin } from "@/lib/session-guards";

// READ ONLY. The create handler that lived here was removed by #52: a site
// changes only the lodge(s) the central server says it owns, and those arrive
// by download — nothing is created here. A POST now answers 405 from Next.js.
//
// The response carries the owned list in its three states (`null` = the server
// has never said, `[]` = owns none) so the panel can explain itself, and each
// row's `owned` flag is the route's own `ownsOtherLodge` answer. Another club's
// booking officer PHONE is not sent at all (`serializeOtherLodgeForAdmin`).

export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const [otherLodges, settings, version] = await Promise.all([
    prisma.otherLodge.findMany({
      orderBy: otherLodgeOrderBy(),
      select: otherLodgeSelect,
    }),
    loadServerNzSettings(),
    // The STORED answer (#49): no network call from a list read.
    readStoredServerVersion(),
  ]);
  const owned = settings.otherLodgesOwnedNames;

  const body: AdminOtherLodgesResponse = {
    otherLodges: otherLodges.map((lodge) => serializeOtherLodgeForAdmin(lodge, owned)),
    ownedLodgeNames: owned,
    serverVersionStatus: version.status,
  };
  return NextResponse.json(body);
}
