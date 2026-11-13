# File-size allowances for the #4976 follow-up (admin save failures)

Each handler gains an import of the shared reader, a named fallback, and a
network-failure branch. Moving one handler out of an oversized page to save
those lines would scatter a page's own save logic, and splitting these pages
is a refactor of its own.

file: src/app/(admin)/admin/family-groups/page.tsx
lines: 884
reason: the create handler had no catch at all; the shared-reader import, the
  named fallback and the network-failure branch are the whole fix.

file: src/app/(admin)/admin/rules/fees/_components/hut-fees-section.tsx
lines: 1273
reason: the save handler gains the shared-reader import and a named fallback
  so the refusal and the network failure say the same sentence.

file: src/app/(admin)/admin/work-parties/page.tsx
lines: 624
reason: the delete handler had no network-failure path and parsed before
  checking res.ok; the import, fallback and null-response branch are the fix.
