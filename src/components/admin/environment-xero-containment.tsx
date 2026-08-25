"use client";

import { formatNZInstantOrRaw } from "@/lib/nzst-date";

/**
 * What a copy has done to the club's Xero contacts, on `/admin/environment`
 * (ENV-SAFETY 3, #3036; epic #2986; INV-CONFIG-005).
 *
 * SPLIT OUT OF `environment-safety-panel.tsx` because the panel outgrew its
 * file-size budget once this block gained the addressable list, and because the
 * block is genuinely a separate subject: the panel says which installation this
 * is and who set the override, and this says how much of the club's accounting
 * has been edited and what to do about it. The panel renders it and passes in
 * the four facts it needs; the types live here, and the panel imports them for
 * its own payload shape.
 *
 * WHAT THIS SCREEN MAY CLAIM. #3034 recorded and reported the role; #3035 and
 * #3036 are the changes that made the role ACT, so this copy says what actually
 * happens. It may NOT claim that a copy leaves the club's real Xero organisation
 * alone — a previous draft did. It keeps writing: invoices, credit notes
 * and contacts, all of it, deliberately, so settlement behaviour stays testable.
 * What changes is that the contacts can no longer reach anybody, and if it is
 * pointed at the club's REAL organisation, containment REWRITES real accounting
 * records — which is why this block reports how many, and which.
 */

export type EnvironmentRole = "PRODUCTION" | "NON_PRODUCTION" | "UNKNOWN";

export type DeclarationKind =
  | "production"
  | "non-production"
  | "absent"
  | "invalid";

/**
 * One contact whose deliverable address this installation overwrote.
 *
 * Declared here rather than imported for the same reason as every other type on
 * this screen: the module that builds the payload is `server-only`, so a client
 * component cannot import from it.
 */
export type RewrittenXeroContact = {
  xeroContactId: string;
  xeroContactUrl: string;
  memberName: string | null;
  memberId: string | null;
  rewrittenAt: string | null;
};

/**
 * Two counts and three instants, and none of them may be swapped for another.
 *
 * `containedContacts` climbing on a copy is the feature working.
 * `rewrittenContacts` counts the contacts that were holding a DELIVERABLE
 * address when this installation overwrote it — ordinary against a sandbox Xero
 * organisation, a destructive edit against the club's real books.
 * `available: false` is deliberately its own case and NOT a zero: "nothing has
 * been contained" and "we could not count" look identical on a screen and mean
 * opposite things.
 */
export type XeroContactContainment =
  | { available: false }
  | {
      available: true;
      containedContacts: number;
      rewrittenContacts: number;
      /** The last containment CHECK. Moves whenever a copy resolves a contact. */
      mostRecentAt: string | null;
      /** When a deliverable address was last actually replaced. The damage date. */
      lastRewrittenAt: string | null;
      firstContainedAt: string | null;
      rewritten: RewrittenXeroContact[];
    };

type Props = {
  role: EnvironmentRole;
  declarationKind: DeclarationKind;
  overrideReadable: boolean;
  containment: XeroContactContainment;
};

/**
 * The headline and the paragraph.
 *
 * WHY IT SAYS OPPOSITE THINGS UNDER NON_PRODUCTION AND UNKNOWN. On a confirmed
 * copy containment is running, and the number an operator wants is how much of
 * the club's accounting it has edited. On an UNDECLARED installation containment
 * is NOT running and nothing is being WRITTEN to Xero at all, and a count of zero
 * there means "nothing has happened", not "nothing needed to happen". One
 * sentence for both would tell the operator of an undeclared LIVE site that their
 * Xero is fine when in fact their invoicing has stopped.
 *
 * WRITES, NOT READS, and the distinction is deliberate. Reading from Xero still
 * works while the role is unresolved — the contact and invoice screens still
 * load, which is what an operator diagnosing this needs. A read changes nothing
 * in the club's books and cannot make Xero email anybody.
 *
 * THE UNKNOWN BRANCH HAS TWO CASES, because the repair differs and the obvious
 * single sentence is wrong for one of them. An installation that has DECLARED
 * itself production still resolves UNKNOWN when the safer override cannot be read
 * from the database — deliberate #3034 fail-closed behaviour — and telling that
 * operator to "declare the role" sends them to fix something already correct.
 *
 * IT NAMES NO EMAIL ADDRESS, and cannot: the payload carries counts, instants,
 * member names and Xero contact ids.
 */
