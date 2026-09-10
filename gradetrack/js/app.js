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
  settingsView: 'home',
  goal: 90,
  perClassGoals: {},
  classAliases: {},
  classColors: {},
  excludedClassIds: [],
  apiKeys: {},
  settingsReturnView: 'overview',
  trackedClassIds: null,
  assignmentsClassId: null,
  aiInsights: null,
  calendarSelectedDate: null,
  calendarMode: 'assignments',   // 'assignments' | 'notequiz'
  noteQuizCalendar: null,        // {year, month, days: [...]}
  trendShowOverall: true,
  theme: 'dark',
  autoRefreshMinutes: 5,
  quizDelay: 3,
  levelsEnabled: false,
  autoScrape: { enabled: false, times: '07:00', period: 'all', classes: 'all' },
  noteQuiz: { classes: {} },
  noteQuizMenuOpen: null,
  availableYears: [],
  userName: '',
  userPosition: '',
  profilePicture: '',
  profileLoaded: false,
  scrapeLog: { running: false, exitCode: null, logs: [] },
  aiConversation: [],
  aiChat: [],
  aiAskLoading: false,
  aiDraft: '',
  calendarDetailId: null,
  calendarDetailEditing: false,
  calendarEventDetailId: null,
  todoFormOpen: false,
  todoForm: {},
  openItemMenu: null,
  customBlooketFile: null,
  customBlooketRunning: false,
  blooketLoaded: false,
  currentSetUrl: null,
  expandAllQuestions: false,
  openQuestions: {},
  blooketClasses: [],
  blooketCustomSets: [],
  noteQuizToday: {},            // {classId: [note quiz sets generated today]}
  reviewQuery: '',
  expandedClasses: {},
  expandedCategories: {},        // {classId__category: true} — expanded assignment category
  chapterIndex: {},             // {classId: index} — selected chapter per class card
  quizActive: false,
  trilium: { url: '', token: '', connected: false, notes: {}, cache: {} },
  renderedOnce: false,
  renderedView: null,
  refreshTimer: null
};

const VIEWS = ['overview', 'assignments', 'analytics', 'calendar', 'planner', 'goals', 'insights', 'settings'];
const ANALYTICS_VIEWS = ['analytics', 'insights', 'goals'];
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const COLORS = ['#3b82f6','#8b5cf6','#2dd4bf','#eab308','#f97316','#06b6d4','#ec4899','#a855f7','#22c55e'];

// Predefined per-class color sets, each with a dark-mode and light-mode variant.
const CLASS_COLOR_SETS = [
  { name: 'Blue', dark: '#3b82f6', light: '#2563eb' },
  { name: 'Violet', dark: '#8b5cf6', light: '#7c3aed' },
  { name: 'Teal', dark: '#2dd4bf', light: '#0d9488' },
  { name: 'Amber', dark: '#f59e0b', light: '#d97706' },
  { name: 'Orange', dark: '#f97316', light: '#ea580c' },
  { name: 'Cyan', dark: '#06b6d4', light: '#0891b2' },
  { name: 'Pink', dark: '#ec4899', light: '#db2777' },
  { name: 'Purple', dark: '#a855f7', light: '#9333ea' },
  { name: 'Green', dark: '#22c55e', light: '#16a34a' },
  { name: 'Red', dark: '#ef4444', light: '#dc2626' },
  { name: 'Sky', dark: '#0ea5e9', light: '#0284c7' },
  { name: 'Rose', dark: '#f43f5e', light: '#e11d48' },
];

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

// One-percent goal buffer: any score within 1pt of (or below) goal is yellow.
// Above goal by 1pt+ is green; below goal is orange (red if very low).
const GOAL_BUFFER = 1;

function goalStatus(score, goal) {
  if (score == null || isNaN(score)) return 'unknown';
  if (goal == null || isNaN(goal)) goal = 90;
  if (score < goal) return 'below';
  if (score < goal + GOAL_BUFFER) return 'close';
  return 'above';
}

function gradeColor(score) {
  if (score == null || isNaN(score)) return '#6c6c7c';
  const goal = (typeof state !== 'undefined' && state && state.goal != null && !isNaN(state.goal)) ? state.goal : 90;
  if (score >= goal + GOAL_BUFFER) return '#22c55e';
  if (score >= goal) return '#eab308';
  if (score >= 70) return '#f97316';
  return '#ef4444';
}

function goalColor(score, goal) {
  if (score == null || isNaN(score)) return '#6c6c7c';
  if (goal == null || isNaN(goal)) goal = (state && state.goal != null) ? state.goal : 90;
  if (score >= goal + GOAL_BUFFER) return '#22c55e';
  if (score >= goal) return '#eab308';
  if (score >= 70) return '#f97316';
  return '#ef4444';
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
  restart:'<path d="M4 4v6h6M20 20v-6h-6M20 9A8 8 0 005.64 5.64L4 8m0 0V4m16 12v4m0-4h-4" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  user:'<path d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  lock:'<rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  dots:'<circle cx="12" cy="5" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="19" r="1.2" fill="currentColor"/>',
  trash:'<path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  pencil:'<path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  paperclip:'<path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  send:'<path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  download:'<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  refresh:'<path d="M3 12a9 9 0 0115-6.7L21 8M21 3v5h-5M21 12a9 9 0 01-15 6.7L3 16M3 21v-5h5" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  checkCircle:'<path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  trilium:'<g transform="translate(2.4,0) scale(0.0875)"><path d="m202.9 112.7c-22.5 16.1-54.5 12.8-74.9 6.3l14.8-11.8 14.1-11.3 49.1-39.3-51.2 35.9-14.3 10-14.9 10.5c0.7-21.2 7-49.9 28.6-65.4 1.8-1.3 3.9-2.6 6.1-3.8 2.7-1.5 5.7-2.9 8.8-4.1 27.1-11.1 68.5-15.3 85.2-9.5 0.1 16.2-15.9 45.4-33.9 65.9-2.4 2.8-4.9 5.4-7.4 7.8-3.4 3.5-6.8 6.4-10.1 8.8z" fill="currentColor" opacity="0.55"/><path d="m213.1 104c-22.2 12.6-51.4 9.3-70.3 3.2l14.1-11.3 49.1-39.3-51.2 35.9-14.3 10c0.5-18.1 4.9-42.1 19.7-58.6 2.7-1.5 5.7-2.9 8.8-4.1 27.1-11.1 68.5-15.3 85.2-9.5 0.1 16.2-15.9 45.4-33.9 65.9-2.3 2.8-4.8 5.4-7.2 7.8z" fill="currentColor" opacity="0.75"/><path d="m220.5 96.2c-21.1 8.6-46.6 5.3-63.7-0.2l49.2-39.4-51.2 35.9c0.3-15.8 3.5-36.6 14.3-52.8 27.1-11.1 68.5-15.3 85.2-9.5 0.1 16.2-15.9 45.4-33.8 66z" fill="currentColor"/><path d="m106.7 179c-5.8-21 5.2-43.8 15.5-57.2l4.8 14.2 4.5 13.4 15.9 47-12.8-47.6-3.6-13.2-3.7-13.9c15.5 6.2 35.1 18.6 40.7 38.8 0.5 1.7 0.9 3.6 1.2 5.5 0.4 2.4 0.6 5 0.7 7.7 0.9 23.1-7.1 54.9-15.9 65.7-12-4.3-29.3-24-39.7-42.8-1.4-2.6-2.7-5.1-3.8-7.6-1.6-3.5-2.9-6.8-3.8-10z" fill="currentColor" opacity="0.55"/><path d="m110.4 188.9c-3.4-19.8 6.9-40.5 16.6-52.9l4.5 13.4 15.9 47-12.8-47.6-3.6-13.2c13.3 5.2 29.9 15 38.1 30.4 0.4 2.4 0.6 5 0.7 7.7 0.9 23.1-7.1 54.9-15.9 65.7-12-4.3-29.3-24-39.7-42.8-1.4-2.6-2.7-5.2-3.8-7.7z" fill="currentColor" opacity="0.75"/><path d="m114.2 196.5c-0.7-18 8.6-35.9 17.3-47.1l15.9 47-12.8-47.6c11.6 4.4 26.1 12.4 35.2 24.8 0.9 23.1-7.1 54.9-15.9 65.7-12-4.3-29.3-24-39.7-42.8z" fill="currentColor"/><path d="m86.3 59.1c21.7 10.9 32.4 36.6 35.8 54.9l-15.2-6.6-14.5-6.3-50.6-22 48.8 24.9 13.6 6.9 14.3 7.3c-16.6 7.9-41.3 14.5-62.1 4.1-1.8-0.9-3.6-1.9-5.4-3.2-2.3-1.5-4.5-3.2-6.8-5.1-19.9-16.4-40.3-46.4-42.7-61.5 12.4-6.5 41.5-5.8 64.8-0.3 3.2 0.8 6.2 1.6 9.1 2.5 4 1.3 7.6 2.8 10.9 4.4z" fill="currentColor" opacity="0.55"/><path d="m75.4 54.8c18.9 12 28.4 35.6 31.6 52.6l-14.5-6.3-50.6-22 48.7 24.9 13.6 6.9c-14.1 6.8-34.5 13-53.3 8.2-2.3-1.5-4.5-3.2-6.8-5.1-19.8-16.4-40.2-46.4-42.6-61.5 12.4-6.5 41.5-5.8 64.8-0.3 3.1 0.8 6.2 1.6 9.1 2.6z" fill="currentColor" opacity="0.75"/><path d="m66.3 52.2c15.3 12.8 23.3 33.6 26.1 48.9l-50.6-22 48.8 24.9c-12.2 6-29.6 11.8-46.5 10-19.8-16.4-40.2-46.4-42.6-61.5 12.4-6.5 41.5-5.8 64.8-0.3z" fill="currentColor"/></g>'
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
    state.classAliases = settings.classAliases || {};
    state.classColors = settings.classColors || {};
    state.excludedClassIds = settings.excludedClassIds || [];
    state.apiKeys = settings.apiKeys || {};
    state.theme = settings.theme || state.theme || 'dark';
    state.autoRefreshMinutes = settings.autoRefreshMinutes || state.autoRefreshMinutes || 5;
    state.quizDelay = typeof settings.quizDelay === 'number' ? settings.quizDelay : state.quizDelay;
    state.levelsEnabled = !!settings.levelsEnabled;
    state.autoScrape = settings.autoScrape || state.autoScrape || { enabled: false, times: '07:00', period: 'all', classes: 'all' };
    state.trilium = { connected: false, cache: {}, ...(settings.trilium || state.trilium || {}) };
    state.email = settings.email || state.email || { recipients: [], subjectPrefix: 'Grades Update' };
    state.noteQuiz = { classes: (settings.noteQuiz && settings.noteQuiz.classes) || {} };
    state.prompts = (settings.prompts && typeof settings.prompts === 'object') ? settings.prompts : {};
    state.displayYear = settings.displayYear || '';
    state.availableYears = Array.isArray(settings.availableYears) ? settings.availableYears : (state.availableYears || []);
    state.emailHtml = settings.emailHtml || state.emailHtml || '';
    state.notifications = settings.notifications || state.notifications || { enabled: false, scrapeDone: true, blooketDone: true };
    state.userName = settings.userName || '';
    state.userPosition = settings.userPosition || '';
    state.profilePicture = settings.profilePicture || '';
    state.profileLoaded = true;
    if (typeof updateSidebarUserInfo === 'function') updateSidebarUserInfo();
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
    state.classAliases = settings.classAliases || {};
    state.classColors = settings.classColors || {};
    state.excludedClassIds = settings.excludedClassIds || [];
    state.apiKeys = settings.apiKeys || {};
    state.theme = settings.theme || state.theme || 'dark';
    state.autoRefreshMinutes = settings.autoRefreshMinutes || state.autoRefreshMinutes || 5;
    state.quizDelay = typeof settings.quizDelay === 'number' ? settings.quizDelay : state.quizDelay;
    state.levelsEnabled = !!settings.levelsEnabled;
    state.autoScrape = settings.autoScrape || state.autoScrape || { enabled: false, times: '07:00', period: 'all', classes: 'all' };
    state.trilium = { connected: false, cache: {}, ...(settings.trilium || state.trilium || {}) };
    state.email = settings.email || state.email || { recipients: [], subjectPrefix: 'Grades Update' };
    state.noteQuiz = { classes: (settings.noteQuiz && settings.noteQuiz.classes) || (state.noteQuiz && state.noteQuiz.classes) || {} };
    state.prompts = (settings.prompts && typeof settings.prompts === 'object') ? settings.prompts : (state.prompts || {});
    state.displayYear = settings.displayYear || '';
    state.emailHtml = typeof settings.emailHtml === 'string' ? settings.emailHtml : (state.emailHtml || '');
    state.notifications = settings.notifications || state.notifications || { enabled: false, scrapeDone: true, blooketDone: true };
    state.userName = settings.userName || '';
    state.userPosition = settings.userPosition || '';
    state.profilePicture = settings.profilePicture || '';
    state.computed = { ...(state.computed || {}), settings: { ...(state.computed?.settings || {}), ...settings } };
    applyTheme(state.theme);
    scheduleAutoRefresh();
    return true;
  } catch(e) {
    return false;
  }
}

window.toggleLevelsEnabled = function(cb) {
  state.levelsEnabled = cb.checked;
};;

window.updateToggleUI = function(cb) {
  const track = document.getElementById('levels-toggle-track');
  const knob = document.getElementById('levels-toggle-knob');
  if (!track || !knob) return;
  if (cb.checked) {
    track.classList.add('levels-on');
    knob.classList.add('translate-x-5', 'bg-teal-300');
    knob.style.boxShadow = '0 0 12px rgba(45,212,191,0.7)';
  } else {
    track.classList.remove('levels-on');
    knob.classList.remove('translate-x-5', 'bg-teal-300');
    knob.style.boxShadow = '';
  }
};

