"""
GradeTrack compute bridge (Python port of public/js/compute-server-bridge.js).

Produces the exact derived-data shape the GradeTrack frontend consumes via
/api/computed, running in-process in the FastAPI backend.

Mirrors:
  - gradetrack-app/public/js/compute-server-bridge.js
  - the history-merge step in gradetrack-app/server.js
"""

import math
from datetime import datetime, timezone

GRADE_SCALE = [
    (93, 'A', 4.0),
    (90, 'A-', 3.7),
    (87, 'B+', 3.3),
    (83, 'B', 3.0),
    (80, 'B-', 2.7),
    (77, 'C+', 2.3),
    (73, 'C', 2.0),
    (70, 'C-', 1.7),
    (67, 'D+', 1.3),
    (60, 'D', 1.0),
    (0, 'F', 0.0),
]

PERIODS = {
    'q1': [1], 'q2': [2], 'q3': [3], 'q4': [4],
    's1': [1, 2], 's2': [3, 4], 'year': [1, 2, 3, 4],
}

NON_ACADEMIC_KEYWORDS = [
    'study hall', 'lunch', 'demerit', 'merit', 'homeroom',
    'chapel', 'power group', 'ministry training',
]

DEFAULT_ACADEMIC_YEAR = '2025-26'


def _js_round(value, ndigits=1):
    """Match JavaScript Math.round(x * 10**n) / 10**n (half toward +inf)."""
    factor = 10 ** ndigits
    return math.floor(value * factor + 0.5) / factor


def _is_number(value):
    try:
        float(value)
        return True
    except (TypeError, ValueError):
        return False


def _to_number(value):
    if value is None or value == '':
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def compute_letter_grade(score):
    if score is None:
        return 'N/A'
    try:
        score = float(score)
    except (TypeError, ValueError):
        return 'N/A'
    if math.isnan(score):
        return 'N/A'
    for minimum, letter, _gpa in GRADE_SCALE:
        if score >= minimum:
            return letter
    return 'F'


def compute_gpa(score):
    if score is None:
        return 0
    try:
        score = float(score)
    except (TypeError, ValueError):
        return 0
    if math.isnan(score):
        return 0
    for minimum, _letter, gpa in GRADE_SCALE:
        if score >= minimum:
            return gpa
    return 0


def compute_weighted_grade(categories):
    if not categories:
        return {'grade': None, 'letter': 'N/A', 'categoryGrades': []}
    total_weight = 0.0
    weighted_sum = 0.0
    category_grades = []
    for cat in categories:
        weight = _to_number(cat.get('weight')) or 0.0
        avg = _to_number(cat.get('average'))
        category_grades.append({
            'name': cat.get('name'),
            'weight': weight,
            'average': avg,
            'assignments': cat.get('assignments') or [],
        })
        if avg is not None and not math.isnan(avg) and weight > 0:
            weighted_sum += avg * (weight / 100)
            total_weight += weight / 100
    grade = weighted_sum / total_weight if total_weight > 0 else None
    return {
        'grade': _js_round(grade) if grade is not None else None,
        'letter': compute_letter_grade(grade),
        'categoryGrades': category_grades,
    }


def term_filter_for(terms):
    def _filter(term):
        return term is None or term in terms
    return _filter


def compute_running_average(categories, term_filter=None):
    if not categories:
        return []
    all_assignments = []
    for cat in categories:
        weight = _to_number(cat.get('weight')) or 0.0
        for a in cat.get('assignments') or []:
            if a.get('status') in ('Excuse', 'Exempt'):
                continue
            if term_filter and not term_filter(a.get('term')):
                continue
            pts = _to_number(a.get('pts'))
            mx = _to_number(a.get('max'))
            if pts is None or mx is None or mx == 0:
                continue
            all_assignments.append({
                'date': a.get('dueDate') or a.get('dueRaw') or '',
                'pts': pts,
                'max': mx,
                'category': cat.get('name'),
                'weight': weight,
            })
    if not all_assignments:
        return []
    all_assignments.sort(key=lambda a: a['date'])
    date_map = {}
    for a in all_assignments:
        date_map.setdefault(a['date'], []).append(a)
    unique_dates = sorted(date_map.keys())
    cat_names = list(dict.fromkeys(a['category'] for a in all_assignments))
    cat_weights = {cat.get('name'): (_to_number(cat.get('weight')) or 0.0) for cat in categories}
    acc = {name: {'pts': 0.0, 'max': 0.0} for name in cat_names}
    result = []
    cumulative_count = 0
    for date in unique_dates:
        for a in date_map[date]:
            acc[a['category']]['pts'] += a['pts']
            acc[a['category']]['max'] += a['max']
            cumulative_count += 1
        weighted_sum = 0.0
        total_weight = 0.0
        cat_averages = {}
        for name in cat_names:
            w = cat_weights.get(name) or 0.0
            bucket = acc[name]
            avg = (bucket['pts'] / bucket['max']) * 100 if bucket['max'] > 0 else None
            cat_averages[name] = _js_round(avg) if avg is not None else None
            if avg is not None and w > 0:
                weighted_sum += avg * (w / 100)
                total_weight += w / 100
        grade = _js_round(weighted_sum / total_weight) if total_weight > 0 else None
        result.append({'date': date, 'grade': grade, 'nAssignments': cumulative_count, 'catAverages': cat_averages})
    return result


