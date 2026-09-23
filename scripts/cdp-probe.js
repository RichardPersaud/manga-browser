'use strict';
// Drive the running app over the Chrome DevTools Protocol: evaluate JS in the
// WebView and take screenshots. Usage:
//   node scripts/cdp-probe.js eval "<js>"   -> prints result
//   node scripts/cdp-probe.js shot out.png  -> writes a PNG screenshot
const WebSocket = require('ws');
const fs = require('fs');

const CDP_HTTP = 'http://127.0.0.1:9222/json';
let id = 0;

async function getPageTarget() {
  const targets = await (await fetch(CDP_HTTP)).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  return page.webSocketDebuggerUrl;
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function send(ws, method, params) {
  return new Promise((resolve, reject) => {
    const mid = ++id;
    const onMsg = (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id === mid) {
        ws.off('message', onMsg);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}

(async () => {
  const [, , cmd, arg] = process.argv;
  const ws = new WebSocket(await getPageTarget());
  await new Promise((r) => ws.on('open', r));
  if (cmd === 'eval') {
    const r = await send(ws, 'Runtime.evaluate', {
      expression: arg,
      returnByValue: true,
      awaitPromise: true,
    });
    console.log(JSON.stringify(r.result.value, null, 2));
  } else if (cmd === 'shot') {
    const r = await send(ws, 'Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(arg, Buffer.from(r.data, 'base64'));
    console.log('saved', arg);
  } else {
    console.log('usage: node scripts/cdp-probe.js eval "<js>" | shot <out.png>');
  }
  ws.close();
  process.exit(0);
})().catch((e) => { console.error(e.message || e); process.exit(1); });