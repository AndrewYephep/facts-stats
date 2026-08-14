let DATA = null;
const SECTION_IDS = ["dashboard", "analytics", "watchlist", "grades"];
let THRESHOLD = 95;
let activeClassId = null;
let selectedQuarter = '1';
let selectedPeriod = '1';
let selectedGradesQuarter = '1';
let selectedCategory = 'all';
let chartsReady = false;
let chartRefs = {};
let timelinePopupState = { chart: null, index: null, datasetIndex: null };
let timelinePopupScrollBound = false;
let yearGaugeHoverIndex = null;
let gaugeAnimFrame = null;
let gaugePulseFrame = null;
const animatedGaugeValues = new WeakMap();

function termLabel(value) {
  const raw = String(value || '').replace(/^Q/i, '');
  return `Q${raw}`;
}

function slug(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item';
}

function formatPct(value, digits = 1) {
  if (value === null || value === undefined) return 'N/A';
  return `${Number(value).toFixed(digits)}%`;
}

function toneClass(status) {
  if (status === 'attention') return 'tone-attention';
  if (status === 'strong') return 'tone-strong';
  return '';
}

function chartBounds(values) {
  const nums = values.filter((value) => value !== null && value !== undefined && !Number.isNaN(value));
  if (!nums.length) return { min: 0, max: 100 };
  const low = Math.min(...nums);
  const high = Math.max(...nums);
  const spread = Math.max(high - low, 2);
  const pad = Math.max(spread * 0.18, 1.2);
  return {
    min: Math.max(0, Math.floor((low - pad) * 10) / 10),
    max: Math.min(100, Math.ceil((high + pad) * 10) / 10),
  };
}

function flattenDatasetValues(datasets) {
  return datasets.flatMap((dataset) => dataset.data || []);
}

function findClass(classid) {
  return DATA.classes.find((item) => item.classid === classid);
}

function categoriesForGradesQuarter(item) {
  return (item.categories_by_term && item.categories_by_term[selectedGradesQuarter]) || [];
}

function gradeForGradesQuarter(item) {
  return item.quarter_values[termLabel(selectedGradesQuarter)];
}

function letterForGradesQuarter(item) {
  if (String(selectedGradesQuarter) === String(DATA.analytics.quarterly.current_term)) {
    return item.term_letter || '';
  }
  return '';
}

function categoriesBelowForQuarter(item) {
  return categoriesForGradesQuarter(item).filter((cat) => cat.status === 'attention').length;
}

const SPEEDOMETER_NS = 'http://www.w3.org/2000/svg';
const SPEEDOMETER_CFG = {
  cx: 210,
  cy: 210,
  rInner: 100,
  rOuter: 178,
  startA: -125,
  endA: 125,
  minV: 60,
  maxV: 100,
  angleStep: 6.25,
  ringSteps: 7,
  gapDeg: 0.7,
  gapR: 2.5,
  columnGradientStart: 0.0,
  columnGradientEnd: 1.0,
  rowGradientStart: 0.0,
  rowGradientEnd: 0.0,
  columnCurve: 1.0,
  rowCurve: 1.6,
  columnGradientStrength: 1,
};
const SPEEDOMETER_DARK_CFG = {
  cx: 210, cy: 210,
  rInner: 110, rOuter: 178,
  startA: -125, endA: 125,
  minV: 60, maxV: 100,
  angleStep: 6.25, ringSteps: 7,
  gapDeg: 0.7, gapR: 2.5,
};
const speedometerWidgets = new Map();

const SPEEDOMETER_ZONES = [
  { min: 60, max: 70, c0: [70, 72, 78], c1: [15, 15, 18] },
  { min: 70, max: 80, c0: [255, 140, 190], c1: [60, 15, 90] },
  { min: 80, max: 90, c0: [230, 55, 60], c1: [90, 15, 35] },
  { min: 90, max: 95, c0: [255, 225, 70], c1: [120, 55, 10] },
  { min: 95, max: 100, c0: [150, 235, 120], c1: [15, 90, 40] },
];

function speedometerSafeId(value) {
  return String(value).replace(/[^a-z0-9_-]/gi, '_');
}

function speedometerClamp(value) {
  return Math.max(SPEEDOMETER_CFG.minV, Math.min(SPEEDOMETER_CFG.maxV, Number(value || 0)));
}

function speedometerToRad(deg) {
  return (deg - 90) * Math.PI / 180;
}

function speedometerPolar(angleDeg, radius) {
  const rad = speedometerToRad(angleDeg);
  return [SPEEDOMETER_CFG.cx + radius * Math.cos(rad), SPEEDOMETER_CFG.cy + radius * Math.sin(rad)];
}

function speedometerArcPath(a1, a2, radius) {
  const [x1, y1] = speedometerPolar(a1, radius);
  const [x2, y2] = speedometerPolar(a2, radius);
  const large = (a2 - a1) <= 180 ? 0 : 1;
  return `M ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2}`;
}

function speedometerValueToAngle(value) {
  const ratio = (value - SPEEDOMETER_CFG.minV) / (SPEEDOMETER_CFG.maxV - SPEEDOMETER_CFG.minV);
  return SPEEDOMETER_CFG.startA + ratio * (SPEEDOMETER_CFG.endA - SPEEDOMETER_CFG.startA);
}

function speedometerLerp(a, b, t) {
  return a + (b - a) * t;
}

