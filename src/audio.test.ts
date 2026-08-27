import { describe, expect, test } from "bun:test";
import {
  MICROPHONE_THRESHOLD_RANGE,
  MicrophoneInput,
  alignBeatsToTempoGrid,
  alignBeatsToTempoMap,
} from "./audio";

describe("alignBeatsToTempoGrid", () => {
  test("BPMとoffsetの骨格を近傍onsetへ合わせる", () => {
    const beats = alignBeatsToTempoGrid(
      [
        { time: 0.49, strength: 0.8 },
        { time: 1.01, strength: 0.7 },
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
        { time: 0.54, strength: 0.8 },
        { time: 0.81, strength: 0.9 },
        { time: 1.48, strength: 0.7 },
      ],
      2.2,
      { bpm: 120, offset: 0 },
    );

    expect(beats.map((beat) => beat.time)).toEqual([0.54, 0.81, 1.48]);
  });

  test("高BPMでは強い表拍側を選んで過密な譜面を避ける", () => {
    const beats = alignBeatsToTempoGrid(
      [
        { time: 0.433, strength: 1 },
        { time: 1.1, strength: 1 },
        { time: 1.767, strength: 1 },
      ],
      2.2,
      { bpm: 180, offset: 0.1 },
    );

    expect(beats[0]?.time).toBeCloseTo(0.433, 2);
    expect((beats[1]?.time ?? 0) - (beats[0]?.time ?? 0)).toBeGreaterThan(0.6);
  });

  test("無音区間はonsetがなければ判定点を置かない", () => {
    const beats = alignBeatsToTempoGrid(
      [{ time: 1, strength: 0.9 }],
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
        { time: 0.5, strength: 0.9 },
        { time: 1, strength: 0.9 },
        { time: 1.5, strength: 0.9 },
        { time: 2.7, strength: 0.9 },
        { time: 3.3, strength: 0.9 },
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
