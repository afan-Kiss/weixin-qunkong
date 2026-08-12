# MeshCentral wiring (silent client + admin console)

## Architecture

```
Windows client
  → login success (non-blocking)
  → ensureMeshReady(clientId)  [single-flight]
       1. check resources / Mesh Agent service
       2. missing→install (staged msh agentName=WXQK-<clientId>)
       3. stopped→start / broken→repair
       4. wait node + POST /api/mesh/auto-bind
       5. remoteReady=true

wxqk admin console (#/desktop · 远程桌面)
  → /api/mesh/session/desktop|files (admin token)
  → auto-bind self-heal if needed (shared for Desktop + Files)
  → MeshCentral 1.2.4 embed (?login=&node=&viewmode=11|13&hide=63)
```

## Bind priority (server)

1. Exact `name` / `agentName` == `WXQK-<clientId>` (new installs via `agentName=` in msh)
2. Existing `clientId ↔ meshNodeId` mapping if node still present
3. Unique hostname fallback only for legacy migration (admin/console auto-bind fills hostname from online hello meta)  
   Ambiguous hostname → never auto-bind

Client prepare: if bind keeps returning `MESH_NO_MATCH`, repair MeshAgent once with staged `agentName` then continue waiting.

## UX

- Never show users: `MESH_UNBOUND`, `meshNodeId`, `auto-bind`, Mesh node jargon
- Preparing: 「正在准备远程服务…」 etc.
- Failure only after prepare exhausted: 「远程服务准备失败」+ understandable reason
