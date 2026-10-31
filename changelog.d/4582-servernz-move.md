- **Moving the Alpine Central Server address leaves nothing of the old server behind (#4470).**
  An API key saved from a setup page that still showed the old address is now
  refused, with a message to reload the page and enter the key again, so a key
  the old server issued is never sent to the new one. Moving the address also
  removes the old server's push secret, so the next sync registers this site
  with the new server for pushes and the old server's pushes stop being
  accepted. A download, upload or push registration still running against the
  old server when the address moves records nothing.