def compute_overall_running_average(classes_with_history):
    date_set = set()
    for cls in classes_with_history:
        for point in cls.get('runningAverage') or []:
            date_set.add(point['date'])
    all_dates = sorted(date_set)
    if not all_dates:
        return []
    result = []
    for date in all_dates:
        total = 0
        count = 0
        for cls in classes_with_history:
            latest_grade = None
            for point in cls.get('runningAverage') or []:
                if point['date'] <= date and point.get('grade') is not None:
                    latest_grade = point['grade']
            if latest_grade is not None:
                total += latest_grade
                count += 1
        result.append({
            'date': date,
            'grade': _js_round(total / count) if count > 0 else None,
            'nClasses': count,
        })
    return result


def detect_trend(values):
    valid = [v for v in (values or []) if v is not None and _is_number(v)]
    if len(valid) < 3:
        return 'stable'
    win = max(1, int(len(valid) / 6))
    smooth = []
    for i in range(len(valid)):
        lo = max(0, i - win)
        hi = min(len(valid) - 1, i + win)
        window = valid[lo:hi + 1]
        smooth.append(sum(window) / len(window))
    n = len(smooth)
    indices = list(range(n))
    sum_x = sum(indices)
    sum_y = sum(smooth)
    sum_xy = sum(x * y for x, y in zip(indices, smooth))
    sum_xx = sum(x * x for x in indices)
    denom = n * sum_xx - sum_x * sum_x
    if denom == 0:
        return 'stable'
    slope = (n * sum_xy - sum_x * sum_y) / denom
    total_change = slope * n
    if abs(total_change) < 1.5:
        return 'stable'
    if total_change > 1.5:
        return 'improving'
    if total_change < -1.5:
        return 'declining'
    return 'stable'


def compute_assignment_scores(categories):
    scored = []
    for cat in categories or []:
        for a in cat.get('assignments') or []:
            if a.get('status') in ('Excuse', 'Exempt'):
                continue
            if a.get('pct') is not None and a.get('dueDate'):
                scored.append({'date': a['dueDate'], 'pct': a['pct']})
    scored.sort(key=lambda s: s['date'])
    return [s['pct'] for s in scored]


def find_below_threshold(classes, default_goal, tracked_class_ids=None, per_class_goals=None, period='year'):
    per_class_goals = per_class_goals or {}
    alerts = []
    for cls in classes:
        goal = per_class_goals.get(cls['id'], default_goal)
        if tracked_class_ids is not None and cls['id'] not in tracked_class_ids:
            continue
        period_grade = (cls.get('periodGrade') or {}).get(period)
        if period_grade is not None and period_grade < goal:
            alerts.append({
                'type': 'class',
                'classId': cls['id'],
                'className': cls.get('shortName') or cls.get('name'),
                'categoryName': None,
                'currentGrade': period_grade,
                'goal': goal,
                'gap': _js_round(period_grade - goal, 1),
                'view': 'courses',
                'viewParams': {'courseId': cls['id']},
            })
        for cat in (cls.get('periodCategoryGrades') or {}).get(period) or []:
            if cat.get('average') is not None and cat['average'] < goal:
                alerts.append({
                    'type': 'category',
                    'classId': cls['id'],
                    'className': cls.get('shortName') or cls.get('name'),
                    'categoryName': cat.get('name'),
                    'currentGrade': cat['average'],
                    'goal': goal,
                    'gap': _js_round(cat['average'] - goal, 1),
                    'view': 'courses',
                    'viewParams': {'courseId': cls['id'], 'category': cat.get('name')},
                })
    alerts.sort(key=lambda a: a['gap'])
    return alerts


def is_academic_class(class_name):
    lower = (class_name or '').lower()
    return not any(k in lower for k in NON_ACADEMIC_KEYWORDS)


def parse_short_name(full_name):
    if not full_name:
        return ''
    idx = full_name.find('(')
    return full_name[:idx].strip() if idx >= 0 else full_name.strip()


