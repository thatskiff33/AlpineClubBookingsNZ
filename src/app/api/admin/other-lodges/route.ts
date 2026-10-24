import { NextResponse } from "next/server";
import {
  isNotOnCentralServer,
  otherLodgeOrderBy,
  otherLodgeSelect,
  serializeOtherLodgeForAdmin,
  type AdminOtherLodgesResponse,
  type OtherLodgeReferences,
  visibleOtherLodgeWhere,
} from "@/lib/other-lodges";
import { otherLodgeFeesProblem } from "@/lib/other-lodge-fees-sync";
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
// A HIDDEN lodge (#58) is not listed at all: deleted on the central server, or
// hidden by an administrator, it is kept only for the bookings and requests
// that name it, where it still shows.
//
// A row the central server does not list (`isNotOnCentralServer`, #64) is
// marked, with what still cites it, so an administrator can assess it and hide
// it (#58): usually a duplicate left by a rename before #64, or a lodge deleted
// there before it told clubs about deletions. Before a whole-registry download
// has keyed the registry (a site not yet downloaded since upgrading) nothing is
// marked.
async function unkeyedLodgeReferences(
  lodges: ReadonlyArray<{ id: string; centralId: string | null }>,
  keyedAt: string | null,
): Promise<Map<string, OtherLodgeReferences>> {
  const unkeyed = lodges.filter((l) => isNotOnCentralServer(l, keyedAt)).map((l) => l.id);
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
      where: visibleOtherLodgeWhere,
      orderBy: otherLodgeOrderBy(),
      select: otherLodgeSelect,
    }),
    loadServerNzSettings(),
    // The STORED answer (#49): no network call from a list read.
    readStoredServerVersion(),
  ]);
  const owned = settings.otherLodgesOwnedLodges;
  const notOnCentralServer = await unkeyedLodgeReferences(
    otherLodges,
    settings.otherLodgesKeyedAt,
  );

  const body: AdminOtherLodgesResponse = {
    otherLodges: await Promise.all(
      otherLodges.map(async (lodge) => {
        const row = serializeOtherLodgeForAdmin(lodge, owned, notOnCentralServer.get(lodge.id));
        // Why the Fees page cannot fill our own lodge now (#77), for its editor.
        const feesProblem = row.owned ? await otherLodgeFeesProblem(lodge, owned) : null;
        return feesProblem ? { ...row, feesProblem } : row;
      }),
    ),
    // The panel's notes name the owned lodges; the rows carry `owned` (#69).
    ownedLodgeNames: owned === null ? null : owned.map((l) => l.name),
    serverVersionStatus: version.status,
  };
  return NextResponse.json(body);
}
