- **A refund of a superseded card payment stops for an officer rather than
  risk paying the member twice (#4858).** When a member is refunded a card
  payment the app no longer needed, and a booking change's card refund has
  since gone through first time on part of the same card charge, the app used
  to send only the rest. If that other refund later failed, the app could owe
  it twice: once as that refund again and once more on this one. It now sends
  nothing, stops retrying and lists the refund under **Card refunds Stripe gave
  up on** in Stuck States, with the officers' email naming the other refund.
  Check the booking and the Stripe refunds, then settle anything still owed
  with **Paid another way** - unless the refund it names has since failed and
  shows as a refund of its own that Stripe failed later. Then do not close it
  that way: the two may be the same money, so ask a developer (#4492).
