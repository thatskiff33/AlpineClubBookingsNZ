- **Admin hub cards now use the page names that admin search shows (#5128).**
  On the Lobby Display hub the cards read **Display Devices**, **Display
  Builder**, **Display Layouts**, **Display Templates** and **Display
  Reference** (they were Devices, Visual builder, Layouts (Advanced), Templates
  and Reference); on Integrations, **Google Sign-in Setup**, **Backup Setup**,
  **Video Meetings Setup** and **Alpine Central Server Setup**; on Bookings
  Setup, **Seasons** (was Hut Fees & Seasons), whose card now says that nightly
  rates are set under Fees. Each title is read from the admin page registry,
  where the command palette also gets its page names, and a test fails any hub
  card that opens a whole page under another name. Addresses and permissions
  are unchanged.
