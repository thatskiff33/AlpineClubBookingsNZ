// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithRecentAuth = vi.hoisted(() => vi.fn());

vi.mock("@/lib/officer-sign-in-switch", () => ({
  OFFICER_SIGN_IN_ENFORCED: true,
}));

vi.mock("@/components/confirm-its-you", () => ({
  fetchWithRecentAuth: (...args: unknown[]) => fetchWithRecentAuth(...args),
}));

import { MemberExportControl } from "@/app/(admin)/admin/members/_components/member-export-control";

describe("member export when officer sign-in is enforced (#4619)", () => {
  beforeEach(() => {
    fetchWithRecentAuth.mockReset();
    vi.stubGlobal("URL", {
      createObjectURL: () => "blob:members",
      revokeObjectURL: () => undefined,
    });
  });

  it("fetches the CSV and saves the Content-Disposition filename", async () => {
    fetchWithRecentAuth.mockResolvedValue(
      new Response("name\nAda\n", {
        status: 200,
        headers: {
          "Content-Disposition": 'attachment; filename="tac-members-2026-07-01.csv"',
        },
      }),
    );
    const anchors: HTMLAnchorElement[] = [];
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const element = realCreate(tag);
      if (tag === "a") {
        anchors.push(element as HTMLAnchorElement);
        element.click = () => undefined;
      }
      return element;
    });

    render(<MemberExportControl href="/api/admin/members/export?q=ada" />);
    expect(screen.queryByRole("link", { name: "Export CSV" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));

    await waitFor(() => expect(anchors.some((anchor) => anchor.download === "tac-members-2026-07-01.csv")).toBe(true));
    expect(fetchWithRecentAuth).toHaveBeenCalledTimes(1);
    expect(fetchWithRecentAuth).toHaveBeenCalledWith("/api/admin/members/export?q=ada");
  });
});
