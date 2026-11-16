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
   member, stay, status, and per-booking discount.

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
2. **Delete** is available only while an event has **no** attending bookings; once
   bookings have claimed it, deactivate it instead to preserve the discount history.

### Add an existing booking to a work party

For a member who booked nights inside a work party but forgot to tick "I am
attending a working bee". You need **bookings edit** (a Booking Officer or Full
Admin).

1. Open the booking. In the **Admin tools** card, click **Add to work party**.
2. Choose the work party. Every active work party that overlaps the stay is
   listed. If the booking is already on one, the dialog says so instead.
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
  Account credit the booking had used always goes back to the member's balance.
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
- the stay has already started, so its prices are fixed;
- it belongs to an organisation (a school), which has no account credit;
- it is priced by its quote (a school or booking-request quote);
- it already has another promo code and the club allows only one discount per
  booking (the same rule as when booking);
- the work party is held at another lodge.

**Your own or your family's booking.** You can add your own booking, or one of
someone in your family group, when nothing comes back, for example an unpaid
booking with no account credit applied, whose price just drops. When the change
would refund or credit any money, including account credit an unpaid booking
had applied that is now more than its new total, **Show the new total** says
another officer must add it, and nothing is saved. For a joiner's booking the group organiser paid for, the same applies
when you, or someone in your family group, organised the group, because the
money goes back to the organiser.

A booking can be on only one work party. Removing a booking from a work party is
not available.

## Settings reference

| Field | What it controls | Default | Notes / constraints |
| --- | --- | --- | --- |
| Name | The event's display name | — | Required |
| Discount % | Percent off nights in the window | 100 | Whole number 1–100 |
| Start date | First night in the discount window | — | NZ date-only |
| End date (last discounted night) | Last night in the discount window | — | NZ date-only; inclusive |
| Description | A note shown on the card | — | Optional; up to 1000 characters |
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
| "Another officer must add this booking" after **Show the new total** | It is your own or your family's booking (or you organised the group that paid for it), and money would come back | Ask another Booking Officer or Full Admin to add it |
| There's no Delete button on an event | It already has attending bookings | Deactivate it instead — delete is blocked to keep the discount history |
| A member says the discount didn't apply | The event is inactive, their nights fall outside the window, or they didn't tick the working-bee option | Check the event is Active, its dates cover their nights, and that they selected it when booking |
| "Discount must be a whole number between 1 and 100" | A non-integer or out-of-range discount was entered | Enter a whole number from 1 to 100 |

## Related links

- Back to the [documentation hub](../README.md).
- Sibling guides: [Chore Roster](roster.md), [Hut Leaders](hut-leaders.md),
  [Lodges](lodges.md), [Bookings](bookings.md).
- Reference: [Admin and Lodge](../ARCHITECTURE.md#admin-and-lodge).
