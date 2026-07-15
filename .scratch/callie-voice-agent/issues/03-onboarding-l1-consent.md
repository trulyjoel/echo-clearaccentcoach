# 03 — Onboarding: native language + recording consent

**What to build:** After a user's first login, they select their native language (L1) and give explicit consent to voice recording/storage before any session can start. Both are persisted on their profile and not asked again on return visits.

**Blocked by:** 02 — Sign up / log in

**Status:** ready-for-agent

- [ ] First-login user is prompted to select their L1 from a fixed shortlist (the top 4-5 supported languages) plus an "Other" option
- [ ] First-login user is shown an explicit, specific consent step for voice recording/storage (distinct from general ToS), and must accept before proceeding
- [ ] L1 selection and consent acceptance (with timestamp) are persisted on the user's profile
- [ ] Returning user is not re-prompted for L1 or consent on subsequent logins
- [ ] No session/recording can start for a user who has not completed consent
