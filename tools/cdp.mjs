// Tiny Chrome DevTools Protocol driver for screenshots of the game.
// usage: node tools/cdp.mjs <url> <outdir> <script>
// script: semicolon list of: wait:ms | key:Code[:holdms] | down:Code | up:Code | shot:name | eval:js
import fs from 'node:fs';

const [url, outDir, script = 'wait:3000;shot:a'] = process.argv.slice(2);
const ver = await (await fetch('http://127.0.0.1:9222/json/version')).json();
const tgt = await (await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(tgt.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
const logs = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) {
    pending.get(d.id)(d);
    pending.delete(d.id);
  } else if (d.method === 'Runtime.consoleAPICalled') {
    logs.push(d.params.type + ': ' + d.params.args.map((a) => a.value ?? a.description).join(' '));
  } else if (d.method === 'Runtime.exceptionThrown') {
    logs.push('EXCEPTION: ' + JSON.stringify(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
  }
};
const send = (method, params = {}) =>
  new Promise((r) => {
    const i = ++id;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1195, height: 896, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = async (type, code) => {
  const keyName = { Enter: 'Enter', Space: ' ', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight' }[code] || code.replace('Key', '').toLowerCase();
  await send('Input.dispatchKeyEvent', { type, code, key: keyName, windowsVirtualKeyCode: code === 'Enter' ? 13 : 0 });
};
for (const step of script.split(';').filter(Boolean)) {
  const [cmd, a, b] = step.split(':');
  if (cmd === 'wait') await sleep(+a);
  else if (cmd === 'key') {
    await key('keyDown', a);
    await sleep(+(b || 80));
    await key('keyUp', a);
  } else if (cmd === 'down') await key('keyDown', a);
  else if (cmd === 'up') await key('keyUp', a);
  else if (cmd === 'shot') {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`${outDir}/${a}.png`, Buffer.from(r.result.data, 'base64'));
  } else if (cmd === 'eval') {
    const r = await send('Runtime.evaluate', { expression: decodeURIComponent(a), returnByValue: true });
    console.log('eval:', JSON.stringify(r.result?.result?.value ?? r.result));
  }
}
console.log(logs.join('\n'));
await send('Page.close');
ws.close();
process.exit(0);
