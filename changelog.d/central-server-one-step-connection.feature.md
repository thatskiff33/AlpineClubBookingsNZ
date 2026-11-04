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

- **Connecting to the Alpine Central Server is one step (triyder/AlpineClubBookingsNZ#97).** Saving the API key on **Integrations → Alpine Central Server** now registers this site's address with the server at once, rather than at the next 3-hourly sync, and says how it went (registered, not `https://` so poll-only, waiting for the server's approval, no server address saved, paused for a software version difference, or not reachable), then downloads the club's lodges and opens a **Link your lodges** dialog with the current links (or, for one lodge and one listed, that pair) preselected; nothing is linked until **Save links**, as every club links explicitly. A link saved on a lodge's **Central lodge** card now fills its rates from the Fees page straight away. Saving a change to **Edit my Lodge** uploads the lodge straight away for an administrator who also holds Finance edit (the **Upload** button's permission), and says whether the server accepted it; otherwise the nightly sync sends it. The setup page links to **View all lodge details**. A link saved from the dialog is audited as `LODGE_CENTRAL_LINK_UPDATED` under `admin`, exactly as from the card, so one more audit write site is readable with Support view alone (140 to 141 sites); no existing row changes readership.
