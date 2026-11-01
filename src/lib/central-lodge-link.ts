import "server-only";
import type { OwnedCentralLodge } from "@/lib/other-lodges";
import { prisma } from "@/lib/prisma";

/**
 * Which LOCAL lodge a central lodge id means (#62, owner decision D5).
 *
 * The Alpine Central Server asks about a lodge by its permanent central id —
 * never by name, because a lodge can be renamed centrally. This site answers
 * only for a lodge the server says this club OWNS (`ownLodges` from the pull,
 * stored on `ServerNzSettings.otherLodgesOwnedLodges`), and only for the
 * ACTIVE lodge an administrator explicitly LINKED to it ("Central lodge",
 * `Lodge.centralLodgeId`). Otherwise nothing: the route answers 404, the same
 * as for an unknown id.
 *
 * EVERY CLUB LINKS EXPLICITLY, a one-lodge club included (owner decision,
 * 24 Oct 2026, #4262): there is no automatic one-lodge fallback. A club with
 * one active lodge that owns one central lodge is only offered that lodge
 * preselected on the Central lodge card (`suggestedCentralLodgeId`), and
 * nothing is answered until an administrator saves it.
 *
 * An inactive lodge never answers: it takes no bookings, so it has no beds.
 */

/** The active lodges, two at most: enough to know "exactly one" or not. */
function readActiveLodges() {
  return prisma.lodge.findMany({
    where: { active: true },
    select: { id: true, centralLodgeId: true },
    take: 2,
  });
}

/**
 * The central lodge the Central lodge card PRESELECTS when an administrator
 * opens it to edit (pure, on values already read): the club owns exactly one
 * central lodge, has exactly one active lodge, and that lodge is not linked
 * yet. A suggestion only — never an answer: until it is saved, the lodge
 * answers nothing (#4262). `null` otherwise.
 */
export function suggestedCentralLodgeId(
  owned: ReadonlyArray<OwnedCentralLodge> | null,
  activeLodges: ReadonlyArray<{ centralLodgeId: string | null }>,
): string | null {
  if (!owned || owned.length !== 1 || activeLodges.length !== 1) return null;
  const [only] = owned;
  const [lodge] = activeLodges;
  if (!only || !lodge || lodge.centralLodgeId !== null) return null;
  return only.id;
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
  return linked?.active ? linked.id : null;
}

/**
 * What the admin page shows for one local lodge, decided by the SAME resolver
 * the endpoint uses, so the page can never say "linked" for a lodge the
 * endpoint refuses (or the reverse):
 *
 *  - `answersFor`: the owned central lodge this local lodge actually answers
 *    for — by its own saved link — or null;
 *  - `heldBy`: when the club owns exactly one central lodge and ANOTHER local
 *    lodge (typically an inactive one) holds its link, that lodge's name, so
 *    the page can say why nothing is answered here;
 *  - `suggested`: the central lodge the card preselects on Edit
 *    (`suggestedCentralLodgeId`), or null. Never what the lodge answers for.
 */
export async function centralLinkStatus(
  localLodgeId: string,
  owned: ReadonlyArray<OwnedCentralLodge> | null,
): Promise<{ answersFor: string | null; heldBy: string | null; suggested: string | null }> {
  if (!owned) return { answersFor: null, heldBy: null, suggested: null };
  for (const lodge of owned) {
    if ((await resolveLocalLodgeForCentralId(lodge.id, owned)) === localLodgeId) {
      return { answersFor: lodge.id, heldBy: null, suggested: null };
    }
  }
  const [only] = owned;
  if (owned.length !== 1 || !only) return { answersFor: null, heldBy: null, suggested: null };
  const holder = await prisma.lodge.findUnique({
    where: { centralLodgeId: only.id },
    select: { id: true, name: true },
  });
  if (holder && holder.id !== localLodgeId) {
    return { answersFor: null, heldBy: holder.name, suggested: null };
  }
  const active = await readActiveLodges();
  const [onlyActive] = active;
  const suggested =
    onlyActive?.id === localLodgeId && !holder ? suggestedCentralLodgeId(owned, active) : null;
  return { answersFor: null, heldBy: null, suggested };
}
