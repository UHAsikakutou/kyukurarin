import { describe, expect, test } from "bun:test";
import { RhythmGame } from "./game";

const makeBeats = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    time: index + 1,
    strength: 1,
    contributions: { bass: 1, mid: 0, high: 0 },
    source: "onset" as const,
  }));

describe("RhythmGame", () => {
  test("判定窓内の入力だけが同じbeatを一度claimする", () => {
    const game = new RhythmGame();
    game.configure(makeBeats(2));
    game.startFresh();

    expect(game.registerInput(0.861, 10).kind).toBe("ok");
    expect(game.registerInput(0.9, 20).kind).toBe("ng");
    expect(game.hits).toBe(1);
    expect(game.strayInputs).toBe(1);
  });

  test("OK→NG→OKで中央が空いた列を保つ", () => {
    const game = new RhythmGame();
    game.configure(makeBeats(3));
    game.startFresh();

    game.registerInput(1, 10);
    game.advance(1, 10);
    game.advance(2.21, 20);
    game.registerInput(3, 30);
    game.advance(3, 30);

    expect(game.pieces.map((piece) => piece.column)).toEqual([2, 4]);
    expect(game.misses).toBe(1);
  });

  test("画像番号は7枚の次に1枚目へ戻る", () => {
    const game = new RhythmGame();
    game.configure(makeBeats(8));
    game.startFresh();

    for (let index = 0; index < 8; index += 1) {
      game.registerInput(index + 1, index * 10);
      game.advance(index + 1, index * 10);
    }

    expect(game.pieces.at(-1)?.imageIndex).toBe(0);
  });

  test("獲得済み画像がすべて流れた後のmissでgameover", () => {
    const game = new RhythmGame();
    game.configure(makeBeats(8));
    game.startFresh();
    game.registerInput(1, 0);
    game.advance(1, 0);

    for (let time = 2; time <= 8; time += 1) game.advance(time + 0.21, time * 10);

    expect(game.visiblePieceCount).toBe(0);
    expect(game.phase).toBe("gameover");
  });

  test("曲終了時に画像が残っていればclear", () => {
    const game = new RhythmGame();
    game.configure(makeBeats(1));
    game.startFresh();
    game.registerInput(1, 0);
    game.advance(1, 0);

    expect(game.finish()).toBe("clear");
  });

  test("最後のdraw前にendedが来ても直前のOKを画像へ反映する", () => {
    const game = new RhythmGame();
    game.configure(makeBeats(1));
    game.startFresh();
    expect(game.registerInput(1, 10).kind).toBe("perfect");

    expect(game.finish(20)).toBe("clear");
    expect(game.visiblePieceCount).toBe(1);
  });
});