function speedometerEaseSplit(t) {
  return t < 0.5
    ? 2 * t * t
    : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function speedometerZoneFor(value) {
  for (const zone of SPEEDOMETER_ZONES) {
    if (value <= zone.max) return zone;
  }
  return SPEEDOMETER_ZONES[SPEEDOMETER_ZONES.length - 1];
}

function speedometerColorAt(t, zone) {
  const clamped = Math.max(0, Math.min(1, t));
  const eased = speedometerEaseSplit(1 - clamped * SPEEDOMETER_CFG.columnGradientStrength);
  return [
    speedometerLerp(zone.c0[0], zone.c1[0], eased),
    speedometerLerp(zone.c0[1], zone.c1[1], eased),
    speedometerLerp(zone.c0[2], zone.c1[2], eased),
  ];
}

function speedometerLightFactor(ringT) {
  const ratio = Math.max(0, Math.min(1,
    (ringT - SPEEDOMETER_CFG.rowGradientStart) /
    (SPEEDOMETER_CFG.rowGradientEnd - SPEEDOMETER_CFG.rowGradientStart || 1)
  ));
  return Math.pow(ratio, SPEEDOMETER_CFG.rowCurve);
}

function speedometerShade(rgb, factor) {
  const [r, g, b] = rgb;
  const curved = Math.pow(factor, 1.6);
  const floor = 0.28;
  const eased = floor + curved * (1 - floor);
  const darkR = 18;
  const darkG = 34;
  const darkB = 40;
  return `rgb(${Math.round(speedometerLerp(darkR, r, eased))},${Math.round(speedometerLerp(darkG, g, eased))},${Math.round(speedometerLerp(darkB, b, eased))})`;
}

function speedometerBuildMarkup(hostId, percent) {
  const safeId = speedometerSafeId(hostId);
  const value = Math.round(speedometerClamp(percent));
  return `
    <div class="stage speedometer-stage" data-speedometer-host="${hostId}">
      <div class="gauge">
        <svg viewBox="0 0 420 420" aria-hidden="true">
          <defs>
            <filter id="glow-${safeId}" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="2.4" result="b"/>
              <feMerge>
                <feMergeNode in="b"/>
                <feMergeNode in="SourceGraphic"/>
              </feMerge>
            </filter>
            <radialGradient id="ringDepth-${safeId}" cx="50%" cy="38%" r="65%">
              <stop offset="0%" style="stop-color:var(--gauge-depth-1)"/>
              <stop offset="55%" style="stop-color:var(--gauge-depth-2)"/>
              <stop offset="100%" style="stop-color:var(--gauge-depth-3)"/>
            </radialGradient>
            <radialGradient id="ringSheen-${safeId}" cx="35%" cy="25%" r="70%">
              <stop offset="0%" stop-color="#ffffff" stop-opacity="0.10"/>
              <stop offset="35%" stop-color="#ffffff" stop-opacity="0.02"/>
              <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
            </radialGradient>
          </defs>
          <circle cx="210" cy="210" r="198" fill="url(#ringDepth-${safeId})"/>
          <circle cx="210" cy="210" r="198" fill="url(#ringSheen-${safeId})"/>
          <circle cx="210" cy="210" r="196" fill="none" stroke="var(--gauge-outer-stroke)" stroke-width="1.5"/>
          <g data-speedometer-cells></g>
          <path data-speedometer-rim-track fill="none" stroke="var(--gauge-rim-track)" stroke-width="2"/>
          <path data-speedometer-rim-fg fill="none" stroke="var(--zoneA)" stroke-width="2" filter="url(#glow-${safeId})"/>
          <line data-speedometer-cap-start stroke="var(--gauge-cap-stroke)" stroke-width="2" filter="url(#glow-${safeId})"/>
          <line data-speedometer-cap-end stroke="var(--gauge-cap-stroke)" stroke-width="2" filter="url(#glow-${safeId})"/>
        </svg>
        <div class="core">
          <div class="val" data-speedometer-value>${value}</div>
          <div class="unit" data-speedometer-unit>Km/h</div>
        </div>
      </div>
    </div>
  `;
}

function buildSpeedometerMarkup(hostId, percent) {
  return speedometerBuildMarkup(hostId, percent);
}

function speedometerBuildWidget(hostId) {
  const host = document.getElementById(hostId);
  if (!host) return null;
  const root = host.querySelector('.speedometer-stage');
  if (!root) return null;
  const valueEl = root.querySelector('[data-speedometer-value]');
  const core = root.querySelector('.core');
  const cellsG = root.querySelector('[data-speedometer-cells]');
  const rimTrack = root.querySelector('[data-speedometer-rim-track]');
  const rimFg = root.querySelector('[data-speedometer-rim-fg]');
  const capStart = root.querySelector('[data-speedometer-cap-start]');
  const capEnd = root.querySelector('[data-speedometer-cap-end]');

  if (!cellsG || !valueEl || !core || !rimTrack || !rimFg || !capStart || !capEnd) return null;

  const safeId = speedometerSafeId(hostId);
  const cells = [];
  const totalAngle = SPEEDOMETER_CFG.endA - SPEEDOMETER_CFG.startA;
  const ringPitch = (SPEEDOMETER_CFG.rOuter - SPEEDOMETER_CFG.rInner) / SPEEDOMETER_CFG.ringSteps;

  if (!cellsG.dataset.speedometerBuilt) {
    for (let a = SPEEDOMETER_CFG.startA; a < SPEEDOMETER_CFG.endA; a += SPEEDOMETER_CFG.angleStep) {
      const a0 = a + SPEEDOMETER_CFG.gapDeg / 2;
      const a1 = a + SPEEDOMETER_CFG.angleStep - SPEEDOMETER_CFG.gapDeg / 2;
      for (let ring = 0; ring < SPEEDOMETER_CFG.ringSteps; ring++) {
        const r0 = SPEEDOMETER_CFG.rInner + ring * ringPitch + SPEEDOMETER_CFG.gapR / 2;
        const r1 = SPEEDOMETER_CFG.rInner + (ring + 1) * ringPitch - SPEEDOMETER_CFG.gapR / 2;
        const [x00, y00] = speedometerPolar(a0, r0);
        const [x01, y01] = speedometerPolar(a1, r0);
        const [x11, y11] = speedometerPolar(a1, r1);
        const [x10, y10] = speedometerPolar(a0, r1);

        const poly = document.createElementNS(SPEEDOMETER_NS, 'path');
        poly.setAttribute('d', `M ${x00} ${y00} L ${x01} ${y01} L ${x11} ${y11} L ${x10} ${y10} Z`);
        poly.setAttribute('fill', '#6f8790');
        cellsG.appendChild(poly);
        cells.push({ el: poly, angle: a, ringT: ring / (SPEEDOMETER_CFG.ringSteps - 1) });
      }
    }
    cellsG.dataset.speedometerBuilt = '1';
  } else {
    cells.push(...Array.from(cellsG.querySelectorAll('path')).map((el, index) => {
      const angleIndex = Math.floor(index / SPEEDOMETER_CFG.ringSteps);
      const ringIndex = index % SPEEDOMETER_CFG.ringSteps;
      return {
        el,
        angle: SPEEDOMETER_CFG.startA + angleIndex * SPEEDOMETER_CFG.angleStep,
        ringT: ringIndex / (SPEEDOMETER_CFG.ringSteps - 1),
      };
    }));
  }

  const widget = {
    host, root, valueEl, core, cellsG, rimTrack, rimFg, capStart, capEnd,
    cells, totalAngle, current: 0, target: 0, raf: null,
    renderFn: speedometerRenderWidget,
  };

  widget.root.style.setProperty('--zoneA', 'rgb(70,72,78)');
  widget.root.style.setProperty('--zoneB', 'rgb(255,255,255)');
  widget.root.style.setProperty('--gauge-core-border-bg', 'linear-gradient(180deg, rgb(255,255,255) 0%, rgb(70,72,78) 30%, rgb(255,255,255) 100%)');
  widget.rimTrack.setAttribute('d', speedometerArcPath(SPEEDOMETER_CFG.startA, SPEEDOMETER_CFG.endA, SPEEDOMETER_CFG.rOuter + 12));

  const [capStartX0, capStartY0] = speedometerPolar(SPEEDOMETER_CFG.startA, SPEEDOMETER_CFG.rInner);
  const [capStartX1, capStartY1] = speedometerPolar(SPEEDOMETER_CFG.startA, SPEEDOMETER_CFG.rOuter + 12);
  widget.capStart.setAttribute('x1', capStartX0);
  widget.capStart.setAttribute('y1', capStartY0);
  widget.capStart.setAttribute('x2', capStartX1);
  widget.capStart.setAttribute('y2', capStartY1);

  const [capEndX0, capEndY0] = speedometerPolar(SPEEDOMETER_CFG.endA, SPEEDOMETER_CFG.rInner);
  const [capEndX1, capEndY1] = speedometerPolar(SPEEDOMETER_CFG.endA, SPEEDOMETER_CFG.rOuter + 12);
  widget.capEnd.setAttribute('x1', capEndX0);
  widget.capEnd.setAttribute('y1', capEndY0);
  widget.capEnd.setAttribute('x2', capEndX1);
  widget.capEnd.setAttribute('y2', capEndY1);

  widget.root.dataset.speedometerId = safeId;
  speedometerWidgets.set(hostId, widget);
  return widget;
}

function speedometerRenderWidget(widget, value) {
  if (!widget) return;
  const v = speedometerClamp(value);
  const a = speedometerValueToAngle(v);
  const zone = speedometerZoneFor(v);
  const totalAngle = widget.totalAngle || (SPEEDOMETER_CFG.endA - SPEEDOMETER_CFG.startA);

  const zoneA = `rgb(${Math.round(zone.c0[0])},${Math.round(zone.c0[1])},${Math.round(zone.c0[2])})`;
  const zoneB = `rgb(${Math.round(zone.c1[0])},${Math.round(zone.c1[1])},${Math.round(zone.c1[2])})`;
  widget.root.style.setProperty('--zoneA', zoneA);
  widget.root.style.setProperty('--zoneB', zoneB);
  widget.root.style.setProperty('--gauge-core-border-bg', `linear-gradient(180deg, ${zoneB} 0%, ${zoneA} 30%, ${zoneB} 100%)`);

  widget.cells.forEach((cell) => {
    if (cell.angle <= a) {
      const rawT = (cell.angle - SPEEDOMETER_CFG.startA) / totalAngle;
      const t = Math.pow(
        Math.max(0, Math.min(1,
          (rawT - SPEEDOMETER_CFG.columnGradientStart) /
          (SPEEDOMETER_CFG.columnGradientEnd - SPEEDOMETER_CFG.columnGradientStart || 1)
        )),
        SPEEDOMETER_CFG.columnCurve
      );
      const base = speedometerColorAt(t, zone);
      const factor = speedometerLightFactor(cell.ringT + 0.2);
      cell.el.style.fill = '';
      cell.el.setAttribute('fill', speedometerShade(base, factor));
      cell.el.setAttribute('filter', `url(#glow-${widget.root.dataset.speedometerId})`);
    } else {
      cell.el.style.fill = 'var(--gauge-cell-inactive)';
      cell.el.removeAttribute('filter');
    }
  });

  const activeSteps = Math.floor((a - SPEEDOMETER_CFG.startA) / SPEEDOMETER_CFG.angleStep);
  const rimEdge = activeSteps >= 0
    ? Math.min(SPEEDOMETER_CFG.endA, SPEEDOMETER_CFG.startA + (activeSteps + 1) * SPEEDOMETER_CFG.angleStep)
    : SPEEDOMETER_CFG.startA;
  widget.rimFg.setAttribute('d', speedometerArcPath(SPEEDOMETER_CFG.startA, rimEdge, SPEEDOMETER_CFG.rOuter + 12));

  widget.valueEl.textContent = String(Math.round(v));
  widget.core.style.boxShadow = `0 0 24px 4px rgba(${Math.round(zone.c0[0])},${Math.round(zone.c0[1])},${Math.round(zone.c0[2])},0.5)`;
}

function speedometerBuildWidgetDark(hostId) {
  const host = document.getElementById(hostId);
  if (!host) return null;
  const root = host.querySelector('.speedometer-stage');
  if (!root) return null;
  const valueEl = root.querySelector('[data-speedometer-value]');
  const core = root.querySelector('.core');
  const cellsG = root.querySelector('[data-speedometer-cells]');
  const rimTrack = root.querySelector('[data-speedometer-rim-track]');
  const rimFg = root.querySelector('[data-speedometer-rim-fg]');
  const capStart = root.querySelector('[data-speedometer-cap-start]');
  const capEnd = root.querySelector('[data-speedometer-cap-end]');
  if (!cellsG || !valueEl || !core || !rimTrack || !rimFg || !capStart || !capEnd) return null;

  const safeId = speedometerSafeId(hostId);
  const cells = [];
  const totalAngle = SPEEDOMETER_DARK_CFG.endA - SPEEDOMETER_DARK_CFG.startA;
  const ringPitch = (SPEEDOMETER_DARK_CFG.rOuter - SPEEDOMETER_DARK_CFG.rInner) / SPEEDOMETER_DARK_CFG.ringSteps;

  cellsG.innerHTML = '';
  for (let a = SPEEDOMETER_DARK_CFG.startA; a < SPEEDOMETER_DARK_CFG.endA; a += SPEEDOMETER_DARK_CFG.angleStep) {
    const a0 = a + SPEEDOMETER_DARK_CFG.gapDeg / 2;
    const a1 = a + SPEEDOMETER_DARK_CFG.angleStep - SPEEDOMETER_DARK_CFG.gapDeg / 2;
    for (let ring = 0; ring < SPEEDOMETER_DARK_CFG.ringSteps; ring++) {
      const r0 = SPEEDOMETER_DARK_CFG.rInner + ring * ringPitch + SPEEDOMETER_DARK_CFG.gapR / 2;
      const r1 = SPEEDOMETER_DARK_CFG.rInner + (ring + 1) * ringPitch - SPEEDOMETER_DARK_CFG.gapR / 2;
      const [x00, y00] = speedometerPolar(a0, r0);
      const [x01, y01] = speedometerPolar(a1, r0);
      const [x11, y11] = speedometerPolar(a1, r1);
      const [x10, y10] = speedometerPolar(a0, r1);
      const poly = document.createElementNS(SPEEDOMETER_NS, 'path');
      poly.setAttribute('d', `M ${x00} ${y00} L ${x01} ${y01} L ${x11} ${y11} L ${x10} ${y10} Z`);
      poly.setAttribute('fill', '#0d2027');
      cellsG.appendChild(poly);
      cells.push({ el: poly, angle: a, ringT: ring / (SPEEDOMETER_DARK_CFG.ringSteps - 1) });
    }
  }

  const widget = {
    host, root, valueEl, core, cellsG, rimTrack, rimFg, capStart, capEnd,
    cells, totalAngle, current: 0, target: 0, raf: null,
    renderFn: speedometerRenderWidgetDark,
  };

  widget.root.style.setProperty('--zoneA', 'rgb(70,72,78)');
  widget.root.style.setProperty('--zoneB', 'rgb(15,15,18)');
  widget.root.style.setProperty('--gauge-core-border-bg', 'linear-gradient(180deg, rgb(70,72,78) 0%, rgb(70,72,78) 30%, rgb(15,15,18) 100%)');
  widget.rimTrack.setAttribute('d', speedometerArcPath(SPEEDOMETER_DARK_CFG.startA, SPEEDOMETER_DARK_CFG.endA, SPEEDOMETER_DARK_CFG.rOuter + 12));

  const [capStartX0, capStartY0] = speedometerPolar(SPEEDOMETER_DARK_CFG.startA, SPEEDOMETER_DARK_CFG.rInner);
  const [capStartX1, capStartY1] = speedometerPolar(SPEEDOMETER_DARK_CFG.startA, SPEEDOMETER_DARK_CFG.rOuter + 12);
  widget.capStart.setAttribute('x1', capStartX0);
  widget.capStart.setAttribute('y1', capStartY0);
  widget.capStart.setAttribute('x2', capStartX1);
  widget.capStart.setAttribute('y2', capStartY1);

  const [capEndX0, capEndY0] = speedometerPolar(SPEEDOMETER_DARK_CFG.endA, SPEEDOMETER_DARK_CFG.rInner);
  const [capEndX1, capEndY1] = speedometerPolar(SPEEDOMETER_DARK_CFG.endA, SPEEDOMETER_DARK_CFG.rOuter + 12);
  widget.capEnd.setAttribute('x1', capEndX0);
  widget.capEnd.setAttribute('y1', capEndY0);
  widget.capEnd.setAttribute('x2', capEndX1);
  widget.capEnd.setAttribute('y2', capEndY1);

  widget.root.dataset.speedometerId = safeId;
  speedometerWidgets.set(hostId, widget);
  return widget;
}

function speedometerRenderWidgetDark(widget, value) {
  if (!widget) return;
  const v = Math.max(SPEEDOMETER_DARK_CFG.minV, Math.min(SPEEDOMETER_DARK_CFG.maxV, Number(value || 0)));
  const a = SPEEDOMETER_DARK_CFG.startA + ((v - SPEEDOMETER_DARK_CFG.minV) / (SPEEDOMETER_DARK_CFG.maxV - SPEEDOMETER_DARK_CFG.minV)) * (SPEEDOMETER_DARK_CFG.endA - SPEEDOMETER_DARK_CFG.startA);
  const zone = speedometerZoneFor(v);
  const totalAngle = widget.totalAngle || (SPEEDOMETER_DARK_CFG.endA - SPEEDOMETER_DARK_CFG.startA);

  const zoneA = `rgb(${Math.round(zone.c0[0])},${Math.round(zone.c0[1])},${Math.round(zone.c0[2])})`;
  const zoneB = `rgb(${Math.round(zone.c1[0])},${Math.round(zone.c1[1])},${Math.round(zone.c1[2])})`;
  widget.root.style.setProperty('--zoneA', zoneA);
  widget.root.style.setProperty('--zoneB', zoneB);
  widget.root.style.setProperty('--gauge-core-border-bg', `linear-gradient(180deg, ${zoneA} 0%, ${zoneA} 30%, ${zoneB} 100%)`);

  widget.cells.forEach(cell => {
    if (cell.angle <= a) {
      const t = (cell.angle - SPEEDOMETER_DARK_CFG.startA) / totalAngle;
      const clamped = Math.max(0, Math.min(1, t));
      const eased = speedometerEaseSplit(1 - clamped);
      const base = [
        speedometerLerp(zone.c0[0], zone.c1[0], eased),
        speedometerLerp(zone.c0[1], zone.c1[1], eased),
        speedometerLerp(zone.c0[2], zone.c1[2], eased),
      ];
      const factor = Math.max(0, Math.min(1, cell.ringT));
      const curved = Math.pow(factor, 1.6);
      const floor = 0.28;
      const eff = floor + curved * (1 - floor);
      const dr = 18, dg = 34, db = 40;
      cell.el.setAttribute('fill', `rgb(${Math.round(speedometerLerp(dr, base[0], eff))},${Math.round(speedometerLerp(dg, base[1], eff))},${Math.round(speedometerLerp(db, base[2], eff))})`);
      cell.el.setAttribute('filter', `url(#glow-${widget.root.dataset.speedometerId})`);
    } else {
      cell.el.setAttribute('fill', '#0d2027');
      cell.el.removeAttribute('filter');
    }
  });

  const activeSteps = Math.floor((a - SPEEDOMETER_DARK_CFG.startA) / SPEEDOMETER_DARK_CFG.angleStep);
  const rimEdge = activeSteps >= 0 ? Math.min(SPEEDOMETER_DARK_CFG.endA, SPEEDOMETER_DARK_CFG.startA + (activeSteps + 1) * SPEEDOMETER_DARK_CFG.angleStep) : SPEEDOMETER_DARK_CFG.startA;
  widget.rimFg.setAttribute('d', speedometerArcPath(SPEEDOMETER_DARK_CFG.startA, rimEdge, SPEEDOMETER_DARK_CFG.rOuter + 12));

  widget.valueEl.textContent = String(Math.round(v));
  widget.core.style.boxShadow = `0 0 24px 4px rgba(${Math.round(zone.c0[0])},${Math.round(zone.c0[1])},${Math.round(zone.c0[2])},0.5)`;
}

function speedometerAnimate(hostId) {
  const widget = speedometerWidgets.get(hostId);
  if (!widget) return;
  widget.current += (widget.target - widget.current) * 0.12;
  if (Math.abs(widget.target - widget.current) < 0.15) widget.current = widget.target;
  (widget.renderFn || speedometerRenderWidget)(widget, widget.current);
  if (widget.current !== widget.target) {
    widget.raf = requestAnimationFrame(() => speedometerAnimate(hostId));
  } else {
    widget.raf = null;
  }
}

function speedometerRenderHost(hostId, percent, options = {}) {
  const host = document.getElementById(hostId);
  if (!host) return;
  const value = Math.max(SPEEDOMETER_CFG.minV, Math.min(SPEEDOMETER_CFG.maxV, Number(percent || 0)));
  const title = options.title || '';
  const subtitle = options.subtitle || '';
  const isDark = document.body.classList.contains('theme-dark');
  host.innerHTML = `
    ${title ? `<div class="gauge-head"><strong>${title}</strong><span style="color:var(--muted); font-size:0.78rem; text-transform:uppercase; letter-spacing:0.05em;">${subtitle}</span></div>` : ''}
    ${speedometerBuildMarkup(hostId, value)}
  `;
  const build = isDark ? speedometerBuildWidgetDark : speedometerBuildWidget;
  const widget = build(hostId);
  const config = isDark ? SPEEDOMETER_DARK_CFG : SPEEDOMETER_CFG;
  (widget.renderFn || speedometerRenderWidget)(widget, config.minV);
  widget.current = config.minV;
  widget.target = value;
  if (!widget.raf) {
    widget.raf = requestAnimationFrame(() => speedometerAnimate(hostId));
  }
}

function renderGaugeCard(hostId, title, percent, color, subtitle, centerText) {
  speedometerRenderHost(hostId, percent, { title, subtitle });
}

function renderYearHoverGauge(value, label, subtitle, contextLabel) {
  const host = document.getElementById('yearHoverGauge');
  if (!host) return;
  const isDark = document.body.classList.contains('theme-dark');
  const build = isDark ? speedometerBuildWidgetDark : speedometerBuildWidget;
  if (host.dataset.shellReady !== '1') {
    host.dataset.shellReady = '1';
    host.innerHTML = speedometerBuildMarkup('yearHoverGauge', value || 0);
  }
  const widget = speedometerWidgets.get('yearHoverGauge') || build('yearHoverGauge');
  (widget.renderFn || speedometerRenderWidget)(widget, value || 0);
  const context = document.getElementById('yearGaugeContext');
  if (context) {
    context.textContent = contextLabel;
  }
}

function ensureYearHoverGaugeShell() {
  const host = document.getElementById('yearHoverGauge');
  if (!host || host.dataset.shellReady === '1') return;
  renderYearHoverGauge(
    DATA.meta.year_average || 0,
    'Current year',
    'Average across classes',
    'Hover the year timeline to preview the selected period. Leave the graph to return to the current year average.'
  );
}

function resetYearHoverGauge(animate = true) {
  yearGaugeHoverIndex = null;
  renderYearHoverGauge(
    DATA.meta.year_average || 0,
    'Current year',
    'Average across classes',
    'Hover the year timeline to preview the selected period. Leave the graph to return to the current year average.'
  );
}

function updateYearHoverGauge(value, label) {
  renderYearHoverGauge(value || 0, label, 'Average across classes', `Hovering ${label}.`);
}

function renderRowList(hostId, rows, emptyText, jumpMode = null) {
  const host = document.getElementById(hostId);
  if (!rows.length) {
    host.innerHTML = `<div class="empty">${emptyText}</div>`;
    return;
  }
  host.innerHTML = rows.map((row) => {
    const jumpAttrs = jumpMode === 'class'
      ? `data-jump-class="${row.classid}"`
      : jumpMode === 'category'
      ? `data-jump-class="${row.classid}" data-jump-category="${row.name || row.category}"`
      : '';
    return `
      <div class="row" ${jumpAttrs}>
        <div>
          <strong>${row.title || row.short_name || row.name}</strong>
          <span>${row.subtitle || row.class_name || ''}</span>
        </div>
        <div class="${toneClass(row.status)}">${formatPct(row.value !== undefined ? row.value : row.average)}</div>
      </div>
    `;
  }).join('');

  host.querySelectorAll('[data-jump-class]').forEach((node) => {
    node.style.cursor = 'pointer';
    node.addEventListener('click', () => {
      jumpToClass(node.dataset.jumpClass, node.dataset.jumpCategory || '');
    });
  });
}

function renderYearlyNotes() {
  const rows = [
    {
      title: 'Year timeline',
      subtitle: 'Each line shows one class. The dark line is the average across all tracked classes.',
      value: DATA.meta.year_average,
      status: 'strong',
    },
    {
      title: `Tracked classes: ${DATA.meta.tracked_classes}`,
      subtitle: `Current quarter average is ${formatPct(DATA.meta.quarter_average)}.`,
      value: DATA.meta.quarter_average,
      status: 'strong',
    },
    {
      title: `${DATA.overview.classes_below_threshold} classes are below threshold`,
      subtitle: 'Use Watchlist to jump directly to classes or categories that are under target.',
      value: THRESHOLD,
      status: 'attention',
    },
  ];
  renderRowList('yearlyNotes', rows, 'No yearly notes are available.');
}

function renderDashboardHighlights() {
  

  const preview = DATA.attention_summary.attention_classes.slice(0, 4).map((item) => ({
    classid: item.classid,
    title: item.title,
    subtitle: item.reason,
    value: item.value,
    status: item.status,
  }));
  renderRowList(
    'dashboardAttentionPreview',
    preview,
    'No classes currently need attention.',
    'class'
  );
}

function renderStats() {
  renderGaugeCard('quarterGauge', 'Quarter average', DATA.meta.quarter_average || 0, '#204f9e', DATA.meta.term || 'Current term', formatPct(DATA.meta.quarter_average));
  renderGaugeCard('yearGauge', 'Year average', DATA.meta.year_average || 0, '#173b76', DATA.meta.year || 'School year', formatPct(DATA.meta.year_average));
}

function polarToCartesian(cx, cy, radius, angle) {
  return {
    x: cx + Math.cos(angle) * radius,
    y: cy + Math.sin(angle) * radius,
  };
}

function describeGaugeArc(cx, cy, radius, startAngle, endAngle) {
  const start = polarToCartesian(cx, cy, radius, startAngle);
  const end = polarToCartesian(cx, cy, radius, endAngle);
  const largeArcFlag = endAngle - startAngle > Math.PI ? 1 : 0;
  return `M ${start.x.toFixed(3)} ${start.y.toFixed(3)} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${end.x.toFixed(3)} ${end.y.toFixed(3)}`;
}

function buildSegmentedArcSvg(percent, color, caption = '', label = '') {
  const safeColor = color || '#204f9e';
  const clamped = Math.max(0, Math.min(100, percent || 0));
  const safeCaption = caption || `${Math.round(clamped)}%`;
  const safeLabel = label || 'AVERAGE';
  return `
    <canvas class="gauge-canvas" width="300" height="180" data-logical-width="300" data-logical-height="180" data-gauge-shape="semicircle" data-gauge-value="${clamped}" data-gauge-color="${safeColor}" data-gauge-caption="${safeCaption}" data-gauge-label="${safeLabel}" aria-hidden="true"></canvas>
  `;
}

function buildSpeedometerSvg(clamped, color) {
  return buildSegmentedArcSvg(clamped, color);
}

function safeGaugeId(value) {
  return String(value).replace(/[^a-z0-9_-]/gi, '_');
}

function colorForGauge(value) {
  return value >= 95 ? '#4caf50' : value >= 85 ? '#f59e0b' : '#ef4444';
}

function hexToRgb(hex) {
  const clean = String(hex).replace('#', '').trim();
  if (clean.length !== 6) return null;
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

function hexToRgba(color, alpha = 0.15) {
  // Handle HSL colors: "hsl(h s% l%)" or "hsl(h, s%, l%)"
  if (String(color).toLowerCase().startsWith('hsl')) {
    // Convert "hsl(...)" to "hsla(.../ alpha)"
    const hslStr = String(color).trim();
    return hslStr.replace(/\)$/, `/ ${alpha})`).replace('hsl(', 'hsla(');
  }
  
  // Handle hex colors: "#ffffff"
  const rgb = hexToRgb(color);
  if (!rgb) return color;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

function tintColor(hex, amount) {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const mix = (channel) => Math.round(channel + (255 - channel) * amount);
  return `rgb(${mix(rgb.r)}, ${mix(rgb.g)}, ${mix(rgb.b)})`;
}

function setGaugeNeedle(path, dot, percent) {
  if (!path || !dot) return;
  const length = path.getTotalLength();
  const visiblePercent = Math.max(0, Math.min(100, percent - 1.5));
  const offset = length - (visiblePercent / 100) * length;
  path.style.strokeDasharray = `${length}`;
  path.style.strokeDashoffset = `${offset}`;
  const point = path.getPointAtLength((visiblePercent / 100) * length);
  dot.setAttribute('cx', point.x);
  dot.setAttribute('cy', point.y);
}

function animateGaugeNeedle(path, dot, targetPercent, duration = 260) {
  if (!path || !dot) return;
  const length = path.getTotalLength();
  const targetOffset = length - (Math.max(0, Math.min(100, targetPercent - 1.5)) / 100) * length;
  const startOffset = parseFloat(path.style.strokeDashoffset);
  const from = Number.isFinite(startOffset) ? startOffset : length;

  if (gaugeAnimFrame) cancelAnimationFrame(gaugeAnimFrame);

  if (duration <= 0 || Math.abs(from - targetOffset) < 0.5) {
    setGaugeNeedle(path, dot, targetPercent);
    return;
  }

  const start = performance.now();
  function frame(now) {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const current = from + (targetOffset - from) * eased;
    path.style.strokeDasharray = `${length}`;
    path.style.strokeDashoffset = `${current}`;
    const traveled = Math.max(0, Math.min(length, length - current));
    const point = path.getPointAtLength(traveled);
    dot.setAttribute('cx', point.x);
    dot.setAttribute('cy', point.y);
    if (t < 1) {
      gaugeAnimFrame = requestAnimationFrame(frame);
    } else {
      gaugeAnimFrame = null;
    }
  }
  gaugeAnimFrame = requestAnimationFrame(frame);
}

function applySpeedometerGauge(hostId, percent) {
  const host = document.getElementById(hostId);
  if (!host) return;
  const canvas = host.querySelector('canvas.gauge-canvas');
  if (!canvas || typeof canvas.getContext !== 'function') return;
  canvas.dataset.gaugeValue = String(percent);
  if (!animatedGaugeValues.has(canvas)) {
    animatedGaugeValues.set(canvas, 0);
  }
  drawSegmentedArcOnCanvas(canvas, animatedGaugeValues.get(canvas), canvas.dataset.gaugeColor || '#204f9e', performance.now() / 1000);
}

function drawSegmentedArcOnCanvas(canvas, percent, color, time = 0) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = Number(canvas.dataset.logicalWidth || 300);
  const h = Number(canvas.dataset.logicalHeight || 180);
  const scaledW = Math.round(w * dpr);
  const scaledH = Math.round(h * dpr);
  if (canvas.width !== scaledW) canvas.width = scaledW;
  if (canvas.height !== scaledH) canvas.height = scaledH;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const shape = canvas.dataset.gaugeShape || 'semicircle';

  if (shape === 'semicircle') {
    drawSemicircleGauge(ctx, canvas, w, h, percent, color, time);
  } else {
    drawCircleGauge(ctx, canvas, w, h, percent, color, time);
  }
}

function drawSemicircleGauge(ctx, canvas, w, h, percent, color, time) {
  const cx = w / 2;
  const cy = h * 0.82;
  const radius = Math.min(w * 0.38, h * 0.65);
  const startAngle = Math.PI;
  const endAngle = 0;
  const totalArc = Math.PI;
  const segmentCount = 30;
  const segmentArc = totalArc / segmentCount;
  const gap = 0.025;
  const safePercent = Math.max(0, Math.min(100, percent || 0));
  const valueColor = color || colorForGauge(safePercent);
  const baseColor = valueColor;

  function valueToAngle(value) {
    return startAngle + (value / 100) * totalArc;
  }

  function drawArcSegment(segStart, segEnd, strokeWidth, strokeColor, alpha, glow) {
    ctx.beginPath();
    ctx.lineWidth = strokeWidth;
    ctx.lineCap = 'round';
    ctx.strokeStyle = strokeColor;
    ctx.globalAlpha = alpha != null ? alpha : 1;
    if (glow) {
      ctx.save();
      ctx.shadowColor = strokeColor;
      ctx.shadowBlur = 12;
    }
    ctx.arc(cx, cy, radius, segStart, segEnd);
    ctx.stroke();
    if (glow) ctx.restore();
    ctx.globalAlpha = 1;
  }

  const lightColor = tintColor(baseColor, 0.35);
  const midColor = tintColor(baseColor, 0.18);

  function makeGradient() {
    const g = ctx.createLinearGradient(cx - radius, cy, cx + radius, cy);
    g.addColorStop(0, lightColor);
    g.addColorStop(0.5, midColor);
    g.addColorStop(1, baseColor);
    return g;
  }

  // Inactive track
  for (let i = 0; i < segmentCount; i++) {
    const segStart = startAngle + i * segmentArc + gap / 2;
    const segEnd = startAngle + (i + 1) * segmentArc - gap / 2;
    drawArcSegment(segStart, segEnd, 7, 'rgba(219,229,242,0.5)', 1);
  }

  // Active fill
  const filledCount = Math.round((safePercent / 100) * segmentCount);
  const gradient = makeGradient();
  for (let i = 0; i < filledCount; i++) {
    const segStart = startAngle + i * segmentArc + gap / 2;
    const segEnd = startAngle + (i + 1) * segmentArc - gap / 2;
    const isLast = i === filledCount - 1;
    const intensity = 0.3 + 0.7 * (i / Math.max(1, segmentCount - 1));
    const pulse = isLast ? 0.5 + 0.5 * Math.sin(time * 4) : 1;
    drawArcSegment(segStart, segEnd, isLast ? 9 : 7, gradient, intensity * pulse, isLast);
  }

  // Subtle glow behind the arc
  const aura = ctx.createRadialGradient(cx, cy - 10, radius * 0.1, cx, cy - 10, radius * 1.1);
  aura.addColorStop(0, hexToRgba(baseColor, 0.04));
  aura.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.save();
  ctx.fillStyle = aura;
  ctx.beginPath();
  ctx.arc(cx, cy - 10, radius * 1.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Tick marks at 0, 25, 50, 75, 100
  const tickValues = [0, 25, 50, 75, 100];
  tickValues.forEach((tick) => {
    const angle = valueToAngle(tick);
    const innerR = radius - 14;
    const outerR = radius + 10;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * innerR, cy + Math.sin(angle) * innerR);
    ctx.lineTo(cx + Math.cos(angle) * outerR, cy + Math.sin(angle) * outerR);
    ctx.strokeStyle = 'rgba(83,103,130,0.5)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    const labelR = radius + 20;
    ctx.fillStyle = 'rgba(83,103,130,0.65)';
    ctx.font = '500 9px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(String(tick), cx + Math.cos(angle) * labelR, cy + Math.sin(angle) * labelR + 2);
  });

  // Center text
  const rawCaption = canvas.dataset.gaugeCaption || '';
  const captionMatch = rawCaption.trim().match(/^-?\d+(?:\.(\d+))?%$/);
  const decimals = captionMatch && captionMatch[1] ? captionMatch[1].length : 0;
  const displayCaption = captionMatch ? `${safePercent.toFixed(decimals)}%` : (rawCaption || `${Math.round(safePercent)}%`);

  ctx.fillStyle = '#162033';
  ctx.font = '700 40px "JetBrains Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(displayCaption, cx, cy - radius + 48);

  ctx.fillStyle = hexToRgba(valueColor, 0.75);
  ctx.font = '400 11px "Space Grotesk", sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText(canvas.dataset.gaugeLabel || 'AVERAGE', cx, cy - radius + 52);
}

function drawCircleGauge(ctx, canvas, w, h, percent, color, time) {
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(w, h) * 0.4;
  const startAngle = Math.PI * 0.75;
  const endAngle = Math.PI * 2.25;
  const totalArc = endAngle - startAngle;
  const majorPortion = 0.2;
  const majorValue = 60;
  const minorCount = 40;
  const majorEndAngle = startAngle + totalArc * majorPortion;
  const minorArc = (totalArc * (1 - majorPortion)) / minorCount;
  const majorGap = 0.02;
  const minorGap = 0.01;
  const safePercent = Math.max(0, Math.min(100, percent || 0));
  const valueColor = colorForGauge(safePercent);
  const baseColor = valueColor;
  const glowColor = valueColor;
  const lightColor = tintColor(baseColor, 0.28);
  const midColor = tintColor(baseColor, 0.12);

  function mapValueToVisual(value) {
    if (value <= majorValue) {
      return (value / majorValue) * (majorPortion * 100);
    }
    return (majorPortion * 100) + ((value - majorValue) / (100 - majorValue)) * ((1 - majorPortion) * 100);
  }

  function valueToAngle(value) {
    return startAngle + totalArc * (mapValueToVisual(value) / 100);
  }

  function drawArcSegment(segStart, segEnd, strokeWidth, strokeColor, alpha = 1, pulse = false, shadow = false) {
    ctx.beginPath();
    ctx.lineWidth = strokeWidth;
    ctx.lineCap = 'butt';
    ctx.strokeStyle = strokeColor;
    ctx.globalAlpha = alpha;
    if (shadow) {
      ctx.save();
      ctx.shadowColor = strokeColor;
      ctx.shadowBlur = 18;
    }
    ctx.arc(cx, cy, radius, segStart, segEnd);
    ctx.stroke();
    if (shadow) ctx.restore();
    ctx.globalAlpha = 1;
  }

  function makeSegmentGradient() {
    const gradient = ctx.createLinearGradient(cx - radius, cy - radius, cx + radius, cy + radius);
    gradient.addColorStop(0, lightColor);
    gradient.addColorStop(0.55, midColor);
    gradient.addColorStop(1, glowColor);
    return gradient;
  }

  drawArcSegment(startAngle + majorGap / 2, majorEndAngle - majorGap / 2, 9, '#dbe5f2', 1);
  for (let i = 0; i < minorCount; i++) {
    const segStart = majorEndAngle + i * minorArc + minorGap / 2;
    const segEnd = majorEndAngle + (i + 1) * minorArc - minorGap / 2;
    drawArcSegment(segStart, segEnd, 8, '#dbe5f2', 1);
  }

  const majorVisual = Math.min(safePercent, majorValue);
  const majorActiveEnd = valueToAngle(majorVisual);
  const majorPulse = safePercent > 0 && safePercent < majorValue;
  drawArcSegment(startAngle + majorGap / 2, majorActiveEnd, majorPulse ? 10 : 9, makeSegmentGradient(), majorPulse ? 0.55 + 0.45 * Math.sin(time * 3.5) : 1, majorPulse, majorPulse);

  if (safePercent > majorValue) {
    const minorProgress = (safePercent - majorValue) / (100 - majorValue);
    const filledMinorCount = Math.round(minorProgress * minorCount);
    for (let i = 0; i < minorCount; i++) {
      const segStart = majorEndAngle + i * minorArc + minorGap / 2;
      const segEnd = majorEndAngle + (i + 1) * minorArc - minorGap / 2;
      const isActive = i < filledMinorCount;
      const isPulse = i === filledMinorCount - 1 && filledMinorCount > 0;
      const intensity = 0.28 + 0.72 * (i / Math.max(1, minorCount - 1));
      if (isActive) {
        drawArcSegment(segStart, segEnd, isPulse ? 12 : 9, makeSegmentGradient(), isPulse ? 0.55 + 0.45 * Math.sin(time * 3.5) : intensity, isPulse, isPulse);
      }
    }
  }

  const aura = ctx.createRadialGradient(cx, cy, radius * 0.18, cx, cy, radius * 1.08);
  aura.addColorStop(0, hexToRgba(glowColor, 0.025));
  aura.addColorStop(0.42, hexToRgba(glowColor, 0.012));
  aura.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.save();
  ctx.fillStyle = aura;
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 1.05, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const rawCaption = canvas.dataset.gaugeCaption || '';
  const percentCaptionMatch = rawCaption.trim().match(/^-?\d+(?:\.(\d+))?%$/);
  const captionDecimals = percentCaptionMatch && percentCaptionMatch[1] ? percentCaptionMatch[1].length : 0;
  const displayCaption = percentCaptionMatch ? `${safePercent.toFixed(captionDecimals)}%` : (rawCaption || `${Math.round(safePercent)}%`);

  ctx.fillStyle = '#162033';
  ctx.font = '700 46px "JetBrains Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(displayCaption, cx, cy + 2);

  ctx.fillStyle = hexToRgba(valueColor, 0.88);
  ctx.font = '400 11px "Space Grotesk", sans-serif';
  ctx.fillText(canvas.dataset.gaugeLabel || 'AVERAGE', cx, cy + 30);
  ctx.globalAlpha = 1;
}

function startGaugePulse() {
  return;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startGaugePulse);
} else {
  startGaugePulse();
}

