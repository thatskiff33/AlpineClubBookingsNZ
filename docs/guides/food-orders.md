# Food Orders

Audience: Operator

## What it is

A way for members to order food for a lodge stay, for the club's food officer
to receive each order by email, and for the people at the lodge to say the food
arrived — item by item, because food does not always come in one delivery. It
has three parts:

- **Order food** (`/food-order`), in the members' area. A signed-in member picks
  the lodge and the date the food is needed by, adds one line per item (a
  description, a quantity and its type, such as "2 Loaves" or "250 Grams"), and
  can add a note. A card on the
  member dashboard, beside **Report an issue**, links to it.
- **Food orders** (`/food-orders`), the order history. Members see their own
  orders. Committee members, hut leaders at a lodge today and Lodge Operations
  admins see every order, with filters and the totals the club forecasts from.
- **Food Orders** settings (`/admin/food-orders`, **Admin → Lodge Operations →
  Food Orders**): the email address orders are sent to, and what your club calls
  the person who buys the food.

Food orders is the `foodOrders` module, **off by default**. Turn it on under
**Admin → Setup → Modules**, then set the address orders go to. While it is off,
the order and history pages, their APIs and the settings page return Not Found,
and the dashboard card and sidebar entry are hidden. Orders already placed are
kept.

Orders are **not linked to bookings**. The food officer matches an order to a
stay by its lodge and needed-by date. Organisation accounts (schools and similar
groups) cannot order: their catering is arranged through the booking officer.

## When you'd use it

- You are setting up food ordering for the first time.
- The food officer has changed and orders need to go to a new address.
- You want to see what food was ordered for a lodge, whether it arrived, and what
  it cost.
- Food has arrived at the lodge and the order should be closed.

## Step-by-step

### Set up food ordering

1. Turn on **Food orders** under **Admin → Setup → Modules**. The settings page
   only exists while the module is on.
2. Open **Admin → Lodge Operations → Food Orders** and click **Edit**.
3. Enter the **Email address for orders**, usually the food officer's committee
   address. The app checks only that it is a valid email address. It does not
   check it against your members or committee roles, so keeping it current when
   the role changes hands is the committee's job.
4. If your club calls the role something else, change **What your club calls
   them** (default "Food officer"). It is shown as you type it on the order page,
   the history and the email.
5. Click **Save**.

Between steps 1 and 5 — and whenever the address is empty — members who open
**Order food** are told that ordering is not set up, and nothing is accepted.

### Place an order (members)

1. From the dashboard, click **Order food**.
2. Choose the lodge and the **Needed by** date (today or later, in the club's own
   calendar).
3. Add one line per item: what it is, the **Quantity** (more than 0, up to two
   decimal places, for example 0.5 or 250), and its **Type** — Items, Grams,
   Kilograms, Liters, Loaves, Packets, Bottles, Cans, Bags, Boxes, Punnets
   or Milliliters, Items by default. The type reads singular when the quantity is
   exactly 1 ("1 Packet") and plural otherwise ("0.5 Packets", "2 Packets"), and
   the order, the history and the email all show the line that way, for example
   "2 Loaves — Wholemeal". Use **Add item** and **Remove**; an order holds 1 to 50
   items.
4. Add a note if you need to, then **Send this order**.

The order is saved as **Open** first, and only then is the food officer emailed,
with every item and quantity, the note, and a link to the order. The member is
told the order was placed and that the officer is notified by email; the email
itself can be muted under Delivery Rules or fail to send, and the order is in the
history either way. Each member can place up to 10 orders an hour.

The link in the email opens **Food orders** with that order pinned at the top as
**Linked order**, whichever page of the history it would fall on. It shows the
order only to someone who may see it: the member who placed it, or a committee
member, current hut leader or Lodge Operations admin. Anyone else sees the
history with nothing extra, the same as for a link to an order that does not
exist.

### Tick off what arrived

Food does not always arrive in one delivery, so an order is received item by
item.

1. Open **Food orders** from the dashboard card.
2. On the order, tick each item that has arrived (or **Select all**), then click
   **Mark selected received**. Each ticked item records who received it and when.
3. While some items are still to come the order stays **Open** and shows, for
   example, "Open — 2 of 5 items received". When the last item is ticked the
   order closes as **Received**, recorded with that moment and person.

