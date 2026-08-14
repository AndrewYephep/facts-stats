/* ================================================================
   blooket-quiz.js — Quiz runner + levels engine + level-up screens.
   Loaded after app.js (which provides state, helpers, icons, theme).
   This file owns the entire quiz subsystem, both classic and levels-based.
   ================================================================ */


function getQuizStats(url) {
  if (!url) return null;
  try {
    const map = JSON.parse(localStorage.getItem('gradetrack-quiz-stats') || '{}');
    const stat = map[url];
    if (!stat || !stat.total) return null;
    return { ...stat, pct: Math.round((stat.correct / stat.total) * 100) };
  } catch (err) { return null; }
}

function saveQuizStats(url, correct, total) {
  if (!url || !total) return;
  try {
    const map = JSON.parse(localStorage.getItem('gradetrack-quiz-stats') || '{}');
    const prev = map[url] || { correct: 0, total: 0, count: 0 };
    map[url] = { correct: prev.correct + correct, total: prev.total + total, count: prev.count + 1, last: Date.now() };
    localStorage.setItem('gradetrack-quiz-stats', JSON.stringify(map));
  } catch (err) {}
}

// Per-answer accuracy recording: saves as you go so quitting early or jumping
// back to Review still shows the percent built up so far (across all sessions).
function recordQuizAnswer(url, correct) {
  if (!url) return;
  try {
    const map = JSON.parse(localStorage.getItem('gradetrack-quiz-stats') || '{}');
    const prev = map[url] || { correct: 0, total: 0, count: 0 };
    map[url] = { correct: prev.correct + (correct ? 1 : 0), total: prev.total + 1, count: prev.count + 1, last: Date.now() };
    localStorage.setItem('gradetrack-quiz-stats', JSON.stringify(map));
  } catch (err) {}
}

// Circular percent badge — the "ring" with the number in the middle.
function ringPct(pct, size, color, mini) {
  const p = Math.max(0, Math.min(100, Math.round(pct || 0)));
  const r = 15.5;
  const c = 2 * Math.PI * r;
  const off = c * (1 - p / 100);
  const fs = mini ? 5.5 : 7;
  return `<svg width="${size}" height="${size}" viewBox="0 0 36 36" class="block flex-shrink-0">
    <circle cx="18" cy="18" r="${r}" fill="none" stroke="rgba(120,130,150,0.25)" stroke-width="3.5"/>
    <circle cx="18" cy="18" r="${r}" fill="none" stroke="${color}" stroke-width="3.5" stroke-linecap="round"
      stroke-dasharray="${c}" stroke-dashoffset="${off}" transform="rotate(-90 18 18)" style="transition:stroke-dashoffset .4s ease"/>
    <text x="18" y="${18 + fs * 0.36}" text-anchor="middle" fill="${color}" font-size="${fs}" font-weight="700" font-family="inherit">${p}%</text>
  </svg>`;
}

