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
python manage.py prepare    # copies .env.example / config.example.json, creates data|files|backups
# edit .env + config.json (Cert, allowedFramingOrigins, hostname)
python manage.py validate
python manage.py up         # docker compose up -d
python manage.py status
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

Put the hex into wxqk env as `WXQK_MESH_LOGIN_KEY` (alias `WXQK_MESH_SECRET`). Never put it in the Electron renderer or git.

Cookies minted by wxqk include MeshCentral `expire` (minutes, default 30 via `WXQK_MESH_TOKEN_EXPIRE_MIN`). Without `expire`, MeshCentral only accepts ~2 minutes.

## Agent packages for Electron

```bash
cd admin-ui
# set WXQK_MESH_AGENT_URL / WXQK_MESH_MSH_URL from your MeshCentral "Add Agent" download links
npm run fetch:mesh-agent
npm run check:mesh
```

Release packaging runs `check:mesh --strict` and fails if exe/msh are missing.

## Nginx

See `nginx.example.conf` (HTTPS + WebSocket Upgrade + 3600s timeouts).

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
