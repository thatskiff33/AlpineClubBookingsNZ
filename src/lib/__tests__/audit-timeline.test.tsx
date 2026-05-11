// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuditTimeline } from "@/components/audit-timeline";
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
