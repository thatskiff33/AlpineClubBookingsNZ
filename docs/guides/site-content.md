# Site Content

Audience: Operator

## What it is

An editor for the shared site chrome shown on **every** public page — the three
footer columns. Find it at **Admin → Setup & Configuration → Site Appearance & Content
→ Site Content** (`/admin/site-content`). It has no direct sidebar entry — open
it from the **Site Content** card on the Site Appearance & Content hub.

The footer columns render exactly as written (after sanitising); the logo,
copyright line, and privacy/terms links stay managed by the system and are not
editable here. Site Content is edited under the **content** permission area.

## When you'd use it

- You want to change the short club blurb, quick-links list, or affiliations
  shown in the site footer.
- You need to hide one footer column entirely.
- Your affiliation links or member-login wording changed.

## Step-by-step

### Edit a footer column

1. Open **Site Content**. Each footer column has its own rich-text editor:
   **Footer: club blurb** (first column), **Footer: quick links** (middle
   column), and **Footer: affiliations** (last column). The **Last saved**
   timestamp shows above each.

   ![Site Content showing the three footer section editors — club blurb, quick links, and affiliations — each with a rich-text toolbar and its own Save button](../images/admin/admin-site-content.png)

2. Edit the content in the editor. Toggle **HTML Editor** to edit the raw HTML,
   or stay in the visual editor (headings, bold/italic, lists, links, images,
   horizontal rule, alignment). Use **Clear** to empty a column.
3. Click the column's **Save** button (e.g. **Save Footer: club blurb**). To
   hide a footer column, leave its section empty and save.

> **Affiliations start empty.** A new install ships no affiliations, because
> only your club knows which bodies it belongs to — the footer shows two columns
> until you add them here. If you are upgrading an older install that still
> shows the original starter list (Federated Mountain Clubs and the Ruapehu
> Mountain Clubs Association), that list is cleared for you on upgrade; see
> [`UPGRADING.md`](../UPGRADING.md) (#2490).

## Settings reference

| Section | What it controls | Notes / constraints |
| --- | --- | --- |
| Footer: club blurb | The short paragraph under the club logo in the footer's first column | Leave empty to hide that column; HTML sanitised on save |
| Footer: quick links | The heading and link list in the footer's middle column | Leave empty to hide that column |
| Footer: affiliations | The heading and link list in the footer's last column | **Empty on a new install** — add your club's own affiliations; leave empty to hide that column |
| Logo / copyright / privacy & terms links | System-managed footer elements | **Not editable here** |

Each column's content HTML is capped by the shared `SITE_CONTENT_LIMITS` (the
same cap the configuration export/import enforces), and every column's key is
one of the recognised `SITE_CONTENT_KEYS`.

> **Copying a deliberately empty column to another install.** A configuration
> import in **Merge** mode only writes bundle fields that have a value in them,
> so it can never *clear* a footer column on the target: import a bundle whose
> affiliations are empty and the plan reports that row as **Unchanged** while
> the target keeps whatever it had. Use **Overwrite** mode when the empty state
> is the thing you are propagating — see
> [Config Transfer](config-transfer.md).

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| A footer column disappeared from the public site | Its section was saved empty | Re-add content and save; empty hides the column by design |
| Formatting looks different on the public site | The HTML was sanitised on save | Use the allowed tags shown in the toolbar; check the HTML Editor view |
| Everything is read-only | Your admin role can view but not edit under the content area | Ask a full admin for content edit access |
| Save is rejected as too long | The content exceeds the `SITE_CONTENT_LIMITS` cap | Shorten the column content |
| A configuration import left a footer column showing the old content | **Merge** mode skips blank bundle fields, so it cannot clear a column | Re-import in **Overwrite** mode, or clear the column here and save |
| The edit is saved but the public home page still shows the old text | The home page is cached for up to a minute for logged-out visitors | Wait a minute and reload, or check while signed in — signed-in views are never cached |
| A footer link points at a page that no longer exists | A page was deleted under **Page Content**; deleting a page never rewrites these sections, though its confirmation does warn when a footer section links the page | Remove or repoint the link here and save |

## Related links

- Back to the [documentation hub](../README.md).
- Parent hub: [Site Appearance & Content](appearance.md).
- Sibling guides: [Page Content](page-content.md),
  [Site Style](site-style.md), [Image Manager](image-manager.md).
- Reference: publishing authoritative content blocks and tokens in
  [`PUBLIC_PAGE_CONTENT_TOKENS.md`](../PUBLIC_PAGE_CONTENT_TOKENS.md).
