// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  BookingWithheldEmailsBanner,
  type WithheldEmailGroupView,
} from "@/components/admin/booking-withheld-emails-banner";
import { withheldEmailDisplayName } from "@/lib/booking-email-suppression";

/**
 * CT-4 (#2870): the banner is a SERVER component and now awaits the club's
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

/**
 * Render an ASYNC server component: call it, await its element, hand that to
 * Testing Library. `render` cannot take a promise, and this component became
 * async in CT-4 because it has to read the club's zone.
 */
async function renderAsync(element: ReactElement) {
  const { type, props } = element as unknown as {
    type: (p: unknown) => Promise<ReactElement | null>;
    props: unknown;
  };
  const resolved = await type(props);
  return render((resolved ?? <span data-empty />) as ReactElement);
}

/*
  #2259 — the persistent warning must list what was ACTUALLY withheld, from the
  audit records, and must keep stating the admin's obligation after the switch
  is cleared. A banner that only fired while the switch was on would quietly
  drop the case that matters most: emails back on, but the cancellation the
  member never heard about is still never sent.

  Since the review it also has to survive a chore-roster fan-out (one row per
  guest per date) without burying the one message that matters, and must not
  imply an officer can forward something that was never created.
*/

function group(over: Partial<WithheldEmailGroupView>): WithheldEmailGroupView {
  return {
    templateName: "booking-cancelled",
    label: withheldEmailDisplayName("booking-cancelled"),
    count: 1,
    subject: "Your booking has been cancelled",
    latestAt: "2026-07-20T02:00:00.000Z",
    remedy: "relay" as const,
    ...over,
  };
}

const GROUPS: WithheldEmailGroupView[] = [
  group({}),
  group({
    templateName: "xero-booking-invoice-email",
    label: withheldEmailDisplayName("xero-booking-invoice-email"),
    subject: "Invoice INV-0042 from the club",
    latestAt: "2026-07-19T21:30:00.000Z",
  }),
];

