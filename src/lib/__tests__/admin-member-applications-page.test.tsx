// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { beforeEach, describe, expect, it, vi } from "vitest";

// #1997: the page derives view-only gating from the session matrix via
// useAdminAreaEditAccess("membership"). Mock an all-edit admin so the existing
// approve/refresh/replace action assertions (enabled buttons) hold.
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "admin-1",
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

// #4960: the page mirrors its filter and page into the URL.
const navigation = vi.hoisted(() => ({ search: "", replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: navigation.replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(navigation.search),
}));

import MemberApplicationsPage from "@/app/(admin)/admin/membership/member-applications/page";

const fetchMock = vi.fn();

function baseApplication(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: "app-base",
    applicantFirstName: "Pat",
    applicantLastName: "Member",
    applicantEmail: "pat@example.com",
    applicantDateOfBirth: "1990-01-01",
    applicantPhone: null,
    applicantAddress: {},
    familyMembers: [],
    familyMemberCount: 0,
    nominator1Email: "nom1@example.com",
    nominator2Email: "nom2@example.com",
    nominator1Id: "nom-1",
    nominator2Id: "nom-2",
    nominator1Name: "Nom One",
    nominator2Name: "Nom Two",
    nominator1ConfirmedAt: null,
    nominator2ConfirmedAt: null,
    nominator1TokenExpiresAt: "2026-06-08T00:00:00.000Z",
    nominator2TokenExpiresAt: "2026-06-08T00:00:00.000Z",
    nominator1TokenLastSentAt: "2026-06-01T00:00:00.000Z",
    nominator2TokenLastSentAt: "2026-06-01T00:00:00.000Z",
    nominator1ReminderCount: 1,
    nominator2ReminderCount: 4,
    nominatorReminderLimit: 4,
    nominator1ReminderExhausted: false,
    nominator2ReminderExhausted: true,
    status: "PENDING_NOMINATORS",
    adminNotes: null,
    reviewerName: null,
    reviewedAt: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function listResponse() {
  return {
    applications: [
      baseApplication({
        id: "stuck-1",
        applicantFirstName: "Stuck",
        applicantLastName: "Nominators",
        status: "PENDING_NOMINATORS",
      }),
      baseApplication({
        id: "ready-1",
        applicantFirstName: "Ready",
        applicantLastName: "Admin",
        status: "PENDING_ADMIN",
        nominator1ConfirmedAt: "2026-06-02T00:00:00.000Z",
        nominator2ConfirmedAt: "2026-06-02T00:00:00.000Z",
      }),
    ],
    pendingCount: 1,
  };
}

describe("MemberApplicationsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    navigation.search = "";
    global.fetch = fetchMock as typeof fetch;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, status: "REJECTED" }),
        });
      }
      // Item 15 (#1931): the joining-fee preview for a PENDING_ADMIN applicant.
      if (url.includes("/joining-fee/preview")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            defaultAmountCents: 7500,
            defaultNarration: "Membership joining fee (Adult)",
            exempt: false,
            effectiveFrom: "2026-01-01",
            source: "SCHEDULE",
          }),
        });
      }
      if (init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, warnings: [] }),
        });
      }
      if (url.startsWith("/api/admin/members?")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            members: [
              {
                id: "nom-3",
                firstName: "Nom",
                lastName: "Three",
                email: "nom3@example.com",
              },
            ],
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => listResponse() });
    });
  });

  it("offers recovery controls for PENDING_NOMINATORS applications", async () => {
    render(<MemberApplicationsPage />);

    await waitFor(() =>
      expect(screen.queryByText("Stuck Nominators")).not.toBeNull()
    );

    expect(
      screen.queryByText(/Refresh the workflow to send fresh links/i)
    ).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: /Refresh nomination workflow/i })
    ).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: /Reject application/i })
    ).not.toBeNull();
    expect(screen.queryByText(/Automatic reminders: 4\/4 exhausted/i)).not.toBeNull();
  });

  it("does not offer approval for PENDING_NOMINATORS applications", async () => {
    render(<MemberApplicationsPage />);

    await waitFor(() =>
      expect(screen.queryByText("Ready Admin")).not.toBeNull()
    );

    // Approve is rendered only for the single PENDING_ADMIN application, never
    // for the PENDING_NOMINATORS one.
    expect(screen.getAllByRole("button", { name: /^Approve$/ })).toHaveLength(1);
  });

  it("refreshes a stuck nominator application via the recovery endpoint", async () => {
    render(<MemberApplicationsPage />);

    await waitFor(() =>
      expect(screen.queryByText("Stuck Nominators")).not.toBeNull()
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Refresh nomination workflow/i })
    );

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          url === "/api/admin/member-applications/stuck-1/nominations/refresh" &&
          (init as RequestInit | undefined)?.method === "POST"
      );
      expect(postCall).toBeDefined();
    });
  });

  it("replaces an unconfirmed nominator via the replacement endpoint", async () => {
    render(<MemberApplicationsPage />);

    await waitFor(() =>
      expect(screen.queryByText("Stuck Nominators")).not.toBeNull()
    );

    fireEvent.change(screen.getAllByPlaceholderText(/Search name or email/i)[0], {
      target: { value: "Nom Three" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: /Search members/i })[0]);

    await waitFor(() =>
      expect(screen.queryByText("Nom Three")).not.toBeNull()
    );

    fireEvent.click(screen.getAllByRole("button", { name: /^Use$/ })[0]);

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          url === "/api/admin/member-applications/stuck-1/nominators/nominator1/replace" &&
          (init as RequestInit | undefined)?.method === "POST"
      );
      expect(postCall).toBeDefined();
      expect(JSON.parse((postCall?.[1] as RequestInit).body as string)).toEqual({
        memberId: "nom-3",
      });
    });
  });

  it("surfaces the default joining fee and prefills the override fields for a PENDING_ADMIN applicant (#1931)", async () => {
    render(<MemberApplicationsPage />);

    await waitFor(() => expect(screen.queryByText("Ready Admin")).not.toBeNull());

    // The preview endpoint was called with the applicant's raw inputs (FULL type
    // + DOB), and the default is surfaced.
    await waitFor(() => {
      const previewCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          typeof url === "string" &&
          url.includes("/joining-fee/preview") &&
          (init as RequestInit | undefined)?.method === "POST",
      );
      expect(previewCall).toBeDefined();
      expect(JSON.parse((previewCall?.[1] as RequestInit).body as string)).toMatchObject({
        membershipTypeKey: "FULL",
        dateOfBirth: "1990-01-01",
      });
    });
    expect(await screen.findByText(/Default:/)).toBeTruthy();

    // The amount + narration override fields are prefilled with the default.
    await waitFor(() => {
      expect(screen.getByDisplayValue("75.00")).toBeTruthy();
      expect(screen.getByDisplayValue("Membership joining fee (Adult)")).toBeTruthy();
    });
  });

  it("rejects a stuck nominator application via the review endpoint", async () => {
    render(<MemberApplicationsPage />);

    await waitFor(() =>
      expect(screen.queryByText("Stuck Nominators")).not.toBeNull()
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Reject application/i })
    );

    // #1786: the reject action now opens the notify-choice dialog; confirm with
    // the default notify path ("Reject and email applicant") to fire the PUT.
    fireEvent.click(
      await screen.findByRole("button", {
        name: /Reject and email applicant/i,
      })
    );

    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "PUT"
      );
      expect(putCall).toBeDefined();
      expect(putCall?.[0]).toBe("/api/admin/member-applications/stuck-1");
      expect(JSON.parse((putCall?.[1] as RequestInit).body as string)).toMatchObject(
        { decision: "REJECT" }
      );
    });
  });
});

