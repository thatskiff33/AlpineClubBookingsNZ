# Chore Roster

Audience: Operator

## What it is

The daily board that assigns the people in the lodge to its chores for a chosen
day. It auto-suggests a roster from your [chore templates](chores.md) and who is
here, lets you tweak it, confirm it, print it, and email each guest their
chores. Find it at **Admin → Lodge Operations → Roster** (`/admin/roster`).

"Here" means the lodge day, not the night. Everyone who stays a night is in the
lodge from midday on the day they arrive until midday on the day they leave, so
a guest checking out this morning is on this morning's roster — they slept here,
they ate breakfast here, and they are the obvious person to strip a bed or sweep
a bunkroom before they drive home. They can be given morning and anytime chores
but not evening ones; someone arriving that evening is the other way round.
A guest who needs to leave earlier than midday arranges it with the hut leader;
otherwise they get assigned.

The roster is a **lodge** permission area: lodge view to read, lodge **edit** to
generate, reassign, confirm, or email. The page appears only when the `chores`
module is on.

## When you'd use it

- A group is arriving and you want a chore roster ready for the night.
- It is a changeover day and you need the shutdown work covered by the people
  who are actually still there to do it.
- You need to reassign a chore because someone left early or a child can't do it.
- You want to email everyone their chores, or print the roster for the lodge wall.

## Step-by-step

### Pick a day

1. Go to **Admin → Lodge Operations → Roster**. Use the **Date** field or the
   calendar to choose a day. The calendar colours each day by roster status —
   **Needs roster**, **Suggested (unconfirmed)**, **Confirmed — some guests need
   chores**, and **Confirmed** — and the **Who's at the lodge** panel shows who is
   here. Someone arriving that evening carries an **Arriving** badge and someone
   leaving that morning a **Departing** badge. No times appear anywhere: the
   midday boundary is simply how a lodge day is defined, not something anyone
   records.

   The colours count the same lodge day the roster does, and they count the
   same **people** it does. A changeover morning is coloured **Needs roster**
   rather than left blank. A day is left uncoloured when nobody on it can be
   rostered — because the only member guests are still waiting to accept their
   invitation, or because the only booking is held by an admin review and so
   cannot check in. Either way the calendar can no longer say a roster is
   needed and then open with nobody to roster. The same two exclusions apply to
   the **Roster Assignment** count on the admin dashboard.

   One place deliberately does *not* hide them: the kiosk lodge list still
   shows a review-held booking's guests, marked "Blocked from Check-In", so the
   hut leader at the door can see who has been turned away. So a day can read
   as having no roster to do on the kiosk week strip and still open onto a list
   of flagged people. Both are right — one is asking who can be given a chore,
   the other who is standing in the building.

   The two numbers beside each other measure different things, which matters on
   a changeover day. The **Who's at the lodge** panel counts **guest-nights** —
   who sleeps here — so a day whose occupants all leave that morning shows zero
   there while the calendar colours it as needing a roster. Both are right: the
   beds are empty tonight and the kitchen still needs shutting down this
   morning. The panel says which of the two it is counting.

   ![Chore Roster page on a changeover day, showing the date picker and the staged whole-roster editor with departing guests from two booking groups alongside the group arriving that evening](../images/admin/admin-roster.png)

### Generate and adjust the roster

1. Click **Regenerate Roster** to auto-suggest assignments for the selected day.
   Tick **Include non-essential chores** first if you want the optional chores in
   as well. Regenerating a confirmed roster asks you to confirm — it replaces the
   confirmed roster with a fresh editable suggestion.
2. The roster opens read-only. Click **Edit roster** once to stage changes across
   the whole night. On each chore card, use the **guest** dropdown to reassign,
   **Remove** to drop a person, or **+ Add Person** to add a row. Nothing is
   written while you make these changes.
3. Review the always-visible **Chore staffing** and **Guest assignment check**
   summaries. Staffing names every active chore due that day as under, within,
   or over its recommended people count. The guest check keeps everyone in the
   lodge under their booking or family group and says whether they have no chore,
   one chore, or several (including repeated chores).
4. Click **Save roster** once to commit the complete draft, or **Cancel** to
   restore the last server-saved roster. Save returns every assignment to
   **Suggested**, ready for confirmation. If completed chores exist, the page
   warns before Edit and requires you to acknowledge that a successful Save will
   clear those completion marks; Cancel never clears them.

Within each booking/family group, guests linked to member records with a known
date of birth appear oldest to youngest. Equal dates use displayed-name order.
Guests whose date of birth is unknown follow in displayed-name order. The date of birth
is used only for ordering: it is never shown, and the age-tier label is not used
to guess it.

### Confirm, email, and print

1. Click **Confirm Roster** to mark all suggested assignments final.
2. Click **Email Roster to Guests** to send each affected guest their chores. A
   dialog lets you choose to **email** (which issues each guest a fresh 48-hour
   chore link) or **not email** (which sends nothing and leaves any previously
   sent chore links valid). Guests who opted out of chore-roster emails are always
   skipped. Only the **suppression** choice is written to the audit log (as
   "Admin suppressed the chore-roster email send"); an ordinary send leaves no
   audit record, by design.
