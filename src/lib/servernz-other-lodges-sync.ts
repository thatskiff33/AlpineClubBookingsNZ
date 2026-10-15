import "server-only";
import { Prisma } from "@prisma/client";
import { ownedNamesAsLocal, usableCentralId } from "@/lib/other-lodge-central-id";
import {
  OTHER_LODGE_DATA_SELECT,
  omitRateFields,
  otherLodgeAmenitiesSelect,
  ownsOtherLodge,
  serializeOtherLodgeAmenities,
  serializeOtherLodgeData,
  visibleOtherLodgeWhere,
} from "@/lib/other-lodges";
import { createAuditLog } from "@/lib/audit";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  uploadOtherLodges,
  pullOtherLodges,
  type OtherLodgesUploadResult,
} from "@/lib/servernz-api";
import {
  localNamesByCentralId,
  hideDeletedLodge,
  mergeDistributedLodge,
  type MergeOutcome,
  type NameConflict,
} from "@/lib/servernz-other-lodges-merge";
import { readServerNzApiKeyStamp } from "@/lib/servernz-config";
import { ratesToServer } from "@/lib/servernz-rate";
import {
  advancedDownloadCursor,
  overlappedRequestCursor,
} from "@/lib/servernz-cursor-overlap";
import {
  SERVERNZ_SETTINGS_ID,
  loadServerNzSettings,
  lockServerNzSettings,
  recordOtherLodgesUpload,
  recordOtherLodgesDownload,
} from "@/lib/servernz-settings";

/**
 * Sync the local "Other lodges" registry (the club's Other Clubs details) with
 * the Alpine Central Server. Upload pushes this club's entries up; download
 * pulls the centrally-distributed set down and merges it into the local
 * registry, keyed by the central server's permanent lodge id once known and by
 * the unique lodge name before that (#64, `@/lib/servernz-other-lodges-merge`).
 */

export interface UploadSummary extends OtherLodgesUploadResult {
  /** Local rows considered for upload (changed since the last upload). */
  sent: number;
}

// The columns that carry a lodge's data, plus its amenity list. The list itself
// lives in `@/lib/other-lodges` (`OTHER_LODGE_DATA_FIELDS`), shared with the
// admin routes and the serializer, so the upload projection, the download
// merge and the "differs" check below cannot drift from what the admin can edit.
const LODGE_DATA_SELECT = {
  ...OTHER_LODGE_DATA_SELECT,
  amenities: otherLodgeAmenitiesSelect,
} as const;

/**
 * Push the club's changed Other Clubs entries to the central server.
 *
 * Incremental: only rows whose `updatedAt` is newer than the last upload
 * watermark (`otherLodgesLastUploadAt`) are sent — new and edited rows, never
 * the whole table. On the first upload (no watermark) every row is sent. When
 * nothing has changed, no request is made and the watermark is left untouched.
 *
 * ONLY THE CLUB'S OWN LODGES ARE SENT once the central server has said which
 * those are (#52): the stored owned list, through the one `ownsOtherLodge`
 * rule the admin PATCH route and the panel also apply. Before #52 every changed
 * row went up — including other clubs' lodges this site had just DOWNLOADED,
 * whose server-stamped `updatedAt` sat above the watermark — so each night
 * re-sent the whole registry for the server to refuse (#53). While the list is
 * UNKNOWN (never received: not connected, or an older server) the upload keeps
 * its pre-#52 behaviour and sends every changed row, so a club on an older
 * central server loses nothing. A row the server then reports as `skipped` is
 * still held below the watermark exactly as before (INV-INT-004).
 *
 * A stored list that is PRESENT BUT UNREADABLE is neither: it is a defect in
 * the column, and the honest answer is to send nothing until a download
 * rewrites it, rather than fall back to sending every row because the parsed
 * value happens to be `null`.
 */
