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
  description). This happens even while the calendar module is off, so entries
  never show old dates.
- **Deactivating** hides the entries; **activating** shows them again.
- The entries are read-only on the calendar. Change the work party instead.
- **Add to calendar** appears, while the Events calendar module is on, on an
  active work party with nights still to come and no entries — one made
  before this feature, or while the calendar was off. Nothing is added to the
  calendar for those automatically, because you may already have typed them in
  by hand. Delete any hand-made entry first so it does not show twice.
- If the work party saves but its calendar entries cannot be written, the page
  says so: use **Add to calendar** to try again for a new work party, or save
  an edited one again.

### Members: join a work party

Members see a **Work Parties** card on their dashboard listing up to five
upcoming active work parties, soonest first, with the dates and (for one held at
a particular lodge) the lodge. A work party stays listed until its last night
has passed.

1. A member clicks a work party to open its page (`/work-parties/{id}`): its
   nights, lodge, discount and description.
2. **Join Work Party** opens **Book a Stay** with the stay filled in — check-in on
   the first night (or today, if it has started), check-out the morning after the
   last night — and the lodge and "I am attending a working bee" ticked.
3. The member adds guests and pays as usual. Joining *is* a booking: there is no
   separate sign-up list, every booking rule still applies (capacity, minimum
   stay, booking windows), and a full lodge shows the usual message.

Only **members** see the card, the page and the button — not organisation
accounts (schools), non-member logins, or kiosk or admin-only accounts. A
finished work party has no Join button, and an inactive one (or one whose internal
promo code has been switched off or archived) is not shown at all.

If the work party can no longer be joined, or it is held at a lodge the member
cannot book, Book a Stay opens empty with a short notice saying so.

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
| There's no Delete button on an event | It already has attending bookings | Deactivate it instead — delete is blocked to keep the discount history |
| A work party is not on the Events Calendar | It was made before this feature or while the calendar was off, or the calendar module is off | Turn the **Events calendar** module on, then click **Add to calendar** on its card |
| A member can't see the Work Parties card at all | The **Work parties** module is off, or the account is not a member (an organisation, a non-member login, or an admin-only account) | Check the module under **Admin → Setup → Modules** and the account's user type |
| The card says "No upcoming work parties" | Every work party is inactive, has finished (its last night has passed), or has had its internal promo code switched off or archived | Check the work party is **Active** with nights still to come |
| A member says the discount didn't apply | The event is inactive, their nights fall outside the window, or they didn't tick the working-bee option | Check the event is Active, its dates cover their nights, and that they selected it when booking |
| "Discount must be a whole number between 1 and 100" | A non-integer or out-of-range discount was entered | Enter a whole number from 1 to 100 |

## Related links

- Back to the [documentation hub](../README.md).
- Sibling guides: [Chore Roster](roster.md), [Hut Leaders](hut-leaders.md),
  [Lodges](lodges.md), [Bookings](bookings.md).
- Reference: [Admin and Lodge](../ARCHITECTURE.md#admin-and-lodge).