function populateQuarterNav() {
  const host = document.getElementById('quarterNav');
  host.innerHTML = [1, 2, 3, 4].map((term) => `
    <button class="quarter-btn ${String(term) === String(selectedQuarter) ? 'active' : ''}" data-term="${term}">Q${term}</button>
  `).join('');
  host.querySelectorAll('[data-term]').forEach((button) => {
    button.addEventListener('click', () => {
      selectedQuarter = String(button.dataset.term);
      updateQuarterView();
      if (selectedPeriod === 'quarter') {
        refreshClassAnalytics();
      }
    });
  });
}

function populateAnalyticsClassSelect() {
  const select = document.getElementById('analyticsClassSelect');
  select.innerHTML = DATA.classes.map((item) =>
    `<option value="${item.classid}">${item.short_name}</option>`
  ).join('');
  if (activeClassId) select.value = activeClassId;
}

function categorySourceForClass(item) {
  if (!item) return [];
  if (selectedPeriod === 'year') {
    return item.categories_year || [];
  }
  return (item.categories_by_term && item.categories_by_term[selectedPeriod]) || item.categories || [];
}

function timelineSourceForClass(item) {
  if (!item) return { labels: [], values: [] };
  if (selectedPeriod === 'year') {
    return item.timeline_year || { labels: [], values: [] };
  }
  return (item.timeline_quarters && item.timeline_quarters[selectedPeriod]) || item.timeline_current || { labels: [], values: [] };
}

