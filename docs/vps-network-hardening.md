# VPS network hardening

## Verified checkpoint — October 23, 2026, 18:18 UTC

The requested two-server network configuration is active. The operator confirmed
the dedicated Hetzner firewall is attached and the monitor-only Hostinger
firewall is active (Drop TCP 22 plus its default Drop Any rule, no Accept rules).
These control-plane settings were operator-confirmed; the agent has no provider
API credentials. The out-of-scope Hostinger POC VPS was not changed.

Fresh, non-multiplexed Tailscale SSH works to both servers. Both connectors have
four ready connections, both rollback timers are inactive, and UFW/Docker/
Tailscale/their connector units are enabled. New outbound HTTPS over IPv4 and
IPv6 returned 200 from both hosts. External direct TCP 22/80/443 timed out on
both hosts' public IPv4 and IPv6 addresses. This was a targeted TCP check, not a
full port/UDP scan. No reboot or post-firewall connector restart was performed.

Public Cloudflare readiness, WebFinger and the signed COSE binding returned
200/DYNAMIC without challenges. Enrollment from the provider reached its 401
token gate; the operator's earlier actual-container probe after host contraction
returned 401 without token / 400 with token. The apex monitor domain intentionally
returns 403/DYNAMIC. Monitor/database/heartbeat remain healthy. Operator passkey
login through the Haili tunnel was previously confirmed. Public enrollment remains
publicly routed, but its Haili-specific admission limitations are intentionally
unchanged and belong to a later task. The abandoned private-only enrollment
Serve/grant path has been removed.

Maintenance handoff:

- Release adoption is the follow-up action. The protected provider checkout
  intentionally has modified `apps/server/deploy/public/Caddyfile` and
  `compose.yaml`; its normal deploy wrapper requires a clean checkout. Adopt the
  reviewed ingress changes into a release and reconcile that checkout **before
  its next guarded deploy**. Do not discard/reset the live changes to bypass the
  guard. The monitor checkout is clean; its live ingress config is in `/etc`.
- The shared public provider profile is now tunnel-only. Do not apply its new
  ingress files to the unmigrated POC VPS without a separate transition plan.
- The monitor database image is labeled `postgres:14.4-alpine`, conflicting with
  earlier 14.24 upgrade records. Verify the running SQL/binary version before
  deciding whether to upgrade: a retagged image can have a stale label. PostgreSQL
  14 approaches end of support in November 2026. No database image/schema/key
  changes occurred during network hardening.
- Existing rollback/config backups and old Caddy certificate volumes were kept.
  Connector credentials remain root-only; existing monitor backup coverage does
  not include the new token/unit, which can be recreated through Cloudflare.

## Target and current stage

- Administration: ordinary key-based `hailops` SSH over Tailscale, not Tailscale SSH.
- Haili public HTTP: Cloudflare Tunnel to a loopback-only Caddy listener.
- Provider-to-monitor enrollment: retain public `enroll.plcmonitor.us` through a
  monitor-side Cloudflare Tunnel, with existing authentication/restrictions.
- Final state: no unsolicited public inbound traffic, IPv4 or IPv6, on either VPS.
- Retain the monitor identity, signing keys, databases, mail routing, Worker and backups.

Hosting scope: Haili provider at Hetzner; independent monitor at Hostinger. The
operator also has a separate Hostinger POC VPS hosting `hailproto.dev` and
`hailproto.app`; it is not part of this two-server hardening pass.

October 23, 2026: laptop `100.111.12.28` can SSH to tagged provider
`100.89.223.70` and monitor `100.102.184.47`. Tailscale TCP 80/443 timed out
from the laptop. The initial policy granted only laptop-to-server TCP 22. Public
ingress was initially unchanged. The operator created the `haili-provider` Cloudflare tunnel.

Provider preparation was applied through the root console. After the operator
corrected a truncated token, read-only verification at 14:09 UTC confirmed the
service running, connector `/ready` reporting four ready connections, loopback
8080 readiness passing and public readiness still using direct Caddy. The restart
count remained 140 across checks (historical failures before the token correction).
At that check DNS cutover was pending. Sections 1–3 below are the recorded apply
procedure, not instructions to reapply over the now-modified baseline.

