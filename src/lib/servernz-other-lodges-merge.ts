import "server-only";
import { Prisma } from "@prisma/client";
import { usableCentralId } from "@/lib/other-lodge-central-id";
import {
  OTHER_LODGE_DATA_SELECT,
  otherLodgeAmenitiesDiffer,
  otherLodgeAmenitiesSelect,
  otherLodgeDataColumns,
  otherLodgeDataDiffers,
  ownsOtherLodge,
  type OwnedOtherLodges,
  replaceOtherLodgeAmenities,
  visibleOtherLodgeWhere,
} from "@/lib/other-lodges";
import { prisma } from "@/lib/prisma";
import type { OtherLodgesPullResult } from "@/lib/servernz-api";

/**
 * Merging ONE lodge from the central server's pull into the local Other
 * lodges registry (`downloadOtherClubsFromServer` runs it for each).
 *
 * WHICH ROW (#64). By the central server's permanent id (`centralId`) first,
 * so a lodge renamed there is the same row here. A lodge whose row has no id
 * yet is matched by NAME once, and that match fills the id in (the backfill).
 * Two lodges may share a name (#69), so the name is only a fallback, and only
 * when exactly ONE row could be the lodge; otherwise the lodge is new here.
 *
 * NAMES. Another club's lodge takes the server's name: a rename there renames
 * this row in place, so its bookings, requests and amenities follow it. This
 * club's OWN lodge never takes its name from a download: the name is this
 * site's to change, and an upload carries it to the server (API 2.3).
 *
 * RETRIES. A write that loses a race with a concurrent writer (an admin's
 * save, or a second download creating the same central id) is DEFERRED; the
 * caller retries the deferred lodges after the rest of the pull, then runs one
 * FINAL pass, where what still misses is reported. A name never collides: it
 * is not unique (#69).
 *
 * TWO RULES keep `updatedAt` honest as a sync signal, because the upload
 * watermark is derived from it:
 *
 *  1. A server-sourced write carries the SERVER's `updatedAt`, not `now()`.
 *     Prisma's `@updatedAt` would otherwise stamp the moment we wrote it, which
 *     re-presents a row we merely received as a local edit — and the next
 *     upload dutifully sends it back.
 *
 *  2. A remote row OLDER than the local copy is not applied — for a lodge this
 *     club may edit (#52). Upload runs before download in the same pass, so an
 *     admin editing a row in between would otherwise have their edit
 *     overwritten by the copy the server was already holding. Newest wins, and
 *     the next upload carries the club's edit. Another club's lodge has no
 *     local edit to protect: the server's copy is authoritative.
 */

type PulledLodge = OtherLodgesPullResult["lodges"][number];

const MERGE_SELECT = {
  id: true,
  name: true,
  centralId: true,
  hiddenAt: true,
  updatedAt: true,
  ...OTHER_LODGE_DATA_SELECT,
  amenities: otherLodgeAmenitiesSelect,
} as const;

/**
 * A lodge this download could not place: `lodge` is the local row's name, or
 * `null` for a lodge new to this site, which was not added; `wanted` is the
 * server's name. Since #69 only a lodge that could not be created (a
 * concurrent writer holding its central id on the final pass), or one the
 * server sent without an id whose name several local lodges share.
 */
export interface NameConflict {
  lodge: string | null;
  wanted: string;
}

