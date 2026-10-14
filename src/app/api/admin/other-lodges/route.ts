import { NextResponse } from "next/server";
import {
  otherLodgeOrderBy,
  otherLodgeSelect,
  serializeOtherLodgeForAdmin,
  type AdminOtherLodgesResponse,
  type OtherLodgeReferences,
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
//
// A row with no central id once the registry IS keyed (#64) is one the central
// server no longer has — a duplicate left by a rename before #64, or a lodge
// deleted there. It is marked, with what still cites it, so an administrator
// can assess it; nothing removes it here (deletion is #58). Before any row is
// keyed (a site that has not downloaded since upgrading) nothing is marked.
async function unkeyedLodgeReferences(
  lodges: ReadonlyArray<{ id: string; centralId: string | null }>,
): Promise<Map<string, OtherLodgeReferences>> {
  if (!lodges.some((l) => l.centralId)) return new Map();
  const unkeyed = lodges.filter((l) => !l.centralId).map((l) => l.id);
  if (unkeyed.length === 0) return new Map();
  const rows = await prisma.otherLodge.findMany({
    where: { id: { in: unkeyed } },
    select: { id: true, _count: { select: { bookings: true, bookingRequests: true } } },
  });
  return new Map(
    rows.map((r) => [
      r.id,
      { bookings: r._count.bookings, bookingRequests: r._count.bookingRequests },
    ]),
  );
}

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
  const notOnCentralServer = await unkeyedLodgeReferences(otherLodges);

  const body: AdminOtherLodgesResponse = {
    otherLodges: otherLodges.map((lodge) =>
      serializeOtherLodgeForAdmin(lodge, owned, notOnCentralServer.get(lodge.id)),
    ),
    ownedLodgeNames: owned,
    serverVersionStatus: version.status,
  };
  return NextResponse.json(body);
}
