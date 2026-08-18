'use strict';

/**
 * Node half of the shell plugin.
 *
 * The interesting half is client.js, which runs in the engine's page. This file
 * exists because the loader needs a package to mount: the client scanner walks
 * the host loader's entries looking for packages that declare `dsh.client`, so
 * a client-only package would never be seen.
 */

export function apply() {
  // Nothing to do on the server. The UI regions live entirely in the browser.
}
