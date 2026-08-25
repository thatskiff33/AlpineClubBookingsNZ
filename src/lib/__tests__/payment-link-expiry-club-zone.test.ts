/**
 * Whose civil day a payment link dies at the end of (CT-4, #2870;
 * `INV-CONFIG-002`).
 *
 * ## What was wrong
 *
 * The pay page and the approval email both state the link's expiry as a moment
 * in the club's PERSISTED timezone (#3068). The mint derived the stored instant
 * from `APP_TIME_ZONE` — the deployment's `TZ` seed — so for a club whose zone
 * differs from its host environment's, `PaymentLink.expiresAt` meant something
 * different from what both surfaces said. Nine sites across four files each
 * wrote the boundary out again; two of them are the settlement cron's
 * capacity-releasing `PENDING -> CANCELLED` terminal decisions, bound to the
 * mint's boundary by a comment saying "so the two can never disagree".
 *
 * ## How this suite can see it, on every host
 *
 * `divergentClubZone` (`helpers/club-time-zone.ts`) is the epic's hoisted
 * chooser: it takes the derivation and returns a persisted zone whose answer is
 * proven to differ from BOTH `APP_TIME_ZONE`'s answer and the host's own. That
 * is what a hand-picked literal cannot promise — `APP_TIME_ZONE` with no `TZ`
 * IS `Pacific/Auckland`, so a suite persisting Auckland cannot tell the
 * persisted zone from the environment however much it asserts, and a
 * hand-picked `America/Denver` stops discriminating on a Denver developer's
 * machine without going red.
 *
 * The club's row is a fake; the REAL `readClubTimeZoneOutsideRequest` runs, so
 * these tests also pin which reader the production path uses. That reader is
 * deliberately the CLI-safe one and not `clubTime()`: all four files are
 * reachable from `src/instrumentation.node.ts`, which
 * `docs/CLUB_TIME_KERNEL.md` -> "Where the zone comes from" makes the deciding
 * measurement.
 *
 * ## The lock guard is the other half
 *
 * Resolving the zone is a `clubTimeSettings` query, and three of the nine sites
 * run inside a `prisma.$transaction` already holding the per-lodge capacity
 * lock. `does not read the club's zone inside the lock transaction` counts the
 * reads that happen while the callback is running, so an `await` that drifts
 * back under the lock fails here rather than in production as a lock held for
 * the length of a settings query.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { BookingStatus } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  clubTimeSettingsFindUnique: vi.fn(),
  paymentLinkFindUnique: vi.fn(),
  paymentLinkFindFirst: vi.fn(),
  paymentLinkCreate: vi.fn(),
  paymentLinkUpdateMany: vi.fn(),
  bookingFindUnique: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    clubTimeSettings: { findUnique: mocks.clubTimeSettingsFindUnique },
    paymentLink: {
      findUnique: mocks.paymentLinkFindUnique,
      findFirst: mocks.paymentLinkFindFirst,
      create: mocks.paymentLinkCreate,
      updateMany: mocks.paymentLinkUpdateMany,
      update: vi.fn(),
    },
    booking: { findUnique: mocks.bookingFindUnique },
    payment: { upsert: vi.fn() },
    emailLog: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "emaillog-1" }),
    },
    bookingEvent: { findMany: vi.fn().mockResolvedValue([]) },
    lodge: { findFirst: vi.fn().mockResolvedValue({ id: "lodge-1" }) },
    $transaction: mocks.transaction,
    $executeRaw: vi.fn(),
  },
}));

vi.mock("@/lib/stripe", () => ({
  createPaymentIntent: vi.fn(),
  findOrCreateCustomer: vi.fn(),
  getPaymentIntent: vi.fn(),
}));

const emailMocks = vi.hoisted(() => ({
  sendBookingRequestApprovedEmail: vi.fn(),
  sendSplitGuestPaymentLinkEmail: vi.fn(),
}));

vi.mock("@/lib/email", () => ({
  sendAdminPaymentFailureAlert: vi.fn().mockResolvedValue(undefined),
  sendBookingRequestApprovedEmail: emailMocks.sendBookingRequestApprovedEmail,
  sendSplitGuestPaymentLinkEmail: emailMocks.sendSplitGuestPaymentLinkEmail,
}));

vi.mock("@/lib/payment-reconciliation", () => ({
  markBookingPaymentSucceeded: vi.fn(),
}));
vi.mock("@/lib/booking-payment-cleanup", () => ({
  queueSupersededPrimaryIntentCancellations: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/payment-transactions", () => ({
  findPaymentTransactionByIntentId: vi.fn().mockResolvedValue(null),
  upsertPaymentIntentTransaction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/capacity", () => ({
  checkCapacityForGuestRanges: vi.fn(),
  acquireLodgeCapacityLock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/xero-booking-invoice-queue", () => ({
  queueXeroInvoiceForPaidBooking: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { readFileSync } from "node:fs";
import path from "node:path";

import { hashActionToken, issueActionToken } from "@/lib/action-tokens";
import type { ClubTimeZone } from "@/lib/club-time";
import { paymentLinkExpiryForCheckIn } from "@/lib/payment-link-expiry";
import {
  issueSplitGuestPaymentLink,
  mintSplitGuestPaymentLinkIfAbsent,
  reissuePaymentLinkForToken,
} from "@/lib/payment-link";

import { divergentClubZone } from "./helpers/club-time-zone";

/** A check-in comfortably after the repository's frozen `2026-07-01T00:00Z`. */
const CHECK_IN_DAY = "2026-08-01";
const CHECK_IN = new Date(`${CHECK_IN_DAY}T00:00:00.000Z`);

