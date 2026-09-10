/* ================================================================
   blooket-create.js — Create-set modal + blooket error modal + bulk paste.
   Loaded after app.js (which provides state, helpers, icons, theme).
   This file owns:
     - REVIEW: CREATE SET MODAL  (manual set creation)
     - BLOOKET ERROR MODAL      (crashes / publish failures)
     - CUSTOM BLOOKET (paste / upload)  (bulk paste parser)
   ================================================================ */


// ─── REVIEW: CREATE SET MODAL ────────────────────────────────────
let _createSetOverlay = null;

function _createSetKeydown(e) {
  if (e.key === 'Escape') closeCreateSetModal();
}

function createSetOverlay() {
  if (_createSetOverlay) return _createSetOverlay;
  const overlay = document.createElement('div');
  overlay.id = 'create-set-overlay';
  overlay.className = 'fixed inset-0 z-50 flex items-start sm:items-center justify-center p-4 overflow-y-auto';
  overlay.style.cssText = 'background:rgba(0,0,0,0.6);backdrop-filter:blur(8px);';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeCreateSetModal(); });
  document.body.appendChild(overlay);
  document.addEventListener('keydown', _createSetKeydown);
  _createSetOverlay = overlay;
  return overlay;
}

function closeCreateSetModal() {
  document.removeEventListener('keydown', _createSetKeydown);
  if (_createSetOverlay) { _createSetOverlay.remove(); _createSetOverlay = null; }
}

function openCreateSetModal() {
  createSetOverlay();
  renderCreateSetPicker();
}

function createSetModalHeader(title, backFn) {
  return `
    <div class="flex items-center gap-2 px-5 py-4 border-b border-[#22222e]">
      ${backFn ? `<button type="button" onclick="${backFn}" title="Back" class="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-white hover:bg-[#16161f] transition-colors flex-shrink-0">${icon('chevronLeft', 'w-4 h-4')}</button>` : ''}
      <div class="flex-1 min-w-0">
        <div class="text-base font-semibold text-white truncate">${title}</div>
      </div>
      <button type="button" onclick="closeCreateSetModal()" class="w-8 h-8 flex items-center justify-center rounded-lg text-gray-500 hover:text-gray-300 hover:bg-[#16161f] transition-colors flex-shrink-0">${icon('x', 'w-4 h-4')}</button>
    </div>`;
}

function renderCreateSetPicker() {
  const overlay = createSetOverlay();
  overlay.innerHTML = `
    <div class="create-set-panel w-full max-w-xl bg-[#12121b] border border-[#22222e] rounded-2xl shadow-2xl overflow-hidden fade-in">
      ${createSetModalHeader('Create a quiz set')}
      <div class="p-5">
        <div class="text-sm text-gray-400 mb-4">Pick how you want to build it</div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <button type="button" onclick="showCreateSetCustom()" class="text-left rounded-2xl border border-teal-500/30 bg-teal-500/10 p-5 hover:bg-teal-500/15 hover:border-teal-500/50 transition-all">
            <div class="w-11 h-11 rounded-xl bg-teal-500/15 text-teal-300 flex items-center justify-center mb-4">${icon('file', 'w-5 h-5')}</div>
            <div class="text-sm font-semibold text-white mb-1">Custom</div>
            <div class="text-xs text-gray-500 leading-relaxed">Paste text or upload a document and turn it into a quiz.</div>
          </button>
          <button type="button" onclick="renderCreateSetNotes()" class="text-left rounded-2xl border border-purple-500/30 bg-purple-500/10 p-5 hover:bg-purple-500/15 hover:border-purple-500/50 transition-all">
            <div class="w-11 h-11 rounded-xl bg-purple-500/15 text-purple-300 flex items-center justify-center mb-4">${icon('sparkle', 'w-5 h-5')}</div>
            <div class="text-sm font-semibold text-white mb-1">From class notes</div>
            <div class="text-xs text-gray-500 leading-relaxed">Generate a quiz from a class's latest chapter.</div>
          </button>
        </div>
      </div>
    </div>`;
}

function renderCreateSetNotes() {
  const overlay = createSetOverlay();
  const classes = state.blooketClasses || [];
  const rows = classes.length
    ? classes.map(c => {
        const color = c._color || COLORS[0];
        const latest = c.latest;
        const letter = escapeHtml((c.shortName || c.name || '?').trim().charAt(0).toUpperCase());
        return `
        <button type="button" onclick="startClassFlow('${jsStr(c.classId)}')" class="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-[#16161f] transition-all text-left">
          <span class="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold flex-shrink-0" style="background:${color}24; color:${color}">${letter}</span>
          <span class="min-w-0 flex-1">
            <span class="block text-sm font-medium text-gray-200 truncate">${escapeHtml(c.name)}</span>
            <span class="block text-[11px] text-gray-500 truncate">${latest ? 'Latest chapter: ' + escapeHtml(latest.title) : 'No chapter notes yet'}</span>
          </span>
          ${icon('chevronRight', 'w-4 h-4 text-gray-600 flex-shrink-0')}
        </button>`;
      }).join('')
    : `
    <div class="p-6 text-center">
      <div class="text-xs text-gray-500 leading-relaxed">No classes have linked notes yet.<br>Link a Trilium notes folder in <span class="text-gray-300">Settings → Class Notes</span>.</div>
    </div>`;
  overlay.innerHTML = `
    <div class="create-set-panel w-full max-w-xl bg-[#12121b] border border-[#22222e] rounded-2xl shadow-2xl overflow-hidden fade-in">
      ${createSetModalHeader('From class notes', 'renderCreateSetPicker()')}
      <div class="${classes.length ? 'p-2 max-h-[55vh] overflow-y-auto' : ''}">${rows}</div>
    </div>`;
}

function startClassFlow(classId) {
  const cls = (state.blooketClasses || []).find(c => String(c.classId) === String(classId));
  openBlooketFlow(classId, cls?.name || 'Class', cls?.latest?.title || '');
}

window.startChapterFlow = function(classId, noteId) {
  const cls = (state.blooketClasses || []).find(c => String(c.classId) === String(classId));
  const chapterTitle = noteId ? (cls?.sets || []).find(s => s.sourceNoteId === noteId)?.chapterTitle || '' : cls?.latest?.title || '';
  openBlooketFlow(classId, cls?.name || 'Class', chapterTitle, noteId || '');
}

function renderCreateSetClassConfig() {
  const ctx = _blooketCtx;
  if (!ctx) return;
  const overlay = createSetOverlay();
  const cls = (state.blooketClasses || []).find(c => String(c.classId) === String(ctx.classId));
  const color = cls?._color || COLORS[0];
  const latest = cls?.latest;
  const letter = escapeHtml((cls?.shortName || cls?.name || '?').trim().charAt(0).toUpperCase());
  overlay.innerHTML = `
    <div class="create-set-panel w-full max-w-xl bg-[#12121b] border border-[#22222e] rounded-2xl shadow-2xl overflow-hidden fade-in">
      ${createSetModalHeader('From class notes', 'renderCreateSetNotes()')}
      <div class="p-5">
        <div class="flex items-center gap-3 mb-4">
          <span class="w-10 h-10 rounded-xl flex items-center justify-center text-sm font-bold flex-shrink-0" style="background:${color}24; color:${color}">${letter}</span>
          <div class="min-w-0">
            <div class="text-sm font-semibold text-white truncate">${escapeHtml(cls?.name || ctx.className || 'Class')}</div>
            <div class="text-[11px] text-gray-500 truncate">${latest ? 'Latest chapter: <a href="' + escapeHtml(triliumWebUrl(latest.noteId)) + '" target="_blank" rel="noopener" class="hover:text-blue-400 hover:underline underline-offset-2 transition-colors">' + escapeHtml(latest.title) + '</a>' : 'No chapter notes yet'}</div>
          </div>
        </div>
        <label class="block text-[11px] font-medium text-gray-500 mb-1.5">Focus prompt (optional)</label>
        <input id="blooket-prompt-input" type="text" placeholder="e.g. ecosystems, key vocabulary, the brain…" value="${escapeHtml(ctx.prompt || '')}"
          oninput="_blooketCtx && (_blooketCtx.prompt = this.value)"
          onkeydown="if(event.key==='Enter'){event.preventDefault();startBlooketGenerate();}"
          class="w-full bg-[#0a0a0f] border border-[#22222e] rounded-xl px-3.5 py-2.5 text-sm text-white placeholder-gray-600 focus:border-purple-500/50 transition-colors mb-4">
        ${blooketAppendOptions(ctx.classId)}
        <button id="blooket-submit-btn" type="button" onclick="startBlooketGenerate()"
          class="w-full flex items-center justify-center gap-2 bg-purple-500/20 border border-purple-500/30 rounded-xl px-4 py-3 text-sm font-medium text-purple-300 hover:bg-purple-500/30 transition-all">${icon('sparkle', 'w-4 h-4')}Start generating</button>
        <div class="text-[11px] text-gray-600 mt-3 text-center">The set will appear in this class's card when it's ready.</div>
      </div>
    </div>`;
  setTimeout(() => document.getElementById('blooket-prompt-input')?.focus(), 60);
}

function showCreateSetCustom() {
  const overlay = createSetOverlay();
  overlay.innerHTML = `
    <div class="create-set-panel w-full max-w-2xl bg-[#12121b] border border-[#22222e] rounded-2xl shadow-2xl overflow-hidden fade-in">
      ${createSetModalHeader('Custom quiz', 'renderCreateSetPicker()')}
      <div class="p-5">${customBlooketBuilderHtml()}</div>
    </div>`;
  populateCustomBlooketTarget(state.blooketClasses || [], state.blooketCustomSets || []);
  renderCustomBlooketSets(state.blooketCustomSets || []);
  renderCustomBlooketFileChip();
}

function openCustomBlooketModal() {
  showCreateSetCustom();
}

function customBlooketBuilderHtml() {
  return `
  <div class="rounded-xl border border-[#22222e] bg-[#0a0a0f] p-3 mb-3">
    <textarea id="custom-blooket-text" rows="6" placeholder="Paste your notes, article, or study material here…"
      class="w-full bg-transparent text-sm text-white placeholder-gray-600 focus:outline-none resize-none"
      oninput="state.customBlooketText=this.value" onpaste="onCustomBlooketPaste(event)">${escapeHtml(state.customBlooketText || '')}</textarea>
    <div id="custom-blooket-file" class="hidden items-center gap-2 text-xs text-gray-400 bg-[#16161f] rounded-lg px-2.5 py-1.5 mt-2">
      <span class="w-3.5 h-3.5 text-green-400">${icon('file', 'w-3.5 h-3.5')}</span>
      <span id="custom-blooket-file-name" class="truncate"></span>
      <button type="button" onclick="clearCustomBlooketFile()" class="text-gray-600 hover:text-red-400 ml-auto flex-shrink-0">${icon('x', 'w-3.5 h-3.5')}</button>
    </div>
    <input type="file" id="custom-blooket-file-input" accept=".txt,.md,.rtf,.csv" class="hidden" onchange="handleCustomBlooketFileInput(event)">
    <div class="flex items-center gap-2 mt-2">
      <button type="button" onclick="document.getElementById('custom-blooket-file-input').click()" class="inline-flex items-center gap-1.5 text-xs font-medium text-gray-400 border border-[#22222e] rounded-lg px-2.5 py-1.5 hover:text-purple-300 hover:border-purple-500/40 transition-all">${icon('upload', 'w-3.5 h-3.5')}Upload a document</button>
    </div>
  </div>

  <div class="flex flex-col sm:flex-row gap-2 mb-3">
    <input id="custom-blooket-prompt" type="text" placeholder="Optional spec — e.g. focus on vocabulary and formulas, 15 questions" value="${escapeHtml(state.customBlooketPrompt || '')}"
      oninput="state.customBlooketPrompt=this.value"
      class="flex-1 bg-[#0a0a0f] border border-[#22222e] rounded-xl px-3.5 py-2.5 text-sm text-white placeholder-gray-600 focus:border-purple-500/50 transition-colors">
    <select id="custom-blooket-target" class="bg-[#0a0a0f] border border-[#22222e] rounded-xl px-3 py-2.5 text-sm text-gray-200 focus:border-purple-500/50 transition-colors max-w-full">
      <option value="">Create a new set</option>
    </select>
  </div>

  <button id="custom-blooket-submit" type="button" onclick="startCustomBlooket()"
    class="w-full flex items-center justify-center gap-2 bg-purple-500/20 border border-purple-500/30 rounded-xl px-4 py-2.5 text-sm font-medium text-purple-300 hover:bg-purple-500/30 transition-all">${icon('sparkle', 'w-4 h-4')}Generate quiz</button>
  <div id="custom-blooket-sets" class="flex flex-wrap gap-2 mt-3"></div>`;
}

function openBlooketFlow(classId, className, chapterTitle, noteId) {
  if (_blooketPollTimer) { clearInterval(_blooketPollTimer); _blooketPollTimer = null; }
  _blooketCtx = {
    classId: classId || '',
    className: className || 'Class',
    chapterTitle: chapterTitle || '',
    noteId: noteId || '',
    custom: false,
    busy: false,
    done: false,
    notified: false,
    errorModalShown: false,
    prompt: '',
    setUrl: '',
  };
  dismissBlooketErrorModal();
  clearAllBlooketProgress();
  renderCreateSetClassConfig();
}

function blooketAppendOptions(classId) {
  if (!classId) return '';
  const cls = (state.blooketClasses || []).find(c => String(c.classId) === String(classId));
  const sets = (cls?.sets || []).slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  if (!sets.length) return '';
  const opts = ['<option value="">Publish a new set</option>',
    ...sets.map(s => `<option value="${escapeHtml(s.setUrl)}">Append to “${escapeHtml((s.title || s.chapterTitle || 'set').slice(0, 42))}”</option>`)];
  return `
    <label class="block text-[11px] font-medium text-gray-500 mb-1">Append to an existing set (optional)</label>
    <select id="blooket-append-target" onchange="blooketAppendChanged(this)"
      class="w-full bg-[#0a0a0f] border border-[#22222e] rounded-lg px-2.5 py-2 text-sm text-gray-200 focus:border-purple-500/50 transition-colors mb-2">${opts.join('')}</select>`;
}

function blooketAppendChanged(sel) {
  if (_blooketCtx) _blooketCtx.setUrl = sel.value;
  const btn = document.getElementById('blooket-submit-btn');
  if (!btn) return;
  btn.innerHTML = `${icon(sel.value ? 'plus' : 'sparkle', 'w-3.5 h-3.5')}${sel.value ? 'Append & publish set' : 'Create Blooket set'}`;
}

function cancelBlooketFlow() {
  if (_blooketPollTimer) { clearInterval(_blooketPollTimer); _blooketPollTimer = null; }
  _blooketCtx = null;
  state.customBlooketRunning = false;
  clearAllBlooketProgress();
  dismissBlooketErrorModal();
}

function clearAllBlooketProgress() {
  document.querySelectorAll('.blooket-progress').forEach(el => { el.innerHTML = ''; });
}

function blooketProgressTarget() {
  const ctx = _blooketCtx;
  if (!ctx) return null;
  if (ctx.custom) return document.querySelector('.blooket-progress[data-class-id="custom"]');
  return document.querySelector(`.blooket-progress[data-class-id="${cssEscape(ctx.classId)}"]`);
}

