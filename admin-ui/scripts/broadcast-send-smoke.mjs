import { access } from 'node:fs/promises'

const ALLOWED_WECHAT_IDS = new Set(['ffqqybzbfk', 'gqygqy0301', 'fanfanerhao0824'])
const targetWechatId = process.env.TEST_TARGET_WECHAT_ID || ''
const imagePath = process.env.TEST_IMAGE_PATH || ''
const text = process.env.TEST_MESSAGE || '群发功能文字和图片测试，请忽略'
const baseUrl = process.env.WECHAT_API_URL || 'http://127.0.0.1:19088'

if (!ALLOWED_WECHAT_IDS.has(targetWechatId)) throw new Error('测试已停止：接收微信号不在允许名单中')
if (!imagePath) throw new Error('测试已停止：没有提供测试图片')
await access(imagePath)

async function post(path, body = {}) {
  const response = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const raw = await response.json()
  return { response, raw }
}

function findContacts(value, output = [], seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return output
  seen.add(value)
  if (Array.isArray(value)) { for (const item of value) findContacts(item, output, seen); return output }
  const alias = String(value.alias || value.Alias || '')
  const wxid = String(value.wxid || value.userName || value.UserName || '')
  if (alias) output.push({ alias, wxid })
  for (const child of Object.values(value)) findContacts(child, output, seen)
  return output
}

const login = await post('/api/check_login')
if (login.raw?.data?.status !== true) throw new Error('测试已停止：微信当前未登录')
const contacts = await post('/api/get_contact_list2')
const matches = findContacts(contacts.raw).filter((item) => item.alias === targetWechatId)
if (matches.length !== 1) throw new Error('测试已停止：允许名单中的微信号无法唯一匹配好友')
const targetWxid = matches[0].wxid
if (!targetWxid || targetWxid.endsWith('@chatroom')) throw new Error('测试已停止：接收对象不是个人好友')

const textResult = await post('/api/send_text_msg', { wxid: targetWxid, msg: text })
if (!textResult.response.ok || (textResult.raw?.code !== 1 && textResult.raw?.errCode !== 1)) throw new Error('文字测试发送失败')
const imageResult = await post('/api/send_image_msg', { wxid: targetWxid, filepath: imagePath })
if (!imageResult.response.ok || (imageResult.raw?.code !== 1 && imageResult.raw?.errCode !== 1)) throw new Error('图片测试发送失败')

console.log(JSON.stringify({ targetWechatId, text: '发送成功', image: '发送成功' }))
