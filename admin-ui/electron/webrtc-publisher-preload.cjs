'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('wxPub', {
  onCommand(handler) {
    ipcRenderer.on('webrtc-pub:command', (_event, payload) => {
      try { handler(payload || {}) } catch (_) {}
    })
  },
  send(type, payload = {}) {
    ipcRenderer.send('webrtc-pub:event', { type, ...(payload || {}) })
  },
})
