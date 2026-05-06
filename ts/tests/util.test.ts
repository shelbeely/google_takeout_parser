import { describe, expect, test } from "bun:test";
import { parseDatetimeMillis, parseDatetimeSec, parseJsonUtcDate } from "../src/time/index.ts";
import { convertToHttps, convertToHttpsOpt } from "../src/util/httpAllowlist.ts";

describe("httpAllowlist", () => {
  test("upgrades google domains", () => {
    expect(convertToHttps("http://www.google.com/")).toBe("https://www.google.com/");
    expect(convertToHttps("http://m.youtube.com/watch?v=x")).toBe(
      "https://m.youtube.com/watch?v=x",
    );
  });
  test("leaves unrelated domains alone", () => {
    expect(convertToHttps("http://example.com/")).toBe("http://example.com/");
  });
  test("returns null for null input", () => {
    expect(convertToHttpsOpt(null)).toBeNull();
    expect(convertToHttpsOpt(undefined)).toBeNull();
  });
});

describe("time parsing", () => {
  test("parseJsonUtcDate handles trailing Z and microseconds", () => {
    expect(parseJsonUtcDate("2021-09-30T01:44:33.000Z").toISOString()).toBe(
      "2021-09-30T01:44:33.000Z",
    );
    expect(parseJsonUtcDate("2023-01-27T22:46:47.389Z").getTime()).toBe(
      Date.UTC(2023, 0, 27, 22, 46, 47, 389),
    );
  });
  test("parseDatetimeSec / Millis", () => {
    expect(parseDatetimeSec("1700000000").toISOString()).toBe("2023-11-14T22:13:20.000Z");
    expect(parseDatetimeMillis("1700000000000").toISOString()).toBe("2023-11-14T22:13:20.000Z");
  });
});
