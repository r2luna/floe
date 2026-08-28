// CDP driver for the Rookery dev app on :9229 (screenshot tooling, not app code)
// usage: node rookery-cdp.mjs <cmd> [args...]
//   reload | eval "<js>" | shot <outfile> | key <key> [meta|shift|alt|ctrl ...] | type "<text>" | click "<selector>"
const port = 9229;

async function target() {
  const list = await (await fetch(`http://localhost:${port}/json`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  return page.webSocketDebuggerUrl;
}

let id = 0;
const pending = new Map();
const ws = new WebSocket(await target());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
function send(method, params = {}) {
  return new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}

const KEYS = {
  Enter: { code: 'Enter', key: 'Enter', keyCode: 13 },
  Escape: { code: 'Escape', key: 'Escape', keyCode: 27 },
  Tab: { code: 'Tab', key: 'Tab', keyCode: 9 },
  ArrowDown: { code: 'ArrowDown', key: 'ArrowDown', keyCode: 40 },
  ArrowUp: { code: 'ArrowUp', key: 'ArrowUp', keyCode: 38 },
};

async function pressKey(name, mods) {
  let modifiers = 0;
  for (const m of mods) modifiers |= { alt: 1, ctrl: 2, meta: 4, shift: 8 }[m] || 0;
  const k = KEYS[name] || { code: `Key${name.toUpperCase()}`, key: name, keyCode: name.toUpperCase().charCodeAt(0) };
  const base = { code: k.code, key: k.key, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers };
  const printable = name.length === 1 && modifiers === 0;
  await send('Input.dispatchKeyEvent', { type: printable ? 'keyDown' : 'rawKeyDown', ...base, ...(printable ? { text: name } : {}) });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

const [cmd, ...args] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

switch (cmd) {
  case 'reload':
    await send('Page.reload');
    await sleep(1500);
    break;
  case 'eval': {
    const r = await send('Runtime.evaluate', { expression: args[0], returnByValue: true, awaitPromise: true });
    console.log(JSON.stringify(r.result?.result ?? r.result, null, 1));
    break;
  }
  case 'shot': {
    await sleep(300);
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(args[0], Buffer.from(r.result.data, 'base64'));
    console.log('wrote', args[0]);
    break;
  }
  case 'key':
    await pressKey(args[0], args.slice(1));
    await sleep(250);
    break;
  case 'type':
    for (const ch of args[0]) { await pressKey(ch, []); await sleep(30); }
    break;
  case 'click': {
    const r = await send('Runtime.evaluate', {
      expression: `(()=>{const el=document.querySelector(${JSON.stringify(args[0])});if(!el)return 'NOT FOUND';el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));el.click();return 'clicked '+el.className;})()`,
      returnByValue: true,
    });
    console.log(JSON.stringify(r.result?.result?.value));
    await sleep(400);
    break;
  }
  default:
    console.error('unknown cmd');
}
ws.close();
