export type RiskLevel = '高' | '中' | '低'
export type LoginStatus = '已登录' | '未登录' | '异常'
export type RunStatus = '运行中' | '已停止' | '异常'
export type TaskStatus = '待执行' | '执行中' | '已暂停' | '已完成' | '频繁暂停' | '频繁中止'
export type AddStatus = '未添加' | '已添加' | '已过滤' | '频繁暂停'
export type QrType = '群二维码' | '个人码' | '未知'
export type QrStatus = '待识别' | '已识别' | '已入群' | '频繁暂停'
export type LogLevel = '信息' | '成功' | '警告' | '错误'
export type SaveStatus = '未保存' | '已保存' | '保存中' | '保存失败'

export interface NavItem {
  key: string
  label: string
  path: string
  icon: string
}

export interface StatCardItem {
  key: string
  title: string
  value: string
  sub: string
  icon: string
  tone?: 'primary' | 'info' | 'warning' | 'danger' | 'success'
}
