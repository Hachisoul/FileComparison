<#
.SYNOPSIS
  BulkCheck command-line version: compare folders or files and show which lines differ.

.DESCRIPTION
  Works with Windows PowerShell 5.1 (built into Windows 10 and 11) and PowerShell 7.
  Nothing to install.

  -A and -B each take a folder, one file, or several files:
    Two folders                 files are matched by name (and subfolder path).
    One file on each side       the two files are compared, even if their names differ.
    Several files on each side  files are matched by name.
    Files against a folder      each file is compared with the same-named file in the folder.

  Text files are compared line by line. Word (.docx) and Excel (.xlsx) are compared by their text.
  Other files (including PDF) are compared byte for byte. Images and videos are skipped.

  Exit code: 0 = everything identical, 1 = differences or missing files, 2 = error.

.EXAMPLE
  .\bulkcheck.ps1 -A "C:\Release 2.3" -B "C:\Release 2.4"

.EXAMPLE
  .\bulkcheck.ps1 -A old.xml -B new.xml

.EXAMPLE
  .\bulkcheck.ps1 -A C:\Old -B C:\New -Html report.html -Csv report.csv -SummaryOnly
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)][string[]]$A,
  [Parameter(Mandatory = $true, Position = 1)][string[]]$B,
  [switch]$NoSubfolders,
  [switch]$IgnoreWhitespace,
  [switch]$IgnoreCase,
  [string]$Csv,
  [string]$Html,
  [switch]$SummaryOnly,
  [int]$MaxLines = 40,
  [int]$Context = 3
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$script:Version = '1.1.0'

# ---------------------------------------------------------------- file types

$ImageExt = @('png','jpg','jpeg','jpe','jfif','gif','bmp','dib','tif','tiff','webp','ico','icns','svg','svgz',
  'heic','heif','avif','psd','raw','cr2','cr3','nef','arw','dng','orf','rw2','tga','jxl','jp2','emf','wmf','xcf')
$VideoExt = @('mp4','m4v','mov','avi','mkv','wmv','flv','f4v','webm','mpg','mpeg','mpe','m2v','3gp','3g2',
  'mts','m2ts','vob','ogv','rm','rmvb','asf','divx')
$DocxExt = @('docx','docm','dotx')
$XlsxExt = @('xlsx','xlsm','xltx')
$IgnoredNames = @('thumbs.db','desktop.ini','.ds_store')
$MaxTextBytes = 64MB

function Get-Kind([string]$Path) {
  $ext = [IO.Path]::GetExtension($Path).TrimStart('.').ToLowerInvariant()
  if ($ImageExt -contains $ext) { return 'image' }
  if ($VideoExt -contains $ext) { return 'video' }
  if ($DocxExt -contains $ext) { return 'docx' }
  if ($XlsxExt -contains $ext) { return 'xlsx' }
  return 'auto'
}

# ---------------------------------------------------------------- reading files

$script:ZipLoaded = $false
function Initialize-Zip {
  if (-not $script:ZipLoaded) {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $script:ZipLoaded = $true
  }
}

$script:Cp1252 = $null
function Get-Cp1252 {
  if ($null -eq $script:Cp1252) {
    try {
      $script:Cp1252 = [Text.Encoding]::GetEncoding(1252)
    } catch {
      # PowerShell 7 needs the code-page provider registered first.
      [Text.Encoding]::RegisterProvider([Text.CodePagesEncodingProvider]::Instance)
      $script:Cp1252 = [Text.Encoding]::GetEncoding(1252)
    }
  }
  return $script:Cp1252
}

function Split-Lines([string]$Text) {
  if ($Text.Length -eq 0) { return ,([string[]]@()) }
  $lines = [regex]::Split($Text, "\r\n|\r|\n")
  if ($lines.Length -gt 1 -and $lines[$lines.Length - 1] -eq '') {
    $lines = $lines[0..($lines.Length - 2)]
  }
  return ,([string[]]$lines)
}

