# MeshCentral integration (WXQK)

Remote maintenance uses **MeshCentral Relay only** (pinned **1.2.4** — see `deploy/meshcentral/VERSION`). The previous custom desktop path is retired.

## Architecture

```
Vue RemoteSupport → RemoteService → Electron IPC (clientId only)
  → wxqk /api/mesh/* (auth + ownership + mapping)
  → MeshCentral 1.2.4 (webRTC=false, allowLoginToken=true)
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
