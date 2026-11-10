# Member notices

Audience: Operator

## What it is

A committee news board: write a notice, target it to the right members, and
publish it. Targeted members see it on their dashboard "Recent News" card at
login and on the **Recent News** page (`/notices`), and you can see who has read
each notice. Find the admin surface at **Admin → Members → Member notices**
(`/admin/notices`).

The admin page is gated by the **Member notices** module (Admin → Modules),
which is **on by default** — if the sidebar entry is missing, that module is
off. Creating, publishing, editing, and deleting notices are **membership**-area
edit actions: a view-only membership admin sees the pages and the read reports
but cannot change anything.

Unlike Communications (a one-off bulk email), a notice is a durable, on-site
post with per-member read tracking. The two are complementary — a notice can
*optionally* also send one email when it is published.

## When you'd use it

- The committee wants to post news or an announcement that members read in the
  app, not just an email that scrolls out of the inbox.
- You need the notice to reach only a subset — a lodge's users, a membership
  type, a committee role, or specific members.
- You want to know who has seen an important notice, or require members to
  explicitly acknowledge it.

## Targeting (audiences)

A notice is shown to a member only if it targets them. You can target:

- **Everyone** — all active members.
- **Specific members** — chosen individually. Only **active** members are
  reached: an inactive member you target individually cannot log in or read the
  notice, so they are not emailed and do not appear as a permanently-unread row
  in the read report.
- **Membership types** — everyone whose current-season type matches. A member
  with no explicit season assignment still matches via their role's default
  type, so operational and new accounts are handled correctly.
- **Lodges** — everyone with access to that lodge.
- **Committee roles** — everyone holding an active assignment to that role.

You can combine several of these on one notice. A member who matches more than
one rule still sees the notice once.

### Financial members only

Each notice has a **Financial members only** toggle (off by default). When it is
on, the *group* audiences (Everyone, membership type, lodge, committee role)
reach only members who are **financial** — that is, paid-up for the current
season, or exempt (Life/honorary/operational types, or a non-billable age
tier). Members you target **individually** always see the notice, regardless of
this toggle.

"Financial" here means *paid or exempt*, resolved from the same subscription
facts the rest of the app uses — it is not a separate definition. Note this is
based on **membership status, not on whether a specific payment has cleared** in
any deeper sense than the member's current-season subscription being marked
paid or not required.

## Read tracking and acknowledgement

- Opening a notice records a **read receipt** the first time a member views it.
  The receipt is recorded when the member actually opens the notice page — never
  from a background link prefetch — and the first-open time is never overwritten.
- If you turn on **Requires acknowledgement**, members see an **Acknowledge**
  button on the notice and their acknowledgement is recorded once.
- The notice's admin page shows a **read-status report**: each member in the
  audience, whether they have read it, and (when required) whether they have
  acknowledged it, plus the totals.

## Email on publish (optional)

When you publish a notice you can tick **Also email this notice to the audience**
(off by default). This sends **one** email per notice — a single-send guard
means re-publishing never re-emails. The email:

- goes only to audience members who opted in to club communications (the same
  preference the Communications tool uses), and
- respects email suppression (bounces/complaints) automatically.

The email is a short "new notice" message with a link back to the notice on the
site; the full notice always lives in the app.

When the batch finishes, an audit record (`notice.emailSent`) is written with the
audience size and the sent / failed / opted-out counts, so there is a trail of
each send. If the send cannot even begin — for example the audience can't be
resolved — the one-time send guard is released so a later re-publish can retry;
once emails have started going out it is never released, so successful recipients
are never emailed twice.

## Step-by-step

### Post a notice

1. Open **Member notices** and click **New notice**.
2. Enter a **Title** (up to 200 characters) and write the **body** in the
   editor.
3. Choose the **audience** — Everyone, or Targeted (then pick membership types,
   lodges, committee roles, and/or search for individual members). At least one
   audience is required.
4. Set the options you want: **Pinned** (shown first), **Requires
   acknowledgement**, **Financial members only**, and an optional **expiry** date
   after which the notice disappears.
5. Click **Save draft** to keep working, or **Publish** to make it visible. The
   Publish confirmation includes the optional **Also email this notice to the
   audience** checkbox.

### Check who has read a notice

1. Open the notice from the list.
2. Read the **read-status report** below the editor: audience size, read count,
   acknowledged count, and the per-member rows.

## Privacy notes

- Members never see a notice's audience definition, other members' read
  receipts, or the "financial members only" flag — only their own read/ack
  state.
- A member cannot tell an out-of-audience notice apart from a non-existent one:
  the direct URL returns "not found" either way.
- Authored HTML is sanitised when the notice is saved **and** again when it is
  rendered, so a notice can never inject active scripts into a member's browser.

## Related

- [Communications](communications.md) — one-off bulk email to opted-in members.
- [Modules](modules.md) — turn the Member notices module on or off.
