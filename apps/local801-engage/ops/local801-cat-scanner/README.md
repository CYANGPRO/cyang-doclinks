# Local 801 CAT scanner adapter

This owner-operated service implements the exact `https://scan.cyang.io/v1/scan` contract used by Local 801 CAT. It is separate from the DocLinks `/scan` bearer-token scanner. The adapter binds only to loopback, authenticates each request with a body-bound HMAC plus timestamp and nonce, enforces bounded size/rate/concurrency/timeouts, sends bytes to local ClamAV with framed `INSTREAM`, and never writes request content to disk. A private runtime journal preserves accepted nonces and rate timestamps across service restarts; it contains no content, hashes, credentials or filenames and is removed on host reboot.

The ClamAV transport follows the official [`clamd` protocol](https://docs.clamav.net/manual/Usage/ClamdProtocol.html): `zINSTREAM` with 32-bit network-order chunk lengths and a zero-length terminator. The configured ClamAV `StreamMaxLength` must be at least 20 MiB and the daemon socket must never be exposed to an untrusted network.

## VPS installation

Use a supported Node.js 24 runtime and an active, current ClamAV daemon. Prefer the ClamAV Unix socket; the adapter also permits a loopback TCP socket and never permits a remote clamd host.

1. Confirm ClamAV is current and active with `clamdscan --version` and `systemctl is-active clamav-daemon`. Locate the configured local socket with `grep -E '^(LocalSocket|TCPSocket|TCPAddr)' /etc/clamav/clamd.conf`.
2. Create a dedicated unprivileged account: `sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin local801-scanner`. If using the Unix socket, add it to the socket's ClamAV group with `sudo usermod -aG clamav local801-scanner`.
3. Install `server.mjs` at `/opt/local801-cat-scanner/server.mjs`, owned by `root:root` and mode `0755`.
4. Generate a Production-only secret with `openssl rand -hex 32` and store it immediately in the approved password manager. For synthetic Preview acceptance, generate a second, distinct key and store it separately. Do not paste either key into chat, tickets, screenshots, shell history, or repository files.
5. Create `/etc/local801-cat-scanner.env` from `environment.example`, set client ID `local801-production`, insert the Production secret through `sudoedit`, and select either the discovered ClamAV socket or loopback TCP configuration. To enable synthetic Preview acceptance, also set `LOCAL801_SCANNER_PREVIEW_HMAC_SECRET_HEX` to the distinct Preview key; this activates the fixed `local801-preview` identity without exposing the Production credential to Preview. Set ownership `root:root` and mode `0600`.
6. Install `local801-cat-scanner.service` at `/etc/systemd/system/local801-cat-scanner.service`, then run `sudo systemctl daemon-reload && sudo systemctl enable --now local801-cat-scanner`. The unit deliberately sets `MemoryDenyWriteExecute=false` because Node/V8 requires executable memory during runtime initialization; retain the remaining namespace, filesystem, privilege, capability, address-family and loopback restrictions.
7. From the VPS, verify the loopback health route without exposing a port: `curl --fail --header 'Host: scan.cyang.io' http://127.0.0.1:8089/healthz`.
8. In the existing Caddy `scan.cyang.io` site, route only the `POST /v1/scan` handler to `127.0.0.1:8089`. Preserve every other handler and upstream, validate the Caddyfile before reload, and do not add a public VPS firewall port.

The service logs only the safe event name and coarse outcome. It does not log client IDs, signatures, nonces, hashes, filenames, file bytes, or ClamAV signatures.

## Application configuration and acceptance

Store the same generated values as Sensitive, Production-only Vercel variables:

- `LOCAL801_MALWARE_SCANNER_CLIENT_ID=local801-production`
- `LOCAL801_MALWARE_SCANNER_HMAC_SECRET_HEX=<64 lowercase hex characters>`
- `LOCAL801_MALWARE_SCANNER_URL=https://scan.cyang.io`
- `LOCAL801_MALWARE_SCANNER_ENABLED=1`

For Preview, use `LOCAL801_MALWARE_SCANNER_CLIENT_ID=local801-preview` and the distinct Preview key as `LOCAL801_MALWARE_SCANNER_HMAC_SECRET_HEX`. Keep the URL and enabled flag unchanged. Preview durable imports remain restricted to strict synthetic identities; never copy the Production HMAC key into Preview.

Redeploy only after the VPS health check passes. From a trusted owner workstation, put those four values into process-scoped variables, set `LOCAL801_SCANNER_ACCEPTANCE_CONFIRM=SEND_STANDARD_ANTIMALWARE_TEST_PAYLOADS` and `LOCAL801_SCANNER_ACCEPTANCE_EXPECT=clean-infected`, then run `npm run scanner:acceptance`. Acceptance requires `scannerAcceptance`, `cleanPath`, and `infectedPath` all `ok`.

For the reversible unavailable-path exercise while launch and real data remain locked, stop the adapter, set `LOCAL801_SCANNER_ACCEPTANCE_EXPECT=unavailable`, and rerun the command. It must return `scannerAcceptance: ok` and `unavailablePath: ok`. Restart the adapter immediately, restore `clean-infected`, and require the clean/infected acceptance to pass again. Clear all process-scoped secrets after testing.

The standard antimalware test payload is not malware and is constructed only in memory by the acceptance command. No acceptance payload is stored in the database or R2.
