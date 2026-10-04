/* ==================================================================
   report.js - "Export PDF": a report of the dashboard tabs for the
   current filters, ready to share or print. Built with jsPDF and
   jsPDF-AutoTable (bundled in lib/, so it works offline).

   The tabs are drawn once in the light theme (App.withExportLayout) and
   read back from the page:
     - charts are copied in as 2x images
     - key numbers, the sample-status bars, the average journey and all
       tables are written as real PDF text (sharp, searchable, selectable)
================================================================== */

const Report = (() => {
  const $ = id => document.getElementById(id);

  const SECTIONS = {
    tabOverview: "Overview",
    tabTat: "Turnaround",
    tabBacklog: "Backlogs",
    tabSites: "Labs & Facilities",
  };
  // Page tables that are lists rather than the data behind a chart.
  const LIST_TABLES = new Set(["hvlTable", "blTable", "blPendingTable", "facTable"]);
  // Chart tables already covered by a list (the facility chart's table repeats the scorecard).
  const COVERED_BY_LISTS = new Set(["facilities"]);

  // Light-theme tokens (css/dashboard.css), as RGB for jsPDF.
  const INK1 = [11, 11, 11], INK2 = [82, 81, 78], MUTED = [137, 135, 129];
  const GRID = [225, 224, 217], BORDER = [227, 227, 224], HEAD_BG = [242, 242, 239], ACCENT = [42, 120, 214];

  const MARGIN = 14;  // mm

  // ---------- text: the built-in PDF fonts only cover Windows-1252 ----------
  const REPLACE = { "→": "->", "≥": ">=", "≤": "<=", "⇄": "", "⇢": "", "✓": "", "✕": "", "⊘": "", "◷": "", "▲": "", "✎": "", "⚠": "!", "↕": "", "↑": "", "↓": "" };
  const CP1252_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
  function clean(v) {
    if (v === null || v === undefined) return "–";
    return String(v)
      .replace(/[^\x00-\xFF]/g, ch => (ch in REPLACE ? REPLACE[ch] : CP1252_EXTRA.includes(ch) ? ch : ""))
      .replace(/\s+/g, " ")
      .trim();
  }
  const text = el => (el ? clean(el.textContent) : "");

  function rgbOf(el) {
    const m = getComputedStyle(el).backgroundColor.match(/[\d.]+/g);
    return m ? m.slice(0, 3).map(Number) : ACCENT;
  }
  function colorOf(el) {
    const m = getComputedStyle(el).color.match(/[\d.]+/g);
    return m ? m.slice(0, 3).map(Number) : ACCENT;
  }

  // ---------- read the laid-out tabs into plain blocks ----------
  function kpisFrom(container) {
    return [...container.querySelectorAll(".kpi")].map(k => ({
      value: text(k.querySelector(".kpi-value")),
      label: text(k.querySelector(".kpi-label")),
      sub: text(k.querySelector(".kpi-sub")),
      warn: text(k.querySelector(".warn-note")),
      color: k.querySelector(".kpi-icon") ? colorOf(k.querySelector(".kpi-icon")) : ACCENT,
    }));
  }

  function cardHead(card) {
    return { title: text(card.querySelector(".viz-title")), hint: text(card.querySelector(".viz-hint")) };
  }

  function tableRows(tbl) {
    const head = [...tbl.querySelectorAll("thead th")].map(text);
    const body = [...tbl.querySelectorAll("tbody tr")].map(tr => [...tr.cells].map(text));
    return { head, body };
  }

  function captureSection(id, opts) {
    const pane = $(id);
    const blocks = [];
    for (const el of pane.querySelectorAll("#kpiRow, #blKpis, .viz-card")) {
      if (el.id === "kpiRow" || el.id === "blKpis") {
        blocks.push({ type: "kpis", items: kpisFrom(el) });
        continue;
      }
      const head = cardHead(el);
      const canvas = el.querySelector("canvas");
      if (canvas) {
        if (!canvas.width || !canvas.height) continue;
        const key = el.dataset.chart;
        const table = opts.tables && key && !(opts.lists && COVERED_BY_LISTS.has(key)) ? Charts.getTable(key) : null;
        blocks.push({ type: "chart", ...head, img: canvas.toDataURL("image/png"), w: canvas.width, h: canvas.height,
          table: table && { head: table.head.map(clean), body: table.rows.map(r => r.map(clean)) } });
      } else if (el.querySelector("#statusBars")) {
        const rows = [...el.querySelectorAll(".status-row")].map(r => {
          const fill = r.querySelector(".status-fill");
          const spans = r.querySelectorAll(".status-label > span");
          return {
            label: text(r.querySelector(".status-label strong")),
            value: text(spans[spans.length - 1]),
            frac: Math.min(1, (parseFloat(fill.style.width) || 0) / 100),
            color: rgbOf(fill),
          };
        });
        const table = opts.tables ? Charts.getTable(el.dataset.chart) : null;
        blocks.push({ type: "status", ...head, rows,
          table: table && { head: table.head.map(clean), body: table.rows.map(r => r.map(clean)) } });
      } else if (el.querySelector("#avgJourney")) {
        const steps = [...el.querySelectorAll(".journey .j-step")].map(s => text(s.querySelector(".j-name")));
        const gaps = [...el.querySelectorAll(".journey .j-link")].map(l => text(l.querySelector(".j-days")));
        blocks.push({ type: "journey", ...head, steps, gaps, kpis: kpisFrom(el) });
      } else {
        const tbl = el.querySelector("table");
        if (tbl && LIST_TABLES.has(tbl.id)) {
          if (opts.lists) blocks.push({ type: "list", ...head, count: text(el.querySelector(".badge")), ...tableRows(tbl) });
        } else if (!tbl) {
          const p = text(el);
          if (p) blocks.push({ type: "note", text: p });
        }
      }
    }
    return { id, title: SECTIONS[id], blocks };
  }

  // ---------- PDF drawing ----------
  function makeWriter(doc) {
    const pw = doc.internal.pageSize.getWidth(), ph = doc.internal.pageSize.getHeight();
    const W = pw - 2 * MARGIN, bottom = ph - MARGIN - 6;   // leave room for the footer
    const w = { doc, pw, ph, W, bottom, y: MARGIN };

    w.fits = hgt => w.y + hgt <= bottom;
    w.ensure = hgt => { if (!w.fits(hgt)) { doc.addPage(); w.y = MARGIN; } };
    w.font = (size, style = "normal", color = INK1) => {
      doc.setFont("helvetica", style); doc.setFontSize(size); doc.setTextColor(...color);
    };
    // Wrapped paragraph; returns its height in mm.
    w.para = (str, size, style, color, width = W, x = MARGIN) => {
      w.font(size, style, color);
      const lines = doc.splitTextToSize(str, width);
      const lh = size * 0.3528 * 1.25;
      doc.text(lines, x, w.y + size * 0.3528);
      w.y += lines.length * lh;
      return lines.length * lh;
    };
    w.measure = (str, size, width = W) => {
      doc.setFontSize(size);
      return doc.splitTextToSize(str, width).length * size * 0.3528 * 1.25;
    };
    return w;
  }

  function drawHeading(w, title, hint) {
    const need = 7 + (hint ? w.measure(hint, 8) : 0) + 20;   // keep the heading with some content
    w.ensure(need);
    w.para(title, 11, "bold", INK1);
    if (hint) { w.y += 0.5; w.para(hint, 8, "normal", INK2); }
    w.y += 2.5;
  }

  function drawKpis(w, items) {
    if (!items.length) return;
    const { doc } = w;
    const perRow = w.W > 200 ? 5 : 4, gap = 3;
    const tw = (w.W - gap * (perRow - 1)) / perRow;
    for (let i = 0; i < items.length; i += perRow) {
      const row = items.slice(i, i + perRow);
      const th = Math.max(...row.map(k => 13 + (k.sub ? w.measure(k.sub, 6.5, tw - 6) : 0) + (k.warn ? 3.5 : 0)));
      w.ensure(th + gap);
      row.forEach((k, j) => {
        const x = MARGIN + j * (tw + gap), y = w.y;
        doc.setDrawColor(...BORDER); doc.setLineWidth(0.25);
        doc.roundedRect(x, y, tw, th, 2, 2, "S");
        doc.setFillColor(...k.color);
        doc.rect(x, y + 2.5, 1.2, th - 5, "F");
        w.font(14, "bold", INK1); doc.text(k.value || "–", x + 4, y + 6.5);
        w.font(7.5, "normal", INK2); doc.text(doc.splitTextToSize(k.label, tw - 6)[0], x + 4, y + 10.5);
        let yy = y + 13.5;
        if (k.sub) {
          w.font(6.5, "normal", MUTED);
          const lines = doc.splitTextToSize(k.sub, tw - 6);
          doc.text(lines, x + 4, yy);
          yy += lines.length * 6.5 * 0.3528 * 1.25;
        }
        if (k.warn) { w.font(6.5, "normal", [208, 59, 59]); doc.text(k.warn, x + 4, yy + 0.5); }
      });
      w.y += th + gap;
    }
    w.y += 2;
  }

  function drawTable(w, head, body, { fontSize = 7.5, title = null } = {}) {
    if (!body.length) return;
    w.ensure(14);
    if (title) { w.para(title, 8, "bold", INK2); w.y += 1; }
    autoTable(w.doc, {
      startY: w.y,
      head: [head],
      body,
      theme: "plain",
      // Few columns read better as a compact table than spread over the page.
      tableWidth: head.length <= 4 ? Math.min(w.W, 150) : "auto",
      margin: { left: MARGIN, right: MARGIN, top: MARGIN, bottom: w.ph - w.bottom },
      styles: { font: "helvetica", fontSize, cellPadding: { top: 1, bottom: 1, left: 1.5, right: 1.5 }, textColor: INK1, lineColor: GRID, overflow: "linebreak" },
      headStyles: { fillColor: HEAD_BG, textColor: INK2, fontStyle: "bold" },
      bodyStyles: { lineWidth: { bottom: 0.15 } },
      didParseCell: d => {
        // Right-align numbers; bold the "Total" row of month-by-month tables.
        if (d.section === "body") {
          const raw = String(d.cell.raw ?? "");
          if (d.column.index > 0 && /^[-–\d.,%\s/d]+$/.test(raw)) d.cell.styles.halign = "right";
          if (d.row.raw && d.row.raw[0] === "Total") d.cell.styles.fontStyle = "bold";
        }
      },
    });
    w.y = w.doc.lastAutoTable.finalY + 6;
  }

  function drawChart(w, b, landscape) {
    const ratio = b.h / b.w;
    const maxH = landscape ? 80 : 85;
    let iw = w.W, ih = iw * ratio;
    if (ih > maxH) { ih = maxH; iw = ih / ratio; }
    // Keep the heading on the same page as its chart.
    w.ensure(7 + (b.hint ? w.measure(b.hint, 8) + 0.5 : 0) + 2.5 + ih + 2);
    drawHeading(w, b.title, b.hint);
    w.doc.addImage(b.img, "PNG", MARGIN, w.y, iw, ih, undefined, "FAST");
    w.y += ih + 5;
    if (b.table) drawTable(w, b.table.head, b.table.body);
    else w.y += 2;
  }

  function drawStatus(w, b) {
    const { doc } = w;
    drawHeading(w, b.title, b.hint);
    const barW = Math.min(w.W, 150);
    b.rows.forEach(r => {
      w.ensure(9);
      w.font(8.5, "bold", INK1); doc.text(r.label, MARGIN, w.y + 3);
      w.font(8.5, "normal", INK2); doc.text(r.value, MARGIN + barW, w.y + 3, { align: "right" });
      doc.setFillColor(...GRID); doc.roundedRect(MARGIN, w.y + 4.5, barW, 2.6, 1.3, 1.3, "F");
      if (r.frac > 0) { doc.setFillColor(...r.color); doc.roundedRect(MARGIN, w.y + 4.5, Math.max(2.6, barW * r.frac), 2.6, 1.3, 1.3, "F"); }
      w.y += 9.5;
    });
    w.y += 3;
    if (b.table) drawTable(w, b.table.head, b.table.body);
  }

  function drawJourney(w, b) {
    const { doc } = w;
    drawHeading(w, b.title, b.hint);
    w.ensure(20);
    const n = b.steps.length;
    const step = w.W / n, r = 3.2, cy = w.y + r + 1;
    for (let i = 0; i < n; i++) {
      const cx = MARGIN + step * i + step / 2;
      if (i < n - 1) {
        doc.setDrawColor(...ACCENT); doc.setLineWidth(0.6);
        doc.line(cx + r + 1, cy, cx + step - r - 1, cy);
        w.font(8.5, "bold", INK1);
        doc.text(b.gaps[i] || "–", cx + step / 2, cy - 1.8, { align: "center" });
      }
      doc.setFillColor(...ACCENT); doc.circle(cx, cy, r, "F");
      w.font(8.5, "bold", INK1); doc.text(b.steps[i], cx, cy + r + 4.5, { align: "center" });
    }
    w.y = cy + r + 10;
    drawKpis(w, b.kpis);
  }

  function drawList(w, b) {
    drawHeading(w, b.title + (b.count ? ` (${b.count})` : ""), b.hint.replace(/\s*Click[^.]*\.\s*/g, " ").trim());
    // Rows that are only a message ("No samples…", "Showing the 300 oldest…") span the table.
    const body = b.body.map(r => (r.length === 1 && b.head.length > 1
      ? [{ content: r[0], colSpan: b.head.length, styles: { textColor: INK2, fontStyle: "italic" } }] : r));
    drawTable(w, b.head, body, { fontSize: 7 });
  }

  function drawCover(w, meta) {
    const { doc } = w;
    // The dashboard's three-bar mark.
    [[0, 5, ACCENT], [3.3, 3, [235, 104, 52]], [6.6, 0, [27, 175, 122]]].forEach(([dx, dy, c]) => {
      doc.setFillColor(...c); doc.roundedRect(MARGIN + dx, w.y + dy, 2.5, 8 - dy, 0.6, 0.6, "F");
    });
    w.font(18, "bold", INK1); doc.text("Viral load report", MARGIN + 12, w.y + 7);
    w.y += 14;
    const line = (label, value) => {
      w.font(9, "bold", INK2); doc.text(label, MARGIN, w.y + 3.2);
      w.para(value, 9, "normal", INK1, w.W - 28, MARGIN + 28);
      w.y += 1.2;
    };
    line("File", meta.file);
    line("Samples", meta.samples);
    line("Filters", meta.filters);
    line("Created", meta.created);
    w.y += 2;
    doc.setDrawColor(...GRID); doc.setLineWidth(0.3); doc.line(MARGIN, w.y, MARGIN + w.W, w.y);
    w.y += 6;
  }

  function drawFooters(w, meta) {
    const { doc } = w, n = doc.getNumberOfPages();
    for (let i = 1; i <= n; i++) {
      doc.setPage(i);
      w.font(7, "normal", MUTED);
      doc.text(`VL Dashboard · ${meta.file}${meta.filtersShort ? " · " + meta.filtersShort : ""}`.slice(0, 140), MARGIN, w.ph - MARGIN + 2);
      doc.text(`Page ${i} of ${n}`, w.pw - MARGIN, w.ph - MARGIN + 2, { align: "right" });
    }
  }

  function buildPdf(sections, opts, meta) {
    const { jsPDF } = window.jspdf;
    const landscape = opts.orientation === "landscape";
    const doc = new jsPDF({ orientation: opts.orientation, unit: "mm", format: "a4", compress: true });
    doc.setProperties({ title: `Viral load report · ${meta.file}`, subject: meta.filters, creator: "VL Dashboard" });
    const w = makeWriter(doc);
    drawCover(w, meta);

    sections.forEach((sec, i) => {
      if (i > 0) { doc.addPage(); w.y = MARGIN; }
      w.font(15, "bold", INK1); doc.text(clean(sec.title), MARGIN, w.y + 5);
      doc.setFillColor(...ACCENT); doc.rect(MARGIN, w.y + 7.5, 16, 0.8, "F");
      w.y += 13;
      for (const b of sec.blocks) {
        if (b.type === "kpis") drawKpis(w, b.items);
        else if (b.type === "chart") drawChart(w, b, landscape);
        else if (b.type === "status") drawStatus(w, b);
        else if (b.type === "journey") drawJourney(w, b);
        else if (b.type === "list") drawList(w, b);
        else if (b.type === "note") { w.ensure(10); w.para(b.text, 8.5, "normal", INK2); w.y += 4; }
      }
    });
    drawFooters(w, meta);
    return doc;
  }

  // ---------- the dialog ----------
  function pad(n) { return String(n).padStart(2, "0"); }

  function reportMeta() {
    const st = App.state, parts = App.filterParts();
    const now = new Date();
    return {
      file: clean(st.fileName) + (st.source === "raw" ? " (raw InteLIS export)" : ""),
      samples: `${st.view.length.toLocaleString()} of ${st.all.length.toLocaleString()} samples in the file`,
      filters: clean(parts.length ? parts.join(" · ") : "None (all months, laboratories, facilities and entry types)"),
      filtersShort: clean(parts.join(" · ")),
      created: `${pad(now.getDate())}-${pad(now.getMonth() + 1)}-${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
      stamp: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    };
  }

  function fileNameFor(meta) {
    const base = App.state.fileName.replace(/\.xlsx?$/i, "").replace(/[^\w\-]+/g, "_").replace(/_+/g, "_").slice(0, 60);
    const scope = App.filterParts().join("_").replace(/[^\w\-]+/g, "_").replace(/_+/g, "_").slice(0, 40);
    return `VL-report_${base}${scope ? "_" + scope : ""}_${meta.stamp}.pdf`;
  }

  const nextFrame = () => new Promise(r => setTimeout(r, 30));

  async function exportPdf(opts) {
    const overlay = $("exportOverlay"), status = $("exportStatus");
    overlay.classList.remove("d-none");
    status.textContent = "Drawing the charts…";
    await nextFrame();
    try {
      const sections = await App.withExportLayout(opts.sections, async () =>
        opts.sections.map(id => captureSection(id, opts)));
      status.textContent = "Writing the PDF…";
      await nextFrame();
      const meta = reportMeta();
      const doc = buildPdf(sections, opts, meta);
      doc.save(fileNameFor(meta));
    } finally {
      overlay.classList.add("d-none");
    }
  }

  function init() {
    const modalEl = $("exportModal"), form = $("exportForm"), err = $("exportError");
    const modal = () => bootstrap.Modal.getOrCreateInstance(modalEl);
    $("btnExport").addEventListener("click", () => {
      const parts = App.filterParts();
      $("exportScope").textContent = `${App.state.view.length.toLocaleString()} samples` + (parts.length ? ` · ${parts.join(" · ")}` : " · no filters");
      err.classList.add("d-none");
      modal().show();
    });
    form.addEventListener("submit", async e => {
      e.preventDefault();
      const sections = [...form.querySelectorAll('input[name="section"]:checked')].map(i => i.value);
      if (!sections.length) { err.textContent = "Pick at least one section."; err.classList.remove("d-none"); return; }
      if (!window.jspdf || typeof window.autoTable !== "function") {
        err.textContent = "The PDF library (lib/jspdf.umd.min.js) is missing."; err.classList.remove("d-none"); return;
      }
      modal().hide();
      try {
        await exportPdf({
          sections,
          tables: $("exTables").checked,
          lists: $("exLists").checked,
          orientation: form.querySelector('input[name="exOrient"]:checked').value,
        });
      } catch (ex) {
        console.error(ex);
        err.textContent = "The PDF could not be created: " + (ex.message || ex);
        err.classList.remove("d-none");
        modal().show();
      }
    });
  }
  document.addEventListener("DOMContentLoaded", init);

  return { exportPdf, buildPdf, captureSection };
})();
