- **Five quiet faults fixed across the admin screens, the booking endpoints and
  the officer quote form, found by making the code say what happens when a
  lookup finds nothing (#2801).** This is internal type-safety work and no fee,
  capacity, membership, booking or authorisation decision changes — but five
  places were already able to save or show something wrong, and all five now
  leave the data alone instead:

  - dragging a bed-allocation preference and then switching that same preference
    off mid-drag could add a blank entry to the saved preference order;
  - the same shape existed when reordering membership types, where it could also
    have moved the wrong row;
  - the school attendee confirmation form could store half a name change — the
    first name set and the surname missing, or the other way round — for a guest
    it did not recognise, and the missing half then silently saved as the name
    already on file;
  - an officer who CLEARED a booking request's total and pressed Save quote was
    quoted the request's stored price instead of being told the box was empty.
    The figure had just been deliberately erased, and nothing showed that it had
    come back. It now refuses, and sends nothing;
  - the setup wizard crashed rather than showing its own explanation when no
    steps were configured.

  On the money side, the endpoints that add a guest to a booking, quote a change
  and check a promo code now refuse outright if the pricing pass has not priced
  one of the guests it was given, rather than reading a neighbouring guest's
  amounts. That is the same rule the club already applies to a missing night
  price: an amount nobody calculated is never replaced by a guess or by somebody
  else's. The refusals are covered by new tests that pin them, and the
  member-facing message is unchanged in every case.

  Two displays also stopped guessing. A guest whose per-night price list is
  shorter than their stay now shows nothing for the nights it does not cover,
  rather than a neighbouring night's price; and a finance chart asked for a
  colour scheme that does not exist now fails loudly at start-up instead of
  picking a colour.

  Nothing was silenced to make the compiler happy. Measured across the whole
  change rather than claimed: in the code that runs, no forced non-null reads,
  no `any`, no suppression comments, and **six type casts removed against one
  added** — and the one added is narrower than the two it replaced, on a request
  body each of whose fields is still checked individually before use. One lookup
  turned out to be unreachable and was deleted rather than guarded. The
  recorded list of remaining places the stricter `noUncheckedIndexedAccess`
  check would complain drops from 255 to 52 with this stage of programme #2694 —
  every non-test file under the application routes, pages and components is now
  clean, and only build scripts and database seeds remain — and the build still
  fails if it ever grows.

  Administrators and members see no change to any screen, other than the two
  refusals above, which replace a wrong answer with a clear one.
