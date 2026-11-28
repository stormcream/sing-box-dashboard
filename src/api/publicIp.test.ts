import { describe, expect, it } from "vitest";

import { publicCountryName, publicPlaceName } from "./publicIp";

describe("publicCountryName", () => {
  it("prefers the code table over the source label", () => {
    expect(publicCountryName({ ip: "", countryCode: "SG", country: "Singapore", place: [] }, "zh-Hans")).toBe(
      "新加坡",
    );
    expect(
      publicCountryName({ ip: "", countryCode: "SG", country: "Singapore", place: [] }, "en"),
    ).toBe("Singapore");
  });

  it("falls back to the source label for unmapped codes", () => {
    expect(
      publicCountryName({ ip: "", countryCode: "ZZ", country: "Nowhere", place: [] }, "zh-Hans"),
    ).toBe("Nowhere");
  });
});

describe("publicPlaceName", () => {
  it("keeps Chinese labels for Chinese UIs", () => {
    expect(
      publicPlaceName({ ip: "", countryCode: "", country: "中国", place: ["上海"] }, "zh-Hant"),
    ).toBe("上海");
  });

  it("translates the domestic source's country labels for other languages", () => {
    expect(
      publicPlaceName({ ip: "", countryCode: "", country: "中国", place: ["天津", "美国"] }, "en"),
    ).toBe("天津, United States");
  });

  it("joins several labels with commas", () => {
    expect(publicPlaceName({ ip: "", countryCode: "", country: "", place: ["Region", "City"] }, "en")).toBe(
      "Region, City",
    );
  });
});
