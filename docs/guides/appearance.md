# Site Appearance & Content

Audience: Operator

## What it is

The hub for everything a visitor sees on your public website: your club's
identity, the site theme and logo, editable page and footer content, notice
banners, mountain-condition widgets, and the shared image library. Find it at
**Admin → Setup & Configuration → Site Appearance & Content**
(`/admin/appearance`). Each card opens a dedicated tool; this page is only the
launcher.

The cards are:

| Card | Opens | What it does |
| --- | --- | --- |
| **Club Identity** | `/admin/appearance/identity` | Club name, short name, hut-leader label, and your lodge's public details (covered below). |
| **Site Style** | `/admin/site-style` | The public theme, brand colours, fonts, logo, and first-run style completion. See [Site Style](site-style.md). |
| **Site Content** | `/admin/site-content` | Shared site chrome such as the footer columns. See [Site Content](site-content.md). |
| **Page Content** | `/admin/page-content` | The database-backed public pages, menus, tokens, and publishing state. See [Page Content](page-content.md). |
| **Site Banners** | `/admin/site-banners` | Dated notice banners for public visitors and members. See [Site Banners](site-banners.md). |
| **Mountain Conditions** | `/admin/mountain-conditions` | The Whakapapa Snow.nz condition widget content. See [Mountain Conditions](mountain-conditions.md). |
| **Image Manager** | `/admin/image-manager` | Upload and organise images used by the content editors. See [Image Manager](image-manager.md). |

Everything here is edited under the **content** permission area: you need
content **edit** access to save, and a view-only content role can read but not
change these pages.

## When you'd use it

- You've forked the platform for your own club and need to set your club name,
  colours, logo, and footer before going live.
- Your club details, affiliations, or public wording changed and the site needs
  to match.
- You want to post a temporary notice (e.g. a road closure) or refresh the
  mountain-condition widget.

## Step-by-step

### Find the right tool

1. Open **Admin → Site Appearance & Content**. Pick the card for what you want
   to change.

   ![The Site Appearance & Content hub showing the seven cards: Club Identity, Site Style, Site Content, Page Content, Site Banners, Mountain Conditions, and Image Manager](../images/admin/admin-appearance.png)

### Set the club identity

1. Open the **Club Identity** card (`/admin/appearance/identity`).
2. Under **Club identity**, the fields open read-only. Click **Edit**, then
   change the **Club name**, **Short name**, **Hut-leader label**, and
   **Facebook URL**. These override the file configuration — leave a field
   blank to fall back to the configured default. Click **Save club identity**
   to save all four at once; changes appear across the site and in emails
   within a few seconds. **Save club identity** stays greyed out until a value
   actually changes (extra spaces at either end don't count), and **Cancel**
   puts every field back to what was last saved without saving anything. If
   your role can view but not change club identity, a note at the top of the
   section says so and **Edit** is greyed out.

   ![The Club Identity page: the Club identity section read-only (Club name, Short name, Hut-leader label, Facebook URL) with an Edit button, then the Lodge details form (Lodge name, Address, Travel note, Door code) and the Club Contact form](../images/admin/admin-appearance-identity.png)

3. Under **Lodge details**, edit the **Lodge name**, **Address**, **Travel
   note**, and **Door code**, then click **Save lodge details**. The lodge name
   and address appear on the public site (contact page and the `{{lodge-name}}`
   / `{{lodge-address}}` content tokens). The **door code is only shared in
   confirmation emails**, never on the public site. For a single-lodge club
   these are the lodge name, travel note, and door code that automated emails
   use — the same values the [Email Messages](email-messages.md) templates
   reference; a multi-lodge club sets them per lodge under **Setup → Lodges**
   ([Lodges](../multi-lodge/README.md)) instead.
4. Also under **Lodge details**, and all optional, are the details the booking
   invoice prints: a **Postal address** (beside **Address**; the invoice uses it
   instead of the address when set), then, under **Door code**, **Bank details
   for bookings** (an **Account name** and an **Account number** in four parts,
   `BB-bbbb-AAAAAAA-SSS`, the suffix 2 or 3 digits) and a **GST
   number**. They are
   saved by the same **Save lodge details** button and appear only on the
   invoice a booker or officer downloads from a booking that has no Xero
   invoice — never on the public site or in emails. A multi-lodge club sets them
   per lodge in the **Edit** form under **Setup → Lodges**
   ([Lodges](lodges.md#edit-a-lodges-identity)); both screens edit the same
   lodge record.

## Settings reference

**Club identity**

| Setting | What it controls | Default | Notes / constraints |
| --- | --- | --- | --- |
| Club name | The full club name shown across the site and in emails | Configured default | Blank falls back to the file config |
| Short name | The abbreviated club name (e.g. "EMC") | Configured default | Blank falls back to the file config |
| Hut-leader label | What the role is called throughout the app, in the singular (e.g. "Hut Leader") | Configured default | Renames the sidebar entry and member-facing wording. The app adds the plural itself ("Hut Leaders"), and leaves a label that already ends in "s" as typed |
| Facebook URL | The club's Facebook link used in the footer/contact | Configured default | Full URL |

**Lodge details**

| Setting | What it controls | Default | Notes / constraints |
| --- | --- | --- | --- |
| Lodge name | Public lodge name (`{{lodge-name}}` token) | Configured default | Appears on the public site |
| Address | Public lodge address (`{{lodge-address}}` token) | Blank | Appears on the contact page; while it is blank the contact page shows no address block and the token renders nothing |
| Travel note | Extra travel/access note for visitors | Blank | Optional |
| Door code | The lodge door/access code | Blank | Shared **only** in confirmation emails, never public |
| Postal address | The issuer address on the booking invoice | Blank | Up to 300 characters; when blank the invoice uses the address |
| Bank details for bookings | Account name and New Zealand account number in the invoice's payment box | Blank | Name up to 200 characters; the number is `BB-bbbb-AAAAAAA-SSS` (15 or 16 digits) or blank, and a part-filled number will not save; the box appears only when one is set |
| GST number | "GST Number" on the booking invoice | Blank | Up to 40 characters; printed only when set |

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| A card is missing from the hub | The feature is gated off (e.g. Mountain Conditions needs the `skifieldConditions` module) | Enable the module at **Admin → Modules** |
| Everything is read-only | Your admin role can view but not edit under the content area | Ask a full admin for content edit access |
| A changed name still shows the old value | The DB-first identity cache updates within a few seconds; a stale tab may hold the old value | Reload the page |
| A field went back to the old default | You cleared it — blank falls back to the file configuration | Re-enter the value and save |

## Related links

- Back to the [documentation hub](../README.md).
- Sub-pages: [Site Style](site-style.md), [Site Content](site-content.md),
  [Page Content](page-content.md), [Site Banners](site-banners.md),
  [Mountain Conditions](mountain-conditions.md),
  [Image Manager](image-manager.md).
- Reference: the [`CONFIGURATION.md`](../../CONFIGURATION.md) file config that
  club identity overrides, and the public content tokens in
  [`PUBLIC_PAGE_CONTENT_TOKENS.md`](../PUBLIC_PAGE_CONTENT_TOKENS.md).
