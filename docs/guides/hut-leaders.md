# Hut Leaders

Audience: Operator

## What it is

The calendar for assigning a member to be the **hut leader** (the on-site lead) for
the nights that need cover. You paint a date range, pick a member, and confirm;
the page shows which upcoming nights still need a leader and gives each assigned
leader a kiosk PIN for the lodge device. Find it at
**Admin → Lodge Operations → Hut Leaders** (`/admin/hut-leaders`). A daily
`hut-leader-auto-assign` cron also suggests leaders in the background
(`ARCHITECTURE.md`).

"Hut leader" is the default label — a club can rename it (for example to
"Custodian" or "Warden") in its club identity settings, and this page follows that
label. Hut-leader assignments are a **lodge** permission area: lodge view to read,
lodge **edit** to assign, delete, or reset a PIN. The feature is on by default
(the `hutLeaders` module).

## When you'd use it

- Upcoming booked nights have no one in charge and you need to assign a leader.
- A leader dropped out and you need to reassign their nights.
- A hut leader needs a fresh kiosk PIN for the lodge device.

## Step-by-step

### See what needs cover and assign a leader

The selected lodge scopes the whole workspace: the assignment table, upcoming
uncovered nights, red/violet occupancy calendar, eligible-member suggestions,
bed choices and the new assignment all describe that lodge only. Switching
lodges clears the previous results while the new lodge loads. If the lodge list
cannot be loaded, the page explains the failure, offers **Try again**, and sends
no hut-leader request or assignment write until a real lodge returns.

1. Go to **Admin → Lodge Operations → Hut Leaders**. The amber **Upcoming Dates
   Without …** card lists booked nights with no leader; the calendar paints
   **Needs a Hut Leader** (red) and **Has a Hut Leader** (violet) nights.

   A night "needs a leader" **at one lodge**: it has a booking with at least one
   guest staying, and no assignment covering it at that lodge. Every lodge runs
   its own leader, so the same night can need one at Lodge A and be covered at
   Lodge B. This card is scoped to the lodge in the selector above it, so it only
   ever describes that one lodge.

   ![Hut Leader Assignments page showing the pick-the-nights calendar with "Needs leader" nights, the choose-the-leader step, and the assignments table](../images/admin/admin-hut-leaders.png)

2. **Pick the nights to cover** — set the **Start Date** and **End Date**, or click
   **Assign** on an upcoming-date card to pre-fill a single night.
3. **Choose the hut leader** — the page lists members eligible for that range
   (adopting their conflict-free suggested range), or you can pick any member.
4. Review the summary — nights covered, red nights it fills, and any conflicts —
   then click to confirm. An assignment overlapping an existing one by more than a
   day is blocked.

   **Exception: a school group's teachers do not block you.** When a school
   booking is approved, the app records one assignment per teacher. Those do not
   count against this rule, so you can deliberately put a club leader on the same
   nights as a school group if you judge that it needs one. Two consequences worth
   knowing. The eligible-members list still treats a school night as fully
   covered, so it will not suggest a range there even though confirming one is now
   accepted -- pick the member and set the dates yourself. And the nightly
   automatic assignment leaves those nights alone entirely: it never places a
   leader across a school group's nights, so if you want one there it has to be
   you who puts it there.

### Hold a bed for a custodian

Some clubs keep someone on site for a whole season — a custodian who lives in
the lodge without ever making a booking. An assignment can **hold one bed** for
its whole range to represent exactly that.

1. Pick the nights and the member as above. For a season-long custodian with no
   booking of their own, use the **Any member** tab.
2. In **Hold a bed (optional)**, choose the bed they sleep in. The default,
   **No bed — role only**, is the original behaviour and changes no capacity.
3. Confirm. From that moment the bed is out of the bookable pool and off the
   allocation board for every covered night — with **no booking anywhere**.

What a held bed does, and does not, do:

- **Members** simply see one fewer bed on the availability calendar for those
  nights. There is deliberately no custodian label on any member-facing screen.
- The **allocation board** draws a hatched *Custodian* band across the bed's
  cells. It is not a drop target, and the server refuses any placement onto it.
