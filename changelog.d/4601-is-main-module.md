- **Maintenance scripts now run when started through a linked folder
  (#4598).** About forty of the repository's command-line scripts decided
  whether they had been run directly by comparing two spellings of their own
  path. Started from a checkout reached through a symbolic link, some of them
  quietly did nothing and still reported success.

  Every script now asks one shared helper, which compares the real location of
  both paths, and a test fails any script that writes its own check again.
  Nothing changes for an operator running the scripts the usual way.
