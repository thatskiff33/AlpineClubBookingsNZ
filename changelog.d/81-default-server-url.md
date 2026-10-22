- **The Alpine Central Server setup page suggests the server address on a new
  site, and spells out register-then-paste (triyder/AlpineClubBookingsNZ#81).**
  Until now the setup page's server address started empty, so "Request a
  Connection" had nowhere to go until an administrator found and typed the
  central server's address. The deployment's `.env` can now name the central
  server it pairs with (`SERVERNZ_DEFAULT_BASE_URL`); while no address has been
  saved, the page pre-fills the field from it and says so, and the
  administrator's Save stores it. Nothing is contacted before that Save: the
  sync and the Request a Connection link read only the saved address, and a
  site that already has one sees no change. The page's instructions now
  describe the whole path — save the address, register on the central server,
  copy the API key it shows once, paste it, Save, Download — and say that the
  key starts working once the central server's administrator approves the
  connection.
