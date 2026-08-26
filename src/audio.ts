import { guess } from "web-audio-beat-detector";

export type AnalysisBeat = {
  time: number;
  strength: number;
};

export type TrackAnalysis = {
  beats: AnalysisBeat[];
  duration: number;
  tempo: number;
  strategy: "tempo-grid" | "onset";
};

export type TempoGuess = { bpm: number; offset: number };

type AnalysisOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
};

const ANALYSIS = {
  frameSize: 512,
  historySeconds: 1.1,
  thresholdMad: 2.35,
  minimumNovelty: 0.018,
  minimumBeatGap: 0.48,
  fallbackStep: 0.82,
  startPadding: 0.38,
  endPadding: 0.24,
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  if (values.length % 2 === 1) return values[middle] ?? 0;
  return ((values[middle - 1] ?? 0) + (values[middle] ?? 0)) / 2;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new DOMException("解析を中止しました", "AbortError");
}

function yieldToBrowser() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

function closestOnset(onsets: AnalysisBeat[], time: number, window: number) {
  let closest: AnalysisBeat | null = null;
  for (const onset of onsets) {
    if (onset.time < time - window) continue;
    if (onset.time > time + window) break;
    if (!closest || onset.strength > closest.strength) closest = onset;
  }
  return closest;
}

/** BPMと先頭拍から一定間隔の譜面を作り、onsetは拍の強度と位相選択に使う。 */
export function alignBeatsToTempoGrid(
  onsets: AnalysisBeat[],
  duration: number,
  tempoGuess: TempoGuess,
  isActive: (time: number) => boolean = () => true,
) {
  const { bpm, offset } = tempoGuess;
  if (!Number.isFinite(bpm) || bpm <= 0 || !Number.isFinite(offset) || duration <= 0)
    return [];

  const baseInterval = 60 / bpm;
  let interval = baseInterval;
  let subdivision = 1;
  // 高BPM曲を毎拍にすると手拍子が過密になるため、半テンポへ落とす。
  while (interval < ANALYSIS.minimumBeatGap) {
    interval += baseInterval;
    subdivision += 1;
  }

  const normalizedOffset = ((offset % baseInterval) + baseInterval) % baseInterval;
  const snapWindow = Math.min(0.1, baseInterval * 0.24);
  let bestPhase = normalizedOffset;
  let bestScore = -Infinity;

  // 半テンポにした場合は、強いonsetが多い表拍側を選ぶ。
  for (let phase = 0; phase < subdivision; phase += 1) {
    const phaseOffset = normalizedOffset + phase * baseInterval;
    let score = 0;
    for (let time = phaseOffset; time < duration; time += interval) {
      score += closestOnset(onsets, time, snapWindow)?.strength ?? 0;
    }
    if (score > bestScore) {
      bestScore = score;
      bestPhase = phaseOffset;
    }
  }

  let firstTime = bestPhase;
  while (firstTime < ANALYSIS.startPadding) firstTime += interval;
  const beats: AnalysisBeat[] = [];
  for (
    let time = firstTime;
    time <= duration - ANALYSIS.endPadding;
    time += interval
  ) {
    const onset = closestOnset(onsets, time, snapWindow);
    if (!onset && !isActive(time)) continue;
    beats.push({
      // 判定時刻は一定グリッドを守り、onsetは難易度/表示強度だけに使う。
      time,
      strength: onset ? clamp(0.35 + onset.strength * 0.65, 0.35, 1) : 0.28,
    });
  }
  return beats;
}

/**
 * 曲を低・中・高域の3本のエネルギー包絡へ変換し、急な立ち上がりを
 * 適応閾値で抽出する。厳密な採譜ではなく、手拍子しやすい強いonsetを
 * ゲーム用のターゲット列へ落とすための軽量な解析である。
 */
