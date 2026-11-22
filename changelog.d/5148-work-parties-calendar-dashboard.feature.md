- **Work parties go on the Events Calendar by themselves** (#5148). With the
  Events calendar module on, creating a work party adds one all-day entry for
  each of its nights, titled "Work party: {name}", with the lodge as location.
  Editing it moves the entries with it in the same save, deactivating hides
  them and activating shows them again, and deleting it removes them. While the
  Work parties module is off, its entries are hidden from the calendar too. Only
  members see the entries, and the dashboard Events card shows each work party
  once, on its first night. The entries are read-only on the calendar, with a
  link to the work party. Work
  parties made before this have an **Add to calendar** button, so a club that
  typed one in by hand does not get it twice. New work-party dates can now
  span at most 366 nights, the calendar's limit. An existing longer work party
  can still be deactivated or re-described; only changing its dates asks for
  the shorter window, and its calendar shows its first 366 nights.
- **Members see upcoming work parties on their dashboard and can join one in a
  click.** A new **Work Parties** card lists up to five upcoming active work
  parties, and is not shown when there are none. Each opens a work party page
  under the dashboard (`/dashboard/work-parties/{id}`), with its nights,
  lodge, discount and description; the app does not take the `/work-parties`
  address, so a club's website can still have a page there. **Join Work Party** opens Book a Stay with the nights, the lodge
  and "I am attending a working bee" filled in; the member adds guests and pays
  as usual, and every booking rule still applies. Only members see the card,
  the page and the button — not organisation accounts or non-member logins.