// ─── LEVELS-BASED REVIEW STATE ──────────────────────────────────
function loadLevelsMap() {
  try { return JSON.parse(localStorage.getItem(LEVELS_STORE) || '{}'); } catch (err) { return {}; }
}
function saveLevelsMap(map) {
  try { localStorage.setItem(LEVELS_STORE, JSON.stringify(map)); } catch (err) {}
}
function getLevelState(setUrl) {
  return setUrl ? loadLevelsMap()[setUrl] || null : null;
}
function saveLevelState(setUrl, st) {
  if (!setUrl || !st) return;
  st.updated = Date.now();
  const map = loadLevelsMap();
  map[setUrl] = st;
  saveLevelsMap(map);
}
function deleteLevelState(setUrl) {
  if (!setUrl) return;
  const map = loadLevelsMap();
  delete map[setUrl];
  saveLevelsMap(map);
}
function initLevelState(n) {
  return {
    round: 0,      // level index currently being cleared (0..3); 4 = all mastered
    done: true,    // true between rounds (fresh, or a completed level, stopped for now)
    started: false,
    pos: 0,
    queue: [],
    cards: Array.from({ length: n }, () => ({ lvl: 0, nr: false, done3: false })),
    updated: Date.now(),
  };
}
function sanitizeLevelState(st, n) {
  if (!st || typeof st !== 'object') st = initLevelState(n);
  if (!Array.isArray(st.cards)) st.cards = [];
  if (st.cards.length < n) { while (st.cards.length < n) st.cards.push({ lvl: 0, nr: false, done3: false }); }
  else if (st.cards.length > n) st.cards = st.cards.slice(0, n);
  st.cards.forEach(c => { c.lvl = Math.max(0, Math.min(3, c.lvl | 0)); c.nr = !!c.nr; c.done3 = !!c.done3; });
  if (!Array.isArray(st.queue)) st.queue = [];
  st.queue = st.queue.filter(i => Number.isInteger(i) && i >= 0 && i < n);
  st.round = Math.max(0, Math.min(4, st.round | 0));
  st.pos = Math.max(0, Math.min(st.queue.length, st.pos | 0));
  return st;
}
// Is the current round cleared? (every question correctly answered at/past it)
function roundComplete(st) {
  if (st.round >= 4) return true;
  if (st.round === 3) return st.cards.every(c => c.lvl === 3 && c.done3);
  return st.cards.every(c => c.lvl > st.round);
}
function rebuildQueue(st) {
  const idxs = [];
  st.cards.forEach((c, i) => {
    if (st.round === 3 ? !(c.lvl === 3 && c.done3) : c.lvl <= st.round) idxs.push(i);
  });
  st.queue = quizShuffle(idxs);
  st.pos = 0;
}
// Jump through any rounds whose queue is already drained (e.g. a saved state
// where the current round is 100% cleared — every card past the round — so a
// rebuild leaves nothing to answer). Stops at the first round with real
// questions, or marks the set mastered. Returns true when a question remains
// to render; false when the mastered screen was shown instead.
function advanceLevelsRounds(ctx) {
  const st = ctx.lv;
  let guard = 0;
  while (st.round < 4 && (!st.queue.length || roundComplete(st))) {
    if (st.round >= 3) { st.round = 4; st.done = true; break; }
    st.round++;
    ctx.pendingLevelUp = false;
    rebuildQueue(st);
    if (++guard > 4) break;
  }
  if (st.round >= 4) {
    st.done = true;
    saveLevelState(ctx.setUrl, st);
    showLevelsMastered(ctx.setUrl, ctx.title, ctx.chapterTitle, st);
    return false;
  }
  if (!st.queue.length || st.pos >= st.queue.length) rebuildQueue(st);
  saveLevelState(ctx.setUrl, st);
  return true;
}
// What a set is currently at + how far through the level: "% into level" is the
// share of questions that have already cleared the current round.
function levelInfo(st) {
  if (!st || !st.cards || !st.cards.length) return null;
  const total = st.cards.length;
  if (st.round >= 4) return { level: 3, name: 'mastered', pct: 100, nr: st.cards.filter(c => c.nr).length };
  const cleared = st.cards.filter(c => c.lvl > st.round).length;
  return {
    level: st.round,
    name: LEVELS[st.round]?.name || 'unknown',
    pct: Math.round((cleared / total) * 100),
    nr: st.cards.filter(c => c.nr).length,
  };
}
function levelColor(level, light) {
  const l = LEVELS[Math.max(0, Math.min(3, level))];
  return l ? (light ? l.light : l.color) : '#94a3b8';
}
function accRingColor(pct) {
  const light = isLightTheme();
  if (pct >= 90) return light ? '#0d9488' : '#2dd4bf';
  if (pct >= 70) return light ? '#2563eb' : '#60a5fa';
  if (pct >= 50) return light ? '#b45309' : '#f59e0b';
  return light ? '#ea580c' : '#fb923c';
}



// ─── QUIZ REVIEWER (in-house quizzer) ───────────────────────────
let _quizCtx = null;
const QUIZ_LETTERS = ['A', 'B', 'C', 'D'];
const QUIZ_OPTION_STYLES = [
  { badge: 'bg-blue-500/15 text-blue-300', rest: 'border-blue-500/40 bg-blue-500/10 text-blue-200 hover:bg-blue-500/15',
    lightBadge: 'bg-blue-600/10 text-blue-700', lightRest: 'border-blue-500/50 bg-blue-500/10 text-blue-800 hover:bg-blue-500/15' },
  { badge: 'bg-violet-500/15 text-violet-300', rest: 'border-violet-500/40 bg-violet-500/10 text-violet-200 hover:bg-violet-500/15',
    lightBadge: 'bg-violet-600/10 text-violet-700', lightRest: 'border-violet-500/50 bg-violet-500/10 text-violet-800 hover:bg-violet-500/15' },
  { badge: 'bg-teal-500/15 text-teal-300', rest: 'border-teal-500/40 bg-teal-500/10 text-teal-200 hover:bg-teal-500/15',
    lightBadge: 'bg-teal-600/10 text-teal-700', lightRest: 'border-teal-500/50 bg-teal-500/10 text-teal-800 hover:bg-teal-500/15' },
  { badge: 'bg-amber-500/15 text-amber-300', rest: 'border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/15',
    lightBadge: 'bg-amber-600/10 text-amber-700', lightRest: 'border-amber-500/50 bg-amber-500/10 text-amber-800 hover:bg-amber-500/15' },
];

function quizShuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function quizBuildQuestions(questions) {
  return quizShuffle(questions).map(q => {
    const opts = q.options || [];
    const order = quizShuffle(opts.map((_, i) => i));
    return { q: q.q, options: order.map(i => opts[i]), correct: order.indexOf(q.correct) };
  });
}

function quizCurrentQuestion(ctx) {
  if (!ctx) return null;
  if (ctx.mode === 'levels') return ctx.questions[ctx.lv.queue[ctx.lv.pos]];
  return ctx.questions[ctx.idx];
}