function populateAnalyticsCategorySelect() {
  const item = findClass(activeClassId) || DATA.classes[0];
  const select = document.getElementById('analyticsCategorySelect');
  const categories = categorySourceForClass(item).filter((cat) => cat.average !== null);
  const optionValues = ['all', ...categories.map((cat) => slug(cat.name))];
  if (!optionValues.includes(selectedCategory)) {
    selectedCategory = 'all';
  }
  select.innerHTML = [`<option value="all">All categories</option>`]
    .concat(categories.map((cat) => `<option value="${slug(cat.name)}">${cat.name}</option>`))
    .join('');
  select.value = selectedCategory;
}

function classMatches(item, query, filter) {
  const quarterCategories = categoriesForGradesQuarter(item);
  const quarterGrade = gradeForGradesQuarter(item);
  const haystack = [
    item.short_name,
    item.name,
    ...quarterCategories.map((cat) => cat.name),
  ].join(' ').toLowerCase();
  const queryMatch = !query || haystack.includes(query);
  const filterMatch = filter === 'all' || statusForClientGrade(quarterGrade) === filter;
  return queryMatch && filterMatch;
}

function statusForClientGrade(value) {
  if (value === null || value === undefined) return 'unknown';
  return value < THRESHOLD ? 'attention' : 'strong';
}

