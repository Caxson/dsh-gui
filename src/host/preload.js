'use strict';

/**
 * Host preload for the engine view.
 *
 * The engine's page is the one surface a user always has in front of them, so
 * app-level controls belong in its sidebar rather than behind a panel that is
 * hidden by default. This is the only channel between that page and the app.
 *
 * Deliberately narrow. The engine page renders model output and tool results,
 * so what is reachable from it is a security question, not a convenience one:
 * this exposes appearance and window layout and nothing else. No filesystem, no
 * shell, no session control — those stay on channels the engine page cannot
 * see. Adding to this list is adding to what a page full of untrusted text can
 * reach, and should be treated that way.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshGuiHost', {
  /** Palettes and which one is showing, for a picker. */
  themes: () => ipcRenderer.invoke('panel:themes'),
  /** Apply one, or the string "system" to follow the machine. */
  setTheme: (id) => ipcRenderer.invoke('panel:theme-set', id),
  /** Show or hide the right panel — the same action as the menu item. */
  togglePanel: () => ipcRenderer.send('panel:collapse'),
  /** Whether the panel is open, so a control can show which state it is in. */
  panelVisible: () => ipcRenderer.invoke('panel:visible'),
  /** Fires when either changes, so injected UI can follow without polling. */
  onHostState: (fn) => {
    ipcRenderer.on('host:state', (_e, state) => fn(state));
  },
});
