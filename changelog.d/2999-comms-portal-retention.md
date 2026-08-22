- **The club message board can now clear out old posts on a schedule (#2999).**
  A **Retention** card on **Admin → Members → Message Board** sets how long
  posts are kept — three months, six months, a year, two years, or **Keep
  everything**, which is the default and what every existing club gets until an
  administrator changes it.

  Before you save, the card tells you how many posts on the board are already
  older than the period you picked, so you can see what a choice would cost
  before making it. Once set, a nightly job deletes posts past that age, and
  **Run cleanup now** does it immediately and reports how many went.

  **This deletion is permanent.** Hidden posts are deleted too, and there is no
  recovery from the screen. A post exactly on the boundary is kept rather than
  deleted, and if the nightly job is already running the button declines instead
  of deleting twice.