function averageClient(values) {
  const nums = values.filter((value) => value !== null && value !== undefined);
  if (!nums.length) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function bindCategoryAccordions(host, openedCategory = '') {
  host.querySelectorAll('.category-head').forEach((button) => {
    const card = button.closest('.category-card');
    if (!card) return;
    if (!openedCategory && button.dataset.accordionTarget === '0') {
      card.classList.add('open');
    }
    button.addEventListener('click', () => {
      card.classList.toggle('open');
    });
  });
}

function renderClassList() {
  const host = document.getElementById('gradesClassList');
  const query = document.getElementById('gradesSearchInput').value.trim().toLowerCase();
  const filtered = DATA.classes.filter((item) => {
    const quarterGrade = gradeForGradesQuarter(item);
    const haystack = [item.short_name, item.name].join(' ').toLowerCase();
    return !query || haystack.includes(query);
  });

  if (!filtered.length) {
    host.innerHTML = '<div class="empty" style="padding:12px; color:var(--muted);">No classes match this search.</div>';
    return;
  }

  if (!filtered.some((item) => item.classid === activeClassId)) {
    activeClassId = filtered[0].classid;
  }

  host.innerHTML = filtered.map((item) => {
    const quarterGrade = gradeForGradesQuarter(item);
    const quarterStatus = statusForClientGrade(quarterGrade);
    return `
      <div class="grades-class-item ${quarterStatus} ${item.classid === activeClassId ? 'active' : ''}" data-classid="${item.classid}">
        <div class="grades-class-name">${item.short_name}</div>
        <div class="grades-class-average">${formatPct(quarterGrade)}</div>
      </div>
    `;
  }).join('');

  host.querySelectorAll('.grades-class-item').forEach((item) => {
    item.addEventListener('click', () => {
      activeClassId = item.dataset.classid;
      renderClassList();
      renderClassDetail();
      if (window.innerWidth <= 768) closeMobileSidebar();
    });
  });

  renderClassDetail();
}

function renderClassAnalyticsControls() {
  populateAnalyticsClassSelect();
  populateAnalyticsCategorySelect();
  document.getElementById('analyticsPeriodSelect').value = selectedPeriod;
}

function insightPeriodLabel() {
  return selectedPeriod === 'year' ? 'Year' : termLabel(selectedPeriod);
}

function quarterBarColor(value) {
  if (value === null || value === undefined) return '#c5d0de';
  if (value < THRESHOLD) return '#b42318';
  if (value >= 95) return '#1d6b4a';
  return '#204f9e';
}

function updateClassQuarterChart(item) {
  if (chartRefs.classQuarterInsight) {
    chartRefs.classQuarterInsight.destroy();
    chartRefs.classQuarterInsight = null;
  }
  const canvas = document.getElementById('classQuarterChart');
  if (!canvas || !item || typeof Chart === 'undefined') return;

  const labels = ['Q1', 'Q2', 'Q3', 'Q4'];
  const values = labels.map((label) => item.quarter_values[label]);
  const colors = values.map((value) => quarterBarColor(value));
  const currentQuarter = termLabel(DATA.analytics.quarterly.current_term);
  const bounds = chartBounds(values.filter((value) => value !== null && value !== undefined));

  chartRefs.classQuarterInsight = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: colors,
        borderColor: labels.map((label) => (label === currentQuarter ? '#132033' : 'transparent')),
        borderWidth: labels.map((label) => (label === currentQuarter ? 2 : 0)),
        borderRadius: 6,
        maxBarThickness: 44,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false, events: [] },
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${formatPct(ctx.parsed.y)}`,
          },
        },
      },
      scales: {
        y: {
          min: bounds.min,
          max: bounds.max,
          grid: { color: '#e4eaf1' },
          ticks: {
            callback: (value) => `${value}%`,
            font: { size: 10 },
          },
        },
        x: {
          grid: { display: false },
          ticks: { font: { size: 11, weight: '600' } },
        },
      },
      onClick: (_, elements) => {
        if (!elements.length) return;
        const term = String(elements[0].index + 1);
        selectedPeriod = term;
        document.getElementById('analyticsPeriodSelect').value = term;
        renderClassAnalyticsControls();
        refreshClassAnalytics();
      },
    },
  });
}

function renderClassInsightPanel(item) {
  const host = document.getElementById('classInsightPanel');
  if (!host || !item) return;

  if (chartRefs.classQuarterInsight) {
    chartRefs.classQuarterInsight.destroy();
    chartRefs.classQuarterInsight = null;
  }

  const categories = categorySourceForClass(item).filter((cat) => cat.average !== null && cat.average !== undefined);
  const periodGrade = selectedPeriod === 'year'
    ? item.year_average
    : (item.quarter_values[termLabel(selectedPeriod)] ?? null);
  const periodStatus = statusForClientGrade(periodGrade);
  const strongestCategory = [...categories].sort((a, b) => b.average - a.average)[0];
  const weakestCategory = [...categories].sort((a, b) => a.average - b.average)[0];
  const belowCount = categories.filter((cat) => cat.status === 'attention').length;

  host.innerHTML = `
    <div class="class-insight-top">
      <div>
        <h3 class="class-insight-name">${item.short_name}</h3>
        <p class="class-insight-meta">${item.name}</p>
      </div>
      <div class="class-insight-hero ${periodStatus}">
        <span class="class-insight-hero-value ${toneClass(periodStatus)}">${formatPct(periodGrade)}</span>
        <span class="class-insight-hero-label">${insightPeriodLabel()} average</span>
      </div>
    </div>
    <div class="class-insight-metrics">
      <div class="insight-metric">
        <span>Year average</span>
        <strong class="${toneClass(statusForClientGrade(item.year_average))}">${formatPct(item.year_average)}</strong>
      </div>
      <div class="insight-metric">
        <span>Strongest category</span>
        <strong>${strongestCategory ? `${strongestCategory.name} · ${formatPct(strongestCategory.average)}` : 'N/A'}</strong>
      </div>
      <div class="insight-metric">
        <span>Weakest category</span>
        <strong>${weakestCategory ? `${weakestCategory.name} · ${formatPct(weakestCategory.average)}` : 'N/A'}</strong>
      </div>
      <div class="insight-metric">
        <span>Below ${THRESHOLD}%</span>
        <strong>${belowCount} categor${belowCount === 1 ? 'y' : 'ies'}</strong>
      </div>
    </div>
    <div class="class-insight-chart-wrap">
      <span class="class-insight-chart-label">Quarter averages</span>
      <div class="class-insight-chart"><canvas id="classQuarterChart" aria-label="Quarterly averages bar chart"></canvas></div>
    </div>
  `;

  updateClassQuarterChart(item);
}

function renderClassDetail(scrollCategory = '') {
  const item = findClass(activeClassId);
  const host = document.getElementById('classDetail');
  if (!item) {
    host.innerHTML = '<div class="empty">Select a class to inspect it.</div>';
    return;
  }
  const categories = categoriesForGradesQuarter(item);
  const quarterGrade = gradeForGradesQuarter(item);
  const quarterStatus = statusForClientGrade(quarterGrade);
  const letter = letterForGradesQuarter(item);

  host.innerHTML = `
    <div class="grades-class-header">
      <div>
        <h2>${item.name}</h2>
        <div class="grades-class-meta">
          <span class="status-pill ${quarterStatus}">${formatPct(quarterGrade)} · Q${selectedGradesQuarter}</span>
          
        </div>
      </div>
      <button class="btn" id="openClassAnalytics" type="button">Analytics →</button>
    </div>

    <div class="category-list">
      ${categories.length ? categories.map((cat, index) => `
        <section class="category-card ${cat.status}" id="cat-${item.classid}-${slug(cat.name)}">
          <button class="category-head" type="button" data-accordion-target="${index}">
            <div class="category-title">
              <span class="category-caret">›</span>
              <div>
                <strong>${cat.name}</strong>
              </div>
            </div>
            <div class="${toneClass(cat.status)}">${formatPct(cat.average)}</div>
          </button>
          <div class="category-body">
          ${cat.assignments.length ? `
            <div class="assignment-scroll">
            <table class="grades-table">
              <thead>
                <tr><th>Assignment</th><th>Pts</th><th>Max</th><th>%</th><th>Due</th></tr>
              </thead>
              <tbody>
                ${cat.assignments.map((asn) => `
                  <tr class="${asn.percent !== null && asn.percent < THRESHOLD ? 'low' : ''}">
                    <td>${asn.name}</td>
                    <td class="num">${asn.score ?? ''}</td>
                    <td class="num">${asn.max ?? ''}</td>
                    <td class="num">${formatPct(asn.percent)}</td>
                    <td>${asn.due || ''}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
            </div>
          ` : '<div class="empty" style="padding:12px;">No graded assignments yet.</div>'}
          </div>
        </section>
      `).join('') : `<div class="empty">No category data is available for this class in Q${selectedGradesQuarter}.</div>`}
    </div>
  `;

  document.getElementById('openClassAnalytics').addEventListener('click', () => {
    showSection('analytics');
    showView('classview');
    activeClassId = item.classid;
    selectedPeriod = String(selectedGradesQuarter);
    renderClassAnalyticsControls();
    refreshClassAnalytics();
  });

  if (scrollCategory) {
    const target = document.getElementById(`cat-${item.classid}-${slug(scrollCategory)}`);
    if (target) {
      target.classList.add('open');
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
  bindCategoryAccordions(host, scrollCategory);
}

function jumpToClass(classid, category = '') {
  activeClassId = classid;
  if (document.getElementById('analyticsClassSelect')) {
    document.getElementById('analyticsClassSelect').value = classid;
  }
  showSection('grades');
  renderClassList();
  renderClassDetail(category);
  if (window.innerWidth <= 768) closeMobileSidebar();
}

function showSection(sectionId) {
  SECTION_IDS.forEach((id) => {
    document.getElementById(id).classList.toggle('active', id === sectionId);
    document.querySelector(`.tab[data-section="${id}"]`).classList.toggle('active', id === sectionId);
  });
  
  const gradesDropdown = document.getElementById('gradesDropdown');
  const gradesSearch = document.getElementById('gradesSearchWrap');
  const gradesTabText = document.getElementById('gradesTabText');
  
  const sidebarToggle = document.getElementById('sidebarToggle');
  
  if (sectionId === 'grades') {
    // Auto-expand sidebar if collapsed to show the dropdown
    if (document.body.classList.contains('sidebar-collapsed')) {
      document.body.classList.remove('sidebar-collapsed');
      if (sidebarToggle) {
        sidebarToggle.setAttribute('aria-label', 'Collapse sidebar');
        sidebarToggle.setAttribute('aria-expanded', 'true');
      }
    }
    // Hide the toggle button while Grades is open
    if (sidebarToggle) {
      sidebarToggle.style.display = 'none';
    }
    gradesDropdown.classList.add('open');
    gradesSearch.classList.add('visible');
    renderClassList();
  } else {
    // Show the toggle button for other sections
    if (sidebarToggle) {
      sidebarToggle.style.display = '';
    }
    gradesDropdown.classList.remove('open');
    gradesSearch.classList.remove('visible');
  }
  
  if (sectionId === 'analytics') initCharts();
}

function showView(name, quarterOverride = null) {
  if (quarterOverride !== null && quarterOverride !== undefined) {
    selectedQuarter = String(quarterOverride);
  }
  document.querySelectorAll('.subtab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === name);
  });
  document.querySelectorAll('.analytics-view').forEach((view) => {
    view.classList.toggle('active', view.id === `view-${name}`);
  });
  if (name === 'quarterly') {
    updateQuarterView();
  }
  if (name === 'classview') {
    renderClassAnalyticsControls();
    refreshClassAnalytics();
  }
  if (name === 'yearly') {
    resetYearHoverGauge();
  }
}

function linePointStyle(color) {
  return {
    pointRadius: 0,
    pointHitRadius: 12,
    pointHoverRadius: 4,
    pointHoverBackgroundColor: color,
    pointHoverBorderColor: color,
    pointHoverBorderWidth: 0,
  };
}

function makeLineDatasets(series, averageLabel) {
  const datasets = [{
    label: averageLabel,
    data: series.average,
    borderColor: '#101828',
    backgroundColor: 'rgba(16, 24, 40, 0.15)',
    fill: 'origin',
    tension: 0.25,
    borderWidth: 3,
    ...linePointStyle('#101828'),
  }];
  series.classes.forEach((item) => {
    datasets.push({
      label: item.short_name,
      data: item.values,
      borderColor: item.color,
      backgroundColor: hexToRgba(item.color, 0.25),
      fill: 'origin',
      tension: 0.18,
      borderWidth: 2,
      hidden: true,
      ...linePointStyle(item.color),
    });
  });
  return datasets;
}

function attachLineChartMeta(chart, series) {
  if (!chart) return;
  chart.$timelinePoints = series && series.points ? series.points : null;
  chart.$classSeries = series && series.classes ? series.classes : [];
}

function formatTimelineDate(label) {
  if (!label) return 'Selected date';
  const raw = String(label);
  const dt = new Date(`${raw}T12:00:00`);
  if (Number.isNaN(dt.getTime())) return raw;
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function assignmentScoreLabel(asn) {
  if (asn.percent !== null && asn.percent !== undefined) return formatPct(asn.percent);
  if (asn.score != null && asn.max != null && asn.max !== '') return `${asn.score} / ${asn.max}`;
  return 'N/A';
}

function assignmentRowClass(asn) {
  if (asn.percent === null || asn.percent === undefined) return '';
  if (asn.percent < THRESHOLD) return 'attention';
  if (asn.percent >= 95) return 'strong';
  return '';
}

function hideTimelinePointPopup() {
  const popup = document.getElementById('timelinePointPopup');
  if (!popup) return;
  popup.classList.remove('is-visible');
  popup.hidden = true;
  popup.innerHTML = '';
  timelinePopupState = { chart: null, index: null, datasetIndex: null };
}

function bindTimelinePopupReposition() {
  if (timelinePopupScrollBound) return;
  timelinePopupScrollBound = true;
  const reposition = () => repositionTimelinePointPopup();
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);
}

function repositionTimelinePointPopup() {
  const { chart, index, datasetIndex } = timelinePopupState;
  const popup = document.getElementById('timelinePointPopup');
  if (!popup || popup.hidden || !chart || index === null || datasetIndex === null) return;

  const meta = chart.getDatasetMeta(datasetIndex);
  const point = meta && meta.data ? meta.data[index] : null;
  if (!point) return;

  const props = point.getProps(['x', 'y'], true);
  const canvasRect = chart.canvas.getBoundingClientRect();
  popup.style.left = `${canvasRect.left + props.x}px`;
  popup.style.top = `${canvasRect.top + props.y}px`;
}

function buildTimelinePopupRows(assignments) {
  if (!assignments.length) {
    return '<p class="timeline-popup-empty">No assignments were due on this date.</p>';
  }

  const grouped = {};
  assignments.forEach((asn) => {
    const key = asn.class || '';
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(asn);
  });

  const groupKeys = Object.keys(grouped);
  const showClassHeaders = groupKeys.length > 1 || (groupKeys[0] && groupKeys[0] !== '');

  return groupKeys.map((className) => `
    <section class="timeline-popup-group">
      ${showClassHeaders && className ? `<div class="timeline-popup-class">${className}</div>` : ''}
      <ul class="timeline-popup-list">
        ${grouped[className].map((asn) => `
          <li class="timeline-popup-row ${assignmentRowClass(asn)}">
            <div class="timeline-popup-row-main">
              <span class="timeline-popup-asn">${asn.name}</span>
              <span class="timeline-popup-cat">${asn.category}</span>
            </div>
            <strong>${assignmentScoreLabel(asn)}</strong>
          </li>
        `).join('')}
      </ul>
    </section>
  `).join('');
}

function showTimelinePointPopup(chart, element) {
  const popup = document.getElementById('timelinePointPopup');
  if (!popup || !chart.$timelinePoints) return;

  const index = element.index;
  const datasetIndex = element.datasetIndex;
  let assignments = chart.$timelinePoints[index] || [];

  if (datasetIndex > 0 && chart.$classSeries && chart.$classSeries.length) {
    const classMeta = chart.$classSeries[datasetIndex - 1];
    if (classMeta) {
      assignments = assignments.filter((asn) => asn.classid === classMeta.classid);
    }
  }

  const dateLabel = chart.data.labels[index];
  const runningAverage = chart.data.datasets[datasetIndex].data[index];
  const seriesLabel = chart.data.datasets[datasetIndex].label;
  const avgText = runningAverage !== null && runningAverage !== undefined
    ? `${formatPct(runningAverage)} running avg`
    : 'Running average unavailable';

  popup.innerHTML = `
    <div class="timeline-point-popup-card">
      <div class="timeline-point-popup-arrow"></div>
      <header class="timeline-point-popup-head">
        <div>
          <strong>${formatTimelineDate(dateLabel)}</strong>
          <span>${seriesLabel} · ${avgText}</span>
        </div>
        <button type="button" class="timeline-point-popup-close" aria-label="Close">&times;</button>
      </header>
      <div class="timeline-point-popup-body">${buildTimelinePopupRows(assignments)}</div>
    </div>
  `;

  popup.hidden = false;
  popup.classList.add('is-visible');
  bindTimelinePopupReposition();
  timelinePopupState = { chart, index, datasetIndex };
  repositionTimelinePointPopup();

  popup.querySelector('.timeline-point-popup-close').addEventListener('click', (event) => {
    event.stopPropagation();
    hideTimelinePointPopup();
  });

}

function handleTimelinePointClick(event, elements, chart) {
  if (!elements.length) {
    hideTimelinePointPopup();
    return;
  }
  const element = elements[0];
  const samePoint = timelinePopupState.chart === chart
    && timelinePopupState.index === element.index
    && timelinePopupState.datasetIndex === element.datasetIndex;
  if (samePoint) {
    hideTimelinePointPopup();
    return;
  }
  showTimelinePointPopup(chart, element);
}

function makeLineChart(targetId, labels, datasets, options = {}) {
  const ctx = document.getElementById(targetId);
  const bounds = chartBounds(flattenDatasetValues(datasets));
  const chart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        filler: { propagate: true },
        legend: {
          display: options.legend !== false,
          position: 'bottom',
        },
      },
      onClick: (event, _elements, chart) => {
        const hit = chart.getElementsAtEventForMode(event, 'nearest', { intersect: true }, false);
        handleTimelinePointClick(event, hit, chart);
        if (options.onClick) options.onClick(event, hit, chart);
      },
      onHover: options.onHover,
      scales: {
        y: {
          min: bounds.min,
          max: Math.max(bounds.max, 100),
          grid: { color: '#dbe3ee' },
        },
        x: {
          grid: { display: false },
          ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12 },
        }
      }
    }
  });
  attachLineChartMeta(chart, {
    points: options.timelinePoints,
    classes: options.classSeries,
  });
  if (options.onLeave) {
    ctx.addEventListener('mouseleave', options.onLeave);
  }
  return chart;
}