/** The civil date an instant falls on in a zone, `yyyy-MM-dd`. */
function civilDateIn(zone: string, at: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/**
 * The last millisecond whose civil date in `zone` is `day` — the INDEPENDENT
 * oracle, found by bisecting `Intl` rather than by any offset arithmetic the
 * code under test also uses.
 *
 * It has to be independent, and the first version of this file learned why the
 * hard way. Deriving the oracle from `paymentLinkExpiryForCheckIn` itself made
 * a mutant that ignored the zone entirely DISARM the zone chooser: every
 * candidate then produced the same answer, `divergentClubZone` correctly refused
 * to return one, and the suite died at import with "no tests" instead of nine
 * assertion failures. A guard whose oracle shares the bug cannot see it.
 */
function lastInstantOfCivilDay(zone: string, day: string): Date {
  const anchor = Date.parse(`${day}T00:00:00.000Z`);
  // Two days either side is beyond every real UTC offset, so the invariant
  // (`lo` is on or before `day`, `hi` is after it) holds before the first step.
  let lo = anchor - 2 * 86_400_000;
  let hi = anchor + 2 * 86_400_000;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (civilDateIn(zone, new Date(mid)) <= day) lo = mid;
    else hi = mid;
  }
  return new Date(lo);
}

/**
 * The club's zone, and the expiry instant it implies, chosen so that neither
 * `APP_TIME_ZONE`'s answer nor the host's can match it.
 *
 * A premise failure here is a FAILURE and never a skip (owner decision, #2870).
 */
const CLUB = divergentClubZone((zone: ClubTimeZone) =>
  lastInstantOfCivilDay(zone, CHECK_IN_DAY).toISOString(),
);

/** The instant the club's own day really ends on. */
const CLUB_EXPIRY = new Date(CLUB.expected);

const RAW_TOKEN = issueActionToken().token;

function splitChild(overrides: Record<string, unknown> = {}) {
  return {
    id: "child-1",
    memberId: "member-1",
    status: BookingStatus.PENDING,
    checkIn: CHECK_IN,
    checkOut: new Date("2026-08-03T00:00:00.000Z"),
    finalPriceCents: 12_000,
    deletedAt: null,
    parentBookingId: "parent-1",
    hasNonMembers: true,
    lodgeId: "lodge-1",
    noEmails: false,
    noEmailsAt: null,
    member: {
      id: "member-1",
      email: "tara@example.com",
      firstName: "Tara",
      lastName: "Tester",
    },
    guests: [{ id: "g1" }, { id: "g2" }],
    payment: null,
    parentBooking: { id: "parent-1", payment: null },
    groupBookingJoin: null,
    ...overrides,
  };
}