def parse_date(mmd, academic_year):
    if not mmd or '/' not in mmd:
        return ''
    parts = mmd.split('/')
    if len(parts) != 2:
        return ''
    try:
        month, day = int(parts[0]), int(parts[1])
    except ValueError:
        return ''
    if not month or not day:
        return ''
    try:
        start_year, end_year = (int(x) for x in academic_year.split('-'))
    except ValueError:
        start_year, end_year = 2025, 2026
    base_year = start_year if month >= 7 else (end_year if end_year > 100 else start_year + 1)
    return f'{base_year:04d}-{month:02d}-{day:02d}'


def normalize_grades_data(raw_data, history=None):
    if not raw_data or not raw_data.get('classes'):
        return None

    academic_year = raw_data.get('academic_year') or DEFAULT_ACADEMIC_YEAR
    current_term = raw_data.get('current_term') or 4

    # Merge previous quarters (1-3) from history so running averages span
    # the whole academic year, not just the current term (mirrors server.js).
    if history:
        year_data = (history or {}).get(academic_year, {})
        for quarter in ('1', '2', '3'):
            for class_id, cls_data in (year_data.get(quarter) or {}).items():
                if class_id not in raw_data['classes']:
                    continue
                raw_data['classes'][class_id].setdefault('quarters', {})[quarter] = cls_data

    classes = []
    academic_class_ids = set()
    non_academic_class_ids = set()
    quarter_starts = {}

    for class_id, cls_data in raw_data['classes'].items():
        class_name = cls_data.get('class_name') or 'Unknown'
        is_academic = is_academic_class(class_name)
        if is_academic:
            academic_class_ids.add(class_id)
        else:
            non_academic_class_ids.add(class_id)

        quarters = cls_data.get('quarters') or {}
        term_data = quarters.get(str(current_term)) or {}
        term_grade_raw = term_data.get('term_grade')
        term_grade = _to_number(term_grade_raw) if term_grade_raw not in (None, 'No') else None

        quarter_grades = []
        quarter_keys = sorted(quarters.keys(), key=lambda k: int(k))
        by_cat_name = {}
        for q in quarter_keys:
            qd = quarters[q]
            if not qd:
                continue
            tg = qd.get('term_grade')
            if tg not in (None, 'No') and _is_number(tg):
                quarter_grades.append({
                    'term': int(q),
                    'grade': float(tg),
                    'letter': qd.get('term_letter') or 'N/A',
                })
            for cat in qd.get('categories') or []:
                cat_name = cat.get('name')
                if cat_name not in by_cat_name:
                    by_cat_name[cat_name] = {
                        'name': cat_name,
                        'weight': _to_number(cat.get('weight')) or 0.0,
                        'average': None,
                        'assignments': [],
                    }
                entry = by_cat_name[cat_name]
                for a in cat.get('assignments') or []:
                    pts = _to_number(a.get('pts'))
                    mx = _to_number(a.get('max'))
                    due_date = parse_date(a.get('due'), academic_year)
                    entry['assignments'].append({
                        'name': a.get('name') or 'Untitled',
                        'pts': pts,
                        'max': mx,
                        'avg': _to_number(a.get('avg')),
                        'pct': _js_round((pts / mx) * 100) if (pts is not None and mx is not None and mx > 0) else None,
                        'status': a.get('status') or 'Unknown',
                        'dueDate': due_date,
                        'dueRaw': a.get('due'),
                        'term': int(q),
                    })
                    if due_date:
                        if q not in quarter_starts or due_date < quarter_starts[q]:
                            quarter_starts[q] = due_date

        term_categories = term_data.get('categories') or []
        categories = []
        for entry in by_cat_name.values():
            term_cat = next((c for c in term_categories if c.get('name') == entry['name']), None)
            computed_avg = _to_number(term_cat.get('average')) if term_cat and term_cat.get('average') not in (None, '') else None
            if computed_avg is None:
                valid = [a for a in entry['assignments'] if a['pts'] is not None and a['max'] is not None and a['max'] > 0]
                if valid:
                    computed_avg = _js_round(sum((a['pts'] / a['max']) * 100 for a in valid) / len(valid))
            categories.append({
                'name': entry['name'],
                'weight': entry['weight'],
                'average': computed_avg,
                'assignments': entry['assignments'],
            })

        classes.append({
            'id': class_id,
            'name': class_name,
            'shortName': parse_short_name(class_name),
            'isAcademic': is_academic,
            'termGrade': term_grade,
            'termLetter': term_data.get('term_letter') or 'N/A',
            'categories': categories,
            'quarterGrades': quarter_grades,
            'weightedGrade': None,
            'runningAverage': [],
            'trend': 'stable',
        })

    classes.sort(key=lambda c: (not c['isAcademic'], c['name']))

    return {
        'classes': classes,
        'meta': {
            'academicYear': academic_year,
            'currentTerm': int(current_term),
            'updated': raw_data.get('updated') or '',
            'quarterStarts': quarter_starts,
        },
        'academicClassIds': academic_class_ids,
        'nonAcademicClassIds': non_academic_class_ids,
    }


