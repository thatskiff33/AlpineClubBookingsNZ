- **A hut leader's PIN no longer leaves the shared lodge tablet privileged all
  day.** Typing the kiosk PIN used to unlock the wall screen for **twelve
  hours**, with nothing anywhere that could end it early — so a tablet PINned in
  after breakfast was still a hut leader's screen at ten that night, to whoever
  walked up to it. The unlock now lasts **ten minutes of nobody touching the
  screen**, and there is a **Lock hut leader controls** button for walking away
  sooner. Continuous use keeps it unlocked indefinitely, so somebody marking off
  a full lodge is never dropped part-way through; the tablet refreshing itself in
  the background deliberately does **not** count as use, which is what stops an
  unattended device holding its own session open. The deadline lives inside the
  signed session cookie and is set by the server, and renewal exists in exactly
  one endpoint — a source census fails any other module that tries to write or
  extend that cookie. On a lock or a timeout the kiosk drops every privileged
  answer it is holding and asks again, so nothing a hut leader could see is left
  on screen or in the page's data even when the network is down at that moment. A
  hut leader signed in with their own account on their own device is unaffected.
  Operator detail in the [Lodge Kiosk
  guide](../docs/guides/lodge.md#when-a-hut-leader-unlocks-the-kiosk-with-their-pin).
