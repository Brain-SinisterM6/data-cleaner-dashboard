# VL Dashboard

An interactive dashboard for InteLIS viral load exports. It reads either the **raw export** straight from InteLIS or the `_cleaned.xlsx` file produced by `Data-Cleaner.py`; both give the same numbers.

## How to use

1. Double-click `main.html` (Chrome, Edge or Firefox). No internet and no server needed.
2. Drag the InteLIS VL export (or its `_cleaned.xlsx`) onto the page, or click **Choose file**.
3. To share or print, click **Export PDF** (top right).

The file is read inside the browser and never leaves the computer. The top bar shows whether the file was a *raw export* or a *cleaned file*.

### Raw exports

Running `Data-Cleaner.py` first is optional. The dashboard reads the text dates in a raw export (`21-08-2026`, `07-09-2026 13:05`, `21/08/2026`, `2026-08-21`) the same way the cleaner converts them, skips banner rows above the headers and blank rows at the end, and applies the same rules listed below.

### Export PDF

**Export PDF** makes an A4 report (portrait or landscape) of the current filter selection, ready to email or print. You choose:

- **Sections**: Overview, Turnaround, Backlogs, Labs & Facilities
- **The numbers behind each chart**: a table under every chart
- **Lists**: high viral load samples, backlog month-by-month table, backlog samples still not tested (up to 300, oldest first), facility scorecard

Charts are always drawn in the light theme. Key numbers and tables are real text in the PDF, so you can search and copy them. The file name includes the source file, the filters and the date, e.g. `VL-report_export_June_2026_2026-10-04.pdf`.

## What's in it

| Tab | Shows |
|---|---|
| **Overview** | Key numbers, samples per month (click a bar to focus on that month, then samples per day), where samples are (tested / pending / not at lab / failed / rejected), viral load results, high viral load list |
| **Turnaround** | Average journey of a sample (collection → lab → tested → printed), transport / testing TAT / result dispatch / validation figures, monthly trend, TAT distribution, remote vs manual, TAT by lab |
| **Backlogs** | Samples not tested in the month they were collected: per month, transported vs not transported, remote vs manual, what happened to each month's backlog, last month's backlog tested this month, backlog by lab, and a list of backlog samples still not tested |
| **Labs & Facilities** | Samples per lab and per facility (click to filter), sortable facility scorecard |
| **Timeline** | Look up a **sample** (Sample ID or Remote ID), **patient** (Unique ART No., or any of the patient's Sample IDs / Remote IDs), **facility** or **laboratory** and see its full timeline |

The filter bar (month, lab, facility, remote/manual) applies to every tab except Timeline. On the Backlogs tab the monthly charts always show every month (a backlog is carried from one month to the next); picking a month changes the key numbers, the lab chart and the list of samples still waiting. Timelines always show all dates.
Every chart has a **Table** button that shows the same numbers as a table.

## How numbers are calculated

The dashboard reads the data sheet (not the cleaner's summary sheets), so it can recalculate everything for any filter. It uses the same rules as `Data-Cleaner.py`:

- **Remote** = Remote Sample ID present. **Manual** = Sample ID present, no Remote Sample ID.
- **Pending** = no *Sample Tested On* date. **Failed** = result contains invalid / error / fail.
- **High viral load** = Result (cp/mL) ≥ 1000.
- **Transport** = reception − collection. **Testing TAT** = tested − collection.
  **Result dispatch** = printed − collection. **Validation** = printed − tested.
- Negative day counts (bad dates) are left out of averages and minimums.
- **Backlog** = collected in a month but not tested in that same month (tested later, or not tested yet). Rejected samples are never backlog. **Transported** = has a Sample Reception Date.

With no filters applied, the totals match the *Statistics* and *Backlogs* sheets that `Data-Cleaner.py` makes from the same export.

## Files

```
main.html            the page
css/dashboard.css    styles and colour tokens (light + dark)
js/xlsx-fast.js      streaming .xlsx reader (keeps large files responsive)
js/data.js           turns rows into sample records and statistics
js/charts.js         Chart.js helpers
js/timeline.js       journey stepper and Timeline views
js/app.js            upload, filters and tabs
js/report.js         Export PDF
lib/                 Bootstrap 5.3, Chart.js 4.4, SheetJS 0.18, jsPDF 4.2 + AutoTable 5.0 (bundled for offline use)
```
