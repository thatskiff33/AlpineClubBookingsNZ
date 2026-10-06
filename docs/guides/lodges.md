# Lodges

Audience: Operator

## What it is

The list of the club's lodge **properties**: their names, whether each is active,
and the address/door-code/travel-note that feed booking emails and the public
site. From here you add a lodge, edit its identity, deactivate it, or open its
**configuration hub** (rooms/beds, lockers, seasons & rates, and chores as cards,
plus per-lodge display settings as a section when the `lobbyDisplay` module is on).
Find it at **Admin → Setup & Configuration → Lodges** (`/admin/lodges`).

Lodges are a **lodge** permission area: lodge view to read, lodge **edit** to add,
edit, or deactivate. Member-facing screens only change once a **second active
lodge** exists — a single-lodge club sees no lodge pickers.

The same page also carries an **Other lodges** panel — a registry of every
club's lodges as the
[Alpine Central Server](integrations.md#connect-to-the-alpine-central-server)
distributes it (name, location, booking officer name and email, bed capacity,
website and booking details, season start dates, a facilities checklist and a
list of amenities). These are **not** the club's own lodges in the sense of the
properties above: they take no bookings and have no configuration hub. The
list arrives by download and is read-only, with one exception: **your own
lodge**, which the central server names for your site, has an **Edit my
Lodge** button that opens a popup for its details. Those are what every other
connected club sees for you. Which lodge is yours is set on the central server
by its operator, not here. Their names populate an **"Are you a member of
another lodge?"** drop-down on the public
[booking request form](booking-requests.md) (it defaults to **No**); the chosen
lodge is saved with the request for use when it is reviewed. The panel uses the
same **lodge edit** permission as the properties above.

## When you'd use it

- You are bringing a second lodge online and need to create and configure it.
- A lodge's address, door code, or travel note changed.
- A property is closing for the season and you want to stop new bookings against
  it.

## Step-by-step

### Review the lodge properties

1. Go to **Admin → Setup & Configuration → Lodges**. Each lodge shows its name, an
   **Active/Inactive** badge, and its travel note, with **Configure**, **Edit**,
   and **Deactivate/Activate** actions.

   ![Lodges page showing the "Example Mountain Club Lodge" property with its Active badge and the Configure, Edit, and Deactivate actions](../images/admin/admin-lodges.png)

### Add a lodge

1. Click **Add lodge**, enter a name, and save. A new lodge lands straight in a
   guided **setup wizard** (`/admin/lodges/[id]/setup`) with identity pre-filled;
   every remaining step can be skipped and completed later.

### Edit a lodge's identity

1. Click **Edit** on a lodge and set its **Name**, **Address**, **Door code**, and
   **Travel note**, then **Save**. The address feeds the public
   `{{lodge-address}}` content token; the door code and travel note appear in that
   lodge's booking and pre-arrival emails.

### Configure a lodge

1. Click **Configure** to open the lodge's hub (`/admin/lodges/[id]`), which cards
   through to [Rooms & Beds](rooms-beds.md), [Lockers](lockers.md), Seasons &
   Rates (in [Fees](fees.md)), and [Chores](chores.md). The **per-lodge display
   settings** are **not** a hub card — they appear as a separate section on this
   page only when the `lobbyDisplay` module is on (it is **off by default**; enable
   it under **Admin → Setup → Modules**). See [Lobby Display](display.md).
2. The **Member roster** card on the same hub opens this lodge's roster name
   setting (`/admin/lodges/[id]/roster`). Unlike the display section it is
   **always** shown, even while the Member lodge roster module is off, because
   you need to be able to choose how much of a name the roster would show
   before you switch it on. See [Modules](modules.md).

### Deactivate a lodge

1. Click **Deactivate**. If the lodge still has future bookings, waitlist entries,
   hut-leader assignments, or bound kiosk accounts, a pre-flight lists them and
   asks you to confirm — deactivating stops new bookings but leaves those in place.
   At least one lodge must stay active.

### Edit your own lodge's details

1. Scroll to the **Other lodges** panel below the lodge properties. Your own
   lodge's row carries an **Edit my Lodge** button (if the central server has
   given your site more than one lodge, each of those rows has its own button,
   named **Edit ‹lodge name›**). Click it. The form opens in a **popup over
   the page**, so the list stays where it is.
2. The **Name** is shown but cannot be changed: the central server matches
   lodges by name, so a new name would create a second lodge there. Fill in or
   change the **Location**, the **booking officer's** name, email and phone,
   the **Non-member booking page URL**, the **Bed capacity**, **Double beds**,
   **Single beds** and **Minutes' walk to the lodge**, whether guests sleep in
   a **Room** or a **Dormitory** (or **Not stated**), the **Cancellation
   period** and the dates its **winter** and **summer seasons start**, then
   **Save**.