export async function analyzeTrack(
  file: File,
  options: AnalysisOptions = {},
): Promise<TrackAnalysis> {
  const { signal, onProgress } = options;
  throwIfAborted(signal);
  onProgress?.(0.03);

  const encoded = await file.arrayBuffer();
  throwIfAborted(signal);
  onProgress?.(0.08);

  const context = new AudioContext();
  let buffer: AudioBuffer;
  try {
    buffer = await context.decodeAudioData(encoded);
  } finally {
    await context.close();
  }
  throwIfAborted(signal);
  onProgress?.(0.14);
  const tempoGuessPromise = guess(buffer, {
    minTempo: 70,
    maxTempo: 190,
  }).catch(() => null);

  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) =>
    buffer.getChannelData(index),
  );
  const sampleRate = buffer.sampleRate;
  const frameSize = ANALYSIS.frameSize;
  const frameCount = Math.max(1, Math.ceil(buffer.length / frameSize));
  const frameDuration = frameSize / sampleRate;
  const bassEnergy = new Float32Array(frameCount);
  const midEnergy = new Float32Array(frameCount);
  const highEnergy = new Float32Array(frameCount);
  const totalEnergy = new Float32Array(frameCount);

  // 2つのone-pole low-passの差分で3帯域へ分ける。FFTより軽く、
  // キックと手拍子の両方を拾える程度の時間分解能を確保できる。
  const bassAlpha = 1 - Math.exp((-2 * Math.PI * 220) / sampleRate);
  const midAlpha = 1 - Math.exp((-2 * Math.PI * 2400) / sampleRate);
  let bassState = 0;
  let midState = 0;

  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * frameSize;
    const end = Math.min(buffer.length, start + frameSize);
    const count = Math.max(1, end - start);
    let bassSum = 0;
    let midSum = 0;
    let highSum = 0;
    let totalSum = 0;

    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
      let sample = 0;
      for (const channel of channels) sample += channel[sampleIndex] ?? 0;
      sample /= Math.max(1, channels.length);

      bassState += bassAlpha * (sample - bassState);
      midState += midAlpha * (sample - midState);
      const bass = bassState;
      const mid = midState - bassState;
      const high = sample - midState;
      bassSum += bass * bass;
      midSum += mid * mid;
      highSum += high * high;
      totalSum += sample * sample;
    }

    bassEnergy[frame] = Math.sqrt(bassSum / count);
    midEnergy[frame] = Math.sqrt(midSum / count);
    highEnergy[frame] = Math.sqrt(highSum / count);
    totalEnergy[frame] = Math.sqrt(totalSum / count);

    if (frame % 480 === 0) {
      onProgress?.(0.14 + (frame / frameCount) * 0.5);
      await yieldToBrowser();
      throwIfAborted(signal);
    }
  }

  const novelty = new Float32Array(frameCount);
  const logEnergy = (value: number) => Math.log1p(value * 36);
  for (let index = 1; index < frameCount; index += 1) {
    const bassRise = Math.max(
      0,
      logEnergy(bassEnergy[index] ?? 0) - logEnergy(bassEnergy[index - 1] ?? 0),
    );
    const midRise = Math.max(
      0,
      logEnergy(midEnergy[index] ?? 0) - logEnergy(midEnergy[index - 1] ?? 0),
    );
    const highRise = Math.max(
      0,
      logEnergy(highEnergy[index] ?? 0) - logEnergy(highEnergy[index - 1] ?? 0),
    );
    novelty[index] = bassRise * 1.35 + midRise + highRise * 0.82;
  }

  const historyFrames = Math.max(
    12,
    Math.round(ANALYSIS.historySeconds / frameDuration),
  );
  const rawCandidates: AnalysisBeat[] = [];

  for (
    let index = Math.max(3, Math.floor(historyFrames / 3));
    index < frameCount - 3;
    index += 1
  ) {
    if (index % 640 === 0) {
      onProgress?.(0.64 + (index / frameCount) * 0.27);
      await yieldToBrowser();
      throwIfAborted(signal);
    }
    const value = novelty[index] ?? 0;
    if (
      value < (novelty[index - 1] ?? 0) ||
      value < (novelty[index + 1] ?? 0) ||
      value < (novelty[index - 2] ?? 0) ||
      value < (novelty[index + 2] ?? 0)
    ) {
      continue;
    }

    const from = Math.max(0, index - historyFrames);
    const history = Array.from(novelty.subarray(from, index));
    const center = median(history);
    const deviation = median(
      history.map((sample) => Math.abs(sample - center)),
    );
    const threshold =
      center +
      Math.max(ANALYSIS.minimumNovelty, deviation * ANALYSIS.thresholdMad);
    const energy = totalEnergy[index] ?? 0;

    if (value > threshold && energy > 0.004) {
      const time = (index + 0.5) * frameDuration;
      if (
        time >= ANALYSIS.startPadding &&
        time <= buffer.duration - ANALYSIS.endPadding
      ) {
        rawCandidates.push({
          time,
          strength: clamp(
            (value - threshold) / Math.max(0.025, threshold),
            0.08,
            1,
          ),
        });
      }
    }
  }

  const onsetBeats: AnalysisBeat[] = [];
  for (const candidate of rawCandidates) {
    const previous = onsetBeats.at(-1);
    if (
      !previous ||
      candidate.time - previous.time >= ANALYSIS.minimumBeatGap
    ) {
      onsetBeats.push(candidate);
    } else if (candidate.strength > previous.strength) {
      onsetBeats[onsetBeats.length - 1] = candidate;
    }
  }

  onProgress?.(0.92);
  const tempoGuess = await tempoGuessPromise;
  throwIfAborted(signal);
  const typicalEnergy = median(Array.from(totalEnergy));
  const activityFloor = Math.max(0.0045, typicalEnergy * 0.18);
  const isActive = (time: number) => {
    const center = Math.round(time / frameDuration);
    const radius = Math.max(1, Math.round(0.09 / frameDuration));
    let peak = 0;
    for (
      let index = Math.max(0, center - radius);
      index <= Math.min(totalEnergy.length - 1, center + radius);
      index += 1
    ) {
      peak = Math.max(peak, totalEnergy[index] ?? 0);
    }
    return peak >= activityFloor;
  };

  let beats = tempoGuess
    ? alignBeatsToTempoGrid(rawCandidates, buffer.duration, tempoGuess, isActive)
    : [];
  let strategy: TrackAnalysis["strategy"] = "tempo-grid";
  let tempo = tempoGuess?.bpm ?? 0;

  // BPM推定が失敗した曲や、グリッド上に有効な拍がほとんどない曲は
  // 従来のonset譜面へ戻す。ライブラリ障害でもゲーム開始を妨げない。
  if (beats.length < Math.max(2, Math.floor(buffer.duration / 15))) {
    beats = onsetBeats;
    strategy = "onset";
  }

  // 無音や極端に滑らかな曲でもプロトタイプを開始不能にしない。
  // 検出が少ない場合は、区間内でもっとも強い立ち上がりを一定間隔で選ぶ。
  if (beats.length < Math.max(2, Math.floor(buffer.duration / 12))) {
    beats.length = 0;
    const stepFrames = Math.max(
      1,
      Math.round(ANALYSIS.fallbackStep / frameDuration),
    );
    for (
      let start = Math.round(ANALYSIS.startPadding / frameDuration);
      start < frameCount;
      start += stepFrames
    ) {
      const end = Math.min(frameCount, start + stepFrames);
      let bestIndex = start;
      for (let index = start + 1; index < end; index += 1) {
        if ((novelty[index] ?? 0) > (novelty[bestIndex] ?? 0))
          bestIndex = index;
      }
      const time = (bestIndex + 0.5) * frameDuration;
      if (time > buffer.duration - ANALYSIS.endPadding) break;
      beats.push({
        time,
        strength: clamp((novelty[bestIndex] ?? 0) / 0.18, 0.1, 0.72),
      });
    }
    strategy = "onset";
  }

  if (strategy === "onset") {
    const intervals = beats
      .slice(1)
      .map((beat, index) => beat.time - (beats[index]?.time ?? 0))
      .filter((interval) => interval > 0.3 && interval < 2.2);
    tempo = intervals.length > 0 ? 60 / median(intervals) : 0;
    while (tempo > 180) tempo /= 2;
    while (tempo > 0 && tempo < 70) tempo *= 2;
  }

  onProgress?.(1);
  return {
    beats,
    duration: buffer.duration,
    tempo: Math.round(tempo),
    strategy,
  };
}