The operator subsequently published `haili.app` to HTTP `127.0.0.1:8080` and
replaced apex DNS with the proxied tunnel CNAME. At 14:22 UTC, DNS returned
Cloudflare IPv4/IPv6 addresses; public readiness and login returned 200, HTTP
redirected to HTTPS, and responses reported `CF-Cache-Status: DYNAMIC`. The
connector retained four connections and zero request errors; its request counter
increased during external checks. Direct-origin readiness still returned 200,
intentionally preserving rollback.

Discovery initially failed with `User-Agent: Python-urllib/3.14`: Cloudflare
returned 403 / error 1010 while the direct origin returned 200. Cloudflare
documents 1010 as browser-signature blocking. The operator deployed a configuration
rule disabling Browser Integrity Check only for host `haili.app` and the exact
paths `/api`, `/hail`, `/.well-known`, `/health` or their slash-delimited subpaths,
matching the application's API/browser boundary. Initially its setting was On;
after correction to Off, Python-client readiness, WebFinger and the 350-byte COSE
binding all returned 200 / DYNAMIC. The normal login page also returned 200.
The operator confirmed zone-wide BIC On. After briefly enabling Bot Fight Mode,
the operator disabled it: Free-plan Bot Fight Mode cannot be bypassed by endpoint
exception rules and can challenge legitimate federation clients. Subsequent
checks returned 200 / DYNAMIC for Python-client readiness, WebFinger and the COSE
binding, but 403 / 1010 for Python-client `/auth/login`; normal curl login returned
200. This confirms the browser gate remains active outside the API exception.
Keep managed WAF/DDoS protection enabled. The operator subsequently confirmed
successful interactive passkey login to `j4@haili.app` through the tunnel.

**Corrected boundary:** enrollment is intended for independent providers, not a
permanently internal Haili service. Do not move its canonical API address into
Tailscale. Use Tailscale for administration and Cloudflare Tunnel for public
enrollment. Multi-provider admission/authentication changes are a separate task;
preserve current source-IP, token, method, path and provider restrictions here.
Do not close public ports until the public monitor tunnel has been verified.

The operator added provider-tag to monitor-tag TCP 443 and enabled Tailscale Serve
on the monitor. At 16:05 UTC, Serve reported tailnet-only HTTPS at
`https://haili-monitor.tail24a2ed.ts.net`, proxying to `http://127.0.0.1:3001`.
An empty unauthenticated POST from the provider host verified DNS, trusted TLS
and the grant, returning the expected 401. The monitor and heartbeat timer remain
healthy. The provider's container path and authenticated request still require
the console preflight. This private-path plan was subsequently superseded. The
operator then confirmed both the saved and running provider API origin are public
`https://enroll.plcmonitor.us`, so no provider rollback is needed. The temporary
Serve listener and provider-to-monitor TCP 443 grant can be removed.

Corrective read-only checks at 16:19 UTC confirmed public enrollment still accepts
the provider host's unauthenticated empty POST up to its token gate (401), and
provider/monitor containers remain healthy. The provider container was not
recreated during the proposed private cutover, and the operator subsequently
confirmed the saved root-only `.env` also retains the public API origin.
A monitor-side loopback Cloudflare listener
and connector service are prepared, not installed: existing direct
ingress and application restrictions remain intact. Local Caddy integration
checks verify the new listener retains hostname, method, path and source-IP
restrictions using trusted `CF-Connecting-IP` only on loopback. Its source list
includes the same provider's public IPv4 and IPv6 addresses because Cloudflare
can receive either; multi-provider admission remains deliberately unchanged.
The operator created the `haili-monitor` tunnel and applied its connector/origin
configuration. At 16:44 UTC it had four ready connections and zero restarts;
8080 was loopback-only, local authorized-source enrollment reached the token gate
(401), and the existing public enrollment path still returned 401 from the
provider. Tailscale Serve is off and provider-to-monitor Tailscale TCP 443 timed
out, consistent with grant cleanup. Monitor/database/heartbeat remain healthy.
The operator then attempted public enrollment DNS cutover. At 16:55 UTC the
connector's runtime config showed hostname `plcmonitor.us` rather than
`enroll.plcmonitor.us`, causing catch-all 404; its local origin still passes the
source checks. Python-client enrollment also gets Cloudflare error 1010. Correct
the published hostname and BIC exception before authenticated container checks
or firewall contraction. The operator corrected both settings; at 17:01 UTC,
provider-host Python enrollment reached the token gate (401 / DYNAMIC), laptop
requests got the expected source-policy 403 rather than browser-signature error,
and the connector retained four ready connections. The operator then ran the
staged provider-container probe and confirmed unauthenticated 401/authenticated
invalid-payload 400. This verifies the public tunnel path with the actual
application's DNS, routing, TLS and retained service token. Apply records,
connectivity checks, private-path cleanup and rollback are in
[Monitor tunnel hardening](monitor-tunnel-hardening.md).

