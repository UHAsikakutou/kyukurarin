import p5 from "p5";
import art1Url from "./public/1.PNG" with { type: "file" };
import art2Url from "./public/2.PNG" with { type: "file" };
import art3Url from "./public/3.PNG" with { type: "file" };
import art4Url from "./public/4.PNG" with { type: "file" };
import art5Url from "./public/5.PNG" with { type: "file" };
import art6Url from "./public/6.PNG" with { type: "file" };
import art7Url from "./public/7.PNG" with { type: "file" };
import {
  MICROPHONE_THRESHOLD_RANGE,
  MicrophoneInput,
  TrackPlayer,
  analyzeTrack,
  type MicrophoneState,
  type TrackAnalysis,
} from "./src/audio";
import {
  RhythmGame,
  type GamePhase,
  type GamePiece,
  type Judgement,
  type PieceVisibility,
} from "./src/game";

/** p5キャンバス上の矩形領域。座標と寸法はCSSピクセル相当。 */
type Rect = { x: number; y: number; w: number; h: number };

/** 現在のウィンドウ寸法から計算した、主要UI領域の配置。 */
type Layout = {
  compact: boolean;
  margin: number;
  header: Rect;
  stage: Rect;
  footer: Rect;
  upload: Rect;
  play: Rect;
  tap: Rect;
  mic: Rect;
  info: Rect;
  overlayAction: Rect;
  showMicPanel: boolean;
};

/** 画像URLと、元画像から人物を切り抜く範囲。 */
type ArtSpec = {
  url: string;
  crop: { x: number; y: number; w: number; h: number };
};

const COLORS = {
  paper: "#f2eee7",
  paperDark: "#ddd6cc",
  ink: "#100f12",
  softInk: "#5e5a5b",
  white: "#fffdf8",
  cyan: "#15e6df",
  pink: "#ff4eb8",
  gray: "#898487",
};

const ART: ArtSpec[] = [
  { url: art1Url, crop: { x: 724, y: 23, w: 421, h: 1028 } },
  { url: art2Url, crop: { x: 822, y: 88, w: 456, h: 962 } },
  { url: art3Url, crop: { x: 760, y: 94, w: 490, h: 941 } },
  { url: art4Url, crop: { x: 837, y: 112, w: 418, h: 947 } },
  { url: art5Url, crop: { x: 781, y: 88, w: 592, h: 962 } },
  { url: art6Url, crop: { x: 759, y: 30, w: 540, h: 1007 } },
  { url: art7Url, crop: { x: 766, y: 178, w: 529, h: 856 } },
];

const MOTION = {
  pitch: 169.159,
  scale: 0.94,
  moveDuration: 100,
  dropDownAt: 67,
  bounceAt: 100,
  settleAt: 140,
};

/** 必須DOM要素を取得し、HTMLとの不整合を起動直後に明示する。 */
function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`${selector} が見つかりません`);
  return element;
}

/** 数値を両端を含む指定範囲へ収める。 */
function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

/** 速く始まり緩やかに終わる、0〜1の3次イージング。 */
function easeOutCubic(value: number) {
  return 1 - (1 - value) ** 3;
}

/** 緩やかに始まり速く終わる、0〜1の3次イージング。 */
function easeInCubic(value: number) {
  return value ** 3;
}

/** 秒数を再生時間表示用の `分:秒` に変換する。 */
function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return "0:00";
  const safe = Math.max(0, seconds);
  return `${Math.floor(safe / 60)}:${Math.floor(safe % 60)
    .toString()
    .padStart(2, "0")}`;
}

/** ゲームフェーズをヘッダー用の短い英語ラベルへ変換する。 */
function phaseLabel(phase: GamePhase) {
  const labels: Record<GamePhase, string> = {
    idle: "NO TRACK",
    analyzing: "ANALYZING",
    ready: "READY",
    playing: "PLAYING",
    paused: "PAUSED",
    clear: "CLEAR",
    gameover: "GAME OVER",
    error: "ERROR",
  };
  return labels[phase];
}

const app = requireElement<HTMLElement>("#app");
const audioElement = requireElement<HTMLAudioElement>("#audio");
const fileInput = requireElement<HTMLInputElement>("#audio-file");
const liveRegion = requireElement<HTMLElement>("#live-region");
const settings = requireElement<HTMLDetailsElement>("#audio-settings");
const settingsButton = requireElement<HTMLElement>("#audio-settings > summary");
const volumeInput = requireElement<HTMLInputElement>("#playback-volume");
const volumeValue = requireElement<HTMLOutputElement>("#volume-value");
const inputDeviceSelect = requireElement<HTMLSelectElement>("#input-device");
const outputDeviceSelect = requireElement<HTMLSelectElement>("#output-device");
const track = new TrackPlayer(audioElement);
const microphone = new MicrophoneInput();
const game = new RhythmGame();

let analysis: TrackAnalysis | null = null;
let analysisProgress = 0;
let analysisController: AbortController | null = null;
let trackTitle = "音声ファイルを選択";
let errorMessage = "";
let lastInputAt = -Infinity;
let pieceVisibility: PieceVisibility | undefined;

/** 端末一覧を設定欄へ反映する。権限取得後はブラウザが実名を返す。 */
async function refreshAudioDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    inputDeviceSelect.disabled = true;
    outputDeviceSelect.disabled = true;
    return;
  }
  const devices = await navigator.mediaDevices
    .enumerateDevices()
    .catch(() => []);
  const fill = (
    select: HTMLSelectElement,
    kind: MediaDeviceKind,
    defaultLabel: string,
    selectedId: string,
  ) => {
    const matching = devices.filter((device) => device.kind === kind);
    select.replaceChildren(new Option(defaultLabel, ""));
    matching.forEach((device, index) => {
      select.add(
        new Option(
          device.label ||
            `${kind === "audioinput" ? "マイク" : "出力"} ${index + 1}`,
          device.deviceId,
        ),
      );
    });
    select.value = selectedId;
  };
  fill(
    inputDeviceSelect,
    "audioinput",
    "既定のマイク",
    microphone.inputDeviceId,
  );
  fill(
    outputDeviceSelect,
    "audiooutput",
    "既定の出力",
    outputDeviceSelect.value,
  );
  outputDeviceSelect.disabled = !("setSinkId" in audioElement);
}

volumeInput.addEventListener("input", () => {
  const volume = Number(volumeInput.value) / 100;
  track.setVolume(volume);
  volumeValue.value = `${volumeInput.value}%`;
});

settings.addEventListener("toggle", () => {
  if (settings.open) void refreshAudioDevices();
});

// summaryはクリック後もフォーカスを保持し、次のSpaceを開閉操作に使ってしまう。
// マウスで設定を開閉した後は、ゲームのキーボード操作へすぐ戻せるようにする。
settingsButton.addEventListener("click", () => settingsButton.blur());

inputDeviceSelect.addEventListener("change", async () => {
  const changed = await microphone.setInputDevice(inputDeviceSelect.value);
  announce(
    changed
      ? "入力デバイスを変更しました。マイクを再調整します"
      : "入力デバイスを変更できませんでした",
  );
  await refreshAudioDevices();
});

outputDeviceSelect.addEventListener("change", async () => {
  const changed = await track.setOutputDevice(outputDeviceSelect.value);
  announce(
    changed
      ? "出力デバイスを変更しました"
      : "出力デバイスを変更できませんでした",
  );
});

