/* ==================================================================
   timeline.js - the journey stepper and the Timeline tab views
   (sample, patient, facility, laboratory).

   All text from the workbook is inserted with textContent, never innerHTML.
================================================================== */

const Timeline = (() => {
  const { fmtDate, monthLabel, summarize, groupBy } = VLData;

  // ---------- tiny DOM helper ----------
  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style") el.style.cssText = v;
      else if (k === "html") el.innerHTML = v;          // only ever used with our own static SVG
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    }
    return el;
  }

  const ICONS = {

    collect: '<svg viewBox="0 0 24 24"><path d="M9 3h6M10 3v11a2 2 0 004 0V3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M7 20h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    receive: '<svg viewBox="0 0 24 24"><path d="M3 7h11v9H3zM14 10h4l3 3v3h-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="7" cy="18" r="1.8" fill="currentColor"/><circle cx="17" cy="18" r="1.8" fill="currentColor"/></svg>',
    test: '<svg viewBox="0 0 24 24"><path d="M9 3v6l-5 9a2 2 0 002 3h12a2 2 0 002-3l-5-9V3M8 3h8" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
    print: '<svg viewBox="0 0 24 24"><path d="M7 8V3h10v5M7 17H4v-7h16v7h-3M7 14h10v7H7z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  };

  // "Request Created On" is when the record was entered in InteLIS (often after
  // collection), so it is shown as a fact, not as a step of the journey.
  const STEPS = [
    { key: "collected", name: "Collected", icon: "collect" },
    { key: "received", name: "At the lab", icon: "receive" },
    { key: "tested", name: "Tested", icon: "test" },
    { key: "printed", name: "Result printed", icon: "print" },
  ];

  /**
   * Horizontal stepper. `points` = {collected, received, tested, printed}
   * as serial dates (single sample) or null. `gaps` optional override of the
   * day labels between steps (used for averages).
   */
  function journey(points, { gaps = null, avgMode = false } = {}) {
    const wrap = h("div", { class: "journey", role: "list" });
    const shown = STEPS;
    shown.forEach((s, i) => {
      const val = points[s.key];
      // Averages: a step counts as reached if some sample has data for the gap leading to it.
      const has = avgMode ? (i === 0 || (gaps && gaps[i - 1] !== null)) : val !== null && val !== undefined;
      wrap.appendChild(h("div", { class: `j-step${has ? "" : " missing"}`, role: "listitem" },
        h("div", { class: "j-dot", html: ICONS[s.icon] }),
        h("div", { class: "j-name" }, s.name),
        h("div", { class: "j-date" }, avgMode ? "" : has ? fmtDate(val, true) : "not yet"),
      ));
      if (i < shown.length - 1) {
        const next = shown[i + 1];
        let days = null;
        if (gaps) days = gaps[i];
        else if (has && points[next.key] !== null && points[next.key] !== undefined) {
          days = VLData.dayDiff(val, points[next.key]);
        }
        const bad = days !== null && days < 0;
        wrap.appendChild(h("div", { class: `j-link${days !== null ? (bad ? " bad" : " done") : ""}` },
          h("div", { class: "j-line" }),
          h("div", { class: "j-days" },
            days === null ? h("span", {}, "–") :
              [h("strong", {}, String(days)), ` day${Math.abs(days) === 1 ? "" : "s"}`],
            bad ? h("div", { class: "warn-note" }, "⚠ date error") : null),
        ));
      }
    });
    return wrap;
  }

  // ---------- status chips (icon + label, never color alone) ----------
  function statusChips(r) {
    const chips = [];
    chips.push(h("span", { class: `chip chip-${r.entry === "Remote" ? "remote" : "manual"}` },
      r.entry === "Remote" ? "⇄ Remote" : r.entry === "Manual" ? "✎ Manual" : "? Unknown entry"));
    if (/^y/i.test(r.rejected)) chips.push(h("span", { class: "chip chip-critical" }, "✕ Rejected"));
    if (r.failed) chips.push(h("span", { class: "chip chip-critical" }, "✕ Failed"));
    else if (r.pending) chips.push(h("span", { class: "chip chip-warning" }, "◷ Pending test"));
    else if (r.highVl) chips.push(h("span", { class: "chip chip-serious" }, "▲ High VL"));
    else chips.push(h("span", { class: "chip chip-good" }, "✓ Tested"));
    if (r.notTransported) chips.push(h("span", { class: "chip chip-warning" }, "◷ Not yet at lab"));
    return h("span", { class: "d-inline-flex flex-wrap align-items-start align-self-start gap-1" }, chips);
  }

  function resultText(r) {
    if (r.resultText) return r.resultText + (r.vl !== null ? " cp/mL" : "");
    return r.pending ? "Not tested yet" : "No result";
  }

  // "Where the time went" proportional bar for one sample.
  function timeSplit(r) {
    const segs = [
      { label: "Transport to lab", days: r.transport, color: "var(--series-1)" },
      { label: "Waiting / testing in lab", days: r.inLab, color: "var(--series-2)" },
      { label: "Validation & printing", days: r.validation, color: "var(--series-3)" },
    ].filter(s => s.days !== null && s.days >= 0);
    const total = segs.reduce((a, s) => a + s.days, 0);
    if (!segs.length || total === 0) return null;
    const bar = h("div", { class: "time-split" });
    segs.forEach(s => {
      if (!s.days) return;
      const seg = h("div", { style: `flex:${s.days};background:${s.color}`, tabindex: "0" });
      App.attachTip(seg, () => `<strong>${s.days} days</strong><br>${s.label}`);
      bar.appendChild(seg);
    });
    return h("div", { class: "mt-3" },
      h("div", { class: "small text-secondary" }, `Where the ${total} days went`),
      bar,
      h("div", { class: "legend" }, segs.map(s => h("span", {}, h("i", { style: `background:${s.color}` }), `${s.label}: ${s.days} d`))));
  }

  // ---------- views ----------
  function sampleView(r, allRecords) {
    const labAvg = summarize(allRecords.filter(x => x.lab === r.lab)).tatStats.avg;
    const card = h("div", { class: "viz-card" },
      h("div", { class: "d-flex flex-wrap justify-content-between gap-2 mb-2" },
        h("div", {},
          h("h2", { class: "h5 mb-1" }, r.id),
          r.remoteId && r.remoteId !== r.id ? h("div", { class: "small text-secondary" }, `Remote ID: ${r.remoteId}`) : null),
        statusChips(r)),
      journey(r),
      timeSplit(r),
      h("hr"),
      h("dl", { class: "fact-grid mb-0" },
        fact("Viral load", resultText(r)),
        fact("Testing TAT", r.tat !== null ? `${r.tat} days` + (labAvg !== null ? ` (lab average ${labAvg})` : "") : "–"),
        fact("Laboratory", linkish(r.lab, () => App.openTimeline("lab", r.lab))),
        fact("Facility", linkish(r.facility, () => App.openTimeline("facility", r.facility))),
        fact("Patient ID", r.patientId ? linkish(r.patientId, () => App.openTimeline("patient", r.patientId)) : "–"),
        fact("Sex / Age", [r.sex, r.age].filter(Boolean).join(" / ") || "–"),
        fact("Sample type", r.sampleType || "–"),
        fact("Reason for test", r.indication || "–"),
        fact("Entered in system", r.created !== null ? fmtDate(r.created, true) : "–"),
      ));
    return card;
  }

  function fact(label, value) {
    return h("div", {}, h("dt", {}, label), h("dd", {}, value));
  }
  function linkish(text, fn) {
    return text && text !== "N/A" ? h("button", { class: "link-btn", type: "button", onclick: fn }, text) : (text || "–");
  }

  function compactSample(r) {
    return h("div", { class: "sample-card" },
      h("div", { class: "d-flex flex-wrap justify-content-between gap-2 mb-1" },
        h("div", {},
          h("button", { class: "link-btn fw-semibold", type: "button", onclick: () => App.openTimeline("sample", r.key) }, r.id),
          h("span", { class: "small text-secondary ms-2" }, resultText(r))),
        statusChips(r)),
      journey(r));
  }

  function patientView(pid, allRecords) {
    const recs = allRecords.filter(r => r.patientId === pid)
      .sort((a, b) => (a.collected ?? 0) - (b.collected ?? 0));
    const first = recs[0];
    const wrap = h("div", {});
    wrap.appendChild(h("div", { class: "viz-card mb-3" },
      h("div", { class: "d-flex flex-wrap justify-content-between gap-2" },
        h("div", {},
          h("h2", { class: "h5 mb-1" }, `Patient ${pid}`),
          h("div", { class: "small text-secondary" },
            `${recs.length} sample${recs.length === 1 ? "" : "s"} · ${[first.sex, first.age ? first.age + " yrs" : ""].filter(Boolean).join(", ")} · ${first.facility}`)),
        h("div", {}, recs.some(r => r.highVl) ? h("span", { class: "chip chip-serious" }, "▲ Has had a high VL") : h("span", { class: "chip chip-good" }, "✓ No high VL on record"))),
      h("div", { class: "chart-box chart-sm mt-3" }, h("canvas", { id: "cPatientVl" })),
      h("div", { class: "small text-secondary mt-1" }, "Viral load over time (log scale). The dashed line is 1000 cp/mL. “Target not detected” is drawn at the bottom.")));
    wrap.appendChild(h("h3", { class: "h6 mt-3 mb-2" }, "Every sample, oldest first"));
    recs.forEach(r => wrap.appendChild(compactSample(r)));

    // chart drawn after the canvas is in the DOM
    requestAnimationFrame(() => drawPatientChart(recs));
    return wrap;
  }

  function drawPatientChart(recs) {
    const t = Charts.tokens();
    const pts = recs.filter(r => r.collected !== null && !r.pending && !r.failed);
    const FLOOR = 10;
    const labels = pts.map(r => fmtDate(r.collected));
    const values = pts.map(r => (r.vl !== null ? Math.max(r.vl, FLOOR) : FLOOR));
    const colors = pts.map(r => (r.highVl ? t.critical : t.s1));
    Charts.render("cPatientVl", {
      type: "line",
      data: {
        labels,
        datasets: [
          Charts.lineDataset("Viral load (cp/mL)", values, t.s1, { pointBackgroundColor: colors, pointRadius: 6 }),
        ],
      },
      options: {
        scales: (() => {
          const sc = Charts.scales({ logY: true, yTitle: "cp/mL" });
          // Keep the 1000 cp/mL line mid-chart and "not detected" on the floor.
          sc.y.min = FLOOR;
          sc.y.max = Math.max(100000, ...values.map(x => x * 10));
          sc.x.offset = true;
          sc.y.ticks.callback = v => ([10, 100, 1000, 10000, 100000, 1e6, 1e7, 1e8].includes(v) ? v.toLocaleString() : "");
          return sc;
        })(),
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: { label: ctx => { const r = pts[ctx.dataIndex]; return r.resultText || "Target not detected"; } },
          },
        },
      },
      plugins: [{
        id: "vlThreshold",
        beforeDatasetsDraw(chart) {
          const { ctx, chartArea: a, scales: { y } } = chart;
          const py = y.getPixelForValue(VLData.HIGH_VL);
          ctx.save();
          ctx.strokeStyle = t.muted; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
          ctx.beginPath(); ctx.moveTo(a.left, py); ctx.lineTo(a.right, py); ctx.stroke();
          ctx.setLineDash([]); ctx.fillStyle = t.ink2; ctx.font = "11px system-ui, sans-serif";
          ctx.textAlign = "right"; ctx.fillText("1000 cp/mL", a.right, py - 4);
          ctx.restore();
        },
      }],
    });
    Charts.setTable("patient", "Viral load over time", ["Collected", "Result", "Sample"],
      pts.map(r => [fmtDate(r.collected), r.resultText, r.id]));
  }

  /** Facility or lab: activity over time + average journey + recent samples. */
  function entityView(kind, name, allRecords) {
    const recs = allRecords.filter(r => (kind === "lab" ? r.lab : r.facility) === name);
    const s = summarize(recs);
    const dated = recs.filter(r => r.collected !== null).map(r => r.collected);
    const firstD = dated.length ? Math.min(...dated) : null;
    const lastD = dated.length ? Math.max(...dated) : null;

    const wrap = h("div", {});
    const other = kind === "lab"
      ? `${new Set(recs.map(r => r.facility)).size} facilities send samples here`
      : `Sends samples to ${[...new Set(recs.map(r => r.lab))].join(", ")}`;
    wrap.appendChild(h("div", { class: "viz-card mb-3" },
      h("h2", { class: "h5 mb-1" }, name),
      h("div", { class: "small text-secondary mb-3" },
        `${kind === "lab" ? "Laboratory" : "Facility"} · ${other} · ` +
        (firstD !== null ? `first sample ${fmtDate(firstD)}, latest ${fmtDate(lastD)}` : "no collection dates")),
      App.kpiRow(s, true),
    ));

    const trendCard = h("div", { class: "viz-card mb-3" },
      h("div", { class: "viz-head" },
        h("div", {}, h("h3", { class: "viz-title" }, "Activity month by month"),
          h("p", { class: "viz-hint" }, "Bars = samples collected. Line = average testing TAT (days)."))),
      h("div", { class: "row g-3" },
        h("div", { class: "col-lg-6" }, h("div", { class: "chart-box" }, h("canvas", { id: "cEntVol" }))),
        h("div", { class: "col-lg-6" }, h("div", { class: "chart-box" }, h("canvas", { id: "cEntTat" })))));
    wrap.appendChild(trendCard);

    wrap.appendChild(h("div", { class: "viz-card mb-3" },
      h("h3", { class: "viz-title" }, "Average journey of a sample"),
      h("p", { class: "viz-hint" }, "Average days between steps."),
      journey({}, { avgMode: true, gaps: [s.transportStats.avg, s.inLabStats.avg, s.validationStats.avg] })));

    const recent = [...recs].sort((a, b) => (b.collected ?? 0) - (a.collected ?? 0)).slice(0, 15);
    wrap.appendChild(h("div", { class: "viz-card" },
      h("h3", { class: "viz-title mb-2" }, `Latest ${recent.length} samples`),
      recent.map(compactSample)));

    requestAnimationFrame(() => {
      const byMonth = [...groupBy(recs, r => r.month).entries()].sort((a, b) => a[0].localeCompare(b[0]));
      const t = Charts.tokens();
      const labels = byMonth.map(([k]) => monthLabel(k, true));
      Charts.render("cEntVol", {
        type: "bar",
        data: {
          labels, datasets: [
            Charts.barDataset("Remote", byMonth.map(([, v]) => v.filter(r => r.entry === "Remote").length), t.s1, { borderWidth: { top: 2 } }),
            Charts.barDataset("Manual", byMonth.map(([, v]) => v.filter(r => r.entry === "Manual").length), t.s2, { borderWidth: { top: 2 } }),
          ],
        },
        options: { scales: Charts.scales({ stacked: true, yTitle: "Samples" }), interaction: { mode: "index", intersect: false } },
      });
      const monthStats = byMonth.map(([, v]) => summarize(v));
      Charts.render("cEntTat", {
        type: "line",
        data: {
          labels, datasets: [
            Charts.lineDataset("Testing TAT", monthStats.map(m => m.tatStats.avg), t.s1),
            Charts.lineDataset("Transport", monthStats.map(m => m.transportStats.avg), t.s2),
          ],
        },
        options: { scales: Charts.scales({ yTitle: "Days" }), interaction: { mode: "index", intersect: false } },
      });
    });
    return wrap;
  }

  return { journey, sampleView, patientView, entityView, statusChips, resultText, h };
})();
