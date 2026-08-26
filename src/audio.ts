import { guess } from "web-audio-beat-detector";

/**
 * このファイルは、ゲームの「音」に関する次の3つの役割を受け持つ。
 *
 * 1. `analyzeTrack`: 音声ファイルから、プレイヤーが入力する時刻の列を作る。
 * 2. `TrackPlayer`: `<audio>` の再生時刻を、ゲーム全体の時計として公開する。
 * 3. `MicrophoneInput`: マイク波形から手拍子らしい一瞬の音を1回だけ通知する。
 *
 * 判定点・解析履歴・曲頭末余白は秒、`frameSize` はサンプル数、マイクの
 * 校正・再発火制御は `performance.now()` 由来のミリ秒で表す。BPMは1分あたりの
 * 拍数、周波数はHzである。音声サンプル、RMS、`strength` は物理的な音圧
 * （Pa）ではなく、ブラウザ内で扱う正規化された相対値である。判定点を実際に
 * PERFECT/OK/MISSへ分類する処理は `game.ts`、全処理の接続は `index.ts` にある。
 */

/** 1つのゲーム用判定点。音楽理論上の「拍」と必ず一致するとは限らない。 */
export type AnalysisBeat = {
  /**
   * 曲頭を0とした判定時刻（秒）。入力との距離、画像列を動かす時刻、
   * リズムレール上の位置を決める共通基準になる。
   */
  time: number;
  /**
   * 0〜1程度に正規化した立ち上がりの目立ち度。onset候補の段階では、
   * グリッド位相と近接候補の選択に使う。最終判定点になった後はリズムレールの
   * 線幅だけに使い、判定幅・得点・画像生成へ直接は使わない。
   */
  strength: number;
};

/** `analyzeTrack` がUIとゲーム初期化へ渡す、曲全体の解析結果。 */
export type TrackAnalysis = {
  /** `RhythmGame.configure()` に渡す、時刻順の判定点。 */
  beats: AnalysisBeat[];
  /**
   * デコード後の曲長（秒）。ステージとフッターの再生進捗・時間表示で、
   * `<audio>` が報告する `TrackPlayer.duration` より優先して使う。
   */
  duration: number;
  /** READY画面に表示する整数BPM。onset方式では判定点間隔からの概算値。 */
  tempo: number;
  /** READY画面に、一定グリッドかonset系フォールバックかを表示する。 */
  strategy: "tempo-grid" | "onset";
};

/**
 * BPM推定器の結果。`bpm` は1分あたりの拍数、`offset` は推定された周期
 * グリッドの基準時刻（秒）。offsetは小節頭や強拍を保証せず、下で同じ
 * 周期内の位置へ正規化するため、負や曲長より大きい値でも扱える。
 */
export type TempoGuess = { bpm: number; offset: number };

type AnalysisOptions = {
  /** 別の曲が選ばれたとき、時間のかかる解析を途中で打ち切るために使う。 */
  signal?: AbortSignal;
  /** 解析画面の進捗バーへ、0〜1の概算進捗を渡す。 */
  onProgress?: (progress: number) => void;
};

/**
 * 解析結果を「音楽的に正しい採譜」ではなく「遊べる密度の譜面」にする調整値。
 * `frameSize` はサンプル数、履歴・間隔・余白は秒、`minimumNovelty` は
 * 相対的な新規性、`thresholdMad` はMADへ掛ける無次元の倍率で表す。
 */
const ANALYSIS = {
  // この個数のサンプルフレームを1区間として、その区間の音量を1値へまとめる。
  frameSize: 512,
  // onset判定の基準となる、直前の曲調を観測する長さ（秒）。
  historySeconds: 1.1,
  // 過去の通常変動（MAD）の何倍を「急な変化」とみなすか。
  thresholdMad: 2.35,
  // 静かな区間でMADがほぼ0でも、微小な揺れをonsetにしないための下限。
  minimumNovelty: 0.018,
  // tempo-gridと第1onsetフォールバックで保証する最小間隔（秒）。
  // 最終0.82秒区間フォールバックには適用せず、近接する場合もある。
  minimumBeatGap: 0.48,
  // 最終フォールバックで、判定点を1個ずつ探す区間の長さ（秒）。
  fallbackStep: 0.82,
  // 曲頭は解析履歴が不足し、開始直後の入力も難しいため判定点から除外する。
  startPadding: 0.38,
  // MISS確定に必要な遅判定200msを曲末より前にほぼ確保する余白。
  endPadding: 0.24,
};

