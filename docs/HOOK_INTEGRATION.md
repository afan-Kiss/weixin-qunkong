# 微信 Hook 与 API 对接说明

## 工具位置
- Hook 包：`4.1.8.27/`
  - `inject.exe` 注入器
  - `WeChatWin_4.1.8.27.exe` / 配套 DLL
  - `python_demo/app.py`：HTTP 回调接收示例（`POST /api/recvMsg`）
  - `python_demo/tcp_server.py`：TCP 回调示例（默认 `61108`）

## 注入参数要点
```json
{
  "recivemode": "http",
  "tcp_ip": "127.0.0.1",
  "tcp_port": 61108,
  "http_server_port": 19088,
  "http_callback_url": "http://127.0.0.1:5000/api/recvMsg",
  "usedefault": false,
  "start_server_while_login": true
}
```

- `http_server_port`：本地功能 API（与桌面 `微信.har` / Apifox「微信40通用」一致，基址 `http://127.0.0.1:19088`）
- `http_callback_url`：群聊/私聊等消息回调地址（桌面 Agent 应监听并转发到 `/wxqk`）

## 登录与注册（已确认）
- 管理后台：密码登录（同发财888 `POST /api/login` + `X-Admin-Token`）
- 桌面端：Ed25519 设备自动注册

## 数据流
1. Hook 回调 → 本地 Agent 解析消息/进群/图片
2. 需要时调用 `19088` API（下载图片、加好友、加群等）
3. Agent 上报 → `https://xiangyuzhubao.xyz/wxqk` 落库/存图
4. admin-ui 查询展示，支持手动清理图片
