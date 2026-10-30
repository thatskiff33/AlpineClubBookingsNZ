import "server-only";
import { Prisma } from "@prisma/client";
import { createAuditLog } from "@/lib/audit";
import { otherLodgeChoiceLabel, type OwnedCentralLodge } from "@/lib/other-lodges";
import { prisma } from "@/lib/prisma";
import {
  SERVERNZ_TRANSACTION_OPTIONS,
  loadServerNzSettings,
  lockServerNzSettings,
} from "@/lib/servernz-settings";

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

/**
 * Each owned lodge with the label its option shows (#69): two may share a
 * name, so such a pair also shows the location their local copies hold.
 */
export async function labelOwnedLodges(owned: ReadonlyArray<OwnedCentralLodge>) {
  const rows = await prisma.otherLodge.findMany({
    where: { centralId: { in: owned.map((l) => l.id) } },
    select: { centralId: true, location: true },
  });
  const location = new Map(rows.map((r) => [r.centralId, r.location]));
  return owned.map((l) => ({
    ...l,
    label: otherLodgeChoiceLabel({ name: l.name, location: location.get(l.id) ?? null }, owned),
  }));
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

/** One lodge's link as a save asks for it. */
export interface CentralLodgeLinkChange {
  lodgeId: string;
  /** The owned central lodge to link, or null to unlink. */
  centralLodgeId: string | null;
  /**
   * The link the caller was shown, when it must still be the stored one: an
   * automatic link passes `null` so it never overwrites a link someone saved
   * meanwhile ("stale" otherwise). Absent: replace whatever is stored.
   */
  expectCurrent?: string | null;
}

export type CentralLodgeLinkSaveResult =
  | { ok: true; before: Array<{ lodgeId: string; centralLodgeId: string | null }> }
  | { ok: false; reason: "not-owned" | "duplicate" | "stale" }
  | { ok: false; reason: "lodge-not-found"; lodgeId: string }
  /** The unique index refused it: another lodge holds that central lodge. */
  | { ok: false; reason: "already-linked"; holderName: string | null };

/**
 * Save one or more lodges' Central lodge links (#62) — the ONE writer the
 * lodge's Central lodge card (`PUT /api/admin/lodges/[id]/central-lodge`) and
 * the setup page's link step both use.
 *
 * The ownership check, the transition and its audit row are ONE serialised
 * step (#4262 review). The save first takes the settings row lock
 * (`lockServerNzSettings`) and re-reads the owned list under it, so a download
 * recording a new list (it unlinks deleted ids under the same lock) cannot
 * slip between the check and the write; then it locks each `Lodge` row
 * (`SELECT 1 … FOR UPDATE`, in id order), reads the link it is replacing,
 * writes the new one and writes `LODGE_CENTRAL_LINK_UPDATED` on the same
 * transaction client. Settings then Lodge is the download's own order, so
 * neither can wait on the other in reverse. Two administrators saving at once
 * queue on the locks, so the second reads the first's link as its "before". A
 * save refused for ownership writes nothing; one refused by the unique index
 * rolls back; neither leaves an audit row. See docs/CONCURRENCY_AND_LOCKING.md
 * -> "Central lodge link writer".
 *
 * Several rows save together so links can move between lodges: each moving
 * row is cleared first, then every row takes its new link, all in the one
 * transaction, so the unique index sees only the end state's clashes.
 *
 * A single-row update of one nullable unique column per lodge: it joins no
 * lifecycle, settlement or capacity cohort and takes no advisory lock
 * (INV-LOCK-001/002 unaffected).
 */
export async function saveCentralLodgeLinks(
  changes: ReadonlyArray<CentralLodgeLinkChange>,
  actorMemberId: string,
): Promise<CentralLodgeLinkSaveResult> {
  const wanted = changes.flatMap((c) => (c.centralLodgeId === null ? [] : [c.centralLodgeId]));
  if (
    new Set(wanted).size !== wanted.length ||
    new Set(changes.map((c) => c.lodgeId)).size !== changes.length
  ) {
    return { ok: false, reason: "duplicate" };
  }
  // Id order, so two batch saves lock their rows in the same order.
  const ordered = [...changes].sort((a, b) => a.lodgeId.localeCompare(b.lodgeId));
  try {
    return await prisma.$transaction(async (tx): Promise<CentralLodgeLinkSaveResult> => {
      await lockServerNzSettings(tx);
      // Only a lodge the central server says this club owns may be linked:
      // anything else could never be asked about, and would hide a typo.
      if (wanted.length > 0) {
        const { otherLodgesOwnedLodges: owned } = await loadServerNzSettings(tx);
        if (!wanted.every((id) => owned?.some((l) => l.id === id))) {
          return { ok: false, reason: "not-owned" };
        }
      }
      const before: Array<{ lodgeId: string; centralLodgeId: string | null }> = [];
      for (const change of ordered) {
        await tx.$executeRaw`SELECT 1 FROM "Lodge" WHERE "id" = ${change.lodgeId} FOR UPDATE`;
        const current = await tx.lodge.findUnique({
          where: { id: change.lodgeId },
          select: { centralLodgeId: true },
        });
        if (!current) return { ok: false, reason: "lodge-not-found", lodgeId: change.lodgeId };
        if (change.expectCurrent !== undefined && change.expectCurrent !== current.centralLodgeId) {
          return { ok: false, reason: "stale" };
        }
        before.push({ lodgeId: change.lodgeId, centralLodgeId: current.centralLodgeId });
      }
      if (ordered.length > 1) {
        for (const [i, change] of ordered.entries()) {
          const was = before[i]?.centralLodgeId ?? null;
          if (was !== null && was !== change.centralLodgeId) {
            await tx.lodge.update({ where: { id: change.lodgeId }, data: { centralLodgeId: null } });
          }
        }
      }
      for (const [i, change] of ordered.entries()) {
        await tx.lodge.update({
          where: { id: change.lodgeId },
          data: { centralLodgeId: change.centralLodgeId },
        });
        // Category `admin`, like every writer under `/api/admin/lodges/`
        // (INV-PRIV-013; see `LODGE_GATED_ADMIN_CATEGORIES_2765` in the audit census).
        await createAuditLog(
          {
            action: "LODGE_CENTRAL_LINK_UPDATED",
            memberId: actorMemberId,
            actorMemberId,
            entityType: "Lodge",
            entityId: change.lodgeId,
            category: "admin",
            severity: "important",
            outcome: "success",
            summary: "Central lodge link updated",
            metadata: {
              before: { centralLodgeId: before[i]?.centralLodgeId ?? null },
              after: { centralLodgeId: change.centralLodgeId },
            },
          },
          tx,
        );
      }
      return { ok: true, before };
    }, SERVERNZ_TRANSACTION_OPTIONS);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { ok: false, reason: "already-linked", holderName: await linkHolderName(wanted, changes) };
    }
    throw error;
  }
}

/** The lodge outside the save that holds one of the central lodges it asked for. */
async function linkHolderName(
  wanted: ReadonlyArray<string>,
  changes: ReadonlyArray<CentralLodgeLinkChange>,
): Promise<string | null> {
  const saving = new Set(changes.map((c) => c.lodgeId));
  for (const centralLodgeId of wanted) {
    const holder = await prisma.lodge.findUnique({
      where: { centralLodgeId },
      select: { id: true, name: true },
    });
    if (holder && !saving.has(holder.id)) return holder.name;
  }
  return null;
}
