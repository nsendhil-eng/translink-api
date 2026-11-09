#!/usr/bin/env bash
# Gives the journey planner (OTP on the Oracle box) Translink's live delays and cancellations.
# Run from a Mac, once (safe to repeat):
#   ssh ubuntu@152.67.98.226 'bash -s' < scripts/setup-otp-realtime.sh
#
# Writes router-config.json beside the graph, makes the weekly rebuild carry it across, and
# restarts OTP (about a minute without plans). If OTP doesn't come back answering plans, the
# change is undone and OTP restarted as it was.
set -euo pipefail

OTP_DIR=/home/ubuntu/otp
LIVE=$OTP_DIR/graphs/seq
CONFIG=$LIVE/router-config.json
REBUILD=$OTP_DIR/rebuild.sh
FEED=https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates
PLAN='http://localhost:8080/otp/routers/default/plan?fromPlace=-27.4838,152.9937&toPlace=-27.4656,153.0194&mode=TRANSIT,WALK&numItineraries=5'

# grep -c, not -q: -q stops reading early, which pipefail would report as a failed curl
plan_ok() { [ "$(curl -sSf -m 20 "$PLAN" 2>/dev/null | grep -c '"itineraries":\[{' || true)" -gt 0 ]; }
wait_for_plans() {
  for _ in $(seq 1 60); do
    if plan_ok; then return 0; fi
    sleep 5
  done
  return 1
}

echo "Checking the live feed is reachable from here..."
curl -sSf -m 30 -o /dev/null "$FEED"

BACKUP_REBUILD=$(mktemp)
cp "$REBUILD" "$BACKUP_REBUILD"
HAD_CONFIG=0
BACKUP_CONFIG=$(mktemp)
if [ -f "$CONFIG" ]; then HAD_CONFIG=1; cp "$CONFIG" "$BACKUP_CONFIG"; fi

undo() {
  echo "Undoing: OTP did not come back with the new config."
  cp "$BACKUP_REBUILD" "$REBUILD"
  if [ "$HAD_CONFIG" = 1 ]; then cp "$BACKUP_CONFIG" "$CONFIG"; else rm -f "$CONFIG"; fi
  sudo systemctl restart otp
  wait_for_plans && echo "OTP is back as it was." || echo "OTP IS NOT ANSWERING: check journalctl -u otp"
  exit 1
}

# feedId "1": the prefix OTP gave this GTFS feed's trips ("1:39823013-QR ...")
cat > "$CONFIG" <<JSON
{
  "updaters": [
    {
      "type": "stop-time-updater",
      "frequency": "30s",
      "url": "$FEED",
      "feedId": "1"
    }
  ]
}
JSON

# The weekly rebuild builds in a new folder and swaps it in, copying only the files it names
if ! grep -q 'router-config.json' "$REBUILD"; then
  sed -i 's|^cp "$LIVE/otp-config.json" "$LIVE/build-config.json" "$STAGE/"$|cp "$LIVE/otp-config.json" "$LIVE/build-config.json" "$LIVE/router-config.json" "$STAGE/"|' "$REBUILD"
  grep -q 'router-config.json' "$REBUILD" || { echo "Couldn't update rebuild.sh"; undo; }
fi
bash -n "$REBUILD" || undo

echo "Restarting OTP..."
sudo systemctl restart otp
wait_for_plans || undo
echo "OTP is answering plans."

echo "Waiting for live data to reach a plan..."
LIVE_LEGS=0
for _ in $(seq 1 24); do
  LIVE_LEGS=$( (curl -sSf -m 20 "$PLAN" 2>/dev/null || true) | (grep -o '"realTime":true' || true) | wc -l)
  [ "$LIVE_LEGS" -gt 0 ] && break
  sleep 5
done

if [ "$LIVE_LEGS" -gt 0 ]; then
  echo "DONE: plans are using live data ($LIVE_LEGS live legs in a test plan)."
else
  # Plans work, so the change stays: a quiet hour can have no live trip on this test journey
  echo "OTP is running, but the test plan had no live legs yet. Recent updater messages:"
  sudo journalctl -u otp --since "5 minutes ago" --no-pager | grep -iE "updater|gtfs|trip ?update" | tail -8 || true
fi
