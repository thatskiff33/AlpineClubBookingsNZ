# Stuck States

Audience: Operator

## What it is

A single operator queue for records that have got **stuck** — a payment that
never settled, a booking mid-transition, a Xero sync that didn't complete, an
email that exhausted its retries, a waitlist or bed-allocation edge case. Each
signal is grouped by domain, ranked by severity, given an owner, and linked
straight to the screen where you fix it. Find it at **Admin → Monitoring & Support → Stuck States**
(`/admin/stuck-states`).

The page is computed on each visit (it shows when it was generated). It is
read-only apart from one money action: closing a card refund Stripe gave up on
as **paid another way** (below). It complements [System Health](health.md) (which watches services)
by watching **data** — see [`ARCHITECTURE.md`](../ARCHITECTURE.md)
(stuck-state dashboard).

## When you'd use it

- Your daily sweep for anything that silently fell out of a normal flow.
- A member reports a payment or booking that's "stuck" and you want to find and
  clear it fast.
- After an incident (provider outage, failed deploy) to catch records left
  mid-transition.

## Step-by-step

### Work the queue

1. Go to **Admin → Stuck States**. The summary tiles show the count of
   **Critical**, **Warning**, and **Info** records and the total open signals.

   ![Stuck States with severity summary tiles, per-domain cards, and the operator queue table linking each signal to its fix screen](../images/admin/admin-stuck-states.png)

2. Scan the **per-domain cards** (payment, booking, Xero, email, waitlist, bed
   allocation, lodge) for where the problem is.
3. In the **Operator Queue** table, each row names the signal, its severity, its
   owner, and a count. Click **Open** to go straight to the screen that resolves
   it. An empty queue shows "No stuck states found."

### Close a card refund Stripe gave up on

