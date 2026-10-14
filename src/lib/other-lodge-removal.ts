import "server-only";
import { Prisma } from "@prisma/client";
import { otherLodgeSelect, type OtherLodgeRecord } from "@/lib/other-lodges";
import { prisma } from "@/lib/prisma";
import { loadServerNzSettings } from "@/lib/servernz-settings";

/**
 * An administrator removing an Other lodges row by hand (#58) — ONLY a row the
 * central server does not list, and only one nothing here refers to.
 *
 * #52 removed delete for other clubs' lodges on purpose: the server's registry
 * is authoritative, and a lodge it still lists would only come back. This is
 * the narrow exception for the rows it does NOT list — duplicates left by a
 * rename before #64, and lodges deleted there before it told clubs about
 * deletions (#58, API 2.4). The test for "not listed" is the same one the panel
 * marks them by: after a whole-registry download has keyed the registry
 * (`ServerNzSettings.otherLodgesKeyedAt`), the row still has no central id.
 *
 * A row a booking or booking request cites is never removed (the foreign keys
 * are Restrict); the refusal says so. The delete is guarded on `centralId` still
 * being null, so a download that keyed the row meanwhile wins.
 */
export type OtherLodgeRemoval =
  | { ok: true; removed: OtherLodgeRecord }
  | { ok: false; status: 404 | 409; error: string };

export async function removeUnlistedOtherLodge(id: string): Promise<OtherLodgeRemoval> {
  const { otherLodgesKeyedAt } = await loadServerNzSettings();
  const row = await prisma.otherLodge.findUnique({
    where: { id },
    select: {
      ...otherLodgeSelect,
      _count: { select: { bookings: true, bookingRequests: true } },
    },
  });
  if (!row) return { ok: false, status: 404, error: "Lodge not found" };

  const listedRefusal = {
    ok: false as const,
    status: 409 as const,
    error:
      "Only a lodge marked “Not found on the Alpine Central Server” can be removed here. Lodges the central server lists are kept in step with it.",
  };
  if (!otherLodgesKeyedAt || row.centralId !== null) return listedRefusal;

  const { _count: references, ...lodge } = row;
  const referencedRefusal = {
    ok: false as const,
    status: 409 as const,
    error:
      "This lodge cannot be removed: bookings or booking requests still refer to it.",
  };
  if (references.bookings + references.bookingRequests > 0) return referencedRefusal;

  try {
    const gone = await prisma.otherLodge.deleteMany({ where: { id, centralId: null } });
    if (gone.count !== 1) return listedRefusal;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
      return referencedRefusal;
    }
    throw error;
  }
  return { ok: true, removed: lodge };
}
