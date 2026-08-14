/* ================================================================
   GradeTrack v2 — Full Application
   Real data from FACTS SIS, computed analytics, watchlist
   ================================================================ */

// ─── STATE ───────────────────────────────────────────────────────
const state = {
  data: null, computed: null, currentView: 'overview',
  filters: { course: 'all', category: 'all', status: 'all' },
  calendarMonth: new Date().getMonth(), calendarYear: new Date().getFullYear(),
  loading: true, error: null, lastUpdated: null,
  trendView: 'overall', trendActive: null,
  gradePeriod: null, assignmentsPeriod: null,
  settingsOpen: false,
  goal: 90,
  perClassGoals: {},
  excludedClassIds: [],
  apiKeys: {},
  settingsReturnView: 'overview',
  trackedClassIds: null,
  assignmentsClassId: null,
  aiInsights: null,
  calendarSelectedDate: null,
  trendShowOverall: true,
  theme: 'dark',
  autoRefreshMinutes: 5,
  quizDelay: 3,
  levelsEnabled: false,
  autoScrape: { enabled: false, times: '07:00', period: 'all', classes: 'all' },
  scrapeLog: { running: false, exitCode: null, logs: [] },
  aiConversation: [],
  aiChat: [],
  aiAskLoading: false,
  aiDraft: '',
  customBlooketFile: null,
  customBlooketRunning: false,
  blooketLoaded: false,
  blooketClasses: [],
  blooketCustomSets: [],
  reviewQuery: '',
  expandedClasses: {},
  quizActive: false,
  trilium: { url: '', token: '', connected: false, notes: {}, cache: {} },
  renderedOnce: false,
  refreshTimer: null
};

const VIEWS = ['overview', 'assignments', 'grades', 'calendar', 'planner', 'goals', 'insights', 'settings'];
const GRADE_VIEWS = ['grades', 'insights', 'goals'];
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const COLORS = ['#3b82f6','#8b5cf6','#2dd4bf','#eab308','#f97316','#06b6d4','#ec4899','#a855f7','#22c55e'];

// Levels-based review: each question climbs unknown → familiar → proficient → mastered.
const LEVELS = [
  { name: 'unknown', color: '#94a3b8', light: '#475569' },
  { name: 'familiar', color: '#2dd4bf', light: '#0f766e' },
  { name: 'proficient', color: '#a855f7', light: '#7c3aed' },
  { name: 'mastered', color: '#22c55e', light: '#15803d' },
];
const LEVELS_STORE = 'gradetrack-levels-v1';

// Period definitions shared with the server compute layer
const PERIOD_ORDER = ['q1', 'q2', 'q3', 'q4', 's1', 's2', 'year'];
const QUARTER_PERIODS = ['q1', 'q2', 'q3', 'q4'];
const PERIOD_LABELS = { q1: 'Q1', q2: 'Q2', q3: 'Q3', q4: 'Q4', s1: 'Sem 1', s2: 'Sem 2', year: 'Full Year' };
const PERIOD_TERMS = { q1: [1], q2: [2], q3: [3], q4: [4], s1: [1, 2], s2: [3, 4], year: [1, 2, 3, 4] };
const PERIOD_FULL = { q1: 'Quarter 1', q2: 'Quarter 2', q3: 'Quarter 3', q4: 'Quarter 4', s1: 'Semester 1', s2: 'Semester 2', year: 'Full Year' };

function defaultPeriod() {
  return 'q' + (state.computed?.meta?.currentTerm || 4);
}

function periodIn(period, term) {
  return PERIOD_TERMS[period]?.includes(term);
}

function periodLine(cls, period) {
  return (cls.periodRunning && cls.periodRunning[period]) || [];
}

function periodGrade(cls, period) {
  return cls.periodGrade?.[period] ?? null;
}

function gradeAt(line, date) {
  let latest = null;
  for (const p of line) { if (p.date <= date && p.grade != null) latest = p.grade; }
  return latest;
}

function prevCatAvg(line, name) {
  const prev = [...line].reverse().find(p => p.grade != null);
  return (prev && prev.catAverages && prev.catAverages[name] != null) ? prev.catAverages[name] : null;
}

function periodStats(d, period) {
  const line = (d.overallPeriods && d.overallPeriods[period]) || [];
  const last = [...line].reverse().find(p => p.grade != null);
  return { line, grade: last ? last.grade : null, points: line.length };
}

function toggleSidebar() {
  document.querySelector('.sidebar')?.classList.toggle('open');
  document.getElementById('sidebar-overlay')?.classList.toggle('open');
}
window.toggleSidebar = toggleSidebar;

function isDesktop() {
  return window.matchMedia('(min-width: 769px)').matches;
}

function isSidebarCollapsed() {
  return isDesktop() && document.body.classList.contains('sidebar-collapsed');
}

function setSidebarCollapsed(collapsed) {
  if (!isDesktop()) {
    document.body.classList.remove('sidebar-collapsed');
    return;
  }
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  try { localStorage.setItem('gradetrack-sidebar-collapsed', collapsed ? '1' : '0'); } catch (err) {}
}

function toggleSidebarCollapsed() {
  setSidebarCollapsed(!isSidebarCollapsed());
}
window.toggleSidebarCollapsed = toggleSidebarCollapsed;

function applyTheme(theme) {
  const resolved = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = resolved;
  document.body?.setAttribute('data-theme', resolved);
  state.theme = resolved;
  try { localStorage.setItem('gradetrack-theme', resolved); } catch (err) {}
  updateThemeControls();
}

function updateThemeControls() {
  document.querySelectorAll('[data-theme-choice]').forEach(btn => {
    const active = btn.dataset.themeChoice === state.theme;
    btn.classList.toggle('active', active);
    btn.classList.toggle('bg-blue-500/15', active);
    btn.classList.toggle('text-blue-300', active);
  });
}

function setThemeMode(theme) {
  applyTheme(theme);
}
window.setThemeMode = setThemeMode;

function isLightTheme() {
  return state.theme === 'light';
}

function themeChoice(darkClass, lightClass) {
  return isLightTheme() ? lightClass : darkClass;
}

function reportAverageColor() {
  return isLightTheme() ? '#1f2937' : '#60a5fa';
}

function getAutoRefreshInterval() {
  const value = parseInt(state.autoRefreshMinutes, 10);
  return Number.isFinite(value) && value > 0 ? value : 5;
}

function scheduleAutoRefresh() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  const intervalMs = getAutoRefreshInterval() * 60 * 1000;
  state.refreshTimer = setInterval(() => {
    refreshData({ silent: true });
  }, intervalMs);
}

function captureScrollState() {
  const chat = document.getElementById('ai-chat-log');
  return {
    x: window.scrollX,
    y: window.scrollY,
    chatTop: chat ? chat.scrollTop : null,
    chatLeft: chat ? chat.scrollLeft : null,
  };
}

function restoreScrollState(snapshot) {
  if (!snapshot) return;
  requestAnimationFrame(() => {
    window.scrollTo(snapshot.x || 0, snapshot.y || 0);
    const chat = document.getElementById('ai-chat-log');
    if (chat && snapshot.chatTop != null) {
      chat.scrollTop = snapshot.chatTop;
      chat.scrollLeft = snapshot.chatLeft || 0;
    }
  });
}

// ─── HELPERS ─────────────────────────────────────────────────────
function letterGrade(score) {
  if (score == null || isNaN(score)) return 'N/A';
  const tiers = [[93,'A'],[90,'A-'],[87,'B+'],[83,'B'],[80,'B-'],[77,'C+'],[73,'C'],[70,'C-'],[67,'D+'],[60,'D'],[0,'F']];
  for (const [m,l] of tiers) if (score >= m) return l;
  return 'F';
}

function gradeColor(score) {
  if (score == null || isNaN(score)) return '#6c6c7c';
  const goal = (typeof state !== 'undefined' && state && state.goal != null && !isNaN(state.goal)) ? state.goal : 90;
  if (score >= Math.max(goal + 5, 95) && score < 100) return '#eab308';
  if (score >= Math.max(goal, 90)) return '#22c55e';
  if (score >= 70) return '#f97316';
  return '#ef4444';
}

function goalColor(score, goal) {
  if (score == null || isNaN(score)) return '#6c6c7c';
  if (goal == null || isNaN(goal)) goal = (state && state.goal != null) ? state.goal : 90;
  if (score >= goal + 5 && score < 100) return '#eab308';
  if (score >= goal) return '#22c55e';
  return '#f97316';
}

function goalFor(c) {
  if (c && state.perClassGoals && state.perClassGoals[c.id] != null) return state.perClassGoals[c.id];
  return state.goal;
}

function daysUntil(dateStr) {
  if (!dateStr) return '';
  const now = new Date(), target = new Date(dateStr + 'T23:59:59');
  const diff = Math.ceil((target - now) / 86400000);
  if (diff < 0) return 'Overdue';
  if (diff === 0) return 'Today'; if (diff === 1) return 'Tomorrow';
  if (diff < 7) return `In ${diff} days`;
  const w = Math.floor(diff / 7);
  return w === 1 ? 'In 1 week' : `In ${w} weeks`;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T12:00:00');
  return `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function timeSince(date) {
  if (!date) return 'never';
  const s = Math.floor((new Date() - new Date(date)) / 1000);
  if (s < 10) return 'just now'; if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function trendArrow(trend) {
  if (trend === 'improving') return '<span class="text-green-400">↗</span>';
  if (trend === 'declining') return '<span class="text-red-400">↘</span>';
  return '<span class="text-gray-500">→</span>';
}

function shorten(name, max = 18) {
  return name && name.length > max ? name.slice(0, max) + '...' : name;
}

// ─── ICONS ───────────────────────────────────────────────────────
const ICONS = {
  home:'<path d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  book:'<path d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18c1.746 0 3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.746 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  clipboard:'<path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002-2h2a2 2 0 012 2M9 5a2 2 0 012 2h2a2 2 0 012-2m-6 9l2 2 4-4" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  chart:'<path d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  trend:'<path d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  calendar:'<path d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  clock:'<path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  target:'<circle cx="12" cy="12" r="9" stroke="currentColor" fill="none" stroke-width="2"/><circle cx="12" cy="12" r="4.5" stroke="currentColor" fill="none" stroke-width="2"/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
  star:'<path d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  bell:'<path d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  plus:'<path d="M12 4v16m8-8H4" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  check:'<path d="M5 13l4 4L19 7" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  x:'<path d="M6 18L18 6M6 6l12 12" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  external:'<path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  chevronDown:'<path d="M19 9l-7 7-7-7" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  chevronLeft:'<path d="M15 19l-7-7 7-7" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  chevronRight:'<path d="M9 5l7 7-7 7" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  arrowUp:'<path d="M5 10l7-7m0 0l7 7m-7-7v18" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  search:'<path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  settings:'<path d="M12 15a3 3 0 100-6 3 3 0 000 6z"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  sparkle:'<path d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  alert:'<path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  filter:'<path d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  file:'<path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  upload:'<path d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M12 4v12m0-12l-4 4m4-4l4 4" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  play:'<path d="M8 5.14v13.72a1 1 0 001.5.86l11-6.86a1 1 0 000-1.72l-11-6.86a1 1 0 00-1.5.86z" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  restart:'<path d="M4 4v6h6M20 20v-6h-6M20 9A8 8 0 005.64 5.64L4 8m0 0V4m16 12v4m0-4h-4" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
};

function icon(name, cls = 'w-5 h-5') {
  return ICONS[name] ? `<svg class="${cls}" viewBox="0 0 24 24">${ICONS[name]}</svg>` : '';
}

function badge(text, color = 'blue') {
  const m = {blue:'bg-blue-500/10 text-blue-400',green:'bg-green-500/10 text-green-400',orange:'bg-orange-500/10 text-orange-400',purple:'bg-purple-500/10 text-purple-400',yellow:'bg-yellow-500/10 text-yellow-400',red:'bg-red-500/10 text-red-400',teal:'bg-teal-500/10 text-teal-400'};
  return `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${m[color]||m.blue}">${text}</span>`;
}

// ─── DATA LAYER ──────────────────────────────────────────────────
async function fetchComputed() {
  state.loading = true;
  const timeout = (ms, label) => new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout fetching ' + label)), ms));
  const getJSON = (url, label) => Promise.race([fetch(url), timeout(20000, label)]).then(res => {
    if (!res.ok) throw new Error('API ' + url + ' returned HTTP ' + res.status);
    return res.json();
  });

  // Fetch in parallel, in the background; merge + render as each arrives.
  const overviewP = getJSON('/api/computed/overview', '/api/computed/overview');
  const classesP = getJSON('/api/computed/classes', '/api/computed/classes');
  const assignmentsP = getJSON('/api/computed/assignments', '/api/computed/assignments');
  const insightsP = getJSON('/api/insights', '/api/insights');
  const settingsP = getJSON('/api/settings', '/api/settings');
  const scrapeLogP = getJSON('/api/scrape/logs', '/api/scrape/logs');

  const merge = (obj) => { state.computed = { ...(state.computed || {}), ...obj }; };

  try {
    const settings = await settingsP;
    state.goal = settings.goal || 90;
    state.perClassGoals = settings.perClassGoals || {};
    state.excludedClassIds = settings.excludedClassIds || [];
    state.apiKeys = settings.apiKeys || {};
    state.theme = settings.theme || state.theme || 'dark';
    state.autoRefreshMinutes = settings.autoRefreshMinutes || state.autoRefreshMinutes || 5;
    state.quizDelay = typeof settings.quizDelay === 'number' ? settings.quizDelay : state.quizDelay;
    state.levelsEnabled = !!settings.levelsEnabled;
    state.autoScrape = settings.autoScrape || state.autoScrape || { enabled: false, times: '07:00', period: 'all', classes: 'all' };
    state.trilium = { connected: false, cache: {}, ...(settings.trilium || state.trilium || {}) };
    applyTheme(state.theme);
    scheduleAutoRefresh();
  } catch (err) {
    console.error(err);
  }

  try {
    state.scrapeLog = await scrapeLogP;
  } catch (err) {
    state.scrapeLog = { running: false, exitCode: null, logs: [] };
  }

  try {
    const overview = await overviewP;
    merge(overview);
    if (overview.goal != null) state.goal = overview.goal;
    state.lastUpdated = overview.lastUpdated;
    state.loading = false;
    state.error = null;
  } catch (err) {
    state.loading = false;
    state.error = 'Failed to load: ' + (err.message || err) + '. Run the server with: npm start';
    console.error(err);
  }
  render();

  const classes = await classesP.catch(err => { console.error(err); return null; });
  if (classes) { merge(classes); render(); }

  const assignments = await assignmentsP.catch(err => { console.error(err); return null; });
  if (assignments) { merge(assignments); render(); }

  const aiInsights = await insightsP.catch(err => ({ status: 'error', message: err.message }));
  state.aiInsights = aiInsights;
  render();
}

async function refreshData(options = {}) {
  await fetchComputed();
  render();
  if (!state.error && !options.silent) showToast('Data refreshed!', 'success');
}

async function saveSettings(settings) {
  try {
    const res = await fetch('/api/settings', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(settings) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    state.goal = settings.goal || 90;
    state.perClassGoals = settings.perClassGoals || {};
    state.excludedClassIds = settings.excludedClassIds || [];
    state.apiKeys = settings.apiKeys || {};
    state.theme = settings.theme || state.theme || 'dark';
    state.autoRefreshMinutes = settings.autoRefreshMinutes || state.autoRefreshMinutes || 5;
    state.quizDelay = typeof settings.quizDelay === 'number' ? settings.quizDelay : state.quizDelay;
    state.levelsEnabled = !!settings.levelsEnabled;
    state.autoScrape = settings.autoScrape || state.autoScrape || { enabled: false, times: '07:00', period: 'all', classes: 'all' };
    state.trilium = { connected: false, cache: {}, ...(settings.trilium || state.trilium || {}) };
    applyTheme(state.theme);
    scheduleAutoRefresh();
    showToast('Settings saved!', 'success');
    return true;
  } catch(e) {
    showToast('Failed to save settings', 'error');
    return false;
  }
}

// ─── TOAST & MODAL ───────────────────────────────────────────────
function showToast(msg, type='success') {
  const light = isLightTheme();
  const m = {
    success: light ? 'bg-green-100 border-green-300 text-green-800' : 'bg-green-600 border-green-500 text-white',
    error: light ? 'bg-red-100 border-red-300 text-red-700' : 'bg-red-600 border-red-500 text-white',
    info: light ? 'bg-blue-100 border-blue-300 text-blue-800' : 'bg-blue-600 border-blue-500 text-white',
    warning: light ? 'bg-yellow-100 border-yellow-300 text-yellow-800' : 'bg-yellow-500 border-yellow-400 text-black',
  };
  const c = document.getElementById('toast-container');
  if (!c) return;
  const t = document.createElement('div');
  t.className = `${m[type]||m.info} border rounded-xl px-4 py-3 text-sm font-medium shadow-lg animate-slide-in`;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => { t.style.opacity='0'; t.style.transform='translateX(100%)'; t.style.transition='all 0.3s ease'; setTimeout(()=>t.remove(),300); }, 3500);
}
window.showToast = showToast;

function showModal(title, content, wide) {
  const overlay = document.getElementById('modal-overlay');
  const container = document.getElementById('modal-container');
  if (!overlay || !container) return;
  overlay.classList.remove('hidden');
  container.innerHTML = `<div class="bg-[#12121b] border border-[#22222e] rounded-2xl w-full ${wide ? 'max-w-4xl' : 'max-w-2xl'} max-h-[90vh] overflow-y-auto shadow-2xl">
    <div class="flex items-center justify-between p-6 border-b border-[#22222e] sticky top-0 bg-[#12121b] z-10">
      <h3 class="text-lg font-semibold text-white">${title}</h3>
      <button onclick="closeModal()" class="text-gray-500 hover:text-gray-300 transition-colors">${icon('x','w-5 h-5')}</button>
    </div>
    <div class="p-6">${content}</div>
  </div>`;
}
function closeModal() {
  document.getElementById('modal-overlay')?.classList.add('hidden');
  const mc = document.getElementById('modal-container');
  if (mc) mc.innerHTML = '';
}
window.closeModal = closeModal;

// ─── SKELETON ────────────────────────────────────────────────────
function skeleton() {
  return `<div class="animate-pulse space-y-4">
    <div class="h-8 bg-[#22222e] rounded-lg w-1/3"></div>
    <div class="grid grid-cols-1 md:grid-cols-4 gap-4">${Array(4).fill(0).map(()=>'<div class="h-28 bg-[#22222e] rounded-2xl"></div>').join('')}</div>
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4"><div class="h-72 bg-[#22222e] rounded-2xl"></div><div class="h-72 bg-[#22222e] rounded-2xl"></div></div>
  </div>`;
}

// ─── RUNNING AVERAGE CHART ──────────────────────────────────────
let _chartSeq = 0;
const __chartRegistry = {};

function fmtDateShort(d) {
  if (!d || d.length < 10) return d || '';
  const m = parseInt(d.slice(5, 7), 10) - 1;
  const day = parseInt(d.slice(8, 10), 10);
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return MONTHS[m] + ' ' + day;
}

function quarterBoundariesFrom(meta) {
  const qs = (meta && meta.quarterStarts) || {};
  return [1, 2, 3, 4].map(term => ({ term, date: qs[String(term)] })).filter(b => b.date);
}

// Interactive hover + click layer shared by every line chart
function chartHover(cid, i) {
  const d = __chartRegistry[cid];
  if (!d) return;
  const wrap = document.getElementById(cid);
  if (!wrap) return;
  const svg = wrap.querySelector('svg');
  const pt = d.points[i];
  if (!svg || !pt) return;

  svg.querySelectorAll('circle.chart-dp').forEach(el => {
    el.style.opacity = el.getAttribute('data-pt') === String(i) ? '1' : '0';
  });

  let line = wrap.querySelector('.chart-xhair');
  if (!line) {
    line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('class', 'chart-xhair');
    line.setAttribute('stroke', '#4b4b5c');
    line.setAttribute('stroke-width', '1');
    line.setAttribute('stroke-dasharray', '4,4');
    svg.appendChild(line);
  }
  line.setAttribute('x1', pt.x.toFixed(1));
  line.setAttribute('x2', pt.x.toFixed(1));
  line.setAttribute('y1', d.pad.top);
  line.setAttribute('y2', d.height - d.pad.bottom);

  const tip = wrap.querySelector('.chart-tip');
  if (tip) {
    if (d.series.length === 1) {
      const s = d.series[0];
      const g = s.valuesByDate[pt.date];
      tip.innerHTML = `<div class="text-[10px] uppercase tracking-wider text-gray-500 mb-0.5">${d.fmt ? d.fmt(pt.date) : pt.date}</div>
        <div class="text-xl font-bold" style="color:${s.color}">${g != null ? g + '%' : '—'}</div>`;
    } else {
      const rows = d.series.map(s => {
        const g = s.valuesByDate[pt.date];
        return g != null
          ? `<div class="flex items-center justify-between gap-4"><span class="inline-flex items-center gap-1.5 text-gray-300"><span class="w-2 h-2 rounded-full" style="background:${s.color}"></span>${s.label}</span><span class="font-semibold" style="color:${s.color}">${g}%</span></div>`
          : '';
      }).filter(Boolean).join('');
      tip.innerHTML = `<div class="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5">${d.fmt ? d.fmt(pt.date) : pt.date}</div>${rows}`;
    }
    tip.classList.remove('hidden');
  }
}

function chartMove(e, cid, i) {
  const d = __chartRegistry[cid];
  if (!d) return;
  const wrap = document.getElementById(cid);
  if (!wrap) return;
  const tip = wrap.querySelector('.chart-tip');
  if (tip) {
    const r = wrap.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    tip.style.left = Math.max(8, Math.min(r.width - tip.offsetWidth - 8, x)) + 'px';
    tip.style.top = Math.max(8, y - tip.offsetHeight - 10) + 'px';
  }
  const pt = d.points[i];
  const line = wrap.querySelector('.chart-xhair');
  if (pt && line) {
    line.setAttribute('x1', pt.x.toFixed(1));
    line.setAttribute('x2', pt.x.toFixed(1));
  }
}

function chartOut(cid) {
  const d = __chartRegistry[cid];
  if (!d) return;
  const wrap = document.getElementById(cid);
  if (!wrap) return;
  const tip = wrap.querySelector('.chart-tip');
  if (tip) tip.classList.add('hidden');
  const line = wrap.querySelector('.chart-xhair');
  if (line) line.remove();
  const svg = wrap.querySelector('svg');
  if (svg) {
    svg.querySelectorAll('circle.chart-dp').forEach(el => { el.style.opacity = '0'; });
    const last = wrap.querySelector('.chart-dp-last');
    if (last) last.style.opacity = '1';
  }
}

function chartClick(cid, i, ev) {
  const d = __chartRegistry[cid];
  if (!d) return;
  const pt = d.points[i];
  if (!pt) return;
  let activeSeries = null;
  if (d.multiClass && d.seriesPts && ev && ev.clientX != null) {
    const wrap = document.getElementById(cid);
    const svg = wrap?.querySelector('svg');
    if (svg) {
      const r = svg.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        const sx = ((ev.clientX - r.left) / r.width) * d.width;
        const sy = ((ev.clientY - r.top) / r.height) * d.height;
        let best = null, bestDist = Infinity;
        for (const entry of d.seriesPts) {
          for (const c2 of entry.coords) {
            const dist = Math.hypot(c2.x - sx, c2.y - sy);
            if (dist < bestDist) { bestDist = dist; best = entry.s; }
          }
        }
        if (best && bestDist < 22) activeSeries = best;
      }
    }
  }
  showDayTooltip(cid, i, activeSeries);
}

