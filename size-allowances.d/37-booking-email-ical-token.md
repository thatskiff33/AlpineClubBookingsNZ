# File-size allowances for #37 (fork PR — {{ical}} token, fork issue #35)

Each of these three files is the canonical single home for one facet of a new
email token, and the token cannot land without touching all three. None of the
additions is splittable: an approved-token vocabulary entry, a preview sample,
a sensitive-subject entry, an OPTIONAL declaration, and a sender's
compose-and-supply block each belong exactly where their siblings live, and a
satellite file for one token would break the "one home per contract" shape the
email guards enforce.

file: src/lib/email-message-registry.ts
lines: 2043
reason: +24 — the {{ical}} vocabulary entry, its sensitive-subject entry (the block carries the signed .ics bearer URL), and its hard-coded realistic-length preview sample.
The registry is the single authority for approved tokens and samples; the
sample is hard-coded here (not composed) because composing needs the HMAC
secret and this module is editor-facing.

file: src/lib/email-message-token-contract.ts
lines: 719
reason: +4 — the OPTIONAL_TEMPLATE_TOKENS declaration for {{ical}} (the sender
fails open on this decoration, so the token can render empty and the
dangling-line guard must prove the default body survives that). The table's own
docblock mandates recording the declaration in the same change as the sender.

file: src/lib/email/booking.ts
lines: 1487
reason: +60 — the authority-gated (resolveBookingEmailLink), fail-open compose of the calendar links and the {{ical}}
templateData supply in the booking-confirmed sender. The module's docblock
names it the family boundary for booking sends; the reusable logic itself lives
in the new src/lib/calendar-links.ts, which is well under budget.
