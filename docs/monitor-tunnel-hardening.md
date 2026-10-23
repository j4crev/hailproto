# Monitor Cloudflare Tunnel: connector preparation

**Current checkpoint:** both host contraction and the operator-activated,
monitor-only Hostinger firewall passed targeted checks at 18:18 UTC. Fresh private
SSH and new outbound IPv4/IPv6 HTTPS work, direct public TCP 22/80/443 is blocked
on both families, four tunnel connections remain ready, enrollment is preserved,
and monitor/database/heartbeat are healthy. Both rollback timers are inactive.
No reboot or complete UDP scan was performed. See the consolidated checkpoint
and maintenance handoff in [VPS network hardening](vps-network-hardening.md).
The apply sections below are historical records, not instructions to rerun.

## Current state

The operator applied sections 1–3. At 16:44 UTC on October 23, 2026, read-only
checks confirmed the connector active with four ready connections and zero
restarts, origin 8080 bound only to 127.0.0.1, expected local unauthenticated 401,
and healthy monitor/database/heartbeat supervision. Tailscale Serve has no config;
provider-to-monitor Tailscale TCP 443 timed out, consistent with grant removal.
The provider still gets 401 through the unchanged direct public enrollment path.
The operator subsequently changed enrollment DNS. At 16:55 UTC, external requests
returned empty Cloudflare 404 instead of the expected provider 401. Inspection of
the connector's loopback `/config` endpoint confirmed its only hostname route is
`plcmonitor.us`, with HTTP Host Header `enroll.plcmonitor.us`, followed by catch-all
404: the published route is missing its `enroll` subdomain. Correct its hostname
to `enroll.plcmonitor.us` before proceeding. Python-client requests also receive
Cloudflare error 1010, so the enrollment BIC-Off exception needs confirmation.
Local origin checks still return 401 for the authorized provider source and 403
for an unauthorized source; the origin listener itself is healthy.
After the operator corrected the published hostname and added the BIC-Off action,
17:01 UTC checks confirmed the connector route now matches
`enroll.plcmonitor.us`, retains four ready connections, and serves provider-host
Python-client POSTs with 401 / DYNAMIC. The same request from the laptop gets
empty 403 / DYNAMIC from the preserved source policy, not Cloudflare error 1010.
The operator subsequently ran the staged provider-container check and confirmed
`Without token: 401` and `With token: 400`. Public tunnel routing, actual container
connectivity and retained service authentication have therefore passed their
pre-firewall checks. Direct ingress is still enabled pending firewall audit.
The installation sections below are historical apply steps;
do not reapply over the now-modified configuration or close public ports.

This preserves public `enroll.plcmonitor.us` and its current enrollment policy.
Independent-provider admission is a separate task. No provider API URL, token,
signing key, database, Worker, mail record or sudo privilege changes here.

**Run only on the monitor VPS (`2.25.206.150`), in its root provider console.**
Do not run the dashboard's service installer as well. Keep existing SSH open.
The `haili-monitor` tunnel must already exist in Cloudflare; do not publish its
hostname or change DNS/firewalls until the connector and origin pass checks.

The files are staged at `/home/hailops/hail-monitor-tunnel-stage.SrtkIC`.
Review them before installation. The Caddy config retains the existing public
HTTPS listener for rollback, adding HTTP **127.0.0.1:8080 only** for cloudflared.
Only that loopback listener trusts `CF-Connecting-IP`; it retains the existing
Haili provider-only access restriction, including the provider's public IPv6
address for requests that reach Cloudflare over IPv6. It still requires the
enrollment hostname, POST method, exact onboarding path and application token.
Other requests get 403. Do not interpret these existing restrictions as completed
multi-provider admission support.

## 1. Install cloudflared and save the monitor tunnel token

```bash
set -e
install -d -m 0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  -o /usr/share/keyrings/cloudflare-main.gpg
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
  > /etc/apt/sources.list.d/cloudflared.list
apt-get update
apt-get install -y cloudflared
test ! -e /etc/cloudflared/haili-monitor.token
install -d -m 0700 /etc/cloudflared
install -m 0600 /dev/null /etc/cloudflared/haili-monitor.token
```

