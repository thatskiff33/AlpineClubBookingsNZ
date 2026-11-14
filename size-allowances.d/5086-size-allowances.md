# Size allowances for #5086

function: src/app/(admin)/admin/finance/refund-requests/page.tsx#RefundRequestsPage
lines: 796
reason: this change (Add Go back to admin email-choice dialogs) adds its lines
  here; those lines sit inside the function `RefundRequestsPage`, which was
  already over its limit before this change, and lifting it apart is a
  refactor of its own, not part of this fix.

function: src/components/cancel-booking-button.tsx#CancelBookingButton
lines: 648
reason: this change (Add Go back to admin email-choice dialogs) adds its lines
  here; those lines sit inside the function `CancelBookingButton`, which was
  already over its limit before this change, and lifting it apart is a
  refactor of its own, not part of this fix.

function: src/components/edit-booking-panel.tsx#EditBookingPanel
lines: 2009
reason: this change (Add Go back to admin email-choice dialogs) adds its lines
  here; those lines sit inside the function `EditBookingPanel`, which was
  already over its limit before this change, and lifting it apart is a
  refactor of its own, not part of this fix.
