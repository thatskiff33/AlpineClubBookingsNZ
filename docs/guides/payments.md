# Payments

Audience: Operator

## What it is

A filterable, sortable ledger of every booking payment — Stripe card payments
and Internet Banking bank transfers — showing the amount, status, Stripe link,
Xero invoice state, and any cancellation-settlement breakdown, with an inline
action to generate a missing Xero invoice. Find it at **Admin → Finance →
Payments** (`/admin/payments`).

Payments is a **finance** permission area: you need finance view access to open
it, and finance **edit** access to generate invoices. Amounts are stored as
integer cents and shown as dollars.

## When you'd use it

- A member asks whether their payment went through, or for a receipt/invoice.
- You are reconciling Stripe or Internet Banking payments against bookings.
- A payment is refunded or credited and you want to see the settlement
  breakdown.
- A successful payment has no Xero invoice yet and you want to generate one.

## Step-by-step

### Open and read the ledger

1. Go to **Admin → Finance → Payments**. The stat cards summarise the current
   filter (Total Revenue, Refunded / Credited, Payments count, Success Rate),
   and the table lists each payment.

   ![Payments page: the filter bar, summary stat cards (Total Revenue, Refunded/Credited, Payments, Success Rate), and the payments table with status and Xero columns](../images/admin/admin-payments.png)

2. Each row shows the last-updated date, check-in, member, a **View** link to
   the booking, the amount, the status chip (with a Stripe or Internet Banking
   sub-chip), the Stripe payment link, and the Xero invoice state.

### Find a payment

1. Type a name, email, or payment reference into **Member or reference**.
2. Narrow with **Status**, **Source** (Stripe / Internet Banking), **Xero**
   state, **Settlement** kind, and the **Updated** date range. Open **More
   filters** for exact/min/max amount and a check-in date range. Click **Reset**
   to restore all filters, sort, and page. The default **Updated** range is the
   rolling NZ date three months before today through today, not all history.

### Generate a missing Xero invoice

1. Find a **Paid** (succeeded) Stripe payment whose Xero column shows **Invoice
   missing**.
2. Click **Generate Invoice**. The chip changes to **Queued** while Xero
   processes it. This action needs finance edit access; a view-only finance role
   sees it disabled.

### Record a payment made in cash or by an off-Xero bank transfer

Some money never reaches the app: a member pays cash at the lodge, or makes a
bank transfer for a club that does not use Xero invoicing.

1. Open the booking (Admin → Bookings → the booking, or **View** from this
   page) and find **Cash / off-Xero payment** in the **Admin tools** card.
2. Click **Record manual payment**. The dialog shows the exact amount owing
   (after any account credit already applied), takes an optional note for the
   club's records, and asks whether the member should be emailed the usual
   booking confirmation. The payment is recorded either way, and your choice is
   written to the audit log. If the booking's **No emails** switch is on, the
   dialog says so instead of offering the choice.
3. The booking becomes **Paid** and its beds are claimed, exactly as a card
   payment would. Nothing is sent to Xero: no invoice is created, and none is
   emailed.

**When the booking still has an extra owing from a later change.** If the
booking was priced up after it was first made — someone added a guest, say — the
increase is recorded separately as an "additional payment" that the member is
normally asked to pay by card. If that extra has never been collected, the
dialog says so before you record anything. It shows the booking amount before
the change, the extra, and what the booking owes in total — the extra is *part
of* that total, not on top of it — and asks one question: **does the money you
have received cover that addition as well?** You must answer before the
recording buttons work; neither answer is a default, because guessing either way
is a guess about money. The dialog deliberately does not name a total until you
have answered, because your answer changes it:

- **Yes** records the full amount owing, including the addition, and marks the
  addition settled. Nothing will chase the member for it again: the "$X due"
  chip disappears from the bookings list, the reminder emails stop, and the
  booking's history gains an entry saying the payment you recorded also covered
  the extra.
- **No** records **only the amount owed before the change**. The booking is
  still marked paid, but the club's books say it received that smaller amount
  and is still owed the addition — so the two figures add up, and the member is
  rightly still asked for the rest. If the whole amount owing *is* the addition,
  there is nothing left to record and the action is refused.

