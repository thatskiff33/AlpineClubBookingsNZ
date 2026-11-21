- **A real-PostgreSQL Xero repair test no longer fails now and then on a slow runner (#5215).**
  The test of a repair that died after recording its payment now waits until the first run is actually held at its close step before letting later runs close normally, instead of guessing that from the payment record. No change to the app itself.
