// @vitest-environment jsdom

/**
 * A refused subscription-category load, create, save or delete says why
 * (#4976, ALP-589).
 *
 * Each handler parsed the reply as JSON before it knew the reply was a
 * refusal, and showed `err.message`: an HTML 502 from the proxy read as a JSON
 * parse error and a dropped connection as "Failed to fetch". Each now reads
 * through the shared response reader and throws an `ApiRefusalError`, so
 * anything else shows the handler's own fallback. A 403 keeps the shared
 * forbidden-save reason.
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_FORBIDDEN_SAVE_REASON } from "@/components/admin/view-only-action";
import {
  htmlErrorPage,
  itShowsEveryRefusal,
} from "@/lib/__tests__/support/failed-write-cases";

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

import AdminSubscriptionCategoriesPage from "@/app/(admin)/admin/membership/subscription-categories/page";

const LIST_URL = "/api/admin/subscription-categories";
const COUPLE_URL = `${LIST_URL}/cat-couple`;

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

type Answer = () => Response | Promise<Response>;

/** Every route answers well unless the case names the one to refuse. */
function installFetch(refused?: { method: string; url: string; answer: Answer }) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (refused && refused.method === method && refused.url === url) {
      return refused.answer();
    }
    if (url === LIST_URL && method === "GET") {
      return Response.json({ subscriptionCategories });
    }
    if (url === LIST_URL && method === "POST") {
      return Response.json({ subscriptionCategory: subscriptionCategories[1] }, { status: 201 });
    }
    if (url === COUPLE_URL && method === "PATCH") {
      return Response.json({ subscriptionCategory: subscriptionCategories[1] });
    }
    if (url === COUPLE_URL && method === "DELETE") {
      return Response.json({ ok: true });
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function renderPage() {
  render(<AdminSubscriptionCategoriesPage />);
  await screen.findByText("Couple");
}

function coupleCard() {
  return within(screen.getByText("Couple").closest("article") as HTMLElement);
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("loading subscription categories", () => {
  function loadWith(answer: Answer) {
    installFetch({ method: "GET", url: LIST_URL, answer });
    render(<AdminSubscriptionCategoriesPage />);
  }

  it("shows the route's own sentence from a JSON refusal", async () => {
    loadWith(() => Response.json({ error: "Categories are unavailable." }, { status: 404 }));

    expect(await screen.findByText("Categories are unavailable.")).toBeTruthy();
  });

  it.each([500, 502])("shows the fallback, not a parse error, for an HTML %i", async (status) => {
    loadWith(() => htmlErrorPage(status));

    expect(await screen.findByText("Failed to load subscription categories")).toBeTruthy();
    expect(screen.queryByText(/JSON/)).toBeNull();
  });

  it("shows the fallback when the request never gets an answer", async () => {
    loadWith(() => Promise.reject(new TypeError("Failed to fetch")));

    expect(await screen.findByText("Failed to load subscription categories")).toBeTruthy();
    expect(screen.queryByText("Failed to fetch")).toBeNull();
  });
});

describe("creating a subscription category", () => {
  itShowsEveryRefusal({
    fallback: "Failed to create subscription category",
    async submit(answer) {
      installFetch({ method: "POST", url: LIST_URL, answer });
      await renderPage();
      fireEvent.click(screen.getByRole("button", { name: /new category/i }));
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Family" } });
      fireEvent.click(screen.getByRole("button", { name: /save/i }));
    },
  });

  it("keeps the shared forbidden-save reason for a 403", async () => {
    installFetch({
      method: "POST",
      url: LIST_URL,
      answer: () => Response.json({ error: "Nope." }, { status: 403 }),
    });
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: /new category/i }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Family" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(await screen.findAllByText(ADMIN_FORBIDDEN_SAVE_REASON)).not.toHaveLength(0);
  });
});

describe("saving a subscription category", () => {
  itShowsEveryRefusal({
    fallback: "Failed to save subscription category",
    async submit(answer) {
      installFetch({ method: "PATCH", url: COUPLE_URL, answer });
      await renderPage();
      fireEvent.click(coupleCard().getByRole("button", { name: /edit/i }));
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Couple plus" } });
      fireEvent.click(screen.getByRole("button", { name: /save/i }));
    },
  });
});

describe("deleting a subscription category", () => {
  itShowsEveryRefusal({
    fallback: "Failed to delete subscription category",
    async submit(answer) {
      installFetch({ method: "DELETE", url: COUPLE_URL, answer });
      await renderPage();
      fireEvent.click(coupleCard().getByRole("button", { name: /delete/i }));
      fireEvent.click(await screen.findByRole("button", { name: /delete category/i }));
    },
  });

  it("removes the category when the delete succeeds", async () => {
    installFetch();
    await renderPage();
    fireEvent.click(coupleCard().getByRole("button", { name: /delete/i }));
    fireEvent.click(await screen.findByRole("button", { name: /delete category/i }));

    expect(await screen.findByText("Deleted Couple.")).toBeTruthy();
  });
});
