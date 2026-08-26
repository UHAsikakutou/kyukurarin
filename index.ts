import p5 from "p5";

/**
 * p5.js オーディオプレイヤー
 *
 * 実装は次の3つに分けている。
 * 1. AudioEngine: 音声の再生、ファイルURL、周波数データを管理する
 * 2. BeatDetector: 周波数データから音の立ち上がり（ビート）を検出する
 * 3. p5スケッチ: UIの描画、レイアウト、マウス操作を担当する
 *
 * HTMLはブラウザAPIに必要な audio / file input と、p5のマウント先だけに留める。
 */

const COLORS = {
  background: [17, 16, 15] as const,
  beatBackground: [67, 46, 31] as const,
  accent: [215, 154, 98] as const,
  foreground: [244, 240, 232] as const,
  muted: [157, 153, 146] as const,
  card: [25, 23, 21, 232] as const,
};

const UI = {
  cardWidth: 680,
  cardHeight: 530,
  mobileBreakpoint: 520,
  fileButtonWidth: 150,
  fileButtonHeight: 34,
  controlSize: 48,
  labelWidth: 76,
};

const AUDIO = {
  fftSize: 1024,
  smoothing: 0.55,
  initialVolume: 0.8,
};

const BEAT = {
  firstBin: 2,
  lastBin: 96,
  bassEndBin: 18,
  bassWeight: 1.5,
  minimumHistory: 12,
  historySize: 75,
  thresholdDeviation: 1.35,
  minimumFlux: 0.004,
  cooldownMs: 150,
  glowDecay: 0.9,
};

type DragTarget = "seek" | "volume" | null;

type Layout = {
  x: number;
  y: number;
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  fileY: number;
  controlsY: number;
  seekY: number;
  volumeY: number;
  meterY: number;
};

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`${selector} が見つかりません`);
  return element;
}

/**
 * 音声に関するブラウザAPIをp5の描画処理から切り離す。
 * AudioContextはブラウザの自動再生制限を避けるため、最初の再生操作時に生成する。
 */
class AudioEngine {
  readonly element: HTMLAudioElement;
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private spectrumData: Uint8Array<ArrayBuffer> | null = null;
  private objectUrl: string | null = null;

  constructor(element: HTMLAudioElement) {
    this.element = element;
    this.element.volume = AUDIO.initialVolume;
  }

  get hasTrack() {
    return Boolean(this.element.src);
  }
  get isPlaying() {
    return this.hasTrack && !this.element.paused;
  }
  get currentTime() {
    return this.element.currentTime;
  }
  get duration() {
    return this.element.duration;
  }
  get volume() {
    return this.element.volume;
  }

  set currentTime(value: number) {
    this.element.currentTime = value;
  }
  set volume(value: number) {
    this.element.volume = value;
  }

  load(file: File) {
    this.releaseObjectUrl();
    this.objectUrl = URL.createObjectURL(file);
    this.element.src = this.objectUrl;
  }

  async togglePlayback() {
    if (!this.hasTrack) return;
    this.prepareAnalyser();
    await this.context?.resume();
    if (this.element.paused) await this.element.play();
    else this.element.pause();
  }

  stop() {
    this.element.pause();
    this.element.currentTime = 0;
  }

  /** 毎フレーム最新の周波数データを取得する。未再生時はnullを返す。 */
  readSpectrum() {
    if (!this.analyser || !this.spectrumData) return null;
    this.analyser.getByteFrequencyData(this.spectrumData);
    return this.spectrumData;
  }

  dispose() {
    this.releaseObjectUrl();
    void this.context?.close();
  }

  private prepareAnalyser() {
    if (this.context) return;
    this.context = new AudioContext();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = AUDIO.fftSize;
    this.analyser.smoothingTimeConstant = AUDIO.smoothing;
    this.spectrumData = new Uint8Array(this.analyser.frequencyBinCount);

    const source = this.context.createMediaElementSource(this.element);
    source.connect(this.analyser);
    this.analyser.connect(this.context.destination);
  }

  private releaseObjectUrl() {
    if (!this.objectUrl) return;
    URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }
}

/**
 * スペクトルフラックス方式のビート検出器。
 *
 * 単純な音量閾値は、曲の平均音圧に基準値が追いつくと反応しなくなる。
 * そこで「直前フレームから増えた周波数成分」を音の立ち上がりとして測り、
 * 直近履歴の平均＋標準偏差から動的な閾値を作る。曲中の音圧変化にも追従できる。
 */
