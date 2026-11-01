- **Inactive work reservations now prompt an owner decision (#4452).**
  `pnpm run lanes:stale` reports reservations with no checkpoint or branch push
  for more than 72 hours. The coordinator asks the owner once whether to extend,
  reassign or release each reservation; silence never releases it automatically.
