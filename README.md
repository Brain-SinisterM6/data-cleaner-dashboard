# VL Dashboard

An interactive dashboard for the `_cleaned.xlsx` file produced by `Data-Cleaner.py`.

## How to use

1. Run `Data-Cleaner.py` on an InteLIS VL export to get `<name>_cleaned.xlsx`.
2. Double-click `main.html` (Chrome, Edge or Firefox). No internet and no server needed.
3. Drag the `_cleaned.xlsx` file onto the page, or click **Choose file**.

The file is read inside the browser and never leaves the computer.

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

The dashboard reads the cleaned data sheet (not the summary sheets), so it can recalculate everything for any filter. It uses the same rules as `Data-Cleaner.py`:

- **Remote** = Remote Sample ID present. **Manual** = Sample ID present, no Remote Sample ID.
- **Pending** = no *Sample Tested On* date. **Failed** = result contains invalid / error / fail.
- **High viral load** = Result (cp/mL) ≥ 1000.
- **Transport** = reception − collection. **Testing TAT** = tested − collection.
  **Result dispatch** = printed − collection. **Validation** = printed − tested.
- Negative day counts (bad dates) are left out of averages and minimums.
- **Backlog** = collected in a month but not tested in that same month (tested later, or not tested yet). Rejected samples are never backlog. **Transported** = has a Sample Reception Date.

With no filters applied, the totals match the *Statistics* and *Backlogs* sheets of the same file.

## Files

```
main.html            the page
css/dashboard.css    styles and colour tokens (light + dark)
js/xlsx-fast.js      streaming .xlsx reader (keeps large files responsive)
js/data.js           turns rows into sample records and statistics
js/charts.js         Chart.js helpers
js/timeline.js       journey stepper and Timeline views
js/app.js            upload, filters and tabs
lib/                 Bootstrap 5.3, Chart.js 4.4, SheetJS 0.18 (bundled for offline use)
```
