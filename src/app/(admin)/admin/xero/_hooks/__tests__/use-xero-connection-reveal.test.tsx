// @vitest-environment jsdom

// #2934: "go to section" on /admin/xero used to open the section and then wait a
// `setTimeout(0)` before scrolling to it — a guess at when the section would
// exist. The request is now state: opening the section and recording the
// request land in one commit, and the reveal runs after that commit, through the
// shared primitive, so the section takes focus as well as coming into view.

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useXeroConnection } from "@/app/(admin)/admin/xero/_hooks/use-xero-connection";

let scrollIntoView: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          connected: true,
          needsReentry: false,
          tenantId: "t-1",
          tokenExpiresAt: null,
        }),
        { status: 200 },
      ),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

function Harness() {
  const { sectionOpen, scrollToSection } = useXeroConnection();
  return (
    <div>
      <button type="button" onClick={() => scrollToSection("usage")}>
        Go to usage
      </button>
      {/* The section wrapper exists only while the section is open, as the
          real panels' collapsible bodies do — which is exactly why a scroll
          fired before the open commit found nothing to scroll to. */}
      {sectionOpen.usage ? (
        <section id="xero-section-usage" data-testid="usage">
          Usage
        </section>
      ) : null}
    </div>
  );
}

describe("useXeroConnection.scrollToSection", () => {
  it("opens the section and reveals it in the same commit, with focus", async () => {
    render(<Harness />);
    expect(screen.queryByTestId("usage")).toBeNull();

    await act(async () => {
      screen.getByRole("button", { name: "Go to usage" }).click();
    });

    const usage = screen.getByTestId("usage");
    expect(document.activeElement).toBe(usage);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.instances[0]).toBe(usage);
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "start",
    });
  });

  it("reveals the same section again on a second request", async () => {
    render(<Harness />);
    await act(async () => {
      screen.getByRole("button", { name: "Go to usage" }).click();
    });
    await act(async () => {
      screen.getByRole("button", { name: "Go to usage" }).click();
    });
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });
});
