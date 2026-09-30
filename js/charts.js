/* ==================================================================
   charts.js - thin wrapper around Chart.js.

   - Colors are read from the CSS tokens, so light/dark each use their own
     validated steps; charts are rebuilt when the theme changes.
   - Every chart registers its data so the "Table" button can show the
     same numbers without hovering (accessibility / print fallback).
================================================================== */

const Charts = (() => {
  const instances = {};   // canvas id -> Chart
  const tables = {};      // data-chart key -> {title, head, rows}

  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function tokens() {
    return {
      s1: css("--series-1"), s2: css("--series-2"), s3: css("--series-3"),
      neutral: css("--neutral"),
      good: css("--good"), warning: css("--warning"), serious: css("--serious"), critical: css("--critical"),
      ink1: css("--ink-1"), ink2: css("--ink-2"), muted: css("--ink-muted"),
      grid: css("--grid"), axis: css("--axis"), surface: css("--surface"),
    };
  }

  function applyDefaults() {
    const t = tokens();
    Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", sans-serif';
    Chart.defaults.font.size = 12;
    Chart.defaults.color = t.ink2;
    Chart.defaults.borderColor = t.grid;
    Chart.defaults.maintainAspectRatio = false;
    Chart.defaults.animation.duration = 250;
    const tt = Chart.defaults.plugins.tooltip;
    tt.backgroundColor = t.surface;
    tt.titleColor = t.ink2;
    tt.bodyColor = t.ink1;
    tt.borderColor = t.axis;
    tt.borderWidth = 1;
    tt.padding = 10;
    tt.cornerRadius = 8;
    tt.boxWidth = 10;
    tt.boxHeight = 2;          // line keys, not boxes
    tt.bodyFont = { weight: "600" };
    tt.titleFont = { weight: "400" };
    const lg = Chart.defaults.plugins.legend;
    lg.position = "top";
    lg.align = "start";
    lg.labels.boxWidth = 10;
    lg.labels.boxHeight = 10;
    lg.labels.color = t.ink2;
  }

  function scales({ horizontal = false, stacked = false, yTitle = "", xTitle = "", logY = false, suggestedMax } = {}) {
    const t = tokens();
    const valueAxis = {
      beginAtZero: !logY,
      type: logY ? "logarithmic" : "linear",
      stacked,
      grid: { color: t.grid, drawTicks: false },
      border: { display: false },
      ticks: { color: t.muted, padding: 6, precision: 0 },
      title: { display: !!yTitle, text: yTitle, color: t.muted },
      suggestedMax,
    };
    const catAxis = {
      stacked,
      grid: { display: false },
      border: { color: t.axis },
      ticks: { color: t.muted, autoSkip: true, maxRotation: 0 },
      title: { display: !!xTitle, text: xTitle, color: t.muted },
    };
    return horizontal ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis };
  }

  // Bars: thin, rounded data-end only, 2px surface gap between segments.
  function barDataset(label, data, color, extra = {}) {
    return {
      label, data,
      backgroundColor: color,
      hoverBackgroundColor: color,
      borderColor: tokens().surface,
      borderWidth: { top: 0, bottom: 0, left: 0, right: 0 },
      borderRadius: 4,
      borderSkipped: "start",
      maxBarThickness: 36,
      categoryPercentage: 0.7,
      barPercentage: 0.9,
      ...extra,
    };
  }

  function lineDataset(label, data, color, extra = {}) {
    return {
      label, data,
      borderColor: color, backgroundColor: color,
      borderWidth: 2, tension: 0.25,
      pointRadius: 4, pointHoverRadius: 6,
      pointBorderColor: tokens().surface, pointBorderWidth: 2,
      spanGaps: true,
      ...extra,
    };
  }

  function render(canvasId, config) {
    if (instances[canvasId]) instances[canvasId].destroy();
    const el = document.getElementById(canvasId);
    if (!el) return null;
    instances[canvasId] = new Chart(el, config);
    return instances[canvasId];
  }

  function destroy(canvasId) {
    if (instances[canvasId]) { instances[canvasId].destroy(); delete instances[canvasId]; }
  }

  function destroyWithin(container) {
    for (const id of Object.keys(instances)) {
      const el = document.getElementById(id);
      if (!el || container.contains(el)) destroy(id);
    }
  }

  /** Register the data behind a chart so its Table button can show it. */
  function setTable(key, title, head, rows) {
    tables[key] = { title, head, rows };
  }

  function showTable(key) {
    const t = tables[key];
    if (!t) return;
    document.getElementById("tableModalTitle").textContent = t.title;
    const tbl = document.getElementById("tableModalBody");
    tbl.replaceChildren();
    const thead = tbl.createTHead().insertRow();
    t.head.forEach(h => { const th = document.createElement("th"); th.textContent = h; thead.appendChild(th); });
    const tb = tbl.createTBody();
    t.rows.forEach(r => {
      const tr = tb.insertRow();
      r.forEach(c => { tr.insertCell().textContent = c === null || c === undefined ? "–" : c; });
    });
    bootstrap.Modal.getOrCreateInstance(document.getElementById("tableModal")).show();
  }

  return { tokens, applyDefaults, scales, barDataset, lineDataset, render, destroy, destroyWithin, setTable, showTable };
})();
