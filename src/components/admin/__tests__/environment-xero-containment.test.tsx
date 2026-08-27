import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/*
  `APP_TIME_ZONE` IS PINNED BEHIND GREENWICH, AND NOT TO THE CLUB ZONE BELOW.

  This block is what makes the #3123 case at the bottom of this file mean
  something. Before that migration these stamps went through `formatNZInstantOrRaw`,
  whose zone IS `APP_TIME_ZONE` — the container's `TZ`. Pinning it to
  `America/Denver` while the provider carries `Pacific/Auckland` makes the two
  disagree about the day of the fixture instant, so the assertion cannot pass by
  coincidence and could not have passed before the migration. A suite that
  persisted `Pacific/Auckland` could not tell the persisted zone from the
  environment's, because that is exactly what `APP_TIME_ZONE` falls back to
  (#3123 execution contract).
*/
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "America/Denver",
  APP_LOCALE: "en-NZ",
}));

import {
  EnvironmentXeroContainment,
  type XeroContactContainment,
} from "@/components/admin/environment-xero-containment";
import { ClubTimeProvider } from "@/components/club-time-provider";

/** The club's persisted zone under test. Deliberately NOT the environment's. */
const CLUB_ZONE = "Pacific/Auckland";
/** What `APP_TIME_ZONE` claims above, held apart from it on purpose. */
const ENVIRONMENT_ZONE = "America/Denver";

/**
 * The Xero-containment block on `/admin/environment` (#3036; INV-CONFIG-005).
 *
 * WHY THIS EXISTS, when a source census already reads the same file. Because the
 * census cannot answer "does an operator actually SEE the list", and the first
 * version of that census could not answer it either: a mutation probe disabled
 * the whole list, the screen rendered nothing, and every case still passed. A
 * census case was added and now catches that — but the honest fix is the one
 * below, because this is a four-prop presentational component and rendering it is
 * three lines.
 *
 * The earlier justification for not writing this ("there is no harness for this
 * screen and inventing one is the worse trade") was simply untrue:
 * `react-dom/server` and `@testing-library/react` are both here and dozens of
 * admin components are rendered in tests. The census stays — it judges the WORDING
 * of copy that must not drift, which markup assertions are a poor tool for — and
 * this covers the structure.
 */

const CONTACT_A = "8f4d2c1a-9b3e-4f57-8a26-1d0c7e5b9a34";
const CONTACT_B = "11111111-2222-3333-4444-555555555555";

