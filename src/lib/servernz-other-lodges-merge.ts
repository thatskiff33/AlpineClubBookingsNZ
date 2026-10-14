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
  replaceOtherLodgeAmenities,
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
 * A pulled lodge with no usable id is matched by name, exactly as before #64.
 *
 * NAMES. Another club's lodge takes the server's name: a rename there renames
 * this row in place, so its bookings, requests and amenities follow it. This
 * club's OWN lodge never takes its name from a download: the name is this
 * site's to change, and an upload carries it to the server (API 2.3).
 *
 * COLLISIONS. A name the server gives a lodge may be held here by another row
 * — a chain of renames arriving in one pull (A becomes B while B becomes C), or
 * a stale row. The first pass DEFERS such a lodge; the caller retries the
 * deferred lodges once at the end, after the rest of the pull has moved names
 * out of the way. On that final pass a rename that still collides applies
 * everything but the name and is reported; a NEW lodge whose name is held by
 * a different central lodge is reported and not created.
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
  updatedAt: true,
  ...OTHER_LODGE_DATA_SELECT,
  amenities: otherLodgeAmenitiesSelect,
} as const;

export type MergeOutcome =
  | { kind: "created" | "updated" | "unchanged" | "keptLocal"; renamed?: boolean; nameConflict?: boolean }
  /** First pass only: retry at the end of the pull. */
  | { kind: "deferred" }
  /** Final pass: nothing written, and reported. */
  | { kind: "conflict" };

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * Merge one pulled lodge. `owned` is the owned list for this merge (the pull's,
 * else the stored one; `null` when neither is known). `final` is the retry pass,
 * which reports a collision instead of deferring it.
 */
