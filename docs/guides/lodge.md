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

That last one is enforced by the server, not only hidden on the screen: a
check-in for a night the guest is not booked for is refused even if the request
reaches the server anyway, which is what a kiosk page left open since an earlier
night would send. When that happens the screen says the guest is not booked in
for that night and asks you to reload the day, rather than reporting a failure —
nothing is wrong with the kiosk, the page is just out of date.

The week strip and the day list count slightly different populations, on
purpose. The strip counts who can be **rostered**, so a booking still held by
an admin review is not in its numbers. The day list counts who is **in the
building**, so it does show that booking, marked "Blocked from Check-In". A
day can therefore read as empty on the strip and open onto a flagged party.

**Mark Departed** appears on every morning a guest actually leaves. On a stay
with a gap in it, that is more than once: someone booked in for Friday and again
for Monday leaves on Saturday morning and again on Tuesday morning, and each
check-out can be recorded on the day it happens. Until #2628 only the last one
could be — the earlier morning showed the **Departing** badge with no button —
so a guest who left and came back was recorded as leaving once, at the end.

**Mark Arrived** appears again when they come back. The kiosk holds one arrival
and one departure per guest — where they are *now*, not a diary of every trip —
so tapping **Mark Arrived** on the night they return records the new arrival and
clears the earlier check-out at the same time. Their name stops being greyed out
and the next **Mark Departed** records their next check-out. If the return
arrival is never recorded, the card still reads **Departed** on the following
departure morning: tap it once to clear that, and again to record the departure.

Checking someone out clears the **suggested** chores they can no longer do —
only up to the next night they are booked in for. Chores rostered for a later
part of the same stay are left alone, and any chore already **confirmed** is
never touched.

The **Who's at the lodge** panel that sits under an admin calendar counts
guest-**nights** rather than lodge days. On the chore roster calendar, whose
day colours *are* lodge days, the panel spells that difference out on screen;
the hut-leader assignment calendar is night-based throughout, so there is no
difference to explain there and it says nothing.

### Group Trips on the day list

**Audience: operator.**

Several separate bookings can belong to one travelling party — that is what a
Group Trip is, and it works whether or not your club shares adult cover between
those bookings. The day list says so, and how much it says depends on who is
looking at the screen.

**Anyone the kiosk shows the day list to** — including a guest who is staying
and signed in — sees a small **Group trip 1** chip on each card that belongs to
one trip. Cards carrying the same number are one party; different numbers are
different parties. The number is only a label for the list on screen: it is
counted from the top of that day's list, it changes from day to day, and it is
not the group's own reference. A card gets no chip at all unless another card in
front of you belongs to the same trip, because a lone chip would link to
nothing.

That chip is the whole of it for an ordinary guest. They are not told who
organised the trip, which booking or which adult is providing the required adult
cover, or the trip's join code — none of that reaches their screen, and it is not
hidden behind a tap or a tooltip either. It simply is not sent.

**A hut leader signed in with their PIN, and a full admin,** see two extra lines
on those cards:

- **who organises the trip** — the organiser's name, and which card is theirs.
  Nothing else about that account: no email, no phone number.
- **where the adult cover comes from** — how many of the booking's nights have a
  qualifying adult, and which kind of booking supplies them (the booking itself,
  another booking on the same account, or another booking in the same Group
  Trip). Cover is decided night by night, so "2 of 3 nights covered" is a normal
  and useful thing to read, and the uncovered nights are listed.

Both lines appear on Group Trip cards only. A booking that is not part of a
group carries neither.

The cover line is deliberately cautious. It reports what the club's adult-cover
rule last worked out, and where that answer cannot be trusted it says so instead
of claiming cover:

| What you see | What it means |
| --- | --- |
| *Adult cover: 2 of 3 nights covered* | The rule found a problem with this booking, and this is what it found. There is always at least one night it could not cover — a booking with no problem has nothing recorded at all, so you will never see "3 of 3" |
| *Adult cover: needs re-checking — the last check is out of date* | The last answer may no longer be right — because a related booking changed, because the recorded answer is waiting to be worked out again, or because the cover rested on another booking in the trip and we cannot yet confirm that booking has not changed |
| *Adult cover: last check could not be read* | The stored answer is not in a shape the kiosk can read — worth telling a Booking Officer |
| *Adult cover: no issue recorded for this booking* | Nothing has been recorded against this booking. That is the normal state for most bookings, and it is why this line is quiet grey rather than a warning. It is **not** a guarantee of cover |

Where a Booking Officer has already looked at a recorded problem, the card says
so underneath — *waiting for a Booking Officer's decision*, *a Booking Officer
has approved this*, or *a Booking Officer declined this*. Without that line an
arrangement an officer has already approved looks exactly like one nobody has
dealt with.

Until the Group Trip re-checking work is finished, cover that comes from another
booking in the same trip is reported as *needs re-checking* rather than as
cover. That is deliberate: the kiosk cannot yet tell whether that other booking
has changed, and it will not claim supervision it cannot stand behind.

**The cover line only appears at all where your club's adult member hosting
requirement is switched on.** If your club does not use that requirement, or has
switched it off, no cover line is shown on any card — rather than a row of
"not recorded" warnings about a rule you never turned on. The chip and the
organiser line are unaffected, because they do not depend on it. Switching the
requirement off does not delete what was recorded while it was on; the kiosk
simply stops reporting it, because it is no longer the rule.

A shared lodge wall device signed in as the kiosk account is treated as an
ordinary viewer for all of this: it shows the chip and neither extra line,
because anybody who walks past an unattended screen is that account.

**Read that carefully, because it is about the account and not about the
device.** The moment a hut leader signs in on that same wall tablet with their
PIN, the screen is showing a hut leader's view — organiser name and cover line
included — to whoever is standing in front of it, and it goes on doing so for as
long as that PIN session lasts. So sign out, or lock the screen, when you walk
away from it. How long a PIN session stays open, and how to end one deliberately,
is described where that session is set up rather than repeated here — see #3228.

The chip itself is not something you switch on. Any club that uses group
bookings gets it, because it only says that these cards arrived together — it is
not tied to the Group Trip adult cover setting, which is about who may supervise
whom.

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
| **Mark Arrived** answers "this guest is not booked in for this night" | The page has been open since an earlier night, so its buttons are stale | Reload the day. The guest's booking has a gap over the night on screen — they went home — and the refreshed list shows who is actually staying |
| The kiosk tablet's clock or time zone is set wrong | The device clock is separate from the club's calendar | Nothing to change for the kiosk: it takes "today" from the club's New Zealand day, so the week strip, the **Today** button and the night it opens on stay correct — and a kiosk left sitting on the week strip rolls onto the new day at the club's midnight without a reload (an open day list stays put; press **Today**). Fix the device clock only if people read the time off the tablet itself |

## Related links

- Back to the [documentation hub](../README.md).
- Feature hub: [Multi-lodge support](../multi-lodge/README.md).
- Sibling guides: [Hut Leaders](hut-leaders.md) (kiosk PINs),
  [Chore Roster](roster.md), [Lodge Instructions](lodge-instructions.md),
  [Lobby Display](display.md).
- Reference: the lodge kiosk/operations model in
  [Admin and Lodge](../ARCHITECTURE.md#admin-and-lodge).