export async function uploadOtherClubsToServer(): Promise<UploadSummary> {
  const settings = await loadServerNzSettings();
  if (settings.otherLodgesOwnedNamesUnreadable) {
    logger.warn(
      "The stored owned-lodge list cannot be read; uploading nothing until the next download rewrites it",
    );
    return { created: 0, updated: 0, unchanged: 0, skipped: 0, results: [], sent: 0 };
  }
  const since = settings.otherLodgesLastUploadAt
    ? new Date(settings.otherLodgesLastUploadAt)
    : null;
  const owned = settings.otherLodgesOwnedNames;

  // A hidden lodge (#58) is never uploaded: it is a deleted lodge kept here.
  const changed = await prisma.otherLodge.findMany({
    where: { ...visibleOtherLodgeWhere, ...(since ? { updatedAt: { gt: since } } : {}) },
    select: { name: true, centralId: true, updatedAt: true, ...LODGE_DATA_SELECT },
    orderBy: { name: "asc" },
  });
  const lodges =
    owned === null ? changed : changed.filter((l) => ownsOtherLodge(owned, l.name));

  if (lodges.length === 0) {
    // Nothing changed since the last upload — skip the round-trip entirely.
    return { created: 0, updated: 0, unchanged: 0, skipped: 0, results: [], sent: 0 };
  }

  // Every data column (dates as `YYYY-MM-DD`) and the WHOLE amenity list: the
  // server replaces its set for the lodge with what is sent, so a partial list
  // would delete the rest.
  // The rates leave as the server's dollar keys, never as the `…Cents`
  // columns (#61): the server's item schema is strict and would refuse them.
  const result = await uploadOtherLodges(
    lodges.map((l) => {
      const data = serializeOtherLodgeData(l);
      const commonData = omitRateFields(data);
      return {
        // The central id, once known (#64, API 2.3): the server matches the
        // item by it, so a name changed here renames the lodge there.
        ...(l.centralId ? { id: l.centralId } : {}),
        name: l.name,
        ...commonData,
        ...ratesToServer(data),
        amenities: serializeOtherLodgeAmenities(l.amenities),
      };
    }),
  );

  // Advance the watermark to the newest `updatedAt` the server ACCEPTED. Any row
  // edited after this read has a larger `updatedAt` and is caught next time.
  //
  // Rows the server reported as `skipped` are excluded (INV-INT-004). Advancing
  // past a rejected row is how a rejection becomes permanent: the row is never
  // re-sent, so it silently never reaches the registry and nothing says so. By
  // holding the watermark below the oldest skipped row, every subsequent run
  // retries it — and `skipped` is surfaced in the summary so an operator can see
  // a row that keeps bouncing.
  const skippedNames = new Set(
    result.results.filter((r) => r.status === "skipped").map((r) => r.name),
  );
  const accepted = lodges.filter((l) => !skippedNames.has(l.name));

  const [firstAccepted] = accepted;
  if (accepted.length > 0 && firstAccepted) {
    const oldestSkipped = lodges
      .filter((l) => skippedNames.has(l.name))
      .reduce<Date | null>((min, l) => (!min || l.updatedAt < min ? l.updatedAt : min), null);

    let watermark = accepted.reduce(
      (max, l) => (l.updatedAt > max ? l.updatedAt : max),
      firstAccepted.updatedAt,
    );
    // Never step over a rejected row, even when a newer row was accepted.
    if (oldestSkipped && watermark >= oldestSkipped) {
      watermark = new Date(oldestSkipped.getTime() - 1);
    }
    if (!since || watermark > since) {
      await recordOtherLodgesUpload(watermark);
    }
  }

  return { ...result, sent: lodges.length };
}

/**
 * The commit-order overlap this pull applies to its stored cursor lives in
 * `@/lib/servernz-cursor-overlap` — the window, the request-side step back and
 * the persist-side monotonic guard — because the shared-post mirror applies
 * the same one (#3449) and a rule with two homes drifts (`INV-SSOT-001`).
 * Read that module before touching either call below: it records why the
 * repeat is deliberate, why removing it re-opens a permanent skip, why the
 * parse is the club-time kernel's, and what an opaque cursor means.
 *
 * What is THIS sync's to prove is that the repeated rows are harmless here: the
 * merge below is idempotent — an identical row is counted `unchanged` and not
 * written, and an older remote row loses to a newer local one.
 */
const OVERLAP_SYNC_LABEL = "Other Clubs";

