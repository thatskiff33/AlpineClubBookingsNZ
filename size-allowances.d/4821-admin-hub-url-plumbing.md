# File-size allowances for #4821

The sidebar was already over its budget. Mark-paid and subscription-billing
are the same length as `main` after #4822, so they are not declared here.

file: src/components/admin-sidebar.tsx
lines: 1217
reason: the active-link comparison stays in the sidebar, as samePage over the
  visible hrefs. That is two lines longer than activeAdminHref, and lifting
  the highlight out of the component that renders the link would split the
  rule from the nav it highlights.