**How the member pays an addition you said the cash did not cover.** Recording a
cash payment normally cancels any card payment the member still had open for the
booking, so they cannot accidentally pay twice for money you already hold. The
one exception is the card payment for the addition itself: if you answer **No**,
that one is deliberately left open, because the club is still asking for it and
that is the member's own way to send it. They can pay it from their booking page
exactly as they could before, and once they do, the booking's books balance on
their own — nothing further for you to record.

Some additions have no card payment set up (an older booking, or one where the
card step never got as far as being created). The confirmation on screen tells
you which situation you are in: either "they can pay it themselves from their
booking page", or "someone will need to contact them to collect it". If it is
the second, contact them — there is no other door. If you would rather undo the
whole thing and start again, **Reverse manual payment** puts the booking and the
addition back exactly as they were.

Either way the confirmation on screen repeats which it was and names the figure
that was recorded. The member's confirmation email says the same thing: instead
of "Total Paid" it shows the booking total, what has been paid, and what is
still owing, and it tells them how to pay the rest. If the extra changes while
your screen is open, or one appears that was not on your screen when you opened
the dialog, the recording is refused rather than guessed and you are asked to
refresh.

**If the extra is bigger than the whole amount owing.** This can happen when a
change fee was charged: the fee is added to the recorded addition but not to the
booking's price, so the addition is no longer a slice of what the booking owes.
Neither answer can be recorded honestly, so the action is refused. Ask the member
to pay the addition from their booking page, or correct the booking's price, and
then record the payment.

**If the booking's payment has already taken money.** A booking whose card
payment succeeded but whose status never caught up cannot also be recorded as a
cash payment — the card money is already in the ledger and recording cash over
the top of it would misstate the books. The button is not offered, and the
reason says so. Check the payment (and whether a refund is owed) before
recording anything.

**When the member had asked to use their account credit.** If they ticked "use
my credit" and saved the booking as a draft, and that credit was never applied,
the dialog warns you before you record anything: it names the amount they asked
to put towards the stay and says plainly that taking cash cannot use it. That is
not a reason to refuse the money — if they have handed you the full amount, take
it. Recording the cash clears the saved choice rather than spending their
credit, because the money you collected settled the booking in full, so their
credit balance is untouched.

Afterwards, the confirmation you see on screen repeats the amount and confirms
the credit is still on their account, the booking's history tells the member the
same thing, and the admins are alerted. That alert quotes their **live** credit
balance, not the amount they elected — the two often differ, because the choice
may have been made months and several bookings ago — and it states the most that
could sensibly be refunded against this booking, which is never more than the
account actually holds. If the balance has been spent since, it says there is
nothing to refund.

Reversing the payment (below) puts the saved choice back on the booking, so the
member can use their credit when they pay it properly. Your screen confirms that
too.

Needs finance **edit** access. It is refused — with the reason shown — when the
booking already has a Xero invoice (or one queued), when it was settled as part
of a group booking, when there is nothing owing, when the booking no longer fits
the lodge, or when the amount changed while your screen was open. Recording it
against the Xero invoice in Xero is the right move in the first case.

**Reversing it.** If you recorded it against the wrong booking, use **Reverse
manual payment** on the same card. The booking goes back to unpaid — it is *not*
cancelled — and the member is not emailed. Any account-credit choice the
original recording cleared is put back on the booking, so the member can spend
that credit when the booking is paid for real. An extra you confirmed the cash
covered goes back to owing as well, so the booking is not left unpaid while its
later addition still reads as collected. What is un-recorded is exactly what was
recorded — so if you recorded only the amount owed before a change, only that
amount is undone. A booking restored to
awaiting-payment stops holding its beds, so other bookings can take them, and
recording the payment again later can be refused if the lodge has filled in the
meantime. This is only possible while nothing has happened since that a
reversal could not undo: no refund, no card payment, no open refund task, and
no Xero invoice.

### Pay back a refund for a cash booking

When a booking that was paid in cash is cancelled, there is no card charge to
reverse, so the system raises a task instead of pretending money moved. It
appears at the top of this page as **Refunds to pay back by hand**, and the
member is told the club will arrange their refund.

1. Pay the member back however the club normally does.
2. Click **Mark paid back** on the task. Only do this once the money has
   actually gone — that click is what records the refund in the payment ledger
   and on the booking's history.
3. If the member declined the refund, or it was settled another way, click
   **Dismiss** and say which. A note is required.

