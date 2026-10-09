const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('zsenseShot', Object.freeze({
  onInit: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('zsense:global-screenshot:init', listener)
    return () => ipcRenderer.removeListener('zsense:global-screenshot:init', listener)
  },
  select: (rectangle) => ipcRenderer.invoke('zsense:global-screenshot:select', rectangle),
  output: (action, image) => ipcRenderer.invoke('zsense:global-screenshot:output', { action, image }),
  close: () => ipcRenderer.invoke('zsense:global-screenshot:close'),
}))
