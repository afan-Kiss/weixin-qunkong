/**
 * 消息群发：对象过滤（公众号、排除规则）。
 */

/** 微信公众号 wxid 以 gh_ 开头。 */
export function isOfficialAccountWxid(wxid: string) {
  return /^gh_/i.test(String(wxid || '').trim())
}

/** 多行/逗号分隔排除词，去空白去重。 */
export function splitExcludeRules(text: string) {
  const seen = new Set<string>()
  const result: string[] = []
  for (const part of String(text || '').split(/[\r\n,，]+/)) {
    const value = part.trim()
    if (!value) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result
}

/** 备注是否命中排除：任意规则在备注中「包含」即排除（忽略大小写）。 */
export function remarkMatchesExclude(remark: string, rules: string[]) {
  const haystack = String(remark || '').toLowerCase()
  if (!haystack || !rules?.length) return false
  return rules.some((rule) => haystack.includes(String(rule || '').toLowerCase()))
}

/** 昵称精确匹配排除（忽略大小写）。 */
export function nicknameExactExcluded(nickname: string, rules: Set<string> | string[]) {
  const set = rules instanceof Set
    ? rules
    : new Set((rules || []).map((item) => String(item || '').trim().toLowerCase()).filter(Boolean))
  const name = String(nickname || '').trim().toLowerCase()
  return Boolean(name && set.has(name))
}

/** 微信号精确匹配排除（忽略大小写）。 */
export function wxidExactExcluded(wxid: string, rules: Set<string> | string[]) {
  const set = rules instanceof Set
    ? rules
    : new Set((rules || []).map((item) => String(item || '').trim().toLowerCase()).filter(Boolean))
  return set.has(String(wxid || '').trim().toLowerCase())
}