/** 経験的に算出したonset候補・表示用strengthを、扱いやすい範囲へ収める。 */
function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  // 平均値と違い突出した1点に引っ張られにくく、音量や拍間隔の代表に向く。
  // 呼び出し元が保持する配列を並べ替えないよう、必要な箇所ではコピーを渡す。
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  if (values.length % 2 === 1) return values[middle] ?? 0;
  return ((values[middle - 1] ?? 0) + (values[middle] ?? 0)) / 2;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new DOMException("解析を中止しました", "AbortError");
}

/** 長い同期ループの合間に描画・ファイル再選択などのブラウザ処理を通す。 */
function yieldToBrowser() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

/**
 * `time` 前後の窓にあるonsetのうち、時刻が最も近いものではなく最も強いものを
 * 返す。1つの拍の近くに候補が複数あっても、位相評価、グリッド点を残す判断、
 * 表示強度に使う代表を1つにするためである。`onsets` は時刻順であることを
 * 前提に、探索を早く終える。
 */
function closestOnset(onsets: AnalysisBeat[], time: number, window: number) {
  let closest: AnalysisBeat | null = null;
  for (const onset of onsets) {
    if (onset.time < time - window) continue;
    if (onset.time > time + window) break;
    if (!closest || onset.strength > closest.strength) closest = onset;
  }
  return closest;
}

/**
 * 推定BPMと周期グリッドの基準位置から、一定間隔のゲーム用判定点を作る。
 *
 * `60 / bpm` で1拍の秒数を求める。ただし速い曲は何拍かおきに間引き、onset
 * （音量が急に立ち上がった時刻）が多く重なる位相を選ぶ。onsetそのものへ判定
 * 時刻をずらさないので、最終的な判定点は一定間隔を保つ。
 *
 * @param onsets 時刻と相対強度を持つonset候補。時刻の昇順で渡す。
 * @param duration 曲長（秒）。曲末より後の判定点を作らないために使う。
 * @param tempoGuess BPMと、推定された周期グリッドの基準時刻（秒）。
 * @param isActive onsetが近くにない拍を残せるほど音が鳴っているかを返す関数。
 * @returns `RhythmGame.configure()` に渡せる、時刻順の判定点。
 */
export function alignBeatsToTempoGrid(
  onsets: AnalysisBeat[],
  duration: number,
  tempoGuess: TempoGuess,
  isActive: (time: number) => boolean = () => true,
) {
  const { bpm, offset } = tempoGuess;
  if (!Number.isFinite(bpm) || bpm <= 0 || !Number.isFinite(offset) || duration <= 0)
    return [];

  // BPMは「1分に何拍」なので、60秒をBPMで割ると1拍の間隔になる。
  const baseInterval = 60 / bpm;
  let interval = baseInterval;
  let subdivision = 1;
  // 高BPM曲を毎拍にすると手拍子が過密になるため、基本間隔の整数倍へ落とす。
  // 例: 180 BPMなら1拍は約0.333秒なので、2拍ごとの約0.667秒にする。
  while (interval < ANALYSIS.minimumBeatGap) {
    interval += baseInterval;
    subdivision += 1;
  }

  // offsetと、そこから基本間隔の整数倍だけ離れた時刻は同じ拍位置を表す。
  // 二重の剰余で負のoffsetも 0以上baseInterval未満へ入れる。
  const normalizedOffset = ((offset % baseInterval) + baseInterval) % baseInterval;
  // onsetとの対応を許す時間幅。遅い曲でも前後100msより広げない。
  const snapWindow = Math.min(0.1, baseInterval * 0.24);
  let bestPhase = normalizedOffset;
  let bestScore = -Infinity;

  // 何拍かおきに間引くと、開始位置の候補も同じ数だけ生じる。
  // 各候補に近いonset強度の合計を比べ、強い音が多い側を採用する。
  // 2拍ごとの例なら「1, 3, 5...拍」と「2, 4, 6...拍」の比較になる。
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

  // 曲頭の操作時間を避けつつ、選んだグリッドの位相は変えない。
  let firstTime = bestPhase;
  while (firstTime < ANALYSIS.startPadding) firstTime += interval;
  const beats: AnalysisBeat[] = [];
  for (
    let time = firstTime;
    time <= duration - ANALYSIS.endPadding;
    time += interval
  ) {
    const onset = closestOnset(onsets, time, snapWindow);
    // 近くにonsetがなく、周辺もほぼ無音なら、休符に判定点を置かない。
    if (!onset && !isActive(time)) continue;
    beats.push({
      // onsetの有無は直前でグリッド点を残す判断にも使ったが、採用後の時刻は
      // 一定グリッドから動かさない。出力値には表示用strengthだけを反映する。
      // onsetなしでも音が続いている点は、弱い線（0.28）として残す。
      time,
      strength: onset ? clamp(0.35 + onset.strength * 0.65, 0.35, 1) : 0.28,
    });
  }
  return beats;
}