function runningAvgChart(dataPoints, height = 200, width = 600, color = '#3b82f6', showGoal = null, goal = 90, quarterBoundaries = null, opts = {}) {
  if (!dataPoints || dataPoints.length < 2) {
    return `<div class="flex items-center justify-center h-${height} text-gray-500 text-sm">Not enough data points</div>`;
  }

  const values = dataPoints.map(p => p.grade).filter(g => g != null);
  if (values.length < 2) return `<div class="flex items-center justify-center h-${height} text-gray-500 text-sm">Not enough data to plot</div>`;

  const min = Math.floor(Math.min(...values, showGoal ? goal - 5 : 70) / 5) * 5;
  const max = Math.ceil(Math.max(...values, 100) / 5) * 5;
  const range = max - min || 10;

  const pad = { top: 10, bottom: 25, left: 40, right: 10 };
  const cw = width - pad.left - pad.right;
  const ch = height - pad.top - pad.bottom;

  const xScale = (i) => pad.left + (i / (dataPoints.length - 1)) * cw;
  const yScale = (v) => pad.top + ((max - v) / range) * ch;

  const linePts = dataPoints.map((p, i) => p.grade != null ? `${xScale(i).toFixed(1)},${yScale(p.grade).toFixed(1)}` : null).filter(Boolean).join(' ');

  const areaPts = dataPoints.map((p, i) => {
    if (p.grade == null) return null;
    return `${xScale(i).toFixed(1)},${yScale(p.grade).toFixed(1)}`;
  }).filter(Boolean);
  if (areaPts.length > 0) {
    areaPts.unshift(`${xScale(0).toFixed(1)},${yScale(min).toFixed(1)}`);
    areaPts.push(`${xScale(dataPoints.length - 1).toFixed(1)},${yScale(min).toFixed(1)}`);
  }

  // Y-axis labels
  const yLabels = [];
  const step = Math.ceil(range / 4 / 5) * 5;
  for (let v = min; v <= max; v += step) {
    yLabels.push(v);
  }
  if (yLabels[yLabels.length - 1] < max) yLabels.push(max);

  // Goal line
  const goalY = showGoal ? yScale(goal) : null;

  const lastIdx = dataPoints.reduce((acc, p, i) => p.grade != null ? i : acc, -1);
  const spacing = cw / Math.max(1, dataPoints.length - 1);
  const cid = 'chart-' + (++_chartSeq);
  const gradId = 'rag-' + cid;
  const pts = dataPoints.map((p, i) => p.grade != null ? { x: xScale(i), y: yScale(p.grade), date: p.date, grade: p.grade } : null).filter(Boolean);
  const valuesByDate = {};
  for (const p of pts) valuesByDate[p.date] = p.grade;
  __chartRegistry[cid] = {
    points: pts, pad, width, height, color,
    series: [{ label: opts.title || '', color, valuesByDate }],
    classIds: opts.classIds || [], periodKey: opts.periodKey || 'year',
    title: opts.title || 'Assignments', fmt: fmtDateShort, lastIdx
  };

  return `
  <div class="chart-interactive relative" id="${cid}" style="width:100%">
    <svg viewBox="0 0 ${width} ${height}" style="width:100%; height:auto; display:block; max-width:${width}px;">
      <defs>
        <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="0.25"/>
          <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
        </linearGradient>
      </defs>

      <!-- Grid lines -->
      ${yLabels.map(v => `<line x1="${pad.left}" y1="${yScale(v)}" x2="${width - pad.right}" y2="${yScale(v)}" stroke="#1c1c26" stroke-width="1"/>`).join('')}

      <!-- Quarter boundary markers -->
      ${(quarterBoundaries || []).filter(b => b.term > 1).map(b => {
        const idx = dataPoints.findIndex(p => p.date >= b.date);
        if (idx <= 0) return '';
        const x = xScale(idx);
        return `<line x1="${x}" y1="${pad.top}" x2="${x}" y2="${height - pad.bottom}" stroke="#3d3d4d" stroke-width="1" stroke-dasharray="3,3" opacity="0.6"/>
          <text x="${x}" y="${pad.top + 8}" text-anchor="middle" fill="#8a8a9a" font-size="8">Q${b.term}</text>`;
      }).join('')}

      <!-- Y-axis labels -->
      ${yLabels.map(v => `<text x="${pad.left - 6}" y="${yScale(v) + 4}" text-anchor="end" fill="#6c6c7c" font-size="10">${v}%</text>`).join('')}

      <!-- Goal line -->
      ${goalY != null ? `<line x1="${pad.left}" y1="${goalY}" x2="${width - pad.right}" y2="${goalY}" stroke="#eab308" stroke-width="1.5" stroke-dasharray="5,4" opacity="0.7"/>
        <text x="${width - pad.right - 2}" y="${goalY - 4}" text-anchor="end" fill="#eab308" font-size="9">Goal ${goal}%</text>` : ''}

      <!-- Area fill -->
      ${areaPts.length > 2 ? `<polygon points="${areaPts.join(' ')}" fill="url(#${gradId})"/>` : ''}

      <!-- Line -->
      <polyline points="${linePts}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>

      <!-- Data points (hidden until hover) -->
      ${dataPoints.map((p, i) => p.grade != null ? `<circle class="chart-dp${i === lastIdx ? ' chart-dp-last' : ''}" data-pt="${i}" cx="${xScale(i)}" cy="${yScale(p.grade)}" r="${i === lastIdx ? 4 : 3}" fill="#0a0a0f" stroke="${color}" stroke-width="${i === lastIdx ? 2.5 : 1.5}" style="opacity:${i === lastIdx ? 1 : 0}"/>` : '').join('')}

      <!-- Last point value label -->
      ${(() => {
        const last = [...dataPoints].reverse().find(p => p.grade != null);
        if (!last) return '';
        const idx = dataPoints.indexOf(last);
        return `<text x="${xScale(idx)}" y="${yScale(last.grade) - 10}" text-anchor="middle" fill="${color}" font-size="10" font-weight="bold">${last.grade}%</text>`;
      })()}

      <!-- X-axis labels (show ~6 evenly spaced) -->
      ${(() => {
        const step = Math.max(1, Math.floor(dataPoints.length / 6));
        return dataPoints.map((p, i) => {
          if (i % step !== 0 && i !== dataPoints.length - 1) return '';
          const label = p.date ? fmtDateShort(p.date) : '';
          return `<text x="${xScale(i)}" y="${height - 6}" text-anchor="middle" fill="#6c6c7c" font-size="9">${label}</text>`;
        }).join('');
      })()}

      <!-- Hover hit zones -->
      ${dataPoints.map((p, i) => p.grade != null ? `<rect x="${(xScale(i) - spacing / 2).toFixed(1)}" y="${pad.top}" width="${spacing.toFixed(1)}" height="${ch}" fill="transparent" data-pt="${i}" onmouseover="chartHover('${cid}',${i})" onmousemove="chartMove(event,'${cid}',${i})" onmouseout="chartOut('${cid}')" onclick="chartClick('${cid}',${i})"/>` : '').join('')}
    </svg>
    <div class="chart-tip hidden"></div>
  </div>`;
}

// Day-detail sticky tooltip: hovers above the clicked point and follows it on scroll.
let __dayTip = null;

function showDayTooltip(cid, i, activeSeries) {
  const d = __chartRegistry[cid];
  if (!d) return;
  const pt = d.points[i];
  if (!pt) return;
  closeDayTip();
  let anchorPt = pt;
  if (d.seriesPts) {
    let anchor = null;
    if (activeSeries) {
      const entry = d.seriesPts.find(e => e.s === activeSeries);
      if (entry) anchor = entry.coords.find(c => c.date === pt.date) || null;
    }
    if (!anchor) {
      const oEntry = d.seriesPts.find(e => e.s.overall);
      if (oEntry) anchor = oEntry.coords.find(c => c.date === pt.date) || null;
    }
    if (!anchor) {
      for (const e of d.seriesPts) {
        const c = e.coords.find(c => c.date === pt.date);
        if (c) { anchor = c; break; }
      }
    }
    if (anchor) anchorPt = { x: anchor.x, y: anchor.y };
  }
  const el = document.createElement('div');
  el.className = 'day-tip';
  el.innerHTML = dayTooltipContent(pt.date, { classIds: d.classIds || [], periodKey: d.periodKey || 'year', title: d.title || 'Assignments', series: d.series, multiClass: d.multiClass, activeSeries });
  document.body.appendChild(el);
  __dayTip = { el, cid, i, pt: anchorPt };
  window.addEventListener('scroll', onDayTipMove, true);
  window.addEventListener('resize', onDayTipMove);
  window.addEventListener('keydown', onDayTipKey);
  setTimeout(() => document.addEventListener('click', onDayTipDocClick), 0);
  positionDayTip();
}

function dayTooltipContent(dateStr, opts) {
  const d = state.computed;
  if (!d || !dateStr) return '<div class="day-tip-head"><span class="text-[10px] uppercase tracking-wider text-gray-500">Day detail</span><button onclick="closeDayTip()" class="day-tip-close" aria-label="Close">✕</button></div><div class="day-tip-inner"><div class="text-xs text-gray-500">No data for this date.</div></div>';
  const classIds = opts.classIds || [];
  const periodKey = opts.periodKey || 'year';
  const activeSeries = opts.activeSeries || null;
  let activeClassId = null;
  if (activeSeries && !activeSeries.overall && activeSeries.classId) activeClassId = activeSeries.classId;
  const dt = new Date(dateStr + 'T12:00:00');
  const dateLabel = dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const blocks = [];
  for (const c of d.activeClasses) {
    if (!c.isAcademic) continue;
    if (activeClassId) { if (c.id !== activeClassId) continue; }
    else if (!classIds.includes(c.id)) continue;
    const asns = (d.allAssignments || []).filter(a => a.classId === c.id && a.dueDate === dateStr);
    if (asns.length === 0) continue;
    const line = c.periodRunning?.[periodKey] || [];
    let gradeAt = null;
    for (const p of line) { if (p.date <= dateStr && p.grade != null) gradeAt = p.grade; }
    const ci = d.activeClasses.indexOf(c);
    const color = COLORS[ci >= 0 ? ci % COLORS.length : 0];
    const rows = asns.map(a => {
      const isBelow = a.pct != null && a.pct < d.goal;
      return `<div class="flex items-center justify-between gap-3 py-1.5 border-b border-[#22222e]/50 last:border-0">
        <div class="min-w-0">
          <div class="text-xs text-gray-200 truncate">${a.name}</div>
          <div class="text-[10px] text-gray-500">${a.category}${a.status === 'Valid' ? '' : ' · ' + (a.status || '')}</div>
        </div>
        <div class="flex items-center gap-2 flex-shrink-0">
          <span class="text-[10px] text-gray-500">${a.pts != null ? a.pts + '/' + a.max : '—'}</span>
          ${a.pct != null ? `<span class="text-xs font-semibold" style="color:${gradeColor(a.pct)}">${a.pct}%</span>` : '<span class="text-xs text-gray-600">ungraded</span>'}
          ${isBelow ? `<span class="text-[10px] text-orange-400">-${Math.round(d.goal - a.pct)}</span>` : ''}
        </div>
      </div>`;
    }).join('');
    blocks.push(`<div class="py-2 ${blocks.length ? 'border-t border-[#22222e]' : ''}">
      <div class="flex items-center gap-2 mb-1">
        <span class="w-2 h-2 rounded-full flex-shrink-0" style="background:${color}"></span>
        <span class="text-xs font-semibold text-gray-200 truncate">${c.shortName || c.name}</span>
        ${gradeAt != null ? `<span class="text-xs font-bold ml-auto" style="color:${gradeColor(gradeAt)}">${gradeAt}%</span>` : ''}
      </div>
      ${rows}
    </div>`);
  }
  const body = blocks.length > 0 ? blocks.join('') : '<div class="py-3 text-center text-xs text-gray-500">No assignments on this day</div>';
  let contributing = '';
  if (opts.multiClass && opts.series && !activeClassId) {
    const rows = opts.series.filter(s => !s.overall).map(s => {
      const g = s.valuesByDate[dateStr];
      return g != null
        ? `<div class="flex items-center justify-between gap-4 py-0.5"><span class="inline-flex items-center gap-1.5 text-gray-300"><span class="w-2 h-2 rounded-full" style="background:${s.color}"></span>${s.label}</span><span class="font-semibold" style="color:${s.color}">${g}%</span></div>`
        : '';
    }).filter(Boolean).join('');
    if (rows) {
      contributing = `<div class="px-3 pt-1.5 pb-2">
        <div class="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Contributing grades</div>
        ${rows}
      </div>`;
    }
  }
  return `<div class="day-tip-head">
    <span class="text-[10px] uppercase tracking-wider text-gray-500">${dateLabel}</span>
    <button onclick="closeDayTip()" class="day-tip-close" aria-label="Close">✕</button>
  </div>
  <div class="day-tip-inner">${contributing}${body}</div>
  <span class="day-tip-arrow"></span>`;
}

function positionDayTip() {
  const t = __dayTip;
  if (!t) return;
  const d = __chartRegistry[t.cid];
  if (!d) return;
  const wrap = document.getElementById(t.cid);
  const svg = wrap && wrap.querySelector('svg');
  if (!svg) return;
  const rect = svg.getBoundingClientRect();
  const x = rect.left + (t.pt.x / d.width) * rect.width;
  const y = rect.top + (t.pt.y / d.height) * rect.height;
  const el = t.el;
  const tw = el.offsetWidth, th = el.offsetHeight;
  let left = x - tw / 2;
  left = Math.max(8, Math.min(window.innerWidth - tw - 8, left));
  let top = y - th - 14;
  let side = 'above';
  if (top < 8) { top = y + 14; side = 'below'; }
  el.style.left = left + 'px';
  el.style.top = top + 'px';
  el.setAttribute('data-side', side);
  el.style.setProperty('--arrow-x', Math.max(12, Math.min(tw - 12, x - left)) + 'px');
}

function onDayTipMove() { positionDayTip(); }

function onDayTipKey(e) {
  if (e.key === 'Escape') closeDayTip();
}

function onDayTipDocClick(e) {
  if (!__dayTip) return;
  const inTip = __dayTip.el.contains(e.target);
  const inChart = !!e.target.closest && !!e.target.closest('.chart-interactive');
  if (!inTip && !inChart) closeDayTip();
}

function closeDayTip() {
  if (!__dayTip) return;
  __dayTip.el.remove();
  __dayTip = null;
  window.removeEventListener('scroll', onDayTipMove, true);
  window.removeEventListener('resize', onDayTipMove);
  window.removeEventListener('keydown', onDayTipKey);
  document.removeEventListener('click', onDayTipDocClick);
}
window.closeDayTip = closeDayTip;

// ─── WATCHLIST BAR ──────────────────────────────────────────────
function renderWatchlistBar() {
  const w = state.computed?.watchlist;
  if (!w || w.length === 0) return '';
  const maxShow = 5;
  const shown = w.slice(0, maxShow);
  const remaining = w.length - maxShow;

  return `
  <div class="bg-[#12121b] border border-orange-500/20 rounded-xl px-4 py-2.5 mb-4 flex items-center gap-3 overflow-x-auto">
    <div class="flex items-center gap-1.5 text-orange-400 flex-shrink-0">
      ${icon('alert', 'w-4 h-4')}
      <span class="text-xs font-semibold whitespace-nowrap">${w.length} below goal</span>
    </div>
    <div class="flex items-center gap-2 text-xs flex-wrap">
      ${shown.map(a => `
        <button onclick="navigateToAlert('${a.classId}', '${a.categoryName || ''}')"
          class="flex items-center gap-1 px-2 py-1 rounded-lg bg-orange-500/10 text-orange-300 hover:bg-orange-500/20 transition-colors whitespace-nowrap">
          <span class="font-medium">${shorten(a.className, 12)}</span>
          ${a.categoryName ? `<span class="text-orange-400/70">· ${a.categoryName}</span>` : ''}
          <span class="font-bold" style="color:${gradeColor(a.currentGrade)}">${a.currentGrade}%</span>
        </button>
      `).join('')}
      ${remaining > 0 ? `<span class="text-gray-500 whitespace-nowrap">+${remaining} more</span>` : ''}
    </div>
  </div>`;
}

window.navigateToAlert = function(classId, categoryName) {
  state.currentView = 'grades';
  state.filters.course = classId;
  window.location.hash = 'grades';
  render();
};
window.navigate = navigate;

// ─── VIEW: OVERVIEW ─────────────────────────────────────────────
function renderOverview() {
  const d = state.computed;
  if (!d) return skeleton();
  const { overallGrade, overallLetter, overallGPA, overallRunning = [], activeClasses = [], allAssignments = [], watchlist = [], goal = 90, totalAssignments = 0, completedAssignments = 0 } = d;
  const qPeriod = defaultPeriod();
  const qLabel = PERIOD_LABELS[qPeriod] || qPeriod.toUpperCase();

  const totalGraded = allAssignments.filter(a => a.pts != null && a.pts !== '').length;
  const validCount = allAssignments.filter(a => a.status !== 'Excuse' && a.status !== 'Exempt').length;
  const missingCount = validCount - totalGraded;
  const completionRate = validCount > 0 ? Math.round((totalGraded / validCount) * 100) : 0;

  const classDist = {};
  for (const c of activeClasses) {
    const lg = c.weightedLetter || letterGrade(c.weightedGrade);
    classDist[lg] = (classDist[lg] || 0) + 1;
  }

  const distLetters = ['A','A-','B+','B','B-','C+','C','C-','D','F'];
  const distColors = {'A':'#22c55e','A-':'#2dd4bf','B+':'#60a5fa','B':'#3b82f6','B-':'#8b5cf6','C+':'#eab308','C':'#f97316','C-':'#ef4444','D':'#ef4444','F':'#dc2626'};
  state.gradeDistData = distLetters.filter(lg => (classDist[lg] || 0) > 0).map(lg => ({ name: lg, y: classDist[lg], color: distColors[lg] }));

  return `
  <div class="flex items-center justify-between mb-6">
    <div>
      <h1 class="text-2xl font-bold text-white">Dashboard</h1>
      <p class="text-gray-400 mt-1 text-sm">Academic Year ${d.meta?.academicYear || '2025-26'} · Full Year · ${overallRunning?.length || 0} data points</p>
    </div>
    <div class="flex items-center gap-3">
      <button onclick="refreshData()" class="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors" title="Refresh">${icon('sparkle','w-3.5 h-3.5')} ${timeSince(state.lastUpdated)}</button>
      <button onclick="openSettings()" class="flex items-center gap-2 bg-[#12121b] border border-[#22222e] rounded-xl px-4 py-2.5 text-sm text-gray-300 hover:text-white transition-colors" title="Settings">
        ${icon('settings','w-4 h-4')}
        <span class="hidden sm:inline">${goal}% Goal</span>
      </button>
    </div>
  </div>

  ${watchlist.length > 0 ? renderWatchlistBar() : ''}

  <!-- Stats Row -->
  <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
    <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5">
      <div class="text-xs text-gray-500 mb-1">Overall Grade</div>
      <div class="text-3xl font-bold" style="color:${gradeColor(overallGrade)}">${overallGrade != null ? overallGrade + '%' : 'N/A'}</div>
      <div class="flex items-center gap-2 mt-2">
        <span class="text-sm font-medium text-gray-300">${overallLetter || ''}</span>
        <span class="text-xs text-gray-500">vs goal ${goal}%</span>
        ${overallGrade != null && overallGrade >= goal ? '<span class="text-xs text-green-400">✓</span>' : '<span class="text-xs text-red-400">⚠</span>'}
      </div>
      <div class="flex items-center gap-1.5 mt-2.5 flex-wrap">
        ${(d.quarterTrend || []).map(q => `
          <span class="text-[10px] px-1.5 py-0.5 rounded-md ${q.grade != null && q.grade >= goal ? 'bg-green-500/10 text-green-400' : 'bg-orange-500/10 text-orange-400'}">Q${q.term} ${q.grade != null ? q.grade + '%' : '—'}</span>
        `).join('')}
      </div>
    </div>
    <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5">
      <div class="text-xs text-gray-500 mb-1">GPA</div>
      <div class="text-3xl font-bold text-white">${overallGPA?.toFixed(2) || '0.00'}</div>
      <div class="text-xs text-gray-500 mt-2">${activeClasses.length} classes · ${activeClasses.filter(c => c.isAcademic).length} academic</div>
    </div>
    <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5">
      <div class="text-xs text-gray-500 mb-1">Completion</div>
      <div class="text-3xl font-bold text-white">${completionRate}%</div>
      <div class="text-xs text-gray-500 mt-2">${totalGraded}/${validCount} assignments graded</div>
      ${missingCount > 0 ? `<div class="text-xs text-red-400 mt-0.5">${missingCount} missing</div>` : ''}
    </div>
    <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5">
      <div class="text-xs text-gray-500 mb-1">Watchlist</div>
      <div class="text-3xl font-bold ${watchlist.length > 0 ? 'text-orange-400' : 'text-green-400'}">${watchlist.length}</div>
      <div class="text-xs ${watchlist.length > 0 ? 'text-orange-400' : 'text-gray-500'} mt-2">${watchlist.length > 0 ? 'Items below goal' : 'All above goal ✓'}</div>
    </div>
  </div>

  <!-- Charts Row -->
  <div class="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
    <!-- Running Average Chart -->
    <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5 lg:col-span-2">
      <div class="flex items-center justify-between mb-3">
        <h3 class="text-sm font-medium text-gray-300">Overall Grade Trend</h3>
        <span class="text-xs text-gray-500">${overallRunning?.length || 0} data points · hover to inspect</span>
      </div>
      ${overallRunning && overallRunning.length > 1
        ? runningAvgChart(overallRunning, 220, 550, '#3b82f6', true, goal, quarterBoundariesFrom(d.meta), { classIds: activeClasses.filter(c => c.isAcademic).map(c => c.id), periodKey: 'year', title: 'All Classes' })
        : '<div class="flex items-center justify-center h-48 text-gray-500 text-sm">Collecting grade data...</div>'}
    </div>

    <!-- Grade Distribution (Highcharts Pie) -->
    <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5">
      <h3 class="text-sm font-medium text-gray-300 mb-3">Grade Distribution</h3>
      <div id="grade-dist-chart" class="h-[260px]"></div>
    </div>
  </div>

  <!-- Class Summary Row -->
  <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5 mb-4">
    <div class="flex items-center justify-between mb-4">
      <div class="flex items-center gap-2">
        <h3 class="text-sm font-medium text-gray-300">Class Snapshot</h3>
        <span class="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 font-medium">${qLabel} Averages</span>
      </div>
      <button onclick="navigate('grades')" class="text-xs text-blue-400 hover:text-blue-300">View All →</button>
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      ${activeClasses.length > 0 ? activeClasses.filter(c => c.isAcademic)
        .sort((a, b) => {
          const ga = periodGrade(a, qPeriod), gb = periodGrade(b, qPeriod);
          const na = ga == null, nb = gb == null;
          if (na && nb) return 0;
          if (na) return 1;
          if (nb) return -1;
          return ga - gb;
        })
        .map(c => {
        const qg = periodGrade(c, qPeriod);
        const ql = letterGrade(qg);
        const isBelow = qg != null && qg < goal;
        return `
        <div onclick="showCourseDetail('${c.id}')" class="rounded-xl p-3 hover:border-blue-500/30 transition-all cursor-pointer border ${isBelow ? themeChoice('bg-orange-500/15 border-orange-500/50', 'bg-orange-50 border-orange-200') : themeChoice('bg-[#0a0a0f] border-[#22222e]', 'bg-white border-[#d9dde7]')}">
          <div class="flex items-center justify-between mb-1">
            <span class="text-sm font-medium ${isBelow ? themeChoice('text-orange-100', 'text-orange-700') : themeChoice('text-gray-200', 'text-gray-800')} truncate">${c.shortName || c.name}</span>
            <span style="color:${gradeColor(qg)}" class="text-sm font-bold">${qg != null ? qg + '%' : 'N/A'}</span>
          </div>
          <div class="flex items-center gap-2 text-xs ${isBelow ? themeChoice('text-orange-200/70', 'text-orange-700') : themeChoice('text-gray-500', 'text-gray-600')}">
            <span>${ql || ''}</span>
            ${trendArrow(c.trend)}
            ${isBelow ? `<span class="${themeChoice('text-orange-300', 'text-orange-700')} font-semibold">${Math.round(goal - qg)}pts below goal</span>` : ''}
          </div>
          <div class="flex items-center gap-1.5 mt-2 pt-2 border-t ${isBelow ? themeChoice('border-orange-500/30', 'border-orange-200') : themeChoice('border-[#22222e]', 'border-[#d9dde7]')}">
            <button onclick="event.stopPropagation();gotoClassAssignments('${c.id}')" class="flex items-center gap-1 px-2 py-1 rounded-lg ${themeChoice('bg-[#12121b] border-[#22222e] text-gray-400 hover:text-blue-300 hover:border-blue-500/30', 'bg-white border-[#d9dde7] text-gray-600 hover:text-blue-700 hover:border-blue-400/40')} border text-[10px] font-medium transition-colors" title="Jump to this class's assignments">${icon('clipboard','w-3 h-3')} Assignments</button>
            <button onclick="event.stopPropagation();gotoClassTrends('${c.id}')" class="flex items-center gap-1 px-2 py-1 rounded-lg ${themeChoice('bg-[#12121b] border-[#22222e] text-gray-400 hover:text-blue-300 hover:border-blue-500/30', 'bg-white border-[#d9dde7] text-gray-600 hover:text-blue-700 hover:border-blue-400/40')} border text-[10px] font-medium transition-colors" title="Jump to this class's report">${icon('trend','w-3 h-3')} Reports</button>
            ${triliumNotesFor(c.id) ? triliumCardHtml(c.id, c.shortName || c.name, true) : ''}
          </div>
        </div>`;
      }).join('') : '<div class="col-span-full text-center text-gray-500 text-sm py-6 flex items-center justify-center gap-2"><span class="animate-spin inline-block w-4 h-4 border-2 border-gray-600 border-t-blue-400 rounded-full"></span> Loading classes…</div>'}
    </div>
  </div>

  <!-- Recent Activity -->
  <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5">
    <h3 class="text-sm font-medium text-gray-300 mb-4">Recent Assignments</h3>
    ${allAssignments.length === 0
      ? '<div class="text-center text-gray-500 py-4 text-sm flex items-center justify-center gap-2"><span class="animate-spin inline-block w-4 h-4 border-2 border-gray-600 border-t-blue-400 rounded-full"></span> Loading recent assignments…</div>'
      : allAssignments.filter(a => a.pts != null).sort((a, b) => (b.dueDate || '').localeCompare(a.dueDate || '')).slice(0, 5).map(a => `
      <div class="flex items-center gap-3 py-2 border-b border-[#22222e] last:border-0">
        <div class="w-2 h-2 rounded-full flex-shrink-0" style="background:${COLORS[activeClasses.findIndex(c => c.id === a.classId) % COLORS.length]}"></div>
        <div class="flex-1 min-w-0">
          <div class="text-sm text-gray-200 truncate">${a.name}</div>
          <div class="text-xs text-gray-500">${a.className} · ${a.category}</div>
        </div>
        <div class="text-right flex-shrink-0">
          <div class="text-sm font-medium" style="color:${gradeColor(a.pct)}">${a.pct != null ? a.pct + '%' : a.pts + '/' + a.max}</div>
          <div class="text-xs text-gray-500">${a.dueDate ? formatDate(a.dueDate) : ''}</div>
        </div>
      </div>
    `).join('')}
    ${allAssignments.length > 0 && allAssignments.filter(a => a.pts != null).length === 0 ? '<div class="text-center text-gray-500 py-4 text-sm">No graded assignments yet</div>' : ''}
  </div>`;
}

