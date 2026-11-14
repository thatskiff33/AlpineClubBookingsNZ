// @vitest-environment jsdom

// #4976: removing someone from a committee role used to say something only when
// the officer lacked permission (403). An assignment someone else had already
// removed (404), an expired session (401) or a server fault (500) left the row
// in place with no message. Every refusal now shows, through the shared
// error-message helper, and the 403 keeps its own wording.

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ADMIN_FORBIDDEN_SAVE_REASON } from "@/components/admin/view-only-action";
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

import CommitteePage from "@/app/(admin)/admin/membership/committee/page";

const treasurer = {
  id: "role-1",
  key: "treasurer",
  name: "Treasurer",
  description: null,
  contactEmail: null,
  isActive: true,
  sortOrder: 1,
  assignmentCount: 1,
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
  isActive: true,
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

let deleteResponse: () => Response;
let assignmentFetches = 0;

beforeEach(() => {
  assignmentFetches = 0;
  installScrollIntoViewSpy();
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "DELETE") return deleteResponse();
      if (url.includes("/api/admin/committee/roles")) return Response.json({ roles: [treasurer] });
      if (url.includes("/api/admin/committee/assignments")) {
        assignmentFetches += 1;
        return Response.json({ assignments: [assignment] });
      }
      return Response.json({});
    }),
  );
});

afterEach(() => {
  cleanup();
  removeScrollIntoViewSpy();
  vi.unstubAllGlobals();
});

async function clickRemove() {
  fireEvent.click(
    await screen.findByRole("button", { name: "Remove Ada Example as Treasurer" }),
  );
}

describe("committee page: a refused remove is visible (#4976)", () => {
  it.each([
    [400, "Assignment is already inactive"],
    [401, "Your session has expired"],
    [404, "Assignment not found"],
  ])("shows the server's sentence for a %i", async (status, sentence) => {
    deleteResponse = () => Response.json({ error: sentence }, { status });
    render(<CommitteePage />);
    await clickRemove();

    expect(await screen.findByRole("alert")).toHaveTextContent(sentence);
  });

  it("shows the fallback, not a parse error, for an HTML 500", async () => {
    deleteResponse = () =>
      new Response("<html>Internal error</html>", {
        status: 500,
        headers: { "content-type": "text/html" },
      });
    render(<CommitteePage />);
    await clickRemove();

    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to remove assignment");
  });

  it("keeps the forbidden-save wording for a 403", async () => {
    deleteResponse = () => Response.json({ error: "Forbidden" }, { status: 403 });
    render(<CommitteePage />);
    await clickRemove();

    expect(await screen.findByRole("alert")).toHaveTextContent(ADMIN_FORBIDDEN_SAVE_REASON);
  });

  it("refreshes the assignments on success and shows no error", async () => {
    deleteResponse = () => Response.json({ success: true });
    render(<CommitteePage />);
    await clickRemove();

    await waitFor(() => expect(assignmentFetches).toBe(2));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
