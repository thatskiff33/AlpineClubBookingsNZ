// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  expectRevealed,
  installScrollIntoViewSpy,
  removeScrollIntoViewSpy,
  type ScrollIntoViewSpy,
} from "@/lib/__tests__/helpers/focus";

// #5234: the Stuck States mismatch items link to /admin/xero?section=…. The page
// used only to OPEN that section, while still on its loading screen, so the
// operator landed at the top of the page. The link must land on the section.

const navigation = vi.hoisted(() => ({ search: "" }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/xero",
  useSearchParams: () => new URLSearchParams(navigation.search),
}));

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ name: "Test Club" }),
}));

vi.mock("../_components/webhook-health-panel", () => ({ WebhookHealthPanel: () => null }));

// The diagnostics panel stands in for the real one with just the section the
// link names, rendered where the real panel renders it: after the status read.
vi.mock("../_components/panels", async () => {
  const { xeroSectionId } = (await vi.importActual("../_components/types")) as typeof import("../_components/types");
  const stub = () => null;
  return {
    GoToXeroButton: stub,
    xeroLinkState: () => "connected",
    ClubTaxCard: stub,
    XeroTaxOverridePauseCard: stub,
    ConnectionStatusPanel: stub,
    ContactSyncPanel: stub,
    ErasedMemberContactsPanel: stub,
    HealthAndDiagnosticsPanels: ({ contactGroupMismatchesOpen }: { contactGroupMismatchesOpen: boolean }) => (
      <section id={xeroSectionId("contactGroupMismatches")} data-testid="group-mismatches" data-open={String(contactGroupMismatchesOpen)}>
        Contact Group Mismatches
      </section>
    ),
    InboundEventsPanel: stub,
    MembershipSyncPanel: stub,
    MissingContactsPanel: stub,
    OperationsPanel: stub,
    SyncResultsPanel: stub,
    TaxCategoryMappingCard: stub,
    UsagePanel: stub,
  };
});

import XeroPage from "../page";

let scrollIntoView: ScrollIntoViewSpy;

beforeEach(() => {
  scrollIntoView = installScrollIntoViewSpy();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) =>
      String(input).startsWith("/api/admin/xero/status")
        ? new Response(JSON.stringify({ connected: true, needsReentry: false, tenantId: "t-1", tokenExpiresAt: null }), { status: 200 })
        : new Response("{}", { status: 404 }),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  removeScrollIntoViewSpy();
  navigation.search = "";
});

describe("/admin/xero?section= (#5234)", () => {
  it("opens the named section and scrolls to it once the page has loaded", async () => {
    navigation.search = "section=contactGroupMismatches";
    await act(async () => {
      render(<XeroPage />);
    });

    const section = await screen.findByTestId("group-mismatches");
    await waitFor(() => expect(section.getAttribute("data-open")).toBe("true"));
    await waitFor(() => expectRevealed(scrollIntoView, section));
  });

  it("scrolls nowhere without a section, or for one the page does not have", async () => {
    for (const search of ["", "section=notASection"]) {
      navigation.search = search;
      await act(async () => {
        render(<XeroPage />);
      });
      const section = await screen.findByTestId("group-mismatches");
      expect(section.getAttribute("data-open")).toBe("false");
      expect(scrollIntoView).not.toHaveBeenCalled();
      cleanup();
    }
  });
});
