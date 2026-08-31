- **Money the club is owed after a booking change is now always billed, even
  when the invoice for that change has already gone out (#3193).** When a change
  cannot be priced automatically, the office prices it by hand, and one change
  can raise two of those pricing jobs. If both were settled while the invoice was
  still waiting to go, the invoice was simply raised to cover both and the member
  was asked once — that is unchanged and is still what normally happens.

  What went wrong was the narrow case where the second job was settled *after*
  the invoice had already been sent. The invoice is never altered once it is with
  a member, so the extra amount was billed nowhere. It was written into the
  booking's history, but nothing asked the member for it and nothing chased it:
  somebody had to notice and collect it outside the system.

  The club now raises a second, small invoice for that extra amount instead. The
  first invoice is untouched and still stands, and the second one covers only the
  difference — never the whole change again. It says on the invoice why a second
  one has arrived, so the member is not left guessing.

- **A member will only ever see two invoices for one change in that one
  situation.** While the first invoice is still waiting to go out, everything
  still ends up on it and the member is asked once. Two invoices happen only
  where the alternative was being billed too little and then approached later for
  the rest.

- **The office gets a plain record either way.** The booking's history now says
  when a second invoice was raised and for how much, so whoever answers the
  member's "why have I got two of these?" has the answer in front of them. On the
  rare occasion the second invoice cannot be raised — the club's accounting
  connection being down at that moment — the history says that instead, and says
  exactly what to do: raise one by hand for the difference only. In the one case
  where the difference cannot be worked out from the booking alone, it says so
  and points at the Xero repair check rather than inviting a guess, because
  raising an invoice for the full amount there would bill the member twice.

- Running the same settlement twice, or two of them at once, still produces one
  invoice per amount owed and never a duplicate.
