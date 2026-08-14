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

function openBlooketFlow(classId, className, chapterTitle) {
  if (_blooketPollTimer) { clearInterval(_blooketPollTimer); _blooketPollTimer = null; }
  _blooketCtx = {
    classId: classId || '',
    className: className || 'Class',
    chapterTitle: chapterTitle || '',
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
  const failed = !!data.error || ((data.exitCode !== 0 && data.exitCode !== null && data.exitCode !== undefined) && !r.setUrl);
  if (failed) {
    target.innerHTML = `<div class="inline-flex items-center gap-2 rounded-full border border-red-500/30 bg-[#12121b] px-3 py-1.5 shadow-lg">${icon('alert','w-3.5 h-3.5 text-red-400')}<span class="text-xs text-red-300">Publish failed</span></div>`;
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
  const transientHtml = data.transientError
    ? `<span class="text-[10px] text-gray-500 flex items-center gap-1 flex-shrink-0">${icon('alert','w-3 h-3')}reconnecting…</span>`
    : '';
  const html = `<div class="inline-flex items-center gap-2 rounded-full border border-[#22222e] bg-[#12121b] px-3 py-1.5 shadow-lg"><span class="w-4 h-4 flex-shrink-0 animate-spin border-2 border-purple-400 border-t-transparent rounded-full"></span><span class="text-xs text-white font-medium">${active}…</span>${transientHtml}</div>`;
  if (target.innerHTML === html) return; // keep the spinner smooth, don't replace unchanged DOM each poll
  target.innerHTML = html;
}

// ─── BLOOKET ERROR MODAL (crashes / publish failures) ───────────
let _blooketErrorData = null;

function showBlooketErrorModal(data) {
  const r = data.result || {};
  const error = r.error || 'The Blooket publish failed — see the logs below.';
  const logs = data.logs || [];
  _blooketErrorData = { error, logs };
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
    const res = await fetch('/api/blooket/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ classId: ctx.classId, prompt, setUrl }) });
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
    if (_blooketCtx) _blooketCtx.lastStatus = data;
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
  return `<a href="${triliumWebUrl(link.noteId)}" target="_blank" rel="noopener" title="Open class notes in Trilium" class="flex items-center gap-1 px-2 py-1 rounded-lg ${themeChoice('bg-[#12121b] border-[#22222e] text-gray-400 hover:text-blue-300 hover:border-blue-500/30', 'bg-white border-[#d9dde7] text-gray-600 hover:text-blue-700 hover:border-blue-400/40')} border text-[10px] font-medium transition-colors">${icon('book','w-3 h-3')} Notes</a>`;
}



// ─── SETTINGS (tabbed shell + autosave + Cmd+K palette) ────────────────────────

const SETTINGS_TABS = [
  { id: 'classes',     label: 'Classes',             icon: 'target' },
  { id: 'connections', label: 'Connections and AI',  icon: 'sparkle' },
  { id: 'data',        label: 'Data & Refresh',      icon: 'clock' },
  { id: 'account',     label: 'Account',             icon: 'user' },
];

// Per-section save UI state (module-scope so it doesn't churn render state).
const SETTINGS_STATUS = {};
SETTINGS_TABS.forEach(t => { SETTINGS_STATUS[t.id] = { dirty: false, saving: false, savedAt: null, error: null }; });
const SETTINGS_DEBOUNCE = {};
SETTINGS_TABS.forEach(t => { SETTINGS_DEBOUNCE[t.id] = null; });

// Search index for Cmd+K palette. elementId takes priority over elementSelector.
const SETTINGS_INDEX = [
  { tab: 'classes', label: 'Default grade goal',    keywords: 'goal threshold target default minimum letter', elementId: 'settings-goal' },
  { tab: 'classes', label: 'Per-class goals',       keywords: 'per class override subject goal',                elementSelector: '[data-per-class-goal]:first-of-type' },
  { tab: 'classes', label: 'Class names',           keywords: 'class names aliases rename short display',        elementSelector: '[data-class-alias]:first-of-type' },
  { tab: 'classes', label: 'Class colors',          keywords: 'class colors palette swatches theme custom',     elementSelector: '[data-class-color]:first-of-type' },
  { tab: 'classes', label: 'Skip classes',          keywords: 'exclude skip omit classes hide',                 elementSelector: '[data-exclude-class]:first-of-type' },
  { tab: 'classes', label: 'Levels-based review',   keywords: 'levels mastery proficiency climb spaced',         elementId: 'settings-levels-enabled' },
  { tab: 'classes', label: 'Quiz review delay',     keywords: 'quiz delay wrong answer seconds wait',            elementId: 'settings-quiz-delay' },
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
  { tab: 'connections', label: 'FACTS SIS API key', keywords: 'facts sis api key secret password',               elementSelector: '[data-apikey="facts"]' },
  { tab: 'connections', label: 'Trilium URL',       keywords: 'trilium etapi url notes',                         elementId: 'trilium-url' },
  { tab: 'connections', label: 'Trilium ETAPI token',keywords: 'trilium token etapi notes secret',               elementId: 'trilium-token' },
  { tab: 'connections', label: 'Test Trilium connection', keywords: 'trilium test connection status ping',       elementId: 'trilium-test-btn' },
  { tab: 'connections', label: 'Search Trilium notes', keywords: 'search notes trilium folder',                  elementId: 'trilium-search-input' },
  { tab: 'account', label: 'Account picture',         keywords: 'profile picture avatar photo upload image',      elementId: 'settings-profile-file' },
  { tab: 'account', label: 'Display name',            keywords: 'name display show user your full first',          elementId: 'settings-user-name' },
  { tab: 'account', label: 'Position',                keywords: 'position title role student teacher parent job', elementId: 'settings-user-position' },
  { tab: 'account', label: 'Update login credentials', keywords: 'update save credentials password username',    elementId: 'settings-auth-save-btn' },
];

// Collapsible settings panels (accordions). module-scope so re-renders keep them open.
const SETTINGS_PANELS = {
  pc_goals: true,     // Per-class goals (most-used; open by default)
  pc_names: false,
  pc_colors: false,   // Visual customization (changed rarely)
  pc_skip: false,
  pc_review: false,   // Levels + Quiz delay (rarely changed)
  pc_notes: false,    // Per-class Trilium linking
  conn_keys: true,    // API keys (user often needs to set these)
  conn_trilium: false,
  ds_refresh: false,  // Run a refresh now (action, not config)
  ds_scrape: true,    // Automatic scrape schedule
  account_profile: true, // Profile picture + display name + position (set on first use)
  account_creds: false,
  account_signout: false,
};

function panelOpen(id) { return SETTINGS_PANELS[id] === true; }
function setPanelOpenUI(id, open) {
  const panel = document.querySelector(`[data-panel="${id}"]`);
  if (!panel) return;
  panel.classList.toggle('collapsed', !open);
  const btn = panel.parentElement?.querySelector('button.accordion-trigger');
  if (btn) {
    btn.setAttribute('aria-expanded', String(open));
    const chev = btn.querySelector('.chevron-icon');
    if (chev) chev.classList.toggle('rotate-180', open);
  }
}

window.toggleSettingsPanel = function(id) {
  const wasOpen = panelOpen(id);
  SETTINGS_PANELS[id] = !wasOpen;
  setPanelOpenUI(id, !wasOpen);
};

function settingsAccordion(id, iconName, iconColor, title, summary, bodyHtml, extra) {
  const open = panelOpen(id);
  return `
  <div class="bg-[#12121b] border border-[#22222e] rounded-2xl mb-4 overflow-hidden">
    <button type="button" onclick="toggleSettingsPanel('${id}')" aria-expanded="${open}"
      class="accordion-trigger w-full flex items-center justify-between gap-3 p-4 hover:bg-[#16161f] text-left">
      <div class="flex items-center gap-3 min-w-0">
        <span class="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style="background:${iconColor}1a;color:${iconColor}">${icon(iconName,'w-4 h-4')}</span>
        <div class="min-w-0">
          <div class="text-sm font-semibold text-gray-200">${title}</div>
          <div class="text-xs text-gray-500 truncate mt-0.5">${summary}</div>
        </div>
      </div>
      <div class="flex items-center gap-2 flex-shrink-0">
        ${extra || ''}
        <span class="chevron-icon text-gray-500 ${open ? 'rotate-180' : ''}">${icon('chevronDown','w-4 h-4')}</span>
      </div>
    </button>
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
        const tabLabel = SETTINGS_TABS.find(t => t.id === it.tab)?.label || it.tab;
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
    const tab = SETTINGS_TABS.find(t => t.id === it.tab);
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
  const tabChanged = state.settingsTab !== tab;
  if (tabChanged) { state.settingsTab = tab; render(); }
  let panelToOpen = null;
  let panelStateChanged = false;
  const el0 = elementId ? document.getElementById(elementId) : (elementSelector ? document.querySelector(elementSelector) : null);
  const panel = el0 && el0.closest ? el0.closest('[data-panel]') : null;
  if (panel) {
    const pid = panel.getAttribute('data-panel');
    if (SETTINGS_PANELS[pid] !== true) {
      SETTINGS_PANELS[pid] = true;
      if (!tabChanged) {
        setPanelOpenUI(pid, true);
        panelToOpen = panel;
        panelStateChanged = true;
      }
    }
  }
  const delay = tabChanged ? 80 : (panelStateChanged ? 290 : 60);
  setTimeout(() => {
    let el = null;
    if (elementId) el = document.getElementById(elementId);
    else if (elementSelector) el = document.querySelector(elementSelector);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      try { el.focus({ preventScroll: true }); } catch (_) {}
      flashElement(el);
    }
  }, delay);
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

function switchSettingsTab(tab) {
  if (state.settingsTab === tab) return;
  state.settingsTab = tab;
  render();
  // Refresh any in-flight status text after re-render (e.g. "Saved 2m ago")
  SETTINGS_TABS.forEach(t => updateSectionStatus(t.id));
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

  return {
    goal, perClassGoals, classAliases, classColors, excludedClassIds,
    apiKeys, ollamaModel, theme: state.theme || 'dark',
    autoRefreshMinutes, quizDelay, levelsEnabled, autoScrape, trilium,
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
  scheduleSettingsSave('classes');
};

window.setClassColorDefault = function(classId) {
  state.classColors = state.classColors || {};
  delete state.classColors[classId];
  refreshColorSwatches(classId);
  scheduleSettingsSave('classes');
};

async function saveSettingsSection(tab) {
  SETTINGS_DEBOUNCE[tab] = null;
  SETTINGS_STATUS[tab].dirty = false;
  SETTINGS_STATUS[tab].saving = true;
  SETTINGS_STATUS[tab].error = null;
  updateSectionStatus(tab);
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
    if (typeof payload.userName === 'string') state.userName = payload.userName;
    if (typeof payload.userPosition === 'string') state.userPosition = payload.userPosition;
    if (typeof payload.profilePicture === 'string') {
      state.profilePicture = payload.profilePicture;
      updateSidebarUserInfo();
    }
    try { scheduleAutoRefresh(); } catch (_) {}
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

// --- Tabbed shell ---
function renderSettings() {
  const activeTab = state.settingsTab || 'classes';
  if (activeTab === 'connections') setTimeout(loadOllamaModels, 60);
  const themeMode = state.theme || 'dark';
  return `
  <div class="flex items-center justify-between gap-3 mb-4">
    <div class="flex items-center gap-3 min-w-0">
      <button onclick="closeSettings()" class="w-9 h-9 rounded-xl bg-[#12121b] border border-[#22222e] flex items-center justify-center text-gray-400 hover:text-white hover:border-blue-500/30 transition-colors flex-shrink-0" title="Back">${icon('chevronLeft','w-5 h-5')}</button>
      <div class="min-w-0">
        <h1 class="text-2xl font-bold text-white">Settings</h1>
        <p class="text-gray-400 mt-1 text-sm">Stored on the app server — applied across every view. Autosaves as you adjust.</p>
      </div>
    </div>
    <div class="flex items-center gap-2 flex-shrink-0">
      <div class="inline-flex items-center gap-1 bg-[#12121b] border border-[#22222e] rounded-xl p-1" title="Theme">
        <button type="button" data-theme-choice="dark" onclick="setThemeMode('dark'); scheduleSettingsSave('classes')" class="px-2.5 py-1.5 rounded-lg text-xs font-medium text-gray-400 hover:text-gray-200 transition-colors ${themeMode === 'dark' ? 'bg-blue-500/15 text-blue-300' : ''}">Dark</button>
        <button type="button" data-theme-choice="light" onclick="setThemeMode('light'); scheduleSettingsSave('classes')" class="px-2.5 py-1.5 rounded-lg text-xs font-medium text-gray-400 hover:text-gray-200 transition-colors ${themeMode === 'light' ? 'bg-blue-500/15 text-blue-300' : ''}">Light</button>
      </div>
      <button onclick="openSettingsPalette()" class="flex items-center gap-2 bg-[#12121b] border border-[#22222e] rounded-xl px-3 py-2 text-xs text-gray-300 hover:text-white hover:border-blue-500/30 transition-colors">
        ${icon('search','w-3.5 h-3.5')} Search
        <kbd class="font-mono text-[10px] bg-[#0a0a0f] border border-[#22222e] rounded px-1.5 py-0.5 ml-1">⌘K</kbd>
      </button>
    </div>
  </div>

  <div role="tablist" class="flex gap-1 overflow-x-auto border-b border-[#22222e] mb-5 -mx-1 px-1">
    ${SETTINGS_TABS.map(t => `
      <button role="tab" aria-selected="${t.id === activeTab}"
        onclick="switchSettingsTab('${t.id}')"
        class="flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition-colors ${t.id === activeTab ? 'text-blue-400 border-blue-400' : 'text-gray-400 border-transparent hover:text-gray-200'}">
        <span class="${t.id === activeTab ? 'text-blue-400' : 'text-gray-500'}">${icon(t.icon,'w-3.5 h-3.5')}</span>
        ${t.label}
      </button>`).join('')}
  </div>

  <div class="max-w-3xl">
    <section id="settings-tab-panel-classes" ${activeTab === 'classes' ? '' : 'hidden'}>${renderSettingsClasses()}</section>
    <section id="settings-tab-panel-connections" ${activeTab === 'connections' ? '' : 'hidden'}>${renderSettingsConnectionsAndAi()}</section>
    <section id="settings-tab-panel-data" ${activeTab === 'data' ? '' : 'hidden'}>${renderSettingsData()}</section>
    <section id="settings-tab-panel-account" ${activeTab === 'account' ? '' : 'hidden'}>${renderSettingsAccount()}</section>
  </div>
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
              oninput="syncRangeNum('pcgn-${c.id}','pcgn-${c.id}'); scheduleSettingsSave('classes')"
              class="w-36 h-1.5 bg-[#1c1c26] rounded-full appearance-none cursor-pointer accent-blue-500">
            <input type="number" id="pcgn-${c.id}" data-per-class-goal="${c.id}" min="50" max="100" step="1" placeholder="${goal}" value="${cur != null ? cur : ''}"
              oninput="syncNumRange('pcgn-${c.id}','pcgn-${c.id}',50,100); scheduleSettingsSave('classes')"
              class="w-16 px-2 py-1.5 bg-[#12121b] border border-[#22222e] rounded-lg text-sm text-gray-200 text-right placeholder-gray-600 tabular-nums">
          </div>
        </div>`;
      }).join('')}
    </div>`;

  const namesBody = `
    <div class="flex justify-end mb-2">
      <button type="button" onclick="document.querySelectorAll('[data-class-alias]').forEach(i=>i.value=''); scheduleSettingsSave('classes')" class="text-xs text-gray-500 hover:text-gray-300 transition-colors">Reset all</button>
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
            oninput="scheduleSettingsSave('classes')"
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
            onchange="scheduleSettingsSave('classes')">
          <div class="flex-1 min-w-0">
            <div class="text-sm text-gray-200 truncate">${escapeHtml(c.shortName || c.name)}</div>
            <div class="text-xs text-gray-500">${isExcluded ? 'Hidden from averages and goal checks' : 'Included'}</div>
          </div>
          <span class="text-xs ${isExcluded ? 'text-orange-400' : 'text-gray-600'}">${isExcluded ? 'Skipped' : 'Included'}</span>
        </label>`;
      }).join('')}
    </div>`;

  const reviewBody = `
    <div class="space-y-4">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <h3 class="text-sm font-semibold text-gray-200">Levels-based review</h3>
          <p class="text-xs text-gray-500 mt-1 leading-relaxed">Climb unknown → familiar → proficient → mastered. Questions come back only when you need them, and your progress through each level is saved as you go so you can stop anytime. Turn off for a straight run-through.</p>
        </div>
        <label class="switch" title="Levels-based review">
          <input id="settings-levels-enabled" type="checkbox" ${state.levelsEnabled ? 'checked' : ''} onchange="toggleLevelsEnabled(this); scheduleSettingsSave('classes')">
          <span class="track"><span class="thumb"></span></span>
        </label>
      </div>
      <div class="border-t border-[#22222e]"></div>
      <div>
        <h3 class="text-sm font-semibold text-gray-200 mb-1">Quiz review delay</h3>
        <p class="text-xs text-gray-500 mb-3">After a wrong answer you're locked from moving on for this many seconds, then click anywhere to continue. Set to 0 to skip the wait.</p>
        <div class="flex items-center gap-3">
          <input id="quiz-delay-range" type="range" min="0" max="30" step="0.5" value="${state.quizDelay ?? 3}"
            oninput="syncRangeNum('quiz-delay-range','settings-quiz-delay'); scheduleSettingsSave('classes')"
            class="flex-1 h-2 bg-[#1c1c26] rounded-full appearance-none cursor-pointer accent-blue-500">
          <div class="flex items-center gap-2 flex-shrink-0">
            <input id="settings-quiz-delay" type="number" min="0" max="30" step="0.5" value="${state.quizDelay ?? 3}"
              oninput="syncNumRange('quiz-delay-range','settings-quiz-delay',0,30); scheduleSettingsSave('classes')"
              class="w-20 px-3 py-2 bg-[#0a0a0f] border border-[#22222e] rounded-xl text-sm text-gray-200 tabular-nums">
            <span class="text-xs text-gray-500">sec</span>
          </div>
        </div>
        <div class="flex justify-between text-[10px] text-gray-600 mt-1"><span>0</span><span>30</span></div>
      </div>
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
        </div>`;
      }).join('')}
    </div>
    <p class="text-[11px] text-gray-500 mt-3">To link a class, open <button type="button" onclick="jumpToSettings('connections'); setTimeout(()=>document.getElementById('trilium-search-input')?.focus(),260)" class="underline hover:text-blue-300">Connections</button> and search for the notes folder.</p>`;

  return `
    <header class="flex items-center justify-between mb-4">
      <div>
        <h2 class="text-base font-semibold text-white">Classes</h2>
        <p class="text-xs text-gray-500 mt-0.5">Grading goals and per-class settings. Saved automatically as you adjust.</p>
      </div>
      <div id="section-status-classes"></div>
    </header>

    <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5 mb-4">
      <div class="flex items-baseline justify-between mb-1">
        <h3 class="text-sm font-semibold text-gray-200">Default grade goal</h3>
        <span class="text-xs text-gray-500">${escapeHtml(letterGrade(goal))} threshold</span>
      </div>
      <p class="text-xs text-gray-500 mb-4">Used for every class unless you set a per-class override below.</p>
      <div class="flex items-center gap-3">
        <input id="settings-goal" type="range" min="60" max="100" step="1" value="${goal}"
          oninput="document.getElementById('goal-display').textContent=this.value+'%'; document.getElementById('goal-letter-display').textContent='('+letterGrade(parseInt(this.value,10))+' threshold)'; scheduleSettingsSave('classes')"
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
    ${settingsAccordion('pc_review', 'star', '#22c55e', 'Review', 'Levels climb and quiz delay between wrong answers.', reviewBody)}
    ${settingsAccordion('pc_notes', 'book', '#14b8a6', 'Class notes (Trilium)', 'Link each class to its notes folder in Trilium.', notesBody, pill(classes.filter(c => triliumNotesFor(c.id)).length + '/' + classes.length, 'linked'))}
  `;
}

