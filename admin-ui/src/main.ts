import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import { ElMessage } from 'element-plus'
import 'element-plus/dist/index.css'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import App from './App.vue'
import router from './router'
import './styles/theme.css'
import { isIpcCloneError, isUserDismissError, userErrorMessage } from './utils/error'
import { bootstrapClientUpdate } from './utils/clientUpdate'

const app = createApp(App)
let lastToastAt = 0
let lastToastText = ''

/**
 * 上报界面错误到主进程日志（不弹气泡）。
 * @param error 原始错误
 */
function reportUiError(error: unknown) {
  if (isUserDismissError(error)) return
  const message = error instanceof Error ? error.message : String(error ?? '未知错误')
  void window.wxControl?.reportError?.('界面操作失败', { reason: message.slice(0, 500) })
}

/**
 * 防刷屏错误气泡：同文案 4 秒内只弹一次；取消/克隆类噪声不弹。
 * @param error 原始错误
 */
function showUiErrorToast(error: unknown) {
  if (isUserDismissError(error)) return
  // 克隆失败已在 IPC 层修复并写日志，避免动不动弹「操作失败」
  if (isIpcCloneError(error)) {
    reportUiError(error)
    return
  }
  const text = userErrorMessage(error)
  if (!text) return
  const now = Date.now()
  if (text === lastToastText && now - lastToastAt < 4000) return
  lastToastText = text
  lastToastAt = now
  ElMessage.error(text)
}

app.config.errorHandler = (error) => {
  reportUiError(error)
  showUiErrorToast(error)
}
window.addEventListener('error', (event) => reportUiError(event.error || event.message))
window.addEventListener('unhandledrejection', (event) => {
  reportUiError(event.reason)
  // 未处理 Promise 也走防刷屏，但克隆类仍只记日志
  if (isIpcCloneError(event.reason) || isUserDismissError(event.reason)) return
  showUiErrorToast(event.reason)
})
app.use(router)
app.use(ElementPlus, { locale: zhCn, size: 'default' })
app.mount('#app')
void bootstrapClientUpdate()
