# Bed Allocation

Audience: Operator

## What it is

A drag-and-drop board for placing approved bookings' guests onto individual beds
across a range of nights. You can let the system suggest placements
automatically, drag guests onto beds yourself, and approve the resulting
allocation. Find it at **Admin → Bookings & Beds → Bed Allocation**
(`/admin/bed-allocation`).

Bed allocation is gated by the **`bedAllocation`** module — when it is on, each
lodge's capacity is its active bed count. Editing needs **bookings edit**
access; a view-only bookings role can browse the board but not move, allocate,
approve, or save. Dates are NZ date-only lodge nights, and the board shows up to
31 nights at a time.

## When you'd use it

- The night before a busy weekend, to assign every guest to a specific bed.
- To let the system auto-allocate approved bookings, then review and approve.
- To move a guest from one bed to another, or free a bed by unallocating.
- To check which beds are free on a given night.

## Step-by-step

### Open the board and set the dates

1. Go to **Admin → Bookings & Beds → Bed Allocation**. Set **Date In** and
   **Date Out** (the range is capped at 31 nights) and click **Refresh** if
   needed. The header badges show the mode, room count, active bed count, and
   how many allocations exist.

   ![Bed Allocation board: the date controls and Allocation Mode card, the "Bookings approved, awaiting allocation" pool with Run Auto Allocation, and the room-by-night Allocation Board](../images/admin/admin-bed-allocation.png)

### Choose the allocation mode

1. In the **Allocation Mode** card, tick **Auto allocation enabled** to let the
   system propose placements, and optionally **Single-night drag mode** (when
   on, dragging a guest allocates only the night you drop on; when off, dropping
   allocates the guest's whole stay). Click **Save Mode**.

### Auto-allocate and approve

1. In **Bookings approved, awaiting allocation**, click **Run Auto Allocation**
   to apply the suggested placements (this button is available when
   auto-allocation is on and there are suggestions).
2. Review the resulting draft placements on the Allocation Board, then click
   **Approve Visible** to approve them. The "N draft allocations to approve"
   badge tracks how many are still draft.

### Allocate a guest by hand

1. In the awaiting-allocation pool, use a guest's **Select bed** dropdown and
   click **Allocate**, or drag the guest chip onto a bed cell on the
   **Allocation Board**.
2. To move a placed guest, drag their chip to another bed/night, or use the
   chip's menu → **Move to bed**. To free a bed, drag the chip back to the pool
   or use **Remove allocation**.

## Settings reference

| Control | What it does | Default | Notes / constraints |
| --- | --- | --- | --- |
| Date In / Date Out | The night range shown on the board | today to today + 7 | NZ date-only; range capped at 31 nights |
| Auto allocation enabled | Let the system propose bed placements | as saved | Persisted setting; enables Run Auto Allocation |
| Single-night drag mode | Drag allocates one night vs the whole stay | off | Client-side only, not saved |
| Save Mode | Persist the auto-allocation setting | — | — |
| Run Auto Allocation | Apply suggested placements | — | Needs auto-allocation on and suggestions available |
| Approve Visible | Approve the visible draft allocations | — | Disabled when nothing is unapproved |
| Select bed / Allocate | Place a guest on a chosen bed | — | Needs bookings edit access |
| Refresh | Reload the board | — | — |
| Lodge selector | Which lodge's board is shown | first/only lodge | Only shown with more than one active lodge |

Notes: bed types (single, bunk top/bottom, double) are descriptive and do not
change capacity; a double bed-night can hold two occupants (declared partners).
Bookings that hold an **exclusive whole-lodge hold** are not placed on
individual beds — the whole lodge is taken for their nights. Setting a hold on a
booking therefore **removes the bed assignments it already has**, including any
you placed by hand and any that were approved; the removed assignments are
recorded in the audit log, so you can rebuild them if the hold turns out to be a
mistake. Clearing a hold makes the booking ordinary again and re-plans its beds
automatically — but only when **Auto allocation enabled** is on. With
auto-allocation off, the guests come back to the awaiting-allocation list and
you place them yourself.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| A view-only notice, drag disabled | Your admin role can view but not edit bed allocation | Ask a full admin for bookings edit access |
| Bed Allocation is missing from the sidebar | The `bedAllocation` module is off | Enable it under **Admin → Setup → Modules** — see [`CONFIGURATION.md`](../../CONFIGURATION.md#module-controls-and-admin-modules) |
| **Run Auto Allocation** is disabled | Auto-allocation is off, or there are no suggestions | Tick **Auto allocation enabled** and **Save Mode**, then refresh |
| "No rooms available" / "No active beds" | Rooms and beds are not set up | Configure them in **Rooms & Beds** (via [Bookings Setup](bookings-setup.md)) |
| "That bed was just taken … refreshing" | Someone else allocated that bed-night at the same moment | The board reloads automatically; pick another bed |
| A focused booking is "not on the board" | The deep-linked booking is outside the date range or was cancelled | Adjust Date In / Date Out to bring it into view |

## Related links

- Back to the [documentation hub](../README.md).
- Sibling guides: [Bookings](bookings.md), [Waitlist](waitlist.md),
  [Bookings Setup](bookings-setup.md).
- Reference: the
  [bed allocation lifecycle](../STATE_MACHINES.md#bed-allocation-lifecycle), the
  [capacity model](../CAPACITY_MODEL.md#two-distinct-quantities) and its
  [admin surface](../CAPACITY_MODEL.md#admin-surface), and the
  [capacity locking discipline](../CONCURRENCY_AND_LOCKING.md#capacity-who-claims-who-releases-under-which-lock).
