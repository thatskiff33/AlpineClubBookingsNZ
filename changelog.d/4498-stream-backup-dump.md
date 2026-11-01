- **Nightly backups use bounded memory as the database grows (#4487).** Database
  dumps are now compressed to disk as they arrive. Failed or timed-out dumps
  remove their partial file and report failure before copying or uploading it.
  Docker stages compressed files on a disk-backed volume, which keeps a dump only
  while no destination received it and clears anything over an hour old; recreate
  the app and cron containers during the upgrade to apply the new mount.