navigator.mediaDevices?.addEventListener("devicechange", () => {
  if (settings.open) void refreshAudioDevices();
});

/** スクリーンリーダー向けライブ領域へ状態変化を通知する。 */
function announce(message: string) {
  liveRegion.textContent = message;
}

/** 同じファイルも再選択できるよう値を消してからファイル選択を開く。 */
function openFilePicker() {
  fileInput.value = "";
  fileInput.click();
}

/**
 * 選択された音声を再生用に登録し、解析からゲーム譜面の設定まで行う。
 * 後から別の曲が選ばれた場合は古い解析を中止し、その結果を採用しない。
 */
async function loadTrack(file: File) {
  analysisController?.abort();
  const controller = new AbortController();
  analysisController = controller;
  track.pause();
  microphone.pause();
  analysis = null;
  analysisProgress = 0;
  errorMessage = "";
  trackTitle = file.name.replace(/\.[^.]+$/, "");
  track.load(file);
  game.setPhase("analyzing");
  announce(`${trackTitle} を解析しています`);

  try {
    const result = await analyzeTrack(file, {
      signal: controller.signal,
      onProgress: (progress) => {
        if (analysisController === controller) analysisProgress = progress;
      },
    });
    if (controller.signal.aborted || analysisController !== controller) return;
    analysis = result;
    game.configure(result.beats);
    announce(`解析完了。${result.beats.length}個のリズムポイントがあります`);
  } catch (error) {
    if (controller.signal.aborted) return;
    errorMessage =
      error instanceof Error
        ? `音声を解析できませんでした：${error.message}`
        : "音声を解析できませんでした";
    game.setPhase("error");
    announce(errorMessage);
  }
}

/** 再生・マイク・ゲーム時計をそろえて一時停止する。 */
function pauseGame() {
  if (game.phase !== "playing") return;
  track.pause();
  microphone.pause();
  game.pause();
  announce("一時停止しました");
}

/** マイク権限を要求し、環境音を測る初期調整を開始する。 */
async function prepareMicrophone() {
  if (game.phase !== "ready" || microphone.state !== "off") return;
  announce("マイクの許可を待っています");
  const enabled = await microphone.start();
  if (enabled) void refreshAudioDevices();
  if (game.phase !== "ready") {
    microphone.pause();
    return;
  }
  announce(
    enabled
      ? "マイクを調整しています。少しだけ静かにしてください"
      : "マイクなしで遊びます。STARTを押してください",
  );
}

/** 現在のフェーズに応じて、マイク準備または再生開始を実行する。 */
function activatePrimaryAction() {
  if (game.phase === "ready") {
    if (microphone.state === "off") {
      void prepareMicrophone();
      return;
    }
    if (microphone.state === "requesting" || microphone.state === "calibrating")
      return;
  }
  void beginPlayback();
}

/**
 * 新規プレイまたは一時停止位置から、音声とゲームを開始する。
 * @param useMicrophone `false` ならマイクを起動せず手動入力だけで遊ぶ。
 */
async function beginPlayback(useMicrophone = true) {
  if (!analysis) return;
  if (game.phase === "playing") {
    pauseGame();
    return;
  }

  if (
    game.phase === "ready" ||
    game.phase === "clear" ||
    game.phase === "gameover"
  ) {
    track.rewind();
    game.startFresh();
  } else if (game.phase === "paused") {
    game.resume();
  } else {
    return;
  }

  const playback = track.play();
  if (
    useMicrophone &&
    (microphone.state === "paused" || microphone.state === "active")
  ) {
    void microphone.start();
  } else if (!useMicrophone) {
    microphone.pause();
  }

  try {
    await playback;
    if (track.playing) announce("ゲーム開始。曲に合わせて手拍子してください");
  } catch (error) {
    if (game.phase === "paused") return;
    track.pause();
    microphone.pause();
    errorMessage =
      error instanceof Error
        ? `再生を開始できません：${error.message}`
        : "再生を開始できません";
    game.setPhase("error");
    announce(errorMessage);
  }
}

/** 曲末の未確定判定を処理し、クリアまたはゲームオーバーを通知する。 */
function finishGame() {
  const result = game.finish(performance.now(), pieceVisibility);
  microphone.pause();
  if (result === "clear") announce(`クリア。スコア ${game.score}`);
  if (result === "gameover")
    announce("ゲームオーバー。画面に画像が残りませんでした");
}

/**
 * マイクまたは手動操作の1入力を、現在の再生時刻でゲームへ渡す。
 * マイク入力だけは検出・処理遅延の概算として35ms早める。
 */
function registerHit(source: "mic" | "manual") {
  if (game.phase !== "playing") return;
  const now = performance.now();
  const songTime = Math.max(
    0,
    track.currentTime - (source === "mic" ? 0.035 : 0),
  );
  const judgement = game.registerInput(songTime, now);
  lastInputAt = now;
  const label =
    judgement.kind === "perfect" || judgement.kind === "ok" ? "OK" : "NG";
  announce(label);
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) void loadTrack(file);
});

audioElement.addEventListener("ended", finishGame);
audioElement.addEventListener("error", () => {
  if (game.phase === "analyzing") return;
  errorMessage = "この音声形式はブラウザで再生できません";
  game.setPhase("error");
  announce(errorMessage);
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) pauseGame();
});

