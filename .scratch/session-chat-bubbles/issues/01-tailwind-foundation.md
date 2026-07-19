# 01 — Tailwind CSS styling foundation

**What to build:** The project's first styling foundation. Not user-facing on its own — this is
prefactoring so every subsequent ticket in this feature can apply real visual styling instead of
building on unstyled markup.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Tailwind CSS is installed and wired into the frontend build via its Vite plugin, with no
      separate PostCSS or Tailwind config file needed.
- [ ] A single CSS entry file imports Tailwind and defines the violet/lavender theme tokens (accent
      colors) that later tickets will use for the bubble palette.
- [ ] The entry file is imported once at the app's root so Tailwind utility classes are available
      anywhere in the frontend.
- [ ] `pnpm build`, `pnpm dev`, `pnpm typecheck`, and `pnpm lint` all still succeed with no new
      warnings.
- [ ] A minimal smoke check confirms a Tailwind utility class actually applies in the rendered app
      (e.g., a visibly styled element somewhere), proving the pipeline works end-to-end.

## Comments
