# 旧远控模块清单（WebRTC / LiveKit / TURN / JPEG）

分析日期：2026-08-12  
状态：**已执行删除 + MeshCentral 迁移完成**（见下方「执行结果」）

目标：彻底删除自研远程桌面实现，改用 MeshCentral + MeshAgent。  
原则：`remote-agent` 的 **设备在线 / 策略 / wx_sync / 公告** 通道保留；仅删除桌面采集、输入注入、WebRTC/LiveKit/JPEG 图传。

---

## 架构（删除前）

```text
Electron main
  └─ remote-agent.cjs  ──WS──► /api/ws/agent
        ├─ JPEG / dirty-rect → /api/ws/viewer
        ├─ webrtc-desktop → LiveKit publisher
        └─ win-input（鼠标键盘）

Admin viewers:
  ├─ admin_ui.py #/desktop
  └─ deploy_rd_portal_888 PORTAL_HTML（:888 屏幕墙）

Server: webrtc_session.py + livekit_session.py
Infra: deploy_turn / deploy_livekit*
```

---

## 一、纯远控 / 可整文件删除

| 文件 | 作用 | 入口 | 被谁引用 | 纯远控 | 能否删除 | 删除影响 |
|------|------|------|----------|--------|----------|----------|
| `admin-ui/electron/webrtc-desktop.cjs` | LiveKit 推流隐藏窗 | remote-agent require | remote-agent、测试 | 是 | 是 | LiveKit 推流消失 |
| `admin-ui/webrtc-desktop.cjs` | 与 electron 副本同步 | 同步测试 | webrtc-desktop-module.test | 是 | 是 | 无运行时影响 |
| `admin-ui/electron/webrtc-publisher.html` | getDisplayMedia + LiveKit | webrtc-desktop loadFile | webrtc-desktop | 是 | 是 | 同上 |
| `admin-ui/electron/webrtc-publisher-preload.cjs` | publisher IPC 桥 | BrowserWindow preload | webrtc-desktop | 是 | 是 | 同上 |
| `admin-ui/electron/vendor/livekit-client.umd.js` | LiveKit SDK | publisher script | publisher.html | 是 | 是 | 同上 |
| `admin-ui/electron/win-input.cjs` | 远程键鼠注入 | remote-agent only | remote-agent、可靠性测试 | 是 | 是 | 旧远控键鼠失效（预期） |
| `server/wxqk/webrtc_session.py` | ICE/TURN 会话 | server import | server、deploy_turn、审计 | 是 | 是 | `/api/desktop/webrtc/*` 失效 |
| `server/wxqk/livekit_session.py` | LiveKit token | server/webrtc_session | server、部署脚本 | 是 | 是 | LiveKit 路径失效 |
| `server/wxqk/deploy_turn.py` | coturn 部署 | 手工 | 文档/备注 | 是 | 是 | 无法从仓库重装 coturn |
| `server/wxqk/deploy_livekit.py` | LiveKit Docker 部署 | 手工 | env→livekit_session | 是 | 是 | 无法从仓库重装 LiveKit |
| `server/wxqk/deploy_livekit_bin.py` | LiveKit 二进制部署 | 手工 | 同上 | 是 | 是 | 同上 |
| `server/wxqk/coturn_notes.txt` | coturn 手记 | 文档 | — | 是 | 是 | 文档丢失 |
| `admin-ui/test/webrtc-desktop-module.test.cjs` | LiveKit/publisher 契约 | npm test | — | 是 | 是 | 旧测试移除 |
| `admin-ui/test/remote-agent-reliability.test.cjs` | 旧 agent/WebRTC 契约 | npm test | — | 是 | 是（替换为 Mesh 测试） | 需新测试覆盖 |
| `admin-ui/test/hidden-remote.test.cjs` | 断言 Vue 无远控入口 | npm test | — | 是 | 否→改写 | 新 UI 需暴露「远程维护」 |

---

## 二、混合模块（禁止整文件删除）