new p5((p) => {
  let images: p5.Image[] = [];
  let failedAssets = 0;
  let thresholdDragging = false;

  /** ウィンドウ寸法から、通常表示またはコンパクト表示の配置を作る。 */
  function createLayout(): Layout {
    const compact = p.width < 720 || p.height < 610;
    const margin = compact ? 10 : 22;
    const headerHeight = compact ? 62 : 72;
    const footerHeight = compact ? 108 : 126;
    const footerY = p.height - footerHeight;
    const stage: Rect = {
      x: margin,
      y: headerHeight,
      w: Math.max(1, p.width - margin * 2),
      h: Math.max(130, footerY - headerHeight - margin),
    };
    const uploadWidth = compact ? 112 : 142;
    const playSize = compact ? 46 : 54;
    const tapWidth = compact ? 94 : 144;
    const tap: Rect = {
      x: p.width - margin - tapWidth,
      y: footerY + (footerHeight - 56) / 2,
      w: tapWidth,
      h: 56,
    };
    const showMicPanel = p.width >= 690;
    const micWidth = showMicPanel ? Math.min(184, p.width * 0.18) : 0;
    const mic: Rect = {
      x: tap.x - micWidth - (showMicPanel ? 18 : 0),
      y: tap.y,
      w: micWidth,
      h: tap.h,
    };
    const play: Rect = {
      x: margin,
      y: footerY + (footerHeight - playSize) / 2,
      w: playSize,
      h: playSize,
    };
    const infoX = play.x + play.w + (compact ? 12 : 18);
    const infoRight = showMicPanel ? mic.x - 20 : tap.x - 14;
    const actionWidth = Math.min(compact ? 184 : 220, stage.w - 32);
    return {
      compact,
      margin,
      header: { x: 0, y: 0, w: p.width, h: headerHeight },
      stage,
      footer: { x: 0, y: footerY, w: p.width, h: footerHeight },
      upload: {
        x: p.width - margin - uploadWidth,
        y: compact ? 12 : 15,
        w: uploadWidth,
        h: compact ? 38 : 42,
      },
      play,
      tap,
      mic,
      info: {
        x: infoX,
        y: footerY + (compact ? 20 : 25),
        w: Math.max(40, infoRight - infoX),
        h: footerHeight - (compact ? 40 : 50),
      },
      overlayAction: {
        x: stage.x + (stage.w - actionWidth) / 2,
        y: stage.y + stage.h * 0.68,
        w: actionWidth,
        h: compact ? 46 : 52,
      },
      showMicPanel,
    };
  }

  /** 現在のポインター座標が矩形内にあるかを返す。 */
  function pointIn(rect: Rect) {
    return (
      p.mouseX >= rect.x &&
      p.mouseX <= rect.x + rect.w &&
      p.mouseY >= rect.y &&
      p.mouseY <= rect.y + rect.h
    );
  }

  /** マイクパネル内の入力レベル・閾値メーター領域を返す。 */
  function microphoneMeter(layout: Layout): Rect {
    return { x: layout.mic.x, y: layout.mic.y + 28, w: layout.mic.w, h: 8 };
  }

  /** ノイズ抑制切り替えボタンの操作領域を返す。 */
  function noiseSuppressionToggle(layout: Layout): Rect {
    return {
      x: layout.mic.x + layout.mic.w - 52,
      y: layout.mic.y - 1,
      w: 52,
      h: 17,
    };
  }

  /** 手動閾値から自動調整へ戻すボタンの操作領域を返す。 */
  function automaticThresholdButton(layout: Layout): Rect {
    return {
      x: layout.mic.x + layout.mic.w - 34,
      y: layout.mic.y + 39,
      w: 34,
      h: 15,
    };
  }

  /** メーター上のポインター位置をマイクの手動閾値へ変換する。 */
  function setThresholdFromPointer(layout: Layout) {
    const meter = microphoneMeter(layout);
    const ratio = clamp((p.mouseX - meter.x) / meter.w, 0, 1);
    const { minimum, maximum } = MICROPHONE_THRESHOLD_RANGE;
    microphone.setManualThreshold(minimum + ratio * (maximum - minimum));
  }

  /** ノイズ抑制の希望値を反転し、適用結果を読み上げる。 */
  async function toggleNoiseSuppression() {
    if (microphone.state === "requesting") return;
    const enabled = !microphone.noiseSuppression;
    const applied = await microphone.setNoiseSuppression(enabled);
    if (applied) {
      announce(
        `ブラウザへノイズ抑制${enabled ? "有効" : "無効"}を要求しました`,
      );
    } else {
      announce(
        `ノイズ抑制${enabled ? "有効" : "無効"}は現在のマイクへ適用できませんでした`,
      );
    }
  }

  /** 幅に収まらない文字列を末尾の省略記号付きで短縮する。 */
  function fitText(text: string, maximumWidth: number) {
    if (p.textWidth(text) <= maximumWidth) return text;
    let output = text;
    while (output.length > 1 && p.textWidth(`${output}…`) > maximumWidth) {
      output = output.slice(0, -1);
    }
    return `${output}…`;
  }

  /** 共通の矩形ボタンを、ホバー・強調・無効状態に応じて描画する。 */
  function drawButton(
    rect: Rect,
    label: string,
    accent = false,
    disabled = false,
  ) {
    const hover = !disabled && pointIn(rect);
    p.strokeWeight(1.5);
    p.stroke(disabled ? COLORS.gray : COLORS.ink);
    if (disabled) p.fill(COLORS.paperDark);
    else if (accent) p.fill(hover ? COLORS.pink : COLORS.cyan);
    else p.fill(hover ? COLORS.ink : COLORS.paper);
    p.rect(rect.x, rect.y, rect.w, rect.h, 2);
    p.noStroke();
    p.fill(
      disabled ? COLORS.gray : hover && !accent ? COLORS.white : COLORS.ink,
    );
    p.textAlign(p.CENTER, p.CENTER);
    p.textStyle(p.BOLD);
    p.textSize(rect.h < 48 ? 11 : 12);
    p.text(label, rect.x + rect.w / 2, rect.y + rect.h / 2 + 0.5);
  }

  /** タイトル、ゲーム状態、曲選択ボタンを含むヘッダーを描画する。 */
  function drawHeader(layout: Layout) {
    p.noStroke();
    p.fill(COLORS.paper);
    p.rect(0, 0, layout.header.w, layout.header.h);
    p.fill(COLORS.ink);
    p.textAlign(p.LEFT, p.CENTER);
    p.textStyle(p.BOLD);
    p.textSize(layout.compact ? 17 : 22);
    p.text(
      "KYU/KURA/RIN",
      layout.margin,
      layout.header.h / 2 - (layout.compact ? 0 : 7),
    );
    if (!layout.compact) {
      p.fill(COLORS.softInk);
      p.textStyle(p.NORMAL);
      p.textSize(10);
      p.text(
        "RHYTHM ARCHIVE  /  きゅうくらりん",
        layout.margin,
        layout.header.h / 2 + 14,
      );
    }
    const statusX = layout.compact ? layout.margin + 138 : layout.margin + 235;
    p.fill(game.phase === "playing" ? COLORS.cyan : COLORS.ink);
    p.circle(statusX, layout.header.h / 2, 7);
    p.fill(COLORS.softInk);
    p.textStyle(p.BOLD);
    p.textSize(9);
    if (p.width >= 430) {
      p.text(phaseLabel(game.phase), statusX + 9, layout.header.h / 2 + 0.5);
    }
    drawButton(layout.upload, "＋  曲を選ぶ");
  }

  /** 1920×1080基準の画像配置を現在のステージ寸法へ写す値を計算する。 */
  function visualMetrics(stage: Rect) {
    const scale = Math.min(stage.h / 1080, stage.w / 1260);
    const aspect = stage.w / Math.max(1, stage.h);
    const anchorRatio = aspect < 1.1 ? 0.68 : aspect < 1.45 ? 0.59 : 0.5;
    return {
      scale,
      pitch: MOTION.pitch * scale,
      anchorX: stage.x + stage.w * anchorRatio,
      baseline: stage.y + stage.h * 0.992,
    };
  }

  /** 現在のレスポンシブ配置で、画像の横幅がステージと交差するか調べる。 */
  function isPieceVisible(layout: Layout, piece: GamePiece) {
    const spec = ART[piece.imageIndex];
    if (!spec) return false;
    const metrics = visualMetrics(layout.stage);
    const width = spec.crop.w * MOTION.scale * metrics.scale;
    const center =
      metrics.anchorX + (piece.column - (game.slotCount - 1)) * metrics.pitch;
    return (
      center + width / 2 > layout.stage.x &&
      center - width / 2 < layout.stage.x + layout.stage.w
    );
  }

  /** 5つの論理列の基準位置をステージ下端へ短い目盛りとして描く。 */
  function drawSlotGuides(layout: Layout) {
    const metrics = visualMetrics(layout.stage);
    p.stroke(255, 255, 255, 45);
    p.strokeWeight(1);
    for (let column = 0; column < game.slotCount; column += 1) {
      const x =
        metrics.anchorX + (column - (game.slotCount - 1)) * metrics.pitch;
      p.line(x, metrics.baseline - 8, x, metrics.baseline);
    }
    p.noStroke();
  }

  /**
   * 生成直後の画像について、落下・行き過ぎ・跳ね返り・静止のY座標を求める。
   * @param elapsed 画像生成からの経過時間（ms）。
   */
  function fallingY(
    elapsed: number,
    start: number,
    landing: number,
    stageHeight: number,
  ) {
    const overshoot = landing + stageHeight * 0.14;
    const rebound = landing - stageHeight * 0.075;
    if (elapsed <= 0) return start;
    if (elapsed < MOTION.dropDownAt) {
      return p.lerp(start, overshoot, easeInCubic(elapsed / MOTION.dropDownAt));
    }
    if (elapsed < MOTION.bounceAt) {
      const t =
        (elapsed - MOTION.dropDownAt) / (MOTION.bounceAt - MOTION.dropDownAt);
      return p.lerp(overshoot, rebound, easeOutCubic(t));
    }
    if (elapsed < MOTION.settleAt) {
      const t =
        (elapsed - MOTION.bounceAt) / (MOTION.settleAt - MOTION.bounceAt);
      return p.lerp(rebound, landing, easeOutCubic(t));
    }
    return landing;
  }

  /** ゲームの論理画像列を、落下と左移動の補間を加えて描画する。 */
  function drawPieces(layout: Layout, now: number) {
    const metrics = visualMetrics(layout.stage);
    const ordered = [...game.pieces].sort(
      (left, right) => right.column - left.column,
    );
    for (const piece of ordered) {
      const spec = ART[piece.imageIndex];
      const image = images[piece.imageIndex];
      if (!spec) continue;
      const moveProgress = clamp(
        (now - piece.movedAt) / MOTION.moveDuration,
        0,
        1,
      );
      const visualColumn = p.lerp(
        piece.fromColumn,
        piece.column,
        easeOutCubic(moveProgress),
      );
      const xCenter =
        metrics.anchorX + (visualColumn - (game.slotCount - 1)) * metrics.pitch;
      const drawHeight = spec.crop.h * MOTION.scale * metrics.scale;
      const drawWidth = spec.crop.w * MOTION.scale * metrics.scale;
      const landing = metrics.baseline - drawHeight;
      const start = layout.stage.y - drawHeight;
      const y = fallingY(now - piece.spawnedAt, start, landing, layout.stage.h);
      const x = xCenter - drawWidth / 2;
      if (image && image.width > 1) {
        p.image(
          image,
          x,
          y,
          drawWidth,
          drawHeight,
          spec.crop.x,
          spec.crop.y,
          spec.crop.w,
          spec.crop.h,
        );
      } else {
        p.noFill();
        p.stroke(COLORS.cyan);
        p.rect(x, y, drawWidth, drawHeight);
        p.noStroke();
        p.fill(COLORS.white);
        p.textAlign(p.CENTER, p.CENTER);
        p.textSize(28);
        p.text(String(piece.imageIndex + 1), xCenter, y + drawHeight / 2);
      }
    }
  }

  /** 譜面レールと解析ビューで共有する、現在時刻のX座標。 */
  function rhythmTargetX(layout: Layout) {
    return layout.stage.x + layout.stage.w * 0.77;
  }

  /** 現在時刻の前後にある判定点と入力目標線をリズムレールへ描く。 */
  function drawBeatRail(layout: Layout) {
    if (!analysis) return;
    const current = track.currentTime;
    const railY = layout.stage.y + 24;
    const targetX = rhythmTargetX(layout);
    const pixelsPerSecond = Math.min(170, layout.stage.w * 0.14);
    p.stroke(255, 255, 255, 42);
    p.strokeWeight(1);
    p.line(
      layout.stage.x + 18,
      railY,
      layout.stage.x + layout.stage.w - 18,
      railY,
    );
    for (const beat of game.beats) {
      const difference = beat.time - current;
      if (difference < -1.2) continue;
      if (difference > 3.2) break;
      const x = targetX + difference * pixelsPerSecond;
      if (x < layout.stage.x || x > layout.stage.x + layout.stage.w) continue;
      p.stroke(
        beat.hit ? COLORS.cyan : beat.resolved ? COLORS.pink : COLORS.white,
      );
      p.strokeWeight(beat.strength > 0.55 ? 3 : 1.5);
      p.line(x, railY - 7, x, railY + 7);
    }
    p.stroke(COLORS.cyan);
    p.strokeWeight(2);
    p.line(targetX, railY - 12, targetX, railY + 12);
    p.noStroke();
  }

  /**
   * 判定表示の背面に、解析で実際に使った3帯域のRMS振幅を流して描く。
   * 桃線はBPM推定ライブラリの未加工の拍、シアン線は最終的なゲーム判定点で、
   * 中央の白線が現在の再生時刻である。
   */
  function drawRhythmEvidence(layout: Layout) {
    if (!analysis) return;
    const context = p.drawingContext as CanvasRenderingContext2D;
    const visualization = analysis.visualization;
    const wide = layout.stage.w / layout.stage.h >= 1.2;
    const targetX = rhythmTargetX(layout);
    const panelWidth = layout.stage.w * (wide ? 0.38 : 0.42);
    const panelMargin = layout.compact ? 10 : 18;
    const panelHeight = Math.min(
      clamp(layout.stage.h * 0.32, 128, layout.compact ? 156 : 190),
      Math.max(64, layout.stage.h * 0.44),
    );
    const panel: Rect = {
      // 右端の余白を固定し、画面幅が変わっても外枠との間隔を揃える。
      x: layout.stage.x + layout.stage.w - panelWidth - panelMargin,
      // OK/NGとコンボの下へ離し、判定結果を波形で隠さない。
      y: layout.stage.y + layout.stage.h - panelHeight - 10,
      w: panelWidth,
      h: panelHeight,
    };
    const graphTop = panel.y + 58;
    const graphBottom = panel.y + panel.h - 20;
    const graphHeight = graphBottom - graphTop;
    const centerX = targetX;
    const secondsAcross = 2.4;
    const pixelsPerSecond = panel.w / secondsAcross;
    // パネルだけを右へ動かしても、現在時刻は譜面と同じtargetXに固定する。
    const timeToX = (time: number) =>
      targetX + (time - track.currentTime) * pixelsPerSecond;
    const startTime =
      track.currentTime - (targetX - panel.x) / pixelsPerSecond;
    const endTime =
      track.currentTime + (panel.x + panel.w - targetX) / pixelsPerSecond;

    p.noStroke();
    p.fill(9, 10, 13, 205);
    p.rect(panel.x, panel.y, panel.w, panel.h, 2);
    p.stroke(255, 255, 255, 30);
    p.noFill();
    p.rect(panel.x, panel.y, panel.w, panel.h, 2);

    p.noStroke();
    p.fill(255, 255, 255, 135);
    p.textAlign(p.LEFT, p.CENTER);
    p.textStyle(p.BOLD);
    p.textSize(8);
    p.text("FILTERED RMS  LOW / MID / HIGH", panel.x + 7, panel.y + 10);

    const bands = [visualization.bass, visualization.mid, visualization.high];
    const bandColors = [COLORS.cyan, COLORS.white, COLORS.pink];
    const frameDuration = visualization.frameDuration;
    const firstFrame = Math.max(0, Math.floor(startTime / frameDuration));
    const lastFrame = Math.min(
      bands[0]?.length ?? 0,
      Math.ceil(endTime / frameDuration),
    );
    const step = Math.max(1, Math.ceil((lastFrame - firstFrame) / panel.w));

    bands.forEach((band, bandIndex) => {
      const rowHeight = graphHeight / bands.length;
      const baseline = graphTop + rowHeight * (bandIndex + 0.72);
      p.stroke(255, 255, 255, 18);
      p.strokeWeight(1);
      p.line(panel.x, baseline, panel.x + panel.w, baseline);
      p.noFill();
      p.stroke(bandColors[bandIndex] ?? COLORS.white);
      p.strokeWeight(1.15);
      p.beginShape();
      for (let frame = firstFrame; frame < lastFrame; frame += step) {
        const time = (frame + 0.5) * frameDuration;
        const amplitude = clamp(
          (band[frame] ?? 0) /
            (visualization.bandCeilings[bandIndex] ?? 0.0001),
          0,
          1,
        );
        p.vertex(timeToX(time), baseline - amplitude * rowHeight * 0.58);
      }
      p.endShape();
    });

    // ライブラリ拍は推定結果そのものなので、特定帯域へ割り当てず薄白にする。
    for (const beat of visualization.libraryBeats) {
      if (beat < startTime) continue;
      if (beat > endTime) break;
      const x = timeToX(beat);
      p.stroke(255, 255, 255, 105);
      p.strokeWeight(1);
      context.setLineDash([3, 3]);
      p.line(x, graphTop, x, graphBottom);
    }
    context.setLineDash([]);
    for (const beat of game.beats) {
      if (beat.time < startTime) continue;
      if (beat.time > endTime) break;
      const values = beat.contributions
        ? [
            beat.contributions.bass,
            beat.contributions.mid,
            beat.contributions.high,
          ]
        : [0, 0, 0];
      const total = values.reduce((sum, value) => sum + value, 0);
      const dominantIndex =
        beat.source === "library" || total <= 0
          ? -1
          : values.reduce(
              (best, value, index) =>
                value > (values[best] ?? -Infinity) ? index : best,
              0,
            );
      if (dominantIndex >= 0)
        p.stroke(bandColors[dominantIndex] ?? COLORS.white);
      else p.stroke(255, 255, 255, 135);
      p.strokeWeight(beat.strength > 0.55 ? 2.2 : 1.2);
      const x = timeToX(beat.time);
      p.line(x, graphTop, x, graphBottom);

      // onsetに結び付いた判定点だけ、3帯域の寄与率を縦棒の真上へ表示する。
      if (dominantIndex >= 0) {
        const percentages = values.map((value) =>
          Math.round((value / total) * 100),
        );
        // 個別丸めで99%や101%になった差は、最大寄与帯域へ戻して合計100%にする。
        percentages[dominantIndex] =
          (percentages[dominantIndex] ?? 0) +
          100 -
          percentages.reduce((sum, value) => sum + value, 0);
        const labels = ["L", "M", "H"];
        p.noStroke();
        p.textAlign(p.CENTER, p.CENTER);
        p.textStyle(p.BOLD);
        p.textSize(layout.compact ? 6 : 7);
        for (let index = 0; index < labels.length; index += 1) {
          if (index === dominantIndex) p.fill(bandColors[index] ?? COLORS.white);
          else p.fill(255, 255, 255, 135);
          p.text(
            `${labels[index]}${percentages[index] ?? 0}`,
            x,
            panel.y + 24 + index * 10,
          );
        }
      }
    }
    p.stroke(COLORS.white);
    p.strokeWeight(1.5);
    p.line(centerX, graphTop - 2, centerX, graphBottom + 2);

    p.noStroke();
    p.fill(255, 255, 255, 125);
    p.textAlign(p.CENTER, p.CENTER);
    p.textStyle(p.BOLD);
    p.textSize(7);
    p.text("LIBRARY BEAT", panel.x + panel.w * 0.27, panel.y + panel.h - 9);
    p.fill(255, 255, 255, 135);
    p.circle(panel.x + panel.w * 0.12, panel.y + panel.h - 9, 4);
    p.fill(255, 255, 255, 125);
    p.text("RHYTHM POINT", panel.x + panel.w * 0.73, panel.y + panel.h - 9);
    p.fill(COLORS.cyan);
    p.circle(panel.x + panel.w * 0.57, panel.y + panel.h - 9, 4);
    p.noStroke();
  }

  /** 判定結果を、精度名または判定点からの時間差表示へ変換する。 */
  function judgementDetail(judgement: Judgement) {
    if (judgement.kind === "perfect") return "PERFECT";
    if (judgement.kind === "miss") return "MISS";
    if (judgement.kind === "ng" || judgement.offset === null) return "OFF BEAT";
    const milliseconds = Math.round(judgement.offset * 1000);
    return `${milliseconds > 0 ? "+" : ""}${milliseconds} ms`;
  }

  /** 直近のOK/NGとコンボ、プレイ開始直後の操作案内を描画する。 */
  function drawPlayingReadout(layout: Layout, now: number) {
    const sideX =
      layout.stage.x +
      layout.stage.w * (layout.stage.w / layout.stage.h < 1.2 ? 0.76 : 0.79);
    const sideY = layout.stage.y + layout.stage.h * 0.45;
    const judgement = game.latestJudgement;
    const age = judgement ? now - judgement.at : Infinity;
    if (judgement && age < 620) {
      const positive = judgement.kind === "perfect" || judgement.kind === "ok";
      const scale = 1 + Math.max(0, 1 - age / 150) * 0.16;
      p.push();
      p.translate(sideX, sideY);
      p.scale(scale);
      p.fill(positive ? COLORS.cyan : COLORS.pink);
      p.textAlign(p.CENTER, p.CENTER);
      p.textStyle(p.BOLD);
      p.textSize(layout.compact ? 42 : 64);
      p.text(positive ? "OK!" : "NG", 0, 0);
      p.fill(COLORS.white);
      p.textSize(10);
      p.text(judgementDetail(judgement), 0, layout.compact ? 34 : 48);
      p.pop();
    }
    if (game.combo >= 2) {
      p.fill(COLORS.white);
      p.textAlign(p.CENTER, p.CENTER);
      p.textStyle(p.BOLD);
      p.textSize(layout.compact ? 12 : 14);
      p.text(`${game.combo} COMBO`, sideX, sideY + (layout.compact ? 66 : 88));
    }
    if (track.currentTime < 3 && game.hits === 0) {
      p.fill(255, 255, 255, 150);
      p.textAlign(p.CENTER, p.BOTTOM);
      p.textStyle(p.BOLD);
      p.textSize(10);
      p.text(
        "CLAP  /  SPACE  /  TAP",
        sideX,
        layout.stage.y + layout.stage.h - 22,
      );
    }
  }

  /** プレイ中以外のフェーズに対応する中央メッセージと操作を描画する。 */
  function drawOverlay(layout: Layout) {
    const centerX = layout.stage.x + layout.stage.w / 2;
    const centerY = layout.stage.y + layout.stage.h * 0.42;
    const titleSize = clamp(
      layout.stage.w * 0.07,
      32,
      layout.compact ? 54 : 84,
    );
    p.textAlign(p.CENTER, p.CENTER);
    p.textStyle(p.BOLD);
    if (game.phase === "idle") {
      p.fill(COLORS.cyan);
      p.textSize(10);
      p.text(
        "UPLOAD A SONG  /  FIND THE RHYTHM",
        centerX,
        centerY - titleSize * 0.82,
      );
      p.fill(COLORS.white);
      p.textSize(titleSize);
      p.text("きゅうくらりん", centerX, centerY);
      p.fill(255, 255, 255, 160);
      p.textStyle(p.NORMAL);
      p.textSize(layout.compact ? 11 : 13);
      p.text("ああ 取り繕っていたいな", centerX, centerY + titleSize * 0.72);
      drawButton(layout.overlayAction, "音声ファイルを選ぶ", true);
      return;
    }
    if (game.phase === "analyzing") {
      p.fill(COLORS.white);
      p.textSize(layout.compact ? 28 : 42);
      p.text("ANALYZING", centerX, centerY - 16);
      p.fill(255, 255, 255, 130);
      p.textSize(10);
      p.text("曲の盛り上がりを探しています", centerX, centerY + 24);
      const barWidth = Math.min(380, layout.stage.w - 64);
      const barX = centerX - barWidth / 2;
      const barY = centerY + 54;
      p.fill(255, 255, 255, 35);
      p.rect(barX, barY, barWidth, 5);
      p.fill(COLORS.cyan);
      p.rect(barX, barY, barWidth * analysisProgress, 5);
      p.fill(COLORS.white);
      p.text(`${Math.round(analysisProgress * 100)}%`, centerX, barY + 22);
      return;
    }
    if (game.phase === "ready") {
      const preparing =
        microphone.state === "requesting" || microphone.state === "calibrating";
      const actionLabel =
        microphone.state === "off"
          ? "MICを準備"
          : preparing
            ? "MICを調整中…"
            : microphone.state === "active" || microphone.state === "paused"
              ? "START"
              : "START  /  TAP MODE";
      const guidance =
        microphone.state === "off"
          ? "先にマイクを準備　／　SpaceならマイクなしでSTART"
          : preparing
            ? "調整が終わるまで少しだけ静かにしてください"
            : microphone.state === "active" || microphone.state === "paused"
              ? "マイク準備完了　ヘッドホンでのプレイを推奨"
              : "マイクなし：Space / Tap で遊べます";
      p.fill(COLORS.cyan);
      p.textSize(10);
      p.text(
        `${analysis?.beats.length ?? 0} RHYTHM POINTS  /  ${analysis?.tempo || "--"} BPM  /  ${analysis?.strategy === "tempo-grid" ? "BEAT GRID" : "ONSET"}`,
        centerX,
        centerY - 62,
      );
      p.fill(COLORS.white);
      p.textSize(titleSize);
      p.text("READY", centerX, centerY);
      p.fill(255, 255, 255, 160);
      p.textStyle(p.NORMAL);
      p.textSize(layout.compact ? 10 : 12);
      p.text(guidance, centerX, centerY + 52);
      drawButton(layout.overlayAction, actionLabel, true, preparing);
      return;
    }
    if (game.phase === "paused") {
      p.fill(COLORS.white);
      p.textSize(titleSize);
      p.text("PAUSED", centerX, centerY);
      p.fill(255, 255, 255, 145);
      p.textStyle(p.NORMAL);
      p.textSize(11);
      p.text("Pキーでも再開できます", centerX, centerY + 52);
      drawButton(layout.overlayAction, "再開する", true);
      return;
    }
    if (game.phase === "clear" || game.phase === "gameover") {
      const clear = game.phase === "clear";
      p.fill(clear ? COLORS.cyan : COLORS.pink);
      p.textSize(titleSize);
      p.text(clear ? "CLEAR!" : "GAME OVER", centerX, centerY - 16);
      p.fill(COLORS.white);
      p.textSize(layout.compact ? 12 : 14);
      p.text(
        clear
          ? `${game.countVisiblePieces(pieceVisibility)} IMAGES LEFT  /  SCORE ${game.score.toLocaleString()}`
          : `BEST COMBO ${game.bestCombo}  /  SCORE ${game.score.toLocaleString()}`,
        centerX,
        centerY + 48,
      );
      drawButton(layout.overlayAction, "もう一度", true);
      return;
    }
    if (game.phase === "error") {
      p.fill(COLORS.pink);
      p.textSize(layout.compact ? 30 : 46);
      p.text("ERROR", centerX, centerY - 24);
      p.fill(COLORS.white);
      p.textStyle(p.NORMAL);
      p.textSize(layout.compact ? 10 : 12);
      p.text(
        errorMessage,
        centerX - layout.stage.w * 0.35,
        centerY + 22,
        layout.stage.w * 0.7,
        52,
      );
      drawButton(layout.overlayAction, "別の曲を選ぶ", true);
    }
  }

  /** 背景、進捗、画像、判定レール、状態オーバーレイをステージ内へ描画する。 */
  function drawStage(layout: Layout, now: number) {
    const { stage } = layout;
    const context = p.drawingContext as CanvasRenderingContext2D;
    context.save();
    context.beginPath();
    context.rect(stage.x, stage.y, stage.w, stage.h);
    context.clip();
    p.noStroke();
    p.fill(COLORS.ink);
    p.rect(stage.x, stage.y, stage.w, stage.h);
    p.stroke(255, 255, 255, 14);
    p.strokeWeight(1);
    for (let index = 1; index < 10; index += 1) {
      const x = stage.x + (stage.w / 10) * index;
      p.line(x, stage.y, x, stage.y + stage.h);
    }
    for (let index = 1; index < 6; index += 1) {
      const y = stage.y + (stage.h / 6) * index;
      p.line(stage.x, y, stage.x + stage.w, y);
    }
    p.noStroke();
    p.fill(255, 255, 255, 8);
    p.textAlign(p.LEFT, p.CENTER);
    p.textStyle(p.BOLD);
    p.textSize(clamp(stage.w * 0.13, 44, 170));
    p.text("RHYTHM", stage.x + 18, stage.y + stage.h * 0.55);
    const duration = analysis?.duration ?? track.duration;
    const progress =
      duration > 0 ? clamp(track.currentTime / duration, 0, 1) : 0;
    p.fill(255, 255, 255, 30);
    p.rect(stage.x, stage.y, stage.w, 4);
    p.fill(COLORS.cyan);
    p.rect(stage.x, stage.y, stage.w * progress, 4);
    if (
      game.phase === "playing" ||
      game.phase === "paused" ||
      game.phase === "clear" ||
      game.phase === "gameover"
    ) {
      drawSlotGuides(layout);
      drawPieces(layout, now);
    }
    if (game.phase === "playing") {
      drawBeatRail(layout);
    }
    if (game.phase === "playing" || game.phase === "paused") {
      drawRhythmEvidence(layout);
    }
    if (game.phase === "playing") {
      drawPlayingReadout(layout, now);
    }
    if (game.phase !== "playing") drawOverlay(layout);
    context.restore();
    p.noFill();
    p.stroke(COLORS.ink);
    p.strokeWeight(2);
    p.rect(stage.x, stage.y, stage.w, stage.h);
    p.noStroke();
  }

  /** マイク状態をフッター用の短いラベルへ変換する。 */
  function microphoneLabel(state: MicrophoneState) {
    const labels: Record<MicrophoneState, string> = {
      off: "MIC STANDBY",
      requesting: "MIC REQUEST",
      calibrating: "MIC TUNING",
      active: "MIC ACTIVE",
      paused: "MIC PAUSED",
      denied: "SPACE / TAP",
      unsupported: "SPACE / TAP",
    };
    return labels[state];
  }

  /** 再生可能状態とフェーズに合う再生・一時停止ボタンを描画する。 */
  function drawPlayControl(layout: Layout) {
    const { play } = layout;
    const enabled =
      analysis !== null && game.phase !== "analyzing" && game.phase !== "error";
    const hover = enabled && pointIn(play);
    p.noStroke();
    p.fill(enabled ? (hover ? COLORS.cyan : COLORS.ink) : COLORS.paperDark);
    p.circle(play.x + play.w / 2, play.y + play.h / 2, play.w);
    p.fill(enabled && !hover ? COLORS.white : COLORS.ink);
    const cx = play.x + play.w / 2;
    const cy = play.y + play.h / 2;
    if (game.phase === "playing") {
      p.rect(cx - 7, cy - 9, 5, 18);
      p.rect(cx + 3, cy - 9, 5, 18);
    } else {
      p.triangle(cx - 6, cy - 10, cx - 6, cy + 10, cx + 10, cy);
    }
  }

  /** 曲情報、進捗、得点、マイク設定、TAP操作を含むフッターを描画する。 */
  function drawFooter(layout: Layout, now: number) {
    const { footer, info, tap, mic } = layout;
    p.noStroke();
    p.fill(COLORS.paper);
    p.rect(footer.x, footer.y, footer.w, footer.h);
    p.stroke(COLORS.ink);
    p.strokeWeight(1.5);
    p.line(0, footer.y, p.width, footer.y);
    p.noStroke();
    drawPlayControl(layout);
    p.textAlign(p.LEFT, p.TOP);
    p.fill(COLORS.ink);
    p.textStyle(p.BOLD);
    p.textSize(layout.compact ? 11 : 13);
    p.text(fitText(trackTitle, info.w), info.x, info.y);
    p.fill(COLORS.softInk);
    p.textStyle(p.NORMAL);
    p.textSize(9);
    const duration = analysis?.duration ?? track.duration;
    p.text(
      `${formatTime(track.currentTime)} / ${formatTime(duration)}`,
      info.x,
      info.y + 20,
    );
    const timelineY = info.y + (layout.compact ? 42 : 48);
    p.fill(COLORS.paperDark);
    p.rect(info.x, timelineY, info.w, 4, 2);
    p.fill(COLORS.ink);
    const progress =
      duration > 0 ? clamp(track.currentTime / duration, 0, 1) : 0;
    p.rect(info.x, timelineY, info.w * progress, 4, 2);
    if (!layout.compact) {
      p.fill(COLORS.softInk);
      p.textStyle(p.BOLD);
      p.textSize(9);
      p.text(
        `SCORE ${game.score.toLocaleString()}   OK ${game.hits}   NG ${game.misses + game.strayInputs}`,
        info.x,
        timelineY + 12,
      );
    }
    if (layout.showMicPanel) {
      p.fill(COLORS.softInk);
      p.textAlign(p.LEFT, p.TOP);
      p.textStyle(p.BOLD);
      p.textSize(9);
      p.text(microphoneLabel(microphone.state), mic.x, mic.y + 2);
      const noiseToggle = noiseSuppressionToggle(layout);
      const noiseDisabled = microphone.state === "requesting";
      const noiseHover = !noiseDisabled && pointIn(noiseToggle);
      p.stroke(noiseDisabled ? COLORS.gray : COLORS.ink);
      p.strokeWeight(1);
      p.fill(
        noiseDisabled
          ? COLORS.paperDark
          : microphone.noiseSuppression
            ? noiseHover
              ? COLORS.pink
              : COLORS.cyan
            : COLORS.paper,
      );
      p.rect(noiseToggle.x, noiseToggle.y, noiseToggle.w, noiseToggle.h, 2);
      p.noStroke();
      p.fill(noiseDisabled ? COLORS.gray : COLORS.ink);
      p.textAlign(p.CENTER, p.CENTER);
      p.textSize(8);
      p.text(
        `NS ${microphone.noiseSuppression ? "ON" : "OFF"}`,
        noiseToggle.x + noiseToggle.w / 2,
        noiseToggle.y + noiseToggle.h / 2,
      );
      const meter = microphoneMeter(layout);
      const { minimum: meterMinimum, maximum: meterMaximum } =
        MICROPHONE_THRESHOLD_RANGE;
      const meterRange = meterMaximum - meterMinimum;
      const level = clamp((microphone.level - meterMinimum) / meterRange, 0, 1);
      const threshold = clamp(
        (microphone.threshold - meterMinimum) / meterRange,
        0,
        1,
      );
      p.fill(COLORS.paperDark);
      p.rect(meter.x, meter.y, meter.w, meter.h, 1);
      p.fill(level >= threshold ? COLORS.pink : COLORS.cyan);
      p.rect(meter.x, meter.y, meter.w * level, meter.h, 1);
      p.fill(COLORS.ink);
      p.rect(meter.x + meter.w * threshold, meter.y - 3, 2, 14);
      p.fill(COLORS.softInk);
      p.textAlign(p.LEFT, p.TOP);
      p.textStyle(p.NORMAL);
      p.textSize(8);
      p.text(
        `${microphone.thresholdMode === "automatic" ? "AUTO" : "MANUAL"} ${microphone.threshold.toFixed(3)}`,
        mic.x,
        meter.y + 13,
      );
      if (microphone.thresholdMode === "manual") {
        const autoButton = automaticThresholdButton(layout);
        p.fill(pointIn(autoButton) ? COLORS.pink : COLORS.softInk);
        p.textAlign(p.RIGHT, p.TOP);
        p.textStyle(p.BOLD);
        p.text("AUTO↺", autoButton.x + autoButton.w, autoButton.y + 1);
      }
    }
    const tapEnabled = game.phase === "playing";
    const tapPulse = now - lastInputAt < 130;
    p.stroke(COLORS.ink);
    p.strokeWeight(1.5);
    p.fill(
      tapEnabled
        ? tapPulse || pointIn(tap)
          ? COLORS.pink
          : COLORS.cyan
        : COLORS.paperDark,
    );
    p.rect(tap.x, tap.y, tap.w, tap.h, 2);
    p.noStroke();
    p.fill(tapEnabled ? COLORS.ink : COLORS.gray);
    p.textAlign(p.CENTER, p.CENTER);
    p.textStyle(p.BOLD);
    p.textSize(layout.compact ? 12 : 14);
    p.text("TAP", tap.x + tap.w / 2, tap.y + 19);
    p.textSize(8);
    p.text(
      microphone.state === "active" ? "SPACE / MIC" : "SPACE KEY",
      tap.x + tap.w / 2,
      tap.y + 39,
    );
  }

  /**
   * 描画フレームごとにマイクを検出し、曲時刻までゲーム判定を進める。
   * ゲームオーバーが発生した場合は音声とマイクも停止する。
   */
  function updateGame(layout: Layout, now: number) {
    const previousMicrophoneState = microphone.state;
    const microphoneTriggered =
      game.phase === "playing" || microphone.state === "calibrating"
        ? microphone.update(now)
        : false;
    if (
      previousMicrophoneState === "calibrating" &&
      microphone.state === "active" &&
      game.phase === "ready"
    ) {
      announce("マイク準備完了。STARTを押してください");
    }
    if (game.phase !== "playing") return;
    if (microphoneTriggered) registerHit("mic");
    const events = game.advance(track.currentTime, now, (piece) =>
      isPieceVisible(layout, piece),
    );
    if (events.some((event) => event.type === "gameover")) {
      track.pause();
      microphone.pause();
      announce("ゲームオーバー。画像がすべて画面外へ流れました");
    }
  }

  /** 現在クリック可能な領域に応じてマウスカーソルを切り替える。 */
  function updateCursor(layout: Layout) {
    const micInteractive =
      layout.showMicPanel &&
      (pointIn(microphoneMeter(layout)) ||
        (microphone.state !== "requesting" &&
          pointIn(noiseSuppressionToggle(layout))) ||
        (microphone.thresholdMode === "manual" &&
          pointIn(automaticThresholdButton(layout))));
    const interactive =
      thresholdDragging ||
      micInteractive ||
      pointIn(layout.upload) ||
      pointIn(layout.play) ||
      (game.phase === "playing" &&
        (pointIn(layout.tap) || pointIn(layout.stage))) ||
      (game.phase !== "playing" &&
        game.phase !== "analyzing" &&
        pointIn(layout.overlayAction));
    p.cursor(interactive ? p.HAND : p.ARROW);
  }

  /** ポインター押下位置から、閾値・各ボタン・TAPの操作を振り分ける。 */
  function handlePointer(event?: PointerEvent) {
    // p5はwindow全体のpointerdownを監視するため、HTML設定欄の既定操作は
    // キャンバス用ハンドラーでpreventDefaultされないよう、そのまま通す。
    if (event?.target instanceof Node && settings.contains(event.target))
      return true;
    const layout = createLayout();
    if (layout.showMicPanel && pointIn(microphoneMeter(layout))) {
      thresholdDragging = true;
      setThresholdFromPointer(layout);
      return false;
    }
    if (
      layout.showMicPanel &&
      microphone.state !== "requesting" &&
      pointIn(noiseSuppressionToggle(layout))
    ) {
      void toggleNoiseSuppression();
      return false;
    }
    if (
      layout.showMicPanel &&
      microphone.thresholdMode === "manual" &&
      pointIn(automaticThresholdButton(layout))
    ) {
      microphone.useAutomaticThreshold();
      announce("マイク入力感度を自動調整へ戻しました");
      return false;
    }
    if (pointIn(layout.upload)) {
      openFilePicker();
      return false;
    }
    if (pointIn(layout.play)) {
      activatePrimaryAction();
      return false;
    }
    if (game.phase !== "playing" && pointIn(layout.overlayAction)) {
      if (game.phase === "idle" || game.phase === "error") openFilePicker();
      else if (game.phase !== "analyzing") activatePrimaryAction();
      return false;
    }
    if (
      game.phase === "playing" &&
      (pointIn(layout.tap) || pointIn(layout.stage))
    ) {
      registerHit("manual");
      return false;
    }
    return false;
  }

  /** キャンバスと画像素材を初期化する、p5の起動時コールバック。 */
  p.setup = async () => {
    const canvas = p.createCanvas(window.innerWidth, window.innerHeight);
    canvas.parent(app);
    canvas.elt.setAttribute("role", "application");
    canvas.elt.setAttribute(
      "aria-label",
      "きゅうくらりんリズムゲーム。曲を選び、再生中に手拍子、Spaceキー、または画面タップで遊びます。",
    );
    p.textFont(
      '\"Arial Narrow\", \"Hiragino Kaku Gothic ProN\", \"Yu Gothic\", sans-serif',
    );
    p.noStroke();
    p.imageMode(p.CORNER);
    const loaded = await Promise.allSettled(
      ART.map((spec) => p.loadImage(spec.url)),
    );
    images = loaded.map((result) => {
      if (result.status === "fulfilled") return result.value;
      failedAssets += 1;
      return p.createImage(1, 1);
    });
    if (failedAssets > 0)
      announce(`${failedAssets}枚の画像素材を読み込めませんでした`);
  };

  /** ゲーム更新後に全UIを再描画する、p5のフレームコールバック。 */
  p.draw = () => {
    const now = performance.now(); // ページ読み込みからの経過時間を取得
    const layout = createLayout();
    pieceVisibility = (piece) => isPieceVisible(layout, piece);
    updateGame(layout, now);
    p.background(COLORS.paper);
    drawHeader(layout);
    drawStage(layout, now);
    drawFooter(layout, now);
    updateCursor(layout);
  };

  p.mousePressed = handlePointer;
  /** ドラッグ中のポインター位置をマイク閾値へ連続反映する。 */
  p.mouseDragged = () => {
    if (!thresholdDragging) return true;
    setThresholdFromPointer(createLayout());
    return false;
  };
  /** 閾値ドラッグを終了し、固定した値を読み上げる。 */
  p.mouseReleased = () => {
    if (!thresholdDragging) return true;
    thresholdDragging = false;
    announce(`マイク閾値を ${microphone.threshold.toFixed(3)} に固定しました`);
    return false;
  };
  /** キーボード操作を入力、再生制御、曲選択、リトライへ振り分ける。 */
  p.keyPressed = (event?: KeyboardEvent) => {
    // range/selectの操作中だけは設定側へキーを渡す。summaryにフォーカスが
    // 残っていてもSpaceはゲーム操作を優先し、設定表示を再トグルさせない。
    if (
      event?.target instanceof HTMLInputElement ||
      event?.target instanceof HTMLSelectElement
    )
      return true;
    if (event?.repeat) return false;
    const code = event?.code ?? "";
    if (code === "Space") {
      event?.preventDefault();
      if (game.phase === "playing") registerHit("manual");
      else if (game.phase === "ready") {
        void beginPlayback(false);
      } else if (
        game.phase === "paused" ||
        game.phase === "clear" ||
        game.phase === "gameover"
      ) {
        void beginPlayback();
      }
      return false;
    }
    if (code === "Enter" && game.phase !== "playing") {
      activatePrimaryAction();
      return false;
    }
    if (code === "KeyP" || code === "Escape") {
      if (game.phase === "playing") pauseGame();
      else if (game.phase === "paused") void beginPlayback();
      return false;
    }
    if (code === "KeyO" || code === "KeyU") {
      openFilePicker();
      return false;
    }
    if (
      code === "KeyR" &&
      (game.phase === "clear" || game.phase === "gameover")
    ) {
      void beginPlayback();
      return false;
    }
    return true;
  };
  /** ブラウザの表示領域にキャンバス寸法を追従させる。 */
  p.windowResized = () => p.resizeCanvas(window.innerWidth, window.innerHeight);
}, app);

window.addEventListener("beforeunload", () => {
  analysisController?.abort();
  track.dispose();
  void microphone.dispose();
});
