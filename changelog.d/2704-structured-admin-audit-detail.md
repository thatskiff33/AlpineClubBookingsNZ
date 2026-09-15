- **A very large audit entry no longer arrives on screen broken, and can no
  longer show a piece of a number as though it were the number (#2704).** The
  audit trail's detail field has a size limit, and until now an entry that ran
  past it was cut off at the thousandth character, wherever that fell. Two
  things followed, on exactly the entries an officer most needs to read. The
  expanded row showed a wall of broken text instead of named fields, with no
  metadata panel and none of the drill-through links. And the cut could land in
  the middle of a value: an entry recording an amount of 1234567 could be stored
  showing `1`, with nothing on screen to say it was a fragment, so anyone
  reading it read a figure wrong by six orders of magnitude.

  An entry that will not fit now keeps whole fields instead. It records as many
  complete fields as there is room for, says how long the full record was, and
  names the fields it could not keep — and on the rare entry with more names
  than will fit, it says how many fields were dropped altogether, so a short
  list is never mistaken for the whole story. Which fields it keeps no longer
  depends on the order they were written in: the small ones are taken first, so
  a single long note can never push the amount, the booking and the payment
  reference off an entry. A long piece of free text is still shortened and still
  says so; a number, an identifier or a date is either recorded in full or
  listed as dropped. Nothing on the screen is a piece of a value pretending to
  be the whole one.

  **Entries recorded before this release are read back the same way, as far as
  that is possible.** The cut already happened and nothing can undo it, so the
  screen rebuilds the fields that were complete before the cut, discards the
  part that was not, and marks the entry as rebuilt. The original stored text is
  still shown beside it, because the rebuilt fields are a convenience and the
  stored text is the club's actual record. Nothing in the database is rewritten.

- **What a member reads is untouched by all of it.** The previous release made
  that an explicit decision recorded on each kind of event, so what a member sees
  no longer depends on the size or the shape of what an officer recorded. This
  change makes more of an entry readable to an authorised officer and nothing
  readable to anybody else — the member's own activity history and the data
  download both still show the sentence the event declared for them, or nothing.
  One member-facing page does read a recorded entry: a member's own booking
  page, showing the reason a payment failed. No code on it changed and it now
  shows *less*, not more — where a long recorded reason used to make the whole
  stored record spill onto the page, it now shows the reason itself.

- **The audit-writer census now reports which entries store structured evidence
  and which store a sentence**, so "how many writers does this rule govern"
  is a figure anyone can reproduce by running the census rather than a hand count
  in a comment. Measured on this change: 104 of them.
