import { describe, it, expect } from "vitest";
import { serializeJson } from "../lib/http";
import { formatBytes, formatTime, formatTimePrecise } from "../lib/utils";

describe("Web serialization and formatting utilities", () => {
  it("serializes BigInt fields cleanly to JSON numbers", () => {
    const out = serializeJson({
      id: "job_1",
      sourceFileSizeBytes: BigInt(1048576),
      nested: { outputFileSizeBytes: BigInt(2048) },
    }) as {
      id: string;
      sourceFileSizeBytes: number;
      nested: { outputFileSizeBytes: number };
    };

    expect(out.sourceFileSizeBytes).toBe(1048576);
    expect(out.nested.outputFileSizeBytes).toBe(2048);
  });

  it("formats durations and byte sizes accurately", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(75)).toBe("1:15");
    expect(formatTime(3661)).toBe("1:01:01");
    expect(formatTimePrecise(65.4)).toBe("1:05.4");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
  });
});
