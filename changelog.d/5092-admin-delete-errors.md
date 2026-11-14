- **A refused admin delete or remove now says why (#4976).** Deleting a family
  group, removing someone from a committee role, and deleting or switching a
  season on or off (on the Seasons page and in Hut Fees) now show the server's
  explanation, or a plain fallback, when the request is refused or the
  connection fails. Before, a refused family-group delete showed nothing, a
  committee remove spoke up only when the officer lacked permission, and a
  season refusal from the web server in front of the app showed a JSON parse
  error such as Unexpected token < instead of a reason. The family-group
  message appears above the list, where the officer is looking.
