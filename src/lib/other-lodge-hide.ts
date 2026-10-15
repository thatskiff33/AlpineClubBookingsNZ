import "server-only";
import { isNotOnCentralServer } from "@/lib/other-lodges";
import { prisma } from "@/lib/prisma";
import { loadServerNzSettings } from "@/lib/servernz-settings";

/**
 * An administrator HIDING an Other lodges row (#58, owner decision): only a row
 * the central server does not list. Hidden, never removed: the row and its data
 * stay, so the bookings and booking requests that name it keep it, and it
 * leaves the Other lodges list and every drop-down. Never undone.
 *
 * #52 removed delete for other clubs' lodges on purpose: the server's registry
 * is authoritative, and a lodge it still lists would only come back. Hide is
 * for the rows it does NOT list — duplicates left by a rename before #64, and
 * lodges deleted there before it told clubs about deletions — by the same rule
 * the panel marks them with (`isNotOnCentralServer`). The write is guarded on
 * the row still being unkeyed and visible, so a download that keyed it
 * meanwhile wins, and `updatedAt` is left as it was: hiding is not an edit.
 */
export type OtherLodgeHiding =
  | { ok: true; hidden: { id: string; name: string } }
  | { ok: false; status: 404 | 409; error: string };

export async function hideUnlistedOtherLodge(id: string): Promise<OtherLodgeHiding> {
  const { otherLodgesKeyedAt } = await loadServerNzSettings();
  const row = await prisma.otherLodge.findUnique({
    where: { id },
    select: { id: true, name: true, centralId: true, hiddenAt: true, updatedAt: true },
  });
  if (!row || row.hiddenAt) return { ok: false, status: 404, error: "Lodge not found" };

  const listedRefusal = {
    ok: false as const,
    status: 409 as const,
    error:
      "Only a lodge marked “Not found on the Alpine Central Server” can be hidden here. Lodges the central server lists are kept in step with it.",
  };
  if (!isNotOnCentralServer(row, otherLodgesKeyedAt)) return listedRefusal;

  const hidden = await prisma.otherLodge.updateMany({
    where: { id, centralId: null, hiddenAt: null },
    data: { hiddenAt: new Date(), updatedAt: row.updatedAt },
  });
  if (hidden.count !== 1) return listedRefusal;
  return { ok: true, hidden: { id: row.id, name: row.name } };
}
