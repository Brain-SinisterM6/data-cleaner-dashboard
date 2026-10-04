/* ==================================================================
   data.js - read a VL workbook into sample records.

   Accepts either the raw InteLIS VL export or the _cleaned.xlsx made by
   Data-Cleaner.py. The dashboard works from the data sheet(s) (one row per
   sample) rather than the cleaner's summary sheets, so every number can be
   recomputed for any month / lab / facility selection.

   Raw exports store dates as text ("21-08-2026", "07-09-2026 13:05"); they
   are read with the same formats the cleaner converts (dd-mm-yyyy,
   dd/mm/yyyy, yyyy-mm-dd, with or without a time), so a raw file and its
   cleaned copy give the same numbers. Banner rows above the headers and
   trailing blank rows are skipped.

   The rules below mirror Data-Cleaner.py so the numbers agree with the
   Statistics sheet:
     - Remote  = Remote Sample ID present
     - Manual  = Sample ID present and no Remote Sample ID
     - Pending = no "Sample Tested On" date
     - Failed  = Result (cp/mL) or Result (log) contains invalid/error/fail
     - High VL = numeric Result (cp/mL) >= 1000 ("<40" reads as 40)
     - Day counts = whole days, rounded down like Python's timedelta.days
     - Negative day counts are excluded from averages and minimums
     - Backlog = collected in a month but not tested in that same month
       (tested later or not at all). Rejected samples are never backlog.
       Transported = has a Sample Reception Date.
================================================================== */

