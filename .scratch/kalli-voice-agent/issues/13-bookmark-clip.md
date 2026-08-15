# 13 — Bookmark a clip

**What to build:** A user can bookmark a specific error's audio clip to exempt it from the default 90-day expiry.

**Blocked by:** 11 — Audio clip capture + storage

**Status:** ready-for-agent

- [ ] User can toggle a bookmark on a stored audio clip from the error review UI
- [ ] Bookmarked clips are excluded from the expiry/cleanup mechanism from ticket 11
- [ ] Un-bookmarking a clip restores it to the normal expiry schedule (90 days from original creation, not reset)
- [ ] Bookmark state persists and is visible when the user revisits the error later
