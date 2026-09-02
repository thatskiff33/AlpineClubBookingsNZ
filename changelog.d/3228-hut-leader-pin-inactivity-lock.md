- **A hut leader's PIN no longer leaves the shared lodge tablet privileged all
  day.** Typing the kiosk PIN used to unlock the wall screen for **twelve
  hours**, with nothing anywhere that could end it early — so a tablet PINned in
  after breakfast was still a hut leader's screen at ten that night, to whoever
  walked up to it. The unlock now lasts **10 minutes of nobody touching the
  screen**, and there is a **Lock hut leader controls** button for walking away
  sooner. Continuous use keeps it unlocked, so somebody marking off a full lodge
  is never dropped part-way through — and that includes the **chore-roster
  wizard**, which is a separate screen: touching either page keeps the unlock
  alive, so a long roster setup reaches Confirm with everything intact. If the
  screen does lock itself mid-wizard, nothing is lost: the allocation stays
  exactly as it was and the PIN box appears at the top of the page, with the
  interrupted step re-running itself once the PIN goes in.

  The tablet refreshing itself in the background deliberately does **not** count
  as use, which is what stops an unattended device holding its own session open.
  The deadline lives inside the signed session cookie and is set by the server,
  and renewal exists in exactly one endpoint — a source census fails any other
  module that writes, names or extends that cookie. Behind the idle window sits
  an unchanged **12-hour ceiling** from the moment the PIN was typed, which no
  amount of use moves; it is the bound on the two cases the idle window cannot
  help with, and both are written up for operators: a tablet running anti-sleep
  software that taps its own screen, and an unlock copied off the device.
  Changing a hut leader's PIN still ends every unlock made with the old one at
  once.

  On a lock or a timeout the kiosk drops every privileged answer it is holding
  and asks again, so nothing a hut leader could see is left on screen or in the
  page's data even when the network is down at that moment; if the lock itself
  fails, a banner stays beside the button saying the screen is still unlocked
  rather than a message that disappears after three seconds. Every lodge kiosk
  response is now `Cache-Control: no-store`, so a cached answer cannot survive a
  lock. A hut leader signed in with their own account on their own device is
  unaffected by any of it. Operator detail in the [Lodge Kiosk
  guide](../docs/guides/lodge.md#when-a-hut-leader-unlocks-the-kiosk-with-their-pin).
