# Lobby Display

Audience: Operator

## What it is

The admin area behind the club's **lobby TV display** — a live, self-updating
noticeboard you hang on the lodge wall that shows arrivals, departures, who's in
which room, today's chores, and arrival information, all driven by data the system
already holds. This hub is where you pair screens, author what they show, and look
up the display vocabulary. Find it at **Admin → Lobby Display** (`/admin/display`).

The whole area is gated by the **`lobbyDisplay`** module, which is **off by
default**. The **Lobby Display** sidebar entry and every page below it appear only
once the module is enabled (**Admin → Setup → Modules**); until then the routes
return 404. This guide documents what ships on `main`: the hub and its five cards
— **Devices**, **Visual builder**, **Layouts (Advanced)**, **Templates**, and
**Reference** — plus the template **preview**. The lobby
display complements the interactive [Lodge Kiosk](lodge.md): the kiosk is a tablet
someone taps; the lobby display is a read-only screen the whole room reads at a
glance. For the deeper design and operating detail, see the
[Lobby Display feature hub](../lobby-display/README.md) and its
[operating guide](../lobby-display/operating.md) rather than duplicating them here.

## Three words you will meet

The admin uses three words for what is really two stored things. They are
defined the same way here, on the **Lobby Display** hub cards, and on the
**Reference** page:

- **Layout** — A Layout is the structural skeleton of a board: an HTML body with
  named areas and a default CSS block. It sets the shape, not the words.
- **Template** — A Template is a Layout filled in: content or an embedded module
  in each area, CSS layered over the layout default, and the footer. A Template
  is what you bind to a screen.
- **Board** — A board is what a lobby screen actually shows: a Template rendered
  on its Layout for the lodge that screen is paired to.

Only Layouts and Templates are stored — a board is the two of them on a screen,
which is why the **Visual builder** saves a Layout *and* a Template when you
compose one. The authoring model behind the split is
[ADR-003](../lobby-display/decisions/ADR-003-layout-template-authoring-model.md).

## When you'd use it

- You are hanging a new TV in the lodge lobby and need to pair it.
- You want to change what a screen shows — its board layout, content, or footer.
- A screen is showing the wrong lodge, a stale board, or the pairing screen, and
  you need to fix or revoke it.

## The quickest path: the guided setup wizard

If you are setting a screen up for the first time — or replacing a TV — use
**Admin → Lobby Display → Guided setup** (`/admin/display/setup`) instead of
working through the cards yourself. It is six steps in the order the job
actually happens:

1. **Module** — turn **Lobby TV display** on. This wizard is the one display
   page that stays open while the module is off, precisely so this step is
   reachable. Turning a module on needs system-settings (support) edit access;
   if your role has lodge access only, the step tells you who to ask.
2. **Built-in boards** — check that boards exist, and run **Restore built-in
   boards** if they do not. It never runs by itself, and it states exactly what
   it overwrites before it runs.
3. **Pick the board** — choose which board the TV will show, and open a preview
   of it as the lodge will see it (the preview opens in a new tab, so the wizard
   keeps your place). Nothing is bound to a screen yet, so browsing is safe.
4. **Lodge details** — fill in the handful of values the boards print (Wi-Fi
   name and password, checkout time, door code) and the on-screen notice. A
   value the board asks for but the lodge has not saved renders as a visible
   `⟨config:key?⟩` placeholder on the wall. Anything beyond these is edited on
   the lodge's full display settings, linked from the step.
5. **Pair the TV** — open the display URL on the screen, type the six-character
   code it shows, and the wizard creates the screen record, binds the board you
   picked, and arms the pairing in one go. The TV claims the code on its own
   check a few seconds later, so the step then **waits with you**: it re-reads
   your screens every few seconds and ticks over by itself, and there is a
   **Check again** button if you would rather not wait. Only ever one screen
   record is created, however many times a code is mistyped — a retry re-arms
   the same screen. If the board could not be assigned to it, the step says so
   rather than promising a board the screen is not showing. And if the choice
   you made at step 3 was lost (a reload, or another admin resuming), the step
   asks for the board again instead of quietly pairing onto the club default.
6. **Done** — this step only ticks once a paired screen has actually fetched its
   board with its own token. That is the proof the whole path works, not just
   the admin half of it. It re-checks itself every few seconds while it waits,
   and carries the same **Check again** button.

**Two things worth knowing.**

- **Every step checks real state**, not what you typed. You can leave and come
  back, run the wizard again after replacing a TV, and nothing you have already
  done is undone.
