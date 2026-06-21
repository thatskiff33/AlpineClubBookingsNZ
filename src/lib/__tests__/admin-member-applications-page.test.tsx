// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MemberApplicationsPage from "@/app/(admin)/admin/member-applications/page";

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
    nominator1Name: "Nom One",
    nominator2Name: "Nom Two",
    nominator1ConfirmedAt: null,
    nominator2ConfirmedAt: null,
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
    global.fetch = fetchMock as typeof fetch;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, status: "REJECTED" }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => listResponse() });
    });
  });

  it("offers a reject control for stuck PENDING_NOMINATORS applications", async () => {
    render(<MemberApplicationsPage />);

    await waitFor(() =>
      expect(screen.queryByText("Stuck Nominators")).not.toBeNull()
    );

    // The waiting-on-nominators card explains why and offers a reject control.
    expect(
      screen.queryByText(/unblocks a fresh application for the same email/i)
    ).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: /Reject stuck application/i })
    ).not.toBeNull();
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

  it("rejects a stuck nominator application via the review endpoint", async () => {
    render(<MemberApplicationsPage />);

    await waitFor(() =>
      expect(screen.queryByText("Stuck Nominators")).not.toBeNull()
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Reject stuck application/i })
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