class BeatDetector {
  private previous: Uint8Array<ArrayBuffer> | null = null;
  private readonly history: number[] = [];
  private lastBeatAt = 0;
  glow = 0;

  update(
    spectrum: Uint8Array<ArrayBuffer> | null,
    isPlaying: boolean,
    now: number,
  ) {
    this.glow *= BEAT.glowDecay;
    if (!spectrum) return;

    if (!this.previous || this.previous.length !== spectrum.length) {
      this.previous = new Uint8Array(spectrum.length);
      this.previous.set(spectrum);
      return;
    }

    if (!isPlaying) {
      // 停止中の無音との差をビートと誤認しないよう、比較元だけ更新する。
      this.previous.set(spectrum);
      return;
    }

    const flux = this.calculateFlux(spectrum);
    if (this.history.length >= BEAT.minimumHistory) {
      const threshold = this.calculateThreshold();
      if (
        flux > Math.max(BEAT.minimumFlux, threshold) &&
        now - this.lastBeatAt > BEAT.cooldownMs
      ) {
        const strength =
          (flux - threshold) / Math.max(threshold, BEAT.minimumFlux);
        this.glow = Math.min(0.72, Math.max(0.26, 0.26 + strength * 0.2));
        this.lastBeatAt = now;
      }
    }

    this.history.push(flux);
    if (this.history.length > BEAT.historySize) this.history.shift();
    this.previous.set(spectrum);
  }

  reset() {
    this.previous = null;
    this.history.length = 0;
    this.lastBeatAt = 0;
    this.glow = 0;
  }

  private calculateFlux(spectrum: Uint8Array<ArrayBuffer>) {
    const end = Math.min(BEAT.lastBin, spectrum.length);
    let flux = 0;
    let weightTotal = 0;

    for (let i = BEAT.firstBin; i < end; i++) {
      // キックを拾いやすくしつつ、スネアなど中域の立ち上がりも対象にする。
      const weight = i < BEAT.bassEndBin ? BEAT.bassWeight : 1;
      flux +=
        Math.max(0, (spectrum[i] ?? 0) - (this.previous?.[i] ?? 0)) * weight;
      weightTotal += weight;
    }
    return flux / (weightTotal * 255);
  }

  private calculateThreshold() {
    const mean =
      this.history.reduce((sum, value) => sum + value, 0) / this.history.length;
    const variance =
      this.history.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      this.history.length;
    return mean + Math.sqrt(variance) * BEAT.thresholdDeviation;
  }
}

const audio = new AudioEngine(requireElement<HTMLAudioElement>("#audio"));
const fileInput = requireElement<HTMLInputElement>("#audio-file");
const app = requireElement<HTMLElement>("#app");
const beatDetector = new BeatDetector();

