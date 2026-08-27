#!/usr/bin/env bash

set -euo pipefail

demo_dir="$(cd "$(dirname "$0")" && pwd)"
temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/kyukurarin-demo.XXXXXX")"
trap 'rm -rf "$temp_dir"' EXIT

sample_rate=44100
part_index=0

begin_track() {
  track_duration="$1"
  parts=()
  sox -n -r "$sample_rate" -c 1 -b 16 "$temp_dir/base.wav" trim 0 "$track_duration"
}

add_click() {
  local start="$1"
  local frequency="$2"
  local volume="$3"
  local length="${4:-0.055}"
  local part="$temp_dir/part-$(printf '%04d' "$part_index").wav"
  part_index=$((part_index + 1))

  sox -n -r "$sample_rate" -c 1 -b 16 "$part" \
    synth "$length" sine "$frequency" \
    fade q 0.002 "$length" 0.018 \
    vol "$volume" \
    pad "$start" 0
  parts+=("$part")
}

finish_track() {
  local output="$1"
  sox -m "$temp_dir/base.wav" "${parts[@]}" "$demo_dir/$output" gain -n -1
}

# 120 BPM（0.5秒間隔）。4拍ごとの低音を少し強くして周期を聞き取りやすくする。
begin_track 10
for step in $(seq 1 19); do
  time="$(awk -v step="$step" 'BEGIN { printf "%.3f", step * 0.5 }')"
  if (( step % 4 == 1 )); then volume=0.95; else volume=0.62; fi
  add_click "$time" 100 "$volume"
done
finish_track "01-steady-120bpm.wav"

# 120 BPMの格子付近で、発音だけを最大45ms前後させる。
begin_track 10
for event in \
  0.500 1.045 1.478 2.020 2.500 3.035 3.485 4.030 4.500 \
  5.040 5.490 6.025 6.500 7.045 7.480 8.020 8.500 9.035 9.490; do
  add_click "$event" 100 0.78
done
finish_track "02-humanized-120bpm.wav"

# 100 BPMの主拍（0.6秒間隔）に、格子の中央へ高い音のシンコペーションを置く。
begin_track 10
for step in $(seq 0 15); do
  time="$(awk -v step="$step" 'BEGIN { printf "%.3f", 0.5 + step * 0.6 }')"
  add_click "$time" 100 0.68
done
for event in 1.400 3.800 6.200 8.600; do
  add_click "$event" 2500 0.98 0.040
done
finish_track "03-syncopation-100bpm.wav"

# 180 BPM（約0.333秒間隔）の均一な打音で、密度制限を示す。
begin_track 10
for step in $(seq 0 28); do
  time="$(awk -v step="$step" 'BEGIN { printf "%.3f", 0.433 + step / 3 }')"
  add_click "$time" 120 0.80 0.045
done
finish_track "04-fast-180bpm.wav"

# 前後は120 BPM、4.0秒から6.0秒までは完全な休符。
begin_track 10
for event in 0.500 1.000 1.500 2.000 2.500 3.000 3.500 \
             6.500 7.000 7.500 8.000 8.500 9.000 9.500; do
  add_click "$event" 100 0.78
done
finish_track "05-rest-in-the-middle.wav"

# onsetも周期もない入力で、最終フォールバックの挙動を確認する。
sox -n -r "$sample_rate" -c 1 -b 16 "$demo_dir/06-silence-fallback.wav" trim 0 6

printf 'Generated demo WAV files in %s\n' "$demo_dir"
