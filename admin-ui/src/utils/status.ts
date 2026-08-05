export const statusLabels: Record<string, string> = {
  ONLINE: '在线',
  WAITING_LOGIN: '待登录',
  RESTORING: '恢复中',
  STARTING: '启动中',
  ERROR: '异常',
  STOPPED: '已停止',
  WAITING_SCAN: '待识别',
  SCANNED: '已识别',
  SCAN_FAILED: '识别失败',
  REFERENCE_ONLY: '仅归档',
  CLASSIFIED: '已分类',
  DUPLICATE: '重复',
  UNKNOWN: '未知',
  GROUP_LINK: '群二维码',
  PERSONAL_LINK: '个人二维码',
  QQ_GROUP_LINK: 'QQ群二维码',
  INVALID: '无效',
  NORMAL: '正常',
  INFO: '普通',
  WARNING: '提醒',
  WAITING_CONFIRMATION: '等待确认',
  QUEUED: '排队中',
  RUNNING: '执行中',
  PAUSED: '已暂停',
  CANCELLED: '已取消',
  COMPLETED: '已完成',
  SUBMITTED: '已提交待确认',
  REQUEST_SENT: '申请已提交',
  PROFILE_PENDING: '待取资料',
  CREDENTIALS_READY: '凭证已就绪',
  RESOLUTION_FAILED: '资料解析失败',
  PARTIAL_FAILED: '部分失败',
  FAILED: '执行失败',
  FREQUENT: '已经频繁',
  COOLING_DOWN: '冷却中',
  SKIPPED: '已跳过',
  READY: '待执行',
  BLOCKED_API_UNVERIFIED: '暂不可执行',
  UNSAFE_RESUME: '需要人工复核',
}
export const taskTypeLabels: Record<string, string> = { SEND_TEXT_TO_FRIEND: '发送好友文字', SEND_TEXT_TO_GROUP: '发送群聊文字', SEND_IMAGE_TO_FRIEND: '发送好友图片', SEND_IMAGE_TO_GROUP: '发送群聊图片', SEND_MIXED_TO_FRIEND: '发送好友消息', SEND_MIXED_TO_GROUP: '发送群聊消息', QR_SCAN: '二维码识别', ADD_FRIEND: '添加好友', KICKED_GROUP_CLEANUP: '清理被踢群' }

export function statusLabel(status: unknown) {
  const key = String(status ?? '')
  return statusLabels[key] ?? key
}
export function taskTypeLabel(type: unknown) { return taskTypeLabels[String(type ?? '')] ?? '其他任务' }
