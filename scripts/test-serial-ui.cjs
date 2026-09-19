const { chromium } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');

(async () => {
  const root = path.resolve(__dirname, '..');
  const results = path.join(root, '.test-results');
  await fs.mkdir(results, { recursive: true });
  const html = (await fs.readFile(path.join(root, 'media/serial.html'), 'utf8'))
    .replaceAll('{{cspSource}}', "'self'").replaceAll('{{nonce}}', 'ui-test')
    .replaceAll('{{styleUri}}', '/serial.css').replaceAll('{{scriptUri}}', '/serial.js')
    .replace('</head>', '<link rel="stylesheet" href="/theme.css"></head>');
  const theme = ':root { --vscode-foreground:#cccccc; --vscode-panel-background:#181818; --vscode-editor-background:#1f1f1f; --vscode-input-background:#313131; --vscode-input-foreground:#cccccc; --vscode-input-border:#464646; --vscode-dropdown-background:#313131; --vscode-dropdown-foreground:#cccccc; --vscode-button-background:#0078d4; --vscode-button-foreground:#ffffff; --vscode-button-hoverBackground:#026ec1; --vscode-button-secondaryBackground:#313131; --vscode-button-secondaryForeground:#cccccc; --vscode-descriptionForeground:#9d9d9d; --vscode-focusBorder:#0078d4; --vscode-textLink-foreground:#4daafc; --vscode-panel-border:#353535; --vscode-errorForeground:#f48771; --vscode-font-family:"Segoe UI","Microsoft YaHei",sans-serif; --vscode-font-size:13px; }';
  const server = http.createServer(async (req, res) => {
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); }
    else if (req.url === '/theme.css') { res.setHeader('Content-Type', 'text/css'); res.end(theme); }
    else if (['/serial.css', '/serial.js'].includes(req.url)) {
      res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : 'text/css');
      res.end(await fs.readFile(path.join(root, 'media', req.url.slice(1))));
    } else { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}), headless: true });
    const page = await browser.newPage({ viewport: { width: 1180, height: 440 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.addInitScript(() => {
      window.__messages = [];
      let state;
      window.acquireVsCodeApi = () => ({ postMessage: message => window.__messages.push(message), getState: () => state, setState: value => { state = value; } });
    });
    const emit = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
    const last = type => page.evaluate(type => window.__messages.filter(message => message.type === type).at(-1), type);
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.__messages.some(m => m.type === 'ready'));
    await emit({ type: 'state', ports: [], sessions: [], connecting: false });
    assert.ok((await page.locator('#port-note').textContent()).includes('未检测到串口'));
    assert.equal(await page.locator('#connect').isDisabled(), true);
    await page.screenshot({ path: path.join(results, 'serial-panel-empty.png') });
    await page.locator('#port').selectOption('__manual__');
    assert.equal(await page.locator('#manual').isVisible(), true);
    await page.locator('#manual').fill('COM9');
    assert.equal(await page.locator('#connect').isEnabled(), true);
    await page.locator('#connect').click();
    assert.equal((await last('connect')).options.path, 'COM9');
    const ports = [{ path: 'COM3', manufacturer: 'USB-SERIAL CH340', vendorId: '1A86', productId: '7523' }, { path: 'COM12', manufacturer: 'Silicon Labs CP210x' }];
    const model = { type: 'state', ports, sessions: [], connecting: false };
    await emit(model);
    await page.locator('#port').selectOption('COM12');
    await page.locator('#baud').fill('9600');
    await page.locator('#advanced summary').click();
    await page.locator('#parity').selectOption('even');
    await page.locator('#flow').selectOption('rtscts');
    await page.locator('#connect').click();
    assert.deepEqual((await last('connect')).options, { path: 'COM12', baudRate: 9600, dataBits: 8, parity: 'even', stopBits: 1, rtscts: true });
    await emit(model);
    assert.equal(await page.locator('#port').inputValue(), 'COM12', 'Periodic scan preserves chosen port');
    await page.locator('#advanced summary').click();
    const id = '11111111-1111-4111-8111-111111111111';
    const session = { id, name: 'COM12 @ 9600', state: 'open', kind: 'serial' };
    await emit({ ...model, sessions: [session], selected: id });
    const entry = (seq, type, data, actor) => ({ seq, type, data, actor, time: '2026-09-06T00:15:21.123Z', ...(type !== 'status' ? { base64: Buffer.from(data).toString('base64') } : {}) });
    await emit({ type: 'snapshot', sessionId: id, events: [entry(1, 'status', 'Connected'), entry(2, 'output', 'Device ready. Firmware v1.4.2\r\n'), entry(3, 'input', 'status\r\n', 'ai'), entry(4, 'output', 'Voltage: 3.30 V  |  Temperature: 26.5 C\r\n'), entry(5, 'input', 'help\r\n', 'human'), entry(6, 'output', 'Commands: status, help, version\r\n')] });
    assert.equal(await page.locator('#send').isEnabled(), true);
    await page.locator('#input').fill('version');
    await page.locator('#send').click();
    assert.deepEqual(await last('send'), { type: 'send', sessionId: id, data: 'version', encoding: 'utf8', ending: 'crlf' });
    await page.screenshot({ path: path.join(results, 'serial-panel-connected.png') });
    await emit({ type: 'events', sessionId: id, events: [entry(7, 'output', '<img src=x onerror=alert(1)>')] });
    assert.equal(await page.locator('#output img').count(), 0, 'Untrusted device output is plain text');
    await page.locator('#display').selectOption('hex');
    assert.ok((await page.locator('#output').textContent()).includes('44 65 76 69 63 65'));
    await page.locator('#encoding').selectOption('hex');
    assert.equal(await page.locator('#ending').inputValue(), 'none');
    await page.locator('#input').fill('00 FF 0D 0A');
    await page.locator('#send').click();
    assert.equal((await last('send')).encoding, 'hex');
    await page.locator('#disconnect').click();
    assert.equal((await last('disconnect')).sessionId, id);
    await page.locator('#export').click();
    assert.equal((await last('export')).sessionId, id);
    await page.locator('#clear').click();
    await emit({ type: 'snapshot', sessionId: id, events: [entry(7, 'output', 'old data')] });
    assert.equal(await page.locator('#output .event').count(), 0, 'Cleared history stays cleared when the view becomes visible again');
    await emit({ type: 'events', sessionId: id, events: [entry(8, 'output', 'new data')] });
    assert.equal(await page.locator('#output .event').count(), 1);
    await emit({ ...model, ports: [], sessions: [{ ...session, state: 'closed' }], selected: id });
    assert.equal(await page.locator('#send').isDisabled(), true);
    await page.setViewportSize({ width: 470, height: 500 });
    await page.screenshot({ path: path.join(results, 'serial-panel-narrow.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'No horizontal page overflow');
    assert.deepEqual(errors, []);
    console.log('Serial panel UI: PASS (empty state, manual port, device selection, parameters, refresh, send, HEX, disconnect, XSS, narrow layout)');
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
