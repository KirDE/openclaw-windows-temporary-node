# OpenClaw Temporary Windows Node

Run a temporary OpenClaw node on a Windows PC for troubleshooting and repair.
The bootstrap uses a portable Node.js runtime, keeps all OpenClaw state under a
random directory in `%TEMP%`, stays in the foreground, and removes its local
runtime and device credentials when it exits.

No administrator privileges, permanent Node.js installation, OpenClaw service,
or inbound port forwarding are required.

> [!WARNING]
> A connected OpenClaw node can execute commands on the Windows machine after
> the Gateway operator approves its command surface and individual execution
> requests. Use it only with a Gateway and operator you trust. Stopping the node
> does **not** revoke it at the Gateway; follow the revocation step below.

## What the script does

1. Creates a current-user-only working directory under `%TEMP%`.
2. Downloads the pinned official Node.js ZIP and verifies its SHA-256 checksum.
3. Installs a pinned OpenClaw package into that temporary directory.
4. Optionally opens an outbound SSH local-forward tunnel to the Gateway host.
5. Prompts for a short-lived OpenClaw join target without echoing it.
6. Runs `openclaw connect` in the foreground with an isolated
   `OPENCLAW_STATE_DIR`.
7. Stops the tunnel and deletes the temporary runtime and credentials on exit.

The defaults are Node.js `v24.20.0` and OpenClaw `2026.9.3`. Both can be
overridden with script parameters.

## Requirements

- Windows 10/11 with Windows PowerShell 5.1 or PowerShell 7.
- Outbound HTTPS access to `nodejs.org` and `registry.npmjs.org`.
- A trusted OpenClaw Gateway operator.
- For tunnel mode: the Windows OpenSSH client, key-based SSH authentication,
  and a previously verified host key in `known_hosts`.

## Download and inspect

Download the script rather than piping remote code directly into PowerShell:

```powershell
Invoke-WebRequest `
  https://raw.githubusercontent.com/KirDE/openclaw-windows-temporary-node/main/OpenClaw-TemporaryNode.ps1 `
  -OutFile .\OpenClaw-TemporaryNode.ps1

Get-Content .\OpenClaw-TemporaryNode.ps1
```

## Option A: direct WSS/HTTPS connection

On the **Gateway**, create a short-lived join URL that points to a reachable,
TLS-protected Gateway endpoint:

```bash
openclaw devices join-code --url wss://gateway.example.com
```

Then run on **Windows**:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\OpenClaw-TemporaryNode.ps1
```

Create the join URL only when the script asks for it. It is single-use and
expires after about ten minutes. Paste it into the hidden prompt.

## Option B: connection through an SSH tunnel

This is the recommended option when the Gateway listens only on loopback. It
does not expose the Gateway port to the internet.

First, verify the SSH host key and key-based login from the Windows PC:

```powershell
ssh support@gateway.example.com exit
```

Confirm the displayed fingerprint with the Gateway administrator before
accepting it. The bootstrap deliberately uses `StrictHostKeyChecking=yes` and
will not silently trust a new host key.

Start the bootstrap on **Windows**:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\OpenClaw-TemporaryNode.ps1 `
  -SshTarget support@gateway.example.com `
  -SshIdentityFile "$env:USERPROFILE\.ssh\id_ed25519"
```

Once it reports that the tunnel is ready, create a loopback join URL on the
**Gateway**:

```bash
openclaw devices join-code --url ws://127.0.0.1:18789
```

Paste the resulting `http://127.0.0.1:18789/j/...` URL into the hidden Windows
prompt. The HTTP hop exists only over loopback at both ends and is carried
inside the authenticated SSH tunnel.

If local port `18789` is occupied, choose another local port on Windows:

```powershell
.\OpenClaw-TemporaryNode.ps1 `
  -SshTarget support@gateway.example.com `
  -LocalPort 28789
```

Generate the join URL with the matching advertised loopback port:

```bash
openclaw devices join-code --url ws://127.0.0.1:28789
```

The SSH forward still targets Gateway port `18789` unless `-GatewayPort` is
also changed.

## Approve the temporary node

OpenClaw uses separate approval steps for the device identity and its declared
node command surface. On the Gateway:

```bash
openclaw devices list
openclaw devices approve <device-request-id>
```

If the Windows command exits while waiting for approval, run the bootstrap
again with a fresh join URL. After the device connects, approve the node command
surface:

```bash
openclaw nodes pending
openclaw nodes approve <node-request-id>
openclaw nodes status
```

Command execution remains subject to the node's local exec-approval policy.
Prefer `ask: "on-miss"` or a narrow allowlist instead of unrestricted access.

## End and revoke access

1. Press `Ctrl+C` in the Windows console and wait for the cleanup message.
2. On the Gateway, identify and remove the temporary node:

   ```bash
   openclaw nodes status
   openclaw nodes remove --node <id-or-exact-name>
   ```

3. Confirm it no longer appears as paired/connected:

   ```bash
   openclaw nodes status
   openclaw devices list
   ```

Closing the console abruptly can prevent local cleanup. If that happens,
delete only the `openclaw-temporary-node-*` directory created under the current
user's `%TEMP%` directory, then revoke the node at the Gateway.

## Parameters

```text
-DisplayName        Node name shown at the Gateway
-SshTarget          Optional SSH destination, for example user@gateway.example
-SshIdentityFile    Optional path to an existing SSH private key
-LocalPort          Local tunnel port (default: 18789)
-GatewayPort        Gateway loopback port on the SSH host (default: 18789)
-NodeVersion        Pinned portable Node.js version (default: v24.20.0)
-OpenClawVersion    Pinned OpenClaw npm version (default: 2026.9.3)
```

## Security notes

- Do not paste a Gateway token or password into the script. Use the short-lived
  join URL/setup code generated by `openclaw devices join-code`.
- Do not publish join URLs, setup codes, SSH private keys, or node state.
- Do not expose the Gateway listener with router port forwarding. Use WSS,
  Tailscale, or the outbound SSH tunnel described above.
- The script uses a private target file so the join credential is not placed in
  the OpenClaw child process command line.
- The SSH mode refuses unknown host keys and password authentication. Verify
  the host fingerprint separately and use a dedicated, restricted SSH account
  where possible.
- Temporary local cleanup and Gateway-side revocation are both required.

## Official alternatives

OpenClaw also publishes a signed native Windows Hub companion app. Use Windows
Hub for ongoing access, tray status, screen/camera capabilities, and managed
connections. This repository is intentionally limited to temporary,
foreground, command-line node access.

- [OpenClaw Windows documentation](https://docs.openclaw.ai/platforms/windows)
- [OpenClaw node documentation](https://docs.openclaw.ai/cli/node)
- [OpenClaw connect documentation](https://docs.openclaw.ai/cli/connect)

## License

MIT
