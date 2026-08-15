# 11 — Audio clip capture + storage

**What to build:** When pass 1 flags an error, the surrounding audio segment (not the full session) is clipped, compressed, and uploaded to Cloudflare R2, linked to the Error row, with a default 90-day expiry.

**Blocked by:** 07 — Two-pass correction pipeline

**Status:** ready-for-agent

- [ ] For each detected error, the audio segment covering that portion of the user's turn is extracted (not the full session recording)
- [ ] Clips are compressed to Opus before upload
- [ ] Clips are uploaded to Cloudflare R2 and the storage reference is linked to the corresponding Error row
- [ ] Each stored clip has a default expiry of 90 days from creation
- [ ] An expiry/cleanup mechanism removes clips past their expiry (unless bookmarked, per ticket 13)
- [ ] No clip is stored for a user who has not given recording consent (ticket 03)