function makeBarChart(targetId, labels, values, colors, horizontal = false, options = {}) {
  const ctx = document.getElementById(targetId);
  const bounds = chartBounds(values);
  return new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: colors,
        borderRadius: 6,
      }]
    },
    options: {
      indexAxis: horizontal ? 'y' : 'x',
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false, events: [] } },
      onClick: options.onClick,
      scales: horizontal ? {
        x: {
          min: bounds.min,
          max: bounds.max,
          grid: { color: '#dbe3ee' },
        },
        y: {
          grid: { display: false },
          ticks: { autoSkip: false },
        }
      } : {
        y: {
          min: bounds.min,
          max: bounds.max,
          grid: { color: '#dbe3ee' },
        },
        x: {
          grid: { display: false },
          ticks: { autoSkip: false, maxRotation: 45, minRotation: 0 },
        }
      }
    }
  });
}

function renderWatchlist() {
  const host = document.getElementById('watchlistGrid');
  if (!DATA.watchlist.length) {
    host.innerHTML = '<div class="empty">Nothing is on the watchlist right now.</div>';
    return;
  }
  host.innerHTML = DATA.watchlist.map((item) => `
    <div class="watch-card ${item.status}" data-jump-class="${item.classid}">
      <div class="watch-head">
        <div>
          <span class="watch-status ${item.status}">${item.status === 'attention' ? 'Needs attention' : 'Watch'}</span>
          <h3>${item.title}</h3>
          <div class="watch-subtitle">${item.subtitle}</div>
        </div>
        <div class="watch-grade ${toneClass(item.status)}">${formatPct(item.value)}</div>
      </div>
      <div class="watch-reason">${item.reason}</div>
      ${item.categories && item.categories.length ? `
        <div class="watch-links">
          ${item.categories.map((cat) => `
            <button type="button" class="watch-chip ${cat.status}" data-jump-class="${item.classid}" data-jump-category="${cat.name}">
              ${cat.name} · ${formatPct(cat.average)}
            </button>
          `).join('')}
        </div>
      ` : ''}
    </div>
  `).join('');
  host.querySelectorAll('.watch-card').forEach((card) => {
    card.addEventListener('click', () => jumpToClass(card.dataset.jumpClass, ''));
  });
  host.querySelectorAll('.watch-chip, .watch-actions .btn').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      jumpToClass(btn.dataset.jumpClass, btn.dataset.jumpCategory || '');
    });
  });
}