function showCourseDetail(classId) {
  const d = state.computed;
  if (!d) return;
  const c = d.activeClasses?.find(x => x.id === classId);
  if (!c) return showToast('Class not found', 'error');

  const goal = d.goal;
  const belowGoal = c.weightedGrade != null && c.weightedGrade < goal;
  const period = defaultPeriod();
  const periodLabel = PERIOD_LABELS[period] || 'Current Quarter';
  const avg = periodLine(c, period);
  const periodGradeValue = periodGrade(c, period);
  const periodCategories = (c.periodCategoryGrades?.[period] || []).filter(cg => cg.average != null);
  const periodAssignments = periodCategories.flatMap(cg => (cg.assignments || []).filter(a => a.status !== 'Excuse' && a.status !== 'Exempt'));
  const hasQuarterData = avg.length > 0 || periodCategories.length > 0;

  const content = `
  <div class="space-y-6">
    <div class="flex items-center gap-4">
      <div class="w-14 h-14 rounded-2xl flex items-center justify-center text-2xl font-bold" style="background:${COLORS[d.activeClasses.indexOf(c) % COLORS.length]}20; color:${COLORS[d.activeClasses.indexOf(c) % COLORS.length]}">${(c.shortName || c.name).charAt(0)}</div>
      <div class="flex-1">
        <h2 class="text-xl font-bold ${themeChoice('text-white', 'text-gray-900')}">${c.shortName || c.name}</h2>
        <p class="text-sm ${themeChoice('text-gray-400', 'text-gray-600')}">${c.name} · ${periodLabel}</p>
        <div class="flex items-center gap-2 mt-2">
          <button onclick="gotoClassAssignments('${c.id}')" class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg ${themeChoice('bg-[#0a0a0f] border-[#22222e] text-gray-300 hover:text-blue-300 hover:border-blue-500/30', 'bg-white border-[#d9dde7] text-gray-600 hover:text-blue-700 hover:border-blue-400/40')} border text-xs font-medium transition-colors">${icon('clipboard','w-3.5 h-3.5')} Assignments</button>
          <button onclick="gotoClassTrends('${c.id}')" class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg ${themeChoice('bg-[#0a0a0f] border-[#22222e] text-gray-300 hover:text-blue-300 hover:border-blue-500/30', 'bg-white border-[#d9dde7] text-gray-600 hover:text-blue-700 hover:border-blue-400/40')} border text-xs font-medium transition-colors">${icon('trend','w-3.5 h-3.5')} Reports</button>
        </div>
      </div>
      <div class="text-center">
        <div class="text-3xl font-bold" style="color:${gradeColor(periodGradeValue != null ? periodGradeValue : c.weightedGrade)}">${periodGradeValue != null ? periodGradeValue + '%' : c.weightedGrade != null ? c.weightedGrade + '%' : 'N/A'}</div>
        <div class="text-sm ${themeChoice('text-gray-400', 'text-gray-600')}">${periodLabel}</div>
        ${periodGradeValue != null && periodGradeValue < goal ? `<div class="text-xs text-orange-400 font-medium mt-1">${Math.round(goal - periodGradeValue)}pts below ${goal}%</div>` : belowGoal ? `<div class="text-xs text-orange-400 font-medium mt-1">${Math.round(goal - c.weightedGrade)}pts below ${goal}%</div>` : ''}
      </div>
    </div>

    <!-- Running Average Mini Chart -->
    ${avg && avg.length > 1 ? `
    <div class="bg-[#0a0a0f] border border-[#22222e] rounded-xl p-4">
      <div class="text-xs text-gray-500 mb-2">${periodLabel} Trend</div>
      ${runningAvgChart(avg, 160, 500, COLORS[d.activeClasses.indexOf(c) % COLORS.length], true, goal, period === 'year' ? quarterBoundariesFrom(d.meta) : null, { classIds: [c.id], periodKey: period, title: c.shortName || c.name })}
    </div>` : ''}

    ${triliumNotesFor(c.id) ? `<div>
      <h4 class="text-sm font-medium ${themeChoice('text-gray-300', 'text-gray-700')} mb-2">Class Notes (Trilium)</h4>
      ${triliumNoteCard(c.id, c.shortName || c.name)}
    </div>` : ''}

    <!-- Category Breakdown -->
    <div>
      <h4 class="text-sm font-medium ${themeChoice('text-gray-300', 'text-gray-700')} mb-3">${periodLabel} Category Breakdown</h4>
      <div class="space-y-3">
        ${hasQuarterData ? periodCategories.map(cg => {
          const catBelow = cg.average != null && cg.average < goal;
          const assignments = (cg.assignments || []).filter(a => a.status !== 'Excuse' && a.status !== 'Exempt');
          return `
          <div class="${themeChoice('bg-[#0a0a0f] border-[#22222e]', 'bg-white border-[#d9dde7]')} border rounded-xl p-4">
            <div class="flex items-center justify-between mb-2">
              <div class="flex items-center gap-2">
                <span class="text-sm font-medium ${themeChoice('text-gray-200', 'text-gray-800')}">${cg.name}</span>
                <span class="text-xs ${themeChoice('text-gray-500', 'text-gray-600')}">${cg.weight}% weight</span>
              </div>
              <div class="flex items-center gap-2">
                <span class="text-lg font-bold" style="color:${gradeColor(cg.average)}">${cg.average != null ? cg.average + '%' : '-'}</span>
                ${catBelow ? `<span class="text-xs text-orange-400">below ${goal}%</span>` : `<span class="text-xs text-green-400">✓ goal</span>`}
              </div>
            </div>
            <div class="h-2 bg-[#1c1c26] rounded-full overflow-hidden mb-3">
              <div class="h-full rounded-full transition-all" style="width:${Math.min(cg.average || 0, 100)}%; background:${goalColor(cg.average, goal)}"></div>
            </div>
            <div class="space-y-1 max-h-48 overflow-y-auto">
              ${assignments.length > 0 ? assignments.map(a => `
                <div class="flex items-center justify-between text-xs py-1.5 px-2 rounded-lg ${themeChoice('hover:bg-[#0a0a0f]/60 border-b border-[#22222e]/50', 'hover:bg-slate-50 border-b border-[#d9dde7]/70')} last:border-0 transition-colors">
                  <span class="${themeChoice('text-gray-400', 'text-gray-700')} truncate flex-1">${a.name}</span>
                  <div class="flex items-center gap-2 flex-shrink-0">
                    <span class="${themeChoice('text-gray-500', 'text-gray-600')}">${a.pts != null ? a.pts + '/' + a.max : '-'}</span>
                    <span style="color:${gradeColor(a.pct)}" class="font-medium w-10 text-right">${a.pct != null ? a.pct + '%' : '-'}</span>
                    <span class="${a.status === 'Valid' ? 'text-green-400' : a.status === 'Excuse' || a.status === 'Exempt' ? themeChoice('text-gray-600', 'text-gray-500') : 'text-yellow-400'} capitalize">${a.status === 'Valid' ? '✓' : a.status === 'Excuse' ? 'exc' : a.status || ''}</span>
                  </div>
                </div>
              `).join('') : '<div class="text-xs text-gray-600 py-1">No assignments in this category</div>'}
            </div>
          </div>`;
        }).join('') : '<div class="text-sm text-gray-500">No current-quarter category data available yet.</div>'}
      </div>
    </div>
  </div>`;

  showModal(c.shortName || c.name, content, true);
}

// ─── ASSIGNMENTS SUBMENU ───────────────────────────────────────
function toggleAssignmentsSubmenu() {
  const sub = document.getElementById('assignments-submenu');
  const ch = document.querySelector('.nav-chevron');
  if (!sub) return;
  const isOpen = sub.classList.toggle('open');
  ch?.classList.toggle('open', isOpen);
}
window.toggleAssignmentsSubmenu = toggleAssignmentsSubmenu;

function toggleGradesSubmenu() {
  const sub = document.getElementById('grades-submenu');
  const chevron = document.querySelector('.grades-chevron');
  if (!sub) return;
  const isOpen = sub.classList.toggle('open');
  chevron?.classList.toggle('open', isOpen);
}
window.toggleGradesSubmenu = toggleGradesSubmenu;

// ─── COLLAPSED-SIDEBAR FLYOUT ───────────────────────────────────
let sidebarFlyoutVisible = false;

function sidebarFlyoutPeriod() {
  const p = state.assignmentsPeriod;
  return p && PERIOD_ORDER.includes(p) ? p : defaultPeriod();
}