/**
 * 音声ファイルから、ゲームで入力を待つ判定点の列を生成する。
 *
 * 処理は大きく次の順番で進む。
 *
 * 1. 音声をサンプル列へデコードし、左右などのチャンネルを平均する。
 * 2. 512サンプルずつ、低・中・高域と全体のRMS（実効振幅）を求める。
 * 3. 各帯域のRMSが急に増えた瞬間をonset候補として抽出する。
 * 4. 推定BPMの等間隔グリッドとonsetを組み合わせ、遊びやすい判定点にする。
 * 5. 推定に失敗した場合も、onset列または区間ごとの最大変化へ退避する。
 *
 * ここでいうonsetは「音符の開始を完全に採譜したもの」ではなく、キック、
 * スネア、歌い出しなどで帯域ごとのRMSが急増したゲーム向け候補である。
 * したがって、戻り値は音楽理論上の楽譜ではなく、入力判定用の近似譜面となる。
 */
export async function analyzeTrack(
  file: File,
  options: AnalysisOptions = {},
): Promise<TrackAnalysis> {
  const { signal, onProgress } = options;
  throwIfAborted(signal);
  onProgress?.(0.03);

  // 圧縮されたMP3等のバイト列を、計算可能なPCMサンプル列へ変換する。
  const encoded = await file.arrayBuffer();
  throwIfAborted(signal);
  onProgress?.(0.08);

  // 解析専用のAudioContextはデコード後すぐ閉じる。曲の再生自体は下の
  // `TrackPlayer` がHTMLAudioElementで行うため、このcontextを保持しない。
  const context = new AudioContext();
  let buffer: AudioBuffer;
  try {
    buffer = await context.decodeAudioData(encoded);
  } finally {
    await context.close();
  }
  throwIfAborted(signal);
  onProgress?.(0.14);
  // 外部ライブラリのBPM推定は、この下のonset解析と並行して進める。
  // 推定失敗を例外のままにせずnullへ変え、後段のonset方式へ退避可能にする。
  // 推定候補は70〜190 BPMに限定し、極端に遅い・速い値を譜面の基準にしない。
  const tempoGuessPromise = guess(buffer, {
    minTempo: 70,
    maxTempo: 190,
  }).catch(() => null);

  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) =>
    buffer.getChannelData(index),
  );
  const sampleRate = buffer.sampleRate;
  const frameSize = ANALYSIS.frameSize;
  // ここでのframeは、同時刻の全チャンネルを指す「サンプルフレーム」ではなく、
  // 512個のサンプルフレームをまとめた解析区間。44.1kHzなら約11.6msになる。
  const frameCount = Math.max(1, Math.ceil(buffer.length / frameSize));
  const frameDuration = frameSize / sampleRate;
  // 変数名はEnergyだが、格納するのは二乗平均の平方根、つまりRMS振幅。
  // 物理単位はなく、「この短い区間が相対的にどれだけ大きいか」を表す。
  const bassEnergy = new Float32Array(frameCount);
  const midEnergy = new Float32Array(frameCount);
  const highEnergy = new Float32Array(frameCount);
  const totalEnergy = new Float32Array(frameCount);

  // one-poleローパスは、保持中のstateを現在のsampleへ少しずつ近づける処理:
  //   state = state + alpha * (sample - state)
  // 急な変化ほど追従しきれないので、結果には低い周波数が多く残る。
  // 220Hz版と2400Hz版の差、そして原音との差を取ることで、FFTを使わず
  // おおよそ低域（キック）・中域・高域（手拍子等）の3つへ分ける。
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
      // 左右など全チャンネルを同じ重みで平均し、解析用モノラル波形にする。
      // 再生音は変更せず、判定点を探す計算だけを簡単にするための変換である。
      let sample = 0;
      for (const channel of channels) sample += channel[sampleIndex] ?? 0;
      sample /= Math.max(1, channels.length);

      bassState += bassAlpha * (sample - bassState);
      midState += midAlpha * (sample - midState);
      // 2400Hz以下の成分から220Hz以下を引けば中域が、原音から
      // 2400Hz以下を引けば高域が近似できる。3つを足すと元のsampleに戻る。
      const bass = bassState;
      const mid = midState - bassState;
      const high = sample - midState;
      bassSum += bass * bass;
      midSum += mid * mid;
      highSum += high * high;
      totalSum += sample * sample;
    }

    // RMS = sqrt((x1^2 + ... + xN^2) / N)。正負に振動する波形を単純平均すると
    // ほぼ0になるため、二乗してから平均し、この区間の音量の目安にする。
    bassEnergy[frame] = Math.sqrt(bassSum / count);
    midEnergy[frame] = Math.sqrt(midSum / count);
    highEnergy[frame] = Math.sqrt(highSum / count);
    totalEnergy[frame] = Math.sqrt(totalSum / count);

    // 数百区間ごとにUIへ制御を返し、長い曲でも進捗描画や中止操作を止めない。
    if (frame % 480 === 0) {
      onProgress?.(0.14 + (frame / frameCount) * 0.5);
      await yieldToBrowser();
      throwIfAborted(signal);
    }
  }

  // novelty（新規性）は「直前の解析区間より音がどれだけ急に強くなったか」。
  // 大きいほどonsetらしく、減衰した区間は0になる。
  const novelty = new Float32Array(frameCount);
  // log1pによる対数圧縮で、大音量部分だけが評価を独占するのを抑える。
  // 36は検出しやすい数値範囲に合わせる経験的倍率で、物理単位は持たない。
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
    // キック由来の低域を少し優先し、高域の細かなノイズは少し弱める。
    novelty[index] = bassRise * 1.35 + midRise + highRise * 0.82;
  }

  // 秒で指定した履歴長を解析区間数へ換算する。サンプルレートが違っても、
  // 約1.1秒という同じ長さの曲調を基準にできる。
  const historyFrames = Math.max(
    12,
    Math.round(ANALYSIS.historySeconds / frameDuration),
  );
  // rawCandidatesは近接候補をまだ間引かない。BPMグリッドの位相評価では、
  // 細かなonsetも材料にした方が強い拍位置を選びやすいためである。
  const rawCandidates: AnalysisBeat[] = [];

  // 曲頭側は最低でも履歴長の約1/3を集めてから開始し、曲末側は局所最大の
  // 前後を安全に比較できるよう3区間を残す。
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
    // 前後2区間（44.1kHzなら約23ms）の値以上となる局所最大だけを調べる。
    // 山の斜面まで別々のonsetに数えることを防ぐ。
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
    // MAD = median(|各値 - 中央値|)。通常の揺れ幅を表し、一部の大きな音に
    // 引っ張られにくい。曲が静かでも最低差0.018は要求する。
    const deviation = median(
      history.map((sample) => Math.abs(sample - center)),
    );
    const threshold =
      center +
      Math.max(ANALYSIS.minimumNovelty, deviation * ANALYSIS.thresholdMad);
    const energy = totalEnergy[index] ?? 0;

    // noveltyだけでは、ほぼ無音中の数値揺れも局所的な山になりうる。
    // 全帯域RMSにも下限を設け、実際にある程度音が鳴った瞬間だけ残す。
    if (value > threshold && energy > 0.004) {
      // 区間の先頭ではなく中央を代表時刻にして、最大約半区間の偏りを避ける。
      const time = (index + 0.5) * frameDuration;
      if (
        time >= ANALYSIS.startPadding &&
        time <= buffer.duration - ANALYSIS.endPadding
      ) {
        rawCandidates.push({
          time,
          // 閾値をどれだけ上回ったかを0.08〜1へ収めた相対値。
          // 後でグリッド位相の比較、0.48秒内のonset候補選択、最終的な
          // リズムレールの線幅に使う。
          strength: clamp(
            (value - threshold) / Math.max(0.025, threshold),
            0.08,
            1,
          ),
        });
      }
    }
  }

  // BPM推定を使えない場合に備え、0.48秒未満で隣り合う候補を1つへ整理する。
  // 同じ範囲に複数あれば、先着ではなく最も強い候補へ置き換える。
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
  // 曲全体の典型的RMSを基準にしつつ、極端に小さくならない下限を持たせる。
  // 一時的な大音量に左右されにくいよう平均ではなく中央値を用いる。
  const typicalEnergy = median(Array.from(totalEnergy));
  const activityFloor = Math.max(0.0045, typicalEnergy * 0.18);
  const isActive = (time: number) => {
    // グリッド時刻の前後約90msで最大RMSを探す。onsetの瞬間でなくても
    // 伴奏や持続音が十分鳴っていれば、その拍はプレイ対象として残せる。
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

  // グリッドの位相選択には、0.48秒へ間引く前の細かな候補を渡す。
  // `onsetBeats` はBPMグリッドが成立しなかった場合にだけ使う退避先である。
  let beats = tempoGuess
    ? alignBeatsToTempoGrid(rawCandidates, buffer.duration, tempoGuess, isActive)
    : [];
  let strategy: TrackAnalysis["strategy"] = "tempo-grid";
  let tempo = tempoGuess?.bpm ?? 0;

  // BPM推定が失敗した曲や、有効なグリッド点が曲長に対して少なすぎる曲は、
  // 最小0.48秒の間隔へ整理済みのonset列を判定点として使う。外部ライブラリの
  // 推定結果にかかわらずゲームを開始できるようにするための第1退避である。
  if (beats.length < Math.max(2, Math.floor(buffer.duration / 15))) {
    beats = onsetBeats;
    strategy = "onset";
  }

  // それでも判定点が少ないときは、0.82秒の各区間からnovelty最大の時刻を
  // 強制的に1つ選ぶ。最大値が閾値を超える必要はないため、これは厳密には
  // onset検出ではない。無音や滑らかな曲にも最低限の譜面を作る最終退避である。
  // 各区間内の最大位置を使うので、隣り合う出力の時刻差は0.82秒とは限らない。
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
        // 最終退避でも表示上の強弱は残す。ただし強い判定点に見えすぎないよう
        // 上限を0.72とし、完全な無音でも細い線として見える下限を置く。
        strength: clamp((novelty[bestIndex] ?? 0) / 0.18, 0.1, 0.72),
      });
    }
    strategy = "onset";
  }

  if (strategy === "onset") {
    // onset方式には信頼できるBPMがないため、隣接判定点の代表間隔から
    // `60 / 間隔` を求め、READY画面用の概算BPMにする。外れやすい極端な
    // 間隔を除き、平均ではなく中央値を使う。
    const intervals = beats
      .slice(1)
      .map((beat, index) => beat.time - (beats[index]?.time ?? 0))
      .filter((interval) => interval > 0.3 && interval < 2.2);
    tempo = intervals.length > 0 ? 60 / median(intervals) : 0;
    // 2倍/半分のテンポは同じ周期感として推定されやすい。表示だけを
    // 70〜180 BPMへ寄せる処理であり、すでに作った判定点時刻は変更しない。
    while (tempo > 180) tempo /= 2;
    while (tempo > 0 && tempo < 70) tempo *= 2;
  }

  onProgress?.(1);
  return {
    beats,
    duration: buffer.duration,
    // BPM表示に小数は不要。tempo-gridを間引いていても、ここでは
    // ライブラリが推定した元のBPMを表示する。
    tempo: Math.round(tempo),
    strategy,
  };
}

