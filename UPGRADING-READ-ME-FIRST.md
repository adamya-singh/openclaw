# ⚠ READ BEFORE UPGRADING THIS GATEWAY

**Run published STABLE tags only. Never `main`. Never `-beta.` / `-rc.`.**

## What went wrong on 2026-08-08

This gateway was checked out on `main` at `39c405e` — an unreleased `2026.7.2`
dev build, ahead of *every* published release. The latest stable at the time was
`v2026.7.1-2`, and there was no stable `2026.7.2` at all.

The macOS app (`2026.7.1`, current with stable) could not handle the newer
gateway's exec-approval payload. It **auto-denied every approval prompt in
under 100ms**:

| resolve time | decision | command                        |
| ------------ | -------- | ------------------------------ |
| 60ms         | deny     | `openclaw nodes status`        |
| 63ms         | deny     | `python3 …/agentic-journal…`   |
| 180ms        | deny     | `python3 -c 'import json…'`    |

Each was recorded with `terminal_reason: user` and
`resolver_id: Adamya's MacBook Pro`, so it looked like a human pressed Deny.
Nobody did. Quitting the macOS app fixed it instantly — the same class of
command then stayed pending ~15s and was allowed.

Symptoms to recognise:

- Approval prompts never reach Telegram.
- Commands come back "Denied" that you never saw, let alone denied.
- Approvals resolve in tens of milliseconds (no human is that fast).

## Correct upgrade procedure

```bash
cd ~/projects/openclaw
git fetch --tags origin

# pick the newest tag with NO alpha/beta/rc/pre in the name
git tag -l 'v*' --sort=-v:refname | grep -vEi 'alpha|beta|rc|pre' | head -1

git checkout --detach <that-tag>
CI=true pnpm install --frozen-lockfile
pnpm ui:build      # non-fatal if it fails
pnpm build
systemctl --user restart openclaw-gateway.service
openclaw --version
```

Then confirm the gateway and the macOS app report the **same** version.

## Automated guard

`.git/hooks/post-checkout` and `.git/hooks/post-merge` print a loud warning
whenever HEAD is not the latest stable tag. They live in `.git/`, so they
survive checkouts and are never clobbered by a pull. They only warn — they
never block a git operation.
