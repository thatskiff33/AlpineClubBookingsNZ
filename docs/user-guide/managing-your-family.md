# Managing your family & household

Audience: Member

## What it is

How you group your household so you can book and be billed together, and how you
record a partner. You manage all of it from your **Profile** — the **Family
Group** and **Partner** sections (`/profile`). Family changes go to the club for
review before they take effect. The lifecycle is in
[`STATE_MACHINES.md`](../STATE_MACHINES.md#family-and-dependent-lifecycle).

## When you'd use it

- You want your partner, or your children, on the same family group as you.
- You are joining an existing family group, or starting a new one.
- You want to add an infant, child, or youth who does not have their own login.
- You want to record a partner (husband/wife/partner) relationship with the club.

## Step-by-step

### Family group — join, create, or add dependents

Open **Profile** and find the **Family Group** section.

![The member profile showing the Family Group and Partner sections with Request to Join a Family Group, Create a Family Group, and Declare your partner by email](../images/public/member-profile.png)

- If you are **not** in a family group, you can:
  - **Request to Join a Family Group** — by another member's email. They (or the
    club) approve you into their group.
  - **Create a Family Group** — from scratch. You can give it an optional name
    (it defaults to "*{your last name}* Family"), name an optional **partner by
    email**, and add optional **infant / child / youth** rows in one go. The
    whole bundle goes to the club for review before the group exists.
- Adults in a group can invite other adults and request to add infants,
  children, or youth. **Login-capable adults** confirm their own inclusion;
  **dependents** (infants/children/youth) do not have their own login and are
  managed by the group's adults.
- The club can record who a member's parents are — up to two parents each, and
  up to **four generations** in one line (great-grandparent, grandparent,
  parent, child), **whatever their ages**: a 16 or 17 year old can genuinely be
  a parent, and the club can now write that down. Being someone's parent no
  longer stops you being recorded as someone else's child, so a
  three-generation family can be recorded as it really is. Recording the
  relationship is all it does — it does not decide who is billed, who can book
  for whom, or who can change someone's details.
  Your family list names each parent it has on file, and marks which of them the
  club's email for that person goes to. It has never printed anyone's email
  address on that list, and it still does not — but the club now also **only
  sends a parent's address to your browser when that parent is in one of your
  own family groups**. For a parent who is in none of your groups, all your
  browser is given is a name. Their address is not withheld from the club: an
  administrator still sees it.
  If a dependent has no email address of their own, club email for them goes to
  **their own parent** — one step, and no further. It has to be an adult: the
  club's contact for a member always is one.
  If that parent has no address the club can send to, the dependent inherits
  **nobody** rather than the mail travelling further up the family. That is
  deliberate. An address that hops an unknown number of times is not predictable
  to the person whose address it is, and a grandparent who supplies an email for
  one grandchild should not quietly start receiving mail for a branch of the
  family they have nothing to do with. Where it leaves a gap, the club can see
  the gap and will ask you for an address.

While a create-group request is pending, the Join/Create buttons are replaced by
"Your family group request is awaiting admin review", showing the requested group
name, partner, and children you submitted.

### Partner — record a relationship

In the **Partner** section you can record one partner (husband, wife, or
partner):

1. Enter your **partner's email address** and click **Send partner request**.
   They must be a registered adult member with a login; they confirm the
   relationship from **their own** profile Partner section (just like a family
   invitation).
2. A pending request shows "waiting for *X* to confirm", with a **withdraw**
   action if you change your mind.
3. To end a confirmed partnership, remove it from the Partner section — the other
   person is emailed, and any shared double-bed placements you both held are
   released back to the club for re-allocation.

If a no-login adult in your group has had their details confirmed by you, you can
declare them as your partner in one step. There is no "group admin" — any adult
with a login in the group can confirm a member's details, and whoever did is the
one who can make that declaration. The partner rules are in
[`STATE_MACHINES.md`](../STATE_MACHINES.md#partner-link-lifecycle-declared-partnerhusbandwife-1742).

## What to expect

| Action | What to expect |
| --- | --- |
| Request to join / create a group | Goes to the club for review before it takes effect |
| Add a dependent (infant/child/youth) | Requested via your group; no login is created for them |
| Invite an adult | They confirm from their own profile |
| Declare a partner by email | They confirm from their own profile Partner section |
| Unregistered partner by email | They are emailed a claim link that routes them through joining, then into your group |
| Remove a confirmed partner | The other person is emailed; shared double-bed placements are released |

Both people in a partnership must be **adults**, and each member can have at most
**one** confirmed partner. The same two people cannot also be recorded as direct
parent and dependant: this applies while a partner request is pending as well as
after it is confirmed, and it applies to either recorded parent. If the club's
records disagree, the relationship request is left unchanged while the club
checks which record needs correcting. Family billing (who pays for the
household) is set by the club; see the operator
[Family Groups](../guides/family-groups.md) guide.

## Troubleshooting

| Symptom | Why it happens | What to do |
| --- | --- | --- |
| The Join / Create buttons are gone | You already have a pending family-group request | Wait for the club to review it; the pending note shows what you submitted |
| Your partner request is stuck on "waiting to confirm" | They have not confirmed from their own profile yet | Ask them to open **Profile → Partner** and confirm; you can withdraw and re-send |
| "If they're eligible, we've sent them a partner request" | A privacy-safe response — a member who already has a partner looks the same as an eligible one | If they are eligible they will get the request; otherwise contact the club office |
| The NZ address lookup is unavailable when adding details | The autocomplete service is off or unconfigured | Enter the address by hand — the fields still work |
| You cannot cancel a pending family-group request yourself | Members cannot cancel a pending group request in this version | Ask the club office to reject it |

## Related links

- Back to the [Member & Guest Guide](README.md) and the
  [documentation hub](../README.md).
- Sibling guides: [Managing your account](your-account.md),
  [Booking a stay](booking-a-stay.md) (adding family members as guests).
- Reference: the
  [family & dependent lifecycle](../STATE_MACHINES.md#family-and-dependent-lifecycle)
  and the
  [partner link lifecycle](../STATE_MACHINES.md#partner-link-lifecycle-declared-partnerhusbandwife-1742).
  Operators use the [Family Groups](../guides/family-groups.md) guide.