/**
 * `<audio>` の再生操作とローカルファイルURLの寿命をまとめる。
 *
 * ゲームは `currentTime` を、判定入力・盤面更新・リズムレールで共通の時計として
 * 使う。実際に鳴っている要素の時計なので、一時停止や再開を挟んでも
 * `performance.now()` のように曲からずれ続けることがない。
 */
export class TrackPlayer {
  readonly element: HTMLAudioElement;
  private objectUrl: string | null = null;

  constructor(element: HTMLAudioElement) {
    this.element = element;
    // 再生音だけを少し下げる。解析したRMSや判定点のstrengthには影響しない。
    this.element.volume = 0.82;
  }

  /** `RhythmGame` の判定と進行へ渡す、現在の曲時刻（秒）。 */
  get currentTime() {
    return this.element.currentTime;
  }

  /** タイムライン表示へ渡す、ブラウザが認識した曲長（秒）。 */
  get duration() {
    return this.element.duration;
  }

  /** 再生開始の成否通知などに使う。曲末は「再生中」に含めない。 */
  get playing() {
    return !this.element.paused && !this.element.ended;
  }

  load(file: File) {
    // ローカルFileをこのページ内だけで参照できるURLへ変換する。
    // 音声をサーバーへ送る処理ではない。曲を替える前に旧URLを解放し、
    // 選曲のたびにブラウザ内メモリを保持し続けないようにする。
    this.pause();
    this.releaseObjectUrl();
    this.objectUrl = URL.createObjectURL(file);
    this.element.src = this.objectUrl;
    this.element.load();
  }

