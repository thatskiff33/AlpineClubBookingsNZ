# File-size allowances for ALP-578 (#4975)

Each surface gains a permanently mounted `FocusedActionError` (a multi-line
JSX block where a one-line conditional box used to be), a separate passive
load-error state, and — where a save unmounts the focused control — a
`useActionAttention` call. The growth is that wiring and its short "why"
comments; splitting a page to absorb a dozen lines of focus wiring would put
the alert in a different file from the action that fills it.

file: src/app/(admin)/admin/booking-desk/book/page.tsx
lines: 1669
reason: the action alert and its Xero-reconnect link replace the old error box in place.

file: src/app/(admin)/admin/family-groups/page.tsx
lines: 890
reason: two focused action alerts (revoke, save) replace two plain error boxes.

file: src/app/(admin)/admin/finance/refund-requests/page.tsx
lines: 998
reason: the queue's load error and its review failures are now two states, each with its Dismiss control.

file: src/app/(admin)/admin/system/backups/backups-client.tsx
lines: 859
reason: focused alerts for Run now and the credentials save, beside the controls they explain.

file: src/app/(admin)/admin/website/mountain-conditions/_components/mountain-conditions-panel.tsx
lines: 920
reason: the passive load error and the focused action alert are now separate states.
