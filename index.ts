import p5 from "p5";
import art1Url from "./public/1.PNG" with { type: "file" };
import art2Url from "./public/2.PNG" with { type: "file" };
import art3Url from "./public/3.PNG" with { type: "file" };
import art4Url from "./public/4.PNG" with { type: "file" };
import art5Url from "./public/5.PNG" with { type: "file" };
import art6Url from "./public/6.PNG" with { type: "file" };
import art7Url from "./public/7.PNG" with { type: "file" };
import {
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

type Rect = { x: number; y: number; w: number; h: number };

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

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`${selector} が見つかりません`);
  return element;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function easeOutCubic(value: number) {
  return 1 - (1 - value) ** 3;
}

function easeInCubic(value: number) {
  return value ** 3;
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return "0:00";
  const safe = Math.max(0, seconds);
  return `${Math.floor(safe / 60)}:${Math.floor(safe % 60)
    .toString()
    .padStart(2, "0")}`;
}

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

function announce(message: string) {
  liveRegion.textContent = message;
}

function openFilePicker() {
  fileInput.value = "";
  fileInput.click();
}

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

function pauseGame() {
  if (game.phase !== "playing") return;
  track.pause();
  microphone.pause();
  game.pause();
  announce("一時停止しました");
}

async function prepareMicrophone() {
  if (game.phase !== "ready" || microphone.state !== "off") return;
  announce("マイクの許可を待っています");
  const enabled = await microphone.start();
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
    if (track.playing)
      announce("ゲーム開始。曲に合わせて手拍子してください");
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

function finishGame() {
  const result = game.finish(performance.now(), pieceVisibility);
  microphone.pause();
  if (result === "clear") announce(`クリア。スコア ${game.score}`);
  if (result === "gameover")
    announce("ゲームオーバー。画面に画像が残りませんでした");
}

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

  function pointIn(rect: Rect) {
    return (
      p.mouseX >= rect.x &&
      p.mouseX <= rect.x + rect.w &&
      p.mouseY >= rect.y &&
      p.mouseY <= rect.y + rect.h
    );
  }

  function fitText(text: string, maximumWidth: number) {
    if (p.textWidth(text) <= maximumWidth) return text;
    let output = text;
    while (output.length > 1 && p.textWidth(`${output}…`) > maximumWidth) {
      output = output.slice(0, -1);
    }
    return `${output}…`;
  }

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

  function drawBeatRail(layout: Layout) {
    if (!analysis) return;
    const current = track.currentTime;
    const railY = layout.stage.y + 24;
    const targetX = layout.stage.x + layout.stage.w * 0.77;
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

  function judgementDetail(judgement: Judgement) {
    if (judgement.kind === "perfect") return "PERFECT";
    if (judgement.kind === "miss") return "MISS";
    if (judgement.kind === "ng" || judgement.offset === null) return "OFF BEAT";
    const milliseconds = Math.round(judgement.offset * 1000);
    return `${milliseconds > 0 ? "+" : ""}${milliseconds} ms`;
  }

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
      p.text(
        "手拍子で、画面に記憶を残していく。",
        centerX,
        centerY + titleSize * 0.72,
      );
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
      const meterY = mic.y + 28;
      const meterMaximum = Math.max(0.06, microphone.threshold * 1.5);
      const level = clamp(microphone.level / meterMaximum, 0, 1);
      const threshold = clamp(microphone.threshold / meterMaximum, 0, 1);
      p.fill(COLORS.paperDark);
      p.rect(mic.x, meterY, mic.w, 8, 1);
      p.fill(level >= threshold ? COLORS.pink : COLORS.cyan);
      p.rect(mic.x, meterY, mic.w * level, 8, 1);
      p.fill(COLORS.ink);
      p.rect(mic.x + mic.w * threshold, meterY - 2, 2, 12);
      p.fill(COLORS.softInk);
      p.textStyle(p.NORMAL);
      p.text("input level", mic.x, meterY + 15);
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

  function updateCursor(layout: Layout) {
    const interactive =
      pointIn(layout.upload) ||
      pointIn(layout.play) ||
      (game.phase === "playing" &&
        (pointIn(layout.tap) || pointIn(layout.stage))) ||
      (game.phase !== "playing" &&
        game.phase !== "analyzing" &&
        pointIn(layout.overlayAction));
    p.cursor(interactive ? p.HAND : p.ARROW);
  }

  function handlePointer() {
    const layout = createLayout();
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

  p.draw = () => {
    const now = performance.now();
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
  p.keyPressed = (event?: KeyboardEvent) => {
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
  p.windowResized = () => p.resizeCanvas(window.innerWidth, window.innerHeight);
}, app);

window.addEventListener("beforeunload", () => {
  analysisController?.abort();
  track.dispose();
  void microphone.dispose();
});