  play() {
    // 自動再生制限やデコード失敗を呼び出し側で表示できるようPromiseを返す。
    return this.element.play();
  }

  pause() {
    this.element.pause();
  }

  rewind() {
    // 新規プレイとリトライでは、ゲーム状態と同時に曲時計も0へ戻す。
    this.element.currentTime = 0;
  }

  dispose() {
    // ページ終了時は再生だけでなくObject URLも解放する。
    this.pause();
    this.releaseObjectUrl();
  }

  private releaseObjectUrl() {
    if (!this.objectUrl) return;
    URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }
}

/**
 * 通常は `off → requesting → calibrating → active` と進む。一時停止は
 * `paused`、API非対応は `unsupported`、許可拒否を含む取得失敗は `denied`。
 */
export type MicrophoneState =
  | "off"
  | "requesting"
  | "calibrating"
  | "active"
  | "paused"
  | "denied"
  | "unsupported";

/**
 * マイク波形から、手拍子のように急に大きくなる打撃音を検出する。
 *
 * `update(performance.now())` は描画フレームごとに呼ばれ、手拍子を新しく1回
 * 検出した瞬間だけ `true` を返す。呼び出し側はその真偽を共通の
 * `RhythmGame.registerInput()` へ渡すため、ここではPERFECT/OKの判定をしない。
 * 波形値はマイクやOSが正規化した相対振幅であり、PaやdB SPLではない。
 */
