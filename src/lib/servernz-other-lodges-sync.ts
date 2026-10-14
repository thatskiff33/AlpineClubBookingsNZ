import "server-only";
import { ownedNamesAsLocal } from "@/lib/other-lodge-central-id";
import {
  OTHER_LODGE_DATA_SELECT,
  omitRateFields,
  otherLodgeAmenitiesSelect,
  ownsOtherLodge,
  serializeOtherLodgeAmenities,
  serializeOtherLodgeData,
} from "@/lib/other-lodges";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  uploadOtherLodges,
  pullOtherLodges,
  type OtherLodgesUploadResult,
} from "@/lib/servernz-api";
import {
  localNamesByCentralId,
  mergeDistributedLodge,
  registryNeedsKeying,
  type MergeOutcome,
} from "@/lib/servernz-other-lodges-merge";
import { ratesToServer } from "@/lib/servernz-rate";
import {
  advancedDownloadCursor,
  overlappedRequestCursor,
} from "@/lib/servernz-cursor-overlap";
import {
  loadServerNzSettings,
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

  const changed = await prisma.otherLodge.findMany({
    where: since ? { updatedAt: { gt: since } } : {},
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
   * Lodges renamed on the server whose new name another local lodge holds:
   * everything else was applied, the old name kept (#64). The server's names.
   */
  nameConflicts: string[];
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
  // Ask from one overlap BEFORE the stored cursor, where the stored cursor is
  // an instant — see `@/lib/servernz-cursor-overlap` for why the repeat is deliberate,
  // why removing it re-opens a permanent skip, and what an opaque cursor means.
  // The stored cursor itself is untouched here.
  //
  // A registry not yet keyed by central id (#64: just upgraded) asks for the
  // WHOLE registry once instead, so every row is matched and keyed.
  const pull = await pullOtherLodges(
    (await registryNeedsKeying())
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

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let keptLocal = 0;
  let renamed = 0;
  const nameConflicts: string[] = [];
  const count = (outcome: MergeOutcome, lodge: { name: string }) => {
    if (outcome.kind === "deferred") return;
    if (outcome.kind === "conflict" || ("nameConflict" in outcome && outcome.nameConflict)) {
      nameConflicts.push(lodge.name);
    }
    if (outcome.kind === "created") created++;
    else if (outcome.kind === "updated") updated++;
    else if (outcome.kind === "unchanged") unchanged++;
    else if (outcome.kind === "keptLocal") keptLocal++;
    if ("renamed" in outcome && outcome.renamed) renamed++;
  };
  // The pull has COMPLETED before this loop starts, so no transaction below is
  // ever held open across the central server's HTTP call. A lodge whose name
  // is held here by another row is DEFERRED and retried once after the rest
  // (#64): that settles a chain of renames within one pull, and what still
  // collides is reported in the summary rather than lost silently.
  const deferred: typeof pull.lodges = [];
  for (const lodge of pull.lodges) {
    const outcome = await mergeDistributedLodge(lodge, owned, false);
    if (outcome.kind === "deferred") deferred.push(lodge);
    else count(outcome, lodge);
  }
  for (const lodge of deferred) {
    count(await mergeDistributedLodge(lodge, owned, true), lodge);
  }
  if (nameConflicts.length > 0) {
    logger.warn(
      { lodges: nameConflicts },
      "Lodges renamed on the central server could not take their new name here: another local lodge holds it",
    );
  }

  // The owned list is STORED under this site's names (#64): a lodge renamed
  // here keeps its local name until the server accepts the rename, and every
  // "may this lodge be changed here?" check reads the list by local name.
  // Mapped AFTER the merge, which may just have keyed the rows.
  const ownLodgeNames =
    pull.ownLodgeNames === undefined
      ? undefined
      : ownedNamesAsLocal(
          pull.ownLodgeNames,
          pull.ownLodges,
          await localNamesByCentralId((pull.ownLodges ?? []).map((l) => l.id)),
        );

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
  await recordOtherLodgesDownload(
    advancedDownloadCursor(settings.otherLodgesCursor, pull.cursor),
    ownLodgeNames,
    pull.ownLodges,
  );
  return {
    fetched: pull.count,
    created,
    updated,
    unchanged,
    keptLocal,
    renamed,
    nameConflicts,
    dropped: pull.dropped,
  };
}
