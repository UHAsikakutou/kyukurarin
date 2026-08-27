import type { AnalysisBeat } from "./audio";

/** ゲーム全体の状態。UI表示と、各操作を受け付けるかの判定に使う。 */
export type GamePhase =
  | "idle"
  | "analyzing"
  | "ready"
  | "playing"
  | "paused"
  | "clear"
  | "gameover"
  | "error";

/** 解析済み判定点に、プレイ中の処理状況を加えた内部状態。 */
export type BeatState = AnalysisBeat & {
  /** 許容時間内の入力と対応付けられたか。 */
  hit: boolean;
  /** 判定点の時刻を迎え、盤面を左へ送ったか。 */
  shifted: boolean;
  /** 遅判定の終了時刻を過ぎ、成功またはMISSが確定したか。 */
  resolved: boolean;
  /** この判定点の成功に対応する画像を生成済みか。 */
  pieceCreated: boolean;
};

/** 盤面上を右から左へ移動する1枚の画像の論理状態。 */
export type GamePiece = {
  /** 描画要素を一意に識別する、プレイごとの連番。 */
  id: number;
  /** `public/1.PNG`〜`7.PNG` のどれを使うかを表す0始まりの番号。 */
  imageIndex: number;
  /** 現在の論理列。右端は4で、拍ごとに1ずつ減る。 */
  column: number;
  /** 左移動アニメーション開始前の論理列。 */
  fromColumn: number;
  /** 落下アニメーションを開始した `performance.now()` 時刻（ms）。 */
  spawnedAt: number;
  /** 最後に左移動を開始した `performance.now()` 時刻（ms）。 */
  movedAt: number;
};

/** 1回の入力、または入力されなかった判定点の判定結果。 */
export type Judgement = {
  /** 成功精度、範囲外入力、未入力のいずれか。 */
  kind: "perfect" | "ok" | "ng" | "miss";
  /** 入力時刻から判定点時刻を引いた秒数。入力先がなければ `null`。 */
  offset: number | null;
  /** 判定表示アニメーションの基準となる `performance.now()` 時刻（ms）。 */
  at: number;
};

/** `advance()` が再生時刻を進めた結果、外側へ通知する出来事。 */
export type GameEvent =
  | { type: "shift"; beatIndex: number }
  | { type: "miss"; beatIndex: number }
  | { type: "gameover" };

/** レスポンシブ描画を考慮し、画像が実際に画面内かを判定する関数。 */
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

/**
 * 音声再生や描画に依存せず、判定・得点・盤面・勝敗を管理する。
 *
 * 曲の時刻は秒、画像アニメーションの時刻は `performance.now()` 由来の
 * ミリ秒で受け取る。`index.ts` が両方の時計を供給する。
 */
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

  /** 盤面が持つ論理列の数。新しい画像は右端の列へ追加される。 */
  get slotCount() {
    return RULES.slotCount;
  }

  /** 判定点より何秒前から入力を成功候補として受け付けるか。 */
  get earlyWindow() {
    return RULES.earlyWindow;
  }

  /** 判定点より何秒後まで入力を成功候補として受け付けるか。 */
  get lateWindow() {
    return RULES.lateWindow;
  }

  /** 固定の1920×1080基準で見積もった、画面内の画像数。 */
  get visiblePieceCount() {
    return this.countVisiblePieces();
  }

  /** 確定済み判定点の割合。判定点がなければ0。 */
  get progress() {
    if (this.beats.length === 0) return 0;
    return this.nextResolveIndex / this.beats.length;
  }

  /**
   * 解析結果をプレイ用状態へ変換し、ゲームを開始待ちにする。
   * @param beats 時刻順に並んだ、曲のゲーム用判定点。
   */
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

  /** UIや音声処理で決まったフェーズをゲーム状態へ反映する。 */
  setPhase(phase: GamePhase) {
    this.phase = phase;
  }

  /** 判定・得点・画像を初期化し、同じ譜面を曲頭から開始する。 */
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

  /** 一時停止中であればプレイ状態へ戻す。 */
  resume() {
    if (this.phase === "paused") this.phase = "playing";
  }

  /** プレイ中であれば一時停止状態にする。 */
  pause() {
    if (this.phase === "playing") this.phase = "paused";
  }

  /**
   * 1回の手拍子または手動入力を、最も近い未確定判定点へ対応付ける。
   * 成功時は得点とコンボを更新し、判定点の時刻を過ぎていれば画像も作る。
   *
   * @param songTime 入力が起きた曲中時刻（秒）。
   * @param animationTime 判定表示と画像生成に使う単調増加時刻（ms）。
   * @returns PERFECT、OK、または対応する判定点がないNG。
   */
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

  /**
   * 現在画面内にある画像を数える。
   * @param isVisible 実際のレイアウトを使う任意の可視判定。省略時は基準画面で判定する。
   */
  countVisiblePieces(isVisible?: PieceVisibility) {
    return this.pieces.filter((piece) =>
      isVisible ? isVisible(piece) : this.isPieceOnScreen(piece),
    ).length;
  }

  /**
   * 曲の再生時刻まで判定点を進め、盤面移動、MISS、途中敗北を確定する。
   * @param songTime 現在の曲中時刻（秒）。
   * @param animationTime 盤面移動と判定表示の開始時刻（ms）。
   * @param isVisible 現在の画面サイズにおける画像の可視判定。
   * @returns この更新で発生した出来事を時系列に並べた配列。
   */
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

  /**
   * 曲終了時に残りの判定点を確定し、画像が残っていればクリアとする。
   * @param animationTime 最終更新のアニメーション時刻（ms）。
   * @param isVisible 現在の画面サイズにおける画像の可視判定。
   * @returns 確定後のゲームフェーズ。
   */
  finish(animationTime = 0, isVisible?: PieceVisibility) {
    if (this.phase !== "playing" && this.phase !== "paused") return this.phase;
    // endedイベントがdrawより先に届いた場合も、最後のhit/shiftを取りこぼさない。
    if (this.phase === "playing") {
      const events = this.advance(Infinity, animationTime, isVisible);
      if (events.some((event) => event.type === "gameover")) return this.phase;
    }
    this.phase = this.countVisiblePieces(isVisible) > 0 ? "clear" : "gameover";
    return this.phase;
  }

  /** 全画像の論理列を1つ左へ進め、十分遠い画像を管理対象から外す。 */
  private shiftBoard(animationTime: number) {
    for (const piece of this.pieces) {
      piece.fromColumn = piece.column;
      piece.column -= 1;
      piece.movedAt = animationTime;
    }
    // 左端を抜けるtweenが終わるまで描画用entityを少しだけ保持する。
    this.pieces = this.pieces.filter((piece) => piece.column >= -5);
  }

  /** 成功した判定点に対して画像を一度だけ右端へ追加する。 */
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

  /** 1920×1080の基準コンポジション上で画像が画面と交差するか調べる。 */
  private isPieceOnScreen(piece: GamePiece) {
    const width = (RULES.imageWidths[piece.imageIndex] ?? 0) * RULES.imageScale;
    const center =
      RULES.compositionAnchorX +
      (piece.column - (RULES.slotCount - 1)) * RULES.compositionPitch;
    return (
      center + width / 2 > 0 && center - width / 2 < RULES.compositionWidth
    );
  }

  /** 譜面を保持したまま、1プレイ分の可変状態を初期値へ戻す。 */
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