# Returns decoded text, or $null when the bytes look binary.
function ConvertFrom-Bytes([byte[]]$Bytes) {
  $n = $Bytes.Length
  if ($n -eq 0) { return '' }
  if ($n -ge 3 -and $Bytes[0] -eq 0xEF -and $Bytes[1] -eq 0xBB -and $Bytes[2] -eq 0xBF) {
    return [Text.Encoding]::UTF8.GetString($Bytes, 3, $n - 3)
  }
  if ($n -ge 2 -and $Bytes[0] -eq 0xFF -and $Bytes[1] -eq 0xFE) { return [Text.Encoding]::Unicode.GetString($Bytes, 2, $n - 2) }
  if ($n -ge 2 -and $Bytes[0] -eq 0xFE -and $Bytes[1] -eq 0xFF) { return [Text.Encoding]::BigEndianUnicode.GetString($Bytes, 2, $n - 2) }

  $sample = [Math]::Min($n, 8192)
  $nul = 0; $evenNul = 0; $oddNul = 0; $ctrl = 0
  for ($i = 0; $i -lt $sample; $i++) {
    $c = $Bytes[$i]
    if ($c -eq 0) {
      $nul++
      if ($i % 2 -eq 0) { $evenNul++ } else { $oddNul++ }
    } elseif ($c -lt 9 -or ($c -gt 13 -and $c -lt 32 -and $c -ne 27)) {
      $ctrl++
    }
  }
  if ($nul -gt 0) {
    $half = $sample / 2
    if ($oddNul -gt $half * 0.3 -and $evenNul -lt $half * 0.02) { return [Text.Encoding]::Unicode.GetString($Bytes) }
    if ($evenNul -gt $half * 0.3 -and $oddNul -lt $half * 0.02) { return [Text.Encoding]::BigEndianUnicode.GetString($Bytes) }
    return $null
  }
  if ($ctrl / $sample -gt 0.1) { return $null }
  try {
    $strict = New-Object Text.UTF8Encoding($false, $true)
    return $strict.GetString($Bytes)
  } catch {
    return (Get-Cp1252).GetString($Bytes)
  }
}

function Read-ZipXml($Zip, [string]$EntryName) {
  $entry = $Zip.GetEntry($EntryName)
  if ($null -eq $entry) { return $null }
  $stream = $entry.Open()
  try {
    $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8)
    $xml = New-Object Xml.XmlDocument
    $xml.XmlResolver = $null
    $xml.LoadXml($reader.ReadToEnd())
    # The comma stops PowerShell from unrolling the document into its child nodes.
    return ,$xml
  } finally {
    $stream.Dispose()
  }
}

function Get-DocxLines([string]$Path) {
  Initialize-Zip
  $zip = [IO.Compression.ZipFile]::OpenRead($Path)
  try {
    $doc = Read-ZipXml $zip 'word/document.xml'
    $lines = New-Object 'Collections.Generic.List[string]'
    if ($null -eq $doc) { return ,($lines.ToArray()) }
    $ns = New-Object Xml.XmlNamespaceManager($doc.NameTable)
    $ns.AddNamespace('w', 'http://schemas.openxmlformats.org/wordprocessingml/2006/main')
    foreach ($p in $doc.SelectNodes('//w:body//w:p', $ns)) {
      $sb = New-Object Text.StringBuilder
      foreach ($node in $p.SelectNodes('.//w:t | .//w:tab | .//w:br', $ns)) {
        switch ($node.LocalName) {
          't' { [void]$sb.Append($node.InnerText) }
          'tab' { [void]$sb.Append("`t") }
          'br' { [void]$sb.Append(' ') }
        }
      }
      $lines.Add($sb.ToString())
    }
    # Drop empty paragraphs at the end.
    while ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq '') { $lines.RemoveAt($lines.Count - 1) }
    return ,($lines.ToArray())
  } finally {
    $zip.Dispose()
  }
}

function ConvertFrom-CellRef([string]$Ref) {
  $col = 0
  foreach ($ch in $Ref.ToCharArray()) {
    if ($ch -ge [char]'A' -and $ch -le [char]'Z') { $col = $col * 26 + ([int]$ch - 64) } else { break }
  }
  return $col
}

