import { describe, expect, it } from "vitest";
import { distribute, type FamilyLoad } from "../src/modules/fairness";

const fam = (key: string, load = 0, lastAt = 0): FamilyLoad => ({ key, assigneeId: `p-${key}`, name: key, load, lastAt });
const items = (n: number, skip?: Record<number, string[]>) =>
  Array.from({ length: n }, (_, i) => ({ id: `t${i}`, skip: skip?.[i] ? new Set(skip[i]) : undefined }));
const who = (m: Map<string, string>) => [...m.values()].map((v) => v.slice(2));

describe("retfærdig fordeling", () => {
  it("giver alle en opgave, før nogen får to", () => {
    const out = distribute([fam("a"), fam("b"), fam("c")], items(6));
    const counts = who(out).reduce<Record<string, number>>((c, k) => ({ ...c, [k]: (c[k] ?? 0) + 1 }), {});
    expect(counts).toEqual({ a: 2, b: 2, c: 2 });
    expect(who(out).slice(0, 3).sort()).toEqual(["a", "b", "c"]);
  });

  it("starter hos dem, der har haft færrest", () => {
    expect(who(distribute([fam("a", 3), fam("b", 1), fam("c", 2)], items(2)))).toEqual(["b", "c"]);
  });

  it("vælger ved lighed den, der længst har været uden", () => {
    expect(who(distribute([fam("a", 1, 500), fam("b", 1, 100), fam("c", 1, 300)], items(3)))).toEqual(["b", "c", "a"]);
  });

  it("er deterministisk ved fuld lighed: efter navn", () => {
    expect(who(distribute([fam("c"), fam("a"), fam("b")], items(3)))).toEqual(["a", "b", "c"]);
  });

  it("springer familier over, der har meldt fra, men falder tilbage hvis alle har", () => {
    expect(who(distribute([fam("a"), fam("b")], items(2, { 0: ["a"] })))).toEqual(["b", "a"]);
    expect(who(distribute([fam("a"), fam("b")], items(1, { 0: ["a", "b"] })))).toEqual(["a"]);
  });

  it("giver ingenting uden familier", () => {
    expect(distribute([], items(3)).size).toBe(0);
  });
});
