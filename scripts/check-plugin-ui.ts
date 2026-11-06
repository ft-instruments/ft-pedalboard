// Headless-Chrome check of the page in plugin mode: serves dist/, fakes the
// JUCE bridge (window.__JUCE__.backend) that the plugin's WebView injects,
// and plays the C++ side: sends the session state, host automation,
// meters, and checks what the page sends back. Screenshot to
// out/screenshot-plugin.png (delete it). Needs `npm run build` first.
//
//   node scripts/check-plugin-ui.ts

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 4175, DEBUG = 9335;
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const server = createServer((req, res) => {
  let p = join('dist', decodeURIComponent((req.url ?? '/').split('?')[0]));
  if (!existsSync(p) || p.endsWith('/')) p = 'dist/index.html';
  res.setHeader('content-type', MIME[extname(p)] ?? 'application/octet-stream');
  res.end(readFileSync(p));
}).listen(PORT);

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${DEBUG}`, '--window-size=1320,900', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check', '--user-data-dir=/tmp/ft-pedalboard-chrome-plugin', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// What JUCE injects, reduced to the two calls the page uses. Everything the
// page emits is recorded in window.__sent; window.__toPage(msg) is the C++ side.
const FAKE_JUCE = `
  window.__sent = [];
  const listeners = new Map();
  window.__JUCE__ = { backend: {
    emitEvent: (id, payload) => window.__sent.push({ id, payload: JSON.parse(JSON.stringify(payload)) }),
    addEventListener: (id, fn) => { (listeners.get(id) ?? listeners.set(id, []).get(id)).push(fn); },
  } };
  window.__toPage = (msg) => (listeners.get('pedalboard') ?? []).forEach((fn) => fn(msg));
