- **A booking site whose own address changes now tells the Alpine Central
  Server (#4770).** A site registered its push address once and never again,
  so one that moved (for example from `new.club.example.nz` to
  `club.example.nz`) left the central server pushing posts to, and asking free
  beds of, a name that no longer answered. Other clubs' lodge searches then
  showed the club as not answering.

  The site now keeps the address it registered beside the push secret, and the
  3-hourly pass registers again when `NEXTAUTH_URL` gives a different one.
  Sites that registered before this change register once more on their next
  pass and keep the same secret. An address that is not `https://` never
  replaces a working registration.

  A staging or restored copy must not keep production's Alpine Central Server
  key: on its own address it would now take the registration over. Remove the
  key on the copy before its first sync.
