import "server-only";
import { prisma } from "@/lib/prisma";
import {
  uploadOtherLodges,
  pullOtherLodges,
  type OtherLodgesUploadResult,
} from "@/lib/servernz-api";
import {
  loadServerNzSettings,
  recordOtherLodgesUpload,
  recordOtherLodgesDownload,
} from "@/lib/servernz-settings";

/**
 * Sync the local "Other lodges" registry (the club's Other Clubs details) with
 * the Alpine Central Server. Upload pushes this club's entries up; download
 * pulls the centrally-distributed set down and merges it into the local
 * registry, keyed by the unique lodge name.
 */

export interface UploadSummary extends OtherLodgesUploadResult {
  /** Local rows considered for upload (changed since the last upload). */
  sent: number;
}

// The contact/capacity columns that carry a lodge's data. Kept in one place so
// the upload projection and the download diff stay in step.
const LODGE_DATA_SELECT = {
  location: true,
  bookingOfficerName: true,
  bookingOfficerEmail: true,
  bookingOfficerPhone: true,
  bedCapacity: true,
} as const;

/**
 * Push the club's changed Other Clubs entries to the central server.
 *
 * Incremental: only rows whose `updatedAt` is newer than the last upload
 * watermark (`otherLodgesLastUploadAt`) are sent — new and edited rows, never
 * the whole table. On the first upload (no watermark) every row is sent. When
 * nothing has changed, no request is made and the watermark is left untouched.
 */
export async function uploadOtherClubsToServer(): Promise<UploadSummary> {
  const settings = await loadServerNzSettings();
  const since = settings.otherLodgesLastUploadAt
    ? new Date(settings.otherLodgesLastUploadAt)
    : null;

  const lodges = await prisma.otherLodge.findMany({
    where: since ? { updatedAt: { gt: since } } : {},
    select: { name: true, updatedAt: true, ...LODGE_DATA_SELECT },
    orderBy: { name: "asc" },
  });

  if (lodges.length === 0) {
    // Nothing changed since the last upload — skip the round-trip entirely.
    return { created: 0, updated: 0, unchanged: 0, skipped: 0, results: [], sent: 0 };
  }

  const result = await uploadOtherLodges(
    lodges.map((l) => ({
      name: l.name,
      location: l.location,
      bookingOfficerName: l.bookingOfficerName,
      bookingOfficerEmail: l.bookingOfficerEmail,
      bookingOfficerPhone: l.bookingOfficerPhone,
      bedCapacity: l.bedCapacity,
    })),
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

export interface DownloadSummary {
  fetched: number;
  created: number;
  updated: number;
  /** Fetched rows already identical locally — left untouched (no `updatedAt` bump). */
  unchanged: number;
  /** Rows where the LOCAL copy was newer, so the remote was not applied. */
  keptLocal: number;
  /** Rows the server sent that failed validation and were discarded. */
  dropped: number;
}

/**
 * Pull the distributed Other Clubs set and merge it into the local registry.
 * Incremental in two ways: the stored cursor means only entries the server
 * changed since last time are fetched, and a fetched row is only written when
 * its data actually differs from the local copy — so an unchanged row keeps its
 * `updatedAt` and is never needlessly re-uploaded. Keyed by unique lodge name.
 *
 * TWO rules keep `updatedAt` honest as a sync signal, because the upload
 * watermark is derived from it:
 *
 *  1. A server-sourced write carries the SERVER's `updatedAt`, not `now()`.
 *     Prisma's `@updatedAt` would otherwise stamp the moment we wrote it, which
 *     re-presents a row we merely received as a local edit — and the next
 *     upload dutifully sends it back. (The server reports identical content as
 *     `unchanged`, so that echo settles after one redundant round trip rather
 *     than running forever; it is still a lie about when the row last changed,
 *     and the watermark is built on that field.)
 *
 *  2. A remote row OLDER than the local copy is not applied. Upload runs before
 *     download in the same pass, so an admin editing a row in between would
 *     otherwise have their edit overwritten by the copy the server was already
 *     holding — and, with rule 1, the stale value would then look authoritative.
 *     Newest-timestamp-wins keeps the club's own fresh edit and lets the next
 *     upload carry it.
 */
export async function downloadOtherClubsFromServer(): Promise<DownloadSummary> {
  const settings = await loadServerNzSettings();
  const pull = await pullOtherLodges(settings.otherLodgesCursor);

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let keptLocal = 0;
  for (const lodge of pull.lodges) {
    const existing = await prisma.otherLodge.findUnique({
      where: { name: lodge.name },
      select: { id: true, updatedAt: true, ...LODGE_DATA_SELECT },
    });
    const data = {
      location: lodge.location,
      bookingOfficerName: lodge.bookingOfficerName,
      bookingOfficerEmail: lodge.bookingOfficerEmail,
      bookingOfficerPhone: lodge.bookingOfficerPhone,
      bedCapacity: lodge.bedCapacity,
    };

    // The server's own timestamp for this row. An unparseable value falls back to
    // `null`, which means "let Prisma stamp it" — worse than the server's answer
    // but better than refusing the row.
    const remoteUpdatedAt = Number.isNaN(Date.parse(lodge.updatedAt))
      ? null
      : new Date(lodge.updatedAt);

    if (!existing) {
      // Upsert, not create: `name` is unique and this read-then-write is not
      // atomic, so a concurrent writer (an admin pressing Download while the
      // 03:00 cron runs, or the two directions of a manual double-click) can
      // insert the same name in the gap and turn a plain create into a P2002
      // that aborts the whole merge part-way — after some rows were written and
      // before the cursor advanced, so the next run re-fetches from the old
      // cursor. The upsert lets the loser of that race fall through to the same
      // update it would have made, and stays correct when it wins.
      await prisma.otherLodge.upsert({
        where: { name: lodge.name },
        create: {
          name: lodge.name,
          ...data,
          ...(remoteUpdatedAt ? { updatedAt: remoteUpdatedAt } : {}),
        },
        update: { ...data, ...(remoteUpdatedAt ? { updatedAt: remoteUpdatedAt } : {}) },
      });
      created++;
      continue;
    }

    const differs =
      existing.location !== data.location ||
      existing.bookingOfficerName !== data.bookingOfficerName ||
      existing.bookingOfficerEmail !== data.bookingOfficerEmail ||
      existing.bookingOfficerPhone !== data.bookingOfficerPhone ||
      existing.bedCapacity !== data.bedCapacity;

    if (!differs) {
      unchanged++;
      continue;
    }

    // Rule 2: a local edit made after the server's copy wins and is left to the
    // next upload. Equal timestamps apply the remote, so a server correction
    // issued in the same instant is not silently dropped.
    if (remoteUpdatedAt && existing.updatedAt > remoteUpdatedAt) {
      keptLocal++;
      continue;
    }

    await prisma.otherLodge.update({
      where: { id: existing.id },
      // Rule 1: carry the server's timestamp rather than letting `@updatedAt`
      // stamp now(), so this row is not re-uploaded as though we had edited it.
      data: { ...data, ...(remoteUpdatedAt ? { updatedAt: remoteUpdatedAt } : {}) },
    });
    updated++;
  }

  await recordOtherLodgesDownload(pull.cursor);
  return {
    fetched: pull.count,
    created,
    updated,
    unchanged,
    keptLocal,
    dropped: pull.dropped,
  };
}
