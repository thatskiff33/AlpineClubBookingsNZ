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
invoice still owes. If Xero shows a payment whose amount it cannot give exactly,
the cancel is refused until Xero can be read.

If Xero shows the invoice **paid in full** but the app has not caught up, the
email says so; the next Xero sync marks the booking paid. If the invoice
**cannot be read** (Xero disconnected, down, or the invoice missing there), the
hold is kept too and admins get one email. The cron keeps trying and releases the
hold itself once Xero shows the invoice unpaid. If it still cannot be read by
the check-in date or seven days after the hold deadline, whichever comes first,
the hold is released and a second email goes out; the invoice-clearing credit
note is only created once Xero can be read and shows the invoice still owes it.
The email goes to admins with the **payment failure** notification switched on,
and a send that reaches nobody is retried on the next run.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Everything is read-only ("… can view Internet Banking settings but cannot change them") | Your finance role is view-only | Ask a finance-edit admin |
| The page shows **Xero off** / **Module Not Ready** | The Xero integration or Internet Banking module is off | Enable Xero and the Internet Banking module — see [`CONFIGURATION.md`](../../CONFIGURATION.md#module-controls-and-admin-modules) |
| An expired hold was not cancelled and an **Internet banking hold needs attention** email arrived | Xero shows part (or all) of the invoice paid, or the invoice could not be read | Follow the email: wait for the rest, or cancel the booking in the app (the part payment is credited under the policy); reconnect Xero if it could not be read |
| Cancelling says "Xero shows a payment against this booking's invoice, but its amount could not be read exactly" | Xero is unreachable, or one of the booking's invoices could not be read, while a payment is recorded | Reconnect Xero or wait, then cancel again |
| Members aren't offered Internet Banking at checkout | The module is off, or the booking is inside the minimum lead time | Turn the module on and check the **Minimum lead time** value |

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