function Get-XlsxLines([string]$Path) {
  Initialize-Zip
  $zip = [IO.Compression.ZipFile]::OpenRead($Path)
  try {
    $main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    $relNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

    $shared = New-Object 'Collections.Generic.List[string]'
    $sst = Read-ZipXml $zip 'xl/sharedStrings.xml'
    if ($null -ne $sst) {
      $ns = New-Object Xml.XmlNamespaceManager($sst.NameTable)
      $ns.AddNamespace('m', $main)
      foreach ($si in $sst.SelectNodes('/m:sst/m:si', $ns)) {
        $sb = New-Object Text.StringBuilder
        foreach ($t in $si.SelectNodes('.//m:t[not(ancestor::m:rPh)]', $ns)) { [void]$sb.Append($t.InnerText) }
        $shared.Add($sb.ToString())
      }
    }

    $targets = @{}
    $rels = Read-ZipXml $zip 'xl/_rels/workbook.xml.rels'
    if ($null -ne $rels) {
      foreach ($r in $rels.DocumentElement.ChildNodes) {
        if ($r.NodeType -ne 'Element') { continue }
        $t = $r.GetAttribute('Target')
        if ($t.StartsWith('/')) { $t = $t.TrimStart('/') } else { $t = 'xl/' + $t }
        $targets[$r.GetAttribute('Id')] = $t
      }
    }

    $lines = New-Object 'Collections.Generic.List[string]'
    $wb = Read-ZipXml $zip 'xl/workbook.xml'
    if ($null -eq $wb) { return ,($lines.ToArray()) }
    $wns = New-Object Xml.XmlNamespaceManager($wb.NameTable)
    $wns.AddNamespace('m', $main)
    foreach ($sheet in $wb.SelectNodes('/m:workbook/m:sheets/m:sheet', $wns)) {
      $name = $sheet.GetAttribute('name')
      $rid = $sheet.GetAttribute('id', $relNs)
      $lines.Add("--- Sheet: $name ---")
      if (-not $targets.ContainsKey($rid)) { continue }
      $sx = Read-ZipXml $zip $targets[$rid]
      if ($null -eq $sx) { continue }
      $sns = New-Object Xml.XmlNamespaceManager($sx.NameTable)
      $sns.AddNamespace('m', $main)
      foreach ($row in $sx.SelectNodes('/m:worksheet/m:sheetData/m:row', $sns)) {
        $vals = New-Object 'Collections.Generic.List[string]'
        $next = 1
        foreach ($c in $row.SelectNodes('m:c', $sns)) {
          $ref = $c.GetAttribute('r')
          $col = if ($ref) { ConvertFrom-CellRef $ref } else { $next }
          while ($next -lt $col) { $vals.Add(''); $next++ }
          $type = $c.GetAttribute('t')
          $v = $c.SelectSingleNode('m:v', $sns)
          $text = ''
          if ($type -eq 's' -and $null -ne $v) {
            $idx = [int]$v.InnerText
            if ($idx -lt $shared.Count) { $text = $shared[$idx] }
          } elseif ($type -eq 'inlineStr') {
            $is = $c.SelectSingleNode('m:is', $sns)
            if ($null -ne $is) { $text = $is.InnerText }
          } elseif ($type -eq 'b' -and $null -ne $v) {
            $text = if ($v.InnerText -eq '1') { 'true' } else { 'false' }
          } elseif ($null -ne $v) {
            $text = $v.InnerText
          }
          $vals.Add(($text -replace "\r?\n", ' '))
          $next = $col + 1
        }
        while ($vals.Count -gt 0 -and $vals[$vals.Count - 1] -eq '') { $vals.RemoveAt($vals.Count - 1) }
        if ($vals.Count -gt 0) { $lines.Add('Row ' + $row.GetAttribute('r') + ': ' + ($vals -join ' | ')) }
      }
    }
    return ,($lines.ToArray())
  } finally {
    $zip.Dispose()
  }
}

# Returns @{ Kind = 'text'|'binary'; Lines; Format }
function Read-Comparable([string]$Path, [string]$Kind) {
  if ($Kind -eq 'docx') { return @{ Kind = 'text'; Lines = (Get-DocxLines $Path); Format = 'Word text' } }
  if ($Kind -eq 'xlsx') { return @{ Kind = 'text'; Lines = (Get-XlsxLines $Path); Format = 'Excel cells' } }
  $info = Get-Item -LiteralPath $Path
  if ($info.Length -gt $MaxTextBytes) { return @{ Kind = 'binary'; Format = 'Large file' } }
  $text = ConvertFrom-Bytes ([IO.File]::ReadAllBytes($Path))
  if ($null -eq $text) { return @{ Kind = 'binary'; Format = 'Binary' } }
  return @{ Kind = 'text'; Lines = (Split-Lines $text); Format = 'Text' }
}

function Test-SameBytes([string]$P1, [string]$P2) {
  $l1 = (Get-Item -LiteralPath $P1).Length
  $l2 = (Get-Item -LiteralPath $P2).Length
  if ($l1 -ne $l2) { return $false }
  if ($l1 -eq 0) { return $true }
  return (Get-FileHash -LiteralPath $P1 -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $P2 -Algorithm SHA256).Hash
}

# ---------------------------------------------------------------- line diff

function Get-NormKey([string]$s) {
  if ($IgnoreWhitespace) { $s = ($s -replace '\s+', ' ').Trim() }
  if ($IgnoreCase) { $s = $s.ToLowerInvariant() }
  return $s
}

