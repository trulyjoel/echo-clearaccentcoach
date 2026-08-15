# 09 — L1-driven interference hints

**What to build:** Pass 1's prompt is seeded with the user's stored native language (L1, captured in ticket 03) to bias error detection toward interference patterns known to be common for speakers of that language. Unsupported/"Other" L1s keep the generic taxonomy from ticket 07.

**Blocked by:** 07 — Two-pass correction pipeline

**Status:** ready-for-agent

- [ ] Pass 1 prompt includes L1-specific interference-pattern hints for each of the top 4-5 supported native languages
- [ ] The correct hint set is selected based on the user's stored L1 from onboarding (ticket 03)
- [ ] Users with an unsupported L1 or "Other" get the generic taxonomy with no L1-specific hints, and pass 1 still functions normally for them
- [ ] Hint sets are sourced from established contrastive-analysis/L2 error literature for each covered L1
- [ ] Detected errors are still categorized using the same five generic categories from ticket 07 (L1 hints bias detection, they don't add new categories)
