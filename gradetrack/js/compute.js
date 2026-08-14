/* ================================================================
   GradeTrack v2 — Computation Engine
   Core math: weighted grades, running averages, trend detection
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
  for (const tier of GRADE_SCALE) {
    if (score >= tier.min) return tier.letter;
  }
  return 'F';
}

function computeGPA(score) {
  if (score == null || isNaN(score)) return 0;
  for (const tier of GRADE_SCALE) {
    if (score >= tier.min) return tier.gpa;
  }
  return 0;
}

function computeGradeColor(score) {
  if (score == null || isNaN(score)) return '#6c6c7c';
  if (score >= 90) return '#22c55e';
  if (score >= 80) return '#60a5fa';
  if (score >= 70) return '#eab308';
  if (score >= 60) return '#f97316';
  return '#ef4444';
}

/* Compute weighted grade for a class given its categories
   categories = [{ name, weight (number), average (number|null), assignments: [] }]
   Returns { grade: number|null, letter: string, categoryGrades: [...] }
*/
function computeWeightedGrade(categories) {
  if (!categories || categories.length === 0) return { grade: null, letter: 'N/A', categoryGrades: [] };

  let totalWeight = 0;
  let weightedSum = 0;
  const categoryGrades = [];

  for (const cat of categories) {
    const weight = parseFloat(cat.weight) || 0;
    const avg = cat.average != null ? parseFloat(cat.average) : null;

    categoryGrades.push({
      name: cat.name,
      weight,
      average: avg,
      assignments: cat.assignments || []
    });

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

/* Compute running weighted average day by day.
   For each date where assignments exist, compute what the cumulative
   weighted grade was at that point using only assignments up to that date.

   categories = [{ name, weight, assignments: [{ pts, max, due, status }] }]
   Returns [{ date: 'YYYY-MM-DD', grade: number, nAssignments: number, catAverages: {} }]
*/
function computeRunningAverage(categories) {
  if (!categories || categories.length === 0) return [];

  // Collect all assignments with their dates and category info
  const allAssignments = [];
  for (const cat of categories) {
    const weight = parseFloat(cat.weight) || 0;
    for (const a of (cat.assignments || [])) {
      if (a.status === 'Excuse' || a.status === 'Exempt') continue;
      const pts = parseFloat(a.pts);
      const max = parseFloat(a.max);
      if (isNaN(pts) || isNaN(max) || max === 0) continue;
      allAssignments.push({
        date: a.due || a.date || '',
        pts,
        max,
        category: cat.name,
        weight
      });
    }
  }

  if (allAssignments.length === 0) return [];

  // Sort by date
  allAssignments.sort((a, b) => a.date.localeCompare(b.date));

  // Group by date and compute cumulative weighted average at each date
  const dateMap = new Map();
  for (const a of allAssignments) {
    if (!dateMap.has(a.date)) dateMap.set(a.date, []);
    dateMap.get(a.date).push(a);
  }

  const uniqueDates = [...dateMap.keys()].sort();
  const catNames = [...new Set(allAssignments.map(a => a.category))];
  const catWeights = {};
  for (const cat of categories) {
    catWeights[cat.name] = parseFloat(cat.weight) || 0;
  }

  // Running accumulators per category
  const acc = {};
  for (const name of catNames) acc[name] = { pts: 0, max: 0 };

  const result = [];
  let cumulativeCount = 0;

  for (const date of uniqueDates) {
    const dayAssignments = dateMap.get(date);
    for (const a of dayAssignments) {
      acc[a.category].pts += a.pts;
      acc[a.category].max += a.max;
      cumulativeCount++;
    }

    // Compute weighted grade at this point
    let weightedSum = 0;
    let totalWeight = 0;
    const catAverages = {};

    for (const name of catNames) {
      const w = catWeights[name] || 0;
      const a = acc[name];
      const avg = a.max > 0 ? (a.pts / a.max) * 100 : null;
      catAverages[name] = avg != null ? Math.round(avg * 10) / 10 : null;
      if (avg != null && w > 0) {
        weightedSum += avg * (w / 100);
        totalWeight += w / 100;
      }
    }

    const grade = totalWeight > 0 ? Math.round((weightedSum / totalWeight) * 10) / 10 : null;

    result.push({
      date,
      grade,
      nAssignments: cumulativeCount,
      catAverages
    });
  }

  return result;
}

/* Compute overall running average across all classes.
   Averages per-class running averages at each date.
*/
function computeOverallRunningAverage(classesWithHistory) {
  // Collect all unique dates across all classes
  const dateSet = new Set();
  for (const cls of classesWithHistory) {
    if (cls.runningAverage) {
      for (const point of cls.runningAverage) {
        dateSet.add(point.date);
      }
    }
  }

  const allDates = [...dateSet].sort();
  if (allDates.length === 0) return [];

  return allDates.map(date => {
    let sum = 0;
    let count = 0;
    for (const cls of classesWithHistory) {
      if (cls.runningAverage) {
        // Find the latest running average point up to this date
        let latestGrade = null;
        for (const point of cls.runningAverage) {
          if (point.date <= date && point.grade != null) {
            latestGrade = point.grade;
          }
        }
        if (latestGrade != null) {
          sum += latestGrade;
          count++;
        }
      }
    }
    return {
      date,
      grade: count > 0 ? Math.round((sum / count) * 10) / 10 : null,
      nClasses: count
    };
  });
}

/* Detect trend from a series of values.
   Returns 'improving' | 'declining' | 'stable'
*/
function detectTrend(values) {
  if (!values || values.length < 3) return 'stable';
  const valid = values.filter(v => v != null && !isNaN(v));
  if (valid.length < 3) return 'stable';

  // Linear regression slope
  const n = valid.length;
  const indices = valid.map((_, i) => i);
  const sumX = indices.reduce((s, x) => s + x, 0);
  const sumY = valid.reduce((s, y) => s + y, 0);
  const sumXY = indices.reduce((s, x, i) => s + x * valid[i], 0);
  const sumXX = indices.reduce((s, x) => s + x * x, 0);
  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumY);

  const threshold = 0.5; // points per index step
  if (slope > threshold) return 'improving';
  if (slope < -threshold) return 'declining';
  return 'stable';
}

/* Find everything below a given goal threshold.
   Returns array of watchlist alerts:
   [{ type, classId, className, categoryName, currentGrade, goal, gap, view, viewParams }]
*/
function findBelowThreshold(classes, goal, trackedClassIds) {
  const alerts = [];

  for (const cls of classes) {
    if (!trackedClassIds || !trackedClassIds.has(cls.id)) continue;

    // Check overall class grade
    if (cls.weightedGrade != null && cls.weightedGrade < goal) {
      alerts.push({
        type: 'class',
        classId: cls.id,
        className: cls.name,
        categoryName: null,
        currentGrade: cls.weightedGrade,
        goal,
        gap: cls.weightedGrade - goal,
        view: 'courses',
        viewParams: { courseId: cls.id }
      });
    }

    // Check each category
    if (cls.categories) {
      for (const cat of cls.categories) {
        if (cat.average != null && cat.average < goal) {
          alerts.push({
            type: 'category',
            classId: cls.id,
            className: cls.name,
            categoryName: cat.name,
            currentGrade: cat.average,
            goal,
            gap: cat.average - goal,
            view: 'courses',
            viewParams: { courseId: cls.id, category: cat.name }
          });
        }
      }
    }
  }

  // Sort by gap (most negative first)
  alerts.sort((a, b) => a.gap - b.gap);
  return alerts;
}

/* Compute what grade is needed on remaining assignments to reach goal.
   Not yet implemented — requires knowledge of remaining assignments.
   Placeholder for future "what-if" calculator.
*/
function computeGradeNeeded(currentGrade, goal, remainingWeight) {
  if (!remainingWeight || remainingWeight <= 0) return null;
  const needed = (goal - currentGrade * (1 - remainingWeight)) / remainingWeight;
  return Math.round(needed * 10) / 10;
}

export {
  computeLetterGrade,
  computeGPA,
  computeGradeColor,
  computeWeightedGrade,
  computeRunningAverage,
  computeOverallRunningAverage,
  detectTrend,
  findBelowThreshold,
  computeGradeNeeded
};
