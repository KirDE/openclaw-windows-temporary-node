[CmdletBinding()]
param(
    [Parameter()]
    [string]$DisplayName = "Temporary Windows node ($env:COMPUTERNAME)",

    [Parameter()]
    [string]$SshTarget,

    [Parameter()]
    [string]$SshIdentityFile,

    [Parameter()]
    [ValidateRange(1, 65535)]
    [int]$LocalPort = 18789,

    [Parameter()]
    [ValidateRange(1, 65535)]
    [int]$GatewayPort = 18789,

    [Parameter()]
    [string]$NodeVersion = "v24.20.0",

    [Parameter()]
    [string]$OpenClawVersion = "2026.9.3"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-Step {
    param([Parameter(Mandatory)][string]$Message)
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Test-TcpPort {
    param(
        [Parameter(Mandatory)][string]$HostName,
        [Parameter(Mandatory)][int]$Port,
        [int]$TimeoutMilliseconds = 500
    )

    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $result = $client.BeginConnect($HostName, $Port, $null, $null)
        if (-not $result.AsyncWaitHandle.WaitOne($TimeoutMilliseconds, $false)) {
            return $false
        }
        $client.EndConnect($result)
        return $true
    }
    catch {
        return $false
    }
    finally {
        $client.Close()
    }
}

function Protect-DirectoryForCurrentUser {
    param([Parameter(Mandatory)][string]$Path)

    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $security = New-Object System.Security.AccessControl.DirectorySecurity
    $security.SetOwner($identity)
    $security.SetAccessRuleProtection($true, $false)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $identity,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        [System.Security.AccessControl.InheritanceFlags]"ContainerInherit, ObjectInherit",
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow
    )
    $security.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $security
}

function Read-SecretText {
    param([Parameter(Mandatory)][string]$Prompt)

    $secure = Read-Host -Prompt $Prompt -AsSecureString
    $pointer = [IntPtr]::Zero
    try {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        if ($pointer -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        }
    }
}

if ($env:OS -ne "Windows_NT") {
    throw "This bootstrap is intended for Windows PowerShell or PowerShell on Windows."
}
if ($NodeVersion -notmatch '^v\d+\.\d+\.\d+$') {
    throw "NodeVersion must look like v24.20.0."
}
if ($OpenClawVersion -notmatch '^\d{4}\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') {
    throw "OpenClawVersion must look like 2026.9.3."
}
if ($SshTarget -and ($SshTarget.StartsWith('-') -or $SshTarget -match '\s')) {
    throw "SshTarget must be a single SSH host expression without whitespace."
}
if ($SshIdentityFile -and -not $SshTarget) {
    throw "SshIdentityFile requires SshTarget."
}

$architecture = switch ($env:PROCESSOR_ARCHITECTURE) {
    "AMD64" { "x64" }
    "ARM64" { "arm64" }
    default { throw "Unsupported Windows architecture: $env:PROCESSOR_ARCHITECTURE" }
}

