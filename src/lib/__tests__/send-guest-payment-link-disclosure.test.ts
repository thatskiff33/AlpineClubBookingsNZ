import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2258 round-2 (HIGH). `POST /api/bookings/[id]/send-guest-payment-link` is
 * NOT admin-only: the BOOKER calls it for their own booking. Its only client
 * renders the response's `error` verbatim, so any cause named here is shown to
 * the member.
 *
 * The per-booking "No emails" switch is an internal club decision. Naming it to
 * a member discloses an admin control they cannot see elsewhere and invites
 * them to ask for it to be changed — so the cause is disclosed to admins only.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  hasAdminAccess: vi.fn(),
  bookingFindUnique: vi.fn(),
  issueSplitGuestPaymentLink: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));
vi.mock("@/lib/access-roles", () => ({ hasAdminAccess: mocks.hasAdminAccess }));
vi.mock("@/lib/prisma", () => ({
  prisma: { booking: { findUnique: mocks.bookingFindUnique } },
}));
vi.mock("@/lib/payment-link-split-guest", () => ({
  issueSplitGuestPaymentLink: mocks.issueSplitGuestPaymentLink,
}));
vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { POST } from "@/app/api/bookings/[id]/send-guest-payment-link/route";

const params = Promise.resolve({ id: "parent-1" });

function request() {
  return new NextRequest(
    "http://localhost/api/bookings/parent-1/send-guest-payment-link",
    { method: "POST" },
  );
}

/** Words that would give the member the existence of the switch. */
const DISCLOSING_TERMS = [
  "no emails",
  "turn emails back on",
  "set to send no emails",
  "switch",
  "setting",
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "member-1" } });
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.hasAdminAccess.mockReturnValue(false);
  mocks.bookingFindUnique.mockResolvedValue({
    memberId: "member-1",
    deletedAt: null,
    linkedBookings: [{ id: "child-1" }],
  });
  mocks.issueSplitGuestPaymentLink.mockResolvedValue({ outcome: "withheld" });
});

describe("send-guest-payment-link withheld disclosure (#2258)", () => {
  it("never names the cause to the booking's own member", async () => {
    const res = await POST(request(), { params });
    const body = await res.json();

    expect(res.status).toBe(409);
    const error = String(body.error).toLowerCase();
    for (const term of DISCLOSING_TERMS) {
      expect(error, `member-facing error disclosed "${term}"`).not.toContain(term);
    }
    // Still honest that nothing was sent, and points somewhere useful.
    expect(error).toContain("contact the club");
  });

  it("names the cause to an admin, who can act on it", async () => {
    mocks.hasAdminAccess.mockReturnValue(true);

    const res = await POST(request(), { params });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(String(body.error).toLowerCase()).toContain("no emails");
  });

  it("reports a mixed outcome instead of unqualified success", async () => {
    mocks.bookingFindUnique.mockResolvedValue({
      memberId: "member-1",
      deletedAt: null,
      linkedBookings: [{ id: "child-1" }, { id: "child-2" }],
    });
    mocks.issueSplitGuestPaymentLink
      .mockResolvedValueOnce({ outcome: "sent" })
      .mockResolvedValueOnce({ outcome: "withheld" });

    const res = await POST(request(), { params });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ sent: 1, notDelivered: 1 });
  });

  // The FIELD NAME is disclosure too: a `withheld` key in devtools tells a
  // member the shortfall was deliberate, which is exactly what the error
  // strings are careful never to say.
  it("never sends cause-specific counts to a member, only the aggregate", async () => {
    mocks.bookingFindUnique.mockResolvedValue({
      memberId: "member-1",
      deletedAt: null,
      linkedBookings: [{ id: "child-1" }, { id: "child-2" }],
    });
    mocks.issueSplitGuestPaymentLink
      .mockResolvedValueOnce({ outcome: "sent" })
      .mockResolvedValueOnce({ outcome: "withheld" });

    const body = await (await POST(request(), { params })).json();

    expect(body).not.toHaveProperty("withheld");
    expect(body).not.toHaveProperty("suppressed");
    expect(body).not.toHaveProperty("transientFailure");
    // The client only ever reads these two, so nothing breaks.
    expect(body).toMatchObject({ sent: 1, notDelivered: 1 });
  });

  it("does give an admin the cause-specific counts", async () => {
    mocks.hasAdminAccess.mockReturnValue(true);
    mocks.bookingFindUnique.mockResolvedValue({
      memberId: "someone-else",
      deletedAt: null,
      linkedBookings: [{ id: "child-1" }, { id: "child-2" }],
    });
    mocks.issueSplitGuestPaymentLink
      .mockResolvedValueOnce({ outcome: "sent" })
      .mockResolvedValueOnce({ outcome: "withheld" });

    const body = await (await POST(request(), { params })).json();

    expect(body).toMatchObject({ sent: 1, withheld: 1, notDelivered: 1 });
  });

  it("does not report a shortfall when everything went out", async () => {
    mocks.issueSplitGuestPaymentLink.mockResolvedValue({ outcome: "sent" });

    const body = await (await POST(request(), { params })).json();

    expect(body).toMatchObject({ sent: 1, notDelivered: 0 });
  });

  // A transient read failure is not an undeliverable address: reporting the 502
  // would misinform the member and point an officer at the wrong diagnosis.
  it("reports an unreadable-setting failure as retryable, not as undeliverable", async () => {
    mocks.issueSplitGuestPaymentLink.mockResolvedValue({
      outcome: "transient_failure",
    });

    const res = await POST(request(), { params });
    const body = await res.json();

    expect(res.status).toBe(503);
    const error = String(body.error).toLowerCase();
    expect(error).toContain("try again");
    expect(error).not.toContain("undeliverable");
    for (const term of DISCLOSING_TERMS) {
      expect(error, `error disclosed "${term}"`).not.toContain(term);
    }
  });

  it("keeps the undeliverable-address 502 for a genuinely suppressed address", async () => {
    mocks.issueSplitGuestPaymentLink.mockResolvedValue({ outcome: "suppressed" });

    const res = await POST(request(), { params });

    expect(res.status).toBe(502);
    expect(String((await res.json()).error).toLowerCase()).toContain(
      "undeliverable",
    );
  });
});
