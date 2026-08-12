const fs = require('fs');
let forge = null;
try { forge = require('/opt/meshcentral/meshcentral/node_modules/node-forge'); } catch (e1) {
  try { forge = require('node-forge'); } catch (e2) {}
}
const common = require('/opt/meshcentral/meshcentral/common.js');
const certPem = fs.readFileSync('/opt/meshcentral/meshcentral-data/agentserver-cert-public.crt', 'utf8');
let serverid = '';
const tries = [];
if (typeof common.certificateToHash === 'function') {
  try { serverid = common.certificateToHash(certPem); tries.push('pem:' + (serverid || '').length); } catch (e) { tries.push('pemERR:' + e.message); }
  try { if (!serverid) { serverid = common.certificateToHash(Buffer.from(certPem)); tries.push('buf:' + (serverid || '').length); } } catch (e) { tries.push('bufERR:' + e.message); }
}
function sha384Hex(bytes) {
  const md = forge.md.sha384.create();
  md.update(bytes);
  return md.digest().toHex();
}
if (!serverid && forge) {
  try {
    const cert = forge.pki.certificateFromPem(certPem);
    serverid = sha384Hex(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes());
    tries.push('sha384cert');
  } catch (e) { tries.push('sha384certERR:' + e.message); }
}
if (!serverid && forge) {
  try {
    const cert = forge.pki.certificateFromPem(certPem);
    serverid = sha384Hex(forge.asn1.toDer(forge.pki.publicKeyToAsn1(cert.publicKey)).getBytes());
    tries.push('sha384spki');
  } catch (e) { tries.push('spkiERR:' + e.message); }
}
const lines = [
  'MeshName=WXQK Devices',
  'MeshID=' + process.env.MID,
  'ServerID=' + serverid,
  'MeshServer=' + process.env.MS
];
fs.writeFileSync('/tmp/out.msh', lines.join('\r\n') + '\r\n');
console.log(JSON.stringify({ sidlen: serverid.length, tries: tries }));
