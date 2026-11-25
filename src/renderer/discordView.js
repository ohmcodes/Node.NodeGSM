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

// ---------- Bot (slash commands) ----------
const bt = { st: { state: 'off' }, tokenSet: false, clearToken: false, cmds: [], perm: { rules: [], errors: [], warnings: [], servers: [] }, permSeq: 0, permTimer: null };
const NL = String.fromCharCode(10);
const BT_ID =/^\d{15,25}$/;
const btList = (el) => el.value.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
const BT_LABEL = { off: 'Off', connecting: 'Connecting', online: 'Online', error: 'Error' };

function btPaintStatus() {
  const st = bt.st || { state: 'off' };
  const b = $('#dcBotBadge'); b.className = 'badge bot-' + (BT_LABEL[st.state] ? st.state : 'off'); b.textContent = BT_LABEL[st.state] || 'Off';
  const parts = [];
  if (st.user) parts.push(`Logged in as ${st.user}`);
  if (st.state === 'online') parts.push(`${st.guilds || 0} server${st.guilds === 1 ? '' : 's'}`, st.registered ? 'commands registered' : 'commands not registered');
  if (st.error) parts.push(st.error);
  const m = $('#dcBotMsg'); m.textContent = parts.join(' - '); m.className = 'small ' + (st.state === 'error' || st.error ? 'dc-bad' : 'muted');
}
function btListMsg(el, msgEl) {
  const bad = btList(el).filter((x) => !BT_ID.test(x));
  msgEl.textContent = bad.length ? `Not a Discord ID (17-19 digits): ${bad.slice(0, 3).join(', ')}${bad.length > 3 ? ' ...' : ''}` : `${btList(el).length} ID${btList(el).length === 1 ? '' : 's'}`;
  msgEl.className = 'small ' + (bad.length ? 'dc-bad' : 'muted');
  return !bad.length;
}
function btPaintForm() {
  btListMsg($('#dcBotUsers'), $('#dcBotUsersMsg')); btListMsg($('#dcBotRoles'), $('#dcBotRolesMsg'));
  const none = !btList($('#dcBotUsers')).length && !btList($('#dcBotRoles')).length && !bt.perm.rules.length;
  $('#dcBotWarn').textContent = none ? 'Nobody is allowed to use the bot yet: add at least one permission rule or admin role ID. Every command is refused until then.' : '';
  const ts = bt.clearToken ? 'The saved token will be removed when you save.' : bt.tokenSet ? 'A token is saved (hidden). Leave the field blank to keep it.' : 'No token saved.';
  $('#dcBotTokState').textContent = ts; $('#dcBotTokClear').hidden = !bt.tokenSet || bt.clearToken;
}
function btInvite() { const id = $('#dcBotApp').value.trim(); return /^\d{15,25}$/.test(id) ? `https://discord.com/oauth2/authorize?client_id=${id}&scope=applications.commands%20bot&permissions=0` : ''; }
function btPaintCmds() {
  $('#dcBotCmds').innerHTML = bt.cmds.map((c) => `<code>/${esc(c.name)}${(c.options || []).map((o) => ` ${o.required ? '&lt;' : '['}${esc(o.name)}${o.required ? '&gt;' : ']'}`).join('')}</code><span>${esc(c.description)}</span>`).join('');
}
// ---------- permission rules (parsed by the main process so the editor and the bot use the same parser) ----------
function btPermPaint() {
  const p = bt.perm; const raw = $('#dcBotPermsErr');
  const names = {}; for (const x of p.servers || []) names[x.id] = x.name;
  $('#dcBotPermsMsg').textContent = p.errors.length ? `${p.errors.length} line${p.errors.length === 1 ? '' : 's'} with errors: fix them to save` : `${p.rules.length} rule${p.rules.length === 1 ? '' : 's'}${p.warnings.length ? ', ' + p.warnings.length + ' warning' + (p.warnings.length === 1 ? '' : 's') : ''}`;
  $('#dcBotPermsMsg').className = 'small ' + (p.errors.length ? 'dc-bad' : 'muted');
  raw.innerHTML = p.errors.map((e) => `<li class="e">${e.line ? 'Line ' + e.line + ': ' : ''}${esc(e.message)}</li>`).join('') + p.warnings.map((e) => `<li class="w">Line ${e.line}: ${esc(e.message)}</li>`).join('');
  const rawOn = $('#dcBotRaw').checked;
  const tb = $('#dcBotPermsTable'); tb.hidden = !p.rules.length;
  tb.querySelector('tbody').innerHTML = p.rules.map((r) => {
    const srv = r.serverId === '0' ? 'All servers' : `#${esc(r.serverId)} ${names[r.serverId] ? esc(names[r.serverId]) : '(not found)'}`;
    const acts = r.actions.map((a) => esc(a) + (a === 'send' && !rawOn ? ' (switched off below)' : '')).join(', ');
    return `<tr><td>${esc(r.userId)}</td><td>${srv}</td><td>${acts}</td></tr>`;
  }).join('');
  btPaintForm();
}
async function btPermParse() {
  const seq = ++bt.permSeq; const r = await run('discordPermParse', $('#dcBotPerms').value);
  if (!r || seq !== bt.permSeq) return r;
  bt.perm = r; btPermPaint(); return r;
}
$('#dcBotPerms').oninput = () => { clearTimeout(bt.permTimer); bt.permTimer = setTimeout(btPermParse, 150); };
$('#dcBotRaw').onchange = btPermPaint;
async function btPermFill(rules) { const t = await run('discordPermFormat', rules || []); $('#dcBotPerms').value = t || ''; await btPermParse(); }