function requestOriginLink() {
  return {
    id: "link-1",
    bookingId: "booking-1",
    bookingRequestId: "req-1",
    tokenHash: hashActionToken(RAW_TOKEN),
    revokedAt: null,
    usedAt: null,
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    booking: {
      id: "booking-1",
      memberId: "member-1",
      status: BookingStatus.PENDING,
      checkIn: CHECK_IN,
      checkOut: new Date("2026-08-03T00:00:00.000Z"),
      finalPriceCents: 12_000,
      deletedAt: null,
      noEmails: false,
      noEmailsAt: null,
      parentBookingId: null,
      groupBookingJoin: null,
      lodgeId: "lodge-1",
      lodge: { name: "Default Lodge" },
      member: {
        id: "member-1",
        email: "tara@example.com",
        firstName: "Tara",
        lastName: "Tester",
      },
      guests: [{ id: "guest-1" }],
      payment: null,
    },
  };
}

/**
 * How many `clubTimeSettings` reads happened while a `$transaction` callback was
 * running. Zero is the contract: the zone is resolved before the lock.
 */
let readsInsideTransaction = 0;

/** A `tx` exposing only what the mint paths touch. */
function lockedTx() {
  return {
    booking: { findUnique: mocks.bookingFindUnique },
    paymentLink: {
      findFirst: mocks.paymentLinkFindFirst,
      create: mocks.paymentLinkCreate,
      updateMany: mocks.paymentLinkUpdateMany,
    },
  } as never;
}

/** Runs the callback, counting any zone read that happened while it ran. */
function runTransactionCallback(arg: unknown) {
  if (typeof arg !== "function") return arg;
  const before = mocks.clubTimeSettingsFindUnique.mock.calls.length;
  const finish = () => {
    readsInsideTransaction +=
      mocks.clubTimeSettingsFindUnique.mock.calls.length - before;
  };
  return Promise.resolve((arg as (tx: unknown) => unknown)(lockedTx())).finally(
    finish,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  readsInsideTransaction = 0;
  // The club HAS chosen a zone, so the real reader resolves the persisted value
  // rather than the environment seed. Only the row is a fake.
  mocks.clubTimeSettingsFindUnique.mockResolvedValue({ timeZone: CLUB.zone });
  mocks.paymentLinkFindFirst.mockResolvedValue(null);
  mocks.paymentLinkCreate.mockResolvedValue({ id: "pl-fresh" });
  mocks.paymentLinkUpdateMany.mockResolvedValue({ count: 0 });
  mocks.transaction.mockImplementation(runTransactionCallback);
  emailMocks.sendBookingRequestApprovedEmail.mockResolvedValue({
    status: "sent",
    emailLogId: "log-1",
    messageId: null,
  });
  emailMocks.sendSplitGuestPaymentLinkEmail.mockResolvedValue({
    status: "sent",
    emailLogId: "log-2",
    messageId: null,
  });
});

describe("the premise: three zones, three different expiry instants", () => {
  it("proves the club's answer differs from the environment's and the host's", () => {
    // Without this the assertions below could all pass against a tree that read
    // the environment's zone. Stated as its own test so a chooser or ICU change
    // fails here, legibly, rather than as a date mismatch further down.
    expect(CLUB.expected).not.toBe(CLUB.environmentAnswer);
    expect(CLUB.expected).not.toBe(CLUB.hostAnswer);
  });

  it("agrees with the helper, so the oracle is checking the same boundary", () => {
    // The oracle bisects `Intl`; the helper composes the kernel. They must land
    // on the same millisecond, or the assertions below would be measuring the
    // gap between two definitions rather than which zone reached the mint.
    expect(paymentLinkExpiryForCheckIn(CHECK_IN, CLUB.zone)).toEqual(
      CLUB_EXPIRY,
    );
  });
});