- **Where you got to is saved for the whole club, not for you personally.** The
  resume position is one record per wizard for the whole install, so another
  admin opening the wizard resumes from the same step, and the later of two
  admins to move wins. That was an accepted trade rather than an oversight: the
  position is only a hint about which step to open on, and because every step
  re-derives its own state, a clobbered position can never tick something off
  that has not actually happened. The wizard says so on every step.
  (Saving the position also needs finance access, which is what the underlying
  route is gated on. An admin without it still runs the whole wizard — it simply
  does not remember where they were between visits.)

**Where you find it.** While your club has no boards, or no working screen, the
Lobby Display hub leads with a gold **Guided setup** card. Once a screen is
live that card retires and the wizard stays available as an ordinary card in the
hub grid, and the **Help** panel on every Lobby Display page names it too.

The rest of this guide is the same ground, card by card, for when you want to
change one thing rather than set the whole thing up.

## Step-by-step

### 1. Turn on the module and open the hub

1. Enable **Lobby TV display** under **Admin → Setup → Modules** (it is off by
   default). The **Lobby Display** entry then appears in the sidebar.
2. Open **Admin → Lobby Display**. The hub cards through to **Devices**, the
   **Visual builder**, **Layouts (Advanced)**, **Templates**, and **Reference**.
   Most operators want the **Visual builder** — it composes a board without HTML
   (see below); the Layouts/Templates cards are the advanced, hand-authored path.

   ![Lobby Display hub showing the Devices, Visual builder, Layouts (Advanced), Templates, and Reference cards](../images/admin/admin-display.png)

### 2. Pair a screen (Devices)

1. Open the **Devices** card. It pairs lobby screens per lodge, assigns each a
   template, and sets each device's refresh interval; devices are read-only and
   individually revocable.

   ![Display Devices page showing the "Setting up a screen" steps, the Add a display device form, and the empty device list](../images/admin/admin-display-devices.png)

2. On the TV (or any browser on the screen device), open the club's `…/display`
   URL. The screen shows a **six-character pairing code**.
3. Create (or pick) a device below, type the code into its **Pair** box, and the
   screen connects itself within a few seconds. It keeps working across reboots
   until you **revoke** it. Per-lodge display values (guest-name granularity, the
   committee notice, and `{{config:key}}` values) are edited on each lodge under
   **Admin → Lodges → [a lodge] → display**, not here.

### 3. Compose a board without HTML (Visual builder)

1. Open the **Visual builder** card — the guided, no-HTML way to build a board and
   the path most operators should use. You pick a board **shape**, drop the
   **modules** you want (arrivals, room occupancy, chores, notices, and the rest)
   into its zones, and watch a **live preview** update as you go. When you save, the
   builder writes a valid **Layout** and **Template** for you, so you never touch
   `{{area:key}}` placeholders or CSS by hand. Bind the result to a screen on the
   **Devices** page exactly like any other template. For the full builder walk-through
   and the deeper authoring model, see the
   [Lobby Display feature hub](../lobby-display/README.md) — this guide keeps to the
   hub-level orientation rather than duplicating it.
2. Where you do type by hand — the builder's **Footer HTML** and **CSS
   overrides** fields, and a zone's **HTML block** — an **Insert token** button
   sits on the field's label row. It opens a searchable picker that inserts the
   right token **at the cursor** (replacing any selected text): on an HTML field
   the standard tokens (`{{lodge-name}}`, `{{display-date}}`) and the preview
   lodge's saved `{{config:…}}` keys, each row showing the value currently
   saved on that lodge, plus free-text entry that turns anything you type into
   `{{config:<your-key>}}`; on a CSS field the `var(--display-…)` and club
   brand tokens the **Reference** page lists. A key with no saved value can
   still be inserted — the picker warns that the wall will show a visible
   `⟨config:key?⟩` placeholder until the value is saved under
   **Admin → Lodges → [a lodge] → display**. The picker follows the **Preview
   lodge** selector and is fully keyboard operable (arrow keys, Enter to
   insert, Esc to close).

### 4. Author the structure by hand (Layouts — advanced)

1. Open the **Layouts** card. A **Layout** is the structural skeleton of a
   display: an HTML **body** with `{{area:key}}` placeholders, a **default CSS**
   block, and the named **areas** each Template will fill. Layouts define the
   shape; Templates supply the content.

   ![Display Layouts page showing the built-in layouts (Everyday board, Singles house, Whole lodge) and the New layout editor with Body HTML, Default CSS, and Areas](../images/admin/admin-display-layouts.png)

2. Most clubs never need to build a layout from scratch — the built-in layouts
   cover the common boards. Editing layouts is the advanced surface; see the
   [feature hub](../lobby-display/README.md) for the authoring model.

### 5. Fill a board by hand (Templates — advanced)