// --- Data & Syncing ---
function renderSettingsData() {
  return `
    <header class="flex items-center justify-between mb-4">
      <div>
        <h2 class="text-base font-semibold text-white">Data &amp; Refresh</h2>
        <p class="text-xs text-gray-500 mt-0.5">How often the dashboard fetches fresh data, and how to trigger a scraper run.</p>
      </div>
      <div id="section-status-data"></div>
    </header>

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
      <div class="flex items-center justify-between gap-3 mb-3">
        <div>
          <h3 class="text-sm font-semibold text-gray-200">Scheduled scrapes</h3>
          <p class="text-xs text-gray-500 mt-0.5">Runs from the backend even if the dashboard is closed.</p>
        </div>
        <label class="switch" title="Scheduled scrape">
          <input id="settings-auto-scrape-enabled" type="checkbox" ${state.autoScrape?.enabled ? 'checked' : ''} onchange="scheduleSettingsSave('data')">
          <span class="track"><span class="thumb"></span></span>
        </label>
      </div>
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
    <header class="flex items-center justify-between mb-4">
      <div>
        <h2 class="text-base font-semibold text-white">Connections and AI</h2>
        <p class="text-xs text-gray-500 mt-0.5">External services, API keys, and the AI insights model.</p>
      </div>
      <div id="section-status-connections"></div>
    </header>

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
        <p class="text-[11px] text-gray-500 mt-3">Per-class linking lives in the <button type="button" onclick="jumpToSettings('classes'); setTimeout(()=>{document.querySelector('[data-panel=pc_notes]')?.classList?.contains('collapsed')&&toggleSettingsPanel('pc_notes')},260)" class="underline hover:text-blue-300">Classes tab → Class notes</button>.</p>
      </div>
    `)}
  `;
}

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
  scheduleSettingsSave('classes');
};

// --- Account ---
function renderSettingsAccount() {
  const pic = state.profilePicture || '';
  const initial = ((state.userName || 'A').trim().charAt(0) || 'A').toUpperCase();
  return `
    <header class="flex items-center justify-between mb-4">
      <div>
        <h2 class="text-base font-semibold text-white">Account</h2>
        <p class="text-xs text-gray-500 mt-0.5">Profile, login credentials, and sign out.</p>
      </div>
      <div id="section-status-account"></div>
    </header>

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
  const pic = state.profilePicture || '';
  const displayName = (state.userName || '').trim();
  const displayPos = (state.userPosition || '').trim();
  const fallback = (displayName || 'A').charAt(0).toUpperCase();
  if (avatar) {
    if (pic) {
      avatar.style.backgroundImage = `url('${pic}')`;
      avatar.style.backgroundSize = 'cover';
      avatar.style.backgroundPosition = 'center';
      avatar.textContent = '';
    } else {
      avatar.style.backgroundImage = '';
      avatar.textContent = fallback;
    }
  }
  if (name) name.textContent = displayName || 'User';
  if (position) position.textContent = displayPos || '';
  if (position) position.style.display = displayPos ? '' : 'none';
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
    if (state.currentView === 'settings') SETTINGS_TABS.forEach(t => updateSectionStatus(t.id));
  }, 15000);
}
startSettingsStatusTimer();

// Open palette shortcut is also exposed on Ctrl+K from anywhere in the app once settings is visible.
// (Cmd+listener is set at top of section.)
function jumpToSettings(sec) {
  if (state.settingsTab !== sec) {
    state.settingsTab = sec;
    render();
    return;
  }
  const el = document.getElementById('settings-tab-panel-' + sec);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
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

