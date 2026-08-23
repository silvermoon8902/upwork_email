/* Popup: edit settings, drive Start/Pause/Resume/Stop, render live log. */

const $ = id => document.getElementById(id);

// Field name -> how to read/write it. Must stay in sync with DEFAULT_CONFIG.
const CFG_FIELDS = {
  searchUrl:       'text',
  contactOutToken: 'text',
  openaiKey:       'text',
  openaiModel:     'text',
  postEndpoint:    'text',
  minDelayMs:      'int',
  maxDelayMs:      'int',
  matchThreshold:  'int',
  maxCandidates:   'int',
  skipIfGithub:    'bool',
};

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
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = fmtTime(e.t);
    div.appendChild(t);
    div.appendChild(document.createTextNode(e.msg));
    box.appendChild(div);
  }
  box.scrollTop = box.scrollHeight;
}

async function refresh() {
  const r = await send('getState');
  if (!r) return;
  if (r.config) {
    for (const [f, kind] of Object.entries(CFG_FIELDS)) {
      const el = $(f);
      if (!el || r.config[f] == null) continue;
      if (kind === 'bool') el.checked = !!r.config[f];
      else el.value = r.config[f];
    }
  }
  if (r.state) renderStatus(r.state);
  if (r.log) renderLog(r.log);
}

async function saveCfg() {
  const config = {};
  for (const [f, kind] of Object.entries(CFG_FIELDS)) {
    const el = $(f);
    if (!el) continue;
    if (kind === 'bool') config[f] = el.checked;
    else if (kind === 'int') config[f] = parseInt(el.value, 10) || 0;
    else config[f] = el.value;
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
  if (msg && msg.type === 'tick') refresh();
});

refresh();
