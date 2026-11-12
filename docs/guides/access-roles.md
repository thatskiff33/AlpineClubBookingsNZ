# Access Roles

Audience: Operator

## What it is

Where you define the **custom admin roles** your club can hand out — each role a
named bundle of permissions across the admin areas. Assigning a role to a member
(from **Admin → Members**) is what gives them their admin access; this page
decides what each role can see and do. Find it at **Admin → Setup &
Configuration → Access Roles** (`/admin/access-roles`).

Only **Full Admins** see this sidebar entry and can reach the page. Editing a
role takes effect for every member holding it on their next request. See
[`ARCHITECTURE.md`](../ARCHITECTURE.md) (access roles / definitions) for the
underlying model.

## When you'd use it

- You want a committee member to manage bookings but never touch finance or
  member data — create a role with **Edit** on Bookings & Beds and **None**
  elsewhere.
- You're onboarding a treasurer and want a finance-only role.
- A role's remit changed and you need to widen or narrow what it can do.

## Step-by-step

### Create or edit a role

1. Go to **Admin → Setup & Configuration → Access Roles**. Each custom role
   shows its name, description, permission summary, and how many members hold it.

   ![Access Roles page listing custom roles with their permission matrix and member counts, plus the protected system roles](../images/admin/admin-access-roles.png)

2. Click **New role** (or the pencil to edit one). Give it a **name** and
   **description**, then set each admin area to **None**, **View**, or **Edit**
   in the permission grid.
3. Save. To remove a role, use the delete action — a role still assigned to
   members can't be removed until those members are moved off it.
4. Assign the role to people on **Admin → Members**; this page only defines it.

## Settings reference

Each custom role carries a name, a description, and a permission level per admin
area:

| Permission area | Covers |
| --- | --- |
| Admin Overview | The dashboard and cross-area overview |
| Bookings & Beds | Bookings, requests, beds, waitlist, seasons, promos |
| Membership | Members, applications, family links, memberships, inductions, communications |
| Finance | Fees, payments, subscriptions, refunds, Xero, reports |
| Lodge Operations | Hut leaders, rosters, chores, work parties, lodge settings, rooms/beds |
| Content | Page content, site chrome, banners, public images, site style |
| Support & System | Setup, modules, security, audit, health, notifications |

| Level | Meaning |
| --- | --- |
| None | No access to that area |
| View | Read-only |
| Edit | Full read/write |

**Protected system roles** — Full Admin (`ADMIN`), Lodge (`LODGE`), User
(`USER`), and Organisation (`ORG`) — are code-defined, shown for reference, and
can never be edited or deleted here.

**Areas also decide who is emailed.** Every admin alert belongs to one of these
areas, and a role is only offered — and only ever sent — the alerts for the
areas it can **edit**. Giving a role Bookings edit is therefore what makes
booking-change and exception-request alerts reach it. See
[Recipients](notification-recipients.md) for the alert-to-area table.

**Areas also decide what AI Diagnostics can look up.** Any signed-in administrator
may open AI Diagnostics, but opening it grants nothing by itself: the server re-reads
the administrator's current areas on **every** question and on **every** lookup, and
offers only the tools their areas cover.

- General system evidence — diagnostics readiness, deployment/release, diagnostics
  spend, background-job health, system and security event correlation — needs
  **Support & System** at View.
- Domain diagnostics use their **own** area, not Support & System. Booking evidence
  needs Bookings at View; membership evidence needs Membership; payment, refund and
  Xero evidence needs Finance.
- Evidence that spans the audit trail *and* a business domain needs **both** — for
  example, correlating booking events needs Support & System **and** Bookings.
- A Full Admin holds every area, so they can investigate the whole case.

Where an area is missing, Diagnostics says so and names the permission required. It
never fills the gap from another source, and it never performs an action: it explains
the current state, identifies what is blocking it, and describes what an authorised
administrator would do next. A role change takes effect on the very next lookup, so
removing an area mid-conversation stops the evidence immediately. Full detail in
[`docs/ai-diagnostics/tool-pack-support.md`](../ai-diagnostics/tool-pack-support.md).

**Areas also decide which admin menu someone sees.** The admin sidebar shows
a menu for the work each role does, worked out from that role's areas, never
from its name (so custom roles follow the same rule):

| Menu | Which roles get it | What it shows |
| --- | --- | --- |
| Admin | A role with Edit on every area (Full Admin); a view-only role that spans several menus (Read-only Admin); a role that edits Support & System, or only views Admin Overview or Support & System | The full admin menu |
| Bookings | A role that edits Bookings & Beds or Lodge Operations, or views only those (Booking Officer) | Bookings & Beds, Bookings Setup, Rates & Policies, Finance, Lodge Operations, and the booking-request, unpaid-stay and hut-leader alerts |
| Membership | A role that edits Membership, or views only that (Membership Officer) | The Members section, Membership & Members setup, and the application, family, cancellation and deletion alerts |
| Content | A role that edits Content, or views only that (Content Manager) | The Site Appearance & Content pages |
| Finance | A role that views Finance and nothing else, without editing it (Finance Viewer) | Finance Dashboard and the Finance section |
| Treasurer | A role that edits Finance (Treasurer) | The Finance menu, plus Subscriptions, Integrations, and the refund and unpaid-stay alerts |

Someone with more than one menu sees a selector at the top of the sidebar, one
button per menu, and opens on the first. Each role a person holds counts on its
own, so a Full Admin sees only Admin unless they also hold another role. The
sidebar remembers the last choice in that browser. The Admin Dashboard and the
Member Dashboard are not in the sidebar: use **Admin** and **Dashboard** in the
top bar. The menus are display only: a page left out of a menu can still be
opened from the search (Ctrl K) or a direct link if the role allows it, and a
page the role cannot open appears in neither. On staff pages (`/admin` and the
`/finance` workspace) the top bar also leaves out Book and My Bookings. An
account whose User Type is **Admin** and that is not also a club member never
sees My Bookings in the top bar: its holder books from their own member login.
An Admin who is also a club member keeps it. **Who's at the lodge** is not in
the top bar for anyone; it is a button under **Open Kiosk** on the member
dashboard's Lodge Kiosk card.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| No Access Roles entry in the sidebar | You are not a Full Admin | Only Full Admins can manage roles; ask one |
| A page is missing from the sidebar | It belongs to a menu your roles don't give you | Search with Ctrl K, or pick another menu at the top of the sidebar if you have one |
| A role won't delete | Members still hold it | Reassign those members first, then delete |
| A member still can't reach an area | Their role's level for it is None/View, or the change hasn't taken effect | Adjust the role; changes apply on the member's next request |
| A system role can't be edited | It is a protected built-in role | Create a custom role instead |

## Related links

- Back to the [documentation hub](../README.md).
- Sibling guides: [Members](members.md) (where roles are assigned),
  [Committee](committee.md), [Login & Security](security.md),
  [Recipients](notification-recipients.md) (which alerts each area receives).
- Reference: access roles / definitions in [`ARCHITECTURE.md`](../ARCHITECTURE.md).