async function startQuiz(setUrl, fallbackTitle) {
  if (_quizCtx || !setUrl) return;
  try {
    const res = await fetch('/api/blooket/quiz?url=' + encodeURIComponent(setUrl));
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Failed to load quiz');
    const raw = data.questions || [];
    if (!raw.length) {
      showToast('This set has no saved questions to review', 'warning');
      return;
    }
    const title = data.title || fallbackTitle || 'Review quiz';
    const chapterTitle = data.chapterTitle || '';
    if (state.levelsEnabled) { startLevelsQuiz(setUrl, title, chapterTitle, raw); return; }
    _quizCtx = {
      url: setUrl,
      title,
      chapterTitle,
      source: raw,
      questions: quizBuildQuestions(raw),
      idx: 0,
      correctCount: 0,
      answered: false,
      picked: -1,
      timer: null,
      countdownInt: null,
      ignoreNextClick: false,
      locked: false,
    };
    state.quizActive = true;
    document.addEventListener('click', quizGlobalClick);
    document.addEventListener('keydown', quizGlobalKeydown);
    ensureQuizCss();
    renderQuizScreen();
    window.scrollTo(0, 0);
  } catch (err) {
    showToast(err.message || 'Failed to load quiz', 'error');
  }
}

// ─── LEVELS QUIZ ENGINE ─────────────────────────────────────────
function startLevelsQuiz(setUrl, title, chapterTitle, raw) {
  let st = sanitizeLevelState(getLevelState(setUrl), raw.length);
  // Resuming: if they finished a level and stopped, advance to the next round.
  const resuming = st.started && st.done;
  if (resuming) {
    if (st.round >= 3) st.round = 4;
    else st.round++;
  }
  st.done = false;
  st.started = true;
  // Always set up _quizCtx first so the mastered screen, quitQuiz, and
  // levelContinueReview all have the context they need even when round>=4.
  _quizCtx = {
    mode: 'levels',
    url: setUrl,
    setUrl,
    title,
    chapterTitle,
    source: raw,
    questions: raw,             // stable server order — lv.cards[i] maps to questions[i]
    lv: st,
    idx: 0,
    correctCount: 0,
    answered: false,
    picked: -1,
    timer: null,
    countdownInt: null,
    ignoreNextClick: false,
    locked: false,
    pendingLevelUp: false,
  };
  saveLevelState(setUrl, st);
  if (st.round >= 4) {
    showLevelsMastered(setUrl, title, chapterTitle, st);
    return;
  }
  // A saved resume state can be 100% done with its current round (all cards
  // cleared it in a previous session, e.g. stopping right at the level-up
  // screen, or a set with very few questions). Rebuilding the queue then yields
  // nothing and the quiz would silently render a blank screen — jump to the
  // next real round. Fresh sets skip this (queue is built below).
  if (resuming && !st.queue.length && st.cards.length > 0 && !advanceLevelsRounds(_quizCtx)) return;
  if (!st.queue.length || st.pos >= st.queue.length) rebuildQueue(st);
  state.quizActive = true;
  document.addEventListener('click', quizGlobalClick);
  document.addEventListener('keydown', quizGlobalKeydown);
  ensureQuizCss();
  renderQuizScreen();
  window.scrollTo(0, 0);
}

function applyLevelsAnswer(ctx, correct) {
  const st = ctx.lv;
  const ci = ctx.lv.queue[ctx.lv.pos];
  const card = st.cards[ci];
  if (st.reviewMode) {
    // Review mode: no level progression, no round-complete triggers. Just keep cycling.
    if (correct) {
      ctx.lv.queue.splice(ctx.lv.pos, 1);
      if (ctx.lv.queue.length === 0) {
        // Review round drained — start a new one.
        ctx.lv.queue = quizShuffle(st.cards.map((_, i) => i));
        ctx.lv.pos = 0;
      }
    } else {
      requeueLevelsCard(ctx, ci);
    }
    saveLevelState(ctx.setUrl, st);
    return;
  }
  if (correct) {
    card.lvl = Math.min(3, card.lvl + 1);
    if (card.lvl === 3) card.done3 = true;
    if (card.lvl >= 1) card.nr = false;   // cleared unknown → no longer needs review
    ctx.lv.queue.splice(ctx.lv.pos, 1);          // pos now points to the next card
  } else {
    if (card.lvl === 0) card.nr = true;    // unknown-wrong → needs review
    requeueLevelsCard(ctx, ci);            // reinsert at pos + 4-8 (fillers if needed)
  }
  if (roundComplete(st)) ctx.pendingLevelUp = true;
  if (ctx.lv.queue.length === 0) ctx.pendingLevelUp = true;   // safety: round drained
  saveLevelState(ctx.setUrl, st);
}

function requeueLevelsCard(ctx, cardIdx) {
  const st = ctx.lv;
  ctx.lv.queue.splice(ctx.lv.pos, 1);            // remove the just-answered card
  const gap = 4 + Math.floor(Math.random() * 5);   // 4..8 questions later
  let insertAt = ctx.lv.pos + gap;
  const above = st.round + 1;
  if (above <= 3) {
    const inQ = new Set(ctx.lv.queue);
    const fillers = st.cards.map((c, i) => ({ c, i }))
      .filter(o => o.c.lvl === above && !inQ.has(o.i))
      .map(o => o.i);
    let fi = 0;
    while (insertAt > ctx.lv.queue.length && fi < fillers.length) {
      ctx.lv.queue.push(fillers[fi++]);        // pad with questions from the level above
    }
  }
  if (insertAt > ctx.lv.queue.length) insertAt = ctx.lv.queue.length;
  ctx.lv.queue.splice(insertAt, 0, cardIdx);
}