The temporary direct and tunnel Caddy listeners use separate trust boundaries:
public HTTPS ignores supplied client-IP headers; the loopback tunnel listener
overwrites `X-Hail-Trusted-Client-IP` using Cloudflare's `CF-Connecting-IP`.
The application continues validating that value as an IP address. Never publish
8080 publicly, and do not enable Cloudflare's Remove visitor IP headers transform.
Keep Pseudo IPv4 disabled to retain actual IPv6 client addresses.

## 1. Install the connector on the provider

Use the **provider root console**, not the monitor and not the laptop. Restricted
`hailops` sudo intentionally cannot perform these changes. Keep existing SSH open.
These commands use Cloudflare's stable, signed APT repository; they do not update
the application or database.

```bash
set -e
install -d -m 0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  -o /usr/share/keyrings/cloudflare-main.gpg
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
  > /etc/apt/sources.list.d/cloudflared.list
apt-get update
apt-get install -y cloudflared
test ! -e /etc/cloudflared/haili-provider.token
install -d -m 0700 /etc/cloudflared
install -m 0600 /dev/null /etc/cloudflared/haili-provider.token
```

Open `nano /etc/cloudflared/haili-provider.token`. Paste **only the tunnel token**
from Cloudflare's connector installation command, save and exit. Do not paste the
whole command, run the dashboard's service installer, share the token in chat,
put it in shell arguments/history or add it to the repository. If the token file
already existed, stop and inspect the existing setup instead of overwriting it.

The custom systemd unit uses `LoadCredential` and an unprivileged dynamic user.
The token is not stored in the unit, process arguments or the Compose environment.

## 2. Apply the prepared origin listener and service

The currently staged directory is `/home/hailops/haili-tunnel-stage.JisL4Q`.
Its files are non-secret but must be installed as root-owned configuration.
The source checkout was clean and both deployed configuration hashes matched the
local baseline before preparation. Review the staged files before applying them.

Run in the **same provider root console**, after saving the token:

```bash
set -e
stage=/home/hailops/haili-tunnel-stage.JisL4Q
deploy=/opt/hailproto/apps/server/deploy/public
cd "$stage"
sha256sum --check SHA256SUMS
test -s /etc/cloudflared/haili-provider.token
test ! -e /etc/systemd/system/haili-tunnel.service
test ! -e /etc/systemd/system/cloudflared.service
cd "$deploy"
# Stop if either configuration changed since the read-only inventory.
echo '83637cf405bbf6c6dab7d7fb0c9d70284851c9575749e7d2826fea47d168528a  Caddyfile' | sha256sum --check
echo '1641c6a8fd209c5fa6fe413f404c6eece43fd64496f447063c73411de06d7199  compose.yaml' | sha256sum --check
backup=$(mktemp -d /var/lib/haili-tunnel-before.XXXXXX)
cp -p Caddyfile compose.yaml "$backup/"
printf 'Rollback directory: %s\n' "$backup"
install -o root -g root -m 0644 "$stage/Caddyfile" Caddyfile
install -o root -g root -m 0644 "$stage/compose.yaml" compose.yaml
docker compose --env-file .env config --quiet
docker compose --env-file .env up -d --no-deps caddy
install -o root -g root -m 0644 "$stage/haili-tunnel.service" /etc/systemd/system/haili-tunnel.service
systemctl daemon-reload
systemctl enable --now haili-tunnel.service
```

