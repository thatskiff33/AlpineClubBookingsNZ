- **The database now prevents contradictory parent and partner records
  (#3292).** The application already refuses to make the same two members both
  direct parent/dependant and partners. A PostgreSQL backstop now applies the
  same rule to concurrent writes and maintenance SQL, for either parent field
  and for pending or confirmed partnerships.

  This migration requires a planned maintenance window. Operators must stop the
  old application and workers, complete the privately approved relationship
  preflight, verify a fresh backup, and obtain a zero-conflict census before
  migrating. The migration fails closed without changing relationship data if
  any overlap remains.
