#!/bin/sh
set -eu
[ "$(docker inspect hail-public-monitor-monitor-1 --format '{{.State.Health.Status}}')" = healthy ]
. /etc/hail-monitor-heartbeat
curl --fail --silent --show-error --max-time 15 -X POST \
  -H "Authorization: Bearer $HEARTBEAT_TOKEN" https://alerts.plcmonitor.us/heartbeat
