# Security policy

AcruxHub has **not had an independent audit**. It runs on Acrux Net with test tokens. Don't route real value through it.

## Reporting a vulnerability

Please report privately through [GitHub private vulnerability reporting](https://github.com/AcruxHub/AcruxHub/security/advisories/new). Don't open a public issue for security problems.

Include what's affected (program, SDK, web app, relayer), how to reproduce it, and the impact you expect. We'll acknowledge within a few days.

## Scope

- `programs/amm`, `programs/launchpad`, `programs/bridge`
- `sdk/` (including the threshold sealer)
- `relayer/`
- `web/` and `web/api/upload.ts`

What's tested and the known risks are in [docs/08-security.md](docs/08-security.md).