export async function mergeDistributedLodge(
  lodge: PulledLodge,
  owned: ReadonlyArray<string> | null,
  final: boolean,
): Promise<MergeOutcome> {
  const centralId = usableCentralId(lodge.id);
  const byId = centralId
    ? await prisma.otherLodge.findUnique({ where: { centralId }, select: MERGE_SELECT })
    : null;
  let existing = byId;
  if (!existing) {
    const byName = await prisma.otherLodge.findUnique({
      where: { name: lodge.name },
      select: MERGE_SELECT,
    });
    // The name is held here by a DIFFERENT central lodge: one renamed away on
    // the server that this pull has not (yet) renamed here. Never merged into
    // it, which would weld two lodges into one row.
    if (byName && centralId !== null && byName.centralId !== null) {
      return final ? { kind: "conflict" } : { kind: "deferred" };
    }
    existing = byName;
  }

  // Only the fields the server SENT: a field it omitted is absent here, so a
  // server that does not yet carry it leaves the local value alone.
  const data = otherLodgeDataColumns(lodge);
  // Another club's lodge, once the owned list is known — by the server's name
  // or by this row's own (a lodge this site renamed is still ours). Its booking
  // officer's PHONE is never stored here (#52): overridden to null, the one
  // deliberate exception to "a field the server did not send is left alone".
  const theirs =
    owned !== null &&
    !ownsOtherLodge(owned, lodge.name) &&
    !(existing !== null && ownsOtherLodge(owned, existing.name));
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
    // Upsert, not create: `name` is unique and this read-then-write is not
    // atomic, so a concurrent writer (an admin pressing Download while the
    // 03:00 cron runs) can insert the same name in the gap; the upsert lets the
    // loser fall through to the same update. The amenity replacement rides in
    // the same transaction, keyed on the unique (lodge, name).
    try {
      await prisma.$transaction(async (tx) => {
        const row = await tx.otherLodge.upsert({
          where: { name: lodge.name },
          create: { name: lodge.name, centralId, ...data, ...stamp },
          update: { ...data, ...stamp },
          select: { id: true },
        });
        if (amenities) await replaceOtherLodgeAmenities(tx, row.id, amenities);
      });
    } catch (error) {
      // The id is held by a row a concurrent download just wrote.
      if (!isUniqueViolation(error)) throw error;
      return final ? { kind: "conflict" } : { kind: "deferred" };
    }
    return { kind: "created" };
  }

  const row = existing;

  // The backfill: the row matched by name gets its central id. Written on its
  // own and WITHOUT moving `updatedAt` (it is set to the value read), so it is
  // never re-presented as a local edit, and it lands even when the data below
  // is unchanged or loses to a newer local edit.
  if (centralId !== null && row.centralId === null) {
    try {
      await prisma.otherLodge.updateMany({
        where: { id: row.id, centralId: null },
        data: { centralId, updatedAt: row.updatedAt },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }

  // A rename: only another club's lodge, only one matched by id.
  let renameTo = theirs && byId !== null && row.name !== lodge.name ? lodge.name : null;
  let nameConflict = false;
  if (renameTo !== null) {
    const holder = await prisma.otherLodge.findUnique({
      where: { name: renameTo },
      select: { id: true },
    });
    if (holder) {
      if (!final) return { kind: "deferred" };
      renameTo = null;
      nameConflict = true;
    }
  }

  // Amenities are part of "differs": a lodge whose only change is its amenity
  // list is still a changed lodge, and still carries the server's timestamp.
  const amenitiesChanged =
    amenities !== undefined && otherLodgeAmenitiesDiffer(row.amenities, amenities);
  if (renameTo === null && !otherLodgeDataDiffers(data, row) && !amenitiesChanged) {
    return { kind: "unchanged", nameConflict };
  }

  // Rule 2, for a lodge this club may edit. Equal timestamps apply the remote,
  // so a server correction issued in the same instant is not dropped.
  if (!theirs && remoteUpdatedAt && row.updatedAt > remoteUpdatedAt) {
    return { kind: "keptLocal", nameConflict };
  }

  // One transaction for the lodge row and its amenities. The row write comes
  // FIRST and is GUARDED on the `updatedAt` read above: an admin can save an
  // edit between that read and this write, and an unguarded update would
  // overwrite it and stamp the row with the server's OLDER timestamp — below
  // the upload watermark, so the edit would never be sent. A miss is the local
  // edit winning after all (keptLocal). The same write takes the row's lock, so
  // a concurrent amenity replacement on this lodge queues behind it.
  let applied: boolean;
  try {
    applied = await prisma.$transaction(async (tx) => {
      const claimed = await tx.otherLodge.updateMany({
        where: { id: row.id, updatedAt: row.updatedAt },
        data: { ...data, ...stamp, ...(renameTo !== null ? { name: renameTo } : {}) },
      });
      if (claimed.count !== 1) return false;
      if (amenitiesChanged && amenities) {
        await replaceOtherLodgeAmenities(tx, row.id, amenities);
      }
      return true;
    });
  } catch (error) {
    // A rename onto a name another writer took since the check above.
    if (renameTo === null || !isUniqueViolation(error)) throw error;
    return final ? { kind: "conflict" } : { kind: "deferred" };
  }
  if (!applied) return { kind: "keptLocal", nameConflict };
  return { kind: "updated", renamed: renameTo !== null, nameConflict };
}

/**
 * True when the registry has rows but none is keyed by a central id yet: the
 * site has just upgraded to #64 (or rolled its column back and re-upgraded).
 * The download then asks for the WHOLE registry once, so every row is matched
 * by name and keyed, rather than only the lodges that happen to change.
 */
export async function registryNeedsKeying(): Promise<boolean> {
  const keyed = await prisma.otherLodge.findFirst({
    where: { centralId: { not: null } },
    select: { id: true },
  });
  if (keyed) return false;
  const any = await prisma.otherLodge.findFirst({ select: { id: true } });
  return any !== null;
}

/** Local names of the rows keyed by these central ids. */
export async function localNamesByCentralId(
  ids: ReadonlyArray<string>,
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.otherLodge.findMany({
    where: { centralId: { in: [...ids] } },
    select: { centralId: true, name: true },
  });
  return new Map(
    rows.flatMap((row) => (row.centralId ? [[row.centralId, row.name] as const] : [])),
  );
}
