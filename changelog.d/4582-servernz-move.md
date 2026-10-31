- **Moving the Alpine Central Server address no longer keeps the old server's key, push secret or sync positions (#4470).**
  The setup page keeps **Save key** off while the address box holds an
  address that has not been saved, and a key saved from a page that still
  showed the old address is refused with a message to reload, so a key one
  server issued is never stored against, or sent to, another. Moving the
  address, or replacing the API key, also removes the push secret registered
  with the old connection: the next sync registers this site again for
  pushes, and pushes and free-beds questions signed with the old secret stop
  being accepted within a minute. A download, upload, message-board sync or
  push registration still running against the old connection when it changes
  writes nothing more from it. Lodges and posts already brought over from the
  old server are kept.
