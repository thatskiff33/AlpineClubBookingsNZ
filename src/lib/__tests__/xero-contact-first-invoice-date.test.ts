import { describe, expect, it, vi, beforeEach } from "vitest";

import { withTimeZoneAsync } from "@/lib/__tests__/helpers/timezone";

/**
 * THE ORIGINAL DEFECT OF #2869, pinned (INV-DATE-019, INV-DATE-024).
 *
 * `getContactFirstInvoiceDate` reads a member's earliest Xero invoice and the
 * bulk contact sync writes that day into `Member.joinedDate`. The old line was
 * `new Date(invoices[0].date)`, and it was correct only for the wire shape
 * `xero-node` happened to be producing:
 *
 *   - the SDK types `Invoice.date` as `string` and hands back a `Date` for a
 *     Microsoft-JSON payload, so the same expression parsed two different kinds;
 *   - an offset-less `"2019-03-11T00:00:00"` resolved in the SERVER's zone. Under
 *     the `TZ=Pacific/Auckland` pin in the Dockerfile that is
 *     `2019-03-10T11:00:00Z`, so the member's joined date was stored, and read
 *     back, ONE DAY EARLY.
 *
 * Every case below is asserted under three host zones — one behind UTC, one
 * ahead, and UTC — because a suite pinned to this machine's zone would have
 * passed against the defective code.
 *
 * THERE ARE TWO READERS WITH THIS NAME: the exported one in `xero-contacts.ts`
 * and a private clone in `xero-inbound/contact.ts` — which is exactly how this
 * class of defect hid from the #2834 census. Only the exported one is called
 * directly below, because the clone is reachable only through
 * `reconcileXeroContactFromInbound` and its whole prisma surface. What covers
 * the clone instead is stated rather than assumed: both now call the SAME
 * `xeroCalendarDateAsDateOnly`, whose behaviour under every wire shape and host
 * zone is pinned in `xero-provider-dates.test.ts`, and
 * `xero-provider-date-boundary-census.test.ts` fails if either reader — or any
 * future third one — goes back to parsing a payload date in place.
 */

