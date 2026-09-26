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

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Everything is read-only ("… can view Internet Banking settings but cannot change them") | Your finance role is view-only | Ask a finance-edit admin |
| The page shows **Xero off** / **Module Not Ready** | The Xero integration or Internet Banking module is off | Enable Xero and the Internet Banking module — see [`CONFIGURATION.md`](../../CONFIGURATION.md#module-controls-and-admin-modules) |
| Members aren't offered Internet Banking at checkout | The module is off, or the booking is inside the minimum lead time | Turn the module on and check the **Minimum lead time** value |
| An admin alert says a booking "may have been paid TWICE" | A card payment had already settled the booking, and Xero then reported its Internet Banking invoice paid too (#3638). The bank payment is recorded; nothing was refunded | Check the invoice's payment in Xero: if it is separate money from the member, agree with them which payment to refund; if it is the card money matched to the invoice by hand, correct the match in Xero |

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