Open `nano /etc/cloudflared/haili-monitor.token`. Paste **only the new monitor
tunnel's token**, not the provider tunnel token or the full command. Save and exit.
Keep the token on the VPS; never paste it into chat, shell arguments/history or
the repository. If the file already exists, stop and inspect rather than overwrite.

## 2. Add the origin listener and start the connector

```bash
set -e
stage=/home/hailops/hail-monitor-tunnel-stage.SrtkIC
sha256sum --check "$stage/SHA256SUMS"
test -s /etc/cloudflared/haili-monitor.token
test ! -e /etc/systemd/system/hail-monitor-tunnel.service
test ! -e /etc/systemd/system/cloudflared.service
# This must match the original live config. Stop on mismatch; do not bypass it.
echo '2507df1cfe718932072e987945e8f3347a90c28299364dd075302967161b33a8  /etc/hail-monitor-enrollment/Caddyfile' | sha256sum --check
docker run --rm --network none \
  --mount "type=bind,src=$stage/Caddyfile,dst=/etc/caddy/Caddyfile,readonly" \
  caddy:2.10.2-alpine caddy validate --config /etc/caddy/Caddyfile
backup=$(mktemp -d /var/lib/hail-monitor-tunnel-before.XXXXXX)
cp -p /etc/hail-monitor-enrollment/Caddyfile "$backup/Caddyfile"
tailscale serve status --json > "$backup/serve-before.json"
printf 'Rollback directory: %s\n' "$backup"
install -o root -g root -m 0600 "$stage/Caddyfile" /etc/hail-monitor-enrollment/Caddyfile
docker compose \
  --env-file /opt/hail/hail-plc-monitor-ts/deploy/public/.env \
  --env-file /etc/hail-monitor-enrollment/enrollment.env \
  -f /opt/hail/hail-plc-monitor-ts/deploy/public/compose.yaml \
  -f /etc/hail-monitor-enrollment/compose.override.json config --quiet
docker compose \
  --env-file /opt/hail/hail-plc-monitor-ts/deploy/public/.env \
  --env-file /etc/hail-monitor-enrollment/enrollment.env \
  -f /opt/hail/hail-plc-monitor-ts/deploy/public/compose.yaml \
  -f /etc/hail-monitor-enrollment/compose.override.json \
  up -d --no-deps --force-recreate enrollment-edge
install -o root -g root -m 0644 "$stage/hail-monitor-tunnel.service" /etc/systemd/system/hail-monitor-tunnel.service
systemctl daemon-reload
systemctl enable --now hail-monitor-tunnel.service
```

Record the rollback directory. This recreates **only the Caddy edge**, not the
monitor or database. Existing connections through Caddy may be interrupted
briefly. Force-recreation is intentional: the file bind mount must pick up the
new config inode. It preserves the existing TLS certificate volumes.

## 3. Verify the connection and origin, then stop

```bash
systemctl is-active hail-monitor-tunnel.service
# Check actual Cloudflare connectivity, not merely that the process started.
curl --fail --retry 12 --retry-delay 5 --retry-all-errors --max-time 10 \
  --silent --show-error http://127.0.0.1:20241/ready
curl --silent --show-error --max-time 10 --include \
  http://127.0.0.1:8080/api/v1/onboarding \
  -H 'Host: enroll.plcmonitor.us' -H 'CF-Connecting-IP: 5.161.254.78' \
  -H 'Content-Type: application/json' --data '{}'
ss -lnt 'sport = :8080'
sudo hail-monitor-ops status
```

Expect service `active`, at least one `readyConnections`, enrollment **401**
(`Unauthorized enrollment`, expected without a token), port 8080 bound only to
127.0.0.1, and healthy monitor/database/heartbeat supervision. The synthesized
header is a local test only; it does not prove end-to-end Cloudflare forwarding.
Cloudflare should show the connector healthy. A bad/truncated token must be fixed
before proceeding. No token contents are needed for troubleshooting.

The operator confirmed both the saved and running provider API URL are still
public `https://enroll.plcmonitor.us`; the abandoned private path is unused.
After successful checks, remove its monitor-side Serve listener:

```bash
tailscale serve --bg --https=443 off
tailscale serve status
```

