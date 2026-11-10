// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SiteStyleWizard } from "@/app/(admin)/admin/website/site-style/site-style-wizard";
import {
  DEFAULT_CLUB_THEME_VALUES,
  type ClubThemeValues,
} from "@/lib/club-theme-schema";

const fetchMock = vi.fn();
const refreshMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

// The wizard now gates its controls on content:edit (#1927); render as a
// content:edit admin so these existing behaviour tests keep exercising the
// editable path.
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

// Every test here renders the full wizard in jsdom, which routinely exceeds
// vitest's 5s default under parallel full-suite load (the sibling
// site-style-wizard.test.tsx carries the same raised ceiling per test).
vi.setConfig({ testTimeout: 45_000 });

describe("site style wizard — logo upload (#2322)", () => {
  /** Renders the wizard and navigates straight to the Logo step. */
  function renderOnLogoStep(initial: Partial<ClubThemeValues> = {}) {
    render(
      <SiteStyleWizard
        initialTheme={{
          ...DEFAULT_CLUB_THEME_VALUES,
          ...initial,
          completedAt: null,
          contrastWarnings: [],
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Logo" }));
  }

  function pngFile(name = "club-logo.png") {
    return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
  }

  function fileInput() {
    return document.querySelector('input[type="file"]') as HTMLInputElement;
  }

  /** An upload response resolved manually, so the in-flight state is testable. */
  function deferredUpload() {
    let release: (value: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    fetchMock.mockImplementation(() => pending);
    return { release };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = fetchMock as typeof fetch;
  });

  it("stores the returned URL and reports success", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ logoUrl: "/api/images/new123" }),
    });
    renderOnLogoStep();

    fireEvent.change(fileInput(), { target: { files: [pngFile()] } });

    await waitFor(() => {
      expect(screen.getByText(/Logo uploaded/i)).toBeTruthy();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/site-style/logo",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("surfaces the server's error message, including the 413 oversize case", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 413,
      json: async () => ({ error: "Logo exceeds the 2MB upload limit." }),
    });
    renderOnLogoStep();

    fireEvent.change(fileInput(), { target: { files: [pngFile()] } });

    await waitFor(() => {
      expect(
        screen.getByText("Logo exceeds the 2MB upload limit."),
      ).toBeTruthy();
    });
  });

  it("reports a network failure rather than failing silently", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    renderOnLogoStep();

    fireEvent.change(fileInput(), { target: { files: [pngFile()] } });

    await waitFor(() => {
      expect(screen.getByText("Logo could not be uploaded.")).toBeTruthy();
    });
  });

  it("falls back when the response carries no URL", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    renderOnLogoStep();

    fireEvent.change(fileInput(), { target: { files: [pngFile()] } });

    await waitFor(() => {
      expect(screen.getByText("Logo could not be uploaded.")).toBeTruthy();
    });
  });

  it("disables the save controls while an upload is in flight", async () => {
    const { release } = deferredUpload();
    renderOnLogoStep();

    fireEvent.change(fileInput(), { target: { files: [pngFile()] } });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Uploading/ })).toBeTruthy();
    });
    // A save mid-upload would post a theme whose logo is about to change.
    expect(
      screen.getByRole("button", { name: "Save and next" }).hasAttribute("disabled"),
    ).toBe(true);

    release({ ok: true, json: async () => ({ logoUrl: "/api/images/x" }) });
  });

  it("disables Remove during an upload so the two cannot race in the UI", async () => {
    const { release } = deferredUpload();
    renderOnLogoStep({ logoUrl: "/api/images/existing" });

    fireEvent.change(fileInput(), { target: { files: [pngFile()] } });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Uploading/ })).toBeTruthy();
    });

    expect(
      screen
        .getByRole("button", { name: /Remove logo/ })
        .hasAttribute("disabled"),
    ).toBe(true);

    release({ ok: true, json: async () => ({ logoUrl: "/api/images/x" }) });
  });

  it("surfaces the server's 409 when the saved logo blob is gone", async () => {
    // A stale tab saving a logo a newer save already replaced. The message has
    // to reach the admin — retrying the same payload will never work.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: "That logo is no longer available — re-upload it and save again.",
      }),
    });
    renderOnLogoStep();

    fireEvent.click(screen.getByRole("button", { name: "Save and next" }));

    await waitFor(() => {
      expect(
        screen.getByText(
          "That logo is no longer available — re-upload it and save again.",
        ),
      ).toBeTruthy();
    });
  });

  it("disables Reset neutral during an upload and invalidates it when reset fires", async () => {
    const { release } = deferredUpload();
    renderOnLogoStep();

    fireEvent.change(fileInput(), { target: { files: [pngFile()] } });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Uploading/ })).toBeTruthy();
    });

    // Reset clears the logo along with everything else, so it must not be
    // reachable mid-upload.
    expect(
      screen
        .getByRole("button", { name: /Reset neutral/ })
        .hasAttribute("disabled"),
    ).toBe(true);

    release({ ok: true, json: async () => ({ logoUrl: "/api/images/x" }) });
  });

  it("discards a superseded upload's response (staleness guard)", async () => {
    // Defence in depth behind the disabled buttons: whichever upload started
    // LAST owns the result, so a slow earlier response can never overwrite it.
    let releaseFirst: (value: unknown) => void = () => {};
    const first = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    fetchMock.mockImplementationOnce(() => first);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ logoUrl: "/api/images/second" }),
    });

    renderOnLogoStep();

    // The hidden input is not itself disabled, so a second upload can be
    // driven even while the Choose button is.
    fireEvent.change(fileInput(), { target: { files: [pngFile("a.png")] } });
    fireEvent.change(fileInput(), { target: { files: [pngFile("b.png")] } });

    await waitFor(() => {
      expect(screen.getByText(/Logo uploaded/i)).toBeTruthy();
    });

    // The first upload now lands; its result must be thrown away.
    releaseFirst({
      ok: true,
      json: async () => ({ logoUrl: "/api/images/first" }),
    });

    await waitFor(() => {
      expect(screen.getByText(/Logo uploaded/i)).toBeTruthy();
    });
    const preview = document.querySelector(
      'img[alt="Logo preview"]',
    ) as HTMLImageElement | null;
    expect(preview?.getAttribute("src")).toBe("/api/images/second");
  });
});
