// @vitest-environment jsdom

// #4467 item 3's worked example: the committee page's Add / Edit Role form on
// the shared form layer. What changed for the officer is the error handling —
// a refused field is marked inline and listed in a summary that takes focus,
// whether the browser or the route refused it. What must NOT have changed is
// what the form sends, where, and how a refusal that is not about a field is
// shown; both halves are asserted.

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  expectRecoveryAlertToHoldFocus,
  expectToHoldFocus,
  installScrollIntoViewSpy,
  removeScrollIntoViewSpy,
} from "@/lib/__tests__/helpers/focus";
import { ADMIN_FORBIDDEN_SAVE_REASON } from "@/components/admin/view-only-action";

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

const fetchMock = vi.fn();

const treasurer = {
  id: "role-1",
  key: "treasurer",
  name: "Treasurer",
  description: "Looks after the money",
  contactEmail: "treasurer@example.org",
  isActive: true,
  sortOrder: 4,
  assignmentCount: 0,
};

function json(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response);
}

/** Reads answer with one role; a write answers with `write`. */
function respond(write: () => Promise<Response>) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST" || init?.method === "PATCH") return write();
    if (url.includes("/api/admin/committee/roles")) return json({ roles: [treasurer] });
    if (url.includes("/api/admin/committee/assignments")) {
      return json({ assignments: [] });
    }
    return json({});
  });
}

function writes() {
  return fetchMock.mock.calls.filter(
    ([, init]) => init?.method === "POST" || init?.method === "PATCH",
  );
}

async function openAddRole() {
  render(<CommitteePage />);
  await screen.findByText("Treasurer");
  fireEvent.click(screen.getByRole("button", { name: /Add Role/i }));
  await screen.findByLabelText(/Role Name/i);
}

async function save() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Save Role" }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  installScrollIntoViewSpy();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  removeScrollIntoViewSpy();
  vi.unstubAllGlobals();
});

describe("committee role form on the shared form layer (#4467)", () => {
  it("sends the payload it always sent, trimmed, with blanks as null", async () => {
    respond(() => json({ role: { id: "role-2" } }, 201));
    await openAddRole();

    fireEvent.change(screen.getByLabelText(/Role Name/i), {
      target: { value: "  Chair " },
    });
    await save();

    expect(writes()).toHaveLength(1);
    const [url, init] = writes()[0]!;
    expect(url).toBe("/api/admin/committee/roles");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "Chair",
      description: null,
      contactEmail: null,
      // The next free position after the existing role, as before.
      sortOrder: 5,
      isActive: true,
    });
  });

  it("edits a role through PATCH with its stored values", async () => {
    respond(() => json({ role: treasurer }));
    render(<CommitteePage />);
    await screen.findByText("Treasurer");
    // The row's pencil is named after its role (#4563).
    fireEvent.click(screen.getByRole("button", { name: "Edit Treasurer" }));

    expect(await screen.findByLabelText(/Role Name/i)).toHaveValue("Treasurer");
    expect(screen.getByRole("checkbox", { name: "Active" })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "Active" }));
    await save();

    const [url, init] = writes()[0]!;
    expect(url).toBe("/api/admin/committee/roles/role-1");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "Treasurer",
      description: "Looks after the money",
      contactEmail: "treasurer@example.org",
      sortOrder: 4,
      isActive: false,
    });
  });

  it("refuses an invalid role in the browser: nothing is sent, the summary takes focus", async () => {
    respond(() => json({ role: { id: "role-2" } }, 201));
    await openAddRole();

    fireEvent.change(screen.getByLabelText("Role Email"), {
      target: { value: "not-an-email" },
    });
    await save();

    expect(writes()).toHaveLength(0);
    const summary = screen.getByRole("alert");
    expect(
      Array.from(summary.querySelectorAll("a")).map((link) => link.textContent),
    ).toEqual([
      "Enter a role name",
      "Enter the role email as an address, like president@example.org",
    ]);
    expect(screen.getByLabelText(/Role Name/i)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Role Email")).toHaveAttribute("aria-invalid", "true");
    await expectToHoldFocus(summary, "the role form's error summary");
  });

  it("marks the field a route refuses, and shows no page-level alert for it", async () => {
    respond(() =>
      json(
        {
          error: "Invalid input",
          details: {
            formErrors: [],
            fieldErrors: { name: ["Use a role name of 120 characters or fewer"] },
          },
        },
        400,
      ),
    );
    await openAddRole();
    fireEvent.change(screen.getByLabelText(/Role Name/i), {
      target: { value: "Chair" },
    });
    await save();

    const name = screen.getByLabelText(/Role Name/i);
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAccessibleDescription(
      "Use a role name of 120 characters or fewer",
    );
    // One alert: the form's summary. The page banner is for refusals that are
    // not about a field.
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveAccessibleName("There is a problem");
    await expectToHoldFocus(alerts[0]!, "the role form's error summary");
  });

  it("keeps a refusal that is not about a field in the page banner", async () => {
    respond(() => json({ error: "Forbidden" }, 403));
    await openAddRole();
    fireEvent.change(screen.getByLabelText(/Role Name/i), {
      target: { value: "Chair" },
    });
    await save();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(ADMIN_FORBIDDEN_SAVE_REASON);
    await expectRecoveryAlertToHoldFocus(alert);
  });

  it.each([
    ["a 500", 500, { error: "Committee roles are unavailable." }],
    [
      "a 400 with no field details (PATCH's empty-body refusal)",
      400,
      { error: "At least one committee role field is required" },
    ],
  ])("shows %s in the page banner and marks no field", async (_label, status, body) => {
    respond(() => json(body, status));
    await openAddRole();
    fireEvent.change(screen.getByLabelText(/Role Name/i), {
      target: { value: "Chair" },
    });
    await save();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(body.error);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    for (const control of [
      screen.getByLabelText(/Role Name/i),
      screen.getByLabelText("Sort Order"),
      screen.getByLabelText("Role Email"),
      screen.getByLabelText("Description"),
      screen.getByRole("checkbox", { name: "Active" }),
    ]) {
      expect(control).toHaveAttribute("aria-invalid", "false");
    }
    await expectRecoveryAlertToHoldFocus(alert);
  });

  it("names the icon-only Close button", async () => {
    respond(() => json({}));
    await openAddRole();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("uses the Checkbox primitive for Active and the example as the email's description", async () => {
    respond(() => json({}));
    await openAddRole();

    expect(screen.getByRole("checkbox", { name: "Active" })).toHaveAttribute(
      "data-slot",
      "checkbox",
    );
    expect(screen.getByLabelText("Role Email")).toHaveAccessibleDescription(
      "Example: president@example.org",
    );
  });
});
