// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import AdminSubscriptionCategoriesPage from "@/app/(admin)/admin/subscription-categories/page";

const fetchMock = vi.fn();

const subscriptionCategories = [
  {
    id: "cat-individual",
    key: "INDIVIDUAL",
    name: "Individual",
    description: null,
    isActive: true,
    isBuiltIn: true,
    sortOrder: 0,
    assignmentCount: 0,
    feeCount: 0,
  },
  {
    id: "cat-couple",
    key: "COUPLE",
    name: "Couple",
    description: "Two partners sharing one flat fee.",
    isActive: true,
    isBuiltIn: false,
    sortOrder: 1,
    assignmentCount: 2,
    feeCount: 1,
  },
];

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 400) {
  return { ok, status, json: async () => body };
}

function mockFetch() {
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/api/admin/subscription-categories") && method === "GET") {
      return jsonResponse({ subscriptionCategories });
    }
    throw new Error(`Unhandled fetch: ${method} ${url}`);
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  mockFetch();
  vi.stubGlobal("fetch", fetchMock);
});

describe("AdminSubscriptionCategoriesPage", () => {
  it("renders the list of subscription categories", async () => {
    render(<AdminSubscriptionCategoriesPage />);

    await screen.findByText("Individual");
    screen.getByText("Couple");
    screen.getByText("Built-in");
    screen.getByText("Custom");
  });

  it("does not offer Delete or Archive for the built-in Individual category", async () => {
    render(<AdminSubscriptionCategoriesPage />);
    await screen.findByText("Individual");

    const individualCard = screen.getByText("Individual").closest("article")!;
    const buttonLabels = Array.from(individualCard.querySelectorAll("button")).map(
      (button) => button.textContent ?? "",
    );
    expect(buttonLabels.some((text) => /delete/i.test(text))).toBe(false);
    expect(buttonLabels.some((text) => /archive/i.test(text))).toBe(false);
  });

  it("offers Delete and Archive for a custom category", async () => {
    render(<AdminSubscriptionCategoriesPage />);
    await screen.findByText("Couple");

    const coupleCard = screen.getByText("Couple").closest("article")!;
    const buttons = Array.from(coupleCard.querySelectorAll("button")).map((b) => b.textContent);
    expect(buttons.some((text) => /delete/i.test(text ?? ""))).toBe(true);
    expect(buttons.some((text) => /archive/i.test(text ?? ""))).toBe(true);
  });

  it("creates a new subscription category", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/admin/subscription-categories") && method === "GET") {
        return jsonResponse({ subscriptionCategories });
      }
      if (url.endsWith("/api/admin/subscription-categories") && method === "POST") {
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({ name: "Family" });
        return jsonResponse({
          subscriptionCategory: {
            id: "cat-family",
            key: "FAMILY",
            name: "Family",
            description: "",
            isActive: true,
            isBuiltIn: false,
            sortOrder: 2,
            assignmentCount: 0,
            feeCount: 0,
          },
        }, true, 201);
      }
      throw new Error(`Unhandled fetch: ${method} ${url}`);
    });

    render(<AdminSubscriptionCategoriesPage />);
    await screen.findByText("Individual");

    fireEvent.click(screen.getByRole("button", { name: /new category/i }));
    const nameInput = screen.getByLabelText("Name");
    fireEvent.change(nameInput, { target: { value: "Family" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => screen.getByText("Subscription category created."));
  });

  it("confirms before deleting a custom category", async () => {
    const deleteCalls: string[] = [];
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/admin/subscription-categories") && method === "GET") {
        return jsonResponse({ subscriptionCategories });
      }
      if (url.includes("/api/admin/subscription-categories/cat-couple") && method === "DELETE") {
        deleteCalls.push(url);
        return jsonResponse({ ok: true });
      }
      throw new Error(`Unhandled fetch: ${method} ${url}`);
    });

    render(<AdminSubscriptionCategoriesPage />);
    await screen.findByText("Couple");

    const coupleCard = screen.getByText("Couple").closest("article")!;
    const deleteButton = Array.from(coupleCard.querySelectorAll("button")).find((b) =>
      /delete/i.test(b.textContent ?? ""),
    )!;
    fireEvent.click(deleteButton);

    // The confirm dialog must appear before any DELETE request fires.
    await screen.findByText(/Delete Couple\?/i);
    expect(deleteCalls).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: /delete category/i }));
    await waitFor(() => expect(deleteCalls).toHaveLength(1));
  });
});