export class MicrophoneInput {
  /** 許可待ち・初期調整・利用中などをUIと開始操作へ知らせる状態。 */
  state: MicrophoneState = "off";
  /** マイクメーター表示用に平滑化したRMS。トリガー判定には生のRMSを使う。 */
  level = 0;
  /** 現在の環境音から決めたRMS閾値。検出とメーターの目盛りに使う。 */
  threshold = 0.025;

  // context/analyser/streamはリアルタイム波形を読むためのWeb Audio経路。
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private stream: MediaStream | null = null;
  // AnalyserNodeから毎回1024個の時間波形を受け取る再利用バッファ。
  private samples: Float32Array<ArrayBuffer> | null = null;
  // 連打や複数UIイベントから、マイク許可要求を同時に複数発行しないための共有処理。
  private startPromise: Promise<boolean> | null = null;
  // 初回約900msの周囲音を集め、端末ごとの静かな入力レベルを推定する。
  private calibrationUntil = 0;
  private calibrationSamples: number[] = [];
  // noiseFloorは静かな環境音、slowLevelは入力全体へ緩やかに追従する音量。
  // 2種類を併用し、定常ノイズと最近の曲音混入の両方に閾値を合わせる。
  private noiseFloor = 0.006;
  private slowLevel = 0.006;
  // 1回前の生RMS。今回との差から急上昇したかを判定する。
  private previousLevel = 0;
  // 以下の時刻はperformance.now()と同じミリ秒。発火間隔の下限に使う。
  private lastTriggerAt = -Infinity;
  // 発火後falseになり、音が十分静かになるまで次の入力を受け付けない。
  private armed = true;
  // 再待機に必要な「静かな状態」が始まった時刻（ミリ秒）。
  private quietSince = 0;