function renderAnalyticsLists() {
  const attentionHost = document.getElementById('attentionClassesList');
  if (!DATA.attention_summary.attention_classes.length) {
    attentionHost.innerHTML = '<div class="empty">No classes are below threshold right now.</div>';
  } else {
    attentionHost.innerHTML = DATA.attention_summary.attention_classes.map((item) => `
      <div class="watch-card ${item.status}" data-jump-class="${item.classid}">
        <div class="watch-head">
          <div>
            <span class="watch-status ${item.status}">Needs attention</span>
            <h3>${item.title}</h3>
            <div class="watch-subtitle">${item.category_count ? `${item.category_count} categories below threshold` : 'Class average below threshold'}</div>
          </div>
          <div class="watch-grade ${toneClass(item.status)}">${formatPct(item.value)}</div>
        </div>
        <div class="watch-reason">${item.reason}</div>
        ${item.categories && item.categories.length ? `
          <div class="watch-links">
            ${item.categories.map((cat) => `
              <button type="button" class="watch-chip ${cat.status}" data-jump-class="${item.classid}" data-jump-category="${cat.name}">
                ${cat.name} · ${formatPct(cat.average)}
              </button>
            `).join('')}
          </div>
        ` : ''}
      </div>
    `).join('');
    attentionHost.querySelectorAll('[data-jump-class]').forEach((btn) => {
      btn.addEventListener('click', () => jumpToClass(btn.dataset.jumpClass, btn.dataset.jumpCategory || ''));
    });
  }

  renderRowList(
    'attentionCategoriesList',
    DATA.attention_summary.attention_categories.map((row) => ({
      classid: row.classid,
      title: row.name,
      subtitle: row.class_name,
      value: row.average,
      status: row.status,
      name: row.name,
    })),
    'No categories are below threshold right now.',
    'category'
  );

  renderRowList(
    'strongClassesList',
    DATA.attention_summary.strong_classes.map((item) => ({
      classid: item.classid,
      title: item.short_name,
      subtitle: item.strongest_category ? `Strongest: ${item.strongest_category.name}` : 'Consistent performance',
      value: item.term_grade,
      status: 'strong',
    })),
    'No strong classes are available yet.',
    'class'
  );
}

function updateQuarterView() {
  populateQuarterNav();
  const quarterData = DATA.analytics.quarterly.terms[String(selectedQuarter)] || DATA.analytics.quarterly.timeline;
  if (!chartRefs.quarterTimeline || !chartRefs.classAverage) return;

  chartRefs.quarterTimeline.data.labels = quarterData.labels || [];
  chartRefs.quarterTimeline.data.datasets = makeLineDatasets(quarterData, `Quarter ${selectedQuarter} average`);
  attachLineChartMeta(chartRefs.quarterTimeline, quarterData);
  chartRefs.quarterTimeline.resize();
  chartRefs.quarterTimeline.update();

  const values = DATA.classes.map((item) => item.quarter_values[termLabel(selectedQuarter)]);
  chartRefs.classAverage.data.labels = DATA.classes.map((item) => item.short_name);
  chartRefs.classAverage.data.datasets[0].data = values;
  chartRefs.classAverage.data.datasets[0].backgroundColor = DATA.classes.map((item) => item.color);
  chartRefs.classAverage.options.onClick = (_, elements) => {
    if (!elements.length) return;
    const index = elements[0].index;
    const classid = DATA.analytics.quarterly.class_ids[index];
    if (classid) jumpToClass(classid);
  };
  chartRefs.classAverage.resize();
  chartRefs.classAverage.update();
  populateQuarterNav();
}

