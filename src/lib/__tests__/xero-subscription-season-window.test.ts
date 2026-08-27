import { beforeEach, describe, expect, it, vi } from "vitest";
import { Invoice } from "xero-node";

import { withTimeZone } from "@/lib/__tests__/helpers/timezone";

/**
 * A membership subscription's SEASON WINDOW is decided on the calendar, not on
 * the container's clock (CT-5, #2869).
 *
 * `collectSubscriptionInvoiceMatches` filters a contact's invoices down to the
 * season being refreshed. It used to do that with
 *
 *     const seasonStart = new Date(seasonYear, startMonth - 1, 1);   // HOST-local
 *     const invoiceDate = new Date(invoice.date);                     // shape-dependent
 *     if (invoiceDate < seasonStart) return;
 *
 * and the two sides disagreed for two independent reasons. `new Date(y, m, 1)`
 * is midnight in the CONTAINER's zone, while a Microsoft-JSON invoice date
 * deserialises to UTC midnight — so on a host WEST of Greenwich the season start
 * sits later than the invoice that opens the season, and that invoice falls
 * outside its own season. The member then reads as unpaid with a paid
 * subscription sitting in Xero.
 *
 * That is the whole point of the fixtures below: the invoice is dated the FIRST
 * DAY of the season, and the assertion is repeated on a host behind UTC.
 */

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** One zone behind UTC, one ahead, and UTC itself. */
const HOST_ZONES = ["UTC", "America/Denver", "Pacific/Auckland"];

/**
 * The four shapes Xero can send for `Invoice.date`, each naming 1 April 2026 —
 * the first day of the season for the default 31 March year-end.
 */
const FIRST_DAY_OF_SEASON: ReadonlyArray<readonly [string, unknown]> = [
  ["a plain calendar date", "2026-04-01"],
  ["an offset-less date-time", "2026-04-01T00:00:00"],
  ["an offset-bearing instant", "2026-04-01T00:00:00Z"],
  ["a Microsoft-JSON string", "/Date(1775001600000+0000)/"],
  ["a Date the SDK already built", new Date("2026-04-01T00:00:00.000Z")],
];

const SUBSCRIPTION_ACCOUNT_CODE = "203";

function subscriptionInvoice(date: unknown): Invoice {
  return {
    invoiceID: "inv_sub",
    status: Invoice.StatusEnum.PAID,
    date,
    lineItems: [{ accountCode: SUBSCRIPTION_ACCOUNT_CODE }],
  } as unknown as Invoice;
}

beforeEach(async () => {
  const { __setFinancialYearEndMonthForTesting } = await import(
    "@/lib/financial-year"
  );
  // 31 March year-end, so the season starts on 1 April.
  __setFinancialYearEndMonthForTesting(3);
});

