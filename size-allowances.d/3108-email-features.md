# File-size allowances for #3108 (fork PRs triyder#37 + triyder#40)

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
lines: 1491
reason: +60 — the authority-gated (resolveBookingEmailLink), fail-open compose of the calendar links and the {{ical}}
templateData supply in the booking-confirmed sender. The module's docblock
names it the family boundary for booking sends; the reusable logic itself lives
in the new src/lib/calendar-links.ts, which is well under budget.


The editor itself and the policy module are new files well under budget
(`email-body-rich-editor.tsx`, `email-body-html.ts`); what remains below is
the irreducible wiring in three files that are each the canonical single home
for their half of the feature.

file: src/lib/email-message-renderer.ts
lines: 897
reason: +49 — the rich-body render branch and its palette container (sanitise → escaped token
substitution → themed shell) beside the legacy plain path, at both the send
and preview sites, plus the record-type field. The renderer is the single
authority on how a stored override becomes HTML; the policy and transforms
live in the new src/lib/email-body-html.ts.

file: src/app/api/admin/email-templates/route.ts
lines: 657
reason: +79 — the bodyHtml field through the update schema, the derived-text 10k cap, the formatting-only staleness comparison, the
sanitise-then-derive-text save rule (bodyText is derived from the rich body
so audit, diffs and validation keep operating on text), the
text-save-clears-rich-body shadowing guard, and the serialized override.
This route is the single save/read surface for template overrides.

file: src/components/admin/email-settings/email-message-settings-panel.tsx
lines: 1015
reason: +36 — the rich-editor mount, the editorHtmlFor load/dirty helper, the formatting-only diff note and
the bodyHtml save/preview payloads. The panel is the single staged-edit
surface for email templates; the editor's bulk lives in its own component.