function ensureQuizCss() {
  if (document.getElementById('quiz-css')) return;
  const s = document.createElement('style');
  s.id = 'quiz-css';
  s.textContent = `
    @keyframes quiz-pop { 0% { transform: scale(1); } 45% { transform: scale(1.03); } 100% { transform: scale(1); } }
    @keyframes quiz-flash { 0% { background-color: rgba(239,68,68,0.95); } 100% { background-color: rgba(239,68,68,0.3); } }
    @keyframes quiz-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    .quiz-pop { animation: quiz-pop 0.35s ease; }
    .quiz-flash { animation: quiz-flash 0.5s ease forwards; }
    .quiz-in { animation: quiz-in 0.3s ease; }
  `;
  document.head.appendChild(s);
}

function renderQuizScreen() {
  const ctx = _quizCtx;
  if (!ctx) return;
  let q = quizCurrentQuestion(ctx);
  // Safety net: an empty queue (round fully cleared on a previous session)
  // would leave no question to render — advance to the next real round instead
  // of silently showing nothing.
  if (!q && ctx.mode === 'levels' && ctx.lv.cards.length > 0 && advanceLevelsRounds(ctx)) {
    q = quizCurrentQuestion(ctx);
  }
  if (!q) return;
  const total = ctx.questions.length;
  const levels = ctx.mode === 'levels';
  const light = state.theme === 'light';
  let progPct, progColor, lineHtml;
  if (levels) {
    const reviewMode = ctx.lv.reviewMode;
    const li = reviewMode ? null : levelInfo(ctx.lv);
    const curCard = ctx.lv.cards[ctx.lv.queue[ctx.lv.pos]];
    progPct = reviewMode ? 0 : (li ? li.pct : 0);
    progColor = reviewMode ? levelColor(2, light) : levelColor(li ? li.level : 0, light);
    const remaining = ctx.lv.queue.length - ctx.lv.pos;
    lineHtml = reviewMode
      ? `<span class="font-semibold" style="color:${progColor}">Review mode</span>
         <span class="opacity-60">· ${remaining} question${remaining === 1 ? '' : 's'} left in this round</span>`
      : `<span class="font-semibold" style="color:${progColor}">${li ? li.name : 'unknown'}</span>
         <span class="opacity-60">· ${remaining} question${remaining === 1 ? '' : 's'} left this level</span>
         ${curCard && curCard.nr ? `<span class="ml-1 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-400 text-[9px] font-semibold">review</span>` : ''}`;
  } else {
    progPct = Math.round((ctx.idx / total) * 100);
    progColor = light ? '#0d9488' : '#2dd4bf';
    lineHtml = `<span>Question ${ctx.idx + 1} of ${total}</span>`;
  }
  const container = document.getElementById('view-container');
  let screen = document.getElementById('quiz-screen');
  if (!screen) {
    screen = document.createElement('div');
    screen.id = 'quiz-screen';
    if (container) {
      container.innerHTML = '';
      container.appendChild(screen);
    } else {
      document.body.appendChild(screen);
    }
  }
  screen.innerHTML = `
    <div class="quiz-in w-full h-[calc(100vh-5px)] p-[5px] flex flex-col">
      <div class="flex items-center gap-3">
        <button type="button" onclick="quitQuiz()" title="Back to Review (Esc)"
          class="w-9 h-9 flex items-center justify-center rounded-xl border ${themeChoice('border-[#22222e] text-gray-400 hover:text-white hover:border-purple-500/40', 'border-[#d9dde7] text-gray-500 hover:text-gray-900 hover:border-purple-400')} transition-colors flex-shrink-0">${icon('chevronLeft', 'w-4 h-4')}</button>
        <div class="min-w-0 flex-1">
          <div class="text-sm font-semibold ${themeChoice('text-white', 'text-gray-900')} truncate">${escapeHtml(ctx.title)}</div>
          ${ctx.chapterTitle ? `<div class="text-xs ${themeChoice('text-gray-500', 'text-gray-600')} truncate">${escapeHtml(ctx.chapterTitle)}</div>` : ''}
        </div>
        <div class="flex items-center gap-1.5 text-[11px] uppercase tracking-wider ${themeChoice('text-gray-500', 'text-gray-600')} flex-shrink-0">
          <span class="${themeChoice('text-teal-400/90', 'text-teal-600')} font-semibold">${ctx.correctCount} correct</span>
        </div>
      </div>
      <div class="h-1 ${themeChoice('bg-[#1c1c26]', 'bg-gray-200')} rounded-full overflow-hidden my-4">
        <div class="h-full rounded-full transition-all duration-300" style="width:${progPct}%;background:${progColor}"></div>
      </div>
      <div class="flex items-center gap-2 text-[11px] uppercase tracking-wider ${themeChoice('text-gray-500', 'text-gray-600')} mb-3">
        ${lineHtml}
      </div>
      <div class="flex-1 flex flex-col justify-center py-2">
        <h2 class="text-2xl sm:text-3xl md:text-4xl font-semibold leading-snug text-center ${themeChoice('text-white', 'text-gray-900')} mb-8 quiz-in flex-1 flex items-center justify-center">${escapeHtml(q.q)}</h2>
        <div id="quiz-options" class="grid grid-cols-1 sm:grid-cols-2 flex-1" style="gap:3px;padding:3px"></div>
      </div>
      <div id="quiz-footer" class="min-h-10 py-3"></div>
    </div>`;
  renderQuizOptions();
  renderQuizFooter();
}

