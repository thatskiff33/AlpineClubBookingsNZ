# Admin Dashboard

Audience: Operator

## What it is

The admin landing page: a set of **attention cards** for work that needs a
decision, headline **stat cards** for the club's numbers, a **Recent Bookings**
list, and **Quick Actions** shortcuts. Find it at **Admin → Admin Dashboard**
(`/admin/dashboard`).

Everything on the dashboard is a link into the area that owns the detail — the
dashboard never edits anything itself. The attention cards mirror the sidebar's
**Needs Attention** section (see [`ARCHITECTURE.md`](../ARCHITECTURE.md) →
Needs Attention / badges): a card appears only while its queue has something
pending and disappears once the queue is clear, so it never implies work that
isn't there.

## When you'd use it

- You've just logged in and want the one-screen view of what needs doing today.
- You want a quick count of active members, active bookings, or this month's
  revenue without opening the detailed reports.
- You want to jump to a pending queue (refund appeals, booking reviews, deletion
  requests) straight from the alert that surfaced it.

## Step-by-step

### Read the dashboard

1. Go to **Admin → Admin Dashboard**.

   ![Admin dashboard showing attention cards, the member/booking/revenue stat cards, recent bookings, and quick-action shortcuts](../images/admin/admin-dashboard.png)

2. Scan the **attention cards** at the top. Each is a shortcut to the queue that
   raised it — click through to act on it.
3. Use the **stat cards** for the headline numbers, or the **Quick Actions**
   tiles to jump to Members, Seasons, Bookings, Promo Codes, or the Chore
   Roster.

### Find any page fast (command palette)

The admin panel has around ninety pages across ten sidebar sections, so you
don't have to remember which section hides a feature.

- Press **Ctrl + K** (Windows/Linux) or **⌘ + K** (Mac) from any admin page, or
  click the **Search…** button at the top of the sidebar.
- Start typing a page name — or a related word, such as "accounting" for Xero
  Sync or "permissions" for Access Roles — then use the **arrow keys** to move,
  **Enter** to open the highlighted page, and **Escape** to close.
- The palette only ever lists pages **you** can open: it applies exactly the
  same permission rules as the sidebar, so a page you aren't permitted to see
  never appears here.
- It lists every page the sidebar *could* show you, which is slightly more than
  the sidebar shows at any one moment. The two attention shortcuts — **Unpaid
  Finished Stays** and **Unpaid Stay Additions** — stay searchable as
  pre-filtered views even when nothing is currently owing, whereas the sidebar
  only surfaces them while their queue has something in it.

## Settings reference

The dashboard has no settings — it is read-only. The cards it can show:

| Card | Appears when | Opens |
| --- | --- | --- |
| Pending Review Queue | Refund appeals or manual credit approvals are waiting | [Refunds & Credits](refund-requests.md) |
| Booking Requests | New booking reviews or change requests are waiting | [Booking Requests](booking-requests.md) |
| Unpaid Finished Stays | A stay ended but is still payment-pending | [Bookings](bookings.md) (pre-filtered) |
| Finished Stays With Unpaid Additions | A settled past stay has an upward change still uncollected | [Bookings](bookings.md) (pre-filtered) |
| Account Deletion Requests | A member self-service deletion is pending | [Deletion Requests](deletion-requests.md) |
| Membership Lifecycle Review | A cancellation or archive request is waiting | [Cancellation Requests](membership-cancellations.md) |
| Hut Leader Assignment Required | Upcoming dates have bookings but no hut leader. On a club with more than one active lodge this counts **lodge-nights** and names the lodge on every date, because each lodge needs its own leader — see [Hut Leaders](hut-leaders.md) | [Hut Leaders](hut-leaders.md) |

Stat cards (each links to its detail area):

| Stat | What it counts |
| --- | --- |
| Members | Active members, with the total and inactive count |
| Total Bookings | All-time bookings (excludes deleted) |
| Active Bookings | Payment-pending, paid, confirmed, and hold statuses |
| Revenue This Month | Payments **taken** this calendar month, **less refunds made on them** — the money the club holds from them. When any of those payments has been refunded, the gross paid and the refunded total are shown beneath the headline, so the arithmetic is on the card. A payment that is still pending or failed is not counted |
| Upcoming Check-ins | Active bookings checking in within the next 7 NZ days |

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| An attention card vanished | Its queue is now empty | Nothing to do — the card only shows while work is pending |
| Revenue looks low | It is **net of refunds**, and it counts only payments taken in the current NZ month. A refund made this month on last month's payment does not reduce it | Use [Reports](reports.md) or [Payments](payments.md) for full figures |
| A quick-action tile is missing | The related module is off (e.g. Chore Roster needs the `chores` module) | Enable it in [Modules](modules.md) |

## Related links

- Back to the [documentation hub](../README.md).
- Sibling queues: [Booking Requests](booking-requests.md),
  [Refunds & Credits](refund-requests.md),
  [Deletion Requests](deletion-requests.md),
  [Cancellation Requests](membership-cancellations.md).
- Reference: the Needs Attention / badges model in
  [`ARCHITECTURE.md`](../ARCHITECTURE.md).
