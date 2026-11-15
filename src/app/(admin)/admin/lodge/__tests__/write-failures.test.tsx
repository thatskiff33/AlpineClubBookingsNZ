// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";
import { itShowsEveryRefusal } from "@/lib/__tests__/support/failed-write-cases";
import AdminLodgePage from "@/app/(admin)/admin/lodge/page";

/*
  The kiosk-account save and create check `res.ok` before parsing and read a
  refusal through `apiErrorMessageFromResponse` (ALP-589).
*/

vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => true,
}));
vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ hutLeaderLabel: "Hut Leader" }),
}));
vi.mock("@/components/lodge-select", () => ({
  useLodgeOptions: () => ({
    lodges: [
      { id: "lodge-1", name: "Lodge One" },
      { id: "lodge-2", name: "Lodge Two" },
    ],
    failed: false,
    forbidden: false,
    reload: () => {},
  }),
}));

const ACCOUNT = {
  id: "kiosk-1",
  email: "kiosk@example.test",
  firstName: "Lodge",
  lastName: "Kiosk",
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
  boundLodgeId: "lodge-1",
  boundLodgeName: "Lodge One",
};

function stubFetch(method: string, answer: () => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === method
      ? answer()
      : Response.json({ accounts: [ACCOUNT], defaultLodgeName: "Lodge One" }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const loads = (fetchMock: ReturnType<typeof stubFetch>) =>
  fetchMock.mock.calls.filter(([, init]) => !init?.method).length;

async function saveAccount(answer: () => Response | Promise<Response>) {
  const fetchMock = stubFetch("PUT", answer);
  render(<AdminLodgePage />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("First Name"), { target: { value: "Front" } });
  fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
  return fetchMock;
}

async function createAccount(answer: () => Response | Promise<Response>) {
  const fetchMock = stubFetch("POST", answer);
  render(<AdminLodgePage />);
  fireEvent.click(await screen.findByRole("button", { name: "Add account" }));
  fireEvent.change(document.getElementById("new-kiosk-email")!, { target: { value: "second@example.test" } });
  fireEvent.change(document.getElementById("new-kiosk-password")!, { target: { value: "a-long-password-1" } });
  fireEvent.click(screen.getByRole("button", { name: "Create account" }));
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("kiosk account: save refused", () => {
  itShowsEveryRefusal({ submit: async (answer) => void (await saveAccount(answer)), fallback: "Failed to save changes" });

  it("reloads the accounts on success", async () => {
    const fetchMock = await saveAccount(() => Response.json({ ok: true }));

    expect(await screen.findByText("Kiosk account updated successfully")).toBeInTheDocument();
    await waitFor(() => expect(loads(fetchMock)).toBeGreaterThanOrEqual(2));
  });
});

describe("kiosk account: create refused", () => {
  itShowsEveryRefusal({
    submit: async (answer) => void (await createAccount(answer)),
    fallback: "Failed to create account",
  });

  it("reloads the accounts on success", async () => {
    const fetchMock = await createAccount(() => Response.json({ ok: true }, { status: 201 }));

    expect(await screen.findByText("Kiosk account created")).toBeInTheDocument();
    await waitFor(() => expect(loads(fetchMock)).toBeGreaterThanOrEqual(2));
  });
});