This recreates **only Caddy**, keeping its existing certificate volumes and
public listeners. It may interrupt an existing web connection briefly. No
provider/GUI/database container is recreated. Record the rollback directory.
Changes to tracked configuration are intentional; reconcile them into a reviewed
release before the next normal deploy, whose wrapper requires a clean checkout.

## 3. Verify and stop

```bash
systemctl is-active haili-tunnel.service
curl --fail --silent --show-error http://127.0.0.1:8080/health/ready \
  -H 'Host: haili.app' -H 'CF-Connecting-IP: 192.0.2.10' \
  -H 'X-Forwarded-Proto: https'
curl --fail --silent --show-error https://haili.app/health/ready
ss -lnt 'sport = :8080'
```

Expect service `active`, both readiness checks `status: ok`, and host port 8080
listening **only on 127.0.0.1**. Cloudflare should report the connector healthy.
The synthetic client-IP header above is only a local listener check; it does not
prove Cloudflare's end-to-end handling. Stop here and report completion.

## Rollback before DNS cutover

Use the recorded backup path, not a guessed directory. No DNS change is needed at
this stage. Restore configuration only; never run `docker compose down -v`.

```bash
set -e
backup=/var/lib/haili-tunnel-before.REPLACE_WITH_RECORDED_SUFFIX
test -f "$backup/Caddyfile"
test -f "$backup/compose.yaml"
if systemctl cat haili-tunnel.service >/dev/null 2>&1; then
  systemctl disable --now haili-tunnel.service
fi
cd /opt/hailproto/apps/server/deploy/public
cp -p "$backup/Caddyfile" Caddyfile
cp -p "$backup/compose.yaml" compose.yaml
docker compose --env-file .env config --quiet
docker compose --env-file .env up -d --no-deps caddy
curl --fail --silent --show-error https://haili.app/health/ready
```

Keep the disabled service and protected credential for investigation. Rotate the
tunnel token in Cloudflare if it was exposed. Updating the APT package and
restarting `haili-tunnel.service` is the connector update path; third-party APT
origins are not necessarily covered by default unattended-upgrade settings.

## Later gates (not performed by the commands above)

1. Publish `haili.app` through this tunnel to **HTTP `127.0.0.1:8080`**. Preserve
   host `haili.app`; no TLS-verification bypass is needed on this loopback hop.
   Replace both the apex A and AAAA records with the tunnel's proxied CNAME.
2. Enforce public HTTPS; bypass caching for dynamic application traffic. Do not
   put browser challenges or interactive Cloudflare Access in front of federation
   APIs. Verify readiness, passkey login, signed federation and client-IP handling
   through Cloudflare before disabling the old path. Record a DNS rollback.
3. Put public `enroll.plcmonitor.us` behind a separate monitor-side Cloudflare
   Tunnel. Keep the provider API URL public and preserve current admission
   restrictions. Trust Cloudflare's client-IP header only on a loopback origin
   listener; account for the provider's public IPv4 and IPv6 addresses. Defer
   multi-provider enrollment configuration to its own task.
4. Remove direct HTTP/HTTPS bindings and obsolete enrollment exposure only after
   their replacements pass. The apex `plcmonitor.us` currently returns Cloudflare
   525; do not silently treat it as a working site or delete its identity.
5. Verify provider recovery consoles, then restrict host and provider firewalls
   for IPv4 and IPv6. Account for Docker forwarding and Tailscale interface rules;
   preserve outbound connections and established/related return traffic. Confirm
   the actual VPS firewall product's deny semantics, rather than assuming that
   an empty rule set blocks traffic. Test from outside the tailnet.

Local regression check (Linux with Docker and `caddy:2.10.2-alpine`):

```bash
python3 apps/server/deploy/public/check-tunnel.py
```

It exercises the actual Caddy routing with an echo upstream: tunnel IPv4/IPv6,
overwriting forged trusted-client headers, absent-header/wrong-host rejection,
HTTP-to-HTTPS redirect, absence of public provider bindings, and the monitor's
loopback-only listener and preserved admission restrictions.

## Superseded private monitor API plan — do not apply