### A refund that happened without you — "Refunded automatically"

Sometimes a member pays at the same moment the booking is being cancelled — or
deleted. That happens both for a booking's own payment and for a payment for a
change to it. The payment goes through against a booking that is on its way out, and
Stripe hands the money straight back to the member on its own. Nobody decided that,
and there is nothing for you to pay back.

Those refunds appear on this page in a second card, **Refunded automatically —
nothing to pay back**, above the filters. It lists the member, the amount, the day
the money went back and the stay, and it covers the last 30 days.

**The card is split into two groups, and the top one is the one to read.**

- **The booking was deleted.** Worth a look. If deleting the booking was the mistake
  rather than the payment, the refund has already gone out — so the booking has to be
  made again and the member charged again. That is the only work these rows can
  create, and it is not on this page.
- **The booking was cancelled and is still on file.** Normally nothing to do. This is
  what you would expect when a booking is cancelled while the member is part-way
  through paying for it, or for a change to it. The same applies if the cancellation
  itself was the mistake: the money has gone back, so the booking has to be remade
  and charged again.

1. **There are no buttons, and that is on purpose.** The money has already gone
   back to the member. Marking it as paid back would record the same refund twice.
2. **The card is the list, with one exception.** It shows every automatic refund of
   this kind from the last 30 days — an empty card means none happened in that
   window, not "none recorded". The exception: if somebody had already closed the
   hand-back task for that payment **by hand** before Stripe's refund arrived, their
   own record of it is in the booking's history and the refund is not repeated here,
   because one payment never gets two refund tasks. Older ones live in the booking's
   audit log; a Full Admin can look for a
   `booking.payment.refunded_after_cancellation` entry. **Both kinds of payment are
   listed** — a booking's own payment and a payment for a change to it. Until
   recently only the second kind appeared, and each row's reason line says which it
   was.
3. **You are also emailed at the time.** The subject says what happened — *Payment
   refunded automatically — booking already deleted*, or *… already cancelled* — and
   it cannot be switched off in [Notification Recipients](notification-recipients.md)
   or [Delivery Rules](notification-rules.md), because money moved without anybody
   deciding it. It goes to everyone whose role can edit Finance.
4. **If it says it could not be loaded, reload.** A line in place of the card means
   the page could not read the record — not that there is nothing to see. The
   hand-back queue above it is unaffected.

### When you have already paid a late capture back yourself

If you click **Mark paid back** on the hand-back task for a late capture and
Stripe's automatic refund for that same payment arrives afterwards, the system does
**not** send the money a second time. Marking a task paid back is what records the
refund in the ledger, so refunding at Stripe on top of it would pay the member twice.

**In practice this only comes up for a payment for a *change* to a booking.** That
is the only late capture a task is ever raised for and therefore the only one you
can mark paid back; a booking's own late payment is recorded automatically and
arrives with no buttons. The check itself runs on both kinds, so nothing depends on
that staying true.

Instead you are emailed *Automatic refund withheld — already paid back by hand*, and
the booking's audit log carries a
`booking.payment.late_capture_refund_withheld` entry. **Check that the hand-back
really happened and covers the whole amount** — if it did not, the money is still
sitting at Stripe and has to be refunded from there. Nothing appears on the
"Refunded automatically" card for these, because no automatic refund was made; your
own closed task is the record.

There is one timing you cannot be protected from. If you mark the task paid back at
the exact moment Stripe's refund is going out, the check cannot see your work yet
and the refund goes as well. You are emailed *Payment may have been refunded TWICE
— reconcile* and the audit log carries
`booking.payment.late_capture_double_refund_suspected`. **Assume the member has been
paid twice until you have checked**: compare the refund on the Stripe payment
against the hand-back you recorded, and recover the difference if there is one.
Neither email can be switched off.

There is no **View booking** link on these rows. A deleted booking's page opens only
for a Full Admin, and a cancelled booking's page needs Bookings access that a
Finance Viewer does not have, so the booking's identifier is printed as text for you
to quote instead of a link that would not work for you.

### Follow a payment into Stripe or Xero

1. Click the Stripe id to open the payment in the Stripe dashboard, or the Xero
   invoice link to open the invoice in Xero. **View activity** opens the record
   activity log for the payment.

## Settings reference

