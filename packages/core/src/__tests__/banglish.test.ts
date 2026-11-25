import { describe, expect, it } from "vitest";
import {
  SUPPORTED_CAPTION_LANGUAGES,
  analysisConfigSchema,
  containsBengaliScript,
  transliterateBengaliToBanglish,
} from "../index.js";

describe("Bengali to Banglish transliteration", () => {
  it("transliterates Bengali podcast phrases into readable Romanized Banglish", () => {
    const out = transliterateBengaliToBanglish("আজকে বাংলা পডকাস্ট কেমন হলো ভাই?");
    expect(containsBengaliScript(out)).toBe(false);
    expect(out.toLowerCase()).toContain("ajke");
    expect(out.toLowerCase()).toContain("bangla");
    expect(out.toLowerCase()).toContain("kemon");
    expect(out.toLowerCase()).toContain("bhai?");
  });

  it("preserves mixed English words, numbers, and Bengali numerals", () => {
    const out = transliterateBengaliToBanglish("Podcast episode ১২৩ super hit!");
    expect(out).toBe("Podcast episode 123 super hit!");
  });

  it("includes Bangla and Banglish in supported caption languages and schemas", () => {
    const codes = SUPPORTED_CAPTION_LANGUAGES.map((l) => l.code);
    expect(codes).toContain("bn");
    expect(codes).toContain("bn_en");

    expect(
      analysisConfigSchema.safeParse({ captionLanguage: "bn_en" }).success,
    ).toBe(true);
    expect(
      analysisConfigSchema.safeParse({ captionLanguage: "bn" }).success,
    ).toBe(true);
  });
});
