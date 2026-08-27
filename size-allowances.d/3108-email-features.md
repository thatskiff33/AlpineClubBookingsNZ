# File-size allowances for #3108 (fork PRs triyder#37 + #40 + #42 + #44)

One consolidated allowance for the one upstream PR, per the one-file-per-PR
convention. Each file below is the canonical single home for its half of the
email features this PR carries; the reusable logic lives in new under-budget
modules (`calendar-links.ts`, `email-body-html.ts`, `email-body-rich-editor.tsx`).

file: src/lib/email-message-registry.ts
lines: 2046
reason: the {{ical}} approved-vocabulary entry, its realistic preview sample,
and the ical/icalHtml sensitive-subject entries. The registry is the single
authority for approved tokens, samples and the subject-forbidden list.

file: src/lib/email-message-token-contract.ts
lines: 719
reason: the OPTIONAL_TEMPLATE_TOKENS declaration for {{ical}} (the sender
fails open on this decoration, so the dangling-line guard must prove the
default body survives an empty render). The table's own docblock mandates
recording the declaration beside the sender change.

file: src/lib/email/booking.ts
lines: 1497
reason: the authority-gated, fail-open compose of the calendar links, the
flat {{ical}} block, and the icon-row twin in the booking-confirmed sender.
The module's docblock names it the family boundary for booking sends.

file: src/lib/email-message-renderer.ts
lines: 945
reason: the rich-body render branch with its palette container, and the
{{ical}} sentinel-swap mechanism at the three render sites (plain override,
rich override, preview). The renderer is the single authority on how a body
becomes HTML; the swap must sit exactly where escaping and sanitising happen
or the security property it preserves cannot be reasoned about.

file: src/app/api/admin/email-templates/route.ts
lines: 668
reason: the bodyHtml field through the update schema, the sanitise-then-
derive-text save rule, the derived-text 10k cap, the text-save-clears-rich-
body shadowing guard, the formatting-only staleness comparison, and the
serialized override. This route is the single save/read surface for template
overrides.

file: src/components/admin/email-settings/email-message-settings-panel.tsx
lines: 1015
reason: the rich-editor mount, the editorHtmlFor load/dirty helper, the
formatting-only diff note and the bodyHtml save/preview payloads. The panel
is the single staged-edit surface for email templates; the editor's bulk
lives in its own component.
