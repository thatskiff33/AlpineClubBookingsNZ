// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClubIdentityProvider } from "@/components/club-identity-provider";
import { clubIdentity } from "@/config/club-identity";
import { DataExportButton } from "../data-export-button";

// INV-CONFIG-001 (#4986): a download with no Content-Disposition name still
// carries this club's short name, never one club's initials.
describe("DataExportButton filename", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function captureDownloads(): HTMLAnchorElement[] {
    const anchors: HTMLAnchorElement[] = [];
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const element = realCreate(tag);
      if (tag === "a") {
        anchors.push(element as HTMLAnchorElement);
        element.click = () => {};
      }
      return element;
    });
    URL.createObjectURL = vi.fn(() => "blob:export");
    URL.revokeObjectURL = vi.fn();
    return anchors;
  }

  function renderButton() {
    render(
      <ClubIdentityProvider value={{ ...clubIdentity, shortName: "Ruapehu AC" }}>
        <DataExportButton />
      </ClubIdentityProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Download My Data" }));
  }

  it("falls back to the club's own name when the response names no file", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const anchors = captureDownloads();

    renderButton();

    await waitFor(() => expect(anchors.map((a) => a.download)).toContain("ruapehu-ac-my-data.json"));
  });

  it("keeps the server's name when the response carries one", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: { "Content-Disposition": 'attachment; filename="ruapehu-ac-my-data-2026-07-01.json"' },
      }),
    );
    const anchors = captureDownloads();

    renderButton();

    await waitFor(() => expect(anchors.map((a) => a.download)).toContain("ruapehu-ac-my-data-2026-07-01.json"));
  });
});