$workRoot = Join-Path ([IO.Path]::GetTempPath()) ("openclaw-temporary-node-" + [Guid]::NewGuid().ToString("N"))
$sshProcess = $null
$environmentNames = @("PATH", "OPENCLAW_STATE_DIR", "npm_config_cache", "npm_config_audit", "npm_config_fund", "npm_config_update_notifier")
$oldEnvironment = @{}
foreach ($name in $environmentNames) {
    $oldEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

try {
    New-Item -ItemType Directory -Path $workRoot | Out-Null
    Protect-DirectoryForCurrentUser -Path $workRoot

    $nodeArchive = "node-$NodeVersion-win-$architecture.zip"
    $nodeArchivePath = Join-Path $workRoot $nodeArchive
    $checksumsPath = Join-Path $workRoot "SHASUMS256.txt"
    $nodeBaseUrl = "https://nodejs.org/dist/$NodeVersion"

    Write-Step "Downloading portable Node.js $NodeVersion ($architecture)"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -Uri "$nodeBaseUrl/$nodeArchive" -OutFile $nodeArchivePath
    Invoke-WebRequest -UseBasicParsing -Uri "$nodeBaseUrl/SHASUMS256.txt" -OutFile $checksumsPath

    Write-Step "Verifying the Node.js SHA-256 checksum"
    $escapedArchive = [Regex]::Escape($nodeArchive)
    $checksumLine = Get-Content -LiteralPath $checksumsPath | Where-Object { $_ -match "^([0-9a-fA-F]{64})\s+$escapedArchive$" } | Select-Object -First 1
    if (-not $checksumLine) {
        throw "No checksum was published for $nodeArchive."
    }
    $expectedHash = ([Regex]::Match($checksumLine, '^([0-9a-fA-F]{64})')).Groups[1].Value
    $actualHash = (Get-FileHash -LiteralPath $nodeArchivePath -Algorithm SHA256).Hash
    if ($actualHash -ne $expectedHash) {
        throw "Node.js checksum verification failed."
    }

    Expand-Archive -LiteralPath $nodeArchivePath -DestinationPath $workRoot
    $nodeRoot = Join-Path $workRoot ("node-$NodeVersion-win-$architecture")
    $npmPath = Join-Path $nodeRoot "npm.cmd"
    if (-not (Test-Path -LiteralPath $npmPath -PathType Leaf)) {
        throw "Portable npm was not found after extraction."
    }

    $packageRoot = Join-Path $workRoot "package"
    $stateRoot = Join-Path $workRoot "state"
    $npmCache = Join-Path $workRoot "npm-cache"
    New-Item -ItemType Directory -Path $packageRoot, $stateRoot, $npmCache | Out-Null

    $env:PATH = "$nodeRoot;$($env:PATH)"
    $env:OPENCLAW_STATE_DIR = $stateRoot
    $env:npm_config_cache = $npmCache
    $env:npm_config_audit = "false"
    $env:npm_config_fund = "false"
    $env:npm_config_update_notifier = "false"

    Write-Step "Installing temporary OpenClaw $OpenClawVersion runtime"
    & $npmPath install --prefix $packageRoot --no-audit --no-fund --loglevel=error "openclaw@$OpenClawVersion"
    if ($LASTEXITCODE -ne 0) {
        throw "Temporary OpenClaw installation failed with exit code $LASTEXITCODE."
    }

    $openclawPath = Join-Path $packageRoot "node_modules\.bin\openclaw.cmd"
    if (-not (Test-Path -LiteralPath $openclawPath -PathType Leaf)) {
        throw "The OpenClaw executable was not created by npm."
    }

    if ($SshTarget) {
        if (Test-TcpPort -HostName "127.0.0.1" -Port $LocalPort) {
            throw "Local port $LocalPort is already in use. Choose another LocalPort."
        }

        $sshCommand = Get-Command ssh.exe -CommandType Application -ErrorAction Stop
        $sshArguments = @(
            "-N",
            "-o", "BatchMode=yes",
            "-o", "ExitOnForwardFailure=yes",
            "-o", "ServerAliveInterval=15",
            "-o", "ServerAliveCountMax=3",
            "-o", "StrictHostKeyChecking=yes",
            "-o", "ConnectTimeout=15"
        )
        if ($SshIdentityFile) {
            $resolvedIdentityFile = (Resolve-Path -LiteralPath $SshIdentityFile).Path
            # Start-Process joins ArgumentList values on Windows, so preserve a
            # key path containing spaces as one quoted argument.
            $sshArguments += @("-i", ('"{0}"' -f $resolvedIdentityFile))
        }
        $sshArguments += @("-L", "127.0.0.1:${LocalPort}:127.0.0.1:${GatewayPort}", $SshTarget)

        Write-Step "Starting the SSH tunnel to $SshTarget"
        $sshProcess = Start-Process -FilePath $sshCommand.Source -ArgumentList $sshArguments -NoNewWindow -PassThru

        $deadline = [DateTime]::UtcNow.AddSeconds(20)
        while ([DateTime]::UtcNow -lt $deadline) {
            if ($sshProcess.HasExited) {
                throw "SSH exited before the tunnel became ready (exit code $($sshProcess.ExitCode)). Verify key authentication and the saved host key."
            }
            if (Test-TcpPort -HostName "127.0.0.1" -Port $LocalPort) {
                break
            }
            Start-Sleep -Milliseconds 250
        }
        if (-not (Test-TcpPort -HostName "127.0.0.1" -Port $LocalPort)) {
            throw "SSH tunnel did not become ready within 20 seconds."
        }
    }

    Write-Host "`nThe Gateway operator must create a fresh, single-use join URL now." -ForegroundColor Yellow
    if ($SshTarget) {
        Write-Host "For this tunnel, the URL must start with http://127.0.0.1:$LocalPort/j/" -ForegroundColor Yellow
    }
    $joinTarget = Read-SecretText -Prompt "Paste the join URL or setup code (input is hidden)"
    if ([string]::IsNullOrWhiteSpace($joinTarget)) {
        throw "A join URL or setup code is required."
    }

    if ($SshTarget) {
        $joinUri = $null
        if (-not [Uri]::TryCreate($joinTarget, [UriKind]::Absolute, [ref]$joinUri)) {
            throw "Tunnel mode requires a loopback HTTP join URL, not a bare setup code."
        }
        if ($joinUri.Scheme -ne "http" -or $joinUri.Host -notin @("127.0.0.1", "localhost") -or $joinUri.Port -ne $LocalPort -or -not $joinUri.AbsolutePath.StartsWith("/j/")) {
            throw "Tunnel mode requires http://127.0.0.1:$LocalPort/j/<shortcode>."
        }
    }

    $targetPath = Join-Path $workRoot "join-target.txt"
    [IO.File]::WriteAllText($targetPath, $joinTarget, (New-Object Text.UTF8Encoding($false)))
    $joinTarget = $null

    Write-Step "Starting the temporary OpenClaw node"
    Write-Host "Keep this window open. Press Ctrl+C after the repair." -ForegroundColor Green
    Write-Host "The Gateway operator must approve both device pairing and the node command surface.`n" -ForegroundColor Green

    & $openclawPath connect --target-file $targetPath --display-name $DisplayName
    if ($LASTEXITCODE -ne 0) {
        throw "OpenClaw exited with code $LASTEXITCODE."
    }
}
finally {
    Write-Host "`nStopping temporary access and cleaning local files..." -ForegroundColor Yellow
    if ($sshProcess -and -not $sshProcess.HasExited) {
        Stop-Process -Id $sshProcess.Id -Force -ErrorAction SilentlyContinue
        $sshProcess.WaitForExit(5000) | Out-Null
    }

    foreach ($name in $environmentNames) {
        [Environment]::SetEnvironmentVariable($name, $oldEnvironment[$name], "Process")
    }

    if (Test-Path -LiteralPath $workRoot) {
        Remove-Item -LiteralPath $workRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    Write-Host "Local runtime and node credentials were removed." -ForegroundColor Green
    Write-Host "IMPORTANT: the Gateway operator must also revoke the paired device." -ForegroundColor Yellow
}
