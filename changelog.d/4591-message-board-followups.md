- **A shared message-board post is no longer sent to the central server
  twice, and a new post no longer names a picture that has gone (#4590).**
  Three rare faults in the club message board are closed:
  - If the central server accepted a shared post but recording that here
    failed, the next try shared it again, leaving a copy on every club's board
    that could not be taken down from here. The accepted share is now
    recorded with the server's answer and never sent again; if it still cannot
    be recorded, the post says so and names the copy on the server.
  - A long-running retention clean-up no longer releases the hold of a newer
    clean-up that took over from it.
  - A picture left unattached for over an hour can be cleared away just as a
    member posts it. The post is now refused with a message to add the
    picture again, instead of being published with a missing picture.
