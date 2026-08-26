import type { AnalysisBeat } from "./audio";

export type GamePhase =
  | "idle"
  | "analyzing"
  | "ready"
  | "playing"
  | "paused"
  | "clear"
  | "gameover"
  | "error";

export type BeatState = AnalysisBeat & {
  hit: boolean;
  shifted: boolean;
  resolved: boolean;
  pieceCreated: boolean;
};

export type GamePiece = {
  id: number;
  imageIndex: number;
  column: number;
  fromColumn: number;
  spawnedAt: number;
  movedAt: number;
};

export type Judgement = {
  kind: "perfect" | "ok" | "ng" | "miss";
  offset: number | null;
  at: number;
};

export type GameEvent =
  | { type: "shift"; beatIndex: number }
  | { type: "miss"; beatIndex: number }
  | { type: "gameover" };

export type PieceVisibility = (piece: GamePiece) => boolean;

const RULES = {
  earlyWindow: 0.14,
  lateWindow: 0.2,
  perfectWindow: 0.072,
  slotCount: 5,
  imageCount: 7,
  compositionWidth: 1920,
  compositionAnchorX: 954,
  compositionPitch: 169.159,
  imageScale: 0.94,
  imageWidths: [421, 456, 490, 418, 592, 540, 529] as const,
};

export class RhythmGame {
  phase: GamePhase = "idle";
  beats: BeatState[] = [];
  pieces: GamePiece[] = [];
  score = 0;
  combo = 0;
  bestCombo = 0;
  hits = 0;
  misses = 0;
  strayInputs = 0;
  latestJudgement: Judgement | null = null;

  private nextShiftIndex = 0;
  private nextResolveIndex = 0;
  private nextImageIndex = 0;
  private nextPieceId = 1;
  private hasEverPlaced = false;

  get slotCount() {
    return RULES.slotCount;
  }

  get earlyWindow() {
    return RULES.earlyWindow;
  }

  get lateWindow() {
    return RULES.lateWindow;
  }

  get visiblePieceCount() {
    return this.countVisiblePieces();
  }

  get progress() {
    if (this.beats.length === 0) return 0;
    return this.nextResolveIndex / this.beats.length;
  }

  configure(beats: AnalysisBeat[]) {
    this.beats = beats.map((beat) => ({
      ...beat,
      hit: false,
      shifted: false,
      resolved: false,
      pieceCreated: false,
    }));
    this.phase = "ready";
    this.resetRuntime();
  }

  setPhase(phase: GamePhase) {
    this.phase = phase;
  }

  startFresh() {
    this.resetRuntime();
    for (const beat of this.beats) {
      beat.hit = false;
      beat.shifted = false;
      beat.resolved = false;
      beat.pieceCreated = false;
    }
    this.phase = "playing";
  }

  resume() {
    if (this.phase === "paused") this.phase = "playing";
  }

  pause() {
    if (this.phase === "playing") this.phase = "paused";
  }

  registerInput(songTime: number, animationTime: number): Judgement {
    if (this.phase !== "playing") {
      return { kind: "ng", offset: null, at: animationTime };
    }

    let closestIndex = -1;
    let closestDistance = Infinity;
    for (
      let index = Math.max(0, this.nextResolveIndex - 1);
      index < this.beats.length;
      index += 1
    ) {
      const beat = this.beats[index];
      if (!beat || beat.hit || beat.resolved) continue;
      const offset = songTime - beat.time;
      if (offset < -RULES.earlyWindow) {
        // 時系列なので、これ以降のbeatはさらに遠い。
        break;
      }
      if (offset > RULES.lateWindow) continue;
      const distance = Math.abs(offset);
      if (distance < closestDistance) {
        closestIndex = index;
        closestDistance = distance;
      }
    }

    if (closestIndex < 0) {
      this.combo = 0;
      this.strayInputs += 1;
      const judgement: Judgement = {
        kind: "ng",
        offset: null,
        at: animationTime,
      };
      this.latestJudgement = judgement;
      return judgement;
    }

    const beat = this.beats[closestIndex];
    if (!beat) {
      const judgement: Judgement = {
        kind: "ng",
        offset: null,
        at: animationTime,
      };
      this.latestJudgement = judgement;
      return judgement;
    }
    const offset = songTime - beat.time;
    beat.hit = true;
    this.hits += 1;
    this.combo += 1;
    this.bestCombo = Math.max(this.bestCombo, this.combo);
    const kind = Math.abs(offset) <= RULES.perfectWindow ? "perfect" : "ok";
    this.score +=
      (kind === "perfect" ? 1000 : 700) + Math.min(500, this.combo * 18);
    if (beat.shifted) this.createPiece(beat, animationTime);

    const judgement: Judgement = { kind, offset, at: animationTime };
    this.latestJudgement = judgement;
    return judgement;
  }