# Myers diff on the part between the common prefix and suffix.
# Returns a list of rows: @{ T = 'eq'|'mod'|'add'|'del'; L; LT; R; RT } (L/R are 1-based line numbers).
function Compare-Lines([string[]]$Left, [string[]]$Right) {
  if ($null -eq $Left) { $Left = [string[]]@() }
  if ($null -eq $Right) { $Right = [string[]]@() }
  $n = $Left.Length; $m = $Right.Length
  $ka = New-Object 'string[]' $n
  $kb = New-Object 'string[]' $m
  for ($i = 0; $i -lt $n; $i++) { $ka[$i] = Get-NormKey $Left[$i] }
  for ($j = 0; $j -lt $m; $j++) { $kb[$j] = Get-NormKey $Right[$j] }

  $pre = 0
  while ($pre -lt $n -and $pre -lt $m -and [string]::Equals($ka[$pre], $kb[$pre], [StringComparison]::Ordinal)) { $pre++ }
  $suf = 0
  while ($suf -lt ($n - $pre) -and $suf -lt ($m - $pre) -and
         [string]::Equals($ka[$n - 1 - $suf], $kb[$m - 1 - $suf], [StringComparison]::Ordinal)) { $suf++ }

  # ops: 0 = equal, 1 = delete (left), 2 = insert (right), in order, for the middle part.
  $ops = New-Object 'Collections.Generic.List[int]'
  $N = $n - $pre - $suf; $M = $m - $pre - $suf
  $approx = $false
  if ($N -gt 0 -or $M -gt 0) {
    $max = $N + $M
    $limit = [Math]::Min($max, 800)
    $off = $max + 1
    $V = New-Object 'int[]' (2 * $max + 3)
    $trace = New-Object 'Collections.Generic.List[int[]]'
    $found = $false
    for ($d = 0; $d -le $limit; $d++) {
      $snap = New-Object 'int[]' (2 * $d + 1)
      for ($k = -$d; $k -le $d; $k += 2) {
        if ($k -eq -$d -or ($k -ne $d -and $V[$off + $k - 1] -lt $V[$off + $k + 1])) { $x = $V[$off + $k + 1] }
        else { $x = $V[$off + $k - 1] + 1 }
        $y = $x - $k
        while ($x -lt $N -and $y -lt $M -and [string]::Equals($ka[$pre + $x], $kb[$pre + $y], [StringComparison]::Ordinal)) { $x++; $y++ }
        $V[$off + $k] = $x
        if ($x -ge $N -and $y -ge $M) { $found = $true; break }
      }
      for ($k = -$d; $k -le $d; $k++) { $snap[$k + $d] = $V[$off + $k] }
      $trace.Add($snap)
      if ($found) { break }
    }
    if ($found) {
      # Walk back through the saved snapshots to recover the edit script.
      $rev = New-Object 'Collections.Generic.List[int]'
      $x = $N; $y = $M
      for ($d = $trace.Count - 1; $d -gt 0; $d--) {
        $prev = $trace[$d - 1]
        $k = $x - $y
        $pd = $d - 1
        if ($k -eq -$d -or ($k -ne $d -and $prev[$k - 1 + $pd] -lt $prev[$k + 1 + $pd])) { $pk = $k + 1 } else { $pk = $k - 1 }
        $px = $prev[$pk + $pd]
        $py = $px - $pk
        while ($x -gt $px -and $y -gt $py) { $rev.Add(0); $x--; $y-- }
        if ($x -eq $px) { $rev.Add(2); $y-- } else { $rev.Add(1); $x-- }
      }
      while ($x -gt 0 -and $y -gt 0) { $rev.Add(0); $x--; $y-- }
      for ($i = $rev.Count - 1; $i -ge 0; $i--) { $ops.Add($rev[$i]) }
    } else {
      # Too different to align quickly: compare line by line in order.
      $approx = $true
      $common = [Math]::Min($N, $M)
      for ($i = 0; $i -lt $common; $i++) {
        if ([string]::Equals($ka[$pre + $i], $kb[$pre + $i], [StringComparison]::Ordinal)) { $ops.Add(0) } else { $ops.Add(1); $ops.Add(2) }
      }
      for ($i = $common; $i -lt $N; $i++) { $ops.Add(1) }
      for ($i = $common; $i -lt $M; $i++) { $ops.Add(2) }
    }
  }

  $rows = New-Object 'Collections.Generic.List[object]'
  for ($i = 0; $i -lt $pre; $i++) { $rows.Add(@{ T = 'eq'; L = $i + 1; LT = $Left[$i]; R = $i + 1; RT = $Right[$i] }) }
  $li = $pre; $ri = $pre
  $dels = New-Object 'Collections.Generic.List[int]'
  $adds = New-Object 'Collections.Generic.List[int]'
  $flush = {
    $cnt = [Math]::Max($dels.Count, $adds.Count)
    for ($q = 0; $q -lt $cnt; $q++) {
      if ($q -lt $dels.Count -and $q -lt $adds.Count) {
        $rows.Add(@{ T = 'mod'; L = $dels[$q] + 1; LT = $Left[$dels[$q]]; R = $adds[$q] + 1; RT = $Right[$adds[$q]] })
      } elseif ($q -lt $dels.Count) {
        $rows.Add(@{ T = 'del'; L = $dels[$q] + 1; LT = $Left[$dels[$q]]; R = $null; RT = $null })
      } else {
        $rows.Add(@{ T = 'add'; L = $null; LT = $null; R = $adds[$q] + 1; RT = $Right[$adds[$q]] })
      }
    }
    $dels.Clear(); $adds.Clear()
  }
  foreach ($op in $ops) {
    if ($op -eq 1) { $dels.Add($li); $li++ }
    elseif ($op -eq 2) { $adds.Add($ri); $ri++ }
    else {
      . $flush
      $rows.Add(@{ T = 'eq'; L = $li + 1; LT = $Left[$li]; R = $ri + 1; RT = $Right[$ri] })
      $li++; $ri++
    }
  }
  . $flush
  for ($i = 0; $i -lt $suf; $i++) {
    $rows.Add(@{ T = 'eq'; L = $li + 1; LT = $Left[$li]; R = $ri + 1; RT = $Right[$ri] })
    $li++; $ri++
  }

  $stats = @{ Modified = 0; Added = 0; Deleted = 0 }
  foreach ($r in $rows) {
    if ($r.T -eq 'mod') { $stats.Modified++ } elseif ($r.T -eq 'add') { $stats.Added++ } elseif ($r.T -eq 'del') { $stats.Deleted++ }
  }
  $stats.Changed = $stats.Modified + $stats.Added + $stats.Deleted
  return @{ Rows = $rows; Stats = $stats; Approximate = $approx }
}

