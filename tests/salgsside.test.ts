// Salgssidens data: HoldLivs pris er én konfigurationsværdi, og konkurrentpriser har kilde og dato.
import { afterEach, describe, expect, it } from "vitest";
import { COMPARISON, COMPETITORS, COMPETITOR_CHECKED, holdlivPriceText } from "../src/lib/priser";

afterEach(() => {
  delete process.env.HOLDLIV_PRICE_TEXT;
});

describe("HoldLivs pris", () => {
  it("er ikke sat som standard, så siden viser 'Pris kommer snart'", () => {
    expect(holdlivPriceText()).toBeNull();
  });
  it("læses fra én værdi og ignorerer tom tekst", () => {
    process.env.HOLDLIV_PRICE_TEXT = "  249 kr./md. ";
    expect(holdlivPriceText()).toBe("249 kr./md.");
    process.env.HOLDLIV_PRICE_TEXT = "   ";
    expect(holdlivPriceText()).toBeNull();
  });
});

describe("konkurrentdata", () => {
  it("har kilde med https-adresse og en dato", () => {
    expect(COMPETITOR_CHECKED).toMatch(/\d{4}$/);
    expect(COMPETITORS.map((c) => c.name)).toEqual(["Klubmodul", "Holdsport"]);
    for (const c of COMPETITORS) {
      expect(c.source.url).toMatch(/^https:\/\//);
      expect(c.lines.length).toBeGreaterThan(0);
    }
  });
  it("viser også det HoldLiv mangler, og har unikke rækker", () => {
    expect(new Set(COMPARISON.map((r) => r.area)).size).toBe(COMPARISON.length);
    expect(COMPARISON.some((r) => r.holdliv === "nej")).toBe(true);
    expect(COMPARISON.some((r) => r.holdliv === "ja")).toBe(true);
  });
});
