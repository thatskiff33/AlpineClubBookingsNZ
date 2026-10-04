# File-size allowances for #3835

The settle dialog tells the officer, before a financial review on a cancelled
booking is completed, what the share will actually give back. The notice, its
fetch and its copy are in their own files
(`manual-refund-task-still-owed-notice.tsx`, `stillOwedNoticeText`); the only
lines left here are its import and the one place it mounts.

file: src/components/admin/manual-refund-task-queue.tsx
lines: 2116
reason: the notice has to mount inside the dialog, beside the amount box whose
  figure it is computed from and whose state lives here; an import and one
  JSX element are the whole addition.
