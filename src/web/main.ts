// The web build's entry.
//
// Order is the whole point: the renderer's own entry reads `window.floe` while
// it is still evaluating (`applyConfig()` runs before the first render), so the
// bridge has to be installed before that module is even imported. A static
// import would be hoisted above this call, hence the dynamic one.

import { installFloe, type FloeBoot } from './bridge'

const boot = (window as unknown as { __FLOE_BOOT__?: FloeBoot }).__FLOE_BOOT__
if (!boot) throw new Error('no boot payload — the page was not served by the Floe daemon')

installFloe(boot)

await import('../renderer/src/main')