export function describeXeroContainment(state: Props): {
  headline: string;
  detail: string;
} {
  const containment = state.containment;
  if (state.role === "UNKNOWN") {
    if (state.declarationKind === "production" && !state.overrideReadable) {
      return {
        headline: "Nothing is being written to Xero",
        detail:
          "This deployment DOES declare itself the club's live site, so the repair is not to declare it again. The safer override could not be read from the database, and until it can be, this application cannot rule out that an administrator has already forced this instance to behave as a copy — so it will not write to Xero on a guess. Reading from Xero still works. Apply the pending database migrations (prisma migrate deploy) or restore database access, then reload this page: Xero writing resumes on its own, and anything that was refused can be re-driven from Admin → Xero.",
      };
    }
    return {
      headline: "Nothing is being written to Xero",
      detail:
        "Until this installation says whether it is the club's live site or a copy, no invoice, credit note, payment, allocation or contact is written to Xero at all. Reading from Xero still works, so the Xero screens here will still load. The reason writing stops is that the answer decides what email address may sit on a Xero contact: the member's real one on the live site, a replaced one on a copy — because Xero emails invoice reminders from its own servers to whatever the contact holds. Guessing either way is wrong, so nothing is attempted. Set APP_ENVIRONMENT_ROLE and Xero writing resumes; anything that was refused can be re-driven from Admin → Xero.",
    };
  }
  if (!containment.available) {
    return {
      headline: "Could not be counted on this installation",
      detail:
        "This is not the same as none. The count could not be read from the database — usually a migration that has not been applied here. Until it can be, this line cannot tell you whether this copy has been editing contacts in the club's real Xero organisation.",
    };
  }
  if (containment.containedContacts === 0) {
    return {
      headline: "No Xero contact's address has been checked yet",
      detail:
        "This copy has not yet looked at the email address on any Xero contact. It does that the first time it needs a contact — to raise an invoice or a credit note, or when a member's details change — and it then replaces that contact's email address with one that cannot be delivered, so Xero cannot email a real member from here. That is a real edit in whichever Xero organisation this copy is connected to. Note this line is about CONTACT ADDRESSES only: a copy also writes invoices, credit notes and payments, deliberately, and those are not counted here.",
    };
  }
  const lastChecked = containment.mostRecentAt
    ? ` Last checked ${formatNZInstantOrRaw(containment.mostRecentAt)}.`
    : "";
  const since = containment.firstContainedAt
    ? ` The first was ${formatNZInstantOrRaw(containment.firstContainedAt)}.`
    : "";
  const contacts = `${containment.containedContacts} Xero contact${containment.containedContacts === 1 ? "" : "s"}`;
  if (containment.rewrittenContacts > 0) {
    /*
      `lastRewrittenAt`, NOT `mostRecentAt`. The sentence is about when a real
      address was last replaced, and `mostRecentAt` moves every time this copy
      re-checks any contact — so using it would date a destructive edit made in
      June to whenever the copy last ran anything at all.
    */
    const lastRewritten = containment.lastRewrittenAt
      ? ` The most recent was ${formatNZInstantOrRaw(containment.lastRewrittenAt)}.`
      : "";
    return {
      headline: `${containment.rewrittenContacts} real email address${containment.rewrittenContacts === 1 ? "" : "es"} replaced on ${contacts}`,
      detail: `Those contacts were holding a working email address and this copy overwrote it with one that cannot be delivered, so Xero can no longer email invoice reminders to a real member from here.${lastRewritten} If this copy is connected to a test Xero organisation, that is simply the copy behaving correctly and there is nothing to do. If it is connected to the club's REAL Xero organisation, those are real accounting records: every member's address is still correct in this database and on the live site, but it is gone from Xero, and putting it back is a manual job — see the list below.`,
    };
  }
  return {
    headline: `${contacts} checked, none was holding a real address`,
    detail: `Every Xero contact this copy has looked at was already unable to reach anybody — no address at all, or a club-internal placeholder — so this installation has not overwritten a working address on any of them.${since}${lastChecked}`,
  };
}

