- **Card refunds Stripe gave up on can be tried on the card again, or closed when nothing is left owed (#4368).**
  On **Stuck States**, each card refund under **Card refunds Stripe gave up
  on** now offers **Try the card again** beside **Paid another way**. After a
  confirm dialog the app puts the refund back to its automatic retries; before
  anything is sent it reads the refunds Stripe already holds on the charge, so
  a refund Stripe already made is counted and one made in the Stripe dashboard
  stops it again for you to check. Where trying the card could pay the member
  more than they are owed - for example while a refund Stripe failed later is
  still open on the same payment - the row says why and offers only **Paid
  another way**.

  A refund a later Stripe refund has covered now stays on the list, reads
  "nothing left owed" and offers **Nothing left owed**: its dialog names that
  Stripe refund, and closing it moves no money, sends nothing to Stripe and
  changes nothing in Xero. Before, such a refund dropped off the list and
  needed a developer.

  The guidance on the page, in the Stuck States guide and in the officers'
  emails about refunds Stripe failed later now says to settle a refund Stripe
  gave up on here - never with a new refund in the Stripe dashboard, which on
  a booking paid by bank transfer is credited in Xero twice. The old advice to
  refund in the dashboard and wait for it to show is gone. Both new buttons
  need **Finance edit**, and are view-only without it, as **Paid another way**
  is. Both are recorded in the audit log under **Payment**, read with Support view
  and Finance view (two more audit write sites, 536 to 538).
