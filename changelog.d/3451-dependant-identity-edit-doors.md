- **Adding or renaming a guest on Edit Booking now asks when the name matches
  one of your own dependants (#3451).** Edit Booking asks the same question the
  booking wizard already asks — **This is my dependant — book them as a
  member**, or **This is a different person with the same name** — instead of
  silently adding your child as a provisional, separately invoiced non-member
  guest. Officers editing on a member's behalf are asked about that member's
  dependants, in their own words. The preview and the save both re-check the
  answer against the club's own records; a **Request Booking Officer approval**
  sent from Edit Booking carries the answer and is checked again on approval;
  guests whose names are unchanged are not asked about again; and a guest added
  through the API-only add-guests route is refused with a message pointing at
  Edit Booking. Only the booking owner's own recorded dependants are ever
  compared, on an exact name match.
