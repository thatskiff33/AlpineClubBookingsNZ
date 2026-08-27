- **Mountain Conditions shows trails again after Whakapapa's website update
  (contributed from the triyder fork, triyder#45).** Whakapapa moved its
  trail lists behind collapsible panels
  whose content is no longer part of the page itself, which left the Trails
  section of the scraped report empty. The scraper now reads the same data
  feed the panels draw from whenever the page carries no trails, so every
  area's trails — name, open/closed status, groomed flag and difficulty —
  come through as before. Nothing changes for the other sections, and no
  admin action is needed.
