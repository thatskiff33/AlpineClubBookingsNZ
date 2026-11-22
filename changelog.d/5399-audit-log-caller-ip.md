- **Audit log entries record the IP address the club's proxy saw, on every
  action (#5399).** About twenty actions, among them booking edits and payments,
  refund decisions, issue and maintenance reports and saved-card charges, took
  the first address in the forwarding header the club's proxy passes on. A
  visitor can write that address themselves.

  This affects a club whose proxy adds to the forwarding header instead of
  replacing it. On such a club those audit entries could show an address the
  visitor chose, and three of them stored the whole list of addresses. They now
  record the address the proxy saw, the same one the rate limits already use,
  and a single address rather than a list.

  Nothing changes for a club running the reference Caddy configuration, which
  replaces the header with one address. Entries already in the audit log are
  not changed.