- The **lodge screen** shows a `Custodian` line in its footer while the
  assignment is running — the fixed word for every club, whatever your club
  calls the role in the admin area. On a handover night, when two people hold two
  beds, it reads `Custodians` with both names or, if either of them may not be
  named, with the count. A minor-age custodian is never named there at any
  name-display setting, and neither is anyone else once a minor is among them —
  naming one of two would identify the other by elimination.
- The custodian is **not a guest**: no chore-roster entry, no booking row, no
  invoice for the held bed. They can still make an ordinary booking of their
  own, anywhere — including at the same lodge.
- **Ending or shortening** the assignment frees the bed immediately; there is
  nothing to clean up.

**Changing your mind later.** The assignments table has two bed controls on each
row, so you never have to delete an assignment to change its bed:

- **Release bed** (the undo icon) hands the bed straight back to the bookable
  pool and keeps the assignment, its coverage record and its kiosk PIN. This is
  the button every "clear the bed first" message elsewhere in the app is asking
  you to press. It keeps working even if the `bedAllocation` module is later
  turned off — a bed held while it was on is still a real bed with someone in it.
- **Change bed** (the bed icon) opens the same picker in the row, checked against
  that assignment's own dates. It also works on rows the automatic assignment
  created, which never come with a bed.

> **The end date is a night, not a departure.** The hold covers the start date
> to the end date **inclusive** — the night of the end date included. The
> automatic assignment cron sets an assignment's end date to a guest's
> *check-out* day, which is a morning rather than a slept night, so adding a bed
> to one of those rows holds the bed for one night longer than anyone is there.
> Trim the end date by a day first.

### Manage assignments and kiosk PINs

1. In the assignments table, each row shows the member, the date range, and a
   status (**Active**, **Upcoming**, or **Past**).
2. Use the **key** icon to generate a new **kiosk PIN** — it is shown once and, if
   email is working, sent to the leader (their old PIN stops working). The PIN
   signs the leader in on the [Lodge Kiosk](lodge.md) device. Use the **trash**
   icon to delete an assignment.

