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
#   tcpOwners   the pids holding the established TCP socket whose own end
#               is localAddress:localPort and whose far end is
#               remoteAddress:remotePort, one a line

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$in = [Console]::In
$out = [Console]::Out

while ($true) {
  $line = $in.ReadLine()
  if ($null -eq $line) { break }
  $id = $null
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    switch ($req.op) {
      'ping' { $result = 'pong' }
      'processes' {
        $rows = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CreationDate | ForEach-Object {
          $created = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }
          "$($_.ProcessId) $($_.ParentProcessId) $created"
        }
        $result = ($rows -join "`n")
      }
      'tcpOwners' {
        $conns = Get-NetTCPConnection -State Established -LocalAddress ([string]$req.localAddress) -LocalPort ([int]$req.localPort) -RemoteAddress ([string]$req.remoteAddress) -RemotePort ([int]$req.remotePort) -ErrorAction SilentlyContinue
        $result = ((@($conns) | Where-Object { $_ } | ForEach-Object { [string]$_.OwningProcess }) -join "`n")
      }
      default { throw "unknown op: $($req.op)" }
    }
    $answer = @{ id = $id; ok = $true; result = [string]$result } | ConvertTo-Json -Compress
  } catch {
    $answer = @{ id = $id; ok = $false; error = [string]$_ } | ConvertTo-Json -Compress
  }
  $out.WriteLine($answer)
  $out.Flush()
}
