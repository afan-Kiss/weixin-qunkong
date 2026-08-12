# MeshCentral integration (WXQK)

Remote maintenance uses **MeshCentral Relay only** (pinned **1.2.4** — see `deploy/meshcentral/VERSION`). The previous custom desktop path is retired.

## Architecture

```
Windows client (silent MeshAgent; no remote UI in product)
  → wxqk /api/mesh/auto-bind (software Bearer)

wxqk admin console (#/desktop)
  → /api/mesh/session/desktop|files (admin token only)
  → MeshCentral 1.2.4 (webRTC=false, allowLoginToken=true, allowFraming=true)
  → MeshAgent Windows service
```

## Hard requirements

1. `settings.webRTC: false` forever
2. `allowLoginToken: true`
3. No secrets in git / renderer / localStorage
4. Product opens only Desktop (`viewmode=11`) and Files (`viewmode=13`) with `hide=63`. Never Terminal (`12`)
5. Do not invent MeshCentral REST APIs — login cookies + embed query + `control.ashx` WebSocket only
6. Electron: `webSecurity=true`, `contextIsolation=true`, `nodeIntegration=false`, temporary session partition

## Deploy

```bash
cd deploy/meshcentral
python manage.py prepare
# edit .env + config.json
python manage.py validate
python manage.py up
python manage.py status
```

Image: `ghcr.io/ylianst/meshcentral:1.2.4` (never `:latest`). Volumes: `data/`, `files/`, `backups/`.

## Production TLS (public IP, no domain)

Production Mesh entry uses a **publicly trusted Let's Encrypt IP Address Certificate**
with the **shortlived** ACME profile (~6 days / 160 hours):

```text
https://120.27.219.138:8444
```

Requirements:

1. Certbot ≥ 5.4 with `--preferred-profile shortlived --ip-address <IP>`
2. HTTP-01 via nginx `/.well-known/acme-challenge/` on port 80
3. nginx loads `/etc/letsencrypt/live/<IP>/fullchain.pem` + `privkey.pem`
4. Unattended renew: `snap.certbot.renew.timer` + deploy-hook `systemctl reload nginx`
5. Extra nudge timer `wxqk-ip-cert-check.timer` (12h) logs validity and renews if &lt;48h left
6. Failed renewals append to `/var/log/letsencrypt/wxqk-ip-renew.log`
7. Electron Mesh BrowserWindow uses **system trust only** — never `rejectUnauthorized=false`,
   never unconditional `certificate-error` accept, never install self-signed CA into the client
8. `WXQK_MESH_TLS_CA` is optional and only for private/lab CAs — **not** used with public LE IP certs

### wxqk :8443 (same LE IP cert)

`:8443` (wxqk) and `:8444` (Mesh) share the same Let's Encrypt IP leaf.

Client SPKI pinning for `:8443` uses **dual pins** during rotation:

1. Legacy self-signed leaf SPKI (pre-cutover)
2. Let's Encrypt IP leaf SPKI (current)

`WXQK_TLS_SPKI_PINS` can override.

**Critical:** because `:8443` clients pin the **public CA leaf SPKI**, the Certbot lineage
must keep **`reuse_key = True`** forever (`certbot reconfigure --cert-name <IP> --reuse-key`
or first issue via `_issue_ip_cert.py` with `--reuse-key`). Otherwise each renew may mint a
new key → new SPKI → `TLS_CERT_PIN_MISMATCH` on already-shipped Electron builds.

Monitor: `/usr/local/sbin/wxqk-ip-cert-check` compares the live leaf SPKI to
`/etc/wxqk/le-ip-expected-spki.txt` and logs `CRITICAL SPKI_CHANGED` on drift (no auto-rollback).

Certbot renewals must **reuse the private key** so the LE SPKI remains stable.

## Login tokens (verified vs MeshCentral **1.2.4** `encodeCookie` / `webserver.js`)

Algorithm unchanged from prior releases: AES-256-GCM, `iv(12)||tag(16)||ciphertext`, base64 with `+/` → `@$`.

Cookie JSON for `?login=`:

```json
{ "u": "user//name", "a": 3, "time": <unix_sec>, "expire": <minutes> }
```

1.2.4 `webserver.js` calls `decodeCookie(req.query.login, key, **60**)` for URL login — without `expire`, the timeout argument is **60 minutes**. wxqk still sets `expire` explicitly via `WXQK_MESH_TOKEN_EXPIRE_MIN` (default **30**).

Userid domain check: `loginCookie.u.split('/')[1] == domain.id` → default domain requires `user//name`.

### Login Token session notes (1.2.3 / 1.2.4)

MeshCentral user-created login tokens set `req.session.loginToken` and block many WS admin actions. **encodeCookie `?login=` embed sessions do not set `req.session.loginToken`** — they create a normal `userid` session. Desktop/Files work. 1.2.3 fix (#8010) only relaxes `serverversion` for user-created token sessions; irrelevant to our embed path but confirms token-session hardening continues.

Embed URL:

```
{WXQK_MESH_URL}/?login={token}&node={leafNodeId}&viewmode=11|13&hide=63
```

`node` must be the **leaf id** only. MeshCentral `_id` like `node//…` is stripped by `normalize_node_query_id` before embedding (1.2.4 builds `currentNode = 'node/' + domain.id + '/' + query.node`).

## Agent packaging

```bash
cd admin-ui
# WXQK_MESH_AGENT_URL from MeshCentral 1.2.4 UI → Add Agent (typically /meshagents?id=…)
export WXQK_MESH_AGENT_URL='https://your-mesh/meshagents?id=4'
export WXQK_MESH_MSH_URL='…'   # matching .msh from same server
npm run fetch:mesh-agent
npm run check:mesh            # asserts VERSION/compose pin 1.2.4
```

## Mapping / APIs / Relay

Unchanged: `/api/mesh/*`, `mesh_node_map.json`, auto-bind via `control.ashx`, `check-mesh-relay.ps1`.

## Upgrade from 1.1.54 → 1.2.4

1. `python manage.py backup`
2. Set `MESHCENTRAL_VERSION=1.2.4` in `.env` / `VERSION`
3. `python manage.py validate && python manage.py up`
4. Confirm `webRTC=false` and `allowLoginToken=true`
5. Re-download Agent from **this** 1.2.4 server if MeshCentral requires agent rebuild
6. Re-test Desktop + Files embed

## Related

- `deploy/meshcentral/manage.py`
- `admin-ui/scripts/fetch-mesh-agent.cjs` / `check-mesh.cjs`
- `server/wxqk/meshcentral_client.py` (`PINNED_MESHCENTRAL_VERSION = "1.2.4"`)