describe("the mint stores the CLUB's end of the check-in day", () => {
  it("reissuePaymentLinkForToken mints on the persisted zone, not APP_TIME_ZONE", async () => {
    mocks.paymentLinkFindUnique.mockResolvedValue(requestOriginLink());

    await reissuePaymentLinkForToken(RAW_TOKEN);

    expect(
      mocks.paymentLinkCreate.mock.calls[0]?.[0]?.data?.expiresAt,
      "INV-CONFIG-002: the pay page and the approval email both state this " +
        "instant in the club's persisted zone. Minting it from APP_TIME_ZONE " +
        "makes the stored deadline a different moment from the one the member " +
        "was told.",
    ).toEqual(CLUB_EXPIRY);
  });

  it("issueSplitGuestPaymentLink stores AND emails the same club instant", async () => {
    // The divergence class is not "one surface is wrong" but "two derivations
    // of one boundary" — so this asserts the pair AGREE, which two independent
    // assertions could not: both can be satisfied while the values differ.
    mocks.bookingFindUnique
      .mockResolvedValueOnce(splitChild())
      .mockResolvedValueOnce({ status: BookingStatus.PENDING });

    const result = await issueSplitGuestPaymentLink("child-1");

    expect(result).toEqual({ outcome: "sent" });
    const stored = mocks.paymentLinkCreate.mock.calls[0]?.[0]?.data?.expiresAt;
    const emailed =
      emailMocks.sendSplitGuestPaymentLinkEmail.mock.calls[0]?.[0]?.expiresAt;
    expect(stored).toEqual(CLUB_EXPIRY);
    expect(
      emailed,
      "The emailed deadline and the stored one must be the same instant. Two " +
        "derivations of one boundary is how the page, the email and the row " +
        "came to mean three different moments (#3068).",
    ).toEqual(stored);
  });

  it("mintSplitGuestPaymentLinkIfAbsent takes the zone and returns the stored instant", async () => {
    const minted = await mintSplitGuestPaymentLinkIfAbsent(
      lockedTx(),
      { id: "child-1", checkIn: CHECK_IN },
      CLUB.zone,
    );

    expect(minted).toEqual({
      token: expect.any(String),
      paymentLinkId: "pl-fresh",
      expiresAt: CLUB_EXPIRY,
    });
    expect(
      mocks.clubTimeSettingsFindUnique,
      "This helper runs inside its caller's lock transaction, so it must never " +
        "resolve the zone itself.",
    ).not.toHaveBeenCalled();
  });
});

describe("the boundary that refuses a mint is the club's too", () => {
  it("refuses a link that would be born expired on the club's day", async () => {
    // A check-in day that has ended under EVERY candidate zone, so the refusal
    // is the boundary and not an artefact of which zone was chosen.
    const minted = await mintSplitGuestPaymentLinkIfAbsent(
      lockedTx(),
      { id: "child-1", checkIn: new Date("2020-01-01T00:00:00.000Z") },
      CLUB.zone,
    );

    expect(minted).toBeNull();
    expect(mocks.paymentLinkCreate).not.toHaveBeenCalled();
  });
});

describe("no zone read happens under a held lock", () => {
  it("does not read the club's zone inside the lock transaction (reissue)", async () => {
    mocks.paymentLinkFindUnique.mockResolvedValue(requestOriginLink());

    await reissuePaymentLinkForToken(RAW_TOKEN);

    expect(mocks.clubTimeSettingsFindUnique).toHaveBeenCalledTimes(1);
    expect(
      readsInsideTransaction,
      "`acquireLodgeCapacityLock` is held for the whole callback. A settings " +
        "query in there lengthens a lock every mint path, the settlement cron " +
        "and every capacity claim contend for, and buys nothing.",
    ).toBe(0);
  });

  it("does not read the club's zone inside the lock transaction (on-demand mint)", async () => {
    mocks.bookingFindUnique
      .mockResolvedValueOnce(splitChild())
      .mockResolvedValueOnce({ status: BookingStatus.PENDING });

    await issueSplitGuestPaymentLink("child-1");

    expect(mocks.clubTimeSettingsFindUnique).toHaveBeenCalledTimes(1);
    expect(readsInsideTransaction).toBe(0);
  });
});

