// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  GoToXeroButton,
  xeroLinkState,
} from "@/app/(admin)/admin/finance/xero/_components/go-to-xero-button";

// #2261: an admin who spots a problem on the Xero Sync page (or its Health
// Snapshot) can jump straight into Xero. The link must be live in EVERY
// connection state — the club's tenant GUID is not usable in a Xero URL, so
// without the organisation short code the link degrades to the generic
// go.xero.com dashboard rather than disappearing or rendering dead.
describe("GoToXeroButton", () => {
  function link() {
    return screen.getByRole("link") as HTMLAnchorElement;
  }

  it("deep-links into THIS organisation when the short code is known", () => {
    render(<GoToXeroButton state="connected" shortCode="!aBc12" />);

    expect(link().getAttribute("href")).toBe(
      "https://go.xero.com/organisationlogin/default.aspx?shortcode=!aBc12&redirecturl=%2FDashboard%2F",
    );
    expect(link().textContent).toContain("Go to Xero");
    expect(link().getAttribute("title")).toMatch(/this club's Xero organisation/i);
  });

  it("falls back to the generic Xero link when the short code is unavailable", () => {
    render(<GoToXeroButton state="connected" shortCode={null} />);

    expect(link().getAttribute("href")).toBe("https://go.xero.com/Dashboard/");
    expect(link().textContent).toContain("Go to Xero");
    // The admin is told why the link is less precise, not left with a dead one.
    expect(link().getAttribute("title")).toMatch(/short code could not be read/i);
  });

  // #2261 review: while the short code is still being read the link is already
  // the generic one, but the explanation must not blame a read that has not
  // failed — the admin would be told the org could not be identified at the one
  // moment that is not yet true.
  it("stays neutral while the short code is still loading", () => {
    render(
      <GoToXeroButton state="connected" shortCode={null} shortCodeLoading />,
    );

    expect(link().getAttribute("href")).toBe("https://go.xero.com/Dashboard/");
    expect(link().textContent).toContain("Go to Xero");
    expect(link().getAttribute("title")).toBe("Opens Xero in a new tab.");
    expect(link().getAttribute("title")).not.toMatch(/could not be read/i);
  });

  it("still explains a genuinely failed read once loading settles", () => {
    render(
      <GoToXeroButton
        state="connected"
        shortCode={null}
        shortCodeLoading={false}
      />,
    );

    expect(link().getAttribute("title")).toMatch(/short code could not be read/i);
  });

  it("offers a plain Xero sign-in when Xero is disconnected", () => {
    render(<GoToXeroButton state="disconnected" shortCode={null} />);

    expect(link().getAttribute("href")).toBe("https://go.xero.com/Dashboard/");
    expect(link().textContent).toContain("Log in to Xero");
    expect(link().getAttribute("title")).toMatch(/not connected to this site/i);
  });

  it("stays live, and explains itself, when stored tokens need re-entry", () => {
    render(<GoToXeroButton state="needsReentry" shortCode={null} />);

    expect(link().getAttribute("href")).toBe("https://go.xero.com/Dashboard/");
    expect(link().textContent).toContain("Log in to Xero");
    expect(link().getAttribute("title")).toMatch(/reconnect Xero here/i);
  });

  it("opens in a new tab without leaking the admin page to Xero", () => {
    render(<GoToXeroButton state="connected" shortCode="!aBc12" />);

    expect(link().getAttribute("target")).toBe("_blank");
    expect(link().getAttribute("rel")).toBe("noopener noreferrer");
  });
});

describe("xeroLinkState", () => {
  it("maps the connection status onto the link's promise", () => {
    expect(
      xeroLinkState({ connected: true, tenantId: "t", tokenExpiresAt: null }),
    ).toBe("connected");
    expect(
      xeroLinkState({
        connected: false,
        needsReentry: true,
        tenantId: null,
        tokenExpiresAt: null,
      }),
    ).toBe("needsReentry");
    expect(
      xeroLinkState({ connected: false, tenantId: null, tokenExpiresAt: null }),
    ).toBe("disconnected");
    // Status not loaded yet: the safest claim is a plain Xero sign-in.
    expect(xeroLinkState(null)).toBe("disconnected");
  });

  it("prefers connected over a stale needsReentry flag", () => {
    expect(
      xeroLinkState({
        connected: true,
        needsReentry: true,
        tenantId: "t",
        tokenExpiresAt: null,
      }),
    ).toBe("connected");
  });
});