1. Open the **Templates** card. A **Template** fills a Layout's areas with content
   or embedded modules, layers CSS overrides on the layout default, and carries the
   footer. The gallery lists the **built-in templates** that ship ready to use;
   each has **Preview**, **Builder**, **Edit (Advanced)**, and **Delete**. This raw **Key / Layout / CSS**
   authoring flow is the **advanced** path — most operators should compose a board
   with the **Visual builder** (§3) instead, which produces the layout and template
   for them; reach for Templates directly only when you need hand control.

   ![Display Templates page showing the seven built-in templates — Everyday board, Whole lodge, Singles house, Room by room, Nights ahead, Lodge operations, and Welcome kiosk — each with Preview, Builder, Edit (Advanced), and Delete actions, above the New template form](../images/admin/admin-display-templates.png)

2. **If the gallery is empty, it now tells you why** rather than showing
   nothing. The built-in boards are created by the database seed, and upgrading
   the app does not re-run the seed — so a club whose database predates the
   lobby display has none of them. **Restore built-in boards** (next to *New
   template*) creates all seven, and can be pressed again safely. It asks first,
   because it is a *restore*: every built-in is rewritten to the design that
   ships with the app, so any change made to a built-in in place is lost. Your
   own layouts and templates are never touched, screens stay bound to whatever
   they already show, and the action is written to the audit log. The other two
   things an empty gallery can mean — the **Lobby TV display** module being
   switched off, or your admin role lacking lodge view access — are named on
   screen when they are what happened.
3. To use a built-in as a starting point, open it and **duplicate it to
   customise** — editing a built-in in place warns you, because a built-in is
   rewritten from code whenever the seed runs again or **Restore built-in
   boards** is pressed, and an in-place edit would be overwritten. A custom copy
   is yours to keep, and its key cannot be one of the seven reserved built-in
   keys (the create form refuses those, for the same reason).
4. To build one, set a lower-case **Key** (fixed after creation) and **Name**,
   choose the **Layout** it fills (locked once created), add optional **CSS
   overrides**, and a **Footer HTML**. Content and footers use `{{config:key}}`
   tokens (per-lodge values) and `{{module:name}}` embeds; external URLs,
   `@import`, and scripts are stripped on save. The CSS and footer fields carry
   the same **Insert token** picker as the Visual builder (§3): it offers the
   preview lodge's saved config keys and the theme's `var(--…)` tokens, and
   inserts at the cursor. A template stays lodge-agnostic — the picker only
   helps you type; it never binds the template to a lodge.
5. Bind the finished template to a screen on the **Devices** page — a template
   renders against whichever lodge its display is bound to.

### 6. Look up the vocabulary (Reference)

1. Open the **Reference** card — a read-only page (nothing here changes a setting)
   opening with the **Layout vs Template** definitions above, then
   listing the embeddable **modules** (`{{module:…}}`) and their CSS hooks, the
   **conditions** that gate areas (with a live true/false status for the selected
   lodge), and the **CSS tokens** (`var(--display-…)` and club brand tokens) you
   can use in authored CSS.

   ![Display Reference page listing the embeddable modules, area conditions with live status, and the display and brand CSS tokens](../images/admin/admin-display-reference.png)

### 7. Preview a template

1. From a template's **Preview** button, the template renders in a sandboxed frame,
   isolated from your admin session, against a chosen lodge. Opening the preview
   route on its own (with no template chosen) shows a prompt to open it from a
   template.

   ![Template preview page showing the "No template to preview" prompt and the Reload preview button](../images/admin/admin-display-preview.png)

2. The Visual builder's **Live preview** button uses the same sandboxed frame for
   your unsaved draft, so it is isolated from your admin session in exactly the
   same way. If a draft has a problem, the builder lists what to fix instead of
   opening a frame.

## Settings reference

| Page / card | What it controls | Notes / constraints |
| --- | --- | --- |
| Devices | Pairs and revokes lobby screens per lodge, assigns a template, sets refresh interval | Read-only screens; individually revocable; pairing uses a six-character code |
| Visual builder | Composes a board with no HTML: pick a shape, drop modules into zones, live preview; saves a valid layout + template | The recommended authoring path for most operators; deeper walk-through in the [feature hub](../lobby-display/README.md). The Footer HTML / CSS overrides / zone HTML fields carry the **Insert token** picker |
| Layouts (Advanced) | The structural skeleton: body HTML with `{{area:key}}`, default CSS, named areas | Advanced hand-authoring; built-in layouts cover the common boards |
| Templates | Fills a layout's areas with content/modules, CSS overrides, and footer | Advanced hand-authoring; Key fixed after creation; layout locked after creation; external URLs/`@import`/scripts stripped on save; the CSS/footer fields carry the **Insert token** picker |
| Reference | Read-only vocabulary: modules, area conditions (live status), CSS tokens | Changes nothing; for authoring reference only |
| Preview | Renders a template in a sandboxed frame against a chosen lodge | Isolated from the admin session; opened from a template's Preview |
| Per-lodge display values | Guest-name granularity, committee notice, `{{config:key}}` values | Edited on each lodge (**Admin → Lodges → [a lodge] → display**), not on this hub |