function renderQuizOptions() {
  const ctx = _quizCtx;
  if (!ctx) return;
  const el = document.getElementById('quiz-options');
  if (!el) return;
  const q = quizCurrentQuestion(ctx);
  const opts = q.options || [];
  const light = state.theme === 'light';
  el.innerHTML = opts.map((opt, i) => {
    const st = QUIZ_OPTION_STYLES[i % QUIZ_OPTION_STYLES.length];
    let cls, badgeCls, delayAttr = '';
    if (ctx.answered) {
      if (i === q.correct) {
        cls = 'quiz-pop bg-green-500 border-green-500 text-white';
        badgeCls = 'bg-white/25 text-white';
      } else if (i === ctx.picked) {
        cls = 'quiz-flash bg-red-500/30 border-red-500 text-red-200';
        badgeCls = 'bg-red-500/30 text-red-100';
        if (light) { cls = 'quiz-flash bg-red-500/15 border-red-500 text-red-700'; badgeCls = 'bg-red-500/20 text-red-700'; }
      } else {
        cls = 'opacity-40 border-[#22222e] bg-[#16161f] text-gray-400';
        badgeCls = 'bg-[#22222e] text-gray-500';
        if (light) { cls = 'opacity-40 border-[#d9dde7] bg-white text-gray-500'; badgeCls = 'bg-gray-200 text-gray-500'; }
      }
    } else {
      cls = 'quiz-in ' + (light ? st.lightRest : st.rest);
      badgeCls = light ? st.lightBadge : st.badge;
      delayAttr = ` style="animation-delay:${i * 40}ms"`;
    }
    return `<button type="button" onclick="quizPick(${i})"
      class="w-full h-full flex items-center justify-center text-center rounded-xl border px-5 py-6 transition-all duration-150 ${cls} ${ctx.answered ? 'cursor-default' : 'cursor-pointer'}"${delayAttr}>
      <span class="text-lg sm:text-xl md:text-2xl font-medium break-words">${escapeHtml(opt)}</span>
    </button>`;
  }).join('');
}

function renderQuizFooter() {
  const ctx = _quizCtx;
  if (!ctx) return;
  const el = document.getElementById('quiz-footer');
  if (!el) return;
  const q = quizCurrentQuestion(ctx);
  if (!ctx.answered) {
    el.innerHTML = `<div class="text-xs ${themeChoice('text-gray-600', 'text-gray-500')} text-center">Pick an answer — or press <span class="${themeChoice('text-gray-400', 'text-gray-700')} font-medium">1–${(quizCurrentQuestion(ctx)?.options || []).length || 4}</span></div>`;
    return;
  }
  if (ctx.picked === q.correct) {
    el.innerHTML = `<div class="text-sm ${themeChoice('text-green-400', 'text-green-600')} font-medium text-center">Correct — click anywhere to continue</div>`;
    return;
  }
  const correctLetter = QUIZ_LETTERS[q.correct] || (q.correct + 1);
  const delay = Math.max(0, parseFloat(state.quizDelay ?? 3) || 0);
  el.innerHTML = `
    <div class="text-center">
      <div class="text-sm ${themeChoice('text-red-400', 'text-red-600')} font-medium">Not quite — the answer is ${correctLetter}.</div>
      ${delay > 0
        ? `<div class="text-xs ${themeChoice('text-gray-500', 'text-gray-500')} mt-1" id="quiz-countdown">Locked — continue in ${Math.ceil(delay)}s</div>`
        : `<div class="text-xs ${themeChoice('text-gray-500', 'text-gray-500')} mt-1">Click anywhere to continue</div>`}
    </div>`;
}

function quizPick(i) {
  const ctx = _quizCtx;
  if (!ctx || ctx.answered) return;
  const q = quizCurrentQuestion(ctx);
  if (!q || i < 0 || i >= (q.options || []).length) return;
  ctx.answered = true;
  ctx.picked = i;
  ctx.ignoreNextClick = true;
  const correct = i === q.correct;
  if (correct) ctx.correctCount++;
  recordQuizAnswer(ctx.url, correct);                    // saves accuracy as you go
  renderQuizOptions();
  renderQuizFooter();
  if (correct) return; // any click continues
  const delay = Math.max(0, parseFloat(state.quizDelay ?? 3) || 0);
  if (delay <= 0) { ctx.locked = false; return; }
  ctx.locked = true;
  let remaining = delay;
  const el = document.getElementById('quiz-countdown');
  const tick = () => {
    remaining -= 0.1;
    if (remaining <= 0) {
      clearInterval(ctx.countdownInt);
      ctx.countdownInt = null;
      ctx.locked = false;
      if (el) el.textContent = 'Click anywhere to continue';
      return;
    }
    if (el) el.textContent = 'Locked — continue in ' + Math.max(1, Math.ceil(remaining)) + 's';
  };
  ctx.countdownInt = setInterval(tick, 100);
  tick();
}

