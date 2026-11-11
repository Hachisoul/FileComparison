# BulkCheck command-line version

A PowerShell script that does the same comparison as the BulkCheck app, for PCs where you can't run the app. It needs nothing installed: Windows PowerShell 5.1 comes with Windows 10 and 11.

## Files

- `bulkcheck.ps1`: the script.
- `bulkcheck.cmd`: a shortcut so you can run it from Command Prompt as `bulkcheck A B`.

Copy both files into the same folder.

## Run it

From Command Prompt:

```bat
bulkcheck "C:\Release 2.3" "C:\Release 2.4"
```

From PowerShell:

```powershell
.\bulkcheck.ps1 -A "C:\Release 2.3" -B "C:\Release 2.4"
```

If PowerShell says running scripts is disabled, use the `.cmd` file or run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\bulkcheck.ps1 -A <A> -B <B>
```

This only relaxes the setting for that one run. If your company enforces it through Group Policy, or PowerShell runs in "Constrained Language Mode" (check with `$ExecutionContext.SessionState.LanguageMode`), the script can't run and you'll need to ask IT.

## What to compare

`-A` and `-B` each take a folder, one file, or several files:

| A | B | What happens |
|---|---|---|
| Folder | Folder | Files are matched by name (and subfolder path) |
| One file | One file | The two files are compared, even if their names differ |
| Several files | Several files | Matched by name |
| Files | Folder | Each file is compared with the same-named file in the folder |

List several files with commas (`-A a.xml,b.xml`) or use a wildcard (`-A C:\Old\*.xml`).

## Options

| Option | Meaning |
|---|---|
| `-Html report.html` | Save a report with side-by-side changed lines. Open it in any browser. |
| `-Csv report.csv` | Save every changed line as CSV (opens in Excel). |
| `-NoSubfolders` | Only look at the top level of each folder. |
| `-IgnoreWhitespace` | Treat lines that differ only in spaces or tabs as the same. |
| `-IgnoreCase` | Treat upper and lower case as the same. |
| `-SummaryOnly` | Print one line per file, without the changed lines. |
| `-MaxLines 40` | How many changed lines to print per file in the console (default 40). |
| `-Context 3` | Unchanged lines shown around each change in the HTML report (default 3). |

Exit code: `0` if everything is identical, `1` if anything differs or is missing on one side, `2` on an error. You can use this in batch files.

## Differences from the app

- **PDF files are compared byte for byte** (identical or different, no line view). Reading PDF text needs a library that PowerShell doesn't have.
- **Excel dates appear as numbers** (for example `45941` instead of `2025-10-12`), because the script reads raw cell values. Changes are still detected.
- Changed lines are shown whole, without highlighting the exact changed characters.
- Very different large files (more than about 800 changed lines in one block) are compared line by line in order instead of being aligned.

Everything else matches the app: text files in UTF-8, UTF-16 or Windows-1252, Windows and Unix line endings treated the same, Word (.docx) by paragraph, Excel (.xlsx) by row, other files byte for byte, images and videos skipped.

## Test

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File cli\test\test-cli.ps1
```
