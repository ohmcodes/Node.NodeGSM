'use strict';
// Files tab: auto-clear rules of the server (panel + "Auto-clear..." dialog). Uses the globals of app.js (run, esc, $, toast, state).

const acFmt = (b) => (b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(2)} GB` : b >= 2 ** 20 ? `${(b / 2 ** 20).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`);
const acEvery = (m) => (m % 1440 === 0 ? `${m / 1440} d` : m % 60 === 0 ? `${m / 60} h` : `${m} min`);
const acWhen = (t) => (t ? new Date(t).toLocaleString() : 'never');
const ac = { sid: null, rules: [], editing: null };   // editing: rule index, or -1 for a new rule

const acPlain = (r) => ({ path: r.path, pattern: r.pattern, olderThanDays: r.olderThanDays, intervalMin: r.intervalMin, enabled: r.enabled, recursive: r.recursive, onlyWhenStopped: r.onlyWhenStopped, lastRun: r.lastRun });

async function acSave(rules, msg) {
  const r = await run('autoClearSave', ac.sid, rules.map(acPlain));
  if (!r) return false;
  ac.rules = r; acPaint(); if (msg) toast(msg); return true;
}

function acPaint() {
  const box = $('#acPanel'); if (!box) return;
  box.querySelector('.ac-rows').innerHTML = ac.rules.length ? `<table><tr><th>On</th><th>Folder</th><th>Pattern</th><th>Older than</th><th>Every</th><th>Last run</th><th></th></tr>${ac.rules.map((r) => `<tr data-i="${r.index}">
      <td><input type="checkbox" class="ac-on" ${r.enabled ? 'checked' : ''} title="Enable / disable"></td>
      <td class="nw">${esc(r.path)}${r.recursive ? ' <span class="badge">+ subfolders</span>' : ''}${r.fromPlugin ? ' <span class="badge" title="Suggested by the game plugin">plugin</span>' : ''}</td>
      <td>${esc(r.pattern)}</td><td class="nw">${r.olderThanDays ? `${esc(r.olderThanDays)} d` : 'any age'}</td><td class="nw">${esc(acEvery(r.intervalMin))}${r.onlyWhenStopped ? ' (stopped only)' : ''}</td><td class="nw">${esc(acWhen(r.lastRun))}</td>
      <td class="bk-act"><button class="ac-run" title="Delete matching files now">Run now</button><button class="ac-prev" title="Show what would be deleted">Preview</button><button class="ac-edit">Edit</button><button class="ac-del danger">Delete</button></td></tr>`).join('')}</table>`
    : '<p class="muted small">No rules yet. Open a folder and press <b>Auto-clear this folder...</b> (or right-click a folder).</p>';
  box.querySelectorAll('tr[data-i]').forEach((tr) => {
    const i = Number(tr.dataset.i);
    tr.querySelector('.ac-on').onchange = (e) => acSave(ac.rules.map((r) => (r.index === i ? { ...r, enabled: e.target.checked } : r)));
    tr.querySelector('.ac-edit').onclick = () => acDialog(i);
    tr.querySelector('.ac-del').onclick = () => { if (confirm('Delete this rule? (Files already deleted are not affected.)')) acSave(ac.rules.filter((r) => r.index !== i), 'Rule deleted'); };
    tr.querySelector('.ac-prev').onclick = () => acRun(i, true);
    tr.querySelector('.ac-run').onclick = () => { const r = ac.rules.find((x) => x.index === i); if (confirm(`Delete files in "${r.path}" matching ${r.pattern}${r.olderThanDays ? ` older than ${r.olderThanDays} days` : ''} now?\n\nThis cannot be undone. Use Preview first if unsure.`)) acRun(i, false); };
  });
}

async function acRun(i, dry) {
  const r = await run('autoClearRun', ac.sid, i, dry);
  if (!r) return;
  const x = r.results[0]; const out = $('#acResult'); if (!out || !x) return;
  const head = dry ? `Preview: ${x.matched} file${x.matched === 1 ? '' : 's'} (${acFmt(x.bytes)}) would be deleted.` : `Deleted ${x.deleted} file${x.deleted === 1 ? '' : 's'} (${acFmt(x.freed)})${x.locked ? `, ${x.locked} locked and skipped` : ''}.`;
  out.innerHTML = `<b>${esc(head)}</b>${x.exists ? '' : ' <span class="muted">The folder does not exist.</span>'}${x.errors.length ? `<div class="err">${x.errors.slice(0, 5).map(esc).join('<br>')}</div>` : ''}${dry && x.sample.length ? `<div class="muted small">${x.sample.map(esc).join('<br>')}${x.matched > x.sample.length ? '<br>...' : ''}</div>` : ''}`;
  if (!dry) acReload();
}
async function acReload() { const r = await run('autoClearList', ac.sid); if (r) { ac.rules = r; acPaint(); } }

/** Open the dialog for a rule index (existing) or a new rule for a folder path. */
function acDialog(indexOrPath) {
  const isNew = typeof indexOrPath === 'string';
  const r = isNew ? { path: indexOrPath, pattern: '*', olderThanDays: 7, intervalMin: 1440, enabled: true, recursive: false, onlyWhenStopped: false } : ac.rules.find((x) => x.index === indexOrPath);
  if (!r) return;
  ac.editing = isNew ? -1 : indexOrPath;
  $('#acPath').value = r.path; $('#acPattern').value = r.pattern; $('#acDays').value = r.olderThanDays; $('#acEvery').value = r.intervalMin;
  $('#acEnabled').checked = r.enabled; $('#acRecursive').checked = r.recursive; $('#acStopped').checked = r.onlyWhenStopped;
  $('#dlgAutoClear').showModal();
}
$('#acCancel').onclick = () => $('#dlgAutoClear').close();
$('#acForm').onsubmit = async (e) => {
  e.preventDefault();
  const rule = { path: $('#acPath').value.trim(), pattern: $('#acPattern').value.trim() || '*', olderThanDays: Number($('#acDays').value || 0), intervalMin: Number($('#acEvery').value || 1440), enabled: $('#acEnabled').checked, recursive: $('#acRecursive').checked, onlyWhenStopped: $('#acStopped').checked };
  const rules = ac.rules.map((x) => acPlain(x));
  if (ac.editing === -1) rules.push(rule); else rules[ac.rules.findIndex((x) => x.index === ac.editing)] = { ...rule, lastRun: ac.rules.find((x) => x.index === ac.editing).lastRun };
  if (await acSave(rules, 'Rule saved')) $('#dlgAutoClear').close();
};

/** Called by tabFiles: fills #acPanel for server s. */
async function acMount(s) {
  ac.sid = s.id;
  const box = $('#acPanel'); if (!box) return;
  box.innerHTML = `<h4>Auto-clear rules</h4><p class="muted small" style="margin:0 0 6px">Deletes <b>files</b> (never folders) that match the pattern and are older than the given age, checked every minute and run at most once per interval. Links are not followed, locked files are skipped, everything stays inside this server's folder.</p>
    <div class="ac-rows"></div><div id="acResult" class="small"></div>`;
  await acReload();
}