function quizGlobalClick() {
  const ctx = _quizCtx;
  const q = ctx && quizCurrentQuestion(ctx);
  if (!ctx || !ctx.answered || !q) return;
  if (ctx.ignoreNextClick) { ctx.ignoreNextClick = false; return; }
  if (ctx.picked === q.correct) { quizNext(); return; }
  if (ctx.locked) return;
  quizNext();
}

function quizGlobalKeydown(e) {
  const ctx = _quizCtx;
  if (!ctx) return;
  const q = quizCurrentQuestion(ctx);
  if (e.key === 'Escape') { e.preventDefault(); quitQuiz(); return; }
  if (ctx.answered) {
    if (q && (ctx.picked === q.correct || !ctx.locked) && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      quizNext();
    }
    return;
  }
  const map = { '1': 0, '2': 1, '3': 2, '4': 3, 'a': 0, 'b': 1, 'c': 2, 'd': 3 };
  const k = e.key.length === 1 ? e.key.toLowerCase() : '';
  if (k in map && map[k] < (q?.options || []).length) {
    e.preventDefault();
    quizPick(map[k]);
  }
}

function quizNext() {
  const ctx = _quizCtx;
  if (!ctx) return;
  if (ctx.timer) { clearTimeout(ctx.timer); ctx.timer = null; }
  if (ctx.countdownInt) { clearInterval(ctx.countdownInt); ctx.countdownInt = null; }
  ctx.ignoreNextClick = false;
  ctx.locked = false;
  // Levels mode: apply the just-answered card's queue effect, then advance render.
  if (ctx.mode === 'levels') {
    const q = quizCurrentQuestion(ctx);
    if (ctx.answered && q) applyLevelsAnswer(ctx, ctx.picked === q.correct);
    if (ctx.pendingLevelUp || ctx.lv.queue.length === 0 || ctx.lv.pos >= ctx.lv.queue.length) { renderLevelUp(); return; }
    ctx.answered = false;
    ctx.picked = -1;
    renderQuizScreen();
    return;
  }
  if (ctx.idx + 1 >= ctx.questions.length) { renderQuizResult(); return; }
  ctx.idx++;
  ctx.answered = false;
  ctx.picked = -1;
  renderQuizScreen();
}

function renderQuizResult() {
  const ctx = _quizCtx;
  if (!ctx) return;
  const total = ctx.questions.length;
  const pct = total ? Math.round((ctx.correctCount / total) * 100) : 0;
  // Accuracy was recorded per-answer — just show the summary here.
  const stat = getQuizStats(ctx.url);
  const overallPct = stat && stat.total ? stat.pct : pct;
  const msg = overallPct >= 90 ? 'Crushed it.' : overallPct >= 70 ? 'Solid work.' : overallPct >= 50 ? 'Getting there.' : 'Worth another pass.';
  const light = state.theme === 'light';
  const color = light
    ? (overallPct >= 90 ? 'text-teal-600' : overallPct >= 70 ? 'text-blue-600' : overallPct >= 50 ? 'text-amber-600' : 'text-orange-600')
    : (overallPct >= 90 ? 'text-teal-400' : overallPct >= 70 ? 'text-blue-400' : overallPct >= 50 ? 'text-amber-400' : 'text-orange-400');
  const screen = document.getElementById('quiz-screen');
  if (screen) {
    screen.innerHTML = `
      <div class="quiz-in max-w-md mx-auto px-1 py-10 min-h-[50vh] flex flex-col items-center justify-center text-center">
        <button type="button" onclick="quitQuiz()" title="Back to Review (Esc)"
          class="self-start w-9 h-9 flex items-center justify-center rounded-xl border ${themeChoice('border-[#22222e] text-gray-400 hover:text-white hover:border-purple-500/40', 'border-[#d9dde7] text-gray-500 hover:text-gray-900 hover:border-purple-400')} transition-colors flex-shrink-0 mb-6">${icon('chevronLeft', 'w-4 h-4')}</button>
        <div class="w-20 h-20 flex items-center justify-center mb-6">${ringPct(overallPct, 80, accRingColor(overallPct))}</div>
        <div class="${themeChoice('text-gray-300', 'text-gray-800')} font-medium mb-1">${ctx.correctCount} of ${total} correct this round</div>
        <div class="${themeChoice('text-gray-500', 'text-gray-600')} text-sm mb-2">${stat && stat.total ? `Overall accuracy: ${stat.correct}/${stat.total}` : 'First run'}</div>
        <div class="${themeChoice('text-gray-500', 'text-gray-600')} text-sm mb-8">${msg}</div>
        <div class="w-full grid gap-2.5">
          <button type="button" onclick="restartQuiz()" class="w-full flex items-center justify-center gap-2 bg-teal-500/20 border border-teal-500/30 rounded-xl px-4 py-3 text-sm font-medium ${themeChoice('text-teal-300', 'text-teal-700')} hover:bg-teal-500/30 transition-all">${icon('restart', 'w-4 h-4')}Try again</button>
          <button type="button" onclick="quitQuiz()" class="w-full flex items-center justify-center gap-2 text-sm font-medium ${themeChoice('text-gray-400 border-[#22222e] hover:text-white hover:border-teal-500/40', 'text-gray-600 border-[#d9dde7] hover:text-gray-900 hover:border-teal-500')} border rounded-xl px-4 py-3 transition-all">Back to Review</button>
        </div>
      </div>`;
  }
}

