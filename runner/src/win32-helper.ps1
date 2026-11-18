# The runner's helper on Windows (src/win32-helper.ts starts it, hidden, and
# keeps it running). What ps and lsof tell the runner on a Mac, Windows
# only tells through PowerShell, and a new powershell.exe for each question
# takes a second or more; this one answers in about a tenth of that.
#
# One request a line on stdin, as JSON: { "id": n, "op": ..., ... }. One
# answer a line on stdout: { "id": n, "ok": true, "result": "<text>" } or
# { "id": n, "ok": false, "error": "<why>" }. Results are plain text the
# runner parses, so PowerShell 5's JSON quirks (a one-item array coming out
# as the item) can't change their shape.
#
#   processes   every process, one "pid ppid created" line each, created
#               as a FILETIME (100 ns since 1601, UTC; 0 when Windows
#               won't say)
#   snapshot    for port: every established connection to it, with the
#               pid holding the client's end, and every process (below),
#               in one answer, so any number of connections waiting to be
#               looked up share one (peer.ts)
#
# The runner doesn't run this file: it reads it once when it starts and
# passes it to powershell.exe as -EncodedCommand, so changing the file
# under a running runner changes nothing (Codex's review, 18 Nov 2026).

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Only Windows' own modules, from System32 by full path, and nothing loaded
# by name from anywhere else: PowerShell would otherwise find a module
# called NetTCPIP or CimCmdlets in Documents\WindowsPowerShell\Modules first,
# and a thread can write there (Codex's third review, 18 Nov 2026). The
# commands below are called by their modules' names too.
$PSModuleAutoLoadingPreference = 'None'
$system = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\Modules"
$env:PSModulePath = $system
foreach ($m in 'Microsoft.PowerShell.Utility', 'CimCmdlets', 'NetTCPIP') {
  Import-Module "$system\$m" -ErrorAction Stop
}
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$in = [Console]::In
$out = [Console]::Out

while ($true) {
  $line = $in.ReadLine()
  if ($null -eq $line) { break }
  $id = $null
  try {
    $req = $line | Microsoft.PowerShell.Utility\ConvertFrom-Json
    $id = $req.id
    switch ($req.op) {
      'ping' { $result = 'pong' }
      'processes' {
        $rows = CimCmdlets\Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CreationDate | ForEach-Object {
          $created = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }
          "$($_.ProcessId) $($_.ParentProcessId) $created"
        }
        $result = ($rows -join "`n")
      }
      'snapshot' {
        # Each established connection to the port, as its client sees it
        # ("c localAddress localPort remoteAddress remotePort pid"), then
        # every process ("p pid ppid created"). Taken after the connections,
        # so a process holding one is in the list.
        # None found is an error of its own kind (ObjectNotFound), and the
        # only one that means none: any other (access denied, the provider
        # failing) fails the snapshot, so it can't pass for "nobody's".
        try {
          $found = @(NetTCPIP\Get-NetTCPConnection -State Established -RemotePort ([int]$req.port) -ErrorAction Stop)
        } catch {
          if ($_.CategoryInfo.Category -ne 'ObjectNotFound') { throw }
          $found = @()
        }
        $conns = $found | Where-Object { $_ } | ForEach-Object {
          "c $($_.LocalAddress) $($_.LocalPort) $($_.RemoteAddress) $($_.RemotePort) $($_.OwningProcess)"
        }
        $procs = CimCmdlets\Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CreationDate | ForEach-Object {
          $created = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }
          "p $($_.ProcessId) $($_.ParentProcessId) $created"
        }
        $result = ((@($conns) + @($procs)) -join "`n")
      }
      default { throw "unknown op: $($req.op)" }
    }
    $answer = @{ id = $id; ok = $true; result = [string]$result } | Microsoft.PowerShell.Utility\ConvertTo-Json -Compress
  } catch {
    $answer = @{ id = $id; ok = $false; error = [string]$_ } | Microsoft.PowerShell.Utility\ConvertTo-Json -Compress
  }
  $out.WriteLine($answer)
  $out.Flush()
}
