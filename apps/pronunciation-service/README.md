# apps/pronunciation-service

Modal-hosted HuPER Corrector service. See
`docs/superpowers/specs/2026-09-05-pronunciation-service-modal-design.md` for the design.

## Local development

```bash
uv sync
uv run pytest
uv run ruff check .
uv run ty check .
```

## Deploying

```bash
modal deploy modal_app.py
```

Prints a URL ending in `.modal.run` — set that as `PRONUNCIATION_SERVICE_URL` in `apps/server`'s
Fly secrets (`fly secrets set PRONUNCIATION_SERVICE_URL=...`).

## Secrets

- `pronunciation-service-auth` (Modal secret, holds `PRONUNCIATION_SERVICE_TOKEN`): create with
  `modal secret create pronunciation-service-auth PRONUNCIATION_SERVICE_TOKEN=<token>`. The same
  token value must also be set as `PRONUNCIATION_SERVICE_TOKEN` in `apps/server`'s Fly secrets —
  this service and `apps/server` share one static bearer token, checked on every `/score` request.