def compute_derived_data(normalized, goal=90, tracked_class_ids=None, per_class_goals=None):
    classes = normalized['classes']
    meta = normalized['meta']
    active_classes = [c for c in classes if c['isAcademic']]
    tracked_ids = tracked_class_ids if tracked_class_ids is not None else {c['id'] for c in active_classes}

    for cls in active_classes:
        weighted = compute_weighted_grade(cls['categories'])

        cls['periodRunning'] = {}
        cls['periodGrade'] = {}
        cls['periodCategoryGrades'] = {}
        for period_key in PERIODS:
            line = compute_running_average(cls['categories'], term_filter_for(PERIODS[period_key]))
            last_point = next((p for p in reversed(line) if p.get('grade') is not None), None)
            cat_avgs = last_point['catAverages'] if last_point else None
            cls['periodRunning'][period_key] = line
            cls['periodGrade'][period_key] = last_point['grade'] if last_point else None
            cls['periodCategoryGrades'][period_key] = (
                [
                    {
                        'name': name,
                        'weight': next((c.get('weight') or 0) for c in cls['categories'] if c.get('name') == name) if any(c.get('name') == name for c in cls['categories']) else 0,
                        'average': cat_avgs[name],
                        'assignments': [a for a in (next((c for c in cls['categories'] if c.get('name') == name), {}).get('assignments') or []) if term_filter_for(PERIODS[period_key])(a.get('term'))],
                    }
                    for name in cat_avgs
                ]
                if cat_avgs
                else []
            )

        cls['runningAverage'] = cls['periodRunning']['year']
        last_point = next((p for p in reversed(cls['runningAverage']) if p.get('grade') is not None), None)
        if last_point:
            cls['weightedGrade'] = last_point['grade']
            cls['weightedLetter'] = compute_letter_grade(last_point['grade'])
            cls['categoryGrades'] = cls['periodCategoryGrades']['year']
        else:
            cls['weightedGrade'] = weighted['grade']
            cls['weightedLetter'] = weighted['letter']
            cls['categoryGrades'] = weighted['categoryGrades']

        cls['trend'] = detect_trend(compute_assignment_scores(cls['categories']))

    active_classes.sort(key=lambda c: (c['weightedGrade'] is None, c['weightedGrade'] if c['weightedGrade'] is not None else float('inf')))

    overall_periods = {}
    for period_key in PERIODS:
        overall_periods[period_key] = compute_overall_running_average(
            [{'runningAverage': c['periodRunning'][period_key]} for c in active_classes]
        )
    overall_running = overall_periods['year']

    current_grades = [c['weightedGrade'] for c in active_classes if c['weightedGrade'] is not None]
    overall_grade = _js_round(sum(current_grades) / len(current_grades)) if current_grades else None

    quarter_trend = []
    for term in (1, 2, 3, 4):
        grades = []
        for c in active_classes:
            match = next((q for q in c.get('quarterGrades') or [] if q['term'] == term), None)
            if match and match.get('grade') is not None:
                grades.append(match['grade'])
        if grades:
            quarter_trend.append({
                'term': term,
                'grade': _js_round(sum(grades) / len(grades)),
                'n': len(grades),
            })

    gpa_values = [compute_gpa(c['weightedGrade']) for c in active_classes if compute_gpa(c['weightedGrade']) > 0]
    overall_gpa = _js_round(sum(gpa_values) / len(gpa_values), 2) if gpa_values else 0

    watchlist = find_below_threshold(
        active_classes,
        goal,
        tracked_ids,
        per_class_goals,
        period=f'q{meta["currentTerm"]}',
    )

    all_assignments = []
    for cls in active_classes:
        for cat in cls['categories']:
            for a in cat['assignments']:
                all_assignments.append({
                    **a,
                    'classId': cls['id'],
                    'className': cls.get('shortName') or cls.get('name'),
                    'category': cat['name'],
                    'categoryWeight': cat['weight'],
                })

    return {
        'overallGrade': overall_grade,
        'overallLetter': compute_letter_grade(overall_grade),
        'overallGPA': overall_gpa,
        'quarterTrend': quarter_trend,
        'overallRunning': overall_running,
        'overallPeriods': overall_periods,
        'activeClasses': active_classes,
        'allAssignments': all_assignments,
        'watchlist': watchlist,
        'meta': meta,
        'goal': goal,
        'trackedClassIds': sorted(tracked_ids),
        'nonAcademicClassIds': sorted(normalized['nonAcademicClassIds']),
        'totalAssignments': len(all_assignments),
        'completedAssignments': len([a for a in all_assignments if a.get('pts') is not None]),
        'lastUpdated': datetime.now(timezone.utc).isoformat(),
    }
