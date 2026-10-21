# Cloudflare email alert receiver

This Worker receives signed monitor alerts at
`https://alerts.plcmonitor.us/hail`, verifies the pinned monitor Ed25519 key and
signature, and sends them from `alerts@plcmonitor.us` to `the@j4w8n.com`.

Cloudflare Email Service must list `the@j4w8n.com` as a verified destination.
After generating the monitor key:

```bash
cd deploy/cloudflare-alert-worker
bunx wrangler login
printf '%s' 'did:key:z...' | bunx wrangler secret put MONITOR_PUBLIC_KEY
bunx wrangler deploy
```

Use `https://alerts.plcmonitor.us/hail` as the monitor enrollment webhook. The
Worker sends no email and returns a non-2xx status unless the raw request has a
valid `hail.plc-monitor-alert.v1` signature from the pinned key. Cloudflare may
deliver duplicate email if sending succeeds but its HTTP response is lost; the
alert UUID is included for recognition.
