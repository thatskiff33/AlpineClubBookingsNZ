// #5266 (owner decision 20 Nov 2026, `INV-ADDPAY-034`): the booking page
// explains a REMOVED booking to whoever the page would admit if it were live as
// its owner or a member guest, and gives everybody else the same plain "not
// found" as an id that never existed — by the same database reads, so a guessed
// or forwarded id is no deleted-versus-live oracle.
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

import { DELETED_BOOKING_MESSAGE } from "@/lib/deleted-booking-refusal";

type Fixture = {
  id: string;
  memberId: string | null;
  organisationId: string | null;
  deletedAt: Date | null;
  guests: Array<{ memberId: string | null }>;
};

const mocks = vi.hoisted(() => ({
  rows: [] as Fixture[],
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  auth: vi.fn(),
}));

/**
 * The few `where` shapes these reads use, evaluated against the fixture rows.
 * Anything else throws, so a query that grew a new filter cannot quietly match
 * everything here.
 */
function matches(row: Fixture, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    switch (key) {
      case "id":
      case "memberId":
        return row[key] === value;
      case "deletedAt":
        if (value === null) return row.deletedAt === null;
        if (JSON.stringify(value) === JSON.stringify({ not: null })) return row.deletedAt !== null;
        throw new Error(`unmodelled deletedAt filter ${JSON.stringify(value)}`);
      case "OR":
        return (value as Array<Record<string, unknown>>).some((arm) => matches(row, arm));
      case "guests": {
        const some = (value as { some?: { memberId?: string } }).some;
        if (!some || Object.keys(some).join() !== "memberId") {
          throw new Error(`unmodelled guests filter ${JSON.stringify(value)}`);
        }
        return row.guests.some((guest) => guest.memberId === some.memberId);
      }
      default:
        throw new Error(`unmodelled where key ${key}`);
    }
  });
}

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findUnique: mocks.findUnique,
      findFirst: mocks.findFirst,
    },
  },
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));

// The money projection the loader adds to a FOUND booking is beside the point
// here, and these fixtures carry no stay dates for it to read.
vi.mock("@/lib/booking-money-reconciliation-store", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  reconcileStoredBookingMoney: () => null,
}));

vi.mock("@/lib/club-time/server", () => ({
  clubTime: async () => ({ today: () => "2026-07-01" }),
}));

vi.mock("@/lib/club-format-server", () => ({
  clubFormat: async () => ({ format: () => "" }),
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
}));

import { notFound } from "next/navigation";
import { resolveBookingDetailEntry } from "../_lib/booking-detail-entry";
import {
  removedBookingEntitledViewerWhere,
  resolveBookingDetailViewer,
} from "../_lib/booking-detail-viewer";
import BookingDetailPage from "../page";

const OWNER = "m-owner";
const GUEST = "m-guest";
const OTHER = "m-other";
const REMOVED_AT = new Date("2026-06-20T00:00:00.000Z");

const REMOVED: Fixture = {
  id: "bk-removed",
  memberId: OWNER,
  organisationId: null,
  deletedAt: REMOVED_AT,
  guests: [{ memberId: OWNER }, { memberId: GUEST }, { memberId: null }],
};
const REMOVED_SCHOOL: Fixture = {
  id: "bk-school",
  memberId: null,
  organisationId: "org-1",
  deletedAt: REMOVED_AT,
  guests: [{ memberId: null }],
};
const LIVE: Fixture = { ...REMOVED, id: "bk-live", deletedAt: null };

function session(id: string, role = "USER") {
  return { user: { id, role: role === "ADMIN" ? "ADMIN" : "MEMBER", accessRoles: [{ role }] } } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rows = [REMOVED, REMOVED_SCHOOL, LIVE];
  mocks.findUnique.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
    mocks.rows.find((row) => matches(row, where)) ?? null,
  );
  mocks.findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    const row = mocks.rows.find((candidate) => matches(candidate, where));
    return row ? { id: row.id } : null;
  });
});

