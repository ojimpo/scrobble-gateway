import { describe, expect, it } from "vitest";
import { assertDateRange, parseDateTime, periodStart } from "../src/time.js";

describe("time helpers", () => {
  it("accepts Unix seconds and timezone-aware ISO timestamps", () => {
    expect(parseDateTime("1722470400", "from")).toBe(1_722_470_400);
    expect(parseDateTime("2024-08-01T00:00:00Z", "from")).toBe(1_722_470_400);
    expect(parseDateTime("2024-08-01T04:00:00+04:00", "from")).toBe(1_722_470_400);
  });

  it("accepts UTC date-only values but rejects ambiguous local date-times and reversed ranges", () => {
    expect(parseDateTime("2024-08-01", "from")).toBe(1_722_470_400);
    expect(parseDateTime("2024-08-01", "to")).toBe(1_722_556_799);
    expect(() => parseDateTime("2024-08-01T12:00:00", "from")).toThrow(/timezone/);
    expect(() => assertDateRange(20, 10)).toThrow(/from/);
  });

  it("converts standard chart periods to rolling starts", () => {
    const now = Math.floor(Date.parse("2026-08-06T00:00:00Z") / 1_000);
    expect(periodStart("overall", now)).toBeUndefined();
    expect(periodStart("7day", now)).toBe(now - 7 * 86_400);
    expect(new Date((periodStart("3month", now) ?? 0) * 1_000).toISOString()).toBe("2026-05-06T00:00:00.000Z");
    const monthEnd = Math.floor(Date.parse("2025-03-31T12:00:00Z") / 1_000);
    expect(new Date((periodStart("1month", monthEnd) ?? 0) * 1_000).toISOString()).toBe("2025-02-28T12:00:00.000Z");
  });
});
