function createSerialExecutor() {
  let tail = Promise.resolve()
  return function run(operation) {
    const result = tail.then(operation)
    tail = result.catch(() => undefined)
    return result
  }
}

/** GBK：DLL注入成功 / DLL注入失败（来自 inject.exe 实测输出） */
const GBK_INJECT_SUCCESS = Buffer.from('D7A2C8EBB3C9B9A6', 'hex')
const GBK_INJECT_FAILED = Buffer.from('D7A2C8EBCAA7B0DC', 'hex')

/**
 * 在 Buffer 中查找子串。
 * @param {Buffer} haystack 原始输出
 * @param {Buffer} needle 目标字节
 * @returns {boolean}
 */
function bufferIncludes(haystack, needle) {
  return haystack.indexOf(needle) !== -1
}

/**
 * 将 inject.exe 的 GBK 输出解码为可读文本。
 * @param {Buffer[]} chunks stdout/stderr 分片
 * @returns {string}
 */
function decodeInjectorChunks(chunks) {
  const raw = Buffer.concat((chunks || []).map((chunk) => Buffer.from(chunk)))
  try {
    return new TextDecoder('gbk').decode(raw)
  } catch {
    return raw.toString('utf8')
  }
}

/**
 * 解析 inject.exe 输出，判断 DLL 注入是否成功。
 * 同时使用 GBK 文本与原始字节匹配，避免编码/粘包导致误判。
 * @param {Buffer[]} chunks inject.exe 标准输出分片
 * @param {{ exitCode?: number | null }} [options]
 * @returns {{ output: string, pid: number | null, failed: boolean, succeeded: boolean, raw: Buffer }}
 */
function parseInjectorOutput(chunks, options = {}) {
  const raw = Buffer.concat((chunks || []).map((chunk) => Buffer.from(chunk)))
  const output = decodeInjectorChunks(chunks)
  const pidMatch = output.match(/PID:\s*(\d+)/i)
  const failed = output.includes('DLL注入失败')
    || output.includes('目标进程分配内存失败')
    || bufferIncludes(raw, GBK_INJECT_FAILED)
  const textSucceeded = (output.includes('DLL注入成功') || bufferIncludes(raw, GBK_INJECT_SUCCESS)) && !failed
  // 退出码 0 且已拿到微信 PID、又无失败标记时，按成功处理（避免 stdout 粘包导致漏读“成功”）
  const exitCode = options.exitCode
  const pid = pidMatch ? Number(pidMatch[1]) : null
  const softSucceeded = !failed && exitCode === 0 && Number.isInteger(pid) && pid > 0
  const succeeded = textSucceeded || softSucceeded
  return { output, pid, failed, succeeded, raw }
}

/**
 * 等待子进程 stdout/stderr 收完后再读取 exitCode。
 * Windows 上仅监听 exit 时，最后一段“DLL注入成功”可能尚未进入 data 回调。
 * 注意：调用方必须在 spawn 后立刻自行累积 stdout，本函数不再挂 data 监听，避免漏读早到的输出。
 * @param {import('child_process').ChildProcess} child
 * @returns {Promise<{ code: number | null, signal: NodeJS.Signals | null }>}
 */
function waitForInjectorClose(child) {
  return new Promise((resolve) => {
    let settled = false
    let exitCode = null
    let exitSignal = null
    let stdoutEnded = !child.stdout
    let stderrEnded = !child.stderr
    let processExited = false

    const maybeResolve = () => {
      if (settled || !processExited || !stdoutEnded || !stderrEnded) return
      settled = true
      resolve({ code: exitCode, signal: exitSignal })
    }

    child.stdout?.once('end', () => { stdoutEnded = true; maybeResolve() })
    child.stdout?.once('error', () => { stdoutEnded = true; maybeResolve() })
    child.stderr?.once('end', () => { stderrEnded = true; maybeResolve() })
    child.stderr?.once('error', () => { stderrEnded = true; maybeResolve() })
    child.once('exit', (code, signal) => {
      exitCode = code
      exitSignal = signal
      processExited = true
      // 给 stdio 一点时间冲刷；仍以 end 为准，超时兜底
      setTimeout(() => {
        stdoutEnded = true
        stderrEnded = true
        maybeResolve()
      }, 500)
      maybeResolve()
    })
    child.once('error', () => {
      processExited = true
      stdoutEnded = true
      stderrEnded = true
      maybeResolve()
    })
  })
}

module.exports = { createSerialExecutor, parseInjectorOutput, decodeInjectorChunks, waitForInjectorClose }
