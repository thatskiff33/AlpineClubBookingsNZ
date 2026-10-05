# Page Content

Audience: Operator

## What it is

The editor for your database-backed public website pages — About, Join, Rules,
Contact, Privacy, FAQ, and any custom pages — including their menu order,
publishing state, rich text, and content tokens. Find it at **Admin →
Setup & Configuration → Site Appearance & Content → Page Content**
(`/admin/page-content`). It has no direct sidebar entry — open it from the
**Page Content** card on the Site Appearance & Content hub.

It also holds two site-wide controls: which **authoritative fee and policy
blocks** may be published by content tokens, and the public header's **Book Now**
button. Page Content is edited under the **content** permission area.

## When you'd use it

- You want to reword a public page (About, Rules, FAQ) or add a new page.
- You need to take a page you added off the public site, either temporarily
  (**Hide**) or for good (**Delete**).
- You need to change what shows in the public site menu or its order.
- You want a page to publish authoritative fees or a booking policy via a token,
  or to point the **Book Now** button somewhere specific.

## Step-by-step

### Edit or add a page

1. Open **Page Content**. Each **Editable Page** card shows the page title, its
   `/slug`, badges (**SYSTEM**, **NO MENU**, **Has content**), the **Menu
   order**, and the last-updated time.

   ![Page Content showing the Editable Pages grid (Club Lodge, About, Join, Apply for Membership, Rules, Contact Us, Committee, Privacy Policy, Terms of Service, FAQ, Page Not Found), the Public fee and policy blocks checkboxes, and the Book Now button controls](../images/admin/admin-page-content.png)

2. Click **Edit &lt;page&gt;** to open its editor, change the title, menu title,
   menu order, rich-text content (with content tokens such as
   `{{member-application-form}}`, `{{contact-form}}`, `{{booking-requests}}`,
   `{{school-bookings}}`, or `{{committee-members-cards}}` — the editor's token
   help button lists every token the page supports), and its published state. Use
   **+ Add Page** to create a new page.
3. Every page the starter site ships (Home, About, Join, Apply, Rules, Contact,
   Booking Requests, School Bookings, Committee, Privacy, Terms, FAQ, and the
   **System** pages Club Lodge `/home` and Page Not Found `/404`) cannot be
   hidden or deleted, because a code route serves each of them and the footer or
   the sitemap links most of them. Only pages you add yourself can be hidden or
   deleted; a hidden page returns 404 to the public and drops out of the site
   menu. System pages additionally keep their fixed slug and menu order. If a
   built-in page ever shows a **Hidden** badge (only possible from hand-edited
   data), its card offers a one-click **Publish** to repair it — until then the
   public site treats the content as absent: `/contact`, `/join`, `/join/apply`,
   `/booking-requests` and `/school-bookings` fall back to their built-in copy
   and forms, and `/home` answers 404.

   **Booking Requests and School Bookings are the two that are not advertised
   by default**, and they are the reason the menu title is worth understanding.
   Both ship with an empty menu title, which keeps each page out of your site
   menu *and* tells search engines not to list it. Give either page a menu title
   and it joins the menu and becomes searchable together — one field, both
   effects, so the two can never disagree. Clear the menu title and both
   reverse. Neither page is in the sitemap in either state; the menu is what
   advertises them. The addresses themselves never change, so the links your club
   has already shared, and the confirmation emails the system sends, keep
   working whichever you choose.

   You can also drop either form onto a page of your own with the
   `{{booking-requests}}` or `{{school-bookings}}` content token. If you do, that
   page keeps its own privacy behaviour — the form is served under that page's
   security settings and analytics, not the special handling the dedicated
   `/booking-requests` and `/school-bookings` pages get. Those two dedicated pages
   are the ones that never load analytics and always get a fresh per-visit
   security token, because they are where a visitor types the most personal
   information; a form you embed elsewhere follows the page it sits on.

### Hide a page, or delete it

**Hide** is the reversible one. The page and everything you wrote stay exactly
where they are; the public site stops serving that address and drops the page
from the menu, and **Publish** on the same card brings it straight back. Use it
whenever the page might come back — a seasonal notice, a trip report you are
still drafting, a page you want to check with the committee first.

**Delete** removes the page and its content permanently. There is no recycle bin
and no Restore button. Use it when the page was a mistake or is genuinely
finished with — for example a mistyped slug you want to recreate correctly.

Both controls appear only on pages you added yourself. Delete asks you to
confirm, and the confirmation tells you three things before you commit:

- the address that disappears;
- whether the page is live on the public site right now, in which case that
  address starts returning "page not found" straight away — the change is
  immediate for visitors, not on a delay;
- anything else in your content that points at it: other pages whose text links
  to that address and any **footer** section that links to it (those links will
  break — and the footer is on every public page), and whether the header's
  **Book Now** button is pointing at this page, in which case the button's
  setting is changed back to the booking flow for you. If the footer or the
  **Book Now** setting could not be read at that moment, the confirmation says
  that check could not be run rather than staying quiet, so you can look
  yourself before you confirm.