> The PIN unlocks the shared kiosk for **10 minutes of no use** at a time, and
> there is a **Lock** button on the kiosk for walking away sooner. Continuous use
> keeps it unlocked — including all the way through the chore-roster wizard, so
> nobody is dropped mid-roster and nothing part-finished is lost. It will not
> stay unlocked past 12 hours from when the PIN was typed. Changing a PIN here
> ends every unlock made with the old one at once. See
> [Lodge Kiosk → When a hut leader unlocks the kiosk with their PIN](lodge.md#when-a-hut-leader-unlocks-the-kiosk-with-their-pin).

## Settings reference

| Control | What it does | Notes / constraints |
| --- | --- | --- |
| Start Date / End Date | The nights the leader covers | NZ date-only; an >1-day overlap with an existing assignment is blocked, EXCEPT against a school group's teacher assignments, which never block you |
| Eligible members list | Members whose bookings make them a natural fit | Adopts each member's conflict-free suggested range |
| Pick any member | Assign a member with no booking (e.g. a visiting custodian) | Keeps the range you picked |
| Hold a bed (optional) | Holds one bed for every covered night, with no booking | Default is **No bed — role only** (no capacity effect). Needs the `bedAllocation` module on to *set* a bed. Inclusive of the end date's night. Each choice names the bed type, so a double is obvious before you take it |
| Release bed (undo icon) | Hands the held bed back and keeps the assignment | Available whether or not the `bedAllocation` module is on — a hold made while it was on still occupies a real bed |
| Change bed (bed icon) | Opens the bed picker for that row's own dates | Works on automatically created assignments too, which never come with a bed |
| Reset kiosk PIN (key icon) | Issues a new kiosk PIN for that leader | Shown once; emailed if delivery works; old PIN is revoked |
| Delete (trash icon) | Removes the assignment | Frees those nights (they may go red again) |
| Lodge selector | Which lodge the whole workspace describes | Only shown with more than one active lodge. It scopes reads, bed choices and new assignments together |

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| The lodge list could not be loaded | The page cannot prove which lodge its reads or writes belong to | Press **Try again**. Assignment controls remain hidden until a real lodge returns |
| The dashboard says more uncovered nights than this page lists | Expected on a club with more than one lodge. The dashboard and the sidebar badge count **lodge-nights** across the whole club — one night with two uncovered lodges is two — while this page shows only the lodge in its selector. On a club with more than one lodge the dashboard names the lodge beside every date, so you can see where the extra ones are. A club with one lodge sees the same number in both places, with no lodge names | Switch lodges here to see the rest, or read the dashboard's dates, which name the lodge each belongs to |
| The dashboard lists an uncovered night at a lodge you have archived, shown as "*Lodge name*, archived" | Archiving a lodge stops new bookings but does not cancel the ones it already had. Those guests still arrive and still need a leader, so the night is still counted and is labelled archived. It will not clear itself: the nightly automatic assignment only ever assigns at active lodges | Decide which of the two you meant. To cover it, make the lodge active again (**Admin → Lodges**), assign a leader here, and archive it again afterwards. To be rid of it, cancel or move the remaining bookings at that lodge — the row goes when the last one does |
| Hut Leaders is missing from the sidebar / 404s | The `hutLeaders` module is off | Enable it under **Admin → Setup → Modules** — see [`CONFIGURATION.md`](../../CONFIGURATION.md#module-controls-and-admin-modules) |
| Everything is read-only ("… can view … but cannot change them") | Your admin role has lodge view but not edit | Ask a full admin for **lodge edit** access |
| "This member overlaps an existing assignment" | The range overlaps another leader's by more than a day. A school group's teacher assignments are excluded and never cause this | Shorten the range or delete the conflicting assignment |
| The label says "Custodian"/"Warden", not "Hut Leader" | The club renamed the hut-leader label in its identity settings | Expected — this page, the allocation board's band and every refusal message on screen all follow the club's label |
| The **lodge TV** says "Custodian" even though we renamed the role | Deliberate: the wall uses one fixed word for every club, so a visitor reads it without knowing the club's vocabulary | Expected. Only the public screen does this; every admin surface uses your label |
| A leader's PIN doesn't work on the kiosk | Their PIN was reset (old one revoked), or their kiosk account is ambiguous | Reset the PIN again; check the [Lodge Kiosk](lodge.md) account binding |
| The **Hold a bed** step is missing | The `bedAllocation` module is off, so the lodge has no rooms or beds to hold | Enable it under **Admin → Setup → Modules**, or leave the assignment role-only |
| "That bed already has guests allocated on …" | A guest is placed on that bed on one or more of the covered nights | Clear those nights on [Bed Allocation](bed-allocation.md) first, then set the bed here. Nothing is ever displaced automatically |
| "That bed is already held by another hut-leader assignment on …" | Two assignments want the same bed on the same night | A one-day handover overlap is fine, but only on **different** beds — give the incoming custodian another bed, or trim a date |
| "Holding that bed puts the lodge over capacity" | The lodge is already full on those nights | This is often correct — the custodian really is sleeping there. The card lists the nights and, separately, any live booking those figures could **not** count (an overridden booking still to settle), so read both before you confirm. Confirm to proceed, or free a night first |
| The bed is held for one night longer than expected | The dates came from the auto-assign cron, whose end date is a guest's *departure* day | Trim the end date by one day; the hold is inclusive of the end date's night |
| "Cannot deactivate/delete this bed while it is held by a hut-leader assignment" | A live or historic assignment holds that bed | Press **Release bed** on that row (or delete the assignment) first |
| The board shows a custodian-conflict warning | An allocation row is sitting on a held bed-night — usually written just before a deploy finished rolling out | Remove the allocation on [Bed Allocation](bed-allocation.md), or change the custodian's bed here |

## Related links

- Back to the [documentation hub](../README.md).
- Sibling guides: [Lodge Kiosk](lodge.md), [Chore Roster](roster.md),
  [Chore Templates](chores.md), [Lodges](lodges.md),
  [Bed Allocation](bed-allocation.md).
- Reference: [Admin and Lodge](../ARCHITECTURE.md#admin-and-lodge) and the
  `hut-leader-auto-assign` job in [Cron Jobs](../ARCHITECTURE.md#cron-jobs).
