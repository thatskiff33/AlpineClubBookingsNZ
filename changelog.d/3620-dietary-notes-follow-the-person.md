- **A guest's dietary note now follows the person, not the row, when a booking
  guest is linked to a member or renamed (#3021).** Linking a member onto a
  guest row that someone had already named, or renaming a school attendee to a
  different child, used to leave the previous person's note on the row, where
  the kiosk and the linked member's own data export showed it as theirs. The
  note is now kept only when the row is still the same person (a placeholder
  being filled in, or the same name or a spelling fix at the same age);
  otherwise it is replaced from the new member's own profile, or cleared.

  The upgrade runbook's rollback clean-up now also clears the profile note on
  any account deleted while the previous version was still serving.
