'use strict';
// Discord view: webhook + test, per-event toggles, embed / simple-message editor with a live preview that imitates a Discord embed.
// Uses the globals of app.js (run, esc, $, toast, appSettings, viewHooks, saveSetting).

const dc = { info: null, events: {}, templates: {}, sel: null, hook: '', timer: null, dirty: false };
const dcTpl = () => dc.templates[dc.sel];
const dcDefault = (k) => JSON.parse(JSON.stringify((dc.info.defaults || {})[k] || {}));

/** Minimal Discord markdown for the preview: **bold**, *italic*, `code`, line breaks (input is escaped first). */
function dcMd(t) {
  return esc(t).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\*([^*]+)\*/g, '<i>$1</i>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\n/g, '<br>');
}

function dcDrawPreview(p) {
  const el = $('#dcPreview');
  if (!p) { el.innerHTML = '<span class="muted small">No preview</span>'; return; }
  const e = (p.embeds || [])[0];
  let embed = '';
  if (e) {
    const col = typeof e.color === 'number' ? '#' + e.color.toString(16).padStart(6, '0') : 'var(--line)';
    const fields = (e.fields || []).map((f) => `<div class="dp-f ${f.inline ? 'in' : ''}"><div class="dp-fn">${dcMd(f.name)}</div><div>${dcMd(f.value)}</div></div>`).join('');
    const time = e.timestamp ? new Date(e.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    embed = `<div class="dp-embed" style="border-left-color:${esc(col)}">
      <div class="dp-main">
        ${e.title ? `<div class="dp-title">${dcMd(e.title)}</div>` : ''}
        ${e.description ? `<div class="dp-desc">${dcMd(e.description)}</div>` : ''}
        ${fields ? `<div class="dp-fields">${fields}</div>` : ''}
        ${e.image ? `<img class="dp-img" src="${esc(e.image.url)}" alt="">` : ''}
        ${e.footer || time ? `<div class="dp-foot">${e.footer ? esc(e.footer.text) : ''}${e.footer && time ? ' &bull; ' : ''}${esc(time)}</div>` : ''}
      </div>
      ${e.thumbnail ? `<img class="dp-thumb" src="${esc(e.thumbnail.url)}" alt="">` : ''}
    </div>`;
  }
  el.innerHTML = `<div class="dp-msg"><div class="dp-av">N</div><div class="dp-body">
    <div class="dp-name">${esc(p.username || 'NodeGSM')} <span class="dp-bot">BOT</span></div>
    ${p.content ? `<div class="dp-content">${dcMd(p.content)}</div>` : ''}${embed}</div></div>`;
}
function dcPreview() {
  clearTimeout(dc.timer);
  dc.timer = setTimeout(async () => { if (dc.sel) dcDrawPreview(await run('discordPreview', dcTpl(), {}, dc.sel)); }, 150);
}

function dcRenderEvents() {
  const groups = {};
  for (const e of dc.info.events) (groups[e.group] = groups[e.group] || []).push(e);
  $('#dcEvents').innerHTML = Object.entries(groups).map(([g, list]) => `<div class="dc-group">${esc(g)}</div>` + list.map((e) =>
    `<div class="dc-ev ${e.key === dc.sel ? 'sel' : ''}" data-k="${esc(e.key)}"><input type="checkbox" class="switch" data-ev="${esc(e.key)}" ${dc.events[e.key] ? 'checked' : ''} title="Send this event to Discord">
      <span class="dc-evn">${esc(e.label)}<small>${esc(e.key)}</small></span></div>`).join('')).join('');
  $('#dcEvents').querySelectorAll('.dc-ev').forEach((row) => {
    row.onclick = (ev) => { if (ev.target.matches('input')) return; dc.sel = row.dataset.k; dcRenderEvents(); dcRenderEditor(); };
    row.querySelector('input').onchange = (ev) => { dc.events[row.dataset.k] = ev.target.checked; dc.dirty = true; };
  });
}

function dcRenderEditor() {
  const t = dcTpl(); const ev = dc.info.events.find((e) => e.key === dc.sel);
  if (!t) { $('#dcEditor').innerHTML = ''; return; }
  const simple = t.mode === 'simple';
  const f = (k, label, ph = '') => `<label>${label}<input data-t="${k}" value="${esc(t[k])}" placeholder="${esc(ph)}"></label>`;
  $('#dcEditor').innerHTML = `
    <div class="row wrap"><b>${esc(ev ? ev.label : dc.sel)}</b>
      <div class="seg" id="dcMode"><button type="button" data-m="simple" class="${simple ? 'on' : ''}">Simple message</button><button type="button" data-m="embed" class="${simple ? '' : 'on'}">Embed</button></div></div>
    <div class="muted small" style="margin:6px 0">Placeholders: ${dc.info.variables.map((v) => `<code>{${esc(v)}}</code>`).join(' ')}</div>
    ${simple ? `<label>Message<textarea data-t="content" rows="3">${esc(t.content)}</textarea></label>` : `
    <div class="dc-form">
      ${f('title', 'Title')}
      <label>Colour<span class="row"><input type="color" data-t="color" value="${/^#[0-9a-f]{6}$/i.test(t.color) ? esc(t.color) : '#808080'}" style="width:48px;padding:2px"><label class="check"><input type="checkbox" id="dcNoColor" ${t.color ? '' : 'checked'}> none</label></span></label>
      <label style="grid-column:1/-1">Description<textarea data-t="description" rows="3">${esc(t.description)}</textarea></label>
      ${f('thumbnail', 'Thumbnail URL (https)', 'https://...')}${f('image', 'Image URL (https)', 'https://...')}
      ${f('footer', 'Footer')}
      <label style="grid-column:1/-1">Fallback text (shown when the embed is empty)<input data-t="content" value="${esc(t.content)}"></label>
    </div>
    <div class="dc-fields"><div class="row"><b>Fields</b><span class="muted small">${t.fields.length}/10</span><span class="spacer"></span><button type="button" id="dcAddField" ${t.fields.length >= 10 ? 'disabled' : ''}>+ Add field</button></div>
      ${t.fields.map((x, i) => `<div class="dc-field" data-i="${i}"><input data-fi="name" placeholder="Name" value="${esc(x.name)}"><input data-fi="value" placeholder="Value" value="${esc(x.value)}">
        <label class="check"><input type="checkbox" data-fi="inline" ${x.inline ? 'checked' : ''}> inline</label><button type="button" class="danger" data-rm="${i}" title="Remove field">&times;</button></div>`).join('')}
    </div>`}
    <div class="row end"><button type="button" id="dcReset">Reset to default</button><button type="button" id="dcSendTpl">Send test with this template</button></div>`;
  $('#dcMode').querySelectorAll('button').forEach((b) => (b.onclick = () => { t.mode = b.dataset.m; dc.dirty = true; dcRenderEditor(); }));
  $('#dcEditor').querySelectorAll('[data-t]').forEach((i) => (i.oninput = () => { t[i.dataset.t] = i.value; if (i.type === 'color') { t.color = i.value; $('#dcNoColor').checked = false; } dc.dirty = true; dcPreview(); }));
  const nc = $('#dcNoColor'); if (nc) nc.onchange = () => { t.color = nc.checked ? '' : $('#dcEditor').querySelector('input[type=color]').value; dc.dirty = true; dcPreview(); };
  $('#dcEditor').querySelectorAll('.dc-field').forEach((row) => {
    const x = t.fields[+row.dataset.i];
    row.querySelectorAll('[data-fi]').forEach((i) => (i.oninput = i.onchange = () => { x[i.dataset.fi] = i.type === 'checkbox' ? i.checked : i.value; dc.dirty = true; dcPreview(); }));
    row.querySelector('[data-rm]').onclick = () => { t.fields.splice(+row.dataset.i, 1); dc.dirty = true; dcRenderEditor(); };
  });
  const add = $('#dcAddField'); if (add) add.onclick = () => { t.fields.push({ name: 'Name', value: 'Value', inline: true }); dc.dirty = true; dcRenderEditor(); };
  $('#dcReset').onclick = () => { dc.templates[dc.sel] = dcDefault(dc.sel); dc.dirty = true; dcRenderEditor(); };
  $('#dcSendTpl').onclick = () => dcSendTest(dc.sel, dcTpl());
  dcPreview();
}

function dcHookMsg(text, bad) { const m = $('#dcHookMsg'); m.textContent = text || ''; m.className = 'small ' + (bad ? 'dc-bad' : 'muted'); }

async function dcSaveAll(quiet) {
  const hook = $('#dcWebhook').value.trim();
  const s = await run('saveSettings', { discord: { webhookUrl: hook, events: dc.events, templates: dc.templates } });
  if (!s) return false;
  appSettings.discord = s.discord;
  if (hook && !s.discord.webhookUrl) { dcHookMsg('Not saved: the webhook must look like https://discord.com/api/webhooks/<id>/<token>.', true); toast('Webhook URL rejected', true); return false; }
  dc.dirty = false; dc.templates = JSON.parse(JSON.stringify(s.discord.templates || {}));
  dcFillMissingTemplates(); dcRenderEvents(); dcRenderEditor();
  if (!quiet) toast('Discord settings saved');
  return true;
}
async function dcSendTest(kind, tpl) {
  if (!(await dcSaveAll(true))) return;     // the test goes to the saved webhook
  dcHookMsg('Sending ...');
  const r = await run('discordTest', kind, tpl);
  if (!r) return;
  dcHookMsg(r.ok ? `Sent (HTTP ${r.status}). Check your Discord channel.` : `Failed: ${r.error || 'HTTP ' + r.status}`, !r.ok);
}
function dcFillMissingTemplates() { for (const e of dc.info.events) if (!dc.templates[e.key]) dc.templates[e.key] = JSON.parse(JSON.stringify(dc.info.templates[e.key] || dcDefault(e.key))); }

async function openDiscordView() {
  const [info, st] = await Promise.all([run('discordInfo'), run('settings')]);
  if (!info) return;
  if (st) appSettings = { ...appSettings, ...st };
  const d = (st && st.discord) || {};
  dc.info = info; dc.hook = d.webhookUrl || '';
  dc.events = {}; for (const e of info.events) dc.events[e.key] = typeof (d.events || {})[e.key] === 'boolean' ? d.events[e.key] : !!e.on;
  dc.templates = {}; for (const e of info.events) dc.templates[e.key] = JSON.parse(JSON.stringify(info.templates[e.key]));
  if (!dc.sel || !dc.templates[dc.sel]) dc.sel = info.events[0] && info.events[0].key;
  $('#dcWebhook').value = dc.hook; dcHookMsg('');
  dcRenderEvents(); dcRenderEditor();
}
$('#dcTest').onclick = () => dcSendTest('plain');
$('#dcSaveHook').onclick = () => dcSaveAll();
$('#dcSave').onclick = () => dcSaveAll();
viewHooks.discord = openDiscordView;
