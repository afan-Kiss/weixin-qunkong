/**
 * 判断是否为用户主动取消对话框（不应弹错误气泡）。
 * @param error 原始错误
 */
export function isUserDismissError(error: unknown) {
  if (error === 'cancel' || error === 'close') return true
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /^(cancel|close)$/i.test(message.trim())
}

/**
 * 判断是否为 IPC 克隆失败（已在主进程侧修复，界面侧避免刷屏）。
 * @param error 原始错误
 */
export function isIpcCloneError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /could not be cloned|An object could not be cloned|DataCloneError/i.test(message)
}

/**
 * 将底层错误转成用户可读文案。
 * @param error 原始错误
 * @param fallback 默认文案
 */
export function userErrorMessage(error: unknown, fallback = '操作失败') {
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (!message) return fallback
  if (isUserDismissError(error)) return ''
  if (isIpcCloneError(error)) return '数据传输失败，请稍后重试；若反复出现请重启软件'
  if (/fetch failed|failed to fetch|econnrefused|connect.*refused/i.test(message)) return '无法连接微信控制接口，请确认微信已正常启动并等待几秒后重试'
  if (/aborted|aborterror|timed?\s*out|timeout/i.test(message)) return '请求超时，微信控制接口暂时没有响应，请稍后重试'
  if (/econnreset|socket hang up/i.test(message)) return '微信控制连接已中断，请确认微信进程是否仍在运行'
  if (/eaddrinuse|address already in use/i.test(message)) return '端口已被其他程序占用，请更换端口后重试'
  if (/eacces|eperm|access.*denied|permission denied/i.test(message)) return '权限不足，请检查安全软件拦截或以管理员方式运行'
  if (/enoent|no such file|cannot find|not found/i.test(message)) return '所需文件或程序不存在，请检查微信安装是否完整'
  if (/error invoking remote method|ipc.*(failed|error)/i.test(message)) return '软件内部通信失败，请重启管理软件后重试'
  if (/\p{Script=Han}/u.test(message)) return message
  return `${fallback}，请到“设置与日志”查看详细原因`
}