| 文件 | 作用 | 远控部分 | 必须保留 | 删除策略 |
|------|------|----------|----------|----------|
| `admin-ui/electron/remote-agent.cjs` | 设备 WS：在线、策略、公告、wx_sync、诊断、更新 + **桌面图传/控制** | desktopCapturer、JPEG、LiveKit、control、file 远控 | 设备通道、start/stop/getStatus | **剥离**桌面代码，保留业务 agent |
| `admin-ui/remote-agent.cjs` | electron 副本 | 同左 | 无（仅同步测试） | 删除根副本，只留 electron/ |
| `admin-ui/electron/main.cjs` | 启动 agent、IPC remote:* | remote:open-console、桌面相关 | startRemoteAgent 登录联动、clientId | 改 IPC 为 Mesh；保留 agent 启动 |
| `server/wxqk/server.py` | 业务 API + 桌面 API/WS | `/api/desktop/*`、viewer JPEG/webrtc、start_desktop | `/api/ws/agent`、设备、登录、任务 | **切除**桌面路由与 JPEG/webrtc 分支 |
| `server/wxqk/admin_ui.py` | Web 管理台含 `#/desktop` | LiveKit+JPEG 桌面页 | 设备/发布等管理页 | 移除 desktop 路由与 LiveKit CDN |
| `server/wxqk/deploy_rd_portal_888.py` | :888 屏幕墙 + nginx | `PORTAL_HTML` LiveKit 墙 | `NGINX_PORT_CONF`（enable_https_ip / deploy_to_new_host） | **不可整删**；清空墙 HTML 为占位，保留 nginx 常量 |
| `server/wxqk/enable_https_ip.py` | HTTPS/nginx | 注释 TURN；import portal | 整文件 | 去掉 TURN 注释依赖，保留 import |
| `server/wxqk/deploy_to_new_host.py` | 新主机部署 | import portal | 整文件 | 保留 import；portal 变为占位 |
| `server/wxqk/deploy.py` | EXTRA_PY / 版本策略 | webrtc/livekit 文件列表 | 其它部署 | 从 EXTRA_PY 移除 session 模块 |
| `server/wxqk/audit_release_security.py` | `check_turn` | webrtc_session | 其它审计 | 删除 check_turn |
| `server/wxqk/update_manifest.py` / `version_policy.py` / `client_gate.py` | `desktopProtocolVersion` | 协议头 | 网关本身 | 保留字段兼容或改为 mesh 标记，不删模块 |
| `admin-ui/electron/device-identity.cjs` / `client-updater.cjs` / `secure-config.cjs` | 协议头/路径 | desktop 命名 | 身份/更新/配置 | 只去远控依赖，不删模块 |
| `server/wxqk/test_remote_security.py` | 远控安全 + wx_sync 等 | desktop ticket 等 | 非桌面安全用例 | 改写为 Mesh/会话所有权测试 |

---

## 三、服务端旧远控 API（须删除）

| 路由 / 通道 | 作用 |
|-------------|------|
| `GET/POST /api/desktop/webrtc/ice-config` | TURN/ICE |
| `POST /api/desktop/webrtc/session` | 创建桌面会话 |
| `POST /api/desktop/webrtc/stop` | 停止会话 |
| `GET /api/desktop/latest` | JPEG 快照 |
| `POST /api/desktop/start` / `stop` | 启停采集 |
| `POST /api/desktop/upload` | 旧帧上传 |
| `POST /api/desktop/start-camera` / `stop-camera` | 摄像头 |
| `/api/ws/viewer` 中 webrtc_* / frame / control / file | 观众端 |
| agent WS：`start_desktop` / `stop_desktop` / `frame` / `frame_delta` / `webrtc_*` / `control` | 推流与控制 |

保留：`/api/ws/agent` 的 hello、heartbeat、策略、命令队列、wx_sync 等非桌面消息。

---

## 四、环境变量（旧远控，部署侧可废弃）

- `FACAI888_TURN_*` / `WXQK_TURN_*` / `SIREN_TURN_SECRET`
- `WXQK_LIVEKIT_*` / `LIVEKIT_*`
- `RD_PORTAL_SSH_*`（仅屏幕墙部署）

---

## 五、Vue / preload

- `admin-ui/src`：**无** RemoteSupport 页（hidden-remote 故意隐藏）
- `preload.cjs`：**无** remote API
- 迁移后：**新增** 远程维护页 + IPC，不恢复旧 WebRTC API

---

## 六、删除优先级

1. **Tier 0**：根目录镜像、coturn_notes、纯 LiveKit/TURN 文件、vendor SDK  
2. **Tier 1**：剥离 remote-agent 桌面代码；删除 server 桌面路由；清空 portal 墙；删纯远控测试  
3. **Tier 2**：引入 MeshCentral（deploy + adapter + agent manager + UI）  
4. **禁止**：`git reset --hard` / 删除设备身份、登录、更新、业务 WSS、任务系统

---

## 七、结论摘要

| 问题 | 答案 |
|------|------|
| win-input 是否仅远控？ | **是**，可删 |
| remote-agent 能否整删？ | **否**，剥离桌面后保留 |
| deploy_rd_portal 能否整删？ | **否**，nginx 常量被其它部署引用 |
| 根目录 remote-agent 副本？ | **可删**（仅 electron/ 打包） |
| 旧远控与 Mesh 可否并存？ | **否**，彻底删除旧链路 |

---

## 八、执行结果（2026-08-12）

已删除纯远控文件：`webrtc-desktop*`、`win-input`、`livekit*`、`webrtc_session`、`deploy_turn/livekit*`、`coturn_notes`、旧相关测试。

已剥离：`remote-agent.cjs`（仅保留业务 WS）、`server.py` `/api/desktop/*` → 410、`admin_ui` desktop 页占位、`deploy_rd_portal_888` 屏幕墙占位。

已新增：MeshCentral deploy、`meshcentral_client` / `mesh_api`、`mesh-agent-manager`、`mesh-remote-bridge`、`RemoteSupport`、`remote-service`、文档与测试。
