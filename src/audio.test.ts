import { describe, expect, test } from "bun:test";
import {
  MICROPHONE_THRESHOLD_RANGE,
  MicrophoneInput,
  alignBeatsToTempoGrid,
  alignBeatsToTempoMap,
  calculateBandContributions,
  expandTempoSegmentsToBeats,
  type AnalysisBeat,
} from "./audio";

const onset = (time: number, strength: number): AnalysisBeat => ({
  time,
  strength,
  contributions: { bass: 1, mid: 0, high: 0 },
  source: "onset",
});

describe("calculateBandContributions", () => {
  test("onset検出と同じ重みで3帯域の寄与率を正規化する", () => {
    const result = calculateBandContributions(1, 1, 1);

    expect(result.bass + result.mid + result.high).toBeCloseTo(1);
    expect(result.bass).toBeGreaterThan(result.mid);
    expect(result.mid).toBeGreaterThan(result.high);
  });
});

describe("expandTempoSegmentsToBeats", () => {
  test("ライブラリのBPMとoffsetを加工前の拍位置へ展開する", () => {
    expect(
      expandTempoSegmentsToBeats(
        [{ start: 0, end: 2, bpm: 120, offset: 0.25 }],
        2,
      ),
    ).toEqual([0.25, 0.75, 1.25, 1.75]);
  });
});

describe("alignBeatsToTempoGrid", () => {
  test("BPMとoffsetの骨格を近傍onsetへ合わせる", () => {
    const beats = alignBeatsToTempoGrid(
      [
        onset(0.49, 0.8),
        onset(1.01, 0.7),
      ],
      3,
      { bpm: 120, offset: 0 },
    );

    expect(beats.map((beat) => beat.time)).toEqual([0.49, 1.01, 2.5]);
    expect(beats[0]?.strength).toBeGreaterThan(0.35);
  });

  test("判定時刻を近いonsetへ合わせ、強い裏拍を譜面へ加える", () => {
    const beats = alignBeatsToTempoGrid(
      [
        onset(0.54, 0.8),
        onset(0.81, 0.9),
        onset(1.48, 0.7),
      ],
      2.2,
      { bpm: 120, offset: 0 },
    );

    expect(beats.map((beat) => beat.time)).toEqual([0.54, 0.81, 1.48]);
  });

  test("高BPMでは強い表拍側を選んで過密な譜面を避ける", () => {
    const beats = alignBeatsToTempoGrid(
      [
        onset(0.433, 1),
        onset(1.1, 1),
        onset(1.767, 1),
      ],
      2.2,
      { bpm: 180, offset: 0.1 },
    );

    expect(beats[0]?.time).toBeCloseTo(0.433, 2);
    expect((beats[1]?.time ?? 0) - (beats[0]?.time ?? 0)).toBeGreaterThan(0.6);
  });

  test("無音区間はonsetがなければ判定点を置かない", () => {
    const beats = alignBeatsToTempoGrid(
      [onset(1, 0.9)],
      2.5,
      { bpm: 120, offset: 0 },
      (time) => time >= 0.9 && time <= 1.1,
    );

    expect(beats.map((beat) => beat.time)).toEqual([1]);
  });
});

describe("alignBeatsToTempoMap", () => {
  test("区間ごとのBPMを対応する範囲だけへ適用する", () => {
    const beats = alignBeatsToTempoMap(
      [
        onset(0.5, 0.9),
        onset(1, 0.9),
        onset(1.5, 0.9),
        onset(2.7, 0.9),
        onset(3.3, 0.9),
      ],
      4,
      [
        { start: 0, end: 2, bpm: 120, offset: 0 },
        { start: 2, end: 4, bpm: 100, offset: 2.1 },
      ],
    );

    expect(beats.map((beat) => beat.time)).toEqual([
      0.5,
      1,
      1.5,
      2.1,
      2.7,
      3.3,
    ]);
    // 前半の120 BPMグリッド（0.5秒間隔）が後半まで漏れていない。
    expect(beats.some((beat) => beat.time === 2.5)).toBe(false);
  });
});

describe("MicrophoneInput settings", () => {
  test("手動閾値をメーターの安全な範囲へ収め、自動へ戻せる", () => {
    const microphone = new MicrophoneInput();

    microphone.setManualThreshold(1);
    expect(microphone.thresholdMode).toBe("manual");
    expect(microphone.threshold).toBe(MICROPHONE_THRESHOLD_RANGE.maximum);

    microphone.useAutomaticThreshold();
    expect(microphone.thresholdMode).toBe("automatic");
    expect(microphone.threshold).toBeCloseTo(0.0186, 4);
  });

  test("ストリーム取得前でも次回のノイズ抑制希望値を保持する", async () => {
    const microphone = new MicrophoneInput();

    expect(await microphone.setNoiseSuppression(true)).toBe(true);
    expect(microphone.noiseSuppression).toBe(true);
  });
});
