/* ================================================================
   GradeTrack v2 — Server-Side Compute Bridge (CommonJS)
   Mirrors compute.js & data-engine.js for Node.js server
   ================================================================ */

const GRADE_SCALE = [
  { min: 93, letter: 'A', gpa: 4.0 },
  { min: 90, letter: 'A-', gpa: 3.7 },
  { min: 87, letter: 'B+', gpa: 3.3 },
  { min: 83, letter: 'B', gpa: 3.0 },
  { min: 80, letter: 'B-', gpa: 2.7 },
  { min: 77, letter: 'C+', gpa: 2.3 },
  { min: 73, letter: 'C', gpa: 2.0 },
  { min: 70, letter: 'C-', gpa: 1.7 },
  { min: 67, letter: 'D+', gpa: 1.3 },
  { min: 60, letter: 'D', gpa: 1.0 },
  { min: 0, letter: 'F', gpa: 0.0 }
];

function computeLetterGrade(score) {
  if (score == null || isNaN(score)) return 'N/A';
  for (const t of GRADE_SCALE) { if (score >= t.min) return t.letter; }
  return 'F';
}

function computeGPA(score) {
  if (score == null || isNaN(score)) return 0;
  for (const t of GRADE_SCALE) { if (score >= t.min) return t.gpa; }
  return 0;
}

function computeWeightedGrade(categories) {
  if (!categories || categories.length === 0) return { grade: null, letter: 'N/A', categoryGrades: [] };
  let totalWeight = 0, weightedSum = 0;
  const categoryGrades = [];
  for (const cat of categories) {
    const weight = parseFloat(cat.weight) || 0;
    const avg = cat.average != null ? parseFloat(cat.average) : null;
    categoryGrades.push({ name: cat.name, weight, average: avg, assignments: cat.assignments || [] });
    if (avg != null && !isNaN(avg) && weight > 0) {
      weightedSum += avg * (weight / 100);
      totalWeight += weight / 100;
    }
  }
  const grade = totalWeight > 0 ? weightedSum / totalWeight : null;
  return {
    grade: grade != null ? Math.round(grade * 10) / 10 : null,
    letter: computeLetterGrade(grade),
    categoryGrades
  };
}

const PERIODS = { q1: [1], q2: [2], q3: [3], q4: [4], s1: [1, 2], s2: [3, 4], year: [1, 2, 3, 4] };

function termFilterFor(terms) {
  return (term) => term == null || terms.includes(term);
}

function computeRunningAverage(categories, termFilter) {
  if (!categories || categories.length === 0) return [];
  const allAssignments = [];
  for (const cat of categories) {
    const weight = parseFloat(cat.weight) || 0;
    for (const a of (cat.assignments || [])) {
      if (a.status === 'Excuse' || a.status === 'Exempt') continue;
      if (termFilter && !termFilter(a.term)) continue;
      const pts = parseFloat(a.pts);
      const max = parseFloat(a.max);
      if (isNaN(pts) || isNaN(max) || max === 0) continue;
      allAssignments.push({ date: a.dueDate || a.dueRaw || '', pts, max, category: cat.name, weight });
    }
  }
  if (allAssignments.length === 0) return [];
  allAssignments.sort((a, b) => a.date.localeCompare(b.date));
  const dateMap = new Map();
  for (const a of allAssignments) {
    if (!dateMap.has(a.date)) dateMap.set(a.date, []);
    dateMap.get(a.date).push(a);
  }
  const uniqueDates = [...dateMap.keys()].sort();
  const catNames = [...new Set(allAssignments.map(a => a.category))];
  const catWeights = {};
  for (const cat of categories) catWeights[cat.name] = parseFloat(cat.weight) || 0;
  const acc = {};
  for (const name of catNames) acc[name] = { pts: 0, max: 0 };
  const result = [];
  let cumulativeCount = 0;
  for (const date of uniqueDates) {
    const dayAssignments = dateMap.get(date);
    for (const a of dayAssignments) { acc[a.category].pts += a.pts; acc[a.category].max += a.max; cumulativeCount++; }
    let weightedSum = 0, totalWeight = 0;
    const catAverages = {};
    for (const name of catNames) {
      const w = catWeights[name] || 0;
      const a = acc[name];
      const avg = a.max > 0 ? (a.pts / a.max) * 100 : null;
      catAverages[name] = avg != null ? Math.round(avg * 10) / 10 : null;
      if (avg != null && w > 0) { weightedSum += avg * (w / 100); totalWeight += w / 100; }
    }
    const grade = totalWeight > 0 ? Math.round((weightedSum / totalWeight) * 10) / 10 : null;
    result.push({ date, grade, nAssignments: cumulativeCount, catAverages });
  }
  return result;
}

