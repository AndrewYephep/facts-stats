/* ================================================================
   blooket-detail.js — Set detail screen and editor.
   Loaded after app.js (which provides state, helpers, icons, theme).
   ================================================================ */


function findSetInState(setUrl) {
  for (const cls of (state.blooketClasses || [])) {
    const found = (cls.sets || []).find(s => s.setUrl === setUrl);
    if (found) return found;
  }
  return (state.blooketCustomSets || []).find(s => s.setUrl === setUrl) || null;
}


window.openSetDetail = function(setUrl) {
  state.currentSetUrl = setUrl;
  render();
};

window.closeSetDetail = function() {
  state.currentSetUrl = null;
  state.openQuestions = {};
  state.expandAllQuestions = false;
  render();
};

function renderSetDetailView() {
  const container = document.getElementById('view-container');
  if (!container) return;
  let screen = document.getElementById('set-detail-screen');
  if (!screen) {
    screen = document.createElement('div');
    screen.id = 'set-detail-screen';
    container.innerHTML = '';
    container.appendChild(screen);
  }
  screen.innerHTML = renderSetDetailScreen();
}

window.deleteSet = async function(setUrl) {
  const ok = await confirmAction({
    title: 'Delete this set?',
    message: 'This cannot be undone. The set and all of its questions will be permanently removed.',
    confirmText: 'Delete',
    danger: true,
  });
  if (!ok) return;
  try {
    const res = await fetch('/api/blooket/set', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ setUrl }) });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      showToast(data?.detail || 'Failed to delete set', 'error');
      return;
    }
    showToast('Set deleted', 'success');
    closeSetDetail();
    if (state.currentView === 'planner') loadBlooketClasses(false);
  } catch(e) {
    showToast('Failed to delete set — ' + e.message, 'error');
  }
};

window.saveSetField = async function(setUrl, field, value) {
  try {
    const res = await fetch('/api/blooket/set', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ setUrl, [field]: value }) });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      showToast(data?.detail || 'Failed to save', 'error');
      return;
    }
    const s = findSetInState(setUrl);
    if (s) { s[field] = value; }
    showToast('Saved', 'success');
  } catch(e) {
    showToast('Failed to save — ' + e.message, 'error');
  }
};

async function saveSetQuestions(setUrl) {
  const s = findSetInState(setUrl);
  if (!s) return;
  try {
    const res = await fetch('/api/blooket/set', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ setUrl, questions: s.questions }) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
  } catch(e) {
    showToast('Failed to save changes — ' + e.message, 'error');
  }
}

window.toggleQuestionOpen = function(i) {
  state.openQuestions[i] = !state.openQuestions[i];
  renderSetDetailView();
};

window.saveQuestionField = async function(qi, field, value) {
  const setUrl = state.currentSetUrl;
  const s = findSetInState(setUrl);
  if (!s) return;
  s.questions = s.questions || [];
  s.questions[qi] = s.questions[qi] || { q: '', options: ['', '', '', ''], correct: 0 };
  s.questions[qi][field] = value;
  await saveSetQuestions(setUrl);
};

window.saveOptionText = async function(qi, oi, value) {
  const setUrl = state.currentSetUrl;
  const s = findSetInState(setUrl);
  if (!s) return;
  s.questions = s.questions || [];
  s.questions[qi] = s.questions[qi] || { q: '', options: ['', '', '', ''], correct: 0 };
  s.questions[qi].options = s.questions[qi].options || ['', '', '', ''];
  s.questions[qi].options[oi] = value;
  await saveSetQuestions(setUrl);
};

window.setCorrectAnswer = async function(qi, oi) {
  const setUrl = state.currentSetUrl;
  const s = findSetInState(setUrl);
  if (!s) return;
  s.questions = s.questions || [];
  s.questions[qi] = s.questions[qi] || { q: '', options: ['', '', '', ''], correct: 0 };
  s.questions[qi].correct = oi;
  renderSetDetailView();
  await saveSetQuestions(setUrl);
};

window.addQuestionOption = async function(qi) {
  const setUrl = state.currentSetUrl;
  const s = findSetInState(setUrl);
  if (!s) return;
  s.questions = s.questions || [];
  s.questions[qi] = s.questions[qi] || { q: '', options: ['', '', '', ''], correct: 0 };
  s.questions[qi].options = s.questions[qi].options || [];
  if (s.questions[qi].options.length >= 6) { showToast('Maximum 6 options', 'warning'); return; }
  s.questions[qi].options.push('');
  renderSetDetailView();
  await saveSetQuestions(setUrl);
};

