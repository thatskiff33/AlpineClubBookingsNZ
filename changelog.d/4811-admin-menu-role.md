- **Officers can pick which role's menu the sidebar shows, once admin hubs
  are switched on (#4811).** An officer who holds more than one admin role
  gets a "Show menu for" choice at the top of the sidebar: one entry per role,
  plus "All my roles". The menu then lists Home and the hubs that role can
  change, or the hubs it can view when it can change nothing. A Full Admin
  still sees every hub and is not offered the choice. Nothing about who can
  open a page changes, and the search box still finds every page the officer
  may open.

  The choice is saved in a browser cookie named `admin-menu-role`. It is sent
  only to admin pages, the page script cannot read it, and it has no expiry of
  its own: the browser keeps it until it is cleared or the officer picks "All
  my roles". While admin hubs are off, the choice is hidden and saving it
  answers as if the address were not there. Signing out does not clear it.
