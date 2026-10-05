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

  // Text dates repeat across thousands of rows; parse each distinct one once.
  const dateCache = new Map();
  function toSerial(v) {
    if (blank(v)) return null;
    if (typeof v === "number") return v > 0 ? v : null;
    if (v instanceof Date) return v.getTime() / 86400000 + 25569;
    const key = String(v);
    let s = dateCache.get(key);
    if (s === undefined) {
      if (dateCache.size > 200000) dateCache.clear();
      s = parseTextDate(key);
      dateCache.set(key, s);
    }
    return s;
  }
  function parseTextDate(text) {
    const m = text.trim().match(TEXT_DATE);
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
  function serialMonthNo(s) {
    const d = serialToDate(s);
    return d.getUTCFullYear() * 12 + d.getUTCMonth();
  }
  const REJECTED_YES = /^(yes|y|oui|true|1)$/i;
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
  // Plain loops, never Math.min(...arr): spreading a large array overflows the
  // call stack (~100k+ values), and these run over every sample.
  function avgNonNeg(values) {
    let sum = 0, n = 0;
    for (const x of values) if (x !== null && x >= 0) { sum += x; n++; }
    return n ? Math.round((sum / n) * 10) / 10 : null;
  }

  /** Running n / avg / min / max / negatives for one day-count field. */
  function newAgg() { return { n: 0, sum: 0, pos: 0, min: null, max: null, negatives: 0 }; }
  function addAgg(a, x) {
    if (x === null) return;
    a.n++;
    if (a.max === null || x > a.max) a.max = x;
    if (x < 0) { a.negatives++; return; }
    a.sum += x; a.pos++;
    if (a.min === null || x < a.min) a.min = x;
  }
  function finishAgg(a) {
    return { n: a.n, avg: a.pos ? Math.round((a.sum / a.pos) * 10) / 10 : null, min: a.min, max: a.max, negatives: a.negatives };
  }

  // ---- workbook parsing ----
  // The cleaner expects headers in row 1, but tolerate a banner row or two.
  const HEADER_SEARCH_ROWS = 10;
  function isHeaderRow(row) {
    const cells = (row || []).map(c => String(c ?? "").trim().toLowerCase());
    return cells.includes("sample id") || cells.includes("remote sample id");
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

  // Lab, facility, sex... repeat on every row. Sharing one string per distinct
  // value keeps memory flat on million-row files.
  const pool = new Map();
  const intern = v => {
    if (v.length > 64) return v;
    let x = pool.get(v);
    if (x === undefined) { pool.set(v, v); x = v; }
    return x;
  };

  function buildRecord(row, idx, sheetName, rowNumber) {
    const get = k => (idx[k] >= 0 ? row[idx[k]] : null);
    const str = k => { const v = get(k); return blank(v) ? "" : String(v).trim(); };
    const cat = k => intern(str(k));

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

    const facilityName = cat("facility");
    const rejected = cat("rejected");
    const facilityCode = cat("facilityCode");

    return {
      key: `${sheetName}#${rowNumber}`,
      sheet: sheetName,
      sno: str("sno"),
      sampleId, remoteId,
      id: sampleId || remoteId || str("sno") || `Row ${rowNumber}`,
      entry: isRemote ? "Remote" : isManual ? "Manual" : "Unknown",
      lab: cat("lab") || "N/A",
      facility: facilityName || facilityCode || "N/A",
      facilityCode,
      district: cat("district"),
      region: cat("region"),
      patientId: str("patientId"),
      sex: cat("sex"),
      age: cat("age"),
      sampleType: cat("sampleType"),
      indication: cat("indication"),
      rejected,
      created: d.created, collected: d.collected, received: d.received, tested: d.tested, printed: d.printed,
      month: d.collected !== null ? monthKey(d.collected) : null,
      testedMonth: d.tested !== null ? monthKey(d.tested) : null,
      // Month numbers (year * 12 + month) and the rejected flag, worked out once
      // here because the backlog figures check them several times per sample.
      monthNo: d.collected !== null ? serialMonthNo(d.collected) : null,
      testedMonthNo: d.tested !== null ? serialMonthNo(d.tested) : null,
      isRejected: REJECTED_YES.test(rejected),
      rejectedAny: /^y/i.test(rejected),   // looser rule used by the status counts
      tnd: !blank(resultCp) && /not detected|tnd/i.test(String(resultCp)),
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

  /**
   * Turns one sheet's rows into records as they arrive, so a large sheet never
   * has to be held as raw rows and records at the same time.
   * add(row) takes rows in sheet order, starting at row 1.
   */
  function sheetCollector(name, out) {
    let idx = null, want = null, rowNumber = 0;
    return {
      add(row) {
        rowNumber++;
        if (idx === null) {
          if (rowNumber <= HEADER_SEARCH_ROWS && isHeaderRow(row)) {
            idx = mapColumns(row);
            want = [];
            for (const j of Object.values(idx)) if (j >= 0) want[j] = true;
            out.used.push(name);
            for (const k of ["lab", "facility", "collected", "tested", "resultCp"]) {
              if (idx[k] === -1) out.missing.add(COLS[k][0]);
            }
          }
          return;
        }
        if (!row || !row.length || row.every(blank)) return;
        out.records.push(buildRecord(row, idx, name, rowNumber));
      },
      // No header in the first rows: not a data sheet, stop reading it.
      skip: () => idx === null && rowNumber >= HEADER_SEARCH_ROWS,
      // Once the header is known, only the mapped columns need decoding.
      want: () => want,
    };
  }

  function newOutput() { return { records: [], used: [], missing: new Set() }; }

  function finishOutput(out, hasSummary) {
    pool.clear();
    dateCache.clear();
    if (!out.used.length) {
      throw new Error("No sample data found. Use an InteLIS VL export or the _cleaned.xlsx made by Data-Cleaner.py " +
        "(it needs a sheet with a \"Sample ID\" or \"Remote Sample ID\" column).");
    }
    // The cleaner always adds its summary sheets, so without them this is a raw export.
    const source = hasSummary ? "cleaned" : "raw";
    return { records: out.records, sheets: out.used, missing: [...out.missing], hasSummary, source };
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
    const out = newOutput();
    for (const name of wanted.filter(n => wb.Sheets[n])) {
      const col = sheetCollector(name, out);
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: true });
      for (const row of rows) { col.add(row); if (col.skip()) break; }
      delete wb.Sheets[name];   // free the sheet before the next one
    }
    return finishOutput(out, names.length > wanted.length);
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
        const out = newOutput();
        for (let i = 0; i < wanted.length; i++) {
          const col = sheetCollector(wanted[i].name, out);
          await FastXlsx.readSheetRows(book, wanted[i], f => onProgress((i + f) / wanted.length), col.add, col.skip, col.want);
        }
        return finishOutput(out, book.sheets.length > wanted.length);
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
    const tr = newAgg(), tat = newAgg(), disp = newAgg(), val = newAgg(), inLab = newAgg();
    for (const r of recs) {
      if (r.entry === "Remote") s.remote++;
      else if (r.entry === "Manual") s.manual++;
      if (r.pending) s.pending++; else s.tested++;
      if (r.failed) s.failed++;
      if (r.highVl) s.highVl++;
      if (r.notTransported) s.notTransported++;
      if (r.rejectedAny) s.rejected++;
      if (!r.pending && !r.failed && !r.highVl) {
        if (r.vl !== null) s.suppressed++;
        else if (r.tnd) s.tnd++;
        else s.otherResult++;
      }
      addAgg(tr, r.transport); addAgg(tat, r.tat); addAgg(disp, r.dispatch); addAgg(val, r.validation); addAgg(inLab, r.inLab);
    }
    s.transportStats = finishAgg(tr);
    s.tatStats = finishAgg(tat);
    s.dispatchStats = finishAgg(disp);
    s.validationStats = finishAgg(val);
    s.inLabStats = finishAgg(inLab);
    return s;
  }

  // ---- backlogs (same rules as compute_backlog_data in Data-Cleaner.py) ----
  const monthIdx = key => { const [y, m] = key.split("-").map(Number); return y * 12 + m - 1; };
  const idxToKey = i => `${Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, "0")}`;

  function newBacklogBucket() {
    return { collected: 0, rejected: 0, testedSameMonth: 0, backlog: 0, transported: 0, notTransported: 0,
      remote: 0, manual: 0, testedNextMonth: 0, testedLater: 0, stillPending: 0 };
  }

  /** How one record counts toward its collection month's backlog, or null if it doesn't. */
  function backlogStatus(r) {
    if (r.monthNo === null || r.isRejected) return null;
    const c = r.monthNo, t = r.testedMonthNo;
    // A test date before collection is a data error; treat it as tested in time.
    if (t !== null && t <= c) return null;
    return t === null ? "pending" : t === c + 1 ? "next" : "later";
  }

  function addToBacklog(b, r, st) {
    b.collected++;
    if (r.isRejected) { b.rejected++; return; }
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
      const st = backlogStatus(r);
      addToBacklog(byMonth.get(r.month), r, st);
      addToBacklog(total, r, st);
      if (lastMonth === null) {
        maxIdx = Math.max(maxIdx, r.monthNo, r.testedMonthNo !== null ? r.testedMonthNo : -Infinity);
      }
      if (st !== null) {
        const next = r.monthNo + 1;
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
