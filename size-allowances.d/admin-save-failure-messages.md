# File-size allowances for the #4976 follow-up (admin save failures)

Each handler gains an import of the shared reader, a named fallback, and a
network-failure branch. Moving one handler out of an oversized page to save
those lines would scatter a page's own save logic, and splitting these pages
is a refactor of its own.

Figures re-measured on the ALP-649 branch, which carries this lane (ALP-581)
together with ALP-578's focused alerts and ALP-589's reads.

file: src/app/(admin)/admin/membership/family-groups/page.tsx
lines: 907
reason: the create handler had no catch at all; the shared-reader import, the
  named fallback and the network-failure branch are the whole fix.

file: src/app/(admin)/admin/rules/fees/_components/hut-fees-section.tsx
lines: 1279
reason: the save handler gains the shared-reader import and a named fallback
  so the refusal and the network failure say the same sentence.

file: src/app/(admin)/admin/work-parties/page.tsx
lines: 634
reason: the delete handler had no network-failure path and parsed before
  checking res.ok; the import, fallback and null-response branch are the fix.
  The figure also covers ALP-649 (stacked): the active toggle gains the catch
  it never had, and the attending-bookings read moves to a module-level
  helper that throws its refusal.
