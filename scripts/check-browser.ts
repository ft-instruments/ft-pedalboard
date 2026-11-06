// Headless-Chrome smoke test: serves dist/, opens the page, boots the
// AudioWorklet, runs the demo guitar and the (fake) live input through it,
// edits the rack (add, move, remove, drag in), switches and saves;
// screenshots into out/ (delete them after).
//
//   node scripts/check-browser.ts

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 4173, DEBUG = 9333;
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const server = createServer((req, res) => {
  let p = join('dist', decodeURIComponent((req.url ?? '/').split('?')[0]));
  if (!existsSync(p) || p.endsWith('/')) p = 'dist/index.html';
  res.setHeader('content-type', MIME[extname(p)] ?? 'application/octet-stream');
  res.end(readFileSync(p));
}).listen(PORT);

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${DEBUG}`, '--window-size=1400,1100', '--hide-scrollbars',
  '--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--no-first-run', '--no-default-browser-check',
  '--user-data-dir=/tmp/ft-pedalboard-chrome', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(2500);
  const title = await evaluate('document.title');
  const unitsN = await evaluate('document.querySelectorAll("#units .unit").length');
  const knobs = await evaluate('document.querySelectorAll(".knob").length');
  const parts = await evaluate('document.querySelectorAll("#lib-parts .part").length');
  const rigs = await evaluate('document.querySelectorAll("#lib-rigs .rig").length');
  console.log(`page "${title}": ${unitsN} units in the rack, ${knobs} knobs; library ${rigs} rigs, ${parts} components`);

  if (!String(await evaluate('typeof window.__pedalboard')).startsWith('object')) { for (const l of logs) console.log('  console', l); throw new Error('main.ts did not finish'); }
  const fail = (msg: string) => { console.error(`FAIL ${msg}`); process.exitCode = 1; };
  const wait = (ms: number) => `new Promise((r) => setTimeout(r, ${ms}))`;
  if (!(Number(unitsN) >= 2)) fail('the first rig did not fill the rack');
  if (parts !== 39) fail(`expected 39 components in the library, found ${parts}`);
  const wakeShown = await evaluate('getComputedStyle(document.querySelector("#wake")).display');
  if (wakeShown === 'none') fail('the switch-on button is not shown before power');

  // power on with the demo guitar
  const demo = await evaluate(`(async () => {
    const v = window.__pedalboard;
    document.querySelector('#wake').click();
    await ${wait(500)};
    await v.setSource('demo:0');
    v.loadRig('Plexi Afternoon');
    await ${wait(2000)};
    return v.lastStats();
  })()`) as { peakL: number; peakIn: number };
  console.log(`demo strum through "Plexi Afternoon": in ${demo.peakIn.toFixed(3)}, out ${demo.peakL.toFixed(3)}`);
  if (!(demo.peakL > 0.01)) fail('no output from the demo guitar');
  const label = await evaluate('document.querySelector("#start-label").textContent');
  console.log(`power: ${label}; ${await evaluate('document.querySelector("#stats").textContent')}; wake button ${await evaluate('getComputedStyle(document.querySelector("#wake")).display')}`);

  // the tuner on the lick
  const hz = await evaluate(`(async () => {
    const v = window.__pedalboard; await v.setSource('demo:2');
    let seen = 0; for (let i = 0; i < 20 && !seen; i++) { await ${wait(100)}; seen = v.lastStats()?.tunerHz || 0; }
    return [seen, document.querySelector('#tuner-note').textContent];
  })()`) as [number, string];
  console.log(`tuner on the lick: ${hz[0].toFixed(1)} Hz, shows "${hz[1]}"`);
  if (!(hz[0] > 60)) fail('tuner did not read the demo lick');

  // live input: Chrome's fake device plays a tone
  const liveIn = await evaluate(`(async () => {
    const v = window.__pedalboard; await v.setSource('live');
    let pk = 0; for (let i = 0; i < 50; i++) { await ${wait(40)}; pk = Math.max(pk, v.lastStats()?.peakIn ?? 0); }
    return [pk, document.querySelector('#source').value, document.querySelector('#device').options.length];
  })()`) as [number, string, number];
  console.log(`live input (fake device): peak in ${Number(liveIn[0]).toFixed(3)}, source "${liveIn[1]}", ${liveIn[2]} device(s)`);
  if (liveIn[1] !== 'live' || !(Number(liveIn[0]) > 0.001)) fail('live input did not come through');
  await evaluate(`window.__pedalboard.setSource('demo:1')`);

  // editing the rack: add, move, remove; the DOM follows and the sound keeps coming
  const edits = await evaluate(`(async () => {
    const v = window.__pedalboard, out = [];
    v.loadRig('Plexi Afternoon');
    out.push(v.rack().join(' '));
    document.querySelector('#lib-parts .part:nth-of-type(1)');
    [...document.querySelectorAll('#lib-parts .part')].find((p) => p.textContent.includes('chorus')).click();
    out.push(v.rack().join(' '));
    v.move(v.rack().indexOf('chorus'), 1);
    out.push(v.rack().join(' '));
    document.querySelectorAll('#units .unit')[1].querySelector('.remove').click();
    out.push(v.rack().join(' '));
    document.querySelectorAll('#units .unit')[1].querySelector('.up').click();
    out.push(v.rack().join(' ') + ' | dom: ' + [...document.querySelectorAll('#units .unit h3')].map((h) => h.textContent).join(' '));
    await ${wait(600)};
    out.push(String(v.lastStats().peakL.toFixed(3)));
    return out;
  })()`) as string[];
  console.log(`rack edits:\n    ${edits.join('\n    ')}`);
  if (edits[1] !== 'gate amp_plexi hall chorus' || edits[2] !== 'gate chorus amp_plexi hall' || edits[3] !== 'gate amp_plexi hall' || !edits[4].startsWith('amp_plexi gate hall | dom: plexi gate hall')) fail('rack edits went wrong');
  if (!(Number(edits[5]) > 0.01)) fail('no sound after editing the rack');

  // the tone doctor: "too bright" turns the amp's treble down and the high cut in, "undo" puts it back; the popover opens
  const doc = await evaluate(`(async () => {
    const v = window.__pedalboard, out = [];
    v.loadRig('Plexi Afternoon');
    const get = () => { const x = v.values(); return [x.s2k4, x.s2k11]; };      // plexi (slot 2): treble, high cut
    out.push(get());
    document.querySelector('#doctor-btn').click();
    out.push(!document.querySelector('#doctor-pop').hidden);
    [...document.querySelectorAll('#doctor-grid button')].find((b) => b.textContent === 'too bright').click();
    out.push(get());
    document.querySelector('#doctor-undo').click();
    out.push(get());
    document.querySelector('#doctor-btn').click();
    out.push(document.querySelector('#doctor-pop').hidden);
    return out;
  })()`) as [number[], boolean, number[], number[], boolean];
  console.log(`tone doctor: treble/high cut ${doc[0].map((x) => x.toFixed(2))} -> ${doc[2].map((x) => x.toFixed(2))} -> undone ${doc[3].map((x) => x.toFixed(2))}, popover ${doc[1] ? 'opens' : 'did not open'}`);
  if (!doc[1] || !(doc[2][0] < doc[0][0]) || !(doc[2][1] < doc[0][1]) || doc[3][0] !== doc[0][0] || doc[3][1] !== doc[0][1] || !doc[4]) fail('tone doctor did not work');

  // the input meter's target zone: with the demo guitar playing, the hint settles on a state and the green band is drawn
  await sleep(800);
  const meter = await evaluate(`(() => { const h = document.querySelector('#in-hint'), z = document.querySelector('#in-zone'); return [h.dataset.state, h.textContent, z.style.width, document.querySelector('#in-hold').style.left]; })()`) as string[];
  console.log(`input meter: "${meter[1]}" (${meter[0]}), zone width ${meter[2]}, hold at ${meter[3]}`);
  if (meter[0] === 'idle' || !meter[2] || !meter[3]) fail('the input meter did not show a level and a target zone');

  // drag a component from the library into the top of the rack
  const dropped = await evaluate(`(async () => {
    const v = window.__pedalboard;
    const part = [...document.querySelectorAll('#lib-parts .part')].find((p) => p.textContent.includes('fuzz'));
    const target = document.querySelector('#units .unit');
    const r = target.getBoundingClientRect();
    const dt = new DataTransfer();
    part.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: r.top + 4 }));
    const line = !document.querySelector('#drop-line').hidden;
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: r.top + 4 }));
    return [v.rack().join(' '), line];
  })()`) as [string, boolean];
  console.log(`drag fuzz to the top: ${dropped[0]} (drop line shown: ${dropped[1]})`);
  if (dropped[0] !== 'fuzz gate amp_plexi hall' || !dropped[1]) fail('dragging a component in did not work');

  // a footswitch by key: 2 = the second unit
  await evaluate(`window.__pedalboard.loadRig('Solo Ridge')`);
  await evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }))`);
  const sw = await evaluate(`[window.__pedalboard.values().s2on, document.querySelectorAll('#units .unit')[1].classList.contains('off')]`) as [number, boolean];
  console.log(`key 2 switched the second unit (glow) to ${sw[0]}, shown off: ${sw[1]}`);
  if (sw[0] !== 0 || !sw[1]) fail('footswitch key did not switch the second unit');
  await evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }))`);
  await sleep(1500);

  mkdirSync('out', { recursive: true });
  const shoot = async (name: string, clip?: { x: number; y: number; width: number; height: number; scale: number }) => {
    const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !clip, ...(clip ? { clip } : {}) }) as { data: string };
    writeFileSync(`out/screenshot-${name}.png`, Buffer.from(s.data, 'base64'));
  };
  await shoot('board');
  await evaluate(`document.querySelector('#doctor-btn').click()`); await sleep(300);
  await shoot('doctor');
  await evaluate(`document.querySelector('#doctor-btn').click()`);
  await evaluate(`window.__pedalboard.loadRig('Slow Orbit')`); await evaluate(`window.__pedalboard.setSource('demo:0')`);
  await evaluate(`document.querySelector('#tab-parts').click()`);
  await sleep(1500);
  await shoot('orbit');
  await evaluate(`document.querySelector('#tab-rigs').click()`);

  // the rig list: search, save and delete
  await evaluate('{ const s = document.querySelector("#lib-search"); s.value = "chug"; s.dispatchEvent(new Event("input")); }');
  const shown = await evaluate('[...document.querySelectorAll("#lib-rigs .rig")].filter((c) => !c.hidden).length');
  console.log(`rigs: search "chug" narrows to ${shown}`);
  if (shown !== 1) fail('search does not narrow');
  await evaluate('{ const s = document.querySelector("#lib-search"); s.value = ""; s.dispatchEvent(new Event("input")); }');
  await evaluate('document.querySelector("#save").click()');
  await sleep(200);
  await evaluate('document.querySelector("#save-name").value = "Check Rig"; document.querySelector("#savebar").requestSubmit()');
  await sleep(200);
  const saved = await evaluate('[document.querySelectorAll("#lib-rigs .rig[data-tag=mine]").length, document.querySelector("#rig-name").textContent]') as [number, string];
  await evaluate('{ const d = document.querySelector("#lib-rigs .rig[data-tag=mine] .del"); d.click(); d.click(); }');
  const left = await evaluate('document.querySelectorAll("#lib-rigs .rig[data-tag=mine]").length');
  console.log(`save: ${saved[0]} of yours, header "${saved[1]}"; after delete ${left}`);
  if (saved[0] !== 1 || saved[1] !== 'Check Rig' || left !== 0) fail('saving rigs does not work');

  // narrow window: the library becomes a drawer
  await evaluate('document.querySelector("#lib-close").click()');
  await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 1, mobile: true });
  await sleep(500);
  const overflow = await evaluate('document.documentElement.scrollWidth - window.innerWidth');
  await shoot('phone');
  console.log(`phone width: horizontal overflow ${overflow}px`);
  if (Number(overflow) > 0) fail('page scrolls sideways at phone width');
  await evaluate('document.querySelector("#open-lib").click()');
  await sleep(400);
  const drawer = await evaluate('Math.round(window.innerWidth - document.querySelector("#library").getBoundingClientRect().left)');
  await shoot('phone-library', { x: 0, y: 0, width: 420, height: 900, scale: 1 });
  console.log(`phone: library drawer ${drawer}px into the screen`);
  if (Number(drawer) < 300) fail('the library drawer did not open');

  console.log('wrote out/screenshot-{board,orbit,phone,phone-library}.png');
  const errors = logs.filter((l) => l.startsWith('[error]') || l.startsWith('[exception]'));
  for (const l of logs) console.log('  console', l);
  if (errors.length) fail(`${errors.length} console error(s)`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => { chrome.kill(); server.close(); });