new p5((p) => {
  let trackTitle = "音声ファイルを選択";
  let displayedLevel = 0;
  let dragTarget: DragTarget = null;

  /** 描画と当たり判定で同じ座標を使うため、関連座標を一か所で算出する。 */
  function createLayout(): Layout {
    const width = Math.min(UI.cardWidth, p.width - 32);
    const height = Math.min(UI.cardHeight, p.height - 32);
    const x = (p.width - width) / 2;
    const y = (p.height - height) / 2;
    const padding = p.width < UI.mobileBreakpoint ? 24 : 46;
    const top = y + padding;
    return {
      x,
      y,
      width,
      height,
      top,
      left: x + padding,
      right: x + width - padding,
      fileY: top + 108,
      controlsY: top + 178,
      seekY: top + 258,
      volumeY: top + 337,
      meterY: top + 391,
    };
  }

  function isPointerOver(x: number, y: number, width: number, height: number) {
    return (
      p.mouseX >= x &&
      p.mouseX <= x + width &&
      p.mouseY >= y &&
      p.mouseY <= y + height
    );
  }

  function formatTime(seconds: number) {
    if (!Number.isFinite(seconds)) return "0:00";
    return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60)
      .toString()
      .padStart(2, "0")}`;
  }

  function drawSlider(x: number, y: number, width: number, progress: number) {
    const value = p.constrain(progress, 0, 1);
    p.strokeWeight(4);
    p.stroke(74, 69, 64);
    p.line(x, y, x + width, y);
    p.stroke(...COLORS.accent);
    p.line(x, y, x + width * value, y);
    p.noStroke();
    p.fill(...COLORS.foreground);
    p.circle(x + width * value, y, 14);
  }

  function drawBackground(spectrum: Uint8Array<ArrayBuffer> | null) {
    const glow = beatDetector.glow;
    p.background(
      p.lerp(COLORS.background[0], COLORS.beatBackground[0], glow),
      p.lerp(COLORS.background[1], COLORS.beatBackground[1], glow),
      p.lerp(COLORS.background[2], COLORS.beatBackground[2], glow),
    );

    // 周波数帯を32本へ間引き、背景全体を使った簡潔なスペクトラムにする。
    const count = 32;
    const gap = 8;
    const width = Math.max(3, (p.width - gap * (count - 1)) / count);
    for (let i = 0; i < count; i++) {
      const value = spectrum?.[Math.floor((i / count) * spectrum.length)] ?? 0;
      const height = Math.max(3, (value / 255) * p.height * 0.28);
      p.fill(215, 154, 98, 18 + (value / 255) * 42);
      p.rect(i * (width + gap), p.height - height, width, height, 3);
    }
  }

  function drawCard(layout: Layout) {
    p.fill(...COLORS.card);
    p.stroke(255, 255, 255, 22);
    p.strokeWeight(1);
    p.rect(layout.x, layout.y, layout.width, layout.height, 28);
    p.noStroke();

    p.fill(...COLORS.accent);
    p.textSize(11);
    p.textStyle(p.BOLD);
    p.textAlign(p.LEFT, p.BASELINE);
    p.text("P5.JS AUDIO PLAYER", layout.left, layout.top);
    p.fill(...COLORS.foreground);
    p.textSize(p.width < UI.mobileBreakpoint ? 25 : 36);
    p.textStyle(p.NORMAL);
    p.text(
      trackTitle,
      layout.left,
      layout.top + 54,
      layout.right - layout.left,
      48,
    );
    p.fill(...COLORS.muted);
    p.textSize(13);
    p.text("音声はブラウザ内だけで再生されます", layout.left, layout.top + 20);
  }

  function drawFileButton(layout: Layout) {
    const hover = isPointerOver(
      layout.left,
      layout.fileY,
      UI.fileButtonWidth,
      UI.fileButtonHeight,
    );
    p.fill(hover ? 55 : 43, 40, 37);
    p.stroke(90, 83, 77);
    p.rect(
      layout.left,
      layout.fileY,
      UI.fileButtonWidth,
      UI.fileButtonHeight,
      17,
    );
    p.noStroke();
    p.fill(222, 216, 207);
    p.textSize(12);
    p.textAlign(p.CENTER, p.CENTER);
    p.text(
      "＋  ファイルを開く",
      layout.left + UI.fileButtonWidth / 2,
      layout.fileY + UI.fileButtonHeight / 2,
    );
  }

  function drawTransport(layout: Layout) {
    const y = layout.controlsY;
    p.fill(
      audio.hasTrack ? 244 : 92,
      audio.hasTrack ? 240 : 88,
      audio.hasTrack ? 232 : 84,
    );
    p.circle(layout.left + 24, y + 24, UI.controlSize);
    p.fill(23, 21, 19);
    if (audio.isPlaying) {
      p.rect(layout.left + 17, y + 15, 5, 18);
      p.rect(layout.left + 27, y + 15, 5, 18);
    } else {
      p.triangle(
        layout.left + 18,
        y + 14,
        layout.left + 18,
        y + 34,
        layout.left + 34,
        y + 24,
      );
    }
    p.fill(
      audio.hasTrack ? 57 : 42,
      audio.hasTrack ? 53 : 40,
      audio.hasTrack ? 49 : 38,
    );
    p.circle(layout.left + 84, y + 24, UI.controlSize);
    p.fill(audio.hasTrack ? 244 : 100);
    p.rect(layout.left + 77, y + 17, 14, 14);
  }

  function drawTimeline(layout: Layout) {
    const progress = audio.duration ? audio.currentTime / audio.duration : 0;
    drawSlider(layout.left, layout.seekY, layout.right - layout.left, progress);
    p.fill(...COLORS.muted);
    p.textSize(12);
    p.textAlign(p.LEFT, p.TOP);
    p.text(formatTime(audio.currentTime), layout.left, layout.seekY + 12);
    p.textAlign(p.RIGHT, p.TOP);
    p.text(formatTime(audio.duration), layout.right, layout.seekY + 12);
  }

  function drawVolume(layout: Layout) {
    p.stroke(255, 255, 255, 20);
    p.line(layout.left, layout.volumeY - 28, layout.right, layout.volumeY - 28);
    p.noStroke();
    p.fill(187, 181, 173);
    p.textSize(11);
    p.textAlign(p.LEFT, p.CENTER);
    p.text("VOLUME", layout.left, layout.volumeY);
    drawSlider(
      layout.left + UI.labelWidth,
      layout.volumeY,
      layout.right - layout.left - 124,
      audio.volume,
    );
    p.fill(...COLORS.accent);
    p.textAlign(p.RIGHT, p.CENTER);
    p.text(`${Math.round(audio.volume * 100)}%`, layout.right, layout.volumeY);
  }

  function drawLevelMeter(layout: Layout) {
    p.fill(187, 181, 173);
    p.textAlign(p.LEFT, p.CENTER);
    p.text("LEVEL", layout.left, layout.meterY);
    const x = layout.left + UI.labelWidth;
    const width = layout.right - x;
    const value = p.constrain(displayedLevel * 1.7, 0, 1);
    p.fill(57, 53, 49);
    p.rect(x, layout.meterY - 4, width, 8, 4);
    p.fill(value > 0.82 ? p.color(237, 106, 85) : p.color(...COLORS.accent));
    p.rect(x, layout.meterY - 4, width * value, 8, 4);
  }

  function updateSeek(layout: Layout) {
    if (!Number.isFinite(audio.duration)) return;
    const progress = p.constrain(
      (p.mouseX - layout.left) / (layout.right - layout.left),
      0,
      1,
    );
    audio.currentTime = progress * audio.duration;
  }

  function updateVolume(layout: Layout) {
    const start = layout.left + UI.labelWidth;
    const width = layout.right - layout.left - 124;
    audio.volume = p.constrain((p.mouseX - start) / width, 0, 1);
  }

  p.setup = () => {
    p.createCanvas(window.innerWidth, window.innerHeight);
    p.textFont("Inter, Yu Gothic, sans-serif");
    p.noStroke();
  };

  p.draw = () => {
    const layout = createLayout();
    const spectrum = audio.readSpectrum();

    // メーターは急な変化を残しつつ、視認しやすいよう少しだけ平滑化する。
    const average = spectrum
      ? spectrum.reduce((sum, value) => sum + value, 0) / spectrum.length / 255
      : 0;
    displayedLevel = p.lerp(displayedLevel, average, spectrum ? 0.28 : 0.1);
    beatDetector.update(spectrum, audio.isPlaying, p.millis());

    drawBackground(spectrum);
    drawCard(layout);
    drawFileButton(layout);
    drawTransport(layout);
    drawTimeline(layout);
    drawVolume(layout);
    drawLevelMeter(layout);
  };

  p.mousePressed = () => {
    const layout = createLayout();
    const playX = layout.left + 24;
    const stopX = layout.left + 84;
    const controlY = layout.controlsY + 24;

    if (
      isPointerOver(
        layout.left,
        layout.fileY,
        UI.fileButtonWidth,
        UI.fileButtonHeight,
      )
    ) {
      fileInput.click();
    } else if (
      audio.hasTrack &&
      p.dist(p.mouseX, p.mouseY, playX, controlY) < UI.controlSize / 2
    ) {
      void audio.togglePlayback();
    } else if (
      audio.hasTrack &&
      p.dist(p.mouseX, p.mouseY, stopX, controlY) < UI.controlSize / 2
    ) {
      audio.stop();
    } else if (
      isPointerOver(
        layout.left - 8,
        layout.seekY - 12,
        layout.right - layout.left + 16,
        28,
      )
    ) {
      dragTarget = "seek";
      updateSeek(layout);
    } else if (
      isPointerOver(
        layout.left + UI.labelWidth - 8,
        layout.volumeY - 13,
        layout.right - layout.left - 108,
        28,
      )
    ) {
      dragTarget = "volume";
      updateVolume(layout);
    }
  };

  p.mouseDragged = () => {
    const layout = createLayout();
    if (dragTarget === "seek") updateSeek(layout);
    if (dragTarget === "volume") updateVolume(layout);
  };
  p.mouseReleased = () => {
    dragTarget = null;
  };
  p.windowResized = () => p.resizeCanvas(window.innerWidth, window.innerHeight);

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    audio.load(file);
    trackTitle = file.name.replace(/\.[^.]+$/, "");
    beatDetector.reset();
    displayedLevel = 0;
  });
}, app);

window.addEventListener("beforeunload", () => audio.dispose());