export interface DownloadSummary {
  fetched: number;
  created: number;
  updated: number;
  /** Fetched rows already identical locally — left untouched (no `updatedAt` bump). */
  unchanged: number;
  /**
   * Rows where the LOCAL copy was newer, so the remote was not applied — by the
   * timestamp read before the write, or because a local edit landed between
   * that read and the guarded write.
   */
  keptLocal: number;
  /** Of `updated`, rows renamed in place to the server's new name (#64). */
  renamed: number;
  /**
   * Lodges renamed on the server whose new name another local lodge holds
   * (#64): `lodge` is the local name — everything else was applied and the old
   * name kept — or `null` for a lodge new here, which was not added. `wanted`
   * is the server's name.
   */
  nameConflicts: NameConflict[];
  /**
   * Lodges the central server deleted that this download HID here (#58), by
   * name: kept for the bookings and requests that name them, and gone from
   * the lists and drop-downs.
   */
  hiddenLodges: string[];
  /** Rows the server sent that failed validation and were discarded. */
  dropped: number;
}

/**
 * Pull the distributed Other Clubs set and merge it into the local registry.
 * Incremental in two ways: the stored cursor means only entries the server
 * changed since last time are fetched — deliberately overlapped backwards by
 * `PULL_CURSOR_OVERLAP_MS` WHEN that cursor is an ISO instant (see
 * `@/lib/servernz-cursor-overlap`) — and a fetched row is only written when
 * its data — any data column, or its amenity list — actually differs from the
 * local copy, so an unchanged row keeps its `updatedAt` and is never needlessly
 * re-uploaded. A field the server did not send is left alone rather than
 * cleared. A lodge's amenity set is replaced whole, in one transaction with the
 * lodge row, after the pull has finished.
 *
 * Each lodge is merged by `mergeDistributedLodge` (`@/lib/servernz-other-lodges-merge`):
 * which row it is (central id, else name), the rename rules (#64), and the two
 * rules that keep `updatedAt` honest as the upload watermark's signal.
 */