window.removeQuestionOption = async function(qi, oi) {
  const setUrl = state.currentSetUrl;
  const s = findSetInState(setUrl);
  if (!s) return;
  s.questions = s.questions || [];
  const q = s.questions[qi];
  if (!q || !q.options || q.options.length <= 2) return;
  q.options.splice(oi, 1);
  if (q.correct === oi) q.correct = 0;
  else if (q.correct > oi) q.correct -= 1;
  renderSetDetailView();
  await saveSetQuestions(setUrl);
};

window.addNewQuestion = async function() {
  const setUrl = state.currentSetUrl;
  const s = findSetInState(setUrl);
  if (!s) return;
  s.questions = s.questions || [];
  const newIdx = s.questions.length;
  s.questions.push({ q: '', options: ['', '', '', ''], correct: 0 });
  state.openQuestions[newIdx] = true;
  renderSetDetailView();
  await saveSetQuestions(setUrl);
};

window.deleteQuestion = async function(qi) {
  const ok = await confirmAction({
    title: 'Delete this question?',
    message: 'This cannot be undone.',
    confirmText: 'Delete',
    danger: true,
  });
  if (!ok) return;
  const setUrl = state.currentSetUrl;
  const s = findSetInState(setUrl);
  if (!s) return;
  s.questions = s.questions || [];
  s.questions.splice(qi, 1);
  delete state.openQuestions[qi];
  state.openQuestions = Object.fromEntries(Object.entries(state.openQuestions).map(([k, v]) => [parseInt(k) > qi ? parseInt(k) - 1 : k, v]));
  renderSetDetailView();
  await saveSetQuestions(setUrl);
};