function openSidebarFlyout(kind, anchorEl) {
  const flyout = document.getElementById('sidebar-flyout');
  if (!flyout || !state.computed) return;
  let inner = '';
  if (kind === 'assignments') {
    const classes = state.computed.activeClasses?.filter(c => c.isAcademic) || [];
    const period = sidebarFlyoutPeriod();
    const sorted = [...classes].sort((a, b) => {
      const ga = a.periodGrade?.[period];
      const gb = b.periodGrade?.[period];
      if (ga == null && gb == null) return 0;
      if (ga == null) return 1;
      if (gb == null) return -1;
      return ga - gb;
    });
    inner = sorted.map(c => {
      const ci = classes.indexOf(c);
      const color = COLORS[ci % COLORS.length];
      const active = state.assignmentsClassId === c.id;
      const pg = c.periodGrade?.[period];
      const above = pg != null && pg >= goalFor(c);
      const pill = pg != null
        ? `<span class="fly-pill ${above ? 'bg-green-500/15 text-green-400' : 'bg-orange-500/15 text-orange-400'}">${Math.round(pg)}%</span>`
        : `<span class="fly-pill bg-[#1c1c26] text-gray-500">—</span>`;
      return `<a class="${active ? 'active' : ''}" onclick="selectAssignmentClass('${c.id}')">
        <span class="fly-letter" style="background:${color}20; color:${color}">${escapeHtml((c.shortName || c.name).trim().charAt(0).toUpperCase())}</span>
        <span class="truncate">${c.shortName || c.name}</span>
        ${pill}
      </a>`;
    }).join('');
    inner = `<div class="fly-head">Classes</div>${inner}`;
  } else {
    const items = [
      { v: 'grades', label: 'Reports', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"/></svg>' },
      { v: 'insights', label: 'Insights', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg>' },
      { v: 'goals', label: 'Goals', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/></svg>' }
    ];
    inner = `<div class="fly-head">Grades</div>` + items.map(x => `
      <a class="${state.currentView === x.v ? 'active' : ''}" onclick="navigate('${x.v}'); closeSidebarFlyout()">
        ${x.icon}
        <span>${x.label}</span>
      </a>`).join('');
  }
  flyout.innerHTML = inner;
  flyout.classList.add('open');
  sidebarFlyoutVisible = true;
  const r = anchorEl?.getBoundingClientRect?.();
  if (r) {
    flyout.style.left = Math.round(r.right + 10) + 'px';
    let top = Math.round(r.top - 6);
    const fh = flyout.offsetHeight || 40;
    if (top + fh > window.innerHeight - 12) top = Math.max(12, window.innerHeight - 12 - fh);
    flyout.style.top = top + 'px';
  }
}

function closeSidebarFlyout() {
  const flyout = document.getElementById('sidebar-flyout');
  if (!flyout) return;
  flyout.classList.remove('open');
  sidebarFlyoutVisible = false;
}
window.closeSidebarFlyout = closeSidebarFlyout;

document.addEventListener('click', (e) => {
  if (!sidebarFlyoutVisible) return;
  if (e.target.closest('#sidebar-flyout')) return;
  if (e.target.closest('.nav-group a')) return;
  closeSidebarFlyout();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSidebarFlyout();
});

function populateAssignmentsSubmenu() {
  const sub = document.getElementById('assignments-submenu');
  if (!sub || !state.computed) return;
  const classes = state.computed.activeClasses?.filter(c => c.isAcademic) || [];
  const period = state.assignmentsPeriod && PERIOD_ORDER.includes(state.assignmentsPeriod) ? state.assignmentsPeriod : defaultPeriod();
  const sorted = [...classes].sort((a, b) => {
    const ga = a.periodGrade?.[period];
    const gb = b.periodGrade?.[period];
    if (ga == null && gb == null) return 0;
    if (ga == null) return 1;
    if (gb == null) return -1;
    return ga - gb;
  });
  sub.innerHTML = sorted.map(c => {
    const ci = classes.indexOf(c);
    const active = state.assignmentsClassId === c.id;
    const pg = c.periodGrade?.[period];
    const above = pg != null && pg >= goalFor(c);
    const pill = pg != null
      ? `<span class="ml-auto text-[10px] px-1.5 py-0.5 rounded-md font-semibold flex-shrink-0 ${above ? 'bg-green-500/15 text-green-400' : 'bg-orange-500/15 text-orange-400'}">${Math.round(pg)}%</span>`
      : `<span class="ml-auto text-[10px] px-1.5 py-0.5 rounded-md bg-[#1c1c26] text-gray-500 flex-shrink-0">—</span>`;
    return `<a class="${active ? 'active' : ''}" onclick="selectAssignmentClass('${c.id}')" data-assign-class="${c.id}">
      <span class="sub-dot" style="background:${COLORS[ci % COLORS.length]}"></span>
      ${c.shortName || c.name}
      ${pill}
    </a>`;
  }).join('');
}

function selectAssignmentClass(classId) {
  state.assignmentsClassId = classId;
  state.currentView = 'assignments';
  window.location.hash = 'assignments';
  populateAssignmentsSubmenu();
  render();
  // Close sidebar on mobile
  document.querySelector('.sidebar')?.classList.remove('open');
  document.getElementById('sidebar-overlay')?.classList.remove('open');
  closeSidebarFlyout();
}
window.selectAssignmentClass = selectAssignmentClass;

function gotoClassAssignments(classId) {
  state.assignmentsClassId = classId;
  closeModal();
  navigate('assignments');
}
window.gotoClassAssignments = gotoClassAssignments;

function gotoClassTrends(classId) {
  state.trendActive = [classId];
  state.gradePeriod = state.gradePeriod || defaultPeriod();
  closeModal();
  navigate('grades');
}
window.gotoClassTrends = gotoClassTrends;

// ─── VIEW: ASSIGNMENTS ──────────────────────────────────────────
function setAssignmentsPeriod(p) {
  state.assignmentsPeriod = p;
  render();
}
window.setAssignmentsPeriod = setAssignmentsPeriod;

function renderAssignments() {
  const d = state.computed;
  if (!d) return skeleton();
  const classes = d.activeClasses?.filter(c => c.isAcademic) || [];
  const cls = classes.find(c => c.id === state.assignmentsClassId);
  if (!cls) return '<div class="flex flex-col items-center justify-center h-64 text-gray-500"><div class="text-lg mb-2">Select a class</div><div class="text-sm">Choose a class from the Assignments menu in the sidebar</div></div>';
  const goal = d.goal;
  const ci = classes.indexOf(cls);
  const color = COLORS[ci >= 0 ? ci % COLORS.length : 0];

  // Assignments only need quarter-level switching — semesters/year are noise here.
  const available = QUARTER_PERIODS.filter(p => (cls.periodRunning?.[p]?.length || 0) > 0);
  let period = state.assignmentsPeriod;
  if (!period || !available.includes(period)) period = available.includes(defaultPeriod()) ? defaultPeriod() : (available[0] || 'q4');
  state.assignmentsPeriod = period;

  const cgs = (cls.periodCategoryGrades?.[period] || []).filter(cg => cg.assignments?.length > 0);
  const periodCount = cgs.reduce((s, cg) => s + cg.assignments.length, 0);
  const periodAvg = cls.periodGrade?.[period];
  const clsGoal = goalFor(cls);
  const belowAvg = periodAvg != null && periodAvg < clsGoal;
  const missingAvg = periodAvg == null;

  return `
  <div class="flex items-center justify-between mb-4">
    <div class="flex items-center gap-3">
      <div class="w-10 h-10 rounded-2xl flex items-center justify-center text-lg font-bold" style="background:${color}20; color:${color}">${(cls.shortName || cls.name).charAt(0)}</div>
      <div>
        <h1 class="text-2xl font-bold text-white">${cls.shortName || cls.name}</h1>
        <p class="text-gray-400 mt-1 text-sm">${cls.categories?.length || 0} categories · ${periodCount} assignments in ${PERIOD_FULL[period]}</p>
        ${triliumNotesFor(cls.id) ? `<a href="${triliumWebUrl(triliumNotesFor(cls.id).noteId)}" target="_blank" rel="noopener" class="inline-flex items-center gap-1.5 text-xs ${themeChoice('text-blue-400 hover:text-blue-300','text-blue-700 hover:text-blue-800')} mt-1 transition-colors">${icon('book','w-3.5 h-3.5')} ${escapeHtml(triliumNotesFor(cls.id).noteTitle || 'Class notes')} <span class="text-gray-500">↗</span></a>` : ''}
      </div>
    </div>
    <div class="text-right">
      <div class="text-xs text-gray-500">${PERIOD_LABELS[period]} Average</div>
      <div class="text-2xl font-bold leading-tight" style="color:${belowAvg ? '#f97316' : gradeColor(periodAvg)}">${periodAvg != null ? periodAvg + '%' : 'N/A'}</div>
      <div class="text-xs text-gray-500">${periodAvg != null ? letterGrade(periodAvg) : ''}</div>
    </div>
  </div>

  ${belowAvg ? `
  <div class="flex items-center gap-2.5 px-4 py-3 rounded-xl bg-orange-500/10 border border-orange-500/30 text-orange-300 text-sm mb-4 fade-in">
    ${icon('alert','w-4 h-4')}
    <span><strong>${cls.shortName || cls.name}</strong> is <strong>${Math.round(clsGoal - periodAvg)}pts below</strong> your ${clsGoal}% goal this ${PERIOD_FULL[period].toLowerCase()} — currently ${periodAvg}%.</span>
  </div>` : missingAvg ? `
  <div class="flex items-center gap-2.5 px-4 py-3 rounded-xl bg-yellow-500/10 border border-yellow-500/30 text-yellow-300 text-sm mb-4 fade-in">
    ${icon('alert','w-4 h-4')}
    <span><strong>${cls.shortName || cls.name}</strong> has no graded averages yet for ${PERIOD_FULL[period].toLowerCase()}.</span>
  </div>` : ''}

  <div class="flex flex-wrap items-center gap-1 bg-[#0a0a0f] border border-[#22222e] rounded-xl p-1 mb-5">
    ${available.map(p => `
      <button onclick="setAssignmentsPeriod('${p}')" class="px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${p === period ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30' : 'text-gray-400 hover:text-gray-200 border border-transparent'}">${PERIOD_LABELS[p]}</button>
    `).join('')}
  </div>

  ${triliumNotesFor(cls.id) ? triliumCardHtml(cls.id, cls.shortName || cls.name, 'latest') : ''}

  <div class="space-y-4">
    ${cgs.map(cg => {
      const catBelow = cg.average != null && cg.average < goal;
      const catColor = goalColor(cg.average, goal);
      const sorted = [...cg.assignments].filter(a => a.status !== 'Excuse' && a.status !== 'Exempt').sort((a, b) => (b.dueDate || '').localeCompare(a.dueDate || ''));
      return `
      <div class="bg-[#12121b] border border-[#22222e] rounded-2xl overflow-hidden">
        <div class="flex items-center justify-between px-5 py-3 border-b border-[#22222e]">
          <div class="flex items-center gap-3">
            <div class="flex items-center gap-2">
              <h3 class="text-sm font-semibold text-gray-200">${cg.name}</h3>
              <span class="text-xs text-gray-500">${cg.weight}% of grade</span>
            </div>
          </div>
          <div class="flex items-center gap-3">
            <div class="flex items-center gap-1.5">
              <div class="h-1.5 w-16 bg-[#1c1c26] rounded-full overflow-hidden">
                <div class="h-full rounded-full" style="width:${Math.min(cg.average || 0, 100)}%; background:${catColor}"></div>
              </div>
              <span class="text-sm font-bold" style="color:${gradeColor(cg.average)}">${cg.average != null ? cg.average + '%' : '-'}</span>
            </div>
            ${catBelow ? `<span class="text-xs text-orange-400">below ${goal}%</span>` : `<span class="text-xs text-green-400">at goal</span>`}
          </div>
        </div>
        <div class="divide-y divide-[#22222e]/50">
          ${sorted.map(a => {
            const isBelow = a.pct != null && a.pct < goal;
            const isMissing = a.pts == null;
            return `
            <div class="flex items-center gap-4 px-5 py-3 hover:bg-[#0a0a0f]/50 transition-colors ${isBelow ? 'bg-orange-500/[0.03]' : isMissing ? 'bg-red-500/[0.03]' : ''}">
              <div class="flex-1 min-w-0">
                <div class="text-sm text-gray-200 font-medium truncate">${a.name}</div>
                <div class="text-xs text-gray-500 mt-0.5">${a.dueDate ? formatDate(a.dueDate) : 'No date'}</div>
              </div>
              <div class="flex items-center gap-4 text-sm flex-shrink-0">
                <div class="text-right">
                  <div class="text-gray-400">${a.pts != null ? a.pts : '-'} <span class="text-gray-600">/ ${a.max != null ? a.max : '-'}</span></div>
                </div>
                <div class="w-14 text-right">
                  ${a.pct != null ? `<span class="font-semibold" style="color:${gradeColor(a.pct)}">${a.pct}%</span>` : '<span class="text-gray-600">—</span>'}
                </div>
                <div class="w-16 text-right">
                  ${isMissing ? '<span class="text-red-400 text-xs font-medium">missing</span>' :
                    a.status !== 'Valid' && a.status ? `<span class="text-gray-600 text-xs">${a.status || ''}</span>` : ''}
                </div>
              </div>
              ${isBelow ? `<div class="text-xs text-orange-400 font-medium flex-shrink-0">-${Math.round(goal - a.pct)}</div>` : ''}
            </div>`;
          }).join('')}
          ${sorted.length === 0 ? '<div class="px-5 py-4 text-sm text-gray-600 text-center">No active assignments in this period</div>' : ''}
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

function setGradePeriod(p) {
  state.gradePeriod = p;
  render();
}
window.setGradePeriod = setGradePeriod;

function periodTrend(cls, period) {
  const line = periodLine(cls, period);
  const first = line[0]?.grade, last = line[line.length - 1]?.grade;
  if (first == null || last == null) return 'stable';
  const diff = last - first;
  if (diff > 0.5) return 'improving';
  if (diff < -0.5) return 'declining';
  return 'stable';
}

// ─── VIEW: GRADES ───────────────────────────────────────────────
function renderGrades() {
  const d = state.computed;
  if (!d) return skeleton();
  const classes = d.activeClasses?.filter(c => c.isAcademic) || [];
  const goal = d.goal;
  let period = state.gradePeriod;
  if (!period || !PERIOD_ORDER.includes(period)) period = defaultPeriod();
  state.gradePeriod = period;
  const stats = periodStats(d, period);
  const label = PERIOD_FULL[period];
  const activeTrendClasses = classes.filter(c => (state.trendActive || []).includes(c.id));
  const allTrendClasses = classes.map(c => ({ ...c, runningAverage: periodLine(c, period) }));
  const reportTrendClasses = activeTrendClasses.map(c => ({ ...c, runningAverage: periodLine(c, period) }));
  const classList = [...classes].sort((a, b) => {
    const ga = periodGrade(a, period);
    const gb = periodGrade(b, period);
    if (ga == null && gb == null) return (a.name || '').localeCompare(b.name || '');
    if (ga == null) return 1;
    if (gb == null) return -1;
    return ga - gb;
  });

  return `
  <div class="flex items-center justify-between mb-4">
    <div>
      <h1 class="text-2xl font-bold text-white">Reports</h1>
      <p class="text-gray-400 mt-1 text-sm">${label}: <span class="text-gray-200 font-medium">${stats.grade != null ? stats.grade + '%' : 'N/A'}</span> · GPA: ${d.overallGPA?.toFixed(2)}</p>
    </div>
  </div>

  <div class="flex flex-wrap items-center gap-1 bg-[#0a0a0f] border border-[#22222e] rounded-xl p-1 mb-5">
    ${PERIOD_ORDER.map(p => `
      <button onclick="setGradePeriod('${p}')" class="px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${p === period ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30' : 'text-gray-400 hover:text-gray-200 border border-transparent'}">${PERIOD_LABELS[p]}</button>
    `).join('')}
  </div>

  <div class="flex flex-wrap items-center gap-3 mb-4">
      <label class="inline-flex items-center gap-2 text-xs text-gray-300 cursor-pointer"><input type="checkbox" ${state.trendShowOverall ? 'checked' : ''} onchange="state.trendShowOverall=this.checked; render()" class="rounded bg-[#1c1c26] border-[#22222e] text-blue-500"> Overall average</label>
      ${activeTrendClasses.map(c => { const color = COLORS[classes.indexOf(c) % COLORS.length]; return `<span class="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-[#0a0a0f] border border-[#22222e] text-xs text-gray-300"><span class="w-2 h-2 rounded-full" style="background:${color}"></span>${c.shortName || c.name}</span>`; }).join('')}
  </div>

  ${(stats.line.length > 1 || activeTrendClasses.length > 0) ? `
  <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5 mb-6">
    <div class="flex items-center justify-between mb-3">
      <h3 class="text-sm font-medium text-gray-300">${label} — Overall Average Trend</h3>
      <span class="text-xs text-gray-500">${stats.points} data points · click a point to inspect</span>
    </div>
    ${renderMultiClassChart(reportTrendClasses, goal, 260, 800, stats.line, state.trendShowOverall, period, allTrendClasses)}
  </div>` : ''}

  <!-- Per-class mini running averages (worst in selected period first) -->
  <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
    ${classList.map(c => {
      const line = periodLine(c, period);
      const g = periodGrade(c, period);
      const tr = periodTrend(c, period);
      const pcgs = (c.periodCategoryGrades?.[period] || []).filter(cg => cg.average != null);
      const cGoal = goalFor(c);
      const below = g != null && g < cGoal;
      const missing = g == null || line.length === 0;
      const warn = below || missing;
      const trendSelected = (state.trendActive || []).includes(c.id);
      return `
      <div class="bg-[#12121b] ${warn ? 'border-orange-500/40 bg-orange-500/[0.03]' : 'border-[#22222e]'} border rounded-2xl p-4">
        <div class="flex items-center justify-between mb-2">
          <label class="flex items-center gap-2 min-w-0 cursor-pointer"><input type="checkbox" ${trendSelected ? 'checked' : ''} onchange="toggleTrendClass('${c.id}')" class="rounded bg-[#1c1c26] border-[#22222e] text-blue-500"><span class="w-2 h-2 rounded-full flex-shrink-0" style="background:${COLORS[classes.indexOf(c) % COLORS.length]}"></span><span class="text-sm font-medium text-gray-200 truncate">${c.shortName || c.name}</span></label>
          <div class="flex items-center gap-2 flex-shrink-0">
            ${below ? `<span class="text-[10px] px-1.5 py-0.5 rounded-md bg-orange-500/15 text-orange-400 font-medium">below goal</span>` : missing ? `<span class="text-[10px] px-1.5 py-0.5 rounded-md bg-yellow-500/15 text-yellow-400 font-medium">no data</span>` : ''}
            <span class="text-sm font-bold" style="color:${gradeColor(g)}">${g != null ? g + '%' : 'N/A'}</span>
          </div>
        </div>
        <div class="h-28">
          ${line.length > 1
            ? runningAvgChart(line, 110, 400, COLORS[classes.indexOf(c) % COLORS.length], true, cGoal, period === 'year' ? quarterBoundariesFrom(d.meta) : null, { classIds: [c.id], periodKey: period, title: c.shortName || c.name })
            : '<div class="flex items-center justify-center h-full text-gray-500 text-xs">Not enough data</div>'}
        </div>
        <div class="mt-3 pt-3 border-t border-[#22222e]">
          <div class="text-[10px] uppercase tracking-wider text-gray-500 mb-2">Category Breakdown</div>
          ${pcgs.length > 0 ? pcgs.map(cg => `
            <div class="flex items-center gap-2 mb-1.5 last:mb-0">
              <span class="text-xs text-gray-500 w-16 flex-shrink-0 truncate" title="${cg.name}">${cg.name}</span>
              <div class="flex-1 h-1.5 bg-[#1c1c26] rounded-full overflow-hidden">
                <div class="h-full rounded-full" style="width:${Math.min(cg.average || 0, 100)}%; background:${goalColor(cg.average, cGoal)}; opacity:0.8"></div>
              </div>
              <span class="text-xs ${cg.average < cGoal ? 'text-orange-400' : 'text-gray-400'} w-9 text-right">${cg.average != null ? cg.average + '%' : '-'}</span>
            </div>
          `).join('') : '<div class="text-xs text-gray-600">No category data this period</div>'}
        </div>
        <div class="flex items-center gap-4 mt-2 text-xs text-gray-500">
          <span>${pcgs.length || c.categories?.length || 0} categories</span>
          <span>${line.length || 0} grade points</span>
          ${warn ? `<span class="font-medium ${below ? 'text-orange-400' : 'text-yellow-400'}">${below ? '⚠ Below goal' : '⚠ Missing this period'}</span>` : ''}
          ${tr === 'improving' ? '<span class="text-green-400">↗ Improving</span>' : tr === 'declining' ? '<span class="text-red-400">↘ Declining</span>' : ''}
        </div>
      </div>
    `}).join('')}
  </div>`;
}

// ─── VIEW: TRENDS (THE HEART) ───────────────────────────────────
function toggleTrendClass(id) {
  if (!state.trendActive || state.trendActive.length === 0) {
    state.trendActive = [id];
  } else if (state.trendActive.includes(id)) {
    state.trendActive = state.trendActive.filter(x => x !== id);
  } else {
    state.trendActive = [...state.trendActive, id];
  }
  render();
}
window.toggleTrendClass = toggleTrendClass;


function renderMultiClassChart(classes, goal, height = 280, width = 800, overallData = null, showOverallOverride = null, periodKey = 'year', overallClasses = null) {
  const allDates = new Set();
  for (const c of classes) {
    if (c.runningAverage) for (const p of c.runningAverage) allDates.add(p.date);
  }
  if (overallData) for (const p of overallData) allDates.add(p.date);
  const dates = [...allDates].sort();
  if (dates.length < 2) return '<div class="flex items-center justify-center h-full text-gray-500 text-sm">Not enough data</div>';

  const classSeries = classes.map((c, idx) => {
    const line = c.runningAverage || [];
    const valuesByDate = {};
    const eventDates = new Set();
    for (const p of line) { if (p.grade != null && p.date) eventDates.add(p.date); }
    for (const date of dates) {
      const g = gradeAt(line, date);
      if (g != null) valuesByDate[date] = g;
    }
    return { c, color: COLORS[idx % COLORS.length], valuesByDate, eventDates };
  });

  const overallValuesByDate = {};
  const avgSource = overallClasses && overallClasses.length > 0 ? overallClasses : classSeries;
  const avgLine = (s) => (s.c && s.c.runningAverage) || s.runningAverage;
  for (const date of dates) {
    if (overallData) {
      const grade = gradeAt(overallData, date);
      if (grade != null) overallValuesByDate[date] = grade;
    } else {
      let sum = 0, count = 0;
      for (const s of avgSource) {
        const g = gradeAt(avgLine(s), date);
        if (g != null) { sum += g; count++; }
      }
      if (count > 0) overallValuesByDate[date] = Math.round((sum / count) * 10) / 10;
    }
  }

  const allValues = [];
  for (const s of classSeries) for (const d of dates) { const v = s.valuesByDate[d]; if (v != null) allValues.push(v); }
  for (const s of avgSource) for (const d of dates) { const g = gradeAt(avgLine(s), d); if (g != null) allValues.push(g); }
  const overallValues = dates.map(d => overallValuesByDate[d]).filter(v => v != null);
  const min = Math.floor(Math.min(...allValues, ...overallValues, goal - 5) / 5) * 5;
  const max = Math.ceil(Math.max(...allValues, ...overallValues, 100) / 5) * 5;
  const range = max - min || 10;

  const pad = { top: 10, bottom: 25, left: 40, right: 10 };
  const cw = width - pad.left - pad.right;
  const ch = height - pad.top - pad.bottom;
  const xScale = (i) => pad.left + (i / (dates.length - 1)) * cw;
  const yScale = (v) => pad.top + ((max - v) / range) * ch;

  const yLabels = [];
  const step = Math.ceil(range / 4 / 5) * 5;
  for (let v = min; v <= max; v += step) yLabels.push(v);
  if (yLabels[yLabels.length - 1] < max) yLabels.push(max);
  const goalY = yScale(goal);

  const showOverall = showOverallOverride == null ? classSeries.length > 1 : showOverallOverride;
  const overallLabel = overallData || (overallClasses && overallClasses.length > 0) ? 'Overall average' : 'Avg of selected';
  const spacing = cw / Math.max(1, dates.length - 1);
  const cid = 'chart-' + (++_chartSeq);

  const series = [];
  if (showOverall) series.push({ label: overallLabel, color: reportAverageColor(), valuesByDate: overallValuesByDate, overall: true });
  for (const s of classSeries) series.push({ label: s.c.shortName || s.c.name, color: s.color, valuesByDate: s.valuesByDate, classId: s.c.id });

  const pts = dates.map((d, i) => ({ x: xScale(i), date: d }));
  const seriesPts = series.map(s => ({
    s,
    coords: dates.map((d, i) => { const v = s.valuesByDate[d]; return v != null ? { x: xScale(i), y: yScale(v), date: d, i } : null; }).filter(Boolean)
  }));
  __chartRegistry[cid] = {
    points: pts, pad, width, height, color: reportAverageColor(),
    series,
    seriesPts,
    classIds: classes.map(c => c.id), periodKey,
    title: 'Assignments', fmt: fmtDateShort, lastIdx: dates.length - 1,
    multiClass: true
  };

  const overallLine = showOverall ? dates.map((d, i) => { const v = overallValuesByDate[d]; return v != null ? `${xScale(i).toFixed(1)},${yScale(v).toFixed(1)}` : null; }).filter(Boolean).join(' ') : '';

  return `
  <div class="chart-interactive relative" id="${cid}" style="width:100%">
    <div class="flex items-center gap-3 flex-wrap mb-2 text-xs">
      ${showOverall ? `<span class="inline-flex items-center gap-1.5 ${themeChoice('text-gray-300', 'text-gray-700')}" ><span class="w-2 h-2 rounded-full" style="background:${reportAverageColor()}"></span>${overallLabel}</span>` : ''}
      ${classSeries.map(s => `<span class="inline-flex items-center gap-1.5 text-gray-300"><span class="w-2 h-2 rounded-full" style="background:${s.color}"></span>${s.c.shortName || s.c.name}</span>`).join('')}
    </div>
    <svg viewBox="0 0 ${width} ${height}" style="width:100%; height:auto; display:block; max-width:${width}px;">
      ${yLabels.map(v => `<line x1="${pad.left}" y1="${yScale(v)}" x2="${width - pad.right}" y2="${yScale(v)}" stroke="#1c1c26" stroke-width="1"/>`).join('')}
      ${yLabels.map(v => `<text x="${pad.left - 6}" y="${yScale(v) + 4}" text-anchor="end" fill="#6c6c7c" font-size="10">${v}%</text>`).join('')}
      <line x1="${pad.left}" y1="${goalY}" x2="${width - pad.right}" y2="${goalY}" stroke="#eab308" stroke-width="1.5" stroke-dasharray="5,4" opacity="0.7"/>
      <text x="${width - pad.right - 2}" y="${goalY - 4}" text-anchor="end" fill="#eab308" font-size="9">Goal ${goal}%</text>

      ${showOverall ? `<polyline points="${overallLine}" fill="none" stroke="${reportAverageColor()}" stroke-width="3.25" stroke-linecap="round" stroke-linejoin="round" opacity="0.92"/>` : ''}

      ${classSeries.map(s => {
        const pts2 = dates.map((d, i) => { const v = s.valuesByDate[d]; return v != null ? `${xScale(i).toFixed(1)},${yScale(v).toFixed(1)}` : null; }).filter(Boolean).join(' ');
        return `<polyline points="${pts2}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>`;
      }).join('')}

      ${classSeries.map(s => dates.map((d, i) => { const v = s.valuesByDate[d]; const hasEvent = s.eventDates.has(d); return v != null && hasEvent ? `<circle class="chart-dp" data-pt="${i}" cx="${xScale(i)}" cy="${yScale(v)}" r="3" fill="#0a0a0f" stroke="${s.color}" stroke-width="1.5" style="opacity:0"/>` : ''; }).join('')).join('')}

      ${dates.map((d, i) => {
        const step = Math.max(1, Math.floor(dates.length / 6));
        if (i % step !== 0 && i !== dates.length - 1) return '';
        return `<text x="${xScale(i)}" y="${height - 6}" text-anchor="middle" fill="#6c6c7c" font-size="9">${fmtDateShort(d)}</text>`;
      }).join('')}

      ${dates.map((_, i) => `<rect x="${(xScale(i) - spacing / 2).toFixed(1)}" y="${pad.top}" width="${spacing.toFixed(1)}" height="${ch}" fill="transparent" data-pt="${i}" onmouseover="chartHover('${cid}',${i})" onmousemove="chartMove(event,'${cid}',${i})" onmouseout="chartOut('${cid}')" onclick="chartClick('${cid}',${i},event)"/>`).join('')}
    </svg>
    <div class="chart-tip hidden"></div>
  </div>`;
}

// ─── VIEW: CALENDAR ─────────────────────────────────────────────
function renderCalendar() {
  const d = state.computed;
  if (!d) return skeleton();
  const all = d.allAssignments || [];
  const classes = d.activeClasses?.filter(c => c.isAcademic) || [];

  const year = state.calendarYear, month = state.calendarMonth;
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date(); today.setHours(0,0,0,0);

  // Group assignments by date
  const monthAssignments = all.filter(a => {
    if (!a.dueDate) return false;
    const d2 = new Date(a.dueDate + 'T12:00:00');
    return d2.getMonth() === month && d2.getFullYear() === year;
  });
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  if (!state.calendarSelectedDate || !state.calendarSelectedDate.startsWith(`${year}-${String(month + 1).padStart(2, '0')}`)) {
    state.calendarSelectedDate = today.getFullYear() === year && today.getMonth() === month ? todayStr : `${year}-${String(month + 1).padStart(2, '0')}-01`;
  }
  const selectedAssignments = monthAssignments.filter(a => a.dueDate === state.calendarSelectedDate);
  const selectedLabel = formatDate(state.calendarSelectedDate);

  return `
  <div class="flex items-center justify-between mb-6">
    <div>
      <h1 class="text-2xl font-bold text-white">Calendar</h1>
      <p class="text-gray-400 mt-1 text-sm">${monthAssignments.length} assignments this month</p>
    </div>
    <div class="flex items-center gap-2">
      <button onclick="state.calendarMonth--; if(state.calendarMonth<0){state.calendarMonth=11;state.calendarYear--;} render()" class="w-8 h-8 rounded-lg bg-[#12121b] border border-[#22222e] flex items-center justify-center text-gray-400 hover:text-white transition-colors">${icon('chevronLeft','w-4 h-4')}</button>
      <span class="text-sm font-medium text-gray-200 w-32 text-center">${['January','February','March','April','May','June','July','August','September','October','November','December'][month]} ${year}</span>
      <button onclick="state.calendarMonth++; if(state.calendarMonth>11){state.calendarMonth=0;state.calendarYear++;} render()" class="w-8 h-8 rounded-lg bg-[#12121b] border border-[#22222e] flex items-center justify-center text-gray-400 hover:text-white transition-colors">${icon('chevronRight','w-4 h-4')}</button>
      <button onclick="state.calendarMonth=today.getMonth(); state.calendarYear=today.getFullYear(); render()" class="text-xs text-blue-400 hover:text-blue-300 px-3 py-1.5 rounded-lg border border-blue-500/20 bg-blue-500/5">Today</button>
    </div>
  </div>

  <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
    <div class="lg:col-span-2 bg-[#12121b] border border-[#22222e] rounded-2xl p-4">
      <div class="grid grid-cols-7 gap-1">
        ${DAYS.map(d => `<div class="text-center text-xs font-medium text-gray-500 py-2">${d}</div>`).join('')}
        ${Array(firstDay).fill(0).map(() => '<div></div>').join('')}
        ${Array(daysInMonth).fill(0).map((_, i) => {
          const day = i + 1;
          const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
          const dayAsns = monthAssignments.filter(a => a.dueDate === dateStr);
          const isToday = today.getFullYear() === year && today.getMonth() === month && today.getDate() === day;
          const hasBelow = dayAsns.some(a => a.pct != null && a.pct < d.goal);
          const isSelected = state.calendarSelectedDate === dateStr;
          return `<div class="aspect-square p-1 rounded-xl border ${isSelected ? 'border-blue-400 bg-blue-500/15 ring-1 ring-blue-500/30' : isToday ? 'border-blue-500/50 bg-blue-500/5' : 'border-[#22222e]'} hover:border-blue-500/30 transition-colors cursor-pointer relative" onclick="selectCalendarDay('${dateStr}')">
            <div class="text-xs font-medium ${isToday ? 'text-blue-400' : 'text-gray-400'}">${day}</div>
            ${dayAsns.slice(0, 3).map(a => {
              const ci = classes.findIndex(c => c.id === a.classId);
              return `<div class="w-full h-1 rounded-full mt-0.5" style="background:${COLORS[ci >= 0 ? ci % COLORS.length : 0]}; opacity:0.7"></div>`;
            }).join('')}
            ${dayAsns.length > 3 ? `<div class="text-xs text-gray-600 mt-0.5">+${dayAsns.length - 3}</div>` : ''}
            ${hasBelow ? `<div class="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-orange-400"></div>` : ''}
          </div>`;
        }).join('')}
      </div>
    </div>

    <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5">
      <h3 class="text-sm font-medium text-gray-300 mb-1">${selectedLabel}</h3>
      <p class="text-xs text-gray-500 mb-3">${selectedAssignments.length} assignment${selectedAssignments.length === 1 ? '' : 's'} due</p>
      <div class="space-y-2 max-h-96 overflow-y-auto">
        ${selectedAssignments.sort((a,b)=>(a.name||'').localeCompare(b.name||'')).map(a => {
          const ci = classes.findIndex(c => c.id === a.classId);
          const isBelow = a.pct != null && a.pct < d.goal;
          return `<div class="flex items-start gap-2 p-2 bg-[#0a0a0f] border border-[#22222e] rounded-lg ${isBelow ? 'border-orange-500/20' : ''}">
            <div class="w-2 h-2 rounded-full mt-1 flex-shrink-0" style="background:${COLORS[ci >= 0 ? ci % COLORS.length : 0]}"></div>
            <div class="flex-1 min-w-0">
              <div class="text-xs text-gray-200 truncate">${a.name}</div>
              <div class="text-xs text-gray-500">${a.className} · ${a.category}</div>
            </div>
            ${a.pct != null ? `<div class="text-xs font-medium flex-shrink-0" style="color:${gradeColor(a.pct)}">${a.pct}%</div>` : ''}
          </div>`;
        }).join('')}
        ${selectedAssignments.length === 0 ? '<div class="text-center text-gray-500 py-6 text-sm">No assignments due on this day</div>' : ''}
      </div>
    </div>
  </div>`;
}

function selectCalendarDay(dateStr) { state.calendarSelectedDate = dateStr; render(); }
window.selectCalendarDay = selectCalendarDay;

// ─── VIEW: PLANNER ──────────────────────────────────────────────
function renderPlanner() {
  const d = state.computed;
  if (!d) return skeleton();
  const classes = d.activeClasses?.filter(c => c.isAcademic) || [];
  const period = defaultPeriod();
  const belowGoal = classes.filter(c => {
    const pg = periodGrade(c, period);
    return pg != null && pg < goalFor(c);
  }).length;

  return `
  <div class="flex flex-wrap items-center justify-between gap-4 mb-6">
    <div>
      <h1 class="text-2xl font-bold text-white">Review</h1>
      <p class="text-gray-400 mt-1 text-sm">${belowGoal > 0 ? `${belowGoal} class${belowGoal > 1 ? 'es' : ''} below the ${d.goal}% goal this quarter` : `All classes are at or above the ${d.goal}% goal this quarter`}</p>
    </div>
    <div class="flex items-center gap-2.5 flex-shrink-0">
      <div class="relative">
        <span class="absolute left-3 top-1/2 -translate-y-1/2 ${themeChoice('text-gray-500', 'text-gray-400')} pointer-events-none">${icon('search', 'w-4 h-4')}</span>
        <input id="review-search" type="text" placeholder="Search sets and classes…" value="${escapeHtml(state.reviewQuery || '')}"
          oninput="state.reviewQuery=this.value; filterReviewGrid()"
          class="w-52 sm:w-64 pl-9 pr-3 py-2.5 rounded-xl bg-[#0a0a0f] border border-[#22222e] text-sm text-white placeholder-gray-600 focus:border-purple-500/50 transition-colors">
      </div>
      <div class="group relative">
        <button id="review-plus-btn" type="button" onclick="openCreateSetModal()"
          class="flex items-center h-9 overflow-hidden rounded-xl border border-purple-500/30 bg-purple-500/20 text-purple-300 hover:bg-purple-500/30 transition-all duration-200 px-2.5 group-hover:pr-3">
          <span class="w-4 h-4 flex-shrink-0 flex items-center justify-center">${icon('plus', 'w-4 h-4')}</span>
          <span class="text-sm font-medium whitespace-nowrap overflow-hidden max-w-0 opacity-0 group-hover:max-w-[4.5rem] group-hover:opacity-100 transition-all duration-200">New set</span>
        </button>
      </div>
    </div>
  </div>

  <div id="review-sets" class="grid grid-cols-1 lg:grid-cols-2 gap-5 content-start"></div>
  `;
}

// ─── VIEW: GOALS ────────────────────────────────────────────────
// ─── GOALS: CATEGORY HEALTH ──────────────────────────────────────
const CATEGORY_SYNONYMS = {
  'assignment': 'homework',
  'homework': 'homework',
  'performance': 'participation',
  'participation': 'participation',
  'paper': 'project',
  'lab': 'project',
  'project': 'project',
};
const CATEGORY_LABELS = { 'homework': 'Homework', 'participation': 'Participation', 'project': 'Projects' };

function normalizeCategoryName(name) {
  if (!name) return '';
  let s = String(name).toLowerCase().trim().replace(/\s+/g, ' ');
  s = s.replace(/[^a-z0-9 ]/g, '');
  if (s.endsWith('ies') && s.length > 4) s = s.slice(0, -3) + 'y';
  else if (s.endsWith('zes') && s.length > 4) s = s.slice(0, -2);
  else if (s.length > 3 && !/ss$|us$|is$|os$/.test(s) && s.endsWith('s')) s = s.slice(0, -1);
  return CATEGORY_SYNONYMS[s] || s;
}

function goalCategoryAggregation(classes, period) {
  const map = {};
  for (const c of classes) {
    const cgs = (c.periodCategoryGrades && c.periodCategoryGrades[period]) || c.categoryGrades || [];
    const cGoal = goalFor(c);
    const ci = classes.indexOf(c);
    const color = COLORS[ci >= 0 ? ci % COLORS.length : 0];
    for (const g of cgs) {
      if (g.average == null) continue;
      const key = normalizeCategoryName(g.name);
      if (!map[key]) map[key] = { key, instances: [] };
      map[key].instances.push({ cls: c, className: c.shortName || c.name, rawName: g.name, average: g.average, weight: g.weight || 0, goal: cGoal, atGoal: g.average >= cGoal, color });
    }
  }
  return Object.values(map).map(agg => {
    const n = agg.instances.length;
    agg.count = n;
    agg.avg = Math.round((agg.instances.reduce((s, i) => s + i.average, 0) / n) * 10) / 10;
    agg.atGoalCount = agg.instances.filter(i => i.atGoal).length;
    const counts = {};
    for (const i of agg.instances) counts[i.rawName] = (counts[i.rawName] || 0) + 1;
    agg.displayName = CATEGORY_LABELS[agg.key] || Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    return agg;
  });
}

const __barRegistry = {};

function categoryBarChart(aggs, goal, height = 250, width = 760) {
  if (!aggs || aggs.length === 0) return '';
  const pad = { top: 18, bottom: 46, left: 34, right: 10 };
  const cw = width - pad.left - pad.right;
  const ch = height - pad.top - pad.bottom;
  const axisMin = 60;
  const yScale = v => pad.top + ((100 - v) / (100 - axisMin)) * ch;
  const n = aggs.length;
  const slot = cw / n;
  const barW = Math.min(slot * 0.52, 46);
  const cid = 'cbar-' + (++_chartSeq);
  const goalY = yScale(Math.min(Math.max(goal, axisMin), 100));

  const bars = aggs.map((agg, i) => {
    const cx = pad.left + slot * i + slot / 2;
    const avg = agg.avg;
    const color = avg == null ? '#2b2b38' : avg >= goal + 5 && avg < 100 ? '#eab308' : avg >= goal ? '#22c55e' : (goal - avg) <= 5 ? '#f97316' : '#ef4444';
    const y = avg != null ? yScale(Math.min(avg, 100)) : yScale(axisMin);
    const h = avg != null ? Math.max(yScale(axisMin) - y, 2) : 4;
    return `
      <rect x="${(cx - barW / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="4" fill="${color}" style="cursor:pointer" opacity="${avg == null ? 0.3 : 0.92}"
        onmouseover="categoryBarHover('${cid}',${i})" onmousemove="categoryBarMove(event,'${cid}')" onmouseout="categoryBarOut('${cid}')"/>
      ${avg != null ? `<text x="${cx.toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="middle" fill="${color}" font-size="10" font-weight="700">${avg}</text>` : ''}
      <text x="${cx.toFixed(1)}" y="${(height - 18).toFixed(1)}" text-anchor="middle" fill="#8b8b9a" font-size="9.5">${escapeHtml(agg.displayName.length > 12 ? agg.displayName.slice(0, 11) + '…' : agg.displayName)}</text>`;
  }).join('');

  const grid = [60, 70, 80, 90, 100].map(v => `
    <line x1="${pad.left}" y1="${yScale(v)}" x2="${width - pad.right}" y2="${yScale(v)}" stroke="#1c1c26" stroke-width="1"/>
    <text x="${pad.left - 5}" y="${yScale(v) + 3}" text-anchor="end" fill="#6c6c7c" font-size="9">${v}</text>`).join('');

  __barRegistry[cid] = { aggs };

  return `
  <div class="relative" id="${cid}" style="width:100%">
    <svg viewBox="0 0 ${width} ${height}" style="width:100%; height:auto; display:block; max-width:${width}px;">
      ${grid}
      <line x1="${pad.left}" y1="${goalY}" x2="${width - pad.right}" y2="${goalY}" stroke="#eab308" stroke-width="1.5" stroke-dasharray="5,4" opacity="0.75"/>
      <text x="${width - pad.right - 2}" y="${goalY - 5}" text-anchor="end" fill="#eab308" font-size="9">Goal ${goal}%</text>
      ${bars}
    </svg>
    <div class="chart-tip hidden"></div>
  </div>`;
}

function categoryBarHover(cid, i) {
  const d = __barRegistry[cid];
  if (!d) return;
  const wrap = document.getElementById(cid);
  if (!wrap) return;
  const agg = d.aggs[i];
  if (!agg) return;
  const tip = wrap.querySelector('.chart-tip');
  if (!tip) return;
  const rows = agg.instances.slice().sort((a, b) => b.average - a.average).map(x => `
    <div class="flex items-center justify-between gap-4 py-0.5">
      <span class="inline-flex items-center gap-1.5 text-gray-300 min-w-0"><span class="w-2 h-2 rounded-full flex-shrink-0" style="background:${x.color}"></span><span class="truncate">${escapeHtml(x.className)}</span></span>
      <span class="font-semibold flex-shrink-0" style="color:${gradeColor(x.average)}">${x.average}%</span>
    </div>`).join('');
  const status = agg.avg >= goal + 5 && agg.avg < 100 ? '<span class="text-yellow-400">excellent — well above goal</span>' : agg.avg >= goal ? '<span class="text-green-400">at goal</span>' : `<span class="text-orange-400">${Math.round((goal - agg.avg) * 10) / 10}pts below</span>`;
  tip.innerHTML = `
    <div class="text-[10px] uppercase tracking-wider text-gray-500 mb-1">${escapeHtml(agg.displayName)} · ${agg.count} class${agg.count > 1 ? 'es' : ''} · avg ${agg.avg}% — ${status}</div>
    ${rows}`;
  tip.style.whiteSpace = 'normal';
  tip.style.width = '220px';
  tip.classList.remove('hidden');
}

function categoryBarMove(ev, cid) {
  const wrap = document.getElementById(cid);
  const tip = wrap?.querySelector('.chart-tip');
  if (!wrap || !tip) return;
  const r = wrap.getBoundingClientRect();
  const x = Math.max(4, Math.min(ev.clientX - r.left, r.width - tip.offsetWidth - 4));
  const y = ev.clientY - r.top - tip.offsetHeight - 10;
  tip.style.left = x + 'px';
  tip.style.top = Math.max(4, y) + 'px';
}

function categoryBarOut(cid) {
  const wrap = document.getElementById(cid);
  const tip = wrap?.querySelector('.chart-tip');
  if (tip) tip.classList.add('hidden');
}

function renderGoals() {
  const d = state.computed;
  if (!d) return skeleton();
  const goal = d.goal;
  const w = d.watchlist || [];
  const classes = d.activeClasses?.filter(c => c.isAcademic) || [];
  const period = defaultPeriod();
  const currentTerm = parseInt((period || 'q4').slice(1), 10) || 4;
  const classGrade = c => c.periodGrade?.[period] ?? null;

  // Achievement rate (current quarter)
  const total = classes.length;
  const achieved = classes.filter(c => {
    const g = classGrade(c);
    return g != null && g >= goalFor(c);
  }).length;
  const atRisk = total - achieved;

  // Hit/miss snapshots for the other quarters
  const quarterSnapshots = [1, 2, 3, 4].filter(t => t !== currentTerm).map(t => ({
    term: t,
    label: PERIOD_FULL['q' + t],
    rows: classes.map(c => {
      const q = (c.quarterGrades || []).find(qq => qq.term === t);
      return { name: c.shortName || c.name, grade: q ? q.grade : null };
    }).filter(r => r.grade != null),
  })).filter(q => q.rows.length > 0);

  // Watchlist grouped by offending class
  let watchlistHtml = '';
  if (w.length > 0) {
    const grouped = {};
    for (const a of w) { (grouped[a.classId] ||= []).push(a); }
    const groups = Object.entries(grouped).map(([classId, items]) => {
      const cls = classes.find(c => c.id === classId);
      const ci = classes.indexOf(cls);
      const color = COLORS[ci >= 0 ? ci % COLORS.length : 0];
      items.sort((a, b) => a.gap - b.gap);
      return { classId, cls, color, items };
    }).sort((x, y) => x.items[0].gap - y.items[0].gap);

    const groupLetter = g => escapeHtml((g.cls?.shortName || g.cls?.name || g.items[0].className || '?').trim().charAt(0).toUpperCase());

    const row = a => `
      <div class="flex items-center justify-between gap-3 px-3 py-2.5 hover:bg-[#0a0a0f] transition-colors cursor-pointer" onclick="navigateToAlert('${a.classId}', '${a.categoryName || ''}')">
        <div class="flex items-center gap-2.5 min-w-0">
          <span class="w-7 h-7 rounded-lg bg-orange-500/10 flex items-center justify-center flex-shrink-0">${icon('alert','w-3.5 h-3.5 text-orange-400')}</span>
          <div class="min-w-0">
            <div class="text-sm font-semibold text-orange-300 truncate">${a.categoryName || 'Overall Grade'}</div>
            <div class="text-[11px] text-gray-500">${a.currentGrade}% · below ${a.goal}% goal</div>
          </div>
        </div>
        <div class="text-right flex-shrink-0">
          <div class="text-sm font-bold text-orange-400">${a.gap > 0 ? '+' : ''}${a.gap}%</div>
          <div class="text-[10px] text-gray-600">below goal</div>
        </div>
      </div>`;

    const single = g => {
      const a = g.items[0];
      return `<div class="flex items-center justify-between gap-3 px-3 py-3 bg-[#0a0a0f] border border-[#22222e] rounded-xl hover:border-orange-500/30 transition-all cursor-pointer" onclick="navigateToAlert('${a.classId}', '${a.categoryName || ''}')">
        <div class="flex items-center gap-3 min-w-0">
          <span class="w-9 h-9 rounded-lg flex items-center justify-center text-sm font-bold flex-shrink-0" style="background:${g.color}20; color:${g.color}">${groupLetter(g)}</span>
          <div class="min-w-0">
            <div class="text-sm font-semibold text-gray-100 truncate">${a.className}</div>
            <div class="text-xs text-gray-400 truncate"><span class="text-orange-400 font-semibold">${a.categoryName || 'Overall Grade'}</span> · ${a.currentGrade}% vs ${a.goal}% goal</div>
          </div>
        </div>
        <div class="text-right flex-shrink-0">
          <div class="text-sm font-bold text-orange-400">${a.gap > 0 ? '+' : ''}${a.gap}%</div>
          <div class="text-[10px] text-gray-600">below goal</div>
        </div>
      </div>`;
    };

    const card = g => `<div class="bg-[#0a0a0f] border border-[#22222e] rounded-xl overflow-hidden">
      <div class="flex items-center justify-between px-3 py-2.5 border-b border-[#22222e]">
        <div class="flex items-center gap-2.5 min-w-0">
          <span class="w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold flex-shrink-0" style="background:${g.color}20; color:${g.color}">${groupLetter(g)}</span>
          <div class="min-w-0">
            <div class="text-sm font-semibold text-gray-100 truncate">${g.items[0].className}</div>
            <div class="text-[11px] text-gray-500">${g.items.length} areas below goal</div>
          </div>
        </div>
        <span class="text-[10px] px-2 py-1 rounded-md bg-orange-500/10 text-orange-400 font-semibold flex-shrink-0">${g.items[0].currentGrade}% worst</span>
      </div>
      <div class="divide-y divide-[#22222e]/60">
        ${g.items.map(row).join('')}
      </div>
    </div>`;

    watchlistHtml = `<div class="bg-[#12121b] border border-orange-500/20 rounded-2xl p-5">
      <div class="flex items-center gap-2 mb-4">
        ${icon('alert', 'w-5 h-5 text-orange-400')}
        <h3 class="text-sm font-medium text-gray-300">Watchlist — Items Below Goal</h3>
        <span class="text-xs text-orange-400">${w.length} items · ${groups.length} classes</span>
      </div>
      <div class="space-y-3">
        ${groups.map(g => g.items.length === 1 ? single(g) : card(g)).join('')}
      </div>
    </div>`;
  }

  // ── Category averages across all classes (normalized names) ──
  const catAggs = goalCategoryAggregation(classes, period).sort((a, b) => a.avg - b.avg);
  let catChartHtml = '';
  if (catAggs.length > 0) {
    const mergedCount = catAggs.filter(a => a.instances.length > 1 && new Set(a.instances.map(i => i.rawName)).size > 1).length;
    const atGoalCats = catAggs.filter(a => a.avg >= goal).length;
    catChartHtml = `
  <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5 mb-6">
    <div class="flex items-center gap-2 mb-1">
      ${icon('chart', 'w-5 h-5 text-blue-400')}
      <h3 class="text-sm font-medium text-gray-300">Category Averages</h3>
    </div>
    <p class="text-xs text-gray-500 mb-1">${PERIOD_FULL[period]} · average category grade across classes vs your ${goal}% goal · ${atGoalCats}/${catAggs.length} categories at goal · hover a bar for the per-class breakdown${mergedCount > 0 ? ' · similar categories grouped regardless of wording (e.g. "homeworks" = "homework")' : ''}</p>
    ${categoryBarChart(catAggs, goal)}
  </div>`;
  }

  return `
  <div class="flex items-center justify-between mb-6">
    <div>
      <h1 class="text-2xl font-bold text-white">Goals</h1>
      <p class="text-gray-400 mt-1 text-sm">${achieved}/${total} classes at goal this quarter</p>
    </div>
    <button onclick="openSettings()" class="flex items-center gap-2 bg-blue-500/20 border border-blue-500/30 rounded-xl px-4 py-2.5 text-sm text-blue-400 hover:bg-blue-500/30 transition-all">${icon('settings','w-4 h-4')}Adjust Goal</button>
  </div>

  <!-- Goal Ring -->
  <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
    <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5 flex flex-col items-center justify-center">
      <div class="relative w-28 h-28 mb-3">
        <svg width="112" height="112" viewBox="0 0 112 112">
          <circle cx="56" cy="56" r="48" fill="none" stroke="#1c1c26" stroke-width="8"/>
          <circle cx="56" cy="56" r="48" fill="none" stroke="${achieved === total ? '#22c55e' : atRisk > 0 ? '#f97316' : '#3b82f6'}" stroke-width="8"
            stroke-dasharray="${(achieved / total) * 301.6}" stroke-dashoffset="0" stroke-linecap="round" transform="rotate(-90 56 56)"/>
        </svg>
        <div class="absolute inset-0 flex flex-col items-center justify-center">
          <div class="text-2xl font-bold text-white">${Math.round((achieved / total) * 100)}%</div>
          <div class="text-xs text-gray-500">achieved</div>
        </div>
      </div>
      <div class="text-xs text-gray-500">${achieved}/${total} classes at ${goal}%</div>
    </div>

    <div class="md:col-span-3 bg-[#12121b] border border-[#22222e] rounded-2xl p-5">
      <div class="flex items-center justify-between mb-4">
        <span class="text-sm font-medium text-gray-300">Class Status vs Goal (${goal}%)</span>
        <span class="text-xs text-gray-500">${PERIOD_FULL[period]}</span>
      </div>
      <div class="space-y-2">
        ${classes.map(c => {
          const g = classGrade(c);
          const cg = goalFor(c);
          const atGoal = g != null && g >= cg;
          const gap = g != null ? Math.round((g - cg) * 10) / 10 : null;
          return `
          <div class="flex items-center gap-3 ${!atGoal ? 'bg-orange-500/5 rounded-lg px-2 py-1.5' : ''}">
            <div class="w-2.5 h-2.5 rounded-full flex-shrink-0" style="background:${goalColor(g, cg)}"></div>
            <div class="w-32 text-sm text-gray-300 truncate flex-shrink-0">${c.shortName || c.name}</div>
            <div class="flex-1 h-2 bg-[#1c1c26] rounded-full overflow-hidden">
              <div class="h-full rounded-full transition-all" style="width:${Math.min(g || 0, 100)}%; background:${goalColor(g, cg)}"></div>
            </div>
            <div class="w-12 text-right text-sm font-bold" style="color:${gradeColor(g)}">${g != null ? g + '%' : 'N/A'}</div>
            <div class="w-16 text-right text-xs ${gap != null && gap < 0 ? 'text-orange-400' : gap != null && g >= cg + 5 && g < 100 ? 'text-yellow-400' : 'text-green-400'}">${gap != null ? (gap >= 0 ? '+'+gap : gap) : '-'}</div>
          </div>`;
        }).join('')}
      </div>
    </div>
  </div>

  <!-- Category averages (across classes) -->
  ${catChartHtml}

  <!-- Watchlist items (grouped by class) -->
  ${watchlistHtml}

  <!-- Other quarters -->
  ${quarterSnapshots.length > 0 ? `
  <div class="mt-6">
    <h3 class="text-sm font-semibold text-gray-300 mb-3">Other quarters</h3>
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      ${quarterSnapshots.map(q => `
        <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5">
          <div class="text-sm font-medium text-gray-300 mb-3">${q.label}</div>
          <div class="space-y-1.5">
            ${q.rows.map(r => {
              const hit = r.grade != null && r.grade >= goal;
              return `
              <div class="flex items-center gap-2 text-xs">
                <span class="w-1.5 h-1.5 rounded-full flex-shrink-0" style="background:${goalColor(r.grade, goal)}"></span>
                <span class="text-gray-300 truncate flex-1">${escapeHtml(r.name)}</span>
                <span class="font-bold" style="color:${gradeColor(r.grade)}">${r.grade}%</span>
                <span class="w-14 text-right ${r.grade >= goal + 5 && r.grade < 100 ? 'text-yellow-400' : hit ? 'text-green-400' : 'text-orange-400'}">${hit ? 'hit' : 'miss'}</span>
              </div>`;
            }).join('')}
          </div>
        </div>`).join('')}
    </div>
  </div>` : ''}
  </div>`;
}

// ─── VIEW: INSIGHTS ─────────────────────────────────────────────
function computeStdDev(vals) {
  if (!vals || vals.length < 2) return 0;
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  return Math.sqrt(vals.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / vals.length);
}

function assignmentScores(cls) {
  const scored = [];
  for (const cat of (cls.categories || [])) {
    for (const a of (cat.assignments || [])) {
      if (a.status === 'Excuse' || a.status === 'Exempt') continue;
      if (a.pct != null && a.dueDate) scored.push({ date: a.dueDate, pct: a.pct });
    }
  }
  scored.sort((a, b) => a.date.localeCompare(b.date));
  return scored.map(s => s.pct);
}

function trendDirection(values) {
  if (!values || values.length < 3) return 'stable';
  const valid = values.filter(v => v != null && !isNaN(v));
  if (valid.length < 3) return 'stable';
  const win = Math.max(1, Math.floor(valid.length / 6));
  const smooth = [];
  for (let i = 0; i < valid.length; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - win); j <= Math.min(valid.length - 1, i + win); j++) { s += valid[j]; c++; }
    smooth.push(s / c);
  }
  const n = smooth.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) { sumX += i; sumY += smooth[i]; sumXY += i * smooth[i]; sumXX += i * i; }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return 'stable';
  const slope = (n * sumXY - sumX * sumY) / denom;
  const totalChange = slope * n;
  if (Math.abs(totalChange) < 1.5) return 'stable';
  if (totalChange > 1.5) return 'improving';
  if (totalChange < -1.5) return 'declining';
  return 'stable';
}

function generateClassInsights(cls, ctx) {
  const { goal } = ctx;
  const insights = [];
  const grade = cls.weightedGrade;
  const cgs = cls.categoryGrades || [];
  const scores = assignmentScores(cls);
  const quarter = cls.quarterGrades || [];

  if (grade != null) {
    if (grade >= goal) {
      insights.push({ icon: 'check', color: 'green', priority: 2, title: grade >= goal + 3 ? 'Comfortably above goal' : 'At your goal', body: `${grade}% vs your ${goal}% goal — ${grade >= goal + 3 ? 'a solid cushion of ' + Math.round(grade - goal) + 'pts.' : 'keep it steady.'}` });
    } else {
      insights.push({ icon: 'alert', color: 'orange', priority: 9, title: `Below your ${goal}% goal`, body: `${grade}% is ${Math.round(goal - grade)}pts short. The weakest category below is your fastest path back.` });
    }
  }

  if (scores.length >= 4) {
    const dir = trendDirection(scores);
    if (dir === 'improving') insights.push({ icon: 'trend', color: 'green', priority: 6, title: 'Scores trending up', body: `Recent assignment scores are climbing — momentum to build on.` });
    else if (dir === 'declining') insights.push({ icon: 'trend', color: 'red', priority: 8, title: 'Scores trending down', body: `Recent assignment scores are slipping. Review the last few graded items to spot the pattern.` });
  }

  const strongest = [...cgs].sort((a, b) => (b.average || 0) - (a.average || 0))[0];
  if (strongest && strongest.average != null && strongest.average >= goal) {
    insights.push({ icon: 'star', color: 'blue', priority: 3, title: `Strongest: ${strongest.name}`, body: `${strongest.average}% at ${strongest.weight}% weight — the anchor of this class grade.` });
  }

  const weakest = [...cgs].sort((a, b) => (a.average || 0) - (b.average || 0))[0];
  if (weakest && weakest.average != null && weakest.average < goal) {
    insights.push({ icon: 'target', color: 'orange', priority: 7, title: `Weakest: ${weakest.name}`, body: `${weakest.average}% — ${Math.round(goal - weakest.average)}pts under goal at ${weakest.weight}% weight.` });
  }

  const leverage = cgs
    .filter(cg => cg.average != null && cg.average < goal)
    .map(cg => ({ cg, gain: Math.round(((goal - cg.average) * (cg.weight / 100)) * 10) / 10 }))
    .sort((a, b) => b.gain - a.gain)[0];
  if (leverage) {
    insights.push({ icon: 'sparkle', color: 'purple', priority: 10, title: `Biggest bang for your buck: ${leverage.cg.name}`, body: `Bringing ${leverage.cg.name} from ${leverage.cg.average}% to ${goal}% would raise this class grade by roughly ${leverage.gain}pts.` });
  }

  if (scores.length >= 3) {
    const sd = computeStdDev(scores);
    const range = scores.length > 0 ? Math.round(Math.min(...scores)) + '–' + Math.round(Math.max(...scores)) : '';
    if (sd <= 3) insights.push({ icon: 'check', color: 'green', priority: 2, title: 'Remarkably consistent', body: `Scores barely vary (σ ${sd.toFixed(1)}, range ${range}%) — no surprises here.` });
    else if (sd >= 12) insights.push({ icon: 'bell', color: 'yellow', priority: 5, title: 'High score volatility', body: `Scores swing widely (σ ${sd.toFixed(1)}, range ${range}%) — inconsistent effort or tough spikes. Worth a look.` });
  }

  if (scores.length >= 3) {
    let streak = 0;
    for (let i = scores.length - 1; i >= 0; i--) { if (scores[i] >= goal) streak++; else break; }
    if (streak >= 3) insights.push({ icon: 'star', color: 'green', priority: 4, title: `${streak}-assignment winning streak`, body: `Last ${streak} graded assignments all at or above ${goal}%.` });
  }

  const missing = (cls.categories || []).flatMap(cat => (cat.assignments || []).filter(a => a.pts == null && a.status !== 'Excuse' && a.status !== 'Exempt'));
  if (missing.length > 0) {
    const catNames = [...new Set(missing.map(a => a.category))].join(', ');
    insights.push({ icon: 'clock', color: 'yellow', priority: 8, title: `${missing.length} ungraded / missing item${missing.length > 1 ? 's' : ''}`, body: `Open items in ${catNames}. Zeros-in-waiting could pull ${grade != null ? grade + '%' : 'this class'} down.` });
  }

  if (quarter.length >= 2) {
    const a = quarter[quarter.length - 2], b = quarter[quarter.length - 1];
    const diff = Math.round((b.grade - a.grade) * 10) / 10;
    insights.push({
      icon: 'trend', color: diff > 0 ? 'green' : diff < 0 ? 'red' : 'gray', priority: diff !== 0 ? 5 : 1,
      title: `Q${b.term} (${b.grade}%) vs Q${a.term} (${a.grade}%)`,
      body: diff > 0 ? `Up ${diff}pts quarter over quarter.` : diff < 0 ? `Down ${Math.abs(diff)}pts quarter over quarter.` : 'Holding steady across quarters.'
    });
  }

  const thin = cgs.filter(cg => cg.weight >= 20 && cg.assignments.filter(a => a.pts != null).length <= 2);
  if (thin.length > 0) {
    insights.push({ icon: 'bell', color: 'purple', priority: 6, title: `Thin data on a heavy category`, body: `${thin.map(t => t.name).join(', ')} (${thin[0].weight}%+) has only a couple of graded results — a single assignment can swing it.` });
  }

  if (cgs.length > 0 && cgs.every(cg => cg.average != null && cg.average >= goal)) {
    insights.push({ icon: 'check', color: 'green', priority: 1, title: 'Every category at goal', body: `All ${cgs.length} weighted categories are at or above ${goal}%.` });
  }

  insights.sort((a, b) => b.priority - a.priority);
  return insights;
}

function renderInsights() {
  const d = state.computed;
  if (!d) return skeleton();
  const classes = d.activeClasses?.filter(c => c.isAcademic) || [];
  const w = d.watchlist || [];
  const goal = d.goal;
  const all = d.allAssignments || [];
  const graded = all.filter(a => a.pct != null);
  const ai = state.aiInsights || {};
  const aiByClass = (ai.insights || []).reduce((out, item) => {
    (out[item.classId] ||= []).push(item); return out;
  }, {});
  const insClasses = classes.filter(c => (aiByClass[String(c.id)] || []).length > 0);

  return `
  <div class="flex items-center justify-between mb-6">
    <div>
      <h1 class="text-2xl font-bold text-white">Insights</h1>
      <p class="text-gray-400 mt-1 text-sm">${ai.status === 'current' ? `AI recommendations generated ${ai.generatedAt ? timeSince(ai.generatedAt) : 'today'}` : ''}</p>
    </div>
  </div>

  <div class="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px] gap-6 items-start">
    <div class="space-y-6 min-w-0">
      <div class="grid grid-cols-1 md:grid-cols-4 gap-3">
        <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-4">
          <div class="text-xs text-gray-500">Overall Average</div>
          <div class="text-xl font-bold mt-1" style="color:${gradeColor(d.overallGrade)}">${d.overallGrade != null ? d.overallGrade + '%' : 'N/A'}</div>
        </div>
        <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-4">
          <div class="text-xs text-gray-500">Classes at Goal</div>
          <div class="text-xl font-bold mt-1 text-green-400">${classes.filter(c => c.weightedGrade != null && c.weightedGrade >= goal).length}/${classes.length}</div>
        </div>
        <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-4">
          <div class="text-xs text-gray-500">Graded Assignments</div>
          <div class="text-xl font-bold mt-1 text-white">${graded.length}</div>
        </div>
        <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-4">
          <div class="text-xs text-gray-500">Watchlist</div>
          <div class="text-xl font-bold mt-1 ${w.length > 0 ? 'text-orange-400' : 'text-green-400'}">${w.length}</div>
        </div>
      </div>

      <div class="space-y-4">
        ${insClasses.length === 0 ? `
        <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-6 text-center">
          <div class="text-3xl mb-3">🤖</div>
          <div class="text-sm font-medium text-gray-300 mb-1">No class insights yet</div>
          <div class="text-xs text-gray-500">${ai.status === 'not_configured' ? 'Add an Ollama Cloud API key in Settings to generate recommendations.' : ai.status === 'error' ? 'AI recommendations could not be generated today. Existing grade data remains unchanged.' : 'Class recommendations will appear here once the AI has reviewed your current-quarter grades.'}</div>
        </div>` : ''}
        ${insClasses.map(c => {
          const ci = classes.indexOf(c);
          const color = COLORS[ci >= 0 ? ci % COLORS.length : 0];
          const ins = aiByClass[String(c.id)] || [];
          const grade = periodGrade(c, defaultPeriod());
          const letter = grade != null ? letterGrade(grade) : '';
          return `
          <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5">
            <div class="flex items-center justify-between mb-4">
              <div class="flex items-center gap-3">
                <span class="w-10 h-10 rounded-xl flex items-center justify-center text-lg font-bold flex-shrink-0" style="background:${color}20; color:${color}">${(c.shortName || c.name).charAt(0)}</span>
                <div>
                  <div class="flex items-center gap-2">
                    <h3 class="font-semibold text-gray-100">${c.shortName || c.name}</h3>
                    ${trendArrow(c.trend)}
                  </div>
                  <div class="text-xs text-gray-500">${c.categories?.length || 0} categories · ${ins.length} insights</div>
                </div>
              </div>
              <div class="text-right">
                <div class="text-xl font-bold" style="color:${gradeColor(grade)}">${grade != null ? grade + '%' : 'N/A'}</div>
                <div class="text-xs text-gray-500">${letter}${grade != null && grade < goalFor(c) ? ` · <span class="text-orange-400">${Math.round(goalFor(c) - grade)} below goal</span>` : ''}</div>
              </div>
            </div>
            <div class="space-y-2">
              ${ins.slice(0, 4).map(i => {
                const cm = { green:'bg-green-500/10 text-green-400',blue:'bg-blue-500/10 text-blue-400',orange:'bg-orange-500/10 text-orange-400',red:'bg-red-500/10 text-red-400',yellow:'bg-yellow-500/10 text-yellow-400',purple:'bg-purple-500/10 text-purple-400' };
                const cc = cm[i.color] || cm.blue;
                return `
                <div class="flex items-start gap-3 p-3 bg-[#0a0a0f] border border-[#22222e] rounded-xl">
                  <div class="w-8 h-8 rounded-lg ${cc} flex items-center justify-center flex-shrink-0">${icon(i.icon, 'w-4 h-4')}</div>
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                      <div class="text-sm font-medium text-gray-200">${i.title}</div>
                      ${i.manual ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-300">yours</span>' : ''}
                    </div>
                    <div class="text-xs text-gray-400 mt-0.5">${i.body}</div>
                    ${(i.nextGradeTarget || i.estimatedAssignments) ? `<div class="flex flex-wrap gap-2 mt-2 text-[10px]"><span class="px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-300">${i.nextGradeTarget || 'Target score unavailable'}</span>${i.estimatedAssignments ? `<span class="px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-300">${i.estimatedAssignments}</span>` : ''}</div>` : ''}
                  </div>
                  ${i.id ? `<button onclick="askRemoveInsight('${i.id}')" title="Remove insight" class="text-gray-600 hover:text-red-400 transition-colors flex-shrink-0">${icon('x','w-4 h-4')}</button>` : ''}
                </div>`;
              }).join('')}
              ${ins.length > 4 ? `<div class="text-xs text-gray-600 pl-11">+${ins.length - 4} more recommendations</div>` : ''}
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>

    ${renderAiCoachCard(ai)}
  </div>
  `;
}

function renderAiCoachCard(ai) {
  return `
    <aside class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5 xl:sticky xl:top-6 ai-card-resize">
      <div class="flex items-start justify-between gap-3 mb-1">
        <div>
          <h3 class="text-sm font-semibold text-gray-200">Ask your grade coach</h3>
          <p class="text-xs text-gray-500 mt-1">Open-ended questions stay in context while the coach uses live grade data.</p>
        </div>
        <span class="text-[10px] uppercase tracking-wider text-gray-600">Ollama Cloud</span>
      </div>
      <div id="ai-chat-log" class="space-y-3 my-4 max-h-[34rem] overflow-y-auto pr-1">
        ${renderAiChatLog()}
      </div>
      <div class="space-y-2">
        <input id="ai-question-input" type="text" value="${state.aiDraft}" placeholder="e.g. What score do I need on the next test to hit 90% in Chemistry?"
          oninput="state.aiDraft=this.value" onkeydown="if(event.key==='Enter') askAIQuestion()"
          class="w-full px-4 py-2.5 bg-[#0a0a0f] border border-[#22222e] rounded-xl text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500/40">
        <button onclick="askAIQuestion()" ${state.aiAskLoading ? 'disabled' : ''} class="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-blue-500/20 border border-blue-500/30 text-sm text-blue-400 hover:bg-blue-500/30 transition-all font-medium ${state.aiAskLoading ? 'opacity-60 cursor-not-allowed' : ''}">
          ${state.aiAskLoading ? '<span class="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin"></span>' : icon('sparkle','w-4 h-4')} ${state.aiAskLoading ? 'Thinking…' : 'Ask'}
        </button>
      </div>
    </aside>
  `;
}

// ─── AI CHAT ────────────────────────────────────────────────────
function renderAiChatLog() {
  const chat = state.aiChat || [];
  if (chat.length === 0) {
    return '<div class="text-xs text-gray-600 text-center py-3">Start a conversation — the coach can inspect each class before answering.</div>';
  }
  return chat.map(m => m.role === 'user'
    ? `<div class="flex justify-end"><div class="max-w-[85%] bg-blue-500/15 border border-blue-500/20 rounded-xl px-3 py-2 text-sm text-gray-100 whitespace-pre-wrap">${escapeHtml(m.content)}</div></div>`
    : `<div class="flex justify-start"><div class="max-w-[85%] bg-[#0a0a0f] border border-[#22222e] rounded-xl px-3 py-2 text-sm text-gray-200 ai-md">${m.loading ? '<span class="text-gray-500">Thinking…</span>' : renderMarkdown(m.content)}${m.created?.length ? `<div class="text-[10px] text-green-400 mt-1">✓ ${m.created.length} insight${m.created.length > 1 ? 's' : ''} saved</div>` : ''}</div></div>`
  ).join('');
}

function renderMarkdown(text) {
  const source = String(text || '');
  if (window.marked) {
    const html = window.marked.parse(source, { gfm: true, breaks: true });
    return window.DOMPurify ? window.DOMPurify.sanitize(html) : html;
  }
  return escapeHtml(source).replace(/\n/g, '<br>');
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function jsStr(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

window.askAIQuestion = async function() {
  const question = (state.aiDraft || '').trim();
  if (!question || state.aiAskLoading) return;
  const conversationSnapshot = Array.isArray(state.aiConversation) ? [...state.aiConversation] : [];
  const userMessage = { role: 'user', content: question };
  state.aiChat.push(userMessage);
  state.aiConversation = [...conversationSnapshot, userMessage];
  state.aiAskLoading = true;
  state.aiDraft = '';
  state.aiChat.push({ role: 'assistant', content: '', loading: true });
  render();
  try {
    const res = await fetch('/api/insights/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question, conversation: state.aiConversation }) });
    if (!res.ok) {
      let detail = 'Request failed';
      try { detail = (await res.json()).detail || detail; } catch (e) {}
      throw new Error(detail);
    }
    const data = await res.json();
    const last = state.aiChat[state.aiChat.length - 1];
    if (last && last.loading) {
      last.loading = false;
      last.content = data.answer || 'No answer received.';
      last.created = data.created || [];
    }
    if (Array.isArray(data.conversation)) {
      state.aiConversation = data.conversation;
    } else {
      state.aiConversation = [...state.aiConversation, { role: 'assistant', content: data.answer || 'No answer received.' }];
    }
    const insightsRes = await fetch('/api/insights');
    if (insightsRes.ok) state.aiInsights = await insightsRes.json();
  } catch (err) {
    state.aiConversation = conversationSnapshot;
    const last = state.aiChat[state.aiChat.length - 1];
    if (last && last.loading) { last.loading = false; last.content = '⚠️ ' + (err.message || 'Failed to ask'); }
    showToast(err.message || 'Failed to ask', 'error');
  } finally {
    state.aiAskLoading = false;
    render();
  }
};

window.askRemoveInsight = function(id) {
  showModal('Remove insight?', `
    <p class="text-sm text-gray-400 mb-6">This insight was saved by you. Remove it permanently?</p>
    <div class="flex justify-end gap-2">
      <button onclick="closeModal()" class="px-4 py-2 rounded-xl text-sm text-gray-400 hover:text-gray-200 bg-[#0a0a0f] border border-[#22222e]">Cancel</button>
      <button onclick="confirmRemoveInsight('${id}')" class="px-4 py-2 rounded-xl text-sm text-white bg-red-500/20 border border-red-500/30 hover:bg-red-500/30">Remove</button>
    </div>`);
};

window.confirmRemoveInsight = async function(id) {
  closeModal();
  try {
    const res = await fetch('/api/insights/' + encodeURIComponent(id), { method: 'DELETE' });
    if (!res.ok) throw new Error('Remove failed');
    const insightsRes = await fetch('/api/insights');
    if (insightsRes.ok) state.aiInsights = await insightsRes.json();
    showToast('Insight removed', 'success');
    render();
  } catch (err) {
    showToast(err.message || 'Failed to remove', 'error');
  }
};

// ─── SETTINGS ───────────────────────────────────────────────────
function openSettings() {
  state.settingsReturnView = state.currentView && state.currentView !== 'settings' ? state.currentView : 'overview';
  closeModal();
  document.querySelector('.sidebar')?.classList.remove('open');
  document.getElementById('sidebar-overlay')?.classList.remove('open');
  navigate('settings');
}
window.openSettings = openSettings;

function closeSettings() {
  navigate(state.settingsReturnView || 'overview');
}
window.closeSettings = closeSettings;

// ─── TRILIUM (class notes) ──────────────────────────────────────
function triliumNotesFor(classId) {
  return (state.trilium?.notes || {})[classId] || null;
}

function triliumWebUrl(noteId) {
  const base = (state.trilium?.url || '').replace(/\/+$/, '');
  return base ? `${base}/#root/${noteId}` : '';
}

function triliumLatestFrom(children) {
  if (!children || children.length === 0) return null;
  const dated = c => c.utcDateModified || c.dateModified || '';
  const numbered = [];
  const plain = [];
  for (const ch of children) {
    const m = /([0-9]+(?:\.[0-9]+)*)/.exec((ch.title || '').trim());
    const number = m ? m[1].split('.').reduce((acc, p, i) => acc + parseFloat(p) / Math.pow(10, i), 0) : null;
    (number != null ? numbered : plain).push({ ...ch, number });
  }
  if (numbered.length > 0) {
    return numbered.reduce((a, b) =>
      (b.number > a.number || (b.number === a.number && dated(b) > dated(a))) ? b : a);
  }
  return plain.reduce((a, b) => (dated(b) > dated(a) ? b : a));
}

async function triliumLoadChapters(classId, latestOnly = false) {
  const link = triliumNotesFor(classId);
  const container = document.getElementById(`trilium-chapters-${classId}`);
  if (!link || !container) return;
  const noteId = link.noteId;
  const cache = state.trilium.cache || {};
  const now = Date.now();
  if (cache[noteId] && now - cache[noteId].at < 60000) {
    container.innerHTML = triliumChaptersHtml(cache[noteId].children, link, latestOnly);
    return;
  }
  try {
    const res = await fetch(`/api/trilium/notes/${encodeURIComponent(noteId)}`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    state.trilium.cache[noteId] = { at: now, children: data.children || [] };
    container.innerHTML = triliumChaptersHtml(data.children || [], link, latestOnly);
  } catch (err) {
    container.innerHTML = `<div class="text-xs text-red-400">Couldn't load chapters — ${escapeHtml(err.message || 'error')}</div>`;
  }
}

function triliumChaptersHtml(children, link, latestOnly = false) {
  if (latestOnly) {
    if (!children || children.length === 0) {
      return '<div class="text-xs text-gray-600">No chapter notes found under this folder.</div>';
    }
    const latest = triliumLatestFrom(children);
    if (!latest) return '<div class="text-xs text-gray-600">No chapter notes found.</div>';
    const url = triliumWebUrl(latest.noteId);
    return `
      <a href="${url}" target="_blank" rel="noopener" onclick="event.stopPropagation()"
         class="flex items-center gap-1.5 text-xs font-medium ${themeChoice('text-blue-400 hover:text-blue-300', 'text-blue-700 hover:text-blue-800')} transition-colors min-w-0" title="Open latest chapter in Trilium">
        ${icon('chevronRight', 'w-3 h-3')}
        <span class="line-clamp-2 break-words min-w-0">${escapeHtml(latest.title)}</span>
        <span class="text-gray-500">↗</span>
      </a>`;
  }
  if (!children || children.length === 0) {
    return '<div class="text-xs text-gray-600">No chapter notes found under this folder.</div>';
  }
  const latest = triliumLatestFrom(children);
  return `
    <div class="flex items-center justify-between mb-2">
      <span class="text-[10px] uppercase tracking-wider text-gray-500">${children.length} chapter note${children.length === 1 ? '' : 's'}</span>
      ${latest ? `<span class="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 font-medium">Latest: ${escapeHtml(latest.title)}</span>` : ''}
    </div>
    <div class="space-y-1 max-h-56 overflow-y-auto">
      ${children.map(ch => {
        const isLatest = latest && ch.noteId === latest.noteId;
        const url = triliumWebUrl(ch.noteId);
        return `
        <a href="${url}" target="_blank" rel="noopener" onclick="event.stopPropagation()"
           class="flex items-center gap-2 px-3 py-1.5 rounded-lg ${themeChoice('bg-[#0a0a0f] hover:bg-[#0a0a0f]/70 border-[#22222e]', 'bg-white hover:bg-slate-50 border-[#d9dde7]')} border text-xs transition-colors group">
          <span class="text-gray-600 group-hover:text-blue-400">${icon('chevronRight','w-3 h-3')}</span>
          <span class="flex-1 truncate ${isLatest ? themeChoice('text-blue-300','text-blue-700') : themeChoice('text-gray-300','text-gray-700')}">${escapeHtml(ch.title)}</span>
          ${isLatest ? `<span class="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400 font-bold flex-shrink-0">LATEST</span>` : ''}
        </a>`;
      }).join('')}
    </div>`;
}

function triliumCardHtml(classId, clsName, variant = false) {
  const link = triliumNotesFor(classId);
  if (!link) return '';
  const open = triliumWebUrl(link.noteId);
  const compact = variant === true || variant === 'compact';
  const latestOnly = compact || variant === 'latest';
  return `
    <div class="${compact ? 'mt-2' : 'bg-[#0a0a0f] border border-[#22222e] rounded-xl p-4'}">
      ${compact ? '' : `
      <div class="flex items-center justify-between gap-2 mb-1.5">
        <a href="${open}" target="_blank" rel="noopener" onclick="event.stopPropagation()" class="flex items-center gap-1.5 min-w-0 text-xs font-medium ${themeChoice('text-blue-400 hover:text-blue-300', 'text-blue-700 hover:text-blue-800')} transition-colors" title="Open note folder in Trilium">
          ${icon('book','w-3.5 h-3.5')}
          <span class="truncate">${escapeHtml(link.noteTitle || 'Class notes')}</span>
          <span class="text-gray-500">↗</span>
        </a>
        <a href="${open}" target="_blank" rel="noopener" onclick="event.stopPropagation()" class="flex-shrink-0 px-2 py-0.5 rounded-md ${themeChoice('bg-[#12121b] border-[#22222e] text-gray-400 hover:text-blue-300 hover:border-blue-500/30', 'bg-white border-[#d9dde7] text-gray-600 hover:text-blue-700 hover:border-blue-400/40')} border text-[10px] font-medium transition-colors">Open</a>
      </div>`}
      <div id="trilium-chapters-${classId}" data-trilium-class="${classId}" ${latestOnly ? 'data-trilium-latest-only="1"' : ''} class="text-xs ${themeChoice('text-gray-500','text-gray-600')}">${compact ? '' : '<div class="py-1">Loading chapters…</div>'}</div>
    </div>`;
}

function triliumHydrate() {
  document.querySelectorAll('[data-trilium-class]').forEach(el => triliumLoadChapters(el.dataset.triliumClass, el.dataset.triliumLatestOnly === '1'));
}

// ─── BLOOKET QUIZ BUILDER ───────────────────────────────────────
let _blooketCtx = null;
let _blooketPollTimer = null;

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && _blooketCtx?.busy) blooketPollTick();
});

async function loadBlooketClasses(showSkeleton = true) {
  const container = document.getElementById('review-sets');
  if (!container) return;
  if (showSkeleton) {
    container.innerHTML = Array(4).fill(0).map(() => '<div class="h-52 bg-[#16161f] rounded-2xl animate-pulse"></div>').join('');
  }
  try {
    const res = await fetch('/api/blooket/classes?_=' + Date.now());
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const classes = (data.classes || []).map((c, i) => ({ ...c, _color: COLORS[i % COLORS.length] }));
    const customSets = data.customSets || [];
    state.blooketClasses = classes;
    state.blooketCustomSets = customSets;
    renderReviewGrid(classes, customSets);
    state.blooketLoaded = true;
    populateCustomBlooketTarget(classes, customSets);
    renderCustomBlooketSets(customSets);
    if (_blooketCtx?.lastStatus) {
      if (_blooketCtx.busy) renderBlooketStepsInline(_blooketCtx.lastStatus);
      else if (_blooketCtx.done) renderBlooketDoneInline(_blooketCtx.lastStatus);
    }
  } catch (err) {
    container.innerHTML = `<div class="col-span-full text-xs text-red-400">Couldn't load classes — ${escapeHtml(err.message || 'error')}</div>`;
  }
}

function filterReviewGrid() {
  renderReviewGrid(state.blooketClasses || [], state.blooketCustomSets || []);
}

function expandClassSets(classId) {
  state.expandedClasses[classId] = true;
  renderReviewGrid(state.blooketClasses || [], state.blooketCustomSets || []);
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
    for (const s of (row.sets || [])) push(s.setUrl, `${row.shortName || row.name} — ${s.chapterTitle || s.title || 'set'}`);
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

function renderSetCard(s, color, isLatest) {
  const url = s.setUrl || '';
  const title = s.chapterTitle || s.title || 'Blooket set';
  const stat = getQuizStats(url);
  const statHtml = stat && stat.total > 0
    ? `<div class="flex items-center gap-1.5" title="${stat.correct} of ${stat.total} correct across all sessions">${ringPct(stat.pct, 30, accRingColor(stat.pct))}</div>`
    : '<div class="text-[10px] text-gray-600">Not played yet</div>';
  // Level tag — only shown once a levels-based run has started for this set.
  const lvRaw = getLevelState(url);
  const li = lvRaw ? levelInfo(sanitizeLevelState(lvRaw, (s.questions || []).length || s.questionCount || 0)) : null;
  const lc = li ? levelColor(li.level, isLightTheme()) : '';
  const lvHtml = li
    ? `<div class="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5" style="border-color:${lc}44;background:${lc}14" title="Levels progress: ${li.name} ${li.pct}%${li.nr ? ' · ' + li.nr + ' need review' : ''}">
         ${ringPct(li.pct, 26, lc, true)}
         <span class="text-[10px] font-semibold leading-none" style="color:${lc}">${li.name}</span>
         ${li.nr ? `<span class="text-[9px] font-bold leading-none" style="color:#f87171" title="${li.nr} need review">·${li.nr}</span>` : ''}
       </div>`
    : '';
  return `
  <div class="group rounded-xl border border-[#22222e] bg-[#0a0a0f] p-3.5 transition-all duration-200 hover:border-purple-500/40 hover:bg-[#0d0d16]">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0 pt-1">
        <div class="text-sm font-semibold text-gray-100 truncate">${escapeHtml(title)}</div>
        <div class="text-[11px] text-gray-500 mt-0.5">${s.questionCount || 0} questions${isLatest ? ' · <span class="text-green-400 font-medium">latest</span>' : ''}</div>
      </div>
      <div class="play-split relative flex h-9 w-9 flex-shrink-0 items-center overflow-hidden rounded-xl border border-[#22222e] bg-[#16161f] transition-all duration-200 group-hover:w-40">
        <a href="${escapeHtml(url)}" target="_blank" rel="noopener" title="Open on Blooket"
          class="pointer-events-none absolute inset-y-0 left-0 flex w-1/2 items-center justify-center gap-1 text-[11px] font-semibold text-purple-300 opacity-0 transition-opacity duration-200 group-hover:pointer-events-auto group-hover:opacity-100 hover:bg-purple-500/20">${icon('external', 'w-3 h-3')} Blooket</a>
        <button type="button" onclick="startQuiz('${jsStr(url)}','${jsStr(title)}')" title="Play in the app"
          class="pointer-events-none absolute inset-y-0 right-0 flex w-1/2 items-center justify-center gap-1 text-[11px] font-semibold text-teal-300 opacity-0 transition-opacity duration-200 group-hover:pointer-events-auto group-hover:opacity-100 hover:bg-teal-500/20">${icon('play', 'w-3 h-3')} Play</button>
        <button type="button" onclick="startQuiz('${jsStr(url)}','${jsStr(title)}')"
          class="absolute inset-0 flex items-center justify-center text-gray-300 transition-opacity duration-200 group-hover:pointer-events-none group-hover:opacity-0">${icon('play', 'w-4 h-4')}</button>
      </div>
    </div>
    <div class="flex items-center justify-between gap-2 mt-3">
      <div class="text-[10px] text-gray-600">${s.createdAt ? escapeHtml(s.createdAt.slice(0, 10)) : ''}</div>
      <div class="flex items-center gap-2 min-w-0 flex-shrink-0">
        ${lvHtml}
        ${statHtml}
      </div>
    </div>
  </div>`;
}

function renderCustomSetsSection(customSets) {
  const sets = customSets.slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const limit = 4;
  const rows = sets.slice(0, limit).map(s => renderSetCard(s, '#2dd4bf', false)).join('');
  const extra = sets.length - limit;
  return `
  <div class="review-class-section bg-[#12121b] border border-[#22222e] rounded-2xl overflow-hidden">
    <div class="relative flex items-center gap-3 px-4 py-3.5 border-b border-[#22222e]" style="background:linear-gradient(90deg, #2dd4bf16, transparent 62%)">
      <span class="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style="background:#2dd4bf24; color:#2dd4bf">${icon('file', 'w-4 h-4')}</span>
      <div class="min-w-0 flex-1">
        <div class="text-sm font-semibold text-white">Other</div>
        <div class="text-[11px] text-gray-500">${sets.length} set${sets.length === 1 ? '' : 's'} you made from your own content</div>
      </div>
      <div class="blooket-progress absolute inset-0 flex items-center justify-center px-16 pointer-events-none" data-class-id="custom"></div>
    </div>
    <div class="p-3 space-y-2">${rows}</div>
  </div>`;
}

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
    ...sets.map(s => `<option value="${escapeHtml(s.setUrl)}">Append to “${escapeHtml((s.chapterTitle || s.title || 'set').slice(0, 42))}”</option>`)];
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
  const active = phase === 'publishing' ? 'Publishing' : 'Generating questions';
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
  if (st.started && st.done) {
    if (st.round >= 3) st.round = 4;
    else st.round++;
  }
  st.done = false;
  st.started = true;
  if (st.round >= 4) {
    saveLevelState(setUrl, st);
    showLevelsMastered(setUrl, title, chapterTitle, st);
    return;
  }
  if (!st.queue.length || st.pos >= st.queue.length) rebuildQueue(st);
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
  const q = quizCurrentQuestion(ctx);
  if (!q) return;
  const total = ctx.questions.length;
  const levels = ctx.mode === 'levels';
  const light = state.theme === 'light';
  let progPct, progColor, lineHtml;
  if (levels) {
    const li = levelInfo(ctx.lv);
    const curCard = ctx.lv.cards[ctx.lv.queue[ctx.lv.pos]];
    progPct = li ? li.pct : 0;
    progColor = levelColor(li ? li.level : 0, light);
    const lvlName = li ? li.name : 'unknown';
    const remaining = ctx.lv.queue.length - ctx.lv.pos;
    lineHtml = `<span class="font-semibold" style="color:${progColor}">${lvlName}</span>
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
    <div class="quiz-in max-w-2xl mx-auto px-1 sm:px-2 py-2 min-h-[62vh] flex flex-col">
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
        <h2 class="text-2xl sm:text-3xl font-semibold leading-snug ${themeChoice('text-white', 'text-gray-900')} mb-8 quiz-in">${escapeHtml(q.q)}</h2>
        <div id="quiz-options" class="grid gap-3 sm:grid-cols-2"></div>
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
      class="w-full flex items-center gap-3 text-left rounded-xl border px-4 py-5 transition-all duration-150 ${cls} ${ctx.answered ? 'cursor-default' : 'cursor-pointer'}"${delayAttr}>
      <span class="w-8 h-8 flex items-center justify-center rounded-lg text-base font-bold flex-shrink-0 ${badgeCls}">${QUIZ_LETTERS[i] || (i + 1)}</span>
      <span class="text-base sm:text-lg font-medium break-words flex-1">${escapeHtml(opt)}</span>
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
    el.innerHTML = `<div class="text-xs ${themeChoice('text-gray-600', 'text-gray-500')} text-center">Pick an answer — or press <span class="${themeChoice('text-gray-400', 'text-gray-700')} font-medium">1–4</span> / <span class="${themeChoice('text-gray-400', 'text-gray-700')} font-medium">A–D</span></div>`;
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
  const st = ctx.lv;
  if (st.round >= 3) {
    st.round = 4; st.done = true;
    saveLevelState(ctx.setUrl, st);
    showLevelsMastered(ctx.setUrl, ctx.title, ctx.chapterTitle, st);
    return;
  }
  st.round++;
  st.done = false;
  ctx.pendingLevelUp = false;
  rebuildQueue(st);
  // Skip ahead if every question already climbed past the new round (via fillers).
  let guard = 0;
  while (st.queue.length === 0 && st.round < 3) { st.round++; rebuildQueue(st); if (++guard > 3) break; }
  if (st.round >= 3 && st.queue.length === 0 && roundComplete(st)) {
    st.round = 4; st.done = true;
    saveLevelState(ctx.setUrl, st);
    showLevelsMastered(ctx.setUrl, ctx.title, ctx.chapterTitle, st);
    return;
  }
  saveLevelState(ctx.setUrl, st);
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
  const screen = document.getElementById('quiz-screen');
  if (!screen) return;
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
        <button type="button" onclick="levelRestartSet()" class="w-full flex items-center justify-center gap-2 bg-teal-500/20 border border-teal-500/30 rounded-xl px-4 py-3 text-sm font-medium ${themeChoice('text-teal-300', 'text-teal-700')} hover:bg-teal-500/30 transition-all">${icon('restart', 'w-4 h-4')}Start over from unknown</button>
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



function renderSettings() {
  const d = state.computed;
  const classes = (d?.activeClasses || []).filter(c => c.isAcademic);
  const goal = state.goal || 90;
  const perClass = state.perClassGoals || {};
  const excluded = new Set(state.excludedClassIds || []);
  const apiKeys = state.apiKeys || {};
  const scrapeLog = state.scrapeLog || { running: false, exitCode: null, logs: [] };

  const keyFields = [
    { name: 'facts', label: 'FACTS SIS' },
    { name: 'openai', label: 'OpenAI' },
    { name: 'ollama', label: 'Ollama Cloud' }
  ];

  return `
  <div class="flex items-center justify-between mb-6">
    <div class="flex items-center gap-3">
      <button onclick="closeSettings()" class="w-9 h-9 rounded-xl bg-[#12121b] border border-[#22222e] flex items-center justify-center text-gray-400 hover:text-white hover:border-blue-500/30 transition-colors" title="Back">${icon('chevronLeft','w-5 h-5')}</button>
      <div>
        <h1 class="text-2xl font-bold text-white">Settings</h1>
        <p class="text-gray-400 mt-1 text-sm">Stored with the app — applied across every view</p>
      </div>
    </div>
    <button onclick="saveSettingsForm()" class="flex items-center gap-2 bg-blue-500/20 border border-blue-500/30 rounded-xl px-4 py-2.5 text-sm text-blue-400 hover:bg-blue-500/30 transition-all font-medium">${icon('check','w-4 h-4')} Save</button>
  </div>

  <div class="flex gap-6 items-start mt-2">
    <aside class="hidden lg:block w-44 flex-shrink-0 self-start sticky top-6">
      <div class="space-y-1">
        <button type="button" class="settings-nav-link active" data-section="goals" onclick="jumpToSettings('goals')">${icon('target','w-3.5 h-3.5')} <span>Goals &amp; Classes</span></button>
        <button type="button" class="settings-nav-link" data-section="data" onclick="jumpToSettings('data')">${icon('clock','w-3.5 h-3.5')} <span>Data &amp; Syncing</span></button>
        <button type="button" class="settings-nav-link" data-section="connections" onclick="jumpToSettings('connections')">${icon('book','w-3.5 h-3.5')} <span>Connections</span></button>
        <button type="button" class="settings-nav-link" data-section="review" onclick="jumpToSettings('review')">${icon('sparkle','w-3.5 h-3.5')} <span>Review &amp; AI</span></button>
        <button type="button" class="settings-nav-link" data-section="appearance" onclick="jumpToSettings('appearance')">${icon('settings','w-3.5 h-3.5')} <span>Appearance</span></button>
      </div>
    </aside>
    <div class="flex-1 min-w-0 max-w-2xl">

  <div id="settings-section-goals" class="settings-section flex items-center gap-2 mt-4 mb-3">
    ${icon('target','w-4 h-4 text-gray-500')}
    <h2 class="text-xs font-bold uppercase tracking-wider text-gray-500">Goals &amp; Classes</h2>
    <div class="flex-1 h-px bg-[#1c1c26]"></div>
  </div>

  <!-- Default Grade Goal -->
  <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5 mb-4">
    <h3 class="text-sm font-semibold text-gray-200 mb-1">Default Grade Goal</h3>
    <p class="text-xs text-gray-500 mb-4">Used for every class unless you set a per-class override below.</p>
    <div class="flex items-center gap-3">
      <input id="settings-goal" type="range" min="60" max="100" step="1" value="${goal}"
        oninput="document.getElementById('goal-display').textContent = this.value + '%'"
        class="flex-1 h-2 bg-[#1c1c26] rounded-full appearance-none cursor-pointer accent-blue-500">
      <span id="goal-display" class="text-lg font-bold text-blue-400 w-16 text-right">${goal}%</span>
    </div>
    <div class="flex justify-between text-xs text-gray-600 mt-1">
      <span>60% (D-)</span><span>90% (A-)</span><span>93% (A)</span><span>100%</span>
    </div>
  </div>

  <!-- Per-Class Goals -->
  <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5 mb-4">
    <div class="flex items-center justify-between mb-1">
      <h3 class="text-sm font-semibold text-gray-200">Per-Class Goals</h3>
      <span class="text-xs text-gray-600">optional override</span>
    </div>
    <p class="text-xs text-gray-500 mb-4">Leave blank to use the default goal.</p>
    <div class="space-y-2">
      ${classes.map(c => {
        const cur = perClass[c.id];
        return `<div class="flex items-center gap-3 p-2 bg-[#0a0a0f] border border-[#22222e] rounded-xl">
          <div class="flex-1 min-w-0">
            <div class="text-sm text-gray-200 truncate">${c.shortName || c.name}</div>
            <div class="text-xs text-gray-500">Current: ${c.weightedGrade != null ? c.weightedGrade + '%' : 'N/A'}</div>
          </div>
          <div class="flex items-center gap-2 flex-shrink-0">
            <span class="text-xs text-gray-600">Goal</span>
            <input type="number" data-per-class-goal="${c.id}" min="50" max="100" step="1" placeholder="Default" value="${cur != null ? cur : ''}"
              class="w-16 px-2 py-1.5 bg-[#12121b] border border-[#22222e] rounded-lg text-sm text-gray-200 text-right placeholder-gray-600">
          </div>
        </div>`;
      }).join('')}
    </div>
  </div>

  <!-- Classes to Skip -->
  <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5 mb-4">
    <h3 class="text-sm font-semibold text-gray-200 mb-1">Classes to Skip</h3>
    <p class="text-xs text-gray-500 mb-4">Excluded from grade calculations, averages and goal checks.</p>
    <div class="space-y-2 scroll-lock max-h-72 overflow-y-auto">
      ${classes.map(c => {
        const isExcluded = excluded.has(c.id);
        return `<label class="flex items-center gap-3 p-2 bg-[#0a0a0f] border border-[#22222e] rounded-xl cursor-pointer hover:border-blue-500/30 transition-colors">
          <input type="checkbox" data-exclude-class="${c.id}" ${isExcluded ? 'checked' : ''} value="${c.id}" class="rounded bg-[#1c1c26] border-[#22222e] text-blue-500 focus:ring-blue-500/30">
          <div class="flex-1 min-w-0">
            <div class="text-sm text-gray-200 truncate">${c.shortName || c.name}</div>
            <div class="text-xs text-gray-500">Current: ${c.weightedGrade != null ? c.weightedGrade + '%' : 'N/A'}</div>
          </div>
          <span class="text-xs ${isExcluded ? 'text-orange-400' : 'text-gray-600'}">${isExcluded ? 'Skipped' : 'Included'}</span>
        </label>`;
      }).join('')}
    </div>
  </div>

  <div id="settings-section-data" class="settings-section flex items-center gap-2 mt-7 mb-3">
    ${icon('clock','w-4 h-4 text-gray-500')}
    <h2 class="text-xs font-bold uppercase tracking-wider text-gray-500">Data &amp; Syncing</h2>
    <div class="flex-1 h-px bg-[#1c1c26]"></div>
  </div>

  <!-- Refresh Classes -->
  <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5 mb-4">
    <h3 class="text-sm font-semibold text-gray-200 mb-1">Refresh Classes</h3>
    <p class="text-xs text-gray-500 mb-4">Run the FACTS scraper now for a specific period and class set. Live output streams below.</p>
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
      <div>
        <label class="text-xs text-gray-500 mb-1 block">Time period</label>
        <select id="scrape-period" class="w-full px-3 py-2 bg-[#0a0a0f] border border-[#22222e] rounded-xl text-sm text-gray-200">
          ${['all','q1','q2','q3','q4','s1','s2','year'].map(p => `<option value="${p}" ${p === 'all' ? 'selected' : ''}>${PERIOD_LABELS[p] || 'All periods'}</option>`).join('')}
        </select>
      </div>
      <div>
        <label class="text-xs text-gray-500 mb-1 block">Classes</label>
        <select id="scrape-classes" class="w-full px-3 py-2 bg-[#0a0a0f] border border-[#22222e] rounded-xl text-sm text-gray-200">
          <option value="all" selected>All classes</option>
          ${classes.map(c => `<option value="${c.id}">${c.shortName || c.name}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="flex items-center gap-2">
      <button onclick="startScrape()" id="scrape-start-btn" class="flex items-center gap-2 bg-blue-500/20 border border-blue-500/30 rounded-xl px-4 py-2.5 text-sm text-blue-400 hover:bg-blue-500/30 transition-all font-medium">${icon('sparkle','w-4 h-4')} Run refresh</button>
      <span id="scrape-status" class="text-xs text-gray-500"></span>
    </div>
    <div class="mt-3 bg-[#0a0a0f] border border-[#22222e] rounded-xl overflow-hidden">
      <div class="flex items-center justify-between px-3 py-2 border-b border-[#22222e]">
        <span class="text-[10px] uppercase tracking-wider text-gray-500">Last scrape ${scrapeLog.running ? ' · running' : scrapeLog.exitCode != null ? ` · exit ${scrapeLog.exitCode}` : ''}</span>
        <button onclick="clearScrapeLog()" class="text-[10px] text-gray-600 hover:text-gray-300 transition-colors">Clear</button>
      </div>
      <pre id="scrape-log" class="scroll-lock h-48 overflow-y-auto p-3 text-[11px] leading-relaxed font-mono text-gray-400 whitespace-pre-wrap">${(scrapeLog.logs && scrapeLog.logs.length) ? escapeHtml(scrapeLog.logs.join('\n')) : 'No scrape has run yet.'}</pre>
    </div>
  </div>

  <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5 mb-4">
    <div class="flex items-center justify-between gap-3 mb-2">
      <div>
        <h3 class="text-sm font-semibold text-gray-200 mb-1">Automatic Refresh</h3>
        <p class="text-xs text-gray-500">Controls how often the dashboard pulls fresh computed data while the app is open.</p>
      </div>
    </div>
    <div>
      <label class="text-xs text-gray-500 mb-1 block">Refresh interval (minutes)</label>
      <input id="settings-refresh-minutes" type="number" min="1" max="240" step="1" value="${state.autoRefreshMinutes || 5}"
        class="w-full px-3 py-2 bg-[#0a0a0f] border border-[#22222e] rounded-xl text-sm text-gray-200 placeholder-gray-600">
    </div>
  </div>

  <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5 mb-4">
    <h3 class="text-sm font-semibold text-gray-200 mb-1">Automatic Scrape</h3>
    <p class="text-xs text-gray-500 mb-4">Schedule FACTS scrapes at specific local times. Times should be comma-separated like 07:00, 12:30, 18:00.</p>
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
      <label class="flex items-center gap-3 p-3 bg-[#0a0a0f] border border-[#22222e] rounded-xl cursor-pointer">
        <input id="settings-auto-scrape-enabled" type="checkbox" ${state.autoScrape?.enabled ? 'checked' : ''} class="rounded bg-[#1c1c26] border-[#22222e] text-blue-500 focus:ring-blue-500/30">
        <div>
          <div class="text-sm text-gray-200">Enable scheduled scrape</div>
          <div class="text-xs text-gray-500">Runs from the backend even if the dashboard is not open.</div>
        </div>
      </label>
      <div>
        <label class="text-xs text-gray-500 mb-1 block">Times</label>
        <input id="settings-auto-scrape-times" type="text" value="${state.autoScrape?.times || '07:00'}" placeholder="07:00, 12:30, 18:00"
          class="w-full px-3 py-2 bg-[#0a0a0f] border border-[#22222e] rounded-xl text-sm text-gray-200 placeholder-gray-600">
      </div>
      <div>
        <label class="text-xs text-gray-500 mb-1 block">What to rescrape</label>
        <select id="settings-auto-scrape-period" class="w-full px-3 py-2 bg-[#0a0a0f] border border-[#22222e] rounded-xl text-sm text-gray-200">
          ${['all','q1','q2','q3','q4','s1','s2','year'].map(p => `<option value="${p}" ${p === (state.autoScrape?.period || 'all') ? 'selected' : ''}>${PERIOD_LABELS[p] || 'All periods'}</option>`).join('')}
        </select>
      </div>
      <div>
        <label class="text-xs text-gray-500 mb-1 block">Classes to rescrape</label>
        <input id="settings-auto-scrape-classes" type="text" value="${state.autoScrape?.classes || 'all'}" placeholder="all or comma-separated class IDs"
          class="w-full px-3 py-2 bg-[#0a0a0f] border border-[#22222e] rounded-xl text-sm text-gray-200 placeholder-gray-600">
      </div>
    </div>
  </div>

  <div id="settings-section-connections" class="settings-section flex items-center gap-2 mt-7 mb-3">
    ${icon('book','w-4 h-4 text-gray-500')}
    <h2 class="text-xs font-bold uppercase tracking-wider text-gray-500">Connections</h2>
    <div class="flex-1 h-px bg-[#1c1c26]"></div>
  </div>

  <!-- API Keys -->
  <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5 mb-4">
    <h3 class="text-sm font-semibold text-gray-200 mb-1">API Keys</h3>
    <p class="text-xs text-gray-500 mb-4">Sent to the app server and stored there — never kept in your browser. Leave a field blank to keep the existing key.</p>
    <div class="space-y-3">
      ${keyFields.map(k => {
        const val = apiKeys[k.name] || '';
        return `<div class="flex items-center gap-3">
          <span class="w-24 text-sm text-gray-300 flex-shrink-0">${k.label}</span>
          <input type="password" data-apikey="${k.name}" autocomplete="off" spellcheck="false"
            value="${val ? '••••••••••' + val.slice(-4) : ''}"
            placeholder="${val ? '•••••••••• stored' : 'Not set'}"
            class="flex-1 px-3 py-2 bg-[#0a0a0f] border border-[#22222e] rounded-xl text-sm text-gray-200 placeholder-gray-600">
        </div>`;
      }).join('')}
    </div>
  </div>

  <!-- Class Notes (Trilium) -->
  <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5 mb-4">
    <div class="flex items-center justify-between mb-1">
      <h3 class="text-sm font-semibold text-gray-200">Class Notes (Trilium)</h3>
      <span id="trilium-status" class="text-xs ${state.trilium?.connected ? 'text-green-400' : 'text-gray-500'}">${state.trilium?.connected ? 'Connected' : 'Not connected'}</span>
    </div>
    <p class="text-xs text-gray-500 mb-4">Search your Trilium notes and link a class to its notes folder. Chapters appear as quick links across Overview, class details and Assignments.</p>

    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
      <div>
        <label class="text-xs text-gray-500 mb-1 block">Trilium URL</label>
        <input id="trilium-url" type="text" value="${escapeHtml((state.trilium?.url || 'http://192.168.0.71:8081'))}" placeholder="http://192.168.0.71:8081" spellcheck="false"
          class="w-full px-3 py-2 bg-[#0a0a0f] border border-[#22222e] rounded-xl text-sm text-gray-200 placeholder-gray-600">
      </div>
      <div>
        <label class="text-xs text-gray-500 mb-1 block">ETAPI token</label>
        <div class="flex items-center gap-2">
          <input id="trilium-token" type="password" autocomplete="off" spellcheck="false"
            value="${state.trilium?.token ? '••••••••••' + state.trilium.token.slice(-4) : ''}"
            placeholder="${state.trilium?.token ? '•••••••••• stored' : 'Paste from Trilium → Options → ETAPI'}"
            class="flex-1 px-3 py-2 bg-[#0a0a0f] border border-[#22222e] rounded-xl text-sm text-gray-200 placeholder-gray-600">
          <button onclick="testTriliumConnection()" id="trilium-test-btn" class="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium ${themeChoice('bg-[#0a0a0f] border-[#22222e] text-gray-300 hover:text-blue-300 hover:border-blue-500/30','bg-white border-[#d9dde7] text-gray-600 hover:text-blue-700 hover:border-blue-400/40')} border transition-colors flex-shrink-0">${icon('sparkle','w-3.5 h-3.5')} Test</button>
        </div>
      </div>
    </div>

    <div class="mt-4">
      <div class="flex items-center gap-2 mb-2">
        <div class="flex-1 flex items-center gap-2">
          <input id="trilium-search-input" type="text" placeholder="Search notes… e.g. 'AP Chemistry' or 'Algebra'" spellcheck="false"
            onkeydown="if(event.key === 'Enter') triliumSearchUI()"
            class="flex-1 px-3 py-2 bg-[#0a0a0f] border border-[#22222e] rounded-xl text-sm text-gray-200 placeholder-gray-600">
          <button onclick="triliumSearchUI()" id="trilium-search-btn" class="flex items-center gap-2 bg-blue-500/20 border border-blue-500/30 rounded-xl px-4 py-2.5 text-sm text-blue-400 hover:bg-blue-500/30 transition-all font-medium">${icon('search','w-4 h-4')} Search</button>
        </div>
      </div>
      <div id="trilium-search-results" class="space-y-2"></div>
    </div>

    <div class="mt-5">
      <div class="flex items-center justify-between mb-2">
        <span class="text-[10px] uppercase tracking-wider text-gray-500">Linked to classes</span>
        <span class="text-[10px] text-gray-600">${classes.filter(c => triliumNotesFor(c.id)).length}/${classes.length} linked</span>
      </div>
      <div class="space-y-2 scroll-lock max-h-80 overflow-y-auto">
        ${classes.map(c => {
          const link = triliumNotesFor(c.id);
          return `
          <div class="p-3 ${themeChoice('bg-[#0a0a0f] border-[#22222e]', 'bg-white border-[#d9dde7]')} border rounded-xl">
            <div class="flex items-center justify-between gap-2 mb-1.5">
              <div class="flex items-center gap-2 min-w-0">
                <span class="text-sm ${themeChoice('text-gray-200','text-gray-800')} truncate">${escapeHtml(c.shortName || c.name)}</span>
                ${link ? badge('linked', 'green') : badge('no notes', 'gray')}
              </div>
              ${link ? `<button onclick="triliumUnlink('${c.id}')" class="text-xs ${themeChoice('text-gray-500 hover:text-red-400','text-gray-600 hover:text-red-600')} transition-colors flex-shrink-0">Unlink</button>` : `<button onclick="document.getElementById('trilium-search-input')?.focus()" class="text-xs text-blue-400 hover:text-blue-300 flex-shrink-0">Search notes…</button>`}
            </div>
            ${link ? triliumNoteCard(c.id, c.shortName || c.name) : ''}
          </div>`;
        }).join('')}
      </div>
    </div>
  </div>

  <div id="settings-section-review" class="settings-section flex items-center gap-2 mt-7 mb-3">
    ${icon('sparkle','w-4 h-4 text-gray-500')}
    <h2 class="text-xs font-bold uppercase tracking-wider text-gray-500">Review &amp; AI</h2>
    <div class="flex-1 h-px bg-[#1c1c26]"></div>
  </div>

  <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5 mb-4">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <h3 class="text-sm font-semibold text-gray-200 mb-1">Levels-based review</h3>
        <p class="text-xs text-gray-500 leading-relaxed">Climb unknown → familiar → proficient → mastered. Questions come back only when you need them, and your progress through each level is saved as you go so you can stop anytime. Turn off for a straight run-through.</p>
      </div>
      <label class="flex-shrink-0 cursor-pointer mt-1">
        <input id="settings-levels-enabled" type="checkbox" ${state.levelsEnabled ? 'checked' : ''} class="sr-only peer">
        <span class="inline-flex w-11 h-6 rounded-full bg-[#1c1c26] border border-[#22222e] peer-checked:bg-teal-500/40 peer-checked:border-teal-500/50 transition-all relative">
          <span class="absolute left-0.5 top-0.5 w-4 h-4 rounded-full bg-gray-500 peer-checked:translate-x-5 peer-checked:bg-teal-300 transition-all"></span>
        </span>
      </label>
    </div>
  </div>

  <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5 mb-4">
    <h3 class="text-sm font-semibold text-gray-200 mb-1">Quiz Review Delay</h3>
    <p class="text-xs text-gray-500 mb-4">After a wrong answer you're locked from moving on for this many seconds, then click anywhere to continue. Set to 0 to skip the wait.</p>
    <label class="text-xs text-gray-500 mb-1 block">Delay after wrong answer (seconds)</label>
    <input id="settings-quiz-delay" type="number" min="0" max="30" step="0.5" value="${state.quizDelay ?? 3}"
      class="w-full px-3 py-2 bg-[#0a0a0f] border border-[#22222e] rounded-xl text-sm text-gray-200 placeholder-gray-600">
  </div>

  <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5 mb-4">
    <h3 class="text-sm font-semibold text-gray-200 mb-1">AI Insights</h3>
    <p class="text-xs text-gray-500 mb-4">Uses Ollama Cloud once daily after grade data changes. Your API key stays on the app server.</p>
    <div class="flex items-center gap-3">
      <span class="w-24 text-sm text-gray-300 flex-shrink-0">Cloud model</span>
      <input id="settings-ollama-model" type="text" value="${(d?.settings?.ollamaModel || 'gpt-oss:120b')}" placeholder="gpt-oss:120b"
        class="flex-1 px-3 py-2 bg-[#0a0a0f] border border-[#22222e] rounded-xl text-sm text-gray-200 placeholder-gray-600">
    </div>
  </div>

  <div id="settings-section-appearance" class="settings-section flex items-center gap-2 mt-7 mb-3">
    ${icon('settings','w-4 h-4 text-gray-500')}
    <h2 class="text-xs font-bold uppercase tracking-wider text-gray-500">Appearance</h2>
    <div class="flex-1 h-px bg-[#1c1c26]"></div>
  </div>

  <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5 mb-4">
    <div class="flex items-center justify-between gap-3 mb-2">
      <div>
        <h3 class="text-sm font-semibold text-gray-200 mb-1">Appearance</h3>
        <p class="text-xs text-gray-500">Switch the whole app between dark and light without reloading.</p>
      </div>
      <div class="inline-flex items-center gap-1 bg-[#0a0a0f] border border-[#22222e] rounded-xl p-1">
        <button type="button" data-theme-choice="dark" onclick="setThemeMode('dark')" class="px-3 py-1.5 rounded-lg text-xs font-medium text-gray-400 hover:text-gray-200 transition-colors ${state.theme === 'dark' ? 'active bg-blue-500/15 text-blue-300' : ''}">Dark</button>
        <button type="button" data-theme-choice="light" onclick="setThemeMode('light')" class="px-3 py-1.5 rounded-lg text-xs font-medium text-gray-400 hover:text-gray-200 transition-colors ${state.theme === 'light' ? 'active bg-blue-500/15 text-blue-300' : ''}">Light</button>
      </div>
    </div>
    <p class="text-xs text-gray-500">The theme is saved with your settings and applied across the app shell and tables.</p>
  </div>
    </div>
  </div>
  `;
}

function jumpToSettings(sec) {
  const el = document.getElementById('settings-section-' + sec);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
window.jumpToSettings = jumpToSettings;

const SETTINGS_SECTIONS = ['goals', 'data', 'connections', 'review', 'appearance'];

function updateSettingsNav() {
  let current = SETTINGS_SECTIONS[0];
  for (const s of SETTINGS_SECTIONS) {
    const el = document.getElementById('settings-section-' + s);
    if (el && el.getBoundingClientRect().top <= 140) current = s;
  }
  document.querySelectorAll('.settings-nav-link').forEach(a => a.classList.toggle('active', a.dataset.section === current));
}

window.saveSettingsForm = async function() {
  const goalInput = document.getElementById('settings-goal');
  const goal = goalInput ? parseInt(goalInput.value) || 90 : state.goal;

  const perClassGoals = {};
  document.querySelectorAll('[data-per-class-goal]').forEach(i => {
    const v = parseInt(i.value);
    if (!isNaN(v) && v >= 1 && v <= 100) perClassGoals[i.dataset.perClassGoal] = v;
  });

  const excludedClassIds = [];
  document.querySelectorAll('[data-exclude-class]').forEach(cb => { if (cb.checked) excludedClassIds.push(cb.value); });

  const apiKeys = { ...(state.apiKeys || {}) };
  document.querySelectorAll('[data-apikey]').forEach(i => {
    const v = i.value.trim();
    if (v && !v.startsWith('••')) apiKeys[i.dataset.apikey] = v;
  });

  const ollamaModel = document.getElementById('settings-ollama-model')?.value.trim() || 'gpt-oss:120b';
  const theme = state.theme || 'dark';
  const autoRefreshMinutes = Math.max(1, parseInt(document.getElementById('settings-refresh-minutes')?.value || state.autoRefreshMinutes || 5, 10) || 5);
  const quizDelay = Math.min(30, Math.max(0, parseFloat(document.getElementById('settings-quiz-delay')?.value) || 0));
  const levelsEnabled = !!document.getElementById('settings-levels-enabled')?.checked;
  const autoScrape = {
    enabled: !!document.getElementById('settings-auto-scrape-enabled')?.checked,
    times: document.getElementById('settings-auto-scrape-times')?.value.trim() || '07:00',
    period: document.getElementById('settings-auto-scrape-period')?.value || 'all',
    classes: document.getElementById('settings-auto-scrape-classes')?.value.trim() || 'all'
  };
  const trilium = { url: state.trilium?.url || '', token: state.trilium?.token || '', notes: state.trilium?.notes || {} };
  const triliumUrl = document.getElementById('trilium-url')?.value.trim();
  const triliumToken = document.getElementById('trilium-token')?.value.trim();
  if (triliumUrl) trilium.url = triliumUrl;
  if (triliumToken && !triliumToken.startsWith('••')) trilium.token = triliumToken;
  const settings = { goal, perClassGoals, excludedClassIds, apiKeys, ollamaModel, theme, autoRefreshMinutes, quizDelay, levelsEnabled, autoScrape, trilium, updated: new Date().toISOString() };
  const ok = await saveSettings(settings);
  if (ok) await refreshData();
};

// ─── SCRAPE / MANUAL REFRESH ────────────────────────────────────
window.startScrape = async function() {
  const period = document.getElementById('scrape-period')?.value || 'all';
  const classes = document.getElementById('scrape-classes')?.value || 'all';
  const btn = document.getElementById('scrape-start-btn');
  const status = document.getElementById('scrape-status');
  if (btn) btn.disabled = true;
  if (status) status.textContent = 'Starting…';
  try {
    const res = await fetch('/api/scrape', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ period, classes }) });
    if (!res.ok) {
      let detail = 'Failed to start';
      try { detail = (await res.json()).detail || detail; } catch (e) {}
      throw new Error(detail);
    }
    await pollScrapeLogs();
  } catch (err) {
    showToast(err.message || 'Failed to start scrape', 'error');
    if (status) status.textContent = '';
  }
};

async function pollScrapeLogs() {
  const status = document.getElementById('scrape-status');
  const logEl = document.getElementById('scrape-log');
  for (let i = 0; i < 400; i++) {
    try {
      const res = await fetch('/api/scrape/logs');
      if (!res.ok) throw new Error('Log fetch failed');
      const data = await res.json();
      state.scrapeLog = data;
      if (logEl) {
        logEl.textContent = data.logs.length ? data.logs.join('\n') : 'No output yet…';
        logEl.scrollTop = logEl.scrollHeight;
      }
      if (data.running) {
        if (status) status.textContent = 'Scrape in progress…';
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      const done = data.exitCode == null || data.exitCode === 0;
      if (status) status.textContent = done ? 'Completed' : 'Finished with errors (exit ' + data.exitCode + ')';
      const btn = document.getElementById('scrape-start-btn');
      if (btn) btn.disabled = false;
      if (done) { await refreshData(); showToast('Classes refreshed!', 'success'); }
      else showToast('Scrape finished with errors — check the log', 'error');
      return;
    } catch (err) {
      const btn = document.getElementById('scrape-start-btn');
      if (btn) btn.disabled = false;
      if (status) status.textContent = '';
      showToast(err.message || 'Failed to read logs', 'error');
      return;
    }
  }
  const btn = document.getElementById('scrape-start-btn');
  if (btn) btn.disabled = false;
  if (status) status.textContent = '';
  showToast('Timed out polling logs', 'error');
}

window.clearScrapeLog = function() {
  const logEl = document.getElementById('scrape-log');
  if (logEl) logEl.textContent = 'No scrape has run yet.';
};

// ─── VIEW ROUTER ────────────────────────────────────────────────
function render(options = {}) {
  if (_quizCtx) return; // keep an active quiz on screen (auto-refresh must not wipe it)
  const container = document.getElementById('view-container');
  if (!container) return;
  const scrollState = options.preserveScroll === false ? null : captureScrollState();
  closeDayTip();

  if (state.loading && !state.renderedOnce) { container.innerHTML = skeleton(); return; }
  if (state.error && !state.renderedOnce) {
    container.innerHTML = `<div class="flex flex-col items-center justify-center h-64">
      <div class="text-4xl mb-4">⚠️</div><div class="text-gray-400 text-lg mb-2">${state.error}</div>
      <button onclick="init()" class="px-4 py-2 bg-blue-500/20 border border-blue-500/30 rounded-xl text-sm text-blue-400">Retry</button>
    </div>`; return;
  }

  const views = { overview: renderOverview, assignments: renderAssignments, grades: renderGrades, calendar: renderCalendar, planner: renderPlanner, goals: renderGoals, insights: renderInsights, settings: renderSettings };
  const fn = views[state.currentView] || renderOverview;
  const gradesNav = GRADE_VIEWS.includes(state.currentView) ? `<nav class="grades-view-nav" aria-label="Grades navigation">
    ${[['grades', 'Reports'], ['insights', 'Insights'], ['goals', 'Goals']].map(([view, label]) => `<button type="button" class="${state.currentView === view ? 'active' : ''}" onclick="navigate('${view}')">${label}</button>`).join('')}
  </nav>` : '';
  const animate = options.animateFirstRender === false ? '' : 'fade-in';
  container.innerHTML = `<div class="${animate}">${gradesNav}${fn()}</div>`;
  state.renderedOnce = true;
  triliumHydrate();
  if (state.currentView === 'settings') checkTriliumStatus();
  if (state.currentView === 'planner') loadBlooketClasses(!state.blooketLoaded);

  // Update sidebar
  document.querySelectorAll('.nav-link').forEach(l => l.classList.toggle('active', l.getAttribute('data-view') === state.currentView || (l.getAttribute('data-view') === 'grades' && GRADE_VIEWS.includes(state.currentView))));
  document.querySelectorAll('#grades-submenu [data-view]').forEach(l => l.classList.toggle('active', l.getAttribute('data-view') === state.currentView));

  // Grade distribution pie chart (Highcharts)
  if (state.currentView === 'overview' && state.gradeDistData && typeof Highcharts !== 'undefined') {
    const el = document.getElementById('grade-dist-chart');
    if (el && state.gradeDistData.length > 0) {
      Highcharts.chart('grade-dist-chart', {
        chart: { type: 'pie', backgroundColor: 'transparent', height: 260 },
        title: { text: '' },
        tooltip: { pointFormat: '<b>{point.y}</b> class(es) ({point.percentage:.1f}%)' },
        plotOptions: {
          pie: {
            innerSize: '55%',
            dataLabels: { enabled: false },
            borderColor: '#12121b',
            borderWidth: 2,
            states: { hover: { halo: { size: 4 }, brightness: 0.1 } }
          }
        },
        legend: {
          layout: 'vertical', align: 'right', verticalAlign: 'middle',
          itemStyle: { color: '#8b8b9a', fontSize: '11px' },
          itemHoverStyle: { color: '#f5f5f7' },
          symbolRadius: 4
        },
        series: [{ name: 'Classes', data: state.gradeDistData, size: '85%' }],
        credits: { enabled: false }
      });
    }
  }
  state.gradeDistData = null;
  restoreScrollState(scrollState);
}

function navigate(view) {
  if (_quizCtx) teardownQuiz();
  if (!VIEWS.includes(view)) view = 'overview';
  state.currentView = view;
  window.location.hash = view;
  render({ preserveScroll: false });
}

// ─── INIT ────────────────────────────────────────────────────────
async function init() {
  try { applyTheme(localStorage.getItem('gradetrack-theme') || 'dark'); } catch (err) {}
  try { setSidebarCollapsed(localStorage.getItem('gradetrack-sidebar-collapsed') === '1'); } catch (err) {}
  await fetchComputed();

  const hash = window.location.hash.slice(1);
  if (hash && VIEWS.includes(hash)) state.currentView = hash;

  render({ preserveScroll: false });

  window.addEventListener('hashchange', () => {
    const h = window.location.hash.slice(1);
    if (VIEWS.includes(h)) navigate(h);
  });

  // Sidebar clicks
  document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const v = link.getAttribute('data-view');
      if (!v) return;
      if (v === 'assignments') {
        if (isSidebarCollapsed()) {
          openSidebarFlyout('assignments', link);
          return;
        }
        toggleAssignmentsSubmenu();
        return;
      }
      if (v === 'grades') {
        if (isSidebarCollapsed()) {
          openSidebarFlyout('grades', link);
          return;
        }
        toggleGradesSubmenu();
      }
      navigate(v);
      document.querySelector('.sidebar')?.classList.remove('open');
      document.getElementById('sidebar-overlay')?.classList.remove('open');
    });
  });

  document.querySelectorAll('#grades-submenu [data-view]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      navigate(link.getAttribute('data-view'));
      document.querySelector('.sidebar')?.classList.remove('open');
      document.getElementById('sidebar-overlay')?.classList.remove('open');
    });
  });

  // Populate assignments submenu and set initial class
  populateAssignmentsSubmenu();
  if (state.assignmentsClassId == null && state.computed?.activeClasses?.length > 0) {
    const classes = state.computed.activeClasses.filter(c => c.isAcademic);
    if (classes.length > 0) state.assignmentsClassId = classes[0].id;
  }

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    const num = parseInt(e.key);
    if (num >= 1 && num <= 9 && VIEWS[num - 1]) { navigate(VIEWS[num - 1]); showToast(`→ ${VIEWS[num - 1].charAt(0).toUpperCase() + VIEWS[num - 1].slice(1)}`, 'info'); }
    if (e.key === 'Escape') closeModal();
  });

  // Auto-refresh
  scheduleAutoRefresh();

  // Settings scroll-spy
  let settingsNavTimer = null;
  window.addEventListener('scroll', () => {
    if (state.currentView !== 'settings') return;
    if (settingsNavTimer) clearTimeout(settingsNavTimer);
    settingsNavTimer = setTimeout(updateSettingsNav, 80);
  }, { passive: true });

  // Click a scrollable box to "activate" its scrolling
  document.addEventListener('click', (e) => {
    const active = e.target.closest('.scroll-lock');
    document.querySelectorAll('.scroll-lock.scroll-active').forEach(el => { if (el !== active) el.classList.remove('scroll-active'); });
    if (active) active.classList.add('scroll-active');
  });

  // Welcome toast
  setTimeout(() => showToast(`📊 GradeTrack loaded — ${state.computed?.activeClasses?.length || 0} classes, ${state.computed?.watchlist?.length || 0} watchlist items`, 'info'), 1500);
}

