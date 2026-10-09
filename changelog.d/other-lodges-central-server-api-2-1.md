- **Syncing with the Alpine Central Server now pauses, and says so, when the
  server is on a different software version from this site (triyder/AlpineClubBookingsNZ#49).** The
  booking site and the central server are upgraded on different days, and
  until now nothing told a club when the two had drifted apart: the nightly
  sync carried on, new fields were silently dropped, and the buttons failed
  with an unhelpful error.

  This site now knows which server version it was built for, and asks the
  server its version — once each time **Integrations → Alpine Central Server**
  is opened, after a key or address is saved, and first thing in the nightly
  sync. The setup page shows both numbers beside the server address and API
  key (the server's reads **0** while no key is stored). While they differ,
  even by the second part of the number, everything that crosses to the
  server waits: the nightly Other Clubs sync, the Upload and Download buttons,
  sharing and withdrawing board posts, the message-board pull and push
  registration. Nothing is sent or received, and nothing is lost: shares and
  withdrawals stay pending without using up their retries, and a push from
  the server is accepted but not acted on. The setup page carries a message
  with both numbers, the Other lodges panel on **Lodges** says the list may be
  out of date, and the **Daily digest** carries a *Central server version*
  entry every day until the two match — to the digest's own readers and to
  everyone with Lodge Operations edit access, who can switch that entry off
  under **Notification recipients**. Someone who holds Lodge Operations but
  not the digest receives a separate message, *Admin Server Version Paused*,
  carrying only that entry and never the digest's alert counts; it has its
  own wording under **Email Messages**, so editing the digest cannot change
  or hide it.

  Upgrade whichever side is behind and syncing resumes by itself: the next
  nightly run, Upload, share or pull records the new answer and carries on.
  There is nothing to reset. A check that could not reach the server pauses
  nothing — the page says *Could not check* and keeps the last known number —
  and a central server from before version checks counts as a different
  version.
- **Other lodges carry the same details as the Alpine Central Server (API 2.1): a booking page link, bed counts, the walk in, room or dormitory, facilities, season start dates, cancellation period and a list of amenities (triyder/AlpineClubBookingsNZ#50).** On **Admin → Lodges → Other lodges**, a lodge can record its **non-member booking page URL**, its **bed capacity**, **double beds** and **single beds**, the **minutes' walk to the lodge**, whether guests sleep in a **room** or a **dormitory**, a cancellation period, the start of its winter and summer seasons, which facilities it has (custodian required, free wifi, quiet room, drying room, shared kitchen, wheelchair access, ski workshop area, games room, and whether breakfast, lunch and dinner are included), and any number of amenities with an optional description each. When Alpine Central Server sync is on, these are sent to and received from the central server along with the name, location and booking officer details the sync already carried.

  Nothing changes for an existing lodge on upgrade: every facility reads "no" and every other new detail is empty until someone fills it in, and the sync only changes a detail the other side actually sent. The booking page URL is only shown as a link when it starts with `http://` or `https://`.
- **Other lodges: only your own lodge can be changed, in a popup editor (triyder/AlpineClubBookingsNZ#51, triyder/AlpineClubBookingsNZ#52).** The **Other lodges** list on **Admin → Lodges** now comes from the Alpine Central Server, which also says which lodge (or lodges) belong to this site. Only those rows have an **Edit my Lodge** button (or **Edit ‹lodge name›** when there are several), and only they are uploaded. Lodges can no longer be added or deleted here, and a lodge's name cannot be changed, because the central server matches lodges by name.

  The editor opens in a popup over the list instead of a panel at the top of the page. Another club's booking officer phone number is no longer sent to this site's browser at all. Until this site has downloaded from the central server, the panel explains that nothing can be edited yet and points to the Alpine Central Server setup page.
- **Operators: this release needs central server version 2.1, and a short maintenance window for its database change.** Syncing with the Alpine Central Server only runs while both sides are on the same version, so after upgrading this site, syncing pauses until the central server is on API 2.1 as well; the Alpine Central Server setup page shows both numbers, and nothing needs resetting afterwards. Four database migrations ship. Three only add columns and a table, but the fourth removes the old free-text **How to book** column from other lodges (the central server dropped it in the same version), so it is declared in `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv` as needing the old app and workers stopped while it runs, with a `rollback.sql` beside it.
