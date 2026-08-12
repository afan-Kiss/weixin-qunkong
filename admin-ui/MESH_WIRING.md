# MeshCentral ↔ Electron wiring — COMPLETED

Wiring is implemented. See:

| Piece | Path |
|-------|------|
| Agent lifecycle | `admin-ui/electron/mesh-agent-manager.cjs` |
| Session bridge | `admin-ui/electron/mesh-remote-bridge.cjs` |
| IPC | `main.cjs` `mesh:*` + `preload.cjs` `remote*` |
| Vue service / UI | `remote-service.ts` / `RemoteSupport.vue` |
| Server | `meshcentral_client.py` / `mesh_api.py` |

Hard rules unchanged: `webRTC: false`, no secrets in renderer, no `webSecurity: false`.

Embed: parented BrowserWindow + `temp:` partition; close clears cookies.
Agent: login/start → `ensureLocalMeshAgent` → best-effort `/api/mesh/auto-bind`.
Scripts: `npm run fetch:mesh-agent`, `npm run check:mesh`, `deploy/meshcentral/manage.py`.
