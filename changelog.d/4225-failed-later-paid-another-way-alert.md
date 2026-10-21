- **A card refund the treasurer already paid back another way is no longer sent
  again when Stripe fails it later (#4210).** When the app asked Stripe for a
  card refund and Stripe's answer was lost, the treasurer could close the refund
  as "Paid another way" and pay the member by bank transfer. If the refund then
  reached the app (listed under "Card refunds paid back twice") and Stripe later
  reported it failed, the app raised a new card refund for it and sent it
  automatically, paying the member a second time.

  A "Paid another way" close now keeps a record of which refunds it counted as
  made and which parts it paid back. A failed refund is treated as settled by
  the close only when it was the closed refund's own, the close did not count
  it, and it matches a part the close paid back exactly: nothing is raised or
  sent, and it leaves the paid-back-twice list. If the close paid back only part
  of what was owed, up to the part it gave up is listed under "Card refunds
  Stripe gave up on" for a treasurer to check, and several failed refunds of one
  close never list more than it gave up. The whole refund is listed instead
  where the paid-twice row had been marked resolved (the member may have
  returned the extra), or where the close was recorded before this release and
  the app cannot tell whether it paid the refund back. These rows are marked
  "Check before paying", count in Refunds owed and Net Collected, and are never
  sent automatically. Close one as "Paid another way" if the member is owed it,
  or with the new "Checked - not owed", which records your note in the audit log
  under Payment and moves no money. The member's booking page says the club will
  be in touch about such an amount.

  The officers get their own email, "Card refund failed after it was paid back
  another way", which cannot be switched off, and the audit log records it
  under Payment. A failed refund that another part of the app made, a refund of
  another amount carrying the same details (a second booking change's), or one
  the close counted as made, is still asked for again automatically, as before.
  Where two booking changes for the same reason sent refunds of the same
  amount, so the app cannot tell which change a failed refund belonged to, it
  is listed as "Check before paying" rather than paid again or closed. Marking a
  paid-twice row resolved now waits for any refund being recorded on the same
  payment, so the two are always weighed in one order, and remembers which
  card refunds it covered.

  **Operator step for this release.** While the old and new versions both
  serve during the switch, the old version can still raise a card refund that
  fails after a "Paid another way" close and send it again. The new version
  checks such a refund before it sends it, but the old one does not. After the
  switch, open Stuck States and check every card refund raised while both
  versions served whose card refund had been closed "Paid another way".
