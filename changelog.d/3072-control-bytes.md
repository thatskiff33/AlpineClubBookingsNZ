### Fixed

- **Five safety checks inside the system had been silently switched off, and two
  of them could never have reported a problem again (#3072).** Nothing a member
  or an administrator does was affected, and no booking, payment or record was
  ever at risk. What was affected is the club's own early-warning system: five
  automatic checks that are supposed to fail loudly if a future change breaks
  something had stopped being able to fail at all.

  The cause was a single invisible character. An editing tool used while working
  on the code had replaced a two-character instruction with the one unprintable
  byte that instruction names. Every ordinary way of looking at the file —
  an editor, a code review, the website that hosts the code — displays that byte
  back as the two characters, so the code read as completely correct to everyone
  who looked at it, and every other automatic check kept passing.

  Two of the five mattered. One was there to stop a particular kind of date
  mistake getting into the queries the support diagnostics run against bookings;
  the other was there to guarantee that no member's email address can ever appear
  on an accounting-integration screen. Both had been passing unconditionally
  rather than actually checking. Both have been repaired and then deliberately
  broken in testing to confirm they now do report the thing they exist to catch.
  Neither had let a real problem through in the meantime.

### Added

- **The routine documentation check now refuses this class of invisible damage
  outright (#3072).** The same check that already rejects a few other kinds of
  invisible file corruption now also rejects stray unprintable characters in any
  file that is meant to be readable text, including inside a comment, and there
  is no exemption list. When it does object it names the file, the line, the
  column and — the useful part — the two-character instruction the author had
  meant to write, so whoever hits it is handed the actual problem rather than a
  file that looks identical to a correct one.

  It also closes a gap that would have let one particular character hide a whole
  file from every check in that command. That was not a theoretical worry: the
  same character had already appeared in two working files for ordinary, correct
  reasons, and both now spell it out in a way that means exactly the same thing
  to the computer while staying readable to a person.
