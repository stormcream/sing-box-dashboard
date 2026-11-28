// Public IP lookup against third-party GeoIP endpoints.
//
// The daemon exposes no RPC for this, so the browser queries the services
// directly. Each direction asks services on its own side of the route: if the
// config sends domestic and foreign traffic through different outbounds, the
// two replies differ, and the overview shows both exits at once.

export interface PublicIpResult {
  ip: string;
  /** ISO 3166-1 alpha-2 code; empty when the source does not report one. */
  countryCode: string;
  /** Country label as the source reported it. */
  country: string;
  /** Region/city labels as the source reported them, country label dropped. */
  place: string[];
}

export type LookupDirection = "china" | "foreign";

interface IpSource {
  url: string;
  parse(body: unknown): PublicIpResult | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Drops empty labels and ones repeating an earlier label. */
function unique(parts: string[]): string[] {
  return parts.filter((part, index) => part !== "" && parts.indexOf(part) === index);
}

const IPWHO: IpSource = {
  url: "https://ipwho.is/",
  parse(body) {
    if (!isRecord(body) || body.success === false || text(body.ip) === "") {
      return null;
    }
    const country = text(body.country);
    return {
      ip: text(body.ip),
      countryCode: text(body.country_code).toUpperCase(),
      country,
      place: unique([country, text(body.region), text(body.city)]).slice(1),
    };
  },
};

const IP_SB: IpSource = {
  url: "https://api.ip.sb/geoip",
  parse(body) {
    if (!isRecord(body) || text(body.ip) === "") {
      return null;
    }
    const country = text(body.country);
    return {
      ip: text(body.ip),
      countryCode: text(body.country_code).toUpperCase(),
      country,
      place: unique([country, text(body.city)]).slice(1),
    };
  },
};

const IPINFO: IpSource = {
  url: "https://ipinfo.io/json",
  parse(body) {
    if (!isRecord(body) || text(body.ip) === "") {
      return null;
    }
    return {
      ip: text(body.ip),
      countryCode: text(body.country).toUpperCase(),
      country: "",
      place: unique([text(body.region), text(body.city)]),
    };
  },
};

const MIR6: IpSource = {
  url: "https://api.mir6.com/api/ip?ip=&type=json",
  parse(body) {
    if (!isRecord(body) || body.code !== 200 || !isRecord(body.data)) {
      return null;
    }
    const ip = text(body.data.ip);
    const country = text(body.data.country);
    return {
      ip,
      countryCode: text(body.data.countryCode).toUpperCase(),
      country,
      place: unique([country, text(body.data.province), text(body.data.city)]).slice(1),
    };
  },
};

const ZXINC: IpSource = {
  url: "https://ip.zxinc.org/api.php?type=json",
  parse(body) {
    if (!isRecord(body) || body.code !== 0 || !isRecord(body.data)) {
      return null;
    }
    const ip = text(body.data.myip);
    if (ip === "") {
      return null;
    }
    const [country = "", ...place] = unique(text(body.data.country).split("–"));
    return { ip, countryCode: "", country, place };
  },
};

// Ordered by preference; the first source whose reply parses wins. Each list
// stays on its own side of the route so a reply from one side never stands in
// for the exit of the other.
const SOURCES: Record<LookupDirection, IpSource[]> = {
  china: [MIR6, ZXINC],
  foreign: [IPWHO, IP_SB, IPINFO],
};

const LOOKUP_TIMEOUT_MS = 8000;

async function request(source: IpSource, signal?: AbortSignal): Promise<PublicIpResult> {
  const response = await fetch(source.url, {
    cache: "no-store",
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const parsed = source.parse((await response.json()) as unknown);
  if (parsed === null) {
    throw new Error("Unexpected response");
  }
  return parsed;
}

/** Queries one direction, moving to the next source when one fails. */
export async function lookupPublicIp(
  direction: LookupDirection,
  signal?: AbortSignal,
): Promise<PublicIpResult> {
  let lastError: unknown = null;
  for (const source of SOURCES[direction]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await request(source, controller.signal);
    } catch (error) {
      if (signal?.aborted) {
        break;
      }
      lastError = error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
  throw lastError ?? new DOMException("The operation was aborted.", "AbortError");
}

/** Country labels in the dashboard's languages, keyed by ISO country code. */
const COUNTRY_NAMES: Record<string, [string, string]> = {
  CN: ["中国", "China"],
  HK: ["香港", "Hong Kong"],
  MO: ["澳门", "Macao"],
  TW: ["台湾", "Taiwan"],
  US: ["美国", "United States"],
  CA: ["加拿大", "Canada"],
  GB: ["英国", "United Kingdom"],
  DE: ["德国", "Germany"],
  FR: ["法国", "France"],
  NL: ["荷兰", "Netherlands"],
  RU: ["俄罗斯", "Russia"],
  JP: ["日本", "Japan"],
  KR: ["韩国", "Korea"],
  SG: ["新加坡", "Singapore"],
  MY: ["马来西亚", "Malaysia"],
  TH: ["泰国", "Thailand"],
  VN: ["越南", "Vietnam"],
  PH: ["菲律宾", "Philippines"],
  ID: ["印度尼西亚", "Indonesia"],
  IN: ["印度", "India"],
  AU: ["澳大利亚", "Australia"],
  BR: ["巴西", "Brazil"],
};

/** The domestic sources answer in Chinese only, so map their labels back. */
const CODES_BY_CHINESE_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(COUNTRY_NAMES).map(([code, [zh]]) => [zh, code]),
);

function isChinese(language: string): boolean {
  return language === "zh-Hans" || language === "zh-Hant";
}

/** Country label for the UI language, or "" when the source reported none. */
export function publicCountryName(result: PublicIpResult, language: string): string {
  const names = COUNTRY_NAMES[result.countryCode];
  if (names !== undefined) {
    return isChinese(language) ? names[0] : names[1];
  }
  return result.country;
}

/** Region and city labels for the UI language, comma joined. */
export function publicPlaceName(result: PublicIpResult, language: string): string {
  if (isChinese(language)) {
    return result.place.join(", ");
  }
  return result.place
    .map((label) => {
      const code = CODES_BY_CHINESE_NAME[label];
      const names = code === undefined ? undefined : COUNTRY_NAMES[code];
      return names === undefined ? label : names[1];
    })
    .join(", ");
}