> Built-in layouts and templates are **code-managed**: they are written by the
> database seed, and rewritten from code whenever the seed runs again or an
> admin presses **Restore built-in boards** — *not* by upgrading the app, which
> re-runs neither. Customise by duplicating a built-in, not by editing it in
> place, and note that the seven built-in keys are reserved: a layout or
> template of your own cannot be saved under one. The full
> catalogue of built-in boards and embeddable modules is documented in the
> [Lobby Display feature hub](../lobby-display/README.md).

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Lobby Display is missing from the sidebar / every display page 404s | The `lobbyDisplay` module is off (the default) | Enable **Lobby TV display** under **Admin → Setup → Modules** — see [Modules](modules.md) and [`CONFIGURATION.md`](../../CONFIGURATION.md#module-controls-and-admin-modules) |
| The TV keeps showing the pairing code | The device wasn't bound, or its token was revoked | Enter the code into a device's **Pair** box; a revoked device returns to the pairing screen and must be re-paired |
| A screen shows another lodge's board | The device is bound to the wrong lodge | Re-pair/assign the device to the correct lodge on **Devices** |
| An area on the board is blank | Its template leaves the slot empty, or its condition is false | Check the template's areas and the **Reference** page's live condition status |
| My CSS or a link didn't take effect on save | External URLs, `@import`, and scripts are stripped for safety | Use the provided `var(--display-…)`/brand tokens and inline content only |
| Editing a built-in warns me | Built-ins are rewritten from code whenever the seed runs again or **Restore built-in boards** is pressed | Duplicate the built-in to a custom template and edit the copy |
| A key I want is refused as "reserved for a built-in board" | The seven built-in keys (`everyday-board`, `whole-lodge`, `singles-house`, `room-by-room`, `nights-ahead`, `operations-board`, `welcome-kiosk`) are reserved, because **Restore built-in boards** overwrites whatever is saved under them | Choose a different key — e.g. `foyer-board` |
| The gallery is empty and my club is an older install | The built-in boards are only created by the database seed, which upgrading does not re-run | Press **Restore built-in boards** on the **Templates** page |
| I am new to this and don't know which card to start with | Nothing is wrong — the cards are a menu, not an order | Use **Guided setup** (`/admin/display/setup`), which walks the whole path in the order it happens |
| The guided wizard opened on a step I didn't leave it on | The resume position is shared by the whole club, not per admin | Expected. Click any earlier step in the stepper; nothing is lost, because each step re-checks real state |
| Step 1 offers me no way to turn the module on | Changing modules needs system-settings (support) edit access; the rest of the wizard only needs lodge access | Ask an admin with support edit to turn on **Lobby TV display**, then reopen the wizard |
| The "Done" step won't tick although the screen is paired | The TV has not fetched its board yet — pairing alone is only the admin half | Leave the TV on the display page and leave the wizard open: it re-reads your screens every few seconds and ticks itself over. Use **Check again** to look now. If it never ticks after a couple of minutes, the screen has no route to the server |
| The wizard says my lodges could not be read | The lodges list did not load, or the club has no active lodge | Steps 3–6 stop rather than guess: a screen at another lodge is not this lodge's screen. Reload the page, and check **Admin → Lodges** has an active lodge |
| Step 4 warns that a saved value "is not text" | That `{{config:…}}` value was hand-edited (or imported) into the lodge's JSON settings as a number or a list | Display values are text; the save here can only write text and replaces the whole set, so it would remove them. Copy them somewhere first, or fix them on the lodge's own display settings, and skip step 4 |

## Related links

- Back to the [documentation hub](../README.md).
- Feature hub: [Lobby Display](../lobby-display/README.md) (with the
  [operating guide](../lobby-display/operating.md) and
  [design](../lobby-display/design.md)).
- Sibling guides: [Lodge Kiosk](lodge.md), [Lodge Instructions](lodge-instructions.md),
  [Lodges](lodges.md), [Modules](modules.md).
- Reference: the lodge kiosk/operations and lobby-display context in
  [Admin and Lodge](../ARCHITECTURE.md#admin-and-lodge).