`;

let failures = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures++; };

async function main(): Promise<void> {
  let targets: { webSocketDebuggerUrl: string; type: string }[] = [];
  for (let i = 0; i < 50 && targets.length === 0; i++) {
    await sleep(200);
    try { targets = (await (await fetch(`http://127.0.0.1:${DEBUG}/json`)).json()).filter((t: { type: string }) => t.type === 'page'); } catch { /* not up yet */ }
  }
  if (targets.length === 0) throw new Error('chrome did not start');
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map<number, (v: unknown) => void>();
  const logs: string[] = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result ?? m.error); pending.delete(m.id); }
    else if (m.method === 'Runtime.consoleAPICalled') logs.push(`[${m.params.type}] ${m.params.args.map((a: { value?: unknown; description?: string }) => a.value ?? a.description).join(' ')}`);
    else if (m.method === 'Runtime.exceptionThrown') logs.push(`[exception] ${m.params.exceptionDetails.text} ${m.params.exceptionDetails.exception?.description ?? ''}`);
  };
  const send = (method: string, params: Record<string, unknown> = {}) => new Promise<unknown>((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression: string) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }) as { result?: { value?: unknown }; exceptionDetails?: { text: string } };
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result?.value;
  };
  type Sent = { id: string; payload: { type: string; [k: string]: unknown } };
  const takeSent = async () => (await evaluate('window.__sent.splice(0)')) as Sent[];

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_JUCE });
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(2000);

  // 1. the page asks for the state and loads nothing by itself
  let sent = await takeSent();
  check(sent.length === 1 && sent[0].payload.type === 'ready', `on open the page only asks for the state (sent: ${sent.map((s) => s.payload.type).join(', ')})`);
  check(await evaluate("document.documentElement.classList.contains('in-plugin')") === true, 'plugin mode is on');
  check(await evaluate("getComputedStyle(document.querySelector('.power-wrap')).display") === 'none', 'the power switch is hidden');
  check(await evaluate("getComputedStyle(document.querySelector('#wake')).display") === 'none', 'and so is the switch-on button');

  // 2. the session state arrives: the rack, the rig name, your rigs, the input
  await evaluate(`window.__toPage({ type: 'state', values: { s1type: 6, s1k1: 0.5, s2type: 13, s3type: 0 }, preset: 'Glass Porch',
    user: [{ name: 'Mine', values: { s1type: 3 } }, { bogus: true }], source: 'demo:1', channel: 1, muted: false })`);
  await sleep(200);
  sent = await takeSent();
  check(sent.length === 0, `the state is not echoed back (sent: ${sent.map((s) => s.payload.type).join(', ') || 'nothing'})`);
  check(await evaluate("window.__pedalboard.rack().join(' ')") === 'amp hall', 'the state fills the rack');
  check(await evaluate("document.querySelector('#rig-name').textContent") === 'Glass Porch', 'the header shows the session rig');
  check(await evaluate("document.querySelectorAll('#lib-rigs .rig[data-tag=mine]').length") === 1, 'your rigs from the file are listed (the malformed one dropped)');
  check(await evaluate("document.querySelector('#source').value") === 'demo:1' && await evaluate("document.querySelector('#channel').value") === '1', 'the input settings come back');
  check(await evaluate("!document.querySelector('#source option[value=file]') && !document.querySelector('#device')") === true, 'no file or device choice in the plugin');

  // 3. host automation moves knobs, switches and modules without being sent back
  await evaluate("window.__toPage({ type: 'params', values: { s1k2: 0.9, s2on: 0, volume: 0.5 } })");
  await sleep(100);
  sent = await takeSent();
  check(sent.length === 0, 'automation is not echoed back');
  check(await evaluate("document.querySelectorAll('#units .unit')[1].classList.contains('off')") === true, 'automating a switch shows on its unit');
  check(await evaluate("document.querySelector('#units .unit .knob .readout').textContent") === '9.0', 'automating a knob turns it');
  check(await evaluate("document.querySelector('#volume').value") === '0.5', 'automating the volume moves the slider');
  await evaluate("window.__toPage({ type: 'params', values: { s3type: 8 } })");
  await sleep(100);
  check(await evaluate("window.__pedalboard.rack().join(' ')") === 'amp hall chorus', 'automating a slot\'s module rebuilds the rack');

  // 4. a rig from the library goes over whole, with its name
  await evaluate("window.__pedalboard.loadRig('Plexi Afternoon')");
  sent = await takeSent();
  const rig = sent.find((s) => s.payload.type === 'rig');
  check(!!rig && (rig.payload.values as Record<string, number>).s2type === 30 && rig.payload.name === 'Plexi Afternoon', 'loading a rig sends its values and name');

  // 5. adding a unit is one batch of parameters, and marks the rig edited
  await evaluate("[...document.querySelectorAll('#lib-parts .part')].find((p) => p.textContent.includes('phaser')).click()");
  sent = await takeSent();
  const batch = sent.filter((s) => s.payload.type === 'params');
  check(batch.length === 1 && (batch[0].payload.values as Record<string, number>).s4type === 9, `adding a unit sends one batch (sent: ${sent.map((s) => s.payload.type).join(', ')})`);
  check(sent.some((s) => s.payload.type === 'current' && s.payload.name === '*Plexi Afternoon'), 'and marks the rig edited for the session');

  // 6. the input choice goes to the plugin
  await evaluate("const s = document.querySelector('#source'); s.value = 'live'; s.dispatchEvent(new Event('change'))");
  sent = await takeSent();
  check(sent.some((s) => s.payload.type === 'source' && s.payload.kind === 0), 'choosing the track input tells the plugin');

  // 7. meters and the tuner from the plugin
  await evaluate(`window.__toPage({ type: 'stats', load: 0.031, peakIn: 0.2, peakL: 0.5, peakR: 0.4, tunerHz: 110, tunerClarity: 0.95,
    slotPeak: [0.2, 0.4, 0.4, 0.4, 0, 0, 0, 0], slotHeat: [0, 0.5, 0, 0, 0, 0, 0, 0], slotLive: [0.01, 0.1, 0.1, 0.3, 0, 0, 0, 0], stageHeat: new Array(40).fill(1) })`);
  await sleep(150);
  check(await evaluate("document.querySelector('#tuner-note').textContent") === 'A2', 'the tuner reads the plugin');
  check(String(await evaluate("document.querySelector('#stats').textContent")).includes('dsp'), 'the dsp load shows');

  // 8. saving a rig goes to the plugin's file
  await evaluate('document.querySelector("#save").click()');
  await sleep(200);
  await evaluate('{ const n = document.querySelector("#save-name"); n.value = "Check Rig"; document.querySelector("#savebar").requestSubmit(); }');
  sent = await takeSent();
  const save = sent.find((s) => s.payload.type === 'saveUser');
  check(!!save && (save.payload.rigs as { name: string }[]).map((p) => p.name).join(',') === 'Mine,Check Rig', 'saving writes your rigs through the plugin');

  // 9. the host swaps the whole state to an edited session
  await evaluate("window.__toPage({ type: 'state', values: { s1type: 5 }, preset: '*Solo Ridge', user: [], source: 'live', channel: 0, muted: true })");
  await sleep(100);
  check(await evaluate("document.querySelector('#rig-name').textContent") === 'Solo Ridge' && await evaluate("document.querySelector('#browse').classList.contains('edited')") === true, 'an edited session shows as edited, under its name');
  check(await evaluate("document.querySelector('#tuner').classList.contains('muted')") === true, 'the tuner mute comes back');

  await evaluate(`window.__toPage({ type: 'state', values: ${JSON.stringify({ s1type: 1, s2type: 3, s3type: 6, s4type: 11, s5type: 13 })}, preset: 'Solo Ridge', user: [], source: 'demo:0', channel: 0, muted: false })`);
  await sleep(300);
  mkdirSync('out', { recursive: true });
  const shot = await send('Page.captureScreenshot', { format: 'png' }) as { data: string };
  writeFileSync('out/screenshot-plugin.png', Buffer.from(shot.data, 'base64'));
  console.log('wrote out/screenshot-plugin.png (delete it)');

  const errors = logs.filter((l) => l.startsWith('[error]') || l.startsWith('[exception]'));
  for (const l of errors) console.log('  console', l);
  check(errors.length === 0, 'no console errors');
  if (failures) process.exitCode = 1;
  ws.close();
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => { chrome.kill(); server.close(); });
