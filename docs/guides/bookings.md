# Bookings

Audience: Operator

## What it is

The master list of every booking the club holds — past, present, draft, and
cancelled — with a filter bar, an availability calendar, and a sortable table.
This is where an operator looks up a member's stay, checks who is booked on a
given night, spots bookings that still need review, and opens any booking to
manage it. Find it at **Admin → Bookings & Beds → Bookings**
(`/admin/bookings`).

Money is shown in dollars but stored as integer cents; every date is an NZ
date-only lodge night (no times), matching the rules in
[`money.md`](../invariants/money.md) and
[`booking-dates-and-capacity.md`](../invariants/booking-dates-and-capacity.md).

## When you'd use it

- A member calls to ask about their booking and you need to find it by name or
  email.
- You want to see how full a night or week is before confirming a new booking.
- A booking is flagged **Review** (for example minors booked without an adult)
  and you need to jump to the approvals queue.
- You are chasing unpaid stays, cancelled bookings, or bookings whose Xero
  invoice is missing.
- You want to start a new booking on a member's behalf (the **+ Create
  Booking** button).

## Step-by-step

### Open the bookings list

1. Go to **Admin → Bookings & Beds → Bookings**. The page loads titled **All
   Bookings** with the filter bar, the availability calendar, and the results
   table below it.

   ![All Bookings page: filter bar, monthly availability calendar with status legend, and the bookings table below](../images/admin/admin-bookings.png)

2. The calendar shows the month with each night's remaining beds (for example
   "14 beds") and coloured bars for the bookings on those nights. The colour
   legend under the calendar maps each colour to a booking status.

### Find a specific booking

1. Type a name or email into **Search member**. The list filters as you type
   (there is a short debounce, so pause briefly).
2. Narrow further with **Status**, **Month**, or **Payment** if needed.
3. Click the member's name in a row to open their member record, or the status
   chip to open the booking detail page.

### Filter the list

1. Use the always-visible filters for the common cases:
   - **Status** — All, or a single booking status (Pending, Confirmed
     (Unpaid), Paid, Waitlisted, Cancelled, and so on).
   - **Month** — All months, or a specific month such as "Jul 2026".
   - **Payment** — All payments, Stripe, Internet Banking, or No payment.
2. Click **More filters** for the advanced set (Deleted, Xero invoice state,
   Beds allocation state, Changes, Additional Payment, and three date ranges —
   Updated, Check In, Check Out). Active filters appear as removable chips, and
   the whole filter state is stored in the page URL so a filtered view can be
   bookmarked or shared.
3. Click **Reset** to restore search, every filter, sort, and page. In a
   multi-lodge club it keeps the selected **Lodge**, so Reset does not move you
   out of the lodge you are working in.