/**
 * The source text of every `$transaction(...)` argument list in `source`, with
 * the line the call starts on.
 *
 * It is a paren matcher rather than a regex because the thing being asked is
 * "is this call INSIDE that callback", which no regex can answer. String
 * literals, template literals, regex-looking slashes and both comment forms are
 * skipped, so a `)` in a message or a `//` in a URL cannot end a span early and
 * let a real offender hide behind it. That mattered: these four files contain
 * plenty of both.
 *
 * A parser would be more correct still. This is deliberately not one — a
 * hand-rolled TypeScript parser in a guard is a larger liability than the
 * property it protects, and the vacuity case below is what catches a scanner
 * that has stopped matching anything.
 */
function transactionCallbackSpans(
  source: string,
): Array<{ line: number; body: string }> {
  const spans: Array<{ line: number; body: string }> = [];
  const NEEDLE = "$transaction(";

  for (let at = source.indexOf(NEEDLE); at !== -1; at = source.indexOf(NEEDLE, at + 1)) {
    const open = at + NEEDLE.length - 1;
    let depth = 0;
    let i = open;
    let end = -1;

    for (; i < source.length; i++) {
      const c = source[i];
      const next = source[i + 1];

      if (c === "/" && next === "/") {
        const nl = source.indexOf("\n", i);
        i = nl === -1 ? source.length : nl;
        continue;
      }
      if (c === "/" && next === "*") {
        const close = source.indexOf("*/", i + 2);
        i = close === -1 ? source.length : close + 1;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        const quote = c;
        i += 1;
        for (; i < source.length; i++) {
          if (source[i] === "\\") {
            i += 1;
            continue;
          }
          if (source[i] === quote) break;
        }
        continue;
      }

      if (c === "(") depth += 1;
      else if (c === ")") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }

    if (end === -1) continue;
    spans.push({
      line: source.slice(0, at).split("\n").length,
      body: source.slice(open + 1, end),
    });
  }

  return spans;
}

