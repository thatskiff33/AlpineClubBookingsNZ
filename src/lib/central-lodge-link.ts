import "server-only";
import type { OwnedCentralLodge } from "@/lib/other-lodges";
import { prisma } from "@/lib/prisma";

/**
 * Which LOCAL lodge a central lodge id means (INV-INT-028).
 *
 * The Alpine Central Server asks about a lodge by its permanent central id —
 * never by name, because a lodge can be renamed centrally. This site answers
 * only for a lodge the server says this club OWNS (`ownLodges` from the pull,
 * stored on `ServerNzSettings.otherLodgesOwnedLodges`), and maps it to one of
 * its own `Lodge` rows through an explicit "Central lodge" link
 * (`Lodge.centralLodgeId`). Every club must opt in, even with only one lodge.
 * Without that link the route answers 404, the same as for an unknown id.
 *
 * An inactive lodge never answers: it takes no bookings, so it has no beds.
 */

export async function resolveLocalLodgeForCentralId(
  centralLodgeId: string,
  owned: ReadonlyArray<OwnedCentralLodge> | null,
): Promise<string | null> {
  if (!owned?.some((l) => l.id === centralLodgeId)) return null;

  const linked = await prisma.lodge.findUnique({
    where: { centralLodgeId },
    select: { id: true, active: true },
  });
  return linked?.active ? linked.id : null;
}

/**
 * What the admin page shows for one local lodge, decided by the SAME resolver
 * the endpoint uses, so the page can never say "linked" for a lodge the
 * endpoint refuses (or the reverse):
 *
 *  - `answersFor`: the owned central lodge this local lodge actually answers
 *    for through its explicit link, or null;
 *  - `heldBy`: when the club owns only one central lodge but ANOTHER local lodge
 *    (typically an inactive one) holds the only owned central lodge's link,
 *    that lodge's name, so the page can say why nothing is answered.
 */
export async function centralLinkStatus(
  localLodgeId: string,
  owned: ReadonlyArray<OwnedCentralLodge> | null,
): Promise<{ answersFor: string | null; heldBy: string | null }> {
  if (!owned) return { answersFor: null, heldBy: null };
  for (const lodge of owned) {
    if ((await resolveLocalLodgeForCentralId(lodge.id, owned)) === localLodgeId) {
      return { answersFor: lodge.id, heldBy: null };
    }
  }
  const [only] = owned;
  if (owned.length !== 1 || !only) return { answersFor: null, heldBy: null };
  const holder = await prisma.lodge.findUnique({
    where: { centralLodgeId: only.id },
    select: { id: true, name: true },
  });
  return {
    answersFor: null,
    heldBy: holder && holder.id !== localLodgeId ? holder.name : null,
  };
}