function renderSetDetailScreen() {
  const setUrl = state.currentSetUrl;
  if (!setUrl) return '';
  const s = findSetInState(setUrl);
  if (!s) return '<div class="p-6 text-gray-400">Set not found.</div>';
  const light = isLightTheme();
  const border = light ? '#d0d7e0' : '#22222e';
  const text = light ? '#101828' : '#f5f5f7';
  const muted = light ? '#6b7280' : '#9ca3af';
  const qBg = light ? '#ffffff' : '#16161f';
  const qInner = light ? '#f9fafb' : '#0d0d16';
  const questions = s.questions || [];
  const safeUrl = setUrl.replace(/'/g, "\\'");
  const lvRaw = getLevelState(s.setUrl);
  const lvSt = lvRaw ? sanitizeLevelState(lvRaw, questions.length) : null;
  const lvCards = lvSt ? lvSt.cards : [];
  return `<div class="quiz-in max-w-5xl mx-auto px-1 sm:px-2 py-2 min-h-[62vh] flex flex-col">
    <div class="flex items-center gap-3">
      <button type="button" onclick="closeSetDetail()" title="Back to Review (Esc)"
        class="w-9 h-9 flex items-center justify-center rounded-xl border ${themeChoice('border-[#22222e] text-gray-400 hover:text-white hover:border-purple-500/40', 'border-[#d9dde7] text-gray-500 hover:text-gray-900 hover:border-purple-400')} transition-colors flex-shrink-0">${icon('chevronLeft', 'w-4 h-4')}</button>
      <div class="min-w-0 flex-1">
        <div class="text-sm font-semibold ${themeChoice('text-white', 'text-gray-900')} truncate">Set details</div>
        <div class="text-xs ${themeChoice('text-gray-500', 'text-gray-600')} truncate">${s.chapterTitle ? escapeHtml(s.chapterTitle) : 'Custom quiz'}</div>
      </div>
      <button type="button" onclick="deleteSet('${safeUrl}')" title="Delete set"
        class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-red-400 hover:bg-red-500/15 transition-colors flex-shrink-0">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg><span>Delete</span>
      </button>
    </div>
    <div class="mt-5">
      <input id="detail-title" type="text" value="${(s.title || '').replace(/"/g, '&quot;')}" placeholder="Set name"
        onblur="saveSetField('${safeUrl}','title',this.value)"
        class="w-full text-3xl font-bold ${themeChoice('bg-transparent text-white', 'bg-transparent text-gray-900')} border-none outline-none mb-1" spellcheck="false">
      <div class="text-xs mb-5 font-medium" style="color:${muted}">AI-generated name</div>
      <textarea id="detail-description" rows="2" placeholder="Add a description…"
        onblur="saveSetField('${safeUrl}','description',this.value)"
        class="w-full text-base border outline-none rounded-xl px-4 py-3 resize-none transition-colors focus:border-blue-400/60"
        style="border-color:${border};color:${text};background:${qInner}">${(s.description || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea>
      <div class="text-xs mt-1 mb-5" style="color:${muted}">Description${s.description ? ' · auto-saves on change' : ' · optional'}</div>
      ${s.sourceNoteId ? `<div class="text-sm mb-5 px-4 py-2.5 rounded-lg border" style="border-color:${border};color:${muted};background:${qInner}">From chapter note: ${escapeHtml(s.chapterTitle || s.sourceNoteId)}</div>` : ''}
      <div class="flex items-center gap-3 mb-4">
        <div class="text-base font-semibold" style="color:${text}">${questions.length} question${questions.length === 1 ? '' : 's'}</div>
        ${s.questionCount ? `<div class="text-sm px-2 py-0.5 rounded-full border" style="border-color:${border};color:${muted}">${s.questionCount} in Blooket</div>` : ''}
        <div class="flex-1"></div>
        <label class="flex items-center gap-2 text-sm cursor-pointer select-none" style="color:${muted}">
          <input type="checkbox" id="expand-all-questions" ${state.expandAllQuestions ? 'checked' : ''} onchange="state.expandAllQuestions=this.checked; renderSetDetailView()" class="w-4 h-4 rounded border-current cursor-pointer">
          <span>Expand all</span>
        </label>
        <div class="text-sm" style="color:${muted}">Created ${s.createdAt ? escapeHtml(s.createdAt.slice(0, 10)) : 'unknown'}</div>
      </div>
      <div class="space-y-3" id="questions-list">
        ${questions.length === 0 ? `<div class="text-base text-center py-10" style="color:${muted}">No questions stored — play the set on Blooket to reload them.</div>` :
          questions.map(function(q, i) {
            var isOpen = state.expandAllQuestions || (state.openQuestions && state.openQuestions[i]);
            var correctIdx = typeof q.correct === 'number' ? q.correct : 0;
            var optsArr = q.options || [];
            var lvlCard = lvCards[i];
            var lvlIdx = lvlCard ? lvlCard.lvl : 0;
            var lvlColor = levelColor(lvlIdx, light);
            var lvlName = LEVELS[lvlIdx] ? LEVELS[lvlIdx].name : 'unknown';
            var lvlBadge = `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold flex-shrink-0" style="background:${lvlColor}22;color:${lvlColor}" title="Level: ${lvlName}${lvlCard && lvlCard.nr ? ' · needs review' : ''}">
              <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><circle cx="10" cy="10" r="6"/></svg>${lvlName}${lvlCard && lvlCard.nr ? ' · review' : ''}</span>`;
            return `<div class="rounded-xl border overflow-hidden" style="border-color:${border};background:${qBg}" data-qi="${i}">
              <div class="flex items-center gap-2 px-4 py-3 cursor-pointer select-none transition-colors" style="color:${text}" onclick="toggleQuestionOpen(${i})">
                <span class="text-sm flex-shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}" style="color:${muted}">${icon('chevronRight', 'w-4 h-4')}</span>
                <span class="text-base font-semibold flex-shrink-0">${i+1}.</span>
                ${lvlBadge}
                <input type="text" value="${escapeHtml(q.q || '').replace(/"/g, '&quot;')}" placeholder="Question text"
                  onclick="event.stopPropagation()"
                  onblur="saveQuestionField(${i},'q',this.value)"
                  class="flex-1 bg-transparent border-none outline-none text-base font-medium" style="color:${text}">
                <button type="button" onclick="event.stopPropagation(); addQuestionOption(${i})" title="Add option"
                  class="w-7 h-7 flex items-center justify-center rounded-lg ${themeChoice('text-gray-500 hover:text-teal-300 hover:bg-teal-500/15', 'text-gray-500 hover:text-teal-700 hover:bg-teal-500/15')} transition-colors flex-shrink-0">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"/></svg>
                </button>
                <button type="button" onclick="event.stopPropagation(); deleteQuestion(${i})" title="Delete question"
                  class="w-7 h-7 flex items-center justify-center rounded-lg text-red-400 hover:bg-red-500/15 transition-colors flex-shrink-0">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
                </button>
              </div>
              <div class="${isOpen ? '' : 'hidden'} px-4 pb-4 pt-1 space-y-2 border-t" style="border-color:${border}">
                ${optsArr.map(function(opt, oi) {
                  var isCorrect = oi === correctIdx;
                  var letter = String.fromCharCode(65 + oi);
                  return `<div class="flex items-center gap-2.5">
                    <button type="button" onclick="setCorrectAnswer(${i},${oi})" title="Mark as correct"
                      class="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 border transition-colors ${isCorrect ? 'border-green-500 bg-green-500/20' : themeChoice('border-[#3a3a4a] hover:border-green-500/50', 'border-gray-300 hover:border-green-400')}"
                      style="${isCorrect ? 'color:#10b981' : 'color:' + muted}">${letter}</button>
                    <input type="text" value="${escapeHtml(opt || '').replace(/"/g, '&quot;')}" placeholder="Answer option"
                      onblur="saveOptionText(${i},${oi},this.value)"
                      class="flex-1 bg-transparent border ${themeChoice('border-[#22222e] focus:border-blue-400/60', 'border-[#d9dde7] focus:border-blue-400/60')} outline-none rounded-lg px-3 py-2 text-base transition-colors ${isCorrect ? 'font-semibold' : ''}"
                      style="color:${isCorrect ? '#10b981' : text};background:${qInner}">
                    ${optsArr.length > 2 ? `<button type="button" onclick="removeQuestionOption(${i},${oi})" title="Remove option"
                      class="w-7 h-7 flex items-center justify-center rounded-lg text-red-400 hover:bg-red-500/15 transition-colors flex-shrink-0">
                      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
                    </button>` : ''}
                  </div>`;
                }).join('')}
              </div>
            </div>`;
          }).join('')}
        <button type="button" onclick="addNewQuestion()" title="Add a new question"
          class="w-full rounded-xl border-2 border-dashed py-4 flex items-center justify-center gap-2 text-base font-medium transition-colors ${themeChoice('text-gray-400 hover:text-teal-300 hover:border-teal-500/40 border-[#22222e]', 'text-gray-500 hover:text-teal-700 hover:border-teal-400/40 border-[#d9dde7]')}">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"/></svg>
          Add new question
        </button>
      </div>
    </div>
  </div>`;
}

