"use client";

import { memberGuestConsentPreviewColumns } from "@/components/book/member-guest-preview";
import { describeMemberGuestConsentBadge } from "@/lib/member-guest-consent-card";
import type { Guest, NewGuest } from "@/components/edit-booking/types";

/**
 * The member-guest consent sentences the edit panel draws beside a guest row.
 *
 * Moved verbatim from `edit-booking-panel.tsx` (#2690). Both compose their
 * wording from shared code rather than writing it here, so what the booker reads
 * before saving and what the booking page shows afterwards cannot drift.
 */

/**
 * The pre-save consent badge and helper line for one newly added guest.
 *
 * Two composed strings, both from shared code rather than from wording written
 * here: the badge from `describeMemberGuestConsentBadge`'s WIZARD audience —
 * the warmer, name-bearing form the create path already uses — and the helper
 * from a tense-corrected version of the same sentence.
 *
 * The columns handed to the badge function are a REAL sub-state of the eight-
 * shape table, not an approximation: `AWAITING_TARGET` without its expiry (the
 * wizard audience shows no date, and a null cannot leak into a rendered
 * deadline the way an invented one could), or `NOTIFY_ONLY_AUTO_CONFIRMED`
 * exactly. Returns null for every other added guest.
 */
export function renderAddedGuestConsent(guest: NewGuest) {
  const columns = memberGuestConsentPreviewColumns(guest);
  if (!columns) return null;
  const preview = guest.memberGuestConsentPreview;
  const badge = describeMemberGuestConsentBadge({
    guest: { memberId: guest.memberId ?? null, ...columns },
    audience: "WIZARD",
    targetFirstName: guest.firstName,
  });
  const name = guest.firstName.trim() || "They";
  return (
    <>
      {badge ? (
        <span
          className={
            badge.tone === "pending"
              ? "mt-1 inline-block rounded-md border border-warning-6 bg-warning-3 px-2 py-0.5 text-xs font-semibold text-warning-11"
              : badge.tone === "ok"
                ? "mt-1 inline-block rounded-md border border-success-6 bg-success-3 px-2 py-0.5 text-xs font-semibold text-success-11"
                : "mt-1 inline-block rounded-md border border-danger-6 bg-danger-3 px-2 py-0.5 text-xs font-semibold text-danger-11"
          }
        >
          {badge.label}
        </span>
      ) : null}
      <p className="mt-1 text-xs text-muted-foreground">
        {preview === "PENDING"
          ? `${name} will be emailed when you save this change, and their bed is held until they answer.`
          : preview === "ADMIN_ASSIGNED"
            ? // MG4-D-a, both halves, and the second is the one an officer is
              // likely to assume away. Tensed for the edit panel — nothing is
              // written until the save — exactly as the PENDING line above is.
              `Added by the club and told by email. ${name} will not be asked first.`
            : "Your club adds member guests straight away and emails them to say so."}
      </p>
    </>
  );
}

/**
 * The one explanatory sentence under an EXISTING member-guest row (MG4 #2309).
 *
 * Two rows carry one, and both come from the signed-off mockup:
 *
 *  - a row still waiting for an answer, where the control below it says "Cancel
 *    request" rather than "Remove" and the booker deserves to know that
 *    pressing it sends an email and frees a held bed;
 *  - a row the club placed (`ADMIN_ASSIGNED`), where MG4-D-a's second half —
 *    they were told, and they were never asked — is the part that goes without
 *    saying and therefore goes unsaid.
 *
 * Every other row returns null and is byte-identical to before: family guests,
 * non-member guests, ordinary consents, and every booking that predates the
 * feature.
 */
export function renderExistingGuestConsentHelper(guest: Guest) {
  const name = guest.firstName.trim() || "They";
  if (guest.consent?.tone === "pending") {
    return (
      <p className="mt-1 text-xs text-muted-foreground">
        Cancelling withdraws the request. {name} is told, and their held bed is
        released.
      </p>
    );
  }
  if (guest.consent?.subState === "ADMIN_ASSIGNED") {
    return (
      <p className="mt-1 text-xs text-muted-foreground">
        Added by the club and told by email. {name} was not asked first.
      </p>
    );
  }
  return null;
}