// ─── TOAST & MODAL ───────────────────────────────────────────────
const toast = (() => {
  const region = document.getElementById('toast-region');

  const ICONS = {
    good: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`,
    bad: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    warn: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L14.7 3.86a2 2 0 0 0-3.4 0z"/></svg>`,
    info: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`,
    default: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/></svg>`
  };

  const COLORS = {
    good: '#34d399',
    bad: '#f87171',
    warn: '#fbbf24',
    info: '#60a5fa',
    default: '#3b82f6'
  };

  const CLOSE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

  function show({ type = 'default', title = '', message = '', duration = 5000, actions = [] } = {}) {
    if (!region) return null;
    const el = document.createElement('div');
    el.className = 'toast';
    el.style.setProperty('--accent-color', COLORS[type] || COLORS.default);
    el.setAttribute('role', type === 'bad' ? 'alert' : 'status');

    const actionsHtml = actions.length
      ? `<div class="toast-actions">${actions.map((a, i) => `<button class="toast-action" data-idx="${i}">${escapeHtml(a.label)}</button>`).join('')}</div>`
      : '';

    const titleHtml = title ? `<p class="toast-title">${escapeHtml(title)}</p>` : '';
    const msgHtml = message ? `<p class="toast-msg">${escapeHtml(message)}</p>` : '';

    el.innerHTML = `
      <div class="toast-icon">${ICONS[type] || ICONS.default}</div>
      <div class="toast-body">
        ${titleHtml}
        ${msgHtml}
        ${actionsHtml}
      </div>
      <button class="toast-close" aria-label="Dismiss">${CLOSE_ICON}</button>
      ${duration > 0 ? `<div class="toast-progress" style="animation-duration:${duration}ms"></div>` : ''}
    `;

    region.appendChild(el);

    actions.forEach((a, i) => {
      el.querySelector(`.toast-action[data-idx="${i}"]`)?.addEventListener('click', () => {
        a.onClick?.();
        dismiss(el);
      });
    });

    el.querySelector('.toast-close').addEventListener('click', () => dismiss(el));

    let timer;
    if (duration > 0) {
      timer = setTimeout(() => dismiss(el), duration);
      el.addEventListener('mouseenter', () => clearTimeout(timer));
      el.addEventListener('mouseleave', () => { timer = setTimeout(() => dismiss(el), 1200); });
    }

    return el;
  }

  function dismiss(el) {
    if (!el || el.classList.contains('leaving')) return;
    el.classList.add('leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }

  return { show, dismiss };
})();
window.toast = toast;

// Backwards-compat wrapper for showToast(msg, type) used throughout the app.
// Maps the legacy type names onto the new toast API.
function showToast(msg, type = 'success') {
  const map = { success: 'good', error: 'bad', warning: 'warn', warn: 'warn', info: 'info' };
  toast.show({ type: map[type] || type, message: msg, duration: 5000 });
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

// App-native confirm dialog. Returns a Promise<boolean>. Replaces window.confirm()
// so destructive actions (delete set, delete question) use the same dark-themed
// modal as the rest of the app instead of the browser-native prompt.
//
//   opts = { title, message, confirmText?, cancelText?, danger?, icon? }
//   Escape = cancel, Enter = confirm, click outside = cancel.
function confirmAction(opts) {
  return new Promise((resolve) => {
    const {
      title = 'Are you sure?',
      message = '',
      confirmText = 'Confirm',
      cancelText = 'Cancel',
      danger = false,
      icon: iconName = 'alert',
    } = opts || {};
    const overlay = document.getElementById('modal-overlay');
    const container = document.getElementById('modal-container');
    if (!overlay || !container) { resolve(window.confirm(`${title}\n\n${message}`)); return; }
    let done = false;
    const cleanup = (val) => {
      if (done) return;
      done = true;
      overlay.classList.add('hidden');
      container.innerHTML = '';
      overlay.onclick = null;
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(false); }
      else if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        // Don't fire confirm when the user is typing in an input/textarea.
        const tag = (e.target?.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea') return;
        e.preventDefault();
        cleanup(true);
      }
    };
    document.addEventListener('keydown', onKey);
    overlay.onclick = (e) => { if (e.target === overlay) cleanup(false); };
    overlay.classList.remove('hidden');
    const accentBg = danger ? 'bg-red-500/15 text-red-400' : 'bg-blue-500/15 text-blue-400';
    const confirmCls = danger
      ? 'bg-red-500/20 border border-red-500/40 hover:bg-red-500/30 text-red-300'
      : 'bg-blue-500/20 border border-blue-500/30 hover:bg-blue-500/30 text-blue-300';
    container.innerHTML = `
      <div class="bg-[#12121b] border ${danger ? 'border-red-500/40' : 'border-[#22222e]'} rounded-2xl w-full max-w-md shadow-2xl overflow-hidden fade-in">
        <div class="flex items-start gap-3 p-5 border-b border-[#22222e]">
          <span class="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${accentBg}">${icon(iconName, 'w-5 h-5')}</span>
          <div class="flex-1 min-w-0">
            <h3 class="text-base font-semibold text-white">${escapeHtml(title)}</h3>
            ${message ? `<p class="text-sm text-gray-400 mt-1">${escapeHtml(message)}</p>` : ''}
          </div>
        </div>
        <div class="flex items-center justify-end gap-2 p-4 bg-[#0a0a0f]">
          <button type="button" data-confirm-cancel class="px-4 py-2 rounded-xl text-sm text-gray-400 hover:text-gray-200 bg-[#12121b] border border-[#22222e] transition-colors">${escapeHtml(cancelText)}</button>
          <button type="button" data-confirm-ok class="px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${confirmCls}">${escapeHtml(confirmText)}</button>
        </div>
      </div>`;
    container.querySelector('[data-confirm-cancel]').onclick = () => cleanup(false);
    const okBtn = container.querySelector('[data-confirm-ok]');
    okBtn.onclick = () => cleanup(true);
    okBtn.focus();
  });
}
window.confirmAction = confirmAction;

// Sticky header divider — toggles .is-stuck so the bottom line only shows
// (fading in) once the header is actually pinned to the top of the viewport.
function updateStickyHeaders() {
  document.querySelectorAll('.sticky-header').forEach(el => {
    el.classList.toggle('is-stuck', el.getBoundingClientRect().top <= 0);
  });
}

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
    title: opts.title || 'Grades', fmt: fmtDateShort, lastIdx
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
  el.innerHTML = dayTooltipContent(pt.date, { classIds: d.classIds || [], periodKey: d.periodKey || 'year',     title: d.title || 'Grades', series: d.series, multiClass: d.multiClass, activeSeries });
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
    const color = classColorFor(c.id);
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

window.navigateToAlert = function(classId, categoryName) {
  state.currentView = 'analytics';
  state.filters.course = classId;
  window.location.hash = 'analytics';
  render();
};
window.navigate = navigate;

// ─── VIEW: OVERVIEW ─────────────────────────────────────────────
function renderOverview() {
  const d = state.computed;
  if (!d) return skeleton();
  const { overallGrade, overallLetter, overallGPA, overallRunning = [], activeClasses = [], allAssignments = [], goal = 90 } = d;
  const qPeriod = defaultPeriod();
  const qLabel = PERIOD_LABELS[qPeriod] || qPeriod.toUpperCase();

  const qTerm = d.meta?.currentTerm;
  const qGraded = allAssignments.filter(a => a.pts != null && a.pts !== '' && a.term === qTerm);
  const atGoalCount = qGraded.filter(a => a.pct != null && a.pct >= goal).length;
  const atGoalPct = qGraded.length > 0 ? Math.round((atGoalCount / qGraded.length) * 100) : 0;

  return `
  <div class="flex items-center justify-between mb-6">
    <div>
      <h1 class="text-2xl font-bold text-white">Dashboard</h1>
      <p class="text-gray-400 mt-1 text-sm">Academic Year ${d.meta?.academicYear || '2025-26'} · Full Year · ${overallRunning?.length || 0} data points</p>
    </div>
    <div class="flex items-center gap-3">
      <button onclick="refreshData()" class="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors" title="Refresh">${icon('sparkle','w-3.5 h-3.5')} ${timeSince(state.lastUpdated)}</button>
    </div>
  </div>

  <!-- Main Grid: 2/3 content column + 1/3 side card -->
  <div class="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
    <div class="lg:col-span-2 space-y-4">
      <!-- Stats Row -->
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
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
          <div class="text-xs text-gray-500 mb-1">Grades at Goal</div>
          <div class="text-3xl font-bold ${atGoalPct >= 80 ? 'text-green-400' : 'text-orange-400'}">${atGoalPct}%</div>
          <div class="text-xs text-gray-500 mt-2">${atGoalCount}/${qGraded.length} graded at/above ${goal}% this quarter</div>
        </div>
      </div>

      <!-- Running Average Chart -->
      <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5">
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-sm font-medium text-gray-300">Overall Grade Trend</h3>
          <span class="text-xs text-gray-500">${overallRunning?.length || 0} data points · hover to inspect</span>
        </div>
        ${overallRunning && overallRunning.length > 1
          ? runningAvgChart(overallRunning, 220, 550, '#3b82f6', true, goal, quarterBoundariesFrom(d.meta), { classIds: activeClasses.filter(c => c.isAcademic).map(c => c.id), periodKey: 'year', title: 'All Classes' })
          : '<div class="flex items-center justify-center h-48 text-gray-500 text-sm">Collecting grade data...</div>'}
      </div>
    </div>

    <!-- Recent Assignments (side card) -->
    <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5">
      <h3 class="text-sm font-medium text-gray-300 mb-4">Recent Grades</h3>
      ${allAssignments.length === 0
        ? '<div class="text-center text-gray-500 py-4 text-sm flex items-center justify-center gap-2"><span class="animate-spin inline-block w-4 h-4 border-2 border-gray-600 border-t-blue-400 rounded-full"></span> Loading recent assignments…</div>'
        : allAssignments.filter(a => a.pts != null).sort((a, b) => (b.dueDate || '').localeCompare(a.dueDate || '')).slice(0, 5).map(a => `
        <div class="flex items-center gap-3 py-2 border-b border-[#22222e] last:border-0">
          <div class="w-2 h-2 rounded-full flex-shrink-0" style="background:${classColorFor(a.classId)}"></div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-1.5 min-w-0">
              <div class="text-sm text-gray-200 truncate">${a.name}</div>
              ${a.newSinceLastScrape ? '<span class="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 font-semibold flex-shrink-0">New</span>' : ''}
            </div>
            <div class="text-xs text-gray-500">${a.className} · ${a.category}</div>
          </div>
          <div class="text-right flex-shrink-0">
            <div class="text-sm font-medium" style="color:${gradeColor(a.pct)}">${a.pct != null ? a.pct + '%' : a.pts + '/' + a.max}</div>
            <div class="text-xs text-gray-500">${a.dueDate ? formatDate(a.dueDate) : ''}</div>
          </div>
        </div>
      `).join('')}
      ${allAssignments.length > 0 && allAssignments.filter(a => a.pts != null).length === 0 ? '<div class="text-center text-gray-500 py-4 text-sm">No graded assignments yet</div>' : ''}
    </div>
  </div>

  <!-- Class Summary Row -->
  <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5 mb-4">
    <div class="flex items-center justify-between mb-4">
      <div class="flex items-center gap-2">
        <h3 class="text-sm font-medium text-gray-300">Class Snapshot</h3>
        <span class="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 font-medium">${qLabel} Averages</span>
      </div>
      <button onclick="navigate('analytics')" class="text-xs text-blue-400 hover:text-blue-300">View All →</button>
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
        const ci = d.activeClasses.findIndex(x => x.id === c.id);
        const color = classColorFor(c.id);
        const letter = escapeHtml((c.shortName || c.name).trim().charAt(0).toUpperCase());
        return `
        <div onclick="showCourseDetail('${c.id}')" class="rounded-xl p-3 hover:brightness-125 transition-all cursor-pointer border ${themeChoice('border-[#22222e]', 'border-[#d9dde7]')}" style="background:linear-gradient(90deg, ${color}1a, transparent 62%)">
          <div class="flex items-center justify-between mb-1">
            <div class="flex items-center gap-2 min-w-0">
              <span class="w-6 h-6 rounded-lg flex items-center justify-center text-xs font-bold flex-shrink-0" style="background:${color}24; color:${color}">${letter}</span>
              <span class="text-sm font-medium ${themeChoice('text-gray-200', 'text-gray-800')} truncate">${c.shortName || c.name}</span>
            </div>
            <span style="color:${goalColor(qg, goal)}" class="text-xl font-bold tabular-nums">${qg != null ? qg + '%' : 'N/A'}</span>
          </div>
          <div class="flex items-center gap-2 text-xs ${themeChoice('text-gray-500', 'text-gray-600')}">
            <span>${ql || ''}</span>
            ${trendArrow(c.trend)}
          </div>
          <div class="flex items-center gap-1.5 mt-2 pt-2 border-t ${themeChoice('border-[#22222e]', 'border-[#d9dde7]')}">
            <button onclick="event.stopPropagation();gotoClassAssignments('${c.id}')" class="flex items-center gap-1 px-2 py-1 rounded-lg ${themeChoice('bg-[#12121b] border-[#22222e] text-gray-400 hover:text-blue-300 hover:border-blue-500/30', 'bg-white border-[#d9dde7] text-gray-600 hover:text-blue-700 hover:border-blue-400/40')} border text-[10px] font-medium transition-colors" title="Jump to this class's grades">${icon('clipboard','w-3 h-3')} Grades</button>
            <button onclick="event.stopPropagation();gotoClassTrends('${c.id}')" class="flex items-center gap-1 px-2 py-1 rounded-lg ${themeChoice('bg-[#12121b] border-[#22222e] text-gray-400 hover:text-blue-300 hover:border-blue-500/30', 'bg-white border-[#d9dde7] text-gray-600 hover:text-blue-700 hover:border-blue-400/40')} border text-[10px] font-medium transition-colors" title="Jump to this class's report">${icon('trend','w-3 h-3')} Reports</button>
            ${triliumNotesFor(c.id) ? `<a href="${triliumWebUrl(triliumNotesFor(c.id).noteId)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" class="flex items-center gap-1 px-2 py-1 rounded-lg ${themeChoice('bg-[#12121b] border-[#22222e] text-gray-400 hover:text-blue-300 hover:border-blue-500/30', 'bg-white border-[#d9dde7] text-gray-600 hover:text-blue-700 hover:border-blue-400/40')} border text-[10px] font-medium transition-colors" title="Open notes in Trilium">${icon('trilium','w-3 h-3')} ${escapeHtml(triliumNotesFor(c.id).noteTitle || 'Notes')}</a>` : ''}
          </div>
        </div>`;
      }).join('') : '<div class="col-span-full text-center text-gray-500 text-sm py-6 flex items-center justify-center gap-2"><span class="animate-spin inline-block w-4 h-4 border-2 border-gray-600 border-t-blue-400 rounded-full"></span> Loading classes…</div>'}
    </div>
  </div>

  <!-- Note quizzes widget -->
  <div id="note-quiz-overview-widget"></div>
  `;
}

// ─── Stubs for legacy references (defined elsewhere in older builds) ─────────
function updateSettingsNav() {
  // No-op: settings scroll-spy nav was removed; kept as a stub so init() doesn't error.
}
function filterReviewGrid() {
  // No-op: review-grid filter is handled inside loadBlooketClasses / blooket-builder.js.
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
      <div class="w-14 h-14 rounded-2xl flex items-center justify-center text-2xl font-bold" style="background:${classColorFor(c.id)}20; color:${classColorFor(c.id)}">${(c.shortName || c.name).charAt(0)}</div>
      <div class="flex-1">
        <h2 class="text-xl font-bold ${themeChoice('text-white', 'text-gray-900')}">${c.shortName || c.name}</h2>
        <p class="text-sm ${themeChoice('text-gray-400', 'text-gray-600')}">${c.name} · ${periodLabel}</p>
        <div class="flex items-center gap-2 mt-2">
          <button onclick="gotoClassAssignments('${c.id}')" class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg ${themeChoice('bg-[#0a0a0f] border-[#22222e] text-gray-300 hover:text-blue-300 hover:border-blue-500/30', 'bg-white border-[#d9dde7] text-gray-600 hover:text-blue-700 hover:border-blue-400/40')} border text-xs font-medium transition-colors">${icon('clipboard','w-3.5 h-3.5')} Grades</button>
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
      ${runningAvgChart(avg, 160, 500, classColorFor(c.id), true, goal, period === 'year' ? quarterBoundariesFrom(d.meta) : null, { classIds: [c.id], periodKey: period, title: c.shortName || c.name })}
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

function toggleAnalyticsSubmenu() {
  const sub = document.getElementById('analytics-submenu');
  const chevron = document.querySelector('.analytics-chevron');
  if (!sub) return;
  const isOpen = sub.classList.toggle('open');
  chevron?.classList.toggle('open', isOpen);
}
window.toggleAnalyticsSubmenu = toggleAnalyticsSubmenu;

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
      const color = classColorFor(c.id);
      const active = state.assignmentsClassId === c.id;
      const pg = c.periodGrade?.[period];
      const cg = goalFor(c);
      const above = pg != null && pg >= cg + GOAL_BUFFER;
      const close = !above && pg != null && pg >= cg;
      const pillCls = above ? 'bg-green-500/15 text-green-400' : close ? 'bg-yellow-500/15 text-yellow-400' : 'bg-orange-500/15 text-orange-400';
      // Keep decimals only when the grade is within 1pt of goal — otherwise round
      // to the nearest whole percent so the pills stay compact.
      const pillText = pg != null ? (close ? pg + '%' : Math.round(pg) + '%') : '—';
      const pill = pg != null
        ? `<span class="fly-pill ${pillCls}">${pillText}</span>`
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
      { v: 'analytics', label: 'Reports', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"/></svg>' },
      { v: 'insights', label: 'Insights', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg>' },
      { v: 'goals', label: 'Goals', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/></svg>' }
    ];
    inner = `<div class="fly-head">Analytics</div>` + items.map(x => `
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

document.addEventListener('click', (e) => {
  const bar = e.target.closest('.multi-day-bar');
  if (!bar) return;
  e.stopPropagation();
  const idx = parseInt(bar.dataset.mdx, 10);
  const ev = (state._monthMultiEvents || [])[idx];
  if (ev) openMultiDayEventDetail(ev.startDate, ev.endDate, ev.name);
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
    const cg = goalFor(c);
    const above = pg != null && pg >= cg + GOAL_BUFFER;
    const close = !above && pg != null && pg >= cg;
    const pillCls = above ? 'bg-green-500/15 text-green-400' : close ? 'bg-yellow-500/15 text-yellow-400' : 'bg-orange-500/15 text-orange-400';
    // Keep decimals only when the grade is within 1pt of goal — otherwise round
    // to the nearest whole percent so the pills stay compact.
    const pillText = pg != null ? (close ? pg + '%' : Math.round(pg) + '%') : '—';
    const pill = pg != null
      ? `<span class="ml-auto text-[10px] px-1.5 py-0.5 rounded-md font-semibold flex-shrink-0 ${pillCls}">${pillText}</span>`
      : `<span class="ml-auto text-[10px] px-1.5 py-0.5 rounded-md bg-[#1c1c26] text-gray-500 flex-shrink-0">—</span>`;
    return `<a class="${active ? 'active' : ''}" onclick="selectAssignmentClass('${c.id}')" data-assign-class="${c.id}">
      <span class="sub-dot" style="background:${classColorFor(c.id)}"></span>
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
  navigate('analytics');
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
  let cls = classes.find(c => c.id === state.assignmentsClassId);
  if (!cls) {
    const autoPeriod = state.assignmentsPeriod && PERIOD_ORDER.includes(state.assignmentsPeriod) ? state.assignmentsPeriod : defaultPeriod();
    cls = [...classes].sort((a, b) => {
      const ga = a.periodGrade?.[autoPeriod];
      const gb = b.periodGrade?.[autoPeriod];
      if (ga == null && gb == null) return 0;
      if (ga == null) return 1;
      if (gb == null) return -1;
      return ga - gb;
    })[0];
    if (cls) state.assignmentsClassId = cls.id;
  }
  if (!cls) return '<div class="flex flex-col items-center justify-center h-64 text-gray-500"><div class="text-lg mb-2">No classes yet</div><div class="text-sm">Grades will appear here once grade data is available</div></div>';
  const goal = d.goal;
  const ci = classes.indexOf(cls);
  const color = classColorFor(cls.id);

  // Assignments only need quarter-level switching — semesters/year are noise here.
  const available = QUARTER_PERIODS.filter(p => (cls.periodRunning?.[p]?.length || 0) > 0);
  let period = state.assignmentsPeriod;
  if (!period || !available.includes(period)) period = available.includes(defaultPeriod()) ? defaultPeriod() : (available[0] || 'q4');
  state.assignmentsPeriod = period;

  const cgs = (cls.periodCategoryGrades?.[period] || []).filter(cg => cg.assignments?.length > 0);
  const periodCount = cgs.reduce((s, cg) => s + cg.assignments.length, 0);
  const periodAvg = cls.periodGrade?.[period];
  const clsGoal = goalFor(cls);

  return `
  <div class="sticky-header -mt-2 pt-4 pb-4" style="--header-tint: ${color}1a; background-image:linear-gradient(90deg, ${color}1a, transparent 62%)">
    <div class="flex items-center justify-between mb-0">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-2xl flex items-center justify-center text-lg font-bold" style="background:${color}20; color:${color}">${(cls.shortName || cls.name).charAt(0)}</div>
        <div>
          <h1 class="text-2xl font-bold text-white">${cls.shortName || cls.name}</h1>
          <p class="text-gray-400 mt-1 text-sm">${cls.categories?.length || 0} categories · ${periodCount} assignments in ${PERIOD_FULL[period]}</p>
          ${triliumNotesFor(cls.id) ? `<a href="${triliumWebUrl(triliumNotesFor(cls.id).noteId)}" target="_blank" rel="noopener" class="inline-flex items-center gap-1.5 text-xs ${themeChoice('text-blue-400 hover:text-blue-300','text-blue-700 hover:text-blue-800')} mt-1 transition-colors">${icon('trilium','w-3.5 h-3.5')} ${escapeHtml(triliumNotesFor(cls.id).noteTitle || 'Class notes')} <span class="text-gray-500">↗</span></a>` : ''}
        </div>
      </div>
      <div class="text-right">
        <div class="text-xs text-gray-500">${PERIOD_LABELS[period]} Average</div>
        <div class="text-2xl font-bold leading-tight" style="color:${goalColor(periodAvg, clsGoal)}">${periodAvg != null ? periodAvg + '%' : 'N/A'}</div>
        <div class="text-xs text-gray-500">${periodAvg != null ? letterGrade(periodAvg) : ''}</div>
      </div>
    </div>
  </div>

  <div class="inline-flex flex-wrap items-center gap-1 bg-[#0a0a0f] border border-[#22222e] rounded-xl p-1 mt-7 mb-7">
    ${available.map(p => `
      <button onclick="setAssignmentsPeriod('${p}')" class="px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${p === period ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30' : 'text-gray-400 hover:text-gray-200 border border-transparent'}">${PERIOD_LABELS[p]}</button>
    `).join('')}
  </div>

  ${triliumNotesFor(cls.id) ? triliumCardHtml(cls.id, cls.shortName || cls.name, 'latest') : ''}

  <div class="space-y-4">
    ${cgs.map(cg => {
      const catGs = goalStatus(cg.average, goal);
      const catBelow = catGs === 'below';
      const catClose = catGs === 'close';
      const catColor = goalColor(cg.average, goal);
      const sorted = [...cg.assignments].filter(a => a.status !== 'Excuse' && a.status !== 'Exempt').sort((a, b) => (b.dueDate || '').localeCompare(a.dueDate || ''));
      const catKey = cls.id + '__' + cg.name;
      const catExpanded = !!state.expandedCategories[catKey];
      const LIMIT = 6;
      const shown = catExpanded ? sorted : sorted.slice(0, LIMIT);
      const overflow = sorted.length - LIMIT;
      const hasMore = overflow > 0;
      return `
      <div class="bg-[#12121b] border border-[#22222e] rounded-2xl overflow-hidden">
        <button type="button" onclick="toggleAssignmentCategory('${jsStr(catKey)}')" class="w-full flex items-center justify-between px-5 py-3 border-b border-[#22222e] hover:bg-[#16161f] transition-colors text-left cursor-pointer">
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
              <span class="text-sm font-bold" style="color:${catColor}">${cg.average != null ? cg.average + '%' : '-'}</span>
            </div>
            ${catBelow ? `<span class="text-xs text-orange-400">below ${goal}%</span>` : catClose ? `<span class="text-xs text-yellow-400">within 1pt</span>` : `<span class="text-xs text-green-400">at goal</span>`}
            <span class="text-gray-500 flex items-center transition-transform ${catExpanded ? '' : ''}" style="transform:${catExpanded ? 'rotate(180deg)' : ''}">${icon('chevronDown','w-4 h-4')}</span>
          </div>
        </button>
        <div class="divide-y divide-[#22222e]/50 relative" style="position:relative">
          ${shown.map(a => {
            const aGs = goalStatus(a.pct, goal);
            const isBelow = aGs === 'below';
            const isClose = aGs === 'close';
            const isMissing = a.pts == null;
            const pctColor = goalColor(a.pct, goal);
            return `
            <div class="flex items-center gap-4 px-5 py-3 hover:bg-[#0a0a0f]/50 transition-colors ${isBelow ? 'bg-orange-500/[0.03]' : isClose ? 'bg-yellow-500/[0.03]' : isMissing ? 'bg-red-500/[0.03]' : ''}">
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-1.5 min-w-0">
                  <div class="text-sm text-gray-200 font-medium truncate">${a.name}</div>
                  ${a.newSinceLastScrape ? '<span class="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 font-semibold flex-shrink-0">New</span>' : ''}
                </div>
                <div class="text-xs text-gray-500 mt-0.5">${a.dueDate ? formatDate(a.dueDate) : 'No date'}</div>
              </div>
              <div class="flex items-center gap-4 text-sm flex-shrink-0">
                <div class="text-right">
                  <div class="text-gray-400">${a.pts != null ? a.pts : '-'} <span class="text-gray-600">/ ${a.max != null ? a.max : '-'}</span></div>
                </div>
                <div class="w-14 text-right">
                  ${a.pct != null ? `<span class="font-semibold" style="color:${pctColor}">${a.pct}%</span>` : '<span class="text-gray-600">—</span>'}
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
          ${hasMore && !catExpanded ? `
            <div class="category-more absolute inset-x-0 bottom-0 h-20 pointer-events-none" style="background:linear-gradient(to top, #12121b, transparent)"></div>
            <button type="button" onclick="toggleAssignmentCategory('${jsStr(catKey)}')" title="Expand to show all of the rest"
              class="absolute inset-x-0 bottom-0 h-10 flex items-center justify-center text-xs font-medium text-gray-300 hover:text-white transition-colors">
              Expand to show all of the rest
            </button>` : ''}
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

function toggleAssignmentCategory(catKey) {
  state.expandedCategories[catKey] = !state.expandedCategories[catKey];
  render();
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
function renderAnalytics() {
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
  <div class="sticky-header -mt-2 py-4">
    <div class="flex items-center justify-between mb-3">
      <div>
        <h1 class="text-2xl font-bold text-white">Reports</h1>
        <p class="text-gray-400 mt-1 text-sm">${label}: <span class="text-gray-200 font-medium">${stats.grade != null ? stats.grade + '%' : 'N/A'}</span> · GPA: ${d.overallGPA?.toFixed(2)}</p>
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-1 bg-[#0a0a0f] border border-[#22222e] rounded-xl p-1 mb-0">
      ${PERIOD_ORDER.map(p => `
        <button onclick="setGradePeriod('${p}')" class="px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${p === period ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30' : 'text-gray-400 hover:text-gray-200 border border-transparent'}">${PERIOD_LABELS[p]}</button>
      `).join('')}
    </div>
  </div>

  <div class="flex flex-wrap items-center gap-3 mb-4">
      <label class="inline-flex items-center gap-2 text-xs text-gray-300 cursor-pointer"><input type="checkbox" ${state.trendShowOverall ? 'checked' : ''} onchange="state.trendShowOverall=this.checked; render()" class="rounded bg-[#1c1c26] border-[#22222e] text-blue-500"> Overall average</label>
      ${activeTrendClasses.map(c => { const color = classColorFor(c.id); return `<span class="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-[#0a0a0f] border border-[#22222e] text-xs text-gray-300"><span class="w-2 h-2 rounded-full" style="background:${color}"></span>${c.shortName || c.name}</span>`; }).join('')}
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
      const gs = goalStatus(g, cGoal);
      const below = gs === 'below';
      const close = gs === 'close';
      const missing = g == null || line.length === 0;
      const warn = below || missing;
      const trendSelected = (state.trendActive || []).includes(c.id);
      const borderCls = below ? 'border-orange-500/40 bg-orange-500/[0.03]' : close ? 'border-yellow-500/40 bg-yellow-500/[0.03]' : 'border-[#22222e]';
      return `
      <div class="bg-[#12121b] ${borderCls} border rounded-2xl p-4">
        <div class="flex items-center justify-between mb-2">
          <label class="flex items-center gap-2 min-w-0 cursor-pointer"><input type="checkbox" ${trendSelected ? 'checked' : ''} onchange="toggleTrendClass('${c.id}')" class="rounded bg-[#1c1c26] border-[#22222e] text-blue-500"><span class="w-2 h-2 rounded-full flex-shrink-0" style="background:${classColorFor(c.id)}"></span><span class="text-sm font-medium text-gray-200 truncate">${c.shortName || c.name}</span></label>
          <div class="flex items-center gap-2 flex-shrink-0">
            ${below ? `<span class="text-[10px] px-1.5 py-0.5 rounded-md bg-orange-500/15 text-orange-400 font-medium">below goal</span>` : close ? `<span class="text-[10px] px-1.5 py-0.5 rounded-md bg-yellow-500/15 text-yellow-400 font-medium">within 1pt</span>` : missing ? `<span class="text-[10px] px-1.5 py-0.5 rounded-md bg-yellow-500/15 text-yellow-400 font-medium">no data</span>` : ''}
            <span class="text-sm font-bold" style="color:${goalColor(g, cGoal)}">${g != null ? g + '%' : 'N/A'}</span>
          </div>
        </div>
        <div class="h-28">
          ${line.length > 1
            ? runningAvgChart(line, 110, 400, classColorFor(c.id), true, cGoal, period === 'year' ? quarterBoundariesFrom(d.meta) : null, { classIds: [c.id], periodKey: period, title: c.shortName || c.name })
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
              <span class="text-xs w-9 text-right" style="color:${goalColor(cg.average, cGoal)}">${cg.average != null ? cg.average + '%' : '-'}</span>
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
    return { c, color: classColorFor(c.id), valuesByDate, eventDates };
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
    title: 'Grades', fmt: fmtDateShort, lastIdx: dates.length - 1,
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
function classroomDueStr(a) {
  const iso = a && (a.dueDate || a.createdAt);
  if (!iso) return null;
  const dt = new Date(iso);
  if (isNaN(dt.getTime())) return null;
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
function classroomDone(a) {
  return a && (a.submissionState === 'TURNED_IN' || a.submissionState === 'RETURNED');
}

// ─── CALENDAR TODOS ──────────────────────────────────────────────
function getUserTodos() {
  if (!state.computed) state.computed = {};
  if (!state.computed.userTodos) state.computed.userTodos = {};
  const t = state.computed.userTodos;
  if (!Array.isArray(t.todos)) t.todos = [];
  if (!t.overrides) t.overrides = {};
  if (!t.hidden) t.hidden = {};
  if (!t.edits) t.edits = {};
  return t;
}

function todoClassName(classId) {
  if (!classId) return '';
  const classes = (state.computed?.activeClasses || []).filter(c => c.isAcademic);
  const c = classes.find(c => String(c.id) === String(classId));
  return c ? (c.shortName || c.name) : '';
}

function isAssignmentDone(a) {
  const ut = getUserTodos();
  if (a && a.id && Object.prototype.hasOwnProperty.call(ut.overrides, a.id)) return !!ut.overrides[a.id];
  return classroomDone(a);
}

function isAssignmentHidden(a) {
  const ut = getUserTodos();
  return !!(a && a.id && ut.hidden[a.id]);
}

function classColorFor(classId) {
  const key = String(classId == null ? '' : classId);
  const set = (state.classColors || {})[key];
  if (set) return isLightTheme() ? (set.light || set.dark) : (set.dark || set.light);
  const classes = (state.computed?.activeClasses || []).filter(c => c.isAcademic);
  const ci = classes.findIndex(c => String(c.id) === key);
  if (ci < 0) return '#64748b';
  const s = CLASS_COLOR_SETS[ci % CLASS_COLOR_SETS.length];
  return isLightTheme() ? s.light : s.dark;
}

function classIsKnown(classId) {
  return (state.computed?.activeClasses || []).some(c => String(c.id) === String(classId));
}

function courseColorFor(courseName) {
  const all = state.computed?.classroomAssignments || [];
  const names = [...new Set(all.map(a => a.courseName).filter(Boolean))].sort();
  return COLORS[Math.max(0, names.indexOf(courseName)) % COLORS.length];
}

function itemFromAssignment(a) {
  const ut = getUserTodos();
  const edit = a && a.id ? (ut.edits[a.id] || {}) : {};
  const key = 'classroom:' + a.id;
  // Use the fuzzy-matched GradeTrack class id for the correct color;
  // fall back to a generic palette for unmatched courses.
  const matchedId = a.matchedClassId || a.courseId;
  return {
    key,
    src: 'classroom',
    id: a.id,
    title: (edit.title || a.title || '(Untitled)').trim(),
    courseName: a.courseName || '',
    color: a.matchedClassId ? classColorFor(a.matchedClassId) : courseColorFor(a.courseName),
    done: isAssignmentDone(a),
    description: (edit.description || a.description || '').trim(),
    instructions: (edit.instructions || a.instructions || '').trim(),
    materials: [...(a.materials || []), ...(a.submissionAttachments || [])],
    link: (edit.link || a.submissionLink || (a.courseId && a.id ? `https://classroom.google.com/c/${a.courseId}/a/${a.id}` : '')).trim(),
    grade: a.assignedGrade != null ? `${Number(a.assignedGrade)}/${a.maxPoints ?? '?'}` : '',
  };
}

function itemFromTodo(t) {
  return {
    key: 'todo:' + t.id,
    src: 'todo',
    id: t.id,
    title: (t.title || '(Untitled)').trim(),
    courseName: t.className || '',
    color: t.classId ? classColorFor(t.classId) : '#64748b',
    done: !!t.done,
    description: (t.description || '').trim(),
    instructions: (t.instructions || '').trim(),
    materials: [],
    link: (t.link || '').trim(),
    grade: '',
  };
}

function calendarItemsFor(dateStr) {
  const ut = getUserTodos();
  const fromAsns = (state.computed?.classroomAssignments || [])
    .filter(a => classroomDueStr(a) === dateStr && !isAssignmentHidden(a))
    .map(itemFromAssignment);
  const fromTodos = ut.todos
    .filter(t => t.date === dateStr)
    .map(itemFromTodo);
  return [...fromAsns, ...fromTodos].sort((a, b) => a.title.localeCompare(b.title));
}

function renderCalendarDayCell(dateStr, day, year, month, multiEvents, firstDay) {
  const items = calendarItemsFor(dateStr);
  const hasItems = items.length > 0;
  const allDone = hasItems && items.every(i => i.done);
  const now = new Date();
  const isToday = now.getFullYear() === year && now.getMonth() === month && now.getDate() === day;
  const isSelected = state.calendarSelectedDate === dateStr;
  const cls = [
    'cal-day aspect-square p-1 rounded-xl border hover:border-blue-500/30 transition-colors cursor-pointer relative flex flex-col',
    isSelected ? 'selected' : '',
    isToday ? 'today' : '',
    allDone ? 'all-done' : '',
  ].filter(Boolean).join(' ');
  const numCls = allDone ? 'text-green-400' : isToday ? '' : 'text-gray-400';
  const events = (state.computed?.schoolEvents || []).filter(e => e.date === dateStr && !e.isMultiDay);
  return `<div data-date="${dateStr}" class="${cls}" onclick="selectCalendarDay('${dateStr}')">
    <div class="cal-day-num text-sm font-medium ${numCls}">${day}</div>
    ${(() => {
      const totalSlots = items.length + events.length;
      const overflow = totalSlots > 6;
      if (overflow) {
        return `<div class="flex-1 min-h-0 overflow-hidden">
          ${items.slice(0, 14).map(i => `<div class="w-full h-1 rounded-full mt-0.5" style="background:${i.color}; opacity:${i.done ? 0.3 : 1}"></div>`).join('')}
          ${items.length > 14 ? `<div class="text-xs text-gray-600 mt-0.5">+${items.length - 14}</div>` : ''}
        </div>`;
      }
      return `<div class="flex-1 min-h-0 overflow-hidden space-y-px">
        ${items.slice(0, 8).map(i => `<div class="w-full flex items-center gap-1 rounded-sm overflow-hidden cursor-pointer" style="background:${i.color}12" title="${escapeHtml(i.title)}" onclick="event.stopPropagation(); selectCalendarDay('${dateStr}'); setTimeout(() => openCalendarDetail('${jsStr(i.key)}'), 50)"><span class="w-1 h-2 rounded-full flex-shrink-0" style="background:${i.color}; opacity:${i.done ? 0.3 : 1}"></span><span class="text-[8px] leading-tight truncate" style="color:${i.color}; opacity:${i.done ? 0.4 : 0.8}">${escapeHtml(i.title)}</span></div>`).join('')}
        ${items.length > 8 ? `<div class="text-[8px] text-gray-600">+${items.length - 8}</div>` : ''}
      </div>`;
    })()}
    ${events.length ? `<div class="mt-auto pt-0.5 space-y-0.5 flex flex-col items-stretch">${events.slice(0, 3).map((ev, ei) => {
      const color = schoolEventColor(ev);
      const marker = ev?.uniformDay ? '★ ' : '';
      return `<div class="truncate text-[10px] leading-tight px-1.5 py-px rounded font-medium w-full text-left cursor-pointer hover:brightness-125" style="color:${color}; background:${color}1a; border-left:2px solid ${color}" title="${escapeHtml(ev?.name || '')}" onclick="event.stopPropagation(); selectCalendarDay('${dateStr}'); setTimeout(() => openSchoolEventDetail(${ei}), 50)">${marker}${escapeHtml(ev?.name || '')}</div>`;
    }).join('')}${events.length > 3 ? `<div class="text-[10px] text-gray-500 leading-tight">+${events.length - 3} more</div>` : ''}</div>` : ''}
  </div>`;
}

function schoolEventColor(ev) {
  const light = isLightTheme();
  const map = {
    requiredParentEvent: light ? '#dc2626' : '#fb7185',
    requiredStudentEvent: light ? '#2563eb' : '#60a5fa',
    requiredTesting: light ? '#16a34a' : '#4ade80',
    uniformDay: light ? '#d97706' : '#fbbf24',
  };
  if (ev?.category && map[ev.category]) return map[ev.category];
  if (ev?.uniformDay) return map.uniformDay;
  return light ? '#64748b' : '#94a3b8';
}

function schoolEventPill(ev) {
  const color = schoolEventColor(ev);
  const marker = ev?.uniformDay ? '★ ' : '';
  return `<div class="truncate text-[10px] leading-tight px-1.5 py-px rounded font-medium w-full text-left" style="color:${color}; background:${color}1a; border-left:2px solid ${color}" title="${escapeHtml(ev?.name || '')}">${marker}${escapeHtml(ev?.name || '')}</div>`;
}

function renderMultiDayEvents(events, firstDay, daysInMonth, year, month) {
  const multiEvents = [];
  const seen = new Set();
  for (const ev of (events || [])) {
    if (!ev.isMultiDay || !ev.startDate || !ev.endDate) continue;
    const key = ev.startDate + '|' + ev.endDate + '|' + ev.name;
    if (seen.has(key)) continue;
    seen.add(key);
    const sParts = ev.startDate.split('-').map(Number);
    const eParts = ev.endDate.split('-').map(Number);
    const sDate = new Date(sParts[0], sParts[1] - 1, sParts[2]);
    const eDate = new Date(eParts[0], eParts[1] - 1, eParts[2]);
    const monthStart = new Date(year, month, 1);
    const monthEnd = new Date(year, month + 1, 0);
    const visStart = sDate < monthStart ? monthStart : sDate;
    const visEnd = eDate > monthEnd ? monthEnd : eDate;
    const startCol = firstDay + (visStart.getDate() - 1);
    const endCol = firstDay + (visEnd.getDate() - 1);
    const color = schoolEventColor(ev);
    const marker = ev.uniformDay ? '★ ' : '';
    multiEvents.push({ name: ev.name, startCol, endCol, color, marker, startDate: ev.startDate, endDate: ev.endDate });
  }
  return multiEvents;
}

function multiDayBarHtml() { return ''; }

function positionMultiDayOverlay() {
  // Multi-day bars are now positioned via CSS in week-row wrappers.
}

function schoolEventDetail(ev, idx) {
  const color = schoolEventColor(ev);
  const categoryLabel = ev?.category === 'requiredParentEvent' ? 'Required parent event'
    : ev?.category === 'requiredStudentEvent' ? 'Required student event'
    : ev?.category === 'requiredTesting' ? 'Required testing'
    : ev?.uniformDay ? 'Uniform day' : 'School event';
  const isActive = state.calendarEventDetailId === idx;
  return `<div class="flex items-center gap-2 p-1.5 rounded-lg cursor-pointer transition-colors ${isActive ? 'bg-[#22222e]' : 'hover:bg-[#1a1a28]'}" onclick="openSchoolEventDetail(${idx})">
    <span class="w-1.5 h-1.5 rounded-full flex-shrink-0" style="background:${color}"></span>
    <span class="flex-1 min-w-0 text-xs text-gray-200 truncate" title="${escapeHtml(ev?.name || '')}">${ev?.uniformDay ? '★ ' : ''}${escapeHtml(ev?.name || '')}</span>
    <span class="text-[9px] text-gray-500 flex-shrink-0" style="color:${color}">${categoryLabel}</span>
  </div>`;
}

function openSchoolEventDetail(idx) {
  state.calendarEventDetailId = state.calendarEventDetailId === idx ? null : idx;
  state.calendarDetailId = null;
  state.calendarDetailEditing = false;
  render();
}

window.openMultiDayEventDetail = function(startDate, endDate, name) {
  const ev = (state.computed?.schoolEvents || []).find(e => e.name === name && e.startDate === startDate && e.endDate === endDate);
  if (!ev) return;
  state.calendarEventDetailId = '_multi_' + startDate + '_' + endDate + '_' + name;
  state.calendarDetailId = null;
  state.calendarDetailEditing = false;
  state._multiDayDetailEvent = ev;
  render();
};

function renderSchoolEventDetailPanel(ev) {
  if (!ev) return '';
  const color = schoolEventColor(ev);
  const categoryLabel = ev?.category === 'requiredParentEvent' ? 'Required parent event'
    : ev?.category === 'requiredStudentEvent' ? 'Required student event'
    : ev?.category === 'requiredTesting' ? 'Required testing'
    : ev?.uniformDay ? 'Uniform day' : 'School event';
  const isRange = ev.startDate && ev.endDate && ev.startDate !== ev.endDate;
  const dateLabel = isRange ? `${formatDate(ev.startDate)} — ${formatDate(ev.endDate)}` : formatDate(ev.date);
  return `
  <div class="cal-detail open">
    <div class="cal-detail-card">
      <div class="flex items-center justify-between gap-2 mb-3">
        <div class="flex items-center gap-2 text-[10px] uppercase tracking-wider text-gray-500">
          ${icon('calendar','w-3 h-3')} School event
        </div>
        <button onclick="state.calendarEventDetailId=null; render()" class="p-1.5 rounded-lg text-gray-500 hover:text-gray-300 hover:bg-[#22222e] transition-colors" title="Close">${icon('x','w-4 h-4')}</button>
      </div>
      <div class="space-y-3">
        <div class="flex flex-wrap items-center gap-2">
          <span class="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full" style="background:${color}20; color:${color}"><span class="w-1.5 h-1.5 rounded-full" style="background:${color}"></span>${escapeHtml(categoryLabel)}</span>
          ${ev.uniformDay ? `<span class="text-xs px-2 py-1 rounded-full bg-amber-500/10 text-amber-300 border border-amber-500/20">★ Uniform day</span>` : ''}
        </div>
        <div class="text-base font-semibold text-gray-100">${ev?.uniformDay ? '★ ' : ''}${escapeHtml(ev.name)}</div>
        <div class="text-sm text-gray-400">${escapeHtml(dateLabel)}</div>
        ${isRange ? `<div class="text-xs text-gray-500">${Math.round((new Date(ev.endDate) - new Date(ev.startDate)) / 86400000) + 1} days</div>` : ''}
      </div>
    </div>
  </div>`;
}

function renderCalendarItems(items) {
  if (items.length === 0 && !state.todoFormOpen) {
    return '<div class="text-center text-gray-500 py-6 text-sm">Nothing due on this day — add a thing to do below.</div>';
  }
  return items.map(i => {
    const menuOpen = state.openItemMenu === i.key;
    return `
    <div class="cal-item relative flex items-start gap-2.5 p-2.5 rounded-xl border transition-all duration-300 cursor-pointer ${i.done ? 'done' : ''}" data-key="${i.key}" onclick="openCalendarDetail('${jsStr(i.key)}')">
      <button class="cal-check mt-0.5 flex-shrink-0" style="--c:${i.color}" onclick="event.stopPropagation(); toggleCalendarItem('${jsStr(i.key)}')" title="${i.done ? 'Mark not done' : 'Mark done'}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path class="cal-check-mark" d="M5 13l4 4L19 7"/></svg>
      </button>
      <div class="flex-1 min-w-0">
        <div class="cal-item-title text-xs font-medium truncate transition-colors">${escapeHtml(i.title)}</div>
        <div class="cal-item-sub text-[11px] truncate transition-colors">${escapeHtml([i.courseName, i.grade].filter(Boolean).join(' · ')) || 'Thing to do'}</div>
      </div>
      <div class="flex items-center gap-1 flex-shrink-0">
        ${i.link ? `<a href="${escapeHtml(i.link)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" class="text-[11px] text-blue-400 hover:text-blue-300 p-1.5 rounded-md hover:bg-blue-500/10 transition-colors">${icon('external','w-3 h-3')}</a>` : ''}
        <button class="cal-more p-1.5 rounded-lg text-gray-500 hover:text-gray-300 hover:bg-[#22222e] transition-colors" onclick="event.stopPropagation(); toggleItemMenu('${jsStr(i.key)}')" title="More">${icon('dots','w-4 h-4')}</button>
      </div>
      ${menuOpen ? `
      <div class="cal-menu" onclick="event.stopPropagation()">
        <button onclick="editCalendarItem('${jsStr(i.key)}')">${icon('pencil','w-3.5 h-3.5')} Edit</button>
        <button class="danger" onclick="deleteCalendarItem('${jsStr(i.key)}')">${icon('trash','w-3.5 h-3.5')} Delete</button>
      </div>` : ''}
    </div>`;
  }).join('');
}

function renderCalendarDetail(items) {
  const key = state.calendarDetailId;
  if (!key) return '';
  const item = items.find(i => i.key === key);
  if (!item) return '';
  const editing = state.calendarDetailEditing;
  const classes = (state.computed?.activeClasses || []).filter(c => c.isAcademic);
  const isTodo = item.src === 'todo';
  const currentClassId = isTodo ? (getUserTodos().todos.find(t => t.id === item.id)?.classId || '') : '';
  const classOptions = `<option value="">No class — just a thing to do</option>${classes.map(c => `<option value="${escapeHtml(c.id)}" ${String(currentClassId) === String(c.id) ? 'selected' : ''}>${escapeHtml(c.shortName || c.name)}</option>`).join('')}`;
  const title = editing ? `<input id="cal-edit-title" value="${escapeHtml(item.title)}" class="cal-input w-full" placeholder="Title">` : `<div class="text-base font-semibold text-gray-100">${escapeHtml(item.title)}</div>`;

  const pills = `
    <div class="flex flex-wrap items-center gap-2">
      ${item.courseName ? `<span class="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full" style="background:${item.color}20; color:${item.color}"><span class="w-1.5 h-1.5 rounded-full" style="background:${item.color}"></span>${escapeHtml(item.courseName)}</span>` : ''}
      ${item.grade ? `<span class="text-xs px-2 py-1 rounded-full bg-blue-500/10 text-blue-300 border border-blue-500/20">${escapeHtml(item.grade)}</span>` : ''}
    </div>`;

  const viewCheck = editing ? '' : `
    <button onclick="toggleCalendarItem('${jsStr(item.key)}')" class="cal-view-check flex-shrink-0 ${item.done ? 'done' : ''}" style="--c:${item.color}" title="${item.done ? 'Mark not done' : 'Mark done'}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path class="cal-view-check-mark" d="M5 13l4 4L19 7"/></svg>
    </button>`;

  const body = editing ? `
    <div class="space-y-2.5">
      ${title}
      ${isTodo ? `<select id="cal-edit-class" class="styled-select cal-input w-full">${classOptions}</select>` : ''}
      <textarea id="cal-edit-desc" rows="2" class="cal-input w-full resize-none" placeholder="Notes / description">${escapeHtml(item.description)}</textarea>
      <textarea id="cal-edit-instr" rows="2" class="cal-input w-full resize-none" placeholder="Instructions">${escapeHtml(item.instructions)}</textarea>
      <input id="cal-edit-link" type="text" value="${escapeHtml(item.link)}" class="cal-input w-full" placeholder="Link (optional)">
    </div>` : `
    <div class="space-y-3">
      <div class="flex items-start justify-between gap-3">
        ${pills}
        ${viewCheck}
      </div>
      ${title}
      ${item.description ? `<div class="text-sm text-gray-400 whitespace-pre-wrap leading-relaxed">${escapeHtml(item.description)}</div>` : ''}
      ${item.instructions ? `<div class="text-sm text-gray-400 whitespace-pre-wrap leading-relaxed">${escapeHtml(item.instructions)}</div>` : ''}
      ${item.materials.length ? `<div class="space-y-1.5">${item.materials.map(m => {
        const mUrl = m.url || m.link || '';
        const mTitle = m.title || mUrl || 'Attachment';
        const isSubmission = !!(m.isSubmission || item.materials.indexOf(m) >= (item.rawMaterials?.length || 0));
        return mUrl ? `<a href="${escapeHtml(mUrl)}" target="_blank" rel="noopener" class="w-full flex items-center gap-2 text-sm text-blue-400 hover:text-blue-300 py-1.5 px-2.5 rounded-lg bg-[#0a0a0f] border border-[#22222e] hover:border-blue-500/30 transition-colors">${icon('paperclip','w-3.5 h-3.5 flex-shrink-0')}<span class="truncate">${escapeHtml(mTitle)}</span></a>` : `<div class="w-full flex items-center gap-2 text-sm text-gray-400 py-1.5 px-2.5 rounded-lg bg-[#0a0a0f] border border-[#22222e]">${icon('paperclip','w-3.5 h-3.5 flex-shrink-0')}<span class="truncate">${escapeHtml(mTitle)}</span></div>`;
      }).join('')}</div>` : ''}
      ${item.link ? `<a href="${escapeHtml(item.link)}" target="_blank" rel="noopener" class="inline-flex items-center gap-2 text-sm text-blue-400 hover:text-blue-300 transition-colors">${icon('external','w-3 h-3')} Open in Google Classroom</a>` : ''}
    </div>`;

  return `
  <div class="cal-detail open">
    <div class="cal-detail-card">
      <div class="flex items-center justify-between gap-2 mb-3">
        <div class="flex items-center gap-2 text-[10px] uppercase tracking-wider ${editing ? 'text-teal-400' : 'text-gray-500'}">
          ${editing ? `${icon('pencil','w-3 h-3')} Editing` : `${icon('file','w-3 h-3')} Details`}
        </div>
        <button onclick="closeCalendarDetail()" class="p-1.5 rounded-lg text-gray-500 hover:text-gray-300 hover:bg-[#22222e] transition-colors" title="Close">${icon('x','w-4 h-4')}</button>
      </div>
      ${body}
      <div class="flex items-center gap-2 mt-4 ${editing ? '' : 'hidden'}">
        <button onclick="saveCalendarEdit('${jsStr(item.key)}')" class="flex-1 px-3 py-2 rounded-xl bg-blue-500/20 border border-blue-500/30 text-sm text-blue-400 hover:bg-blue-500/30 transition-all">Save</button>
        <button onclick="setCalendarEditing(false)" class="px-3 py-2 rounded-xl text-sm text-gray-400 hover:text-gray-200 bg-[#0a0a0f] border border-[#22222e] transition-colors">Cancel</button>
      </div>
    </div>
  </div>`;
}

function renderCalendarAddForm(dateStr) {
  if (!state.todoFormOpen) return '';
  const classes = (state.computed?.activeClasses || []).filter(c => c.isAcademic);
  const f = state.todoForm || {};
  return `
  <div class="todo-form p-3 rounded-xl border border-teal-500/25 bg-teal-500/5 space-y-2">
    <div class="flex items-center justify-between">
      <span class="text-[10px] uppercase tracking-wider text-teal-400">New thing to do</span>
      <button onclick="closeTodoForm()" class="p-1 rounded-md text-gray-500 hover:text-gray-300 transition-colors">${icon('x','w-3.5 h-3.5')}</button>
    </div>
    <input id="todo-form-title" value="${escapeHtml(f.title || '')}" class="cal-input w-full" placeholder="What needs doing?">
    <select id="todo-form-class" class="styled-select cal-input w-full">
      <option value="">No class — just a thing to do</option>
      ${classes.map(c => `<option value="${escapeHtml(c.id)}" ${String(f.classId) === String(c.id) ? 'selected' : ''}>${escapeHtml(c.shortName || c.name)}</option>`).join('')}
    </select>
    <textarea id="todo-form-desc" rows="2" class="cal-input w-full resize-none" placeholder="Notes (optional)">${escapeHtml(f.description || '')}</textarea>
    <textarea id="todo-form-instr" rows="2" class="cal-input w-full resize-none" placeholder="Instructions (optional)">${escapeHtml(f.instructions || '')}</textarea>
    <input id="todo-form-link" type="text" value="${escapeHtml(f.link || '')}" class="cal-input w-full" placeholder="Link (optional)">
    <div class="flex items-center gap-2 pt-1">
      <button onclick="saveNewTodo('${dateStr}')" class="flex-1 px-3 py-2 rounded-xl bg-teal-500/20 border border-teal-500/30 text-sm text-teal-400 hover:bg-teal-500/30 transition-all">Add</button>
      <button onclick="closeTodoForm()" class="px-3 py-2 rounded-xl text-sm text-gray-400 hover:text-gray-200 bg-[#0a0a0f] border border-[#22222e] transition-colors">Cancel</button>
    </div>
  </div>`;
}
function renderCalendar() {
  const d = state.computed;
  if (!d) return skeleton();
  const all = d.classroomAssignments || [];

  const year = state.calendarYear, month = state.calendarMonth;
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date(); today.setHours(0,0,0,0);

  const monthAssignments = all.filter(a => {
    const ds = classroomDueStr(a);
    if (!ds) return false;
    const d2 = new Date(ds + 'T12:00:00');
    return d2.getMonth() === month && d2.getFullYear() === year;
  });
  const monthPrefix = `${year}-${String(month + 1).padStart(2, '0')}`;
  const monthTodoCount = (getUserTodos().todos || []).filter(t => (t.date || '').startsWith(monthPrefix)).length;
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  if (!state.calendarSelectedDate || !state.calendarSelectedDate.startsWith(monthPrefix)) {
    state.calendarSelectedDate = today.getFullYear() === year && today.getMonth() === month ? todayStr : `${monthPrefix}-01`;
  }
  const selectedItems = calendarItemsFor(state.calendarSelectedDate);
  const selectedLabel = formatDate(state.calendarSelectedDate);
  const doneCount = selectedItems.filter(i => i.done).length;
  const allDone = selectedItems.length > 0 && doneCount === selectedItems.length;
  const selectedEvents = (state.computed?.schoolEvents || []).filter(e => e.date === state.calendarSelectedDate);
  const monthStart = `${monthPrefix}-01`;
  const monthEnd = `${monthPrefix}-${String(daysInMonth).padStart(2, '0')}`;
  const monthMultiDayEntries = (state.computed?.schoolEvents || []).filter(e => {
    if (!e.isMultiDay) return false;
    const sd = e.startDate || e.date;
    const ed = e.endDate || e.date;
    return sd <= monthEnd && ed >= monthStart;
  });
  const monthMultiEvents = renderMultiDayEvents(monthMultiDayEntries, firstDay, daysInMonth, year, month);
  state._monthMultiEvents = monthMultiEvents;

  return `
  <div class="flex flex-wrap items-center justify-between gap-4 mb-6">
    <div>
      <h1 class="text-2xl font-bold text-white">Calendar</h1>
      <p class="text-gray-400 mt-1 text-sm">${monthAssignments.length} assignment${monthAssignments.length === 1 ? '' : 's'}${monthTodoCount ? ` · ${monthTodoCount} thing${monthTodoCount === 1 ? '' : 's'} to do` : ''} this month</p>
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
    <div class="lg:col-span-2 bg-[#12121b] border border-[#22222e] rounded-2xl p-4 cal-grid-wrap" style="position:relative">
      <div class="cal-grid">
        <div class="grid grid-cols-7 gap-1 cal-grid-header">
          ${DAYS.map(dd => `<div class="text-center text-xs font-medium text-gray-500 py-2">${dd}</div>`).join('')}
        </div>
        ${(() => {
          const totalCells = firstDay + daysInMonth;
          const weekCount = Math.ceil(totalCells / 7);
          const allCells = [
            ...Array(firstDay).fill(0).map(() => null),
            ...Array(daysInMonth).fill(0).map((_, i) => i + 1),
          ];
          const weeks = [];
          for (let w = 0; w < weekCount; w++) {
            const rowCells = allCells.slice(w * 7, w * 7 + 7);
            const cellsHtml = rowCells.map(day => {
              if (day === null) return '<div></div>';
              return renderCalendarDayCell(`${monthPrefix}-${String(day).padStart(2, '0')}`, day, year, month, monthMultiEvents, firstDay);
            }).join('');
            // Compute multi-day bars for this week row
            const weekStartCol = w * 7;
            const weekEndCol = weekStartCol + 6;
            const weekBars = [];
            const rowSlots = [];
            const sortedEvs = monthMultiEvents
              .filter(ev => ev.endCol >= weekStartCol && ev.startCol <= weekEndCol)
              .map(ev => ({
                ev,
                segStart: Math.max(ev.startCol, weekStartCol),
                segEnd: Math.min(ev.endCol, weekEndCol),
              }))
              .sort((a, b) => a.segStart - b.segStart || a.segEnd - b.segEnd);
            for (const { ev, segStart, segEnd } of sortedEvs) {
              const colInRow = segStart - weekStartCol;
              const span = segEnd - segStart + 1;
              const leftPct = (colInRow / 7 * 100);
              const widthPct = (span / 7 * 100);
              const inset = 0.85;
              const barLeft = leftPct + inset;
              const barWidth = widthPct - inset * 2;
              let slot = 0;
              for (const occupied of rowSlots) {
                if (!(barLeft + barWidth <= occupied.left || barLeft >= occupied.left + occupied.width)) {
                  slot = Math.max(slot, occupied.slot + 1);
                }
              }
              rowSlots.push({ left: barLeft, width: barWidth, slot });
              const isStart = ev.startCol <= weekStartCol;
              const isEnd = ev.endCol >= weekEndCol;
              const bdrL = isStart ? 'border-top-left-radius:3px;border-bottom-left-radius:3px;' : '';
              const bdrR = isEnd ? 'border-top-right-radius:3px;border-bottom-right-radius:3px;' : '';
              const leftBorder = isStart ? `border-left:2px solid ${ev.color};` : '';
              const label = `<span class="truncate">${ev.marker}${escapeHtml(ev.name)}</span>`;
              weekBars.push(`<div class="multi-day-bar" data-mdx="${monthMultiEvents.indexOf(ev)}" style="position:absolute;left:${barLeft}%;width:${barWidth}%;bottom:${5.15 + slot * 18}px;height:16px;background:${ev.color}1a;color:${ev.color};${leftBorder}${bdrL}${bdrR}pointer-events:auto;cursor:pointer;display:flex;align-items:center;padding:0 6px;font-size:10px;font-weight:500;overflow:hidden;transition:filter 0.15s;border-radius:4px;z-index:10;" title="${escapeHtml(ev.name)}">${label}</div>`);
            }
            weeks.push(`<div class="cal-week relative" style="min-height:0"><div class="grid grid-cols-7 gap-1">${cellsHtml}</div>${weekBars.join('')}</div>`);
          }
          return weeks.join('');
        })()}
      </div>
    </div>

    <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-4 flex flex-col lg:h-[calc(100vh-5.5rem)] lg:sticky lg:top-6 overflow-hidden cal-side">
      <div class="flex items-center justify-between mb-1">
        <h3 class="text-sm font-medium text-gray-300">${selectedLabel}</h3>
        <span id="cal-done-count" class="text-xs ${allDone ? 'text-green-400' : 'text-gray-500'}">${doneCount}/${selectedItems.length} done</span>
      </div>
      <div class="flex-1 min-h-0 overflow-y-auto pr-1 space-y-2 py-2 cal-list">
        ${selectedEvents.length ? `<div class="rounded-xl border border-[#22222e] bg-[#0a0a0f] p-2.5 space-y-1.5 cal-events-list">${selectedEvents.map((e, i) => schoolEventDetail(e, i)).join('')}</div>` : ''}
        ${state.calendarEventDetailId !== null
          ? (state.calendarEventDetailId.startsWith('_multi_')
            ? renderSchoolEventDetailPanel(state._multiDayDetailEvent)
            : renderSchoolEventDetailPanel(selectedEvents[state.calendarEventDetailId]))
          : ''}
        ${renderCalendarItems(selectedItems)}
        ${state.todoFormOpen
          ? renderCalendarAddForm(state.calendarSelectedDate)
          : `<button onclick="openTodoForm()" class="w-full rounded-xl border-2 border-dashed py-3 flex items-center justify-center gap-2 text-sm font-medium transition-colors ${isLightTheme() ? 'text-gray-500 hover:text-teal-700 hover:border-teal-400/40 border-[#d9dde7]' : 'text-gray-400 hover:text-teal-300 hover:border-teal-500/40 border-[#22222e]'}">${icon('plus','w-4 h-4')} Add a thing to do</button>`}
      </div>
      ${state.calendarDetailId ? renderCalendarDetail(selectedItems) : ''}
    </div>
  </div>`;
}

function selectCalendarDay(dateStr) {
  state.calendarSelectedDate = dateStr;
  state.calendarDetailId = null;
  state.calendarDetailEditing = false;
  state.calendarEventDetailId = null;
  state.todoFormOpen = false;
  state.todoForm = {};
  state.openItemMenu = null;
  render();
}
window.selectCalendarDay = selectCalendarDay;

// ─── CALENDAR INTERACTIONS ───────────────────────────────────────
window.toggleCalendarItem = async function(key) {
  const sep = key.indexOf(':');
  const src = key.slice(0, sep);
  const id = key.slice(sep + 1);
  const ut = getUserTodos();
  let newDone;
  if (src === 'todo') {
    const t = ut.todos.find(t => t.id === id);
    newDone = !(t && t.done);
  } else {
    const asn = (state.computed.classroomAssignments || []).find(a => String(a.id) === id);
    newDone = !isAssignmentDone(asn);
  }
  if (src === 'todo') {
    const t = ut.todos.find(t => t.id === id);
    if (t) t.done = newDone;
  } else {
    ut.overrides[id] = newDone;
  }
  const itemEl = document.querySelector('.cal-item[data-key="' + key + '"]');
  if (itemEl) {
    itemEl.classList.toggle('done', newDone);
    const chk = itemEl.querySelector('.cal-check');
    if (chk) chk.title = newDone ? 'Mark not done' : 'Mark done';
  }
  const viewCheck = document.querySelector('.cal-detail .cal-view-check');
  if (viewCheck) {
    viewCheck.classList.toggle('done', newDone);
    viewCheck.title = newDone ? 'Mark not done' : 'Mark done';
  }
  updateCalendarCounts(state.calendarSelectedDate);
  try {
    const res = await fetch('/api/todos/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, done: newDone }) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
  } catch (err) {
    if (src === 'todo') {
      const t = ut.todos.find(t => t.id === id);
      if (t) t.done = !newDone;
    } else {
      ut.overrides[id] = !newDone;
    }
    render();
  }
};

function updateCalendarCounts(dateStr) {
  const items = calendarItemsFor(dateStr);
  const doneCount = items.filter(i => i.done).length;
  const allDone = items.length > 0 && doneCount === items.length;
  const cnt = document.getElementById('cal-done-count');
  if (cnt) {
    cnt.textContent = `${doneCount}/${items.length} done`;
    cnt.className = `text-xs ${allDone ? 'text-green-400' : 'text-gray-500'}`;
  }
  const dayEl = document.querySelector('.cal-day[data-date="' + dateStr + '"]');
  if (dayEl) dayEl.classList.toggle('all-done', allDone);
}

window.openCalendarDetail = function(key) {
  state.calendarDetailId = key;
  state.calendarDetailEditing = false;
  state.calendarEventDetailId = null;
  state.todoFormOpen = false;
  state.openItemMenu = null;
  render();
};

window.closeCalendarDetail = function() {
  state.calendarDetailId = null;
  state.calendarDetailEditing = false;
  render();
};

window.setCalendarEditing = function(on) {
  state.calendarDetailEditing = !!on;
  render();
};

window.toggleItemMenu = function(key) {
  state.openItemMenu = state.openItemMenu === key ? null : key;
  render();
};

window.editCalendarItem = function(key) {
  state.calendarDetailId = key;
  state.calendarDetailEditing = true;
  state.openItemMenu = null;
  render();
};

window.deleteCalendarItem = async function(key) {
  const ok = await confirmAction({
    title: 'Delete this task?',
    message: 'This cannot be undone. The task will be removed from your calendar.',
    confirmText: 'Delete',
    danger: true,
  });
  if (!ok) return;
  const sep = key.indexOf(':');
  const src = key.slice(0, sep);
  const id = key.slice(sep + 1);
  const ut = getUserTodos();
  if (src === 'todo') {
    const idx = ut.todos.findIndex(t => t.id === id);
    if (idx >= 0) ut.todos.splice(idx, 1);
  } else {
    ut.hidden[id] = true;
  }
  if (state.calendarDetailId === key) { state.calendarDetailId = null; state.calendarDetailEditing = false; }
  state.openItemMenu = null;
  render();
  try {
    const endpoint = src === 'todo' ? '/api/todos/delete' : '/api/todos/state';
    const body = src === 'todo' ? { id } : { id, hidden: true };
    const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
  } catch (err) {}
};

window.saveCalendarEdit = async function(key) {
  const sep = key.indexOf(':');
  const src = key.slice(0, sep);
  const id = key.slice(sep + 1);
  const ut = getUserTodos();
  const title = (document.getElementById('cal-edit-title')?.value || '').trim();
  if (!title) return;
  const classEl = document.getElementById('cal-edit-class');
  const classId = classEl ? classEl.value : '';
  const description = document.getElementById('cal-edit-desc')?.value || '';
  const instructions = document.getElementById('cal-edit-instr')?.value || '';
  const link = document.getElementById('cal-edit-link')?.value || '';

  if (src === 'todo') {
    const t = ut.todos.find(t => t.id === id);
    if (t) Object.assign(t, { title, classId, className: todoClassName(classId), description, instructions, link });
  } else {
    ut.edits[id] = { title, description, instructions, link };
  }
  state.calendarDetailEditing = false;
  state.openItemMenu = null;
  render();
  try {
    const payload = src === 'todo'
      ? { type: 'todo', id, title, classId, className: todoClassName(classId), description, instructions, link }
      : { type: 'classroom', id, title, description, instructions, link };
    const res = await fetch('/api/todos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
  } catch (err) {}
};

window.openTodoForm = function() {
  state.todoFormOpen = true;
  state.todoForm = { title: '', classId: '', description: '', instructions: '', link: '' };
  state.calendarDetailId = null;
  state.calendarDetailEditing = false;
  state.calendarEventDetailId = null;
  state.openItemMenu = null;
  render();
};

window.closeTodoForm = function() {
  state.todoFormOpen = false;
  state.todoForm = {};
  render();
};

window.saveNewTodo = async function(dateStr) {
  const ut = getUserTodos();
  const title = (document.getElementById('todo-form-title')?.value || '').trim();
  if (!title) return;
  const classId = document.getElementById('todo-form-class')?.value || '';
  const description = document.getElementById('todo-form-desc')?.value || '';
  const instructions = document.getElementById('todo-form-instr')?.value || '';
  const link = document.getElementById('todo-form-link')?.value || '';
  const id = 't_' + Math.random().toString(36).slice(2, 10);
  const rec = { id, date: dateStr, title, classId, className: todoClassName(classId), description, instructions, link, done: false };
  ut.todos.push(rec);
  state.todoFormOpen = false;
  state.todoForm = {};
  render();
  try {
    const res = await fetch('/api/todos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'todo', id, date: dateStr, title, classId, className: todoClassName(classId), description, instructions, link, done: false }) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
  } catch (err) {}
};

if (typeof _calMenuDocBound === 'undefined') {
  window._calMenuDocBound = true;
  document.addEventListener('click', (e) => {
    if (state.openItemMenu && !e.target.closest('.cal-menu') && !e.target.closest('.cal-more')) {
      state.openItemMenu = null;
      render();
    }
    if (state.noteQuizMenuOpen && !e.target.closest('[data-nq-menu]')) {
      state.noteQuizMenuOpen = null;
      if (typeof renderReviewGrid === 'function' && state.blooketClasses) {
        renderReviewGrid(state.blooketClasses, state.blooketCustomSets);
      }
    }
  });
}

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
  <script>
    if (typeof _nqRefreshTodayList === 'function') {
      _nqRefreshTodayList();
    }
  </script>
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
    const color = classColorFor(c.id);
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
    const color = avg == null ? '#2b2b38' : avg >= goal + GOAL_BUFFER ? '#22c55e' : avg >= goal ? '#eab308' : (goal - avg) <= 5 ? '#f97316' : '#ef4444';
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
  const status = agg.avg >= goal + GOAL_BUFFER ? '<span class="text-green-400">above goal</span>' : agg.avg >= goal ? '<span class="text-yellow-400">at goal — within 1pt buffer</span>' : `<span class="text-orange-400">${Math.round((goal - agg.avg) * 10) / 10}pts below</span>`;
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
      const color = classColorFor(classId);
      items.sort((a, b) => a.gap - b.gap);
      return { classId, cls, color, items };
    }).sort((x, y) => x.items[0].gap - y.items[0].gap);

    // Per-goal color so per-class goal overrides show correctly
    const goalColor = (score, goal) => {
      if (score == null || isNaN(score)) return '#6c6c7c';
      const g = goal != null && !isNaN(goal) ? goal : 90;
      if (score >= g + 1) return '#22c55e';
      if (score >= g)     return '#eab308';
      if (score >= 70)    return '#f97316';
      return '#ef4444';
    };
    const groupLetter = g => escapeHtml((g.cls?.shortName || g.cls?.name || g.items[0].className || '?').trim().charAt(0).toUpperCase());

    const row = a => {
      const color = goalColor(a.currentGrade, a.goal);
      return `
      <div class="flex items-center justify-between gap-3 px-3 py-2 hover:bg-[#12121b]/30 transition-colors cursor-pointer" onclick="navigateToAlert('${a.classId}', ${a.categoryName ? `'${escapeHtml(a.categoryName)}'` : 'null'})">
        <div class="flex items-center gap-2.5 min-w-0">
          <span class="w-6 h-6 rounded-md bg-orange-500/10 flex items-center justify-center flex-shrink-0">${icon('alert','w-3 h-3 text-orange-400')}</span>
          <div class="min-w-0">
            <div class="text-sm font-semibold text-gray-100 truncate">${escapeHtml(a.categoryName)}</div>
          </div>
        </div>
        <div class="flex items-center gap-2 flex-shrink-0">
          <div class="text-lg font-bold tabular-nums" style="color:${color}">${a.currentGrade != null ? Math.round(a.currentGrade) + '%' : '—'}</div>
          <div class="text-[10px] text-gray-600 uppercase tracking-wider">goal ${Math.round(a.goal)}</div>
        </div>
      </div>`;
    };

    const card = g => {
      const cls = g.cls;
      const overallItem = g.items.find(a => !a.categoryName);
      const categoryItems = g.items.filter(a => !!a.categoryName);
      const headerGrade = overallItem ? overallItem.currentGrade : cls?.weightedGrade;
      const headerGoal  = overallItem ? overallItem.goal : goalFor(cls);
      const headerColor = goalColor(headerGrade, headerGoal);
      const sub = categoryItems.length === 0
        ? (overallItem ? 'Overall grade below goal' : 'Below goal')
        : `${categoryItems.length} ${categoryItems.length === 1 ? 'category' : 'categories'} below goal`;
      return `<div class="bg-[#0a0a0f] border border-[#22222e] rounded-xl overflow-hidden">
        <div class="flex items-center justify-between gap-3 px-3 py-2.5 ${categoryItems.length > 0 ? 'border-b border-[#22222e]' : ''}">
          <div class="flex items-center gap-2.5 min-w-0">
            <span class="w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold flex-shrink-0" style="background:${g.color}20; color:${g.color}">${groupLetter(g)}</span>
            <div class="min-w-0">
              <div class="text-sm font-semibold text-gray-100 truncate">${escapeHtml(g.cls?.shortName || g.items[0].className)}</div>
              <div class="text-[11px] text-gray-500">${sub}</div>
            </div>
          </div>
          <div class="flex items-baseline gap-2 flex-shrink-0">
            <div class="text-xl font-bold tabular-nums" style="color:${headerColor}">${headerGrade != null ? Math.round(headerGrade) + '%' : '—'}</div>
            <div class="text-[10px] text-gray-600 uppercase tracking-wider">goal ${Math.round(headerGoal)}</div>
          </div>
        </div>
        ${categoryItems.length > 0 ? `<div class="divide-y divide-[#22222e]/60">${categoryItems.map(row).join('')}</div>` : ''}
      </div>`;
    };

    watchlistHtml = `<div class="bg-[#12121b] border border-orange-500/20 rounded-2xl p-5">
      <div class="flex items-center gap-2 mb-4">
        ${icon('alert', 'w-5 h-5 text-orange-400')}
        <h3 class="text-sm font-medium text-gray-300">Watchlist — Items Below Goal</h3>
        <span class="text-xs text-orange-400">${w.length} ${w.length === 1 ? 'item' : 'items'} · ${groups.length} ${groups.length === 1 ? 'class' : 'classes'}</span>
      </div>
      <div class="space-y-3">
        ${groups.map(g => card(g)).join('')}
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
  <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-5 mt-4 mb-6">
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
      <div class="relative w-full max-w-[200px] aspect-square mb-3">
        <svg width="100%" height="100%" viewBox="0 0 112 112" preserveAspectRatio="xMidYMid meet">
          <circle cx="56" cy="56" r="48" fill="none" stroke="var(--panel-border)" stroke-width="8"/>
          <circle cx="56" cy="56" r="48" fill="none" stroke="${achieved === total ? '#22c55e' : atRisk > 0 ? '#f97316' : '#3b82f6'}" stroke-width="8"
            stroke-dasharray="${(achieved / total) * 301.6}" stroke-dashoffset="0" stroke-linecap="round" transform="rotate(-90 56 56)"/>
        </svg>
        <div class="absolute inset-0 flex flex-col items-center justify-center">
          <div class="text-2xl font-bold" style="color:var(--text)">${Math.round((achieved / total) * 100)}%</div>
          <div class="text-xs" style="color:var(--muted)">achieved</div>
        </div>
      </div>
      <div class="text-xs" style="color:var(--muted)">${achieved}/${total} classes at ${goal}%</div>
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
          const gs = goalStatus(g, cg);
          const below = gs === 'below';
          const gap = g != null ? Math.round((g - cg) * 10) / 10 : null;
          const dotColor = below ? 'bg-orange-500' : gs === 'close' ? 'bg-yellow-400' : gs === 'above' ? 'bg-green-500' : 'bg-gray-600';
          return `
          <div class="flex items-center gap-3 px-2 py-1.5 rounded-lg ${below ? 'bg-orange-500/5' : ''}">
            <div class="w-2.5 h-2.5 rounded-full flex-shrink-0 ${dotColor}"></div>
            <div class="w-32 text-sm text-gray-300 truncate flex-shrink-0">${c.shortName || c.name}</div>
            <div class="flex-1 h-2 bg-[#1c1c26] rounded-full overflow-hidden">
              <div class="h-full rounded-full transition-all" style="width:${Math.min(g || 0, 100)}%; background:${goalColor(g, cg)}"></div>
            </div>
            <div class="w-12 text-right text-sm font-bold" style="color:${goalColor(g, cg)}">${g != null ? g + '%' : 'N/A'}</div>
            <div class="w-16 text-right text-xs ${gs === 'below' ? 'text-orange-400' : gs === 'close' ? 'text-yellow-400' : gs === 'above' ? 'text-green-400' : 'text-gray-500'}">${gap != null ? (gap >= 0 ? '+'+gap : gap) : '-'}</div>
          </div>`;
        }).join('')}
      </div>
    </div>
  </div>

  <!-- Watchlist items (grouped by class) — surfaces the most urgent items first -->
  ${watchlistHtml}

  <!-- Category averages (across classes) -->
  ${catChartHtml}

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
              const gs = goalStatus(r.grade, goal);
              return `
              <div class="flex items-center gap-2 text-xs">
                <span class="w-1.5 h-1.5 rounded-full flex-shrink-0" style="background:${goalColor(r.grade, goal)}"></span>
                <span class="text-gray-300 truncate flex-1">${escapeHtml(r.name)}</span>
                <span class="font-bold" style="color:${goalColor(r.grade, goal)}">${r.grade}%</span>
                <span class="w-14 text-right ${gs === 'above' ? 'text-green-400' : gs === 'close' ? 'text-yellow-400' : 'text-orange-400'}">${gs === 'above' ? 'hit' : gs === 'close' ? 'close' : 'miss'}</span>
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

  // Build the deterministic per-class recommendation from gradeMath so every
  // class has a calculator-ready card even before the AI runs.
  const recommendationFor = cls => {
    const gm = cls.gradeMath;
    const overall = gm && gm.overall;
    const catGoal = (gm && gm.goal) || goalFor(cls);
    if (overall == null) {
      return { kind: 'no-data', title: 'No grades yet', body: 'Add a grade to start seeing recommendations.' };
    }
    if (overall >= catGoal) {
      const above = overall - catGoal;
      return above >= 1
        ? { kind: 'above-goal', title: 'Above goal', body: `Your overall average is ${overall}%, exceeding your goal of ${catGoal}%.` }
        : { kind: 'goal-met',   title: 'Goal met',   body: `Your overall average is ${overall}%, meeting your goal of ${catGoal}%.` };
    }
    // Below goal — pick the category with the highest impactPerOverallPoint
    const cats = (gm.categories || []).filter(c => c.average != null && c.categoryAverageNeededForGoal != null)
      .sort((a, b) => (b.impactPerOverallPoint || 0) - (a.impactPerOverallPoint || 0));
    const best = cats[0];
    if (!best) {
      return { kind: 'below-goal', title: 'Below goal', body: `Your overall average is ${overall}%. Add grades to individual categories to see what to aim for.` };
    }
    const needed = best.categoryAverageNeededForGoal;
    const catAvg = best.average;
    if (needed > 100) {
      return {
        kind: 'hard-to-reach',
        title: `${best.name} average needed`,
        body: `${best.name} must average ${Math.round(needed)}% for you to reach ${catGoal}% overall — even all 100%s on ${best.name.toLowerCase()} alone won't bridge the gap on this category.`,
        floor: Math.round(needed),
        categoryName: best.name,
      };
    }
    // Count how many 100%s on this category it would take to bring the category
    // average to `needed` (at which point overall == goal by definition).
    // k >= (needed - catAvg) * gradedCount / (100 - needed)  → ceil
    const n = best.gradedCount || 0;
    let count = 0;
    if (n > 0 && needed < 100) {
      count = Math.ceil(((needed - catAvg) * n) / (100 - needed));
      if (count < 0) count = 0; // category already at/above the target
    }
    if (count === 0 && n > 0) {
      return {
        kind: 'below-goal',
        title: `${best.name} on track`,
        body: `${best.name} is already averaging ${Math.round(catAvg)}% (target needed: ${Math.round(needed)}%). The gap is on another category — focus there to reach ${catGoal}% overall.`,
        target: Math.round(needed),
        categoryName: best.name,
        currentAvg: Math.round(catAvg),
      };
    }
    if (n === 0) {
      return {
        kind: 'below-goal',
        title: `${best.name} average needed`,
        body: `${best.name} must average ${Math.round(needed)}% for you to reach ${catGoal}% overall. Aim for ${Math.round(needed)}% on every ${best.name.toLowerCase()} going forward.`,
        target: Math.round(needed),
        categoryName: best.name,
        assignments: 0,
      };
    }
    const body = `You need ${count} more 100%${count === 1 ? '' : 's'} on ${best.name} to bring its average to ${Math.round(needed)}% (currently ${Math.round(catAvg)}%) and reach ${catGoal}% overall. Currently ${Math.round(overall)}% overall.`;
    return {
      kind: 'below-goal',
      title: `${best.name} average needed`,
      body,
      target: Math.round(needed),
      count,
      categoryName: best.name,
      currentAvg: Math.round(catAvg),
      assignments: n,
      overall: Math.round(overall),
    };
  };

  // For the right-rail "Watchlist" stat, use the deterministic count too.
  const autoWatchlist = classes.filter(c => {
    const overall = c.gradeMath?.overall;
    return overall != null && overall < goalFor(c);
  }).length;

  return `
  <div class="flex items-center justify-between mb-6">
    <div>
      <h1 class="text-2xl font-bold text-white">Insights</h1>
      <p class="text-gray-400 mt-1 text-sm">Calculator-grade math per class — refreshes whenever grade data changes${ai.status === 'current' && ai.generatedAt ? ` · AI extras generated ${timeSince(ai.generatedAt)}` : ''}.</p>
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
          <div class="text-xs text-gray-500">Assignments Graded</div>
          <div class="text-xl font-bold mt-1 text-white">${graded.length}</div>
        </div>
        <div class="bg-[#12121b] border border-[#22222e] rounded-2xl p-4">
          <div class="text-xs text-gray-500">Watchlist</div>
          <div class="text-xl font-bold mt-1 ${autoWatchlist > 0 ? 'text-orange-400' : 'text-green-400'}">${autoWatchlist}</div>
        </div>
      </div>

      <div class="space-y-4">
        ${classes.map(c => {
          const ci = classes.indexOf(c);
          const color = classColorFor(c.id);
          const ins = aiByClass[String(c.id)] || [];
          const grade = periodGrade(c, defaultPeriod());
          const letter = grade != null ? letterGrade(grade) : '';
          const rec = recommendationFor(c);
          // AI is the primary recommendation source. If the model hasn't
          // produced one for this class, fall back to the deterministic
          // grade-math card (which uses the same numbers verbatim).
          const primary = ins[0];
          const extras = ins.slice(1, 5);
          const cm = { green:'bg-green-500/10 text-green-400',blue:'bg-blue-500/10 text-blue-400',orange:'bg-orange-500/10 text-orange-400',red:'bg-red-500/10 text-red-400',yellow:'bg-yellow-500/10 text-yellow-400',purple:'bg-purple-500/10 text-purple-400' };

          let primaryCard;
          if (primary) {
            const cc = cm[primary.color] || cm.blue;
            primaryCard = `
              <div class="flex items-start gap-3 p-3 bg-[#0a0a0f] border border-[#22222e] rounded-xl">
                <div class="w-8 h-8 rounded-lg ${cc} flex items-center justify-center flex-shrink-0">${icon(primary.icon, 'w-4 h-4')}</div>
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 flex-wrap">
                    <div class="text-sm font-medium text-gray-200">${escapeHtml(primary.title)}</div>
                    <span class="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-300 border border-blue-500/20">AI · from grade math</span>
                  </div>
                  <div class="text-xs text-gray-400 mt-0.5">${escapeHtml(primary.body)}</div>
                  ${(primary.nextGradeTarget || primary.estimatedAssignments) ? `<div class="flex flex-wrap gap-2 mt-2 text-[10px]"><span class="px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-300">${escapeHtml(primary.nextGradeTarget || 'Target score unavailable')}</span>${primary.estimatedAssignments ? `<span class="px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-300">${escapeHtml(primary.estimatedAssignments)}</span>` : ''}</div>` : ''}
                </div>
              </div>`;
          } else {
            // Fallback: deterministic card from recommendationFor() until AI runs.
            const recBadgeClass = {
              'above-goal':'bg-green-500/15 text-green-300 border-green-500/30',
              'goal-met'  :'bg-green-500/15 text-green-300 border-green-500/30',
              'no-data'   :'bg-gray-500/15 text-gray-300 border-gray-500/30',
              'hard-to-reach':'bg-red-500/15 text-red-300 border-red-500/30',
            }[rec.kind] || 'bg-orange-500/15 text-orange-300 border-orange-500/30';
            primaryCard = `
              <div class="flex items-start gap-3 p-3 bg-[#0a0a0f] border border-[#22222e] rounded-xl">
                <div class="w-8 h-8 rounded-lg ${recBadgeClass} flex items-center justify-center flex-shrink-0 border">${icon(rec.kind === 'above-goal' || rec.kind === 'goal-met' ? 'check' : rec.kind === 'no-data' ? '?' : 'alert', 'w-4 h-4')}</div>
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 flex-wrap">
                    <div class="text-sm font-medium text-gray-200">${escapeHtml(rec.title)}</div>
                    <span class="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-300 border border-blue-500/20">from grade math</span>
                  </div>
                  <div class="text-xs text-gray-400 mt-0.5">${escapeHtml(rec.body)}</div>
                </div>
              </div>`;
          }

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
                  <div class="text-xs text-gray-500">${c.categories?.length || 0} categories${ins.length ? ' · ' + ins.length + ' insights' : (ai.status && ai.status !== 'current' ? ' · awaiting AI' : '')}</div>
                </div>
              </div>
              <div class="text-right">
                <div class="text-xl font-bold" style="color:${gradeColor(grade)}">${grade != null ? grade + '%' : 'N/A'}</div>
                <div class="text-xs text-gray-500">${letter}${grade != null && grade < goalFor(c) ? ` · <span class="text-orange-400">${Math.round(goalFor(c) - grade)} below goal</span>` : ''}</div>
              </div>
            </div>
            <div class="space-y-2">
              ${primaryCard}
              ${extras.map(i => `
                <div class="flex items-start gap-3 p-3 bg-[#0a0a0f] border border-[#22222e] rounded-xl">
                  <div class="w-8 h-8 rounded-lg ${cm[i.color] || cm.blue} flex items-center justify-center flex-shrink-0">${icon(i.icon, 'w-4 h-4')}</div>
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                      <div class="text-sm font-medium text-gray-200">${escapeHtml(i.title)}</div>
                      <span class="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-300 border border-blue-500/20">AI</span>
                    </div>
                    <div class="text-xs text-gray-400 mt-0.5">${escapeHtml(i.body)}</div>
                  </div>
                </div>`).join('')}
              ${ins.length > 5 ? `<div class="text-xs text-gray-600 pl-11">+${ins.length - 5} more recommendations</div>` : ''}
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
  const chatCount = (state.aiChat || []).length;
  return `
    <aside class="coach-card bg-[#12121b] border border-[#22222e] rounded-2xl flex flex-col overflow-hidden xl:sticky xl:top-6 ai-card-resize">
      <div class="coach-head px-5 pt-5 pb-3 flex items-start justify-between gap-3">
        <div>
          <h3 class="text-sm font-semibold text-gray-200">Ask your grade coach</h3>
          <p class="text-xs text-gray-500 mt-1">Open-ended questions stay in context while the coach uses live grade data.</p>
        </div>
        <div class="flex items-center gap-1.5 flex-shrink-0">
          ${chatCount > 0 ? `<button onclick="clearCoachConversation()" title="Clear conversation" class="coach-clear text-[10px] uppercase tracking-wider text-gray-500 hover:text-gray-300 px-2 py-1 rounded-md hover:bg-[#22222e] transition-colors">Clear</button>` : ''}
          <span class="text-[10px] uppercase tracking-wider text-gray-600">Ollama Cloud</span>
        </div>
      </div>
      <div id="ai-chat-log" class="coach-log flex-1 px-5 py-2 space-y-3 overflow-y-auto min-h-0">
        ${renderAiChatLog()}
      </div>
      <div class="coach-input p-4 pt-3 border-t border-[#22222e]">
        <div class="flex items-end gap-2">
          <textarea id="ai-question-input" rows="1" placeholder="Ask about a class or how to reach a goal…"
            oninput="state.aiDraft=this.value; autoGrowInput(this)" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault(); askAIQuestion();}"
            class="coach-input-field flex-1 resize-none px-4 py-2.5 bg-[#0a0a0f] border border-[#22222e] rounded-xl text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500/50 focus:ring-2 focus:ring-blue-500/15 transition-all leading-relaxed max-h-32">${escapeHtml(state.aiDraft)}</textarea>
          <button onclick="askAIQuestion()" ${state.aiAskLoading ? 'disabled' : ''} title="Send" class="coach-send flex-shrink-0 w-11 h-11 rounded-xl bg-blue-500/20 border border-blue-500/30 text-blue-400 hover:bg-blue-500/30 hover:scale-105 active:scale-95 disabled:opacity-50 disabled:hover:scale-100 flex items-center justify-center transition-all ${state.aiAskLoading ? 'cursor-wait' : ''}">
            ${state.aiAskLoading ? '<span class="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin"></span>' : icon('send','w-4 h-4')}
          </button>
        </div>
      </div>
    </aside>
  `;
}

function autoGrowInput(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 128) + 'px';
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

function patchAiBubble(text) {
  const log = document.getElementById('ai-chat-log');
  if (!log) return;
  const bubbles = log.querySelectorAll('.ai-md');
  const b = bubbles[bubbles.length - 1];
  if (!b) return;
  b.innerHTML = renderMarkdown(text) + '<span class="ai-stream-cursor"></span>';
  log.scrollTop = log.scrollHeight;
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
  saveCoachLocal();
  render();
  try {
    const res = await fetch('/api/insights/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question, conversation: state.aiConversation, stream: true }) });
    if (!res.ok) {
      let detail = 'Request failed';
      try { detail = (await res.json()).detail || detail; } catch (e) {}
      throw new Error(detail);
    }
    const last = state.aiChat[state.aiChat.length - 1];
    let acc = '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const flush = () => {
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
        for (const line of raw.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          let evt;
          try { evt = JSON.parse(line.slice(6)); } catch (e) { continue; }
          if (evt.type === 'delta') {
            acc += evt.content || '';
            if (last) { last.loading = false; last.content = acc; }
            patchAiBubble(acc);
          } else if (evt.type === 'done') {
            if (last) { last.loading = false; last.content = acc || last.content || 'No answer received.'; last.created = evt.created || []; }
            if (Array.isArray(evt.conversation)) state.aiConversation = evt.conversation;
          } else if (evt.type === 'error') {
            throw new Error(evt.message);
          }
        }
      }
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      flush();
    }
    const insightsRes = await fetch('/api/insights');
    if (insightsRes.ok) state.aiInsights = await insightsRes.json();
  } catch (err) {
    state.aiConversation = conversationSnapshot;
    const last = state.aiChat[state.aiChat.length - 1];
    if (last && last.loading) { last.loading = false; last.content = '⚠️ ' + (err.message || 'Failed to ask'); }
  } finally {
  state.aiAskLoading = false;
  saveCoachLocal();
  render();
  requestAnimationFrame(() => {
    const el = document.getElementById('ai-question-input');
    if (el && state.currentView === 'insights') el.focus();
  });
  }
};

const COACH_STORE = 'gradetrack-coach-v1';

function saveCoachLocal() {
  try {
    const chat = (state.aiChat || []).filter(m => !m.loading);
    localStorage.setItem(COACH_STORE, JSON.stringify({ chat, conversation: state.aiConversation }));
  } catch (err) {}
}

function loadCoachLocal() {
  try {
    const raw = localStorage.getItem(COACH_STORE);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (Array.isArray(d.chat)) state.aiChat = d.chat;
    if (Array.isArray(d.conversation)) state.aiConversation = d.conversation;
  } catch (err) {}
}

window.clearCoachConversation = function() {
  state.aiChat = [];
  state.aiConversation = [];
  try { localStorage.removeItem(COACH_STORE); } catch (err) {}
  render();
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
  state.settingsView = 'home';
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
    if (!state.trilium.cache) state.trilium.cache = {};
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
          ${icon('trilium','w-3.5 h-3.5')}
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
      if (done) {
        await refreshData();
        showToast('Classes refreshed!', 'success');
        if (state.notifications?.scrapeDone !== false) browserNotify('Grades refreshed', { body: 'Your classes are up to date.' });
      } else {
        showToast('Scrape finished with errors — check the log', 'error');
        if (state.notifications?.scrapeDone !== false) browserNotify('Grades refresh failed', { body: 'The scrape finished with errors. Check the log in Data & Refresh.' });
      }
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
function renderRecreatePopup() {
  return `
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onclick="if(event.target===this) window._closeRecreatePopup()">
    <div class="bg-[#16161f] border border-[#22222e] rounded-2xl p-6 w-full max-w-md shadow-2xl">
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-base font-semibold text-gray-100">Recreate Quiz</h3>
        <button onclick="window._closeRecreatePopup()" class="p-1.5 rounded-lg text-gray-500 hover:text-gray-300 hover:bg-[#22222e] transition-colors">${icon('x','w-4 h-4')}</button>
      </div>
      <p class="text-sm text-gray-400 mb-4">The new quiz will be generated from the same notes using the same method. Optionally add clarification for the AI about what to focus on differently.</p>
      <textarea id="recreate-clarification" rows="3" class="w-full bg-[#0a0a0f] border border-[#22222e] rounded-xl px-3 py-2 text-sm text-gray-200 placeholder-gray-500 resize-none focus:border-blue-500/50 focus:outline-none transition-colors" placeholder="e.g. Focus more on vocabulary, skip questions about dates, make harder questions...">${escapeHtml(state._recreateClarification || '')}</textarea>
      <div class="flex items-center gap-2 mt-4">
        <button onclick="window._submitRecreate()" class="flex-1 px-3 py-2 rounded-xl bg-blue-500/20 border border-blue-500/30 text-sm text-blue-400 hover:bg-blue-500/30 transition-all">Recreate</button>
        <button onclick="window._closeRecreatePopup()" class="px-3 py-2 rounded-xl text-sm text-gray-400 hover:text-gray-200 bg-[#0a0a0f] border border-[#22222e] transition-colors">Cancel</button>
      </div>
    </div>
  </div>`;
}

async function render(options = {}) {
  if (_quizCtx) return; // keep an active quiz on screen (auto-refresh must not wipe it)
  if (window._nqActive) return; // keep an in-view note quiz on screen (auto-refresh must not wipe it)
  if (state.currentSetUrl && state.currentView === 'planner') {
    renderSetDetailView();
    return;
  }
  const container = document.getElementById('view-container');
  if (!container) return;
  const scrollState = options.preserveScroll === false ? null : captureScrollState();
  closeDayTip();
  if (typeof updateSidebarUserInfo === 'function') updateSidebarUserInfo();

  if (state.error && !state.renderedOnce) {
    container.innerHTML = `<div class="flex flex-col items-center justify-center h-64">
      <div class="text-4xl mb-4">⚠️</div><div class="text-gray-400 text-lg mb-2">${state.error}</div>
      <button onclick="init()" class="px-4 py-2 bg-blue-500/20 border border-blue-500/30 rounded-xl text-sm text-blue-400">Retry</button>
    </div>`; return;
  }

  const views = { overview: renderOverview, assignments: renderAssignments, analytics: renderAnalytics, calendar: renderCalendar, planner: renderPlanner, goals: renderGoals, insights: renderInsights, settings: renderSettings };
  const analyticsNav = ANALYTICS_VIEWS.includes(state.currentView) ? `<nav class="analytics-view-nav" aria-label="Analytics navigation">
    ${[['analytics', 'Reports'], ['insights', 'Insights'], ['goals', 'Goals']].map(([view, label]) => `<button type="button" class="${state.currentView === view ? 'active' : ''}" onclick="navigate('${view}')">${label}</button>`).join('')}
  </nav>` : '';
  const animate = state.renderedView === state.currentView ? '' : 'fade-in';

  // Note-quiz calendar mode replaces the standard calendar entirely.
  const popupHtml = state._recreatePopupOpen ? renderRecreatePopup() : '';
  if (state.currentView === 'calendar' && state.calendarMode === 'notequiz' && typeof _renderNoteQuizCalendar === 'function') {
    const calHtml = await _renderNoteQuizCalendar();
    container.innerHTML = `<div class="${animate}">${analyticsNav}${calHtml}</div>${popupHtml}`;
    state.renderedOnce = true;
    state.renderedView = state.currentView;
    triliumHydrate();
  } else {
    const fn = views[state.currentView] || renderOverview;
    const mainHtml = fn();
    container.innerHTML = `<div class="${animate}">${analyticsNav}${mainHtml}</div>${popupHtml}`;
    state.renderedOnce = true;
    state.renderedView = state.currentView;
    triliumHydrate();
  }
  if (state.currentView === 'settings') { checkTriliumStatus(); loadCurrentCredentials(); }
  if (state.currentView === 'planner') {
    if (typeof renderReviewGridIfLoaded === 'function') renderReviewGridIfLoaded();
    else loadBlooketClasses(!state.blooketLoaded);
  }
  if (state.currentView === 'overview' && typeof _nqRenderOverviewWidget === 'function') {
    _nqRenderOverviewWidget();
  }
  if (state.currentView === 'calendar') {
    // Multi-day bars are positioned via CSS in week-row wrappers
  }

  // Update sidebar
  document.querySelectorAll('.nav-link').forEach(l => {
    const isActive = l.getAttribute('data-view') === state.currentView || (l.getAttribute('data-view') === 'analytics' && ANALYTICS_VIEWS.includes(state.currentView));
    l.classList.toggle('active', isActive);
    // Paint the active Assignments nav button with the current class color so it
    // matches the sticky-header gradient in the assignments view.
    if (isActive && l.id === 'assignments-toggle' && state.currentView === 'assignments') {
      const clsId = state.assignmentsClassId;
      if (clsId) {
        const c = classColorFor(clsId);
        l.style.setProperty('--nav-active-bg', `linear-gradient(90deg, ${c}33 0%, ${c}1a 65%, transparent)`);
        l.style.setProperty('--nav-active-color', c);
        l.style.setProperty('--nav-active-border', `${c}30`);
      }
    } else if (l.id === 'assignments-toggle') {
      l.style.removeProperty('--nav-active-bg');
      l.style.removeProperty('--nav-active-color');
      l.style.removeProperty('--nav-active-border');
    }
  });
  document.querySelectorAll('#analytics-submenu [data-view]').forEach(l => l.classList.toggle('active', l.getAttribute('data-view') === state.currentView));

  restoreScrollState(scrollState);
  updateStickyHeaders();
}

function navigate(view) {
  if (_quizCtx) teardownQuiz();
  if (window._nqActive) {
    window._nqActive = false;
    state.noteQuizReturnView = null;
  }
  if (!VIEWS.includes(view)) view = 'overview';
  state.currentView = view;
  window.location.hash = view;
  render({ preserveScroll: false });
}

// ─── UPDATE CHECK ───────────────────────────────────────────────
// Sidebar badge: a small pulsing dot on the settings cog when a newer
// version is on origin/main. The actual install happens through the
// dashboard's Settings → Updates panel — never auto-restarts. Update
// state lives in state._update so the sidebar re-renders whenever the
// value flips.

state._update = { installed: '', available: '', behind: 0, available: false, checkedAt: 0 };

async function checkForUpdate(force) {
  try {
    const url = '/api/update/check' + (force ? '?_=' + Date.now() : '');
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json();
    state._update = {
      installed: data.installed || '',
      available: data.available || '',
      behind: Number(data.behind || 0),
      available: !!data.available,
      checkedAt: Date.now(),
    };
    _renderUpdateBadge();
  } catch (err) {
    // Network blip; leave the badge alone.
  }
}

function _renderUpdateBadge() {
  const badge = document.getElementById('sidebar-update-badge');
  if (!badge) return;
  badge.classList.toggle('hidden', !state._update.available);
  if (state._update.available) {
    badge.title = `Update available: ${state._update.available} (installed ${state._update.installed})`;
  }
}

async function runAppUpdate() {
  showToast('Updating… don\'t close this tab.', 'info', 8000);
  try {
    const res = await fetch('/api/update/run', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast(data.detail || `Update failed (HTTP ${res.status})`, 'error', 12000);
      return false;
    }
    if (!data.ok) {
      showToast(`Update failed: ${(data.stderr || '').slice(-200) || 'unknown'}`, 'error', 12000);
      return false;
    }
    showToast('Update applied. Reloading…', 'success', 5000);
    setTimeout(() => location.reload(), 1200);
    return true;
  } catch (err) {
    showToast('Update error: ' + (err && err.message ? err.message : 'network'), 'error', 12000);
    return false;
  }
}

// Poll every hour; on visibility change (tab becomes visible), refresh too.
setInterval(() => checkForUpdate(true), 60 * 60 * 1000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) checkForUpdate(true);
});


// ─── INIT ────────────────────────────────────────────────────────
async function init() {
  try { applyTheme(localStorage.getItem('gradetrack-theme') || 'dark'); } catch (err) {}
  try { setSidebarCollapsed(localStorage.getItem('gradetrack-sidebar-collapsed') === '1'); } catch (err) {}
  loadCoachLocal();

  // Real routing: resolve the requested view up front so the page renders
  // straight up instead of showing the dashboard first, then switching.
  const hash = window.location.hash.slice(1);
  if (hash && VIEWS.includes(hash)) state.currentView = hash;

  render({ preserveScroll: false });
  await fetchComputed();

  render({ preserveScroll: false });

  // Preload quiz sets in the background so the Review view is instant when
  // the user navigates there (avoids a visible skeleton + slow network fetch).
  if (typeof loadBlooketClasses === 'function' && !state.blooketLoaded) {
    loadBlooketClasses(false);
  }

  // Preload levels-based review progress from the backend so set cards show
  // the correct level ring immediately and writes can flush to the server.
  if (typeof preloadLevelsState === 'function') {
    preloadLevelsState();
  }

  // Initial update-check (non-blocking). The background polling below keeps
  // the sidebar badge in sync once per hour.
  if (typeof checkForUpdate === 'function') checkForUpdate();

  window.addEventListener('hashchange', () => {
    const h = window.location.hash.slice(1);
    if (!VIEWS.includes(h)) return;
    if (state.currentView === h && state.renderedView === h) return;
    navigate(h);
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
      if (v === 'analytics') {
        if (isSidebarCollapsed()) {
          openSidebarFlyout('analytics', link);
          return;
        }
        toggleAnalyticsSubmenu();
      }
      navigate(v);
      document.querySelector('.sidebar')?.classList.remove('open');
      document.getElementById('sidebar-overlay')?.classList.remove('open');
    });
  });

  document.querySelectorAll('#analytics-submenu [data-view]').forEach(link => {
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

  // Sticky header stuck-state (divider fade)
  window.addEventListener('scroll', updateStickyHeaders, { passive: true });

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

  // Welcome toast removed: the dashboard should not toast on load.
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