const VLData = (() => {
  const HIGH_VL = 1000;

  // Sheets the cleaner adds; never treated as sample data.
  const SUMMARY_SHEETS = new Set(
    ["statistics", "tat", "high viral load", "sample dispatch", "monthly breakdown", "backlogs", "charts"]
  );

  const COLS = {
    sno: ["S.No."],
    sampleId: ["Sample ID"],
    remoteId: ["Remote Sample ID"],
    lab: ["Testing Lab"],
    facility: ["Health Facility Name"],
    facilityCode: ["Health Facility Code"],
    district: ["District/County"],
    region: ["Province/State"],
    patientId: ["Unique ART No.", "Patient ID", "ART No."],
    sex: ["Sex"],
    age: ["Age"],
    sampleType: ["Sample Type"],
    indication: ["Indication for Viral Load Testing"],
    rejected: ["Is Sample Rejected?"],
    created: ["Request Created On"],
    collected: ["Date of Sample Collection"],
    received: ["Sample Reception Date"],
    tested: ["Sample Tested On"],
    printed: ["Result Printed Date"],
    resultCp: ["Result (cp/mL)"],
    resultLog: ["Result (log)"],
  };
  const DATE_FIELDS = ["created", "collected", "received", "tested", "printed"];

  const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
    "August", "September", "October", "November", "December"];

  const blank = v => v === null || v === undefined || String(v).trim() === "";

  // ---- dates as Excel serial numbers (days since 1899-12-30), no time zones ----
  const TEXT_DATE = /^(\d{1,4})[-/](\d{1,2})[-/](\d{1,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

  function toSerial(v) {
    if (blank(v)) return null;
    if (typeof v === "number") return v > 0 ? v : null;
    if (v instanceof Date) return v.getTime() / 86400000 + 25569;
    const m = String(v).trim().match(TEXT_DATE);
    if (!m) return null;
    let [, a, b, c, hh = 0, mm = 0, ss = 0] = m;
    let y, mo, d;
    if (a.length === 4) { y = +a; mo = +b; d = +c; } else { d = +a; mo = +b; y = +c; }
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const ms = Date.UTC(y, mo - 1, d, +hh, +mm, +ss);
    return ms / 86400000 + 25569;
  }

  function serialToDate(s) {
    return new Date(Math.round((s - 25569) * 86400000));
  }

  function fmtDate(s, withTime = false) {
    if (s === null || s === undefined) return "";
    const d = serialToDate(s);
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    let out = `${dd}-${mm}-${d.getUTCFullYear()}`;
    if (withTime && (d.getUTCHours() || d.getUTCMinutes())) {
      out += ` ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
    }
    return out;
  }

  function monthKey(s) {
    const d = serialToDate(s);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  function monthLabel(key, short = false) {
    const [y, m] = key.split("-").map(Number);
    const name = MONTHS[m - 1];
    return short ? `${name.slice(0, 3)} ${String(y).slice(2)}` : `${name} ${y}`;
  }

  // Whole days between two serials, floored like Python's timedelta.days.
  // Rounded to the second first so float noise can't knock 12.0 down to 11.
  function dayDiff(from, to) {
    if (from === null || to === null) return null;
    return Math.floor(Math.round((to - from) * 86400) / 86400);
  }

  function hasFailure(v) {
    if (blank(v)) return false;
    const t = String(v).toLowerCase();
    return t.includes("invalid") || t.includes("error") || t.includes("fail");
  }

  function parseVL(v) {
    if (blank(v)) return null;
    if (typeof v === "number") return v;
    const t = String(v).trim().replace(/^[<>]+/, "").replace(/,/g, "").trim();
    if (t === "" || !/^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(t)) return null;
    return parseFloat(t);
  }

  // ---- stats helpers ----
  function avgNonNeg(values) {
    const v = values.filter(x => x !== null && x >= 0);
    return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
  }
  function minNonNeg(values) {
    const v = values.filter(x => x !== null && x >= 0);
    return v.length ? Math.min(...v) : null;
  }
  function maxOf(values) {
    const v = values.filter(x => x !== null);
    return v.length ? Math.max(...v) : null;
  }

  // ---- workbook parsing ----
  function findHeaderRow(rows) {
    // The cleaner expects headers in row 1, but tolerate a banner row or two.
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      const cells = (rows[i] || []).map(c => String(c ?? "").trim().toLowerCase());
      if (cells.includes("sample id") || cells.includes("remote sample id")) return i;
    }
    return -1;
  }

  function mapColumns(header) {
    const norm = header.map(h => String(h ?? "").trim().toLowerCase());
    const idx = {};
    for (const [key, names] of Object.entries(COLS)) {
      idx[key] = -1;
      for (const n of names) {
        const j = norm.indexOf(n.toLowerCase());
        if (j !== -1) { idx[key] = j; break; }
      }
    }
    return idx;
  }

  function buildRecord(row, idx, sheetName, rowNumber) {
    const get = k => (idx[k] >= 0 ? row[idx[k]] : null);
    const str = k => { const v = get(k); return blank(v) ? "" : String(v).trim(); };

    const sampleId = str("sampleId");
    const remoteId = str("remoteId");
    const isRemote = idx.remoteId >= 0 && remoteId !== "";
    const isManual = !isRemote && idx.sampleId >= 0 && sampleId !== "";

    const d = {};
    for (const f of DATE_FIELDS) d[f] = toSerial(get(f));

    const resultCp = get("resultCp");
    const resultLog = get("resultLog");
    const vl = idx.resultCp >= 0 ? parseVL(resultCp) : null;
    const failed = hasFailure(resultCp) || hasFailure(resultLog);

    const facilityName = str("facility");
    const facilityCode = str("facilityCode");

    return {
      key: `${sheetName}#${rowNumber}`,
      sheet: sheetName,
      sno: str("sno"),
      sampleId, remoteId,
      id: sampleId || remoteId || str("sno") || `Row ${rowNumber}`,
      entry: isRemote ? "Remote" : isManual ? "Manual" : "Unknown",
      lab: str("lab") || "N/A",
      facility: facilityName || facilityCode || "N/A",
      facilityCode,
      district: str("district"),
      region: str("region"),
      patientId: str("patientId"),
      sex: str("sex"),
      age: str("age"),
      sampleType: str("sampleType"),
      indication: str("indication"),
      rejected: str("rejected"),
      ...d,
      month: d.collected !== null ? monthKey(d.collected) : null,
      testedMonth: d.tested !== null ? monthKey(d.tested) : null,
      resultText: blank(resultCp) ? "" : String(resultCp).trim(),
      resultLog: blank(resultLog) ? "" : String(resultLog).trim(),
      vl,
      failed,
      highVl: vl !== null && vl >= HIGH_VL,
      pending: idx.tested >= 0 && d.tested === null,
      notTransported: isRemote && idx.received >= 0 && d.received === null,
      transport: dayDiff(d.collected, d.received),
      tat: dayDiff(d.collected, d.tested),
      dispatch: dayDiff(d.collected, d.printed),
      validation: dayDiff(d.tested, d.printed),
      inLab: dayDiff(d.received, d.tested),
    };
  }

  const isSummary = name => SUMMARY_SHEETS.has(name.trim().toLowerCase());

  /** Turn {name, rows}[] into records. */
  function recordsFromSheets(sheetRows, hasSummary) {
    const records = [];
    const usedSheets = [];
    const missing = new Set();

    for (const { name, rows } of sheetRows) {
      const h = findHeaderRow(rows);
      if (h === -1) continue;
      const idx = mapColumns(rows[h]);
      for (const k of ["lab", "facility", "collected", "tested", "resultCp"]) {
        if (idx[k] === -1) missing.add(COLS[k][0]);
      }
      usedSheets.push(name);
      for (let r = h + 1; r < rows.length; r++) {
        const row = rows[r];
        if (!row || !row.length || row.every(blank)) continue;
        records.push(buildRecord(row, idx, name, r + 1));
      }
    }

    if (!usedSheets.length) {
      throw new Error("No sample data found. Use an InteLIS VL export or the _cleaned.xlsx made by Data-Cleaner.py " +
        "(it needs a sheet with a \"Sample ID\" or \"Remote Sample ID\" column).");
    }
    // The cleaner always adds its summary sheets, so without them this is a raw export.
    const source = hasSummary ? "cleaned" : "raw";
    return { records, sheets: usedSheets, missing: [...missing], hasSummary, source };
  }

  /** SheetJS path: handles every format (.xls too) but blocks while parsing. */
  function parseWithSheetJS(u8) {
    // Only parse the data sheets: the cleaner's summary sheets (TAT alone has
    // one row per sample) would double the work for nothing.
    const names = XLSX.read(u8, { type: "array", bookSheets: true }).SheetNames;
    const wanted = names.filter(n => !isSummary(n));
    // cellDates:false keeps dates as Excel serials -> no time-zone drift.
    const wb = XLSX.read(u8, {
      type: "array", sheets: wanted, dense: true,
      cellDates: false, cellText: false, cellNF: false, cellStyles: false, cellHTML: false,
    });
    const sheetRows = wanted.filter(n => wb.Sheets[n]).map(name => ({
      name,
      rows: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: true }),
    }));
    return recordsFromSheets(sheetRows, names.length > wanted.length);
  }

  /**
   * Parse a raw or cleaned workbook (Uint8Array). Uses the streaming reader for
   * .xlsx so large files don't freeze the page; falls back to SheetJS.
   * onProgress(fraction) reports progress through the data sheets.
   */
  async function parseWorkbook(u8, onProgress = () => {}) {
    let book = null;
    try {
      book = await FastXlsx.openWorkbook(u8);
    } catch (err) {
      console.info("Fast reader not used (" + err.message + "); using SheetJS.");
    }
    if (book) {
      const wanted = book.sheets.filter(s => !isSummary(s.name));
      try {
        const sheetRows = [];
        for (let i = 0; i < wanted.length; i++) {
          const rows = await FastXlsx.readSheetRows(book, wanted[i], f => onProgress((i + f) / wanted.length));
          sheetRows.push({ name: wanted[i].name, rows });
        }
        return recordsFromSheets(sheetRows, book.sheets.length > wanted.length);
      } catch (err) {
        if (/No sample data found/.test(err.message)) throw err;
        console.warn("Fast reader failed, falling back to SheetJS:", err);
      }
    }
    await new Promise(r => setTimeout(r, 30));  // let the "please wait" message paint
    return parseWithSheetJS(u8);
  }

  /** Aggregate numbers for a set of records. */
  function summarize(recs) {
    const s = {
      total: recs.length, remote: 0, manual: 0, pending: 0, failed: 0, highVl: 0,
      tested: 0, notTransported: 0, rejected: 0,
      suppressed: 0, tnd: 0, otherResult: 0,
    };
    const tr = [], tat = [], disp = [], val = [], inLab = [];
    for (const r of recs) {
      if (r.entry === "Remote") s.remote++;
      else if (r.entry === "Manual") s.manual++;
      if (r.pending) s.pending++; else s.tested++;
      if (r.failed) s.failed++;
      if (r.highVl) s.highVl++;
      if (r.notTransported) s.notTransported++;
      if (/^y/i.test(r.rejected)) s.rejected++;
      if (!r.pending && !r.failed && !r.highVl) {
        if (r.vl !== null) s.suppressed++;
        else if (/not detected|tnd/i.test(r.resultText)) s.tnd++;
        else s.otherResult++;
      }
      tr.push(r.transport); tat.push(r.tat); disp.push(r.dispatch); val.push(r.validation); inLab.push(r.inLab);
    }
    const agg = arr => ({
      n: arr.filter(x => x !== null).length,
      avg: avgNonNeg(arr), min: minNonNeg(arr), max: maxOf(arr),
      negatives: arr.filter(x => x !== null && x < 0).length,
    });
    s.transportStats = agg(tr);
    s.tatStats = agg(tat);
    s.dispatchStats = agg(disp);
    s.validationStats = agg(val);
    s.inLabStats = agg(inLab);
    return s;
  }

  // ---- backlogs (same rules as compute_backlog_data in Data-Cleaner.py) ----
  const isRejected = r => /^(yes|y|oui|true|1)$/i.test(r.rejected);
  const monthIdx = key => { const [y, m] = key.split("-").map(Number); return y * 12 + m - 1; };
  const idxToKey = i => `${Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, "0")}`;

  function newBacklogBucket() {
    return { collected: 0, rejected: 0, testedSameMonth: 0, backlog: 0, transported: 0, notTransported: 0,
      remote: 0, manual: 0, testedNextMonth: 0, testedLater: 0, stillPending: 0 };
  }

  /** How one record counts toward its collection month's backlog, or null if it doesn't. */
  function backlogStatus(r) {
    if (r.month === null || isRejected(r)) return null;
    const c = monthIdx(r.month);
    const t = r.testedMonth !== null ? monthIdx(r.testedMonth) : null;
    // A test date before collection is a data error; treat it as tested in time.
    if (t !== null && t <= c) return null;
    return t === null ? "pending" : t === c + 1 ? "next" : "later";
  }

  function addToBacklog(b, r) {
    b.collected++;
    if (isRejected(r)) { b.rejected++; return; }
    const st = backlogStatus(r);
    if (st === null) { b.testedSameMonth++; return; }
    b.backlog++;
    if (r.received !== null) b.transported++; else b.notTransported++;
    if (r.entry === "Remote") b.remote++; else if (r.entry === "Manual") b.manual++;
    if (st === "pending") b.stillPending++; else if (st === "next") b.testedNextMonth++; else b.testedLater++;
  }

  /**
   * Backlog figures for a set of records.
   *   byMonth:   Map "YYYY-MM" (collection month) -> bucket, sorted by month
   *   carryIn:   Map "YYYY-MM" -> {backlog: from previous month, tested: of those tested this month}
   *              (months after lastMonth are left out: no data exists for them yet)
   *   total:     bucket summed over every month
   */
  function backlogs(recs, lastMonth = null) {
    const byMonth = new Map(), carry = new Map(), total = newBacklogBucket();
    let maxIdx = lastMonth !== null ? monthIdx(lastMonth) : -Infinity;
    for (const r of recs) {
      if (r.month === null) continue;
      if (!byMonth.has(r.month)) byMonth.set(r.month, newBacklogBucket());
      addToBacklog(byMonth.get(r.month), r);
      addToBacklog(total, r);
      if (lastMonth === null) {
        maxIdx = Math.max(maxIdx, monthIdx(r.month), r.testedMonth !== null ? monthIdx(r.testedMonth) : -Infinity);
      }
      const st = backlogStatus(r);
      if (st !== null) {
        const next = monthIdx(r.month) + 1;
        if (!carry.has(next)) carry.set(next, { backlog: 0, tested: 0 });
        const c = carry.get(next);
        c.backlog++;
        if (st === "next") c.tested++;
      }
    }
    const sortedMonths = new Map([...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])));
    const carryIn = new Map([...carry.entries()].filter(([i]) => i <= maxIdx).sort((a, b) => a[0] - b[0])
      .map(([i, v]) => [idxToKey(i), v]));
    return { byMonth: sortedMonths, carryIn, total };
  }

  /** Latest month with any collection or test date: the extent of the export. */
  function lastDataMonth(recs) {
    let max = null;
    for (const r of recs) {
      for (const k of [r.month, r.testedMonth]) if (k !== null && (max === null || k > max)) max = k;
    }
    return max;
  }

  function groupBy(recs, keyFn) {
    const m = new Map();
    for (const r of recs) {
      const k = keyFn(r);
      if (k === null || k === undefined) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  }

  return {
    HIGH_VL, parseWorkbook, parseWithSheetJS, summarize, groupBy, avgNonNeg,
    backlogs, backlogStatus, lastDataMonth,
    fmtDate, monthLabel, serialToDate, dayDiff,
  };
})();