# ---------------------------------------------------------------- matching

function Resolve-Side([string[]]$Paths, [string]$Label) {
  # Accept "a.txt,b.txt" in one argument (that is how cmd.exe passes a list).
  $expanded = @()
  foreach ($p in $Paths) {
    if (-not (Test-Path -LiteralPath $p) -and $p.Contains(',')) { $expanded += $p.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ } }
    else { $expanded += $p }
  }
  $resolved = @()
  foreach ($p in $expanded) {
    if (Test-Path -LiteralPath $p) {
      $resolved += (Resolve-Path -LiteralPath $p).ProviderPath
    } else {
      # Allow wildcards such as *.xml
      $found = @(Resolve-Path -Path $p -ErrorAction SilentlyContinue)
      if ($found.Count -eq 0) { throw "Side ${Label}: '$p' was not found." }
      foreach ($f in $found) { $resolved += $f.ProviderPath }
    }
  }
  if ($resolved.Count -eq 0) { throw "Side ${Label}: nothing to compare." }
  if ($resolved.Count -eq 1 -and (Test-Path -LiteralPath $resolved[0] -PathType Container)) {
    return @{ Kind = 'folder'; Path = $resolved[0]; Paths = $resolved }
  }
  foreach ($p in $resolved) {
    if (Test-Path -LiteralPath $p -PathType Container) {
      throw "Side ${Label}: give either one folder or a list of files, not both."
    }
  }
  return @{ Kind = 'files'; Paths = $resolved }
}

