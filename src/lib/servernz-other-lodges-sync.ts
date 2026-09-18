import "server-only";
import { parseInstant } from "@/lib/club-time";
import logger from "@/lib/logger";
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

/**
 * How far BEFORE the stored cursor each subsequent pull deliberately re-asks.
 *
 * DO NOT REMOVE THIS AS REDUNDANT. It looks like wasted work — the server is
 * being asked again for rows we have already applied — and it is not. Database
 * transactions do not become visible in timestamp order: a slow transaction can
 * take an earlier `updatedAt` and commit AFTER a faster one that took a later
 * one. If the cursor advances to the faster row's timestamp in the window
 * before the slow row commits, every later "strictly newer than the cursor"
 * request steps straight over the slow row — permanently, because its
 * `updatedAt` never moves again unless somebody happens to edit that club by
 * hand. Sync keeps reporting success while one club's booking officer stays
 * wrong forever (#2995).
 *
 * Re-asking for a bounded window before the cursor covers that race for any
 * commit lag shorter than the window. Sixty seconds is the starting value and
 * is a measurement, not a product rule: engineering may widen it on evidence of
 * longer commit lag. The repeated rows cost nothing, because the merge below is
 * idempotent — an identical row is counted `unchanged` and not written, and an
 * older remote row loses to a newer local one.
 *
 * This applies to the REQUEST only. The durable watermark still advances only
 * to the cursor the server returned on a successful pass, never to the
 * overlapped value and never backwards — see {@link advancedDownloadCursor},
 * which is what stops the widened question from slowly moving the answer.
 *
 * IT HOLDS ONLY FOR A CURSOR THIS CODE CAN DO ARITHMETIC ON. The cursor is
 * contractually opaque, so a server issuing ids or tokens gets no overlap and
 * keeps the defect; {@link overlappedRequestCursor} says so in the log when that
 * is the case, because an inert overlap is otherwise indistinguishable from a
 * working one.
 */
const PULL_CURSOR_OVERLAP_MS = 60_000;

/**
 * The `Z` or `±HH:MM` an ACCEPTED instant cursor ends with.
 *
 * Read positionally rather than re-matched, and only ever called on a value
 * `parseInstant` has already vouched for. A second regular expression restating
 * the instant shape here is precisely the duplicated rule its caller exists to
 * remove (`INV-SSOT-001`): the two copies had already drifted apart, in both
 * directions, before anybody compared them.
 */
function cursorOffsetDesignator(instantCursor: string): string {
  const last = instantCursor.slice(-1);
  if (last === "Z" || last === "z") return last;
  // The offset's sign is the last `+` or `-` in the string; the date's own
  // hyphens are all earlier, so `lastIndexOf` cannot pick one of those.
  return instantCursor.slice(
    Math.max(instantCursor.lastIndexOf("+"), instantCursor.lastIndexOf("-")),
  );
}

/** That designator read as a UTC offset in milliseconds. */
function designatorOffsetMs(designator: string): number {
  if (designator === "Z" || designator === "z") return 0;
  // Both `+13:00` and the basic-format `+1300` are legal and both arrive here.
  const digits = designator.slice(1).replace(":", "");
  const minutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2));
  return (designator.startsWith("-") ? -minutes : minutes) * 60_000;
}

/**
 * The cursor value to REQUEST, given the stored one: one overlap earlier when
 * the stored cursor is an instant, unchanged otherwise, and `null` when there is
 * no stored cursor at all — so an initial/full sync is untouched.
 *
 * THE PARSE IS THE KERNEL'S, not a local regular expression. A local one lived
 * here first and was both narrower and wronger than `parseInstant` in both
 * directions. It missed four legal spellings a central server is free to send —
 * seconds omitted (`…T10:05Z`), a basic-format offset (`+1300`), a lowercase
 * `t`, and a space separator — which are between them what Python's
 * `isoformat()`, .NET and a Postgres `timestamptz` render, so against such a
 * server the overlap was silently inert and the whole fix did nothing. And it
 * ACCEPTED `2026-02-30T00:00:00Z`, which `Date.parse` rolls forward to 2 March:
 * the "step back" then handed the server a cursor two days LATER than the stored
 * one and skipped every row in between — the defect this exists to close,
 * amplified. `parseInstant` refuses that date, and names it.
 *
 * WHATEVER REPLACES THE PARSE MUST STILL DEMAND `Z` OR AN OFFSET. A zone-less
 * `2026-06-20T10:05:30` is not refused by `Date` — it is read in the HOST's
 * zone, so on a New Zealand deployment the requested cursor moves twelve or
 * thirteen hours, silently and plausibly. `parseInstant` is the home of that
 * rule; the note is here because widening the accepted shape is exactly the
 * helpful-looking change that would undo it.
 *
 * IT RE-EMITS IN THE OFFSET IT WAS GIVEN rather than normalising to `Z`, which
 * is not cosmetic either. A server comparing the `since` parameter as TEXT
 * rather than as an instant sees `2026-06-20T10:05:30-05:00` normalise to
 * `2026-06-20T15:04:30.000Z` — a value that sorts AFTER the stored one, turning
 * the overlap into a five-hour jump FORWARD that skips rows. Keeping the
 * original offset, and the original separator, leaves only the date and time
 * digits changed, so the requested value is strictly earlier under both a text
 * comparison and an instant comparison.
 */
