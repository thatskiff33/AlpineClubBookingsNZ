# Changing or cancelling a booking

Audience: Member

## What it is

How to change a booking (dates, guests, or a promo code), how to cancel one, and
how to tell whether you get money back to your card or as **account credit**. You
do all of it from the booking's own page, opened from **My Bookings**
(`/bookings/<id>`). Booking changes follow the
[modification lifecycle](../STATE_MACHINES.md#booking-modification-lifecycle) and
settlements follow the
[refund & credit lifecycle](../STATE_MACHINES.md#refund-and-credit-lifecycle).

This is about cancelling a **lodge booking**. Cancelling your **membership** is a
different journey — see [Cancelling your membership](#cancelling-your-membership)
at the end.

## When you'd use it

- Your plans changed and you need different dates or a different number of
  guests.
- You want to apply a promo code to an existing booking.
- You need to cancel a stay and want to know what you get back.

## Step-by-step

### Change a booking

1. Open the booking from **My Bookings** (`/bookings`) and choose to edit it.
2. Change the **dates**, **guests**, or **promo code** as allowed. Some nights
   are **locked** close to check-in and may need club review before a change
   takes effect. When you can enter a promo code, any codes assigned to you are
   offered as **clickable chips** — the same ones the booking wizard shows —
   and codes that need you to pick which guests they cover walk you through
   that selection here too.
3. If the booking has not been paid yet, an **Account credit** card shows your
   current balance and lets you tick **Apply credit to this booking** (or untick
   it). Your choice is saved with the booking and applied when you confirm and
   pay — nothing is taken from your balance at edit time. See
   [Paying for your stay](paying-for-your-stay.md#use-account-credit).
4. Review the **delta** — the difference in price. If the change costs more, you
   settle the extra (see [Paying for your stay](paying-for-your-stay.md)); if it
   costs less, you may be due a refund or credit.

If your club has **member guests** turned on, the Guests heading carries two
buttons — **+ Add Member Guest** and **+ Add Non-Member Guest** — exactly as it
does when you first make a booking: find
another club member by email address (or by name, if your club has switched that
on) and add them without cancelling and starting again. Before you save, the new
person's row tells you what saving will do — whether they will be emailed and
asked, with their bed held until they answer, or simply told. See
[Booking a stay](booking-a-stay.md) for how the finder works, and
[When somebody adds you to a booking](being-added-to-a-booking.md) for what the
other person sees.

**Two things worth knowing before you change a booking somebody has agreed to.**
Once a member has said yes, they are not asked again: moving the dates, adding
nights, changing lodge or changing who else is coming all carry their agreement
over, and they are not told. And if you take a member guest OFF the booking,
they get one email saying so — that email is not optional and is not something
you can turn off.

A member editing their own booking always triggers the standard change-notice
email, so you have a record of what changed. (Edits that only fix a guest's
name or only change your saved credit choice don't email — nothing about the
stay changed.)

**If a club rule stops your change**, the edit screen offers **Request Booking
Officer approval** instead of just refusing — for the two rules an officer can
waive (a minimum stay, and the requirement that an adult member is present for
non-member guests). You see the exact proposal, say why you are asking, and track
it under **My booking-rule requests** on **My Bookings**, where you can withdraw or
replace it while it is open. A request covers the **dates and the party only**, so
anything else in the same edit — a name correction, a promo code, an account-credit
choice — is not part of it and is named on the screen before you send it; make those
changes separately once the request is decided. Full detail in
[Booking a stay](booking-a-stay.md#asking-to-be-let-past-a-booking-rule).

### When the club has to check the amount

Occasionally a change goes through fine, but the club's records do not say
clearly enough what those particular nights were sold for. Rather than guess at a
number that was never actually charged, the club **saves your change and works
the amount out by hand**.

You will see this on the booking page as **"Your booking change is saved"**. It
tells you the change went through, shows your new dates, and says the club is
checking what the change means for the amount. Nothing has been refunded or
charged for it while that is happening.

**There is nothing for you to do about that change.** Your stay is unaffected,
your beds are held as normal, and somebody from the club will confirm the amount
with you. You will not be shown a figure for it in the meantime — not even a
zero — because until somebody has checked, there genuinely is not one, and a
made-up number is worse than an honest wait. On **My Bookings** the booking's
total is marked *"being checked"* for the same reason: the total you see is real,
but the adjustment on top of it is still being worked out.

**If the booking itself is still unpaid, that is separate and still due.** A
change can give back nights the club cannot price while adding nights that price
normally, so you may still owe something — the page and the email tell you what
that is, and you should pay it as usual. "Nothing to do" applies only to the
amount being checked.

The change-confirmation email says the same thing, and if the change also added
something you owe for it says that too, with the amount, the invoice number and
the payment reference. The two are separate and are shown separately.

In the booking's **Transaction History** you will see the change listed with how
much the booking's own total moved. That figure is real, but it is not a refund
that has been paid — the row says so while the club is still working the
adjustment out.

If you would like to know where it is up to, just contact the club office.

### Resume and edit a draft

A booking you saved as a **draft** can be re-opened from the dashboard's
**Resume** button and edited like any other booking of yours: dates, guests,
promo codes (with your eligible-code chips), and your account-credit choice are
all editable. A draft commits you to nothing — editing one never charges a
change fee, and beds are only claimed when you confirm and pay. If you saved a
credit choice, the booking page reminds you: *"Your $X credit choice is saved
and will be applied when you confirm."*

**A draft the club saved for you** looks slightly different. It is labelled
**"Saved for you by the club"** and its button reads **Review & pay** rather than
**Resume**, because you never started it — someone at the club made the booking
for you and left the payment to you. Open it, check the dates and the party, and
pay; paying is what confirms it. If the booking comes to **$0** there is nothing
for you to pay, so the button just opens it and the club confirms that one for
you. See [Booking a stay](booking-a-stay.md#a-booking-the-club-saved-for-you).

> **Drafts do not wait forever.** An unpaid draft is **removed 72 hours** after
> it is saved — deleted, not cancelled, so there is nothing left to re-open and
> the booking has to be made again. The dashboard card and the booking page both
> show the deadline. Nothing is emailed about a draft, so if the club saved one
> for you, pay it within three days or ask them to confirm it instead.

### Cancel a booking — and check the refund first

1. Open the booking. The Help widget's **Page guide** shows the **booking status
   glossary** and, once a payment has been captured, the **cancellation refund
   schedule** that applies — so you can see the refund consequence **before** you
   start the cancellation.
2. Start the cancellation and confirm. Whether you get money back, and how much,
   depends on how close to check-in you cancel and your club's policy:
   - **Refund to card** or **account credit** for a paid booking, per the
     schedule.
   - If you paid the club **in cash or by a direct bank transfer** (the club
     recorded the payment for you), there is no card to refund and no credit is
     added — **the club will arrange your refund directly**, and the dialog
     shows the amount you can expect back under the schedule.
   - If the booking is **unpaid** but still cancellable, you simply see "no
     payment received / no refund" instead of refund tiers — there is nothing to
     refund.
3. The booking footer reminds you that the booking page is the **live source of
   truth** if a confirmation, payment, or cancellation email goes missing.

### Refund versus account credit

Depending on the club's settings and how the booking was paid, a cancellation
either refunds your **card** or adds **account credit** to your profile (shown in
the **Account Credit** section, `/profile`). Account credit is applied toward
what you owe on a future booking — see
[Paying for your stay](paying-for-your-stay.md#use-account-credit). The exact
tiers (how many days before check-in return what percentage) are a club policy;
your booking's dialog shows the schedule that applies to you, and operators set
it in the [Booking Policies](../guides/booking-policies.md#default-cancellation-policy)
guide.

## What to expect

| Situation | What to expect |
| --- | --- |
| Change costs more | You settle the extra (delta) before the change is complete |
| Change costs less | A refund or account credit for the difference |
| The club cannot tell what those nights were sold for | Your change still saves. The amount is worked out by a person and confirmed with you; nothing is refunded or charged until then, and no figure is shown in the meantime |
| Nights are locked (near check-in) | The change may need club review before it applies |
| Cancel a paid booking | Refund to card or account credit, per the cancellation schedule |
| Cancel a booking paid in cash / by direct bank transfer | The club will arrange your refund directly — no card refund, no account credit |
| Cancel an unpaid booking | No payment was taken, so no refund — the booking is simply cancelled |
| Confirmation/cancellation email missing | The booking page always shows the true current state |

All amounts are shown in dollars. Refund/credit timing and eligibility follow the
[refund & credit lifecycle](../STATE_MACHINES.md#refund-and-credit-lifecycle).

## Cancelling your membership

Cancelling your **membership** (leaving the club) is separate from cancelling a
booking. You start it from the **Membership Cancellation** section of your
[profile](your-account.md) (`/profile`); adult participants confirm their own
inclusion where required, and an admin reviews it.

The money rules are set out in
[`CANCELLATIONS.md`](../CANCELLATIONS.md#refund-policy): **paid** membership
subscriptions are **not refunded** — cancelling stops future obligations but
money already paid stays with the club — while **unpaid or overdue** subscription
invoices are cleared in the club's accounting (a Xero credit note) so they are no
longer due. A family cancellation processes each participant independently. The
full lifecycle is in
[`STATE_MACHINES.md`](../STATE_MACHINES.md#membership-cancellation-archive-and-delete-lifecycle).
If you instead want your data removed entirely, see the privacy and
account-deletion rights in [Managing your account](your-account.md#privacy-and-data).

## Troubleshooting

| Symptom | Why it happens | What to do |
| --- | --- | --- |
| You cannot change the dates | The nights are locked close to check-in | The change may need club review — contact the club office |
| A date change is rejected mentioning a locked period | The booking has an issued invoice in a locked accounting period | Contact an administrator, as the message says |
| You expected a card refund but got account credit (or vice versa) | The outcome depends on how the booking was paid and club settings | Check the **Account Credit** section on your profile; contact the office if it looks wrong |
| Cancelling shows "no refund" | The booking was never paid | Nothing to refund — the booking is simply cancelled |
| Your change saved but no refund or credit appeared, and the page says the club is checking | The club's stored record of what those nights were sold for is not clear enough to work the amount out automatically | Nothing to do about that part — somebody at the club is working it out and will confirm it with you. Contact the office if you would like to know where it is up to |
| The page says the club is checking an amount, but also asks you to pay | The change gave back nights that could not be priced and added nights that priced normally. The amount asked for is the booking's own, and is due | Pay it as you normally would. The amount being checked is separate and is not part of that figure |
| **Transaction History** shows a minus figure for the change but nothing came back | That figure is how much the booking's total moved, not a refund that has been paid | Nothing to do — the row says while the adjustment is still being worked out; the refund or credit follows once the club confirms it |
| **My Bookings** shows a total marked "being checked" | The same thing: the total is real, but an adjustment on top of it is still being decided | Wait for the club to confirm the amount; the total will settle once they have |
| Your membership-cancellation request is stuck | It is waiting on participant confirmations or admin review | Confirm your own inclusion; ask the club office if a link expired |

## Related links

- Back to the [Member & Guest Guide](README.md) and the
  [documentation hub](../README.md).
- Sibling guides: [Booking a stay](booking-a-stay.md),
  [Paying for your stay](paying-for-your-stay.md),
  [The waitlist & offers](waitlist-and-offers.md).
- Reference: the
  [booking modification lifecycle](../STATE_MACHINES.md#booking-modification-lifecycle),
  the [refund & credit lifecycle](../STATE_MACHINES.md#refund-and-credit-lifecycle),
  and the [membership cancellation policy](../CANCELLATIONS.md). Operators use the
  [Booking Policies](../guides/booking-policies.md) and
  [Refunds & Credits](../guides/refund-requests.md) guides.