function computeOverallRunningAverage(classesWithHistory) {
  const dateSet = new Set();
  for (const cls of classesWithHistory) {
    if (cls.runningAverage) for (const p of cls.runningAverage) dateSet.add(p.date);
  }
  const allDates = [...dateSet].sort();
  if (allDates.length === 0) return [];
  return allDates.map(date => {
    let sum = 0, count = 0;
    for (const cls of classesWithHistory) {
      if (cls.runningAverage) {
        let latestGrade = null;
        for (const p of cls.runningAverage) { if (p.date <= date && p.grade != null) latestGrade = p.grade; }
        if (latestGrade != null) { sum += latestGrade; count++; }
      }
    }
    return { date, grade: count > 0 ? Math.round((sum / count) * 10) / 10 : null, nClasses: count };
  });
}

function detectTrend(values) {
  if (!values || values.length < 3) return 'stable';
  const valid = values.filter(v => v != null && !isNaN(v));
  if (valid.length < 3) return 'stable';

  // Smooth with a small centered window to cut through assignment noise
  const win = Math.max(1, Math.floor(valid.length / 6));
  const smooth = [];
  for (let i = 0; i < valid.length; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - win); j <= Math.min(valid.length - 1, i + win); j++) { s += valid[j]; c++; }
    smooth.push(s / c);
  }

  const n = smooth.length;
  const indices = smooth.map((_, i) => i);
  const sumX = indices.reduce((s, x) => s + x, 0);
  const sumY = smooth.reduce((s, y) => s + y, 0);
  const sumXY = indices.reduce((s, x, i) => s + x * smooth[i], 0);
  const sumXX = indices.reduce((s, x) => s + x * x, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return 'stable';

  const slope = (n * sumXY - sumX * sumY) / denom;
  const totalChange = slope * n;
  if (Math.abs(totalChange) < 1.5) return 'stable';
  if (totalChange > 1.5) return 'improving';
  if (totalChange < -1.5) return 'declining';
  return 'stable';
}

function computeAssignmentScores(categories) {
  const scored = [];
  for (const cat of (categories || [])) {
    for (const a of (cat.assignments || [])) {
      if (a.status === 'Excuse' || a.status === 'Exempt') continue;
      if (a.pct != null && a.dueDate) scored.push({ date: a.dueDate, pct: a.pct });
    }
  }
  scored.sort((a, b) => a.date.localeCompare(b.date));
  return scored.map(s => s.pct);
}

function findBelowThreshold(classes, goal, trackedClassIds) {
  const alerts = [];
  for (const cls of classes) {
    if (!trackedClassIds || !trackedClassIds.has(cls.id)) continue;
    if (cls.weightedGrade != null && cls.weightedGrade < goal) {
      alerts.push({
        type: 'class', classId: cls.id, className: cls.shortName || cls.name,
        categoryName: null, currentGrade: cls.weightedGrade, goal,
        gap: Math.round((cls.weightedGrade - goal) * 10) / 10,
        view: 'courses', viewParams: { courseId: cls.id }
      });
    }
    for (const cat of (cls.categories || [])) {
      if (cat.average != null && cat.average < goal) {
        alerts.push({
          type: 'category', classId: cls.id, className: cls.shortName || cls.name,
          categoryName: cat.name, currentGrade: cat.average, goal,
          gap: Math.round((cat.average - goal) * 10) / 10,
          view: 'courses', viewParams: { courseId: cls.id, category: cat.name }
        });
      }
    }
  }
  alerts.sort((a, b) => a.gap - b.gap);
  return alerts;
}

// Data normalization (mirrors data-engine.js)
const NON_ACADEMIC_KEYWORDS = ['study hall', 'lunch', 'demerit', 'merit', 'homeroom', 'chapel', 'power group', 'ministry training'];

function isAcademicClass(className) {
  const lower = className.toLowerCase();
  return !NON_ACADEMIC_KEYWORDS.some(k => lower.includes(k));
}

