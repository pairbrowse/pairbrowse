# 10. Cloudflare Quick Tunnels carry sharing by default

- Status: Accepted
- Date: by v0.13.1 (2026-10-04); a keeper per tunnel in v0.15.11 (2026-10-05); your own tunnel as an option in v0.15.37 (2026-10-10) ([CHANGELOG](../../CHANGELOG.md))

## Context

Join codes and dev server sharing must reach a person on another computer. Opening a port on the
user's machine, asking them to configure a router, or running a PairBrowse relay server would each
add setup or a party that sees the traffic. The live view's ports listen on 127.0.0.1 only.

## Decision

- By default a share goes through a Cloudflare Quick Tunnel: a temporary
  `https://<words>.trycloudflare.com` address, no Cloudflare account, no open port (`cloudflared`
  connects out). It reaches only the joiner port (never the owner's), which serves nothing without
  an approved join code ([sharing.md](../sharing.md#join-someones-session-with-a-code)).
- `cloudflared` is downloaded once from Cloudflare's GitHub releases, pinned by SHA-256 per
  platform, and installed under the shared install lock.
- A joiner's PairBrowse accepts `*.trycloudflare.com` codes without a prompt; any other host is the
  person's own decision (Allow once or Always allow), never an agent's.
- Each tunnel runs under a keeper that stops it once no helper beats, so a crash leaves nothing open.
- People who need a stable address can set `sharing.tunnel` to a named Cloudflare tunnel, ngrok,
  Tailscale Funnel or a command ([sharing.md](../sharing.md#using-your-own-tunnel)).

## Consequences

- Sharing works with no account and no network setup on either side.
- Quick Tunnels have no uptime guarantee, a limit on requests in flight and a limit on how many can
  be opened in a while; the helper keeps a pool, keeps a tunnel up a while after the last code
  (CHANGELOG 0.15.34) and joiners fail over to a standby.
- Cloudflare relays the traffic; the join code's key and the host's Allow still gate every
  joiner ([security.md](../security.md), "A join code points somewhere else").

## In code

- `scripts/tunnels/quick.mjs`: `CLOUDFLARED`, `ensureCloudflared`, `startQuickTunnel`,
  `adoptTunnel`, `watchTunnel`, `tunnelUrl`
- `scripts/tunnels/keeper.mjs` (entry `scripts/tunnel-keeper.mjs`); `scripts/tunnels/config.mjs`,
  `scripts/tunnels/start.mjs` (your own tunnel)
- `scripts/daemon/tunnel-pool.mjs`: `createTunnelPool`
- `scripts/util.mjs`: `isQuickTunnelHost`; `scripts/sharing/join.mjs`: `hostAllowed`
- `scripts/sharing/devshare.mjs` (dev server sharing through its own Quick Tunnel)
