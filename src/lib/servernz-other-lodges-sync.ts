import "server-only";
import { Prisma } from "@prisma/client";
import { usableCentralId } from "@/lib/other-lodge-central-id";
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
import { isSafeHttpUrl } from "@/lib/http-url";
import logger from "@/lib/logger";
import { syncOwnOtherLodgesFromFees } from "@/lib/other-lodge-fees-sync";
import { prisma } from "@/lib/prisma";
import {
  uploadOtherLodges,
  pullOtherLodges,
  type OtherLodgesUploadResult,
} from "@/lib/servernz-api";
import {
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
 * the lodge name, once, before that (#64, `@/lib/servernz-other-lodges-merge`).
 * Names are not unique (#69): the id is what tells two lodges apart.
 */

export interface UploadSummary extends OtherLodgesUploadResult {
  /** Local rows considered for upload (changed since the last upload). */
  sent: number;
  /** Nothing was sent: the central server has not yet said which lodges are ours (#69). */
  ownedUnknown?: true;
}

const NOTHING_UPLOADED: UploadSummary = {
  created: 0,
  updated: 0,
  unchanged: 0,
  skipped: 0,
  results: [],
  sent: 0,
};

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
 * rule (by central id, #69) the admin PATCH route and the panel also apply.
 * Every row sent is therefore keyed and goes up under its id. While the list
 * is UNKNOWN (never received: a new connection, or one just forgotten) NOTHING
 * is sent (#69): names may repeat, so an unkeyed copy of another club's lodge
 * sent without an id would be CREATED on the server as this club's. The
 * nightly pass's download records the list, and the next upload sends. A row
 * the server reports as `skipped` is held below the watermark (INV-INT-004).
 *
 * A stored list that is PRESENT BUT UNREADABLE is neither: it is a defect in
 * the column, and the honest answer is to send nothing until a download
 * rewrites it, rather than fall back to sending every row because the parsed
 * value happens to be `null`.
 */
export async function uploadOtherClubsToServer(): Promise<UploadSummary> {
  const settings = await loadServerNzSettings();
  if (settings.otherLodgesOwnedLodgesUnreadable) {
    logger.warn(
      "The stored owned-lodge list cannot be read; uploading nothing until the next download rewrites it",
    );
    return { ...NOTHING_UPLOADED };
  }
  const since = settings.otherLodgesLastUploadAt
    ? new Date(settings.otherLodgesLastUploadAt)
    : null;
  const owned = settings.otherLodgesOwnedLodges;
  if (owned === null) {
    logger.info("The central server has not said which Other lodges are this club's yet; uploading nothing until a download records it");
    return { ...NOTHING_UPLOADED, ownedUnknown: true };
  }

  // First bring this club's own lodge up to date with its Fees page (#77): a
  // season that has rolled over, or a configuration import, moves its rates
  // here, and the row it rewrites is newer than the watermark, so it goes now.
  await syncOwnOtherLodgesFromFees("upload");

  // A hidden lodge (#58) is never uploaded: it is a deleted lodge kept here.
  const changed = await prisma.otherLodge.findMany({
    where: { ...visibleOtherLodgeWhere, ...(since ? { updatedAt: { gt: since } } : {}) },
    select: { id: true, name: true, centralId: true, updatedAt: true, ...LODGE_DATA_SELECT },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  const lodges = changed.filter((l) => ownsOtherLodge(owned, l));

  if (lodges.length === 0) {
    // Nothing changed since the last upload — skip the round-trip entirely.
    return { ...NOTHING_UPLOADED };
  }

  // Every data column (dates as `YYYY-MM-DD`) and the WHOLE amenity list: the
  // server replaces its set for the lodge with what is sent, so a partial list
  // would delete the rest.
  // The rates leave as the server's dollar keys, never as the `…Cents`
  // columns (#61): the server's item schema is strict and would refuse them.
  // A booking page address the central server would refuse (#55: saved here
  // before this site held it to the server's stricter rule) is LEFT OUT of
  // that lodge's item (owner decision), so the server keeps what it had and
  // the rest of the lodge, and every other lodge, still goes up. A refused
  // item would fail the whole upload. One warning names the lodges.
  const oddSiteUrls: string[] = [];
  const result = await uploadOtherLodges(
    lodges.map((l) => {
      const data = serializeOtherLodgeData(l);
      const { siteUrl, ...rest } = omitRateFields(data);
      const keepSiteUrl = siteUrl == null || isSafeHttpUrl(siteUrl);
      if (!keepSiteUrl) oddSiteUrls.push(l.name);
      const commonData = keepSiteUrl ? { ...rest, siteUrl } : rest;
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

  if (oddSiteUrls.length > 0) {
    logger.warn(
      { lodges: oddSiteUrls },
      "Other lodges uploaded without their booking page address, which the central server would refuse; fix it on the Lodges page",
    );
  }

  // Advance the watermark to the newest `updatedAt` the server ACCEPTED. Any row
  // edited after this read has a larger `updatedAt` and is caught next time.
  //
  // Rows the server reported as `skipped` are excluded (INV-INT-004). Advancing
  // past a rejected row is how a rejection becomes permanent: the row is never
  // re-sent, so it silently never reaches the registry and nothing says so. By
  // holding the watermark below the oldest skipped row, every subsequent run
  // retries it — and `skipped` is surfaced in the summary so an operator can see
  // a row that keeps bouncing.
  //
  // Each result answers the item AT ITS POSITION (#69): names may repeat, so a
  // name cannot say which row a result is for, and an item sent without an id
  // only learns its id from the answer. A result whose name, or (for an item
  // that quoted one) id, is not its item's means the answer does not line up:
  // nothing is accepted, and the next run sends the rows again. (The server
  // answers one result per item, in order: its 2.5 contract.)
  const answers = lodges.map((l, i) => {
    const r = result.results[i];
    const id = r ? usableCentralId(r.id) : null;
    const lines =
      r !== undefined && r.name === l.name.trim() && (!l.centralId || id === l.centralId);
    return { lodge: l, lines, ok: lines && r?.status !== "skipped", id };
  });
  const aligned = result.results.length === lodges.length && answers.every((a) => a.lines);
  if (!aligned) {
    logger.warn("The central server's upload answer did not line up with the lodges sent; the upload watermark was left as it was");
  }
  const accepted = aligned ? answers.filter((a) => a.ok).map((a) => a.lodge) : [];
  const rejected = aligned ? answers.filter((a) => !a.ok).map((a) => a.lodge) : lodges;

  const [firstAccepted] = accepted;
  if (accepted.length > 0 && firstAccepted) {
    const oldestSkipped = rejected.reduce<Date | null>(
      (min, l) => (!min || l.updatedAt < min ? l.updatedAt : min),
      null,
    );

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
   * Lodges this download could not place (#69): one sent without a usable id
   * whose name several local lodges share, or a new one whose central id a
   * concurrent writer held on the final pass. `lodge` is `null` (not added);
   * `wanted` is the server's name.
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

  if (pull.ownLodgesRefused) {
    logger.warn(
      "The central server sent an owned-lodge list that failed its bounds; it was ignored and the stored list left as it was",
    );
  }
  // Which lodges are OURS for this merge: the list this pull carried, else the
  // stored one; `null` when neither is known. Decides two things per row below.
  const owned = pull.ownLodges ?? settings.otherLodgesOwnedLodges;

  // Lodges the server DELETED (#58, API 2.4) are hidden here FIRST, and a
  // pulled lodge the server also reports deleted (its reads are not one
  // snapshot) is left out of the merge, so it ends hidden. Hidden, never
  // removed (owner decision): the row stays for the bookings and requests that
  // name it. A server that sends no list hides nothing.
  const deletedIds = new Set(pull.deletedLodgeIds ?? []);
  // Only the deleted ids this club HOLDS are visited one by one: a whole-registry
  // pull repeats every deletion ever made, and hiding a lodge that was never
  // here (or is hidden already) would be a round trip per id under the claim.
  const heldDeleted =
    deletedIds.size === 0
      ? []
      : (await prisma.otherLodge.findMany({
          where: { centralId: { in: [...deletedIds] }, hiddenAt: null },
          select: { centralId: true },
        }))
          .map((row) => row.centralId)
          .filter((id): id is string => id !== null && deletedIds.has(id));
  const hiddenLodges: string[] = [];
  let unlinkedLodges = 0;
  for (const centralId of heldDeleted) {
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
  // found". A lodge reported as not placed does not block it: it has no local
  // row to mark.
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
  // ever held open across the central server's HTTP call. A lodge that lost a
  // race with a concurrent writer is DEFERRED; the deferred lodges are retried
  // for as long as a pass settles at least one of them, and then once more as
  // the FINAL pass, which reports what still misses rather than losing it.
  // A whole download names every id the server has, which is what lets the
  // merge tell a stale id (another server's, or a deleted lodge's) from a
  // different lodge of the same name — but only when the pull dropped nothing: a
  // dropped row's id is the server's yet absent here, and its local row must
  // not be taken over by another lodge with its old name.
  const knownIds =
    wholeRegistry && pull.dropped === 0
      ? new Set(lodges.flatMap((l) => usableCentralId(l.id) ?? []))
      : null;
  // Keying by name (#69: names may repeat) only on a whole download, which
  // sees every lodge of the name: when the name is one lodge's alone, or for
  // our own lodge. Otherwise a lodge with an id is new here, never welded onto
  // a row that may be another lodge of the same name.
  const namesInPull = new Map<string, number>();
  for (const l of lodges) namesInPull.set(l.name, (namesInPull.get(l.name) ?? 0) + 1);
  // On `wholeRegistry`, not on `knownIds`: a whole download that dropped a row
  // still keys by name (else every unkeyed row would gain a twin); the dropped
  // row only stops ids from being treated as stale.
  const byNameAllowed = (lodge: (typeof lodges)[number]) =>
    wholeRegistry &&
    (namesInPull.get(lodge.name) === 1 || ownsOtherLodge(owned, { centralId: usableCentralId(lodge.id) }));
  let pending = lodges;
  for (;;) {
    const next: typeof lodges = [];
    for (const lodge of pending) {
      const outcome = await mergeDistributedLodge(lodge, owned, false, knownIds, byNameAllowed(lodge));
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
    const outcome = await mergeDistributedLodge(lodge, owned, true, knownIds, byNameAllowed(lodge));
    if (outcome.kind !== "deferred") count(outcome);
  }
  if (nameConflicts.length > 0) {
    logger.warn(
      { lodges: nameConflicts },
      "Lodges on the central server could not be placed here: a concurrent change held their id, or several local lodges share the name of one sent without an id",
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
  // a valid one: `undefined` leaves the stored list alone. A lodge in the list
  // with no local row is simply absent locally until a download creates it. It
  // is stored by central id (#62, #69), so a lodge renamed here stays ours
  // whatever it is called.
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
    await recordOtherLodgesDownload(
      advancedDownloadCursor(settings.otherLodgesCursor, pull.cursor),
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