  async start() {
    // 同じ状態での多重開始を避ける。startPromiseは許可ダイアログ表示中の
    // 連打にも同じ結果を返し、複数のMediaStreamを作らない。
    if (this.state === "active" || this.state === "calibrating") return true;
    if (this.startPromise) return this.startPromise;
    if (!navigator.mediaDevices?.getUserMedia) {
      this.state = "unsupported";
      return false;
    }
    if (this.context && this.stream?.active) {
      // pauseではストリームと調整値を保持するため、再開時は約900msの
      // 初期調整をやり直さず、AudioContextの時計だけを再開する。
      await this.context.resume();
      this.state = "active";
      return true;
    }
    if (this.context || this.stream) {
      // 片方だけ残った状態や終了済みストリームは再利用せず、完全に片付ける。
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
    // マイク権限とMediaStreamは保持し、解析処理だけ止める。ゲーム再開時に
    // 同じノイズ基準を使える一時停止であり、完全解放はdispose()が行う。
    void this.context.suspend();
    this.state = "paused";
  }

  /**
   * 最新の時間波形を測り、新しい手拍子を検出した1フレームだけ `true` を返す。
   * `now` は `performance.now()` 由来のミリ秒。曲時刻や判定点の秒とは別単位。
   */
  update(now: number) {
    if (!this.analyser || !this.samples || this.context?.state !== "running")
      return false;
    // 1024個の最新波形を取得する。fftSizeという設定名だが、この処理では
    // FFTも周波数データも使わず、時間順の振幅サンプルを直接読む。
    this.analyser.getFloatTimeDomainData(this.samples);

    let squares = 0;
    let peak = 0;
    for (const sample of this.samples) {
      squares += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    // RMSは窓全体の入力レベル、peakは窓内の一瞬の最大振幅を表す。
    // 手拍子は「区間全体でも大きく、瞬間的な山も高い」ため両方を後で使う。
    const rms = Math.sqrt(squares / this.samples.length);
    // 表示メーターは上昇時に速く、下降時にゆっくり追従させ、短い手拍子も
    // 目で確認できるようにする。検出計算にはこの平滑値でなく生のrmsを使う。
    this.level += (rms - this.level) * (rms > this.level ? 0.42 : 0.16);
    // より遅い平滑値は、最近ずっと鳴っている環境音へ閾値を追従させる。
    this.slowLevel += (rms - this.slowLevel) * 0.025;

    if (now < this.calibrationUntil) {
      // 最初の約900msは入力判定をせず、部屋と端末の通常レベルだけを集める。
      // この間に手拍子すると基準自体が上がるため、UIでは静かに待つよう案内する。
      this.state = "calibrating";
      this.calibrationSamples.push(rms);
      this.previousLevel = rms;
      return false;
    }

    if (this.state === "calibrating") {
      const sorted = [...this.calibrationSamples].sort((a, b) => a - b);
      // 小さい順の80%位置を初期ノイズフロアとする。中央値より少し厳しく、
      // 調整中の通常の揺れのうち大きめの値も背景音として扱う。
      this.noiseFloor = sorted[Math.floor(sorted.length * 0.8)] ?? 0.006;
      this.calibrationSamples.length = 0;
      this.state = "active";
    }

    // 判定閾値は、固定下限・初期/更新済み環境音・最近の持続音のうち
    // 最も大きい基準を採る。静かな部屋でも敏感になりすぎず、環境音が
    // 大きい部屋でもそれを手拍子と誤認しにくくする。
    this.threshold = Math.max(
      0.014,
      this.noiseFloor * 3.1,
      this.slowLevel * 1.65,
    );
    // 単に大きい音ではなく、1回前のupdateから急上昇したことを要求する。
    // これにより会話や持続音より、打撃音の立ち上がりを優先する。
    const rising = rms > this.previousLevel * 1.22 + 0.0015;
    // RMSと絶対ピークの両方を超えたものを、短く鋭い音の候補とする。
    const transient =
      rms > this.threshold && peak > Math.max(0.1, this.threshold * 2.1);
    // armedは前の音が十分静かになったこと、170msは短すぎる連続発火を
    // ゲーム上の別入力にしないことを保証する、別々の二重カウント防止策。
    const canTrigger = this.armed && now - this.lastTriggerAt > 170;
    const triggered = canTrigger && rising && transient;

    if (triggered) {
      // 1回発火したら即座に待機解除し、同じ手拍子のピークや余韻を数えない。
      this.lastTriggerAt = now;
      this.armed = false;
      this.quietSince = 0;
    } else if (!this.armed && rms < this.threshold * 0.58) {
      // 発火閾値よりかなり低い状態が55ms続いた後だけ再待機する。
      // 入る閾値と戻る閾値を分ける（ヒステリシス）ことで境界付近の揺れを防ぐ。
      if (this.quietSince === 0) this.quietSince = now;
      if (now - this.quietSince > 55) this.armed = true;
    } else if (rms >= this.threshold * 0.58) {
      this.quietSince = 0;
    }

    // 手拍子候補を除いた比較的静かな入力だけで、プレイ中もnoiseFloorを更新する。
    // 現在値より静かなら速めに下げ、少し騒がしくなった場合はゆっくり上げる。
    // 突発音1回で基準が跳ね上がり、その後の手拍子を見失うことを避けるため。
    if (!triggered && rms < this.threshold * 0.78) {
      const rate = rms < this.noiseFloor ? 0.025 : 0.004;
      this.noiseFloor += (rms - this.noiseFloor) * rate;
    }

    this.previousLevel = rms;
    // trueは「手拍子らしい入力が1回あった」という意味だけを持つ。
    // 呼び出し側が再生時刻を35ms補正し、ゲームのタイミング判定へ渡す。
    return triggered;
  }

  async dispose() {
    // pauseと違い、物理マイクのトラックも停止して権限利用と資源を完全に解放する。
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
      // すべてideal（希望値）なので端末が満たす保証はない。モノラル化で処理を
      // 単純にし、echoCancellationで曲のスピーカー回り込みを減らす。一方、
      // 手拍子の急上昇と自前の閾値調整を保つため、ノイズ抑制と自動音量調整は
      // 無効を希望する。
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: { ideal: 1 },
          echoCancellation: { ideal: true },
          noiseSuppression: { ideal: false },
          autoGainControl: { ideal: false },
        },
      });
      // interactiveは低遅延を希望する指定で、検出からゲーム判定までの遅れを
      // 小さくする。実際の端末差は呼び出し側の35ms補正だけでは消え切らない。
      const context = new AudioContext({ latencyHint: "interactive" });
      const analyser = context.createAnalyser();
      // 1024は取得する時間波形の長さ（44.1kHzなら約23ms）。
      // smoothingTimeConstantは周波数データ用なので、この時間波形には効かない。
      // メーター表示の平滑化は上のupdate()で明示的に行う。
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0;
      // destinationへつながないため、マイク音そのものはスピーカーから再生しない。
      context.createMediaStreamSource(stream).connect(analyser);

      this.stream = stream;
      this.context = context;
      this.analyser = analyser;
      this.samples = new Float32Array(analyser.fftSize);
      this.calibrationSamples.length = 0;
      // ここから900ms後までのRMSを、環境音の初期基準として収集する。
      this.calibrationUntil = performance.now() + 900;
      this.state = "calibrating";
      stream.getAudioTracks()[0]?.addEventListener("ended", () => {
        this.state = "off";
      });
      return true;
    } catch {
      // 権限拒否だけでなく、マイク不在や初期化失敗も同じ状態へまとめる。
      // UIはこの状態を受けてSpace/画面タップで遊べる経路を案内する。
      this.state = "denied";
      return false;
    }
  }
}