window.addEventListener('error', (e) => {
  console.error('GradeTrack JS error:', e.message, e.error);
  const c = document.getElementById('view-container');
  if (c && !c.innerHTML.includes('skeleton') && c.querySelector('.animate-spin')) {
    c.innerHTML = `<div class="flex flex-col items-center justify-center h-64 text-center">
      <div class="text-4xl mb-4">⚠️</div>
      <div class="text-red-400 text-sm mb-2">JS Error: ${e.message}</div>
      <button onclick="location.reload()" class="px-4 py-2 bg-blue-500/20 border border-blue-500/30 rounded-xl text-sm text-blue-400">Reload</button>
    </div>`;
  }
});

document.addEventListener('DOMContentLoaded', init);

setTimeout(() => {
  if (state.loading) {
    const c = document.getElementById('view-container');
    if (c) {
      c.innerHTML = `<div class="flex flex-col items-center justify-center h-64 text-center">
        <div class="text-4xl mb-4">⚠️</div>
        <div class="text-red-400 text-sm mb-1">App stuck loading after 8s</div>
        <div class="text-gray-500 text-xs mb-4">Check the browser console (Cmd+Option+J) for errors</div>
        <div class="flex gap-2">
          <button onclick="location.reload()" class="px-4 py-2 bg-blue-500/20 border border-blue-500/30 rounded-xl text-sm text-blue-400">Reload</button>
        </div>
      </div>`;
    }
  }
}, 8000);
