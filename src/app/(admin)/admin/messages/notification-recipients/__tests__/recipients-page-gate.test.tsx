// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

/**
 * #2548 review finding 1: /admin/notification-recipients resolves to
 * `support: view`, and the admin layout admits on that. The page itself now
 * discloses every privileged user's name, email address and access role — the
 * same data /api/admin/members gates at `membership: view` — so the roster is
 * gated separately. A visitor who clears the layout but not the roster gate must
 * get an explanation, and the database must not be queried at all.
 */

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: { member: { findMany: vi.fn() } },
}));

// The grid is a client component; it reads the viewer's own support level to
// decide read-only vs editable, which is not what this file is about.
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { id: "viewer", adminPermissionMatrix: { support: "edit" } } },
    status: "authenticated",
  }),
}));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { makeSession } from "@/lib/__tests__/helpers";

const mockedAuth = vi.mocked(auth);
const mockedFindMany = vi.mocked(prisma.member.findMany);

/** One admin row in the shape the page selects. */
const bookingOfficerRow = {
  id: "officer-1",
  firstName: "Bea",
  lastName: "Officer",
  email: "officer@club.test",
  canLogin: true,
  accessRoles: [
    { role: "USER", roleDefinitionId: null, roleDefinition: null },
    { role: "ADMIN_BOOKINGS", roleDefinitionId: null, roleDefinition: null },
  ],
  notificationPreference: null,
};

function sessionWithMatrix(matrix: Record<string, string>): Session {
  return makeSession({
    id: "viewer-1",
    accessRoles: [],
    adminPermissionMatrix: {
      overview: "none",
      bookings: "none",
      membership: "none",
      finance: "none",
      lodge: "none",
      content: "none",
      support: "none",
      ...matrix,
    } as never,
  });
}

async function renderPage() {
  const { default: NotificationRecipientsPage } = await import("../page");
  return render(await NotificationRecipientsPage());
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedFindMany.mockResolvedValue([bookingOfficerRow] as never);
});

afterEach(cleanup);

describe("Recipients page roster gate (#2548)", () => {
  it("withholds the roster from a support-view-only viewer without querying", async () => {
    mockedAuth.mockResolvedValue(sessionWithMatrix({ support: "view" }));

    await renderPage();

    expect(mockedFindMany).not.toHaveBeenCalled();
    expect(
      screen.getByText(/needs Membership view access or Support/i),
    ).toBeInTheDocument();
    expect(screen.queryByText("officer@club.test")).not.toBeInTheDocument();
  });

  it("withholds the roster from an unauthenticated render", async () => {
    mockedAuth.mockResolvedValue(null);

    await renderPage();

    expect(mockedFindMany).not.toHaveBeenCalled();
    expect(screen.queryByText("officer@club.test")).not.toBeInTheDocument();
  });

  it("shows the roster to a membership-view viewer", async () => {
    mockedAuth.mockResolvedValue(
      sessionWithMatrix({ support: "view", membership: "view" }),
    );

    await renderPage();

    expect(mockedFindMany).toHaveBeenCalledTimes(1);
    expect(screen.getByText("officer@club.test")).toBeInTheDocument();
  });

  it("shows the roster to a support-edit viewer with no membership access", async () => {
    mockedAuth.mockResolvedValue(sessionWithMatrix({ support: "edit" }));

    await renderPage();

    expect(mockedFindMany).toHaveBeenCalledTimes(1);
    expect(screen.getByText("officer@club.test")).toBeInTheDocument();
  });

  // #2548 review findings 3 and 6: the plain USER classification row is not one
  // of the roles deciding this officer's alerts, so it must not be labelled.
  it("labels privileged roles only, never the plain User row", async () => {
    mockedAuth.mockResolvedValue(sessionWithMatrix({ support: "edit" }));

    await renderPage();

    expect(screen.getByText("Booking Officer")).toBeInTheDocument();
    expect(screen.queryByText(/^User, /)).not.toBeInTheDocument();
    expect(screen.queryByText("User, Booking Officer")).not.toBeInTheDocument();
  });
});
