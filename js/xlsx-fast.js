/* ==================================================================
   xlsx-fast.js - a small streaming .xlsx reader for large files.

   SheetJS parses the whole worksheet XML in one blocking step, which for an
   80,000-row export (~130 MB of XML) freezes the page for tens of seconds.
   This reader unzips with the browser's native DecompressionStream and
   scans rows chunk by chunk, yielding to the browser between chunks so the
   progress bar keeps moving.

   It returns plain row arrays (like SheetJS sheet_to_json with header:1,
   raw:true). Anything it doesn't understand throws, and the caller falls
   back to SheetJS.
================================================================== */

const FastXlsx = (() => {
  const td = new TextDecoder("utf-8");

  // ---------------- zip ----------------
  function readZipIndex(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("not a zip file");
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    if (p === 0xffffffff) throw new Error("zip64 not supported");
    const entries = new Map();
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("bad zip directory");
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const usize = dv.getUint32(p + 24, true);
      const nlen = dv.getUint16(p + 28, true);
      const xlen = dv.getUint16(p + 30, true);
      const clen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = td.decode(u8.subarray(p + 46, p + 46 + nlen));
      entries.set(name, { method, csize, usize, local });
      p += 46 + nlen + xlen + clen;
    }
    return { dv, entries };
  }

  function entryStream(u8, zip, name) {
    const e = zip.entries.get(name);
    if (!e) return null;
    const lh = e.local;
    if (zip.dv.getUint32(lh, true) !== 0x04034b50) throw new Error("bad zip entry");
    const start = lh + 30 + zip.dv.getUint16(lh + 26, true) + zip.dv.getUint16(lh + 28, true);
    const data = u8.subarray(start, start + e.csize);
    const raw = new Blob([data]).stream();
    if (e.method === 0) return raw;
    if (e.method === 8) return raw.pipeThrough(new DecompressionStream("deflate-raw"));
    throw new Error("unsupported zip compression");
  }

  async function entryText(u8, zip, name) {
    const s = entryStream(u8, zip, name);
    return s ? await new Response(s).text() : null;
  }

  // ---------------- xml helpers ----------------
  const ENT = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
  function unescapeXml(s) {
    if (s.indexOf("&") === -1 && s.indexOf("_x") === -1) return s;
    return s
      .replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (m, g) =>
        g[0] === "#" ? String.fromCodePoint(g[1] === "x" ? parseInt(g.slice(2), 16) : +g.slice(1)) : ENT[g])
      .replace(/_x([0-9A-Fa-f]{4})_/g, (m, hx) => String.fromCharCode(parseInt(hx, 16)));
  }
  const attrRe = {};
  function attr(tag, name) {
    const re = attrRe[name] || (attrRe[name] = new RegExp(`\\s${name}="([^"]*)"`));
    const m = tag.match(re);
    return m ? unescapeXml(m[1]) : null;
  }
  // Hot path for cell/row tags: plain indexOf, no regex.
  function quickAttr(tag, key) {           // key like ' r="'
    const i = tag.indexOf(key);
    if (i === -1) return null;
    const s = i + key.length;
    return tag.slice(s, tag.indexOf('"', s));
  }
  // V8 keeps a substring of 13+ chars as a view into its parent, so a cell
  // value sliced out of a 64 KB chunk would keep the whole chunk alive for as
  // long as the record exists (the entire sheet XML, on a big file). Values
  // that outlive the parse are copied into their own string.
  const own = s => (s.length >= 13 ? (" " + s).slice(1) : s);

  // Concatenate every <t>…</t> inside a fragment (handles rich-text runs).
  function allText(frag) {
    let out = "", i = 0;
    while ((i = frag.indexOf("<t", i)) !== -1) {
      const c = frag.charCodeAt(i + 2);
      if (c !== 62 && c !== 32) { i += 2; continue; }          // <t> or <t xml:space=…>, not <tag…>
      const gt = frag.indexOf(">", i);
      if (frag.charCodeAt(gt - 1) === 47) { i = gt + 1; continue; } // <t/>
      const end = frag.indexOf("</t>", gt);
      out += frag.slice(gt + 1, end);
      i = end + 4;
    }
    return own(unescapeXml(out));
  }

  function colIndex(ref) {
    let n = 0;
    for (let i = 0; i < ref.length; i++) {
      const c = ref.charCodeAt(i);
      if (c < 65 || c > 90) break;
      n = n * 26 + (c - 64);
    }
    return n - 1;
  }

  // ---------------- workbook ----------------
  async function openWorkbook(u8) {
    if (typeof DecompressionStream === "undefined") throw new Error("no DecompressionStream");
    const zip = readZipIndex(u8);
    const wbXml = await entryText(u8, zip, "xl/workbook.xml");
    const relXml = await entryText(u8, zip, "xl/_rels/workbook.xml.rels");
    if (!wbXml || !relXml) throw new Error("not an xlsx workbook");

    const rels = {};
    for (const m of relXml.matchAll(/<Relationship\b[^>]*>/g)) {
      const id = attr(m[0], "Id"), target = attr(m[0], "Target");
      if (id && target) rels[id] = target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^\.\//, "");
    }
    const sheets = [];
    for (const m of wbXml.matchAll(/<sheet\b[^>]*>/g)) {
      const name = attr(m[0], "name");
      const rid = attr(m[0], "r:id") || (m[0].match(/\s\w+:id="([^"]*)"/) || [])[1];
      if (name && rels[rid]) sheets.push({ name, path: rels[rid] });
    }

    let shared = null;
    const ssPath = [...zip.entries.keys()].find(k => /^xl\/sharedStrings\.xml$/i.test(k));
    if (ssPath) {
      const ss = await entryText(u8, zip, ssPath);
      shared = [];
      let i = 0;
      while ((i = ss.indexOf("<si", i)) !== -1) {
        const end = ss.indexOf("</si>", i);
        if (end === -1) { shared.push(""); break; }
        shared.push(allText(ss.slice(ss.indexOf(">", i) + 1, end)));
        i = end + 5;
      }
    }
    return { u8, zip, sheets, shared };
  }

  // Parse one <c …>…</c> (or <c …/>) into a JS value.
  function cellValue(tag, body, shared) {
    const t = quickAttr(tag, ' t="');
    if (t === "inlineStr") return allText(body);
    const vs = body.indexOf("<v");
    if (vs === -1) return null;
    const v = body.slice(body.indexOf(">", vs) + 1, body.indexOf("</v>", vs));
    switch (t) {
      case "s": return shared ? shared[+v] ?? null : null;
      case "str": case "e": case "d": return own(unescapeXml(v));
      case "b": return v === "1";
      default: { const n = Number(v); return Number.isNaN(n) ? own(unescapeXml(v)) : n; }
    }
  }

  // want: optional array, want[col] truthy for the columns to read; other
  // cells are skipped without decoding their value.
  function parseRow(rowXml, shared, want) {
    const out = [];
    let i = 0, next = 0;
    while ((i = rowXml.indexOf("<c", i)) !== -1) {
      const c = rowXml.charCodeAt(i + 2);
      if (c !== 32 && c !== 62 && c !== 47) { i += 2; continue; }
      const gt = rowXml.indexOf(">", i);
      const tag = rowXml.slice(i, gt + 1);
      const r = quickAttr(tag, ' r="');
      const col = r ? colIndex(r) : next;
      let body = "";
      if (rowXml.charCodeAt(gt - 1) === 47) {
        i = gt + 1;
      } else {
        const end = rowXml.indexOf("</c>", gt);
        body = rowXml.slice(gt + 1, end);
        i = end + 4;
      }
      next = col + 1;
      if (!body || (want && !want[col])) continue;
      const val = cellValue(tag, body, shared);
      if (val === null || val === "") continue;
      while (out.length < col) out.push(null);
      out[col] = val;
    }
    return out;
  }

  /**
   * Stream a sheet's rows. onProgress(fraction) is called between chunks.
   * Each row array goes to onRow(row) as soon as it is parsed (nothing is
   * kept, so memory stays flat on huge sheets); missing rows are passed as
   * empty arrays so row numbers line up with Excel's. stop() returning true
   * ends the read early. wantCols() may return an array marking the only
   * columns worth decoding (null = all). Without onRow, returns every row.
   */
  async function readSheetRows(book, sheet, onProgress, onRow = null, stop = () => false, wantCols = () => null) {
    const e = book.zip.entries.get(sheet.path);
    const stream = entryStream(book.u8, book.zip, sheet.path);
    if (!stream) throw new Error("sheet not found: " + sheet.name);
    const reader = stream.getReader();
    const dec = new TextDecoder("utf-8");
    const rows = [];
    const emit = onRow || (row => rows.push(row));
    let buf = "", seen = 0, count = 0, lastYield = performance.now();

    const flush = final => {
      let i = 0;
      for (;;) {
        const s = buf.indexOf("<row", i);
        if (s === -1) break;
        const tagEnd = buf.indexOf(">", s);
        if (tagEnd === -1) break;
        let e2, rowXml;
        if (buf.charCodeAt(tagEnd - 1) === 47) { e2 = tagEnd + 1; rowXml = ""; }
        else {
          const close = buf.indexOf("</row>", tagEnd);
          if (close === -1) break;
          e2 = close + 6; rowXml = buf.slice(tagEnd + 1, close);
        }
        const rAttr = quickAttr(buf.slice(s, tagEnd + 1), ' r="');
        const rowNum = rAttr ? +rAttr : count + 1;
        while (count < rowNum - 1) { emit([]); count++; }
        emit(rowXml ? parseRow(rowXml, book.shared, wantCols()) : []);
        count++;
        i = e2;
      }
      buf = final ? "" : buf.slice(i);
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += value.length;
      buf += dec.decode(value, { stream: true });
      flush(false);
      if (stop()) { reader.cancel(); return rows; }
      if (performance.now() - lastYield > 60) {
        if (onProgress && e.usize) onProgress(Math.min(1, seen / e.usize));
        await new Promise(r => setTimeout(r, 0));
        lastYield = performance.now();
      }
    }
    buf += dec.decode();
    flush(true);
    return rows;
  }

  return { openWorkbook, readSheetRows };
})();
