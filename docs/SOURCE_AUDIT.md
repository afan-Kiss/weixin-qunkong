# 来源审查报告

## 已确认来源

- 微信 HAR：`C:\Users\6\Desktop\微信.har`
- HAR 大小：27,170,267 bytes
- HAR SHA-256：`4086F4123E3AEE398DE90ED4B370AC2CFC8033A8A107DE0474B3CCFFBBC6AF6E`
- 正式提取脚本：`admin-ui/scripts/extract-wechat-har.ts`
- 合同 JSON：`admin-ui/docs/generated/wechat-api-contracts.json`
- 合同 Markdown：`admin-ui/docs/generated/wechat-api-contracts.md`
- 去重后的 `apiDetail`：131 个

所有合同均来源于 Apifox HAR 的 `resourceData.type === "apiDetail"`，没有把侧栏 URL 当作请求体。当前合同状态全部为 `RESPONSE_VERIFY`，原因是 HAR 中对应响应示例为空对象或不足以完成实机成功码验证。

## 4.1.8.27 工具

| 文件 | 架构 | SHA-256 | 结论 |
|---|---|---|---|
| `inject.exe` | x64 | `F839265D1D986BD072135038A27DDB242F39165C572BCB16609A9030A304734E` | 注入启动器 |
| `libGLESv1.dll` | x64 | `0F66F21D86D8D273E6DA0FB8D0FBEAE59FA0A501E633504AED52F77B79C7A528` | 用户确认的控制 DLL，按此使用 |
| `WeChatWin_4.1.8.27.exe` | x64 | 未启动验证 | 工具目录中的文件，需确认是否为安装程序/可执行目标 |
| `E:\weixin\Weixin.exe` | x64 | `132E336E16C0D452104D7B9C68971086FFA853F27C8ECCD4351D2B8D24BB3896` | 当前实际安装目标 |
| `命令行参数.txt` | - | - | 旧示例仍写 4.1.5.30 与 libencode.dll |

启动协议按现有文件说明实现：

```text
inject.exe <Weixin.exe> <libGLESv1.dll> <config-json>
```

实际运行路径必须先准备到纯英文 runtime 目录，不能把中文源码路径直接传给 `inject.exe`。每个实例独立分配 HTTP API 端口、TCP 回调端口、实例 ID、PID、HWND 和 API Client。

## 当前 UI

现有页面：登录、总览、微信实例、群与成员、二维码任务、群发、通讯录、任务中心、日志设置、会话监控、远程桌面。工程是 Vue 3 + Vite + Electron，当前 Electron 没有 preload/IPC，页面主要依赖 `src/mock`。

本次新增：左侧“微信 ID 查询”页面，提供好友 WXID、群 roomId、群成员 WXID 的独立查询入口。

## 未确认事项

- 尚未在指定测试账号上启动注入、调用接口并记录真实响应。
- 尚未确认 `WeChatWin_4.1.8.27.exe` 是否是可直接注入的目标；实现默认使用已确认的 `E:\weixin\Weixin.exe`。
- 远程桌面和自建后台不在本阶段范围内。
