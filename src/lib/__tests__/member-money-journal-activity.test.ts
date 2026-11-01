/**
 * Whether the journal is active for a club (#4627, Ledger M3b): a club whose
 * stored currency no card can be charged in gets an inactive journal before any
 * door's transaction, so the door proceeds and posts nothing. Never a refused
 * posting caught after the fact. The census side is
 * `booking-ledger-projection-census-journal.test.ts`; a real cancel and settle
 * on such a club are `booking-ledger-journal.realdb.test.ts`.
 */
import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({
  format: { currencyCode: "NZD", locale: "en-NZ" } as { currencyCode: string; locale: string; unusableStoredCurrency?: string },
  warn: vi.fn(),
}));
vi.mock("@/lib/club-format-settings", () => ({ getClubFormat: async () => settings.format }));
vi.mock("@/lib/club-time-zone-runtime", () => ({ readClubTimeZoneOutsideRequest: async () => "Pacific/Auckland" }));
vi.mock("@/lib/logger", () => ({ default: { warn: settings.warn, info: vi.fn(), error: vi.fn() } }));

import { bookingJournalInactiveReason } from "@/lib/member-money";
import { postBookingLedgerJournal, postMemberMergeTransfer, resolveBookingMoneyPostingContext } from "@/lib/member-money/doors";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

/** A transaction client that fails the test if the door touches it at all. */
const untouchable = new Proxy({}, {
  get(_target, property) { throw new Error(`the journal reached the database (${String(property)})`); },
}) as Prisma.TransactionClient;
const taxRow = { clubTaxSettings: { findUnique: async () => null } } as never;

describe("an inactive journal for a club whose currency no card can be charged in (#4627)", () => {
  beforeEach(() => {
    settings.format = { currencyCode: "NZD", locale: "en-NZ" };
    settings.warn.mockClear();
  });

  it("is a pure decision on the club's format", () => {
    expect(bookingJournalInactiveReason(CLUB_FORMAT_TEST)).toBeNull();
    expect(bookingJournalInactiveReason({ ...CLUB_FORMAT_TEST, unusableStoredCurrency: "JPY" })).toMatch(/stored currency \(JPY\) cannot be charged/);
  });

  it("resolves an inactive context before the transaction, said once, instead of throwing", async () => {
    settings.format = { currencyCode: "NZD", locale: "en-NZ", unusableStoredCurrency: "JPY" };
    const first = await resolveBookingMoneyPostingContext({ db: taxRow });
    await resolveBookingMoneyPostingContext({ db: taxRow });
    expect(first).toMatchObject({ inactive: "unusable-currency", detail: expect.stringContaining("JPY") });
    expect(settings.warn).toHaveBeenCalledTimes(1);
    // A usable currency still resolves a posting context.
    settings.format = { currencyCode: "NZD", locale: "en-NZ" };
    expect(await resolveBookingMoneyPostingContext({ db: taxRow })).toMatchObject({ currency: "NZD" });
  });

  it("makes every booking door post nothing, without a single journal read", async () => {
    const inactive = { inactive: "unusable-currency", detail: "test" } as const;
    expect(await postBookingLedgerJournal(untouchable, inactive, {
      bookingId: "b1", lodgeId: "l1", event: { kind: "confirmation" }, postingKeys: ["k"],
    })).toBeNull();
  });

  it("never lets a merge transfer be skipped: reaching it inactive throws (merge itself refuses first)", async () => {
    const inactive = { inactive: "unusable-currency", detail: "test" } as const;
    await expect(postMemberMergeTransfer(untouchable, inactive, { fromMemberId: "a", toMemberId: "b", actorMemberId: "c" }))
      .rejects.toThrow(/while the journal is inactive/);
  });
});
