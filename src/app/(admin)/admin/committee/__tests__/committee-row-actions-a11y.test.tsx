// @vitest-environment jsdom

// #4563 — the committee page's row actions are icon-only (a pencil, a bin), so
// each needs an accessible name or a screen reader announces a row of
// unlabelled "button"s. And an archived role or inactive assignment keeps its
// text at full strength: the row says "Archived" / "Inactive" in words rather
// than fading every cell below 4.5:1 with opacity.

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  installScrollIntoViewSpy,
  removeScrollIntoViewSpy,
} from "@/lib/__tests__/helpers/focus";

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

vi.mock("@/components/admin/committee-photo-display-control", () => ({
  CommitteePhotoDisplayControl: () => null,
}));

import CommitteePage from "@/app/(admin)/admin/committee/page";

const treasurer = {
  id: "role-1",
  key: "treasurer",
  name: "Treasurer",
  description: null,
  contactEmail: "treasurer@example.org",
  isActive: true,
  sortOrder: 1,
  assignmentCount: 1,
};

const patron = {
  id: "role-2",
  key: "patron",
  name: "Patron",
  description: null,
  contactEmail: null,
  isActive: false,
  sortOrder: 2,
  assignmentCount: 0,
};

const assignment = {
  id: "assign-1",
  memberId: "member-1",
  committeeRoleId: "role-1",
  blurb: null,
  sortOrder: 0,
  published: true,
  showPhone: false,
  contactable: false,
  isActive: false,
  committeeRole: treasurer,
  member: {
    id: "member-1",
    displayName: "Ada Example",
    email: "ada@example.org",
    phone: null,
    role: "MEMBER",
    active: true,
  },
};

function json(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response);
}

beforeEach(() => {
  installScrollIntoViewSpy();
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/admin/committee/roles")) return json({ roles: [treasurer, patron] });
      if (url.includes("/api/admin/committee/assignments")) return json({ assignments: [assignment] });
      return json({});
    }),
  );
});

afterEach(() => {
  cleanup();
  removeScrollIntoViewSpy();
  vi.unstubAllGlobals();
});

describe("committee page row actions and inactive rows (#4563)", () => {
  it("names every icon-only Edit and Remove button after its row", async () => {
    render(<CommitteePage />);
    await screen.findByText("Ada Example");

    expect(screen.getByRole("button", { name: "Edit Treasurer" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Edit Patron" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Edit Ada Example as Treasurer" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Remove Ada Example as Treasurer" }),
    ).toBeEnabled();

    // No button on the page is left without a name.
    const unnamed = screen
      .getAllByRole("button")
      .filter((button) => !button.getAttribute("aria-label") && !button.textContent?.trim());
    expect(unnamed).toEqual([]);
  });

  it("keeps archived and inactive rows at full strength, saying so in words", async () => {
    render(<CommitteePage />);
    await screen.findByText("Ada Example");

    const patronRow = screen.getByText("Patron").closest("tr")!;
    const adaRow = screen.getByText("Ada Example").closest("tr")!;
    expect(within(patronRow).getByText("Archived")).toBeInTheDocument();
    expect(within(adaRow).getByText("Inactive")).toBeInTheDocument();
    for (const row of [patronRow, adaRow]) {
      expect(row.className).not.toMatch(/(?<![:\w-])opacity-/);
    }
  });
});
