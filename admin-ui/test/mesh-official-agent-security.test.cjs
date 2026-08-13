'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const root = path.join(__dirname, '..', '..')

test('formal meshcentral scripts must not use AutoAddPolicy', () => {
  const files = [
    'deploy/meshcentral/manage.py',
    'deploy/meshcentral/provision_official_agent.py',
    'deploy/meshcentral/remote_deploy.py',
    'deploy/meshcentral/remote_prod_deploy.py',
    'deploy/meshcentral/deploy_remote.py',
  ]
  for (const rel of files) {
    const p = path.join(root, rel)
    if (!fs.existsSync(p)) continue
    const text = fs.readFileSync(p, 'utf8')
    assert.equal(text.includes('AutoAddPolicy'), false, rel + ' uses AutoAddPolicy')
    assert.equal(/rejectUnauthorized\s*:\s*false/.test(text), false, rel + ' disables TLS')
  }
})

test('no underscore temp agent-fetch scripts remain in deploy/meshcentral', () => {
  const dir = path.join(root, 'deploy', 'meshcentral')
  const bad = fs.readdirSync(dir).filter((n) => /^_(fetch|stage|create_mesh|finish_msh)/i.test(n))
  assert.deepEqual(bad, [])
})

test('strict check-mesh requires branded WXQK.exe', () => {
  const script = path.join(root, 'admin-ui', 'scripts', 'check-mesh.cjs')
  const text = fs.readFileSync(script, 'utf8')
  assert.match(text, /WXQK\.exe/)
  assert.match(text, /--strict/)
})
