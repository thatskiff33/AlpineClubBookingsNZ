- **More admin screens say why a save or delete was refused (#4976).** Saving a
  season on **Seasons** or **Fees → Hut Fees**, creating a family group, and
  deleting a work party event used to show "Unexpected token < in JSON", or
  nothing at all, when the server or the web server in front of it answered
  with an error page. They now show the server's own reason when it gave one,
  and a plain "Failed to save" style message when it did not or the
  connection dropped.
