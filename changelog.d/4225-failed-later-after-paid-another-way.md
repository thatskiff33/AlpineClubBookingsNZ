- **A card refund the treasurer already paid back another way is no longer sent
  again when Stripe fails it later (#4210).** When the app asked Stripe for a
  card refund and Stripe's answer was lost, the treasurer could close the refund
  as "Paid another way" and pay the member by bank transfer. If the refund then
  reached the app (listed under "Card refunds paid back twice") and Stripe later
  reported it failed, the app raised a new card refund for it and sent it
  automatically, paying the member a second time.

  Such a failed refund is now treated as settled by the close, but only when
  the refund was the closed row's own and the close never counted it: nothing
  is raised or sent, and it leaves the paid-back-twice list. If the close paid
  back only part of what was owed, up to the part it gave up is listed under
  "Card refunds Stripe gave up on" for a treasurer to check; if the paid-twice
  row had been marked resolved (the member may have returned the extra), the
  whole refund is listed there. These are never sent automatically. The
  officers get their own email for it, "Card refund failed after it was paid
  back another way", which cannot be switched off, and the audit log records it
  under Payment. A failed refund that another part of the app made, or that the
  close counted as made, is still asked for again automatically, as before.
