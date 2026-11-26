# Size allowances for #5247

file: src/components/admin/booking-requests/policy-exception-requests-panel.tsx
lines: 1067
reason: the Expired filter and the filter and page in the address add a label
  map and the `usePolicyExceptionQueueAddress` hook. The hook sits beside the
  panel, outside its already over-limit function, rather than in its own file,
  because the INV-OPS-020 pagination census requires each queue panel to call
  `useAdminQueuePage` and parse its page key itself. Splitting the panel's
  card rendering out is a refactor of its own, not part of this fix.
