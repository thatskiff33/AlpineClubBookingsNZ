// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Suspense } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  expectRecoveryAlertToHoldFocus,
  installScrollIntoViewSpy,
  removeScrollIntoViewSpy,
} from "./helpers/focus";
const { push, success } = vi.hoisted(() => ({
  push: vi.fn(),
  success: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => new URLSearchParams("loser=duplicate"),
}));
vi.mock("sonner", () => ({ toast: { success, error: vi.fn() } }));
vi.mock("@/components/confirm-its-you", () => ({
  fetchWithRecentAuth: (...args: Parameters<typeof fetch>) => fetch(...args),
}));
import MemberMergePage from "@/app/(admin)/admin/members/[id]/merge/page";
const response = (body: unknown, ok = true) => ({ ok, json: async () => body });
const preview = {
  masterId: "master",
  loserId: "duplicate",
  masterName: "Test Member",
  loserName: "Duplicate Member",
  confirmationPhrase: "MERGE",
  previewToken: "test-preview",
  fieldMerge: [],
  relationMoves: [],
  collisions: [],
  blockers: [],
  warnings: [],
};
const fetchMock = vi.fn();
let scroll: ReturnType<typeof installScrollIntoViewSpy>;
beforeEach(() => {
  scroll = installScrollIntoViewSpy();
  push.mockReset();
  success.mockReset();
  fetchMock
    .mockReset()
    .mockImplementation(async (url: string) =>
      response(
        url.includes("?")
          ? { members: [] }
          : {
              member: {
                id: url.endsWith("duplicate") ? "duplicate" : "master",
                firstName: "Test",
                lastName: "Member",
                email: "member@example.test",
              },
            },
      ),
    );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  removeScrollIntoViewSpy();
  vi.unstubAllGlobals();
});
async function mount() {
  const params = Promise.resolve({ id: "master" });
  await act(async () => {
    render(
      <Suspense fallback="Loading">
        <MemberMergePage params={params} />
      </Suspense>,
    );
  });
  return screen.findByRole("button", { name: "Preview merge" });
}
async function buildPreview() {
  const button = await mount();
  fetchMock.mockResolvedValueOnce(response(preview));
  fireEvent.click(button);
  fireEvent.change(await screen.findByPlaceholderText("MERGE"), {
    target: { value: "MERGE" },
  });
  return screen.getByRole("button", { name: "Merge and delete duplicate" });
}

describe("Member merge action attention", () => {
  it("focuses and reveals preview failures, including a repeated identical failure", async () => {
    const button = await mount();
    const alert = screen.getByRole("alert");
    expect(alert).toBeEmptyDOMElement();
    expect(alert).toHaveAttribute("role", "alert");
    expect(scroll).not.toHaveBeenCalled();
    fetchMock.mockResolvedValue(response({ error: "Preview failed" }, false));
    for (let attempt = 0; attempt < 2; attempt++) {
      button.focus();
      fireEvent.click(button);
      await expectRecoveryAlertToHoldFocus(alert);
      expect(alert).toHaveTextContent("Preview failed");
    }
    expect(scroll).toHaveBeenCalledTimes(2);
  });

  it("focuses the execute failure above the preview without navigating", async () => {
    const button = await buildPreview();
    fetchMock.mockResolvedValueOnce(response({ error: "Merge failed" }, false));
    fireEvent.click(button);
    const alert = screen.getByRole("alert");
    await expectRecoveryAlertToHoldFocus(alert);
    expect(alert).toHaveTextContent("Merge failed");
    expect(scroll.mock.instances).toContain(alert);
    expect(push).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
  });

  it("retains the existing success toast and navigation without positioning", async () => {
    const button = await buildPreview();
    fetchMock.mockResolvedValueOnce(response({}));
    fireEvent.click(button);
    await screen.findByRole("button", { name: "Merge and delete duplicate" });
    // Wait for the async action rather than asserting before it resumes.
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith("/admin/members/master"),
    );
    expect(success).toHaveBeenCalledWith(
      "Members merged. The duplicate has been deleted.",
    );
    expect(scroll).not.toHaveBeenCalled();
  });
});