4. When the **Add another member as a guest** module is in use (or anything is
   still stuck from when it was), two **consent queue chips** sit above the
   table (#2307):
   - **Waiting for consent · N** — narrows the table to bookings holding a
     member-guest consent request nobody has answered yet. The number is the
     number of bookings the chip reveals.
   - **Consent needs attention · N** — swaps the table for a per-guest
     exception list: requests that were declined or lapsed but whose guest
     could **not** be removed automatically. Each row states *why it is stuck*
     (last guest on the booking, quote-priced, the booking's status, or a stay
     that already started) and *what fixes it* — always the real remedy
     (cancel the booking, add another guest first, re-quote the request),
     never a dead-end. The number is the number of stuck guest rows.

   Clicking an active chip clears it. Everything else on a booking's consent —
   who consented, who was told — shows as badges on the guest list of the
   booking's own page.

### Add a member guest to somebody's booking (#2309)

There is no separate admin booking page in this app — you read a member's own
booking page with admin tools on it — so this lives in the same place a member
would find it. Open the booking, choose **Edit Booking**, and the Guests
card header carries two buttons — **+ Add Member Guest** and **+ Add Non-Member
Guest** — exactly as the booking wizard does. Pressing the first opens the finder
inside the card.

Three things about it differ from what a member sees, and all three are
deliberate:

- **The member is added straight away.** They are not asked first and no bed is
  held pending an answer, whatever the club's ask-first setting says. An officer
  adding somebody on a member's behalf is treated as the club having decided.
- **The member is always emailed to say so, and you cannot turn that off.** It
  is not the courtesy "…and email member" tick you get elsewhere on a booking —
  being put on somebody else's booking is something the person is entitled to
  hear about. The one thing that does withhold it is the booking's own **No
  emails** switch, and a withheld send is then listed on that booking's
  withheld-emails banner so you can see what was held back.
- **You can search by name even when members cannot.** The club's *let members
  search by name* setting is about members; it does not bind you. If your role
  carries membership access you get the name type-ahead including under-18s; if
  it does not — a Booking Officer role with membership access removed — you get
  the exact-email box instead, which is the same thing you have always had.
  Either way the lookup is recorded in the audit log against your name.

**Withdrawing a request or taking a member guest off** is the ordinary guest
removal, on the same edit panel — and on a row whose request nobody has answered
yet the control reads **Cancel request** rather than Remove, because the two are
different events to the member and send different emails. The member gets one email saying they are no
longer on the booking (or that the request has been withdrawn, if they had not
answered yet).

**Do not confuse this with "Confirm pending guests".** That button is about
charging a card and confirming a booking awaiting review, and has nothing to do
with member-guest consent. The consent surfaces say *awaiting approval* or
*consent* and never *pending guests*.

### Charge a visiting club's members at your member rate

Somebody you currently charge the **non-member** rate, who belongs to another
club's lodge, can be charged your **member** rate instead — the reciprocal
arrangement clubs have with each other. The public booking-request form already
asks "are you a member of another lodge?", but plenty of these people arrive
some other way: an officer
books them on behalf, or the answer only comes up later. This is how you set it
on any booking, at any time before the stay starts.

Open the booking, choose **Edit Booking**, and on the Guests card:

1. Tick **Member of Other Lodge**. An **Other Lodge Name** picker appears,
   listing the other lodges recorded on
   [Setup & Configuration → Lodges](lodges.md#other-lodges), and a column of
   tick boxes appears to the left of the guest names. Both are hidden again the
   moment you untick it.
2. Choose the lodge. The tick boxes come alive.
3. Tick each person who is a member of that lodge. Their fee is recalculated at
   your club's member rate **for their own age group** — an adult at the adult
   member rate, a child at the child member rate — and the new figure appears
   beside their name with the old one struck through. Unticking puts them back
   on the non-member rate.
4. Save. Any difference is settled the same way every other booking change is:
   more to pay, or a refund/credit, shown before you commit.

Things worth knowing:

- **A tick box appears beside anybody you currently charge the non-member
  rate.** That is usually a non-member, but not always: somebody who was added
  to the booking with **+ Add Member Guest** can still be on the non-member rate
  — a non-member contact created by an earlier booking, or a membership category
  your club prices at non-member rates — and they get a tick box too, because
  the rate is what the reciprocal arrangement is about.

  **Two groups get no tick box, for two different reasons.**

  Somebody **already on your member rate** has nothing to change: there is no
  non-member rate there to replace, so the box would do nothing.

  Somebody whose **subscription is unpaid** is left out deliberately, and this
  one is not about there being nothing to replace — they may well be on the
  non-member rate right now. It is that handing them your member rate is the one
  thing an unpaid subscription is supposed to cost them. The screen says so
  under the lodge picker. This holds whichever setting your club uses for unpaid
  subscriptions, including the setting that does not reprice anybody: what
  matters is that the subscription is owed.

  **That includes somebody who has let your subscription lapse while being a
  fully paid-up member of the partner lodge**, which reads harsh and is
  deliberate. If reciprocity won there, anybody could let their subscription
  lapse, name a partner lodge, and go on paying your member rate for good — and
  the whole point of the lapsed-subscription setting is to chase the money they
  owe you. Offering the tick with a warning beside it was considered and turned
  down in favour of the simple rule. If you want the reciprocal rate to apply to
  that person, settle their subscription first; the tick box appears as soon as
  it is paid.
- **The booking's own page says so afterwards.** Once saved, that person's line
  in the Guests list carries *(Other Club Member)* after their rate category —
  the note is what explains the member-rate fee beside it.
- **It changes the price and nothing else.** Their standing with your club is
  untouched: whatever they counted as before the tick — for the adult-member
  hosting rule, the guest hold, and member-only promotions — they still count as
  afterwards. The tick records that they are a member of *another* club, and
  says nothing about yours.
- **Clearing the lodge clears everybody.** Untick **Member of Other Lodge**, or
  set the picker back to *Select a lodge*, and every tick clears with it — you
  cannot record somebody as an other-lodge member of no lodge.
- **It works on a booking whose price you negotiated.** A booking that came in
  through the public request form usually carries a price an officer agreed
  rather than the standard rates, and most edits to those are refused so nobody
  disturbs what was agreed. This tick is allowed anyway — it is not a
  renegotiation, it just applies the rate you already offer members of that
  lodge, and everybody else on the booking keeps the price they were quoted. Set
  the tick on its own, though: combine it with a date change, adding or removing
  somebody, or a promo code and the edit is refused as usual.
- **Only one lodge per booking.** A party split across two visiting clubs needs
  the officer to pick the one that applies, or to price the second club's people
  by hand.
- **Not once the stay has started.** The tick is refused mid-stay, because an
  in-progress booking prices its remaining nights through a different path and
  the change would silently settle nothing. Contact the office for a stay
  already under way.
- **It is an officer decision, and it is audited.** Members never see the
  control on their own booking.

### Read the results table

1. The toolbar shows "Showing N of M bookings found". Sort any sortable column
   (Member, Last Updated, Stay, Guests, Total, Status) by clicking its header.
2. Each row shows the member, the stay dates and nights, the guest count
   (total and how many are non-members), the price, the status chip, and the
   payment method. A **Review** chip on the Status cell links straight to the
   Approvals queue for that booking.
3. The Payment cell also says how much of the money has actually arrived. A
   fully settled booking reads **Paid**. One where a later change pushed the
   price up and the extra was never collected reads **Partly paid**, with an
   amber **"$210.00 due"** chip naming the shortfall. The booking's own status
   chip still reads **Paid** in that case, and that is correct — the stay is
   confirmed; it is the money that is short.

### Start a booking on a member's behalf

1. Click **+ Create Booking** (top right) to open the
   [Book on Behalf](book.md) wizard. If your admin role is view-only for
   bookings, this button is disabled.

### Chase money still owed after a booking change

When a change increases a booking's price after the booking has been confirmed —
adding a non-member guest to a paid booking, say — the difference becomes an
**additional payment** the member has to make from their own booking page. It is
easy for that to be quietly forgotten by everybody.

Only confirmed, paid and completed bookings are counted and chased. A cancelled
booking keeps the record of what it once owed, but the club never asks for it and
no screen calls it outstanding.

1. Find the bookings that owe something: the **Bookings With Unpaid Additions**
   card on the admin dashboard, or the **Unpaid Stay Additions** entry in the
   sidebar's Needs Attention menu. Both count stays that are still ahead as well
   as ones that have finished ("3 upcoming, 1 finished") and open the bookings
   list filtered to **Additional Payment: Still owing**.
2. Open a booking from that list. The **Additional payment outstanding** panel
   states the amount, when the change was made and how long ago that was,
   whether the last attempt to charge the member's card failed, and when the
   member was last emailed about it. It is read-only — you cannot take, waive,
   or zero the money from here; collecting it stays with the member's own card
   or with an ordinary booking change.
3. The member is chased automatically while the stay is still ahead: once a few
   days after the change, and once more shortly before check-in. The pre-arrival
   message names the amount too. Nothing is ever cancelled or expired because of
   an unpaid addition, and the automatic chasing stops once the stay is over —
   from then on it is a conversation, which is what the dashboard card is for.

   Automatic chasing covers changes made from the day this feature went live
   onwards. Anything that was already outstanding before then is shown on all
   the screens above but is never emailed about automatically — the club would
   otherwise have mailed its entire backlog in one go, quoting dates it could not
   reconstruct. Chase those by hand with the button below.
4. To chase now, click **Resend payment request email**. It sends the same
   message the automatic reminders send, and it **takes the place of** the
   automatic reminder that was coming: the member gets one message, not two.
   If they were already emailed within the last hour — by you, by another
   officer, or by the automatic reminder — you are told so and nothing is sent,
   so nobody is chased twice over. If the message cannot actually go out (a
   bounced address, or a member with no real email on file) you are told that
   too, rather than being shown a success you cannot rely on. Every re-send is
   recorded in the audit log.
5. If the booking has the **No emails** switch on (below), the re-send is
   refused outright with an explanation rather than silently withheld. Turn the
   switch off first if the member should hear from the club.

### Turn off all emails for one booking

Sometimes you are already dealing with a member directly — over the phone, in
person, or by a long email thread — and the club's automatic messages would
only confuse things. The **No emails** switch on a single booking stops the
system sending that member *anything* about it.

> **This is a promise you make, not one the system keeps.** Nothing withheld is
> ever sent later. If you turn the switch on and the booking is then cancelled,
> the member is never told about the cancellation by the club. Telling them is
> your job from that moment on.

1. Open the booking (click the status chip on its row in the table above).
2. In the **Admin tools** card, click **Turn off all emails**.
3. Read the dialog. It states the consequence plainly: no emails at all for
   this booking, including cancellation notices and payment reminders. Two
   extra warnings appear when they apply:
   - **the booking is holding a live waitlist offer.** The member was already
     emailed that offer and **can still accept it**, so do not reassign the
     bed. What they lose is the expiry warning and the confirmation if they
     do accept — so follow it up yourself.
   - **the booking is still waitlisted** (no offer made yet). While emails are
     off it is skipped when beds are handed out, so no offer is made at all.
     It keeps its place in the queue and holds nobody else up. Nothing about
     this appears in the withheld list later, because there is no offer to
     withhold — this dialog is the only place you are told.
4. Click **Yes — I will tell the member myself**. Nothing is saved until you
   do; **Cancel** leaves the booking exactly as it was.

While the switch is on:

- the booking shows a **red banner** listing what was actually withheld,
  grouped by kind with a count (so a week of chore-roster emails is one line
  reading "Chore Roster ×56" rather than 56 lines burying the cancellation
  underneath). Work down that list when you contact the member. Two kinds carry
  a link rather than information, and they need different things from you:
  the **split-guest payment link** was never generated at all, so clearing the
  switch is enough — it is re-sent automatically. The **chore roster** is not
  the same: the guest's old chore link was replaced before the email was
  withheld, so it no longer works, and nothing re-sends the new one. Clear the
  switch, then re-send the roster from the Roster page by hand;
- the banner also points at **Admin → Email deliverability**. The list covers
  messages the system *deliberately* withheld; a message that failed for some
  other reason shows up there instead, so check both before telling a member
  you have the full picture;
- every action that would normally ask "email the member about this?" stops
  asking and tells you emails are off instead;
- **account and security email is not affected.** Two-factor codes, password
  resets, magic-link sign-ins and email-change notices all still work. The
  switch is attached to the booking, never to the member's address;
- **admin alerts still reach you.** Payment failures, capacity warnings and the
  rest are unaffected;
- **the Xero invoice email is withheld too.** The invoice itself is still
  created in Xero and is unchanged — only the emailing stops, so send it from
  Xero by hand if the member needs it.

To undo it, click **Turn emails back on**. That takes no acknowledgement (a
stuck switch must always be clearable), but it does **not** re-send anything
that was withheld — which is why the banner keeps listing what was missed. It
stays on the booking after the switch is cleared, turning **amber** instead of
red: the messages are still ones the member never received.

Both turning it on and turning it off are written to the
[Audit Log](audit-log.md), with who did it and when.

## Settings reference

The bookings list is a working queue, not a settings page. The controls below
are its filters and columns.

| Control | What it does | Default | Notes / constraints |
| --- | --- | --- | --- |
| Search member | Free-text match on member name or email | empty | Debounced; resets to page 1 |
| Status | Filter to one booking status | All | Values map to the booking state machine (see below) |
| Month | Filter to a single month | All months | Options span the current year ±1 |
| Payment | Filter by payment method | All payments | Stripe, Internet Banking, or No payment |
| More filters → Deleted | Show/hide soft-deleted bookings | Hide deleted | Include deleted or Deleted only |
| More filters → Xero | Filter by Xero invoice state | All Xero states | Invoice linked/missing, failed/partial/pending activity |
| More filters → Beds | Filter by bed-allocation state | All bed states | Only shown when the `bedAllocation` module is on |
| More filters → Changes | Filter by change/review state | All change states | Requires review, pending request, has modification, credit generated |
| More filters → Additional Payment | Bookings that still owe extra | All | "Still owing" |
| Updated / Check In / Check Out ranges | Date-range filters | empty | NZ date-only |
| Lodge | Filter by lodge | All lodges | Only shown when more than one active lodge exists |
| Reset | Restore search, filters, sort, and page | — | Keeps the selected lodge; disabled at the dataset defaults |
| + Create Booking | Open the Book on Behalf wizard | — | Disabled for view-only bookings roles |
| Booking page → Admin tools → Cash / off-Xero payment | Record a payment made in cash or by a bank transfer that never reached Xero, or reverse one | — | Needs finance **edit** (not bookings edit). Never contacts Xero. Asks whether the money also covers any extra still owing from a later change. See the [Payments guide](payments.md) |

**Booking status chips** (shared with the rest of the app): Draft, Pending,
Payment Pending, Confirmed (Unpaid), Awaiting Review, Paid, Completed,
Cancelled, Bumped, Waitlisted, Waitlist Offered. The full set of transitions
lives in [`STATE_MACHINES.md`](../STATE_MACHINES.md#booking-lifecycle).

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| No bookings show | Filters are too narrow, or you are viewing the wrong month | Click **Reset**, then re-apply one filter at a time |
| A booking you expect is missing | It may be soft-deleted or in another lodge | Under **More filters** set Deleted to "Include deleted", and (multi-lodge) check the Lodge filter |
| A row shows a **Review** chip | The booking needs admin review (for example a minor without an adult) | Click the chip to open the [Booking Requests → Approvals](booking-requests.md) queue |
| A row reads **Partly paid** with an amount due | A change raised the price after payment and the extra was never collected | Open the booking and work through the **Additional payment outstanding** panel |
| **Resend payment request email** says one was already sent | Someone — or the automatic reminder — emailed the member within the last hour | Wait for the hour to pass; the panel shows when the member was last emailed |
| **Resend payment request email** is refused for a silenced booking | The booking has the **No emails** switch on | Turn the switch off, or contact the member yourself |
| The Beds filter is missing | The bed-allocation module is off | Enable it under **Admin → Setup → Modules** (`bedAllocation`) — see [`CONFIGURATION.md`](../../CONFIGURATION.md#module-controls-and-admin-modules) |
| **+ Create Booking** is greyed out | Your admin role can view bookings but not edit them | Ask a full admin to grant bookings edit access |
| A member says they never got a confirmation, reminder, or cancellation notice | The booking may have the **No emails** switch on | Open the booking; if the withheld-emails banner is there — **red** while emails are off, **amber** once they are back on — it lists exactly what was held back. Relay it, and check **Admin → Email deliverability** too for messages that failed for other reasons |
| **Turn off all emails** is greyed out | Your admin role can view bookings but not edit them | Ask a full admin to grant bookings edit access |
| A booking still shows the withheld-emails warning after emails were turned back on | Correct — turning the switch back on never re-sends anything | The banner is the record of what the member was never told; work through it with them |

## Related links

- Back to the [documentation hub](../README.md).
- Sibling guides: [Book on Behalf](book.md), [Booking Requests](booking-requests.md),
  [Bed Allocation](bed-allocation.md), [Waitlist](waitlist.md),
  [Payments](payments.md).
- Reference: the booking state machine in
  [`STATE_MACHINES.md`](../STATE_MACHINES.md#booking-lifecycle), the
  booking/payment flow in
  [`ARCHITECTURE.md`](../ARCHITECTURE.md#booking-and-payment-flow), and the
  status list in [`ARCHITECTURE.md`](../ARCHITECTURE.md#booking-statuses).