function overlappedRequestCursor(stored: string | null): string | null {
  if (!stored) return null;
  const instant = parseInstant(stored);
  if (!instant) {
    // The cursor is contractually OPAQUE (`ServerNzSettings.otherLodgesCursor`),
    // so an id, a token or a sequence number is passed through untouched rather
    // than guessed at — and the overlap simply does not apply to that server.
    // SAY SO. Nothing else distinguishes a working overlap from one that has
    // protected nothing since the day it shipped: the download summary is
    // identical either way, and widening it to carry a diagnostic nobody reads
    // on a good day would push the noise out to the API response and the admin
    // screen.
    logger.warn(
      { cursor: stored },
      "ServerNZ Other Clubs: the stored download cursor is not an ISO instant, so the commit-order overlap (#2995) is NOT being applied to this pull",
    );
    return stored;
  }
  const designator = cursorOffsetDesignator(stored);
  // The date/time separator, which is a `T` in nearly every cursor and a
  // lowercase `t` or a space in the two other legal spellings. Put back for the
  // same reason the offset is: an emitted `T` sorts AFTER a stored space.
  const separator = stored.slice(10, 11);
  const wall = new Date(
    instant.getTime() - PULL_CURSOR_OVERLAP_MS + designatorOffsetMs(designator),
  );
  // `toISOString` renders the shifted wall clock, always as
  // `YYYY-MM-DDTHH:MM:SS.mmmZ`; the cursor's own separator and designator then
  // take the place of that `T` and that `Z`, so only the date and time DIGITS
  // come from the arithmetic. Written as two replacements rather than by cutting
  // the string up, because a ten-character cut of a `toISOString` result is the
  // hand-rolled date-only encoding `INV-DATE-019` bans — a different rule, but
  // this would be indistinguishable from it at a glance and to the linter.
  const requested = wall
    .toISOString()
    .replace("T", separator)
    .replace("Z", designator);
  // Re-checked through the same parser that vouched for the input, so a value
  // this arithmetic cannot express — a year outside four digits — falls back to
  // the stored cursor instead of being sent as a malformed one.
  return parseInstant(requested) ? requested : stored;
}

/**
 * The cursor to PERSIST, given the stored one and the one this pull returned:
 * the later of the two when both are instants, the server's answer otherwise.
 *
 * THE DURABLE WATERMARK MUST NEVER MOVE BACKWARDS — an acceptance criterion of
 * #2995 — and until the overlap existed nothing could push it there, because the
 * request never looked backwards. Now something can. Take the ordinary way a
 * cursor endpoint computes its answer: the newest row it returned, or an echo of
 * `since` when the page is empty. A quiet night then goes stored `C` → request
 * `C − 60s` → no rows → echo `C − 60s` → and the stored watermark BECOMES
 * `C − 60s`. The next quiet run rewinds another minute, an admin pressing
 * Download repeatedly accelerates it, and the re-fetch grows without bound —
 * during exactly the quiet spells that are this registry's normal state. A run
 * that returns rows restores it, which is what would make the symptom
 * intermittent and hard to attribute.
 *
 * An opaque cursor keeps its previous behaviour exactly: nothing here can order
 * two tokens, so the server's answer stands.
 *
 * IT IS NOT ATOMIC against a second downloader running at the same time — two
 * passes that both read the same stored value can still write in either order.
 * That race predates the overlap and closing it needs a lock this issue does not
 * open; what this comparison stops is the single-runner rewind the overlap
 * introduced.
 */
function advancedDownloadCursor(
  stored: string | null,
  returned: string | null,
): string | null {
  if (!returned || !stored) return returned;
  const from = parseInstant(stored);
  const to = parseInstant(returned);
  if (!from || !to) return returned;
  return to.getTime() < from.getTime() ? stored : returned;
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
 * changed since last time are fetched — deliberately overlapped backwards by
 * `PULL_CURSOR_OVERLAP_MS` WHEN that cursor is an ISO instant, read that first —
 * and a fetched row is only written
 * when its data actually differs from the local copy, so an unchanged row keeps
 * its `updatedAt` and is never needlessly re-uploaded. Keyed by unique lodge name.
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
  // Ask from one overlap BEFORE the stored cursor, where the stored cursor is
  // an instant — see `PULL_CURSOR_OVERLAP_MS` for why the repeat is deliberate,
  // why removing it re-opens a permanent skip, and what an opaque cursor means.
  // The stored cursor itself is untouched here.
  const pull = await pullOtherLodges(overlappedRequestCursor(settings.otherLodgesCursor));

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

  // The durable watermark is the SERVER's returned cursor, never the overlapped
  // value we requested with: the overlap exists to widen the question, not to
  // move the answer backwards — and `advancedDownloadCursor` is what enforces
  // that second half, because a server echoing `since` on an empty page would
  // otherwise hand the overlapped value straight back. Reached only after every
  // row above merged, so a throw part-way leaves the old cursor standing and the
  // next run re-fetches.
  await recordOtherLodgesDownload(
    advancedDownloadCursor(settings.otherLodgesCursor, pull.cursor),
  );
  return {
    fetched: pull.count,
    created,
    updated,
    unchanged,
    keptLocal,
    dropped: pull.dropped,
  };
}
