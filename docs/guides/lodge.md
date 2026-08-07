# Lodge Kiosk

Audience: Operator

## What it is

The shared sign-in for the physical lodge **kiosk** — the tablet at the lodge that
guests and hut leaders use to check in and out, see who's staying (including a
week-at-a-glance of daily guest counts), and view lodge information. This
page sets the kiosk account's email and password (and, for a
multi-lodge club, which lodge each kiosk device serves); it is **not** a personal
admin login. Find it at **Admin → Lodge Operations → Lodge Kiosk**
(`/admin/lodge`).

The kiosk account is a **lodge** permission area: lodge view to read, lodge
**edit** to change the account or add one. The page appears only when the `kiosk`
module is on.

## When you'd use it

- You are setting up the lodge tablet for the first time and need its sign-in.
- You want to rotate the kiosk password.
- (Multi-lodge) You are adding a kiosk for a second lodge and binding it to that
  property.

## Step-by-step

### Set the kiosk account

1. Go to **Admin → Lodge Operations → Lodge Kiosk**. The **Lodge Account Settings**
   card holds the kiosk's first/last name and email.

   ![Lodge Kiosk page showing the Lodge Account Settings card with the kiosk first name, last name, and email, plus the Preview kiosk and Edit buttons](../images/admin/admin-lodge.png)

2. Click **Edit**, set the **email** and a **New Password** (leave the password
   blank to keep the current one; minimum 6 characters), then **Save Changes**.
   Sign in once on the kiosk device with these details.

### Preview what the kiosk shows

1. Click **Preview kiosk** to open the kiosk exactly as this login would see it — a
   **read-only** preview, so nothing is saved.

### What "here today" means on the kiosk

Every count and badge on the kiosk answers one question: who is in the lodge on
this **day**. Everyone who stays a night is here from midday on the day they
arrive until midday on the day they leave, so a day's list holds the people
sleeping there tonight **and** the people who slept there last night and leave
this morning. **Departing** always means *leaves today* — on the day list, on
the week strip, and in the roster setup wizard, which reads the same list.

Two consequences worth knowing. A changeover morning is not an empty day: the
week strip shows a guest count and offers a roster, because the beds still need
stripping. And a stay with a gap in it — someone booked in for Friday and then
again for Monday — shows nobody on the days in between, because they went home.

The week strip and the day list count slightly different populations, on
purpose. The strip counts who can be **rostered**, so a booking still held by
an admin review is not in its numbers. The day list counts who is **in the
building**, so it does show that booking, marked "Blocked from Check-In". A
day can therefore read as empty on the strip and open onto a flagged party.

**Mark Departed** appears only on a guest's *final* departure — the morning
after their last booked night. On a stay with a gap in it, the earlier
departure morning shows the **Departing** badge without the button, because
check-out can only be recorded once, at the end of the booking.

The **Who's at the lodge** panel that sits under an admin calendar counts
guest-**nights** rather than lodge days. On the chore roster calendar, whose
day colours *are* lodge days, the panel spells that difference out on screen;
the hut-leader assignment calendar is night-based throughout, so there is no
difference to explain there and it says nothing.

### Multi-lodge: bind and add kiosk accounts

1. With more than one lodge, each account gains an **Operates lodge** selector.
   Bind a kiosk to the lodge its device lives at; an unbound account falls back to
   the club's **default lodge** (a warning flags this).
2. Use **Add a kiosk account** to create one per lodge. An account with staff
   access at more than one lodge is flagged **Ambiguous** and blocked from the
   kiosk until you set it to a single lodge.

## Settings reference

| Field | What it controls | Default | Notes / constraints |
| --- | --- | --- | --- |
| First Name / Last Name | The kiosk account's name | seeded "Lodge Kiosk" | Editable |
| Email | The kiosk sign-in email | seeded lodge email | Editable; this is a shared device login, not a personal one |
| New Password | Sets a new kiosk password | — | Minimum 6 characters; leave blank to keep current |
| Operates lodge | Which lodge this kiosk serves | Default lodge | Multi-lodge only; an unbound account uses the club default lodge |
| Preview kiosk | Opens the kiosk read-only as this account | — | No changes are saved |

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Lodge Kiosk is missing from the sidebar / 404s | The `kiosk` module is off | Enable it under **Admin → Setup → Modules** — see [`CONFIGURATION.md`](../../CONFIGURATION.md#module-controls-and-admin-modules) |
| Everything is read-only ("… can view the lodge kiosk accounts but cannot change them") | Your admin role has lodge view but not edit | Ask a full admin for **lodge edit** access |
| "Lodge account not found. Run the database seed to create it." | The kiosk account row is missing | Seed the database, or create the account (multi-lodge) |
| A kiosk account is flagged **Ambiguous** | It has staff access at more than one lodge | Set **Operates lodge** to a single lodge and save |
| A kiosk falls back to the wrong lodge | The account is not bound to a lodge | Bind it to its lodge under **Operates lodge** (multi-lodge) |
| The kiosk tablet's clock or time zone is set wrong | The device clock is separate from the club's calendar | Nothing to change for the kiosk: it takes "today" from the club's New Zealand day, so the week strip, the **Today** button and the night it opens on stay correct — and a kiosk left sitting on the week strip rolls onto the new day at the club's midnight without a reload (an open day list stays put; press **Today**). Fix the device clock only if people read the time off the tablet itself |

## Related links

- Back to the [documentation hub](../README.md).
- Feature hub: [Multi-lodge support](../multi-lodge/README.md).
- Sibling guides: [Hut Leaders](hut-leaders.md) (kiosk PINs),
  [Chore Roster](roster.md), [Lodge Instructions](lodge-instructions.md),
  [Lobby Display](display.md).
- Reference: the lodge kiosk/operations model in
  [Admin and Lodge](../ARCHITECTURE.md#admin-and-lodge).
