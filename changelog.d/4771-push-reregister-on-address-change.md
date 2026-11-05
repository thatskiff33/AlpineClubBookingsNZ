- **A booking site that moves to a new name can now tell the Alpine Central
  Server (#4770).** A site registered its push address once and never again,
  so one that moved (for example from `new.club.example.nz` to
  `club.example.nz`) left the central server pushing posts to, and asking free
  beds of, a name that no longer answered. Other clubs' lodge searches then
  showed the club as not answering, and nothing told the club.

  The site now keeps the address it registered beside the push secret. After a
  move to a new name, the 3-hourly pass logs a warning, and saving the API key
  again under **Admin → Integrations → Alpine Central Server** registers the
  new name. The pass does not move the registration itself, because a staging
  or restored copy of the database looks the same as a moved site and must not
  take over production's. A change on the same host (a port, say) is
  registered by the next pass. Sites that registered before this change keep
  their registration as it is; the address is kept from their next key save.
