// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// #1997: the form derives view-only gating from the session matrix via
// useAdminAreaEditAccess("bookings"). Mock an all-edit admin so the existing
// reuse/create action assertions (enabled buttons) hold.
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

import { NonMemberContactForm } from "../non-member-contact-form";

/**
 * Pins the client/server field-name contract for the suggest-and-pick reuse
 * flow (#1935). A prior regression posted `reuseExistingContactId`, but the
 * route only accepts `useExistingContactId`, so every "Use existing" click
 * 400'd and dedupe never worked from the UI. The route unit test posts the
 * server field directly and cannot catch this drift — this drives the real
 * component fetch instead.
 */

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const SUGGESTION = {
  id: "contact-9",
  firstName: "Rita",
  lastName: "Repeat",
  email: "rita@example.com",
  isPlaceholderEmail: false,
  role: "NON_MEMBER",
  phoneNumber: null,
  bookingCount: 2,
};

describe("NonMemberContactForm — reuse-by-pick contract (#1935)", () => {
  it("posts useExistingContactId (not reuseExistingContactId) when 'Use existing' is clicked", async () => {
    const reused = {
      id: "contact-9",
      firstName: "Rita",
      lastName: "Repeat",
      email: "rita@example.com",
      isPlaceholderEmail: false,
    };

    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      // GET = suggestions; POST = create/reuse.
      if (method === "GET") {
        return Promise.resolve(jsonResponse({ contacts: [SUGGESTION] }));
      }
      return Promise.resolve(jsonResponse({ contact: reused, reused: true }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const onSelected = vi.fn();
    render(<NonMemberContactForm onSelected={onSelected} />);

    // Type an email so the debounced suggestion fetch fires.
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "rita@example.com" },
    });

    // The suggestion (and its "Use existing" button) appears once the GET
    // resolves.
    const useExisting = await screen.findByRole("button", {
      name: "Use existing",
    });
    fireEvent.click(useExisting);

    await waitFor(() => {
      expect(onSelected).toHaveBeenCalledWith(reused);
    });

    // Find the POST call and assert the exact wire contract.
    const postCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST"
    );
    expect(postCall).toBeDefined();
    const body = JSON.parse((postCall![1] as RequestInit).body as string);
    expect(body).toEqual({ useExistingContactId: "contact-9" });
    // Guard against the exact regression that shipped: the old, wrong key.
    expect(body).not.toHaveProperty("reuseExistingContactId");
  });
});
