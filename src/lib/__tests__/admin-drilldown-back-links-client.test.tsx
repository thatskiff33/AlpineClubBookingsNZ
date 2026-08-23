// @vitest-environment jsdom

// #2046 F3: RTL coverage for the drill-down BackLink conversions that live
// behind a client data gate and so cannot be reached by the static-markup
// enforcement suite (admin-leaf-back-links.test.tsx). Where a failed fetch (or
// an always-rendered header) lets us reach the converted BackLink, we assert it
// here so the conversion is genuinely regression-protected — not merely listed.
import "@testing-library/jest-dom/vitest";
import { Suspense } from "react";
import { act, cleanup, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";

// Every page below reads the session permission matrix; provide an edit-level
// admin so gating never short-circuits the render we are asserting on.
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "admin-1",
        accessRoles: ["ADMIN"],
        adminPermissionMatrix: {
          overview: "edit",
          bookings: "edit",
          membership: "edit",
          finance: "edit",
          lodge: "edit",
          content: "edit",
          support: "edit",
        },
      },
    },
  }),
}));

const searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "lodge-7" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => searchParams,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("admin drill-down BackLink conversions (client-gated)", () => {
  it("renders the Lodge configuration error fallback with a BackLink to /admin/lodges", async () => {
    // A non-ok /api/admin/lodges response drives the catch → error fallback,
    // which renders the converted <BackLink href=\"/admin/lodges\" label=\"Lodges\">.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    );
    const LodgeConfigurationHubPage = (
      await import("@/app/(admin)/admin/lodges/[id]/page")
    ).default;

    render(<LodgeConfigurationHubPage />);

    const link = await screen.findByRole("link", { name: "← Lodges" });
    expect(link).toHaveAttribute("href", "/admin/lodges");
  });

  it("renders the Lodge setup 'not found' fallback with a BackLink to /admin/lodges", async () => {
    // F5: a non-ok /api/admin/lodges response drives the setup wizard's
    // loadError fallback, which now renders <BackLink href=\"/admin/lodges\"
    // label=\"Lodges\"> in place of the old plain underline link.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    );
    const LodgeSetupWizardPage = (
      await import("@/app/(admin)/admin/lodges/[id]/setup/page")
    ).default;

    render(<LodgeSetupWizardPage />);

    const link = await screen.findByRole("link", { name: "← Lodges" });
    expect(link).toHaveAttribute("href", "/admin/lodges");
  });

  it("renders the loaded Lodge setup wizard with a BackLink to lodge configuration", async () => {
    // Success path: a valid lodge for the mocked param id lets the wizard render
    // its top-of-page <BackLink href=\"/admin/lodges/lodge-7\" label=\"Lodge
    // configuration\"> (the main conversion, distinct from the fallback above).
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/admin/lodges") {
          return {
            ok: true,
            json: async () => ({
              lodges: [{ id: "lodge-7", name: "Alpine Hut", active: true }],
            }),
          };
        }
        if (url === "/api/admin/modules") {
          return { ok: true, json: async () => ({ settings: {} }) };
        }
        return { ok: true, json: async () => ({}) };
      }),
    );
    const LodgeSetupWizardPage = (
      await import("@/app/(admin)/admin/lodges/[id]/setup/page")
    ).default;

    render(<LodgeSetupWizardPage />);

    const link = await screen.findByRole("link", {
      name: "← Lodge configuration",
    });
    expect(link).toHaveAttribute("href", "/admin/lodges/lodge-7");
  });

  it("renders the member merge page with a BackLink to the master member", async () => {
    // The merge page renders its BackLink unconditionally at the top, so a
    // benign (empty) fetch response is enough to reach it.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );
    const MemberMergePage = (
      await import("@/app/(admin)/admin/members/[id]/merge/page")
    ).default;

    await act(async () => {
      render(
        <Suspense fallback={null}>
          <MemberMergePage params={Promise.resolve({ id: "master-1" })} />
        </Suspense>,
      );
      // Flush the params promise so use() unsuspends before we assert.
      await Promise.resolve();
    });

    const link = await screen.findByRole("link", { name: "← Member" });
    expect(link).toHaveAttribute("href", "/admin/members/master-1");
  });

  it("renders the member detail error fallback with a BackLink to /admin/members", async () => {
    // A 404 on the member load sets pageError → the error fallback renders the
    // converted <BackLink> whose label resolves via getMemberDetailBackLabel.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    );
    const MemberDetailPage = (
      await import("@/app/(admin)/admin/members/[id]/page")
    ).default;

    await act(async () => {
      render(
        <Suspense fallback={null}>
          <MemberDetailPage params={Promise.resolve({ id: "member-9" })} />
        </Suspense>,
      );
      // Flush the params promise (use()) and the failing member fetch so the
      // error fallback — which renders the converted BackLink — is committed.
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(
        screen.getByRole("link", { name: "← Members" }),
      ).toHaveAttribute("href", "/admin/members");
    });
  });

  // Member Notices: both editor leaves (the create page and the [id] edit page)
  // are "use client" pages that fetch on mount, so — like the lodge/member leaves
  // above — they carry the shared BackLink to the /admin/notices hub and are
  // enforced here rather than in the static-markup suite.
  it("renders the New Notice page with a BackLink to /admin/notices", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ membershipTypes: [], lodges: [], roles: [], members: [] }),
      })),
    );
    const NewNoticePage = (
      await import("@/app/(admin)/admin/notices/new/page")
    ).default;

    await act(async () => {
      render(<NewNoticePage />);
      await Promise.resolve();
    });

    const link = await screen.findByRole("link", { name: "← Member notices" });
    expect(link).toHaveAttribute("href", "/admin/notices");
  });

  it("renders the notice edit page with a BackLink to /admin/notices", async () => {
    // The page renders its BackLink unconditionally at the top of the return, so
    // a benign fetch of the notice detail + reads is enough to reach it.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          notice: {
            id: "lodge-7",
            title: "Notice",
            bodyHtml: "<p>x</p>",
            status: "DRAFT",
            publishedAt: null,
            expiresAt: null,
            pinned: false,
            requiresAcknowledgement: false,
            financialMembersOnly: false,
            emailedAt: null,
            audiences: [],
          },
          rows: [],
          page: 1,
          pageSize: 50,
          total: 0,
          totalPages: 1,
          audienceCount: 0,
          readCount: 0,
          acknowledgedCount: 0,
          requiresAcknowledgement: false,
        }),
      })),
    );
    const NoticeEditPage = (
      await import("@/app/(admin)/admin/notices/[id]/page")
    ).default;

    await act(async () => {
      render(<NoticeEditPage />);
      await Promise.resolve();
    });

    const link = await screen.findByRole("link", { name: "← Member notices" });
    expect(link).toHaveAttribute("href", "/admin/notices");
  });
});
