[CmdletBinding()]
param(
    [Parameter()]
    [ValidatePattern('^https://')]
    [string]$RelayUrl = 'https://clawdbie.kir-it.de:18790/temporary-powershell'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function ConvertFrom-SecureText {
    param([Parameter(Mandatory)][Security.SecureString]$Value)
    $pointer = [IntPtr]::Zero
    try {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        if ($pointer -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        }
    }
}

function Invoke-RelayJson {
    param(
        [Parameter(Mandatory)][ValidateSet('GET', 'POST')][string]$Method,
        [Parameter(Mandatory)][string]$Uri,
        [Parameter()][hashtable]$Headers,
        [Parameter()]$Body
    )
    $parameters = @{
        Method = $Method
        Uri = $Uri
        UseBasicParsing = $true
        TimeoutSec = 35
        ErrorAction = 'Stop'
    }
    if ($Headers) { $parameters.Headers = $Headers }
    if ($null -ne $Body) {
        $parameters.ContentType = 'application/json; charset=utf-8'
        $parameters.Body = $Body | ConvertTo-Json -Depth 6 -Compress
    }
    return Invoke-RestMethod @parameters
}

if ($env:OS -ne 'Windows_NT') {
    throw 'This client must run on Windows.'
}

$base = $RelayUrl.TrimEnd('/')
$secureCode = Read-Host 'Enter the one-time support code (input is hidden)' -AsSecureString
$joinCode = ConvertFrom-SecureText -Value $secureCode
$secureCode.Dispose()

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$clientInfo = @{
    computerName = $env:COMPUTERNAME
    userName = $env:USERNAME
    isAdmin = $isAdmin
    psVersion = $PSVersionTable.PSVersion.ToString()
}

$enrollment = $null
try {
    $enrollment = Invoke-RelayJson -Method POST -Uri "$base/v1/enroll" -Body @{
        joinCode = $joinCode
        client = $clientInfo
    }
}
finally {
    $joinCode = $null
}

$sessionId = [string]$enrollment.sessionId
$clientToken = [string]$enrollment.clientToken
$pollSeconds = [Math]::Max(1, [int]$enrollment.pollSeconds)
$headers = @{ Authorization = "Bearer $clientToken" }
$resultCache = @{}

Write-Host "`nTemporary support session connected." -ForegroundColor Green
Write-Host "Computer: $($env:COMPUTERNAME) | User: $($env:USERNAME) | Administrator: $isAdmin"
Write-Host 'Every command will be displayed and requires typing YES. Press Ctrl+C to end access.' -ForegroundColor Yellow

try {
    while ($true) {
        $command = $null
        try {
            $command = Invoke-RelayJson -Method GET -Uri "$base/v1/commands?session=$sessionId" -Headers $headers
        }
        catch {
            $statusCode = 0
            try { $statusCode = [int]$_.Exception.Response.StatusCode } catch { $statusCode = 0 }
            if ($statusCode -eq 400 -or $statusCode -eq 401) {
                throw 'The temporary support session expired or was revoked.'
            }
            Write-Warning "Relay request failed: $($_.Exception.Message)"
            Start-Sleep -Seconds $pollSeconds
            continue
        }
        if ($null -eq $command -or -not $command.id) {
            Start-Sleep -Seconds $pollSeconds
            continue
        }

        $commandId = [string]$command.id
        if ($resultCache.ContainsKey($commandId)) {
            Invoke-RelayJson -Method POST -Uri "$base/v1/results?session=$sessionId" -Headers $headers -Body $resultCache[$commandId] | Out-Null
            $resultCache.Remove($commandId)
            continue
        }

        Write-Host "`n----- Proposed PowerShell command -----" -ForegroundColor Cyan
        Write-Host ([string]$command.script)
        Write-Host "----- Timeout: $([int]$command.timeoutSeconds) seconds -----" -ForegroundColor Cyan
        $approval = Read-Host 'Type YES to execute this command'
        if ($approval -cne 'YES') {
            $result = @{ commandId = $commandId; status = 'denied'; output = 'The Windows user denied this command.' }
        }
        else {
            $job = $null
            try {
                $scriptBlock = [ScriptBlock]::Create([string]$command.script)
                $job = Start-Job -ScriptBlock $scriptBlock
                $completed = Wait-Job -Job $job -Timeout ([int]$command.timeoutSeconds)
                if ($null -eq $completed) {
                    Stop-Job -Job $job -ErrorAction SilentlyContinue
                    $output = Receive-Job -Job $job -ErrorAction SilentlyContinue 2>&1 | Out-String
                    $result = @{ commandId = $commandId; status = 'timeout'; output = $output }
                }
                else {
                    $output = Receive-Job -Job $job -ErrorAction SilentlyContinue 2>&1 | Out-String
                    $status = if ($job.State -eq 'Completed') { 'ok' } else { 'error' }
                    $result = @{ commandId = $commandId; status = $status; output = $output }
                }
            }
            catch {
                $result = @{ commandId = $commandId; status = 'error'; output = ($_ | Out-String) }
            }
            finally {
                if ($job) { Remove-Job -Job $job -Force -ErrorAction SilentlyContinue }
            }
        }

        if ([Text.Encoding]::UTF8.GetByteCount([string]$result.output) -gt 900KB) {
            $result.output = ([string]$result.output).Substring(0, 800000) + "`n[output truncated by client]"
        }
        $resultCache[$commandId] = $result
        Invoke-RelayJson -Method POST -Uri "$base/v1/results?session=$sessionId" -Headers $headers -Body $result | Out-Null
        $resultCache.Remove($commandId)
        Write-Host "Command result returned: $($result.status)" -ForegroundColor Gray
    }
}
finally {
    if ($sessionId -and $clientToken) {
        try {
            Invoke-RelayJson -Method POST -Uri "$base/v1/close?session=$sessionId" -Headers $headers -Body @{} | Out-Null
        }
        catch {
            Write-Warning 'The relay could not confirm closure; the server-side expiry still limits this session.'
        }
    }
    $clientToken = $null
    $headers.Clear()
    Write-Host 'Temporary support access ended. No service or startup entry was installed.' -ForegroundColor Green
}