The link check looks for the page's address in your other pages' text and in the
three footer sections you edit under **Site Content**. It is deliberately
generous — a page mentioning a longer address that starts the same way is listed
too — because a warning that misses a real link is worse than one that mentions
an extra page. It has one blind spot, which the confirmation also mentions: a
link written as a *relative* address (`../trip-reports` rather than
`/trip-reports`) is not found, so check any link you wrote that way yourself.

Four things worth knowing:

- **The address is free again immediately.** Recreating a page at the same slug
  works straight away, which is the normal repair for a typo. If anyone outside
  the club had linked to the old page, that link will start working again and
  show whatever the new page says.
- **Every deletion is recorded in the audit log**, including the page's full
  content at the moment it was removed, and that record is kept for seven years.
  It is not a Restore button — recovering a page means an administrator reading
  the content back out of the audit entry and retyping it — but nothing is lost
  without a trace. Three caveats about what that record can hold, because each is
  the privacy protection working as designed rather than a fault: text shaped
  like `password: ...` has that value redacted, and if the page contains
  something the log treats as a *secret* — a membership-cancellation link, a
  provider API key, a signed token — the whole page body is replaced by
  `[REDACTED]` in the record rather than just that fragment. Likewise a run of
  13 to 19 digits that passes the card-number check (a Luhn-valid number) is
  replaced by `[REDACTED_CARD]`. A page holding any of these is a page whose content you should keep a copy of elsewhere before
  deleting it. **You are told when it happens:** if the record could not keep
  the whole page — redacted, or too large for the record to hold — the message
  after the delete says the copy in the audit log is not complete. The page is
  still deleted; treat the message as the moment to save the wording from
  wherever else you have it (a draft, another open tab), not later. If someone
  edited the page just before you deleted it, the record holds their edit: it
  is a copy of the page as it was at the moment it was removed.