Who can do this: any member with an active committee role, a hut leader whose
access window covers today **at that order's lodge** (from the day before their
first night to the day after their last), and admins with Lodge Operations
**edit**. Everyone else who can see the order sees the same list with each
received item marked. If two people tick the same items at the same moment, the
items are recorded once and the second is told they were already received; the
page reloads to show who did. The **Status** filter counts a partly received
order as Open.

A limit, by design: **received is final**. An item cannot be unticked and a
received order cannot be reopened, so check before you click. The price can
still be changed after the order is received.

### Record the price

1. On the order in **Food orders**, type the amount in **Price** (there are no
   up and down buttons) and click **Save price**.
2. You can change it at any time, including after the order is received.

The same people who can tick items received can record its price. Every
change is written to the audit log with who made it and the old and new amounts.
The save carries the price your screen was showing: if somebody else changed it
in the meantime, nothing is saved, you are told so, and the order reloads with
their price for you to check.
**The price is a record only**: it is never charged to the member, added to a
booking or invoice, posted to the booking ledger, or sent to Xero.

### Review the history and totals

Filter by **Lodge**, **Status** and a **Needed from / to** range, then **Apply**.
The totals panel shows how many orders match and the total of the recorded prices
(with how many of them have a price), across every page of the filter, which is
what forecasting next season's food spending needs.

Under **By year** the panel splits the same figures by the calendar year of each
order's needed-by date, with the same filters applied. This year, and any later
year with orders, are listed openly; earlier years sit inside **Previous years**,
closed until you open it, newest first. A year with no matching orders is not
listed, and when there are no earlier years there is nothing to open.

## Settings reference

| Field | What it controls | Default | Notes / constraints |
| --- | --- | --- | --- |
| Email address for orders | Where every new order is emailed | empty | Checked only as a valid email address. Empty means ordering is not set up and orders are refused |
| What your club calls them | The officer label on the order page, history and email | Food officer | 1 to 60 characters |
| Food orders module | Whether the feature exists at all | **off** | Admin → Setup → Modules |

| Rule | Value |
| --- | --- |
| Items per order | 1 to 50 |
| Item description | Required, up to 200 characters |
| Item quantity | More than 0, at most 99999.99, up to two decimal places |
| Item type | Items (default), Grams, Kilograms, Liters, Loaves, Packets, Bottles, Cans, Bags, Boxes, Punnets, Milliliters; singular for exactly 1 |
| Note | Optional, up to 1,000 characters |
| Needed by | A club calendar day, today or later |
| Orders per member | 10 an hour |
| Price | Zero or more, in cents; a record only |

The settings page is a **lodge** permission area: Lodge Operations view to read
it, edit to change it. The email to the food officer is the
`food-order-placed` template: its wording is editable under
[Email Messages](email-messages.md), and it can be muted under
[Delivery Rules](notification-rules.md) like other non-locked operational
emails; orders are still saved and shown in the history.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| The pages 404 and the dashboard card is missing | The `foodOrders` module is off | Turn it on under **Admin → Setup → Modules** |
| Members see "Food ordering is not set up yet" | No email address is saved | Enter one on the Food Orders settings page |
| The food officer is not getting orders | The address is wrong or out of date, or the email is muted under Delivery Rules | Check the address on the settings page and the `food-order-placed` rule. Every order is still in the history |
| A hut leader cannot tick items received | Their access window does not cover today, or the order is for a different lodge | A committee member or a Lodge Operations edit admin can tick them |
| An item was ticked by mistake | Received is final; there is no untick | Note it on the order with the officer; the audit log records who ticked what and when |
| An organisation account cannot order | By design | Catering for organisation stays is arranged through the booking officer |
| A price save says somebody else changed it | Somebody saved a different price after your screen loaded | The order reloads with the stored price; check it and enter yours again if it is still right |
| Saving the settings says somebody else saved at the same moment | Two admins saved at once; one save was refused and nothing was changed by it | Reload the page and save again |

## Related links

- Back to the [documentation hub](../README.md).
- Sibling guides: [Lodge Maintenance](maintenance-reports.md),
  [Hut Leaders](hut-leaders.md), [Committee](committee.md),
  [Modules](modules.md).
- Reference: lodge scoping in
  [Lodge Scoping Contract](../multi-lodge/lodge-scoping-contract.md); integer
  cents in [money invariants](../invariants/money.md); the routes in
  [`SECURITY-ATTACK-SURFACE.md`](../SECURITY-ATTACK-SURFACE.md); the Open to
  Received transition in [State Machines](../STATE_MACHINES.md#food-order-lifecycle).