export async function downloadOtherClubsFromServer(): Promise<DownloadSummary> {
  const settings = await loadServerNzSettings();
  // The connection this download is for (#64): checked again under the lock
  // before anything is recorded.
  const connection = await readServerNzApiKeyStamp();
  // Ask from one overlap BEFORE the stored cursor, where the stored cursor is
  // an instant — see `@/lib/servernz-cursor-overlap` for why the repeat is deliberate,
  // why removing it re-opens a permanent skip, and what an opaque cursor means.
  // The stored cursor itself is untouched here.
  //
  // Until a whole-registry download has merged to the end (#64: a site just
  // upgraded, a new connection, or a keying download that failed part-way),
  // every download asks for the WHOLE registry instead, so every row is
  // matched by name once and keyed — not only the lodges that happen to change.
  const wholeRegistry = settings.otherLodgesKeyedAt === null;
  const pull = await pullOtherLodges(
    wholeRegistry
      ? null
      : overlappedRequestCursor(settings.otherLodgesCursor, OVERLAP_SYNC_LABEL),
  );

  if (pull.ownLodgeNamesRefused) {
    logger.warn(
      "The central server sent an owned-lodge list that failed its bounds; it was ignored and the stored list left as it was",
    );
  }
  if (pull.ownLodgesRefused) {
    logger.warn(
      "The central server sent owned-lodge ids that failed their bounds; they were ignored and the stored ids cleared, so no lodge is answered for until a download carries valid ids",
    );
  }
  // Which lodges are OURS for this merge: the list this pull carried, else the
  // stored one; `null` when neither is known. Decides two things per row below.
  const owned = pull.ownLodgeNames ?? settings.otherLodgesOwnedNames;

  // Lodges the server DELETED (#58, API 2.4) are hidden here FIRST, and a
  // pulled lodge the server also reports deleted (its reads are not one
  // snapshot) is left out of the merge, so it ends hidden. Hidden, never
  // removed (owner decision): the row stays for the bookings and requests that
  // name it. A server that sends no list hides nothing.
  const deletedIds = new Set(pull.deletedLodgeIds ?? []);
  const hiddenLodges: string[] = [];
  let unlinkedLodges = 0;
  for (const centralId of deletedIds) {
    const outcome = await hideDeletedLodge(centralId);
    if (outcome.hidden !== null) hiddenLodges.push(outcome.hidden);
    unlinkedLodges += outcome.unlinked;
  }
  // One record of what the download hid and unlinked, written HERE so the
  // nightly pass and the Download button leave the same trail (an
  // administrator's own Central lodge change is audited too).
  if (hiddenLodges.length > 0 || unlinkedLodges > 0) {
    await createAuditLog({
      action: "alpine_server.other_lodges.hidden",
      category: "lodge",
      severity: "info",
      outcome: "success",
      summary: "Lodges deleted on the Alpine Central Server were hidden",
      details: `hidden ${hiddenLodges.length}${hiddenLodges.length ? ` (${hiddenLodges.join(", ")})` : ""}; club lodges unlinked from them ${unlinkedLodges}`,
    });
  }
  const lodges = pull.lodges.filter((l) => {
    const id = usableCentralId(l.id);
    return id === null || !deletedIds.has(id);
  });

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let keptLocal = 0;
  let renamed = 0;
  const nameConflicts: NameConflict[] = [];
  // Whether every local row this download touched ended keyed: the marker is
  // set only then. A dropped row or a pulled lodge with no usable id could
  // leave a row the server DOES list unkeyed, and so wrongly marked "not
  // found". A name conflict does not block it: a renamed row is already keyed,
  // and a refused new lodge has no local row to mark.
  let everyLodgeKeyed =
    pull.dropped === 0 && lodges.every((l) => usableCentralId(l.id) !== null);
  const count = (outcome: Exclude<MergeOutcome, { kind: "deferred" }>) => {
    if (outcome.nameConflict) nameConflicts.push(outcome.nameConflict);
    if (outcome.kind === "conflict") return;
    if (outcome.notKeyed) everyLodgeKeyed = false;
    if (outcome.kind === "created") created++;
    else if (outcome.kind === "updated") updated++;
    else if (outcome.kind === "unchanged") unchanged++;
    else keptLocal++;
    if (outcome.renamed) renamed++;
  };
  // The pull has COMPLETED before this loop starts, so no transaction below is
  // ever held open across the central server's HTTP call. A lodge whose name
  // is held here by another row is DEFERRED (#64). The deferred lodges are
  // retried for as long as a pass settles at least one of them — which settles
  // a chain of renames of any length, whatever order the pull sent them in —
  // and then once more as the FINAL pass, which reports what still collides
  // rather than losing it silently.
  // A whole download names every id the server has, which is what lets the
  // merge tell a stale id (another server's, or a deleted lodge's) from a
  // different lodge holding a name — but only when the pull dropped nothing: a
  // dropped row's id is the server's yet absent here, and its local row must
  // not be taken over by another lodge with its old name.
  const knownIds =
    wholeRegistry && pull.dropped === 0
      ? new Set(lodges.flatMap((l) => usableCentralId(l.id) ?? []))
      : null;
  let pending = lodges;
  for (;;) {
    const next: typeof lodges = [];
    for (const lodge of pending) {
      const outcome = await mergeDistributedLodge(lodge, owned, false, knownIds);
      if (outcome.kind === "deferred") next.push(lodge);
      else count(outcome);
    }
    if (next.length === 0 || next.length === pending.length) {
      pending = next;
      break;
    }
    pending = next;
  }
  for (const lodge of pending) {
    const outcome = await mergeDistributedLodge(lodge, owned, true, knownIds);
    if (outcome.kind !== "deferred") count(outcome);
  }
  if (nameConflicts.length > 0) {
    logger.warn(
      { lodges: nameConflicts },
      "Lodges renamed on the central server could not take their new name here: another local lodge holds it",
    );
  }

  // The durable watermark is the SERVER's returned cursor, never the overlapped
  // value we requested with: the overlap exists to widen the question, not to
  // move the answer backwards — and `advancedDownloadCursor` is what enforces
  // that second half, because a server echoing `since` on an empty page would
  // otherwise hand the overlapped value straight back. Reached only after every
  // row above merged, so a throw part-way leaves the old cursor standing and the
  // next run re-fetches.
  //
  // The owned list rides in the same write (#52), and only when the server sent
  // one: `undefined` leaves the stored list alone, so an older server that does
  // not send it cannot clear what a newer one recorded. A name in the list with
  // no local row is simply absent locally until a download creates it. The
  // owned IDS (#62) follow the names: names recorded without usable ids (an
  // older server, or ids refused above) CLEAR the stored ids, so the
  // availability endpoint never answers on an older list than the names.
  //
  // The NAMES are stored as this site names them (#64): a lodge renamed here
  // keeps its local name until the server accepts the rename, and every "may
  // this lodge be changed here?" check reads the list by local name. Each owned
  // id — this pull's, else the stored ones when this pull's were refused — is
  // mapped to its local row's name, read under the settings row's lock, which an
  // admin's rename also takes: neither can write back a list computed before the
  // other committed.
  //
  // A whole-registry download that got this far, with no row dropped by the
  // pull's bounds and none left unkeyed, keyed the registry: the marker is set
  // and later downloads are incremental again. Otherwise the next download is
  // a whole one again.
  //
  // Under the lock the CONNECTION is read again — the server address and the
  // API key's stamp: a download that started before an administrator pointed
  // this site at a different server or replaced its key (which forgets the
  // connection's answers, the marker included) records NOTHING, so it cannot
  // write the old connection's cursor, owned list or marker back.
  //
  // A clean whole download also FORGETS every central id the server no longer
  // lists (another server's after an address change, or a lodge deleted
  // there), so such a row uploads by name again and is marked "not found".
  // Raw, so `updatedAt` stays put: a forgotten id is not an edit.
  const recorded = await prisma.$transaction(async (tx) => {
    await lockServerNzSettings(tx);
    const current = await tx.serverNzSettings.findUnique({
      where: { id: SERVERNZ_SETTINGS_ID },
      select: { baseUrl: true, otherLodgesCursor: true, otherLodgesKeyedAt: true },
    });
    if ((current?.baseUrl ?? null) !== settings.baseUrl) return false;
    if ((await readServerNzApiKeyStamp(tx)) !== connection) return false;
    // Another download recorded since this one started: its answer is newer,
    // so this one records nothing rather than write an older cursor back or
    // forget ids that download has just keyed. Since #66 the buttons and the
    // nightly pass share the sync claim, so this guards the rarer case of a
    // claim reaped as stale under a pass still running.
    if (
      (current?.otherLodgesCursor ?? null) !== settings.otherLodgesCursor ||
      (current?.otherLodgesKeyedAt?.toISOString() ?? null) !== settings.otherLodgesKeyedAt
    ) {
      return false;
    }
    const keyed = wholeRegistry && everyLodgeKeyed;
    // A club lodge linked to a deleted central lodge in the moments since the
    // hide above (an administrator's Central lodge save) is unlinked again, now
    // that the owned list recorded below no longer names it (#58).
    if (deletedIds.size > 0) {
      await tx.$executeRaw(
        Prisma.sql`UPDATE "Lodge" SET "centralLodgeId" = NULL WHERE "centralLodgeId" IN (${Prisma.join([...deletedIds])})`,
      );
    }
    if (keyed && knownIds !== null) {
      // One bound parameter per id (`Prisma.join`), as the rest of the code
      // base binds lists; an empty registry lists none, so every id goes.
      await tx.$executeRaw(
        knownIds.size === 0
          ? Prisma.sql`UPDATE "OtherLodge" SET "centralId" = NULL WHERE "centralId" IS NOT NULL AND "hiddenAt" IS NULL`
          : Prisma.sql`UPDATE "OtherLodge" SET "centralId" = NULL WHERE "centralId" IS NOT NULL AND "hiddenAt" IS NULL AND "centralId" NOT IN (${Prisma.join([...knownIds])})`,
      );
    }
    const ownedIds = pull.ownLodges ?? settings.otherLodgesOwnedLodges ?? [];
    const ownLodgeNames =
      pull.ownLodgeNames === undefined
        ? undefined
        : ownedNamesAsLocal(
            pull.ownLodgeNames,
            ownedIds,
            await localNamesByCentralId(
              ownedIds.map((l) => l.id),
              tx,
            ),
          );
    await recordOtherLodgesDownload(
      advancedDownloadCursor(settings.otherLodgesCursor, pull.cursor),
      ownLodgeNames,
      pull.ownLodges,
      { keyed, db: tx },
    );
    return true;
  });
  if (!recorded) {
    logger.warn(
      "The Alpine Central Server connection changed, or another Other lodges download recorded first, while this one ran; nothing from it was recorded",
    );
  }
  return {
    fetched: pull.count,
    created,
    updated,
    unchanged,
    keptLocal,
    renamed,
    nameConflicts,
    hiddenLodges,
    dropped: pull.dropped,
  };
}