function renderReviewGrid(classes, customSets) {
  const container = document.getElementById('review-sets');
  if (!container) return;
  const query = (state.reviewQuery || '').trim().toLowerCase();
  const q = query;
  const matchSet = s => !q || (s.chapterTitle || '').toLowerCase().includes(q) || (s.title || '').toLowerCase().includes(q);
  const matchClass = c => !q
    || (c.name || '').toLowerCase().includes(q)
    || (c.shortName || '').toLowerCase().includes(q)
    || (c.latest && (c.latest.title || '').toLowerCase().includes(q))
    || (c.sets || []).some(matchSet);
  const filtered = classes.filter(matchClass);
  const classHtml = filtered.map(c => renderBlooketClassCard(c)).join('');
  const customSetsList = customSets || [];
  const customHtml = customSetsList.length || (_blooketCtx?.custom && _blooketCtx.busy)
    ? renderCustomSetsSection(customSetsList)
    : '';

  if (!classHtml && !customHtml) {
    container.innerHTML = `<div class="col-span-full">
      <div class="flex flex-col items-center justify-center py-20 text-center">
        <div class="w-16 h-16 rounded-2xl ${themeChoice('bg-[#16161f] border-[#22222e]', 'bg-white border-[#d9dde7]')} border flex items-center justify-center mb-4">${icon('search', 'w-7 h-7 text-gray-500')}</div>
        <div class="text-gray-300 font-medium mb-1">${q ? 'No sets match “' + escapeHtml(q) + '”' : 'No quiz sets yet'}</div>
        <div class="text-xs text-gray-600 max-w-xs">${q ? 'Try a different search term.' : 'Link class notes in Settings → Class Notes, or build a custom quiz with the + button.'}</div>
      </div>
    </div>`;
    return;
  }
  container.innerHTML = `${classHtml}${customHtml}`;
}

function populateCustomBlooketTarget(classes, customSets) {
  const sel = document.getElementById('custom-blooket-target');
  if (!sel) return;
  const prev = sel.value;
  const opts = ['<option value="">Create a new set</option>'];
  const push = (url, label) => { if (url) opts.push(`<option value="${escapeHtml(url)}">${escapeHtml(label)}</option>`); };
  for (const row of classes) {
    for (const s of (row.sets || [])) push(s.setUrl, `${row.shortName || row.name} — ${s.title || s.chapterTitle || 'set'}`);
  }
  for (const s of customSets) push(s.setUrl, `Custom — ${s.title || s.chapterTitle || 'set'}`);
  sel.innerHTML = opts.join('');
  if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
}

