/* Popup: edit settings, drive Start/Pause/Resume/Stop, render live log. */

const $ = id => document.getElementById(id);
const CFG_FIELDS = ['searchUrl', 'githubToken', 'postEndpoint', 'minDelayMs', 'maxDelayMs'];

function send(cmd, extra = {}) {
  return chrome.runtime.sendMessage(Object.assign({ cmd }, extra));
}

function renderStatus(st) {
  const el = $('status');
  el.className = 'status ' + (st.captcha ? 'captcha' : st.status);
  el.textContent = st.captcha ? 'CAPTCHA — solve in tab, then Resume'
                              : st.status.toUpperCase();
  $('counters').textContent =
    `page ${st.page} · ${st.queueIndex}/${st.queueLen} on page · ` +
    `${st.processed} processed · ${st.emails} emails` +
    (st.current ? ` · now: ${st.current}` : '');
}

function fmtTime(t) {
  const d = new Date(t);
  return d.toTimeString().slice(0, 8);
}

function renderLog(log) {
  const box = $('log');
  box.innerHTML = '';
  for (const e of log) {
    const div = document.createElement('div');
    div.className = e.level || 'info';
    div.innerHTML = `<span class="t">${fmtTime(e.t)}</span>`;
    div.appendChild(document.createTextNode(e.msg));
    box.appendChild(div);
  }
  box.scrollTop = box.scrollHeight;
}

async function refresh() {
  const r = await send('getState');
  if (!r) return;
  if (r.config) for (const f of CFG_FIELDS) if (r.config[f] != null && $(f)) $(f).value = r.config[f];
  if (r.state) renderStatus(r.state);
  if (r.log) renderLog(r.log);
}

async function saveCfg() {
  const config = {};
  for (const f of CFG_FIELDS) {
    let v = $(f).value;
    if (f === 'minDelayMs' || f === 'maxDelayMs') v = parseInt(v, 10) || 0;
    config[f] = v;
  }
  await send('saveConfig', { config });
  $('save').textContent = 'Saved ✓';
  setTimeout(() => ($('save').textContent = 'Save settings'), 1200);
}

$('save').onclick = saveCfg;
$('start').onclick = async () => { await saveCfg(); await send('start'); };
$('pause').onclick = () => send('pause');
$('resume').onclick = () => send('resume');
$('stop').onclick = () => send('stop');
$('clear').onclick = () => send('clearLog');

chrome.runtime.onMessage.addListener(msg => {
  if (msg && msg.type === 'tick') { if (msg.state) renderStatus(msg.state); refresh(); }
});

refresh();
