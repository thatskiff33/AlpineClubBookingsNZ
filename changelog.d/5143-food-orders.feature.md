- **Food orders: members can order food for a lodge stay, and the food officer
  is emailed each order** (fork #121). A new **Food orders** module, off until an
  admin turns it on under **Admin → Setup → Modules**, adds an **Order food** page
  (a dashboard card beside **Report an issue**) where a signed-in member chooses
  the lodge and the date the food is needed by, adds one line per item (a
  description, a quantity of more than 0 with up to two decimal places, and a
  **Type** — Items by default, or Grams, Kilograms, Liters, Loaves, Packets,
  Bottles, Cans, Bags, Boxes, Punnets or Milliliters, shown singular for exactly 1 as
  in "1 Packet" and plural otherwise as in "0.5 Packets"; up to 50 lines) and an
  optional note. The order is saved as Open and then emailed to the address in
  the new **Food Orders** settings (**Admin → Lodge Operations → Food Orders**),
  which also holds what the club calls the role ("Food officer" by default). The
  address is checked only as a valid email address; with none set, the page says
  ordering is not set up and takes no orders. Organisation accounts cannot order.
- **Hut leaders and committee members close food orders and record what they
  cost.** The **Food orders** history shows members their own orders, and shows
  committee members, a hut leader at a lodge today and Lodge Operations admins
  every order, filterable by lodge, status and needed-by dates, with the order
  count and the total of recorded prices for the filter, then the same totals by
  year of the needed-by date (this year and later shown openly, earlier years in
  a "Previous years" section that opens on request). The price is typed, with no
  up and down buttons. A committee member, a
  hut leader whose access window covers today at that order's lodge, or a Lodge
  Operations edit admin ticks items received as they arrive, since food does not
  always come in one delivery: the order shows "Open — 2 of 5 items received"
  until the last item is ticked, then closes as **Received** (two people ticking
  at once are recorded once; received is final). They can record or change the
  price at any time. Every price change is
  audited with the old and new amounts. The price is a record only: nothing is
  charged, invoiced, posted to the booking ledger or sent to Xero. The five new
  audit writers (order placed, items received, order received, price changed,
  settings saved) are all in the `lodge` category.
