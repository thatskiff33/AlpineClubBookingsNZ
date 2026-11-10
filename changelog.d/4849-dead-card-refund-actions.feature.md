- **Card refunds Stripe gave up on can be tried on the card again, or closed when nothing is left owed (#4368).**
  On **Stuck States**, each card refund under **Card refunds Stripe gave up
  on** now offers **Try the card again** beside **Paid another way**. After a
  confirm dialog the app puts the refund back to its automatic retries; before
  anything is sent it reads the refunds Stripe already holds on the charge, so
  one it can match is counted rather than sent again, and one made in the
  Stripe dashboard stops it again for you to check. Where the app cannot show
  that asking again would not pay the member twice - a refund Stripe failed
  later is on the same payment, the last failure suggests Stripe may have
  refunded after all, or Stripe holds an older refund of this one's it cannot
  match - the row says why, or the request is refused with the reason, and
  **Paid another way** remains.

  A refund that Stripe refunds matched to it have paid in full now stays on the
  list, reads "nothing left owed" and offers **Nothing left owed**: its dialog
  names those Stripe refunds, and closing it moves no money, sends nothing to
  Stripe and changes nothing in Xero. Before, such a refund dropped off the list and
  needed a developer.

  The guidance on the page, in the Stuck States guide and in the officers'
  emails about refunds Stripe failed later now says to settle a refund Stripe
  gave up on here - never with a new refund in the Stripe dashboard, which on
  a booking paid by bank transfer is credited in Xero twice. The old advice to
  refund in the dashboard and wait for it to show is gone. Both new buttons
  need **Finance edit**, and are view-only without it, as **Paid another way**
  is. Both are recorded in the audit log under **Payment**, read with Support view
  and Finance view (two more audit write sites, 536 to 538).
