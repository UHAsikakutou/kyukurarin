import { describe, expect, test } from "bun:test";
import { alignBeatsToTempoGrid } from "./audio";

describe("alignBeatsToTempoGrid", () => {
  test("BPMとoffsetから一定間隔の判定点を作る", () => {
    const beats = alignBeatsToTempoGrid(
      [
        { time: 0.49, strength: 0.8 },
        { time: 1.01, strength: 0.7 },
      ],
      3,
      { bpm: 120, offset: 0 },
    );

    expect(beats.map((beat) => beat.time)).toEqual([0.5, 1, 1.5, 2, 2.5]);
    expect(beats[0]?.strength).toBeGreaterThan(0.35);
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
