- **Tests for the money-to-settle queue no longer fail now and then on a busy test runner (#5357).**
  They now wait for the queue to finish loading before reading its rows, instead of waiting for a card that also shows while it loads. Test and documentation only; no behaviour changes for clubs.