Also remove **only** the provider-tag to monitor-tag TCP 443 Tailscale grant.
Retain the laptop-to-server TCP 22 grant. This does not affect the public
enrollment edge or SSH. Report completion and stop: **do not change DNS yet**.

## Rollback before DNS cutover

Use the exact rollback directory printed during installation. The public DNS and
original enrollment endpoint remain unchanged at this stage.

```bash
set -e
backup=/var/lib/hail-monitor-tunnel-before.REPLACE_WITH_RECORDED_SUFFIX
test -f "$backup/Caddyfile"
if systemctl cat hail-monitor-tunnel.service >/dev/null 2>&1; then
  systemctl disable --now hail-monitor-tunnel.service
fi
install -o root -g root -m 0600 "$backup/Caddyfile" /etc/hail-monitor-enrollment/Caddyfile
docker compose \
  --env-file /opt/hail/hail-plc-monitor-ts/deploy/public/.env \
  --env-file /etc/hail-monitor-enrollment/enrollment.env \
  -f /opt/hail/hail-plc-monitor-ts/deploy/public/compose.yaml \
  -f /etc/hail-monitor-enrollment/compose.override.json \
  up -d --no-deps --force-recreate enrollment-edge
sudo hail-monitor-ops status
```

Do not restore database/key backups, remove Docker volumes, or reset all Serve
configuration. Keep the disabled unit and protected credential for investigation.
Private Serve need not be restored because the provider uses public enrollment.
For connector recovery after host loss, reissue the tunnel token from the
Cloudflare account and reinstall this unit/origin configuration. The existing
monitor backup retains its database, signing key and enrollment config; do not
assume it also backs up the new `/etc/cloudflared` credential or systemd unit.

## Following stage (not performed above)

Publish enrollment through this tunnel to HTTP `127.0.0.1:8080`, preserving Host
`enroll.plcmonitor.us`; replace its DNS-only A with a proxied tunnel CNAME.
Bypass caching and browser-only bot checks for the enrollment API; leave managed
WAF and DDoS protection enabled. Keep Free-plan Bot Fight Mode off. Do not add an
interactive Access login requirement to a provider API. Test unauthenticated 401
and authenticated invalid-payload 400 from the actual provider container before
closing any public ports. Keep `alerts.plcmonitor.us` and all mail settings intact.
Review the apex `plcmonitor.us` origin route separately; it currently has no
working public page (525) but its logical monitor identity must not be changed.

For the enrollment cutover, in the `plcmonitor.us` Cloudflare zone:

1. Add a configuration rule matching host `enroll.plcmonitor.us` and exact path
   `/api/v1/onboarding`, explicitly setting **Browser Integrity Check Off**. Do
   not disable managed WAF/DDoS protection or change unrelated Worker settings.
2. Add a cache rule matching host `enroll.plcmonitor.us`, setting **Bypass cache**.
   Ensure Always Use HTTPS is On and Free-plan Bot Fight Mode is Off. Do not add
   interactive Access authentication to the API.
3. Add a published application route on the `haili-monitor` tunnel: hostname
   `enroll.plcmonitor.us`, path blank, service **HTTP** `127.0.0.1:8080`, HTTP Host
   Header `enroll.plcmonitor.us`.
4. Replace only the old `enroll` A record (`2.25.206.150`) with proxied CNAME
   `enroll` targeting `<monitor Tunnel UUID>.cfargotunnel.com`, TTL Auto. Use the
   Tunnel UUID, not the connector ID. If the route auto-creates the CNAME, verify
   it instead of adding a duplicate. Leave apex, Worker and mail records alone.
5. Report completion. Unauthenticated enrollment from the provider must return
   401; ordinary requests from the laptop still get 403 under the existing
   provider-only source policy. Verify the authenticated empty-payload 400 from
   the actual provider container before removing direct ingress.

DNS rollback before direct ingress is removed: restore `enroll` as DNS-only A
`2.25.206.150`, removing its tunnel CNAME. Keep both paths working until the
Cloudflare path passes authentication and source-restriction checks.

### Authenticated container check (provider root console)

This reads the running container's existing API address and token without
printing secrets or changing configuration. Empty payloads cannot enroll an
identity; they must reach authentication and then be rejected as invalid input.
TLS verification remains enabled and redirects are refused.

