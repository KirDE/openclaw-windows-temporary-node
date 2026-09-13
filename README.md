# Temporary PowerShell Support

Give a trusted operator a short-lived, approval-gated PowerShell session on a
Windows computer without installing OpenClaw, Node.js, a service, or a startup
entry on that computer.

The Windows user runs one public PowerShell command, enters a single-use code,
and keeps the console open. Every proposed command is displayed in full and
runs only after the user types `YES`. Closing the console ends the client;
server-side expiry and explicit revocation end the session independently.

> [!WARNING]
> This tool provides remote command execution. Use it only with a trusted
> operator and only on computers whose owner has authorized the session. Never
> share a join code publicly.

## What is—and is not—installed on Windows

Nothing is installed. The client uses Windows PowerShell 5.1 components already
present on Windows 10/11: `Invoke-RestMethod`, one in-memory foreground script,
and temporary `Start-Job` child processes for bounded command execution.

It does **not** install or download Node.js, OpenClaw, WinRM, OpenSSH, a Windows
service, a scheduled task, a driver, or a persistent credential. The client
keeps its session token only in process memory.

Some process must still run on the target computer: an untouched computer
cannot be controlled remotely. Here that process is the visible foreground
PowerShell window started by the user.

## Architecture

1. The Gateway operator creates a session locally with `operator.mjs`.
2. The relay returns a random single-use join code valid for a bounded time.
3. The Windows user runs the public client and enters that code at a hidden prompt.
4. The relay consumes the code and gives the client a random bearer token.
5. The operator queues PowerShell through a protected local command file.
6. Windows displays the complete command and waits for `YES`.
7. The command runs in a bounded PowerShell job and returns output to the relay.
8. Closing, expiry, or operator revocation invalidates the bearer token.

The relay is an OpenClaw Gateway plugin. It binds no additional port and uses
the Gateway's existing HTTPS endpoint. Client routes use plugin-managed random
tokens; operator actions are local filesystem operations and are not exposed by
HTTP.

## Windows: connect with one command

Run in Windows PowerShell 5.1 or PowerShell 7:

```powershell
$u = 'https://gateway.example.com/temporary-powershell'; & ([ScriptBlock]::Create((Invoke-RestMethod 'https://raw.githubusercontent.com/KirDE/openclaw-windows-temporary-node/main/Connect-TemporaryPowerShell.ps1'))) -RelayUrl $u
```

Replace `https://gateway.example.com` with the HTTPS URL through which the
Windows computer can reach this OpenClaw Gateway. The command downloads the
current client directly from this repository into memory and starts it; the
user does not need to clone the repository or save the script first. Relay
traffic still goes only to the explicitly supplied Gateway URL. The relay URL
is deliberately not compiled into the client, so the same client works with
every OpenClaw installation.

The script asks for the single-use code with hidden input. Run PowerShell as
Administrator only when the requested repair actually needs elevation. For
maximum assurance, download and inspect `Connect-TemporaryPowerShell.ps1`
before running it instead of using the one-line form.

## Gateway installation

From this repository on the OpenClaw host:

```bash
openclaw plugins install . --force --accept-capabilities
openclaw plugins enable temporary-powershell-relay
openclaw gateway restart
```

The plugin stores ephemeral state below
`$OPENCLAW_STATE_DIR/powershell-relay` (normally
`~/.openclaw/powershell-relay`) with owner-only permissions.

For a complete installation, reverse-proxy, agent-operation, verification, and
removal procedure, see [`INSTALL.md`](INSTALL.md).

## Operator workflow

Create a 30-minute session:

```bash
node operator.mjs create --ttl-minutes 30 --timeout-seconds 120
```

Deliver the returned join code privately to the Windows user. Do not paste it
into a group chat or ticket. Check whether the client connected:

```bash
node operator.mjs status --session <session-id>
```

Write the proposed PowerShell into an owner-only local file, then queue it:

```bash
node operator.mjs exec \
  --session <session-id> \
  --command-file /secure/local/diagnostic.ps1 \
  --timeout-seconds 120 \
  --wait-seconds 180
```

Command text is deliberately not accepted as a CLI argument, preventing it
from leaking into process listings and shell history. End access even if the
Windows console is still open:

```bash
node operator.mjs revoke --session <session-id>
```

## Security properties

- Join codes carry about 96 bits of randomness, are stored only as SHA-256
  hashes, are single-use, and expire.
- Client bearer tokens are random, stored only as SHA-256 hashes, and revoked
  on close, expiry, or operator action.
- Operator command submission is not available over HTTP.
- Every command requires visible target-user approval by default.
- Commands have a 5–900 second timeout and run in separate PowerShell jobs.
- Commands are limited to 256 KiB and returned output to 1 MiB.
- HTTP request bodies are limited to 2 MiB and responses disable caching.
- The client never disables TLS certificate validation.
- No secrets, join codes, or bearer tokens belong in the repository.

This is not a substitute for a managed endpoint agent. It intentionally omits
screen control, background persistence, unattended execution, dedicated file
transfer, and privilege escalation.

## Verification

```bash
npm test
```

GitHub Actions parses the client with Windows PowerShell 5.1, runs
PSScriptAnalyzer, and executes the Node.js relay tests. These checks do not
replace a real end-to-end Windows session test.

## Removal

Revoke every active session, then disable and uninstall the plugin:

```bash
openclaw plugins disable temporary-powershell-relay
openclaw plugins uninstall temporary-powershell-relay
openclaw gateway restart
```

The Windows side has no installed component to remove.

## License

MIT
