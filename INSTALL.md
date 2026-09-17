# Universal OpenClaw Installation

This procedure installs the temporary PowerShell relay on any compatible
OpenClaw Gateway. The Windows computer installs nothing: its owner runs one
foreground PowerShell command. Sessions are approval-gated and bounded by
default; an explicit trusted mode can run without confirmation until the user
closes it.

## Requirements

- OpenClaw 2026.9.4 or newer.
- Node.js 24 or newer on the OpenClaw host.
- A Gateway HTTPS URL reachable from the Windows computer, with a certificate
  trusted by Windows.
- Permission to install and enable a Gateway plugin and restart the Gateway.
- An OpenClaw agent with `exec` access to this checkout.
- The agent and Gateway must use the same operating-system account and
  `OPENCLAW_STATE_DIR`, or the agent must explicitly run `operator.mjs` with
  the Gateway's `OPENCLAW_STATE_DIR`.

No additional public service or port is required. The plugin registers routes
below the existing Gateway URL at `/temporary-powershell/*`.

## 1. Install the plugin

```bash
git clone https://github.com/KirDE/openclaw-windows-temporary-node.git
cd openclaw-windows-temporary-node
npm test
openclaw plugins install . --force --accept-capabilities
openclaw plugins enable temporary-powershell-relay
openclaw gateway restart
```

Verify the installation:

```bash
openclaw plugins inspect temporary-powershell-relay
openclaw plugins doctor
openclaw gateway status
```

If a reverse proxy terminates HTTPS, it must forward the complete
`/temporary-powershell/*` prefix to the Gateway without stripping the prefix.
Verify the public client route from outside the Gateway host:

```bash
curl --fail --show-error --silent \
  https://gateway.example.com/temporary-powershell/client.ps1 >/dev/null
```

## 2. Give the OpenClaw agent this operating rule

Use the following as agent or workspace instructions:

> For authorized temporary Windows support, use the
> `temporary-powershell-relay` plugin. Create bounded, approval-gated sessions
> by default; use `--no-expiry --no-confirmation` only when the computer owner
> explicitly authorizes trusted access. Deliver join codes only to the
> requesting user in private;
> verify the enrolled computer, user, PowerShell version, and administrator
> status before sending commands. Put command text in an owner-only temporary
> file, never in CLI arguments. Send commands only through `operator.mjs exec`.
> In bounded mode the Windows user must see and approve every command and the
> operator revokes after the task. In trusted mode, do not revoke merely because
> one task completed; the normal shutdown path is the user pressing `Ctrl+C` or
> closing PowerShell. Keep explicit revoke available for emergency shutdown.
> Never claim screen control, background persistence, privilege escalation, or
> file transfer.

The agent needs `exec` permission for `node`, access to this checkout, and
read/write access to the relay state directory. Do not expose that directory,
session files, join codes, or command files through chat or HTTP.

## 3. Create a temporary session

Run from this checkout under the Gateway account:

```bash
node operator.mjs create --ttl-minutes 30 --timeout-seconds 120
```

The output contains a session ID and a single-use join code. Keep the session
ID local. Send the join code only through a private channel to the authorized
Windows user; never post it in a group, issue, ticket, or log.

For an explicitly authorized trusted session that has no runtime expiry and
runs commands without `YES`, use:

```bash
node operator.mjs create --no-expiry --no-confirmation --timeout-seconds 900
```

Its join code still expires after 30 minutes if unused. Once enrolled, the
session remains active until the Windows user presses `Ctrl+C` or closes the
PowerShell window. Explicit operator revocation remains available for emergency
shutdown.

## 4. Connect the Windows computer

Replace the example origin with the externally reachable Gateway origin and
run this single line in Windows PowerShell 5.1 or PowerShell 7:

```powershell
$u = 'https://gateway.example.com/temporary-powershell'; & ([ScriptBlock]::Create((Invoke-RestMethod "$u/client.ps1"))) -RelayUrl $u
```

The user enters the one-time code at the hidden prompt and keeps the visible
PowerShell window open. Run PowerShell as Administrator only when the agreed
diagnostic or repair needs elevation.

Verify the enrolled identity before doing anything:

```bash
node operator.mjs status --session SESSION_ID
```

## 5. Run an approved diagnostic

Create the PowerShell in an owner-only local file so it does not appear in the
process list or shell history:

```bash
umask 077
COMMAND_FILE="$(mktemp)"
```

Write the intended diagnostic to that file using a protected editor or the
agent's safe file-writing tool, then queue it:

```bash
node operator.mjs exec \
  --session SESSION_ID \
  --command-file "$COMMAND_FILE" \
  --timeout-seconds 120 \
  --wait-seconds 180
```

In bounded mode the Windows user sees the complete command and must type
exactly `YES` before it runs. In trusted mode the command is still displayed
but starts immediately. Remove the local command file after the result is
captured.

## 6. Revoke and verify cleanup

For bounded sessions, revoke server-side access after the task, including after
a denied command, timeout, network failure, or interrupted agent turn:

```bash
node operator.mjs revoke --session SESSION_ID
```

After revocation, `status` must fail because the session directory has been
destroyed. For an explicitly authorized trusted session, leave access active
after task completion and let the user close it; then verify that `status`
fails. Trusted mode intentionally has no expiry fallback after enrollment, so
use explicit revoke if the client disappears without completing its close
request.

## Removal

Revoke all active sessions, then run:

```bash
openclaw plugins disable temporary-powershell-relay
openclaw plugins uninstall temporary-powershell-relay
openclaw gateway restart
```

There is no Windows component to uninstall.