The private-only enrollment plan was abandoned before changing the provider's
saved or running API URL. Both remain `https://enroll.plcmonitor.us`. Its temporary
Tailscale Serve listener and provider-to-monitor TCP 443 grant were removed.
The unused migration helper and tests were removed during pre-commit review;
`configure-signup-monitor.py` retains its original bootstrap-only contract and
sudo restrictions. Historical files under
`/home/hailops/haili-monitor-origin-stage.VzKfF7` are superseded, not current apply
instructions. Preserve logical monitor origins, signing keys, tokens, database
and signed evidence. Multi-provider admission remains a separate task.

## Firewall discovery (next console action)

The enrollment transport and operator passkey checks have passed. Before
contracting public ingress, run the prepared **audit only** from each VPS root
console. No firewall/network changes occur; it writes a root-owned report under
`/var/lib/hail-fw-audit.XXXXXX/report.txt`, readable by group `hailops`, so the
agent can retrieve it without extra sudo privileges. It reads firewall rules,
network interfaces/routes/listeners, Docker published ports and selected Docker
network flags, not application environment files or credential files.

Hetzner provider:

```bash
sh /home/hailops/fw.DAcKnO/run.sh
```

Hostinger monitor:

```bash
sh /home/hailops/fw.t0nkcp/run.sh
```

These are staged copies of `apps/server/deploy/public/audit-vps-firewall.sh`.
Report completion; there is no need to paste the report contents. Preserve
existing SSH sessions and provider-console access. Do not apply a provider
firewall or remove host rules yet.

Provider firewall references checked during preparation:

