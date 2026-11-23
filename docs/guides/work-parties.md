# Work Parties

Audience: Operator

## What it is

Working-bee events with an automatic booking discount: you set a date window and a
discount percentage, and members who tick "I am attending a working bee" when they
book nights inside that window get the discount applied automatically. Find it at
**Admin → Lodge Operations → Work Parties** (`/admin/work-parties`).

Work-party events are a **lodge** permission area: lodge view to read, lodge
**edit** to create, edit, or delete. The feature is on by default (the
`workParties` module).

## When you'd use it

- You are running a spring or autumn working bee and want to reward attendees with
  discounted nights.
- You want to see how many bookings claimed a working-bee discount and the total
  given.
- A working bee's dates or discount changed and you need to update it.

## Step-by-step

### Review the working-bee events

1. Go to **Admin → Lodge Operations → Work Parties**. Each event card shows its
   date window, discount, active state, the number of attending bookings, and the
   total discount given so far.

   ![Work Parties page showing the "July Working Bee 2026" event card with its date window, discount, attending-bookings count, and total discount given](../images/admin/admin-work-parties.png)

2. On an event with attending bookings, click **Show bookings** to expand the
   member, stay, status, and per-booking discount. If the bookings cannot be
   loaded, the card says why and offers **Try again**.

### Create or edit an event

1. Click **New Event** (or **Edit** on a card).
2. Set the **Name**, **Discount %** (a whole number 1–100), the **Start date** and
   **End date (last discounted night)**, an optional **Description**, and, with
   more than one lodge, the **Lodge** (or all lodges, club-wide). Tick **Active** so
   members can select it when booking.
3. Click **Create Event** / **Save Changes**. The discount applies to every
   attending guest's nights inside the window.

### Deactivate or delete