3. Use **Print Roster** (top right) for a printable sheet for the lodge wall.
   Its headline reads "N guests on this roster", which is exactly the people in
   the chore table below it — the same lodge day, so on a changeover morning it
   counts the ones who leave before midday, because they are the ones the
   chores are assigned to. It is deliberately **not** a headcount of everyone in
   the building: a booking still waiting on an admin review is not rostered, so
   it is not in this number even though its guests may well be on site (the
   kiosk lodge list shows them, flagged).

## Settings reference

| Control | What it does | Notes / constraints |
| --- | --- | --- |
| Date / calendar | Selects the day the roster is for | NZ lodge days, midday to midday |
| Include non-essential chores | Adds optional chores when regenerating | Off by default; essential chores always included |
| Regenerate Roster | Auto-suggests assignments for the day | Includes arriving and departing guests; overwrites a confirmed roster only after you confirm |
| Edit roster | Opens one staged draft for the whole selected lodge night | Requires lodge edit; changing date/lodge or regenerating a dirty draft asks before discarding it |
| Guest dropdown / Remove / + Add Person | Stages a reassignment, removal, or addition | No request is sent until **Save roster** |
| Save roster / Cancel | Atomically commits the complete draft, or restores the saved snapshot | Save is available only after a valid change; a successful save makes every row Suggested |
| Confirm Roster | Marks all suggested assignments final | Assignments then read CONFIRMED |
| Email Roster to Guests | Emails each affected guest their chores | Issues fresh 48-hour chore links; opted-out guests skipped; only the suppress choice is audited (a send is not) |
| Print Roster | Opens a printable roster for the date | Opens in a new tab; respects the lodge filter |
| Lodge selector | Which lodge's roster you see | Only shown with more than one active lodge |

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| The page 404s / Roster is missing from the sidebar | The `chores` module is off | Enable it under **Admin → Setup → Modules** — see [`CONFIGURATION.md`](../../CONFIGURATION.md#module-controls-and-admin-modules) |
| A day is coloured **Needs roster** but **Who's at the lodge** shows no guest-nights | It is a changeover morning: everyone here leaves before midday, so nobody sleeps there that night | Nothing is wrong. The panel counts guest-nights, the colour counts the lodge day. Open the day and roster the shutdown chores |
| Everything is read-only ("… can view the chore roster but cannot change it") | Your admin role has lodge view but not edit | Ask a full admin for **lodge edit** access |
| "No one is in the lodge on this date" | No operational booking and eligible guest stay cover that lodge day — remember it covers the night itself AND the morning after | Pick a day with guests, or check the booking status, review state, consent, lodge, and individual stay nights |
| A chore says "No one assigned" | The current generated or saved roster has no retained row for that chore | Click **Edit roster**, use **+ Add Person**, choose a guest, and save the complete draft |
| A confirmed day still says some guests need chores | A booking in the lodge has no chore on it | Click **Regenerate Roster** to include it, or **+ Add Person** on a chore |
| "This roster changed while you were editing" | Another admin or lodge workflow changed the same night after you opened Edit | Your draft was not saved. Reload the latest roster and apply the change again |
| "This person is no longer eligible for this lodge night" | Their booking, lodge, stay nights, review state, consent, or active status changed while you edited | Keep the draft open, choose another eligible person, or reload the roster |
| Save says the service could not be reached | The request failed before the whole draft could commit | The draft remains on screen; try **Save roster** again |
| Confirm says a person or chore is no longer eligible/active | The booking or chore configuration changed after this roster was saved | Edit or regenerate the roster, then confirm the corrected result |
| Roster emails were not sent because a person or chore changed | The current roster is no longer safe to send | Reload or regenerate the roster before trying the email action again; no new chore tokens were created |
| The roster load fails | The selected lodge/night could not be loaded | The prior lodge/night is cleared; use **Try again** in the same card |
| A guest didn't get the email | They opted out of chore-roster emails, or delivery failed | Opted-out guests are skipped by design; check [Email Deliverability](email-deliverability.md) for failures |
| The roster lists "Guest 1", "School Child 2" instead of people | The booking still carries the placeholder names it was created with — a school/organisation booking or a member whole-lodge booking where nobody has filled the party in yet | Most bookers are chased automatically as check-in approaches, and the count appears on [Stuck States](stuck-states.md) as **Bookings with unnamed guests** — including the rows nobody chases, such as a school list already confirmed with its placeholder names. Open the booking and edit the names yourself — the chore and bed assignments follow the rename, because it is the same guest row. **The roster still generates, and the stay is never held up over this** |

## Related links

- Back to the [documentation hub](../README.md).
- Sibling guides: [Chore Templates](chores.md), [Hut Leaders](hut-leaders.md),
  [Rooms & Beds](rooms-beds.md), [Lodge Kiosk](lodge.md).
- Reference: the roster/chores model in
  [Admin and Lodge](../ARCHITECTURE.md#admin-and-lodge).
