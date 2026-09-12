# Waitlist

Audience: Operator

## What it is

A paginated queue of waitlisted bookings — members waiting for a bed on nights
that were full — where an admin can **force-confirm** an entry, with dialogs
that handle overbooking and whether to email the member. Find it at **Admin →
Bookings & Beds → Waitlist** (`/admin/waitlist`).

The waitlist is gated by the **`waitlist`** module, which also gates the
force-confirm action. Force-confirm itself sits in the **bookings** permission
area, so a view-only bookings role can browse the queue but not act on it. Money
is integer cents (shown as dollars); dates are NZ date-only lodge nights.

One waitlist repair does not live on this page. **Return to waitlist**, for a
free booking whose confirmation got half-way, sits on the booking's own page
under **Admin tools** — this queue lists only entries that are still waitlisted,
which by definition that booking is not. See
[Return a stranded free confirm to the waitlist](#return-a-stranded-free-confirm-to-the-waitlist).

## When you'd use it

- A night frees up and you want to confirm the next waitlisted member.
- A member accepts a waitlist offer and you need to push their booking through.
- A member's free waitlist confirmation got stuck and you need to give them
  their place back.
- You want to see who is waiting, in what order, and whether their offer email
  was sent.

## Step-by-step

### Open and read the queue

1. Go to **Admin → Bookings & Beds → Waitlist**. The header shows the total
   count. Each row shows the position, member, stay, guests, price, status, the
   source/offer context, when it was created, and a **Force Confirm** action.

   ![Waitlist queue: waitlisted and waitlist-offered entries with position, stay, price, status, offer context, and Force Confirm buttons](../images/admin/admin-waitlist.png)

2. The **Source** column explains each entry — for example "Position #2 waiting
   for capacity" or "Offer expires {date}" — and flags an offer email that is
   missing or undeliverable, with a link to review email deliverability.

### Filter the queue

1. Use **From**, **To**, and **Page size**, then click **Apply**. Click
   **Reset** to restore empty dates, 25 rows, and page 1. The filters are stored
   in the page URL; unrelated URL context is preserved.

### Force-confirm a booking

1. Click **Force Confirm** on the entry.
2. If confirming would email the member (the booking lands paid), the **Email
   the member about this confirmation?** dialog appears — choose **Confirm and
   email member** or **Confirm without emailing**. Your choice is recorded in
   the audit log.

   If the booking has **No emails** turned on
   ([Bookings](bookings.md#turn-off-all-emails-for-one-booking)), there is no
   choice to make — the confirmation is withheld either way — so the dialog
   says emails are off and offers only **Force-confirm booking**. The withheld
   confirmation is then listed on the booking itself for you to relay.
3. If the booking would exceed capacity, the overbook dialog lists the affected
   dates. Click **Confirm Anyway (Overbook)** to proceed — this writes a
   critical audit record you can open from the confirmation.

### Return a stranded free confirm to the waitlist

Very rarely, confirming a **free** waitlist offer gets half-way: the offer is
used up and the booking moves to payment-pending, but the final step cannot
finish and cannot undo itself. The booking then owes nothing, blocks nobody
else's nights, and has no offer for the member to retry, so it will not clear on
its own. The member is told exactly that at the time, and Admin → Audit log
lists it under `waitlist.confirm_offer_release_failed`.

1. Open the booking from **Admin → Bookings**. The waitlist queue will not show
   it — it is no longer waitlisted.
2. In the **Admin tools** card, press **Return to waitlist** and confirm.

The booking goes back on the waitlist for the same nights, its beds are freed
and offered to whoever is next, and the member is emailed that their waitlist
place is back at position N — unless the booking has **No emails** on
([Bookings](bookings.md#turn-off-all-emails-for-one-booking)), in which case the
message is withheld and listed on the booking for you to pass on. That email is
its own message, not the offer-expiry one: it says plainly that their offer did
not run out and that they need do nothing. The action is audited, and the entry
names the failure it resolves.

The button appears only where the audit log shows this failure on that booking
and it has not already been repaired — free, awaiting payment and no payment
record is not enough on its own, because several ordinary paths leave a booking
looking like that without it ever having been on a waitlist. If the booking has a
balance, or someone else has already confirmed or cancelled it, the action says
so and changes nothing. If it says something else is holding the booking right
now, nothing was changed either — wait a moment and press it again.

If the booking also has an admin hold on its nights, the confirmation dialog
says so: returning it to the waitlist releases that hold and the nights become
available to other members straight away. Set the hold again afterwards if you
still need it.

The alternative — cancel the booking and ask the member to rejoin — is still
available and is the right call when the nights are no longer wanted.
`docs/MAINTENANCE.md` has the full runbook, including how to find outstanding
cases in the audit log.

## Settings reference

The waitlist is a work queue, not a settings page. Its controls:

| Control | What it does | Default | Notes / constraints |
| --- | --- | --- | --- |
| From / To | Filter by stay date | empty | NZ date-only |
| Page size | Rows per page | 25 | 10 / 25 / 50 / 100 |
| Apply / Reset | Apply or restore the dataset defaults | — | Stored in the URL; Reset is disabled at defaults |
| Force Confirm | Confirm a waitlisted booking | — | Needs bookings edit access; may prompt for email choice and/or overbook confirmation |

Status chips include **Waitlisted** and **Waitlist Offered**; a warning line
appears when the booking still needs admin review. Offer-email badges show
whether the offer email was sent, queued, retrying, or undeliverable.

### Entries with "No emails" turned on

A booking with **No emails** switched on
([Bookings](bookings.md#turn-off-all-emails-for-one-booking)) behaves
differently on this board, and the badges say which case you are looking at:

- **"Position #N — silenced, will not be offered"** (or **"Silenced — will not
  be offered while emails are off"** when it has no position yet) — the entry is
  skipped when beds are handed out, so no offer is made at all. It keeps its
  place in the queue and does not hold up the members behind it; the position
  numbers everyone else sees are unchanged.
- **"Offer email withheld (No emails)"** — an offer email was withheld, and that
  offer has since lapsed. Nothing needs doing.
- **"Offer live but emails are off — member not told"** — the entry is holding a
  bed on an offer that is still running, and the member will get no expiry
  warning and no confirmation if they accept. This one needs an officer: the
  member was emailed the offer before the switch went on, so they **can** still
  accept it. Do not reassign the bed — contact them.

Force-confirming any of these skips the email choice, as described above.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Waitlist is missing from the sidebar | The `waitlist` module is off | Enable it under **Admin → Setup → Modules** — see [`CONFIGURATION.md`](../../CONFIGURATION.md#module-controls-and-admin-modules) |
| **Force Confirm** is disabled | Your admin role is view-only for bookings | Ask a full admin for bookings edit access |
| "Offer email log missing" / "undeliverable" badge | The waitlist offer email did not send | Click **Review email recovery** to open the email deliverability page (`/admin/email-deliverability`) and re-send |
| Confirming warns about overbooking | The lodge is full for those nights | Use **Confirm Anyway (Overbook)** only when you intend to overbook; it is audited |
| "Unpaid finished stay created" after confirming | The confirmed stay is in the past and unpaid | Chase it from the **Unpaid Finished Stays** queue on the [Bookings](bookings.md) list |
| A member says their free waitlist confirmation "did nothing", and the booking is not on this queue | The confirmation got half-way and could not undo itself | Open the booking from **Admin → Bookings** and press **Return to waitlist** in the Admin tools card — see [above](#return-a-stranded-free-confirm-to-the-waitlist) |
- **No offer is being issued for some dates, and the log shows
  `INV-MONEY-029`** — the offer-time reprice recorded a promotion build-up that
  did not reconcile to the promotion's stored totals. That check runs after the
  reprice's usual "offer at the stored snapshot" fallback and deliberately fails
  the whole hand-out for those dates rather than issuing an offer with a
  build-up that lies. It can only happen through a code defect; report it with
  the booking id from the log entry.


## Related links

- Back to the [documentation hub](../README.md).
- Sibling guides: [Bookings](bookings.md), [Bed Allocation](bed-allocation.md),
  [Booking Requests](booking-requests.md).
- Reference: the
  [waitlist lifecycle](../STATE_MACHINES.md#waitlist-lifecycle), the waitlist
  cron in [`CONFIGURATION.md`](../../CONFIGURATION.md#cron-waitlist-and-backups),
  and [capacity and overbooking](../CAPACITY_MODEL.md#exceeding-the-ceiling-admin-overbook-overrides).
