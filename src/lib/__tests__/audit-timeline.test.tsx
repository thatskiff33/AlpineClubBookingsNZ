// @vitest-environment jsdom

import {
  CLUB_TIME_TEST_ZONE,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/lib/__tests__/support/club-time-render";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuditTimeline } from "@/components/audit-timeline";
import { ClubTimeProvider } from "@/components/club-time-provider";
import { bindClubTime, requireClubTimeZone } from "@/lib/club-time";
import type {
  AuditTimelineEntry,
  AuditTimelineResponse,
} from "@/lib/audit-query";

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: ReactNode;
    href: string;
  } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const fetchMock = vi.fn();

function auditEntry(
  overrides: Partial<AuditTimelineEntry>
): AuditTimelineEntry {
  return {
    id: "audit-1",
    action: "booking.payment.confirmed",
    category: "payment",
    severity: "info",
    outcome: "success",
    summary: "Payment confirmed",
    description: null,
    details: null,
    createdAt: "2026-05-10T03:15:00.000Z",
    actor: null,
    actorDisplayName: "Club admin",
    subject: null,
    subjectDisplayName: "Alice Smith",
    subjectMemberId: "member-1",
    entityType: "Booking",
    entityId: "booking-1",
    drilldowns: [],
    metadata: null,
    ...overrides,
  };
}

function auditResponse(
  overrides: Partial<AuditTimelineResponse>
): AuditTimelineResponse {
  return {
    data: [],
    total: 0,
    page: 1,
    pageSize: 10,
    totalPages: 1,
    category: "all",
    categories: [],
    ...overrides,
  };
}

function okJson(body: AuditTimelineResponse) {
  return {
    ok: true,
    json: async () => body,
  } as unknown as Response;
}

describe("AuditTimeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = fetchMock as typeof fetch;
  });

  it("renders member audit entries and fetches the next page", async () => {
    fetchMock
      .mockResolvedValueOnce(
        okJson(
          auditResponse({
            data: [
              auditEntry({ id: "audit-payment" }),
              auditEntry({
                id: "audit-booking",
                action: "booking.cancel",
                category: "booking",
                summary: "Booking cancelled",
              }),
            ],
            total: 3,
            pageSize: 2,
            totalPages: 2,
          })
        )
      )
      .mockResolvedValueOnce(
        okJson(
          auditResponse({
            data: [
              auditEntry({
                id: "audit-family",
                action: "FAMILY_GROUP_INVITE_ACCEPTED",
                category: "family",
                summary: "Family invitation accepted",
              }),
            ],
            total: 3,
            page: 2,
            pageSize: 2,
            totalPages: 2,
          })
        )
      );

    render(<AuditTimeline endpoint="/api/member/audit-log" pageSize={2} />);

    expect(await screen.findByText("Payment confirmed")).toBeTruthy();
    expect(screen.getByText("Booking cancelled")).toBeTruthy();
    expect(screen.getByText("1-2 of 3")).toBeTruthy();
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/member/audit-log?page=1&pageSize=2"
    );

    fireEvent.click(screen.getByRole("button", { name: "Next audit page" }));

    expect(await screen.findByText("Family invitation accepted")).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/member/audit-log?page=2&pageSize=2"
    );
  });

  it("renders admin entity links and metadata when enabled", async () => {
    fetchMock.mockResolvedValueOnce(
      okJson(
        auditResponse({
          data: [
            auditEntry({
              id: "audit-member",
              action: "admin.member.update",
              category: "admin",
              summary: "Member profile updated",
              entityType: "Member",
              entityId: "member-1",
              metadata: { field: "email" },
            }),
          ],
          total: 1,
        })
      )
    );

    const { container } = render(
      <AuditTimeline
        endpoint="/api/admin/audit-log"
        showAdminEntityLinks
        showMetadata
      />
    );

    expect(await screen.findByText("Member profile updated")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Member/ }).getAttribute("href"))
      .toBe("/admin/members/member-1");

    fireEvent.click(screen.getByText("Metadata"));
    expect(container.textContent).toContain('"field": "email"');
  });
});


/**
 * THE STAMP IS SPELLED IN THE CLUB'S PERSISTED ZONE (CT-4, #2870; epic #2988;
 * INV-CONFIG-002).
 *
 * The audit timeline is the canonical `instantDateTime` surface in this tree — a
 * real moment, recorded by the server, read back by a browser that may be
 * anywhere — and it is the class of timestamp every other admin screen was
 * aligned to. Everything above renders through the harness's default provider,
 * `Pacific/Auckland`, which is also what `APP_TIME_ZONE` resolves to under test,
 * so those assertions cannot tell the persisted zone from the environment. They
 * are not about the zone and are correctly left alone.
 *
 * This pair is about the zone. Same fixture, two provider zones, two answers.
 */
describe("AuditTimeline spells a stamp in the club's zone (CT-4, #2870)", () => {
  /** Behind UTC, so it disagrees with the harness zone and with a UTC host. */
  const CLUB_ZONE_BEHIND_UTC = "America/Denver";

  /** The fixture stamp, which the two zones read as different DAYS. */
  const STAMP = "2026-05-10T03:15:00.000Z";

  function providerFor(zone: string) {
    return function PinnedClubTime({ children }: { children: ReactNode }) {
      return <ClubTimeProvider zone={zone}>{children}</ClubTimeProvider>;
    };
  }

  function spelledIn(zone: string): string {
    return bindClubTime(requireClubTimeZone(zone)).instantDateTime(
      new Date(STAMP),
    );
  }

  function stubOneEntry() {
    fetchMock.mockResolvedValueOnce(
      okJson(
        auditResponse({
          data: [auditEntry({ createdAt: STAMP })],
          total: 1,
        }),
      ),
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = fetchMock as typeof fetch;
  });

  it("reads a Denver club's stamp as the previous evening", async () => {
    // PREMISE, as an ANSWER rather than an identifier: the two zones really do
    // disagree about this instant, and by a whole day.
    expect(spelledIn(CLUB_ZONE_BEHIND_UTC)).toBe("9 May 2026, 9:15 pm");
    expect(spelledIn(CLUB_TIME_TEST_ZONE)).toBe("10 May 2026, 3:15 pm");

    stubOneEntry();
    const { container } = render(
      <AuditTimeline endpoint="/api/admin/audit-log" />,
      { wrapper: providerFor(CLUB_ZONE_BEHIND_UTC) },
    );

    expect(await screen.findByText("Payment confirmed")).toBeTruthy();
    expect(container.textContent).toContain(spelledIn(CLUB_ZONE_BEHIND_UTC));
    expect(container.textContent).not.toContain(
      spelledIn(CLUB_TIME_TEST_ZONE),
    );
  });

  it("reads the same stamp as the next afternoon for a club ahead of UTC", async () => {
    // The mirror image, and it is what makes the case above about the PROVIDER
    // rather than about a hard-coded 9 May.
    stubOneEntry();
    const { container } = render(
      <AuditTimeline endpoint="/api/admin/audit-log" />,
      { wrapper: providerFor(CLUB_TIME_TEST_ZONE) },
    );

    expect(await screen.findByText("Payment confirmed")).toBeTruthy();
    expect(container.textContent).toContain(spelledIn(CLUB_TIME_TEST_ZONE));
    expect(container.textContent).not.toContain(
      spelledIn(CLUB_ZONE_BEHIND_UTC),
    );
  });
});
