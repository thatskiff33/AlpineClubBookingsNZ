# Internet Banking

Audience: Operator

## What it is

The settings for **Xero-invoiced Internet Banking payments** (bank transfers):
whether beds are held while a payment is pending, how long that hold lasts, and
the minimum lead time required before check-in. Find it at **Admin → Finance →
Internet Banking** (`/admin/internet-banking`); the page's back-link goes to
**Finance Setup** (`/admin/xero/setup`).

Internet Banking is a **finance** permission area: finance view to read, finance
**edit** to save. It depends on the Xero integration and the Internet Banking
payments module — the page shows whether each is on.

## When you'd use it

- You want to offer (or stop offering) Internet Banking as a booking payment
  method backed by a Xero invoice.
- You need to change how long a bed is held while waiting for a bank transfer to
  reconcile, or the minimum notice before check-in for an Internet Banking booking.

## Step-by-step

### Configure holds and lead time

1. Go to **Admin → Finance → Internet Banking**. The badges show whether the
   module is ready, Xero is on, and Internet Banking is on.

   > This page only exists when the **Xero integration** and **Internet Banking
   > payments** modules are both enabled (`src/config/feature-routes.ts`);
   > otherwise the route returns *Not Found*. The demo seed leaves Xero off, so no
   > screenshot is captured here.

2. Tick **Hold beds while Internet Banking payment is pending** to confirm bookings
   immediately and release them if Xero has not reconciled payment before the hold
   expires.
3. Set the **Hold duration** (1–30 days) and the **Minimum lead time before
   check-in** (0–365 days), then click **Save Settings**.

## Settings reference

| Setting | What it controls | Default | Notes / constraints |
| --- | --- | --- | --- |
| Hold beds while Internet Banking payment is pending | Whether a bed is held pending reconciliation | from server | When on, bookings confirm immediately and release if unpaid at hold expiry |
| Hold duration | How long a pending-payment hold lasts | from server | Integer 1–30 days |
| Minimum lead time before check-in | Minimum notice for an Internet Banking booking | from server | Integer 0–365 days |

When a held booking's hold expires unpaid, the payment cron cancels the booking,
fails the pending payment, queues an invoice-clearing credit note, and emails the
member — see the operational-Xero behaviour in
[`ARCHITECTURE.md`](../ARCHITECTURE.md#operational-xero).

**A hold that has started being paid is kept, not cancelled** (#3643). Before it
releases a hold, the cron reads the booking's invoices from Xero. If Xero shows
any payment against them — say $150 of a $300 invoice — the booking stays
confirmed, its beds stay held, and admins get one **Internet banking hold needs
attention** email with the booking reference, the invoice link, and what has
been paid and what is still owing. Nothing is refunded or credited. Either wait
for the member to pay the rest (the booking is marked paid once Xero shows the
invoice fully paid), or cancel the booking in the app. The cancellation records
the part payment as money received, applies the club's cancellation policy to
it and returns the refundable share as account credit, and clears only what the
invoice still owes with a credit note reading "Unpaid balance cleared - booking
cancelled". The cancel dialog checks Xero the same way before you confirm, so
the credit it shows is the credit the cancellation gives. If the booking belongs
to an organisation, or Xero cannot give the amount paid exactly, the app cannot
credit the payment: the email says so, an officer's cancel treats the booking as
unpaid (no refund, no credit, invoice left open) and the treasurer is emailed to
settle the payment by hand in Xero, and a member cancelling online is asked to
contact the club. That cancel also puts one item with no amount in **Money to
settle** on the admin payments page. Once you have settled the payment in Xero
and cleared what the invoice still owes, close the item with a note saying what
you did; the Xero repair tool then stops listing the booking for review.

If Xero shows the invoice **paid in full** but the app has not caught up, the
email says so; the next Xero sync marks the booking paid. If the invoice
**cannot be read** (Xero disconnected, down, or the invoice missing there), the
hold is kept too and admins get one email. The cron keeps trying and releases the
hold itself once Xero shows the invoice unpaid. If it still cannot be read seven
days after the hold deadline, the hold is released and a second email goes out;
the invoice-clearing credit note is only created once Xero can be read and shows
the invoice still owes it. If the check-in date arrives first, the stay has
started, so the hold is not cancelled at all: it is left for you to reconcile by
hand, with one email saying so. The cron does not read Xero for a stay that has
started, whatever the invoice shows.

**Groups work the same way.** When an organiser pays for a group with one
combined Internet Banking invoice and the settlement runs out of time while Xero
cannot show that invoice, the group keeps its beds for up to seven days past the
deadline, then is released. If the group's check-in date arrives first, it is
kept, not released, and the treasurer gets one email: the organiser may already
have paid by bank transfer (#3635).

The email goes to admins with the **payment failure** notification switched on.
A send that fails is retried on the next run; one that reaches nobody (every
address suppressed, for example) is tried again a day later, not every run.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Everything is read-only ("… can view Internet Banking settings but cannot change them") | Your finance role is view-only | Ask a finance-edit admin |
| The page shows **Xero off** / **Module Not Ready** | The Xero integration or Internet Banking module is off | Enable Xero and the Internet Banking module — see [`CONFIGURATION.md`](../../CONFIGURATION.md#module-controls-and-admin-modules) |
| An expired hold was not cancelled and an **Internet banking hold needs attention** email arrived | Xero shows part (or all) of the invoice paid, or the invoice could not be read | Follow the email: wait for the rest, or cancel the booking in the app (the part payment is credited under the policy); reconnect Xero if it could not be read |
| A member is told a payment "the club needs to settle by hand" stops them cancelling online | The booking has a payment recorded that the app cannot credit (an organisation's booking, or Xero could not give the amount exactly) | An officer cancels it; the treasurer is emailed to settle the payment in Xero |
| Cancelling says the booking's payment changed while it was being cancelled | A further payment reached Xero after the cancel checked it | Cancel again; it re-reads Xero |
| Members aren't offered Internet Banking at checkout | The module is off, or the booking is inside the minimum lead time | Turn the module on and check the **Minimum lead time** value |
| An admin alert says "Booking may have been paid twice — card and Xero" | A card payment had already settled the booking, and Xero then reported its Internet Banking invoice paid too (#3638). The bank payment is recorded; nothing was refunded | Check the invoice's payment in Xero: if it is separate money from the member, agree with them which payment to refund; if it is the card money matched to the invoice by hand, correct the match in Xero |
| The same alert says the booking was "paid by card and later cancelled" | The booking was paid by card and cancelled, and a bank transfer then arrived against its Internet Banking invoice (#3638). The cancellation already settled the card payment; the bank payment is recorded and was not credited | Check the payment in Xero; if it is the member's money, return it or add it to their account credit |

## Related links

- Back to the [documentation hub](../README.md).
- Feature hub: [Finance dashboard](../finance-dashboard/README.md), and the
  [Xero subsystem](../xero/ARCHITECTURE.md).
- Sibling guides: [Payments](payments.md), [Xero Sync](xero.md),
  [Booking Messages](booking-messages.md).
- Reference: [operational Xero](../ARCHITECTURE.md#operational-xero) and the
  [payment and settlement](../invariants/payment-and-settlement.md) and
  [booking dates and capacity](../invariants/booking-dates-and-capacity.md)
  invariants.