export class TrackPlayer {
  readonly element: HTMLAudioElement;
  private objectUrl: string | null = null;

  constructor(element: HTMLAudioElement) {
    this.element = element;
    this.element.volume = 0.82;
  }

  get currentTime() {
    return this.element.currentTime;
  }

  get duration() {
    return this.element.duration;
  }

  get playing() {
    return !this.element.paused && !this.element.ended;
  }

  load(file: File) {
    this.pause();
    this.releaseObjectUrl();
    this.objectUrl = URL.createObjectURL(file);
    this.element.src = this.objectUrl;
    this.element.load();
  }

  play() {
    return this.element.play();
  }

  pause() {
    this.element.pause();
  }

  rewind() {
    this.element.currentTime = 0;
  }

  dispose() {
    this.pause();
    this.releaseObjectUrl();
  }

  private releaseObjectUrl() {
    if (!this.objectUrl) return;
    URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }
}

export type MicrophoneState =
  | "off"
  | "requesting"
  | "calibrating"
  | "active"
  | "paused"
  | "denied"
  | "unsupported";

export class MicrophoneInput {
  state: MicrophoneState = "off";
  level = 0;
  threshold = 0.025;

  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private stream: MediaStream | null = null;
  private samples: Float32Array<ArrayBuffer> | null = null;
  private startPromise: Promise<boolean> | null = null;
  private calibrationUntil = 0;
  private calibrationSamples: number[] = [];
  private noiseFloor = 0.006;
  private slowLevel = 0.006;
  private previousLevel = 0;
  private lastTriggerAt = -Infinity;
  private armed = true;
  private quietSince = 0;