function refreshClassAnalytics() {
  const select = document.getElementById('analyticsClassSelect');
  const periodSelect = document.getElementById('analyticsPeriodSelect');
  const categorySelect = document.getElementById('analyticsCategorySelect');
  if (!select || !periodSelect || !categorySelect) return;

  activeClassId = select.value || activeClassId;
  selectedPeriod = periodSelect.value || selectedPeriod;
  const item = findClass(activeClassId) || DATA.classes[0];
  if (!item) return;
  renderClassInsightPanel(item);
  if (!chartRefs.classTimeline || !chartRefs.classCategory) return;

  const categories = categorySourceForClass(item).filter((cat) => cat.average !== null);
  if (selectedCategory !== 'all' && !categories.some((cat) => slug(cat.name) === selectedCategory)) {
    selectedCategory = 'all';
  }

  const categoryOptions = ['<option value="all">All categories</option>']
    .concat(categories.map((cat) => `<option value="${slug(cat.name)}">${cat.name}</option>`))
    .join('');
  categorySelect.innerHTML = categoryOptions;
  categorySelect.value = selectedCategory;

  const timeline = timelineSourceForClass(item);
  const timelineBounds = chartBounds(timeline.values || []);
  chartRefs.classTimeline.data.labels = timeline.labels || [];
  chartRefs.classTimeline.data.datasets[0].label = item.short_name;
  chartRefs.classTimeline.data.datasets[0].data = timeline.values || [];
  chartRefs.classTimeline.data.datasets[0].borderColor = item.color;
  chartRefs.classTimeline.data.datasets[0].backgroundColor = hexToRgba(item.color, 0.25);
  Object.assign(chartRefs.classTimeline.data.datasets[0], linePointStyle(item.color));
  chartRefs.classTimeline.options.scales.y.min = timelineBounds.min;
  chartRefs.classTimeline.options.scales.y.max = timelineBounds.max;
  attachLineChartMeta(chartRefs.classTimeline, { points: timeline.points, classes: [] });
  chartRefs.classTimeline.resize();
  chartRefs.classTimeline.update();

  let visibleCategories = categories;
  if (selectedCategory !== 'all') {
    visibleCategories = categories.filter((cat) => slug(cat.name) === selectedCategory);
  }
  const categoryValues = visibleCategories.map((cat) => cat.average);
  const categoryBounds = chartBounds(categoryValues);
  chartRefs.classCategory.data.labels = visibleCategories.map((cat) => cat.name);
  chartRefs.classCategory.data.datasets[0].data = categoryValues;
  chartRefs.classCategory.data.datasets[0].backgroundColor = visibleCategories.map((cat) => {
    if (cat.status === 'attention') return '#b42318';
    if (cat.status === 'strong') return '#1d6b4a';
    return item.color;
  });
  chartRefs.classCategory.options.scales.x.min = categoryBounds.min;
  chartRefs.classCategory.options.scales.x.max = categoryBounds.max;
  chartRefs.classCategory.options.onClick = (_, elements) => {
    if (!elements.length) return;
    const index = elements[0].index;
    const categoryName = visibleCategories[index] ? visibleCategories[index].name : '';
    if (categoryName) jumpToClass(item.classid, categoryName);
  };
  chartRefs.classCategory.resize();
  chartRefs.classCategory.update();
  populateQuarterNav();
}

function initCharts() {
  if (chartsReady || typeof Chart === 'undefined') return;
  chartsReady = true;
  Chart.defaults.color = '#445266';
  Chart.defaults.font.family = '"Segoe UI", Tahoma, sans-serif';

  const yearly = DATA.analytics.yearly.timeline;
  chartRefs.yearTimeline = makeLineChart(
    'yearTimelineChart',
    yearly.labels,
    makeLineDatasets(yearly, 'Average across classes'),
    {
      timelinePoints: yearly.points,
      classSeries: yearly.classes,
      onHover: (_, elements, chart) => {
        if (!elements.length) return;
        const index = elements[0].index;
        if (index === yearGaugeHoverIndex) return;
        yearGaugeHoverIndex = index;
        const label = chart.data.labels[index];
        const value = chart.data.datasets[0].data[index];
        updateYearHoverGauge(value, label);
      },
      onLeave: () => resetYearHoverGauge(true),
    }
  );

  chartRefs.quarterSummary = makeBarChart(
    'quarterSummaryChart',
    DATA.analytics.yearly.quarter_labels,
    DATA.analytics.yearly.quarter_values,
    DATA.analytics.yearly.quarter_values.map((value) => value !== null && value < THRESHOLD ? '#b42318' : '#204f9e'),
    false,
    {
      onClick: (_, elements) => {
        if (!elements.length) return;
        const index = elements[0].index;
        const term = String(index + 1);
        selectedQuarter = term;
        showSection('analytics');
        showView('quarterly', term);
      },
    }
  );

  const initialQuarter = DATA.analytics.quarterly.terms[String(selectedQuarter)] || DATA.analytics.quarterly.timeline;
  chartRefs.quarterTimeline = makeLineChart(
    'quarterTimelineChart',
    initialQuarter.labels || [],
    makeLineDatasets(initialQuarter, `Quarter ${selectedQuarter} average`),
    {
      timelinePoints: initialQuarter.points,
      classSeries: initialQuarter.classes,
    }
  );

  chartRefs.classAverage = makeBarChart(
    'classAverageChart',
    DATA.classes.map((item) => item.short_name),
    DATA.classes.map((item) => item.quarter_values[termLabel(selectedQuarter)]),
    DATA.classes.map((item) => item.color),
    true,
    {
      onClick: (_, elements) => {
        if (!elements.length) return;
        const index = elements[0].index;
        const classid = DATA.analytics.quarterly.class_ids[index];
        if (classid) jumpToClass(classid);
      },
    }
  );

  updateQuarterView();

  chartRefs.classTimeline = makeLineChart('classTimelineChart', [], [{
    label: '',
    data: [],
    borderColor: '#204f9e',
    backgroundColor: hexToRgba('#204f9e', 0.25),
    fill: true,
    tension: 0.2,
    borderWidth: 3,
    ...linePointStyle('#204f9e'),
  }]);

  chartRefs.classCategory = makeBarChart('classCategoryChart', [], [], [], true);
  renderClassAnalyticsControls();
  refreshClassAnalytics();
  ensureYearHoverGaugeShell();
  resetYearHoverGauge(false);
}

function closeMobileSidebar() {
  document.body.classList.remove('sidebar-open');
  const menuBtn = document.getElementById('mobileMenuBtn');
  if (menuBtn) {
    menuBtn.setAttribute('aria-expanded', 'false');
    menuBtn.setAttribute('aria-label', 'Open menu');
  }
}

function openMobileSidebar() {
  document.body.classList.remove('sidebar-collapsed');
  document.body.classList.add('sidebar-open');
  const menuBtn = document.getElementById('mobileMenuBtn');
  if (menuBtn) {
    menuBtn.setAttribute('aria-expanded', 'true');
    menuBtn.setAttribute('aria-label', 'Close menu');
  }
}

function toggleMobileSidebar() {
  if (document.body.classList.contains('sidebar-open')) {
    closeMobileSidebar();
  } else {
    openMobileSidebar();
  }
}

function bindEvents() {
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      showSection(btn.dataset.section);
      if (window.innerWidth <= 768) closeMobileSidebar();
    });
  });
  const sidebarToggle = document.getElementById('sidebarToggle');
  if (sidebarToggle) {
    sidebarToggle.addEventListener('click', () => {
      const collapsed = document.body.classList.toggle('sidebar-collapsed');
      sidebarToggle.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
      sidebarToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    });
  }
  const mobileMenuBtn = document.getElementById('mobileMenuBtn');
  if (mobileMenuBtn) {
    mobileMenuBtn.addEventListener('click', toggleMobileSidebar);
  }
  const sidebarBackdrop = document.getElementById('sidebarBackdrop');
  if (sidebarBackdrop) {
    sidebarBackdrop.addEventListener('click', closeMobileSidebar);
  }
  document.querySelectorAll('.subtab').forEach((btn) => {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  });
  
  document.getElementById('gradesSearchInput').addEventListener('input', renderClassList);
  
  document.getElementById('analyticsClassSelect').addEventListener('change', () => {
    activeClassId = document.getElementById('analyticsClassSelect').value;
    renderClassAnalyticsControls();
    refreshClassAnalytics();
  });
  document.getElementById('analyticsPeriodSelect').addEventListener('change', () => {
    selectedPeriod = document.getElementById('analyticsPeriodSelect').value;
    renderClassAnalyticsControls();
    refreshClassAnalytics();
  });
  document.getElementById('analyticsCategorySelect').addEventListener('change', () => {
    selectedCategory = document.getElementById('analyticsCategorySelect').value;
    refreshClassAnalytics();
  });

  document.addEventListener('click', (event) => {
    const popup = document.getElementById('timelinePointPopup');
    if (!popup || popup.hidden) return;
    if (popup.contains(event.target)) return;
    if (event.target.closest('canvas')) return;
    hideTimelinePointPopup();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hideTimelinePointPopup();
      if (window.innerWidth <= 768) closeMobileSidebar();
    }
  });
}

function applyTheme(theme) {
  document.body.classList.toggle('theme-dark', theme === 'dark');
  const toggle = document.getElementById('themeToggle');
  if (toggle) toggle.dataset.theme = theme;
  localStorage.setItem('dash-theme', theme);
}

function toggleTheme() {
  const isDark = document.body.classList.contains('theme-dark');
  const theme = isDark ? 'light' : 'dark';
  applyTheme(theme);
  if (DATA) {
    renderStats();
    renderYearHoverGauge(
      DATA.meta.year_average || 0,
      'Current year',
      'Average across classes',
      'Hover the year timeline to preview the selected period. Leave the graph to return to the current year average.'
    );
  }
}

async function init() {
  try {
    const response = await fetch('/api/grades');
    DATA = await response.json();
    THRESHOLD = DATA.meta.threshold;
    activeClassId = DATA.classes[0] ? DATA.classes[0].classid : null;
    selectedQuarter = DATA.analytics.quarterly.current_term || '1';
    selectedPeriod = DATA.analytics.quarterly.current_term || '1';
    selectedGradesQuarter = DATA.analytics.quarterly.current_term || '1';

    document.getElementById('metaYear').textContent = DATA.meta.year;
    document.getElementById('metaTerm').textContent = DATA.meta.term;
    document.getElementById('metaThreshold').textContent = 'Threshold ' + DATA.meta.threshold + '%';
    document.getElementById('metaUpdated').textContent = 'Updated ' + DATA.meta.updated;

    const savedTheme = localStorage.getItem('dash-theme') || 'light';
    applyTheme(savedTheme);

    renderStats();
    startGaugePulse();
    renderDashboardHighlights();
    renderYearlyNotes();
    populateQuarterNav();
    renderAnalyticsLists();
    renderWatchlist();
    bindEvents();
    renderClassList();
    showSection('dashboard');

    const toggleBtn = document.getElementById('themeToggle');
    if (toggleBtn) toggleBtn.addEventListener('click', toggleTheme);
  } catch (err) {
    console.error('Failed to load grade data:', err);
    document.getElementById('dashboard').innerHTML = '<div class="panel" style="padding:40px; text-align:center;"><h2>Failed to load dashboard data</h2><p>Please try again later.</p></div>';
  }
}

init();
