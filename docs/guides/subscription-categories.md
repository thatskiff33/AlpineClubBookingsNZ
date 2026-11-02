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

A member's subscription category is set on their own member record (the
seasonal membership card), not from this page — this page only manages the
catalog of categories a club has defined.

## Troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| "Subscription categories with member assignments cannot be deleted" | The category still has members assigned to it | Re-assign those members to a different category (or Individual), then delete — or archive it instead if you want to keep it unassignable but not lose the history |
| "Subscription categories with fee history cannot be deleted" | The category has billed at least one charge in the past | Archive the category instead — deleting would orphan that billing history |
| "The built-in Individual category cannot be archived/deleted" | You tried to change the seeded default category | This is expected — the Individual category is not configurable |
| You can see the page but every button is disabled | You have membership-area view access but not edit access | Ask an officer with membership edit access to make the change, or request that access |