  countVisiblePieces(isVisible?: PieceVisibility) {
    return this.pieces.filter((piece) =>
      isVisible ? isVisible(piece) : this.isPieceOnScreen(piece),
    ).length;
  }

  advance(
    songTime: number,
    animationTime: number,
    isVisible?: PieceVisibility,
  ) {
    const events: GameEvent[] = [];
    if (this.phase !== "playing") return events;

    while (
      this.nextShiftIndex < this.beats.length &&
      (this.beats[this.nextShiftIndex]?.time ?? Infinity) <= songTime
    ) {
      const beat = this.beats[this.nextShiftIndex];
      if (!beat) break;
      this.shiftBoard(animationTime);
      beat.shifted = true;
      if (beat.hit) this.createPiece(beat, animationTime);
      events.push({ type: "shift", beatIndex: this.nextShiftIndex });
      this.nextShiftIndex += 1;
    }

    while (
      this.nextResolveIndex < this.beats.length &&
      (this.beats[this.nextResolveIndex]?.time ?? Infinity) + RULES.lateWindow <
        songTime
    ) {
      const beat = this.beats[this.nextResolveIndex];
      if (!beat) break;
      beat.resolved = true;
      if (!beat.hit) {
        this.misses += 1;
        this.combo = 0;
        this.latestJudgement = {
          kind: "miss",
          offset: null,
          at: animationTime,
        };
        events.push({ type: "miss", beatIndex: this.nextResolveIndex });
      }
      this.nextResolveIndex += 1;

      // 開始時点の空画面では敗北させず、一度獲得した画像をすべて
      // 左へ流してしまったときだけ曲の途中でGAME OVERにする。
      if (
        !beat.hit &&
        this.hasEverPlaced &&
        this.countVisiblePieces(isVisible) === 0
      ) {
        this.phase = "gameover";
        events.push({ type: "gameover" });
        break;
      }
    }

    return events;
  }

  finish(animationTime = 0, isVisible?: PieceVisibility) {
    if (this.phase !== "playing" && this.phase !== "paused") return this.phase;
    // endedイベントがdrawより先に届いた場合も、最後のhit/shiftを取りこぼさない。
    if (this.phase === "playing")
      this.advance(Infinity, animationTime, isVisible);
    if (this.phase === "gameover") return this.phase;
    this.phase = this.countVisiblePieces(isVisible) > 0 ? "clear" : "gameover";
    return this.phase;
  }

  private shiftBoard(animationTime: number) {
    for (const piece of this.pieces) {
      piece.fromColumn = piece.column;
      piece.column -= 1;
      piece.movedAt = animationTime;
    }
    // 左端を抜けるtweenが終わるまで描画用entityを少しだけ保持する。
    this.pieces = this.pieces.filter((piece) => piece.column >= -5);
  }

  private createPiece(beat: BeatState, animationTime: number) {
    if (beat.pieceCreated) return;
    beat.pieceCreated = true;
    this.pieces.push({
      id: this.nextPieceId,
      imageIndex: this.nextImageIndex,
      column: RULES.slotCount - 1,
      fromColumn: RULES.slotCount - 1,
      spawnedAt: animationTime,
      movedAt: animationTime,
    });
    this.nextPieceId += 1;
    this.nextImageIndex = (this.nextImageIndex + 1) % RULES.imageCount;
    this.hasEverPlaced = true;
  }

  private isPieceOnScreen(piece: GamePiece) {
    const width = (RULES.imageWidths[piece.imageIndex] ?? 0) * RULES.imageScale;
    const center =
      RULES.compositionAnchorX +
      (piece.column - (RULES.slotCount - 1)) * RULES.compositionPitch;
    return (
      center + width / 2 > 0 && center - width / 2 < RULES.compositionWidth
    );
  }

  private resetRuntime() {
    this.pieces.length = 0;
    this.nextShiftIndex = 0;
    this.nextResolveIndex = 0;
    this.nextImageIndex = 0;
    this.nextPieceId = 1;
    this.hasEverPlaced = false;
    this.score = 0;
    this.combo = 0;
    this.bestCombo = 0;
    this.hits = 0;
    this.misses = 0;
    this.strayInputs = 0;
    this.latestJudgement = null;
  }
}
