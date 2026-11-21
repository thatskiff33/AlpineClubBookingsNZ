# Subscription Categories

Audience: Operator

## What it is

The page where you define **subscription categories** — a second, independent
way to bill a member's Annual Membership Fee, alongside their `MembershipType`.
A category (e.g. "Couple", "Family") carries its own flat fee shared across
whichever family members you assign it to, while each member keeps their own
membership type for booking rights and hut rates. Find it at **Admin → Setup &
Configuration → Membership & Members → Subscription Categories**
(`/admin/subscription-categories`).

**Opening this page, and every write on it, requires *membership*-area edit
access** — the same area as Membership Types. A Membership Officer can both
view and manage categories; without that access you can look but not change
anything. Category **fee amounts** are set and read on the **Fees** page
(finance-area), not here — this page only manages the category itself (name,
description, active/archived state, and sort order).

## When you'd use it

- You want to offer a flat combined rate to a group of members (e.g. a
  "Couple" rate) that bills once regardless of each member's own membership
  type.
- You need to rename, reorder, or retire a category without losing its
  billing history.

## What you can do here

- **Create a category** — give it a name, an optional description, and an
  optional sort order (the display order on this page and on the member
  assignment picker). Leave sort order blank and it appends after the
  highest sort order any existing category already has. The category's `key`
  is derived from the name and shown read-only afterwards.
- **Edit a category** — change its name, description, active state, or sort
  order at any time.
- **Archive / Reactivate** — toggling a category off (Archived) hides it from
  the member-assignment picker without deleting its history; toggling it back
  on makes it assignable again.
- **Delete a category** — only possible when it has **no member assignments**
  and **no fee history**. The assignment count is across **every season a
  member was ever assigned the category, past or present** — not just the
  current season — so a category nobody is assigned to THIS season can still
  refuse deletion over an old season's assignment. If either check fails,
  delete is refused and the page tells you to re-assign those members (or
  archive the category instead) and clear its fee history first.

## The built-in "Individual" category

Every club has one built-in category named "Individual", seeded automatically.
It cannot be archived, deleted, or assigned a fee through this page or its
API — it exists as the default/no-category sentinel, not as something you
configure.

## Assigning members

A member's subscription category is set for a season, either on their own
member record (the seasonal membership card) or for many members at once from
the members list — this page only manages the catalog of categories a club has
defined.

**Finding who is in a category.** On **Admin → Members**, the **Subscription
Category** filter lists the members in one category this season, or
**Individual (no category)** for everyone billed without one (including members
with no membership type this season). Archived categories stay in the filter so
you can find members still left in one. Each member's category is shown under
their Type – Tier, and the CSV export applies the same filter.

**Setting or clearing many at once.** Tick the members, choose **Set
Subscription Category**, pick a category (or **Individual (no category)** to
clear it) and the season, then **Preview**. The preview lists who moves from
which category to which, and who is skipped and why. Only the category moves:
each member keeps their own membership type, and the same checks as the
member's own card apply. Give a reason, which is written to each member's audit
trail, and confirm. It needs membership-area edit access and takes up to 100
members at a time.

- A member is **skipped** when they are archived, have no membership type for
  that season (assign one on their record first), or are on an archived
  membership type (change it on their record first).
- A member already **paid or invoiced** for that season is flagged but still
  changed: the billing run does not re-bill them, so that season's invoice
  stays as it is. A category is set per season and is not carried into the
  next one.
- An archived category cannot be chosen; archive it after moving its members.

A member whose membership type needs no subscription, or whose age tier is
exempt under their membership type, is never billed through a category. The
billing preview lists them under **Exempt**, naming the membership type or the
age tier as the reason. This still holds after their category is archived, so
an exempt member never needs re-assigning before billing. An age-exempt child
in a family stays exempt and is not covered by the family's category charge.

A family shares one category. If members of one family are assigned different
categories, or some are on a category and others on a family membership-type
fee, the billing preview bills the first and raises a mixed-billing exception
for the rest. Give everyone in the family who should share the charge the same
category, then preview again.

## Moving categories to another deployment

Export & Import ([config transfer](config-transfer.md)) carries your categories
and their fee schedules in the **Membership fees** category. Importing the same
bundle twice changes nothing the second time. Which member is in which category
is member data and does not travel: assign members again on the target, one by
one or in bulk. A category whose fees have all ended raises a missing-fee
exception in the billing preview until you add a fee on the Fees page.

## Not yet included

Grouping Xero contacts by subscription category is coming in a later release.

## Troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| "Subscription categories with member assignments cannot be deleted" | The category still has members assigned to it | Re-assign those members to a different category (or Individual), then delete — or archive it instead if you want to keep it unassignable but not lose the history |
| "Subscription categories with fee history cannot be deleted" | The category has at least one fee row on the Fees page, current or past | Archive the category instead — deleting would orphan that fee history |
| "The built-in Individual category cannot be archived/deleted" | You tried to change the seeded default category | This is expected — the Individual category is not configurable |
| A member is skipped by **Set Subscription Category** with "no membership type for this season" | They have no seasonal membership for the chosen season | Assign their membership type on their record (or with **Set Membership Type**), then set the category |
| A config import refuses with "overlapping fee windows" | The bundle adds a fee for a category whose existing fee on the target is still open | Close the earlier fee on the Fees page (or in the bundle), then preview the import again |
| A config import refuses with "not a valid new category key" | The bundle's `key` column was edited by hand into a shape the Subscription Categories page never creates | Use capital letters, digits and single underscores (for example `COUPLE`), or export the category again from the source |
| You can see the page but every button is disabled | You have membership-area view access but not edit access | Ask an officer with membership edit access to make the change, or request that access |