describe("BookingWithheldEmailsBanner (#2259)", () => {
  it("names each withheld message and timestamps it", async () => {
    await renderAsync(<BookingWithheldEmailsBanner noEmails total={2} groups={GROUPS} />);

    expect(
      screen.getByText("Emails are turned off for this booking"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Telling the member about these is your responsibility/i),
    ).toBeInTheDocument();

    // Display names, not raw slugs — including the Xero-sent invoice, which is
    // inside the same guarantee.
    expect(screen.getByText("Booking Cancelled")).toBeInTheDocument();
    expect(screen.getByText("Xero invoice email")).toBeInTheDocument();
    expect(
      screen.getByText(/Your booking has been cancelled/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Invoice INV-0042 from the club/)).toBeInTheDocument();

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.textContent).toMatch(/\d{1,2} \w{3} \d{4}/);
    }
  });

  it("renders timestamps in the club's PERSISTED zone, not the runtime's or NZ", async () => {
    /*
      One instant, three civil days, and the assertion names the only one the
      club's own setting produces. 2026-07-19T21:30Z is:

        - 19 July, 3:30 pm  in America/Denver (UTC-6) — the club's persisted zone
        - 19 July, 9:30 pm  in UTC             — the runtime's zone on CI
        - 20 July, 9:30 am  in Pacific/Auckland (UTC+12) — `APP_TIME_ZONE`, and
                                                  what `formatNZDateTime` renders

      A bare `toLocaleString` prints the runtime's local day (the #2256 class), and
      a revert to `formatNZDateTime` prints the NZ day (the CT-4 class). Both are
      excluded below, by answer rather than by mechanism.
    */
    await renderAsync(
      <BookingWithheldEmailsBanner
        noEmails
        total={1}
        groups={[
          group({
            templateName: "booking-confirmed",
            label: "Booking Confirmed",
            latestAt: "2026-07-19T21:30:00.000Z",
          }),
        ]}
      />,
    );
    const line = screen.getByRole("listitem").textContent ?? "";
    expect(line).toContain("19 Jul 2026");
    expect(line).toMatch(/3:30\s*pm/i);
    expect(line).not.toContain("20 Jul 2026");
  });

  it("groups a fan-out into one line with a count, so it cannot bury the rest", async () => {
    /*
      A week's chore roster for a party of eight is ~56 rows. Listed flat it
      pushes the single cancellation off the bottom of the banner; grouped, it
      is one line and the total stays exact.
    */
    await renderAsync(
      <BookingWithheldEmailsBanner
        noEmails
        total={57}
        groups={[
          group({
            templateName: "chore-roster",
            label: "Chore Roster",
            count: 56,
            subject: "Your chore for Saturday",
            remedy: "resend-roster",
          }),
          group({}),
        ]}
      />,
    );

    expect(
      screen.getByText(/Withheld so far: 57 messages, across 2 kinds/),
    ).toBeInTheDocument();
    expect(screen.getByText("×56")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    // The cancellation is still visible, not buried.
    expect(screen.getByText("Booking Cancelled")).toBeInTheDocument();
    // A grouped row dates its most recent member honestly.
    expect(screen.getByText(/most recent/)).toBeInTheDocument();
  });

  it("does not pretend a never-minted link can be forwarded", async () => {
    await renderAsync(
      <BookingWithheldEmailsBanner
        noEmails
        total={1}
        groups={[
          group({
            templateName: "split-guest-payment-link",
            label: "Split Guest Payment Link",
            subject: "Your payment link",
            remedy: "auto-regenerates",
          }),
        ]}
      />,
    );
    expect(
      screen.getByText(/Nothing was created to forward/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/re-sent automatically/i)).toBeInTheDocument();
  });

  it("gives the chore roster its own, harder remedy", async () => {
    /*
      The roster is NOT the same case as the payment link, and conflating them
      was a real defect: the roster service deletes the guest's existing chore
      token, mints a fresh one, then sends — so a live link exists, the guest's
      old link is destroyed, and `sendChoreRosterEmail` has no cron behind it.
      "Clear the switch and it regenerates" would be false twice over.
    */
    await renderAsync(
      <BookingWithheldEmailsBanner
        noEmails
        total={1}
        groups={[
          group({
            templateName: "chore-roster",
            label: "Chore Roster",
            subject: "Your chore for Saturday",
            remedy: "resend-roster",
          }),
        ]}
      />,
    );
    expect(
      screen.getByText(/re-send the roster from the Roster page/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/their old link no longer works/i),
    ).toBeInTheDocument();
    // …and must NOT claim anything regenerates on its own.
    expect(screen.queryByText(/re-sent automatically/i)).toBeNull();
  });

  it("omits the subject cleanly when none was read", async () => {
    await renderAsync(
      <BookingWithheldEmailsBanner
        noEmails
        total={1}
        groups={[group({ subject: "" })]}
      />,
    );
    const item = screen.getByRole("listitem");
    expect(item.textContent).toContain("Booking Cancelled");
    expect(item.textContent).not.toContain("—");
  });

  it("does not add that note to a message the officer really can relay", async () => {
    await renderAsync(
      <BookingWithheldEmailsBanner noEmails total={1} groups={[group({})]} />,
    );
    expect(screen.queryByText(/Nothing was created to forward/i)).toBeNull();
  });

  it("states the waitlist consequence it can never list", async () => {
    /*
      A silenced WAITLISTED entry is skipped for offers ENTIRELY, so no offer
      is made and no row is ever recorded. If the banner did not say this, the
      consequence would appear nowhere at all.
    */
    await renderAsync(
      <BookingWithheldEmailsBanner noEmails isWaitlisted total={0} groups={[]} />,
    );
    expect(
      screen.getByText(/passed over for waitlist offers while emails are off/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/no offer is made at all/i)).toBeInTheDocument();
  });

  it("does not claim waitlist offers were withheld in the category list", async () => {
    // An offer is not made at all, so listing it among "withheld" categories
    // would imply one was made and only its email held back.
    await renderAsync(<BookingWithheldEmailsBanner noEmails total={0} groups={[]} />);
    const banner = screen.getByTestId("booking-withheld-emails-banner");
    expect(banner.textContent).not.toMatch(
      /cancellations, waitlist offers, chore rosters/,
    );
  });

  it("points at the failure queue rather than implying the list is exhaustive", async () => {
    await renderAsync(<BookingWithheldEmailsBanner noEmails total={0} groups={[]} />);
    expect(
      screen.getByRole("link", { name: /Email deliverability/i }),
    ).toHaveAttribute("href", "/admin/email-deliverability");
  });

  it("keeps warning after the switch is cleared, because nothing is re-sent", async () => {
    await renderAsync(
      <BookingWithheldEmailsBanner noEmails={false} total={2} groups={GROUPS} />,
    );

    expect(
      screen.getByText("Some emails for this booking were never sent"),
    ).toBeInTheDocument();
    expect(screen.getByText(/are not re-sent/i)).toBeInTheDocument();
    expect(screen.getByText("Booking Cancelled")).toBeInTheDocument();
  });

  it("says so plainly when the switch is on but nothing has been withheld yet", async () => {
    await renderAsync(<BookingWithheldEmailsBanner noEmails total={0} groups={[]} />);

    expect(
      screen.getByText("Emails are turned off for this booking"),
    ).toBeInTheDocument();
    expect(screen.getByText("Nothing has been withheld yet.")).toBeInTheDocument();
  });

  it("renders nothing at all on an ordinary booking", async () => {
    const { container } = await renderAsync(
      <BookingWithheldEmailsBanner noEmails={false} total={0} groups={[]} />,
    );
    // The component returned null; `renderAsync` substitutes a marker so
    // Testing Library has an element, and its presence alone is the assertion.
    expect(container.querySelector("[data-empty]")).not.toBeNull();
    expect(container.textContent).toBe("");
  });
});

describe("withheldEmailDisplayName (#2259)", () => {
  it("uses the registry label for a real template", async () => {
    expect(withheldEmailDisplayName("booking-confirmed")).toBe(
      "Booking Confirmed",
    );
  });

  it("names both Xero pseudo-templates, which are not registry entries", async () => {
    expect(withheldEmailDisplayName("xero-booking-invoice-email")).toBe(
      "Xero invoice email",
    );
    expect(
      withheldEmailDisplayName("xero-group-settlement-invoice-email"),
    ).toBe("Xero group settlement invoice email");
  });

  it("falls back to the raw name rather than inventing one", async () => {
    expect(withheldEmailDisplayName("not-a-registered-template")).toBe(
      "not-a-registered-template",
    );
  });
});
