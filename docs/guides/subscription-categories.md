# Subscription Categories

Audience: Operator

## What it is

The editor for your club's **subscription billing categories** — club-definable
labels (for example "Couple," "2 Adults + 2+ Children") that decide how a
member's **annual subscription is billed and grouped**, completely independent
of their **membership type**. Two members who both hold Full membership type
(same booking rights and hut rate) can be assigned the same "Couple" category
and billed one flat fee instead of two individual ones; two members sharing a
category can even hold different membership types. Find it at **Admin → Setup
& Configuration → Membership & Members → Subscription Categories**
(`/admin/subscription-categories`); it has no direct sidebar entry — reach it
through the [Membership & Members setup hub](membership-setup.md).

A category only ever changes **billing**. It never affects a member's booking
rights, hut rate, or subscription lockout — those are decided entirely by
[Membership Type](membership-types.md). This is a **membership** permission
area: membership view to read, membership **edit** to change.

## When you'd use it

- Your club bills some members as a couple, a family, or another group
  arrangement, at a flat rate cheaper than the sum of their individual
  membership-type fees.
- You want to add a new billing-category tier (the set is not fixed — create
  whatever composition your club actually uses).
- A category is no longer used and you want to archive or delete it.

## Step-by-step

### Review the category list

1. Go to **Subscription Categories** (via **Membership & Members**). Each
   category is a card showing its name, **Active**/**Archived** and
   **Built-in**/**Custom** badges, its key, how many members are currently
   assigned to it, and how many fee schedules it has.
2. The built-in **Individual** category is always present and cannot be
   archived, renamed away from active, or deleted — it is the routing
   sentinel for "bill this member under their membership type, as before,"
   not a priced category. A member with no category assigned behaves exactly
   as if this feature did not exist.

### Create or edit a category

1. Click **New category**, or **Edit** on a card.
2. Set the **Name** (required) and an optional **Description** for other
   admins, and a **Sort order** (lower numbers list first; leave blank to
   fall back to name order). Two categories cannot share a name.
3. For a custom category, tick **Active** to make it assignable. Click
   **Save**.
4. Once created, set the category's flat subscription amount on the
   [Fees](fees.md#set-subscription-category-fees) page — a category with no
   effective fee cannot be billed; members assigned to it are flagged with a
   billing exception instead.

### Archive or delete a category

- **Archive** (the toggle on each custom card) stops the category being
  assignable going forward without deleting its history. Members already
  assigned it keep their assignment, but are **withheld from billing** at the
  next run — an archived-category assignment is flagged for you to resolve
  (re-assign their category, reactivate it, or clear the assignment) rather
  than being silently re-priced under their membership type. Archived
  categories still show in the Fees page's history.
- **Delete** permanently removes a category. It is refused — asking you to
  re-assign members or archive instead — while any member currently holds
  that assignment, or the category has ever had a fee schedule.
- The built-in **Individual** category can never be archived or deleted.

### Assign a member to a category

Categories are a **manual admin choice per member**, the same way membership
type is — there is no automatic detection from family composition. On a
member's profile, open the **Subscription** section of their seasonal
membership assignment and set **Subscription Category** alongside (not
instead of) their **Membership Type**. See [Members](members.md) for the full
member-detail workflow. To bill a couple or family at one flat rate:

1. Make sure the relevant members are in the same family group with a
   nominated billing member — see [Family Groups](family-groups.md).
2. On each member's profile, leave **Membership Type** as it is (their
   booking rights and rate are unaffected) and set **Subscription Category**
   to the shared category.
3. The next subscription billing run resolves the family to that category's
   flat rate instead of billing each member under their own type.

A season roll-forward carries a member's subscription category into the next
season, the same way it carries their membership type.

## Settings reference

| Field | Notes / constraints |
| --- | --- |
| Name | Required, max 120 characters, must be unique (case-insensitive) |
| Description | Optional, max 1000 characters, for other admins only |
| Sort order | Optional whole number; lower lists first |
| Active | Custom categories only — archiving stops future assignment AND withholds billing for members already assigned, flagging each one for you to resolve |
| Built-in Individual | Cannot be archived, renamed away from active, or deleted; carries no fee of its own |

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| "A subscription category named ... already exists" | Another category (active or archived) already has that name | Choose a different name, or edit the existing one |
| "The built-in Individual category cannot be archived" / "...cannot be deleted" | You tried to deactivate or delete the Individual sentinel | Not possible by design — create a custom category instead |
| "Subscription categories with member assignments cannot be deleted" | At least one member currently holds this category | Re-assign those members' subscription category, or archive the category instead |
| "Subscription categories with fee history cannot be deleted" | The category has (or had) a fee schedule on the Fees page | Archive the category instead |
| A member is flagged with a billing exception instead of being invoiced | The category they are assigned has no effective fee for the decision date | Set one on [Fees](fees.md#set-subscription-category-fees) |
| A member is flagged with an "archived subscription category" exception | The category they are assigned has since been archived | Re-assign the member's category to an active one, reactivate the category, or clear their assignment |
| A member is flagged as needing a decision on a closed category charge | The family's category charge was closed as already paid, then a payment was reversed, leaving a covered member unsettled | Decide in Finance: mark the member Paid if the family fee covers them, or invoice the difference in Xero by hand — the family is never billed again automatically |
| A category card is read-only | Your admin role has membership view but not edit | Ask a full admin for membership edit access |

## Related links

- Back to the [documentation hub](../README.md).
- Sibling guides: [Membership Types](membership-types.md), [Fees](fees.md),
  [Family Groups](family-groups.md), [Members](members.md).
- Hub: [Membership & Members setup](membership-setup.md).
