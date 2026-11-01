- **A card refund that fails after its refund was closed "Paid another way" is no longer sent again automatically (#4210).**
  When a card refund's answer from Stripe was lost, the treasurer closed it as
  paid another way and paid the member by bank transfer, and Stripe then
  reported that lost refund as failed, the app raised a new card refund for it
  and sent it again on its own, so the member could be paid twice. That refund
  is now held for an officer instead: it is listed under **Card refunds Stripe
  gave up on** on the Stuck states page, it is never sent again automatically,
  and the officers are emailed once telling them to check the bank transfer the
  close recorded and to settle anything still owed with "Paid another way",
  never with a new refund in the Stripe dashboard (owner's decision of
  25 October, #4361).

  A failed refund whose card refund was not closed this way is asked for again
  automatically, as before; so is one on a payment where a different card
  refund was closed. One case is still open (#4492): a refund whose card refund
  had stalled but not yet been closed, failing before the close, is still sent
  again automatically, and the close still goes through.

  Known limits. After a part close, the amount shown for the held refund can
  include what that close recorded as no longer owed: check the close's record
  before paying. After a close that paid the member back in full, nothing is
  left owed on the payment, so the held refund is not offered for a close; it
  stays in the exhausted recovery operations count, and the health check's
  payment recovery result stays red because of it, until the later stage of
  #4361 settles these automatically. Ask a developer to reconcile it.