3. Tick whatever applies under **Facilities** (an unticked box means *no*, not
   *unknown*), and add anything else the lodge offers under **Amenities** — one
   row per amenity, a name plus an optional description, up to fifty per lodge
   with no two names the same. A problem is reported inside the popup next to
   **Save**, so you can fix it without losing what you typed.
4. Close the popup with **Cancel**, the **×**, or **Esc** — this discards what you
   have typed. Clicking the dimmed page behind it does *not* close it, so a stray
   click cannot throw your work away, and while **Save** is working the popup
   cannot be closed. When it closes, keyboard focus goes back to the button that
   opened it.

Other clubs' lodges have no buttons: each club keeps its own entry up to date
and the central server distributes it, so there is nothing to add, edit or
delete here. The panel also shows **no booking officer phone numbers**, not even
your own lodge's (its phone is still in the popup, where you edit it) — a phone
number is private, and other clubs' numbers are not even sent to the browser.
A download never stores another club's officer phone either, and the next
download of a lodge clears a number an earlier one stored.

**Stated limit:** other clubs' phone numbers that earlier downloads already
stored stay in the database until that lodge's next download rewrites its row,
and they remain in database backups and in older audit entries made before this
release. No purge is built; this release stops new numbers arriving and clears
each stored one as its lodge is next downloaded.

**Three cases leave the panel with nothing to edit**, and the panel says which:

- *"Which lodge is yours is set on the central server…"* — the central server
  has not yet told this site which lodge is its own. That is so until the site
  is connected and has downloaded at least once: open **Integrations → Alpine
  Central Server**, connect, and press **Download**. (A club that never
  connects can no longer change its Other lodges list at all.) It is also what
  an older central server, which does not send the list, leaves you with.
- *"The central server has no lodge assigned to this site…"* — the server has
  answered, and the answer is none. Ask the central server's operator to assign
  your lodge to your site's connection.
- *"The central server names … as yours, but it has not been downloaded…"* —
  the server has named your lodge, but no entry of that name has arrived yet.
  Press **Download**; the **Edit my Lodge** button appears once the entry is
  here.

The list of which lodges are yours is forgotten when the site disconnects from
the central server, when its API key is replaced, or when the server address is
changed (which removes the key), because it was the previous connection's
answer; the panel is read-only again until the next download.

## Settings reference

### Lodge properties

| Field | What it controls | Default | Notes / constraints |
| --- | --- | --- | --- |
| Name | The lodge's display name | — | Required; up to 120 characters |
| Address | The property address | — | Optional; feeds the public `{{lodge-address}}` token (up to 300 chars) |
| Door code | The lodge access code | — | Optional; appears in that lodge's booking/pre-arrival emails (up to 80 chars) |
| Travel note | Directions / arrival notes | — | Optional; appears in booking/pre-arrival emails (up to 2000 chars) |
| Active | Whether the lodge takes new bookings | on | At least one lodge must stay active; inactive lodges are kept for history |
| Configure | Opens the per-lodge configuration hub | — | Hub cards: rooms/beds, lockers, seasons & rates, chores. Per-lodge display is a separate section, shown only when the `lobbyDisplay` module is on (off by default) |
| Member roster name detail | How much of a name other members see for this lodge on the member lodge roster | Use the default (full names) | Per lodge, on the hub's **Member roster** card. Four levels: full names, first name plus surname initial, first names only, or counts with no names. Separate from the lobby display's guest name setting, and editable while the Member lodge roster module is off. Whatever you choose, these never name anyone: a booking that includes a child, a booking by an organisation, a booking that hired the whole lodge, and a party of eight or more that was the only booking in the building on every one of its nights |

### Other lodges

