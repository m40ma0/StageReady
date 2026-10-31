#!/usr/bin/env bash
# Records the Demo Mode rehearsal in your own voice, one scripted line at a time, then builds:
#   apps/worker/fixtures/demo-rehearsal.wav   16 kHz mono PCM16, sent once to Muse Voice Transcribe by the worker
#   apps/worker/fixtures/demo-rehearsal.json  where each line sits in the recording (ms)
#   apps/web/public/demo/rehearsal-1.m4a      the same audio for the session review player
#
#   pnpm demo:record-voice                      # macOS: uses the default microphone
#   AUDIO_DEVICE=1 pnpm demo:record-voice       # another input; list them with:
#                                               # ffmpeg -f avfoundation -list_devices true -i ""
#   pnpm demo:record-voice --assemble-only DIR  # rebuild from DIR/line-<n>.wav without recording
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
FIXTURES="${FIXTURES_DIR:-$ROOT/apps/worker/fixtures}"
PUBLIC="${PUBLIC_DIR:-$ROOT/apps/web/public/demo}"
LEAD_MS=1000
GAP_MS=800

command -v ffmpeg >/dev/null || { echo "FFmpeg is required: brew install ffmpeg" >&2; exit 1; }

mapfile_lines() {
  (cd "$ROOT/apps/worker" && pnpm exec tsx -e 'import { demoSession } from "@stage-ready/shared"; console.log(demoSession.transcript.join("\n"));')
}

# Trims silence at both ends and normalises one line to 16 kHz mono PCM16.
clean_line() {
  ffmpeg -v error -y -i "$1" -ac 1 -ar 16000 \
    -af "highpass=f=80,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.15,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.25,areverse" \
    -c:a pcm_s16le "$2"
}

duration_ms() { ffprobe -v error -show_entries format=duration -of csv=p=0 "$1" | awk '{ printf "%d", $1 * 1000 }'; }

record_lines() {
  local dir="$1" i=0
  local -a lines=()
  while IFS= read -r line; do lines+=("$line"); done < <(mapfile_lines)
  echo "You will read ${#lines[@]} lines from the fictional Signal Garden pitch. Speak naturally, at pitch pace."
  echo "For each line: Enter starts recording, Enter stops. Then Enter keeps it, p plays it back, r records it again."
  for line in "${lines[@]}"; do
    while true; do
      echo
      echo "Line $((i + 1)) of ${#lines[@]}:  \"$line\""
      read -r -p "  Enter to start… " _
      ffmpeg -v error -y -f avfoundation -i ":${AUDIO_DEVICE:-default}" -ac 1 -ar 48000 "$dir/raw-$i.wav" </dev/null &
      local pid=$!
      read -r -p "  Recording. Enter to stop… " _
      kill -INT "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      clean_line "$dir/raw-$i.wav" "$dir/line-$i.wav"
      echo "  $(duration_ms "$dir/line-$i.wav") ms"
      read -r -p "  Enter to keep, p to play, r to redo: " choice
      if [ "$choice" = "p" ]; then
        afplay "$dir/line-$i.wav"
        read -r -p "  Enter to keep, r to redo: " choice
      fi
      [ "$choice" = "r" ] || break
    done
    i=$((i + 1))
  done
}

# Joins line-0.wav … line-N.wav with fixed gaps and writes the three outputs.
assemble() {
  local dir="$1" count at json inputs filter
  count=$(find "$dir" -maxdepth 1 -name 'line-*.wav' | wc -l | tr -d ' ')
  [ "$count" -gt 0 ] || { echo "No line-<n>.wav files in $dir" >&2; exit 1; }
  at=$LEAD_MS
  json='{"lines":['
  inputs=(-f lavfi -t "$(awk "BEGIN{print $LEAD_MS/1000}")" -i "anullsrc=r=16000:cl=mono")
  filter="[0]"
  for ((i = 0; i < count; i++)); do
    local ms
    ms=$(duration_ms "$dir/line-$i.wav")
    if [ "$i" -gt 0 ]; then json+=","; fi
    json+="{\"startMs\":$at,\"endMs\":$((at + ms))}"
    at=$((at + ms + GAP_MS))
    inputs+=(-i "$dir/line-$i.wav" -f lavfi -t "$(awk "BEGIN{print $GAP_MS/1000}")" -i "anullsrc=r=16000:cl=mono")
    filter+="[$((2 * i + 1))][$((2 * i + 2))]"
  done
  json+='],"note":"Recorded with pnpm demo:record-voice; startMs/endMs locate each demoSession.transcript line."}'
  filter+="concat=n=$((2 * count + 1)):v=0:a=1,loudnorm=I=-18:TP=-1.5,aresample=16000[out]"
  mkdir -p "$FIXTURES" "$PUBLIC"
  ffmpeg -v error -y "${inputs[@]}" -filter_complex "$filter" -map "[out]" -ac 1 -ar 16000 -c:a pcm_s16le "$FIXTURES/demo-rehearsal.wav"
  ffmpeg -v error -y -i "$FIXTURES/demo-rehearsal.wav" -c:a aac -b:a 64k -movflags +faststart "$PUBLIC/rehearsal-1.m4a"
  echo "$json" > "$FIXTURES/demo-rehearsal.json"
  echo
  echo "Wrote $FIXTURES/demo-rehearsal.wav ($(duration_ms "$FIXTURES/demo-rehearsal.wav") ms), demo-rehearsal.json and $PUBLIC/rehearsal-1.m4a."
  echo "Commit them and deploy; the worker transcribes the recording once with Muse Voice Transcribe on its next start."
}

if [ "${1:-}" = "--assemble-only" ]; then
  assemble "${2:?Pass the directory holding line-<n>.wav}"
else
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  record_lines "$work"
  assemble "$work"
fi
