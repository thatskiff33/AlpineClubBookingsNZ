// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@/lib/__tests__/support/club-time-render";

/**
 * #4951 — the server-rendered member screens reached from an email link, and
 * the two booking-request token screens, each have exactly one level-1 heading
 * in every state they render.
 *
 * Each is one card whose title is the page's h1 (`headingLevel={1}`). Before
 * #4951 the title only LOOKED like a heading, so a screen reader's heading list
 * was empty.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  nominationFindUnique: vi.fn(),
  inviteView: vi.fn(),
  cancellationDetails: vi.fn(),
  noticeForMember: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
  notFound: () => {
    throw new Error("notFound");
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    nominationToken: { findUnique: mocks.nominationFindUnique },
    member: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/club-time/server", () => ({
  clubTime: async () => ({ instantDate: () => "1 Jul 2026", format: {} }),
}));
vi.mock("@/lib/partner-invite-token", () => ({
  getPartnerInviteTokenForClaim: mocks.inviteView,
}));
vi.mock("@/lib/public-layout-config", () => ({
  getCachedClubIdentity: async () => ({ name: "Test Alpine Club" }),
}));
vi.mock("@/lib/membership-cancellation-requests", () => ({
  getMembershipCancellationConfirmationDetails: mocks.cancellationDetails,
}));
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: async () => ({ memberNotices: true }),
}));
vi.mock("@/lib/notices", () => ({ getNoticeForMember: mocks.noticeForMember }));

// The cards nested inside these pages render no heading of their own; they are
// stubbed so the page's outline is all that is measured.
vi.mock("@/components/nomination-confirm-card", () => ({
  NominationConfirmCard: () => null,
}));
vi.mock("@/components/membership-cancellation-confirm-card", () => ({
  MembershipCancellationConfirmCard: () => null,
}));
vi.mock("@/components/mark-notice-read", () => ({ MarkNoticeRead: () => null }));
vi.mock("@/components/notice-acknowledge-button", () => ({
  NoticeAcknowledgeButton: () => null,
}));

import NominationPage from "../(authenticated)/nominations/[token]/page";
import NoticeDetailPage from "../(authenticated)/notices/[id]/page";
import PartnerInvitePage from "../(public)/family-invite/[token]/page";
import MembershipCancellationConfirmationPage from "../(public)/membership-cancellation/[token]/page";
import { BookingRequestRespondClient } from "../(website-dynamic)/booking-requests/respond/[token]/booking-request-respond-client";
import { BookingRequestVerifyClient } from "../(website-dynamic)/booking-requests/verify/[token]/booking-request-verify-client";

function expectOneLevelOneHeading(name: string | RegExp) {
  const headings = screen.getAllByRole("heading", { level: 1 });
  expect(headings).toHaveLength(1);
  expect(headings[0]).toHaveAccessibleName(name);
}

const tokenParams = { params: Promise.resolve({ token: "tok-1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "member-1" } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("/nominations/[token]", () => {
  it("link not found", async () => {
    mocks.nominationFindUnique.mockResolvedValue(null);
    render(await NominationPage(tokenParams));
    expectOneLevelOneHeading("Nomination link not found");
  });

  it("another member's link", async () => {
    mocks.nominationFindUnique.mockResolvedValue({ nominatorMemberId: "member-2" });
    render(await NominationPage(tokenParams));
    expectOneLevelOneHeading("This nomination is not assigned to your account");
  });

  it("the nomination", async () => {
    mocks.nominationFindUnique.mockResolvedValue({
      nominatorMemberId: "member-1",
      confirmedAt: null,
      expiresAt: new Date("2026-08-01T00:00:00.000Z"),
      application: {
        status: "PENDING_NOMINATORS",
        applicantFirstName: "Ana",
        applicantLastName: "Applicant",
        applicantEmail: "ana@example.test",
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        familyMembers: [],
      },
    });
    render(await NominationPage(tokenParams));
    expectOneLevelOneHeading("Nominate Ana Applicant");
  });
});

describe("/family-invite/[token]", () => {
  // Every state renders through the page's one `Shell`, so two states with
  // different titles pin that the Shell's title is the h1.
  it.each([
    [{ status: "invalid" }, "Invitation link not found"],
    [{ status: "expired" }, "Invitation expired"],
  ])("%j", async (view, title) => {
    mocks.inviteView.mockResolvedValue(view);
    render(await PartnerInvitePage(tokenParams));
    expectOneLevelOneHeading(title);
  });
});

describe("/membership-cancellation/[token]", () => {
  it("the request", async () => {
    mocks.cancellationDetails.mockResolvedValue({
      request: null,
      message: "",
      canRespond: false,
    });
    render(await MembershipCancellationConfirmationPage(tokenParams));
    expectOneLevelOneHeading("Membership Cancellation Request");
  });
});

describe("/notices/[id]", () => {
  it("the notice", async () => {
    mocks.noticeForMember.mockResolvedValue({
      id: "notice-1",
      title: "Working bee this weekend",
      bodyHtml: "<p>Bring gloves.</p>",
      pinned: false,
      publishedAt: "2026-06-01T00:00:00.000Z",
      read: false,
      requiresAcknowledgement: false,
    });
    // The page returns null when the notices module is off; it is on here.
    const page = await NoticeDetailPage({ params: Promise.resolve({ id: "notice-1" }) });
    render(page!);
    expectOneLevelOneHeading("Working bee this weekend");
  });

  // The body is admin-authored HTML and the editor offers an H1 button, so the
  // page must not hand a second level-1 heading to a screen reader.
  it("a notice body that contains an H1 still has one level-1 heading", async () => {
    mocks.noticeForMember.mockResolvedValue({
      id: "notice-2",
      title: "Working bee this weekend",
      bodyHtml: "<h1>Details</h1><p>Bring gloves.</p>",
      pinned: false,
      publishedAt: "2026-06-01T00:00:00.000Z",
      read: false,
      requiresAcknowledgement: false,
    });
    const page = await NoticeDetailPage({ params: Promise.resolve({ id: "notice-2" }) });
    render(page!);
    expectOneLevelOneHeading("Working bee this weekend");
    expect(screen.getByRole("heading", { level: 2, name: "Details" })).toBeInTheDocument();
  });
});

describe("/booking-requests token screens", () => {
  // One card wraps every outcome, so its title is the h1 from the first paint.
  it("respond: loading", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    render(<BookingRequestRespondClient token="tok-1" />);
    expectOneLevelOneHeading("Booking Quote");
  });

  it("verify: loading", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    render(<BookingRequestVerifyClient token="tok-1" clubLodgeName="Test Lodge" />);
    expectOneLevelOneHeading("Booking Request Confirmation");
  });
});