export type MergeOutcome =
  | {
      kind: "created" | "updated" | "unchanged" | "keptLocal";
      renamed?: boolean;
      /** Everything else was applied; the name was not. */
      nameConflict?: NameConflict;
      /** The row could not be keyed on the final pass (a concurrent edit). */
      notKeyed?: boolean;
    }
  /** Not final: retry after the rest of the pull. */
  | { kind: "deferred" }
  /** Final pass: NOTHING written, and reported. */
  | { kind: "conflict"; nameConflict: NameConflict };

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * Merge one pulled lodge. `owned` is the owned list for this merge (the pull's,
 * else the stored one; `null` when neither is known). `final` is the retry pass,
 * which reports a collision instead of deferring it.
 *
 * `byNameAllowed` says whether a lodge WITH a usable id may key an unkeyed row
 * by its name (#69): the caller allows it only on a whole-registry download,
 * and only when the name is the registry's alone or the lodge is ours, so a
 * row is never keyed to another club's lodge of the same name. A lodge
 * without a usable id is always matched by name.
 *
 * `knownIds` is set only for a WHOLE-registry download: every id the server
 * has. A local row keyed by an id NOT among them carries a stale id — from a
 * different central server this site was pointed at, or a lodge since deleted
 * there — and may be matched by name and re-keyed, rather than treated as a
 * different central lodge holding the name.
 */
export async function mergeDistributedLodge(
  lodge: PulledLodge,
  owned: OwnedOtherLodges,
  final: boolean,
  knownIds: ReadonlySet<string> | null = null,
  byNameAllowed = true,
): Promise<MergeOutcome> {
  const centralId = usableCentralId(lodge.id);
  const byId = centralId
    ? await prisma.otherLodge.findUnique({ where: { centralId }, select: MERGE_SELECT })
    : null;
  let existing = byId;
  if (!existing && (centralId === null || byNameAllowed)) {
    // By NAME, among VISIBLE lodges only (#58: a hidden lodge is a deleted one
    // kept for the bookings that name it, never matched to another lodge). A
    // row keyed to a DIFFERENT central lodge is another lodge of the same name
    // (#69) and never merged into — unless a whole download shows that its id
    // is not the server's at all (stale, see above). A pulled lodge with no
    // usable id may match any row of its name.
    const candidates = (
      await prisma.otherLodge.findMany({
        where: { name: lodge.name, ...visibleOtherLodgeWhere },
        select: MERGE_SELECT,
        orderBy: { createdAt: "asc" },
      })
    ).filter(
      (row) =>
        centralId === null ||
        !row.centralId ||
        (knownIds !== null && !knownIds.has(row.centralId)),
    );
    // Exactly one, or none. Several rows of the name: for a lodge with an id
    // that is a new lodge here; for one without, there is no telling which, and
    // creating one would add another copy on every pull, so it is reported.
    if (candidates.length > 1 && centralId === null) {
      return { kind: "conflict", nameConflict: { lodge: null, wanted: lodge.name } };
    }
    existing = candidates.length === 1 ? (candidates[0] ?? null) : null;
  }

  // Only the fields the server SENT: a field it omitted is absent here, so a
  // server that does not yet carry it leaves the local value alone.
  const data = otherLodgeDataColumns(lodge);
  // Another club's lodge, once the owned list is known — by the pulled
  // lodge's central id, or by this row's own key (#69). Its booking officer's
  // PHONE is never stored here (#52): overridden to null, the one deliberate
  // exception to "a field the server did not send is left alone".
  const theirs =
    owned !== null &&
    !ownsOtherLodge(owned, { centralId }) &&
    !(existing !== null && ownsOtherLodge(owned, existing));
  if (theirs) data.bookingOfficerPhone = null;
  // `undefined` when the server sent no amenity list at all — also "leave ours
  // alone", never "the lodge has none".
  const amenities = lodge.amenities;
  // An unparseable server timestamp falls back to letting Prisma stamp it.
  const remoteUpdatedAt = Number.isNaN(Date.parse(lodge.updatedAt))
    ? null
    : new Date(lodge.updatedAt);
  const stamp = remoteUpdatedAt ? { updatedAt: remoteUpdatedAt } : {};

  if (!existing) {
    // A plain create; the amenity set rides in the same transaction. This
    // read-then-write is not atomic, so a concurrent writer (an admin pressing
    // Download while the 03:00 cron runs) can create the same central id in
    // the gap: the unique index refuses this one, and the lodge is retried
    // after the rest of the pull, when the lookups above find the row that
    // writer made and merge into it.
    try {
      await prisma.$transaction(async (tx) => {
        const row = await tx.otherLodge.create({
          data: { name: lodge.name, centralId, ...data, ...stamp },
          select: { id: true },
        });
        if (amenities) await replaceOtherLodgeAmenities(tx, row.id, amenities);
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return final
        ? { kind: "conflict", nameConflict: { lodge: null, wanted: lodge.name } }
        : { kind: "deferred" };
    }
    return { kind: "created" };
  }

  const row = existing;

  // The backfill: the row matched by name gets its central id. Written on its
  // own and WITHOUT moving `updatedAt` (it is set to the value read), so it is
  // never re-presented as a local edit, and it lands even when the data below
  // is unchanged or loses to a newer local edit. GUARDED on that `updatedAt`:
  // an admin saving the row since our read stamped it newer, and writing the
  // old value back would rewind their edit below the upload watermark and let
  // the guarded write further down overwrite it. A miss retries the lodge
  // after the rest of the pull, on a fresh read.
  let notKeyed = false;
  if (centralId !== null && row.centralId !== centralId) {
    let keyed = 0;
    try {
      keyed = (
        await prisma.otherLodge.updateMany({
          // `row.centralId` is null, or a stale id a whole download disowned.
          where: { id: row.id, centralId: row.centralId, updatedAt: row.updatedAt, hiddenAt: null },
          data: { centralId, updatedAt: row.updatedAt },
        })
      ).count;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
    if (keyed !== 1 && !final) return { kind: "deferred" };
    notKeyed = keyed !== 1;
  }

  // A rename: only another club's lodge, only one matched by id. The new
  // name may be one another lodge has (#69).
  const renameTo = theirs && byId !== null && row.name !== lodge.name ? lodge.name : null;

  // Amenities are part of "differs": a lodge whose only change is its amenity
  // list is still a changed lodge, and still carries the server's timestamp.
  const amenitiesChanged =
    amenities !== undefined && otherLodgeAmenitiesDiffer(row.amenities, amenities);
  if (renameTo === null && !otherLodgeDataDiffers(data, row) && !amenitiesChanged) {
    return { kind: "unchanged", notKeyed };
  }

  // Rule 2, for a lodge this club may edit. Equal timestamps apply the remote,
  // so a server correction issued in the same instant is not dropped.
  if (!theirs && remoteUpdatedAt && row.updatedAt > remoteUpdatedAt) {
    return { kind: "keptLocal", notKeyed };
  }

  // One transaction for the lodge row and its amenities. The row write comes
  // FIRST and is GUARDED on the `updatedAt` read above: an admin can save an
  // edit between that read and this write, and an unguarded update would
  // overwrite it and stamp the row with the server's OLDER timestamp — below
  // the upload watermark, so the edit would never be sent. A miss is the local
  // edit winning after all (keptLocal). The same write takes the row's lock, so
  // a concurrent amenity replacement on this lodge queues behind it.
  const applied = await prisma.$transaction(async (tx) => {
    const claimed = await tx.otherLodge.updateMany({
      where: { id: row.id, updatedAt: row.updatedAt, hiddenAt: null },
      data: { ...data, ...stamp, ...(renameTo !== null ? { name: renameTo } : {}) },
    });
    if (claimed.count !== 1) return false;
    if (amenitiesChanged && amenities) {
      await replaceOtherLodgeAmenities(tx, row.id, amenities);
    }
    return true;
  });
  if (!applied) return { kind: "keptLocal", notKeyed };
  return { kind: "updated", renamed: renameTo !== null, notKeyed };
}

/**
 * The central server deleted the lodge with this central id (#58, API 2.4,
 * owner decision): the local row is HIDDEN, never removed. It keeps its data
 * and its central id, so every booking and booking request that names it keeps
 * it, and it leaves the Other lodges list and every drop-down. Any club lodge
 * linked to it (#62) is unlinked. Returns the lodge's name when this call hid it
 * (`null` when there is no such row, or it was already hidden: a repeated
 * deletion is a no-op), and how many club lodges it unlinked. Raw, so `updatedAt`
 * stays put: hiding is not an edit to upload.
 */
export async function hideDeletedLodge(
  centralId: string,
): Promise<{ hidden: string | null; unlinked: number }> {
  // A club lodge LINKED to the deleted central lodge (#62's "Central lodge")
  // points at nothing now: the link is cleared, so the one-lodge default can
  // link it to a successor. Raw, like the hide: not an administrator's edit.
  const unlinked = await prisma.$executeRaw`UPDATE "Lodge" SET "centralLodgeId" = NULL WHERE "centralLodgeId" = ${centralId}`;
  const row = await prisma.otherLodge.findUnique({
    where: { centralId },
    select: { id: true, name: true, hiddenAt: true },
  });
  if (!row || row.hiddenAt) return { hidden: null, unlinked };
  // The instant is the app's, as an administrator's Hide stamps it: the
  // database's NOW() would be read in its own time zone.
  const hidden = await prisma.$executeRaw`UPDATE "OtherLodge" SET "hiddenAt" = ${new Date()} WHERE "id" = ${row.id} AND "centralId" = ${centralId} AND "hiddenAt" IS NULL`;
  return { hidden: hidden === 1 ? row.name : null, unlinked };
}
