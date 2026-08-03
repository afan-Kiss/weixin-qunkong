/**
 * Electron IPC 安全序列化：去掉不可 structured-clone 的值，避免
 * “An object could not be cloned” 把界面刷成「操作失败」气泡。
 */

/**
 * 将任意值转为可跨进程传递的纯 JSON 数据。
 * @param {unknown} value 原始值
 * @param {unknown} [fallback=null] 序列化失败时的回退
 * @returns {unknown}
 */
function safeCloneForIpc(value, fallback = null) {
  if (value === undefined) return null
  try {
    return JSON.parse(JSON.stringify(value, (_key, item) => {
      if (typeof item === 'bigint') return item.toString()
      if (typeof item === 'function' || typeof item === 'symbol') return undefined
      if (item instanceof Error) return { name: item.name, message: item.message, stack: String(item.stack || '').slice(0, 500) }
      if (item && typeof item === 'object') {
        // Buffer / TypedArray → 普通数组（体积大时仅标记，避免拖垮 IPC）
        if (typeof Buffer !== 'undefined' && Buffer.isBuffer(item)) {
          return item.length > 4096 ? { __type: 'Buffer', length: item.length } : [...item]
        }
        if (ArrayBuffer.isView(item)) {
          const view = /** @type {ArrayBufferView} */ (item)
          return view.byteLength > 4096
            ? { __type: view.constructor?.name || 'TypedArray', byteLength: view.byteLength }
            : Array.from(/** @type {any} */ (item))
        }
      }
      return item
    }))
  } catch {
    return fallback
  }
}

module.exports = { safeCloneForIpc }