function parseShortName(fullName) {
  const m = fullName.match(/^([^(]+)/);
  return m ? m[1].trim() : fullName.trim();
}

function normalizeGradesData(rawData) {
  if (!rawData || !rawData.classes) return null;
  const academicYear = rawData.academic_year || '2025-26';
  const currentTerm = rawData.current_term || 4;
  const classes = [];
  const academicClassIds = new Set();
  const nonAcademicClassIds = new Set();
  const quarterStarts = {};

  for (const [classId, clsData] of Object.entries(rawData.classes)) {
    const className = clsData.class_name || 'Unknown';
    const isAcademic = isAcademicClass(className);
    if (isAcademic) academicClassIds.add(classId);
    else nonAcademicClassIds.add(classId);

    const quarters = clsData.quarters || {};
    const termData = quarters[String(currentTerm)] || {};
    const termGradeRaw = termData.term_grade;
    const termGrade = (termGradeRaw && termGradeRaw !== 'No') ? parseFloat(termGradeRaw) : null;
    const quarterGrades = [];

    // Merge assignments from ALL quarters (whole-year running averages)
    const quarterKeys = Object.keys(quarters).sort((a, b) => Number(a) - Number(b));
    const byCatName = new Map();
    for (const q of quarterKeys) {
      const qd = quarters[q];
      if (qd && qd.term_grade != null && qd.term_grade !== 'No') {
        quarterGrades.push({ term: Number(q), grade: parseFloat(qd.term_grade), letter: qd.term_letter || 'N/A' });
      }
      for (const cat of (qd.categories || [])) {
        if (!byCatName.has(cat.name)) byCatName.set(cat.name, { name: cat.name, weight: parseFloat(cat.weight) || 0, average: null, assignments: [] });
        const entry = byCatName.get(cat.name);
        for (const a of (cat.assignments || [])) {
          const pts = a.pts != null && a.pts !== '' ? parseFloat(a.pts) : null;
          const max = a.max != null && a.max !== '' ? parseFloat(a.max) : null;
          const dueDate = a.due ? parseDate(a.due, academicYear) : null;
          entry.assignments.push({
            name: a.name || 'Untitled', pts, max,
            avg: a.avg != null && a.avg !== '' ? parseFloat(a.avg) : null,
            pct: (pts != null && max != null && max > 0) ? Math.round((pts / max) * 1000) / 10 : null,
            status: a.status || 'Unknown', dueDate, dueRaw: a.due, term: Number(q)
          });
          if (dueDate) {
            if (!quarterStarts[q] || dueDate < quarterStarts[q]) quarterStarts[q] = dueDate;
          }
        }
      }
    }

    // Build categories: current term's weight/average, all quarters' assignments
    const categories = [...byCatName.values()].map(entry => {
      const termCat = (termData.categories || []).find(c => c.name === entry.name);
      let computedAvg = (termCat && termCat.average != null && termCat.average !== '') ? parseFloat(termCat.average) : null;
      if (computedAvg == null) {
        const valid = entry.assignments.filter(a => a.pts != null && a.max != null && a.max > 0);
        if (valid.length > 0) {
          computedAvg = Math.round((valid.reduce((s, a) => s + (a.pts / a.max) * 100, 0) / valid.length) * 10) / 10;
        }
      }
      return { name: entry.name, weight: entry.weight, average: computedAvg, assignments: entry.assignments };
    });

    classes.push({
      id: classId, name: className, shortName: parseShortName(className),
      isAcademic, termGrade, termLetter: termData.term_letter || 'N/A', categories,
      quarterGrades,
      weightedGrade: null, runningAverage: [], trend: 'stable'
    });
  }

  classes.sort((a, b) => {
    if (a.isAcademic !== b.isAcademic) return a.isAcademic ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { classes, meta: { academicYear, currentTerm, updated: rawData.updated || '', quarterStarts }, academicClassIds, nonAcademicClassIds };
}

function parseDate(mmd, academicYear) {
  if (!mmd || !mmd.includes('/')) return '';
  const [m, d] = mmd.split('/').map(Number);
  if (!m || !d) return '';
  const [sy, ey] = academicYear.split('-').map(Number);
  const baseYear = m >= 7 ? sy : (ey > 100 ? ey : sy + 1);
  const date = new Date(baseYear, m - 1, d);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function computeDerivedData(normalized, goal = 90, trackedClassIds = null) {
  const { classes, meta, academicClassIds, nonAcademicClassIds } = normalized;
  const activeClasses = classes.filter(c => c.isAcademic);
  const trackedIds = trackedClassIds || new Set(activeClasses.map(c => c.id));

  for (const cls of activeClasses) {
    const r = computeWeightedGrade(cls.categories);

    // Per-period running averages (quarters reset, semesters carry both terms, year = whole)
    cls.periodRunning = {};
    cls.periodGrade = {};
    cls.periodCategoryGrades = {};
    for (const pk of Object.keys(PERIODS)) {
      const line = computeRunningAverage(cls.categories, termFilterFor(PERIODS[pk]));
      const lastP = [...line].reverse().find(p => p.grade != null);
      const catAvgs = lastP ? lastP.catAverages : null;
      cls.periodRunning[pk] = line;
      cls.periodGrade[pk] = lastP ? lastP.grade : null;
      cls.periodCategoryGrades[pk] = catAvgs ? Object.keys(catAvgs).map(name => {
        const cat = cls.categories.find(c => c.name === name) || {};
        const assignments = (cat.assignments || []).filter(a => termFilterFor(PERIODS[pk])(a.term));
        return { name, weight: cat.weight || 0, average: catAvgs[name], assignments };
      }) : [];
    }

    // Whole-year aliases (existing views stay intact)
    cls.runningAverage = cls.periodRunning.year;
    const lastPoint = [...cls.runningAverage].reverse().find(p => p.grade != null);
    if (lastPoint) {
      cls.weightedGrade = lastPoint.grade;
      cls.weightedLetter = computeLetterGrade(lastPoint.grade);
      cls.categoryGrades = cls.periodCategoryGrades.year;
    } else {
      cls.weightedGrade = r.grade;
      cls.weightedLetter = r.letter;
      cls.categoryGrades = r.categoryGrades;
    }

    // Trend from actual assignment scores (not cumulative lines, which only decline)
    cls.trend = detectTrend(computeAssignmentScores(cls.categories));
  }

  // Sort classes lowest average → highest (nulls last) for consistent display everywhere
  activeClasses.sort((a, b) => {
    if (a.weightedGrade == null) return b.weightedGrade == null ? 0 : 1;
    if (b.weightedGrade == null) return -1;
    return a.weightedGrade - b.weightedGrade;
  });

  const overallPeriods = {};
  for (const pk of Object.keys(PERIODS)) {
    overallPeriods[pk] = computeOverallRunningAverage(activeClasses.map(c => ({ runningAverage: c.periodRunning[pk] })));
  }
  const overallRunning = overallPeriods.year;
  const currentGrades = activeClasses.map(c => c.weightedGrade).filter(g => g != null);
  const overallGrade = currentGrades.length > 0 ? Math.round((currentGrades.reduce((s, g) => s + g, 0) / currentGrades.length) * 10) / 10 : null;
  const quarterTrend = [1, 2, 3, 4].map(term => {
    const grades = activeClasses.map(c => (c.quarterGrades || []).find(q => q.term === term)).filter(q => q && q.grade != null).map(q => q.grade);
    return { term, grade: grades.length > 0 ? Math.round((grades.reduce((s, g) => s + g, 0) / grades.length) * 10) / 10 : null, n: grades.length };
  }).filter(q => q.grade != null);
  const gpaValues = activeClasses.map(c => computeGPA(c.weightedGrade)).filter(g => g > 0);
  const overallGPA = gpaValues.length > 0 ? Math.round((gpaValues.reduce((s, g) => s + g, 0) / gpaValues.length) * 100) / 100 : 0;
  const watchlist = findBelowThreshold(activeClasses, goal, trackedIds);

  const allAssignments = [];
  for (const cls of activeClasses) {
    for (const cat of cls.categories) {
      for (const a of cat.assignments) {
        allAssignments.push({ ...a, classId: cls.id, className: cls.shortName || cls.name, category: cat.name, categoryWeight: cat.weight });
      }
    }
  }

  return {
    overallGrade, overallLetter: computeLetterGrade(overallGrade), overallGPA, quarterTrend,
    overallRunning, overallPeriods, activeClasses, allAssignments, watchlist,
    meta, goal, trackedClassIds: trackedIds, nonAcademicClassIds,
    totalAssignments: allAssignments.length,
    completedAssignments: allAssignments.filter(a => a.pts != null).length,
    lastUpdated: new Date().toISOString()
  };
}

module.exports = { normalizeGradesData, computeDerivedData, PERIODS };
