function rawErrorMessage(error) {
  return error instanceof Error ? error.message : String(error ?? '')
}

function toUserErrorMessage(error, fallback = '操作失败') {
  const message = rawErrorMessage(error).trim()
  if (!message) return fallback
  if (/fetch failed|failed to fetch|econnrefused|connect.*refused/i.test(message)) return '无法连接微信控制接口，请确认微信已正常启动并等待几秒后重试'
  if (/aborted|aborterror|timed?\s*out|timeout/i.test(message)) return '请求超时，微信控制接口暂时没有响应，请稍后重试'
  if (/econnreset|socket hang up|other side closed/i.test(message)) return '微信控制连接已中断，请确认微信进程是否仍在运行'
  if (/eaddrinuse|address already in use/i.test(message)) return '端口已被其他程序占用，请刷新端口或更换起始端口后重试'
  if (/eacces|eperm|access.*denied|permission denied|operation not permitted/i.test(message)) return '权限不足，无法完成该操作，请检查安全软件拦截或以管理员方式运行'
  if (/enoent|no such file|cannot find|not found/i.test(message)) return '所需文件或程序不存在，请检查微信、注入器和 DLL 路径'
  if (/sqlite.*constraint|unique constraint|constraint failed/i.test(message)) return '本地数据发生冲突，请刷新页面后重试'
  if (/database is locked|sqlite_busy/i.test(message)) return '本地数据库正在忙，请稍后重试'
  if (/error invoking remote method|ipc.*(failed|error)/i.test(message)) return '软件内部通信失败，请重启管理软件后重试'
  if (/object has been destroyed|render frame was disposed/i.test(message)) return '软件窗口状态已失效，请重新打开软件'
  if (/\p{Script=Han}/u.test(message)) return message
  return `${fallback}，请到“设置与日志”查看详细原因`
}

module.exports = { rawErrorMessage, toUserErrorMessage }
