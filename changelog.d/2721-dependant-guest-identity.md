- **Booking your own child as a guest by accident is no longer possible (#2721).**
  Typing the name of somebody the club records as your dependant into the guest
  form used to quietly book them as a non-member guest. That is the wrong side of
  the booking: a non-member guest can be held provisionally under a Members First
  policy — no bed reserved until the stay is nearly here — is bumped first if the
  lodge fills, and is billed as the separate guest portion. Your dependant is a
  member and should have a bed held at the member rate.

  The wizard now stops on an exact name match and asks which person you mean.
  **This is my dependant** moves them onto the member side of the party, or says
  what has to happen first and who can do it when they are not yet ready to be
  booked from that screen — sometimes that is your own profile, and sometimes it
  is the club, because a dependant can be recorded as yours without being in your
  family group. **This is a different person with the same name** lets the guest
  stay a guest, and is asked once per dependant, so two dependants who share a
  name are answered for separately. The server checks the answer again when the
  booking is made, so a stale browser tab or a request that never came from the
  wizard cannot slip one through.

  The same question is asked when you send the club a booking request that needs
  an officer's approval, because approving one makes a real booking. The officer
  cannot answer it for you — the whole point is that a name is not proof of who
  somebody is — so if your dependant is recorded after you send the request, the
  officer is asked to send it back rather than book your child as a guest without
  you there.

  Names that look identical on screen are now treated as identical: a macron
  typed on one keyboard and the same macron typed on another are the same letter,
  and used to be read as two different names. Near misses are still different
  names — a curly apostrophe is not a straight one, a hyphen is not a space, and
  a middle name on one side is a different name.

  Nothing is compared against anybody else's family. The check looks only at your
  own recorded dependants, and only at names that match exactly — no near
  spellings, no sound-alikes — so the guest name box cannot be used to find out
  whether some name belongs to a member. Adding genuine non-member guests, and
  adding members from your family group, are unchanged.

  **A booking officer recording a stay on a member's behalf is asked the same
  question**, on the admin booking page's guest step, about that member's
  dependants. The protection is for somebody who is not in the room — the child
  whose bed it is, whose parent is not at the screen — so it does not lapse
  because a different person is doing the typing. The officer gets the same two
  answers: book the dependant as a member, or say it is a different person with
  the same name. Where a dependant is recorded but is not in the member's family
  group, the page says to add them to it under Membership first, which is
  something an officer can do.

  Adding a guest to a booking that already exists, and changing one, are not
  covered yet — that is #3451.
