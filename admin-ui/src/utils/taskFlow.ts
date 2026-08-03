import { ElMessageBox } from 'element-plus'
import type { Router } from 'vue-router'

/**
 * 任务创建成功后引导用户前往任务中心确认执行（避免停在当前页误以为已完成）。
 * @param router Vue Router
 * @param summary 简要说明（已创建条数等）
 * @returns 用户是否选择前往任务中心
 */
export async function promptGoToTaskCenter(router: Router, summary = '任务已创建'): Promise<boolean> {
  try {
    await ElMessageBox.confirm(
      `${summary}\n\n任务不会自动执行，请到「任务中心」点击「确认执行」。`,
      '下一步：确认执行',
      {
        type: 'success',
        confirmButtonText: '前往任务中心',
        cancelButtonText: '稍后处理',
        distinguishCancelAndClose: true,
      },
    )
    await router.push('/tasks')
    return true
  } catch {
    return false
  }
}