function Get-SideFiles($Side) {
  $list = New-Object 'Collections.Generic.List[object]'
  if ($Side.Kind -eq 'files') {
    foreach ($p in $Side.Paths) { $list.Add(@{ Rel = [IO.Path]::GetFileName($p); Abs = $p }) }
    return ,$list
  }
  $root = $Side.Path.TrimEnd('\', '/')
  $items = if ($NoSubfolders) { Get-ChildItem -LiteralPath $root -File -Force } else { Get-ChildItem -LiteralPath $root -File -Recurse -Force }
  foreach ($f in $items) {
    if ($IgnoredNames -contains $f.Name.ToLowerInvariant() -or $f.Name.StartsWith('~$')) { continue }
    $rel = $f.FullName.Substring($root.Length).TrimStart('\', '/') -replace '\\', '/'
    $list.Add(@{ Rel = $rel; Abs = $f.FullName })
  }
  return ,$list
}

function Get-Pairs($SideA, $SideB) {
  $la = Get-SideFiles $SideA
  $lb = Get-SideFiles $SideB
  if ($SideA.Kind -eq 'files' -and $SideB.Kind -eq 'files' -and $la.Count -eq 1 -and $lb.Count -eq 1) {
    $name = $la[0].Rel
    if ($la[0].Rel.ToLowerInvariant() -ne $lb[0].Rel.ToLowerInvariant()) { $name = $la[0].Rel + ' <-> ' + $lb[0].Rel }
    return ,@(@{ Name = $name; Left = $la[0].Abs; Right = $lb[0].Abs })
  }
  $map = [ordered]@{}
  foreach ($f in $la) { $map[$f.Rel.ToLowerInvariant()] = @{ Name = $f.Rel; Left = $f.Abs; Right = $null } }
  foreach ($f in $lb) {
    $k = $f.Rel.ToLowerInvariant()
    if ($map.Contains($k)) { $map[$k].Right = $f.Abs } else { $map[$k] = @{ Name = $f.Rel; Left = $null; Right = $f.Abs } }
  }
  $pairs = @($map.Values | Sort-Object { $_.Name })
  if ($SideA.Kind -eq 'files' -and $SideB.Kind -eq 'folder') { $pairs = @($pairs | Where-Object { $_.Left }) }
  if ($SideB.Kind -eq 'files' -and $SideA.Kind -eq 'folder') { $pairs = @($pairs | Where-Object { $_.Right }) }
  return ,$pairs
}

# ---------------------------------------------------------------- compare one pair

function Compare-Pair($Pair) {
  $r = @{ Name = $Pair.Name; Left = $Pair.Left; Right = $Pair.Right; Status = ''; Message = ''; Format = ''; Stats = $null; Rows = $null; Approximate = $false }
  if (-not $Pair.Left) { $r.Status = 'only-right'; $r.Message = 'Only in B'; return $r }
  if (-not $Pair.Right) { $r.Status = 'only-left'; $r.Message = 'Only in A'; return $r }
  try {
    $kind = Get-Kind $Pair.Left
    if ($kind -eq 'image') { $r.Status = 'skipped'; $r.Message = 'Image file (not compared)'; return $r }
    if ($kind -eq 'video') { $r.Status = 'skipped'; $r.Message = 'Video file (not compared)'; return $r }
    if (Test-SameBytes $Pair.Left $Pair.Right) { $r.Status = 'identical'; $r.Message = 'Files are identical'; return $r }

    $a = Read-Comparable $Pair.Left $kind
    $b = Read-Comparable $Pair.Right (Get-Kind $Pair.Right)
    if ($a.Kind -eq 'text' -and $b.Kind -eq 'text') {
      $d = Compare-Lines $a.Lines $b.Lines
      $r.Format = $a.Format
      $r.Stats = $d.Stats
      $r.Rows = $d.Rows
      $r.Approximate = $d.Approximate
      if ($d.Stats.Changed -eq 0) {
        $r.Status = 'identical'
        $r.Message = 'Same content (only line endings, encoding or ignored differences)'
      } else {
        $r.Status = 'different'
        $r.Message = if ($d.Stats.Changed -eq 1) { '1 line differs' } else { "$($d.Stats.Changed) lines differ" }
      }
      return $r
    }
    $r.Status = 'different'; $r.Format = 'Binary'
    $r.Message = 'Binary content differs (no line view for this file type)'
    return $r
  } catch {
    $r.Status = 'error'; $r.Message = 'Could not read: ' + $_.Exception.Message
    return $r
  }
}

# ---------------------------------------------------------------- output

$StatusLabel = @{ identical = 'Identical'; different = 'Different'; 'only-left' = 'Only in A'; 'only-right' = 'Only in B'; skipped = 'Skipped'; error = 'Error' }
$StatusColor = @{ identical = 'Green'; different = 'Yellow'; 'only-left' = 'Magenta'; 'only-right' = 'Magenta'; skipped = 'DarkGray'; error = 'Red' }

function Write-Changes($Res) {
  $shown = 0
  $rows = $Res.Rows
  for ($i = 0; $i -lt $rows.Count; $i++) {
    $row = $rows[$i]
    if ($row.T -eq 'eq') { continue }
    if ($shown -ge $MaxLines) {
      $left = 0
      for ($j = $i; $j -lt $rows.Count; $j++) { if ($rows[$j].T -ne 'eq') { $left++ } }
      Write-Host ("      ... {0} more changed line(s). Use -Html for the full report." -f $left) -ForegroundColor DarkGray
      return
    }
    if ($row.T -eq 'mod' -or $row.T -eq 'del') { Write-Host ("      A {0,6} - {1}" -f $row.L, $row.LT) -ForegroundColor Red }
    if ($row.T -eq 'mod' -or $row.T -eq 'add') { Write-Host ("      B {0,6} + {1}" -f $row.R, $row.RT) -ForegroundColor Green }
    $shown++
  }
}

function ConvertTo-CsvCell($v) {
  if ($null -eq $v) { return '' }
  $s = [string]$v
  if ($s -match '^[=+\-@\t\r]') { $s = "'" + $s }
  # Quote cells with commas, quotes, line breaks or leading/trailing spaces so they survive a round trip.
  if ($s -match '[",\r\n]' -or $s -ne $s.Trim()) { $s = '"' + $s.Replace('"', '""') + '"' }
  return $s
}

function Save-Csv([string]$OutPath, $Results, [string]$DescA, [string]$DescB) {
  $change = @{ mod = 'Changed'; add = 'Added in B'; del = 'Missing in B' }
  $sb = New-Object Text.StringBuilder
  $line = { param($cells) [void]$sb.Append((($cells | ForEach-Object { ConvertTo-CsvCell $_ }) -join ',') + "`r`n") }
  & $line @('BulkCheck report', (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))
  & $line @('A', $DescA)
  & $line @('B', $DescB)
  [void]$sb.Append("`r`n")
  & $line @('File', 'Status', 'Summary', 'Change', 'Line in A', 'Content in A', 'Line in B', 'Content in B')
  foreach ($r in $Results) {
    $changed = @()
    if ($null -ne $r.Rows) { $changed = @($r.Rows | Where-Object { $_.T -ne 'eq' }) }
    if ($changed.Count -eq 0) { & $line @($r.Name, $StatusLabel[$r.Status], $r.Message); continue }
    foreach ($row in $changed) { & $line @($r.Name, $StatusLabel[$r.Status], $r.Message, $change[$row.T], $row.L, $row.LT, $row.R, $row.RT) }
  }
  [IO.File]::WriteAllText($OutPath, $sb.ToString(), (New-Object Text.UTF8Encoding($true)))
}

function ConvertTo-HtmlText($s) {
  if ($null -eq $s) { return '' }
  return [Net.WebUtility]::HtmlEncode([string]$s)
}

function Save-Html([string]$OutPath, $Results, [string]$DescA, [string]$DescB) {
  $sb = New-Object Text.StringBuilder
  $add = { param($t) [void]$sb.Append($t) }
  $counts = @{}
  foreach ($r in $Results) { $counts[$r.Status] = 1 + [int]$counts[$r.Status] }
  & $add @"
<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>BulkCheck report</title>
<style>
:root{--bg:#f6f7f9;--panel:#fff;--border:#dfe3e8;--text:#1d2330;--muted:#677084;--ok:#1f8a4c;--diff:#c26a00;--only:#7a4fd6;--err:#cf3b3b;--mod:#fff4dc;--del:#ffe9e9;--add:#e5f7ea;--gap:#eef1f6;--ln:#98a1b2}
@media (prefers-color-scheme:dark){:root{--bg:#15181e;--panel:#1c2028;--border:#2f3542;--text:#e6e9ef;--muted:#9aa3b5;--ok:#4cc27f;--diff:#f0a33a;--only:#a98bf2;--err:#ff6b6b;--mod:#3a3017;--del:#3d1f22;--add:#17351f;--gap:#222836;--ln:#6d7689}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 "Segoe UI",system-ui,sans-serif}
header{background:var(--panel);border-bottom:1px solid var(--border);padding:16px 24px}h1{margin:0 0 6px;font-size:20px}
.meta{color:var(--muted);font-size:13px;word-break:break-all}main{padding:16px 24px;max-width:1600px;margin:0 auto}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.chip{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:3px 12px;font-size:13px}
table.sum{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--border);margin-bottom:24px}
.sum td,.sum th{padding:6px 10px;border-bottom:1px solid var(--border);text-align:left;font-size:13px}.sum th{color:var(--muted);font-weight:600}
.s-identical{color:var(--ok)}.s-different{color:var(--diff)}.s-only-left,.s-only-right{color:var(--only)}.s-error{color:var(--err)}.s-skipped{color:var(--muted)}
.st{font-weight:600;white-space:nowrap}a{color:inherit}
section{background:var(--panel);border:1px solid var(--border);border-radius:8px;margin-bottom:20px;overflow:hidden}
section h2{margin:0;padding:10px 14px;font-size:15px;border-bottom:1px solid var(--border)}section h2 small{color:var(--muted);font-weight:400;margin-left:8px}
.paths{display:grid;grid-template-columns:1fr 1fr;font-size:12px;color:var(--muted);border-bottom:1px solid var(--border)}.paths div{padding:4px 12px;word-break:break-all}
.diff{display:grid;grid-template-columns:56px 1fr 56px 1fr;font:12.5px/1.55 Consolas,"Cascadia Mono",monospace}
.diff>div{padding:0 8px;white-space:pre-wrap;overflow-wrap:anywhere;min-height:1.55em}.ln{text-align:right;color:var(--ln);border-right:1px solid var(--border)}
.c.r,.ln.r{border-left:1px solid var(--border)}.mod{background:var(--mod)}.del{background:var(--del)}.add{background:var(--add)}
.gap{grid-column:1/-1;background:var(--gap);color:var(--muted);text-align:center;font:12px "Segoe UI",sans-serif;padding:3px}
</style></head><body><header><h1>BulkCheck report</h1>
"@
  & $add ('<div class="meta">A: ' + (ConvertTo-HtmlText $DescA) + '<br>B: ' + (ConvertTo-HtmlText $DescB) + '<br>' + (Get-Date).ToString('yyyy-MM-dd HH:mm') + '</div></header><main><div class="chips">')
  & $add ('<span class="chip">All ' + $Results.Count + '</span>')
  foreach ($s in @('different', 'identical', 'only-left', 'only-right', 'skipped', 'error')) {
    if ($counts.ContainsKey($s)) { & $add ('<span class="chip s-' + $s + '">' + $StatusLabel[$s] + ' ' + $counts[$s] + '</span>') }
  }
  & $add '</div><table class="sum"><tr><th>File</th><th>Status</th><th>Details</th></tr>'
  $idx = 0
  foreach ($r in $Results) {
    $idx++
    $nameCell = ConvertTo-HtmlText $r.Name
    if ($r.Status -eq 'different' -and $null -ne $r.Rows) { $nameCell = '<a href="#f' + $idx + '">' + $nameCell + '</a>' }
    & $add ('<tr><td>' + $nameCell + '</td><td class="st s-' + $r.Status + '">' + $StatusLabel[$r.Status] + '</td><td>' + (ConvertTo-HtmlText $r.Message) + '</td></tr>')
  }
  & $add '</table>'
  $idx = 0
  foreach ($r in $Results) {
    $idx++
    if ($r.Status -ne 'different' -or $null -eq $r.Rows) { continue }
    & $add ('<section id="f' + $idx + '"><h2>' + (ConvertTo-HtmlText $r.Name) + '<small>' + (ConvertTo-HtmlText $r.Message) + '</small></h2>')
    & $add ('<div class="paths"><div>A: ' + (ConvertTo-HtmlText $r.Left) + '</div><div>B: ' + (ConvertTo-HtmlText $r.Right) + '</div></div><div class="diff">')
    $rows = $r.Rows
    $keep = New-Object 'bool[]' $rows.Count
    for ($i = 0; $i -lt $rows.Count; $i++) {
      if ($rows[$i].T -ne 'eq') {
        $lo = [Math]::Max(0, $i - $Context); $hi = [Math]::Min($rows.Count - 1, $i + $Context)
        for ($k = $lo; $k -le $hi; $k++) { $keep[$k] = $true }
      }
    }
    $gap = 0
    for ($i = 0; $i -lt $rows.Count; $i++) {
      if (-not $keep[$i]) { $gap++; continue }
      if ($gap -gt 0) { & $add ('<div class="gap">... ' + $gap + ' unchanged line(s) ...</div>'); $gap = 0 }
      $row = $rows[$i]
      $lc = ''; $rc = ''
      if ($row.T -eq 'mod') { $lc = 'mod'; $rc = 'mod' } elseif ($row.T -eq 'del') { $lc = 'del' } elseif ($row.T -eq 'add') { $rc = 'add' }
      & $add ('<div class="ln ' + $lc + '">' + $row.L + '</div><div class="c l ' + $lc + '">' + (ConvertTo-HtmlText $row.LT) + '</div>')
      & $add ('<div class="ln r ' + $rc + '">' + $row.R + '</div><div class="c r ' + $rc + '">' + (ConvertTo-HtmlText $row.RT) + '</div>')
    }
    if ($gap -gt 0) { & $add ('<div class="gap">... ' + $gap + ' unchanged line(s) ...</div>') }
    & $add '</div></section>'
  }
  & $add '</main></body></html>'
  [IO.File]::WriteAllText($OutPath, $sb.ToString(), (New-Object Text.UTF8Encoding($false)))
}

function Get-SideText($Side) {
  if ($Side.Kind -eq 'folder') { return $Side.Path }
  if ($Side.Paths.Count -eq 1) { return $Side.Paths[0] }
  return "$($Side.Paths.Count) files: " + ($Side.Paths -join '; ')
}

function Get-FullOutPath([string]$p) {
  if ([IO.Path]::IsPathRooted($p)) { return $p }
  return Join-Path (Get-Location).ProviderPath $p
}

# ---------------------------------------------------------------- main

try {
  $sideA = Resolve-Side $A 'A'
  $sideB = Resolve-Side $B 'B'
  $descA = Get-SideText $sideA
  $descB = Get-SideText $sideB

  Write-Host "BulkCheck $script:Version" -ForegroundColor Cyan
  Write-Host "  A: $descA"
  Write-Host "  B: $descB"
  Write-Host ''

  $pairs = Get-Pairs $sideA $sideB
  $results = New-Object 'Collections.Generic.List[object]'
  $n = 0
  foreach ($p in $pairs) {
    $n++
    Write-Progress -Activity 'BulkCheck' -Status "$n / $($pairs.Count): $($p.Name)" -PercentComplete ([int](100 * $n / [Math]::Max(1, $pairs.Count)))
    $res = Compare-Pair $p
    $results.Add($res)
    $label = $StatusLabel[$res.Status].ToUpperInvariant()
    Write-Host ('{0,-11}' -f $label) -ForegroundColor $StatusColor[$res.Status] -NoNewline
    Write-Host (' ' + $res.Name + '  ') -NoNewline
    Write-Host $res.Message -ForegroundColor DarkGray
    if (-not $SummaryOnly -and $res.Status -eq 'different' -and $null -ne $res.Rows) { Write-Changes $res }
  }
  Write-Progress -Activity 'BulkCheck' -Completed

  $count = { param($st) @($results | Where-Object { $_.Status -eq $st }).Count }
  $diff = & $count 'different'
  $same = & $count 'identical'
  $missing = (& $count 'only-left') + (& $count 'only-right')
  $skipped = & $count 'skipped'
  $errors = & $count 'error'
  Write-Host ''
  Write-Host ("Summary: {0} files  |  {1} different  |  {2} identical  |  {3} missing on one side  |  {4} skipped  |  {5} errors" -f `
    $results.Count, $diff, $same, $missing, $skipped, $errors) -ForegroundColor Cyan

  if ($Csv) {
    $out = Get-FullOutPath $Csv
    Save-Csv $out $results $descA $descB
    Write-Host "CSV report saved: $out"
  }
  if ($Html) {
    $out = Get-FullOutPath $Html
    Save-Html $out $results $descA $descB
    Write-Host "HTML report saved: $out"
  }

  if ($errors -gt 0) { exit 2 }
  if ($diff -gt 0 -or $missing -gt 0) { exit 1 }
  exit 0
} catch {
  Write-Host ('Error: ' + $_.Exception.Message) -ForegroundColor Red
  exit 2
}
