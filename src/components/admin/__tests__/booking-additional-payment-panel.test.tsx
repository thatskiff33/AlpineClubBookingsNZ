import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

/**
 * CT-4 (#2870): the panel is a SERVER component and now awaits the club's
 * PERSISTED timezone, so the real reader — which reaches Prisma through
 * `server-only` — is replaced here.
 *
 * IT IS REPLACED BY A ZONE THE ENVIRONMENT DOES NOT HOLD, and that is the whole
 * point of the choice. `America/Denver` is neither `APP_TIME_ZONE`
 * (`Pacific/Auckland` wherever `TZ` is unset, CI included) nor CI's host zone
 * (UTC), and it is BEHIND UTC where both of those are on it or ahead. Mocked to
 * `Pacific/Auckland` this file proved nothing about zone authority: the persisted
 * zone and the environment agreed, so reverting the component to `formatNZDateTime`
 * — the exact defect CT-4 exists to end — would have rendered identical strings and
 * every test here would still have passed.
 */
vi.mock("@/lib/club-time/server", async () => {
  const { bindClubTime, requireClubTimeZone } = await import("@/lib/club-time");
  const zone = requireClubTimeZone("America/Denver");
  return { clubTime: async () => bindClubTime(zone), clubTimeZone: async () => zone };
});

import { BookingAdditionalPaymentPanel } from "@/components/admin/booking-additional-payment-panel";

/**
 * The admin-side view of an uncollected additional payment (#2350).
 *
 * The member-facing card is owner-only by design (#1303), which is exactly why
 * this panel exists — but it must not become a second way to reach the member's
 * payment controls. These tests pin what it says, what it never offers, and who
 * gets the re-send button.
 */

const NOW = new Date("2026-06-11T00:00:00.000Z");
const RAISED_AT = new Date("2026-06-01T00:00:00.000Z");

function payment(overrides: Record<string, unknown> = {}) {
  return {
    additionalAmountCents: 21_000,
    additionalPaymentStatus: "PENDING",
    additionalReminderSentAt: null,
    additionalFinalReminderSentAt: null,
    ...overrides,
  } as Parameters<typeof BookingAdditionalPaymentPanel>[0]["payment"];
}

/**
 * The panel became an ASYNC server component in CT-4, so it is CALLED rather
 * than rendered as an element: `renderToStaticMarkup` is synchronous and cannot
 * await. A `null` return still renders as the empty string, which is what the
 * "renders nothing" assertions below read.
 */
async function render(
  props: Partial<Parameters<typeof BookingAdditionalPaymentPanel>[0]> = {},
) {
  const element = await BookingAdditionalPaymentPanel({
    bookingId: "booking-1",
    bookingStatus: "PAID",
    payment: payment(),
    requestedOn: RAISED_AT,
    canResend: true,
    now: NOW,
    ...props,
  });
  return element === null ? "" : renderToStaticMarkup(element);
}

describe("BookingAdditionalPaymentPanel", () => {
  it("names the amount, its age, and that it is still awaiting payment", async () => {
    const html = await render();

    expect(html).toContain("Additional payment outstanding");
    expect(html).toContain("$210.00");
    expect(html).toContain("Awaiting payment");
    expect(html).toContain("10 days ago");
    expect(html).toContain("Not yet");
  });

  it("says plainly when the last charge attempt failed", async () => {
    const html = await render({
      payment: payment({ additionalPaymentStatus: "FAILED" }),
    });

    expect(html).toContain("Payment failed");
    expect(html).toContain("failed");
  });

  it("reports when the member was last emailed, newest stamp wins", async () => {
    const html = await render({
      payment: payment({
        additionalReminderSentAt: new Date("2026-06-04T00:00:00.000Z"),
        additionalFinalReminderSentAt: new Date("2026-06-09T00:00:00.000Z"),
      }),
    });

    expect(html).not.toContain("Not yet");
    /*
      Club-time medium date + short time (#2264), spelled in the club's PERSISTED
      zone. 2026-06-09T00:00Z is 8 June, 6:00 pm in America/Denver and 9 June,
      12:00 pm in Pacific/Auckland — so the exact date pins two things at once:
      that the newest stamp won, and that the zone came from the club's setting
      rather than from `APP_TIME_ZONE` or a reverted `formatNZDateTime`. The time
      is matched loosely, because some ICU builds emit a narrow no-break space
      (U+202F) before am/pm and others a plain space.
    */
    expect(html).toContain("8 Jun 2026");
    expect(html).toMatch(/6:00\s*pm/i);
    // The older stamp, in the club's zone — the one that must NOT have won.
    expect(html).not.toContain("3 Jun 2026");
    // And the NZ spelling of the same winning instant, which is what a revert to
    // `formatNZDateTime` or a read of `APP_TIME_ZONE` would print.
    expect(html).not.toContain("9 Jun 2026");
  });

  it("renders nothing at all once the extra has been collected", async () => {
    expect(
      await render({ payment: payment({ additionalPaymentStatus: "SUCCEEDED" }) }),
    ).toBe("");
    expect(await render({ payment: payment({ additionalAmountCents: 0 }) })).toBe("");
    expect(await render({ payment: null })).toBe("");
  });

  /*
    A cancelled booking keeps its delta columns exactly as they were, so without
    the lifecycle half of the owed test this panel would tell an admin that a
    cancelled booking still owes money — and offer them a button to chase the
    member for it.
  */
  it("renders nothing on a booking whose lifecycle ended the obligation", async () => {
    for (const bookingStatus of ["CANCELLED", "BUMPED", "PAYMENT_PENDING"]) {
      expect(
        await render({
          bookingStatus,
          payment: payment({ additionalPaymentStatus: "FAILED" }),
        }),
      ).toBe("");
    }
  });

  it("tells the officer the re-send replaces the automatic reminder", async () => {
    // The button writes the stamp that suppresses the pending automatic nudge,
    // so the person pressing it has to know the member gets one message.
    expect(await render()).toContain("takes the place of");
  });

  it("offers the re-send only to an admin who may write", async () => {
    expect(await render({ canResend: true })).toContain(
      "Resend payment request email",
    );

    const viewOnly = await render({ canResend: false });
    expect(viewOnly).not.toContain("Resend payment request email");
    // The reason is stated in prose, in reading order, rather than hidden on a
    // disabled control.
    expect(viewOnly).toContain("cannot make changes");
  });

  /*
    The panel is read-only on purpose: an admin must never be able to take,
    waive, or zero the member's money from here. Collecting it stays with the
    member's own card or the ordinary modification tooling.
  */
  it("offers no way to take or waive the payment", async () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "src/components/admin/booking-additional-payment-panel.tsx",
      ),
      "utf8",
    );

    // Imports only — the prose above deliberately NAMES the member card it is
    // the counterpart to, so a raw substring scan would police the comment.
    const imports = source
      .split(/\r?\n/)
      .filter((line) => line.startsWith("import "))
      .join(" ");
    for (const forbidden of [
      "BookingPaymentSection",
      "additional-payment-card",
      "stripe",
      "Stripe",
    ]) {
      expect(imports).not.toContain(forbidden);
    }
    // And nothing rendered takes input or posts anywhere: the only interactive
    // element the panel can produce is the re-send button.
    const html = await render();
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<input");
    const buttons = html.match(/<button/g) ?? [];
    expect(buttons).toHaveLength(1);
    expect(html).toContain("Resend payment request email");
  });
});