```bash
sh /home/hailops/check.9PthjJ/run.sh
```

This is the staged copy of
`apps/server/deploy/public/check-monitor-api.sh`, replacing the large inline
Docker/Bun command because the Hetzner console truncates pasted commands.

Expect `Without token: 401` and `With token: 400`. On failure, stop and diagnose
before firewall changes. The operator confirmed the monitor VPS is hosted at
Hostinger; inspect its actual host/panel firewall rules rather than assuming
empty-rule semantics. The separate Hostinger POC VPS is outside this pass.

## Monitor host contraction (next console action)

The operator added the separate apex `plcmonitor.us` tunnel route and replaced its
direct-origin DNS. At 17:44 UTC, its public response was the intended 403/DYNAMIC
instead of 525, while provider-host enrollment still returned 401/DYNAMIC. The
connector's runtime config shows both hostnames pointing at loopback 8080 with
their respective Host headers. The provider's earlier rollback is confirmed
inactive and its host contraction remains in place.

The monitor can now remove its legacy public Caddy site. The candidate config
listens only on `127.0.0.1:8080`, preserving the current enrollment source, host,
method, path and token restrictions. UFW gets an explicit Tailscale-interface
TCP 22 allowance; its global OpenSSH/TCP 80/TCP 443 allowances are removed in
both address families. Outbound, established traffic and control-traffic rules
are unchanged. Docker's Compose override, storage, images, keys, tokens and
application configuration are not changed. Only the Caddy edge is recreated;
monitor/database containers keep running.

The official Caddy binary has file capability `cap_net_bind_service=ep`. A local
runtime test confirmed that removing the matching capability prevents execution
even on port 8080. Keep the existing `NET_BIND_SERVICE` exception, read-only root
filesystem and no-new-privileges setting rather than introduce a custom image.

The staged script validates the known live Caddy hash, the new config, active UFW,
actual tunnel readiness and local origin. It backs up Caddy and UFW user rules
and arms a **15-minute automatic configuration rollback before any change**.
After changing only the edge and UFW, it checks local 401, token-authenticated
invalid-payload 400 from the monitor container, and writes a new firewall audit
readable through `hailops`. No valid enrollment or PLC write is performed.

Run in the **Hostinger monitor root console**:

```bash
sh /home/hailops/close.jmoV5j/run.sh
```

Keep the console open and report completion promptly. Do not change hosting
firewalls or stop the rollback timer until fresh private SSH, public tunnel
requests and direct IPv4/IPv6 port checks pass. Also repeat the actual provider
container's authenticated public-path probe in the **Hetzner provider root console**:

```bash
sh /home/hailops/check.9PthjJ/run.sh
```

Expect 401 without its token, 400 with it. The operator/agent should confirm these
results before stopping the monitor timer:

```bash
systemctl stop hail-monitor-ingress-rollback.timer
```

Run that confirmation only in the monitor root console after verification. On
failure, the script stops and its armed rollback restores only Caddy/UFW after
15 minutes; the printed root-only `rollback.sh` can also be run immediately.
No database/key rollback or Docker volume deletion is appropriate. If the timer
already fired, inspect actual state before retrying. Provider-panel firewalls
remain a later layer, needed to block new inbound transport including Tailscale
UDP 41641, which Tailscale accepts before UFW user rules.

The operator ran the monitor contraction and repeated the provider-container
check, confirming expected results. At 18:02 UTC, fresh non-multiplexed Tailscale
SSH succeeded; direct TCP 22/80/443 to both `2.25.206.150` and
`2a02:4780:75:ef42::1` timed out. The monitor retained four ready tunnel
connections, no public web listeners, and healthy monitor/database/heartbeat.
Provider-host Python enrollment returned 401/DYNAMIC; the apex retained its
intended 403/DYNAMIC. Audit `/var/lib/hail-fw-audit.MVupoT/report.txt` shows only
Tailscale-interface TCP 22 UFW allowances in both families. The monitor rollback
timer was still active/waiting; operator cancellation is the next action.
The operator stopped it; a fresh SSH check confirmed the transient timer is now
not found/inactive and four tunnel connections remain ready. Monitor host
contraction is confirmed. Both hosting-provider firewall layers remain pending.