const mocks = vi.hoisted(() => ({
  callXeroApi: vi.fn(),
  getInvoices: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/xero-api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero-api-client")>();
  return {
    ...actual,
    // The real wrapper's retry/ledger behaviour is not what this suite is about;
    // `XeroDailyLimitError` is kept real because the reader branches on it.
    callXeroApi: (call: () => unknown) => mocks.callXeroApi(call),
    getAuthenticatedXeroClient: vi.fn(),
  };
});

/** A Xero client whose `getInvoices` returns one invoice carrying `date`. */
function xeroReturning(date: unknown) {
  return {
    accountingApi: {
      getInvoices: mocks.getInvoices.mockResolvedValue({
        body: { invoices: [{ invoiceID: "inv_1", date }] },
      }),
    },
  } as never;
}

beforeEach(() => {
  mocks.callXeroApi.mockReset();
  mocks.callXeroApi.mockImplementation((call: () => unknown) => call());
  mocks.getInvoices.mockReset();
});

/**
 * The four shapes, all naming 11 March 2019. `/Date(1552262400000+0000)/` is
 * that day's UTC midnight in epoch milliseconds — the classic Accounting API's
 * encoding of a date-only value — and the `Date` is what the SDK turns it into.
 */
const ELEVENTH_OF_MARCH: ReadonlyArray<readonly [string, unknown]> = [
  ["a plain calendar date", "2019-03-11"],
  ["an offset-less date-time", "2019-03-11T00:00:00"],
  ["an offset-bearing instant", "2019-03-11T00:00:00Z"],
  ["a Microsoft-JSON string", "/Date(1552262400000+0000)/"],
  ["a Date the SDK already built", new Date("2019-03-11T00:00:00.000Z")],
];

const HOST_ZONES = ["UTC", "America/Denver", "Pacific/Auckland"];

describe("getContactFirstInvoiceDate (xero-contacts)", () => {
  it.each(ELEVENTH_OF_MARCH)(
    "stores the same joined date from %s, on every host zone",
    async (label, date) => {
      const { getContactFirstInvoiceDate } = await import("@/lib/xero-contacts");

      for (const hostZone of HOST_ZONES) {
        await withTimeZoneAsync(hostZone, async () => {
          const joinedDate = await getContactFirstInvoiceDate(
            xeroReturning(date),
            "tenant",
            "contact",
          );
          // `Member.joinedDate` is a calendar day held at UTC midnight
          // (INV-DATE-024), so the assertion is the exact stored instant.
          expect(joinedDate?.toISOString(), `${label} on ${hostZone}`).toBe(
            "2019-03-11T00:00:00.000Z",
          );
        });
      }
    },
  );

  // The defect, made executable: this is what the removed expression produced
  // on the deployment's own pinned zone.
  it("no longer stores the previous day for an offset-less payload", async () => {
    const { getContactFirstInvoiceDate } = await import("@/lib/xero-contacts");

    await withTimeZoneAsync("Pacific/Auckland", async () => {
      expect(new Date("2019-03-11T00:00:00").toISOString()).toBe(
        "2019-03-10T11:00:00.000Z",
      );
      const joinedDate = await getContactFirstInvoiceDate(
        xeroReturning("2019-03-11T00:00:00"),
        "tenant",
        "contact",
      );
      expect(joinedDate?.toISOString()).toBe("2019-03-11T00:00:00.000Z");
    });
  });

  it.each<readonly [string, unknown]>([
    ["a day that does not exist", "2019-02-30"],
    ["a name", "not-a-date"],
    ["an empty string", ""],
    ["nothing", undefined],
  ])("returns null for %s rather than inventing a day", async (_label, date) => {
    const { getContactFirstInvoiceDate } = await import("@/lib/xero-contacts");

    await expect(
      getContactFirstInvoiceDate(xeroReturning(date), "tenant", "contact"),
    ).resolves.toBeNull();
  });

  it("returns null when the contact has no invoices at all", async () => {
    const { getContactFirstInvoiceDate } = await import("@/lib/xero-contacts");
    const xero = {
      accountingApi: {
        getInvoices: mocks.getInvoices.mockResolvedValue({ body: { invoices: [] } }),
      },
    } as never;

    await expect(
      getContactFirstInvoiceDate(xero, "tenant", "contact"),
    ).resolves.toBeNull();
  });

  it("returns null when Xero answers with no invoices key", async () => {
    const { getContactFirstInvoiceDate } = await import("@/lib/xero-contacts");
    const xero = {
      accountingApi: {
        getInvoices: mocks.getInvoices.mockResolvedValue({ body: {} }),
      },
    } as never;

    await expect(
      getContactFirstInvoiceDate(xero, "tenant", "contact"),
    ).resolves.toBeNull();
  });

  it("still lets a daily-limit error propagate so the caller can abort", async () => {
    const { getContactFirstInvoiceDate } = await import("@/lib/xero-contacts");
    const { XeroDailyLimitError } = await import("@/lib/xero-api-client");
    mocks.callXeroApi.mockRejectedValue(new XeroDailyLimitError(60));

    await expect(
      getContactFirstInvoiceDate(xeroReturning("2019-03-11"), "tenant", "contact"),
    ).rejects.toBeInstanceOf(XeroDailyLimitError);
  });

  it("swallows any other Xero failure and reports no joined date", async () => {
    const { getContactFirstInvoiceDate } = await import("@/lib/xero-contacts");
    mocks.callXeroApi.mockRejectedValue(new Error("Xero is down"));

    await expect(
      getContactFirstInvoiceDate(xeroReturning("2019-03-11"), "tenant", "contact"),
    ).resolves.toBeNull();
  });
});
