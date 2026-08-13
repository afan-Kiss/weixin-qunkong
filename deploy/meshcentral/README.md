# MeshCentral deployment (WXQK)

Pinned release: see `VERSION` (currently **1.2.4**). Never deploy `:latest` in production.

Relay-only remote maintenance. Replaces the retired custom desktop path.

## Hard requirements

1. **`settings.webRTC` must stay `false` forever** (Relay only; no P2P).
2. **`allowLoginToken`: true** — wxqk mints short-lived embed cookies server-side.
3. No production secrets in git (`.env`, `config.json`, TLS keys, `loginTokenKey`, `meshagent.msh`).
4. Product UI only opens Desktop (`viewmode=11`) and Files (`viewmode=13`) with `hide=63`. Never Terminal (`12`).

## Quick start

```bash
cd deploy/meshcentral
python manage.py bootstrap --public-host <YOUR_MESH_HOST>
python manage.py doctor
```

Idempotent bootstrap: prepare → config defaults → validate → compose up →
read MeshCentral 1.2.4 `loginTokenKey` via `node …/meshcentral --loginTokenKey` →
sync server-only `wxqk-mesh.env` and `/etc/wxqk/mesh.env`, merge Mesh keys into
`/etc/wxqk/wxqk.env`, and remind you to restart wxqk with:

```text
EnvironmentFile=-/etc/wxqk/mesh.env
```

wxqk `server.py` also loads `/etc/wxqk/mesh.env` at process start (server-only).

Never prints the full login key (only length + fingerprint).

Manual steps still available:

```bash
python manage.py prepare
# edit .env + config.json (Cert, allowedFramingOrigins, hostname)
python manage.py validate
python manage.py up
python manage.py status
python manage.py gen-secret --write ./wxqk-mesh.env   # no stdout secret unless --show-secret
```

Manual equivalent:

```bash
cp .env.example .env
cp config.example.json config.json
docker compose up -d
```

Volumes:

| Host | Container | Purpose |
|------|-----------|---------|
| `./data` | `/opt/meshcentral/meshcentral-data` | DB, certs, state |
| `./files` | `/opt/meshcentral/meshcentral-files` | File transfer |
| `./backups` | `/opt/meshcentral/meshcentral-backups` | Server backups |
| `./config.json` | `.../config.json` (ro) | Config |

Ports: `443` HTTPS/WSS, `80` redirect, `4433` Agent.

## Login token key

On the MeshCentral host (after first start):

```bash
docker compose exec meshcentral node node_modules/meshcentral --loginTokenKey
```

Put the hex into **wxqk server** env as `WXQK_MESH_LOGIN_KEY` (alias `WXQK_MESH_SECRET`) —
preferably via `python manage.py bootstrap` which writes `wxqk-mesh.env` / `/etc/wxqk/mesh.env`.
Never put it in the Electron renderer, portable client, git, or chat.

Cookies minted by wxqk include MeshCentral `expire` (minutes, default 30 via `WXQK_MESH_TOKEN_EXPIRE_MIN`). Without `expire`, MeshCentral only accepts ~2 minutes.

## Agent packages for Electron

```bash
cd admin-ui
# set WXQK_MESH_AGENT_URL / WXQK_MESH_MSH_URL from your MeshCentral "Add Agent" download links
npm run fetch:mesh-agent
npm run check:mesh
```

Release packaging runs `check:mesh --strict` and fails if exe/msh are missing.

## TLS (Let's Encrypt IP + SPKI)

Production uses a Let's Encrypt **IP Address Certificate** (`shortlived` profile) for
`https://<PUBLIC_IP>:8443` (wxqk) and `:8444` (Mesh).

Electron pins the **leaf SPKI** for `:8443`. Therefore the Certbot renewal config **must**
contain:

```ini
reuse_key = True
```

Set on first issue:

```bash
# from a workstation with SSH env configured
python deploy/meshcentral/_issue_ip_cert.py
```

Or persist onto an existing lineage (official API; runs staging validation):

```bash
python deploy/meshcentral/_enable_reuse_key.py
# equivalent remote:
# certbot reconfigure --cert-name <IP> --reuse-key --non-interactive
```

Do **not** rely on a one-off `certbot renew --reuse-key` flag; timers call plain `certbot renew`
and must inherit reuse from the renewal conf.

SPKI monitor: `/etc/wxqk/le-ip-expected-spki.txt` + `wxqk-ip-cert-check.timer`.

## Relay verification

1. `config.json` → `"webRTC": false`
2. On Windows clients/viewers: `.\check-mesh-relay.ps1`
3. Confirm MeshAgent TCP peers are your MeshCentral host, not the viewer public IP

## Backup / upgrade

```bash
python manage.py backup
# edit VERSION + .env MESHCENTRAL_VERSION
python manage.py validate
python manage.py up
# re-check webRTC=false
```

See `docs/meshcentral-integration.md`.
