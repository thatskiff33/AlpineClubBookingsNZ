- **Officers can correct a school's email address and phone number in the app
  (#5245).** Until now a school's own email and phone were saved once, from its
  first booking request, and the only fix was to edit the school's Xero contact
  by hand, which still left the app's copy wrong.

  An officer who can edit bookings now presses **Edit school details**, either
  beside a school's booking on **Bookings** or under the school notice in
  **Correct this request**. Emails and invoices to the school use the new
  details from then on; anything already sent is not changed. The school's Xero
  contact is updated for you. If Xero refuses the change, the dialog shows why
  and offers **Retry sending to Xero**. A school with no Xero contact yet gets
  the corrected details on its first invoice. The school's name in Xero is
  never changed.

  A later booking request still never changes the saved details, even if it
  types different ones. If two officers edit the same school at once, the
  second save is refused with "Changed by someone else" instead of overwriting
  the first. Each change is recorded in the audit log with the old and new
  values.
