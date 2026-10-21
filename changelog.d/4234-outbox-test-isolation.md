- **Xero regression checks now catch queued work left by another test (#4234).**
  Disposable database tests clean up their own queued operations and check for
  leftovers before processing more work, making the checks independent of test
  order.
