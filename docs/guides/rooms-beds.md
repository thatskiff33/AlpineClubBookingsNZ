# Rooms & Beds

Audience: Operator

## What it is

The bed inventory for a lodge: the rooms it has, the beds in each room, the
bed types (single, bunk, double), and the **allocation preferences** that decide
how guests are fitted into them. This inventory is what the club's bookable
capacity is summed from, and it is what the Bed Allocation board hands guests to.
Find it at `/admin/rooms-beds`. It has **no direct sidebar entry** — rooms and
beds are lodge-scoped (ADR-005), so you reach this page from the **lodge
configuration hub**'s **Rooms & Beds** card (**Admin → Setup & Configuration →
Lodges →** a lodge **→ Rooms & Beds**), which opens it already filtered to that
lodge. There is also a **← Bookings Setup** back-link at the top, because rooms
and beds are the physical side of booking setup.

Although this page lives in the **Lodge Operations** area, its data flows through
the bed-allocation APIs, which enforce the **bookings** permission area: you need
**bookings edit** to add or change rooms and beds, and a bookings view-only role
sees it read-only. The page appears only when the `bedAllocation` module is on.

## When you'd use it

- You are setting up a lodge's rooms and beds for the first time.
- You added a bunk room, converted singles to a double, or took a room offline
  for the season and need capacity to reflect it.
- You want to check the club's total bookable capacity, room by room.
- You want to change how the board decides who goes where — whether it proposes
  placements at all, and what it tries to keep together first.

## Step-by-step

### Open Rooms & Beds for a lodge

