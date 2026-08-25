# File-size allowances for #44 (fork PR — {{ical}} icons in overrides, fork issue #43)

file: src/lib/email-message-renderer.ts
lines: 945
reason: +55 — the sentinel-swap mechanism (withIcalSentinel) and its wiring
at the three render sites (plain override, rich override, preview). The
renderer is the single authority on how a body becomes HTML, and the swap
must sit exactly where escaping and sanitising happen or the security
property it preserves cannot be reasoned about; the icon row itself lives in
calendar-links.ts, which stays well under budget.

file: src/lib/email-message-registry.ts
lines: 2046
reason: +3 — the icalHtml sensitive-subject entry (belt-and-braces). The
registry is the single home for the subject-forbidden list.

file: src/lib/email/booking.ts
lines: 1496
reason: +5 — the sender supplies the icon row beside the flat block inside
its existing fail-open compose. The module's docblock names it the family
boundary for booking sends.
