'use strict';

/* Dsh GUI pairing preload — the bridge for the phone-pairing window.
   The pairing payload contains the secret, so it is fetched on demand and
   never pushed into the page as part of routine status updates. */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshPairing', {
  status: () => ipcRenderer.invoke('pairing:status'),
  enable: () => ipcRenderer.invoke('pairing:enable'),
  disable: () => ipcRenderer.invoke('pairing:disable'),
  rotate: () => ipcRenderer.invoke('pairing:rotate'),
  setRelay: (url) => ipcRenderer.invoke('pairing:set-relay', url),
  /** { payload, qr } — the QR is a data: URL rendered in main. */
  reveal: () => ipcRenderer.invoke('pairing:reveal'),
  copyPayload: () => ipcRenderer.invoke('pairing:copy'),
  onStatus: (fn) => ipcRenderer.on('pairing:status', (_e, s) => fn(s)),
  onTheme: (fn) => ipcRenderer.on('panel:theme', (_e, payload) => fn(payload)),
});
