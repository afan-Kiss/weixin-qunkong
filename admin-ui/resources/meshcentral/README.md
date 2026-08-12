# MeshAgent binaries (not committed)

Place the Windows agent files downloaded from **your** MeshCentral server here before packaging the Electron client:

| File | Required | Notes |
|------|----------|-------|
| `meshagent.exe` | yes | Agent binary from MeshCentral → device group → Add Agent |
| `meshagent.msh` | yes | Pairing file from the same download (contains ServerID / MeshID) |

## How to obtain

1. Open your MeshCentral admin UI (HTTPS).
2. Select the device group used for WXQK remote maintenance.
3. Use **Add Agent** → Windows → download the agent pair for that group.
4. Copy `meshagent.exe` and `meshagent.msh` into this directory (`admin-ui/resources/meshcentral/`).

Do **not** invent or hand-edit `ServerID`. The `.msh` must come from the live server that agents will contact.

## Packaging

In production builds, these files are expected under `process.resourcesPath/meshcentral/`.
In development, `mesh-agent-manager.cjs` resolves to this folder.

## Security

- Treat `.msh` as sensitive (it points agents at your server / group).
- Never commit production `.msh` or real server hostnames into git.
- Keep MeshCentral `webRTC=false` (Relay-only).

See `docs/meshcentral-integration.md` and `deploy/meshcentral/README.md`.