1. From the lodge configuration hub, open a lodge and click its **Rooms & Beds**
   card (or go to `/admin/rooms-beds`). The header shows three badges — the room
   count, a **beds** badge (the sum of the lodge's active beds, its physical
   inventory), and a **Capacity** badge. The two are **distinct quantities**: the
   beds badge is how many beds are installed, while **Capacity** is the *resolved*
   bookable figure — `min(active beds, the lodge's configured capacity ceiling)`.
   When the ceiling is unset or above the bed count the two match (and the badge is
   green); when the ceiling caps the beds the Capacity badge is lower and turns
   amber. The ceiling itself is **not** typed here — it is the lodge's capacity
   setting, edited on the lodge configuration page. See the
   [capacity model](../CAPACITY_MODEL.md#two-distinct-quantities).

   <!--
     ALT TEXT DESCRIBES THIS CAPTURE, NOT THE PAGE. The image predates #2937 and
     does not yet show the Allocation preferences card at the foot of the page;
     saying it does would make the substitute a screen-reader user relies on
     wrong rather than merely stale. Re-run `npm run docs:screenshots` and, in
     the same change, extend the alt text to end "…and the Allocation
     preferences card at the foot of the page".
   -->
   ![Rooms & Beds page showing the room/bed/capacity badges, Quick Add Rooms, and the Room Inventory list with Bunk Room A, Bunk Room B, and the Family Room](../images/admin/admin-rooms-beds.png)

### Seed several rooms at once

1. In **Quick Add Rooms**, set **Rooms** (how many), **Beds per room**, and a
   **Name prefix**, then click **Create**. This seeds the rooms and their beds in
   one go; rename or adjust them individually below.

### Add or edit a room

1. In **Room Inventory**, use the top row (**Room name**, a capacity number,
   **Notes**, **Active**) and click **+ Add Room**.
2. On an existing room, change its name, notes, or **Active** state and click
   **Save**. Deactivating a room takes its beds out of the bookable capacity but
   keeps them for history.

### Add or edit beds in a room

1. In a room, use the bed row (**Bed name**, a sort number, a **bed type**, and
   **Active**) and click **+ Add Bed**.
2. Choose the **bed type** — Single, Bunk (top), Bunk (bottom), or Double. Pair a
   bunk top with its bottom so the board groups them; a lone bunk shows a soft
   unpaired hint until you add its partner. Click **Save** on the row to store
   changes, or the trash icon to remove a bed.

### Set this lodge's allocation preferences

Allocation preferences are **per lodge**, and they never cross a lodge boundary
even in a single-lodge club. The card sits at the bottom of this page and reads
the lodge chosen at the top, so what you edit is always the lodge you are
looking at.

1. Choose the lodge at the top of the page. If the lodge selector is still
   loading, could not load, your role cannot choose a lodge at all, or the club
   has no active lodge, the card says which of those it is and offers nothing to
   change — it never falls back to "some lodge". (A single-lodge club has no
   selector to use: that lodge is simply the one you are editing.)
2. In **Allocation preferences**, click **Edit**. Tick **Auto allocation
   enabled** if the Bed Allocation board and the booking lifecycle should
   propose placements for this lodge.
3. Put the enabled preferences in the order you want them compared. Drag a row
   or use its up/down buttons; **Disable** removes it from the comparison and
   **Enable** adds it back at the bottom.
4. Click **Save**. It is disabled until something changed, and **Cancel**
   restores the saved snapshot. Saving changes what is *proposed* from now on —
   it never moves a guest who is already placed.

   **If you switch to a different lodge while editing, your unsaved changes are
   discarded** rather than carried across. That is deliberate: preferences you
   staged for one lodge must never be saved onto another.

   **If a save is refused, the card says why**, and your staged changes stay in
   edit mode so you can correct the problem and click **Save** again. It repeats
   the club system's own explanation — for example that the lodge is no longer
   active. Four refusals have their own wording:

   - An admin role that can view bookings but not change them is told its role
     cannot make changes. On a failed **load**, a role that cannot even view
     bookings is told that instead.
   - If your sign-in has expired while this page sat open, the card says so and
     tells you to sign in again — in another tab is fine — rather than blaming
     anything about the club's settings.
   - If somebody switches **Bed Allocation** off while you have the page open,
     the card says the module is switched off and that someone who can manage
     Feature modules can turn it on.
   - If the reply cannot be read at all — a gateway error page rather than an
     answer from the club system — the card falls back to "Failed to save
     allocation preferences" rather than showing raw technical output.

The shipped preference order, and what each one means, is in
[Bed Allocation](bed-allocation.md#how-the-preferences-are-compared).

## Settings reference

| Field | What it controls | Default | Notes / constraints |
| --- | --- | --- | --- |
| Rooms / Beds per room / Name prefix (Quick Add) | Seeds a batch of rooms and their beds | — | Integers; rename individually afterwards |
| Room name | The room's display name | — | Required; shown on the bed board and roster |
| Room capacity | The room's bed count field | — | Integer; the header **beds** badge sums this lodge's active beds. The separate **Capacity** badge is the resolved bookable figure — `min(active beds, the lodge's configured ceiling)` — not a room field |
| Room notes | A free-text note on the room | — | Optional |
| Room Active | Whether the room's beds count toward capacity | on | Inactive rooms are kept for history but not bookable |
| Bed name | The bed's label | — | Required; unique within its room |
| Bed sort | The bed's order within the room | — | Integer; controls list/board order |
| Bed type | Single, Bunk (top), Bunk (bottom), or Double | Single | A bunk top pairs with its bottom; a double adds partner-shared headroom (`CAPACITY_MODEL.md`) |
| Bed Active | Whether the bed counts toward capacity | on | Inactive beds are kept for history but not bookable |
| Auto allocation enabled | Let the board and booking lifecycle propose bed placements for the selected lodge | on | Saved per lodge; enables **Run Auto Allocation** on the Bed Allocation board |
| Allocation preference order | Compare feasible layouts from top to bottom | booking cohesion → stay continuity → requested room → direct-family cohesion | Drag or use up/down while editing; each item can be disabled. Advisory only — never a safety override (`INV-CAP-008`) |
| Allocation Edit / Save / Cancel | Stage, persist, or discard this lodge's allocation preferences | — | Needs bookings edit; Save is dirty-gated; switching lodge discards an unsaved draft |

> The **beds** badge and the **Capacity** badge are two different things (see the
> [capacity model](../CAPACITY_MODEL.md#two-distinct-quantities)). The beds badge
> is the physical inventory — every active bed across active rooms. **Capacity** is
> the resolved bookable figure: `min(active beds, the lodge's configured capacity
> ceiling)`. The ceiling is the lodge's capacity setting (typed on the lodge
> configuration page, not here); leave it unset and Capacity simply follows the
> bed count. A lodge can legitimately have more installed beds than it may sleep —
> e.g. 10 beds with an 8 ceiling makes the Capacity badge read **8**, and the page
> warns that the extra beds stay available for allocation but cannot be booked
> into. See the model for how doubles and overrides combine on top.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| I can't find Rooms & Beds in the sidebar | It has no direct sidebar entry (lodge-scoped) | Open **Lodges → [a lodge] → Rooms & Beds**, from **Bookings Setup**, or go to `/admin/rooms-beds` |
| The whole page is read-only | Your admin role has bookings view but not edit | Ask a full admin for **bookings edit** access (rooms/beds use the bed-allocation APIs) |
| The page 404s / is missing | The `bedAllocation` module is off | Enable it under **Admin → Setup → Modules** — see [`CONFIGURATION.md`](../../CONFIGURATION.md#module-controls-and-admin-modules) |
| Capacity looks too low/high | A room or bed is inactive, or a double/bunk is counted differently than expected | Check each room's and bed's **Active** state and bed types against the [capacity model](../CAPACITY_MODEL.md) |
| Capacity is **lower than the beds badge**, and the page warns "Sleeping capacity capped below the installed beds" | The lodge's configured capacity ceiling is below the active bed count, so Capacity = the ceiling (`capped_beds`). The surplus beds stay allocatable but cannot be booked into | Intended? Leave it. To lift the cap, raise or clear the lodge's capacity on the **lodge configuration page** ([Lodges](lodges.md)) — see [the capacity model](../CAPACITY_MODEL.md#two-distinct-quantities) |
| Capacity is **lower than the capacity I set on the lodge**, and no cap warning is shown | The configured capacity is **above** the active bed count, so the beds are what bind. This is allowed and deliberate: capacity is the lower of the two | Activate more beds here to raise the effective capacity, up to the configured number. Do **not** lower the lodge's capacity to match the beds to make the figures agree: the surplus is what the lodge's partner-shared double-bed spots are measured against, so that removes them. What the capacity field says as you type, and why, is in [the capacity model](../CAPACITY_MODEL.md#admin-surface) |
| The page warns "Capacity fallback active" and uses the lodge's capacity setting | Bed Allocation is on but **no active beds** are configured, so bookable capacity falls back to the lodge's capacity setting until at least one active bed exists | Add at least one active bed here, or set the fallback capacity on the [Lodges](lodges.md) configuration page |
| **Allocation preferences** shows a sentence instead of the settings | The page has no single lodge settled, and the card says which of four reasons it is: "Loading lodge…", "The lodge list could not be loaded…", "…your admin role cannot choose one", or "This club has no active lodge…" | Retry the lodge list with **Try again** if it failed; ask for lodge access if your role cannot choose one; add an active lodge on the [Lodges](lodges.md) page if the club has none |
| My allocation preference edits vanished | You switched lodge before saving | Re-choose the lodge and make the change again. Unsaved edits are discarded on a lodge switch so they cannot be written to the wrong lodge |
| A bunk shows an "unpaired" hint | Its partner bunk bed has not been added yet | Add the matching Bunk (top)/(bottom) bed in the same room |
| "Cannot deactivate this bed while current or future allocations exist on … (name)" | A guest is allocated to this bed on the dates listed, and the message names them. "Current" includes **last night**, because that guest is in the lodge until midday today | Move or remove those allocations on the [Bed Allocation](bed-allocation.md) board first, then deactivate |
| "Cannot delete this bed while allocations exist on … (name)" | Deleting a bed is refused while it has **any** allocation, past ones included — the database keeps that history and will not let the bed go | Deactivate the bed instead, which takes it out of the bookable pool and keeps the history. Delete is only for a bed nobody has ever been placed in |
| "Cannot deactivate this bed while it is held by a hut-leader assignment (…)" | A hut leader has been given this bed for the dates listed, so it is out of the bookable pool and someone is genuinely sleeping in it | Release or move the bed on the [Hut Leaders](hut-leaders.md) page — the **Release bed** button on that assignment's row — then deactivate |
| "This bed is held by a hut-leader assignment and cannot be deleted" | The same thing, on a delete. The database refuses it outright, so there is no way to force it | Release the bed on the [Hut Leaders](hut-leaders.md) page first; the assignment itself does not have to be deleted |
| "Cannot deactivate this room while one of its beds is held by a hut-leader assignment (…)" | A hut leader holds one of the room's beds | Release that bed on the [Hut Leaders](hut-leaders.md) page, then deactivate the room |
| "A bed in this room is held by a hut-leader assignment, so the room cannot be deleted" | Deleting a room deletes its beds, and one of them is held | Release the bed on the [Hut Leaders](hut-leaders.md) page first, then delete the room |

## Related links

- Back to the [documentation hub](../README.md).
- Feature hub: [Multi-lodge support](../multi-lodge/README.md).
- Sibling guides: [Bed Allocation](bed-allocation.md), [Bookings Setup](bookings-setup.md),
  [Chores](chores.md), [Lodges](lodges.md).
- Reference: the [capacity model](../CAPACITY_MODEL.md#two-distinct-quantities),
  the [Booking Dates And Capacity](../invariants/booking-dates-and-capacity.md)
  invariants, and the [Admin and Lodge](../ARCHITECTURE.md#admin-and-lodge)
  architecture.