Payments is a read-only ledger (aside from Generate Invoice). Its controls:

| Control | What it does | Default | Notes / constraints |
| --- | --- | --- | --- |
| Member or reference | Free-text search on member or reference | empty | — |
| Status | Filter by payment status | All | Pending, Processing, Succeeded, Failed, Refunded/Credited, Partially Refunded/Credited |
| Source | Filter by payment method | All sources | Stripe or Internet Banking |
| Xero | Filter by Xero invoice/activity state | All Xero states | Invoice linked/missing, failed/partial/pending activity |
| Settlement | Filter by cancellation-settlement kind | All settlements | None, Card refund, Account credit, Mixed, Restored credit |
| Updated range | Filter by last-updated date | last 3 months | NZ date-only, club time zone |
| Amount exact / min / max | Filter by amount | empty | Entered in dollars |
| Check-in range | Filter by booking check-in | empty | NZ date-only |
| Reset | Restore filters, sort, and page | rolling three-month Updated range through today | Disabled while the ledger is already at its defaults |
| Generate Invoice | Create a Xero invoice for a succeeded payment | — | Needs finance **edit**; only for succeeded, non-Internet-Banking payments with no invoice. Never offered for a manually recorded cash payment — no invoice is expected for one |
| Record / Reverse manual payment | Record a cash or off-Xero bank-transfer settlement on a booking, or undo one | — | On the booking page, not here. Needs finance **edit**. Never contacts Xero |
| Mark paid back / Dismiss | Close a hand-back task for a cancelled cash booking | — | Needs finance **edit**. "Mark paid back" writes the refund into the ledger; "Dismiss" needs a note |
| Refunded automatically — nothing to pay back | Read-only record of a payment Stripe returned by itself, because the booking had already been cancelled — the booking's own payment or one for a change to it | last 30 days | No controls at all: the money has already gone back. Every such refund of the last 30 days is listed, grouped into bookings that were deleted (worth a look) and bookings still on file (normally nothing to do); the audit log holds anything older. A capture you had already paid back by hand is not refunded again and is not listed here — you are emailed instead |

Page size is fixed at 25. **Total Revenue** and **Refunded / Credited** reflect
the whole filtered set; **Success Rate** is computed from the visible page.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| "No payments found" | Filters are too narrow, or the date range excludes the payment | Click **Reset** and widen the **Updated** range |
| **Generate Invoice** is disabled | Your finance role is view-only, or the payment is not an eligible succeeded card payment | Ask a finance-edit admin; Internet Banking payments generate invoices differently |
| Xero shows **Failed activity** or **Pending activity** | A Xero sync attempt failed or is still running | Open **View activity**, then retry from the finance/Xero tools |
| A refund isn't reflected | The settlement is still processing, or you filtered it out | Check the **Settlement** filter and the row's settlement breakdown |
| Amounts look off by 100× | Amounts are stored as cents and shown as dollars | Enter amount filters in dollars (for example `90.00`) |
| **Record manual payment** says there is a Xero invoice | The booking already has an invoice in Xero, or one is queued | Record the payment against that invoice in Xero instead — recording it here would leave the two systems permanently disagreeing |
| An admin alert says a cash settlement and a Xero payment disagree | The member (or their employer) later paid the Xero invoice for a booking already recorded as paid in cash | Check whether the two are genuinely separate money. Reverse the manual record, or refund the duplicate — the system deliberately changed nothing |
| **Reverse manual payment** is not offered | A refund, a card payment, an open hand-back task or a Xero invoice has appeared since | Cancel the booking instead; a reversal can no longer be undone cleanly |

## Related links

- Back to the [documentation hub](../README.md).
- Feature hub: [Finance dashboard](../finance-dashboard/README.md).
- Sibling guides: [Reports](reports.md), [Bookings](bookings.md),
  [Booking Requests](booking-requests.md).
- Reference: the
  [payment lifecycle](../STATE_MACHINES.md#payment-lifecycle) and
  [refund and credit lifecycle](../STATE_MACHINES.md#refund-and-credit-lifecycle),
  the [Stripe](../ARCHITECTURE.md#stripe) and
  [operational Xero](../ARCHITECTURE.md#operational-xero) boundaries, and
  [payment and settlement invariants](../invariants/payment-and-settlement.md).
