- **Syncing with the Alpine Central Server now pauses, and says so, when the
  server is on a different software version from this site (#49).** The
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
  version. Operators: one database migration adds the three columns; it is
  additive and safe with the previous release still running.
