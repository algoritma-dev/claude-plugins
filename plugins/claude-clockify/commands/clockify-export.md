---
description: Export the hours of a month from Clockify into your own .xlsx template
argument-hint: "[YYYY-MM] [path/to/template.xlsx]"
---

Export Clockify hours into the user's own Excel template. The plugin knows nothing about the template layout: you learn it from the template itself, once, and save it as a profile.

Arguments: `$ARGUMENTS` (optional month `YYYY-MM`, default the current month; optional template path, only needed the first time or when the template changed).

The CLI is `node "${CLAUDE_PLUGIN_ROOT}/export/cli.js"`. Profile and template path live in `~/.claude-clockify/export-profile.json`.

## 1. Profile (first run, or when the CLI says the template changed or no profile exists)

1. If you have no template path, ask the user for it.
2. Run `node "${CLAUDE_PLUGIN_ROOT}/export/cli.js" inspect <template.xlsx>`. It prints every non-empty cell of every sheet. One sheet holds the data layout, another usually holds the rules to follow.
3. Read the rules carefully. If anything is ambiguous (which column gets what, rounding, grouping, totals), ask the user. Do not guess.
4. Write a JSON profile to a scratch file (not inside the plugin folder) with this shape:

```json
{
  "sheet": "name of the sheet to fill",
  "startRow": 5,
  "columns": [
    { "col": "A", "field": "date" },
    { "col": "B", "field": "project" },
    { "col": "C", "field": "hours" }
  ],
  "groupBy": ["date", "project"],
  "meta": [{ "cell": "B1", "value": "{{month}}" }],
  "removeSheets": ["name of the rules sheet"]
}
```

   - `field`: `date`, `start`, `end`, `hours` (decimal), `minutes`, `duration` (Excel time fraction, for `[h]:mm` formats), `project`, `task`, `description`, `tags`.
   - `startRow`: first data row. Each row takes the style of the template cell in that column at `startRow`, so formats, borders and number formats come from the template.
   - `groupBy` (optional): one row per distinct combination of `date`, `project`, `task`, `description`; durations are summed and descriptions joined. With `groupBy`, columns may only use those fields plus `hours`, `minutes`, `duration`.
   - `meta` (optional): fixed cells (name, month label...). Placeholders: `{{month}}` (`YYYY-MM`), `{{year}}`.
   - `removeSheets` (optional): sheets to drop from the output, typically the rules sheet.
   - Rows are written from `startRow` downwards and nothing below is shifted: if the template has a totals row, make sure it is far enough below or tell the user.
   - **Per-day layout** (attendance sheets with one fixed row per day of the month): use `"layout": "perDay"` instead of `startRow`/`columns`:

```json
{
  "layout": "perDay",
  "sheet": "name of the sheet",
  "firstDayRow": 13,
  "dayColumns": [
    { "col": "C", "field": "morningIn" }, { "col": "D", "field": "morningOut" },
    { "col": "F", "field": "afternoonIn" }, { "col": "G", "field": "afternoonOut" },
    { "col": "K", "field": "note" }
  ],
  "splitTime": "13:00",
  "tagRules": [
    { "tag": "ferie", "note": "Leave", "blankTimes": true },
    { "tag": "permit", "note": "{{hours}}H Permit" }
  ],
  "holidays": { "note": "HOLIDAY", "fill": { "from": "A", "to": "P", "rgb": "C0C0C0" } },
  "meta": [{ "cell": "S1", "value": "{{monthNumber}}" }, { "cell": "P9", "value": "{{year}}" }, { "cell": "E9", "value": "Full Name" }]
}
```

     Row of day N = `firstDayRow + N - 1`. Times are deduced from the day's entries (morning = before `splitTime`, afternoon = after; an entry crossing it is split). Entries carrying a `tagRules` tag (matched case-insensitively against the Clockify tag names) are absences: they do not count as work, `{{hours}}` is their total duration, `blankTimes` clears the times. `holidays` writes the note, blanks the times and fills the row with the given colour on past weekdays that have no entries at all (a weekday with nothing in Clockify is taken to be a holiday). Weekend greying is normally a conditional format of the template itself: do not set it here. Check the real tag names with the user before writing `tagRules`. `meta` placeholders: `{{month}}`, `{{monthNumber}}`, `{{monthName}}` (capitalized, in the profile's `locale`, e.g. `"locale": "it"`), `{{year}}` (a value that is exactly `{{monthNumber}}` or `{{year}}` is written as a number).
     A `dayColumns` entry can be `{ "col": "I", "formula": "..." }` instead of a `field`: the formula (no leading `=`) is written in every day row with `{row}` replaced by the row number, e.g. to fix or replace a template formula. `conditionalFormulas` (`[{ "from": "...", "to": "..." }]`) rewrites the formula of the template's conditional-format rules that match `from` exactly, e.g. to grey weekend rows only when the row has no hours; the export fails if no rule matches, so a changed template is noticed. `cloneConditionalFormats` (`[{ "from": "C13:C43", "to": "D13:D43" }]`) copies the rules of one range onto another one that lacks them (done before `conditionalFormulas`).
   - A legacy `.xls` template is converted once to `.xlsx` with LibreOffice (`soffice`) and the profile points at the converted copy in `~/.claude-clockify/templates/`.
5. Run `node "${CLAUDE_PLUGIN_ROOT}/export/cli.js" save-profile <profile.json> --template <template.xlsx>`. Fix and retry on validation errors.
6. Run the export with `--dry-run` (step 2 below), show the user the preview, and ask for confirmation that it matches what the rules require. Adjust the profile if not.

## 2. Export

1. Dry run: `node "${CLAUDE_PLUGIN_ROOT}/export/cli.js" run --month <YYYY-MM> --dry-run` (prints entry count, total hours and the first rows). Skip it when the profile was already confirmed in a previous run.
2. Real run: `node "${CLAUDE_PLUGIN_ROOT}/export/cli.js" run --month <YYYY-MM> --out <path>`. Default output is `./clockify-<month>.xlsx`.
3. Tell the user the output path, the number of rows and the total hours.

Exit codes: `2` no profile (do section 1), `3` template changed (redo section 1 with the new template), `4` no entries in that month. Other errors: report the message, do not retry in a loop.

Only read from Clockify: this command never creates or changes time entries and never changes the plugin configuration. The template and its rules stay on the user's disk; do not copy their content into the plugin repository.
