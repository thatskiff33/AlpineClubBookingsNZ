- **A shared message-board post is no longer sent to the central server
  twice, and a new post no longer names a picture that has gone (#4590,
  #4592).**
  Three rare faults in the club message board are closed:
  - A shared post is now sent to the central server at most once. Before,
    if the server accepted it but recording that here failed, or the post
    route and the scheduled retry sent it at the same moment, it went out
    twice, leaving a copy on every club's board that could not be taken down
    from here. An accepted share is now recorded with the server's answer.
    The trade-off: in the rare case that the site restarts or the database
    drops in the middle of sharing, the share is dropped rather than sent
    twice, and the post shows as not shared; post it again. If the server
    took it but it could not be recorded here, nothing on screen says so yet:
    the server's id for the copy is in the error log, and the Message Board
    guide's troubleshooting table says how to have it taken down.
  - A long-running retention clean-up no longer releases the hold of a newer
    clean-up that took over from it.
  - A picture left unattached for over an hour can be cleared away just as a
    member posts it. The post is now refused with a message to add the
    picture again, instead of being published with a missing picture.
    A link to a picture pasted into a post's text no longer counts as one of
    its pictures.