function btFill(d) {
  $('#dcBotOn').checked = !!d.botEnabled; $('#dcBotToken').value = ''; $('#dcBotApp').value = d.applicationId || ''; $('#dcBotGuild').value = d.guildId || '';
  $('#dcBotUsers').value = (d.allowedUserIds || []).join(NL); $('#dcBotRoles').value = (d.adminRoleIds || []).join(NL); $('#dcBotRaw').checked = !!d.allowRawCommands; btPermFill(d.permissions);
  bt.tokenSet = !!d.botTokenSet; bt.clearToken = false; btPaintForm();
}
async function btSave() {
  if (!btListMsg($('#dcBotUsers'), $('#dcBotUsersMsg')) || !btListMsg($('#dcBotRoles'), $('#dcBotRolesMsg'))) { toast('Fix the invalid Discord IDs first', true); return false; }
  const pr = await btPermParse(); if (!pr) return false;
  if (pr.errors.length) { toast('Fix the permission rules first', true); return false; }
  const token = $('#dcBotToken').value.trim();
  const patch = { botEnabled: $('#dcBotOn').checked, applicationId: $('#dcBotApp').value.trim(), guildId: $('#dcBotGuild').value.trim(), allowedUserIds: btList($('#dcBotUsers')), adminRoleIds: btList($('#dcBotRoles')), permissions: pr.rules, allowRawCommands: $('#dcBotRaw').checked };
  if (token) patch.botToken = token; else if (bt.clearToken) patch.clearBotToken = true;
  if (token) { const t = await run('discordBotTest', token); if (t && !t.ok) { toast(t.error, true); return false; } }
  const s = await run('saveSettings', { discord: patch });
  if (!s) return false;
  appSettings.discord = s.discord; btFill(s.discord);
  return true;
}
$('#dcBotSave').onclick = async () => { if (await btSave()) toast('Bot settings saved'); };
$('#dcBotReconnect').onclick = async () => { if (!(await btSave())) return; const st = await run('discordBotRestart'); if (st) { bt.st = st; btPaintStatus(); } };
$('#dcBotTokClear').onclick = () => { bt.clearToken = true; $('#dcBotToken').value = ''; btPaintForm(); };
$('#dcBotToken').oninput = () => { if ($('#dcBotToken').value) bt.clearToken = false; btPaintForm(); };
$('#dcBotUsers').oninput = $('#dcBotRoles').oninput = btPaintForm;
$('#dcBotCopy').onclick = async () => {
  const link = btInvite();
  if (!link) { toast('Enter the application ID first (digits only)', true); return; }
  try { await navigator.clipboard.writeText(link); toast('Invite link copied'); }
  catch { const t = document.createElement('textarea'); t.value = link; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); toast('Invite link copied'); } catch { toast(link); } t.remove(); }
};
api.on('discordBot', (st) => { bt.st = st; btPaintStatus(); });

async function openDiscordView() {
  const [info, st, bst, bcmds] = await Promise.all([run('discordInfo'), run('settings'), run('discordBotStatus'), run('discordBotCommands')]);
  if (!info) return;
  if (st) appSettings = { ...appSettings, ...st };
  const d = (st && st.discord) || {};
  dc.info = info; dc.hook = d.webhookUrl || '';
  dc.events = {}; for (const e of info.events) dc.events[e.key] = typeof (d.events || {})[e.key] === 'boolean' ? d.events[e.key] : !!e.on;
  dc.templates = {}; for (const e of info.events) dc.templates[e.key] = JSON.parse(JSON.stringify(info.templates[e.key]));
  if (!dc.sel || !dc.templates[dc.sel]) dc.sel = info.events[0] && info.events[0].key;
  $('#dcWebhook').value = dc.hook; dcHookMsg('');
  bt.st = bst || bt.st; bt.cmds = bcmds || []; btFill(d); btPaintStatus(); btPaintCmds();
  dcRenderEvents(); dcRenderEditor();
}
$('#dcTest').onclick = () => dcSendTest('plain');
$('#dcSaveHook').onclick = () => dcSaveAll();
$('#dcSave').onclick = () => dcSaveAll();
viewHooks.discord = openDiscordView;
