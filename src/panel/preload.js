'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshPanel', {
  // state stream (main polls the DSH bridge and forwards)
  onState: (cb) => ipcRenderer.on('panel:state', (_e, s) => cb(s)),
  // terminal
  onPtyData: (cb) => ipcRenderer.on('panel:pty-data', (_e, d) => cb(d)),
  onPtyExit: (cb) => ipcRenderer.on('panel:pty-exit', (_e, d) => cb(d)),
  ptyOpen: (cols, rows) => ipcRenderer.send('panel:pty-open', cols, rows),
  ptyInput: (data) => ipcRenderer.send('panel:pty-input', data),
  ptyResize: (cols, rows) => ipcRenderer.send('panel:pty-resize', cols, rows),
  ptyClose: () => ipcRenderer.send('panel:pty-close'),
  // live browser view
  onBrowserShot: (cb) => ipcRenderer.on('panel:browser-shot', (_e, s) => cb(s)),
  // tab switching (so main knows when to spawn/refresh the PTY)
  tabChanged: (tab) => ipcRenderer.send('panel:tab', tab),
  // collapse the whole panel (Codex-style hide; Cmd+B / menu restore it)
  collapsePanel: () => ipcRenderer.send('panel:collapse'),
});
