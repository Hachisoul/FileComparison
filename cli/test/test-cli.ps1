# Tests for bulkcheck.ps1. Run with:  powershell -NoProfile -ExecutionPolicy Bypass -File cli\test\test-cli.ps1
# Works on Windows PowerShell 5.1 and PowerShell 7.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path (Split-Path -Parent $here) 'bulkcheck.ps1'
$A = Join-Path $here 'fixtures\A'
$B = Join-Path $here 'fixtures\B'
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('bulkcheck-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null

$script:failures = 0
function Check([bool]$cond, [string]$what) {
  if ($cond) { Write-Host "  ok   $what" -ForegroundColor Green }
  else { Write-Host "  FAIL $what" -ForegroundColor Red; $script:failures++ }
}

# Runs the script and returns @{ Code; Rows } where Rows are the CSV lines (after the header block).
function Invoke-BulkCheck([hashtable]$Params) {
  $csv = Join-Path $tmp ([Guid]::NewGuid().ToString('N') + '.csv')
  & $script @Params -Csv $csv -SummaryOnly *> $null
  $code = $LASTEXITCODE
  $rows = @()
  if (Test-Path -LiteralPath $csv) {
    $rows = @(Get-Content -LiteralPath $csv -Encoding UTF8 | Select-Object -Skip 4 | ConvertFrom-Csv)
  }
  return @{ Code = $code; Rows = $rows }
}

function Status-Of($rows, [string]$file) {
  $r = @($rows | Where-Object { $_.File -eq $file })
  if ($r.Count -eq 0) { return '<missing>' }
  return $r[0].Status
}

function Count-Changes($rows, [string]$file, [string]$change) {
  return @($rows | Where-Object { $_.File -eq $file -and $_.Change -eq $change }).Count
}

try {
  Write-Host 'Two folders'
  $res = Invoke-BulkCheck @{ A = $A; B = $B }
  $rows = $res.Rows
  Check ($res.Code -eq 1) 'exit code 1 when there are differences'
  $expected = [ordered]@{
    'blob.bin' = 'Different'; 'changed.csv' = 'Different'; 'config.xml' = 'Different'; 'eol.txt' = 'Identical'
    'latin1.txt' = 'Different'; 'letter.docx' = 'Different'; 'only-a.md' = 'Only in A'; 'only-b.md' = 'Only in B'
    'pic.png' = 'Skipped'; 'removed.log' = 'Different'; 'same.txt' = 'Identical'; 'spaces.txt' = 'Different'
    'stock.xlsx' = 'Different'; 'sub/deep.json' = 'Different'; 'utf16.txt' = 'Different'
  }
  foreach ($k in $expected.Keys) { Check ((Status-Of $rows $k) -eq $expected[$k]) "$k is $($expected[$k]) (got $(Status-Of $rows $k))" }
  Check ((Count-Changes $rows 'changed.csv' 'Changed') -eq 1 -and (Count-Changes $rows 'changed.csv' 'Added in B') -eq 1) 'changed.csv: 1 changed, 1 added'
  $csvRow = @($rows | Where-Object { $_.File -eq 'changed.csv' -and $_.Change -eq 'Changed' })[0]
  Check ($csvRow.'Line in A' -eq '3' -and $csvRow.'Content in A' -eq '2,bob' -and $csvRow.'Content in B' -eq '2,rob') 'changed.csv: line 3 "2,bob" -> "2,rob"'
  Check ((Count-Changes $rows 'removed.log' 'Missing in B') -eq 1) 'removed.log: 1 line missing in B'
  $x = @($rows | Where-Object { $_.File -eq 'config.xml' -and $_.Change -eq 'Changed' })
  Check ($x.Count -eq 1 -and $x[0].'Content in B' -eq '  <b>3</b>') 'config.xml: <b>2</b> -> <b>3</b>'
  $u = @($rows | Where-Object { $_.File -eq 'utf16.txt' -and $_.Change -eq 'Changed' })
  Check ($u.Count -eq 1 -and $u[0].'Content in A' -eq 'line two') 'utf16.txt decoded'
  $l = @($rows | Where-Object { $_.File -eq 'latin1.txt' -and $_.Change -eq 'Changed' })
  Check ($l.Count -eq 1 -and $l[0].'Content in A' -eq ('caf' + [char]0xE9 + ' au lait')) 'latin1.txt decoded as Windows-1252'
  $d = @($rows | Where-Object { $_.File -eq 'letter.docx' -and $_.Change -eq 'Changed' })
  Check ($d.Count -eq 1 -and $d[0].'Content in B' -eq 'Second paragraph EDITED') 'letter.docx paragraph text'
  $s = @($rows | Where-Object { $_.File -eq 'stock.xlsx' -and $_.Change -eq 'Changed' })
  Check ($s.Count -eq 1 -and $s[0].'Content in A' -eq 'Row 3: pear | 7' -and $s[0].'Content in B' -eq 'Row 3: pear | 99') 'stock.xlsx row text'

  Write-Host 'Ignore whitespace and case'
  $res = Invoke-BulkCheck @{ A = $A; B = $B; IgnoreWhitespace = $true; IgnoreCase = $true }
  Check ((Status-Of $res.Rows 'spaces.txt') -eq 'Identical') 'spaces.txt identical with -IgnoreWhitespace -IgnoreCase'

  Write-Host 'No subfolders'
  $res = Invoke-BulkCheck @{ A = $A; B = $B; NoSubfolders = $true }
  Check ((Status-Of $res.Rows 'sub/deep.json') -eq '<missing>') 'sub/deep.json not compared'

  Write-Host 'One file on each side, different names'
  $res = Invoke-BulkCheck @{ A = (Join-Path $A 'same.txt'); B = (Join-Path $B 'changed.csv') }
  Check ($res.Rows.Count -ge 1 -and $res.Rows[0].File -eq 'same.txt <-> changed.csv' -and $res.Rows[0].Status -eq 'Different') 'compared directly'

  Write-Host 'Files against a folder'
  $res = Invoke-BulkCheck @{ A = @((Join-Path $A 'same.txt'), (Join-Path $A 'config.xml')); B = $B }
  $files = @($res.Rows | Select-Object -ExpandProperty File -Unique)
  Check ($files.Count -eq 2) "only the 2 chosen files are compared (got $($files -join ', '))"
  Check ((Status-Of $res.Rows 'same.txt') -eq 'Identical' -and (Status-Of $res.Rows 'config.xml') -eq 'Different') 'statuses'

  Write-Host 'Comma-separated list and wildcard'
  $res = Invoke-BulkCheck @{ A = ((Join-Path $A 'same.txt') + ',' + (Join-Path $A 'eol.txt')); B = $B }
  Check (@($res.Rows | Select-Object -ExpandProperty File -Unique).Count -eq 2) 'comma-separated list'
  $res = Invoke-BulkCheck @{ A = (Join-Path $A '*.txt'); B = $B }
  Check ((Status-Of $res.Rows 'spaces.txt') -eq 'Different' -and (Status-Of $res.Rows 'changed.csv') -eq '<missing>') 'wildcard *.txt'

  Write-Host 'Exit codes and HTML'
  $res = Invoke-BulkCheck @{ A = (Join-Path $A 'same.txt'); B = (Join-Path $B 'same.txt') }
  Check ($res.Code -eq 0) 'exit code 0 when identical'
  $res = Invoke-BulkCheck @{ A = (Join-Path $A 'does-not-exist.txt'); B = $B }
  Check ($res.Code -eq 2) 'exit code 2 on a missing path'
  $html = Join-Path $tmp 'report.html'
  & $script -A $A -B $B -Html $html -SummaryOnly *> $null
  $content = [IO.File]::ReadAllText($html)
  Check ($content.Contains('config.xml') -and $content.Contains('&lt;b&gt;3&lt;/b&gt;')) 'HTML report written and escaped'
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

if ($script:failures -gt 0) { Write-Host "$($script:failures) check(s) failed" -ForegroundColor Red; exit 1 }
Write-Host 'All checks passed' -ForegroundColor Green
exit 0