/*
  A CENSUS, because the defect class is a call site that writes the boundary out
  again rather than a wrong line in one file. Nine of them did, across four
  files, each beside a comment claiming they agreed.

  `vitest related` cannot reach this describe from a changed production file —
  there is no import edge to the paths it reads off disk — so it is CI-caught by
  design. Run it by name.
*/
describe("every payment-link expiry goes through the one helper", () => {
  const REPO_ROOT = process.cwd();
  const OWNERS = [
    "src/lib/payment-link.ts",
    "src/lib/booking-request.ts",
    "src/lib/group-booking.ts",
    "src/lib/cron-confirm-pending.ts",
  ] as const;

  it("leaves no unzoned day-end derivation in the four files that mint or expire one", () => {
    const offenders: string[] = [];
    for (const file of OWNERS) {
      const source = readFileSync(path.join(REPO_ROOT, file), "utf8");
      // The retired adapter defaults its second argument to `APP_TIME_ZONE`, so
      // a call with one argument is silently the environment's day.
      const unzoned = source.match(
        /endOf(?:DateOnlyForTimeZone|ClubDay(?:Inclusive|Exclusive))\(/g,
      );
      if (unzoned) offenders.push(`${file}: ${unzoned.length}`);
    }

    expect(
      offenders,
      "These files must derive a link's expiry only through " +
        "`paymentLinkExpiryForCheckIn`, which takes the club's zone. A local " +
        "day-end call here is either the environment's day or a second " +
        "derivation of a boundary four decisions are bound to.",
    ).toEqual([]);
  });

  it("each owner file still calls the helper BY THAT EXACT NAME, so an empty census is not a silent pass", () => {
    for (const file of OWNERS) {
      // A word-boundary match, not `toContain`. A substring test is satisfied by
      // any prefix-preserving rename — `paymentLinkExpiryForCheckInZZ` passes it
      // — which is measurably how a published "the helper was renamed away"
      // mutation row came to read as a partial kill while this watchdog had in
      // fact noticed nothing at all.
      //
      // THE TRADE, stated because it is a real one: a CONSISTENT rename of the
      // helper is behaviour-preserving and now fails here, so whoever renames it
      // has to edit this line too. That is the cheaper side. The alternative is a
      // watchdog that cannot tell a rename from a deletion — and telling those
      // apart is the entire job of a case whose name promises the census is not
      // silently passing on files it is no longer watching.
      expect(
        readFileSync(path.join(REPO_ROOT, file), "utf8"),
        `${file} must still call the shared helper; if it no longer does, this ` +
          "census is watching the wrong files.",
      ).toMatch(/\bpaymentLinkExpiryForCheckIn\b/);
    }
  });

  /*
    THE ORDERING GUARD, and the reason it is static rather than a runtime count.

    The runtime `readsInsideTransaction` cases above cover three writers:
    `reissuePaymentLinkForToken`, `issueSplitGuestPaymentLink` and
    `mintSplitGuestPaymentLinkIfAbsent`. NOTHING covered the other two —
    `approveBookingRequest` (`booking-request.ts`) and
    `verifyAndCreateNonMemberJoin` (`group-booking.ts`) — and that gap was
    measured, not supposed: adding a `readClubTimeZoneOutsideRequest()` call
    immediately after `acquireLodgeCapacityLock` in BOTH of those files left all
    219 tests in the seven suites covering them green, `advisory-lock-guard`
    included.

    A refuse-when-handed-a-transaction-client analogue — the shape
    `buildSubscriptionBillingPreview` uses since `42ba10f36` — cannot be built
    here, and the reason is that this PR already took the stronger remedy.
    `paymentLinkExpiryForCheckIn` receives the zone and imports no reader at all,
    so it CANNOT resolve the zone under a lock however it is called; there is no
    client to key a refusal on. What is left to protect is a property of the
    CALLERS: each one's own `await` must sit outside its own transaction. That is
    an ordering fact about source, so a source contract is the honest guard for
    it, and unlike a runtime count it covers all four writers — and any fifth
    one somebody adds — at once.

    The failure it exists to stop, concretely: an edit moves the `await` in
    `booking-request.ts` a few lines down, inside the transaction. Every booking
    request approval then holds `pg_advisory_xact_lock(1)` AND the per-lodge
    capacity lock across a `clubTimeSettings` query, serialising every cancel,
    capture, hold-release and capacity claim behind a settings read.
  */
  it("reads the club's zone outside every transaction, in all four writers", () => {
    const offenders: string[] = [];

    for (const file of OWNERS) {
      const source = readFileSync(path.join(REPO_ROOT, file), "utf8");
      for (const span of transactionCallbackSpans(source)) {
        if (!span.body.includes("readClubTimeZoneOutsideRequest(")) continue;
        offenders.push(`${file}:${span.line}`);
      }
    }

    expect(
      offenders,
      "A `readClubTimeZoneOutsideRequest()` inside a `$transaction` callback " +
        "holds a settings query under whatever locks that transaction took — " +
        "`pg_advisory_xact_lock(1)` and the per-lodge capacity lock, for two of " +
        "these writers. Resolve the zone BEFORE the transaction and thread the " +
        "value in: `payment-link-expiry.ts`, and " +
        "`docs/CONCURRENCY_AND_LOCKING.md` -> \"Which client reads the club's " +
        'timezone".',
    ).toEqual([]);
  });

  it("found real transaction callbacks to inspect, so the ordering guard is not vacuous", () => {
    // Without this, deleting `$transaction` from all four files — or a scanner
    // that silently matched nothing — would leave the guard above passing while
    // reading nothing at all. Nine callbacks across the four files today.
    const spans = OWNERS.flatMap((file) =>
      transactionCallbackSpans(
        readFileSync(path.join(REPO_ROOT, file), "utf8"),
      ),
    );
    expect(spans.length).toBeGreaterThanOrEqual(8);
    for (const span of spans) {
      expect(span.body.length).toBeGreaterThan(0);
    }
  });
});