- **A configuration bundle exported before the deletion will bring the page
  back.** Importing a bundle creates any page it names that is not currently
  present, and that includes a page you have since deleted — so a clone, or a
  rebuild from an archived bundle, re-plants it. This is the same exposure
  [`UPGRADING.md`](../UPGRADING.md) records for the starter-content cleanups
  (issue #2511), and the same habit fixes it: export a fresh bundle after you
  delete a page, and replace any archived bundle you would restore from.
- **Rarely, the message says the page was deleted but the public site's stored
  copy could not be cleared.** That means exactly what it says: the page is gone
  from the club's records, but the old address may keep answering from the
  website's stored copy. Do **not** delete it again: it is already deleted, and
  a second attempt will simply say the page cannot be found. Don't wait for it
  to clear on its own, either — the stored copy is not on a timer, and the site
  can keep handing it out until something clears it. Saving any page (an edit,
  or **Hide** / **Publish**) clears the whole stored copy of the public site,
  the deleted address included. A visit to the address once its stored copy is
  more than about five minutes old also starts a refresh, so the visit after
  that one sees the change. Then check the address again.
- **Two officers deleting the same page at once** is safe: one delete goes
  through and the other is told the page cannot be found. Nothing is deleted
  twice and only one record is written.

Deleting a page never deletes the images it used. Those live in the Image
Manager and have their own delete, with its own warnings.

### Enable authoritative fee/policy blocks

1. Under **Public fee and policy blocks**, tick the families a token is allowed
   to publish: **Joining fees**, **Annual membership fees**, **Hut fees**,
   **Booking policy summaries**, and **Cancellation policies**. A token renders
   no authoritative data until its family is enabled here (and membership types
   must also be individually marked for public listing).
2. Under **Book Now button**, choose whether to **Show the Book Now button** and
   whether it goes to the **booking flow** or a **content page**. A page target
   that is unpublished falls back to the booking flow while it stays hidden, and
   deleting the target page switches this setting back to the booking flow
   outright. While a page target is saved, the target choices stay on screen
   even with the button hidden, so you can always change it. The button is
   **off** until you tick it and save — including for a club that had it on
   before, because the release that shipped this change switched every club off
   (see `docs/UPGRADING.md`). Ticking the box and saving brings it straight
   back.
3. Click **Save visibility**.

## Settings reference

| Setting | What it controls | Default | Notes / constraints |
| --- | --- | --- | --- |
| Page title / menu title | The page name and its public menu label | Per page | Length-capped by `PAGE_CONTENT_LIMITS` |
| Slug (`/path`) | The page's public path | Derived from the page | System pages are fixed; slugs must be valid, non-reserved |
| Menu order | Position in the public site menu | Per page | Between the `PAGE_CONTENT_LIMITS` sort-order min/max; system pages fixed |
| Published / NO MENU | Whether the page is live and whether it appears in the menu | Per page | Only admin-created pages can be hidden; built-in and system pages stay published |
| Delete | Removes the page and its content permanently | — | Only admin-created pages; confirmation required; not reversible from the admin area (the audit log keeps the content for seven years); the slug is free to reuse at once |
| Content (rich text + tokens) | The page body | Per page | HTML sanitised; only recognised `{{tokens}}` render |
| Joining fees / Annual membership fees / Hut fees | Whether fee tokens may publish those authoritative amounts | Off | Money stays in integer cents; types must also be marked public |
| Booking policy summaries / Cancellation policies | Whether policy tokens may publish those blocks | Off | — |
| Show the Book Now button | Whether the public header shows the booking button | Off | Off for every club since #2430, including clubs that had it on; tick and save to bring it back |
| Book Now target | Booking flow, or a specific content page | Booking flow | An unpublished target falls back to the booking flow; **deleting** the target page switches this setting back to the booking flow outright |

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| A fee token shows nothing on the public page | Its family isn't enabled under Public fee and policy blocks | Tick the family and **Save visibility**; also mark the membership types public |
| The Book Now button goes to the booking flow, not my page | The target page is unpublished or was removed | Publish the target page, or re-select it |
| The button vanished after an upgrade | Expected: #2430 switched the public Book Now button off for **every** club, whether or not the club had chosen to show it. Nothing else about your public content changed, and your Book Now target was kept | Tick **Show the Book Now button** and **Save visibility** |
| Visitors see "Member booking", not "Book Now" | Expected: the label follows the visitor, not the target. Nobody who is signed out can book from that button — booking flow means the member login — so it names its audience, including when you have pointed it at a page of your own. Signed-in members still see **Book Now** | Nothing to do — it is not configurable |
| I can't unpublish a page | It's a built-in page — anything the starter site ships (Home, About, Join, Apply, Rules, Contact, Committee, Privacy, Terms, FAQ, 404), not just the two **System** pages | Built-in pages can't be hidden by design; only pages you added yourself can be |
| There's no **Delete** button on a page | Same rule as hiding: only pages you added yourself can be deleted | Nothing to do — the page is one the site itself links, so it stays |
| I deleted a page by mistake | Deletion is permanent; there is no Restore | Recreate the page at the same slug (it is free again immediately) and ask a full administrator to read the old content out of the audit log entry for it. Use **Hide** instead of **Delete** whenever the page might come back |
| I deleted a page and the **Book Now** button changed | Expected: the button was pointing at that page, so the **Book Now target** setting was switched back to the booking flow with the delete rather than left pointing at nothing. The confirmation said so before the delete, and the message afterwards repeats it. Rarely the message instead says the setting "was left set to a page with none chosen": the setting had been left on "a content page" with no page behind it, by this delete (someone pointed **Book Now** at the page while it was being deleted) or by an earlier one, and the delete put it back to the booking flow. The repair fixes any setting in that state, not only one caused by the page you just deleted | Nothing to do — the saved setting is already the booking flow. Point **Book Now** at another page and **Save visibility** if you want it somewhere else |
| **Save visibility** keeps failing with "The selected Book Now page is not published." | The **Book Now target** names a page that has since been hidden. The panel saves all of its settings together, so one setting it cannot save blocks every other change in it — even with the button hidden | Under **Book Now button**, choose **Go to the booking flow** (or a page that is published) and **Save visibility**. The target choices stay on screen whenever a page target is saved, so this is always fixable from the panel. The message on screen is the server's own reason, so it names the setting to change |
| The delete confirmation says the footer or the **Book Now** setting "could not be checked just now" | The footer, or the **Book Now** setting, could not be read at that moment. Only the warning is affected; the delete itself is not | Look under **Site Content** (footer) or **Public fee and policy blocks** (Book Now) yourself before you confirm, or cancel, reload and try again |
| After a delete, the message says the audit log copy is not complete | The page held something the audit log redacts (a secret-shaped link or key, or `password: ...`-style text), or was too large for the record to hold whole | The page is deleted. Save its wording now from wherever else you have it; the audit record cannot give it back in full |
| A page I deleted is still linked from the footer | The footer's link lists are edited separately, under **Site Content**, so a delete cannot rewrite them for you. The confirmation names the footer section when it links the page you are deleting | Edit that footer section under **Site Appearance & Content → Site Content** and remove or repoint the link |
| Save is rejected | A field exceeds `PAGE_CONTENT_LIMITS`, or the slug is invalid/reserved | Fix the flagged field; keep slugs valid and non-reserved |
| Everything is read-only | Your admin role can view but not edit under the content area | Ask a full admin for content edit access |

## Related links

- Back to the [documentation hub](../README.md).
- Parent hub: [Site Appearance & Content](appearance.md).
- Sibling guides: [Site Content](site-content.md),
  [Image Manager](image-manager.md).
- Reference: the token catalogue and publishing rules in
  [`PUBLIC_PAGE_CONTENT_TOKENS.md`](../PUBLIC_PAGE_CONTENT_TOKENS.md).
