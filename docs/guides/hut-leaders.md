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

1. Go to **Admin → Lodge Operations → Hut Leaders**. The amber **Upcoming
   nights with no hut leader staying** card lists the coming nights that have
   guests but no leader staying; the calendar paints **Guests, no hut leader
   staying** (red, labelled **No hut leader tonight**) and **Hut Leader
   staying** (violet) nights. Every one of these uses your club's own word for
   the role, set under **Admin → Club identity**.

   A night "needs a leader" **at one lodge**: it has a booking with at least one
   guest staying, and no leader **assigned to that night and staying that night**
   at that lodge. Every lodge runs its own leader, so the same night can need one
   at Lodge A and be covered at Lodge B. This card is scoped to the lodge in the
   selector above it, so it only ever describes that one lodge. See
   [What counts as a covered night](#what-counts-as-a-covered-night) below.

   ![Hut Leader Assignments page showing the pick-the-nights calendar with nights that need a leader, the choose-the-leader step, and the assignments table](../images/admin/admin-hut-leaders.png)

2. **Pick the nights to cover** — set the **Start Date** and **Last night**, or click
   **Assign** on an upcoming-date card to pre-fill a single night.
3. **Choose the hut leader** — the page lists members eligible for that range
   (adopting their conflict-free suggested range), or you can pick any member.

   **A hut leader must be staying every night they cover.** The dates are
   nights: the end date is the last night the leader sleeps at the lodge, never
   the day they leave. If you pick a night the member is not staying at this
   lodge — the morning they check out, a night between two of their stays, or a
   stay that has been cancelled — the page refuses it, names the first night
   they are not staying and offers **Change last night to …** with their last
   night stayed. There is no override. Only paid (or completed) stays count,
   and only nights the member is a **guest** on: owning a booking they are not
   on does not count. A custodian is the one exception: tick **Custodian (lives
   on site)**, or hold a bed for them (see below).
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

### What counts as a covered night

A hut leader's duty is one **night**: from midday on that day to midday the next
morning, the same boundary a guest's stay uses. A night is covered only when
both of these are true:

- an assignment includes the night, **and**
- the person on it is **in the lodge that night**.

"In the lodge" means different things for different assignments:

| Assignment | Counts as in the lodge on… |
| --- | --- |
| An ordinary member (assigned by hand or automatically) | the nights of their own paid stay at **this** lodge. A cancelled, bumped, archived or unpaid stay counts for nothing, and neither does a stay at another lodge, or a stay as another member's guest that they have not yet confirmed |
| A custodian — ticked **Custodian (lives on site)**, or holding a bed | every night the assignment covers. They live in the lodge, so no booking is needed |
| A school group's teacher | the assignment's own dates, arrival to the night before departure, as recorded when the school booking was approved. These assignments are not linked back to the booking: if the school booking is later cancelled or moved, its teachers still count on the original nights until you delete or change their assignments here |

An assignment for someone who is neither a custodian nor staying covers nothing,
and the page refuses to save one.

So an assignment that runs past the leader's departure does **not** cover the
nights after they leave. Older automatic assignments were recorded through the
leader's check-out day; those check-out nights now show red if other guests are
still staying, with no clean-up needed — the assignment itself is unchanged.

The calendar shows who is on duty each half of a changeover day:

- **AM · Smith until midday** — a leader of the night before finishes at
  midday.
- **PM · Jones from midday** — a leader of tonight starts at midday.
- **No hut leader tonight** — guests are staying and nobody is assigned and
  staying.

A day shows the AM/PM lines only when the two nights have different leaders,
including the first and last day of a stint. A plain surname means a leader on
duty all day: on a one-night overlap, the leader who stays on is shown plainly
beside the one arriving or leaving, never as leaving. On a phone the lines drop
"until midday" / "from midday" so the name still fits; a screen reader always
hears the full wording. The admin dashboard lists the coming week's handovers —
a day on which a leader finishes at midday and another is on duty from midday —
under **Handovers this week**, and its **Nights without a hut leader staying**
card gives each uncovered night with its guest count.

### Assign a custodian

Some clubs keep someone on site for a whole season — a custodian who lives in
the lodge without ever making a booking.

1. Pick the nights, then pick the member on the **Any member** tab.
2. Tick **Custodian (lives on site)**. A custodian counts as staying every night
   the assignment covers, with no booking, and takes **one space** off the
   lodge's capacity on each of those nights — members see one fewer space on the
   calendar. The tick is there whether or not your club uses bed allocation.
3. If your club uses bed allocation, you can also **hold a bed** for them (below)
   so the allocation board shows which bed is theirs. A custodian with a bed
   still takes only one space.
4. Confirm. If the lodge is already full on any of those nights, the page shows
   the nights and asks you to confirm first; if another booking has the whole
   lodge, you are asked before its sole occupancy is narrowed by one space.

Without the tick or a bed, an assignment for someone who is not staying is
refused. **No bed — role only** is only for a leader who is staying on a booking.

A custodian with no bed who is also a guest on a booking at the same lodge is
one person, so they take **one space** on those nights, not two. Their place on
the booking is their space, and a full night still has room for that booking. While
bed allocation is on, a custodian who holds a bed keeps that bed, so a booking
of their own needs another one; with it off, nothing separates the two, so they
are one space too.

**Marking an existing assignment as custodian.** Each row in the assignments
table has a **Custodian (lives on site)** button (the house icon). Press it to
mark that row a custodian, or press it again to untick. Use it for a custodian
created before the tick existed, typically one who holds a bed but was never
ticked: tick them first, then **Release bed** if you want to stop holding the
bed. Unticking, or releasing the bed of an unticked row, is refused if the
member has no stay on those nights, and the message says to mark them
Custodian first.

### Hold a bed for a custodian

With bed allocation on, an assignment can **hold one bed** for its whole range.

1. Pick the nights and the member as above.
2. In **Hold a bed (optional)**, choose the bed they sleep in. The default,
   **No bed — role only**, holds no bed.
3. Confirm. From that moment the bed is out of the bookable pool and off the
   allocation board for every covered night — with **no booking anywhere**.

While bed allocation is off, the page does not offer **Hold a bed** or
**Change bed** at all; **Release bed** stays, so a bed held earlier can still be
handed back.

What a held bed does, and does not, do:

- **Members** simply see one fewer bed on the availability calendar for those
  nights. The calendar carries no custodian label; the roster (below) does.
- The **allocation board** draws a hatched *Custodian* band across the bed's
  cells. It is not a drop target, and the server refuses any placement onto it.
- The **lodge screen** and the members' **Who's at the lodge** roster show
  every custodian — ticked, holding a bed, or both, counted once — while the
  assignment is running. The screen's footer line reads `Custodian`, the fixed
  word for every club, whatever your club calls the role in the admin area. On
  a handover night, with two custodians, it reads `Custodians` with both names
  or, if either of them may not be named, with the count. A minor-age custodian is never named there at any
  name-display setting, and neither is anyone else once a minor is among them —
  naming one of two would identify the other by elimination.
- The custodian is **not a guest**: no chore-roster entry, no booking row, no
  invoice for the held bed. They can still make an ordinary booking of their
  own, anywhere — including at the same lodge.
- **Ending or shortening** the assignment frees the bed immediately; there is
  nothing to clean up.
- A **whole-lodge hold does not cover the custodian's bed.** When a booking has
  the lodge to itself, the custodian's bed is not part of what that group has —
  they have every other bed. Nothing about the group's dates, their price or
  what members see changes; the lodge still reads as full on those nights.

> **If the lodge is already held for those nights, you will be asked first.**
> Holding a bed on a night another booking has taken the whole lodge for means
> that group gives up one bed. Rather than doing that quietly, the page stops
> and shows you the nights, with two choices:
>
> - **Accept and hold the bed** — the assignment is created and the other
>   booking's sole occupancy is narrowed by that one bed on those nights, as a
>   single recorded action. Their dates and what they pay do not change.
> - **Cancel** — nothing changes at all, on either side.
>
> It only works in that direction. Putting a whole-lodge hold on a booking over
> nights a custodian already holds needs no question and asks none: the
> custodian's bed was never part of the hold.

**Changing your mind later.** The assignments table has two bed controls on each
row, so you never have to delete an assignment to change its bed:

- **Release bed** (the undo icon) hands the bed straight back to the bookable
  pool and keeps the assignment, its coverage record and its kiosk PIN. This is
  the button every "clear the bed first" message elsewhere in the app is asking
  you to press. It keeps working even if the `bedAllocation` module is later
  turned off — a bed held while it was on is still a real bed with someone in it.
  The held bed is what let the member lead without a stay, so releasing it from
  an unticked row whose member is not staying is refused: press **Custodian**
  on the row first.
  With the module **off** you cannot see or choose beds, so an edit that moves a
  bed-holding assignment to other nights or another lodge is refused — release
  the bed first (or in the same change), or turn bed allocation back on.
- **Change bed** (the bed icon) opens the same picker in the row, checked against
  that assignment's own dates. It also works on rows the automatic assignment
  created, which never come with a bed.

> **The end date is a night, not a departure.** The hold covers the start date
> to the end date **inclusive** — the night of the end date included. Every new
> assignment's end date is the last night its leader sleeps there, and the
> automatic assignment writes the night before check-out, so adding a bed holds
> it for exactly the nights covered. An older row may still end on the check-out
> day; trim it before adding a bed.

### Manage assignments and kiosk PINs

1. In the assignments table, each row shows the member, the date range, and a
   status (**Active**, **Upcoming**, or **Past**).
2. Use the **key** icon to generate a new **kiosk PIN** — it is shown once and, if
   email is working, sent to the leader (their old PIN stops working). The PIN
   signs the leader in on the [Lodge Kiosk](lodge.md) device. Use the **trash**
   icon to delete an assignment.

> **When a leader can sign in.** From the day before their first night until
> midnight on the day they leave — the day after their last night. That covers
> their own account, the kiosk PIN and the lodge instructions alike, judged on
> the club's calendar.

> The PIN unlocks the shared kiosk for **10 minutes of no use** at a time, and
> there is a **Lock** button on the kiosk for walking away sooner. Continuous use
> keeps it unlocked — including all the way through the chore-roster wizard, so
> nobody is dropped mid-roster and nothing part-finished is lost. It will not
> stay unlocked past 12 hours from when the PIN was typed. Changing a PIN here
> ends every unlock made with the old one at once. See
> [Lodge Kiosk → When a hut leader unlocks the kiosk with their PIN](lodge.md#when-a-hut-leader-unlocks-the-kiosk-with-their-pin).

### Dietary and allergy notes on the kiosk

When the club collects **Dietary/allergy information**, the lodge kiosk's day
list shows each present guest's value for **that stay** under their name — but
only to the **hut leader** running the stay (signed in on their own account, or
unlocked with their PIN on the lodge device) and to a full admin. The value is
the booking's own copy, not the member's profile; booking officers can correct
it on the booking page (see
[Bookings](bookings.md#dietaryallergy-information-for-a-stay)).

The unattended **lodge** screen, a guest staying at the lodge, the lobby wall,
the chore roster and an admin previewing a kiosk account never receive the
values at all. **While a hut leader's PIN unlock is live on the shared device,
anyone standing at that device can read them** — the same exposure the PIN
unlock already has for guests' phone numbers. Press **Lock** when you walk
away.

## Settings reference

| Control | What it does | Notes / constraints |
| --- | --- | --- |
| Start Date / Last night | The nights the leader covers | NZ date-only nights; the last night is the last night stayed, never the leave day. Every night must be one the member is staying at this lodge as a guest, unless the assignment is ticked **Custodian (lives on site)** or holds a bed. An >1-day overlap with an existing assignment is blocked, EXCEPT against a school group's teacher assignments, which never block you |
| Eligible members list | Members whose bookings make them a natural fit | Adopts each member's conflict-free suggested range |
| Pick any member | Assign a member who is not in the suggestions (e.g. a custodian) | Keeps the range you picked. A member with no stay on those nights can be assigned only as a custodian (the tick) or with a held bed |
| Custodian (lives on site) | Marks the leader as living at the lodge | Counts as staying every covered night with no booking, and takes one space off capacity on each (once, even with a bed). Available with bed allocation on or off. Never set by the automatic assignment or a school booking |
| Hold a bed (optional) | Holds one bed for every covered night, with no booking | Default is **No bed — role only** (no capacity effect unless ticked custodian). Only offered while the `bedAllocation` module is on. Inclusive of the end date's night. Each choice names the bed type, so a double is obvious before you take it. If a booking already has the whole lodge on any covered night, you are asked to accept narrowing it by that one bed before anything is written |
| Custodian (house icon, on a row) | Ticks or unticks **Custodian (lives on site)** on an existing assignment | Same capacity questions as the form. A leader who is also a guest on a booking here stays one space on those nights. Unticking a row with no bed and no stay is refused, and the message says to keep them marked or shorten or delete the assignment. Works with bed allocation on or off |
| Release bed (undo icon) | Hands the held bed back and keeps the assignment | Available whether or not the `bedAllocation` module is on — a hold made while it was on still occupies a real bed. Refused on an unticked row whose member is not staying: tick Custodian first |
| Change bed (bed icon) | Opens the bed picker for that row's own dates | Works on automatically created assignments too, which never come with a bed |
| Reset kiosk PIN (key icon) | Issues a new kiosk PIN for that leader | Shown once; emailed if delivery works; old PIN is revoked |
| Delete (trash icon) | Removes the assignment | Frees those nights (they may go red again). A held bed goes straight back to the bookable pool, and any booking holding the whole lodge on those nights covers it again |
| Lodge selector | Which lodge the whole workspace describes | Only shown with more than one active lodge. It scopes reads, bed choices and new assignments together |

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Holding a bed says the lodge is exclusively held on some nights | Another booking has taken the whole lodge for those nights, so holding this bed takes one bed off them | Read the nights listed. **Accept and hold the bed** (or **Accept and save**, when it is the custodian tick and no bed) does both changes together and records them; **Cancel** leaves everything exactly as it was. If the other booking should not have the lodge to itself, clear its whole-lodge hold on the booking first and try again |
| The lodge list could not be loaded | The page cannot prove which lodge its reads or writes belong to | Press **Try again**. Assignment controls remain hidden until a real lodge returns |
| The dashboard says more uncovered nights than this page lists | Expected on a club with more than one lodge. The dashboard and the sidebar badge count **lodge-nights** across the whole club — one night with two uncovered lodges is two — while this page shows only the lodge in its selector. On a club with more than one lodge the dashboard names the lodge beside every date, so you can see where the extra ones are. A club with one lodge sees the same number in both places, with no lodge names | Switch lodges here to see the rest, or read the dashboard's dates, which name the lodge each belongs to |
| A night shows red although it is inside an assignment | The assigned leader is not staying that night — they left that morning, their stay was cancelled or moved, or they are staying at a different lodge. A night is covered only when its leader is assigned **and** staying | Assign someone who is staying that night, or correct the leader's booking. If the assignment is an older automatic one ending on its leader's check-out day, nothing needs fixing: the check-out night was never theirs |
| The dashboard lists an uncovered night at a lodge you have archived, shown as "*Lodge name*, archived" | Archiving a lodge stops new bookings but does not cancel the ones it already had. Those guests still arrive and still need a leader, so the night is still counted and is labelled archived. It will not clear itself: the nightly automatic assignment only ever assigns at active lodges | Decide which of the two you meant. To cover it, make the lodge active again (**Admin → Lodges**), assign a leader here, and archive it again afterwards. To be rid of it, cancel or move the remaining bookings at that lodge — the row goes when the last one does |
| Hut Leaders is missing from the sidebar / 404s | The `hutLeaders` module is off | Enable it under **Admin → Setup → Modules** — see [`CONFIGURATION.md`](../../CONFIGURATION.md#module-controls-and-admin-modules) |
| Everything is read-only ("… can view … but cannot change them") | Your admin role has lodge view but not edit | Ask a full admin for **lodge edit** access |
| "The member is not staying at this lodge on the night of …" | One of the nights is not one they sleep at this lodge: usually the last night is their check-out day, a stay has been cancelled, or they own the booking but are not a guest on it | Press **Change last night to …** to end on their last night stayed, or pick a member who is staying. To assign someone who lives on site, tick **Custodian (lives on site)** (or the row's Custodian button for an existing assignment). Pressing **Release bed** gives this message when the member is not staying: press **Custodian** on the row first |
| "Counting this custodian puts the lodge over capacity" | A custodian takes a space, and the lodge is already full on those nights | Read the nights listed and confirm if the custodian really is there, or free a night first |
| "This member overlaps an existing assignment" | The range overlaps another leader's by more than a day. A school group's teacher assignments are excluded and never cause this | Shorten the range or delete the conflicting assignment |
| The label says "Custodian"/"Warden", not "Hut Leader" | The club renamed the hut-leader label in its identity settings | Expected — this page, the allocation board's band and every refusal message on screen all follow the club's label |
| The **lodge TV** says "Custodian" even though we renamed the role | Deliberate: the wall uses one fixed word for every club, so a visitor reads it without knowing the club's vocabulary | Expected. Only the public screen does this; every admin surface uses your label |
| A hut leader signed in on their own account sees "You are not the hut leader at any lodge on this date" | None of their assignments covers the date they opened (from the day before the first night to the day after the last). On their own account a leader is shown the lodge whose assignment covers **that date** — never the club's default lodge, and never another lodge's guests | Open a date inside their assignment, or extend the assignment here |
| A hut leader sees "You are hut leader at more than one lodge on this date" | Two of their assignments, at different lodges, cover the same day, so the kiosk cannot tell which lodge's guests to show. A changeover is fine: when one assignment ends on the 10th and the next starts on the 11th, the 10th shows the lodge whose assignment actually covers it, and a departure day shows the lodge they are leaving | Trim one assignment so each day belongs to one lodge |
| The kiosk shows no dietary notes | The field is switched off under **Member Fields**, the kiosk is on the plain lodge screen (not a hut leader's unlock), or no guest has a value for this stay | Unlock with the hut leader's PIN; check the field is on; a booking officer can fill values in on the booking page |
| A leader's PIN doesn't work on the kiosk | Their PIN was reset (old one revoked), or their kiosk account is ambiguous | Reset the PIN again; check the [Lodge Kiosk](lodge.md) account binding |
| The **Hold a bed** step is missing | The `bedAllocation` module is off, so the lodge has no rooms or beds to hold | Enable it under **Admin → Setup → Modules**, or leave the assignment role-only |
| "That bed already has guests allocated on …" | A guest is placed on that bed on one or more of the covered nights | Clear those nights on [Bed Allocation](bed-allocation.md) first, then set the bed here. Nothing is ever displaced automatically |
| "That bed is already held by another hut-leader assignment on …" | Two assignments want the same bed on the same night | A one-day handover overlap is fine, but only on **different** beds — give the incoming custodian another bed, or trim a date |
| "Holding that bed puts the lodge over capacity" | The lodge is already full on those nights | This is often correct — the custodian really is sleeping there. The card lists the nights and, separately, any live booking those figures could **not** count (an overridden booking still to settle), so read both before you confirm. Confirm to proceed, or free a night first |
| The bed is held for one night longer than expected | The last night is inclusive — it is the last night held, not the day the custodian leaves. Older assignments, including older automatic ones, may still end on the check-out day | Set the last night to the last night they sleep there |
| "Cannot deactivate/delete this bed while it is held by a hut-leader assignment" | A live or historic assignment holds that bed | Press **Release bed** on that row (or delete the assignment) first |
| The board shows a custodian-conflict warning | An allocation row is sitting on a held bed-night — usually written just before a deploy finished rolling out | Remove the allocation on [Bed Allocation](bed-allocation.md), or change the custodian's bed here |

## Related links

- Back to the [documentation hub](../README.md).
- Sibling guides: [Lodge Kiosk](lodge.md), [Chore Roster](roster.md),
  [Chore Templates](chores.md), [Lodges](lodges.md),
  [Bed Allocation](bed-allocation.md).
- Reference: [Admin and Lodge](../ARCHITECTURE.md#admin-and-lodge) and the
  `hut-leader-auto-assign` job in [Cron Jobs](../ARCHITECTURE.md#cron-jobs).