1. Use **Deactivate**/**Activate** to control whether members can select the event.
   An inactive work party also drops off the member dashboard and the Events
   Calendar until you activate it again.
2. **Delete** is available only while an event has **no** attending bookings; once
   bookings have claimed it, deactivate it instead to preserve the discount history.
   Deleting it also removes its calendar entries.

### The Events Calendar

With the **Events calendar** module on, **creating** a work party also puts it on
the [calendar](calendar.md#work-party-entries): one all-day entry, titled "Work
party: {name}", for each night from the start date to the end date, with the
lodge as its location and the description as its details. A card that is on the
calendar shows an **On calendar** badge.

- **Editing** the work party updates its entries (name, dates, lodge,
  description) in the same save. This happens even while the calendar module
  is off, so entries never show old dates; if the entries cannot be written,
  the save fails and nothing changes.
- **Deactivating** hides the entries; **activating** shows them again. While
  the **Work parties** module is off, every work party's entries are hidden,
  and they come back when it is turned on.
- A work party can run for at most 366 nights, the calendar's limit: new
  dates longer than that are refused when you save. A work party saved longer
  before this limit keeps working: you can still deactivate it or change its
  name or description with its dates as they are, and its calendar shows its
  first 366 nights. Changing its dates means bringing it within the limit.
- The entries are read-only on the calendar. Change the work party instead.
- Only **members** see the entries, on the calendar and the dashboard
  **Events** card, where a work party takes one line. Non-member logins, kiosk
  and admin-only accounts see the rest of the calendar without them.
- **Add to calendar** appears, while the Events calendar module is on, on an
  active work party with nights still to come and no entries — one made
  before this feature, or while the calendar was off. Nothing is added to the
  calendar for those automatically, because you may already have typed them in
  by hand. Delete any hand-made entry first so it does not show twice.
- If a **new** work party saves but its calendar entries cannot be written,
  the page says so: use **Add to calendar** to try again. When **Add to
  calendar** succeeds, the page says so and the button goes.

### Members: join a work party

Members see a **Work Parties** card on their dashboard listing up to five
upcoming active work parties, soonest first, with the dates and (for one held at
a particular lodge) the lodge. A work party stays listed until its last night
has passed. With no upcoming work party the card is not shown at all, so a club
that never runs working bees sees no empty card.

1. A member clicks a work party to open its page
   (`/dashboard/work-parties/{id}`): its nights, lodge, discount and
   description. The page sits under the dashboard so the app does not use the
   `/work-parties` address: a club can still publish a website page there.
2. **Join Work Party** opens **Book a Stay** with the stay filled in — check-in on
   the first night (or today, if it has started), check-out the morning after the
   last night — and the lodge and "I am attending a working bee" ticked.
   An unfinished booking kept in the browser tab is not brought back over it.
   Once the Join has filled in the dates, the Join booking is kept instead, so
   a detour (to add a family member on the profile, say) comes back to it. A
   Join that fills nothing in leaves the older booking kept as it was.
3. The member adds guests and pays as usual. Joining *is* a booking: there is no
   separate sign-up list, every booking rule still applies (capacity, minimum
   stay, booking windows), and a full lodge shows the usual message. A booking
   with "I am attending a working bee" ticked counts as joining; officers see
   those bookings on the work party's card afterwards, and no officer confirms
   them first.

Only **members** see the card, the page, the button and the "I am attending
a working bee" choice in Book a Stay — not organisation accounts (schools),
non-member logins, or kiosk or admin-only accounts. Anyone else booking those
nights sees no work party to choose, and books as usual. The choice lists
work parties up to two years ahead of the club's today (the booking horizon).
A
finished work party has no Join button, and an inactive one (or one whose internal
promo code has been switched off or archived) is not shown at all.

If the work party can no longer be joined, or it is held at a lodge the member
cannot book, Book a Stay opens empty with a short notice saying so.

### Add an existing booking to a work party

For a member who booked nights inside a work party but forgot to tick "I am
attending a working bee". You need **bookings edit** (a Booking Officer or Full
Admin).

1. Open the booking. In the **Admin tools** card, click **Add to work party**.
2. Choose the work party. Every active work party that overlaps the stay is
   listed. A booking already on one shows **Remove from work party** instead
   (see below).
3. Click **Show the new total**. You see the booking's new total, how much comes
   back and how, and anything still to pay.
4. If the booking was paid, choose **Club credit** (the default) or a refund,
   as on an ordinary booking change: **Refund to card** when it was paid by
   card, **Refund to bank account** when it was paid by Internet Banking. The
   figures are worked out again for your choice.
5. Click **Add and email member** or **Add without emailing**. When the booking
   has **No emails** on there is one **Add to work party** button and the member
   is not emailed.

What happens:

- The booking is repriced exactly as if the member had ticked the box when
  booking. The discount applies to each guest's nights inside the window.
- **A stay that has already started** can be added too, for a member at the
  lodge during the working bee. Every night inside the window is discounted,
  including nights already slept. Nights outside the window are not changed,
  and each night keeps the price it was sold at. The money comes back as below.
- **Other promo codes on the booking** are re-applied, as on any change: a
  night takes at most one code, so a member code gives up the nights the work
  party now covers and keeps the rest. On a stay that has started they are
  judged on the check-in day, so a code that has expired or been switched off
  since the stay began is kept, not taken off and charged back.
- A booking an officer overbooked can still be added: the change moves no guest
  or night, so it claims no bed and the lodge's capacity is not re-checked.
- **Unpaid:** the amount owed drops. With a 100% discount an unpaid booking can
  end up owing nothing, and is then settled as any $0 booking is. If account
  credit was applied to it and is now more than the new total, the extra goes
  back to the member's balance, shown as account credit in the figures.
- **Paid by card:** what was paid above the new total goes back as **club
  credit**, or, if you chose it, as a **refund to the card** ("Refunded to card"
  in the figures). Either way it comes back in full, and no cancellation-policy
  tier cuts it.
- **Paid by Internet Banking:** the same choice. A **refund to the bank
  account** ("To be refunded by bank transfer" in the figures) is the ordinary
  booking change's own: it raises one task in the **Money to settle** card for
  the treasurer to pay back by bank transfer, and the member's email says the
  club will refund them by bank transfer (see
  [Payments](payments.md#pay-back-a-refund-for-a-cash-booking)).
- **Paid with account credit, or nothing left to refund:** it goes back as club
  credit only, in full, because an ordinary change offers no refund either.
  The discount comes back to the member's balance as credit, up to the credit
  the booking had used: only the part the cash can't return, capped at the
  credit applied.
- **An additional payment still owed:** the discount cancels what is still
  owed first, as on any change that lowers the price. Only the rest comes
  back, and the figures say how much was cancelled ("Of the discount, $30.00
  cancels what is still owed on this booking"). When the discount is no more
  than what is owed, nothing comes back and there is nothing to choose: the
  figures say "The discount cancels $50.00 of what is still owed on this
  booking, so nothing comes back".
- **Paid by the group organiser:** the money goes back to the organiser, the way
  every change to a joiner's booking does: to the organiser's card, or by bank
  transfer if they paid by Internet Banking. The figures show "Returned to the
  group organiser".
- **No change fee** is charged: this is an officer correcting a missed tick, not
  the member changing their stay.
- It goes through the normal booking change, so the booking's history, the
  ledger, Xero (a credit note for a paid booking) and any refund are recorded
  and made like any other change's. The history marks it as a work-party
  correction.
- If the booking changed between the preview and the save, you are shown the
  new figures and asked to confirm again; nothing is saved meanwhile.

**When a booking can't be added.** The work party is greyed out, with the
reason:

- the booking isn't pending, confirmed or paid (for example cancelled, a draft,
  awaiting review, or on the waitlist);
- the stay has finished (its check-out day has passed);
- it belongs to an organisation (a school), which has no account credit;
- it is priced by its quote (a school or booking-request quote);
- it already has another promo code and the club allows only one discount per
  booking (the same rule as when booking);
- the work party is held at another lodge;
- it is your own or your family's booking (below).

**A disputed card payment.** When the member's card payment has an open or
lost Stripe dispute, any money the discount would hand back is held for the
treasurer to settle by hand, so **Show the new total** says to ask the
treasurer and nothing is saved. Where nothing would come back (the discount
only cancels a payment still owed), the booking can be added as usual.

**Your own or your family's booking.** You can never add your own booking, or
one belonging to someone in your family group, to a work party, even when no
money would come back. That covers the booking's owner and, for a joiner in a
group where the organiser pays, the organiser too, whether or not the group
has been paid for yet, and everyone in either person's family groups. The work party is greyed out with the reason; ask
another Booking Officer or Full Admin to do it. Being a guest on someone else's
booking does not count: that booking is theirs.

A booking can be on only one work party.

### Remove a booking from a work party

For a booking added to the wrong work party, or by mistake. You need **bookings
edit**.

1. Open the booking. In the **Admin tools** card, click **Remove from work
   party**. It replaces **Add to work party** on a booking that is on one.
2. The dialog shows the new total and how much is added to what is owed (or,
   for a joiner's booking billed to the group organiser, how much is invoiced
   to the organiser). If the booking can't be removed, it says why instead.
3. Click **Remove and email member** or **Remove without emailing** (one
   **Remove from work party** button when the booking has **No emails** on).

What happens:

- The booking is repriced without the work party's discount, through the
  normal booking change. The price goes back up by the discount, less anything
  another code on the booking takes back on those nights. Other codes are
  re-applied as for an Add, judged on the check-in day for a started stay, and
  capacity is not re-checked.
- **The difference is owed on the booking**, as with any change that raises the
  price. Unpaid: the amount owed goes up. Paid by card: the member is asked to
  pay the difference ("Asked of the member now"). Where an invoice was issued,
  Xero gets a supplementary invoice. On a stay that has started, that request
  is chased only until check-out; after that it is for the club to follow up
  (see [Chase money still owed after a booking change](bookings.md#chase-money-still-owed-after-a-booking-change)).
- **Nothing is taken back.** Club credit the Add gave (spent or not) stays on
  the member's account, and a refund already paid stays paid.
- A stay that has started can be removed too; the same nights lose the
  discount.
- No change fee is charged.
- A joiner's booking the group organiser paid by card can't be raised this way,
  as with any change to one that raises its price. Where the group organiser is
  invoiced for a joiner's changes, the increase goes on the organiser's invoice
  ("Invoiced to the group organiser").

**When a booking can't be removed.** The dialog says why instead:

- it is your own or your family's booking, as for an Add: another officer must
  remove it;
- it isn't pending, confirmed or paid, its stay has finished, or it is priced
  by its quote;
- it isn't on that work party;
- it is marked paid but no money was taken: for example an unpaid booking a
  100% work party brought to nothing, which was then marked paid and given its
  beds. Removing the work party would leave it paid and holding beds while
  owing what the work party took off, so **cancel the booking, or ask the
  treasurer**;
- it is marked paid with account credit alone, and no money taken: for example
  an unpaid $200 booking with $100 of credit applied, which a 50% work party
  brought down to the credit, so it was marked paid. For the same reason,
  **cancel the booking, or ask the treasurer**. A booking paid in full by
  credit before any work party is refused too. A joiner's booking whose share
  the group organiser paid is not refused for this reason, since the
  organiser's payment counts as money taken; the joiner rules above still
  apply.

## Settings reference

| Field | What it controls | Default | Notes / constraints |
| --- | --- | --- | --- |
| Name | The event's display name | — | Required |
| Discount % | Percent off nights in the window | 100 | Whole number 1–100 |
| Start date | First night in the discount window | — | NZ date-only |
| End date (last discounted night) | Last night in the discount window | — | NZ date-only; inclusive |
| Description | A note shown to members on the work party page and the calendar, and in the booking form to a member booking those nights | — | Optional; up to 1000 characters |
| Lodge | Which lodge the working bee is at | All lodges (club-wide) | Only shown with more than one active lodge |
| Active | Whether members can select the event when booking | on | Inactive events cannot be selected |

> Discounts are computed and stored in **integer cents**; the totals shown (e.g.
> "Total discount given") are those cents formatted as currency.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Work Parties is missing from the sidebar / 404s | The `workParties` module is off | Enable it under **Admin → Setup → Modules** — see [`CONFIGURATION.md`](../../CONFIGURATION.md#module-controls-and-admin-modules) |
| Everything is read-only ("… can view work parties but cannot change them") | Your admin role has lodge view but not edit | Ask a full admin for **lodge edit** access |
| A work party is "not available" in **Add to work party** | One of the reasons listed under "When a booking can't be added" | The dialog names the reason |
| "This is your own or your family's booking, so another officer must change its work party" | You, or someone in your family group, own the booking or organise the group that pays for it | Ask another Booking Officer or Full Admin to add or remove it |
| "This booking's card payment is disputed" after **Show the new total** | The member's card payment has an open or lost Stripe dispute, and money would come back | Ask the treasurer, who settles the held money by hand |
| "This booking is marked paid, but no money was taken" on **Remove** | It was paid with nothing or with account credit alone: for example, a work party brought an unpaid booking down to nothing, or to the credit applied, and it was marked paid | Cancel the booking, or ask the treasurer |
| There's no Delete button on an event | It already has attending bookings | Deactivate it instead — delete is blocked to keep the discount history |
| A work party is not on the Events Calendar | It was made before this feature or while the calendar was off, or the calendar module is off | Turn the **Events calendar** module on, then click **Add to calendar** on its card |
| A work party is missing from someone's calendar | The account is not a member (a non-member login, a kiosk or an admin-only account), the work party is inactive, or the **Work parties** module is off | Entries are shown to members only; check the account's user type, that the work party is **Active**, and the module |
| A member can't see the Work Parties card at all | The **Work parties** module is off, the account is not a member (an organisation, a non-member login, or an admin-only account), or no work party is upcoming | Check the module under **Admin → Setup → Modules** and the account's user type |
| A member sees no Work Parties card although the module is on | No work party is upcoming: every one is inactive, has finished (its last night has passed), or has had its internal promo code switched off or archived | Check the work party is **Active** with nights still to come |
| A member says the discount didn't apply | The event is inactive, their nights fall outside the window, or they didn't tick the working-bee option | Check the event is Active, its dates cover their nights, and that they selected it when booking |
| "Discount must be a whole number between 1 and 100" | A non-integer or out-of-range discount was entered | Enter a whole number from 1 to 100 |

## Related links

- Back to the [documentation hub](../README.md).
- Sibling guides: [Chore Roster](roster.md), [Hut Leaders](hut-leaders.md),
  [Lodges](lodges.md), [Bookings](bookings.md).
- Reference: [Admin and Lodge](../ARCHITECTURE.md#admin-and-lodge).
