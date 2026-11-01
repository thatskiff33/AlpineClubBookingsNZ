- **Changing the Alpine Central Server connection sends all your lodges again (#4485).**
  Changing the address or API key clears the previous connection's lodge and
  shared-feed sync positions.
  Once a download links your lodges again, the next upload includes older entries
  too. An upload still running on the old connection cannot advance the new
  connection's upload position.
