- **Closing a booking's financial review now works the booking's own price out
  again (#3219).** When a change to a booking cannot be priced automatically, the
  change goes through and the money is parked as a job for a person. While it is
  parked the booking's headline price is deliberately frozen, because nobody yet
  knows what the change was worth — and nothing unfroze it. Closing the job moved
  the guest figures and left the booking's own price where it was, so from then
  on the price at the top of the booking and the figures on its nights disagreed,
  permanently, and nothing in the system compared them.

  Closing the job — with **Record the adjustment** or with **No adjustment** —
  now works the price out again from the booking's guests. It is worked out from
  the guests rather than from the amount you settled, so it can move by more or
  less than you just settled; after a change that also took a guest off the
  booking, it moves by that guest's whole stay. Any promotion on the booking is
  worked out again at the same time, against the new total, so a discount can no
  longer end up larger than the stay it is discounting — which could previously
  have left a booking storing a price below zero.

- **A review that shows you price boxes can no longer be closed with them blank
  (#3219, #3257).** The boxes are what the new price is worked out from, so
  closing without them left the booking's headline stale — and after a guest was
  taken off, still counting a guest who is gone. You are now asked to fill them
  in before the job can be closed either way, in the same words the screen
  already warned you with. Rows that show no boxes are untouched and close
  exactly as they always did.

- **The recalculated price is the booking's price for everything afterwards
  (#3219).** That includes what a later cancellation refunds, so a member whose
  booking was reduced by a change you closed with **No adjustment** can get back
  less than they paid. It is deliberate — the booking really is worth less — and
  it is now visible: the booking's own history records **Price Recalculated**
  with the figures before and after, so anybody asking why can be shown.

- **Closing with No adjustment sends nothing to Xero, so the club's invoice can
  be left saying the old figure (#3219).** Where that happens the booking's
  history says so in as many words, and the audit entry for that closure is
  raised to critical, so check the invoice before recording a bank payment
  against the new price.

- **Figures for months already reported can move (#3219).** Recalculating changes
  what the club counts as income for the nights involved and what a member's
  lifetime spend comes to, so a figure already reported for an earlier month may
  stop coming out the same. The new numbers are the truer ones, and every figure
  from before is kept in the audit entry.

- **Closing any review works the price out again, not only one you typed figures
  into (#3219, #3257).** Two situations after a guest is taken off a booking show
  no price boxes at all — the job names the guest who left, or names a guest whose
  nights carry no prices to correct — and those used to work nothing out, so the
  booking went on counting a guest who was gone with no job left to correct it.
  Closing the job now works the price out whatever kind of job it was.

- **Where a guest's nights still cannot be read at all, nothing is recalculated
  (#3219, #3257).** The booking's price is left exactly where the freeze put it
  rather than worked out from evidence the club does not have — a total built
  from guests the club has just said it cannot value would look freshly
  calculated and be wrong, which is worse than a figure that is merely stale. The
  closure's audit entry says the price was not worked out, and why. Recording
  those nights from the booking afterwards makes the guest's stay readable again
  but does not by itself move the booking's price — that happens the next time
  the whole booking is priced again, on another review closing or a later change
  to the booking.

- **A closure that lands on the price already stored records nothing (#3257).**
  Most reviews close on a booking whose price never drifted, so working it out
  again gives the same figures; the booking's history gets a **Price
  Recalculated** entry only when something actually changed. A promotion that
  stops applying and is taken off counts as a change even when every figure comes
  out the same, so the entry saying the promotion was removed is never lost. The
  audit entry records the closure either way.

- **A review naming a guest who is not on the booking is refused (#3219).**
  Nothing previously checked that, so a mismatched record could have recalculated
  one booking's price from a different booking's guests — and a booking that came
  back with no guests at all could have had its price zeroed.
