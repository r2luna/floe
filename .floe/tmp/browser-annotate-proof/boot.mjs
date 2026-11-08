import { app, mcp, mcpPorts, targets, wait } from './cdp.mjs'

for (let i = 0; i < 60; i++) {
  try {
    if ((await targets()).some((t) => t.type === 'page')) break
  } catch {}
  await wait(1000)
}
console.log((await targets()).map((t) => `${t.type} ${t.url}`).join('\n'))
const ports = mcpPorts()
console.log('listening', ports)
const c = await app()
console.log('floe api', await c.evaluate(`typeof window.floe?.browser?.capture`))
for (const port of ports) {
  try {
    const r = await mcp(port, 'list_projects')
    console.log('mcp', port, JSON.stringify(r).slice(0, 400))
    const w = await mcp(port, 'list_sessions')
    console.log('sessions', JSON.stringify(w).slice(0, 400))
    break
  } catch (e) {
    console.log('mcp', port, 'no:', e.message.slice(0, 80))
  }
}
c.close()