describe("the season window", () => {
  it.each(FIRST_DAY_OF_SEASON)(
    "keeps an invoice dated the first day of the season, from %s, on every host zone",
    async (label, date) => {
      const { collectSubscriptionInvoiceMatches } = await import(
        "@/lib/xero-membership-sync"
      );

      for (const hostZone of HOST_ZONES) {
        withTimeZone(hostZone, () => {
          const matches = collectSubscriptionInvoiceMatches(
            [subscriptionInvoice(date)],
            2026,
            { yearEndMonth: 3, accountCode: SUBSCRIPTION_ACCOUNT_CODE },
          );
          expect(matches, `${label} on ${hostZone}`).toHaveLength(1);
          expect(matches[0]?.isPaid, `${label} on ${hostZone}`).toBe(true);
        });
      }
    },
  );

  it.each(FIRST_DAY_OF_SEASON)(
    "excludes the day BEFORE a season, from %s, on every host zone",
    async (label, date) => {
      const { collectSubscriptionInvoiceMatches } = await import(
        "@/lib/xero-membership-sync"
      );
      // The same fixture read as the season that ENDS on it: 1 April 2026 is the
      // first day of 2026/27, so it must not be counted into 2025/26.
      for (const hostZone of HOST_ZONES) {
        withTimeZone(hostZone, () => {
          expect(
            collectSubscriptionInvoiceMatches(
              [subscriptionInvoice(date)],
              2025,
              { yearEndMonth: 3, accountCode: SUBSCRIPTION_ACCOUNT_CODE },
            ),
            `${label} on ${hostZone}`,
          ).toHaveLength(0);
        });
      }
    },
  );

  it("keeps the last day of a season inside it, on every host zone", async () => {
    const { collectSubscriptionInvoiceMatches } = await import(
      "@/lib/xero-membership-sync"
    );

    for (const hostZone of HOST_ZONES) {
      withTimeZone(hostZone, () => {
        expect(
          collectSubscriptionInvoiceMatches(
            [subscriptionInvoice("2027-03-31")],
            2026,
            { yearEndMonth: 3, accountCode: SUBSCRIPTION_ACCOUNT_CODE },
          ),
          hostZone,
        ).toHaveLength(1);
      });
    }
  });

  // #3116. The season an invoice belongs to used to be decided with
  // `getFinancialYearEndMonth()` - the `financial-year.ts` process cache - and
  // the sweep that calls this runs from `xero-cron-runner.ts`, which never seeds
  // that cache. So on a cold worker a non-March club had its invoices sorted by
  // the March default, putting them in the WRONG SEASON and driving a member's
  // paid/unpaid status from a season row that is not theirs.
  //
  // The `beforeEach` above pins the cache to MARCH and these cases pass DECEMBER
  // in the options, so they fail if the classification ever reads the cache
  // again: a 15 January invoice is season 2025 under a March year-end and season
  // 2026 under a December one, which is the whole disagreement.
  describe("the year-end comes from the caller, not the process cache (#3116)", () => {
    const MID_JANUARY = "2026-01-15";

    it("puts a January invoice in the SAME calendar year's season for a December year-end", async () => {
      const { collectSubscriptionInvoiceMatches } = await import(
        "@/lib/xero-membership-sync"
      );

      for (const hostZone of HOST_ZONES) {
        withTimeZone(hostZone, () => {
          expect(
            collectSubscriptionInvoiceMatches(
              [subscriptionInvoice(MID_JANUARY)],
              2026,
              { yearEndMonth: 12, accountCode: SUBSCRIPTION_ACCOUNT_CODE },
            ),
            hostZone,
          ).toHaveLength(1);
        });
      }
    });

    it("puts the same invoice in the PREVIOUS season for a March year-end", async () => {
      const { collectSubscriptionInvoiceMatches } = await import(
        "@/lib/xero-membership-sync"
      );

      // Same invoice, same requested season, different year-end - and the answer
      // flips. This is what proves the option is load-bearing rather than
      // decorative: if it were ignored, both cases would agree.
      expect(
        collectSubscriptionInvoiceMatches(
          [subscriptionInvoice(MID_JANUARY)],
          2026,
          { yearEndMonth: 3, accountCode: SUBSCRIPTION_ACCOUNT_CODE },
        ),
      ).toHaveLength(0);
      expect(
        collectSubscriptionInvoiceMatches(
          [subscriptionInvoice(MID_JANUARY)],
          2025,
          { yearEndMonth: 3, accountCode: SUBSCRIPTION_ACCOUNT_CODE },
        ),
      ).toHaveLength(1);
    });
  });

  it("drops an invoice whose date Xero sent unreadably, rather than guessing a season", async () => {
    const { collectSubscriptionInvoiceMatches } = await import(
      "@/lib/xero-membership-sync"
    );

    expect(
      collectSubscriptionInvoiceMatches(
        [subscriptionInvoice("2026-02-30"), subscriptionInvoice(undefined)],
        2026,
        { yearEndMonth: 3, accountCode: SUBSCRIPTION_ACCOUNT_CODE },
      ),
    ).toHaveLength(0);
  });
});
