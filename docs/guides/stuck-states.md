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
read-only apart from two money actions: closing a card refund Stripe gave up on
as **paid another way**, and picking the refund a voided bank refund note
recorded (both below). It complements [System Health](health.md) (which watches services)
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

### Bank transfer amount alerts not delivered

This critical Finance item means a bank-transfer settlement figure alert failed
three times. The existing Xero inbound job retries unsent markers older than ten
minutes, using the same cooldown claim as invoice deliveries. After three failed
sends it stops emailing; the item remains visible in Stuck States. Open Payments,
check the amount against Xero, and read the booking's staff timeline for the
settlement figure marker. No payment amount or booking status is changed by the
retry (#4446).

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
a timeout, a network or Stripe server error, Stripe saying the money was
already refunded, or Stripe refusing a reused key, so the refund may have gone
through after all. An `idempotency_error` on a card refund ("Keys for
idempotent requests can only be used with the same parameters") means Stripe
already received the refund under that key, so it has almost certainly been
made (#4101). If Stripe did
refund it, or you refund it in the Stripe dashboard yourself, do not close it
here. Wait until that refund shows on the payment: the amount still owed then
drops, and once nothing is left owed the refund leaves this list on its own. A
close always records money paid back, so it can never be for $0.00. A refund
with nothing left owed still shows in the **Exhausted recovery operations**
count: ask a developer to reconcile it.

**A refund Stripe refused** (#4083, #4096). When a booking change or a
cancellation refunds a card and Stripe answers straight away that the refund
failed or was cancelled, Stripe sent nothing back. The officers are emailed
once for the refusal, saying how much Stripe refused, and again if the retries
run out. The app asks again as a new request
each time, because Stripe would otherwise repeat its refusal. If the retries
run out, the row carries no **Stripe may have refunded** warning: Stripe sent
nothing. Once the Stripe dashboard shows that refund as failed or cancelled,
you can pay the member another way and close it here.

The same holds for a reviewed change's card refund, an approved late card
charge's, a duplicate charge's and a refund after the dates filled up (#4103).
Two cases are different. An automatic refund of a late card charge on a
cancelled booking that Stripe refuses is held on the payments board for a
treasurer to approve, whatever the club's setting, and approving it asks
Stripe again as a fresh request. A late-charge refund from the booking repair
tool that Stripe refuses fails, and running the repair again asks Stripe
afresh. An old group organiser's refund, or the refund of a stale group
payment, fails and is retried automatically as a fresh request; if the
officers' alert says it failed for good, refund it in the Stripe dashboard.

**A refund Stripe accepted and failed later** (#4104). Stripe can accept a card
refund as pending and report it failed days later, for example when the card
has been closed. The app then takes it back out of the refunded total and owes
it again: it shows under **Refunds owed**, the officers are emailed once, and it
is asked for again as a new request. Where it was the cancellation's own card
refund, the member's booking page stops saying that amount was refunded and says where
the new request stands: on its way, refunded again, waiting on the club, or
paid back another way (#4166). Three kinds are not asked for again, and are
listed here under **Card refunds Stripe gave up on** straight away, for you to
pay the member another way and close:

- a retry that Stripe also accepted and then failed;
- a refund Stripe **created** before the release that added this, unless a
  refund the app is still working on counts it - the member may already have
  been paid back by hand, so check Stripe and your bank first;
- a refund whose card refund you had already closed as **Paid another way**
  (#4210) - the bank transfer you recorded may already have paid it, so check
  that transfer first. After a part close the figure can include what that
  close recorded as no longer owed: check its record before paying. If the
  member is still owed anything, settle it with **Paid another way**, never
  with a new refund in the Stripe dashboard. After a close that paid back
  everything, nothing is left to close here: the row stays in the **Exhausted
  recovery operations** count, and the health check's payment recovery result
  stays red, so ask a developer to reconcile it.

A refund whose retries had already run out when it failed stays here too, with
the failure noted on it.

When you close one of these, Xero may already hold the card refund credit note
raised while the refund still counted. The dialog says how much of the refund
that note covers: you pay back that much with no new note, and a note worded as
a bank transfer is queued only for anything beyond it. If you pay back less than
the card note covers, Xero credits more than went back; the Xero reconciliation
report lists it as refund coverage above the refunded total, for you to correct
in Xero.

A refund the app did not make for the booking - one made by hand in the Stripe
dashboard, or an older group refund - that fails is not asked for again and is
not counted under Refunds owed. The officers are emailed with its Stripe refund
id, and the [audit log](audit-log.md) records it under **Payment**. Find it in
the Stripe dashboard: if the member is still owed, refund them again there, or
pay them another way. Raise no refund note for it in Xero: the card refund
credit note raised while Stripe counted it, if there is one, already records
it, and a second note would credit them twice. If they are no longer owed, the Xero
reconciliation report lists that note as refund coverage above the refunded
total, for you to correct in Xero.

If you pay the member back another way, for example by bank transfer, close the
refund here:

1. Under **Card refunds Stripe gave up on**, find the booking. Each row shows
   how much is still owed and when the refund started.
2. Click **Paid another way**. With view-only access the button is disabled,
   and the banner above the list says why.
3. The dialog says how much is still owed, and what will be recorded in Xero
   (below). If the amount still owed changes while the dialog is open, the
   dialog says so and clears the amount you typed. If it changes just as you close
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
payment.

The note always waits for the record: it is not queued until the record is in
Xero. If the charge's record is already on its way - a booking change's invoice
that is queued or sending - closing the refund queues nothing more, and the
note follows once that invoice is in Xero. If a record fails to send, press
**Retry in background** on its failed operation in [Xero](xero.md), and the
note follows. When the record has already failed, the dialog and the
confirmation say so rather than "on its way". A record that failed after it may
already have reached Xero - the late charge's own receipt, or a booking
change's invoice - is never retried automatically, not even by closing the
refund: check Xero for it first. If it is not there, retry it, and the note
follows. If it is there, what you do depends on whether the app linked it:

- **Not linked** - you found it in Xero, but its failed operation names no
  Xero invoice: mark the operation resolved as fixed in Xero, and record the
  refund by hand.
- **Already linked** - the operation names its Xero invoice, or the retry
  refuses because the booking change's invoice is already in Xero: mark it
  resolved as fixed in Xero, and do that first, before you record anything by
  hand. Do **not** record by hand the amount you paid back another way: the
  app raises that note against the invoice, through the nightly credit check
  or the Xero repair tool. Any part of the charge that Stripe refunded to the
  card is different. Once the operation is resolved the app raises no note
  for a card refund of the charge, so record that by hand. The retry's
  message names both amounts, and when nothing, or $0, was closed as paid
  another way, it says to record any card refund by hand. A card note that
  is not in Xero - still waiting, failed before it reached Xero, or refused
  by Xero - is in the amount to record by hand. A note an officer retried
  from Xero Operations counts once it is in Xero, even though the original
  waiting note still shows as failed. A card note that may be in Xero - the
  app tried to send it and cannot tell whether Xero took it - is named
  separately, so check Xero for that credit note and record it by hand only
  if it is not there. If the charge still has another invoice in Xero, or one
  on its way there, the app notes its card refunds against that one: record
  none of them by hand, because the app notes any not yet noted the next time
  it notes the charge.

The Xero repair tool a developer runs retries the other failed records, and
queues a note that never followed its record. If the note itself fails, the
record stays in Xero: press **Retry in background** on the failed note in Xero
Operations. The nightly credit check queues a note that was never queued, but
does not retry one that failed. If an officer recorded the charge in Xero by
hand before the app sent it, no note is raised: record the refund by hand too.
The repair tool names the amount: what was refunded to the card, less any note
already in Xero for it, plus what you paid back another way. A card note that
may be in Xero is named separately: check Xero for it before you record that
part. Whenever the charge's record was resolved by hand
and that finding does not apply - the app's own invoice in Xero whose operation
was resolved by hand, a change's invoice resolved before the app sent it, or
once a note for the close exists - the repair tool names the card refunds to
record by hand on their own. It names each charge once at most, and not at all
when the app raises the note. Either finding is a reminder only. It keeps
appearing after you record the refund by hand, and that is expected: the app
cannot see what you record by hand in Xero. The close's finding stops only once
a note for the close exists.

The dialog says before you close what will be recorded in Xero, and the
confirmation says what was queued. When nothing is, check the refund is
recorded in Xero and raise the note by hand if it needs one. When you close the
last refund on the list, the section stays and says the list is empty until you
leave the page; the same goes for the paid-back-twice list below.

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
for the same refund, the row comes back with the new amount. If that happens
while the dialog is open, the dialog says so; if it happens just as you mark it
resolved, the app refuses and the list refreshes, so you only ever resolve the
amount you saw.

This action does not cover two kinds of refund:

- A group organiser's refund for a member of their group comes out of the
  organiser's combined card payment, so it is not listed here.
- An old group cancellation refund (from before #3653) belongs to the group as
  a whole, not to one booking, so it is not listed either. What it still has to
  send counts in Refunds owed as one club-wide amount (owner decision on #3372,
  8 Oct 2026).

Those two still show in the **Exhausted recovery operations** count. Ask a
developer to reconcile them.

### Pick the refund a voided bank refund note recorded

**Voided bank refund notes to answer** (finance view to see it, finance edit to
act; #4162) lists bank refunds whose Xero credit note was voided where the app
could not tell which refund the note was for. Each row shows the booking, the
note's amount, its number and the day the app found it voided.

1. Press **Pick the refund**. The dialog lists the payment's bank refunds that
   are still recorded, with their amounts and the day each was marked paid back.
   A refund whose amount is exactly what the note still has to account for is
   marked **matches the note's amount**. A refund that its own live credit note
   in Xero still records, even in part, is not offered - taking it back would
   take back the whole refund - and the row says how much of it still has a
   live note; if the voided note recorded the rest of it, check Xero and record
   the answer. A refund larger than what is left of the note's amount is not
   offered either.
2. Choose the one the voided note recorded and press **Take this refund back**.
   The app takes that refund back out of the payment's records - the same undo
   it runs by itself for a note it can match - and the refund appears on
   **Money to settle** with the question "Has the money gone to the member?"
   ([guide](payments.md#answer-a-bank-refund-whose-xero-credit-note-was-voided)).
   Nothing is sent to the member or raised in Xero.
3. If the note recorded **more than one refund**, it stays on the list, saying
   how much is still to pick. Pick the next refund the same way; the row leaves
   the list once the refunds picked add up to the note's amount. Each picked
   refund gets its own question on Money to settle. A note whose amount the app
   **cannot read** takes one pick only, and the row says so.

Some rows have nothing to pick. A note that recorded a **card refund the club
paid back another way** keeps that refund recorded: raise its credit note again
from the Xero repair tool, then press **Record the answer** and say what you did
(this moves nothing). A note that recorded a **card refund made through Stripe**
(#4312) keeps that refund recorded too and has no bank refund to take back.
The app never raises its credit note again, not even after a later refund of
the same payment: if Xero should still show that refund, raise a credit note
for it by hand in Xero, then press **Record the answer** and say what you did.
If Stripe failed that refund later and the app sent it again, the voided note
may also have stood for the refund sent in its place: check whether that
refund has a credit note of its own in Xero for its full amount, and if not,
raise one by hand for what is missing.
Any other row with nothing to pick says why in one line -
no bank refund left that the note could have recorded, the payment's records no
longer holding it, or a credit note resolved by hand in Xero with no amount the
app can read. Check the payment in Xero, then press **Record the answer** and
say what you found (this moves nothing either). A note held back for **over a
week** by another credit note still being raised in Xero on the same payment is
shown so it cannot hide: check that payment's Xero operations.

Until the club switches the follow-up on (`XERO_ENABLE_BANK_REFUND_VOID_WRITES`,
see [`UPGRADING.md`](../UPGRADING.md)) the list is for information only and no
action is offered.

### A booking change's card request that stopped on its first refusal

When a booking change raises the price, the app asks the member's card for the
extra. If that request could not be set up at the time, the app retries it in
the background. In one rare order, two changes to the same booking end up with
the same card request, already recorded for the first change. The retry for the
second change would then be refused every time, so it stops on the first
refusal instead of running out its retries (#4081). It shows in the **Exhausted
recovery operations** count at once, at the full attempt count however few times
it ran, and the officers get one "Payment Failed" email. The email names the
change as the booking's history shows it (for example "Guests Added") and says
its card request is "already recorded for another change to the same booking".

Nothing has been written off: the money for the second change is still owed.
To collect it by hand:

1. Open the booking and compare its changes with its additional card requests.
   Check the request named in the email in the Stripe dashboard.
2. If that one request already asks for both changes' money, nothing more is
   needed once the member pays it.
3. Otherwise ask the member for the second change's amount another way, such as
   the supplementary invoice the Xero repair tool raises for a change whose
   card request stopped, and record it as paid the usual way.

## Settings reference

The page has no settings. What it shows:

| Element | Meaning |
| --- | --- |
| Summary tiles | Counts of Critical / Warning / Info records and total open signals |
| Domain cards | Per-domain (payment, booking, Xero, email, waitlist, bed allocation, lodge) counts and highest severity |
| Operator Queue | One row per signal: domain, description, severity, owner, count, and an **Open** link to the fix screen |
| Generated timestamp | When the dashboard was last computed (shown in the header) |
| Card refunds Stripe gave up on | Each dead card refund still owed, with a **Paid another way** close. Shown to Finance view (on a page that needs Support view), closed with Finance edit |
| Card refunds paid back twice | Each refund closed as paid another way that Stripe also refunded to the card afterwards, with both amounts and a **Resolved** action. Shown to Finance view, resolved with Finance edit |

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
| A row says **Stripe may have refunded** | Its last retry failed with a timeout, a network or Stripe server error, Stripe saying it was already refunded, or an `idempotency_error` (Stripe already received this refund) | Check the payment's refunds in the Stripe dashboard before paying the member another way |
| **Paid another way** says paid back in full "must be exactly what is still owed" | What is owed changed since the page loaded | Reload the page, check the amount, and choose again |
| The dialog says what is still owed changed, or closes and says the refund is no longer waiting | A refund was recorded, or someone else closed it, while the dialog was open | Check the new amount, or the payment, before doing anything more |
| **Paid another way** says the late card charge's Xero record "changed while you were closing it" | An officer resolved or withdrew the charge's record in Xero while you were closing the refund | Reload the page. The dialog then says what will be recorded in Xero now |
| **Exhausted recovery operations** counts a booking change's card request that stopped on its first refusal, and the email says its card request is "already recorded for another change to the same booking" | Two changes to one booking ended up with one card request, recorded for the other change; a retry would be refused the same way, so the app stopped at once | The money is still owed. See [A booking change's card request that stopped on its first refusal](#a-booking-changes-card-request-that-stopped-on-its-first-refusal) |
| **Mark resolved** says Stripe's refund to the card changed | Stripe refunded the card again since you opened the dialog | Check the new amount with the member before marking it resolved |

## Related links

- Back to the [documentation hub](../README.md).
- Sibling monitoring guides: [System Health](health.md),
  [Background Jobs](background-jobs.md), [Email Deliverability](email-deliverability.md),
  [Audit Log](audit-log.md).
- Reference: the stuck-state dashboard in [`ARCHITECTURE.md`](../ARCHITECTURE.md).
