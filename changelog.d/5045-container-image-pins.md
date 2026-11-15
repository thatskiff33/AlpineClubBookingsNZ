- **Deploy helpers and security scans now use fixed container builds (#4906).**
  The deploy's temporary Caddy containers use the same pinned image as Compose.
  Security scans, CI databases and the backup drill also use digest pins, with
  a check that rejects floating third-party images before they reach CI.
