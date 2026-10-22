# Cloudflare email alert receiver

This Worker receives signed monitor alerts at
`https://alerts.plcmonitor.us/hail`, verifies the pinned monitor Ed25519 key and
signature, and sends them from `alerts@plcmonitor.us` to `the@j4w8n.com`. Its
minute cron also checks `haili.app` and alerts when authenticated monitor-host
heartbeats are more than six minutes old. Outage and recovery mail is sent only
when state changes.

Cloudflare Email Service must list `the@j4w8n.com` as a verified destination.
After generating the monitor key:

```bash
cd deploy/cloudflare-alert-worker
bunx wrangler login
printf '%s' 'did:key:z...' | bunx wrangler secret put MONITOR_PUBLIC_KEY
printf '%s' 'random secret' | bunx wrangler secret put HEARTBEAT_TOKEN
printf '%s' 'different random secret' | bunx wrangler secret put BACKUP_TOKEN
bunx wrangler deploy
```

Use `https://alerts.plcmonitor.us/hail` as the monitor enrollment webhook. The
Worker sends no email and returns a non-2xx status unless the raw request has a
valid `hail.plc-monitor-alert.v1` signature from the pinned key. Cloudflare may
deliver duplicate email if sending succeeds but its HTTP response is lost; the
alert UUID is included for recognition.

The monitor host posts an empty authenticated `POST /heartbeat` every three
minutes after checking that its monitor container is healthy. Keep the heartbeat
token outside the repository. Unchanged health states are not rewritten to KV;
only heartbeats and state transitions consume writes.

The provider backup job posts to `/backup-heartbeat` only after an encrypted R2
upload is downloaded and its digest matches. Missing backup heartbeats alert
after 26 hours.