  async start() {
    if (this.state === "active" || this.state === "calibrating") return true;
    if (this.startPromise) return this.startPromise;
    if (!navigator.mediaDevices?.getUserMedia) {
      this.state = "unsupported";
      return false;
    }
    if (this.context && this.stream?.active) {
      await this.context.resume();
      this.state = "active";
      return true;
    }
    if (this.context || this.stream) {
      this.stream?.getTracks().forEach((track) => track.stop());
      this.stream = null;
      this.analyser = null;
      this.samples = null;
      if (this.context) await this.context.close();
      this.context = null;
    }

    this.state = "requesting";
    this.startPromise = this.createStream();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  pause() {
    if (
      !this.context ||
      this.state === "denied" ||
      this.state === "unsupported"
    )
      return;
    void this.context.suspend();
    this.state = "paused";
  }

  update(now: number) {
    if (!this.analyser || !this.samples || this.context?.state !== "running")
      return false;
    this.analyser.getFloatTimeDomainData(this.samples);

    let squares = 0;
    let peak = 0;
    for (const sample of this.samples) {
      squares += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    const rms = Math.sqrt(squares / this.samples.length);
    this.level += (rms - this.level) * (rms > this.level ? 0.42 : 0.16);
    this.slowLevel += (rms - this.slowLevel) * 0.025;

    if (now < this.calibrationUntil) {
      this.state = "calibrating";
      this.calibrationSamples.push(rms);
      this.previousLevel = rms;
      return false;
    }

    if (this.state === "calibrating") {
      const sorted = [...this.calibrationSamples].sort((a, b) => a - b);
      this.noiseFloor = sorted[Math.floor(sorted.length * 0.8)] ?? 0.006;
      this.calibrationSamples.length = 0;
      this.state = "active";
    }

    this.threshold = Math.max(
      0.014,
      this.noiseFloor * 3.1,
      this.slowLevel * 1.65,
    );
    const rising = rms > this.previousLevel * 1.22 + 0.0015;
    const transient =
      rms > this.threshold && peak > Math.max(0.1, this.threshold * 2.1);
    const canTrigger = this.armed && now - this.lastTriggerAt > 170;
    const triggered = canTrigger && rising && transient;

    if (triggered) {
      this.lastTriggerAt = now;
      this.armed = false;
      this.quietSince = 0;
    } else if (!this.armed && rms < this.threshold * 0.58) {
      if (this.quietSince === 0) this.quietSince = now;
      if (now - this.quietSince > 55) this.armed = true;
    } else if (rms >= this.threshold * 0.58) {
      this.quietSince = 0;
    }

    if (!triggered && rms < this.threshold * 0.78) {
      const rate = rms < this.noiseFloor ? 0.025 : 0.004;
      this.noiseFloor += (rms - this.noiseFloor) * rate;
    }

    this.previousLevel = rms;
    return triggered;
  }

  async dispose() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.analyser = null;
    this.samples = null;
    if (this.context) await this.context.close();
    this.context = null;
    this.state = "off";
  }

  private async createStream() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: { ideal: 1 },
          echoCancellation: { ideal: true },
          noiseSuppression: { ideal: false },
          autoGainControl: { ideal: false },
        },
      });
      const context = new AudioContext({ latencyHint: "interactive" });
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0;
      context.createMediaStreamSource(stream).connect(analyser);

      this.stream = stream;
      this.context = context;
      this.analyser = analyser;
      this.samples = new Float32Array(analyser.fftSize);
      this.calibrationSamples.length = 0;
      this.calibrationUntil = performance.now() + 900;
      this.state = "calibrating";
      stream.getAudioTracks()[0]?.addEventListener("ended", () => {
        this.state = "off";
      });
      return true;
    } catch {
      this.state = "denied";
      return false;
    }
  }
}