/**
 * The repair, spelled out, because the number on its own is not actionable.
 *
 * WHY IT IS MANUAL, and why saying so is better than offering a button that does
 * not exist. The earlier version of this screen told the operator to "re-sync
 * those members from the live site", and no shipped route does that: the admin
 * force-sync links a contact rather than pushing an address to it, the Xero push
 * refuses an already-linked member, and the contact update only fires when a
 * LOCAL field changes — none of them compares what Xero holds against what the
 * database holds. Nor could the copy repair this itself: writing a member's real
 * address back to Xero is exactly what containment exists to prevent, and it
 * would re-arm the reminders. And the live site cannot find the damage on its
 * own, because the record of what this copy changed is in THIS database.
 *
 * So the repair is: correct each contact in Xero, reading the right address off
 * the member's page on the club's live site. The list below gives the operator
 * the two things that makes possible — which contact, and whose it is.
 */
export function xeroContainmentRepairSteps(): string[] {
  return [
    "Open each contact in Xero using the links below, and put the member's email address back on it. The correct address is on that member's page on the club's LIVE site — it was never changed there.",
    "Do it on the club's live Xero organisation from a browser, not from this copy: a copy is not allowed to write a real address to a Xero contact, which is the whole point of the replacement, and doing so here would start Xero emailing real members again.",
    "Then point this copy at a separate Xero organisation — a demo or trial one — before using it again, so this cannot recur. Disconnecting Xero here also stops it.",
  ];
}

/**
 * Rendered for the two roles in which the answer means something: a confirmed
 * copy (containment is running, and this says how much it has edited) and an
 * undeclared installation (nothing is WRITTEN to the club's books at all,
 * though reading still works). NOT for
 * PRODUCTION, where containment never runs and the table is empty by definition
 * — a "0 contacts contained" line on the live site would be noise, which is the
 * same argument #3035 made for keeping the withheld-email total off a healthy
 * live site.
 */
export function EnvironmentXeroContainment(props: Props) {
  if (props.role !== "NON_PRODUCTION" && props.role !== "UNKNOWN") return null;
  const described = describeXeroContainment(props);
  const containment = props.containment;
  const listed = containment.available ? containment.rewritten : [];
  return (
    <div
      className="space-y-1 rounded-md border bg-card p-6"
      data-testid="environment-xero-containment"
    >
      <p className="text-sm font-semibold">The club&apos;s Xero contacts</p>
      <p className="text-base">{described.headline}</p>
      <p className="text-sm text-muted-foreground">{described.detail}</p>
      {/*
        The addressable half (#3036 review P0-5). A count tells somebody that
        damage exists; this tells them which contacts, whose they are, and where
        to go. Rendered only when there is something to repair.
      */}
      {listed.length > 0 ? (
        <div className="space-y-2 pt-2">
          <p className="text-sm font-semibold">Putting them back</p>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
            {xeroContainmentRepairSteps().map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <ul
            className="space-y-1 pt-1 text-sm"
            data-testid="environment-xero-rewritten-contacts"
          >
            {listed.map((contact) => (
              <li key={contact.xeroContactId}>
                <a
                  className="underline"
                  href={contact.xeroContactUrl}
                  rel="noreferrer noopener"
                  target="_blank"
                >
                  {contact.memberName ??
                    `Xero contact ${contact.xeroContactId}`}
                </a>
                {contact.memberId ? (
                  <>
                    {" — "}
                    <a
                      className="underline"
                      href={`/admin/members/${contact.memberId}`}
                    >
                      member page
                    </a>
                  </>
                ) : (
                  " — no member on this installation points at this contact any more"
                )}
                {contact.rewrittenAt
                  ? ` — replaced ${formatNZInstantOrRaw(contact.rewrittenAt)}`
                  : null}
              </li>
            ))}
          </ul>
          {containment.available &&
          containment.rewrittenContacts > listed.length ? (
            <p className="text-sm text-muted-foreground">
              {containment.rewrittenContacts - listed.length} more are not
              listed here. The count above is the real total.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
