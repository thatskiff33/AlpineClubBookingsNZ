- **Needs Attention now shows when the Alpine Central Server is on a different
  version (triyder/AlpineClubBookingsNZ#136).** While this site is linked to
  the Alpine Central Server and the two are on different software versions,
  every sync with the server is paused. Until now only the setup page and the
  Daily digest said so. The admin sidebar's **Needs Attention** section now
  lists **Alpine Server Out of Sync**, with a matching card on the Admin
  Dashboard, both opening **Integrations → Alpine Central Server Setup**, where
  both version numbers are shown. It is shown only while the Alpine Central
  Server module is on, to admins who can open that page, and clears once a
  check finds the versions match. See
  [the dashboard guide](../docs/guides/dashboard.md#settings-reference).
