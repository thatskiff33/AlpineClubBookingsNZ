import "server-only";
import type { OwnedCentralLodge } from "@/lib/other-lodges";
import { prisma } from "@/lib/prisma";

/**
 * Which LOCAL lodge a central lodge id means (#62, owner decision D5).
 *
 * The Alpine Central Server asks about a lodge by its permanent central id —
 * never by name, because a lodge can be renamed centrally. This site answers
 * only for a lodge the server says this club OWNS (`ownLodges` from the pull,
 * stored on `ServerNzSettings.otherLodgesOwnedLodges`), and maps it to one of
 * its own `Lodge` rows:
 *
 *  1. the active lodge an administrator linked to it ("Central lodge",
 *     `Lodge.centralLodgeId`), if any; otherwise
 *  2. the ONE-LODGE DEFAULT: when the club owns exactly one central lodge and
 *     has exactly one active lodge, that lodge — unless it is explicitly linked
 *     to something else. Resolved here, at request time, and never written, so
 *     adding a second lodge or a second owned lodge withdraws the default at
 *     once instead of leaving a stale link behind; otherwise
 *  3. nothing: the route answers 404, the same as for an unknown id.
 *
 * An inactive lodge never answers: it takes no bookings, so it has no beds.
 */

/** The one-lodge default's rule, on values already read (pure, for the admin page too). */
export function defaultCentralLodgeId(
  owned: ReadonlyArray<OwnedCentralLodge> | null,
  activeLodges: ReadonlyArray<{ centralLodgeId: string | null }>,
): string | null {
  if (!owned || owned.length !== 1 || activeLodges.length !== 1) return null;
  const [only] = owned;
  const [lodge] = activeLodges;
  if (!only || !lodge) return null;
  return lodge.centralLodgeId === null || lodge.centralLodgeId === only.id ? only.id : null;
}

export async function resolveLocalLodgeForCentralId(
  centralLodgeId: string,
  owned: ReadonlyArray<OwnedCentralLodge> | null,
): Promise<string | null> {
  if (!owned?.some((l) => l.id === centralLodgeId)) return null;

  const linked = await prisma.lodge.findUnique({
    where: { centralLodgeId },
    select: { id: true, active: true },
  });
  if (linked) return linked.active ? linked.id : null;

  // Two rows is enough to know "not exactly one".
  const active = await prisma.lodge.findMany({
    where: { active: true },
    select: { id: true, centralLodgeId: true },
    take: 2,
  });
  const [only] = active;
  return only && defaultCentralLodgeId(owned, active) === centralLodgeId ? only.id : null;
}

/**
 * What the admin page shows for one local lodge, decided by the SAME resolver
 * the endpoint uses, so the page can never say "linked" for a lodge the
 * endpoint refuses (or the reverse):
 *
 *  - `answersFor`: the owned central lodge this local lodge actually answers
 *    for — by its own link or by the one-lodge default — or null;
 *  - `heldBy`: when this would be the one-lodge default but ANOTHER local lodge
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
