# File-size allowance for #4828

Site Appearance's menu row now calls `adminHref("appearance")`. That adds
one import line to the sidebar. The row itself stays the same length.

file: src/components/admin-sidebar.tsx
lines: 1181
reason: the sidebar is one navigation table, and this change only imports
  adminHref so Site Appearance's href comes from the hub registry. Splitting
  that table to absorb one import would separate the menu row from the rest
  of the table it belongs with.
