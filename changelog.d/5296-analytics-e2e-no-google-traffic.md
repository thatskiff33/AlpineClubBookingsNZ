- **The analytics consent tests no longer send traffic to Google (#5296).**
  Google now serves its full analytics library even for the made-up
  measurement id these browser tests use, so most of them were loading it in
  CI and sending page-view hits to Google on every run. Every test now serves
  a local stand-in for Google's tag, and a test fails if any request to a
  Google host would otherwise have left the machine. What the tests check is
  unchanged: nothing loads before a visitor accepts, declining or opting out
  stops it, and sign-in pages never load it. Nothing changes for clubs.
