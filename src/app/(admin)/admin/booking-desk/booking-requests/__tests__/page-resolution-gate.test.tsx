// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";

// Drive the client session resolution state (#2065): "loading" leaves
// useAdminAreaEditAccess("bookings") === undefined, "authenticated" resolves it
// from the matrix below.
let sessionMatrix: AdminPermissionMatrix | null = null;
let sessionStatus: "loading" | "authenticated" | "unauthenticated" = "loading";

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: sessionMatrix
      ? { user: { id: "u1", adminPermissionMatrix: sessionMatrix } }
      : null,
    status: sessionStatus,
  }),
}));

// The page reads only the "tab" search param (defaults to "approvals") and
// calls router.replace on tab change (never on render), so stub minimally.
// `searchParamsQuery` lets a test open the page on a specific tab.
let searchParamsQuery = "";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(searchParamsQuery),
}));

// The gate under test is purely "render the panel only once canEditBookings
// resolves". Replace the heavy data-fetching panels with markers so the test
// isolates the `canEditBookings !== undefined` render gate.
vi.mock(
  "@/components/admin/booking-requests/booking-approvals-panel",
  () => ({
    BookingApprovalsPanel: () => <div data-testid="approvals-panel" />,
  }),
);
vi.mock(
  "@/components/admin/booking-requests/booking-change-requests-panel",
  () => ({
    BookingChangeRequestsPanel: () => <div data-testid="changes-panel" />,
  }),
);
vi.mock(
  "@/components/admin/booking-requests/public-booking-requests-panel",
  () => ({
    PublicBookingRequestsPanel: () => <div data-testid="public-panel" />,
  }),
);

// Imported after the mocks are registered.
import BookingRequestsPage from "@/app/(admin)/admin/booking-desk/booking-requests/page";

function editMatrix(): AdminPermissionMatrix {
  return {
    overview: "view",
    bookings: "edit",
    membership: "view",
    finance: "view",
    lodge: "view",
    content: "view",
    support: "view",
  };
}

describe("BookingRequestsPage session-resolution render gate (#2065)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    sessionStatus = "loading";
    searchParamsQuery = "";
    // The page's best-effort pending-count fetch must not hit an unstubbed URL.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ total: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not render the approvals panel while the session is resolving", () => {
    // status "loading" => canEditBookings === undefined => panel gated out.
    sessionStatus = "loading";
    sessionMatrix = editMatrix();
    render(<BookingRequestsPage />);

    expect(screen.queryByTestId("approvals-panel")).not.toBeInTheDocument();
    // The view-only banner must ALSO stay hidden during resolution (it gates on
    // canEdit === false, not on !canEdit).
    expect(
      screen.queryByText(/can view booking requests but cannot approve/i),
    ).not.toBeInTheDocument();
  });

  it("renders the approvals panel once the session resolves to an editor", () => {
    sessionStatus = "authenticated";
    sessionMatrix = editMatrix();
    render(<BookingRequestsPage />);

    expect(screen.getByTestId("approvals-panel")).toBeInTheDocument();
  });

  it("renders the approvals panel (view-only) with the banner once resolved to a viewer", () => {
    sessionStatus = "authenticated";
    sessionMatrix = { ...editMatrix(), bookings: "view" };
    render(<BookingRequestsPage />);

    // Resolved view-only: the panel renders (canEditBookings === false, not
    // undefined) and the view-only banner is shown.
    expect(screen.getByTestId("approvals-panel")).toBeInTheDocument();
    expect(
      screen.getByText(/can view booking requests but cannot approve/i),
    ).toBeInTheDocument();
  });
});

describe("Public Requests tab share link (#2421)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    sessionStatus = "loading";
    searchParamsQuery = "tab=public";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ total: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // The public form is unlisted by default (#2818 decision 1), so this copy
  // field is where an admin gets the URL to hand a guest — and it stays useful
  // for a club that HAS opted in, since the URL is the same either way. Sharing
  // it is not a booking write, so it must NOT be gated on bookings:edit.
  it("shows the copyable public request form link to a view-only admin", () => {
    sessionStatus = "authenticated";
    sessionMatrix = { ...editMatrix(), bookings: "view" };
    render(<BookingRequestsPage />);

    expect(
      screen.getByText("Guest request form link"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`${window.location.origin}/booking-requests`),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /copy/i }),
    ).toBeInTheDocument();
  });

  it("still shows it while the session is resolving, when the panel is gated out", () => {
    sessionStatus = "loading";
    sessionMatrix = editMatrix();
    render(<BookingRequestsPage />);

    expect(
      screen.getByText("Guest request form link"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("public-panel")).not.toBeInTheDocument();
  });
});
