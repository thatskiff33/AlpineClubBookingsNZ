# File-size allowances for #40 (fork PR — rich email bodies, fork issue #38)

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
