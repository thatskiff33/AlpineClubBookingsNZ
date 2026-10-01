- **Adding a guest to an existing booking now asks when the name matches one of
  your own dependants (#3451).** The booking's edit panel asks the same question
  the booking wizard already asks — **This is my dependant — book them as a
  member**, or **This is a different person with the same name** — instead of
  silently adding your child as a provisional, separately invoiced non-member
  guest. Officers editing on a member's behalf are asked about that member's
  dependants, in their own words. The preview and the save both re-check the
  answer against the club's own records, guests already on the booking are not
  asked about again, and a guest added through the API-only add-guests route is
  refused with a message pointing at **Edit Booking**. Only the booking owner's
  own recorded dependants are ever compared, on an exact name match.
