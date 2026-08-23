/**
 * The persistent "these messages were never sent" warning for a booking with
 * the "No emails" switch (#2259, owner decision D10).
 *
 * D10's compensating control has two halves. The acknowledgement dialog
 * (`booking-no-emails-controls.tsx`) makes the admin state the obligation
 * before anything is suppressed; THIS states what the obligation now covers,
 * every time the booking is opened, from the audit record rather than from a
 * static sentence. A fixed "some emails may have been withheld" would be
 * useless: the admin has to know which messages the member never received in
 * order to relay them, and the list includes the invoice emails Xero would have
 * sent on our behalf, which are inside the same guarantee.
 *
 * It renders in two shapes:
 *
 *  - switch ON: danger tokens, because the silence is ongoing;
 *  - switch OFF but rows exist: warning tokens, because the obligation did not
 *    expire when the switch was cleared. Turning emails back on does not re-send
 *    anything, so a member who was never told about a cancellation is still
 *    never told. This is the case a "show it only while the switch is on"
 *    banner would quietly drop.
 *
 * Presentational and admin-only: the booking page mounts it inside its
 * admin-tools gate and never computes the withheld list for a member. Nothing
 * here is safe to show a member — a member must never learn the switch exists.
 */
import Link from "next/link";
import { clubTime } from "@/lib/club-time/server";
import type { WithheldEmailRemedy } from "@/lib/booking-email-suppression";

export interface WithheldEmailGroupView {
  templateName: string;
  /**
   * Human name for the kind — the registry label where one exists, and
   * deliberately the raw template name where none does, rather than inventing
   * a friendly name for a message nobody has registered.
   */
  label: string;
  /** Exact number of this kind withheld. */
  count: number;
  /** Representative subject; empty when none was read. */
  subject: string;
  /** ISO timestamp of the most recent one. */
  latestAt: string;
  /** What the officer has to do about this kind. */
  remedy: WithheldEmailRemedy;
}

/**
 * The per-kind remedy line. Only two kinds need one, and they need DIFFERENT
 * ones — treating them alike is what made the first version of this banner
 * tell an officer to clear the switch and wait for a chore link that nothing
 * regenerates.
 */
function remedyNote(remedy: WithheldEmailRemedy): string | null {
  if (remedy === "auto-regenerates") {
    return "Nothing was created to forward — clear the switch and it is re-sent automatically.";
  }
  if (remedy === "resend-roster") {
    return "The guest's chore link was replaced but never delivered, so their old link no longer works. Clear the switch, then re-send the roster from the Roster page — nothing re-sends this on its own.";
  }
  return null;
}

/**
 * ASYNC, and the `await` is the point (CT-4, #2870; epic #2988). The withheld-row
 * stamps below are real INSTANTS and must read in the club's PERSISTED timezone
 * (`INV-CONFIG-002`), which is a server-only database read. This is a server
 * component, so it takes the club's own binding directly rather than through the
 * client provider - the same interface, one line different. Every caller renders
 * it as a child, which is unchanged by the component becoming async.
 */
export async function BookingWithheldEmailsBanner({
  noEmails,
  isWaitlisted = false,
  total,
  groups,
}: {
  noEmails: boolean;
  /**
   * Whether the booking is still WAITLISTED. A silenced waitlist entry is
   * skipped for offers ENTIRELY, so no offer is made and no withheld row is
   * ever written — the one consequence this banner is structurally blind to,
   * and therefore the one it has to state outright.
   */
  isWaitlisted?: boolean;
  /** Exact total across all kinds. */
  total: number;
  /** One entry per KIND of message, most recently withheld first. */
  groups: WithheldEmailGroupView[];
}) {
  // Nothing to warn about: emails are on and nothing was ever withheld.
  if (!noEmails && total === 0) return null;

  const club = await clubTime();

  const tone = noEmails
    ? "border-danger-6 bg-danger-3 text-danger-11"
    : "border-warning-6 bg-warning-3 text-warning-11";

  return (
    <div
      id="no-emails"
      data-testid="booking-withheld-emails-banner"
      className={`scroll-mt-20 space-y-3 rounded-md border px-4 py-3 text-sm ${tone}`}
    >
      <div className="space-y-1">
        <p className="font-medium">
          {noEmails
            ? "Emails are turned off for this booking"
            : "Some emails for this booking were never sent"}
        </p>
        <p>
          {noEmails
            ? "Nothing is being sent to the member about this booking — confirmations, changes, payments, reminders, arrival information, cancellations, chore rosters and the Xero invoice email are all withheld."
            : "Emails are on again, but the messages below were withheld while the switch was on and are not re-sent."}{" "}
          <span className="font-medium">
            Telling the member about these is your responsibility, not the
            system&apos;s.
          </span>
        </p>
        {/*
          Stated separately from the categories above, and deliberately so: a
          silenced waitlist entry is passed over for offers ALTOGETHER, so there
          is no offer email to withhold and no row will ever appear below for
          it. Listing "waitlist offers" among the withheld categories would
          imply an offer was made and only its email held back.
        */}
        {noEmails && isWaitlisted && (
          <p className="font-medium">
            This booking is also being passed over for waitlist offers while
            emails are off — no offer is made at all, so nothing about that
            appears in the list below.
          </p>
        )}
      </div>

      {total === 0 ? (
        <p>Nothing has been withheld yet.</p>
      ) : (
        <div className="space-y-1">
          <p className="font-medium">
            Withheld so far: {total} {total === 1 ? "message" : "messages"}
            {groups.length > 1 ? `, across ${groups.length} kinds` : ""}
          </p>
          <ul className="list-inside list-disc space-y-1">
            {groups.map((group) => (
              <li key={group.templateName}>
                <span className="font-medium">{group.label}</span>
                {group.count > 1 ? <span> &times;{group.count}</span> : null}
                {group.subject ? (
                  <>
                    {" — "}
                    <span>{group.subject}</span>
                  </>
                ) : null}
                {" ("}
                {group.count > 1 ? "most recent " : ""}
                {club.instantDateTime(new Date(group.latestAt))}
                {")"}
                {remedyNote(group.remedy) ? (
                  <span className="mt-0.5 block pl-5 italic">
                    {remedyNote(group.remedy)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/*
        The list is what the system RECORDED withholding, which is not the same
        as everything the member missed. Three classes are structurally absent —
        a send that failed closed on an unreadable switch, a withheld send whose
        own EmailLog write failed, and rows queued before this feature shipped —
        and saying so costs one line, where letting an officer over-trust the
        list costs a member being told nothing at all.
      */}
      <p className="text-xs">
        This lists messages the system deliberately withheld. A message that
        failed for any other reason shows up under{" "}
        <Link
          className="font-medium underline"
          href="/admin/email-deliverability"
        >
          Admin &rarr; Email deliverability
        </Link>{" "}
        instead — worth a look before you tell the member this is the whole
        list.
      </p>
    </div>
  );
}
