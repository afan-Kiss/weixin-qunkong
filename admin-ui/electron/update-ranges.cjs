/**
 * Byte-range helpers for resume progress (ignore ftruncate preallocation size).
 */

/**
 * Normalize a list of [start, end] inclusive ranges; drop invalid.
 * @param {unknown} ranges
 * @returns {Array<[number, number]>}
 */
function normalizeRanges(ranges) {
  const out = []
  if (!Array.isArray(ranges)) return out
  for (const item of ranges) {
    let start
    let end
    if (Array.isArray(item) && item.length >= 2) {
      start = Number(item[0])
      end = Number(item[1])
    } else if (item && typeof item === 'object') {
      start = Number(item.start)
      end = Number(item.end)
    } else continue
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    start = Math.floor(start)
    end = Math.floor(end)
    if (start < 0 || end < start) continue
    out.push([start, end])
  }
  return out
}

/**
 * Merge overlapping / adjacent inclusive ranges.
 * @param {unknown} ranges
 * @returns {Array<[number, number]>}
 */
function mergeIntervals(ranges) {
  const sorted = normalizeRanges(ranges).sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (!sorted.length) return []
  const merged = [[sorted[0][0], sorted[0][1]]]
  for (let i = 1; i < sorted.length; i += 1) {
    const [start, end] = sorted[i]
    const last = merged[merged.length - 1]
    if (start <= last[1] + 1) {
      if (end > last[1]) last[1] = end
    } else {
      merged.push([start, end])
    }
  }
  return merged
}

/**
 * Count unique completed bytes from inclusive ranges.
 * @param {unknown} ranges
 * @returns {number}
 */
function completedUniqueBytes(ranges) {
  let total = 0
  for (const [start, end] of mergeIntervals(ranges)) {
    total += end - start + 1
  }
  return total
}

/**
 * Build completed ranges from part descriptors `{ start, end, done }`.
 * @param {Array<{ start: number, end: number, done?: boolean }>} parts
 * @returns {Array<[number, number]>}
 */
function rangesFromDoneParts(parts) {
  const ranges = []
  if (!Array.isArray(parts)) return ranges
  for (const part of parts) {
    if (!part || !part.done) continue
    const start = Number(part.start)
    const end = Number(part.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue
    ranges.push([start, end])
  }
  return mergeIntervals(ranges)
}

module.exports = {
  normalizeRanges,
  mergeIntervals,
  completedUniqueBytes,
  rangesFromDoneParts,
}