/*
  #4960 / INV-OPS-017: the route returns 25 applications a page. The worked
  example: 40 pending applications after an open day. The list says so, and
  the next page holds the other 15.
*/
describe("MemberApplicationsPage paging (#4960)", () => {
  let listUrls: URL[];

  beforeEach(() => {
    vi.clearAllMocks();
    navigation.search = "";
    listUrls = [];
    global.fetch = fetchMock as typeof fetch;
    fetchMock.mockImplementation((input: string) => {
      const url = new URL(input, "http://localhost");
      if (url.pathname === "/api/admin/member-applications") {
        listUrls.push(url);
        const page = Number(url.searchParams.get("page"));
        const pageRows = page === 1 ? 25 : 15;
        const applications = Array.from({ length: pageRows }, (_, index) =>
          baseApplication({
            id: `app-${page}-${index}`,
            applicantFirstName: `Applicant${page}x${index}`,
            status: "PENDING_ADMIN",
          }),
        );
        return Promise.resolve({
          ok: true,
          json: async () => ({
            data: applications,
            applications,
            pendingCount: 40,
            page,
            pageSize: 25,
            total: 40,
            totalPages: 2,
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
  });

  it("shows 25 of 40, reaches the other 15, and restarts at page 1 on a filter change", async () => {
    render(<MemberApplicationsPage />);

    expect(await screen.findByText("Showing 1–25 of 40")).toBeTruthy();
    expect(listUrls[0].searchParams.get("status")).toBe("PENDING_ADMIN");
    expect(listUrls[0].searchParams.get("page")).toBe("1");

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("Showing 26–40 of 40")).toBeTruthy();
    expect(listUrls.at(-1)!.searchParams.get("page")).toBe("2");
    expect(screen.getAllByText(/Applicant2x14/).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/Applicant1x0/)).toHaveLength(0);
    await waitFor(() =>
      expect(navigation.replace).toHaveBeenLastCalledWith(
        "/admin/member-applications?page=2",
        { scroll: false },
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    expect(await screen.findByText("Showing 1–25 of 40")).toBeTruthy();
    expect(listUrls.at(-1)!.searchParams.get("page")).toBe("1");

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("Showing 26–40 of 40");
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() => expect(listUrls.at(-1)!.searchParams.has("status")).toBe(false));
    expect(listUrls.at(-1)!.searchParams.get("page")).toBe("1");
    await waitFor(() =>
      expect(navigation.replace).toHaveBeenLastCalledWith(
        "/admin/member-applications?status=ALL",
        { scroll: false },
      ),
    );
  });

  it("opens on the filter and page the URL names", async () => {
    navigation.search = "status=APPROVED&page=2";
    render(<MemberApplicationsPage />);

    expect(await screen.findByText("Showing 26–40 of 40")).toBeTruthy();
    expect(listUrls[0].searchParams.get("status")).toBe("APPROVED");
    expect(listUrls[0].searchParams.get("page")).toBe("2");
  });
});
