'use strict';

/* Dsh GUI panel preload — the only bridge between the sandboxed panel
   renderer and the main process. All engine traffic is proxied by main. */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshPanel', {
  // ── terminals (id-keyed; 'agent' is the shared agent terminal) ──────────
  ptyOpen: (id, cols, rows) => ipcRenderer.send('panel:pty-open', id, cols, rows),
  ptyInput: (id, data) => ipcRenderer.send('panel:pty-input', id, data),
  ptyResize: (id, cols, rows) => ipcRenderer.send('panel:pty-resize', id, cols, rows),
  ptyClose: (id) => ipcRenderer.send('panel:pty-close', id),
  onPtyData: (cb) => ipcRenderer.on('panel:pty-data', (_e, id, data) => cb(id, data)),

  // ── activity/state + live browser view ──────────────────────────────────
  onState: (cb) => ipcRenderer.on('panel:state', (_e, state) => cb(state)),
  onBrowserShot: (cb) => ipcRenderer.on('panel:browser-shot', (_e, shot) => cb(shot)),

  // ── side chat (ephemeral, streamed) ─────────────────────────────────────
  sidechatSend: (chatId, messages) => ipcRenderer.send('panel:sidechat-send', chatId, messages),
  sidechatAbort: (chatId) => ipcRenderer.send('panel:sidechat-abort', chatId),
  onSidechatChunk: (cb) =>
    ipcRenderer.on('panel:sidechat-chunk', (_e, chatId, text, done, error) => cb(chatId, text, done, error)),

  // ── window/tab plumbing ─────────────────────────────────────────────────
  tabChanged: (tab) => ipcRenderer.send('panel:tab', tab),
  openTerminals: (ids) => ipcRenderer.send('panel:terminals', ids),
  collapsePanel: () => ipcRenderer.send('panel:collapse'),
  popOut: () => ipcRenderer.send('panel:popout'),
});
