# 14 — Error history / progress view

**What to build:** A user can view past sessions and their flagged errors, grouped by category, so they can see which mistakes recur across sessions over time.

**Blocked by:** 07 — Two-pass correction pipeline

**Status:** ready-for-agent

- [ ] User can view a list of their past sessions with date and duration
- [ ] User can view the flagged errors for a given past session, with category, original text, and corrected text
- [ ] User can see an aggregate view of error frequency by category across all their sessions
- [ ] History view only shows the requesting user's own data
- [ ] View reflects new sessions/errors as soon as they're persisted (no separate sync step)