function renderCustomBlooketSets(customSets) {
  const wrap = document.getElementById('custom-blooket-sets');
  if (!wrap) return;
  wrap.innerHTML = customSets.slice(0, 4).map(s => `
    <div class="inline-flex items-center gap-1.5 text-xs text-gray-400 bg-[#0a0a0f] border border-[#22222e] rounded-lg px-2.5 py-1.5">
      <span class="w-3 h-3 text-green-400 flex-shrink-0">${icon('check','w-3 h-3')}</span>
      <a href="${escapeHtml(s.setUrl)}" target="_blank" rel="noopener" class="hover:text-purple-300 transition-colors">${escapeHtml(s.title || s.chapterTitle || 'set')} · ${s.questionCount || 0} questions</a>
      <button type="button" onclick="startQuiz('${jsStr(s.setUrl)}','${jsStr(s.title || s.chapterTitle || 'Custom set')}')" title="Review this quiz"
        class="flex items-center gap-1 text-[10px] font-medium text-teal-400 bg-teal-500/10 border border-teal-500/30 rounded-md px-1.5 py-0.5 hover:bg-teal-500/20 transition-all flex-shrink-0">${icon('play','w-2.5 h-2.5')}Review</button>
    </div>`).join('');
}

function renderBlooketClassCard(cls) {
  const color = cls._color || COLORS[0];
  const latest = cls.latest;
  const sets = (cls.sets || []).slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const expanded = !!state.expandedClasses[cls.classId];
  const limit = 4;
  const visible = expanded ? sets : sets.slice(0, limit);
  const extra = sets.length - visible.length;
  const letter = escapeHtml((cls.shortName || cls.name || '?').trim().charAt(0).toUpperCase());
  const rows = visible.map(s => renderSetCard(s, color, latest && s.sourceNoteId === latest.noteId));

  return `
  <div class="review-class-section bg-[#12121b] border border-[#22222e] rounded-2xl overflow-hidden" data-class-id="${escapeHtml(cls.classId)}">
    <div class="relative flex items-center gap-3 px-4 py-3.5 border-b border-[#22222e]" style="background:linear-gradient(90deg, ${color}16, transparent 62%)">
      <span class="w-9 h-9 rounded-xl flex items-center justify-center text-sm font-bold flex-shrink-0" style="background:${color}24; color:${color}">${letter}</span>
      <div class="min-w-0 flex-1">
        <div class="text-sm font-semibold text-white truncate">${escapeHtml(cls.name)}</div>
        <div class="text-[11px] text-gray-500 truncate">${sets.length} set${sets.length === 1 ? '' : 's'}${latest ? ' · <a href="' + escapeHtml(triliumWebUrl(latest.noteId)) + '" target="_blank" rel="noopener" title="Open the latest notes in Trilium" class="hover:text-blue-400 hover:underline underline-offset-2 transition-colors">' + escapeHtml(latest.title) + '</a>' : (cls.noteTitle ? ' · ' + escapeHtml(cls.noteTitle) : ' · no chapter notes')}</div>
      </div>
      <button type="button" onclick="startClassFlow('${jsStr(cls.classId)}')"
        title="Generate a new quiz from ${latest ? escapeHtml(latest.title) : 'this class'}"
        class="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-purple-300 hover:bg-purple-500/10 transition-all flex-shrink-0">${icon('sparkle', 'w-3.5 h-3.5')}</button>
      <div class="blooket-progress absolute inset-0 flex items-center justify-center px-16 pointer-events-none" data-class-id="${escapeHtml(cls.classId)}"></div>
    </div>
    <div class="p-3">
      ${sets.length ? `<div class="space-y-2">${rows.join('')}</div>` : '<div class="text-xs text-gray-600 px-1 py-2">No quizzes yet — use the sparkle button or the + button to create one.</div>'}
      ${extra > 0 ? `<button type="button" onclick="expandClassSets('${jsStr(cls.classId)}')" class="w-full mt-2 text-xs font-medium text-gray-500 hover:text-gray-300 transition-colors py-1.5">+ ${extra} more set${extra === 1 ? '' : 's'}</button>` : ''}
    </div>
  </div>`;
}