When the club refunds a card and Stripe fails, the app retries the refund
automatically. After the last retry it stops, and the refund becomes stuck. It
still counts in **Refunds owed** and still comes off **Net Collected** (owner
decision on #3372, 7 Oct 2026), because the club still owes the member that
money. Stuck card refunds are also counted in the **Exhausted recovery
operations** row of the Operator Queue.

To see them you need **Support view** (for this page) and **Finance view** (for
the list). To close one you need **Finance edit**.

**Before you pay the member another way, check Stripe.** Open the payment in the
Stripe dashboard and compare its refunds with this refund's amount. A row that
says **Stripe may have refunded: check the Stripe dashboard first** failed with
a timeout, a network or Stripe server error, or Stripe saying the money was
already refunded, so the refund may have gone through after all. If Stripe did
refund it, or you refund it in the Stripe dashboard yourself, do not close it
here. Wait until that refund shows on the payment: the amount still owed then
drops, and once nothing is left owed the refund leaves this list on its own. A
close always records money paid back, so it can never be for $0.00. A refund
with nothing left owed still shows in the **Exhausted recovery operations**
count: ask a developer to reconcile it.

If you pay the member back another way, for example by bank transfer, close the
refund here:

1. Under **Card refunds Stripe gave up on**, find the booking. Each row shows
   how much is still owed and when the refund started.
2. Click **Paid another way**. With view-only access the button is disabled,
   and the banner above the list says why.
3. The dialog says how much is still owed, and what will be recorded in Xero
   (below). If the amount still owed changes while the dialog is open, the
   dialog says so and clears what you typed. If it changes just as you close
   it, the close is refused and the list refreshes: check the amount and close
   it again.
4. Choose how much you paid back. Nothing is chosen for you, and the app never
   guesses from the amount:
   - **Paid back in full**: the amount is fixed at what is still owed.
   - **Paid back part of it - the rest will no longer be owed**: type the
     amount you paid. It must be more than nil and less than what is owed. The
     dialog then says in dollars how much will no longer be owed. A problem
     with the amount is shown once you have typed it or left the box.

   A refund that replaces a superseded card payment closes only in full.
5. Under **How was it paid back? (required)**, say how you paid the member
   back. The note goes in the [audit log](audit-log.md) under **Payment**.
   Until it is filled in, the button stays disabled and says why.
6. Click **Close as paid another way**.

The amount is recorded as refunded on the payment, the same way a refund you
complete by hand is recorded. Stripe is not asked again.

**Paying back part of it ends the refund** (owner decision on #3372, 8 Oct
2026). The rest stops being owed anywhere: it leaves Refunds owed and nothing
tracks it any more. A later refund on the same booking, for example from a
booking change reviewed after the cancellation, pays only its own share - it
does not pick up the difference. After a **full** close, Net Collected stays
where it was: the money moves from "owed back" to "refunded".
After a partial close, Net Collected goes **up** by the amount given up, because
the club is no longer treating it as owed.

**Xero** (owner decisions on #3372, 8 Oct 2026). Every kind of card refund - a
cancellation's, an approved refund request's, a booking change's, a late card
charge's or a superseded payment's - queues a Xero refund credit note for
exactly the amount paid back, worded as a bank transfer ("Refund requested via
internet banking") and dated the day you closed it, as long as the app has a
Xero invoice to credit. If the payment's invoice is still on its way to Xero,
the app does not know of one yet: the dialog says no note is queued, and you
check Xero and record the refund there by hand if it needs one.

**A late card charge** - one taken after its booking was cancelled, which you
chose to refund - is credited against its own record in Xero, never the
booking's invoice. If Xero has no record of the charge yet, closing the refund
first records it: an invoice for the whole charge, paid into the Stripe account
on the day Stripe took it. That is the same record the app makes when you
choose to keep a late charge instead of refunding it. Once that record is in
Xero, the refund credit note for the amount you paid back follows, as a bank
transfer, dated the day you closed it, and naming that record. Xero then shows
both movements - the money into the Stripe account and the money out of the
bank - and the charge nets to nil, or to what was given up after a part
payment. The note always waits for the record: it is not queued until the
record is in Xero. If the record fails to send, press **Retry in background**
on its failed operation in [Xero](xero.md), and the note follows; the Xero
repair tool a developer runs retries it too. If the note itself fails, the
record stays in Xero and only the note is retried. If an officer already recorded the charge
in Xero by hand, no note is raised: record the refund by hand too.

The dialog says before you close what will be recorded in Xero, and the
confirmation says what was queued. When nothing is, check the refund is
recorded in Xero and raise the note by hand if it needs one.

**Paid back twice.** If Stripe did refund the card after all and the refund
reaches the app after you closed it, the booking appears under **Card refunds
paid back twice**, with both amounts. The member then has the money twice:
contact them to recover the extra, and record what you agree in Xero.

Once it is sorted out, mark the row resolved (owner decision on #3372, 9 Oct
2026). You need **Finance edit**; with view-only access the button is disabled
and the banner above the list says why.

1. Click **Resolved** on the row.
2. Under **How was it sorted out? (required)**, say what you agreed with the
   member, for example that they paid the extra back by bank transfer.
3. Click **Mark resolved**.

The row leaves the list, and your note goes in the [audit log](audit-log.md)
under **Payment**. Nothing is refunded or charged, and nothing is sent to Xero:
record what you agreed there yourself. If Stripe later refunds the card again
for the same refund, the row comes back with the new amount.

This action does not cover two kinds of refund:

- A group organiser's refund for a member of their group comes out of the
  organiser's combined card payment, so it is not listed here.
- An old group cancellation refund (from before #3653) belongs to the group as
  a whole, not to one booking, so it is not listed either. What it still has to
  send counts in Refunds owed as one club-wide amount (owner decision on #3372,
  8 Oct 2026).

Those two still show in the **Exhausted recovery operations** count. Ask a
developer to reconcile them.

## Settings reference

The page has no settings. What it shows:

| Element | Meaning |
| --- | --- |
| Summary tiles | Counts of Critical / Warning / Info records and total open signals |
| Domain cards | Per-domain (payment, booking, Xero, email, waitlist, bed allocation, lodge) counts and highest severity |
| Operator Queue | One row per signal: domain, description, severity, owner, count, and an **Open** link to the fix screen |
| Generated timestamp | When the dashboard was last computed (shown in the header) |
| Card refunds Stripe gave up on | Each dead card refund still owed, with a **Paid another way** close. Shown to Finance view (on a page that needs Support view), closed with Finance edit |
| Card refunds paid back twice | Each refund closed as paid another way that Stripe also refunded to the card afterwards, with both amounts. Shown to Finance view; nothing to click |

### Who sees the named rows

A few signals expand into a short list naming the individual members or bookings
behind the count — **Members with no reachable email address** lists the members,
and **Bookings without required adult member cover** names each booking's owner.
Those named rows are membership-roll detail, so they appear **only if you also
have Membership view access**. An admin with Stuck States access but not
Membership sees the same signal, the same count, and the same **Open** link to
work it — just not the individual names and per-member deep links. This keeps
the queue useful to support staff (they can see a problem exists and hand it on)
without widening who can read the membership roll.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| **Bookings with unnamed guests** shows a count | An upcoming school/organisation or member whole-lodge booking still lists generated placeholders ("Guest 2", "School Child 5"), so the chore list and arrival roster would print those instead of real people | Most bookers are chased automatically as check-in approaches, but not all of them: a school list the contact already **confirmed** while leaving the placeholder names in place gets no further prompt, and a booking still held for approval is not chased at all. So work the list — open each booking and edit the guest names yourself. Renaming a guest does not change their age group or the price. **This never holds up a stay** — the booking, check-in and [Chore Roster](roster.md) all work exactly as normal while the count stands |
| **Bookings without required adult member cover** shows a count | A booking that was confirmed with the adult-member cover the club requires has since lost it — an officer overrode the refusal, a membership lapsed, another booking on the same account was cancelled, or a payment or lifecycle change removed the person who was covering it. It only appears where the lodge is set to **stop** a non-compliant booking and to allow cover from another booking on the same account (see [Booking Policies](booking-policies.md)) | Open the booking. Four things clear it, and any one of them is enough: put a qualifying adult member back on the party or on another confirmed booking on the same account for those nights, amend the booking so the uncovered nights go away, approve a policy exception for it, or cancel it. The entry clears itself once one of those is true — there is nothing to tick off. **The stay is never held up over this and nothing is ever cancelled automatically**: the beds and the payments are untouched while the count stands, and the booking owner has already been emailed once about it |
| A signal reappears after you act | The underlying record is still in the stuck state | Follow the **Open** link and complete the resolution there; the signal clears on the next generation |
| A payment/Xero signal is Critical | A settlement or sync didn't complete | Open it and reconcile; see [Payments](payments.md) / [Xero Sync](xero.md) |
| An email signal shows exhausted failures | Delivery retries ran out | Investigate in [Email Deliverability](email-deliverability.md) |
| Counts look stale | The dashboard is computed per visit | Reload the page to regenerate |
| **Paid another way** says the refund "is still being retried" | Stripe has retries left, so the refund is not stuck yet | Wait. It only appears in the list once its last retry has failed |
| **Paid another way** says the payment "no longer holds that much to refund" | Another refund or credit on the same payment used the money since the page loaded | Reload the page and check the amount still owed |
| **Paid another way** says the refund "changed while you were closing it", or that the amount is "more than this refund still owes" | A refund was recorded on the payment, or someone else closed it, since the page loaded. The list refreshes behind the dialog | Check the new amount still owed, and Stripe, before closing again |
| A row says **Stripe may have refunded** | Its last retry failed with a timeout, a network or Stripe server error, or Stripe saying it was already refunded | Check the payment's refunds in the Stripe dashboard before paying the member another way |
| **Paid another way** says paid back in full "must be exactly what is still owed" | What is owed changed since the page loaded | Reload the page, check the amount, and choose again |
| The dialog says what is still owed changed, or closes and says the refund is no longer waiting | A refund was recorded, or someone else closed it, while the dialog was open | Check the new amount, or the payment, before doing anything more |

## Related links

- Back to the [documentation hub](../README.md).
- Sibling monitoring guides: [System Health](health.md),
  [Background Jobs](background-jobs.md), [Email Deliverability](email-deliverability.md),
  [Audit Log](audit-log.md).
- Reference: the stuck-state dashboard in [`ARCHITECTURE.md`](../ARCHITECTURE.md).
