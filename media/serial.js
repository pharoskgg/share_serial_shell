(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const saved = vscode.getState() || {};
  let state = { ports: [], sessions: [], connecting: false };
  let initialized = false;
  let portSignature = '';
  let entries = [];
  let lastSeq = 0;
  let selected;
  const clearedAt = {};
  let rx = 0, tx = 0;
  const outputArea = document.querySelector('.output-area');
  const post = (type, extra = {}) => vscode.postMessage({ type, ...extra });
  const error = message => { $('error').textContent = message; $('error').hidden = !message; };
  const path = () => $('port').value === '__manual__' ? $('manual').value.trim() : $('port').value;
  const current = () => state.sessions.find(s => s.id === state.selected);
  const fields = ['baud', 'manual', 'dataBits', 'parity', 'stopBits', 'flow', 'encoding', 'ending', 'display'];
  const persist = () => {
    const value = { port: $('port').value };
    for (const id of fields) value[id] = $(id).value;
    value.timestamps = $('timestamps').checked; value.autoscroll = $('autoscroll').checked;
    vscode.setState(value);
  };
  function controls() {
    const session = current();
    const open = session?.state === 'open';
    const duplicate = state.sessions.some(s => s.state !== 'closed' && s.name.startsWith(path() + ' @ '));
    $('connect').disabled = state.connecting || !path() || duplicate;
    $('connect').textContent = state.connecting ? '连接中…' : duplicate ? '已连接' : '连接';
    $('disconnect').disabled = !session || session.state === 'closed';
    $('terminal').disabled = !session;
    $('export').disabled = !session;
    $('input').disabled = !open; $('send').disabled = !open;
    $('status').classList.toggle('connected', open);
    $('status-text').textContent = session ? ({ open: '已连接', closed: '已断开', connecting: '连接中' }[session.state]) : '未连接';
    $('manual-field').hidden = $('port').value !== '__manual__';
  }
  function updateState(next) {
    state = next;
    if (!initialized) {
      const defaults = next.defaults || {};
      const initial = { baud: defaults.baudRate || 115200, dataBits: defaults.dataBits || 8, parity: defaults.parity || 'none', stopBits: defaults.stopBits || 1, flow: defaults.rtscts ? 'rtscts' : 'none', ...saved };
      for (const id of fields) if (initial[id] !== undefined) $(id).value = String(initial[id]);
      if (saved.timestamps !== undefined) $('timestamps').checked = saved.timestamps;
      if (saved.autoscroll !== undefined) $('autoscroll').checked = saved.autoscroll;
    }
    const desired = initialized ? $('port').value : (saved.port || next.defaults?.path || '');
    const signature = JSON.stringify([next.ports, desired]);
    if (portSignature !== signature) {
      const fragment = document.createDocumentFragment();
      fragment.append(new Option(next.ports.length ? '请选择串口' : '未检测到串口', ''));
      for (const port of next.ports) fragment.append(new Option([port.path, port.friendlyName || port.manufacturer].filter(Boolean).join(' — '), port.path));
      if (desired && desired !== '__manual__' && !next.ports.some(p => p.path === desired)) fragment.append(new Option(desired + '（未检测到）', desired));
      fragment.append(new Option('手动输入设备路径…', '__manual__'));
      $('port').replaceChildren(fragment);
      $('port').value = desired || next.ports[0]?.path || '';
      portSignature = JSON.stringify([next.ports, $('port').value]);
    }
    initialized = true;
    const serial = next.sessions;
    const options = serial.length ? serial.map(s => new Option(s.name + (s.state === 'closed' ? ' · 已断开' : ''), s.id)) : [new Option('尚无串口会话', '')];
    const signatureSessions = JSON.stringify(serial);
    if ($('sessions').dataset.signature !== signatureSessions) {
      $('sessions').replaceChildren(...options); $('sessions').dataset.signature = signatureSessions;
    }
    $('sessions').value = next.selected || '';
    const port = next.ports.find(p => p.path === path());
    $('port-note').textContent = next.scanError || (next.ports.length ? `检测到 ${next.ports.length} 个串口 · 每 3 秒自动刷新` + (port?.vendorId ? ` · VID:PID ${port.vendorId}:${port.productId || '—'}` : '') : '未检测到串口。请连接设备、检查驱动后点击刷新；也可以手动输入设备路径。');
    controls();
  }
  function dataBytes(entry) {
    if (!entry.base64) return new TextEncoder().encode(entry.data);
    return Uint8Array.from(atob(entry.base64), ch => ch.charCodeAt(0));
  }
  let decoder = new TextDecoder('utf-8');
  function row(entry) {
    const element = document.createElement('div');
    element.className = 'event ' + (entry.actor || entry.type);
    if ($('timestamps').checked) {
      const time = document.createElement('span'); time.className = 'time'; time.textContent = new Date(entry.time).toLocaleTimeString('zh-CN', { hour12: false }) + '.' + entry.time.slice(20, 23); element.append(time);
    }
    const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = entry.type === 'output' ? 'RX' : entry.actor === 'ai' ? 'AI' : entry.actor === 'human' ? 'TX' : '•'; element.append(badge);
    const content = document.createElement('span'); content.className = 'event-data';
    if (entry.type === 'status') content.textContent = entry.data;
    else if ($('display').value === 'hex') content.textContent = Array.from(dataBytes(entry), b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
    else if (entry.type === 'input') content.textContent = JSON.stringify(entry.data).slice(1, -1);
    else content.textContent = decoder.decode(dataBytes(entry), { stream: true }).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, c => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'));
    element.append(content);
    return element;
  }
  function scroll() { if ($('autoscroll').checked) outputArea.scrollTop = outputArea.scrollHeight; }
  function render() {
    decoder = new TextDecoder('utf-8');
    $('output').replaceChildren(...entries.map(row));
    $('empty').hidden = entries.length > 0;
    scroll();
  }
  function receive(events, reset) {
    if (reset) { entries = []; lastSeq = clearedAt[selected] || 0; rx = 0; tx = 0; decoder = new TextDecoder('utf-8'); $('output').replaceChildren(); $('counter').textContent = 'RX 0 B · TX 0 B'; }
    const fresh = events.filter(event => event.seq > lastSeq);
    if (!fresh.length) { $('empty').hidden = entries.length > 0; return; }
    lastSeq = fresh[fresh.length - 1].seq;
    entries.push(...fresh);
    const fragment = document.createDocumentFragment();
    for (const entry of fresh) {
      if (entry.type === 'output') rx += dataBytes(entry).length;
      if (entry.type === 'input') tx += dataBytes(entry).length;
      fragment.append(row(entry));
    }
    $('output').append(fragment);
    while (entries.length > 1000) { entries.shift(); $('output').firstChild?.remove(); }
    $('empty').hidden = true;
    $('counter').textContent = `RX ${rx.toLocaleString()} B · TX ${tx.toLocaleString()} B`;
    scroll();
  }
  window.addEventListener('message', ({ data }) => {
    if (data.type === 'state') updateState(data);
    else if (data.type === 'snapshot') { selected = data.sessionId; receive(data.events, true); }
    else if (data.type === 'events' && data.sessionId === selected) receive(data.events, false);
    else if (data.type === 'error') error(data.message);
    else if (data.type === 'sent') { error(''); $('input').focus(); }
  });
  $('refresh').addEventListener('click', () => { error(''); post('refresh'); });
  $('port').addEventListener('change', () => { controls(); persist(); });
  $('manual').addEventListener('input', () => { controls(); persist(); });
  for (const id of [...fields, 'timestamps', 'autoscroll']) $(id).addEventListener('change', () => {
    if (id === 'display' || id === 'timestamps') render();
    if (id === 'autoscroll') scroll();
    if (id === 'encoding') { $('input').placeholder = $('encoding').value === 'hex' ? '例如 01 FF 0D 0A，按 Enter 发送' : '输入内容，按 Enter 发送'; if ($('encoding').value === 'hex') $('ending').value = 'none'; }
    persist();
  });
  $('connection').addEventListener('submit', event => {
    event.preventDefault(); error('');
    if (!path()) { error('请选择串口，或选择“手动输入设备路径”'); return; }
    persist(); post('connect', { options: { path: path(), baudRate: Number($('baud').value), dataBits: Number($('dataBits').value), parity: $('parity').value, stopBits: Number($('stopBits').value), rtscts: $('flow').value === 'rtscts' } });
  });
  $('disconnect').addEventListener('click', () => { if (state.selected) post('disconnect', { sessionId: state.selected }); });
  $('export').addEventListener('click', () => { if (state.selected) post('export', { sessionId: state.selected }); });
  $('sessions').addEventListener('change', () => { error(''); if ($('sessions').value) post('select', { sessionId: $('sessions').value }); });
  $('terminal').addEventListener('click', () => { if (state.selected) post('terminal', { sessionId: state.selected }); });
  $('clear').addEventListener('click', () => { if (selected) clearedAt[selected] = lastSeq; entries = []; rx = 0; tx = 0; $('counter').textContent = 'RX 0 B · TX 0 B'; render(); });
  $('send-form').addEventListener('submit', event => {
    event.preventDefault(); error('');
    if (current()?.state !== 'open') return;
    post('send', { sessionId: state.selected, data: $('input').value, encoding: $('encoding').value, ending: $('ending').value });
  });
  post('ready');
})();