| Field | What it controls | Default | Notes / constraints |
| --- | --- | --- | --- |
| Name | The lodge's display name | — | Set on the central server; shown read-only, because the server matches lodges by name |
| Location | Where the other lodge is | — | Optional; up to 300 characters |
| Booking officer's name | Contact person at the other lodge | — | Optional; up to 200 characters |
| Booking officer's email | Contact email | — | Optional; must be a valid email; up to 320 characters |
| Booking officer's phone | Contact phone | — | Optional; up to 50 characters. Editable in the popup for your own lodge; never shown in the list, and other clubs' numbers are not sent to this site's browser at all |
| Bed capacity | Informational bed count of the other lodge | — | Optional; whole number 0–100000. Not this system's booking capacity |
| Double beds / Single beds | Informational counts of each kind of bed | — | Optional; whole number 0–100000 each |
| Minutes' walk to the lodge | How long the walk in takes, in minutes | — | Optional; whole number 0–100000 |
| Room or dormitory | Whether guests sleep in private rooms or a dormitory | Not stated | A choice of **Room**, **Dormitory** or **Not stated** |
| Non-member booking page URL | Where a non-member books the other lodge (the list's **Booking page** column) | — | Optional; up to 500 characters; must start with `http://` or `https://` because it is shown as a link (anything else is refused). Server API 2.1 replaced the old free-text **How to book** field with this one link |
| Cancellation period | Free text, e.g. "14 days" | — | Optional; up to 200 characters |
| Winter season starts / Summer season starts | The calendar date each season opens | — | Optional; a real date, stored and shared as a date with no time, so it is never shifted by time zone |
| Facilities | Requires a lodge custodian, free wifi, quiet room, drying room, shared kitchen, wheelchair accessible, breakfast / lunch / dinner included, ski workshop area, games room | all off | Yes/no each; *off* means **no**, and existing lodges start with every box off |
| Amenities | Anything else the lodge offers | none | Up to 50 per lodge; each has a name (up to 120 characters, unique within the lodge ignoring case) and an optional description (up to 1000 characters). Saving replaces the whole list |

Every field in this table is shared with other clubs through the
[Alpine Central Server](integrations.md#connect-to-the-alpine-central-server)
when that connection is on; that page says what leaves the club. Only your own
lodge's entry is uploaded, and only your own lodge's entry can be edited here. If that
connection is on, **the central server has to be upgraded before this site**:
an older central server refuses an upload that names fields it does not know,
so **Upload** (and the nightly sync, which also skips that night's download
while its upload is failing) reports **Central server error: Invalid upload
payload** until the server is upgraded. Nothing needs resetting afterwards.

The names recorded here are what the public booking-request form offers under
*"Are you a member of another lodge?"*, and what a booking officer picks from
when charging a visiting club's members at your member rate — see
[Bookings → Charge a visiting club's members at your member rate](bookings.md#charge-a-visiting-clubs-members-at-your-member-rate).
Lodges are never deleted here: the list is the central server's.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Everything is read-only ("… can view the lodge properties but cannot change them") | Your admin role has lodge view but not edit | Ask a full admin for **lodge edit** access |
| Deactivate warns about dependencies | The lodge still has future bookings, waitlist, hut-leader, or kiosk ties | Review the list; confirm to deactivate anyway (they stay in place) or resolve them first |
| "At least one lodge must stay active" | You tried to deactivate the only active lodge | Keep one active, or activate another first |
| Member screens don't show a lodge picker | The club has only one active lodge | Expected — pickers appear once a second active lodge exists |
| Door code/travel note isn't in an email | The lodge's field is blank, or the email template omits the token | Fill the field here; check the [Booking Messages](booking-messages.md)/email template |
| The Other lodges panel has no **Edit my Lodge** button and says which lodge is yours is set on the central server | The site has not yet downloaded from a central server that names its lodge (not connected, never downloaded, or an older server) | Connect on **Integrations → Alpine Central Server** and press **Download**; the button appears for the lodge the server names |
| The Other lodges panel says no lodge is assigned to this site | The central server's operator has not mapped a lodge to your site's connection | Ask them to assign your lodge |
| Saving your lodge is refused with "Only this site's own lodge can be changed here" | The central server's list changed since the page loaded, or a download that ran while you were editing recorded a list that no longer names it | Reload the page; only the lodge(s) the server names for your site can be saved |
| The panel went read-only after a download, although the server names your lodge | Two downloads ran at once (the nightly job and the **Download** button) and the one that finished last carried an older list | Nothing to fix: the next download records the current list again |
| The panel says syncing with the Alpine Central Server is paused and the list may be out of date | The central server is on a different software version from this site, so nothing is sent or received until the two match (an edit you save here stays local until then) | Open **Integrations → Alpine Central Server**, which shows both numbers, and upgrade whichever side is behind; syncing resumes on its own |

## Related links

- Back to the [documentation hub](../README.md).
- Feature hub: [Multi-lodge support](../multi-lodge/README.md)
  ([feature overview](../multi-lodge/feature-overview.md)).
- Sibling guides: [Rooms & Beds](rooms-beds.md), [Lockers](lockers.md),
  [Chores](chores.md), [Lodge Kiosk](lodge.md).
- Reference: [Adding a Second Lodge](../../CONFIGURATION.md#adding-a-second-lodge)
  and [Admin and Lodge](../ARCHITECTURE.md#admin-and-lodge).