function cssEscape(v) {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(String(v)) : String(v).replace(/["\\]/g, '\\$&');
}

function renderBlooketStepsInline(data) {
  const target = blooketProgressTarget();
  if (!target) return;
  const r = data.result || {};
  const failed = !!data.error || (data.phase === 'failed' && !r.setUrl);
  if (failed) {
    target.innerHTML = `<div class="inline-flex items-center gap-2 rounded-full border border-red-500/30 bg-[#12121b] px-3 py-1.5 shadow-lg">${icon('alert','w-3.5 h-3.5 text-red-400')}<span class="text-xs text-red-300">Publish failed</span></div>`;
    return;
  }
  if (data.phase === 'cancelled') {
    target.innerHTML = `<div class="inline-flex items-center gap-2 rounded-full border border-gray-500/30 bg-[#12121b] px-3 py-1.5 shadow-lg">${icon('x','w-3.5 h-3.5 text-gray-400')}<span class="text-xs text-gray-400">Cancelled</span></div>`;
    return;
  }
  // Phase advances monotonically — once publishing starts (or a URL exists)
  // never regress the pill back to "Generating…" on a stale poll.
  if (_blooketCtx && (data.phase === 'publishing' || r.setUrl)) _blooketCtx.phaseLocked = 'publishing';
  const phase = (_blooketCtx && _blooketCtx.phaseLocked) || data.phase || 'generating';
  // Prefer the bot's detailed step ("Entering title", "Signing in", …) when the
  // backend has one; fall back to the coarse phase label.
  const step = (data.status || '').trim();
  const active = step || (phase === 'publishing' ? 'Publishing' : 'Generating questions');
  let sub = '';
  if ((data.queued > 0) && _blooketCtx && _blooketCtx.jobId) {
    const idx = (data.queue || []).findIndex(q => q.id === _blooketCtx.jobId);
    if (idx >= 0) sub = `<span class="text-[10px] text-gray-500 flex-shrink-0">queued #${idx + 2}</span>`;
  }
  const cancelId = _blooketCtx && _blooketCtx.jobId;
  const transientHtml = data.transientError
    ? `<span class="text-[10px] text-gray-500 flex items-center gap-1 flex-shrink-0">${icon('alert','w-3 h-3')}reconnecting…</span>`
    : '';
  const html = `<div class="inline-flex items-center gap-2 rounded-full border border-[#22222e] bg-[#12121b] px-3 py-1.5 shadow-lg blooket-loading-pill group" data-job="${cancelId || ''}"><span class="w-4 h-4 flex-shrink-0 animate-spin border-2 border-purple-400 border-t-transparent rounded-full"></span><span class="text-xs text-white font-medium">${active}…</span>${sub}${transientHtml}<button type="button" class="hidden group-hover:inline-flex ml-0.5 text-gray-500 hover:text-red-400 transition-colors" title="Cancel" onclick="event.stopPropagation(); cancelBlooketJob('${cancelId || ''}', event)">${icon('x','w-3.5 h-3.5')}</button></div>`;
  if (target.innerHTML === html) return; // keep the spinner smooth, don't replace unchanged DOM each poll
  target.innerHTML = html;
}

async function cancelBlooketJob(jobId, ev) {
  if (!jobId) return;
  if (ev) ev.preventDefault();
  try {
    const res = await fetch('/api/blooket/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: jobId }) });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.detail || 'HTTP ' + res.status); }
    showToast('Queued job cancelled', 'success');
    if (_blooketCtx) renderBlooketStepsInline({ phase: 'cancelled', exitCode: null, result: {} });
  } catch (err) {
    showToast(err.message || 'Could not cancel', 'error');
  }
}

// ─── BLOOKET ERROR MODAL (crashes / publish failures) ───────────
let _blooketErrorData = null;

function showBlooketErrorModal(data) {
  const r = data.result || {};
  const error = r.error || 'The Blooket publish failed — see the logs below.';
  const logs = data.logs || [];
  _blooketErrorData = { error, logs };
  const localKey = r.localKey && (typeof r.localKey === 'string' ? r.localKey : (r.localKey.localKey || ''));
  const existing = document.getElementById('blooket-error-modal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'blooket-error-modal';
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4';
  modal.innerHTML = `
    <div class="bg-[#12121b] border border-red-500/30 rounded-2xl max-w-lg w-full max-h-[85vh] flex flex-col shadow-2xl">
      <div class="flex items-center justify-between px-5 py-4 border-b border-[#22222e]">
        <div class="flex items-center gap-2 text-red-300 font-semibold text-sm">${icon('alert','w-4 h-4')}Blooket publish failed</div>
        <button type="button" onclick="dismissBlooketErrorModal()" class="text-gray-500 hover:text-gray-300 transition-colors">${icon('x','w-4 h-4')}</button>
      </div>
      <div class="px-5 py-4 overflow-y-auto flex-1">
        <p class="text-sm text-gray-300 mb-3 break-words">${escapeHtml(error)}</p>
        <label class="text-[10px] uppercase tracking-wider text-gray-500 font-medium mb-1.5 block">Logs</label>
        <pre class="bg-[#0a0a0f] border border-[#22222e] rounded-lg p-3 text-[10px] font-mono text-gray-400 whitespace-pre-wrap max-h-48 overflow-y-auto">${escapeHtml(logs.join('\n'))}</pre>
      </div>
      <div class="px-5 py-4 border-t border-[#22222e] flex items-center gap-2">
        <button type="button" onclick="copyBlooketLogs()" class="flex-1 text-xs font-medium text-gray-300 border border-[#22222e] rounded-lg px-3 py-2 hover:border-purple-500/40 hover:text-purple-300 transition-all">Copy logs</button>
        ${localKey ? `<button type="button" onclick="dismissBlooketErrorModal(); openSetDetail('${jsStr(localKey)}')" class="flex-1 text-xs font-medium text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 hover:bg-amber-500/20 transition-all">Review locally</button>` : ''}
        <button type="button" onclick="dismissBlooketErrorModal()" class="flex-1 text-xs font-medium text-white bg-purple-500/20 border border-purple-500/30 rounded-lg px-3 py-2 hover:bg-purple-500/30 transition-all">Close</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

function dismissBlooketErrorModal() {
  const el = document.getElementById('blooket-error-modal');
  if (el) el.remove();
  _blooketErrorData = null;
}

function reopenBlooketError() {
  if (_blooketCtx?.lastStatus) showBlooketErrorModal(_blooketCtx.lastStatus);
}

async function copyBlooketLogs() {
  if (!_blooketErrorData) return;
  const text = 'Error: ' + _blooketErrorData.error + '\n\n' + _blooketErrorData.logs.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    showToast('Logs copied to clipboard', 'success');
  } catch (err) {
    showToast('Could not copy automatically — select the logs manually', 'warning');
  }
}


// ─── CUSTOM BLOOKET (paste / upload) ────────────────────────────
function onCustomBlooketPaste() {
  setTimeout(() => {
    const ta = document.getElementById('custom-blooket-text');
    if (!ta || !ta.value.trim() || state.customBlooketFile) return;
    const words = ta.value.trim().split(/\s+/).length;
    state.customBlooketText = ta.value;
    state.customBlooketFile = { name: `pasted-text-${words}-words.txt` };
    renderCustomBlooketFileChip();
  }, 0);
}

async function handleCustomBlooketFileInput(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  const supported = /\.(txt|md|rtf|csv)$/i.test(file.name) || ['text/plain', 'text/markdown', 'text/csv', 'text/rtf'].includes(file.type);
  if (!supported) {
    showToast('Paste the text instead — only .txt / .md / .rtf / .csv files are supported', 'warning');
    return;
  }
  try {
    const text = await file.text();
    const ta = document.getElementById('custom-blooket-text');
    if (ta) ta.value = ta.value.trim() ? ta.value.trim() + '\n\n' + text : text;
    state.customBlooketText = ta ? ta.value : text;
    state.customBlooketFile = { name: file.name };
    renderCustomBlooketFileChip();
  } catch (err) {
    showToast('Could not read that file — paste the text instead', 'warning');
  }
}

function renderCustomBlooketFileChip() {
  const wrap = document.getElementById('custom-blooket-file');
  const nameEl = document.getElementById('custom-blooket-file-name');
  if (!wrap || !nameEl) return;
  if (state.customBlooketFile) {
    nameEl.textContent = state.customBlooketFile.name;
    wrap.classList.remove('hidden');
    wrap.classList.add('flex');
  } else {
    wrap.classList.add('hidden');
    wrap.classList.remove('flex');
  }
}

function clearCustomBlooketFile() {
  state.customBlooketFile = null;
  renderCustomBlooketFileChip();
}

async function startCustomBlooket() {
  if (state.customBlooketRunning) return;
  const text = (document.getElementById('custom-blooket-text')?.value || '').trim();
  if (!text) {
    showToast('Paste text or upload a document first', 'warning');
    return;
  }
  const prompt = (document.getElementById('custom-blooket-prompt')?.value || '').trim();
  const setUrl = document.getElementById('custom-blooket-target')?.value || '';
  if (_blooketPollTimer) { clearInterval(_blooketPollTimer); _blooketPollTimer = null; }
  const label = state.customBlooketFile?.name ? state.customBlooketFile.name.replace(/\.[^.]+$/, '') : 'Custom';
  _blooketCtx = { custom: true, label, setUrl, fileName: state.customBlooketFile?.name || '', busy: true, done: false, notified: false, errorModalShown: false };
  state.customBlooketRunning = true;
  closeCreateSetModal();
  await loadBlooketClasses(false);
  renderBlooketStepsInline({ phase: 'generating', exitCode: null, logs: ['Starting generation…'] });
  try {
    const res = await fetch('/api/blooket/custom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text, prompt, setUrl, fileName: state.customBlooketFile?.name || '' }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Failed to start generation');
    blooketPollTick();
    _blooketPollTimer = setInterval(blooketPollTick, 2500);
  } catch (err) {
    state.customBlooketRunning = false;
    if (_blooketCtx) _blooketCtx.busy = false;
    showToast(err.message || 'Failed to start generation', 'error');
    renderBlooketStepsInline({ error: err.message || 'error' });
  }
}

async function startBlooketGenerate() {
  const ctx = _blooketCtx;
  if (!ctx || ctx.busy || ctx.custom) return;
  const input = document.getElementById('blooket-prompt-input');
  const prompt = input ? input.value.trim() : '';
  const setUrl = (document.getElementById('blooket-append-target')?.value || '').trim();
  const btn = document.getElementById('blooket-submit-btn');
  if (btn) btn.disabled = true;
  ctx.busy = true;
  ctx.prompt = prompt;
  ctx.setUrl = setUrl;
  closeCreateSetModal();
  await loadBlooketClasses(false);
  renderBlooketStepsInline({ phase: 'generating', exitCode: null, logs: ['Starting generation…'] });
  try {
    const res = await fetch('/api/blooket/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ classId: ctx.classId, prompt, setUrl, noteId: ctx.noteId || '' }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Failed to start generation');
    blooketPollTick();
    _blooketPollTimer = setInterval(blooketPollTick, 2500);
  } catch (err) {
    ctx.busy = false;
    if (btn) btn.disabled = false;
    showToast(err.message || 'Failed to start generation', 'error');
    renderBlooketStepsInline({ error: err.message || 'error' });
  }
}

async function blooketPollTick() {
  if (!_blooketCtx || !_blooketCtx.busy) {
    if (_blooketPollTimer) { clearInterval(_blooketPollTimer); _blooketPollTimer = null; }
    return;
  }
  try {
    const res = await fetch('/api/blooket/status?_=' + Date.now());
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (_blooketCtx) { _blooketCtx.lastStatus = data; if (data.jobId) _blooketCtx.jobId = data.jobId; }
    renderBlooketStepsInline(data);
    const doneUrl = data.result?.setUrl;
    if (data.running && !doneUrl) return;
    if (!data.running && data.phase !== 'done' && data.phase !== 'failed' && !doneUrl) return; // race: job not started yet
    if (_blooketPollTimer) { clearInterval(_blooketPollTimer); _blooketPollTimer = null; }
    _blooketCtx.busy = false;
    _blooketCtx.done = true;
    if (_blooketCtx.custom) state.customBlooketRunning = false;
    renderBlooketDoneInline(data);
  } catch (err) {
    // Transient network blip (e.g. the tab was backgrounded) — keep polling,
    // never treat it as a terminal failure while the job still runs.
    if (_blooketCtx?.busy) {
      renderBlooketStepsInline({ ...(_blooketCtx.lastStatus || {}), transientError: err.message || 'reconnecting' });
    }
  }
}

function renderBlooketDoneInline(data) {
  const r = data.result || {};
  // Success the moment a set URL exists (even if the bot process is still
  // closing its browser); only treat as failed on an explicit error or a
  // non-zero exit with no link.
  const failed = !!r.error || (!r.setUrl && data.exitCode !== 0);
  if (failed) {
    const target = blooketProgressTarget();
    if (target) target.innerHTML = `<div class="inline-flex items-center gap-2 rounded-full border border-red-500/30 bg-[#12121b] px-3 py-1.5 shadow-lg">${icon('alert','w-3.5 h-3.5 text-red-400')}<span class="text-xs text-red-300">Publish failed</span></div>`;
    if (!_blooketCtx?.errorModalShown) {
      if (_blooketCtx) _blooketCtx.errorModalShown = true;
      showBlooketErrorModal(data);
      if (state.notifications?.blooketDone !== false) {
        browserNotify('Blooket set failed', { body: (r.error || 'The set could not be published.').slice(0, 120) });
      }
    }
    return;
  }
  // Guard: this runs once per flow. loadBlooketClasses below re-invokes this
  // function (ctx.done is true), so without the flag every reload would fire
  // another toast and reload again — an infinite toast loop.
  if (!_blooketCtx || _blooketCtx.notified) return;
  _blooketCtx.notified = true;
  clearAllBlooketProgress();
  loadBlooketClasses(false);
  showToast((r.title || 'Blooket set') + ' published', 'success');
  if (state.notifications?.blooketDone !== false) {
    browserNotify((r.title || 'Blooket set') + ' published', { body: 'The new set is ready to play.' });
  }
}

async function testTriliumConnection() {
  const url = document.getElementById('trilium-url')?.value.trim();
  const token = document.getElementById('trilium-token')?.value.trim();
  const btn = document.getElementById('trilium-test-btn');
  const status = document.getElementById('trilium-status');
  if (!url) return showToast('Enter the Trilium URL first', 'warning');
  if (!token) return showToast('Enter the Trilium ETAPI token first', 'warning');
  if (btn) btn.disabled = true;
  if (status) status.innerHTML = '<span class="text-gray-500">Testing…</span>';
  try {
    const res = await fetch('/api/trilium/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, token }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Connection failed');
    state.trilium.connected = true;
    if (status) status.innerHTML = `<span class="text-green-400">Connected — ${escapeHtml(data.version || '')}${data.appName ? ' · ' + escapeHtml(data.appName) : ''}</span>`;
    showToast('Trilium connected!', 'success');
  } catch (err) {
    state.trilium.connected = false;
    if (status) status.innerHTML = `<span class="text-red-400">${escapeHtml(err.message || 'Connection failed')}</span>`;
    showToast(err.message || 'Connection failed', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function checkTriliumStatus() {
  try {
    const res = await fetch('/api/trilium/status');
    if (!res.ok) return;
    const data = await res.json();
    state.trilium.connected = data.connected;
    const el = document.getElementById('trilium-status');
    if (el) {
      if (data.connected) el.innerHTML = `<span class="text-green-400">Connected — ${escapeHtml(data.version || '')}</span>`;
      else el.innerHTML = `<span class="text-red-400">${escapeHtml(data.error || 'Not connected')}</span>`;
    }
  } catch (err) {}
}

async function triliumSearchUI() {
  const q = document.getElementById('trilium-search-input')?.value.trim();
  const box = document.getElementById('trilium-search-results');
  const btn = document.getElementById('trilium-search-btn');
  if (!q) return showToast('Enter a search term', 'warning');
  if (box) box.innerHTML = '<div class="text-sm text-gray-500 py-2">Searching…</div>';
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(`/api/trilium/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Search failed');
    const results = data.results || [];
    const classes = (state.computed?.activeClasses || []).filter(c => c.isAcademic);
    if (box) {
      box.innerHTML = results.length === 0
        ? '<div class="text-sm text-gray-500 py-2">No notes found for that search.</div>'
        : results.map((r, i) => `
            <div class="flex flex-wrap items-center gap-2 p-3 ${themeChoice('bg-[#0a0a0f] border-[#22222e]', 'bg-white border-[#d9dde7]')} border rounded-xl">
              <div class="flex-1 min-w-0">
                <div class="text-sm ${themeChoice('text-gray-200','text-gray-800')} truncate">${escapeHtml(r.title || 'Untitled')}</div>
                <div class="text-xs ${themeChoice('text-gray-500','text-gray-600')}">
                  ${badge(r.type || 'note')} ${r.hasChildren ? badge(r.childCount + ' chapters', 'blue') : '<span class="text-xs text-gray-600">no chapters</span>'}
                </div>
              </div>
              <div class="flex items-center gap-2 flex-shrink-0">
                <a href="${triliumWebUrl(r.noteId)}" target="_blank" rel="noopener" class="text-xs ${themeChoice('text-gray-500 hover:text-blue-300','text-gray-600 hover:text-blue-700')}">view</a>
                <select id="trilium-link-class-${r.noteId}" class="px-2 py-1.5 ${themeChoice('bg-[#12121b] border-[#22222e] text-gray-200','bg-white border-[#d9dde7] text-gray-800')} border rounded-lg text-xs max-w-40">
                  <option value="">Link to class…</option>
                  ${classes.map(c => `<option value="${c.id}">${escapeHtml(c.shortName || c.name)}</option>`).join('')}
                </select>
                <button onclick="triliumLinkFromSearch('${r.noteId}')" class="px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-500/20 border border-blue-500/30 text-blue-400 hover:bg-blue-500/30 transition-all" ${r.hasChildren ? '' : 'disabled title="Pick a folder with chapters"'} style="${r.hasChildren ? '' : 'opacity:.4;cursor:not-allowed'}">Link</button>
              </div>
            </div>`).join('');
    }
  } catch (err) {
    if (box) box.innerHTML = `<div class="text-sm text-red-400 py-2">${escapeHtml(err.message || 'Search failed')}</div>`;
    showToast(err.message || 'Search failed', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function triliumLinkFromSearch(noteId) {
  const sel = document.getElementById(`trilium-link-class-${noteId}`);
  const classId = sel?.value;
  if (!classId) return showToast('Choose a class to link to', 'warning');
  try {
    const res = await fetch('/api/trilium/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ classId, noteId }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Link failed');
    state.trilium.notes[classId] = data.linked;
    showToast('Note linked to class!', 'success');
    render({ preserveScroll: true });
  } catch (err) {
    showToast(err.message || 'Link failed', 'error');
  }
}

async function triliumUnlink(classId) {
  try {
    const res = await fetch(`/api/trilium/link?classId=${encodeURIComponent(classId)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Unlink failed');
    delete state.trilium.notes[classId];
    showToast('Note unlinked', 'success');
    render({ preserveScroll: true });
  } catch (err) {
    showToast(err.message || 'Unlink failed', 'error');
  }
}

function triliumNoteCard(classId, clsName) {
  return triliumCardHtml(classId, clsName, false);
}

function triliumNoteLinkButton(classId) {
  const link = triliumNotesFor(classId);
  if (!link) return '';
  return `<a href="${triliumWebUrl(link.noteId)}" target="_blank" rel="noopener" title="Open class notes in Trilium" class="flex items-center gap-1 px-2 py-1 rounded-lg ${themeChoice('bg-[#12121b] border-[#22222e] text-gray-400 hover:text-blue-300 hover:border-blue-500/30', 'bg-white border-[#d9dde7] text-gray-600 hover:text-blue-700 hover:border-blue-400/40')} border text-[10px] font-medium transition-colors">${icon('trilium','w-3 h-3')} Notes</a>`;
}

const NOTE_QUIZ_WEEKDAYS = [
  { key: 0, short: 'Mon', long: 'Monday' },
  { key: 1, short: 'Tue', long: 'Tuesday' },
  { key: 2, short: 'Wed', long: 'Wednesday' },
  { key: 3, short: 'Thu', long: 'Thursday' },
  { key: 4, short: 'Fri', long: 'Friday' },
  { key: 5, short: 'Sat', long: 'Saturday' },
  { key: 6, short: 'Sun', long: 'Sunday' },
];

function _noteQuizCfg(classId) {
  const block = (state.noteQuiz && state.noteQuiz.classes) || {};
  const cfg = block[classId] || {};
  const weekdaysRaw = Array.isArray(cfg.weekdays) ? cfg.weekdays : [0, 1, 2, 3, 4];
  const weekdays = weekdaysRaw.map(d => parseInt(d, 10)).filter(d => Number.isInteger(d) && d >= 0 && d <= 6);
  return {
    enabled: !!cfg.enabled,
    minLines: typeof cfg.minLines === 'number' ? cfg.minLines : (parseInt(cfg.minLines, 10) || 3),
    questionsPerSet: typeof cfg.questionsPerSet === 'number' ? cfg.questionsPerSet : (parseInt(cfg.questionsPerSet, 10) || 20),
    notify: cfg.notify !== false,
    startTime: typeof cfg.startTime === 'string' ? cfg.startTime : '',
    endTime: typeof cfg.endTime === 'string' ? cfg.endTime : '',
    weekdays: weekdays.length ? Array.from(new Set(weekdays)) : [0, 1, 2, 3, 4],
  };
}

function noteQuizClassCard(classId) {
  const cfg = _noteQuizCfg(classId);
  const dark = state.theme !== 'light';
  const weekdayChips = NOTE_QUIZ_WEEKDAYS.map(d => {
    const on = cfg.weekdays.includes(d.key);
    return `<button type="button" data-note-quiz-day="${classId}" data-day="${d.key}"
      onclick="window.noteQuizToggleDay('${classId}', ${d.key}, ${!on})"
      class="px-1.5 py-0.5 rounded-md text-[10px] font-medium border transition-colors ${on
        ? (dark ? 'bg-blue-500/20 border-blue-500/40 text-blue-300' : 'bg-blue-500/15 border-blue-500/40 text-blue-700')
        : (dark ? 'bg-[#0a0a0f] border-[#22222e] text-gray-500 hover:text-gray-300 hover:border-[#3a3a4a]' : 'bg-white border-[#d9dde7] text-gray-500 hover:text-gray-700 hover:border-[#c4c9d4]')}">${d.short}</button>`;
  }).join('');
  return `
    <div data-note-quiz-card="${classId}" class="mt-3 pt-3 border-t border-[#22222e]">
      <div class="flex items-center justify-between gap-3 mb-2">
        <div class="min-w-0">
          <div class="flex items-center gap-2 text-xs font-semibold ${dark ? 'text-gray-200' : 'text-gray-800'}">
            ${icon('sparkle','w-3.5 h-3.5 text-blue-400')}
            Note quizzes
          </div>
          <div class="text-[11px] ${dark ? 'text-gray-500' : 'text-gray-600'} mt-0.5 leading-relaxed">
            Auto-generate a quiz from new lines added to this class's chapter notes. The quiz stays local — nothing is sent to Blooket.
          </div>
        </div>
        <label class="switch" title="Enable note quizzes for this class">
          <input type="checkbox" data-note-quiz-enabled="${classId}" ${cfg.enabled ? 'checked' : ''} onchange="window.noteQuizToggleClass('${classId}', this.checked); scheduleSettingsSave('general')">
          <span class="track"><span class="thumb"></span></span>
        </label>
      </div>
      <div class="grid grid-cols-2 gap-2 mt-2" ${cfg.enabled ? '' : 'style="display:none"'} data-note-quiz-fields="${classId}">
        <label class="block">
          <span class="text-[10px] ${dark ? 'text-gray-500' : 'text-gray-600'} block mb-1">Start time</span>
          <input type="time" value="${escapeHtml(cfg.startTime)}" data-note-quiz-start="${classId}"
            oninput="window.noteQuizUpdateField('${classId}','startTime',this.value); scheduleSettingsSave('general')"
            class="w-full px-2 py-1.5 ${dark ? 'bg-[#12121b] border-[#22222e] text-gray-200' : 'bg-white border-[#d9dde7] text-gray-800'} border rounded-lg text-xs">
        </label>
        <label class="block">
          <span class="text-[10px] ${dark ? 'text-gray-500' : 'text-gray-600'} block mb-1">End time</span>
          <input type="time" value="${escapeHtml(cfg.endTime)}" data-note-quiz-end="${classId}"
            oninput="window.noteQuizUpdateField('${classId}','endTime',this.value); scheduleSettingsSave('general')"
            class="w-full px-2 py-1.5 ${dark ? 'bg-[#12121b] border-[#22222e] text-gray-200' : 'bg-white border-[#d9dde7] text-gray-800'} border rounded-lg text-xs">
        </label>
        <div class="col-span-2">
          <span class="text-[10px] ${dark ? 'text-gray-500' : 'text-gray-600'} block mb-1">Days class meets</span>
          <div class="flex flex-wrap gap-1">${weekdayChips}</div>
        </div>
        <label class="block">
          <span class="text-[10px] ${dark ? 'text-gray-500' : 'text-gray-600'} block mb-1">Min new lines to trigger</span>
          <input type="number" min="1" max="50" value="${cfg.minLines}" data-note-quiz-min="${classId}"
            oninput="window.noteQuizUpdateField('${classId}','minLines',this.value); scheduleSettingsSave('general')"
            class="w-full px-2 py-1.5 ${dark ? 'bg-[#12121b] border-[#22222e] text-gray-200' : 'bg-white border-[#d9dde7] text-gray-800'} border rounded-lg text-xs">
        </label>
        <label class="col-span-2 flex items-center gap-2 mt-1">
          <input type="checkbox" data-note-quiz-notify="${classId}" ${cfg.notify ? 'checked' : ''} onchange="window.noteQuizUpdateField('${classId}','notify',this.checked); scheduleSettingsSave('general')" class="rounded ${dark ? 'bg-[#1c1c26] border-[#22222e] text-blue-500' : 'border-[#d9dde7] text-blue-600'} focus:ring-blue-500/30">
          <span class="text-[11px] ${dark ? 'text-gray-400' : 'text-gray-600'}">Notify me when a quiz is ready</span>
        </label>
      </div>
    </div>
  `;
}

window.noteQuizToggleClass = function(classId, enabled) {
  if (!state.noteQuiz) state.noteQuiz = { classes: {} };
  if (!state.noteQuiz.classes) state.noteQuiz.classes = {};
  const cur = state.noteQuiz.classes[classId] || {};
  cur.enabled = !!enabled;
  if (typeof cur.minLines !== 'number') cur.minLines = 3;
  if (typeof cur.questionsPerSet !== 'number') cur.questionsPerSet = 20;
  if (typeof cur.notify !== 'boolean') cur.notify = true;
  if (!Array.isArray(cur.weekdays) || cur.weekdays.length === 0) cur.weekdays = [0, 1, 2, 3, 4];
  state.noteQuiz.classes[classId] = cur;
  const fields = document.querySelector(`[data-note-quiz-fields="${classId}"]`);
  if (fields) fields.style.display = enabled ? '' : 'none';
};

window.noteQuizToggleDay = function(classId, day, on) {
  if (!state.noteQuiz) state.noteQuiz = { classes: {} };
  if (!state.noteQuiz.classes) state.noteQuiz.classes = {};
  const cur = state.noteQuiz.classes[classId] || {};
  const days = Array.isArray(cur.weekdays) ? Array.from(new Set(cur.weekdays)) : [0, 1, 2, 3, 4];
  const has = days.includes(day);
  if (on && !has) days.push(day);
  if (!on && has) days.splice(days.indexOf(day), 1);
  cur.weekdays = days.sort((a, b) => a - b);
  state.noteQuiz.classes[classId] = cur;
  // Update chip style in place without a full re-render.
  const btn = document.querySelector(`[data-note-quiz-day="${classId}"][data-day="${day}"]`);
  if (btn) {
    const dark = state.theme !== 'light';
    const on2 = cur.weekdays.includes(day);
    btn.className = `px-1.5 py-0.5 rounded-md text-[10px] font-medium border transition-colors ${on2
      ? (dark ? 'bg-blue-500/20 border-blue-500/40 text-blue-300' : 'bg-blue-500/15 border-blue-500/40 text-blue-700')
      : (dark ? 'bg-[#0a0a0f] border-[#22222e] text-gray-500 hover:text-gray-300 hover:border-[#3a3a4a]' : 'bg-white border-[#d9dde7] text-gray-500 hover:text-gray-700 hover:border-[#c4c9d4]')}`;
  }
  scheduleSettingsSave('general');
};

window.noteQuizUpdateField = function(classId, key, value) {
  if (!state.noteQuiz) state.noteQuiz = { classes: {} };
  if (!state.noteQuiz.classes) state.noteQuiz.classes = {};
  const cur = state.noteQuiz.classes[classId] || {};
  if (key === 'notify') {
    cur.notify = !!value;
  } else if (key === 'startTime' || key === 'endTime') {
    cur[key] = String(value || '').trim();
  } else {
    const n = parseInt(value, 10);
    cur[key] = isFinite(n) ? Math.max(1, n) : (key === 'minLines' ? 3 : 5);
  }
  state.noteQuiz.classes[classId] = cur;
};



// ─── SETTINGS (tabbed shell + autosave + Cmd+K palette) ────────────────────────

// Top-level settings pages (full-page sections shown from the settings landing page).
// `bucket` is the autosave/status key used by scheduleSettingsSave(). Sections that
// share a bucket share one "Saving…/Saved" indicator.
const SETTINGS_SECTIONS = [
  { id: 'account',     label: 'Account',              icon: 'user',     desc: 'Profile picture, display name, position, and sign-in credentials.', bucket: 'account' },
  { id: 'classes',     label: 'Classes & Goals',      icon: 'target',   desc: 'Grade goals, class names, colors, skipping, and per-class Trilium notes.', bucket: 'general' },
  { id: 'email',       label: 'Email & Notifications', icon: 'bell',    desc: 'Email recipients, subject, HTML template, and browser alerts.', bucket: 'general' },
  { id: 'data',        label: 'Data & Refresh',       icon: 'clock',    desc: 'How often the dashboard refreshes, and scheduled FACTS scrapes.', bucket: 'data' },
  { id: 'connections', label: 'Connections & AI',     icon: 'sparkle',  desc: 'AI model, API keys, Trilium ETAPI, and AI prompts.', bucket: 'connections' },
  { id: 'updates',     label: 'Updates',              icon: 'download', desc: 'Pull the latest code from GitHub. Never touches your settings, data, or venv.', bucket: 'general' },
  { id: 'app',         label: 'App',                  icon: 'settings', desc: 'Theme, data year, review behavior, and the project README.', bucket: 'general' },
];

// Autosave/status buckets (keys used by scheduleSettingsSave()).
const SETTINGS_BUCKETS = ['general', 'data', 'connections', 'account'];

// Per-section save UI state (module-scope so it doesn't churn render state).
const SETTINGS_STATUS = {};
SETTINGS_BUCKETS.forEach(t => { SETTINGS_STATUS[t] = { dirty: false, saving: false, savedAt: null, error: null }; });
const SETTINGS_DEBOUNCE = {};
SETTINGS_BUCKETS.forEach(t => { SETTINGS_DEBOUNCE[t] = null; });

// Search index for Cmd+K palette. elementId takes priority over elementSelector.
const SETTINGS_INDEX = [
  { tab: 'classes', label: 'Default grade goal',    keywords: 'goal threshold target default minimum letter', elementId: 'settings-goal' },
  { tab: 'classes', label: 'Per-class goals',       keywords: 'per class override subject goal',                elementSelector: '[data-per-class-goal]:first-of-type' },
  { tab: 'classes', label: 'Class names',           keywords: 'class names aliases rename short display',        elementSelector: '[data-class-alias]:first-of-type' },
  { tab: 'classes', label: 'Class colors',          keywords: 'class colors palette swatches theme custom',     elementSelector: '[data-class-color]:first-of-type' },
  { tab: 'classes', label: 'Skip classes',          keywords: 'exclude skip omit classes hide',                 elementSelector: '[data-exclude-class]:first-of-type' },
  { tab: 'classes', label: 'Class notes (Trilium)', keywords: 'trilium notes link folder per class search',     elementSelector: '[data-trilium-linked]:first-of-type' },
  { tab: 'data', label: 'Run a refresh now',        keywords: 'scrape run refresh start facts',                 elementId: 'scrape-start-btn' },
  { tab: 'data', label: 'Refresh interval',         keywords: 'auto refresh interval minutes dashboard pull',   elementId: 'settings-refresh-minutes' },
  { tab: 'data', label: 'Automatic scrape toggle',  keywords: 'auto schedule scrape on off enable',             elementId: 'settings-auto-scrape-enabled' },
  { tab: 'data', label: 'Scrape times',             keywords: 'auto schedule time comma separated',            elementId: 'settings-auto-scrape-times' },
  { tab: 'data', label: 'What to rescrape',         keywords: 'period quarter semester year',                   elementId: 'settings-auto-scrape-period' },
  { tab: 'data', label: 'Classes to rescrape',      keywords: 'class id comma list',                            elementId: 'settings-auto-scrape-classes' },
  { tab: 'connections', label: 'AI cloud model',             keywords: 'ai ollama cloud model insights gpt picker',       elementId: 'settings-ollama-model' },
  { tab: 'connections', label: 'Refresh model list',         keywords: 'ollama models refresh reload list',               elementId: 'ollama-models-refresh' },
  { tab: 'connections', label: 'Test AI connection',         keywords: 'test ai model connection verify prompt',          elementId: 'ai-test-btn' },
  { tab: 'connections', label: 'OpenAI API key',             keywords: 'openai api key secret password ai',               elementSelector: '[data-apikey="openai"]' },
  { tab: 'connections', label: 'Ollama API key',             keywords: 'ollama cloud api key secret gpt ai',              elementSelector: '[data-apikey="ollama"]' },
  { tab: 'connections', label: 'FACTS SIS API key',          keywords: 'facts sis api key secret password scraper',       elementSelector: '[data-apikey="facts"]' },
  { tab: 'connections', label: 'Trilium URL',       keywords: 'trilium etapi url notes',                         elementId: 'trilium-url' },
  { tab: 'connections', label: 'Trilium ETAPI token',keywords: 'trilium token etapi notes secret',               elementId: 'trilium-token' },
  { tab: 'connections', label: 'Test Trilium connection', keywords: 'trilium test connection status ping',       elementId: 'trilium-test-btn' },
  { tab: 'updates', label: 'Check for updates',  keywords: 'update git github pull new version installed behind', elementId: 'updates-apply-btn' },
  { tab: 'connections', label: 'Search Trilium notes', keywords: 'search notes trilium folder',                  elementId: 'trilium-search-input' },
  { tab: 'connections', label: 'AI prompts',             keywords: 'ai prompts prompt edit customize system user template question quiz note blooket coach chat insights', elementId: 'ai-prompts-body' },
  { tab: 'connections', label: 'Note quiz question prompt', keywords: 'note quiz generate questions ai prompt author system', elementSelector: '[data-prompt-text="note_quiz_generate"]' },
  { tab: 'connections', label: 'Note quiz user template', keywords: 'note quiz user prompt template notes placeholder', elementSelector: '[data-prompt-text="note_quiz_user"]' },
  { tab: 'connections', label: 'Blooket quiz builder prompt', keywords: 'blooket builder quiz prompt system import', elementSelector: '[data-prompt-text="blooket_system"]' },
  { tab: 'connections', label: 'AI coach chat prompt',  keywords: 'coach chat prompt ai system tone',              elementSelector: '[data-prompt-text="grade_coach_chat"]' },
  { tab: 'connections', label: 'AI coach insights prompt', keywords: 'coach insights prompt ai weekly cards',       elementSelector: '[data-prompt-text="grade_coach_insights"]' },
  { tab: 'email', label: 'Email recipients',       keywords: 'email recipients who gets mail address scope grades assignments', elementId: 'email-recipient-add' },
  { tab: 'email', label: 'Email subject prefix',   keywords: 'email subject prefix grades update title',        elementId: 'settings-email-subject' },
  { tab: 'email', label: 'Email HTML template',    keywords: 'email html template editor variables customize ai', elementId: 'settings-email-html' },
  { tab: 'email', label: 'Email preview',          keywords: 'email preview render scope grades assignments test', elementId: 'email-preview-frame' },
  { tab: 'email', label: 'Send test email',        keywords: 'email test send try sample',                     elementId: 'email-test-btn' },
  { tab: 'email', label: 'Browser notifications',  keywords: 'notifications browser notify scrape blooket set done', elementId: 'settings-notif-enabled' },
  { tab: 'email', label: 'Note quiz notifications', keywords: 'note quiz notify trilium ready daily notes per class', elementId: 'settings-notif-note-quiz' },
  { tab: 'app', label: 'Theme',                keywords: 'theme dark light appearance color',              elementId: 'settings-theme-dark' },
  { tab: 'app', label: 'Levels-based review',  keywords: 'levels mastery proficiency climb spaced',         elementId: 'settings-levels-enabled' },
  { tab: 'app', label: 'Quiz review delay',    keywords: 'quiz delay wrong answer seconds wait',            elementId: 'settings-quiz-delay' },
  { tab: 'app', label: 'Project README',       keywords: 'readme markdown project docs documentation about copy expand modal view', elementId: 'readme-copy-btn' },
  { tab: 'app', label: 'Data year',            keywords: 'display year academic previous archive switch grades history term', elementId: 'settings-display-year' },
  { tab: 'account', label: 'Account picture',         keywords: 'profile picture avatar photo upload image',      elementId: 'settings-profile-file' },
  { tab: 'account', label: 'Display name',            keywords: 'name display show user your full first',          elementId: 'settings-user-name' },
  { tab: 'account', label: 'Position',                keywords: 'position title role student teacher parent job', elementId: 'settings-user-position' },
  { tab: 'account', label: 'Update login credentials', keywords: 'update save credentials password username',    elementId: 'settings-auth-save-btn' },
];

// Collapsible settings panels (accordions). module-scope so re-renders keep them open.
const SETTINGS_PANELS = {
  pc_goals: false,    // Per-class goals (closed by default like the others)
  pc_names: false,
  pc_colors: false,   // Visual customization (changed rarely)
  pc_skip: false,
  pc_notes: false,    // Per-class Trilium linking
  conn_keys: true,    // API keys (user often needs to set these)
  conn_trilium: false,
  ds_refresh: false,  // Run a refresh now (action, not config)
  email_recipients: true,  // Who gets the email + what they get
  email_template: false,   // HTML editor (big; collapsed by default)
  gen_theme: true,
  gen_reviews: false,  // Levels + Quiz delay (rarely changed)
  gen_about: false,
  account_profile: true, // Profile picture + display name + position (set on first use)
  account_creds: false,
  account_signout: false,
};

// Accordions gated by a master toggle that lives in the accordion header.
// Open state is derived from the toggle: on → open, off → closed.
// The toggle keeps its original element id so save/collect + palette keep working.
const SETTINGS_TOGGLE_PANELS = {
  ds_scrape: {
    switchId: 'settings-auto-scrape-enabled',
    saveTab: 'data',
    get: () => !!state.autoScrape?.enabled,
    set: (on) => { state.autoScrape = { ...(state.autoScrape || {}), enabled: on }; },
  },
  email_notifications: {
    switchId: 'settings-notif-enabled',
    saveTab: 'general',
    get: () => !!state.notifications?.enabled,
    set: (on) => { state.notifications = { ...(state.notifications || {}), enabled: on }; },
  },
};

function panelOpen(id) {
  const tp = SETTINGS_TOGGLE_PANELS[id];
  if (tp) return tp.get();
  return SETTINGS_PANELS[id] === true;
}
function setPanelOpenUI(id, open) {
  const panel = document.querySelector(`[data-panel="${id}"]`);
  if (!panel) return;
  panel.classList.toggle('collapsed', !open);
  const trigger = panel.parentElement?.querySelector('.accordion-trigger');
  if (trigger) {
    trigger.setAttribute('aria-expanded', String(open));
    const chev = trigger.querySelector('.chevron-icon');
    if (chev) chev.classList.toggle('rotate-180', open);
  }
}

window.onTogglePanelSwitch = function(id, cb) {
  const tp = SETTINGS_TOGGLE_PANELS[id];
  if (!tp) return;
  if (id === 'email_notifications') {
    onNotifMasterToggle(cb);   // handles browser-permission gating
  } else {
    tp.set(cb.checked);
    scheduleSettingsSave(tp.saveTab);
  }
  const on = tp.get();
  if (cb) cb.checked = on;     // reflect any veto (e.g. permission denied)
  setPanelOpenUI(id, on);
};

window.toggleSettingsPanel = function(id) {
  const tp = SETTINGS_TOGGLE_PANELS[id];
  if (tp) {
    const cb = document.getElementById(tp.switchId);
    if (cb) {
      cb.checked = !tp.get();
      onTogglePanelSwitch(id, cb);
    }
    return;
  }
  const wasOpen = panelOpen(id);
  SETTINGS_PANELS[id] = !wasOpen;
  setPanelOpenUI(id, !wasOpen);
};

function settingsAccordion(id, iconName, iconColor, title, summary, bodyHtml, extra) {
  const tp = SETTINGS_TOGGLE_PANELS[id];
  const open = panelOpen(id);

  const titleBlock = `
      <div class="flex items-center gap-3 min-w-0">
        <span class="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style="background:${iconColor}1a;color:${iconColor}">${icon(iconName,'w-4 h-4')}</span>
        <div class="min-w-0">
          <div class="text-sm font-semibold text-gray-200">${title}</div>
          <div class="text-xs text-gray-500 truncate mt-0.5">${summary}</div>
        </div>
      </div>`;

  const rightControls = `
      <div class="flex items-center gap-2 flex-shrink-0">
        ${extra || ''}
        ${tp ? `
        <label class="switch" title="${tp.get() ? 'On' : 'Off'}">
          <input id="${tp.switchId}" type="checkbox" ${tp.get() ? 'checked' : ''} onchange="onTogglePanelSwitch('${id}', this)">
          <span class="track"><span class="thumb"></span></span>
        </label>` : ''}
        ${tp
          ? `<button type="button" onclick="toggleSettingsPanel('${id}')" aria-label="Toggle" class="flex items-center justify-center text-gray-500 hover:text-gray-300 transition-colors"><span class="chevron-icon ${open ? 'rotate-180' : ''}">${icon('chevronDown','w-4 h-4')}</span></button>`
          : `<span class="chevron-icon text-gray-500 ${open ? 'rotate-180' : ''}">${icon('chevronDown','w-4 h-4')}</span>`}
      </div>`;

  const header = tp
    ? `
    <div class="accordion-trigger w-full flex items-center justify-between gap-3 p-4 hover:bg-[#16161f]" aria-expanded="${open}">
      <button type="button" onclick="toggleSettingsPanel('${id}')" class="flex items-center gap-3 min-w-0 flex-1 text-left bg-transparent">${titleBlock}</button>
      ${rightControls}
    </div>`
    : `
    <button type="button" onclick="toggleSettingsPanel('${id}')" aria-expanded="${open}" class="accordion-trigger w-full flex items-center justify-between gap-3 p-4 hover:bg-[#16161f] text-left">
      ${titleBlock}
      ${rightControls}
    </button>`;

  return `
  <div class="bg-[#12121b] border border-[#22222e] rounded-2xl mb-4 overflow-hidden">
    ${header}
    <div data-panel="${id}" class="panel-grid ${open ? '' : 'collapsed'}">
      <div class="panel-content px-4 pb-4">${bodyHtml}</div>
    </div>
  </div>`;
}

window.syncRangeNum = function(rangeId, numId) {
  const r = document.getElementById(rangeId), n = document.getElementById(numId);
  if (r && n) n.value = r.value;
};
window.syncNumRange = function(rangeId, numId, min, max) {
  const r = document.getElementById(rangeId), n = document.getElementById(numId);
  if (!r || !n) return;
  let v = parseFloat(n.value);
  if (isNaN(v)) v = parseFloat(r.value);
  if (isNaN(v)) return;
  v = Math.min(max, Math.max(min, v));
  n.value = v;
  r.value = v;
};

// Cmd+K binding for settings palette (registered once after blooket-create loads).
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K') && state.currentView === 'settings' && !document.getElementById('settings-palette-overlay')) {
    e.preventDefault();
    openSettingsPalette();
  } else if (e.key === 'Escape' && document.getElementById('settings-palette-overlay')) {
    closeSettingsPalette();
  }
});

function openSettingsPalette() {
  if (document.getElementById('settings-palette-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'settings-palette-overlay';
  overlay.className = 'fixed inset-0 z-[60] flex items-start justify-center pt-[14vh] px-4';
  overlay.style.cssText = 'background:rgba(0,0,0,0.65);backdrop-filter:blur(6px);';
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) closeSettingsPalette(); });
  overlay.innerHTML = `
    <div class="bg-[#12121b] border border-[#2a2a38] rounded-2xl shadow-2xl w-full max-w-xl overflow-hidden" onclick="event.stopPropagation()">
      <div class="flex items-center gap-2 px-4 py-3 border-b border-[#22222e]">
        <span class="text-gray-500 flex-shrink-0">${icon('search','w-4 h-4')}</span>
        <input id="settings-palette-input" type="text" placeholder="Jump to any setting…"
          autocomplete="off" spellcheck="false"
          class="flex-1 bg-transparent text-sm text-white placeholder-gray-500 focus:outline-none">
        <span class="text-[10px] text-gray-500 font-mono">esc</span>
      </div>
      <div id="settings-palette-list" class="max-h-80 overflow-y-auto py-1"></div>
      <div class="px-4 py-2 border-t border-[#22222e] text-[10px] text-gray-500 flex items-center justify-between">
        <span><kbd class="font-mono">↑</kbd> <kbd class="font-mono">↓</kbd> navigate · <kbd class="font-mono">↵</kbd> open</span>
        <span>${SETTINGS_INDEX.length} settings</span>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const inp = document.getElementById('settings-palette-input');
  inp.addEventListener('input', () => renderSettingsPalette(inp.value));
  inp.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { closeSettingsPalette(); return; }
    const items = document.querySelectorAll('#settings-palette-list [data-palette-item]');
    const active = document.querySelector('#settings-palette-list [data-palette-item].palette-active');
    let idx = Array.from(items).indexOf(active);
    if (ev.key === 'ArrowDown') { idx = Math.min(items.length - 1, idx + 1); ev.preventDefault(); }
    else if (ev.key === 'ArrowUp')   { idx = Math.max(0, idx - 1); ev.preventDefault(); }
    else if (ev.key === 'Enter')     { if (active) { ev.preventDefault(); active.click(); } return; }
    items.forEach((it, i) => it.classList.toggle('palette-active', i === idx));
    if (items[idx]) items[idx].scrollIntoView({ block: 'nearest' });
  });
  setTimeout(() => inp?.focus(), 30);
  renderSettingsPalette('');
}
window.openSettingsPalette = openSettingsPalette;
function closeSettingsPalette() {
  const o = document.getElementById('settings-palette-overlay');
  if (o) o.remove();
}
window.closeSettingsPalette = closeSettingsPalette;

function renderSettingsPalette(query) {
  const list = document.getElementById('settings-palette-list');
  if (!list) return;
  const q = (query || '').trim().toLowerCase();
  const items = q
    ? SETTINGS_INDEX.map(it => {
        const tabLabel = SETTINGS_SECTIONS.find(t => t.id === it.tab)?.label || it.tab;
        const hay = (it.label + ' ' + it.keywords + ' ' + tabLabel).toLowerCase();
        const score = (hay.includes(q) ? 2 : 0)
          + (it.label.toLowerCase().startsWith(q) ? 3 : 0)
          + (it.label.toLowerCase().split(/\s+/).some(w => w.startsWith(q)) ? 2 : 0);
        return { it, score };
      }).filter(r => r.score > 0).sort((a, b) => b.score - a.score).map(r => r.it)
    : SETTINGS_INDEX;
  if (!items.length) {
    list.innerHTML = `<div class="px-4 py-8 text-center text-sm text-gray-500">No settings match "${escapeHtml(query)}".</div>`;
    return;
  }
  list.innerHTML = items.map((it, i) => {
    const tab = SETTINGS_SECTIONS.find(t => t.id === it.tab);
    const sel = it.elementSelector ? it.elementSelector.replace(/'/g, "\\'") : '';
    const eid = it.elementId ? `'${it.elementId}'` : 'null';
    const es = sel ? `'${sel}'` : 'null';
    return `<button type="button" data-palette-item class="w-full flex items-center gap-3 px-4 py-2.5 text-left ${i === 0 ? 'palette-active bg-blue-500/10' : 'hover:bg-[#16161f]'}"
        onclick="closeSettingsPalette(); setTimeout(()=>jumpPaletteItem('${it.tab}', ${eid}, ${es}),30)">
        <span class="text-blue-400 flex-shrink-0">${icon(tab.icon, 'w-3.5 h-3.5')}</span>
        <span class="flex-1 min-w-0">
          <span class="block text-sm text-gray-200 truncate">${escapeHtml(it.label)}</span>
          <span class="block text-[10px] text-gray-500 truncate">${escapeHtml(tab.label)}</span>
        </span>
        <span class="text-gray-600 flex-shrink-0">${icon('chevronRight','w-3.5 h-3.5')}</span>
      </button>`;
  }).join('');
}

function jumpPaletteItem(tab, elementId, elementSelector) {
  const viewChanged = state.settingsView !== tab;
  if (viewChanged) { openSettingsSection(tab); }

  const resolveEl = () => elementId
    ? document.getElementById(elementId)
    : (elementSelector ? document.querySelector(elementSelector) : null);

  // Retry briefly so async-loaded sections (e.g. the AI prompt cards, which
  // appear after /api/prompts resolves) still get scrolled and flashed.
  const MAX_ATTEMPTS = 12;
  let attempts = 0;

  const doJump = () => {
    const el0 = resolveEl();
    if (!el0) {
      if (++attempts <= MAX_ATTEMPTS) setTimeout(doJump, 150);
      return;
    }
    let panelStateChanged = false;
    const panel = el0.closest ? el0.closest('[data-panel]') : null;
    if (panel) {
      const pid = panel.getAttribute('data-panel');
      if (!SETTINGS_TOGGLE_PANELS[pid] && SETTINGS_PANELS[pid] !== true) {
        SETTINGS_PANELS[pid] = true;
        setPanelOpenUI(pid, true);
        panelStateChanged = true;
      }
    }
    const delay = panelStateChanged ? 290 : (viewChanged ? 80 : 60);
    setTimeout(() => {
      const el = resolveEl();
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        try { el.focus({ preventScroll: true }); } catch (_) {}
        flashElement(el);
      }
    }, delay);
  };

  setTimeout(doJump, 30);
}
window.jumpPaletteItem = jumpPaletteItem;

function flashElement(el) {
  const orig = el.style.transition;
  el.style.transition = 'box-shadow 800ms ease-out, border-color 800ms ease-out';
  el.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.55)';
  el.style.borderColor = 'rgba(59,130,246,0.7)';
  setTimeout(() => {
    el.style.boxShadow = '';
    el.style.borderColor = '';
    el.style.transition = orig;
  }, 1200);
}
window.flashElement = flashElement;

function openSettingsSection(sec) {
  if (state.settingsView === sec) return;
  state.settingsView = sec;
  render();
  // Refresh any in-flight status text after re-render (e.g. "Saved 2m ago")
  SETTINGS_BUCKETS.forEach(b => updateSectionStatus(b));
  // Always force a fresh update-check when opening the Updates panel so the
  // user never sees a stale "Latest on GitHub" value.
  if (sec === 'updates' && typeof checkForUpdate === 'function') {
    checkForUpdate(true).then(() => render());
  }
}
window.openSettingsSection = openSettingsSection;

function showSettingsHome() {
  if (state.settingsView === 'home') return;
  state.settingsView = 'home';
  render();
}
window.showSettingsHome = showSettingsHome;

// Compatibility shim: legacy callers passed old tab ids (general/data/connections/account).
const SETTINGS_LEGACY_MAP = { general: 'classes', data: 'data', connections: 'connections', account: 'account' };
function switchSettingsTab(tab) {
  openSettingsSection(SETTINGS_LEGACY_MAP[tab] || tab);
}
window.switchSettingsTab = switchSettingsTab;

// Collect every field on the open settings panels into the canonical payload.
function collectSettingsFromDOM() {
  const goalEl = document.getElementById('settings-goal');
  const goal = goalEl ? Math.max(50, Math.min(100, parseInt(goalEl.value, 10) || 90)) : (state.goal || 90);

  const perClassGoals = {};
  document.querySelectorAll('[data-per-class-goal]').forEach(i => {
    const v = parseInt(i.value, 10);
    if (!isNaN(v) && v >= 1 && v <= 100) perClassGoals[i.dataset.perClassGoal] = v;
  });

  const classAliases = {};
  document.querySelectorAll('[data-class-alias]').forEach(i => {
    const v = (i.value || '').trim();
    if (v) classAliases[i.dataset.classAlias] = v;
  });

  const classColors = { ...(state.classColors || {}) };

  const excludedClassIds = [];
  document.querySelectorAll('[data-exclude-class]').forEach(cb => { if (cb.checked) excludedClassIds.push(cb.value); });

  const apiKeys = { ...(state.apiKeys || {}) };
  document.querySelectorAll('[data-apikey]').forEach(i => {
    const v = (i.value || '').trim();
    if (v && !v.startsWith('••')) apiKeys[i.dataset.apikey] = v;
  });

  const ollamaEl = document.getElementById('settings-ollama-model');
  const ollamaModel = (ollamaEl?.value || 'gpt-oss:120b').trim() || 'gpt-oss:120b';

  const refreshEl = document.getElementById('settings-refresh-minutes');
  const autoRefreshMinutes = Math.max(1, parseInt(refreshEl?.value, 10) || 5);

  const quizDelayEl = document.getElementById('settings-quiz-delay');
  const quizDelay = Math.min(30, Math.max(0, parseFloat(quizDelayEl?.value) || 0));

  const levelsEnabled = !!document.getElementById('settings-levels-enabled')?.checked;

  const autoScrape = {
    enabled: !!document.getElementById('settings-auto-scrape-enabled')?.checked,
    times: document.getElementById('settings-auto-scrape-times')?.value.trim() || '07:00',
    period: document.getElementById('settings-auto-scrape-period')?.value || 'all',
    classes: document.getElementById('settings-auto-scrape-classes')?.value.trim() || 'all',
  };

  const trilium = { url: state.trilium?.url || '', token: state.trilium?.token || '', notes: state.trilium?.notes || {} };
  const triliumUrl = document.getElementById('trilium-url')?.value.trim();
  const triliumToken = document.getElementById('trilium-token')?.value.trim();
  if (triliumUrl) trilium.url = triliumUrl;
  if (triliumToken && !triliumToken.startsWith('••')) trilium.token = triliumToken;

  const email = { recipients: [], subjectPrefix: (state.email?.subjectPrefix || 'Grades Update') };
  document.querySelectorAll('[data-recipient-email]').forEach(i => {
    const addr = (i.value || '').trim();
    if (!addr) return;
    const row = i.closest('[data-recipient-row]');
    const scopeEl = row?.querySelector('[data-recipient-scope]');
    const scope = scopeEl?.value || 'both';
    email.recipients.push({ email: addr, scope });
  });
  const subjectEl = document.getElementById('settings-email-subject');
  if (subjectEl) email.subjectPrefix = subjectEl.value.trim() || 'Grades Update';
  const emailHtml = (document.getElementById('settings-email-html')?.value ?? state.emailHtml) || '';

  const schedEnabledEl = document.getElementById('settings-email-schedule-enabled');
  const schedTimesEl = document.getElementById('settings-email-schedule-times');
  const prevSchedule = (state.email && state.email.schedule) || {};
  email.schedule = {
    enabled: schedEnabledEl ? !!schedEnabledEl.checked : (prevSchedule.enabled !== false),
    times: schedTimesEl ? (schedTimesEl.value || '').split(',').map(s => s.trim()).filter(Boolean).join(', ') || '07:05, 16:00'
      : ((Array.isArray(prevSchedule.times) ? prevSchedule.times.join(', ') : prevSchedule.times) || '07:05, 16:00'),
  };

  const notifications = {
    enabled: !!document.getElementById('settings-notif-enabled')?.checked,
    scrapeDone: !!document.getElementById('settings-notif-scrape')?.checked,
    blooketDone: !!document.getElementById('settings-notif-blooket')?.checked,
    noteQuizReady: document.getElementById('settings-notif-note-quiz') ? !!document.getElementById('settings-notif-note-quiz').checked : (state.notifications?.noteQuizReady !== false),
  };

  const displayYear = document.getElementById('settings-display-year')?.value || '';

  // Read note-quiz toggles from the DOM (per-class) into a structured payload.
  // Mirrors state.noteQuiz.classes so the saved file stays canonical.
  // AI prompt overrides (only present while the Connections tab is rendered).
  // Merge with existing state so saving another section doesn't drop them.
  const prompts = { ...(state.prompts || {}) };
  document.querySelectorAll('[data-prompt-text]').forEach(ta => {
    const key = ta.getAttribute('data-prompt-text');
    if (!key) return;
    if (ta.dataset.promptReset) { prompts[key] = ''; return; }
    const v = (ta.value || '').trim();
    prompts[key] = v;
  });

  const noteQuizClasses = {};
  document.querySelectorAll('[data-note-quiz-card]').forEach(card => {
    const cid = card.dataset.noteQuizCard;
    if (!cid) return;
    const enabledEl = card.querySelector(`[data-note-quiz-enabled="${cid}"]`);
    const minEl = card.querySelector(`[data-note-quiz-min="${cid}"]`);
    const nEl = card.querySelector(`[data-note-quiz-notify="${cid}"]`);
    const startEl = card.querySelector(`[data-note-quiz-start="${cid}"]`);
    const endEl = card.querySelector(`[data-note-quiz-end="${cid}"]`);
    const dayBtns = card.querySelectorAll(`[data-note-quiz-day="${cid}"]`);
    const days = [];
    dayBtns.forEach(btn => {
      // Active chip styling implies it's toggled on.
      if (btn.className.includes('bg-blue-500')) {
        const d = parseInt(btn.dataset.day, 10);
        if (Number.isInteger(d)) days.push(d);
      }
    });
    noteQuizClasses[cid] = {
      enabled: !!(enabledEl && enabledEl.checked),
      minLines: Math.max(1, parseInt(minEl?.value, 10) || 3),
      notify: !!(nEl && nEl.checked),
      startTime: (startEl?.value || '').trim(),
      endTime: (endEl?.value || '').trim(),
      weekdays: days.length ? days.sort((a, b) => a - b) : [0, 1, 2, 3, 4],
    };
  });

  return {
    goal, perClassGoals, classAliases, classColors, excludedClassIds,
    apiKeys, ollamaModel, theme: state.theme || 'dark',
    autoRefreshMinutes, quizDelay, levelsEnabled, autoScrape, trilium,
    email, emailHtml, notifications, displayYear, prompts,
    noteQuiz: { classes: noteQuizClasses },
    userName: document.getElementById('settings-user-name')?.value || state.userName || '',
    userPosition: document.getElementById('settings-user-position')?.value || state.userPosition || '',
    profilePicture: state.profilePicture || '',
  };
}

function scheduleSettingsSave(tab) {
  SETTINGS_STATUS[tab].dirty = true;
  if (SETTINGS_DEBOUNCE[tab]) clearTimeout(SETTINGS_DEBOUNCE[tab]);
  SETTINGS_DEBOUNCE[tab] = setTimeout(() => saveSettingsSection(tab), 700);
  updateSectionStatus(tab);
}
window.scheduleSettingsSave = scheduleSettingsSave;

function refreshColorSwatches(classId) {
  const cur = (state.classColors || {})[classId];
  document.querySelectorAll(`[data-class-color="${classId}"]`).forEach(b => {
    const isSel = !!(cur && CLASS_COLOR_SETS[Number(b.dataset.colorSet)] && cur.dark === CLASS_COLOR_SETS[Number(b.dataset.colorSet)].dark);
    b.classList.toggle('color-sel', isSel);
  });
  const reset = document.querySelector(`[data-class-color-reset="${classId}"]`);
  if (reset) {
    reset.classList.toggle('color-sel', !cur);
    reset.classList.toggle('opacity-40', !!cur);
    reset.classList.toggle('hover:opacity-100', !!cur);
  }
  const dot = document.querySelector(`[data-class-color-dot="${classId}"]`);
  if (dot) dot.style.background = classColorFor(classId);
}

window.setClassColor = function(classId, idx) {
  const s = CLASS_COLOR_SETS[idx];
  state.classColors = state.classColors || {};
  state.classColors[classId] = { dark: s.dark, light: s.light };
  refreshColorSwatches(classId);
  scheduleSettingsSave('general');
};

window.setClassColorDefault = function(classId) {
  state.classColors = state.classColors || {};
  delete state.classColors[classId];
  refreshColorSwatches(classId);
  scheduleSettingsSave('general');
};

async function saveSettingsSection(tab) {
  SETTINGS_DEBOUNCE[tab] = null;
  SETTINGS_STATUS[tab].dirty = false;
  SETTINGS_STATUS[tab].saving = true;
  SETTINGS_STATUS[tab].error = null;
  updateSectionStatus(tab);
  const prevYear = state.displayYear || '';
  try {
    const payload = collectSettingsFromDOM();
    payload.updated = new Date().toISOString();
    const ok = await saveSettings(payload);
    if (!ok) throw new Error('Save returned false');
    SETTINGS_STATUS[tab].saving = false;
    SETTINGS_STATUS[tab].savedAt = Date.now();
    state.goal = payload.goal;
    state.perClassGoals = payload.perClassGoals;
    state.classAliases = payload.classAliases;
    state.classColors = payload.classColors || {};
    state.excludedClassIds = payload.excludedClassIds;
    state.apiKeys = payload.apiKeys;
    state.autoRefreshMinutes = payload.autoRefreshMinutes;
    state.quizDelay = payload.quizDelay;
    state.levelsEnabled = payload.levelsEnabled;
    state.autoScrape = payload.autoScrape;
    state.trilium = payload.trilium;
    state.email = payload.email || state.email;
    state.emailHtml = typeof payload.emailHtml === 'string' ? payload.emailHtml : (state.emailHtml || '');
    state.notifications = payload.notifications || state.notifications;
    state.noteQuiz = { classes: (payload.noteQuiz && payload.noteQuiz.classes) || {} };
    if (payload.prompts && typeof payload.prompts === 'object') state.prompts = payload.prompts;
    state.displayYear = payload.displayYear || '';
    renderAiPromptsBody();
    if (typeof payload.userName === 'string') state.userName = payload.userName;
    if (typeof payload.userPosition === 'string') state.userPosition = payload.userPosition;
    if (typeof payload.profilePicture === 'string') {
      state.profilePicture = payload.profilePicture;
      updateSidebarUserInfo();
    }
    try { scheduleAutoRefresh(); } catch (_) {}
    if ((state.displayYear || '') !== prevYear) {
      try { await fetchComputed(); } catch (_) {}
    }
  } catch (err) {
    SETTINGS_STATUS[tab].saving = false;
    SETTINGS_STATUS[tab].error = err.message || 'Save failed';
  }
  updateSectionStatus(tab);
}
window.saveSettingsSection = saveSettingsSection;

function updateSectionStatus(tab) {
  const el = document.getElementById(`section-status-${tab}`);
  if (!el) return;
  const s = SETTINGS_STATUS[tab];
  if (s.saving) {
    el.innerHTML = `<span class="inline-flex items-center gap-1.5 text-blue-400"><span class="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse"></span>Saving…</span>`;
  } else if (s.error) {
    el.innerHTML = `<span class="inline-flex items-center gap-1.5 text-red-400"><span class="w-1.5 h-1.5 rounded-full bg-red-400"></span>Save failed</span>`;
  } else if (s.dirty) {
    el.innerHTML = `<span class="inline-flex items-center gap-1.5 text-amber-400"><span class="w-1.5 h-1.5 rounded-full bg-amber-400"></span>Unsaved</span>`;
  } else if (s.savedAt) {
    const ago = Math.floor((Date.now() - s.savedAt) / 1000);
    const text = ago < 5 ? 'Saved' : ago < 60 ? `Saved ${ago}s ago` : `Saved ${Math.floor(ago/60)}m ago`;
    el.innerHTML = `<span class="inline-flex items-center gap-1.5 text-green-400"><span class="w-1.5 h-1.5 rounded-full bg-green-400"></span>${text}</span>`;
  } else {
    el.innerHTML = '';
  }
}

// --- Settings shell (landing page + full-page sections) ---
const SETTINGS_SECTION_RENDER = {
  account:     { fn: () => renderSettingsAccount(),              panelId: 'settings-panel-account' },
  classes:     { fn: () => renderSettingsClasses(),              panelId: 'settings-panel-classes' },
  email:       { fn: () => renderSettingsEmail(),                panelId: 'settings-panel-email' },
  data:        { fn: () => renderSettingsData(),                 panelId: 'settings-panel-data' },
  connections: { fn: () => renderSettingsConnectionsAndAi(),     panelId: 'settings-panel-connections' },
  updates:     { fn: () => renderSettingsUpdates(),              panelId: 'settings-panel-updates' },
  app:         { fn: () => renderSettingsApp(),                  panelId: 'settings-panel-app' },
};

function renderSettings() {
  // Lazy initializers for async-backed panels, only for the section actually on
  // screen. Panels stay mounted (hidden) so previously-initialized ones persist.
  const activeView = state.settingsView || 'home';
  if (activeView === 'connections') { setTimeout(loadOllamaModels, 60); setTimeout(loadPromptsMeta, 60); }
  if (activeView === 'email') setTimeout(initEmailSettingsTab, 60);
  if (activeView === 'app') setTimeout(initReadmeTab, 60);

  const themeMode = state.theme || 'dark';
  const inSection = activeView !== 'home';
  const active = SETTINGS_SECTIONS.find(s => s.id === activeView);
  const backArrow = inSection
    ? `<button onclick="showSettingsHome()" class="w-9 h-9 rounded-xl bg-[#12121b] border border-[#22222e] flex items-center justify-center text-gray-400 hover:text-white hover:border-blue-500/30 transition-colors flex-shrink-0" title="All settings">${icon('chevronLeft','w-5 h-5')}</button>`
    : `<button onclick="closeSettings()" class="w-9 h-9 rounded-xl bg-[#12121b] border border-[#22222e] flex items-center justify-center text-gray-400 hover:text-white hover:border-blue-500/30 transition-colors flex-shrink-0" title="Back">${icon('chevronLeft','w-5 h-5')}</button>`;

  const heading = inSection
    ? `<h1 class="text-2xl font-bold text-white">${active.label}</h1>`
    : `<h1 class="text-2xl font-bold text-white">Settings</h1>`;
  const sub = inSection
    ? `<p class="text-gray-400 mt-1 text-sm">${active.desc} Autosaves as you adjust.</p>`
    : `<p class="text-gray-400 mt-1 text-sm">Stored on the app server — applied across every view. Pick a section to get started.</p>`;

  const homeView = activeView === 'home' ? `
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
      ${SETTINGS_SECTIONS.map(s => `
        <button type="button" onclick="openSettingsSection('${s.id}')"
          class="group text-left bg-[#12121b] border border-[#22222e] rounded-2xl p-5 hover:border-blue-500/30 hover:bg-[#16161f] transition-all flex flex-col gap-3">
          <span class="w-11 h-11 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400 flex-shrink-0">${icon(s.icon,'w-5 h-5')}</span>
          <span class="min-w-0">
            <span class="flex items-center justify-between gap-2">
              <span class="text-sm font-semibold text-gray-100">${s.label}</span>
              <span class="text-gray-500 group-hover:text-blue-400 transition-colors flex-shrink-0">${icon('chevronRight','w-4 h-4')}</span>
            </span>
            <span class="block text-xs text-gray-500 mt-1 leading-relaxed">${s.desc}</span>
          </span>
        </button>`).join('')}
    </div>` : '';

  const panels = SETTINGS_SECTIONS.map(s => `
    <section id="${SETTINGS_SECTION_RENDER[s.id].panelId}" ${s.id === activeView ? '' : 'hidden'}>
      ${SETTINGS_SECTION_RENDER[s.id].fn()}
    </section>`).join('');

  return `
  <div class="flex items-center justify-between gap-3 mb-6">
    <div class="flex items-center gap-3 min-w-0">
      ${backArrow}
      <div class="min-w-0">
        ${heading}
        ${sub}
      </div>
    </div>
    <div class="flex items-center gap-2 flex-shrink-0">
      ${inSection ? `<div id="section-status-${active.bucket}" class="flex-shrink-0"></div>` : ''}
      <div class="inline-flex items-center gap-1 bg-[#12121b] border border-[#22222e] rounded-xl p-1" title="Theme">
        <button type="button" data-theme-choice="dark" onclick="setThemeMode('dark'); scheduleSettingsSave('general')" class="px-2.5 py-1.5 rounded-lg text-xs font-medium text-gray-400 hover:text-gray-200 transition-colors ${themeMode === 'dark' ? 'bg-blue-500/15 text-blue-300' : ''}">Dark</button>
        <button type="button" data-theme-choice="light" onclick="setThemeMode('light'); scheduleSettingsSave('general')" class="px-2.5 py-1.5 rounded-lg text-xs font-medium text-gray-400 hover:text-gray-200 transition-colors ${themeMode === 'light' ? 'bg-blue-500/15 text-blue-300' : ''}">Light</button>
      </div>
      <button onclick="openSettingsPalette()" class="flex items-center gap-2 bg-[#12121b] border border-[#22222e] rounded-xl px-3 py-2 text-xs text-gray-300 hover:text-white hover:border-blue-500/30 transition-colors">
        ${icon('search','w-3.5 h-3.5')} Search
        <kbd class="font-mono text-[10px] bg-[#0a0a0f] border border-[#22222e] rounded px-1.5 py-0.5 ml-1">⌘K</kbd>
      </button>
    </div>
  </div>

  ${inSection ? `<div class="max-w-3xl hidden">${homeView}</div>` : homeView}
  <div class="max-w-3xl">${panels}</div>
  `;
}


// --- Classes ---
function renderSettingsClasses() {
  const d = state.computed;
  const classes = (d?.activeClasses || []).filter(c => c.isAcademic);
  const goal = state.goal || 90;
  const perClass = state.perClassGoals || {};
  const excluded = new Set(state.excludedClassIds || []);
  const aliases = state.classAliases || {};
  const colors = state.classColors || {};
  const countSet = obj => Object.keys(obj).filter(k => classes.some(c => String(c.id) === String(k))).length;
  const pill = (n, label) => n > 0
    ? `<span class="text-[10px] px-1.5 py-0.5 rounded-md bg-blue-500/15 text-blue-300 font-medium">${n} ${label}</span>`
    : '';

  const goalBody = `
    <div class="flex justify-end mb-2">
      <button type="button" onclick="clearPerClassGoals()" class="text-xs text-gray-500 hover:text-gray-300 transition-colors">Clear all</button>
    </div>
    <div class="space-y-2">
      ${classes.map(c => {
        const cur = perClass[c.id];
        const grade = c.weightedGrade;
        const effGoal = cur != null ? cur : goal;
        const gColor = grade == null ? '#6c6c7c'
          : grade >= effGoal + 1 ? '#22c55e'
          : grade >= effGoal     ? '#eab308'
          : grade >= 70          ? '#f97316'
          :                          '#ef4444';
        return `<div class="flex items-center gap-3 p-2.5 bg-[#0a0a0f] border border-[#22222e] rounded-xl">
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <span class="w-3 h-3 rounded-full flex-shrink-0" style="background:${classColorFor(c.id)}"></span>
              <span class="text-sm text-gray-200 truncate">${escapeHtml(c.shortName || c.name)}</span>
            </div>
            <div class="text-xs text-gray-500">Current <span style="color:${gColor}" class="font-medium">${grade != null ? grade + '% (' + letterGrade(grade) + ')' : 'N/A'}</span> · Goal ${effGoal}%</div>
          </div>
          <div class="flex items-center gap-2 flex-shrink-0">
            <input type="range" data-per-class-goal-range="${c.id}" min="50" max="100" step="1" value="${effGoal}"
              oninput="syncRangeNum('pcgn-${c.id}','pcgn-${c.id}'); scheduleSettingsSave('general')"
              class="w-36 h-1.5 bg-[#1c1c26] rounded-full appearance-none cursor-pointer accent-blue-500">
            <input type="number" id="pcgn-${c.id}" data-per-class-goal="${c.id}" min="50" max="100" step="1" placeholder="${goal}" value="${cur != null ? cur : ''}"
              oninput="syncNumRange('pcgn-${c.id}','pcgn-${c.id}',50,100); scheduleSettingsSave('general')"
              class="w-16 px-2 py-1.5 bg-[#12121b] border border-[#22222e] rounded-lg text-sm text-gray-200 text-right placeholder-gray-600 tabular-nums">
          </div>
        </div>`;
      }).join('')}
    </div>`;

  const namesBody = `
    <div class="flex justify-end mb-2">
      <button type="button" onclick="document.querySelectorAll('[data-class-alias]').forEach(i=>i.value=''); scheduleSettingsSave('general')" class="text-xs text-gray-500 hover:text-gray-300 transition-colors">Reset all</button>
    </div>
    <div class="space-y-2">
      ${classes.map(c => {
        const alias = aliases[c.id] || '';
        return `<div class="flex items-center gap-3 p-2.5 bg-[#0a0a0f] border border-[#22222e] rounded-xl">
          <div class="flex-1 min-w-0">
            <div class="text-sm text-gray-200 truncate">${escapeHtml(c.shortName || c.name)}</div>
            <div class="text-xs text-gray-500 truncate">${escapeHtml(c.name)}</div>
          </div>
          <input type="text" data-class-alias="${c.id}" value="${escapeHtml(alias)}" placeholder="${escapeHtml(c.shortName || c.name)}" maxlength="40"
            oninput="scheduleSettingsSave('general')"
            class="w-44 px-2 py-1.5 bg-[#12121b] border border-[#22222e] rounded-lg text-sm text-gray-200 placeholder-gray-600">
        </div>`;
      }).join('')}
    </div>`;

  const colorsBody = `
    <div class="flex justify-end mb-2">
      <button type="button" onclick="document.querySelectorAll('[data-class-color-reset]').forEach(b=>window.setClassColorDefault(b.dataset.classColorReset))" class="text-xs text-gray-500 hover:text-gray-300 transition-colors">Reset all</button>
    </div>
    <div class="space-y-2">
      ${classes.map(c => {
        const cur = colors[c.id];
        const dfltIdx = classes.indexOf(c);
        const defDark = CLASS_COLOR_SETS[dfltIdx % CLASS_COLOR_SETS.length].dark;
        const defLight = CLASS_COLOR_SETS[dfltIdx % CLASS_COLOR_SETS.length].light;
        return `<div class="flex items-center gap-3 p-2.5 bg-[#0a0a0f] border border-[#22222e] rounded-xl">
          <div class="w-32 min-w-0 flex-shrink-0">
            <div class="flex items-center gap-2">
              <span class="w-3 h-3 rounded-full flex-shrink-0" data-class-color-dot="${c.id}" style="background:${classColorFor(c.id)}"></span>
              <span class="text-sm text-gray-200 truncate">${escapeHtml(c.shortName || c.name)}</span>
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-1.5 flex-1">
            <button type="button" data-class-color-reset="${c.id}" onclick="setClassColorDefault('${c.id}')" title="Default"
              class="w-7 h-7 rounded-full cursor-pointer transition-all hover:scale-110 flex-shrink-0 flex items-center justify-center text-[9px] font-bold text-white/80 ${!cur ? 'color-sel' : 'opacity-40 hover:opacity-100'}"
              style="background:conic-gradient(from 225deg, ${defDark} 0 50%, ${defLight} 50% 100%)">×</button>
            ${CLASS_COLOR_SETS.map((s, i) => {
              const isSel = cur && cur.dark === s.dark;
              return `<button type="button" data-class-color="${c.id}" data-color-set="${i}" title="${s.name}"
                onclick="setClassColor('${c.id}', ${i})"
                class="w-7 h-7 rounded-full cursor-pointer transition-all hover:scale-110 flex-shrink-0 ${isSel ? 'color-sel' : ''}"
                style="background:conic-gradient(from 225deg, ${s.dark} 0 50%, ${s.light} 50% 100%)"></button>`;
            }).join('')}
          </div>
        </div>`;
      }).join('')}
    </div>`;

  const skipBody = `
    <div class="space-y-2 max-h-80 overflow-y-auto">
      ${classes.map(c => {
        const isExcluded = excluded.has(c.id);
        return `<label class="flex items-center gap-3 p-2.5 bg-[#0a0a0f] border border-[#22222e] rounded-xl cursor-pointer hover:border-blue-500/30 transition-colors">
          <input type="checkbox" data-exclude-class="${c.id}" ${isExcluded ? 'checked' : ''} value="${c.id}" class="rounded bg-[#1c1c26] border-[#22222e] text-blue-500 focus:ring-blue-500/30"
            onchange="scheduleSettingsSave('general')">
          <div class="flex-1 min-w-0">
            <div class="text-sm text-gray-200 truncate">${escapeHtml(c.shortName || c.name)}</div>
            <div class="text-xs text-gray-500">${isExcluded ? 'Hidden from averages and goal checks' : 'Included'}</div>
          </div>
          <span class="text-xs ${isExcluded ? 'text-orange-400' : 'text-gray-600'}">${isExcluded ? 'Skipped' : 'Included'}</span>
        </label>`;
      }).join('')}
    </div>`;

  const notesBody = `
    <div class="space-y-2">
      ${classes.map(c => {
        const link = triliumNotesFor(c.id);
        return `<div data-trilium-linked="${c.id}" class="p-3 bg-[#0a0a0f] border border-[#22222e] rounded-xl">
          <div class="flex items-center justify-between gap-2 mb-1.5">
            <div class="flex items-center gap-2 min-w-0">
              <span class="w-3 h-3 rounded-full flex-shrink-0" style="background:${classColorFor(c.id)}"></span>
              <span class="text-sm text-gray-200 truncate">${escapeHtml(c.shortName || c.name)}</span>
              ${link ? badge('linked', 'green') : badge('no notes', 'gray')}
            </div>
            ${link ? `<button type="button" onclick="triliumUnlink('${c.id}')" class="text-xs text-gray-500 hover:text-red-400 transition-colors flex-shrink-0">Unlink</button>` : `<button type="button" onclick="jumpToSettings('connections'); setTimeout(()=>document.getElementById('trilium-search-input')?.focus(),260)" class="text-xs text-blue-400 hover:text-blue-300 flex-shrink-0">Search notes…</button>`}
          </div>
          ${link ? triliumNoteCard(c.id, c.shortName || c.name) : `<p class="text-xs text-gray-500">Use the Trilium search in the Connections tab to find this class's notes folder.</p>`}
          ${link ? noteQuizClassCard(c.id) : ''}
        </div>`;
      }).join('')}
    </div>
    <p class="text-[11px] text-gray-500 mt-3">To link a class, open <button type="button" onclick="jumpToSettings('connections'); setTimeout(()=>document.getElementById('trilium-search-input')?.focus(),260)" class="underline hover:text-blue-300">Connections</button> and search for the notes folder.</p>`;

  return `
    <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5 mb-4">
      <div class="flex items-baseline justify-between mb-1">
        <h3 class="text-sm font-semibold text-gray-200">Default grade goal</h3>
        <span class="text-xs text-gray-500">${escapeHtml(letterGrade(goal))} threshold</span>
      </div>
      <p class="text-xs text-gray-500 mb-4">Used for every class unless you set a per-class override below.</p>
      <div class="flex items-center gap-3">
        <input id="settings-goal" type="range" min="60" max="100" step="1" value="${goal}"
          oninput="document.getElementById('goal-display').textContent=this.value+'%'; document.getElementById('goal-letter-display').textContent='('+letterGrade(parseInt(this.value,10))+' threshold)'; scheduleSettingsSave('general')"
          class="flex-1 h-2 bg-[#1c1c26] rounded-full appearance-none cursor-pointer accent-blue-500">
        <span class="text-lg font-bold text-blue-400 w-12 text-right tabular-nums"><span id="goal-display">${goal}%</span></span>
      </div>
      <div class="flex justify-between text-[10px] text-gray-600 mt-1">
        <span>60% (D-)</span><span>90% (A-)</span><span>93% (A)</span><span>100%</span>
      </div>
      <div class="text-[11px] text-gray-500 mt-2">Letter at threshold: <span id="goal-letter-display" class="text-gray-300">(${escapeHtml(letterGrade(goal))} threshold)</span></div>
    </div>

    ${settingsAccordion('pc_goals', 'target', '#3b82f6', 'Per-class goals', 'Customize the goal for each class individually.', goalBody, pill(countSet(perClass), 'customized'))}
    ${settingsAccordion('pc_names', 'pencil', '#8b5cf6', 'Class names', 'Give a class a shorter name to show everywhere.', namesBody, pill(countSet(aliases), 'renamed'))}
    ${settingsAccordion('pc_colors', 'star', '#ec4899', 'Class colors', 'Pick a color set per class for the whole app.', colorsBody, pill(countSet(colors), 'customized'))}
    ${settingsAccordion('pc_skip', 'filter', '#f59e0b', 'Skip classes', 'Exclude classes from grade calculations and goal checks.', skipBody, pill(excluded.size, 'skipped'))}
    ${settingsAccordion('pc_notes', 'book', '#14b8a6', 'Class notes (Trilium)', 'Link each class to its notes folder in Trilium.', notesBody, pill(classes.filter(c => triliumNotesFor(c.id)).length + '/' + classes.length, 'linked'))}
  `;
}

// --- Data & Syncing ---
function renderSettingsData() {
  return `
    <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5 mb-4">
      <h3 class="text-sm font-semibold text-gray-200 mb-1">Dashboard refresh interval</h3>
      <p class="text-xs text-gray-500 mb-4">How often the dashboard pulls fresh computed data while the app is open.</p>
      <div class="flex items-center gap-3">
        <input id="refresh-minutes-range" type="range" min="1" max="240" step="1" value="${state.autoRefreshMinutes || 5}"
          oninput="syncRangeNum('refresh-minutes-range','settings-refresh-minutes'); scheduleSettingsSave('data')"
          class="flex-1 h-2 bg-[#1c1c26] rounded-full appearance-none cursor-pointer accent-blue-500">
        <div class="flex items-center gap-2 flex-shrink-0">
          <input id="settings-refresh-minutes" type="number" min="1" max="240" step="1" value="${state.autoRefreshMinutes || 5}"
            oninput="syncNumRange('refresh-minutes-range','settings-refresh-minutes',1,240); scheduleSettingsSave('data')"
            class="w-20 px-3 py-2 bg-[#0a0a0f] border border-[#22222e] rounded-xl text-sm text-gray-200 tabular-nums">
          <span class="text-xs text-gray-500">min</span>
        </div>
      </div>
      <div class="flex justify-between text-[10px] text-gray-600 mt-1"><span>1</span><span>240</span></div>
    </div>

    ${settingsAccordion('ds_refresh', 'sparkle', '#3b82f6', 'Run a refresh now', 'Run the FACTS scraper for a specific period and class set. Live output streams into the log.', `
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
        <div>
          <label class="text-xs text-gray-500 mb-1 block">Time period</label>
          <select id="scrape-period" class="styled-select">
            ${['all','q1','q2','q3','q4','s1','s2','year'].map(p => `<option value="${p}" ${p === 'all' ? 'selected' : ''}>${PERIOD_LABELS[p] || 'All periods'}</option>`).join('')}
          </select>
        </div>
        <div>
          <label class="text-xs text-gray-500 mb-1 block">Classes</label>
          <select id="scrape-classes" class="styled-select">
            <option value="all" selected>All classes</option>
            ${(state.computed?.activeClasses || []).filter(c => c.isAcademic).map(c => `<option value="${c.id}">${escapeHtml(c.shortName || c.name)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="flex items-center gap-2 mb-3">
        <button onclick="startScrape()" id="scrape-start-btn" class="flex items-center gap-2 bg-blue-500/20 border border-blue-500/30 rounded-xl px-4 py-2.5 text-sm text-blue-400 hover:bg-blue-500/30 transition-all font-medium">${icon('sparkle','w-4 h-4')} Run refresh</button>
        <span id="scrape-status" class="text-xs text-gray-500"></span>
      </div>
      ${renderScrapeLogCard()}
    `)}

    ${settingsAccordion('ds_scrape', 'clock', '#14b8a6', 'Automatic scrape', 'Schedule FACTS scrapes at specific local times.', `
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label class="text-xs text-gray-500 mb-1 block">Times (comma-separated)</label>
          <input id="settings-auto-scrape-times" type="text" value="${state.autoScrape?.times || '07:00'}" placeholder="07:00, 12:30, 18:00"
            oninput="scheduleSettingsSave('data')"
            class="w-full px-3 py-2 bg-[#0a0a0f] border border-[#22222e] rounded-xl text-sm text-gray-200 placeholder-gray-600 tabular-nums">
        </div>
        <div>
          <label class="text-xs text-gray-500 mb-1 block">What to rescrape</label>
          <select id="settings-auto-scrape-period" onchange="scheduleSettingsSave('data')" class="styled-select">
            ${['all','q1','q2','q3','q4','s1','s2','year'].map(p => `<option value="${p}" ${p === (state.autoScrape?.period || 'all') ? 'selected' : ''}>${PERIOD_LABELS[p] || 'All periods'}</option>`).join('')}
          </select>
        </div>
        <div>
          <label class="text-xs text-gray-500 mb-1 block">Classes (IDs or "all")</label>
          <input id="settings-auto-scrape-classes" type="text" value="${state.autoScrape?.classes || 'all'}" placeholder="all or 6608,6433"
            oninput="scheduleSettingsSave('data')"
            class="w-full px-3 py-2 bg-[#0a0a0f] border border-[#22222e] rounded-xl text-sm text-gray-200 placeholder-gray-600 tabular-nums">
        </div>
      </div>
    `)}
  `;
}

// --- Scrape log card (color-coded + last-run pill + copy buttons) ---
function renderScrapeLogCard() {
  const scrapeLog = state.scrapeLog || { running: false, exitCode: null, logs: [] };
  const logs = scrapeLog.logs || [];
  const pill = scrapeLog.running
    ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] bg-blue-500/15 text-blue-300 border border-blue-500/30"><span class="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse"></span>Running</span>`
    : scrapeLog.exitCode === 0
      ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] bg-green-500/15 text-green-300 border border-green-500/30"><span class="w-1.5 h-1.5 rounded-full bg-green-400"></span>Last run OK</span>`
      : scrapeLog.exitCode != null
        ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] bg-red-500/15 text-red-300 border border-red-500/30"><span class="w-1.5 h-1.5 rounded-full bg-red-400"></span>Exit ${scrapeLog.exitCode}</span>`
        : `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] bg-[#1c1c26] text-gray-500 border border-[#22222e]"><span class="w-1.5 h-1.5 rounded-full bg-gray-600"></span>Never run</span>`;

  const body = `<pre id="scrape-log" class="h-48 overflow-y-auto p-3 text-[11px] leading-relaxed font-mono whitespace-pre-wrap">${!logs.length
    ? 'No scrape has run yet.'
    : logs.map(line => {
        const safe = escapeHtml(line);
        if (/\b(ERROR|CRITICAL|FATAL|EXCEPTION|TRACEBACK)\b/i.test(line)) return `<span class="text-red-300">${safe}</span>`;
        if (/\b(WARN|WARNING)\b/i.test(line)) return `<span class="text-amber-300">${safe}</span>`;
        if (/\b(OK|SUCCESS|DONE|SAVED|WROTE|FINISHED|COMPLETE|PUBLISHED|STARTING)\b/i.test(line)) return `<span class="text-green-300">${safe}</span>`;
        return `<span class="text-gray-400">${safe}</span>`;
      }).join('\n')}</pre>`;

  return `
    <div class="mt-4 bg-[#0a0a0f] border border-[#22222e] rounded-xl overflow-hidden">
      <div class="flex items-center justify-between px-3 py-2 border-b border-[#22222e] gap-2">
        <div class="flex items-center gap-2">
          ${pill}
          <span class="text-[10px] uppercase tracking-wider text-gray-500">Scrape log</span>
          <span class="text-[10px] text-gray-600">${logs.length} line${logs.length === 1 ? '' : 's'}</span>
        </div>
        <div class="flex items-center gap-1">
          <button type="button" onclick="copyScrapeLog()" class="text-[10px] text-gray-500 hover:text-gray-300 px-2 py-1 rounded transition-colors" title="Copy log to clipboard">Copy</button>
          <button type="button" onclick="copyScrapeBugReport()" class="text-[10px] text-gray-500 hover:text-gray-300 px-2 py-1 rounded transition-colors" title="Copy log + run info as a bug report">Bug report</button>
          <button type="button" onclick="clearScrapeLog()" class="text-[10px] text-gray-500 hover:text-red-400 px-2 py-1 rounded transition-colors">Clear</button>
        </div>
      </div>
      ${body}
    </div>
  `;
}
window.renderScrapeLogCard = renderScrapeLogCard;

function copyScrapeLog() {
  const logs = state.scrapeLog?.logs || [];
  navigator.clipboard.writeText(logs.join('\n')).then(
    () => showToast('Scrape log copied', 'success'),
    () => showToast('Clipboard unavailable — select manually', 'warning')
  );
}
window.copyScrapeLog = copyScrapeLog;

function copyScrapeBugReport() {
  const scrapeLog = state.scrapeLog || {};
  const header = [
    `GradeTrack scrape log — ${new Date().toISOString()}`,
    `exit: ${scrapeLog.exitCode == null ? '(in progress)' : scrapeLog.exitCode}`,
    `running: ${!!scrapeLog.running}`,
    `lines: ${(scrapeLog.logs || []).length}`,
    '',
  ].join('\n');
  const body = (scrapeLog.logs || []).join('\n');
  navigator.clipboard.writeText(header + body).then(
    () => showToast('Bug-report copy ready', 'success'),
    () => showToast('Clipboard unavailable', 'warning')
  );
}
window.copyScrapeBugReport = copyScrapeBugReport;

// --- Updates ---
function renderSettingsUpdates() {
  const u = state._update || {};
  const hasInfo = !!(u.installed && u.available);
  const behindCommits = u.behind || 0;
  let statusBlock;
  if (!hasInfo) {
    statusBlock = `<div class="flex items-center gap-2 text-xs text-gray-500">
        ${icon('refresh', 'w-3.5 h-3.5 animate-spin')}
        Checking for updates…
      </div>`;
  } else if (u.available) {
    statusBlock = `<div class="flex items-center gap-2 text-xs text-blue-300">
        <span class="inline-flex w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse"></span>
        Update available (${behindCommits} commit${behindCommits === 1 ? '' : 's'} behind)
      </div>`;
  } else {
    statusBlock = `<div class="flex items-center gap-2 text-xs text-green-400">
        ${icon('check', 'w-3.5 h-3.5')} You're on the latest version
      </div>`;
  }

  return `
    <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5 mb-4">
      <div class="flex items-start justify-between gap-3 mb-3">
        <div class="min-w-0">
          <h3 class="text-sm font-semibold text-gray-200 flex items-center gap-2">
            ${icon('download', 'w-4 h-4 text-blue-400')}
            Software updates
          </h3>
          <p class="text-xs text-gray-500 mt-1 leading-relaxed">
            Pulls the latest code from GitHub and restarts the dashboard.
            Never touches <span class="text-gray-400">.env</span>,
            <span class="text-gray-400">data/</span>, or
            <span class="text-gray-400">venv/</span> — your settings, grades,
            and credentials stay put.
          </p>
        </div>
        <div class="flex flex-col items-end gap-2 flex-shrink-0">
          ${statusBlock}
          <button type="button" onclick="checkForUpdate(true)"
            class="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-gray-400 hover:text-white border border-[#22222e] hover:border-blue-500/40 rounded-lg px-2.5 py-1.5 transition-all" title="Refresh now">
            ${icon('refresh', 'w-3 h-3')} Refresh
          </button>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-3 mb-4">
        <div class="bg-[#0a0a0f] border border-[#22222e] rounded-xl px-3 py-2.5">
          <div class="text-[10px] uppercase tracking-wider text-gray-500 font-medium mb-0.5">Installed</div>
          <div class="text-sm font-mono text-gray-200 truncate">${escapeHtml(u.installed || '…')}</div>
        </div>
        <div class="bg-[#0a0a0f] border border-[#22222e] rounded-xl px-3 py-2.5">
          <div class="text-[10px] uppercase tracking-wider text-gray-500 font-medium mb-0.5">Latest on GitHub</div>
          <div class="text-sm font-mono ${u.available ? 'text-blue-300' : 'text-gray-200'} truncate">${escapeHtml(u.available || '…')}</div>
        </div>
      </div>

      ${u.available ? `
        <button type="button" onclick="runAppUpdate()" id="updates-apply-btn"
          class="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium bg-blue-500/15 border border-blue-500/30 text-blue-300 hover:bg-blue-500/25 transition-all">
          ${icon('download', 'w-4 h-4')} Update now (${behindCommits} commit${behindCommits === 1 ? '' : 's'})
        </button>` : `
        <button type="button" disabled
          class="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium bg-[#0a0a0f] border border-[#22222e] text-gray-500 cursor-default">
          ${icon('check', 'w-4 h-4')} No update available
        </button>`}

      <p class="text-[10px] text-gray-600 mt-3 leading-relaxed">
        The dashboard polls origin/main about once an hour and on every tab focus.
        You can also pull updates from the command line:
        <code class="text-gray-400 bg-[#0a0a0f] border border-[#22222e] rounded px-1.5 py-0.5">./update.sh</code>
      </p>
    </div>
  `;
}

// --- Connections ---
// --- AI ---
const OLLAMA_MODEL_FALLBACKS = ['gpt-oss:120b', 'gpt-oss:20b', 'deepseek-r1:70b', 'llama3.3:70b', 'qwen3:32b', 'gemma3:27b'];

function renderSettingsConnectionsAndAi() {
  const apiKeys = state.apiKeys || {};
  const current = state.computed?.settings?.ollamaModel || 'gpt-oss:120b';
  const keyInput = (name, label) => {
    const val = apiKeys[name] || '';
    return `<div>
      <label class="text-xs text-gray-500 mb-1 block">${label}</label>
      <input type="password" data-apikey="${name}" autocomplete="off" spellcheck="false"
        value="${val ? '••••••••••' + val.slice(-4) : ''}"
        placeholder="${val ? '•••••••••• stored' : 'Not set'}"
        oninput="scheduleSettingsSave('connections')"
        class="w-full px-3 py-2 bg-[#0a0a0f] border border-[#22222e] rounded-xl text-sm text-gray-200 placeholder-gray-600 font-mono">
    </div>`;
  };
  return `
    <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5 mb-4">
      <div class="flex items-center justify-between gap-3 mb-1">
        <div>
          <h3 class="text-sm font-semibold text-gray-200">AI insights model</h3>
          <p class="text-xs text-gray-500 mt-0.5">Used once daily after grade data changes. Pick from your live Ollama Cloud models or type any model name.</p>
        </div>
        <span id="ai-models-status" class="text-xs text-gray-500 flex-shrink-0"></span>
      </div>
      <div class="mt-4">
        <label class="text-xs text-gray-500 mb-1 block">Cloud model</label>
        <div class="flex items-center gap-2">
          <input id="settings-ollama-model" list="ollama-model-list" type="text" value="${escapeHtml(current)}" placeholder="gpt-oss:120b"
            oninput="scheduleSettingsSave('connections')"
            class="flex-1 min-w-0 px-3 py-2 bg-[#0a0a0f] border border-[#22222e] rounded-xl text-sm text-gray-200 placeholder-gray-600 font-mono">
          <datalist id="ollama-model-list"></datalist>
          <button type="button" id="ollama-models-refresh" onclick="ollamaModelsRefresh()" title="Refresh model list from Ollama Cloud"
            class="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium bg-[#0a0a0f] border border-[#22222e] text-gray-300 hover:text-blue-300 hover:border-blue-500/30 transition-colors flex-shrink-0">${icon('restart','w-3.5 h-3.5')} Refresh</button>
        </div>
      </div>
      <div class="flex items-center gap-3 mt-4 pt-4 border-t border-[#22222e]">
        <button type="button" id="ai-test-btn" onclick="testAIConnection()" class="flex items-center gap-2 bg-blue-500/20 border border-blue-500/30 rounded-xl px-4 py-2 text-sm text-blue-400 hover:bg-blue-500/30 transition-all font-medium">${icon('sparkle','w-4 h-4')} Test connection</button>
        <span id="ai-test-status" class="text-xs text-gray-500"></span>
      </div>
    </div>

    ${settingsAccordion('conn_keys', 'lock', '#8b5cf6', 'API keys', 'All API keys live on the app server. Leave blank to keep the stored key.', `
      <div class="space-y-3">
        ${keyInput('facts', 'FACTS SIS')}
        ${keyInput('openai', 'OpenAI')}
        ${keyInput('ollama', 'Ollama Cloud')}
      </div>
    `)}

    ${settingsAccordion('conn_trilium', 'book', '#14b8a6', 'Trilium (Class Notes)', 'Set up the Trilium ETAPI URL/token and search your notes.', `
      <div class="flex items-center justify-between mb-3 gap-3">
        <div>
          <h3 class="text-sm font-semibold text-gray-200">Trilium connection</h3>
          <p class="text-xs text-gray-500 mt-0.5">Search your Trilium notes and link a class to its notes folder. Chapters appear as quick links across Overview, class details and Assignments.</p>
        </div>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
        <div>
          <label class="text-xs text-gray-500 mb-1 block">Trilium URL</label>
          <input id="trilium-url" type="text" value="${escapeHtml((state.trilium?.url || 'http://192.168.0.71:8081'))}" placeholder="http://192.168.0.71:8081" spellcheck="false"
            onblur="scheduleSettingsSave('connections')"
            class="w-full px-3 py-2 bg-[#0a0a0f] border border-[#22222e] rounded-xl text-sm text-gray-200 placeholder-gray-600">
        </div>
        <div>
          <label class="text-xs text-gray-500 mb-1 block">ETAPI token</label>
          <div class="flex items-center gap-2">
            <input id="trilium-token" type="password" autocomplete="off" spellcheck="false"
              value="${state.trilium?.token ? '••••••••••' + state.trilium.token.slice(-4) : ''}"
              placeholder="${state.trilium?.token ? '•••••••••• stored' : 'Paste from Trilium → Options → ETAPI'}"
              onblur="scheduleSettingsSave('connections')"
              class="flex-1 px-3 py-2 bg-[#0a0a0f] border border-[#22222e] rounded-xl text-sm text-gray-200 placeholder-gray-600 font-mono">
            <button type="button" onclick="testTriliumConnection()" id="trilium-test-btn" class="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium bg-[#0a0a0f] border border-[#22222e] text-gray-300 hover:text-blue-300 hover:border-blue-500/30 transition-colors flex-shrink-0">${icon('sparkle','w-3.5 h-3.5')} Test</button>
          </div>
        </div>
      </div>

        <div class="mt-4">
        <label class="text-xs text-gray-500 mb-1 block">Search notes</label>
        <div class="flex items-center gap-2">
          <input id="trilium-search-input" type="text" placeholder="e.g. 'AP Chemistry' or 'Algebra'" spellcheck="false"
            onkeydown="if(event.key === 'Enter') triliumSearchUI()"
            class="flex-1 px-3 py-2 bg-[#0a0a0f] border border-[#22222e] rounded-xl text-sm text-gray-200 placeholder-gray-600">
          <button type="button" onclick="triliumSearchUI()" id="trilium-search-btn" class="flex items-center gap-2 bg-blue-500/20 border border-blue-500/30 rounded-xl px-4 py-2.5 text-sm text-blue-400 hover:bg-blue-500/30 transition-all font-medium">${icon('search','w-4 h-4')} Search</button>
        </div>
        <div id="trilium-search-results" class="space-y-2 mt-3"></div>
        <p class="text-[11px] text-gray-500 mt-3">Per-class linking lives in the <button type="button" onclick="jumpToSettings('classes'); setTimeout(()=>{const p=document.querySelector('[data-panel=pc_notes]'); if(p){p.classList.contains('collapsed')&&toggleSettingsPanel('pc_notes'); p.scrollIntoView({behavior:'smooth',block:'center'});}},320)" class="underline hover:text-blue-300">Classes section → Class notes</button>.</p>
      </div>
    `)}

    ${settingsAccordion('conn_prompts', 'sparkle', '#3b82f6', 'AI prompts', 'Edit the prompts that control how the AI writes quiz questions and coach replies. Empty reverts to the default.', `
      <p class="text-xs text-gray-500 mb-3">Changes autosave with the rest of this section.</p>
      <div id="ai-prompts-body"><p class="text-xs text-gray-500">Loading prompts…</p></div>
    `)}
  `;
}

// --- Email & Notifications ---
const EMAIL_SCOPE_LABELS = { both: 'Everything (grades + homework)', grades: 'Grades only', assignments: 'Assignments only', review: 'Daily review (streak + completion %)', errors: 'Errors only (any app failure)' };
let _emailPreviewTimer = null;

function renderEmailRecipientRow(r) {
  return `
    <div data-recipient-row class="flex items-center gap-2">
      <input type="email" data-recipient-email value="${escapeHtml(r?.email || '')}" placeholder="you@example.com" spellcheck="false"
        oninput="scheduleSettingsSave('general')"
        class="flex-1 min-w-0 px-3 py-2 bg-[#0a0a0f] border border-[#22222e] rounded-xl text-sm text-gray-200 placeholder-gray-600 font-mono">
      <select data-recipient-scope onchange="scheduleSettingsSave('general')" class="styled-select flex-shrink-0" style="width:16rem">
        ${Object.entries(EMAIL_SCOPE_LABELS).map(([k, label]) => `<option value="${k}" ${k === (r?.scope || 'both') ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
      <button type="button" onclick="removeEmailRecipient(this)" class="w-9 h-9 flex items-center justify-center rounded-xl bg-[#0a0a0f] border border-[#22222e] text-gray-500 hover:text-red-400 hover:border-red-500/30 transition-colors flex-shrink-0" title="Remove recipient">${icon('x','w-4 h-4')}</button>
    </div>`;
}

window.addEmailRecipient = function() {
  const list = document.getElementById('email-recipient-list');
  if (!list) return;
  const tpl = document.createElement('div');
  tpl.innerHTML = renderEmailRecipientRow({ email: '', scope: 'both' });
  list.appendChild(tpl.firstElementChild);
  list.querySelector('[data-recipient-email]:last-of-type')?.focus();
  scheduleSettingsSave('general');
};

window.removeEmailRecipient = function(btn) {
  const row = btn.closest('[data-recipient-row]');
  if (!row) return;
  row.remove();
  scheduleSettingsSave('general');
};

function highlightEmailHtml(code) {
  const re = /(\$[A-Za-z_][A-Za-z0-9_]*)|(<!--[\s\S]*?-->)|(<\/?[a-zA-Z][^>]*>)/g;
  const parts = [];
  let last = 0, m;
  while ((m = re.exec(code))) {
    if (m.index > last) parts.push(escapeHtml(code.slice(last, m.index)));
    if (m[1]) parts.push(`<span class="email-var">${escapeHtml(m[1])}</span>`);
    else if (m[2]) parts.push(`<span class="email-comment">${escapeHtml(m[2])}</span>`);
    else if (m[3]) parts.push(highlightEmailTag(m[3]));
    last = m.index + m[0].length;
  }
  if (last < code.length) parts.push(escapeHtml(code.slice(last)));
  return parts.join('');
}

function highlightEmailTag(tag) {
  const m = tag.match(/^(<\/?)([a-zA-Z][a-zA-Z0-9]*)([\s\S]*?)(\/?>)$/);
  if (!m) return `<span class="email-tag">${escapeHtml(tag)}</span>`;
  const attrRe = /(\s+[a-zA-Z-]+)(=(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
  const parts = [];
  let last = 0, am;
  const inner = m[3] || '';
  while ((am = attrRe.exec(inner))) {
    if (am.index > last) parts.push(escapeHtml(inner.slice(last, am.index)));
    const val = am[2] ? `<span class="email-eq">${escapeHtml(am[2])}</span>` : '';
    parts.push(`<span class="email-attr">${escapeHtml(am[1])}</span>${val}`);
    last = am.index + am[0].length;
  }
  if (last < inner.length) parts.push(escapeHtml(inner.slice(last)));
  return `<span class="email-tag">${escapeHtml(m[1] + m[2])}</span>${parts.join('')}<span class="email-tag">${escapeHtml(m[4])}</span>`;
}

function updateEmailHighlight() {
  const ta = document.getElementById('settings-email-html');
  const pre = document.getElementById('email-html-highlight');
  if (!ta || !pre) return;
  pre.innerHTML = highlightEmailHtml(ta.value || '');
  pre.scrollTop = ta.scrollTop;
  pre.scrollLeft = ta.scrollLeft;
}

function emailEditorInput() {
  const ta = document.getElementById('settings-email-html');
  if (!ta) return;
  state.emailHtml = ta.value;
  updateEmailHighlight();
  scheduleSettingsSave('general');
  if (_emailPreviewTimer) clearTimeout(_emailPreviewTimer);
  _emailPreviewTimer = setTimeout(renderEmailPreview, 450);
}

function emailEditorScroll() {
  const ta = document.getElementById('settings-email-html');
  const pre = document.getElementById('email-html-highlight');
  if (ta && pre) { pre.scrollTop = ta.scrollTop; pre.scrollLeft = ta.scrollLeft; }
}

function emailEditorTab(e) {
  if (e.key !== 'Tab') return;
  const ta = e.target;
  e.preventDefault();
  const start = ta.selectionStart, end = ta.selectionEnd;
  ta.value = ta.value.slice(0, start) + '  ' + ta.value.slice(end);
  ta.selectionStart = ta.selectionEnd = start + 2;
  emailEditorInput();
}

window.insertEmailVariable = function(name) {
  const ta = document.getElementById('settings-email-html');
  if (!ta) return;
  const token = '$' + name;
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, start) + token + ta.value.slice(end);
  ta.selectionStart = ta.selectionEnd = start + token.length;
  ta.focus();
  emailEditorInput();
};

window.resetEmailTemplate = function() {
  const ta = document.getElementById('settings-email-html');
  state.emailHtml = state.emailDefaultTemplate || '';
  if (ta) { ta.value = state.emailHtml; updateEmailHighlight(); }
  scheduleSettingsSave('general');
  renderEmailPreview();
  showToast('Template reset to default', 'success');
};

window.setEmailPreviewScope = function(scope) {
  state.emailScope = scope;
  document.querySelectorAll('[data-preview-scope]').forEach(b => {
    const active = b.dataset.previewScope === scope;
    b.classList.toggle('bg-blue-500/15', active);
    b.classList.toggle('text-blue-300', active);
    b.classList.toggle('text-gray-400', !active);
  });
  renderEmailPreview();
};

async function renderEmailPreview() {
  const iframe = document.getElementById('email-preview-frame');
  if (!iframe) return;
  try {
    const res = await fetch('/api/email/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template: state.emailHtml || '', scope: state.emailScope || 'both' })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      iframe.srcdoc = `<body style="font-family:system-ui,sans-serif;padding:1rem;color:#666">Preview failed: ${escapeHtml(data.detail || res.status)}</body>`;
      return;
    }
    if (Array.isArray(data.variables)) state.emailVariables = data.variables;
    if (typeof data.defaultTemplate === 'string') state.emailDefaultTemplate = data.defaultTemplate;
    const chips = document.getElementById('email-var-chips');
    if (chips && Array.isArray(data.variables) && data.variables.length) {
      chips.innerHTML = `${data.variables.map(v => `<button type="button" onclick="insertEmailVariable('${v}')" title="Click to insert \$${v}" class="px-2 py-1 rounded-lg bg-[#0a0a0f] border border-[#22222e] text-[11px] font-mono text-amber-300 hover:border-amber-500/40 hover:text-amber-200 transition-colors">\$${v}</button>`).join('')}<span class="text-[10px] text-gray-500">Click a variable to insert it at the cursor. These render real data at send time.</span>`;
    }
    iframe.srcdoc = data.html || '';
  } catch (err) {
    iframe.srcdoc = `<body style="font-family:system-ui,sans-serif;padding:1rem;color:#666">Preview unavailable: ${escapeHtml(err.message || err)}</body>`;
  }
}

window.sendDailyEmailNow = async function(run) {
  const status = document.getElementById('email-send-daily-status');
  if (status) { status.textContent = 'Sending…'; status.className = 'text-xs text-gray-500'; }
  try {
    const res = await fetch('/api/email/send-daily', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ run: run || '' })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (status) { status.textContent = data.detail || 'Send failed'; status.className = 'text-xs text-red-400'; }
      return;
    }
    if (data.sent) {
      if (status) { status.textContent = 'Sent'; status.className = 'text-xs text-green-400'; }
      showToast('Daily email sent', 'success');
    } else if (status) {
      status.textContent = 'Nothing sent — check SMTP settings and recipients';
      status.className = 'text-xs text-amber-400';
    }
  } catch (err) {
    if (status) { status.textContent = 'Network error'; status.className = 'text-xs text-red-400'; }
  }
};

window.sendTestEmail = async function() {
  const btn = document.getElementById('email-test-btn');
  const status = document.getElementById('email-test-status');
  if (btn) btn.disabled = true;
  if (status) { status.textContent = 'Sending…'; status.className = 'text-xs text-gray-500'; }
  const recipients = Array.from(document.querySelectorAll('[data-recipient-email]'))
    .map(i => i.value.trim()).filter(Boolean);
  try {
    const res = await fetch('/api/email/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipients })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (status) { status.textContent = data.detail || 'Send failed'; status.className = 'text-xs text-red-400'; }
      return;
    }
    if (data.sent) {
      if (status) { status.textContent = recipients.length ? `Sent to ${recipients.length} recipient(s)` : 'Sent (saved recipients)'; status.className = 'text-xs text-green-400'; }
      showToast('Test email sent', 'success');
    } else if (status) {
      status.textContent = 'Nothing sent — check SMTP settings and recipients';
      status.className = 'text-xs text-amber-400';
    }
  } catch (err) {
    if (status) { status.textContent = 'Network error'; status.className = 'text-xs text-red-400'; }
  } finally {
    if (btn) btn.disabled = false;
  }
};

function browserNotify(title, opts = {}) {
  const n = state.notifications || {};
  if (!n.enabled) return;
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  try { new Notification(title, opts); } catch (_) {}
}
window.browserNotify = browserNotify;

window.requestNotificationPermission = async function() {
  if (!('Notification' in window)) { showToast('This browser does not support notifications', 'warning'); return; }
  if (Notification.permission === 'granted') {
    state.notifications = { ...(state.notifications || {}), enabled: true };
    scheduleSettingsSave('general');
    showToast('Notifications are already enabled', 'success');
    return;
  }
  try {
    const perm = await Notification.requestPermission();
    if (perm === 'granted') {
      state.notifications = { ...(state.notifications || {}), enabled: true };
      scheduleSettingsSave('general');
      render();
      showToast('Notifications enabled', 'success');
    } else {
      showToast('Notifications blocked — allow them in your browser settings', 'warning');
    }
  } catch (_) {}
};

window.onNotifMasterToggle = function(cb) {
  if (cb.checked) {
    if (!('Notification' in window)) {
      cb.checked = false;
      showToast('This browser does not support notifications', 'warning');
      return;
    }
    if (Notification.permission === 'default') {
      requestNotificationPermission();
      return;
    }
    if (Notification.permission === 'denied') {
      cb.checked = false;
      showToast('Notifications are blocked by the browser — allow them in site settings first', 'warning');
      return;
    }
  }
  state.notifications = { ...(state.notifications || {}), enabled: cb.checked };
  scheduleSettingsSave('general');
  if (cb.checked) showToast('Notifications enabled', 'success');
};

function renderSettingsEmail() {
  const email = state.email || { recipients: [], subjectPrefix: 'Grades Update' };
  const recipients = Array.isArray(email.recipients) ? email.recipients : [];
  const notif = state.notifications || { enabled: false, scrapeDone: true, blooketDone: true };
  const scope = state.emailScope || 'both';
  const vars = Array.isArray(state.emailVariables) ? state.emailVariables : [];
  const perm = ('Notification' in window) ? Notification.permission : 'unsupported';

  const recipientRows = recipients.length
    ? recipients.map(r => renderEmailRecipientRow(r)).join('')
    : renderEmailRecipientRow({ email: '', scope: 'both' });

  const varChips = vars.length
    ? `<div id="email-var-chips" class="flex flex-wrap items-center gap-1.5 mb-3">
        ${vars.map(v => `<button type="button" onclick="insertEmailVariable('${v}')" title="Click to insert \$${v}" class="px-2 py-1 rounded-lg bg-[#0a0a0f] border border-[#22222e] text-[11px] font-mono text-amber-300 hover:border-amber-500/40 hover:text-amber-200 transition-colors">\$${v}</button>`).join('')}
        <span class="text-[10px] text-gray-500">Click a variable to insert it at the cursor. These render real data at send time.</span>
      </div>`
    : '<div id="email-var-chips" class="mb-3"><p class="text-xs text-gray-500">Variables appear here after the first preview loads.</p></div>';

  const scopeTabs = Object.entries(EMAIL_SCOPE_LABELS).map(([k, label]) => `
    <button type="button" data-preview-scope="${k}" onclick="setEmailPreviewScope('${k}')"
      class="px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${scope === k ? 'bg-blue-500/15 text-blue-300' : 'text-gray-400 hover:text-gray-200'}">${label}</button>`).join('');

  const permNote = perm === 'granted' ? 'Allowed on this device.'
    : perm === 'denied' ? 'Blocked by the browser — enable it in site settings.'
    : perm === 'unsupported' ? 'Not supported by this browser.'
    : 'Requires your permission on this device.';

  return `
    ${settingsAccordion('email_recipients', 'user', '#3b82f6', 'Email recipients', 'Who gets the Grades Update email, and what they see.', `
      <div class="space-y-2 mb-3" id="email-recipient-list">
        ${recipientRows}
      </div>
      <button type="button" id="email-recipient-add" onclick="addEmailRecipient()" class="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors">${icon('plus','w-3.5 h-3.5')} Add recipient</button>
      <p class="text-[11px] text-gray-500 mt-3">Each recipient gets their own copy filtered to their scope. With no recipients listed, the email falls back to the server's SMTP_TO setting.</p>
    `)}

    <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5 mb-4">
      <h3 class="text-sm font-semibold text-gray-200 mb-1">Email subject prefix</h3>
      <p class="text-xs text-gray-500 mb-3">Prepended to the term and grade summary on the subject line.</p>
      <input id="settings-email-subject" type="text" value="${escapeHtml(email.subjectPrefix || 'Grades Update')}" placeholder="Grades Update" maxlength="80"
        oninput="scheduleSettingsSave('general')"
        class="w-full px-3 py-2 bg-[#0a0a0f] border border-[#22222e] rounded-xl text-sm text-gray-200 placeholder-gray-600">
    </div>

    ${settingsAccordion('email_schedule', 'clock', '#f59e0b', 'Daily email schedule', 'Automatically send the combined Grades Update (assignments, calendar, todos, missing) on a schedule.', `
      <p class="text-xs text-gray-500 mb-3">The combined email lists assignments due today, everything due tomorrow (homework + personal tasks + school calendar events), and anything already missing. Sent as HTML matching your app theme.</p>
      <label class="flex items-center justify-between gap-3 p-3 bg-[#0a0a0f] border border-[#22222e] rounded-xl cursor-pointer hover:border-amber-500/30 transition-colors mb-3">
        <div class="min-w-0">
          <div class="text-sm text-gray-200">Enable scheduled emails</div>
          <div class="text-xs text-gray-500 mt-0.5">Emails are also sent automatically after each scrape that finds changes.</div>
        </div>
        <span class="switch"><input id="settings-email-schedule-enabled" type="checkbox" ${(email.schedule?.enabled !== false) ? 'checked' : ''} onchange="scheduleSettingsSave('general')"><span class="track"><span class="thumb"></span></span></span>
      </label>
      <div class="mb-4">
        <label class="block text-xs text-gray-500 mb-1.5">Send times (comma-separated, 24h or 12h)</label>
        <input id="settings-email-schedule-times" type="text" value="${escapeHtml(Array.isArray(email.schedule?.times) ? email.schedule.times.join(', ') : (email.schedule?.times || '07:05, 16:00'))}" placeholder="07:05, 16:00" maxlength="120"
          oninput="scheduleSettingsSave('general')"
          class="w-full px-3 py-2 bg-[#0a0a0f] border border-[#22222e] rounded-xl text-sm text-gray-200 placeholder-gray-600">
        <p class="text-[11px] text-gray-500 mt-1.5">Morning < 12:00 is a "morning" run (due today); afternoon is an "afternoon" run (full next-day preview).</p>
      </div>
      <button type="button" onclick="sendDailyEmailNow()" class="flex items-center gap-2 bg-amber-500/15 border border-amber-500/30 rounded-xl px-4 py-2 text-sm text-amber-300 hover:bg-amber-500/25 transition-all font-medium">${icon('send','w-4 h-4')} Send daily email now</button>
      <span id="email-send-daily-status" class="text-xs text-gray-500 ml-2"></span>
    `)}

    ${settingsAccordion('email_template', 'file', '#8b5cf6', 'Email HTML template', 'Design the email body. Variables render real data at send time.', `
      ${varChips}
      <div class="relative mb-3" onclick="document.getElementById('settings-email-html')?.focus()">
        <pre id="email-html-highlight" class="absolute inset-0 m-0 p-3 overflow-hidden text-[12px] leading-[1.5] font-mono whitespace-pre-wrap break-words pointer-events-none rounded-xl border border-[#22222e]" aria-hidden="true"></pre>
        <textarea id="settings-email-html" spellcheck="false" autocomplete="off" autocapitalize="off"
          oninput="emailEditorInput()" onscroll="emailEditorScroll()" onkeydown="emailEditorTab(event)"
          class="relative w-full h-64 p-3 text-[12px] leading-[1.5] font-mono whitespace-pre-wrap break-words resize-none bg-transparent text-transparent caret-white rounded-xl border border-[#22222e] focus:outline-none focus:border-blue-500/60"
          placeholder="Hello,

Here are your grades for ${'$'}TERM ${'$'}YEAR."></textarea>
      </div>
      <div class="flex flex-wrap items-center gap-2 mb-4">
        <button type="button" id="email-test-btn" onclick="sendTestEmail()" class="flex items-center gap-2 bg-blue-500/20 border border-blue-500/30 rounded-xl px-4 py-2 text-sm text-blue-400 hover:bg-blue-500/30 transition-all font-medium">${icon('send','w-4 h-4')} Send test email</button>
        <button type="button" onclick="resetEmailTemplate()" class="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium bg-[#0a0a0f] border border-[#22222e] text-gray-300 hover:text-amber-300 hover:border-amber-500/30 transition-colors">${icon('restart','w-3.5 h-3.5')} Reset to default</button>
        <span id="email-test-status" class="text-xs text-gray-500"></span>
      </div>
      <div class="border-t border-[#22222e] pt-4">
        <div class="flex flex-wrap items-center justify-between gap-2 mb-2">
          <h3 class="text-sm font-semibold text-gray-200">Live preview</h3>
          <div class="inline-flex items-center gap-1 bg-[#0a0a0f] border border-[#22222e] rounded-xl p-1">
            ${scopeTabs}
          </div>
        </div>
        <iframe id="email-preview-frame" title="Email preview" class="w-full h-72 rounded-xl border border-[#22222e] bg-white" sandbox=""></iframe>
      </div>
    `)}

    ${settingsAccordion('email_notifications', 'bell', '#22c55e', 'Browser notifications', 'Desktop alerts when long background jobs finish.', `
      <p class="text-xs text-gray-500 mb-3">Show a desktop notification when a grades refresh or Blooket set finishes. ${permNote}</p>
      <div class="space-y-2">
        <label class="flex items-center justify-between gap-3 p-3 bg-[#0a0a0f] border border-[#22222e] rounded-xl cursor-pointer hover:border-blue-500/30 transition-colors">
          <div class="min-w-0">
            <div class="text-sm text-gray-200">Grades refresh finished</div>
            <div class="text-xs text-gray-500 mt-0.5">When a FACTS scrape completes (or fails).</div>
          </div>
          <span class="switch"><input id="settings-notif-scrape" type="checkbox" ${notif.scrapeDone !== false ? 'checked' : ''} onchange="scheduleSettingsSave('general')"><span class="track"><span class="thumb"></span></span></span>
        </label>
        <label class="flex items-center justify-between gap-3 p-3 bg-[#0a0a0f] border border-[#22222e] rounded-xl cursor-pointer hover:border-blue-500/30 transition-colors">
          <div class="min-w-0">
            <div class="text-sm text-gray-200">Blooket set finished</div>
            <div class="text-xs text-gray-500 mt-0.5">When a set is published or its creation fails.</div>
          </div>
          <span class="switch"><input id="settings-notif-blooket" type="checkbox" ${notif.blooketDone !== false ? 'checked' : ''} onchange="scheduleSettingsSave('general')"><span class="track"><span class="thumb"></span></span></span>
        </label>
        <label class="flex items-center justify-between gap-3 p-3 bg-[#0a0a0f] border border-[#22222e] rounded-xl cursor-pointer hover:border-blue-500/30 transition-colors">
          <div class="min-w-0">
            <div class="text-sm text-gray-200">Note quiz ready</div>
            <div class="text-xs text-gray-500 mt-0.5">When a daily note quiz is generated from new lines in a class's notes (per-class opt-in).</div>
          </div>
          <span class="switch"><input id="settings-notif-note-quiz" type="checkbox" ${notif.noteQuizReady !== false ? 'checked' : ''} onchange="scheduleSettingsSave('general')"><span class="track"><span class="thumb"></span></span></span>
        </label>
        <button type="button" id="notif-permission-btn" onclick="requestNotificationPermission()" class="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors">${icon('bell','w-3.5 h-3.5')} Enable notifications on this device…</button>
      </div>
    `)}
  `;
}

function initEmailSettingsTab() {
  const ta = document.getElementById('settings-email-html');
  if (ta) { ta.value = state.emailHtml || ''; updateEmailHighlight(); }
  const frame = document.getElementById('email-preview-frame');
  if (frame && !frame.srcdoc) {
    renderEmailPreview().then(() => {
      // No custom template saved yet — surface the currently-running default
      // template so it can be viewed (and edited) as the base.
      const ta2 = document.getElementById('settings-email-html');
      if (ta2 && !state.emailHtml && state.emailDefaultTemplate) {
        state.emailHtml = state.emailDefaultTemplate;
        ta2.value = state.emailHtml;
        updateEmailHighlight();
      }
    });
  }
}

// --- App ---
function renderSettingsApp() {
  const themeBtn = (mode, label) => `
    <button type="button" id="${mode === 'dark' ? 'settings-theme-dark' : 'settings-theme-light'}" data-theme-choice="${mode}" onclick="setThemeMode('${mode}'); scheduleSettingsSave('general')"
      class="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${state.theme === mode ? 'bg-blue-500/15 text-blue-300' : 'text-gray-400 hover:text-gray-200'}">${label}</button>`;

  const reviewBody = `
    <div class="space-y-4">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <h3 class="text-sm font-semibold text-gray-200">Levels-based review</h3>
          <p class="text-xs text-gray-500 mt-1 leading-relaxed">Climb unknown → familiar → proficient → mastered. Questions come back only when you need them, and your progress through each level is saved as you go so you can stop anytime. Turn off for a straight run-through.</p>
        </div>
        <label class="switch" title="Levels-based review">
          <input id="settings-levels-enabled" type="checkbox" ${state.levelsEnabled ? 'checked' : ''} onchange="toggleLevelsEnabled(this); scheduleSettingsSave('general')">
          <span class="track"><span class="thumb"></span></span>
        </label>
      </div>
      <div class="border-t border-[#22222e]"></div>
      <div>
        <h3 class="text-sm font-semibold text-gray-200 mb-1">Quiz review delay</h3>
        <p class="text-xs text-gray-500 mb-3">After a wrong answer you're locked from moving on for this many seconds, then click anywhere to continue. Set to 0 to skip the wait.</p>
        <div class="flex items-center gap-3">
          <input id="quiz-delay-range" type="range" min="0" max="30" step="0.5" value="${state.quizDelay ?? 3}"
            oninput="syncRangeNum('quiz-delay-range','settings-quiz-delay'); scheduleSettingsSave('general')"
            class="flex-1 h-2 bg-[#1c1c26] rounded-full appearance-none cursor-pointer accent-blue-500">
          <div class="flex items-center gap-2 flex-shrink-0">
            <input id="settings-quiz-delay" type="number" min="0" max="30" step="0.5" value="${state.quizDelay ?? 3}"
              oninput="syncNumRange('quiz-delay-range','settings-quiz-delay',0,30); scheduleSettingsSave('general')"
              class="w-20 px-3 py-2 bg-[#0a0a0f] border border-[#22222e] rounded-xl text-sm text-gray-200 tabular-nums">
            <span class="text-xs text-gray-500">sec</span>
          </div>
        </div>
        <div class="flex justify-between text-[10px] text-gray-600 mt-1"><span>0</span><span>30</span></div>
      </div>
    </div>`;

  const aboutBody = `
    <div class="space-y-1.5 text-xs text-gray-400 leading-relaxed mb-4">
      <div class="flex justify-between gap-8"><span class="text-gray-500">App</span><span class="text-gray-300">GradeTrack dashboard</span></div>
      <div class="flex justify-between gap-8"><span class="text-gray-500">Last data update</span><span class="text-gray-300">${escapeHtml(state.lastUpdated || '—')}</span></div>
      <div class="flex justify-between gap-8"><span class="text-gray-500">Settings storage</span><span class="text-gray-300">Saved on the app server</span></div>
    </div>

    <div id="readme-card" class="rounded-xl border border-[#22222e] overflow-hidden">
      <div class="flex items-center justify-between gap-3 px-3 py-2.5 bg-[#16161f] border-b border-[#22222e]">
        <div class="flex items-center gap-2 text-xs font-semibold text-gray-200 min-w-0">
          ${icon('book','w-3.5 h-3.5 text-blue-400')} Project README
        </div>
        <div class="flex items-center gap-1.5 flex-shrink-0">
          <button type="button" id="readme-copy-btn" onclick="copyReadme()" class="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-medium bg-[#0a0a0f] border border-[#22222e] text-gray-300 hover:text-white hover:border-blue-500/40 transition-colors">${icon('clipboard','w-3 h-3')} Copy</button>
          <button type="button" id="readme-expand-btn" onclick="openReadmeModal()" class="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-medium bg-blue-500/15 border border-blue-500/25 text-blue-300 hover:bg-blue-500/25 transition-colors">${icon('external','w-3 h-3')} Expand</button>
        </div>
      </div>
      <div class="relative">
        <div id="readme-preview" class="md-readme max-h-56 overflow-hidden px-4 py-3 cursor-pointer" onclick="copyReadme()" title="Click anywhere to copy the README"></div>
        <div class="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-[#12121b] to-transparent"></div>
      </div>
    </div>

    <p class="text-[10px] text-gray-600 mt-2 leading-relaxed">Served live from <code class="ai-ic">README.md</code>. <span class="text-gray-400">Click the preview</span> or <span class="text-gray-400">Copy</span> to grab the raw markdown, <span class="text-gray-400">Expand</span> to read the full file.</p>`;

  return `
    <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5 mb-4">
      <h3 class="text-sm font-semibold text-gray-200 mb-1">Theme</h3>
      <p class="text-xs text-gray-500 mb-3">Applies across every view. Also togglable from the settings header.</p>
      <div class="inline-flex items-center gap-1 bg-[#0a0a0f] border border-[#22222e] rounded-xl p-1">
        ${themeBtn('dark', 'Dark')}
        ${themeBtn('light', 'Light')}
      </div>
    </div>

    <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5 mb-4">
      <h3 class="text-sm font-semibold text-gray-200 mb-1">Data year</h3>
      <p class="text-xs text-gray-500 mb-3">Show a previous year's grades while you model or build. Only affects what the dashboard displays — it never touches the scraper or the live files. Switch back to the current year anytime.</p>
      <select id="settings-display-year" onchange="changeDisplayYear(this)"
        class="styled-select">
        ${availableYearOptions()}
      </select>
    </div>

    ${settingsAccordion('gen_reviews', 'star', '#22c55e', 'Review', 'Levels climb and quiz delay between wrong answers.', reviewBody)}
    ${settingsAccordion('gen_about', 'dots', '#64748b', 'README', 'App details and the full project README.', aboutBody)}
  `;
}


function availableYearOptions() {
  const years = state.availableYears || [];
  const current = years[0] || '';
  const active = state.displayYear || '';
  const curLabel = current ? `Current (${escapeHtml(current)})` : 'Current';
  const curOpt = `<option value=""${!active ? ' selected' : ''}>${curLabel}</option>`;
  const opts = years.filter(y => y !== current).map(y =>
    `<option value="${escapeHtml(y)}"${active === y ? ' selected' : ''}>${escapeHtml(y)}</option>`
  ).join('');
  return curOpt + opts;
}

window.changeDisplayYear = function(sel) {
  const next = sel.value || '';
  if (next === (state.displayYear || '')) return;
  scheduleSettingsSave('general');
};

// ─── README (About pane) ────────────────────────────────────────
let readmeMarkdown = null;

async function fetchReadme() {
  if (readmeMarkdown != null) return readmeMarkdown;
  try {
    const res = await fetch('/api/readme');
    const data = await res.json().catch(() => ({}));
    readmeMarkdown = data.markdown || '';
  } catch (err) {
    readmeMarkdown = '';
  }
  return readmeMarkdown;
}

function renderReadme(md) {
  const source = String(md || '');
  if (!window.marked) return escapeHtml(source).replace(/\n/g, '<br>');
  let html = window.marked.parse(source, { gfm: true, breaks: true });
  html = html.replace(/<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, inner) => {
    if (/^(https?:|mailto:)/i.test(href)) {
      return `<a href="${href}" target="_blank" rel="noopener">${inner}</a>`;
    }
    return `<span class="md-file-ref" title="${escapeHtml(href)}">${inner}</span>`;
  });
  return window.DOMPurify ? window.DOMPurify.sanitize(html) : html;
}

async function initReadmeTab() {
  const preview = document.getElementById('readme-preview');
  if (!preview) return;
  const md = await fetchReadme();
  if (!md) {
    preview.innerHTML = '<div class="text-xs text-gray-600 py-2">README not available.</div>';
    return;
  }
  preview.innerHTML = renderReadme(md);
}
window.initReadmeTab = initReadmeTab;

window.copyReadme = async function() {
  const md = await fetchReadme();
  if (!md) {
    showToast('README not available', 'error');
    return;
  }
  try {
    await navigator.clipboard.writeText(md);
    showToast('README copied to clipboard');
  } catch (err) {
    showToast('Could not copy README', 'error');
  }
};

window.openReadmeModal = async function() {
  const overlay = document.getElementById('modal-overlay');
  const container = document.getElementById('modal-container');
  if (!overlay || !container) return;
  const md = await fetchReadme();
  overlay.classList.remove('hidden');
  container.innerHTML = `
    <div class="bg-[#12121b] border border-[#22222e] rounded-2xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden shadow-2xl">
      <div class="flex items-center justify-between gap-3 p-6 border-b border-[#22222e] shrink-0">
        <div class="flex items-center gap-3 min-w-0">
          <span class="w-10 h-10 rounded-xl flex items-center justify-center bg-[#16161f] text-blue-400 flex-shrink-0">${icon('book','w-5 h-5')}</span>
          <div class="min-w-0">
            <h3 class="text-lg font-semibold text-white">GradeTrack README</h3>
            <p class="text-xs text-gray-500 mt-0.5">${md ? md.split('\n').length.toLocaleString() : 0} lines · served live from README.md</p>
          </div>
        </div>
        <div class="flex items-center gap-2 flex-shrink-0">
          <button onclick="copyReadme()" class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[#0a0a0f] border border-[#22222e] text-gray-300 hover:text-white hover:border-blue-500/40 transition-colors">${icon('clipboard','w-3.5 h-3.5')} Copy</button>
          <button onclick="closeModal()" class="w-9 h-9 rounded-lg flex items-center justify-center text-gray-500 hover:text-white hover:bg-[#1c1c26] transition-colors" title="Close">${icon('x','w-5 h-5')}</button>
        </div>
      </div>
      <div class="md-readme overflow-y-auto p-6">${md ? renderReadme(md) : '<p class="text-xs text-gray-500">README not available.</p>'}</div>
    </div>`;
};

async function loadOllamaModels() {
  const input = document.getElementById('settings-ollama-model');
  const list = document.getElementById('ollama-model-list');
  const refresh = document.getElementById('ollama-models-refresh');
  const status = document.getElementById('ai-models-status');
  if (!input) return;
  const current = input.value || state.computed?.settings?.ollamaModel || 'gpt-oss:120b';
  if (status) status.textContent = 'Loading model list…';
  if (refresh) refresh.innerHTML = `${icon('restart','w-3.5 h-3.5')} Loading…`;
  let models = [], error = '';
  try {
    const res = await fetch('/api/ollama/models');
    const data = await res.json().catch(() => ({}));
    models = Array.isArray(data?.models) ? data.models : [];
    error = data?.error || '';
  } catch (err) {
    error = err.message || 'Could not load models';
  }
  const seen = new Set();
  OLLAMA_MODEL_FALLBACKS.concat(models).forEach(m => { if (m) seen.add(m); });
  seen.add(current);
  list.innerHTML = Array.from(seen).map(m => `<option value="${escapeHtml(m)}"></option>`).join('');
  if (status) {
    status.className = 'text-xs flex-shrink-0 ' + (error ? 'text-amber-400' : 'text-gray-500');
    status.textContent = error
      ? `Live list unavailable — ${error}. Showing curated models.`
      : models.length ? `${models.length} live models` : '';
  }
  if (refresh) refresh.innerHTML = `${icon('restart','w-3.5 h-3.5')} Refresh`;
}
window.loadOllamaModels = loadOllamaModels;

window.ollamaModelsRefresh = async function() {
  const refresh = document.getElementById('ollama-models-refresh');
  if (refresh) refresh.disabled = true;
  try {
    await loadOllamaModels();
  } finally {
    if (refresh) refresh.disabled = false;
  }
};

window.testAIConnection = async function() {
  const btn = document.getElementById('ai-test-btn');
  const status = document.getElementById('ai-test-status');
  if (btn) btn.disabled = true;
  if (status) { status.textContent = 'Testing…'; status.className = 'text-xs text-gray-500'; }
  try {
    const res = await fetch('/api/insights/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Reply with exactly: OK', conversation: [] })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (status) { status.textContent = data.detail || 'Test failed'; status.className = 'text-xs text-red-400'; }
      return;
    }
    if (status) { status.textContent = data.answer || 'Connected'; status.className = 'text-xs text-green-400'; }
  } catch (err) {
    if (status) { status.textContent = 'Network error: ' + (err.message || err); status.className = 'text-xs text-red-400'; }
  } finally {
    if (btn) btn.disabled = false;
  }
};

window.clearPerClassGoals = function() {
  document.querySelectorAll('[data-per-class-goal]').forEach(i => {
    const range = document.querySelector(`[data-per-class-goal-range="${i.dataset.perClassGoal}"]`);
    const goal = parseInt(i.placeholder, 10) || 90;
    i.value = '';
    if (range) range.value = goal;
  });
  scheduleSettingsSave('general');
};

// --- Account ---
function renderSettingsAccount() {
  const pic = state.profilePicture || '';
  const initial = ((state.userName || 'A').trim().charAt(0) || 'A').toUpperCase();
  return `
    ${settingsAccordion('account_profile', 'user', '#3b82f6', 'Profile', 'Picture, display name, and position. Shows in the sidebar.', `
      <div class="flex items-center gap-4 mb-4">
        <div id="settings-profile-preview" class="w-16 h-16 rounded-full overflow-hidden flex items-center justify-center text-lg font-bold text-white flex-shrink-0 ${pic ? '' : 'bg-gradient-to-br from-blue-500 to-purple-600'}"
          ${pic ? `style="background-image:url('${escapeHtml(pic)}'); background-size:cover; background-position:center;"` : ''}>
          ${pic ? '' : escapeHtml(initial)}
        </div>
        <div class="flex flex-col gap-2 flex-1 min-w-0">
          <label class="cursor-pointer inline-flex items-center gap-1.5 bg-[#0a0a0f] border border-[#22222e] rounded-lg px-3 py-1.5 text-xs text-gray-200 hover:border-blue-500/30 hover:text-blue-300 transition-colors w-fit">
            ${icon('upload','w-3.5 h-3.5')} Upload picture
            <input id="settings-profile-file" type="file" accept="image/*" class="hidden" onchange="handleProfilePictureUpload(this)">
          </label>
          ${pic ? `<button type="button" onclick="removeProfilePicture()" class="inline-flex items-center gap-1.5 text-xs text-gray-500 hover:text-red-400 transition-colors w-fit">${icon('trash','w-3.5 h-3.5')} Remove picture</button>` : ''}
        </div>
      </div>
      <div class="space-y-3">
        <div>
          <label class="text-xs text-gray-500 mb-1 block">Display name</label>
          <input id="settings-user-name" type="text" value="${escapeHtml(state.userName || '')}" placeholder="Your name" maxlength="40"
            oninput="scheduleSettingsSave('account')"
            class="w-full px-3 py-2 bg-[#0a0a0f] border border-[#22222e] rounded-xl text-sm text-gray-200 placeholder-gray-600">
        </div>
        <div>
          <label class="text-xs text-gray-500 mb-1 block">Position</label>
          <input id="settings-user-position" type="text" value="${escapeHtml(state.userPosition || '')}" placeholder="e.g. Student, Teacher, Parent" maxlength="40"
            oninput="scheduleSettingsSave('account')"
            class="w-full px-3 py-2 bg-[#0a0a0f] border border-[#22222e] rounded-xl text-sm text-gray-200 placeholder-gray-600">
        </div>
      </div>
    `)}

    ${settingsAccordion('account_creds', 'lock', '#8b5cf6', 'Login credentials', 'Change the username and password used to sign in.', `
      <div class="flex items-center justify-end mb-3">
        <span class="text-xs text-gray-500 flex items-center gap-1">${icon('lock','w-3 h-3')} Signed in as <span class="text-gray-300 font-medium ml-1" id="settings-current-username">…</span></span>
      </div>
      <div class="space-y-3">
        <div>
          <label class="text-xs text-gray-500 mb-1 block">Username</label>
          <input id="settings-auth-username" type="text" autocomplete="username" spellcheck="false"
            class="w-full px-3 py-2 bg-[#0a0a0f] border border-[#22222e] rounded-xl text-sm text-gray-200 placeholder-gray-600">
        </div>
        <div>
          <label class="text-xs text-gray-500 mb-1 block">Current password (required to save changes)</label>
          <input id="settings-auth-current" type="password" autocomplete="current-password" placeholder="Enter current password"
            class="w-full px-3 py-2 bg-[#0a0a0f] border border-[#22222e] rounded-xl text-sm text-gray-200 placeholder-gray-600 font-mono">
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label class="text-xs text-gray-500 mb-1 block">New password <span class="text-gray-600">(min 8 chars)</span></label>
            <input id="settings-auth-new" type="password" autocomplete="new-password" placeholder="Leave blank to keep"
              class="w-full px-3 py-2 bg-[#0a0a0f] border border-[#22222e] rounded-xl text-sm text-gray-200 placeholder-gray-600 font-mono">
          </div>
          <div>
            <label class="text-xs text-gray-500 mb-1 block">Confirm new password</label>
            <input id="settings-auth-confirm" type="password" autocomplete="new-password" placeholder="Re-enter new password"
              class="w-full px-3 py-2 bg-[#0a0a0f] border border-[#22222e] rounded-xl text-sm text-gray-200 placeholder-gray-600 font-mono">
          </div>
        </div>
        <div class="flex items-center gap-3 pt-1">
          <button type="button" onclick="saveCredentials()" id="settings-auth-save-btn" class="flex items-center gap-2 bg-blue-500/20 border border-blue-500/30 rounded-xl px-4 py-2 text-sm text-blue-400 hover:bg-blue-500/30 transition-all font-medium">${icon('check','w-3.5 h-3.5')} Update credentials</button>
          <span id="settings-auth-status" class="text-xs text-gray-500"></span>
        </div>
      </div>
    `)}

    ${settingsAccordion('account_signout', 'external', '#ef4444', 'Sign out', 'Clear your sign-in cookie and return to the login page.', `
      <div class="flex items-center justify-between gap-3">
        <p class="text-xs text-gray-500 leading-relaxed">You'll need to sign in again to use this dashboard.</p>
        <form id="logout-form" method="post" action="/logout" class="m-0">
          <button type="submit" class="flex items-center gap-2 bg-red-500/15 border border-red-500/30 rounded-xl px-4 py-2 text-sm text-red-300 hover:bg-red-500/25 transition-all font-medium">${icon('external','w-3.5 h-3.5')} Sign out</button>
        </form>
      </div>
    `)}
  `;
}

// ─── PROFILE (picture, display name, position) ──────────────────────────────

function updateSidebarUserInfo() {
  const avatar = document.getElementById('sidebar-avatar');
  const name = document.getElementById('sidebar-name');
  const position = document.getElementById('sidebar-position');
  // While the settings fetch hasn't landed, show pulsing skeleton blocks so
  // the user doesn't see a placeholder avatar / "User" name flash before their
  // real profile picture and name arrive.
  if (!state.profileLoaded) {
    if (avatar) {
      avatar.className = 'w-9 h-9 rounded-full bg-[#22222e] flex-shrink-0 user-avatar animate-pulse';
      avatar.style.backgroundImage = '';
      avatar.textContent = '';
    }
    if (name) {
      name.textContent = '';
      name.className = 'h-3.5 w-24 bg-[#22222e] rounded animate-pulse truncate';
    }
    if (position) {
      position.textContent = '';
      position.className = 'h-3 w-16 bg-[#22222e] rounded animate-pulse mt-2';
      position.style.display = '';
    }
    return;
  }
  const pic = state.profilePicture || '';
  const displayName = (state.userName || '').trim();
  const displayPos = (state.userPosition || '').trim();
  const fallback = (displayName || 'A').charAt(0).toUpperCase();
  if (avatar) {
    avatar.className = 'w-9 h-9 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-xs font-bold text-white shadow-lg flex-shrink-0 user-avatar';
    avatar.style.backgroundSize = 'cover';
    avatar.style.backgroundPosition = 'center';
    if (pic) {
      avatar.style.backgroundImage = `url('${pic}')`;
      avatar.textContent = '';
    } else {
      avatar.style.backgroundImage = '';
      avatar.textContent = fallback;
    }
  }
  if (name) {
    name.className = 'text-sm font-semibold text-gray-200 truncate';
    name.textContent = displayName || 'User';
  }
  if (position) {
    position.className = 'text-xs text-gray-500';
    position.textContent = displayPos || '';
    position.style.display = displayPos ? '' : 'none';
  }
}

window.handleProfilePictureUpload = function(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) {
    showToast('Profile picture must be under 8 MB', 'error');
    input.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      // Downscale to a small avatar (256px max on the long edge) and re-encode
      // as JPEG so the saved data URL stays small — typical photos drop from
      // a couple of MB to a few tens of KB.
      const MAX_DIM = 256;
      let w = img.width, h = img.height;
      if (w > MAX_DIM || h > MAX_DIM) {
        if (w > h) { h = Math.max(1, Math.round(h * (MAX_DIM / w))); w = MAX_DIM; }
        else { w = Math.max(1, Math.round(w * (MAX_DIM / h))); h = MAX_DIM; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      let dataUrl;
      try {
        dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      } catch (_) {
        dataUrl = String(e.target?.result || '');
      }
      // If the compressed result is still too big (>200 KB), try harder.
      if (dataUrl.length > 200 * 1024) {
        try {
          const smaller = canvas.toDataURL('image/jpeg', 0.65);
          if (smaller.length < dataUrl.length) dataUrl = smaller;
        } catch (_) {}
      }
      state.profilePicture = dataUrl;
      updateSidebarUserInfo();
      render();
      scheduleSettingsSave('account');
    };
    img.onerror = () => { showToast('Could not read that image', 'error'); input.value = ''; };
    img.src = e.target?.result;
  };
  reader.onerror = () => { showToast('Could not read that file', 'error'); input.value = ''; };
  reader.readAsDataURL(file);
};

window.removeProfilePicture = function() {
  state.profilePicture = '';
  updateSidebarUserInfo();
  render();
  scheduleSettingsSave('account');
};

// Page-lifecycle: re-render status text after re-renders so "Saved 2m ago" stays fresh.
let _settingsStatusTimer = null;
function startSettingsStatusTimer() {
  if (_settingsStatusTimer) return;
  _settingsStatusTimer = setInterval(() => {
    if (state.currentView === 'settings') SETTINGS_BUCKETS.forEach(t => updateSectionStatus(t));
  }, 15000);
}
startSettingsStatusTimer();

// Open palette shortcut is also exposed on Ctrl+K from anywhere in the app once settings is visible.
// (Cmd+listener is set at top of section.)
function jumpToSettings(sec) {
  const target = SETTINGS_LEGACY_MAP[sec] || sec;
  const panelId = SETTINGS_SECTION_RENDER[target]?.panelId;
  if (state.settingsView !== target) {
    state.settingsView = target;
    render();
  }
  if (panelId) {
    requestAnimationFrame(() => {
      const el = document.getElementById(panelId);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
}
window.jumpToSettings = jumpToSettings;


async function loadCurrentCredentials() {
  try {
    const res = await fetch('/api/auth');
    if (!res.ok) return;
    const data = await res.json();
    const unameEl = document.getElementById('settings-current-username');
    const inputEl = document.getElementById('settings-auth-username');
    if (unameEl) unameEl.textContent = data.username || '';
    if (inputEl && data.username) inputEl.value = data.username;
  } catch (err) {
    console.warn('Could not load current credentials:', err);
  }
}

window.saveCredentials = async function() {
  const statusEl = document.getElementById('settings-auth-status');
  const btn = document.getElementById('settings-auth-save-btn');
  const username = document.getElementById('settings-auth-username')?.value.trim() || '';
  const currentPassword = document.getElementById('settings-auth-current')?.value || '';
  const newPassword = document.getElementById('settings-auth-new')?.value || '';
  const confirmPassword = document.getElementById('settings-auth-confirm')?.value || '';

  if (!username) return setStatus(statusEl, 'error', 'Username cannot be empty.');
  if (!currentPassword) return setStatus(statusEl, 'error', 'Enter your current password to save changes.');
  if (newPassword && newPassword.length < 8) return setStatus(statusEl, 'error', 'New password must be at least 8 characters.');
  if (newPassword && newPassword !== confirmPassword) return setStatus(statusEl, 'error', 'New password and confirmation do not match.');

  if (btn) btn.disabled = true;
  setStatus(statusEl, '', 'Saving…');

  try {
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, currentPassword, newPassword: newPassword || undefined })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setStatus(statusEl, 'error', data.detail || 'Could not update credentials.');
      return;
    }
    document.getElementById('settings-auth-current').value = '';
    document.getElementById('settings-auth-new').value = '';
    document.getElementById('settings-auth-confirm').value = '';
    setStatus(statusEl, 'ok', data.passwordChanged ? 'Username and password updated.' : 'Username updated.');
    loadCurrentCredentials();
  } catch (err) {
    setStatus(statusEl, 'error', 'Network error: ' + (err.message || err));
  } finally {
    if (btn) btn.disabled = false;
  }
};

function setStatus(el, kind, msg) {
  if (!el) return;
  el.textContent = msg;
  el.className = 'text-xs ' + (kind === 'error' ? 'text-red-400' : kind === 'ok' ? 'text-green-400' : 'text-gray-500');
}



// ─── NOTE QUIZ ENGINE (split-view, line coloring, retry loop) ───────────────

const NOTE_QUIZ = {
  set: null,
  index: 0,
  answers: {},          // {questionId: chosenIndex}
  splitPct: 50,         // % width of left pane (notes)
  showSplit: false,
  retryMode: false,
  retryIndices: [],     // question indices to include in retry
  startTime: 0,
  shuffles: {},         // {questionId: [shuffled order array]}
};

function _nqEsc(s) { return escapeHtml(s == null ? '' : String(s)); }

function _nqLineKey(s) {
  // Trivial stable hash for line lookup.
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}

function _nqRenderLoading() {
  const el = document.getElementById('view-container');
  if (!el) return;
  el.innerHTML = `
    <div class="h-[calc(100vh-3rem)] lg:h-[calc(100vh-4rem)] flex flex-col items-center justify-center gap-3">
      <span class="animate-spin inline-block w-6 h-6 border-2 border-blue-400/30 border-t-blue-400 rounded-full"></span>
      <div class="text-sm text-gray-400">Loading quiz…</div>
    </div>`;
}

window.openNoteQuiz = async function(setId) {
  const id = parseInt(setId, 10);
  if (!id) return showToast('Bad set id', 'error');
  window._nqActive = true;               // render() guard: auto-refresh must not wipe the quiz
  state.noteQuizReturnView = state.currentView || 'planner';
  _nqRenderLoading();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(`/api/note_quiz/sets/${id}`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error((await res.json()).detail || 'Could not load set');
    const data = await res.json();
    NOTE_QUIZ.set = data;
    NOTE_QUIZ.index = 0;
    NOTE_QUIZ.answers = {};
    NOTE_QUIZ.lineColors = {};        // persisted across renders
    NOTE_QUIZ.showSplit = false;
    NOTE_QUIZ.splitPct = 50;
    NOTE_QUIZ.retryMode = false;
    NOTE_QUIZ.retryIndices = [];
    NOTE_QUIZ.startTime = Date.now();
    NOTE_QUIZ.shuffles = {};
    for (const q of (data.questions || [])) {
      const order = [0, 1, 2, 3];
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      NOTE_QUIZ.shuffles[q.id] = order;
    }
    _nqShowQuestion();
  } catch (err) {
    window._nqActive = false;
    const ret = state.noteQuizReturnView || 'planner';
    state.noteQuizReturnView = null;
    showToast(err.message || 'Could not open quiz', 'error');
    navigate(ret);
  }
};

// Phases used by the manual-generate UI to show progress.
window._nqProgress = null;  // { classId, phase, startedAt }

window._nqRenderProgressBanner = function() {
  // Banner above the manual-list grid showing the current pipeline stage
  // for whichever class is generating right now.
  const banner = document.getElementById('nq-progress-banner');
  if (!banner) return;
  const p = window._nqProgress;
  if (!p) {
    banner.innerHTML = '';
    banner.classList.add('hidden');
    return;
  }
  const cls = (state.computed?.activeClasses || []).find(c => String(c.id) === String(p.classId));
  const name = cls ? (cls.shortName || cls.name) : 'this class';
  const elapsed = Math.round((Date.now() - p.startedAt) / 1000);
  const phases = {
    'starting': 'Starting…',
    'fetching': `Pulling ${name} notes from Trilium…`,
    'diffing': 'Comparing against the last quiz (looking for new lines)…',
    'ai': 'Asking Ollama to write questions — this can take 10–30 seconds…',
    'saving': 'Saving the quiz…',
    'done': `Quiz ready for ${name}!`,
  };
  const label = phases[p.phase] || 'Working…';
  const isDone = p.phase === 'done';
  banner.classList.remove('hidden');
  banner.innerHTML = `
    <div class="flex items-center gap-3 px-4 py-2.5 mb-3 rounded-xl border ${isDone ? 'border-green-500/30 bg-green-500/10' : 'border-blue-500/30 bg-blue-500/10'} transition-colors">
      ${isDone
        ? `<span class="w-5 h-5 flex items-center justify-center text-green-400">${icon('check','w-4 h-4')}</span>`
        : `<span class="w-5 h-5 flex items-center justify-center"><span class="animate-spin inline-block w-4 h-4 border-2 border-blue-400/30 border-t-blue-400 rounded-full"></span></span>`}
      <div class="flex-1 min-w-0">
        <div class="text-sm ${isDone ? 'text-green-300' : 'text-blue-200'}">${_nqEsc(label)}</div>
        ${!isDone ? `<div class="text-[11px] text-gray-500 mt-0.5">Elapsed: ${elapsed}s</div>` : ''}
      </div>
      ${!isDone ? `<button type="button" onclick="window._nqCancelGenerate()" class="text-xs text-gray-500 hover:text-gray-300">Cancel</button>` : ''}
    </div>`;
};

window._nqSetProgress = function(classId, phase) {
  if (phase === null) {
    window._nqProgress = null;
  } else if (phase === 'starting') {
    window._nqProgress = { classId, phase, startedAt: Date.now() };
  } else if (window._nqProgress) {
    window._nqProgress.phase = phase;
  }
  // Update the button's appearance.
  const btn = document.querySelector(`[data-nq-manual-btn="${classId}"]`);
  if (btn) {
    const inFlight = phase && phase !== 'done' && phase !== null;
    if (inFlight) {
      btn.setAttribute('disabled', 'true');
      btn.classList.add('opacity-60', 'pointer-events-none');
      btn.innerHTML = `
        <span class="w-2.5 h-2.5 rounded-full flex-shrink-0" style="background:${classColorFor(classId)}"></span>
        <span class="text-sm text-gray-200 truncate flex-1">${_nqEsc((state.computed?.activeClasses?.find(c=>String(c.id)===String(classId))?.shortName)||'Generating')}</span>
        <span class="text-xs text-blue-300 inline-flex items-center gap-1.5">
          <span class="animate-spin inline-block w-3 h-3 border-2 border-blue-400/30 border-t-blue-400 rounded-full"></span>
          Working…
        </span>`;
    } else {
      btn.removeAttribute('disabled');
      btn.classList.remove('opacity-60', 'pointer-events-none');
      // Re-render the review grid to restore the class card's Generate button
      // and show any newly-generated quiz in the note-quiz section.
      if (typeof renderReviewGrid === 'function' && state.blooketClasses) {
        renderReviewGrid(state.blooketClasses, state.blooketCustomSets);
      }
    }
  }
  window._nqRenderProgressBanner();
  // Keep elapsed counter fresh.
  if (window._nqProgress && window._nqProgress.phase !== 'done') {
    if (!window._nqProgress._tick) {
      window._nqProgress._tick = setInterval(() => {
        if (window._nqProgress) window._nqRenderProgressBanner();
      }, 500);
    }
  } else if (window._nqProgress?._tick) {
    clearInterval(window._nqProgress._tick);
    delete window._nqProgress._tick;
  }
};

window._nqCancelGenerate = function() {
  if (!window._nqProgress) return;
  // Visually reset; we can't actually cancel the in-flight fetch easily, but
  // we can mark it cancelled and the UI will snap back when the request finishes.
  const cid = window._nqProgress.classId;
  window._nqSetProgress(cid, null);
  showToast('Generation will stop when the current step finishes.', 'info');
};


// ─── AI PROMPTS EDITOR (inline in Settings → Connections & AI) ─────────────
//
// Renders into `#ai-prompts-body` inside the Connections/AI settings tab. The
// textareas carry `data-prompt-text="<key>"` so `collectSettingsFromDOM()` can
// autosave them through the normal settings flow (settings.prompts[key]).
// Prompts are keyed by `settings.prompts[key]` and override the hardcoded
// defaults in `prompts.py`. An empty value (or the Reset button) reverts to
// the default.

window.loadPromptsMeta = async function() {
  try {
    const res = await fetch('/api/prompts');
    if (!res.ok) throw new Error('Could not load prompts');
    const data = await res.json();
    state.promptsMeta = {};
    (data.prompts || []).forEach(p => { state.promptsMeta[p.key] = p; });
  } catch (err) {
    state.promptsMeta = state.promptsMeta || {};
  }
  renderAiPromptsBody();
};

function renderAiPromptsBody() {
  const body = document.getElementById('ai-prompts-body');
  if (!body) return;
  const metas = state.promptsMeta || {};
  const keys = Object.keys(metas);
  if (!keys.length) {
    body.innerHTML = `<p class="text-xs text-gray-500">Could not load prompts.</p>`;
    return;
  }
  const ACCENTS = {
    note_quiz_generate: { icon: 'sparkle',   color: '#3b82f6' },
    note_quiz_user:     { icon: 'file',      color: '#6366f1' },
    blooket_system:     { icon: 'play',      color: '#10b981' },
    grade_coach_chat:   { icon: 'send',      color: '#8b5cf6' },
    grade_coach_insights: { icon: 'trend',   color: '#f59e0b' },
  };
  const DEFAULT_ACCENT = { icon: 'sparkle', color: '#3b82f6' };

  body.innerHTML = `
    <div class="space-y-4">
      ${keys.map(key => {
        const meta = metas[key] || {};
        const accent = ACCENTS[key] || DEFAULT_ACCENT;
        const custom = (state.prompts && state.prompts[key] && state.prompts[key].trim()) ? true : false;
        const current = custom ? state.prompts[key] : (meta.current || meta.default || '');
        return `
          <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5" data-prompt-section="${_nqEsc(key)}">
            <div class="flex items-start justify-between gap-3">
              <div class="flex items-start gap-3 min-w-0">
                <span class="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style="background:${accent.color}1a;color:${accent.color}">${icon(accent.icon,'w-4 h-4')}</span>
                <div class="min-w-0">
                  <div class="flex flex-wrap items-center gap-2">
                    <h3 class="text-sm font-semibold text-gray-200">${_nqEsc(meta.name || key)}</h3>
                    <span class="inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-medium uppercase tracking-wider ${custom ? 'bg-blue-500/15 text-blue-400' : 'bg-[#1c1c26] text-gray-500'}">${custom ? 'Custom' : 'Default'}</span>
                  </div>
                  <p class="text-xs text-gray-500 mt-0.5 leading-relaxed">${_nqEsc(meta.description || '')}</p>
                  <p class="text-[10px] uppercase tracking-wider text-gray-600 mt-1.5">Key: <code class="text-gray-400">${_nqEsc(key)}</code></p>
                </div>
              </div>
              <button type="button" onclick="window.resetPromptEditor('${_nqEsc(key)}')" title="Revert this prompt to its built-in default"
                class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium text-gray-500 hover:text-gray-300 hover:bg-[#22222e] border border-[#22222e] transition-colors flex-shrink-0">${icon('restart','w-3 h-3')} Reset</button>
            </div>
            <div class="mt-4">
              <label class="text-xs text-gray-500 mb-1 block">Prompt</label>
              <textarea data-prompt-text="${_nqEsc(key)}" rows="9" spellcheck="false"
                oninput="scheduleSettingsSave('connections'); this.removeAttribute('data-prompt-reset')"
                class="w-full px-3 py-2.5 bg-[#0a0a0f] border border-[#22222e] rounded-xl text-[12px] font-mono text-gray-200 leading-relaxed focus:outline-none focus:border-blue-500/50 focus:ring-2 focus:ring-blue-500/15 transition-all resize-y"
                style="min-height: 200px;">${_nqEsc(current)}</textarea>
            </div>
            <details class="mt-3">
              <summary class="inline-flex items-center gap-1.5 text-[11px] text-gray-500 hover:text-gray-300 cursor-pointer select-none">${icon('file','w-3 h-3')} Show built-in default</summary>
              <pre class="mt-2 px-3 py-2 bg-[#0a0a0f] border border-[#22222e] rounded-lg text-[11px] font-mono text-gray-500 whitespace-pre-wrap break-words">${_nqEsc(meta.default || '')}</pre>
            </details>
          </div>`;
      }).join('')}
    </div>`;
}

window.resetPromptEditor = function(key) {
  const meta = state.promptsMeta?.[key];
  const ta = document.querySelector(`[data-prompt-text="${key}"]`);
  if (!meta || !ta) return;
  ta.value = meta.default || '';
  ta.dataset.promptReset = '1';
  scheduleSettingsSave('connections');
};

window.openNoteQuizForClass = async function(classId) {
  // Manual trigger: start a background generation job, then poll it so the
  // "Working… / Saving…" state always resolves (toast + grid refresh on both
  // success and failure — no more stuck spinner until page reload).
  const cls = (state.computed?.activeClasses || []).find(c => String(c.id) === String(classId));
  const name = cls ? (cls.shortName || cls.name) : 'this class';
  window._nqSetProgress(classId, 'starting');
  let jobId = null;
  try {
    const r = await fetch('/api/note_quiz/sets/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ classId }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || 'Generation failed to start');
    if (data.setId) {
      // Backward-compatible: a sync-style endpoint returned the set directly.
      window._nqSetProgress(classId, 'done');
      showToast(`Quiz ready for ${name}`, 'success');
      await _nqRefreshTodayList();
      setTimeout(() => window._nqSetProgress(classId, null), 2500);
      return;
    }
    jobId = data.jobId;
    if (!jobId) throw new Error('No job id returned');
  } catch (err) {
    window._nqSetProgress(classId, null);
    showToast(err.message || 'Could not start generation', 'error');
    return;
  }

  const startedAt = Date.now();
  const maxWaitMs = 6 * 60 * 1000;
  const poll = (id) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    return fetch(`/api/note_quiz/sets/jobs/${id}`, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
  };
  while (Date.now() - startedAt < maxWaitMs) {
    let job;
    try {
      const jr = await poll(jobId);
      if (!jr.ok) throw new Error('status ' + jr.status);
      job = await jr.json();
    } catch (_) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      continue;
    }
    if (job.status === 'done') {
      window._nqSetProgress(classId, 'done');
      showToast(`Quiz ready for ${name}`, 'success');
      await _nqRefreshTodayList();
      setTimeout(() => window._nqSetProgress(classId, null), 2500);
      return;
    }
    if (job.status === 'error') {
      window._nqSetProgress(classId, null);
      showToast(job.error || 'Generation failed', 'error');
      return;
    }
    window._nqSetProgress(classId, { fetching: 'fetching', diffing: 'diffing', ai: 'ai', saving: 'saving' }[job.phase] || 'ai');
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  window._nqSetProgress(classId, null);
  showToast('Generation is still running — it will appear here when it finishes.', 'info');
};

function _nqVisibleQuestions() {
  if (!NOTE_QUIZ.retryMode) return NOTE_QUIZ.set.questions;
  return NOTE_QUIZ.retryIndices.map(i => NOTE_QUIZ.set.questions[i]);
}

function _nqShowQuestion() {
  const qs = _nqVisibleQuestions();
  if (!qs.length) {
    _nqShowResults();
    return;
  }
  if (NOTE_QUIZ.index >= qs.length) {
    _nqShowResults();
    return;
  }
  const q = qs[NOTE_QUIZ.index];
  const lines = NOTE_QUIZ.set.sourceLines || [];
  const lineStart = q.noteLineStart;
  const lineEnd = q.noteLineEnd;
  const lineState = (NOTE_QUIZ.set.lines || []).find(l => l.lineStart === lineStart && l.lineEnd === lineEnd);
  const lineColor = lineState ? lineState.colorState : 'pending';
  const isAnswered = NOTE_QUIZ.answers[q.id] != null;
  const picked = isAnswered ? NOTE_QUIZ.answers[q.id] : null;
  const correct = q.correctIndex;
  const light = isLightTheme();

  // Choices: 2x2 grid matching the main review app's shape (blooket-quiz.js
  // style: large rounded tiles with color-coded badges, red flash on wrong,
  // green pop on right, click anywhere / Enter / 1-4 / a-d to continue).
  const shuffle = NOTE_QUIZ.shuffles[q.id] || [0, 1, 2, 3];
  // Match the main quiz's per-option color band (blue / violet / teal / amber)
  // by display index so the daily quiz feels identical to the blooket review.
  const optStyles = (typeof QUIZ_OPTION_STYLES !== 'undefined' && QUIZ_OPTION_STYLES.length)
    ? QUIZ_OPTION_STYLES
    : [
        { badge: 'bg-blue-500/20 text-blue-300', rest: 'border-blue-500/40 bg-blue-500/10 text-blue-200 hover:bg-blue-500/15', lightBadge: 'bg-blue-600/10 text-blue-700', lightRest: 'border-blue-500/50 bg-blue-500/10 text-blue-800 hover:bg-blue-500/15' },
        { badge: 'bg-violet-500/20 text-violet-300', rest: 'border-violet-500/40 bg-violet-500/10 text-violet-200 hover:bg-violet-500/15', lightBadge: 'bg-violet-600/10 text-violet-700', lightRest: 'border-violet-500/50 bg-violet-500/10 text-violet-800 hover:bg-violet-500/15' },
        { badge: 'bg-teal-500/20 text-teal-300', rest: 'border-teal-500/40 bg-teal-500/10 text-teal-200 hover:bg-teal-500/15', lightBadge: 'bg-teal-600/10 text-teal-700', lightRest: 'border-teal-500/50 bg-teal-500/10 text-teal-800 hover:bg-teal-500/15' },
        { badge: 'bg-amber-500/20 text-amber-300', rest: 'border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/15', lightBadge: 'bg-amber-600/10 text-amber-700', lightRest: 'border-amber-500/50 bg-amber-500/10 text-amber-800 hover:bg-amber-500/15' },
      ];
  const choices = shuffle.map((origIdx, displayIdx) => {
    const opt = q.choices[origIdx];
    const st = optStyles[displayIdx % optStyles.length];
    let cls = '';
    let delayAttr = '';
    if (isAnswered) {
      if (origIdx === correct) {
        cls = 'quiz-pop bg-green-500 border-green-500 text-white';
      } else if (origIdx === picked) {
        cls = light ? 'quiz-flash bg-red-500/15 border-red-500 text-red-700' : 'quiz-flash bg-red-500/30 border-red-500 text-red-200';
      } else {
        cls = light ? 'opacity-40 border-[#d9dde7] bg-white text-gray-500' : 'opacity-40 border-[#22222e] bg-[#16161f] text-gray-400';
      }
    } else {
      cls = light ? st.lightRest : st.rest;
      delayAttr = ` style="animation-delay:${displayIdx * 40}ms"`;
    }
    return `<button type="button" onclick="window._nqPick(${q.id}, ${displayIdx})" data-nq-choice="${displayIdx}"
      class="w-full h-full flex items-center justify-center text-center rounded-xl border px-4 sm:px-5 py-4 sm:py-6 text-lg sm:text-xl md:text-2xl font-medium break-words transition-all duration-150 ${cls} ${isAnswered ? 'cursor-default' : 'cursor-pointer'}"${delayAttr}>
      <span>${escapeHtml(opt)}</span>
    </button>`;
  }).join('');

  // Notes: each line rendered as HTML (preserving bold/italic/lists), with a
  // smooth background-color highlight on the lines covered by this question.
  // Colors persist across questions via NOTE_QUIZ.lineColors so a line that
  // was answered correctly on Q1 stays green when Q2 highlights other lines.
  NOTE_QUIZ.lineColors = NOTE_QUIZ.lineColors || {};
  const localColor = isAnswered ? (picked === correct ? 'green' : 'red') : null;
  const effectiveColor = localColor || lineColor;
  // Persist the answer's color onto the question's line range so it survives
  // re-renders when the user advances to the next question.
  if (isAnswered && localColor) {
    for (let i = lineStart; i <= lineEnd; i++) {
      NOTE_QUIZ.lineColors[i] = localColor;
    }
  }
  const colorClass = (c) =>
    c === 'green' ? 'nq-line-green'
    : c === 'yellow' ? 'nq-line-yellow'
    : c === 'red' ? 'nq-line-red'
    : c === 'bright_red' ? 'nq-line-bright-red'
    : '';
  const notes = lines.map((l, i) => {
    const isHighlighted = i >= lineStart && i <= lineEnd;
    let hlCls = '';
    // 1) Already-answered line (any prior question): use persisted color.
    const persisted = NOTE_QUIZ.lineColors[i];
    if (persisted) {
      hlCls = colorClass(persisted);
    } else if (isHighlighted) {
      // 2) Current question's range, not yet answered: yellow wash.
      hlCls = 'nq-line-active';
      if (isAnswered) {
        // 3) Current question, just answered: paint with the local color.
        hlCls = colorClass(effectiveColor);
      }
    }
    return `<div data-nq-line="${i}" class="nq-line px-3 py-1.5 flex gap-2 transition-colors duration-200 ${hlCls}">
      <span class="text-gray-600 text-[10px] tabular-nums w-8 text-right flex-shrink-0 pt-0.5">${i + 1}</span>
      <span class="flex-1 text-gray-200 text-sm leading-relaxed nq-line-content">${l.t || '<span class="text-gray-600 italic">(empty)</span>'}</span>
    </div>`;
  }).join('');

  // Footer: matches blooket-quiz.js — "Correct — click anywhere to continue" or
  // "Not quite — the answer is B" + countdown (using state.quizDelay).
  const delay = Math.max(0, parseFloat(state.quizDelay ?? 3) || 0);
  let footer = `<div class="text-xs ${light ? 'text-gray-500' : 'text-gray-500'} text-center">Pick an answer — or press <span class="${light ? 'text-gray-700' : 'text-gray-400'} font-medium">1–${(q.choices || []).length || 4}</span></div>`;
  if (isAnswered) {
    if (picked === correct) {
      footer = `<div class="text-sm ${light ? 'text-green-600' : 'text-green-400'} font-medium text-center">Correct — click anywhere to continue</div>`;
    } else {
      const letter = String.fromCharCode(65 + correct);
      footer = `<div class="text-center">
        <div class="text-sm ${light ? 'text-red-600' : 'text-red-400'} font-medium">Not quite — the answer is ${letter}.</div>
        ${delay > 0
          ? `<div class="text-xs ${light ? 'text-gray-500' : 'text-gray-500'} mt-1" id="nq-countdown">Locked — continue in ${Math.ceil(delay)}s</div>`
          : `<div class="text-xs ${light ? 'text-gray-500' : 'text-gray-500'} mt-1">Click anywhere to continue</div>`}
      </div>`;
    }
  }

  const progress = `${NOTE_QUIZ.index + 1} / ${qs.length}`;
  const modal = `
    <div id="nq-view" class="h-[calc(100vh-5px)] p-[5px] flex flex-col min-h-0 bg-[#0a0a0f] border border-[#22222e] rounded-2xl overflow-hidden cursor-pointer">
      <div class="flex-1 flex flex-col min-h-0">
        <div class="flex items-center justify-between gap-3 px-4 py-3 border-b border-[#22222e] bg-[#12121b]">
          <div class="min-w-0 flex items-center gap-2">
            ${icon('sparkle','w-4 h-4 text-blue-400')}
            <span class="text-sm font-semibold text-white truncate">${_nqEsc(NOTE_QUIZ.set.className || '')} — ${_nqEsc(NOTE_QUIZ.set.title || NOTE_QUIZ.set.chapterTitle || 'Notes')}</span>
            ${NOTE_QUIZ.retryMode ? '<span class="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-yellow-500/15 border border-yellow-500/30 text-yellow-300">retry</span>' : ''}
          </div>
          <div class="flex items-center gap-2 flex-shrink-0">
            <span class="text-xs text-gray-500 tabular-nums">${progress}</span>
            <button type="button" onclick="event.stopPropagation(); window._nqToggleSplit()" class="px-2.5 py-1 rounded-lg text-xs font-medium ${NOTE_QUIZ.showSplit ? 'bg-blue-500/15 border border-blue-500/30 text-blue-300' : 'bg-[#12121b] border border-[#22222e] text-gray-400'} transition-colors">${NOTE_QUIZ.showSplit ? 'Hide notes' : 'Show notes'}</button>
            <button type="button" onclick="event.stopPropagation(); window._nqClose()" class="w-8 h-8 rounded-lg bg-[#12121b] border border-[#22222e] text-gray-400 hover:text-white flex items-center justify-center">${icon('x','w-4 h-4')}</button>
          </div>
        </div>
        <div class="flex-1 flex min-h-0">
          ${NOTE_QUIZ.showSplit ? `
            <div id="nq-left" class="overflow-y-auto border-r border-[#22222e]" style="width:${NOTE_QUIZ.splitPct}%">
              <div class="px-4 py-3 sticky top-0 bg-[#0a0a0f] border-b border-[#22222e] text-[11px] text-gray-500 uppercase tracking-wider">Notes</div>
              <div class="py-2">${notes}</div>
            </div>
            <div id="nq-resizer" onmousedown="window._nqStartResize(event)" class="w-1.5 cursor-col-resize bg-[#16161f] hover:bg-blue-500/30 transition-colors"></div>
          ` : ''}
          <div class="flex-1 flex flex-col min-h-0 p-[5px]">
            <div class="flex items-center gap-3">
              <div class="min-w-0 flex-1">
                <div class="text-[11px] uppercase tracking-wider text-gray-500">Question ${NOTE_QUIZ.index + 1} of ${qs.length}</div>
              </div>
              <div class="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-gray-500 flex-shrink-0">
                ${NOTE_QUIZ.retryMode ? '<span class="text-yellow-300 font-semibold">retry</span>' : ''}
              </div>
            </div>
            <div class="flex-1 flex flex-col justify-center py-2 min-h-0">
              <h2 class="text-2xl sm:text-3xl md:text-4xl font-semibold leading-snug text-center ${light ? 'text-gray-900' : 'text-white'} mb-6 sm:mb-8 quiz-in flex-1 flex items-center justify-center">${escapeHtml(q.prompt)}</h2>
              <div id="nq-options" class="grid grid-cols-1 sm:grid-cols-2 flex-1" style="gap:3px;padding:3px">${choices}</div>
            </div>
            <div id="nq-footer" class="min-h-10 py-3">${footer}</div>
          </div>
        </div>
      </div>
    </div>`;
  const host = document.getElementById('view-container');
  if (!host) return;
  host.innerHTML = modal;
  // Make sure the green-pop / red-flash animations are loaded so the answer
  // feedback matches the main review app exactly.
  if (typeof window._ensureQuizCss === 'function') window._ensureQuizCss();
  // Wire up document-level shortcuts so the daily quiz behaves exactly like
  // the main blooket review (Enter / Space / 1-4 / a-d / Escape, click anywhere
  // to continue once the answer is shown).
  document.removeEventListener('click', window._nqGlobalClick);
  document.removeEventListener('keydown', window._nqGlobalKeydown);
  document.addEventListener('click', window._nqGlobalClick);
  document.addEventListener('keydown', window._nqGlobalKeydown);
  if (NOTE_QUIZ.showSplit) {
    requestAnimationFrame(() => {
      const target = document.querySelector(`[data-nq-line="${lineStart}"]`);
      if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }
  // Bump tick token so any old countdown from a prior question clears.
  NOTE_QUIZ._tickToken = (NOTE_QUIZ._tickToken || 0) + 1;
  // Auto-advance countdown for wrong answers (mirror blooket-quiz.js).
  // Guarded by a fresh token so it doesn't double-fire if the user clicks
  // the backdrop during the countdown.
  NOTE_QUIZ._locked = false;
  if (isAnswered && picked !== correct) {
    const d = Math.max(0, parseFloat(state.quizDelay ?? 3) || 0);
    if (d > 0) {
      NOTE_QUIZ._locked = true;
      NOTE_QUIZ._tickToken = (NOTE_QUIZ._tickToken || 0) + 1;
      const myToken = NOTE_QUIZ._tickToken;
      const cdEl = document.getElementById('nq-countdown');
      let remaining = d;
      const tick = setInterval(() => {
        remaining -= 0.1;
        if (cdEl) cdEl.textContent = `Locked — continue in ${Math.max(0, remaining).toFixed(1)}s`;
        if (remaining <= 0 || NOTE_QUIZ._tickToken !== myToken) {
          clearInterval(tick);
          if (remaining <= 0 && NOTE_QUIZ._tickToken === myToken) {
            NOTE_QUIZ._locked = false;
            window._nqNext();
          }
        }
      }, 100);
    }
  }
}

window._nqPick = function(questionId, choiceIndex) {
  if (NOTE_QUIZ.answers[questionId] != null) return;
  const shuffle = NOTE_QUIZ.shuffles[questionId] || [0, 1, 2, 3];
  const originalIndex = shuffle[choiceIndex];
  NOTE_QUIZ.answers[questionId] = originalIndex;
  // The synthesized click on the choice will bubble up; swallow the very next
  // document-level click so the user sees the correct/wrong feedback before
  // the quiz auto-advances.
  NOTE_QUIZ._ignoreNextClick = true;
  _nqShowQuestion();
};

window._nqContinue = function(questionId) {
  // Kept for back-compat; the document-level click handler does the advance.
  if (NOTE_QUIZ.answers[questionId] == null) return;
  window._nqNext();
};

window._nqNext = function() {
  const qs = _nqVisibleQuestions();
  if (NOTE_QUIZ.index < qs.length - 1) {
    NOTE_QUIZ.index++;
    _nqShowQuestion();
  } else {
    _nqShowResults();
  }
};

// Document-level click: advances the quiz once the current question is
// answered (mirrors blooket-quiz.js's click-anywhere-to-continue). The pick
// click triggers a swallow flag so a single click picks AND continues instead
// of skipping the answer altogether.
window._nqGlobalClick = function(ev) {
  if (!window._nqActive || !NOTE_QUIZ.set) return;
  const qs = _nqVisibleQuestions();
  if (!qs.length) return;
  const q = qs[NOTE_QUIZ.index];
  if (!q) return;
  // Ignore the click that picked an answer (without this the picker would
  // also trigger an immediate "continue" and skip showing the feedback).
  // Note: the choice button deliberately does NOT call stopPropagation so the
  // document handler can see this click and consume the swallow flag.
  if (NOTE_QUIZ._ignoreNextClick) { NOTE_QUIZ._ignoreNextClick = false; return; }
  if (NOTE_QUIZ.answers[q.id] == null) return;
  // If the user just answered wrong, wait for the countdown to elapse.
  if (NOTE_QUIZ._locked) return;
  window._nqNext();
};

// Document-level keyboard: matches the main review app's shortcuts.
window._nqGlobalKeydown = function(e) {
  if (!window._nqActive || !NOTE_QUIZ.set) return;
  const qs = _nqVisibleQuestions();
  if (!qs.length) return;
  const q = qs[NOTE_QUIZ.index];
  if (!q) return;
  if (e.key === 'Escape') { e.preventDefault(); window._nqClose(); return; }
  if (NOTE_QUIZ.answers[q.id] != null) {
    if (NOTE_QUIZ._locked) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); window._nqNext(); }
    return;
  }
  // Unanswered: pick by 1-4 / a-d.
  const map = { '1': 0, '2': 1, '3': 2, '4': 3, a: 0, b: 1, c: 2, d: 3 };
  const k = e.key.length === 1 ? e.key.toLowerCase() : '';
  if (k in map && map[k] < (q.choices || []).length) {
    e.preventDefault();
    window._nqPick(q.id, map[k]);
  }
};

window._nqToggleSplit = function() {
  NOTE_QUIZ.showSplit = !NOTE_QUIZ.showSplit;
  _nqShowQuestion();
};

window._nqClose = function() {
  window._nqActive = false;
  document.removeEventListener('click', window._nqGlobalClick);
  document.removeEventListener('keydown', window._nqGlobalKeydown);
  const ret = state.noteQuizReturnView || 'planner';
  state.noteQuizReturnView = null;
  // Refresh today's note quizzes so the review cards reflect completion.
  _nqRefreshTodayList();
  navigate(ret);
};

window._nqStartResize = function(ev) {
  ev.preventDefault();
  const onMove = (e) => {
    const total = document.getElementById('view-container')?.clientWidth || window.innerWidth;
    const pct = Math.max(20, Math.min(80, (e.clientX / total) * 100));
    NOTE_QUIZ.splitPct = pct;
    const left = document.getElementById('nq-left');
    if (left) left.style.width = pct + '%';
  };
  const onUp = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
};

async function _nqShowResults() {
  const setId = NOTE_QUIZ.set.id;
  // In retry mode, fill in the user's prior correct answers for non-retry
  // questions so the backend can score every question (unanswered = wrong
  // would falsely mark already-mastered questions as missed).
  const answers = { ...NOTE_QUIZ.answers };
  if (NOTE_QUIZ.retryMode) {
    for (const q of NOTE_QUIZ.set.questions) {
      if (!(q.id in answers)) answers[q.id] = q.correctIndex;
    }
  }
  let result;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch('/api/note_quiz/attempts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setId, answers, durationSeconds: Math.round((Date.now() - NOTE_QUIZ.startTime) / 1000) }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error('Save failed');
    result = await res.json();
  } catch (err) {
    showToast('Could not save attempt', 'error');
  }
  // Update local line colors so the next view reflects state.
  if (result && Array.isArray(result.lineOutcomes)) {
    for (const o of result.lineOutcomes) {
      const line = (NOTE_QUIZ.set.lines || []).find(l => l.lineStart === o.lineStart && l.lineEnd === o.lineEnd);
      if (line) line.colorState = o.colorAfter;
    }
  }
  // Render results view with line colorings (smooth background, not borders).
  // Prefer persisted live colors from NOTE_QUIZ.lineColors so what the user
  // sees matches what they saw during the quiz, then fall back to server state.
  const qs = _nqVisibleQuestions();
  const lines = NOTE_QUIZ.set.sourceLines || [];
  NOTE_QUIZ.lineColors = NOTE_QUIZ.lineColors || {};
  const colorClass = (c) =>
    c === 'green' ? 'nq-line-green'
    : c === 'yellow' ? 'nq-line-yellow'
    : c === 'red' ? 'nq-line-red'
    : c === 'bright_red' ? 'nq-line-bright-red'
    : '';
  const linesView = lines.map((l, i) => {
    const persisted = NOTE_QUIZ.lineColors[i];
    const line = (NOTE_QUIZ.set.lines || []).find(x => i >= x.lineStart && i <= x.lineEnd);
    const color = persisted || (line ? line.colorState : null);
    return `<div class="nq-line px-3 py-1.5 flex gap-2 transition-colors duration-200 ${color ? colorClass(color) : ''}">
      <span class="text-gray-600 text-[10px] tabular-nums w-8 text-right flex-shrink-0 pt-0.5">${i + 1}</span>
      <span class="flex-1 text-gray-200 text-sm leading-relaxed nq-line-content">${l.t || '<span class="text-gray-600 italic">(empty)</span>'}</span>
    </div>`;
  }).join('');
  const score = result ? `${result.score}/${result.total}` : '?/?';
  const missedCount = qs.filter((q, i) => {
    const realIdx = NOTE_QUIZ.retryMode ? NOTE_QUIZ.retryIndices[i] : i;
    const realQ = NOTE_QUIZ.set.questions[realIdx];
    return NOTE_QUIZ.answers[realQ.id] !== realQ.correctIndex;
  }).length;
  const modal = `
    <div id="nq-view" class="h-[calc(100vh-3rem)] lg:h-[calc(100vh-4rem)] flex flex-col min-h-0 bg-[#0a0a0f] border border-[#22222e] rounded-2xl overflow-hidden">
      <div class="flex items-center justify-between gap-3 px-4 py-3 border-b border-[#22222e] bg-[#12121b]">
        <div class="text-sm font-semibold text-white">${NOTE_QUIZ.retryMode ? 'Retry results' : 'Quiz results'}</div>
        <button type="button" onclick="window._nqClose()" class="w-8 h-8 rounded-lg bg-[#12121b] border border-[#22222e] text-gray-400 hover:text-white flex items-center justify-center">${icon('x','w-4 h-4')}</button>
      </div>
      <div class="flex-1 overflow-y-auto">
        <div class="max-w-3xl mx-auto px-6 py-6">
          <div class="flex items-baseline justify-between mb-4">
            <div>
              <div class="text-2xl font-bold text-white">Score ${score}</div>
              <div class="text-xs text-gray-500 mt-1">${missedCount === 0 ? 'All correct — mastered.' : `${missedCount} question${missedCount > 1 ? 's' : ''} to retry.`}</div>
            </div>
            <div class="flex items-center gap-2">
              ${missedCount > 0 ? `<button type="button" onclick="window._nqStartRetry()" class="px-3 py-1.5 rounded-lg text-xs font-medium bg-yellow-500/15 border border-yellow-500/40 text-yellow-300 hover:bg-yellow-500/25">Review missed (${missedCount})</button>` : ''}
              <button type="button" onclick="window._nqClose()" class="px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-500/20 border border-blue-500/40 text-blue-300 hover:bg-blue-500/30">Done</button>
            </div>
          </div>
          <div class="rounded-xl border border-[#22222e] overflow-hidden">
            <div class="px-3 py-2 bg-[#16161f] text-[11px] text-gray-500 uppercase tracking-wider border-b border-[#22222e]">Notes with line states</div>
            <div class="py-2">${linesView}</div>
          </div>
        </div>
      </div>
    </div>`;
  const host = document.getElementById('view-container');
  if (!host) return;
  host.innerHTML = modal;
}

window._nqStartRetry = function() {
  const qs = NOTE_QUIZ.set.questions;
  NOTE_QUIZ.retryIndices = [];
  for (let i = 0; i < qs.length; i++) {
    if (NOTE_QUIZ.answers[qs[i].id] !== qs[i].correctIndex) {
      NOTE_QUIZ.retryIndices.push(i);
    }
  }
  NOTE_QUIZ.retryMode = true;
  NOTE_QUIZ.index = 0;
  // Clear answers only for retry questions, so the original first-attempt data persists server-side.
  for (const i of NOTE_QUIZ.retryIndices) {
    delete NOTE_QUIZ.answers[qs[i].id];
  }
  _nqShowQuestion();
};

async function _nqRefreshTodayList() {
  try {
    const res = await fetch('/api/note_quiz/today?_=' + Date.now());
    if (!res.ok) return;
    const data = await res.json();
    state.noteQuizToday = {};
    for (const s of (data.sets || [])) {
      const key = String(s.classId || '');
      if (!state.noteQuizToday[key]) state.noteQuizToday[key] = [];
      state.noteQuizToday[key].push(s);
    }
    if (typeof renderReviewGrid === 'function' && state.blooketClasses) {
      renderReviewGrid(state.blooketClasses, state.blooketCustomSets);
    }
  } catch (_) {}
}

// ─── NOTE QUIZ CALENDAR (toggle + per-day dots + past-day list) ─────────────

window._nqSetCalendarMode = function(mode) {
  if (mode !== 'notequiz' && mode !== 'assignments') return;
  if (state.calendarMode === mode) return;
  state.calendarMode = mode;
  // If switching to notequiz and we have no cached data for the current month, fetch it.
  if (mode === 'notequiz') {
    const y = state.calendarYear;
    const m = state.calendarMonth + 1;
    if (!state.noteQuizCalendar || state.noteQuizCalendar.year !== y || state.noteQuizCalendar.month !== m) {
      // Fire-and-forget; _renderNoteQuizCalendar handles missing data.
      fetch(`/api/note_quiz/calendar?year=${y}&month=${m}`).then(r => r.ok ? r.json() : null).then(data => {
        if (data) state.noteQuizCalendar = data;
      }).catch(() => {});
    }
  }
  render();
};

async function _loadNoteQuizCalendar() {
  const y = state.calendarYear;
  const m = state.calendarMonth + 1; // API expects 1-12
  try {
    const res = await fetch(`/api/note_quiz/calendar?year=${y}&month=${m}`);
    if (!res.ok) throw new Error('Could not load calendar');
    state.noteQuizCalendar = await res.json();
  } catch (err) {
    state.noteQuizCalendar = { year: y, month: m, days: [] };
  }
  // Re-render the calendar view so the dots show.
  render();
}

function _renderNoteQuizCalendarDayCell(dateStr, day, year, month) {
  const dayData = (state.noteQuizCalendar?.days || []).find(d => d.date === dateStr);
  const status = dayData ? (dayData.status || 'none') : 'none';
  const now = new Date();
  const isToday = now.getFullYear() === year && now.getMonth() === month && now.getDate() === day;
  const isSelected = state.calendarSelectedDate === dateStr;
  const dotColor = status === 'green' ? '#22c55e'
    : status === 'yellow' ? '#facc15'
    : status === 'red' ? '#ef4444'
    : status === 'bright_red' ? '#fb7185'
    : status === 'pending' ? '#3b82f6'
    : '#3a3a4a';
  // Per-class mini bars: class color + tiny accuracy ring (like the review cards).
  const classBars = (dayData?.classes || []).map(cls => {
    const color = classColorFor(cls.classId);
    const ring = cls.firstTryPct != null
      ? `<span title="${_nqEsc(cls.className)} — first try ${cls.firstTryPct}%">${ringPct(cls.firstTryPct, 22, accRingColor(cls.firstTryPct))}</span>`
      : `<span class="w-[22px] h-[22px] rounded-full border border-[#33334a] flex items-center justify-center" title="${_nqEsc(cls.className)} — not played yet"><span class="w-1.5 h-1.5 rounded-full" style="background:${color}"></span></span>`;
    return `<div class="flex items-center gap-1 min-w-0" title="${_nqEsc(cls.className)}: ${cls.setCount} set${cls.setCount === 1 ? '' : 's'}${cls.firstTryPct != null ? ' · first try ' + cls.firstTryPct + '%' : ''}">
      <span class="w-[3px] h-3 rounded-full flex-shrink-0" style="background:${color}"></span>
      <span class="text-[9px] text-gray-500 truncate min-w-0 leading-tight">${_nqEsc(cls.className)}</span>
      ${ring}
    </div>`;
  }).join('');
  const title = dayData
    ? `${dayData.setCount} set(s), ${dayData.completionPct}% correct, ${dayData.redCount} red / ${dayData.yellowCount} yellow / ${dayData.greenCount} green`
    : 'No quiz that day';
  const cls = [
    'cal-day aspect-square p-1 rounded-xl border hover:border-blue-500/30 transition-colors cursor-pointer relative',
    isSelected ? 'selected' : '',
    isToday ? 'today' : '',
  ].filter(Boolean).join(' ');
  const numCls = isToday ? '' : 'text-gray-400';
  return `<div data-date="${dateStr}" class="${cls}" onclick="selectNoteQuizCalendarDay('${dateStr}')" title="${_nqEsc(title)}">
    <div class="cal-day-num text-xs font-medium ${numCls}">${day}</div>
    ${classBars ? `<div class="absolute bottom-1.5 left-1.5 right-1.5 space-y-1 flex flex-col items-start">${classBars}</div>` : ''}
    ${dayData && dayData.setCount > 1 ? `<div class="absolute top-1 right-1 text-[9px] text-gray-500">${dayData.setCount}</div>` : ''}
  </div>`;
}

window.selectNoteQuizCalendarDay = function(dateStr) {
  state.calendarSelectedDate = dateStr;
  render();
};

async function _renderNoteQuizCalendar() {
  const d = state.computed;
  if (!d) return skeleton();
  const year = state.calendarYear, month = state.calendarMonth;
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthPrefix = `${year}-${String(month + 1).padStart(2, '0')}`;
  if (!state.calendarSelectedDate || !state.calendarSelectedDate.startsWith(monthPrefix)) {
    const today = new Date();
    state.calendarSelectedDate = today.getFullYear() === year && today.getMonth() === month
      ? `${monthPrefix}-${String(today.getDate()).padStart(2, '0')}`
      : `${monthPrefix}-01`;
  }
  // Load calendar data if not present or month changed.
  if (!state.noteQuizCalendar || state.noteQuizCalendar.year !== year || state.noteQuizCalendar.month !== month + 1) {
    await _loadNoteQuizCalendar();
  }
  const selected = (state.noteQuizCalendar?.days || []).find(d => d.date === state.calendarSelectedDate);
  const dayDetail = selected ? await _nqDayDetail(selected.date) : null;
  const monthSetCount = (state.noteQuizCalendar?.days || []).reduce((s, d) => s + d.setCount, 0);
  return `
  <div class="flex flex-wrap items-center justify-between gap-4 mb-6">
    <div>
      <h1 class="text-2xl font-bold text-white">Calendar</h1>
      <p class="text-gray-400 mt-1 text-sm">${monthSetCount} note quiz set(s) this month · colored by completion</p>
    </div>
    <div class="flex items-center gap-2 flex-wrap">
      <div class="inline-flex items-center gap-1 bg-[#0a0a0f] border border-[#22222e] rounded-xl p-1">
        <button type="button" onclick="window._nqSetCalendarMode('assignments')" class="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${state.calendarMode !== 'notequiz' ? 'bg-blue-500/15 text-blue-300' : 'text-gray-400 hover:text-gray-200'}">Assignments</button>
        <button type="button" onclick="window._nqSetCalendarMode('notequiz')" class="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${state.calendarMode === 'notequiz' ? 'bg-blue-500/15 text-blue-300' : 'text-gray-400 hover:text-gray-200'}">Note quizzes</button>
      </div>
      <button onclick="state.calendarMonth--; if(state.calendarMonth<0){state.calendarMonth=11;state.calendarYear--;} render()" class="w-8 h-8 rounded-lg bg-[#12121b] border border-[#22222e] flex items-center justify-center text-gray-400 hover:text-white transition-colors">${icon('chevronLeft','w-4 h-4')}</button>
      <span class="text-sm font-medium text-gray-200 w-32 text-center">${['January','February','March','April','May','June','July','August','September','October','November','December'][month]} ${year}</span>
      <button onclick="state.calendarMonth++; if(state.calendarMonth>11){state.calendarMonth=0;state.calendarYear++;} render()" class="w-8 h-8 rounded-lg bg-[#12121b] border border-[#22222e] flex items-center justify-center text-gray-400 hover:text-white transition-colors">${icon('chevronRight','w-4 h-4')}</button>
      <button onclick="state.calendarMonth=new Date().getMonth(); state.calendarYear=new Date().getFullYear(); render()" class="text-xs text-blue-400 hover:text-blue-300 px-3 py-1.5 rounded-lg border border-blue-500/20 bg-blue-500/5">Today</button>
    </div>
  </div>

  <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
    <div class="lg:col-span-2 bg-[#12121b] border border-[#22222e] rounded-2xl p-4">
      <div class="grid grid-cols-7 gap-1">
        ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(dd => `<div class="text-center text-xs font-medium text-gray-500 py-2">${dd}</div>`).join('')}
        ${Array(firstDay).fill(0).map(() => '<div></div>').join('')}
        ${Array(daysInMonth).fill(0).map((_, i) => _renderNoteQuizCalendarDayCell(`${monthPrefix}-${String(i + 1).padStart(2, '0')}`, i + 1, year, month)).join('')}
      </div>
    </div>

    <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5">
      <div class="flex items-center justify-between mb-3">
        <div class="text-sm font-semibold text-white">${selected ? state.calendarSelectedDate : 'No day selected'}</div>
        ${selected ? `<span class="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${
          selected.status === 'green' ? 'bg-green-500/15 border border-green-500/40 text-green-300' :
          selected.status === 'yellow' ? 'bg-yellow-500/15 border border-yellow-500/40 text-yellow-300' :
          selected.status === 'red' ? 'bg-red-500/15 border border-red-500/40 text-red-300' :
          selected.status === 'pending' ? 'bg-blue-500/15 border border-blue-500/40 text-blue-300' :
          'bg-[#16161f] border border-[#22222e] text-gray-400'
        }">${selected.status || 'none'}</span>` : ''}
      </div>
      ${dayDetail ? dayDetail : '<div class="text-sm text-gray-500">Click a day to see the quizzes you took (or missed).</div>'}
    </div>
  </div>`;
}

async function _nqDayDetail(dateStr) {
  try {
    const res = await fetch(`/api/note_quiz/sets/by-date?date=${dateStr}`);
    if (!res.ok) return '<div class="text-sm text-red-400">Could not load day.</div>';
    const data = await res.json();
    const sets = data.sets || [];
    if (!sets.length) return '<div class="text-sm text-gray-500">No note quizzes generated that day.</div>';
    const groups = {};
    for (const s of sets) {
      const key = String(s.classId || '');
      if (!groups[key]) groups[key] = { className: s.className || 'Unknown', color: classColorFor(s.classId), items: [] };
      groups[key].items.push(s);
    }
    return Object.values(groups).map(g => `
      <div class="mb-3">
        <div class="flex items-center gap-2 mb-1.5 px-1">
          <span class="w-1 h-3 rounded-full flex-shrink-0" style="background:${g.color}"></span>
          <span class="text-xs font-semibold text-gray-300 truncate">${_nqEsc(g.className)}</span>
          <span class="text-[10px] text-gray-600 flex-shrink-0">${g.items.length} set${g.items.length === 1 ? '' : 's'}</span>
        </div>
        ${g.items.map(s => `
        <div class="mb-2 p-3 bg-[#0a0a0f] border border-[#22222e] rounded-xl flex items-center gap-3">
          <div class="min-w-0 flex-1">
            <div class="text-sm text-gray-200 truncate">${_nqEsc(s.title || s.chapterTitle || '')}</div>
            <div class="text-[11px] text-gray-500">${s.lineCount} new lines · ${(s.generatedAt || '').slice(11, 16)}${s.questionCount ? ' · ' + s.questionCount + ' questions' : ''}</div>
          </div>
          <div class="flex items-center gap-2 flex-shrink-0">
            ${s.firstTryPct != null ? `
              <div title="First try: ${s.firstTryPct}% correct">${ringPct(s.firstTryPct, 26, accRingColor(s.firstTryPct), true)}</div>` : ''}
            <button type="button" onclick="window.openNoteQuiz(${s.id})" class="text-xs text-blue-300 hover:text-blue-200 flex-shrink-0">Take / retake →</button>
          </div>
        </div>`).join('')}
      </div>`).join('');
  } catch (_) {
    return '<div class="text-sm text-red-400">Could not load day.</div>';
  }
}

// ─── NOTE QUIZ OVERVIEW WIDGET ─────────────────────────────────────────────

async function _nqRenderOverviewWidget() {
  let stats = { todayCount: 0, streak: 0, perClass: [] };
  let today = { sets: [] };
  try {
    const [sr, tr] = await Promise.all([
      fetch('/api/note_quiz/stats').then(r => r.json()).catch(() => stats),
      fetch('/api/note_quiz/today').then(r => r.json()).catch(() => today),
    ]);
    stats = sr || stats;
    today = tr || today;
  } catch (_) {}

  // dashboard_stats returns perClass as a dict {classId: {...}}; normalize to array.
  const perClassArr = Array.isArray(stats.perClass)
    ? stats.perClass
    : Object.values(stats.perClass || {});

  // Only show streaks for classes the user actually has this year — legacy
  // classes (e.g. Biology from a prior year) may still have old sets.
  const activeIds = new Set((state.computed?.activeClasses || []).map(c => String(c.id)));
  const knownPerClass = perClassArr.filter(pc => activeIds.has(String(pc.classId)));

  const perClassBars = knownPerClass.slice(0, 6).map(pc => {
    const pct = Math.min(100, (pc.streak || 0) * 14);
    return `<div class="flex items-center gap-2" title="${pc.streak || 0}-day streak for ${_nqEsc(pc.className)}">
      <span class="text-[11px] text-gray-400 truncate w-24 flex-shrink-0">${_nqEsc(pc.className)}</span>
      <div class="flex-1 h-1.5 rounded-full bg-[#16161f] overflow-hidden">
        <div class="h-full rounded-full bg-blue-500/60 transition-all duration-500" style="width:${pct}%"></div>
      </div>
      <span class="text-[10px] text-gray-500 w-6 text-right tabular-nums">${pc.streak || 0}d</span>
    </div>`;
  }).join('');
  const todayList = (today.sets || []).map(s => {
    const color = classColorFor(s.classId);
    return `<button type="button" onclick="window.openNoteQuiz(${s.id})" class="w-full text-left px-3 py-2 rounded-lg border transition-colors flex items-center gap-2" style="border-color:${color}1a; background:${color}08; box-shadow:inset 2px 0 0 ${color}44;" onmouseover="this.style.borderColor='${color}33'" onmouseout="this.style.borderColor='${color}1a'">
      <span class="w-2 h-2 rounded-full flex-shrink-0" style="background:${color}"></span>
      <span class="flex-1 min-w-0">
        <span class="block text-xs text-gray-200 truncate">${_nqEsc(s.title || s.chapterTitle || s.className || 'Note quiz')}</span>
        <span class="block text-[10px] text-gray-500 truncate" style="color:${color}">${_nqEsc(s.className || '')}</span>
      </span>
      <span class="text-[10px] text-blue-300">Take →</span>
    </button>`;
  }).join('');

  const html = `
    <div class="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4">
      <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5">
        <div class="flex items-center gap-2 mb-2">
          ${icon('sparkle','w-4 h-4 text-blue-400')}
          <div class="text-xs text-gray-500 uppercase tracking-wider">Note quizzes</div>
        </div>
        <div class="text-2xl font-bold text-white">${stats.todayCount}</div>
        <div class="text-[11px] text-gray-500 mt-1">ready today · ${stats.streak}-day streak</div>
      </div>
      <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5">
        <div class="text-xs text-gray-500 uppercase tracking-wider mb-2">Per-class streaks</div>
        ${perClassBars || '<div class="text-[11px] text-gray-500">Enable note quizzes for a class in Settings to start tracking.</div>'}
      </div>
      <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5">
        <div class="text-xs text-gray-500 uppercase tracking-wider mb-2">Today's quizzes</div>
        ${todayList || '<div class="text-[11px] text-gray-500">Nothing ready yet. Today\'s quizzes appear here as each class ends.</div>'}
      </div>
    </div>`;

  // Re-acquire the element AFTER the await: if render() ran during the fetch
  // it would have replaced our original element reference with a new one.
  const el = document.getElementById('note-quiz-overview-widget');
  if (el) el.innerHTML = html;
}

// ─── NOTE QUIZ CARD MENU (delete / recreate) ──────────────────────────────

window.toggleNoteQuizMenu = function(setId) {
  state.noteQuizMenuOpen = state.noteQuizMenuOpen === setId ? null : setId;
  if (typeof renderReviewGrid === 'function' && state.blooketClasses) {
    renderReviewGrid(state.blooketClasses, state.blooketCustomSets);
  }
};

window.deleteNoteQuiz = async function(setId) {
  state.noteQuizMenuOpen = null;
  const ok = await confirmAction({
    title: 'Delete quiz set?',
    message: 'This cannot be undone.',
    confirmText: 'Delete',
    danger: true,
    icon: 'trash',
  });
  if (!ok) return;
  try {
    const res = await fetch(`/api/note_quiz/sets/${setId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    await _nqRefreshTodayList();
  } catch (err) {
    showToast('Failed to delete: ' + err.message, 'error');
  }
};

window.recreateNoteQuiz = function(setId, chapterNoteId, classId) {
  state.noteQuizMenuOpen = null;
  state._recreateSetId = setId;
  state._recreateChapterNoteId = chapterNoteId;
  state._recreateClassId = classId;
  state._recreateClarification = '';
  state._recreatePopupOpen = true;
  render();
};

window._closeRecreatePopup = function() {
  state._recreatePopupOpen = false;
  state._recreateSetId = null;
  state._recreateChapterNoteId = '';
  state._recreateClassId = '';
  state._recreateClarification = '';
  render();
};

window._submitRecreate = async function() {
  const setId = state._recreateSetId;
  const classId = state._recreateClassId;
  const clarification = (state._recreateClarification || '').trim();
  state._recreatePopupOpen = false;
  render();
  if (!classId) return;
  try {
    // Delete the old quiz FIRST so the snapshot check sees all notes as new.
    await fetch(`/api/note_quiz/sets/${setId}`, { method: 'DELETE' });
    const genRes = await fetch('/api/note_quiz/sets/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ classId, clarification: clarification || undefined })
    });
    if (!genRes.ok) throw new Error((await genRes.json().catch(() => ({}))).detail || 'HTTP ' + genRes.status);
    const { jobId } = await genRes.json();
    let result = null;
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const poll = await fetch(`/api/note_quiz/sets/jobs/${jobId}`);
      if (!poll.ok) continue;
      const job = await poll.json();
      if (job.status === 'done' || job.status === 'error') { result = job; break; }
    }
    if (result && result.status === 'done' && result.setId) {
      await _nqRefreshTodayList();
    } else {
      alert('Recreate failed: ' + (result?.error || 'Timed out'));
    }
  } catch (err) {
    alert('Recreate failed: ' + err.message);
  }
};