function restartQuiz() {
  const ctx = _quizCtx;
  if (!ctx) return;
  ctx.questions = quizBuildQuestions(ctx.source);
  ctx.idx = 0;
  ctx.correctCount = 0;
  ctx.answered = false;
  ctx.picked = -1;
  renderQuizScreen();
}

function teardownQuiz() {
  const ctx = _quizCtx;
  if (!ctx) return;
  if (ctx.timer) clearTimeout(ctx.timer);
  if (ctx.countdownInt) clearInterval(ctx.countdownInt);
  document.removeEventListener('click', quizGlobalClick);
  document.removeEventListener('keydown', quizGlobalKeydown);
  const screen = document.getElementById('quiz-screen');
  if (screen) screen.remove();
  _quizCtx = null;
  state.quizActive = false;
}

function quitQuiz() {
  teardownQuiz();
  navigate('planner');
}

// ─── LEVEL-UP PAGE + MASTERED SCREEN ────────────────────────────
function renderLevelUp() {
  const ctx = _quizCtx;
  if (!ctx) return;
  const st = ctx.lv;
  const completedLevel = Math.min(3, st.round);
  const completedName = LEVELS[completedLevel]?.name || 'unknown';
  const completedColor = levelColor(completedLevel, isLightTheme());
  const nextLevel = st.round >= 3 ? null : Math.min(3, st.round + 1);
  const nextName = nextLevel != null ? (LEVELS[nextLevel]?.name || '') : null;
  const stat = getQuizStats(ctx.url);
  const overallPct = stat && stat.total ? stat.pct : 0;
  const nr = st.cards.filter(c => c.nr).length;
  const mastered = st.cards.filter(c => c.lvl === 3 && c.done3).length;
  const light = state.theme === 'light';
  const screen = document.getElementById('quiz-screen');
  if (!screen) return;
  screen.innerHTML = `
    <div class="quiz-in max-w-md mx-auto px-1 py-10 min-h-[55vh] flex flex-col items-center justify-center text-center">
      <button type="button" onclick="levelFinishNow()" title="Back to Review"
        class="self-start w-9 h-9 flex items-center justify-center rounded-xl border ${themeChoice('border-[#22222e] text-gray-400 hover:text-white hover:border-purple-500/40', 'border-[#d9dde7] text-gray-500 hover:text-gray-900 hover:border-purple-400')} transition-colors flex-shrink-0 mb-6">${icon('chevronLeft', 'w-4 h-4')}</button>
      <div class="mb-6">${ringPct(100, 80, completedColor)}</div>
      <h2 class="text-2xl font-bold ${themeChoice('text-white', 'text-gray-900')} mb-1">Level cleared!</h2>
      <div class="text-sm font-medium mb-1" style="color:${completedColor}">You finished the '${escapeHtml(completedName)}' level</div>
      <div class="${themeChoice('text-gray-500', 'text-gray-600')} text-sm mb-4">Overall accuracy: ${stat && stat.total ? stat.correct + '/' + stat.total + ' (' + overallPct + '%)' : 'first run'}</div>
      ${nr ? `<div class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-500/15 text-red-400 text-xs font-medium mb-4">${nr} question${nr === 1 ? '' : 's'} need review</div>` : ''}
      <div class="${themeChoice('text-gray-500', 'text-gray-600')} text-xs mb-8">Question mastery: ${mastered}/${st.cards.length}</div>
      <div class="w-full grid gap-2.5">
        ${nextLevel != null
          ? `<button type="button" onclick="levelContinue()" class="w-full flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-medium transition-all border" style="border-color:${levelColor(nextLevel, light)}55;background:${levelColor(nextLevel, light)}1a;color:${levelColor(nextLevel, light)}">${icon('chevronRight', 'w-4 h-4')}Continue to '${escapeHtml(nextName)}'</button>`
          : `<button type="button" onclick="levelContinue()" class="w-full flex items-center justify-center gap-2 bg-green-500/20 border border-green-500/30 rounded-xl px-4 py-3 text-sm font-medium ${themeChoice('text-green-300', 'text-green-700')} hover:bg-green-500/30 transition-all">${icon('star', 'w-4 h-4')}Complete mastery</button>`}
        <button type="button" onclick="levelFinishNow()" class="w-full flex items-center justify-center gap-2 text-sm font-medium ${themeChoice('text-gray-400 border-[#22222e] hover:text-white', 'text-gray-600 border-[#d9dde7] hover:text-gray-900')} border rounded-xl px-4 py-3 transition-all">Finish for now</button>
      </div>
    </div>`;
}

function levelContinue() {
  const ctx = _quizCtx;
  if (!ctx) return;
  // Reuse the same reconcile logic as resume: skip any fully-cleared rounds
  // (drained queue) and land on the next round that has questions, or mastered.
  if (!advanceLevelsRounds(ctx)) return;
  ctx.answered = false;
  ctx.picked = -1;
  renderQuizScreen();
}

function levelFinishNow() {
  const ctx = _quizCtx;
  if (!ctx) return;
  const st = ctx.lv;
  st.done = true;
  saveLevelState(ctx.setUrl, st);
  showToast(`'${LEVELS[Math.min(3, st.round)]?.name || 'level'}' cleared — nice work!`, 'success');
  teardownQuiz();
  navigate('planner');
}

function showLevelsMastered(setUrl, title, chapterTitle, st) {
  const stat = getQuizStats(setUrl);
  const overallPct = stat && stat.total ? stat.pct : 0;
  let screen = document.getElementById('quiz-screen');
  if (!screen) {
    // When the user opens an already-mastered set from the Review page, the
    // quiz-screen div hasn't been created yet — create it here so the screen
    // actually appears instead of silently bailing.
    screen = document.createElement('div');
    screen.id = 'quiz-screen';
    const container = document.getElementById('view-container');
    if (container) { container.innerHTML = ''; container.appendChild(screen); }
    else { document.body.appendChild(screen); }
  }
  state.quizActive = true; // keep modal-ish screen until dismissed
  screen.innerHTML = `
    <div class="quiz-in max-w-md mx-auto px-1 py-10 min-h-[55vh] flex flex-col items-center justify-center text-center">
      <button type="button" onclick="quitQuiz()" title="Back to Review"
        class="self-start w-9 h-9 flex items-center justify-center rounded-xl border ${themeChoice('border-[#22222e] text-gray-400 hover:text-white hover:border-purple-500/40', 'border-[#d9dde7] text-gray-500 hover:text-gray-900 hover:border-purple-400')} transition-colors flex-shrink-0 mb-6">${icon('chevronLeft', 'w-4 h-4')}</button>
      <div class="mb-6">${ringPct(100, 80, levelColor(3, isLightTheme()))}</div>
      <h2 class="text-2xl font-bold ${themeChoice('text-white', 'text-gray-900')} mb-1">Set mastered!</h2>
      <div class="text-sm font-medium mb-1" style="color:${levelColor(3, isLightTheme())}">${escapeHtml(title)}</div>
      <div class="${themeChoice('text-gray-500', 'text-gray-600')} text-sm mb-2">Overall accuracy: ${stat && stat.total ? stat.correct + '/' + stat.total + ' (' + overallPct + '%)' : 'no data'}</div>
      <div class="${themeChoice('text-gray-500', 'text-gray-600')} text-sm mb-8">Every question reached 'mastered' — outstanding.</div>
      <div class="w-full grid gap-2.5">
        <button type="button" onclick="levelContinueReview()" class="w-full flex items-center justify-center gap-2 bg-teal-500/20 border border-teal-500/30 rounded-xl px-4 py-3 text-sm font-medium ${themeChoice('text-teal-300', 'text-teal-700')} hover:bg-teal-500/30 transition-all">${icon('play', 'w-4 h-4')}Continue reviewing</button>
        <button type="button" onclick="quitQuiz()" class="w-full flex items-center justify-center gap-2 text-sm font-medium ${themeChoice('text-gray-400 border-[#22222e] hover:text-white', 'text-gray-600 border-[#d9dde7] hover:text-gray-900')} border rounded-xl px-4 py-3 transition-all">Back to Review</button>
      </div>
    </div>`;
}

function levelRestartSet() {
  const ctx = _quizCtx;
  if (!ctx) return;
  const url = ctx.setUrl, title = ctx.title, chapterTitle = ctx.chapterTitle;
  deleteLevelState(url);
  teardownQuiz();
  startQuiz(url, title);  // re-enters levels mode with a fresh state
}

function levelContinueReview() {
  const ctx = _quizCtx;
  if (!ctx) return;
  const st = ctx.lv;
  // Build a review queue of every card. The existing requeue system handles wrong answers.
  st.reviewMode = true;
  st.cards.forEach((c, i) => { if (c.lvl === 3 && c.done3) c.lvl = 2; });
  const idxs = st.cards.map((_, i) => i);
  st.queue = quizShuffle(idxs);
  st.pos = 0;
  st.done = false;
  saveLevelState(ctx.setUrl, st);
  state.quizActive = true;
  document.addEventListener('click', quizGlobalClick);
  document.addEventListener('keydown', quizGlobalKeydown);
  ensureQuizCss();
  renderQuizScreen();
  window.scrollTo(0, 0);
}
