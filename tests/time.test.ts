import { describe, expect, it } from "vitest";
import {
  formatTimestamp,
  parseIso8601Duration,
  parseTimeInput,
} from "../src/utils/time.js";

describe("time utilities", () => {
  it("parses ISO 8601 YouTube durations", () => {
    expect(parseIso8601Duration("PT1H2M3S")).toBe(3_723);
    expect(parseIso8601Duration("PT45S")).toBe(45);
    expect(parseIso8601Duration("P1DT1M")).toBe(86_460);
  });

  it("parses user-friendly time inputs", () => {
    expect(parseTimeInput(90)).toBe(90);
    expect(parseTimeInput("1:30")).toBe(90);
    expect(parseTimeInput("1:02:03")).toBe(3_723);
    expect(parseTimeInput("1h2m3s")).toBe(3_723);
  });

  it("formats transcript timestamps", () => {
    expect(formatTimestamp(65.9)).toBe("1:05");
    expect(formatTimestamp(3_723)).toBe("1:02:03");
  });
});
