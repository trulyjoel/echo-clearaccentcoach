# 08 — Correction text panel

**What to build:** The structured error list from pass 1 renders in an on-screen side panel synced to the live conversation, giving the user the fuller written breakdown alongside Callie's brief spoken correction.

**Blocked by:** 07 — Two-pass correction pipeline

**Status:** ready-for-agent

- [ ] Each turn's structured error list (from pass 1) is sent to the client over the WebSocket
- [ ] A persistent side panel renders each error's category, original text, corrected text, and explanation
- [ ] The panel updates live as new turns produce new errors, without interrupting the conversation UI
- [ ] Turns with no errors show no new panel entries
- [ ] Panel entries are visually associated with the turn they came from (e.g. timestamp or turn reference)
