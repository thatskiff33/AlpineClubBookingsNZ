// @vitest-environment jsdom

/**
 * #2623 T7. A member who WAS successfully linked after a provider-created /
 * link-failed Xero contact create kept blocking member merge and account
 * deletion indefinitely, because neither blocker predicate consults
 * `Member.xeroContactId` and no link path closed the operation. The half that
 * made it a dead end rather than an inconvenience was discoverability: this page
 * reported a completely clean Xero state, so an operator hit an unexplained
 * refusal with nothing to search for and no hint that the remedy lives on the
 * Xero Operations screen.
 *
 * These assertions pin the disclosure, and that it is keyed on the blocker
 * itself rather than on whether the member happens to be linked.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// #4432: the summary also renders the sync-now button, which reads the session
// and has its own tests (`xero-sync-now-button.test.tsx`); this file pins the blocker.
vi.mock("@/components/admin/xero-sync-now-button", () => ({ XeroSyncNowButton: () => null }));

import { MemberXeroContactSummary } from "@/app/(admin)/admin/members/[id]/_components/member-xero-contact-summary";
import type { MemberDetail } from "@/app/(admin)/admin/members/[id]/_types";

function member(overrides: Partial<MemberDetail>): MemberDetail {
  return {
    xeroContactId: "contact-linked",
    xeroContactGroups: [],
    xeroContactGroupsLoaded: true,
    ...overrides,
  } as unknown as MemberDetail;
}

describe("member Xero contact summary lifecycle blocker (#2623 T7)", () => {
  it("names the blocking operation and the screen that clears it", () => {
    render(
      <MemberXeroContactSummary
        member={member({
          xeroContactLifecycleBlocker: {
            operationId: "op-abc123",
            operationType: "CREATE",
            status: "FAILED",
            providerContactId: "contact-provider",
          },
        })}
        xeroOrgShortCode={null}
      />,
    );

    const notice = screen.getByTestId("xero-lifecycle-blocker");
    expect(notice.textContent).toContain("Member merge and account deletion");
    expect(notice.textContent).toContain("op-abc123");
    expect(notice.textContent).toContain("Admin → Xero → Operations");
  });

  it("shows nothing when no operation is blocking", () => {
    render(
      <MemberXeroContactSummary
        member={member({ xeroContactLifecycleBlocker: null })}
        xeroOrgShortCode={null}
      />,
    );

    expect(screen.queryByTestId("xero-lifecycle-blocker")).toBeNull();
  });

  it("still discloses the blocker for a LINKED member, which is the case that read clean", () => {
    render(
      <MemberXeroContactSummary
        member={member({
          xeroContactId: "contact-linked",
          xeroContactLifecycleBlocker: {
            operationId: "op-linked-but-blocked",
            operationType: "CREATE",
            status: "FAILED",
            providerContactId: "contact-provider",
          },
        })}
        xeroOrgShortCode={null}
      />,
    );

    // The link renders as normal — the member IS linked — and the refusal is
    // disclosed alongside it rather than being hidden by it.
    expect(screen.getByText("contact-linked")).toBeDefined();
    expect(
      screen.getByTestId("xero-lifecycle-blocker").textContent,
    ).toContain("op-linked-but-blocked");
  });
});
