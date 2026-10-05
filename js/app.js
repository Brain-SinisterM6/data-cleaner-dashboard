/* ==================================================================
   app.js - upload, filters, and the Overview / Turnaround / Backlogs /
   Labs & Facilities / Timeline tabs.
================================================================== */

const App = (() => {
  const { summarize, groupBy, fmtDate, monthLabel } = VLData;
  const h = (...a) => Timeline.h(...a);
  const $ = id => document.getElementById(id);

  const state = {
    all: [],          // every record in the workbook
    view: [],         // records after filters
    filters: { month: "all", lab: "all", facility: "all", entry: "all" },
    fileName: "",
    source: "",       // "raw" (InteLIS export) or "cleaned" (Data-Cleaner.py output)
    rendered: new Set(), // tabs already drawn for the current filter state
    facSort: { key: "total", dir: -1 },
  };

  // ============================== theme ==============================
  function effectiveTheme() {
    const forced = document.documentElement.getAttribute("data-theme");
    if (forced) return forced;
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  function applyTheme() {
    document.documentElement.setAttribute("data-bs-theme", effectiveTheme());
    Charts.applyDefaults();
  }
  function initTheme() {
    try {
      const saved = localStorage.getItem("vl-dash-theme");
      if (saved) document.documentElement.setAttribute("data-theme", saved);
    } catch (e) { /* storage unavailable: follow the OS */ }
    applyTheme();
    $("btnTheme").addEventListener("click", () => {
      const next = effectiveTheme() === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem("vl-dash-theme", next); } catch (e) { /* ignore */ }
      applyTheme();
      rerender();
    });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { applyTheme(); rerender(); });
  }

  // ============================== upload ==============================
  function initUpload() {
    const dz = $("dropZone"), input = $("fileInput");
    const open = () => input.click();
    $("btnBrowse").addEventListener("click", e => { e.stopPropagation(); open(); });
    dz.addEventListener("click", open);
    dz.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    input.addEventListener("change", () => { if (input.files[0]) loadFile(input.files[0]); input.value = ""; });

    ["dragenter", "dragover"].forEach(ev => document.addEventListener(ev, e => {
      e.preventDefault(); dz.classList.add("dragging");
    }));
    ["dragleave", "drop"].forEach(ev => document.addEventListener(ev, e => {
      e.preventDefault(); if (ev === "drop" || e.target === dz) dz.classList.remove("dragging");
    }));
    document.addEventListener("drop", e => {
      const f = e.dataTransfer && e.dataTransfer.files[0];
      if (f) loadFile(f);
    });
    $("btnNewFile").addEventListener("click", () => {
      $("dashView").classList.add("d-none");
      $("uploadView").classList.remove("d-none");
      $("btnNewFile").classList.add("d-none");
      $("btnExport").classList.add("d-none");
      $("fileBadge").classList.add("d-none");
    });
  }

  function setLoading(on, text = "", pct = null) {
    $("loadStatus").classList.toggle("d-none", !on);
    $("loadText").textContent = text;
    const bar = $("loadBar");
    bar.classList.toggle("progress-bar-striped", pct === null);
    bar.classList.toggle("progress-bar-animated", pct === null);
    bar.style.width = pct === null ? "100%" : `${pct}%`;
  }

  function showError(msg) {
    const el = $("loadError");
    el.textContent = msg;
    el.classList.toggle("d-none", !msg);
  }

  function loadFile(file) {
    showError("");
    if (!/\.xlsx?$/i.test(file.name)) { showError("Please choose an Excel file (.xlsx)."); return; }
    $("uploadView").classList.remove("d-none");
    $("dashView").classList.add("d-none");
    setLoading(true, `Reading ${file.name}…`, 0);
    const reader = new FileReader();
    reader.onprogress = e => { if (e.lengthComputable) setLoading(true, `Reading ${file.name}…`, Math.round(e.loaded / e.total * 100)); };
    reader.onerror = () => { setLoading(false); showError("The file could not be read."); };
    reader.onload = async () => {
      setLoading(true, "Building the dashboard…", 0);
      try {
        const t0 = performance.now();
        const parsed = await VLData.parseWorkbook(new Uint8Array(reader.result), f =>
          setLoading(true, "Building the dashboard…", Math.round(f * 100)));
        state.all = parsed.records;
        state.fileName = file.name;
        state.source = parsed.source;
        setLoading(false);
        startDashboard(parsed);
        console.info(`Parsed ${parsed.records.length} records in ${Math.round(performance.now() - t0)} ms`);
      } catch (err) {
        console.error(err);
        setLoading(false);
        showError(err.message || String(err));
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function startDashboard(parsed) {
    $("uploadView").classList.add("d-none");
    $("dashView").classList.remove("d-none");
    $("btnNewFile").classList.remove("d-none");
    $("btnExport").classList.remove("d-none");
    const badge = $("fileBadge");
    badge.textContent = `${state.fileName} · ${state.source === "raw" ? "raw export" : "cleaned file"} · ${state.all.length.toLocaleString()} samples`;
    badge.classList.remove("d-none");
    if (parsed.missing.length) {
      badge.textContent += ` · missing: ${parsed.missing.join(", ")}`;
    }
    state.filters = { month: "all", lab: "all", facility: "all", entry: "all" };
    buildFilterOptions();
    bootstrap.Tab.getOrCreateInstance(document.querySelector('[data-bs-target="#tabOverview"]')).show();
    $("tlResult").replaceChildren(emptyTimeline());
    $("tlSearch").value = "";
    applyFilters();
  }

  // ============================== filters ==============================
  function fillSelect(sel, options, value) {
    sel.replaceChildren(...options.map(([v, label]) => {
      const o = document.createElement("option");
      o.value = v; o.textContent = label;
      return o;
    }));
    sel.value = options.some(([v]) => v === value) ? value : "all";
  }

  function buildFilterOptions() {
    const f = state.filters;
    const months = [...groupBy(state.all, r => r.month).entries()].sort((a, b) => a[0].localeCompare(b[0]));
    fillSelect($("fMonth"), [["all", "All months"], ...months.map(([k, v]) => [k, `${monthLabel(k)} (${v.length})`])], f.month);

    const labs = [...groupBy(state.all, r => r.lab).entries()].sort((a, b) => b[1].length - a[1].length);
    fillSelect($("fLab"), [["all", "All laboratories"], ...labs.map(([k, v]) => [k, `${k} (${v.length})`])], f.lab);

    buildFacilityOptions();
  }

  function buildFacilityOptions() {
    const f = state.filters;
    const pool = f.lab === "all" ? state.all : state.all.filter(r => r.lab === f.lab);
    const facs = [...groupBy(pool, r => r.facility).entries()].sort((a, b) => a[0].localeCompare(b[0]));
    fillSelect($("fFacility"), [["all", "All facilities"], ...facs.map(([k, v]) => [k, `${k} (${v.length})`])], f.facility);
    f.facility = $("fFacility").value;
  }

  function initFilters() {
    $("fMonth").addEventListener("change", e => setFilter("month", e.target.value));
    $("fLab").addEventListener("change", e => { state.filters.lab = e.target.value; buildFacilityOptions(); applyFilters(); });
    $("fFacility").addEventListener("change", e => setFilter("facility", e.target.value));
    $("fEntry").addEventListener("change", e => setFilter("entry", e.target.value));
    $("btnReset").addEventListener("click", () => {
      state.filters = { month: "all", lab: "all", facility: "all", entry: "all" };
      buildFilterOptions();
      $("fEntry").value = "all";
      applyFilters();
    });
  }

  function setFilter(key, value) {
    state.filters[key] = value;
    if (key === "lab") buildFacilityOptions();
    const sel = { month: "fMonth", lab: "fLab", facility: "fFacility", entry: "fEntry" }[key];
    $(sel).value = value;
    applyFilters();
  }

  function applyFilters() {
    const f = state.filters;
    state.view = state.all.filter(r =>
      (f.month === "all" || r.month === f.month) &&
      (f.lab === "all" || r.lab === f.lab) &&
      (f.facility === "all" || r.facility === f.facility) &&
      (f.entry === "all" || r.entry === f.entry));
    const parts = filterParts();
    $("filterSummary").textContent =
      `${state.view.length.toLocaleString()} of ${state.all.length.toLocaleString()} samples` + (parts.length ? ` · ${parts.join(" · ")}` : "");
    state.rendered.clear();
    renderActiveTab();
  }

  function filterParts() {
    const f = state.filters, parts = [];
    if (f.month !== "all") parts.push(monthLabel(f.month));
    if (f.lab !== "all") parts.push(f.lab);
    if (f.facility !== "all") parts.push(f.facility);
    if (f.entry !== "all") parts.push(f.entry);
    return parts;
  }

  // ============================== tab rendering ==============================
  function activeTabId() {
    const btn = document.querySelector(".nav-link.active[data-bs-target]");
    return btn ? btn.getAttribute("data-bs-target").slice(1) : "tabOverview";
  }

  const RENDERERS = { tabOverview: renderOverview, tabTat: renderTat, tabBacklog: renderBacklog, tabSites: renderSites };

  function renderActiveTab() {
    const id = activeTabId();
    if (state.rendered.has(id)) return;
    state.rendered.add(id);
    if (RENDERERS[id]) RENDERERS[id]();
  }

  /**
   * For the PDF export: lay out the given tabs all at once in the light theme
   * with sharp (2x), unanimated charts, run capture(), then put the page back.
   */
  async function withExportLayout(tabIds, capture) {
    const root = document.documentElement;
    const savedTheme = root.getAttribute("data-theme");
    const savedDpr = Chart.defaults.devicePixelRatio, savedAnim = Chart.defaults.animation;
    root.setAttribute("data-theme", "light");
    applyTheme();
    Chart.defaults.devicePixelRatio = 2;
    Chart.defaults.animation = false;
    document.body.classList.add("exporting");
    try {
      for (const id of tabIds) RENDERERS[id]();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      return await capture();
    } finally {
      document.body.classList.remove("exporting");
      Chart.defaults.devicePixelRatio = savedDpr;
      Chart.defaults.animation = savedAnim;
      if (savedTheme) root.setAttribute("data-theme", savedTheme); else root.removeAttribute("data-theme");
      applyTheme();
      rerender();
    }
  }

  function rerender() {
    if (!state.all.length) return;
    state.rendered.clear();
    renderActiveTab();
    const tl = $("tlResult").dataset;
    if (tl.kind) openTimeline(tl.kind, tl.value, false);
  }

  function initTabs() {
    document.querySelectorAll('[data-bs-toggle="tab"]').forEach(btn =>
      btn.addEventListener("shown.bs.tab", () => renderActiveTab()));
    document.querySelectorAll(".table-toggle").forEach(btn =>
      btn.addEventListener("click", () => Charts.showTable(btn.closest("[data-chart]").dataset.chart)));
  }

  // ============================== shared pieces ==============================
  const KPI_ICONS = {
    total: '<svg width="20" height="20" viewBox="0 0 24 24"><path d="M9 3h6M10 3v11a2 2 0 004 0V3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    remote: '<svg width="20" height="20" viewBox="0 0 24 24"><path d="M4 8h13l-3-3M20 16H7l3 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    tested: '<svg width="20" height="20" viewBox="0 0 24 24"><path d="M5 12l4 4 10-10" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    pending: '<svg width="20" height="20" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 8v4l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    failed: '<svg width="20" height="20" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
    high: '<svg width="20" height="20" viewBox="0 0 24 24"><path d="M12 4l8 14H4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v4M12 16.5v.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    tat: '<svg width="20" height="20" viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 10h16M8 3v4M16 3v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  };

  const short = (text, n = 32) => (text.length > n ? text.slice(0, n - 1) + "…" : text);
  const pct = (n, d) => (d ? `${Math.round(n / d * 100)}%` : "–");

  function kpi(icon, color, value, label, sub) {
    return h("div", { class: "kpi" },
      h("div", { class: "kpi-icon", style: `color:${color};background:color-mix(in srgb, ${color} 14%, transparent)`, html: KPI_ICONS[icon] }),
      h("div", {},
        h("div", { class: "kpi-value" }, value),
        h("div", { class: "kpi-label" }, label),
        sub ? h("div", { class: "kpi-sub" }, sub) : null));
  }

  function kpiRow(s, compact = false) {
    const col = compact ? "col-6 col-md-4 col-xl" : "col-6 col-md-4 col-xl";
    const tiles = [
      kpi("total", "var(--series-1)", s.total.toLocaleString(), "Samples", null),
      kpi("remote", "var(--series-1)", pct(s.remote, s.total), "Ordered remotely", `${s.remote.toLocaleString()} remote · ${s.manual.toLocaleString()} manual`),
      kpi("tested", "var(--good)", s.tested.toLocaleString(), "Tested", pct(s.tested, s.total) + " of samples"),
      kpi("pending", "#c98500", s.pending.toLocaleString(), "Waiting for test", pct(s.pending, s.total) + " of samples"),
      kpi("failed", "var(--critical)", s.failed.toLocaleString(), "Failed / invalid", null),
      kpi("high", "var(--serious)", s.highVl.toLocaleString(), "High viral load", "≥ 1000 cp/mL"),
      kpi("tat", "var(--series-1)", s.tatStats.avg !== null ? `${s.tatStats.avg} d` : "–", "Avg testing TAT", "collection → tested"),
    ];
    return h("div", { class: "row g-3" }, tiles.map(t => h("div", { class: col }, t)));
  }

  // Floating tooltip for HTML marks (status bars, time-split segments).
  function attachTip(el, htmlFn) {
    const tip = $("tooltip");
    const show = e => {
      tip.innerHTML = htmlFn();
      tip.classList.add("show");
      const rect = el.getBoundingClientRect();
      const x = e && e.clientX ? e.clientX : rect.left + rect.width / 2;
      const y = e && e.clientY ? e.clientY : rect.top;
      tip.style.left = `${Math.min(x + 12, innerWidth - tip.offsetWidth - 8)}px`;
      tip.style.top = `${y - tip.offsetHeight - 10}px`;
    };
    const hide = () => tip.classList.remove("show");
    el.addEventListener("pointermove", show);
    el.addEventListener("focus", () => show(null));
    el.addEventListener("pointerleave", hide);
    el.addEventListener("blur", hide);
  }

  function clickableCursor(evt, els) {
    evt.native.target.style.cursor = els.length ? "pointer" : "default";
  }

  // Daily keys inside one month, for the "single month" view of trend charts.
  function daysOfMonth(key) {
    const [y, m] = key.split("-").map(Number);
    const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return Array.from({ length: n }, (_, i) => i + 1);
  }
  const dayOf = r => VLData.serialToDate(r.collected).getUTCDate();

  // ============================== Overview ==============================
  function renderOverview() {
    const v = state.view, s = summarize(v), t = Charts.tokens();
    $("kpiRow").replaceChildren(h("div", { class: "col-12" }, kpiRow(s)));

    // --- volume over time ---
    const month = state.filters.month;
    let labels, remote, manual, keys;
    if (month === "all") {
      const byMonth = [...groupBy(v, r => r.month).entries()].sort((a, b) => a[0].localeCompare(b[0]));
      keys = byMonth.map(([k]) => k);
      labels = keys.map(k => monthLabel(k, true));
      remote = byMonth.map(([, g]) => g.filter(r => r.entry === "Remote").length);
      manual = byMonth.map(([, g]) => g.filter(r => r.entry === "Manual").length);
      $("volumeTitle").textContent = "Samples collected per month";
      $("volumeHint").textContent = "Click a bar to focus on that month.";
    } else {
      const days = daysOfMonth(month);
      const byDay = groupBy(v.filter(r => r.collected !== null), dayOf);
      keys = null;
      labels = days.map(String);
      remote = days.map(d => (byDay.get(d) || []).filter(r => r.entry === "Remote").length);
      manual = days.map(d => (byDay.get(d) || []).filter(r => r.entry === "Manual").length);
      $("volumeTitle").textContent = `Samples collected each day · ${monthLabel(month)}`;
      $("volumeHint").textContent = "Pick “All months” in the Month filter to go back.";
    }
    const undated = v.filter(r => r.collected === null).length;
    if (undated) $("volumeHint").textContent += ` ${undated} sample${undated === 1 ? " has" : "s have"} no collection date.`;

    const stackBorder = { borderWidth: { top: 2 } };
    Charts.render("cVolume", {
      type: "bar",
      data: { labels, datasets: [
        Charts.barDataset("Remote", remote, t.s1, stackBorder),
        Charts.barDataset("Manual", manual, t.s2, stackBorder),
      ] },
      options: {
        scales: Charts.scales({ stacked: true, yTitle: "Samples" }),
        interaction: { mode: "index", intersect: false },
        plugins: { tooltip: { footer: items => `Total: ${items.reduce((a, i) => a + i.parsed.y, 0)}` } },
        onHover: keys ? clickableCursor : undefined,
        onClick: (evt, els) => { if (keys && els.length) setFilter("month", keys[els[0].index]); },
      },
    });
    Charts.setTable("volume", $("volumeTitle").textContent, [month === "all" ? "Month" : "Day", "Remote", "Manual", "Total"],
      labels.map((l, i) => [keys ? monthLabel(keys[i]) : l, remote[i], manual[i], remote[i] + manual[i]]));

    // --- status bars ---
    const rows = [
      { label: "Tested", icon: "✓", n: s.tested, color: "var(--good)" },
      { label: "Waiting for test", icon: "◷", n: s.pending, color: "var(--warning)" },
      { label: "Not yet received at lab", icon: "⇢", n: s.notTransported, color: "var(--warning)" },
      { label: "Failed / invalid", icon: "✕", n: s.failed, color: "var(--critical)" },
      { label: "Rejected", icon: "⊘", n: s.rejected, color: "var(--critical)" },
    ];
    $("statusBars").replaceChildren(...rows.map(r => {
      const fill = h("div", { class: "status-fill", style: `width:${s.total ? r.n / s.total * 100 : 0}%;background:${r.color}` });
      const row = h("div", { class: "status-row", tabindex: "0" },
        h("div", { class: "status-label" },
          h("strong", {}, h("span", { class: "status-icon", "aria-hidden": "true" }, r.icon), r.label),
          h("span", {}, `${r.n.toLocaleString()} · ${pct(r.n, s.total)}`)),
        h("div", { class: "status-track" }, fill));
      attachTip(row, () => `<strong>${r.n.toLocaleString()}</strong> of ${s.total.toLocaleString()} samples`);
      return row;
    }));
    Charts.setTable("status", "Where the samples are", ["Status", "Samples", "% of total"], rows.map(r => [r.label, r.n, pct(r.n, s.total)]));

    // --- result outcome ---
    const below = s.suppressed;
    const outcome = [
      ["Target not detected", s.tnd, t.good],
      ["Detected, below 1000", below - 0, t.good],
      ["High VL (≥ 1000)", s.highVl, t.serious],
      ["Failed / invalid", s.failed, t.critical],
      ["Other / no value", s.otherResult, t.neutral],
    ];
    // "suppressed" counts every numeric result under 1000 (incl. "<40").
    Charts.render("cOutcome", {
      type: "bar",
      data: { labels: outcome.map(o => o[0]), datasets: [
        Charts.barDataset("Samples", outcome.map(o => o[1]), outcome.map(o => o[2]), { borderSkipped: "start" }),
      ] },
      options: {
        indexAxis: "y",
        scales: Charts.scales({ horizontal: true }),
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { display: false },
          tooltip: { callbacks: { label: c => `${c.parsed.x.toLocaleString()} samples (${pct(c.parsed.x, s.tested)} of tested)` } } },
      },
    });
    Charts.setTable("outcome", "Viral load results (tested samples)", ["Result", "Samples"], outcome.map(o => [o[0], o[1]]));

    // --- high VL table ---
    const hv = v.filter(r => r.highVl).sort((a, b) => b.vl - a.vl);
    $("hvlCount").textContent = `${hv.length}`;
    const tbl = $("hvlTable");
    tbl.replaceChildren();
    const head = tbl.createTHead().insertRow();
    ["Sample", "Facility", "Collected", "cp/mL"].forEach(x => { const th = document.createElement("th"); th.textContent = x; head.appendChild(th); });
    const body = tbl.createTBody();
    if (!hv.length) { const c = body.insertRow().insertCell(); c.colSpan = 4; c.className = "text-secondary"; c.textContent = "No high viral load samples in this selection."; }
    hv.slice(0, 300).forEach(r => {
      const tr = body.insertRow();
      tr.className = "clickable"; tr.tabIndex = 0;
      [r.id, r.facility, fmtDate(r.collected), r.vl.toLocaleString()].forEach(x => { tr.insertCell().textContent = x; });
      tr.addEventListener("click", () => openTimeline("sample", r.key));
      tr.addEventListener("keydown", e => { if (e.key === "Enter") openTimeline("sample", r.key); });
    });
  }

  // ============================== Turnaround ==============================
  function renderTat() {
    const v = state.view, s = summarize(v), t = Charts.tokens();

    // --- average journey + headline figures ---
    const box = $("avgJourney");
    box.replaceChildren(
      Timeline.journey({}, { avgMode: true, gaps: [s.transportStats.avg, s.inLabStats.avg, s.validationStats.avg] }),
      h("div", { class: "row g-3 mt-2" }, [
        ["Transport to lab", s.transportStats, "collection → reception"],
        ["Testing TAT", s.tatStats, "collection → tested"],
        ["Result dispatch", s.dispatchStats, "collection → printed"],
        ["Result validation", s.validationStats, "tested → printed"],
      ].map(([label, st, sub]) => h("div", { class: "col-6 col-lg-3" },
        h("div", { class: "kpi" }, h("div", {},
          h("div", { class: "kpi-value" }, st.avg !== null ? `${st.avg} d` : "–"),
          h("div", { class: "kpi-label" }, label),
          h("div", { class: "kpi-sub" }, st.n ? `${sub} · min ${st.min ?? "–"} / max ${st.max ?? "–"} · ${st.n.toLocaleString()} samples` : `${sub} · no data`),
          st.negatives ? h("div", { class: "warn-note" }, `⚠ ${st.negatives} with bad dates left out`) : null))))),
    );

    // --- trend ---
    const month = state.filters.month;
    let groups, labels;
    if (month === "all") {
      const g = [...groupBy(v, r => r.month).entries()].sort((a, b) => a[0].localeCompare(b[0]));
      labels = g.map(([k]) => monthLabel(k, true));
      groups = g.map(([, x]) => x);
      $("tatTrendTitle").textContent = "Average days, month by month";
    } else {
      const days = daysOfMonth(month);
      const byDay = groupBy(v.filter(r => r.collected !== null), dayOf);
      labels = days.map(String);
      groups = days.map(d => byDay.get(d) || []);
      $("tatTrendTitle").textContent = `Average days by collection day · ${monthLabel(month)}`;
    }
    const gs = groups.map(summarize);
    const series = [
      ["Testing TAT", gs.map(x => x.tatStats.avg), t.s1],
      ["Transport to lab", gs.map(x => x.transportStats.avg), t.s2],
      ["Result dispatch", gs.map(x => x.dispatchStats.avg), t.s3],
    ].filter(([, d]) => d.some(x => x !== null));
    Charts.render("cTatTrend", {
      type: "line",
      data: { labels, datasets: series.map(([l, d, c]) => Charts.lineDataset(l, d, c)) },
      options: {
        scales: Charts.scales({ yTitle: "Days" }),
        interaction: { mode: "index", intersect: false },
        plugins: { tooltip: { callbacks: { label: c => ` ${c.parsed.y ?? "–"} days · ${c.dataset.label}` } } },
      },
    });
    Charts.setTable("tatTrend", $("tatTrendTitle").textContent, [month === "all" ? "Month" : "Day", ...series.map(x => x[0] + " (days)")],
      labels.map((l, i) => [l, ...series.map(x => x[1][i])]));

    // --- histogram ---
    const bins = [[0, 7, "0–7"], [8, 14, "8–14"], [15, 21, "15–21"], [22, 30, "22–30"], [31, 60, "31–60"], [61, Infinity, "60+"]];
    const counts = bins.map(([a, b]) => v.filter(r => r.tat !== null && r.tat >= a && r.tat <= b).length);
    Charts.render("cTatHist", {
      type: "bar",
      data: { labels: bins.map(b => b[2]), datasets: [Charts.barDataset("Samples", counts, t.s1)] },
      options: {
        scales: Charts.scales({ yTitle: "Samples", xTitle: "Days from collection to testing" }),
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { display: false }, tooltip: { callbacks: { title: i => `${i[0].label} days` } } },
      },
    });
    Charts.setTable("tatHist", "Samples by testing TAT", ["Days", "Samples"], bins.map((b, i) => [b[2], counts[i]]));

    // --- remote vs manual ---
    const rs = summarize(v.filter(r => r.entry === "Remote")), ms = summarize(v.filter(r => r.entry === "Manual"));
    const cats = [["Transport", "transportStats"], ["Testing TAT", "tatStats"], ["Result dispatch", "dispatchStats"], ["Validation", "validationStats"]];
    Charts.render("cTatEntry", {
      type: "bar",
      data: { labels: cats.map(c => c[0]), datasets: [
        Charts.barDataset("Remote", cats.map(c => rs[c[1]].avg), t.s1),
        Charts.barDataset("Manual", cats.map(c => ms[c[1]].avg), t.s2),
      ] },
      options: {
        scales: Charts.scales({ yTitle: "Average days" }),
        interaction: { mode: "index", intersect: false },
        plugins: { tooltip: { callbacks: { label: c => ` ${c.parsed.y ?? "no data"}${c.parsed.y !== null ? " days" : ""} · ${c.dataset.label}` } } },
      },
    });
    Charts.setTable("tatEntry", "Remote vs manual (average days)", ["Step", "Remote", "Manual"],
      cats.map(c => [c[0], rs[c[1]].avg, ms[c[1]].avg]));

    // --- by lab ---
    const labs = [...groupBy(v, r => r.lab).entries()].map(([k, g]) => [k, summarize(g).tatStats.avg])
      .filter(x => x[1] !== null).sort((a, b) => b[1] - a[1]);
    Charts.render("cTatLab", {
      type: "bar",
      data: { labels: labs.map(x => short(x[0])), datasets: [Charts.barDataset("Avg testing TAT", labs.map(x => x[1]), t.s1)] },
      options: {
        indexAxis: "y",
        scales: Charts.scales({ horizontal: true, yTitle: "" }),
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { display: false }, tooltip: { callbacks: { title: i => labs[i[0].dataIndex][0], label: c => ` ${c.parsed.x} days` } } },
        onHover: clickableCursor,
        onClick: (e, els) => { if (els.length) setFilter("lab", labs[els[0].index][0]); },
      },
    });
    Charts.setTable("tatLab", "Average testing TAT by laboratory", ["Laboratory", "Average days"], labs);
  }

  // ============================== Backlogs ==============================
  // Month charts ignore the Month filter: a backlog runs from one month into the
  // next, so they always show every month. The picked month (if any) drives the
  // key numbers, the lab chart and the list of samples still waiting.
  function renderBacklog() {
    const f = state.filters, t = Charts.tokens();
    const base = state.all.filter(r =>
      (f.lab === "all" || r.lab === f.lab) &&
      (f.facility === "all" || r.facility === f.facility) &&
      (f.entry === "all" || r.entry === f.entry));
    const lastMonth = VLData.lastDataMonth(state.all);
    const bl = VLData.backlogs(base, lastMonth);
    const month = f.month;
    const focus = month === "all" ? bl.total : (bl.byMonth.get(month) || VLData.backlogs([]).total);
    const scopeRecs = month === "all" ? base : base.filter(r => r.month === month);
    const where = month === "all" ? "all months" : monthLabel(month);
    const n = x => x.toLocaleString();

    // --- key numbers ---
    const carry = month === "all" ? null : bl.carryIn.get(month);
    const tiles = [
      kpi("pending", "#c98500", n(focus.backlog), "Backlog", `${pct(focus.backlog, focus.collected - focus.rejected)} of samples collected · ${where}`),
      kpi("total", "var(--series-1)", n(focus.transported), "At the lab", `${n(focus.notTransported)} not yet transported`),
      kpi("remote", "var(--series-1)", n(focus.remote), "Remote backlog", `${n(focus.manual)} manual entry`),
      kpi("tested", "var(--good)", n(focus.testedNextMonth + focus.testedLater), "Backlog tested later", `${n(focus.testedNextMonth)} the following month`),
      kpi("failed", "var(--critical)", n(focus.stillPending), "Still not tested", pct(focus.stillPending, focus.backlog) + " of the backlog"),
    ];
    if (carry) {
      tiles.push(kpi("tat", "var(--series-3)", `${n(carry.tested)} / ${n(carry.backlog)}`, "Last month's backlog tested",
        `${n(carry.backlog - carry.tested)} still pending at the end of ${monthLabel(month)}`));
    }
    $("blKpis").replaceChildren(h("div", { class: "col-12" },
      h("div", { class: "row g-3" }, tiles.map(x => h("div", { class: "col-6 col-md-4 col-xl" }, x)))));

    // --- backlog per collection month: transported vs not ---
    const months = [...bl.byMonth.keys()];
    const rows = [...bl.byMonth.values()];
    const labels = months.map(k => monthLabel(k, true));
    const highlight = (color, i) => (month === "all" || months[i] === month ? color : `color-mix(in srgb, ${color} 35%, transparent)`);
    const stackBorder = { borderWidth: { top: 2 } };
    Charts.render("cBlMonth", {
      type: "bar",
      data: { labels, datasets: [
        Charts.barDataset("Transported to lab", rows.map(b => b.transported), months.map((_, i) => highlight(t.s1, i)), stackBorder),
        Charts.barDataset("Not transported", rows.map(b => b.notTransported), months.map((_, i) => highlight(t.neutral, i)), stackBorder),
      ] },
      options: {
        scales: Charts.scales({ stacked: true, yTitle: "Samples" }),
        interaction: { mode: "index", intersect: false },
        plugins: { tooltip: { footer: items => {
          const b = rows[items[0].dataIndex];
          return `Backlog: ${n(b.backlog)} of ${n(b.collected)} collected\nRemote ${n(b.remote)} · Manual ${n(b.manual)}`;
        } } },
        onHover: clickableCursor,
        onClick: (evt, els) => { if (els.length) setFilter("month", months[els[0].index] === month ? "all" : months[els[0].index]); },
      },
    });
    Charts.setTable("blMonth", "Backlog per collection month",
      ["Month", "Collected", "Backlog", "Transported", "Not transported", "Remote", "Manual"],
      months.map((k, i) => [monthLabel(k), rows[i].collected, rows[i].backlog, rows[i].transported, rows[i].notTransported, rows[i].remote, rows[i].manual]));

    // --- previous month's backlog tested in the current month ---
    const cMonths = [...bl.carryIn.keys()], cRows = [...bl.carryIn.values()];
    Charts.render("cBlCarry", {
      type: "bar",
      data: { labels: cMonths.map(k => monthLabel(k, true)), datasets: [
        Charts.barDataset("Tested this month", cRows.map(c => c.tested), cMonths.map((k, i) => month === "all" || k === month ? t.good : `color-mix(in srgb, ${t.good} 35%, transparent)`), stackBorder),
        Charts.barDataset("Still pending at month end", cRows.map(c => c.backlog - c.tested), cMonths.map((k, i) => month === "all" || k === month ? t.warning : `color-mix(in srgb, ${t.warning} 35%, transparent)`), stackBorder),
      ] },
      options: {
        scales: Charts.scales({ stacked: true, yTitle: "Samples" }),
        interaction: { mode: "index", intersect: false },
        plugins: { tooltip: { footer: items => {
          const c = cRows[items[0].dataIndex];
          return `Backlog from previous month: ${n(c.backlog)} · ${pct(c.tested, c.backlog)} cleared`;
        } } },
      },
    });
    Charts.setTable("blCarry", "Previous month's backlog tested in the current month",
      ["Month", "Backlog from previous month", "Tested this month", "Still pending at month end", "% cleared"],
      cMonths.map((k, i) => [monthLabel(k), cRows[i].backlog, cRows[i].tested, cRows[i].backlog - cRows[i].tested, pct(cRows[i].tested, cRows[i].backlog)]));

    // --- what happened to each month's backlog ---
    Charts.render("cBlFate", {
      type: "bar",
      data: { labels, datasets: [
        Charts.barDataset("Tested next month", rows.map(b => b.testedNextMonth), t.s3, stackBorder),
        Charts.barDataset("Tested later", rows.map(b => b.testedLater), t.s1, stackBorder),
        Charts.barDataset("Still not tested", rows.map(b => b.stillPending), t.warning, stackBorder),
      ] },
      options: {
        scales: Charts.scales({ stacked: true, yTitle: "Samples" }),
        interaction: { mode: "index", intersect: false },
        plugins: { tooltip: { footer: items => `Backlog: ${n(rows[items[0].dataIndex].backlog)}` } },
      },
    });
    Charts.setTable("blFate", "What happened to each month's backlog",
      ["Month", "Backlog", "Tested next month", "Tested later", "Still not tested"],
      months.map((k, i) => [monthLabel(k), rows[i].backlog, rows[i].testedNextMonth, rows[i].testedLater, rows[i].stillPending]));

    // --- backlog by lab ---
    const labs = [...groupBy(scopeRecs, r => r.lab).entries()]
      .map(([k, g]) => [k, VLData.backlogs(g, lastMonth).total])
      .filter(([, b]) => b.backlog > 0)
      .sort((a, b) => b[1].backlog - a[1].backlog);
    $("blLabHint").textContent = `Backlog for ${where}. Click a bar to filter to that lab.`;
    Charts.render("cBlLab", {
      type: "bar",
      data: { labels: labs.map(x => short(x[0])), datasets: [
        Charts.barDataset("Transported to lab", labs.map(([, b]) => b.transported), t.s1, { borderWidth: { right: 2 } }),
        Charts.barDataset("Not transported", labs.map(([, b]) => b.notTransported), t.neutral, { borderWidth: { right: 2 } }),
      ] },
      options: {
        indexAxis: "y",
        scales: Charts.scales({ horizontal: true, stacked: true }),
        interaction: { mode: "index", intersect: false },
        plugins: { tooltip: { callbacks: { title: i => labs[i[0].dataIndex][0] },
          footer: items => { const b = labs[items[0].dataIndex][1]; return `Remote ${n(b.remote)} · Manual ${n(b.manual)} · still not tested ${n(b.stillPending)}`; } } },
        onHover: clickableCursor,
        onClick: (e, els) => { if (els.length) setFilter("lab", labs[els[0].index][0]); },
      },
    });
    Charts.setTable("blLab", `Backlog by laboratory · ${where}`,
      ["Laboratory", "Backlog", "Transported", "Not transported", "Remote", "Manual", "Tested next month", "Tested later", "Still not tested"],
      labs.map(([k, b]) => [k, b.backlog, b.transported, b.notTransported, b.remote, b.manual, b.testedNextMonth, b.testedLater, b.stillPending]));

    // --- month-by-month table (mirrors the Excel sheet) ---
    const cols = [
      ["Month"], ["Collected", "collected"], ["Rejected", "rejected"], ["Tested same month", "testedSameMonth"],
      ["Backlog", "backlog"], ["Transported", "transported"], ["Not transported", "notTransported"],
      ["Remote", "remote"], ["Manual", "manual"], ["Tested next month", "testedNextMonth"],
      ["Tested later", "testedLater"], ["Still not tested", "stillPending"],
    ];
    const tbl = $("blTable");
    tbl.replaceChildren();
    const head = tbl.createTHead().insertRow();
    cols.forEach(([label]) => { const th = document.createElement("th"); th.textContent = label; head.appendChild(th); });
    const body = tbl.createTBody();
    const addRow = (label, b, cls) => {
      const tr = body.insertRow();
      if (cls) tr.className = cls;
      tr.insertCell().textContent = label;
      cols.slice(1).forEach(([, k]) => { tr.insertCell().textContent = n(b[k]); });
    };
    months.forEach((k, i) => addRow(monthLabel(k), rows[i], k === month ? "table-active" : ""));
    if (months.length) addRow("Total", bl.total, "fw-semibold");
    else { const c = body.insertRow().insertCell(); c.colSpan = cols.length; c.className = "text-secondary"; c.textContent = "No samples with a collection date in this selection."; }

    // --- backlog samples still not tested ---
    const waiting = scopeRecs.filter(r => VLData.backlogStatus(r) === "pending").sort((a, b) => a.collected - b.collected);
    $("blPendingTitle").textContent = `Backlog samples still not tested · ${where}`;
    $("blPendingCount").textContent = n(waiting.length);
    const pt = $("blPendingTable");
    pt.replaceChildren();
    const ph = pt.createTHead().insertRow();
    ["Sample", "Entry", "Facility", "Laboratory", "Collected", "At the lab"].forEach(x => { const th = document.createElement("th"); th.textContent = x; ph.appendChild(th); });
    const pb = pt.createTBody();
    if (!waiting.length) { const c = pb.insertRow().insertCell(); c.colSpan = 6; c.className = "text-secondary"; c.textContent = "No backlog samples waiting in this selection."; }
    waiting.slice(0, 300).forEach(r => {
      const tr = pb.insertRow();
      tr.className = "clickable"; tr.tabIndex = 0;
      [r.id, r.entry, r.facility, r.lab, fmtDate(r.collected), r.received !== null ? fmtDate(r.received) : "Not yet"].forEach(x => { tr.insertCell().textContent = x; });
      tr.addEventListener("click", () => openTimeline("sample", r.key));
      tr.addEventListener("keydown", e => { if (e.key === "Enter") openTimeline("sample", r.key); });
    });
    if (waiting.length > 300) {
      const c = pb.insertRow().insertCell(); c.colSpan = 6; c.className = "text-secondary small";
      c.textContent = `Showing the 300 oldest of ${n(waiting.length)}. Narrow the filters to see the rest.`;
    }
  }

  // ============================== Labs & facilities ==============================
  function renderSites() {
    const v = state.view, t = Charts.tokens();
    const stack = horizontal => ({ borderWidth: horizontal ? { right: 2 } : { top: 2 } });

    const labs = [...groupBy(v, r => r.lab).entries()].sort((a, b) => b[1].length - a[1].length);
    Charts.render("cLabs", {
      type: "bar",
      data: { labels: labs.map(x => short(x[0])), datasets: [
        Charts.barDataset("Remote", labs.map(([, g]) => g.filter(r => r.entry === "Remote").length), t.s1, stack(true)),
        Charts.barDataset("Manual", labs.map(([, g]) => g.filter(r => r.entry === "Manual").length), t.s2, stack(true)),
      ] },
      options: {
        indexAxis: "y",
        scales: Charts.scales({ horizontal: true, stacked: true }),
        interaction: { mode: "index", intersect: false },
        plugins: { tooltip: { callbacks: { title: i => labs[i[0].dataIndex][0] } } },
        onHover: clickableCursor,
        onClick: (e, els) => { if (els.length) setFilter("lab", labs[els[0].index][0]); },
      },
    });
    Charts.setTable("labs", "Samples by laboratory", ["Laboratory", "Facilities", "Remote", "Manual", "Total"],
      labs.map(([k, g]) => [k, new Set(g.map(r => r.facility)).size, g.filter(r => r.entry === "Remote").length, g.filter(r => r.entry === "Manual").length, g.length]));

    const facsAll = [...groupBy(v, r => r.facility).entries()].sort((a, b) => b[1].length - a[1].length);
    const facs = facsAll.slice(0, 20);
    $("facTitle").textContent = facsAll.length > 20 ? `Top 20 of ${facsAll.length} facilities by samples sent` : "Facilities by samples sent";
    Charts.render("cFacilities", {
      type: "bar",
      data: { labels: facs.map(x => short(x[0])), datasets: [
        Charts.barDataset("Remote", facs.map(([, g]) => g.filter(r => r.entry === "Remote").length), t.s1, stack(true)),
        Charts.barDataset("Manual", facs.map(([, g]) => g.filter(r => r.entry === "Manual").length), t.s2, stack(true)),
      ] },
      options: {
        indexAxis: "y",
        scales: Charts.scales({ horizontal: true, stacked: true }),
        interaction: { mode: "index", intersect: false },
        plugins: { tooltip: { callbacks: { title: i => facs[i[0].dataIndex][0] } } },
        onHover: clickableCursor,
        onClick: (e, els) => { if (els.length) setFilter("facility", facs[els[0].index][0]); },
      },
    });

    // --- scorecard ---
    const rows = facsAll.map(([name, g]) => {
      const s = summarize(g);
      return { name, lab: [...new Set(g.map(r => r.lab))].join(", "), total: s.total, remote: s.remote, manual: s.manual,
        pending: s.pending, failed: s.failed, highVl: s.highVl, transport: s.transportStats.avg, tat: s.tatStats.avg };
    });
    Charts.setTable("facilities", "Samples by facility", ["Facility", "Laboratory", "Remote", "Manual", "Total"],
      rows.map(r => [r.name, r.lab, r.remote, r.manual, r.total]));
    drawFacTable(rows);
  }

  function drawFacTable(rows) {
    const cols = [
      ["name", "Facility"], ["lab", "Laboratory"], ["total", "Samples"], ["remote", "Remote"], ["manual", "Manual"],
      ["pending", "Pending"], ["failed", "Failed"], ["highVl", "High VL"], ["transport", "Avg transport (d)"], ["tat", "Avg TAT (d)"],
    ];
    const { key, dir } = state.facSort;
    rows.sort((a, b) => {
      const x = a[key], y = b[key];
      if (x === null) return 1; if (y === null) return -1;
      return (typeof x === "string" ? x.localeCompare(y) : x - y) * dir;
    });
    const maxTotal = rows.reduce((m, r) => Math.max(m, r.total), 1);
    const tbl = $("facTable");
    tbl.replaceChildren();
    const head = tbl.createTHead().insertRow();
    cols.forEach(([k, label]) => {
      const th = document.createElement("th");
      th.textContent = label;
      th.className = "sortable" + (k === key ? (dir === 1 ? " sorted-asc" : " sorted-desc") : "");
      th.addEventListener("click", () => {
        state.facSort = { key: k, dir: k === key ? -dir : (typeof rows[0]?.[k] === "string" ? 1 : -1) };
        drawFacTable(rows);
      });
      head.appendChild(th);
    });
    const body = tbl.createTBody();
    rows.forEach(r => {
      const tr = body.insertRow();
      tr.className = "clickable"; tr.tabIndex = 0;
      cols.forEach(([k]) => {
        const td = tr.insertCell();
        if (k === "total") {
          const bar = document.createElement("span");
          bar.className = "mini-bar"; bar.style.width = `${Math.max(2, r.total / maxTotal * 80)}px`;
          td.append(bar, r.total.toLocaleString());
        } else td.textContent = r[k] === null ? "–" : r[k];
      });
      tr.addEventListener("click", () => openTimeline("facility", r.name));
      tr.addEventListener("keydown", e => { if (e.key === "Enter") openTimeline("facility", r.name); });
    });
  }

  // ============================== Timeline explorer ==============================
  const PLACEHOLDER = {
    sample: "Type a Sample ID or Remote ID…",
    patient: "Type a patient ID (Unique ART No.) or a Sample ID…",
    facility: "Type a facility name…",
    lab: "Type a laboratory name…",
  };

  function emptyTimeline() {
    return h("div", { class: "empty-state text-center text-secondary py-5" },
      h("p", { class: "mb-0" }, "Search for something above to see its timeline."));
  }

  function currentKind() {
    return document.querySelector('input[name="tlKind"]:checked').value;
  }

  function suggestions(kind, q) {
    q = q.trim().toLowerCase();
    if (!q) return [];
    const out = [];
    if (kind === "sample") {
      for (const r of state.all) {
        if (r.sampleId.toLowerCase().includes(q) || r.remoteId.toLowerCase().includes(q)) {
          out.push({ value: r.key, label: r.id, sub: `${r.remoteId && r.remoteId !== r.id ? r.remoteId + " · " : ""}${r.facility} · ${fmtDate(r.collected)}` });
          if (out.length >= 12) break;
        }
      }
    } else if (kind === "patient") {
      // Match the ART number directly, or find the patient through one of their sample IDs.
      const found = new Map();   // patientId -> sample ID it was found through (null = matched the ART number)
      const orphans = [];        // matching samples that have no patient ID
      for (const r of state.all) {
        const byPid = r.patientId && r.patientId.toLowerCase().includes(q);
        const bySample = r.sampleId.toLowerCase().includes(q) || r.remoteId.toLowerCase().includes(q);
        if (byPid) found.set(r.patientId, null);
        else if (bySample && r.patientId) { if (!found.has(r.patientId)) found.set(r.patientId, r.sampleId.toLowerCase().includes(q) ? r.sampleId : r.remoteId); }
        else if (bySample && orphans.length < 3) orphans.push(r);
      }
      const counts = new Map();
      for (const r of state.all) if (found.has(r.patientId)) counts.set(r.patientId, (counts.get(r.patientId) || 0) + 1);
      [...found.entries()]
        .sort((a, b) => (a[1] !== null) - (b[1] !== null) || counts.get(b[0]) - counts.get(a[0]))
        .slice(0, 12)
        .forEach(([pid, via]) => {
          const c = counts.get(pid);
          out.push({ value: pid, label: pid, sub: `${via ? `Has sample ${via} · ` : ""}${c} sample${c === 1 ? "" : "s"}` });
        });
      orphans.forEach(r => out.push({ kind: "sample", value: r.key, label: r.id, sub: "No patient ID on this sample · opens the sample" }));
    } else {
      const field = { facility: "facility", lab: "lab" }[kind];
      const seen = new Map();
      for (const r of state.all) {
        const val = r[field];
        if (!val || val === "N/A" || !val.toLowerCase().includes(q)) continue;
        seen.set(val, (seen.get(val) || 0) + 1);
      }
      [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
        .forEach(([val, n]) => out.push({ value: val, label: val, sub: `${n} sample${n === 1 ? "" : "s"}` }));
    }
    return out;
  }

  function initTimeline() {
    const input = $("tlSearch"), box = $("tlSuggest");
    let items = [], active = -1;

    const close = () => { box.classList.add("d-none"); active = -1; };
    const draw = () => {
      box.replaceChildren(...items.map((it, i) => {
        const b = h("button", { type: "button", class: `list-group-item list-group-item-action${i === active ? " active" : ""}` },
          h("div", {}, it.label), h("small", {}, it.sub));
        b.addEventListener("mousedown", e => { e.preventDefault(); pick(it); });
        return b;
      }));
      if (!items.length && input.value.trim()) box.replaceChildren(h("div", { class: "list-group-item" }, h("small", {}, "No matches")));
      box.classList.toggle("d-none", !input.value.trim());
    };
    const pick = it => { input.value = it.label; close(); openTimeline(it.kind || currentKind(), it.value, false); };

    // Each search scans every sample, so wait for a pause in typing on big files.
    let timer = null;
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => { items = suggestions(currentKind(), input.value); active = -1; draw(); },
        state.all.length > 50000 ? 200 : 0);
    });
    input.addEventListener("keydown", e => {
      if (box.classList.contains("d-none")) return;
      if (e.key === "ArrowDown") { active = Math.min(items.length - 1, active + 1); draw(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { active = Math.max(0, active - 1); draw(); e.preventDefault(); }
      else if (e.key === "Enter") { const it = items[active >= 0 ? active : 0]; if (it) pick(it); e.preventDefault(); }
      else if (e.key === "Escape") close();
    });
    input.addEventListener("blur", () => setTimeout(close, 100));
    document.querySelectorAll('input[name="tlKind"]').forEach(r => r.addEventListener("change", () => {
      input.placeholder = PLACEHOLDER[currentKind()];
      input.value = ""; close(); input.focus();
    }));
  }

  /** Open the Timeline tab on a sample (record key), patient, facility or lab. */
  function openTimeline(kind, value, switchTab = true) {
    const res = $("tlResult");
    Charts.destroyWithin(res);
    let view = null, label = value;
    if (kind === "sample") {
      const r = state.all.find(x => x.key === value);
      if (r) { view = Timeline.sampleView(r, state.all); label = r.id; }
    } else if (kind === "patient") {
      if (state.all.some(r => r.patientId === value)) view = Timeline.patientView(value, state.all);
    } else {
      view = Timeline.entityView(kind, value, state.all);
    }
    res.dataset.kind = kind;
    res.dataset.value = value;
    res.replaceChildren(view || emptyTimeline());
    const radio = document.querySelector(`input[name="tlKind"][value="${kind}"]`);
    if (radio) radio.checked = true;
    $("tlSearch").placeholder = PLACEHOLDER[kind];
    $("tlSearch").value = label;
    if (switchTab) {
      bootstrap.Tab.getOrCreateInstance($("tabTimelineBtn")).show();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  // ============================== boot ==============================
  function init() {
    initTheme();
    initUpload();
    initFilters();
    initTabs();
    initTimeline();
  }
  document.addEventListener("DOMContentLoaded", init);

  return { openTimeline, kpiRow, attachTip, state, filterParts, withExportLayout };
})();
