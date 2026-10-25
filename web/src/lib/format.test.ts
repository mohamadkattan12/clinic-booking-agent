import { describe, expect, it } from "vitest";
import { riyadhDateTime, riyadhTime, sar } from "./format";

describe("format", () => {
  it("shows clinic times in Riyadh whatever the browser's time zone", () => {
    expect(riyadhTime("2026-10-26T06:00:00Z")).toBe("09:00");
    expect(riyadhDateTime("2026-10-26T09:00:00+03:00")).toContain("Monday");
  });

  it("formats VAT-inclusive prices from halalas", () => {
    expect(sar(25000)).toBe("250 SAR");
    expect(sar(120000)).toBe("1,200 SAR");
  });
});
