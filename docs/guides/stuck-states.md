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
a timeout or network error, so the refund may have gone through after all. If
Stripe did refund it, or you refund it in the Stripe dashboard yourself, do not
close it here. Wait until that refund shows on the payment: the amount still
owed then drops, and a refund with nothing left owed can be closed at $0.00.

If you pay the member back another way, for example by bank transfer, close the
refund here:

1. Under **Card refunds Stripe gave up on**, find the booking. Each row shows
   how much is still owed and when the refund started.
2. Click **Paid another way**. With view-only access the button is disabled,
   and the banner above the list says why.
3. The dialog says whether a Xero refund credit note will be queued (below).
4. The amount defaults to what is still owed. Change it if you paid back less.
   It cannot be more than is owed, and it cannot be nil while money is still
   owed. A refund that replaces a superseded card payment closes only for the
   whole amount.
5. Under **How was it paid back? (required)**, say how you paid the member
   back. The note goes in the [audit log](audit-log.md) under **Payment**.
   Until it is filled in, the button stays disabled and says why.
6. Click **Close as paid another way**.

The amount is recorded as refunded on the payment, the same way a refund you
complete by hand is recorded. Stripe is not asked again.

**Paying back less ends the refund.** If you enter less than is owed, the rest
stops being owed: it leaves Refunds owed and nothing tracks it any more. The
dialog shows how much that is before you close. After a **full** close, Net
Collected stays where it was: the money moves from "owed back" to "refunded".
After a partial close, Net Collected goes **up** by the amount given up, because
the club is no longer treating it as owed.

**Xero.** For a cancellation's card refund, the close queues a refund credit
note for exactly the amount paid back, worded as a bank transfer, and the
confirmation says so. For any other refund no note is raised. A refund from a
booking change was already credited on the invoice by the change's own credit
note. For anything else, the confirmation asks you to check the refund is
recorded in Xero, and you raise the note by hand if it is not.

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
| A row says **Stripe may have refunded** | Its last retry failed with a timeout or network error | Check the payment's refunds in the Stripe dashboard before paying the member another way |

## Related links

- Back to the [documentation hub](../README.md).
- Sibling monitoring guides: [System Health](health.md),
  [Background Jobs](background-jobs.md), [Email Deliverability](email-deliverability.md),
  [Audit Log](audit-log.md).
- Reference: the stuck-state dashboard in [`ARCHITECTURE.md`](../ARCHITECTURE.md).
