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
| Description | A note shown to members on the work party page and the calendar | — | Optional; up to 1000 characters |
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