function containment(
  overrides: Partial<Extract<XeroContactContainment, { available: true }>> = {},
): XeroContactContainment {
  return {
    available: true,
    containedContacts: 2,
    rewrittenContacts: 2,
    mostRecentAt: "2026-06-25T02:00:00.000Z",
    lastRewrittenAt: "2026-06-25T02:00:00.000Z",
    firstContainedAt: "2026-06-01T00:00:00.000Z",
    rewritten: [
      {
        xeroContactId: CONTACT_A,
        xeroContactUrl: `https://go.xero.com/Contacts/View/${CONTACT_A}`,
        memberName: "Ada Lovelace",
        memberId: "member-1",
        rewrittenAt: "2026-06-25T02:00:00.000Z",
      },
      {
        xeroContactId: CONTACT_B,
        xeroContactUrl: `https://go.xero.com/Contacts/View/${CONTACT_B}`,
        memberName: null,
        memberId: null,
        rewrittenAt: "2026-06-24T02:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

function render(
  props: Partial<Parameters<typeof EnvironmentXeroContainment>[0]> = {},
  zone: string = CLUB_ZONE,
): string {
  /*
    The provider is not decoration. `EnvironmentXeroContainment` reads the club's
    persisted zone through `useClubTime`, which THROWS rather than guessing when
    no provider is above it — so a bare render of this component is a failure,
    by design, and the zone every case below renders under is the one named here.
  */
  return renderToStaticMarkup(
    <ClubTimeProvider zone={zone}>
      <EnvironmentXeroContainment
        role="NON_PRODUCTION"
        declarationKind="non-production"
        overrideReadable
        containment={containment()}
        {...props}
      />
    </ClubTimeProvider>,
  );
}

describe("EnvironmentXeroContainment", () => {
  it("renders nothing at all on the club's live site", () => {
    /*
      Containment never runs on PRODUCTION, so the table is empty by definition
      and a "0 contacts contained" line there would be noise that means nothing —
      the same argument #3035 made for keeping the withheld-email total off a
      healthy live site.
    */
    expect(
      render({ role: "PRODUCTION", declarationKind: "production" }),
    ).toBe("");
  });

  it("lists every rewritten contact, with a link into Xero and whose it is", () => {
    const html = render();
    expect(html).toContain("environment-xero-rewritten-contacts");
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain(`https://go.xero.com/Contacts/View/${CONTACT_A}`);
    expect(html).toContain('href="/admin/members/member-1"');
    // A contact no member points at any more is still a contact this
    // installation edited, so it is still listed — named by its provider id and
    // labelled rather than silently dropped.
    expect(html).toContain(`Xero contact ${CONTACT_B}`);
    expect(html).toContain(
      "no member on this installation points at this contact any more",
    );
    // The repair steps the operator guide's section refers to by name.
    expect(html).toContain("Putting them back");
    expect(html).toContain("put the member&#x27;s email address back on it");
  });

  it("says how many are NOT listed, so a page cannot read as the whole damage", () => {
    const html = render({
      containment: containment({ rewrittenContacts: 57 }),
    });
    expect(html).toContain("55 more are not");
    expect(html).toContain("The count above is the real total");
  });

  it("shows no repair instructions when there is nothing to repair", () => {
    const html = render({
      containment: containment({
        rewrittenContacts: 0,
        lastRewrittenAt: null,
        rewritten: [],
      }),
    });
    expect(html).toContain("checked, none was holding a real address");
    expect(html).not.toContain("Putting them back");
    expect(html).not.toContain("environment-xero-rewritten-contacts");
  });

  it("carries no email address into the markup", () => {
    // The whole reason the stored fingerprint is a hash: an operator surface may
    // report containment without becoming a second place a member's address
    // lives. `@` would appear if an address, or a contained address, leaked.
    expect(render()).not.toContain("@");
  });

  it("dates the damage, not the last check", () => {
    /*
      `mostRecentAt` moves every time this copy re-checks any contact.
      `lastRewrittenAt` is when a real address was last replaced. Rendering the
      first under the second's sentence would date a June overwrite to whenever
      the copy last ran anything at all, so the two fixtures below differ and the
      rewrite date is the one that appears.
    */
    const html = render({
      containment: containment({
        mostRecentAt: "2026-06-30T23:00:00.000Z",
        lastRewrittenAt: "2026-06-02T09:00:00.000Z",
      }),
    });
    expect(html).toContain("The most recent was");
    expect(html).toContain("2 Jun 2026");
    expect(html).not.toContain("30 Jun 2026");
  });

  it("says nothing is WRITTEN — not that nothing reaches Xero — when undeclared", () => {
    const html = render({
      role: "UNKNOWN",
      declarationKind: "absent",
      containment: { available: false },
    });
    expect(html).toContain("Nothing is being written to Xero");
    expect(html).toContain("Reading from Xero still works");
    expect(html).toContain("APP_ENVIRONMENT_ROLE");
  });

  it("does not tell a DECLARED-production installation to declare its role", () => {
    // Deliberate #3034 fail-closed behaviour: a declared-production install whose
    // safer override cannot be read resolves UNKNOWN. Telling that operator to
    // declare the role sends them to fix something already correct.
    const html = render({
      role: "UNKNOWN",
      declarationKind: "production",
      overrideReadable: false,
      containment: { available: false },
    });
    expect(html).toContain("DOES declare itself the club&#x27;s live site");
    expect(html).toContain("prisma migrate deploy");
    expect(html).not.toContain("Set APP_ENVIRONMENT_ROLE");
  });

  it("reports unavailable rather than a reassuring zero", () => {
    const html = render({ containment: { available: false } });
    expect(html).toContain("Could not be counted on this installation");
    expect(html).toContain("This is not the same as none");
  });
});

/*
  #3123 — these stamps are the CLUB's, not the container's.

  Every instant this block prints was going through `formatNZInstantOrRaw`,
  whose zone is `APP_TIME_ZONE`. For a club behind Greenwich that named the
  previous day for a destructive edit to the club's accounting records, on the
  screen an operator opens precisely because something has already gone wrong.
*/
describe("the containment stamps take the club's persisted zone (#3123)", () => {
  /** 2:00 UTC: 25 June 14:00 in Auckland, 24 June 20:00 in Denver. */
  const STRADDLES = "2026-06-25T02:00:00.000Z";

  const checkedOnly = () =>
    containment({
      rewrittenContacts: 0,
      lastRewrittenAt: null,
      rewritten: [],
      mostRecentAt: STRADDLES,
    });

  it("PREMISE: the environment and the club disagree about this instant", () => {
    /*
      Without this leg the cases below pass just as well when the two zones
      happen to agree, which is the false green #3123's contract names. It also
      says "environment" out loud when a machine is configured oddly, rather
      than leaving a bare date mismatch to be read as a dating bug.
    */
    const inEnvironment = new Intl.DateTimeFormat("en-NZ", {
      timeZone: ENVIRONMENT_ZONE,
      dateStyle: "medium",
    }).format(new Date(STRADDLES));
    const inClub = new Intl.DateTimeFormat("en-NZ", {
      timeZone: CLUB_ZONE,
      dateStyle: "medium",
    }).format(new Date(STRADDLES));
    expect(inEnvironment).toBe("24 Jun 2026");
    expect(inClub).toBe("25 Jun 2026");
  });

  it("names the club's day, not the container's", () => {
    // BEFORE the migration this read "24 Jun 2026" (APP_TIME_ZONE = Denver).
    const html = render({ containment: checkedOnly() });
    expect(html).toContain("Last checked 25 Jun 2026");
    expect(html).not.toContain("24 Jun 2026");
  });

  it("moves with the persisted zone — kills a hard-coded Pacific/Auckland", () => {
    /*
      The leg a literal club zone cannot pass. Without it, swapping
      `APP_TIME_ZONE` for a hard-coded "Pacific/Auckland" would go green and the
      next club to configure a different one would be back where this started.
    */
    const ahead = render({ containment: checkedOnly() }, "Pacific/Kiritimati");
    const behind = render({ containment: checkedOnly() }, "Pacific/Pago_Pago");
    expect(ahead).toContain("Last checked 25 Jun 2026");
    expect(behind).toContain("Last checked 24 Jun 2026");
  });

  it("still shows the RAW value when it will not parse, never Invalid Date", () => {
    /*
      The contract `formatNZInstantOrRaw` carried and `formatPayloadInstantDateTimeOrRaw`
      inherits. An operator diagnosing a broken installation is better served by
      whatever arrived than by the words "Invalid Date", and a throw here would
      blank the screen through the nearest error boundary.
    */
    const html = render({
      containment: containment({
        rewrittenContacts: 0,
        lastRewrittenAt: null,
        rewritten: [],
        mostRecentAt: "not-a-timestamp",
      }),
    });
    expect(html).toContain("Last checked not-a-timestamp");
    expect(html).not.toContain("Invalid Date");
  });
});
