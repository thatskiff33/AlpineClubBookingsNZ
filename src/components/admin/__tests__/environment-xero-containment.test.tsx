import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  EnvironmentXeroContainment,
  type XeroContactContainment,
} from "@/components/admin/environment-xero-containment";

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
): string {
  return renderToStaticMarkup(
    <EnvironmentXeroContainment
      role="NON_PRODUCTION"
      declarationKind="non-production"
      overrideReadable
      containment={containment()}
      {...props}
    />,
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