describe("who is told a booking was removed (#5266)", () => {
  it("tells the owner and a member guest on it", async () => {
    for (const viewer of [OWNER, GUEST]) {
      expect(await resolveBookingDetailEntry({ id: REMOVED.id, session: session(viewer) })).toEqual({
        kind: "REMOVED_FOR_VIEWER",
      });
    }
  });

  it("tells another member nothing", async () => {
    expect(await resolveBookingDetailEntry({ id: REMOVED.id, session: session(OTHER) })).toEqual({
      kind: "NOT_FOUND",
    });
  });

  it("grants nothing by role: a Booking Officer or read-only admin not on the booking gets not found", async () => {
    for (const role of ["ADMIN_BOOKINGS", "ADMIN_READONLY"]) {
      expect(
        await resolveBookingDetailEntry({ id: REMOVED.id, session: session("m-officer", role) }),
      ).toEqual({ kind: "NOT_FOUND" });
    }
  });

  it("still tells an officer who owns the booking", async () => {
    expect(
      await resolveBookingDetailEntry({ id: REMOVED.id, session: session(OWNER, "ADMIN_BOOKINGS") }),
    ).toEqual({ kind: "REMOVED_FOR_VIEWER" });
  });

  it("keeps the Full Admin's record view of a removed booking", async () => {
    const entry = await resolveBookingDetailEntry({ id: REMOVED.id, session: session("m-admin", "ADMIN") });
    expect(entry).toMatchObject({ kind: "FOUND", booking: { id: REMOVED.id, deletedAt: REMOVED_AT } });
    expect(mocks.findFirst).not.toHaveBeenCalled();
  });

  it("never loads a removed booking's record for a viewer who is not a Full Admin", async () => {
    await resolveBookingDetailEntry({ id: REMOVED.id, session: session(OWNER) });
    expect(mocks.findUnique).toHaveBeenCalledTimes(1);
    expect(mocks.findUnique.mock.calls[0]?.[0]).toMatchObject({ where: { id: REMOVED.id, deletedAt: null } });
    // The existence check reads the id and nothing else.
    expect(mocks.findFirst.mock.calls[0]?.[0]).toMatchObject({ select: { id: true } });
  });

  it("matches no member on an organisation-owned booking", async () => {
    expect(await resolveBookingDetailEntry({ id: REMOVED_SCHOOL.id, session: session(OWNER) })).toEqual({
      kind: "NOT_FOUND",
    });
  });

  it("loads a live booking for its owner as before", async () => {
    expect(await resolveBookingDetailEntry({ id: LIVE.id, session: session(OWNER) })).toMatchObject({
      kind: "FOUND",
      booking: { id: LIVE.id },
    });
    expect(mocks.findFirst).not.toHaveBeenCalled();
  });
});

describe("never existed and removed-but-not-yours are the same answer", () => {
  /** Every prisma call, with the booking id normalised so the shapes compare. */
  function recordedCalls(bookingId: string) {
    return [mocks.findUnique, mocks.findFirst].map((fn) =>
      JSON.parse(JSON.stringify(fn.mock.calls).split(bookingId).join("<id>")),
    );
  }

  it("makes the same reads with the same arguments and returns the same state", async () => {
    const neverExisted = await resolveBookingDetailEntry({ id: "bk-made-up", session: session(OTHER) });
    const neverCalls = recordedCalls("bk-made-up");
    vi.clearAllMocks();
    const notYours = await resolveBookingDetailEntry({ id: REMOVED.id, session: session(OTHER) });

    expect(notYours).toEqual(neverExisted);
    expect(recordedCalls(REMOVED.id)).toEqual(neverCalls);
  });

  it("is one notFound() on the page with nothing rendered, for both", async () => {
    async function visit(id: string) {
      vi.clearAllMocks();
      mocks.auth.mockResolvedValue(session(OTHER));
      await expect(BookingDetailPage({ params: Promise.resolve({ id }) })).rejects.toThrow("NEXT_NOT_FOUND");
      expect(notFound).toHaveBeenCalledTimes(1);
      return recordedCalls(id);
    }
    expect(await visit(REMOVED.id)).toEqual(await visit("bk-made-up"));
  });

  it("renders the shared sentence to the owner, on the page", async () => {
    mocks.auth.mockResolvedValue(session(OWNER));
    const element = (await BookingDetailPage({ params: Promise.resolve({ id: REMOVED.id }) })) as ReactElement;
    const html = renderToStaticMarkup(element);
    expect(html).toContain("This booking is no longer available");
    expect(html).toContain(DELETED_BOOKING_MESSAGE.replaceAll("'", "&#x27;"));
    expect(notFound).not.toHaveBeenCalled();
  });

  it("sends a signed-out visitor to sign in before any booking is read", async () => {
    mocks.auth.mockResolvedValue(null);
    for (const id of [REMOVED.id, LIVE.id, "bk-made-up"]) {
      await expect(BookingDetailPage({ params: Promise.resolve({ id }) })).rejects.toThrow("redirect:/login");
    }
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(notFound).not.toHaveBeenCalled();
  });
});

describe("the where form agrees with the page's own viewer rule", () => {
  // `removedBookingEntitledViewerWhere` is the query spelling of
  // `isBookingOwner || viewerGuestRow !== null`; if one ever widens alone, a
  // removed booking would be explained to somebody the live page would turn
  // away, or hidden from somebody it admits.
  const table: Fixture[] = [REMOVED, REMOVED_SCHOOL, { ...REMOVED, id: "bk-no-guests", guests: [] }];
  const viewers = [OWNER, GUEST, OTHER];

  for (const booking of table) {
    for (const viewer of viewers) {
      it(`${booking.id} × ${viewer}`, () => {
        const ruled = resolveBookingDetailViewer({
          session: session(viewer),
          booking: { ...booking, member: null, organisation: null } as never,
        });
        const live = ruled.isBookingOwner || ruled.viewerGuestRow !== null;
        expect(matches(booking, removedBookingEntitledViewerWhere(booking.id, viewer) as never)).toBe(live);
      });
    }
  }
});
