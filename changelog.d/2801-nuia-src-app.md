- **Three quiet faults fixed in the admin screens and booking endpoints, found
  by making the code say what happens when a lookup finds nothing (#2801).**
  This is internal type-safety work and no fee, capacity, membership, booking or
  authorisation decision changes — but three places were already able to save
  something wrong, and all three now leave the data alone instead:

  - dragging a bed-allocation preference and then switching that same preference
    off mid-drag could add a blank entry to the saved preference order;
  - the same shape existed when reordering membership types, where it could also
    have moved the wrong row;
  - the school attendee confirmation form could store half a name change — the
    first name set and the surname missing, or the other way round — for a guest
    it did not recognise, and the missing half then silently saved as the name
    already on file.

  On the money side, the endpoints that add a guest to a booking, quote a change
  and check a promo code now refuse outright if the pricing pass has not priced
  one of the guests it was given, rather than reading a neighbouring guest's
  amounts. That is the same rule the club already applies to a missing night
  price: an amount nobody calculated is never replaced by a guess or by somebody
  else's. Two of the three are covered by new tests that pin the refusal; the
  member-facing message is unchanged in every case.

  Nothing was silenced to make the compiler happy: no forced non-null reads, no
  type casts, no suppression comments. The recorded list of remaining places the
  stricter `noUncheckedIndexedAccess` check would complain drops from 255 to 138
  with this stage of programme #2694 — every non-test file under the application
  routes and pages is now clean — and the build still fails if it ever grows.

  Administrators and members see no change to any screen.
