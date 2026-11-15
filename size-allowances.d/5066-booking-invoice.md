# Size allowances for #5066 (booking invoice, fork #115)

## Function-length ratchet

function: src/app/(authenticated)/bookings/[id]/page.tsx#BookingDetailPage
lines: 363
reason: one line, the canDownloadInvoice prop on the BookingEditor the page
  already renders. The rule lives in canDownloadBookingInvoice and the button
  in its own component; the viewer and booking it reads are resolved in this
  body, so the call has to sit beside them.
