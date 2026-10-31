#!/usr/bin/env bash
# Starts Redis, applies migrations, then web, realtime, worker and the router. If any of them exits, the
# container exits too, so the host starts a fresh one.
set -euo pipefail
cd /app

# PUBLIC_HOST is the app's public host name (e.g. la-yee-2024--stage-ready.modal.run); the public URLs follow from
# it unless set explicitly. Hugging Face Spaces set SPACE_HOST, which works the same way.
host="${PUBLIC_HOST:-${SPACE_HOST:-}}"
if [ -n "$host" ]; then
  export AUTH_URL="${AUTH_URL:-https://$host}"
  export WEB_ORIGIN="${WEB_ORIGIN:-https://$host}"
  export REALTIME_URL="${REALTIME_URL:-wss://$host}"
fi

redis-server --port 6379 --bind 127.0.0.1 --save "" --appendonly no --dir /tmp &
redis_pid=$!
for _ in $(seq 1 50); do redis-cli -p 6379 ping >/dev/null 2>&1 && break; sleep 0.2; done
kill -0 "$redis_pid" 2>/dev/null && redis-cli -p 6379 ping >/dev/null || { echo "Redis did not start." >&2; exit 1; }

pnpm db:migrate

# Each service logs to the container output and to a file, so a crash at boot can be shown in one place.
logs=/tmp/stage-ready-logs
mkdir -p "$logs"
PORT=3000 pnpm --filter @stage-ready/web start > >(tee "$logs/web.log") 2>&1 &
web_pid=$!
REALTIME_PORT=4000 pnpm --filter @stage-ready/realtime start > >(tee "$logs/realtime.log") 2>&1 &
realtime_pid=$!
pnpm --filter @stage-ready/worker start > >(tee "$logs/worker.log") 2>&1 &
worker_pid=$!

# 200 from /api/health on a local port, with bash alone (the slim image has no curl).
healthy() {
  local status
  { exec 3<>"/dev/tcp/127.0.0.1/$1"; } 2>/dev/null || return 1
  printf 'GET /api/health HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n' >&3
  read -r -t 2 _ status _ <&3 || status=""
  exec 3>&- 3<&-
  [ "$status" = "200" ]
}

# Open the public port only once web and realtime answer, so a host that waits for the port (Modal) holds
# the first visitor's request instead of showing the "starting" page. If any service exits meanwhile (a
# ConfigError, a bad DATABASE_URL), stop at once with its last log lines instead of waiting out the deadline.
deadline=$((SECONDS + 120))
until healthy 3000 && healthy 4000; do
  for name in web realtime worker; do
    pid_var="${name}_pid"
    if ! kill -0 "${!pid_var}" 2>/dev/null; then
      echo "Stage Ready $name exited during startup. Its last 50 log lines:" >&2
      tail -n 50 "$logs/$name.log" >&2 || true
      exit 1
    fi
  done
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "web or realtime did not answer within 2 minutes; opening the port anyway" >&2
    break
  fi
  sleep 0.5
done
node deploy/container/router.mjs &

set +e
wait -n
code=$?
echo "A Stage Ready process exited (code $code); stopping so the host starts a fresh container." >&2
exit 1
