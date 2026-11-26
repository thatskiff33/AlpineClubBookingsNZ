# File-size allowances for #5322

file: src/app/(admin)/admin/config-transfer/page.tsx
lines: 658
reason: #5190 review: an import whose post-commit liability clear-up failed
  must warn the officer. The warning itself lives in
  `src/components/admin/config-import-clear-up-warning.tsx`; what stays here
  is the one boolean the apply handler sets and the page's reset points clear,
  which belong beside the page's other apply-result state. Splitting the
  page's apply flow out is a refactor of its own.

function: src/app/(admin)/admin/config-transfer/page.tsx#ConfigTransferPage
lines: 567
reason: the same six lines, inside the page component that owns the apply
  state; see the file entry above.
