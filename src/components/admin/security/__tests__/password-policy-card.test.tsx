// @vitest-environment jsdom

import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_FORBIDDEN_SAVE_REASON } from "@/components/admin/view-only-action";

const hookMock = vi.hoisted(() => ({ canEdit: true as boolean | undefined }));
vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => hookMock.canEdit,
  ADMIN_VIEW_ONLY_ACTION_REASON: "View-only reason",
}));

import { PasswordPolicyCard } from "@/components/admin/security/password-policy-card";

// Edit-gated password-policy card (#2103). Loads read-only from
// GET /api/admin/security/password-policy; the draft stages behind
// Edit → Save/Cancel; Cancel reverts to the saved snapshot; Save PUTs the draft.

const NOTICE_RE = /can view login & security settings but cannot change them/i;

function policyResponse(minPasswordLength = 12, breachedPasswordCheck = true) {
  return new Response(
    JSON.stringify({
      policy: {
        minPasswordLength,
        requireUppercase: false,
        requireLowercase: false,
        requireDigit: false,
        requireSymbol: false,
        magicLinkTtlMinutes: 15,
        breachedPasswordCheck,
      },
      updatedAt: null,
      updatedByMemberId: null,
    }),
    { status: 200 },
  );
}

function minLengthInput() {
  return screen.getByLabelText(/minimum password length/i) as HTMLInputElement;
}

function breachCheckbox() {
  return screen.getByRole("checkbox", {
    name: /refuse passwords found in public data breaches/i,
  }) as HTMLInputElement;
}

function editButton() {
  return screen.getByRole("button", { name: "Edit" }) as HTMLButtonElement;
}

async function renderLoaded(loadFetch?: ReturnType<typeof vi.fn>) {
  const fetchMock =
    loadFetch ?? vi.fn(async () => policyResponse());
  vi.stubGlobal("fetch", fetchMock);
  render(<PasswordPolicyCard />);
  await waitFor(() => expect(minLengthInput()).toBeTruthy());
  return fetchMock;
}

describe("PasswordPolicyCard (#2103)", () => {
  beforeEach(() => {
    hookMock.canEdit = true;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("loads read-only: the input is disabled and there is no Save button", async () => {
    await renderLoaded();
    expect(minLengthInput().disabled).toBe(true);
    expect(minLengthInput().value).toBe("12");
    expect(editButton().disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    // Refresh is available while not editing.
    expect(screen.getByRole("button", { name: /refresh/i })).toBeTruthy();
  });

  it("Edit enables the input, hides Refresh, and reveals Save/Cancel", async () => {
    await renderLoaded();
    fireEvent.click(editButton());
    expect(minLengthInput().disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /refresh/i })).toBeNull();
  });

  it("Cancel reverts the draft to the saved snapshot and exits edit mode", async () => {
    await renderLoaded();
    fireEvent.click(editButton());
    fireEvent.change(minLengthInput(), { target: { value: "20" } });
    expect(minLengthInput().value).toBe("20");
    expect(screen.getByText(/unsaved changes/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(minLengthInput().value).toBe("12");
    expect(minLengthInput().disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
  });

  it("Save PUTs the draft and exits edit mode", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "PUT" ? policyResponse(20) : policyResponse(12),
    );
    await renderLoaded(fetchMock);
    fireEvent.click(editButton());
    fireEvent.change(minLengthInput(), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(screen.getByText(/password policy saved/i)).toBeTruthy(),
    );
    const putCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "PUT",
    );
    expect(putCall?.[0]).toBe("/api/admin/security/password-policy");
    expect(JSON.parse(String(putCall?.[1]?.body)).minPasswordLength).toBe(20);
    // Exited edit mode.
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(minLengthInput().disabled).toBe(true);
  });

  // #4610: the breached-password switch stages with the card and round-trips
  // through the same PUT; Cancel reverts it like every other control.
  it("stages the breached-password switch behind Edit, saves it, and reloads it", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "PUT" ? policyResponse(12, false) : policyResponse(12, true),
    );
    await renderLoaded(fetchMock);
    expect(breachCheckbox().checked).toBe(true);
    expect(breachCheckbox().disabled).toBe(true);

    fireEvent.click(editButton());
    fireEvent.click(breachCheckbox());
    expect(breachCheckbox().checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(breachCheckbox().checked).toBe(true);

    fireEvent.click(editButton());
    fireEvent.click(breachCheckbox());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.getByText(/password policy saved/i)).toBeTruthy(),
    );
    const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(JSON.parse(String(putCall?.[1]?.body))).toEqual({
      minPasswordLength: 12,
      requireUppercase: false,
      requireLowercase: false,
      requireDigit: false,
      requireSymbol: false,
      breachedPasswordCheck: false,
    });
    // The saved snapshot is the server's answer, shown read-only again.
    expect(breachCheckbox().checked).toBe(false);
    expect(breachCheckbox().disabled).toBe(true);
  });

  it("surfaces the forbidden-save reason on a 403 from the PUT", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "PUT"
        ? new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 })
        : policyResponse(12),
    );
    await renderLoaded(fetchMock);
    fireEvent.click(editButton());
    fireEvent.change(minLengthInput(), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(screen.getByText(ADMIN_FORBIDDEN_SAVE_REASON)).toBeTruthy(),
    );
    // Still editing; the change did not persist.
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  it("canEdit=false disables Edit and shows the view-only notice", async () => {
    hookMock.canEdit = false;
    await renderLoaded();
    expect(editButton().disabled).toBe(true);
    expect(screen.getByText(NOTICE_RE)).toBeTruthy();
  });

  it("canEdit=undefined (resolving) disables Edit and shows NO notice", async () => {
    hookMock.canEdit = undefined;
    await renderLoaded();
    expect(editButton().disabled).toBe(true);
    expect(screen.queryByText(NOTICE_RE)).toBeNull();
  });
});
