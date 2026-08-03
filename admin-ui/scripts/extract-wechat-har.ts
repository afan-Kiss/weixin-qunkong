import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'

type JsonObject = Record<string, unknown>

interface ExtractedApiContract {
  sourceId: number
  name: string
  method: string
  path: string
  requestBodySchema: unknown
  requestExample: unknown
  responseExamples: unknown[]
  description: string
  updatedAt: string
  sourceHarSha256: string
  contractStatus: 'CONFIRMED' | 'RESPONSE_VERIFY' | 'REFERENCE_ONLY'
}

const harPath = resolve(process.argv[2] || 'C:/Users/6/Desktop/微信.har')
const outputPath = resolve(process.argv[3] || 'docs/generated/wechat-api-contracts.json')

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hydrateFlat(serialized: unknown): unknown {
  if (!Array.isArray(serialized)) return serialized
  const cache = new Map<number, unknown>()

  const dereference = (ref: unknown): unknown => {
    if (typeof ref !== 'number') return ref
    if (ref < 0) return ref === -1 ? undefined : null
    if (cache.has(ref)) return cache.get(ref)
    const raw = serialized[ref]
    if (Array.isArray(raw)) {
      const result: unknown[] = []
      cache.set(ref, result)
      for (const item of raw) result.push(dereference(item))
      return result
    }
    if (isObject(raw)) {
      const result: JsonObject = {}
      cache.set(ref, result)
      for (const [encodedKey, value] of Object.entries(raw)) {
        const keyRef = Number(encodedKey.slice(1))
        const key = typeof serialized[keyRef] === 'string' ? serialized[keyRef] as string : encodedKey
        result[key] = dereference(value)
      }
      return result
    }
    cache.set(ref, raw)
    return raw
  }

  return dereference(0)
}

function walk(value: unknown, visit: (object: JsonObject) => void, seen = new Set<unknown>()): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  if (isObject(value)) {
    visit(value)
    for (const child of Object.values(value)) walk(child, visit, seen)
  } else {
    for (const child of value) walk(child, visit, seen)
  }
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}

function extractContractsFromPayload(payload: string, sha256: string): ExtractedApiContract[] {
  let decoded: unknown
  try { decoded = hydrateFlat(JSON.parse(payload)) } catch { return [] }
  const contracts: ExtractedApiContract[] = []
  walk(decoded, (object) => {
    if (object.type !== 'apiDetail') return
    const candidate = isObject(object.data) ? object.data : object
    if (typeof candidate.id !== 'number') return
    const requestBody = isObject(candidate.requestBody) ? candidate.requestBody : {}
    const examples = Array.isArray(requestBody.examples) ? requestBody.examples : []
    const responses = Array.isArray(candidate.responses) ? candidate.responses : []
    const responseExamples = responses.flatMap((response) => {
      if (!isObject(response) || !Array.isArray(response.responseExamples)) return []
      return response.responseExamples.map((sample) => isObject(sample) ? parseMaybeJson(sample.value ?? sample.data) : sample)
    })
    const rawPath = typeof candidate.path === 'string' ? candidate.path : ''
    const path = rawPath.replace(/^https?:\/\/127\.0\.0\.1:\d+/, '')
    const emptyResponse = responseExamples.length === 0 || responseExamples.every((item) => item == null || (isObject(item) && Object.keys(item).length === 0))
    contracts.push({
      sourceId: candidate.id,
      name: typeof candidate.name === 'string' ? candidate.name : '',
      method: typeof candidate.method === 'string' ? candidate.method.toUpperCase() : '',
      path,
      requestBodySchema: requestBody.jsonSchema ?? null,
      requestExample: isObject(examples[0]) ? parseMaybeJson(examples[0].value) : null,
      responseExamples,
      description: typeof candidate.description === 'string' ? candidate.description : '',
      updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : '',
      sourceHarSha256: sha256,
      contractStatus: path ? (emptyResponse ? 'RESPONSE_VERIFY' : 'CONFIRMED') : 'REFERENCE_ONLY',
    })
  })
  return contracts
}

async function main() {
  const harBytes = await readFile(harPath)
  const har = JSON.parse(harBytes.toString('utf8')) as JsonObject
  const sha256 = createHash('sha256').update(harBytes).digest('hex').toUpperCase()
  const entries = ((har.log as JsonObject)?.entries ?? []) as JsonObject[]
  const bySourceId = new Map<number, ExtractedApiContract>()

  for (const entry of entries) {
    const response = isObject(entry.response) ? entry.response : {}
    const content = isObject(response.content) ? response.content : {}
    const url = String((entry.request as JsonObject)?.url ?? '')
    const text = typeof content.text === 'string' ? content.text : ''
    if (!url.includes('s.apifox.cn') || !url.includes('.data') || !text) continue
    const payload = content.encoding === 'base64' ? Buffer.from(text, 'base64').toString('utf8') : text
    for (const contract of extractContractsFromPayload(payload, sha256)) {
      const current = bySourceId.get(contract.sourceId)
      const score = (value: ExtractedApiContract) => (value.requestBodySchema ? 4 : 0) + (value.requestExample ? 2 : 0) + value.responseExamples.length
      if (!current || score(contract) > score(current)) bySourceId.set(contract.sourceId, contract)
    }
  }

  const contracts = [...bySourceId.values()].sort((a, b) => a.sourceId - b.sourceId)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, JSON.stringify({ sourceHar: harPath, sourceHarSha256: sha256, apiDetailCount: contracts.length, contracts }, null, 2), 'utf8')
  const mdPath = outputPath.replace(/\.json$/i, '.md')
  const rows = contracts.map((c) => `| ${c.sourceId} | ${c.name.replaceAll('|', '\\|')} | ${c.method || '-'} | ${c.path || '-'} | ${c.contractStatus} |`)
  await writeFile(mdPath, `# WeChat API Contracts\n\n- Source: \`${harPath}\`\n- SHA-256: \`${sha256}\`\n- apiDetail: ${contracts.length}\n\n| sourceId | Name | Method | Path | Status |\n|---:|---|---|---|---|\n${rows.join('\n')}\n`, 'utf8')
  console.log(`Extracted ${contracts.length} apiDetail contracts from ${basename(harPath)}`)
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