- [Hetzner Cloud firewall FAQ](https://docs.hetzner.com/cloud/firewalls/faq/):
  stateful; no inbound rules denies new inbound traffic, no outbound rules permits
  outbound traffic; rules from multiple attached firewalls are combined. Verify
  all attached rules, not just the new firewall. DHCP/NDP exceptions are documented.
- [Hostinger managed VPS firewall](https://www.hostinger.com/support/8172641-how-to-use-a-managed-vps-firewall-at-hostinger/):
  supports IPv4/IPv6 and preserves established connections. Documentation says at
  least one rule is needed to activate a group, while an applied empty ruleset
  blocks traffic; confirm actual hPanel behavior rather than guessing. Groups
  can be shared across servers: never modify a group used by the out-of-scope
  POC VPS. Hostinger says propagation may take up to two minutes.

Do not assume UFW alone blocks Docker-published ports or Tailscale's own netfilter
accept rules. The audit must establish actual chain ordering/backend before
choosing a host firewall change. Keep outbound and established return traffic
working. The remaining direct apex `plcmonitor.us` DNS/origin route also needs
review before closing the monitor's public web ports; retain its signed identity.

### Audit results and provider-only contraction

Reports retrieved after the operator ran both audits:

- Provider: `/var/lib/hail-fw-audit.zDfXxR/report.txt` (17:19 UTC).
- Monitor: `/var/lib/hail-fw-audit.vIA2Og/report.txt` (17:20 UTC).

Both use active/enabled UFW, IPv6 enabled, deny incoming/routed and allow outgoing.
Both use Docker 29.1.3 and iptables-nft; the separate nftables service is disabled.
The provider globally allows SSH, TCP 80/443 and UDP 443, publishing its Caddy web
ports through Docker. The monitor allows SSH and TCP 80/443, with a host-network
Caddy edge and loopback-only API 3001. Both INPUT chains jump to Tailscale before
UFW; its UDP 41641 accept remains effective regardless of UFW user rules. Both
FORWARD chains reach Docker before UFW, so simply deleting UFW web allowances
would not block the provider's Docker-published ports.

The monitor has public IPv6 `2a02:4780:75:ef42::1`, despite having no enrollment
AAAA record. Both address families must be covered. Its actual PostgreSQL image
is labeled `postgres:14.4-alpine`, despite earlier upgrade records: inspect the
actual running version before scheduling a backed-up patch rollout. Do not
silently upgrade it during ingress changes.

**Next active change is the Hetzner provider only.** The prepared source removes
its legacy public Caddy site and Docker 80/443 bindings, retaining only loopback
8080. It adds an explicit UFW Tailscale-interface TCP 22 rule and removes the four
global OpenSSH/web allowances in both families. It does not disable Tailscale
netfilter or change UFW defaults, necessary DHCP/ICMPv6 handling, outbound access,
Docker networks, app image, secrets, database, monitor or provider-panel rules.
Existing Caddy data/config volumes are retained for rollback, not deleted.

The console script checks the known deployed Caddy/Compose hashes, actual tunnel
readiness, authenticated container enrollment and the candidate configs first.
It saves root-only copies of Caddy/Compose and UFW `user.rules`/`user6.rules`, and
arms a **15-minute configuration-only automatic rollback before any change**.
It recreates only Caddy, updates UFW, reruns readiness/enrollment checks and writes
a new firewall audit readable through `hailops`. No app/db/schema upgrade occurs.

In the **Hetzner provider root console**:

```bash
sh /home/hailops/close.aO2ZYk/run.sh
```

Keep the console open and report completion promptly. Do not perform concurrent
configuration/deployment changes during the rollback window. Do not change panel
firewalls or stop the rollback timer yet. If anything fails, the script stops and
the armed rollback restores the previous configuration after 15 minutes; the
printed root-only `rollback.sh` can also be run immediately from the console.

After fresh, non-multiplexed Tailscale SSH, public HTTPS/API checks and IPv4/IPv6
direct-port checks pass, stop the timer in that **same provider root console**:

```bash
systemctl stop hail-provider-ingress-rollback.timer
```

If the window expires before confirmation, inspect the actual state before
retrying. This stage does **not** yet deny all unsolicited public traffic: UFW's
normal control-traffic rules and Tailscale's UDP accept remain. Provider-panel
deny-new-inbound rules are a later layer, applied only after host changes pass.
The monitor has not been contracted yet; review its apex origin route first.

The operator applied the provider contraction. At 17:36 UTC, a fresh SSH
connection (`ControlMaster=no`, `ControlPath=none`) to `100.89.223.70` succeeded;
Cloudflare readiness and normal login returned 200. Direct TCP 22/80/443 to both
`5.161.254.78` and `2a01:4ff:f0:a15f::1` timed out. Four tunnel connections remained
ready; host web listeners were gone and only loopback 8080 was published.
Post-apply audit `/var/lib/hail-fw-audit.d6vBkE/report.txt` shows only Tailscale-
interface TCP 22 UFW allowances in both families. Its creation follows successful
post-apply container enrollment checks in the script. The rollback timer was
still active/waiting at verification; operator cancellation is required next.
The operator stopped it; a fresh SSH check at 17:38 UTC confirmed the transient
timer is not found/inactive and the provider tunnel still has four connections.
Provider host contraction is confirmed. The monitor remains unchanged and healthy.
The remaining apex `https://plcmonitor.us` still returns 525 through its proxied
direct-origin A record. Before closing monitor web ports, add a separate apex
tunnel route to HTTP `127.0.0.1:8080` with Host Header `plcmonitor.us`, and replace
its apex A with the monitor tunnel's proxied CNAME. Keep the enrollment route
unchanged. The default-deny origin should return 403 for this non-API hostname;
no new landing page or admission feature is introduced and its logical identity
remains `https://plcmonitor.us`. Worker/mail records stay unchanged.
The operator completed this apex cutover; at 17:44 UTC the apex returned 403 and
provider enrollment still returned 401 through Cloudflare, with both routes
confirmed in the connector config. The monitor's prepared loopback-only host
contraction and its independent rollback timer are documented in
[Monitor host contraction](monitor-tunnel-hardening.md#monitor-host-contraction-next-console-action).
The operator applied that contraction and confirmed the repeated provider auth
probe. At 18:02 UTC fresh private SSH worked, direct monitor TCP 22/80/443 timed
out over both families, public enrollment retained 401 and apex retained 403,
with healthy monitor/database/heartbeat and four tunnel connections. The monitor
rollback timer remains armed pending operator confirmation; neither provider
panel firewall has been changed in this session yet.
The operator stopped the monitor rollback timer; fresh SSH confirmed it is
not found/inactive with four ready tunnel connections. Both host contractions
are confirmed; provider-panel ingress denial remains pending. The Cloudflare
apex-CNAME notice is informational: flattening is expected and no A/AAAA fallback
should be added. Next inspect Hetzner's attached firewall rules before changing
them; if none exist, a new firewall with no inbound/outbound rules denies new
inbound while retaining outbound/return traffic. Do not change Hostinger yet or
modify any unfamiliar existing firewall/group without reviewing its rules.
The operator reported no existing Hetzner firewall, created
`haili-private-ingress`, and removed the default inbound SSH/ICMP allowances.
At 18:10 UTC fresh private SSH still worked, the provider tunnel had four ready
connections, public readiness returned 200 and provider enrollment reached 401;
direct IPv4/IPv6 TCP 22/80/443 still timed out. Confirm the new firewall is
actually attached/applied to this server and has no outbound rules: these tests
alone cannot prove cloud-firewall attachment because the host already blocks
those TCP ports. Hostinger's current group/rules must be inspected next, avoiding
any group shared with the out-of-scope POC VPS.
The operator confirmed the Hetzner firewall is applied to the sole Hetzner VPS.
The operator reported no Hostinger monitor firewall rules. Next create a new,
monitor-only `monitor-private-ingress` group, with one explicit Drop TCP 22 from
Anywhere rule (cover both families where the UI separates them), no Accept
rules, and activate it only on the monitor. Hostinger's documented implicit-drop
default covers all other new inbound traffic; the explicit Drop rule satisfies
its at-least-one-rule activation requirement. Preserve established/outbound
traffic. Allow up to two minutes for propagation, then test before proceeding.
If connectivity fails, deactivate only this new group through hPanel; do not
reset SSH/UFW or modify POC/shared groups.

## Release adoption and database follow-ups

Pre-commit review removed the unused private-origin migration CLI/tests. The
provider bootstrap configuration helper and its sudo contract are unchanged.
The final provider Caddy/Compose files match the deployed bytes exactly. The
provider checkout is at `903af3e`; the local pre-hardening head `33f21be` adds only
two documentation commits beyond that base. No application runtime source update
or rebuild is needed to reconcile the reviewed ingress release.

The prepared, console-only adoption uses a local Git bundle of the reviewed
commit, avoiding server credential changes. It requires that exact old HEAD,
exactly the two known unstaged ingress edits, no index/untracked work, and that
both live files already equal their committed target bytes. It saves root-only
copies and the current diff, then uses Git's merge-preserving detached checkout.
It refuses unrelated changes; it does not reset/discard work, restart services,
or touch the provider environment, data, firewall or POC VPS. The commit is pinned
in the staged launcher/manifest; don't substitute a moving branch name.

After the reviewed bundle has been staged, in the provider root console:

```bash
sh /home/hailops/adopt.7VDXJY/run.sh
```

Expect a clean checkout, unchanged live ingress bytes, and no service restarts.
The agent should verify the resulting HEAD, clean status and public readiness.

Separately, run the **read-only database audit** in the monitor root console:

```bash
sh /home/hailops/db.vHhtQ9/run.sh
```

It records the running PostgreSQL SQL version and binary version, immutable-image
binary version/digests, and configured Compose image, without printing credentials
or application data. SQL runs with read-only transactions. The image probe uses
a disposable, network-isolated container with no live volume attached; no active
container or database is restarted. Its root-owned, `hailops`-readable report is
under `/var/lib/hail-db-audit.XXXXXX/report.txt`.

Do not change the engine until this resolves the conflicting 14.4 image label
versus the earlier 14.24 rollout record. If the engine is old, prepare encrypted
backup, disposable restore/preservation proof, a minor-only target and rollback
before any live change. If the engine is already updated, correct/pin the stale
image reference instead of claiming or performing an unnecessary engine upgrade.

### Follow-up results and next gate

Reviewed ingress commit `07b4decf0ada2ce0b11a6ec3682cdb915176cdb0` was pushed to
`origin/main` with operator approval. The provider adopted that exact commit;
its live Caddy/Compose hashes remain `04eec931...` / `2d59e2bd...`, matching the
reviewed source, and public readiness/tunnel health remain good. No services
were restarted for adoption.

Adoption exposed a permission side effect: the backup process's umask 077 also
affected Git's index refresh and fetched pack metadata, preventing `hailops`
read-only Git inspection. The one-time adopter now gives Git subprocesses umask
022 while keeping the Python preservation backup private. The Git regression
check was extended to fetch a new pack under restrictive umask and check readable
index/pack modes, alongside unchanged ingress/env and unrelated-work refusal.
Repair only the introduced index and pack files, preserving root ownership and
adding no group/other write permissions, in the provider root console:

```bash
sh /home/hailops/fix.ef0160/run.sh
```

Monitor audit `/var/lib/hail-db-audit.POb0XU/report.txt` (19:21 UTC) confirms SQL
`server_version_num=140004`, running binary 14.4 and immutable image binary 14.4.
The merged legacy deployment also specifies 14.4. The earlier 14.24 record is not
the live state. The monorepo's newer base Compose already specifies 14.24 but is
not the monitor's authoritative legacy base/active override.

A fresh existing-wrapper encrypted backup was created without stopping services:

```text
Host: /var/lib/hail-monitor-enrollment/monitor-20261023T193834Z-39612a16.tar.gpg
Off-host temporary copy: /tmp/opencode/monitor-20261023T193834Z-39612a16.tar.gpg
SHA-256: 3919b8527cb025f35b7ced0ff1b72070cda63026c7dbd189745bc324f44ae049
```

The downloaded ciphertext hash matches. This is not yet restore proof or a
durable off-host retention policy. The local default GPG keyring has no secret
key for recovery recipient `870DECF2F98318BCDE17D4B8333035D2650B0400`. Confirm the
operator's off-host private recovery key/passphrase before the upgrade. Never
paste either into chat or copy the recovery private key to a VPS. Use it locally
to stream-decrypt only the dump into an isolated restore rehearsal; do not expose
the archive's credential/key members in tool output.

The planned minor target is 14.24, currently supported upstream, not a major
upgrade. The official multiarch image digest checked during preparation is
`postgres:14.24-alpine@sha256:50fce0c9c54c43d8b02ce16cb9daff75eb94c09c4ee3d41c157852ebd9700c80`.
Review the cumulative migration notes before applying: 14.10 recommends relevant
reindexing; 14.12 requires `fix-CVE-2024-4317.sql` in existing databases including
templates; 14.24 refers back to those changes and extension-specific caveats.
The vendor CVE repair file is present in the target image. No live database
image, volume, catalog, application schema, keys or data have been changed.

References: [14.24 release notes](https://www.postgresql.org/docs/release/14.24/),
[14.12 catalog repair](https://www.postgresql.org/docs/release/14.12/),
[version policy](https://www.postgresql.org/support/versioning/).

### Recovery handoff resolved; minor update prepared

The operator found the original recovery files in
`~/.local/share/hailproto/ops/`; no replacement key was generated. Fingerprint and
owner-only permissions match, and actual encrypted-backup restore tests passed.
The default GPG keyring's missing key did not mean the key was lost: the dedicated
`ops/backup-gnupg` home and exported private key were already present. R2
credentials were left untouched. The provider's narrow Git permission repair
was also verified: readable index/objects, clean checkout at `07b4dec`, unchanged
live ingress and no service restarts.

A fresh 22:17 UTC monitor recovery point was downloaded, checksum-verified and
retained in the established off-host ops backup directory. It too passed a real,
isolated restore and same-volume 14.4 → 14.24 → 14.4 rehearsal, including all
database/template catalog repairs and reindexing, with identical full-row hashes
for seven tables/36 rows. No live engine/data changes have occurred yet.
The guarded update, failure boundaries and console action are in
[Monitor PostgreSQL update](monitor-postgres-update.md).
The first attempt exited during preflight, with the old checkpoint aged past its
one-hour limit (7,011 seconds at inspection), no maintenance report and unchanged
14.4/monitor/edge/heartbeat uptime/health. A fresh October 24 00:19 UTC encrypted
snapshot was retained off-host, hash-verified and fully restore/upgrade/rollback
tested; the staged plan is refreshed without relaxing the guard. The launcher
now displays recent unit logs on failure so preflight reasons are not hidden
behind systemd's generic exit status. No live database upgrade has occurred yet.
