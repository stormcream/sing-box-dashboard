import type { Connection, LogLevel } from "../gen/daemon/started_service_pb";
import { stripAnsi } from "../lib/ansi";
import type { ConnectionRow, ConnectionsData, LogEntry, LogsData } from "./daemon";
import type { StreamStore } from "./stream";

const MAX_FLOWS = 2048;
const MAX_FLOW_LINES = 64;
const FLOW_HEAD_LINES = 40;
const MAX_DNS_EVENTS = 2048;
const MAX_DNS_LINES = 48;
const MATCH_THRESHOLD = 150;
const FLOW_MATCH_TIME_MS = 5_000;
const DNS_LINK_WINDOW_MS = 10 * 60_000;
const NOTIFY_INTERVAL_MS = 200;

export type LogLineKind =
  | "inbound"
  | "outbound"
  | "dns"
  | "router"
  | "connection"
  | "other"
  | "none";

export interface ParsedLogLine {
  id: number;
  level: LogLevel;
  receivedAt: number;
  serverTime: number | null;
  levelSeconds: number | null;
  flowId: number | null;
  elapsedMs: number | null;
  elapsedText: string | null;
  tag: string | null;
  kind: LogLineKind;
  ownerType: string | null;
  ownerTag: string | null;
  body: string;
  text: string;
  raw: string;
}

export interface RuleMatch {
  phase: "match" | "pre-match" | "armed";
  index: number;
  rule: string | null;
  action: string | null;
  line: ParsedLogLine;
}

export interface DnsAnswer {
  recordType: string;
  name: string;
  ttl: number | null;
  value: string;
  raw: string;
}

export interface DnsEvent {
  flowId: number | null;
  name: string;
  queryTypes: string[];
  server: string | null;
  rcode: string | null;
  ttl: number | null;
  disposition: string | null;
  answers: DnsAnswer[];
  lookupAddresses: string[];
  lines: ParsedLogLine[];
  firstTime: number | null;
  lastTime: number | null;
}

export interface FlowTrace {
  flowId: number;
  lines: ParsedLogLine[];
  lineCount: number;
  truncated: boolean;
  firstTime: number | null;
  lastTime: number | null;
  firstReceivedAt: number;
  lastReceivedAt: number;
  inboundType: string | null;
  inboundTag: string | null;
  source: string | null;
  destination: string | null;
  domain: string | null;
  protocol: string | null;
  outboundType: string | null;
  outboundTag: string | null;
  ruleMatches: RuleMatch[];
  dns: DnsEvent | null;
  isDnsFlow: boolean;
}

export type DnsLinkVia = "flow" | "ip" | "domain-time";

export interface DnsLink {
  event: DnsEvent;
  flow: FlowTrace | null;
  via: DnsLinkVia;
}

export interface ConnectionTrace {
  flow: FlowTrace | null;
  dns: DnsLink | null;
  dnsCandidates: number;
}

const DNS_SUMMARY_RE =
  /^(cached|optimistic|exchanged|refreshed|rejected) (\S+) (NOERROR|FORMERR|SERVFAIL|NXDOMAIN|NOTIMP|REFUSED|[A-Z]+)(?: (\d+))?$/;

function parseElapsedMs(value: string): number | null {
  let match = /^(\d+)ms$/.exec(value);
  if (match) {
    return Number(match[1]);
  }
  match = /^(\d+)\.(\d+)s$/.exec(value);
  if (match) {
    return Number(match[1]) * 1000 + Number(match[2].padEnd(2, "0").slice(0, 2)) * 10;
  }
  match = /^(\d+)m(\d+)s$/.exec(value);
  if (match) {
    return Number(match[1]) * 60_000 + Number(match[2]) * 1000;
  }
  return null;
}

function parseQuestion(value: string): { name: string; qtype: string } | null {
  const match = /^(.+?)\.? IN ([A-Z0-9]+)$/.exec(value);
  if (!match) {
    return null;
  }
  return { name: match[1], qtype: match[2] };
}

function parseDnsRecord(body: string): DnsAnswer | null {
  const match =
    /^(?:cached|optimistic|exchanged|refreshed|rejected) ([A-Z0-9]+) (.+?)\. (\d+) IN ([A-Z0-9]+) ([\s\S]+)$/.exec(
      body,
    );
  if (!match) {
    return null;
  }
  return {
    recordType: match[4],
    name: match[2],
    ttl: Number(match[3]),
    value: match[5].trim(),
    raw: body,
  };
}

function normalizeDomain(value: string): string {
  return value.trim().replace(/\.$/, "").toLowerCase();
}

function normalizeHost(value: string): string {
  return value.trim().replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}

export function hostOf(address: string): string {
  if (address === "") {
    return "";
  }
  if (address.startsWith("[")) {
    const end = address.indexOf("]");
    if (end > 0) {
      return address.slice(1, end);
    }
  }
  const index = address.lastIndexOf(":");
  return index > 0 ? address.slice(0, index) : address;
}

export function splitAddress(address: string): { host: string; port: string } {
  if (address === "") {
    return { host: "", port: "" };
  }
  if (address.startsWith("[")) {
    const end = address.indexOf("]");
    if (end > 0) {
      return { host: address.slice(1, end), port: address.slice(end + 1).replace(/^:/, "") };
    }
  }
  const index = address.lastIndexOf(":");
  if (index > 0) {
    return { host: address.slice(0, index), port: address.slice(index + 1) };
  }
  return { host: address, port: "" };
}

export function parseLogMessage(entry: LogEntry, serverStartMs: number | null): ParsedLogLine {
  const text = stripAnsi(entry.message);
  let rest = text;
  let levelSeconds: number | null = null;
  const levelMatch = /^[A-Z]+\[(\d+)\] /.exec(rest);
  if (levelMatch) {
    levelSeconds = Number(levelMatch[1]);
    rest = rest.slice(levelMatch[0].length);
  }

  let flowId: number | null = null;
  let elapsedText: string | null = null;
  let elapsedMs: number | null = null;
  const flowMatch = /^\[(\d+) ((?:\d+ms)|(?:\d+\.\d+s)|(?:\d+m\d+s))\] /.exec(rest);
  if (flowMatch) {
    flowId = Number(flowMatch[1]);
    elapsedText = flowMatch[2];
    elapsedMs = parseElapsedMs(elapsedText);
    rest = rest.slice(flowMatch[0].length);
  }

  let tag: string | null = null;
  let body = rest;
  const tagMatch = /^([a-z][a-z0-9+._-]*(?:\/[a-z0-9+._-]+)?(?:\[[^\]]*\])?): ([\s\S]*)$/.exec(rest);
  if (tagMatch) {
    tag = tagMatch[1];
    body = tagMatch[2];
  }

  let kind: LogLineKind = "none";
  let ownerType: string | null = null;
  let ownerTag: string | null = null;
  if (tag !== null) {
    const owned = /^(inbound|outbound|dns)\/([^[]+)\[([^\]]*)\]$/.exec(tag);
    if (owned) {
      kind = owned[1] as LogLineKind;
      ownerType = owned[2];
      ownerTag = owned[3];
    } else if (tag === "dns") {
      kind = "dns";
    } else if (tag === "router") {
      kind = "router";
    } else if (tag === "connection") {
      kind = "connection";
    } else {
      kind = "other";
    }
  }

  return {
    id: entry.id,
    level: entry.level,
    receivedAt: entry.receivedAt,
    serverTime:
      serverStartMs !== null && levelSeconds !== null ? serverStartMs + levelSeconds * 1000 : null,
    levelSeconds,
    flowId,
    elapsedMs,
    elapsedText,
    tag,
    kind,
    ownerType,
    ownerTag,
    body,
    text,
    raw: entry.message,
  };
}

function scoreFlowConnection(flow: FlowTrace, connection: Connection): number {
  let score = 0;
  let affinity = false;
  if (flow.inboundTag !== null && connection.inbound !== "" && flow.inboundTag === connection.inbound) {
    score += 100;
    affinity = true;
  } else if (
    flow.inboundType !== null &&
    connection.inboundType !== "" &&
    flow.inboundType === connection.inboundType
  ) {
    score += 20;
    affinity = true;
  }
  if (flow.source !== null && connection.source !== "") {
    if (flow.source === connection.source) {
      score += 80;
    } else {
      score -= 40;
    }
  }
  if (
    flow.destination !== null &&
    connection.destination !== "" &&
    flow.destination === connection.destination
  ) {
    score += 40;
  }
  if (
    flow.domain !== null &&
    connection.domain !== "" &&
    normalizeDomain(flow.domain) === normalizeDomain(connection.domain)
  ) {
    score += 30;
  }
  const createdAt = Number(connection.createdAt);
  if (flow.firstTime !== null && createdAt > 0) {
    const delta = Math.abs(flow.firstTime - createdAt);
    if (delta <= FLOW_MATCH_TIME_MS) {
      score += 30;
    } else if (delta <= 60_000) {
      score += 10;
    } else {
      score -= 40;
    }
  }
  if (!affinity) {
    score -= 60;
  }
  return score;
}

function emptyFlow(flowId: number, line: ParsedLogLine): FlowTrace {
  return {
    flowId,
    lines: [],
    lineCount: 0,
    truncated: false,
    firstTime: null,
    lastTime: null,
    firstReceivedAt: line.receivedAt,
    lastReceivedAt: line.receivedAt,
    inboundType: null,
    inboundTag: null,
    source: null,
    destination: null,
    domain: null,
    protocol: null,
    outboundType: null,
    outboundTag: null,
    ruleMatches: [],
    dns: null,
    isDnsFlow: false,
  };
}

function emptyDnsEvent(flowId: number | null): DnsEvent {
  return {
    flowId,
    name: "",
    queryTypes: [],
    server: null,
    rcode: null,
    ttl: null,
    disposition: null,
    answers: [],
    lookupAddresses: [],
    lines: [],
    firstTime: null,
    lastTime: null,
  };
}

export class TraceIndex {
  private flows = new Map<number, FlowTrace>();
  private dnsEvents: DnsEvent[] = [];
  private rows: Map<string, ConnectionRow> = new Map();
  private connectionFlows = new Map<string, FlowTrace>();
  private flowConnectionIds = new Map<number, string>();
  private matchAttempted = new Set<number>();
  private seenConnectionIds = new Set<string>();
  private serverStartMs: number | null = null;
  private lastLogId = -1;

  setServerStart(startedAtMs: number): void {
    if (Number.isFinite(startedAtMs) && startedAtMs > 0) {
      this.serverStartMs = startedAtMs;
    }
  }

  getServerStart(): number | null {
    return this.serverStartMs;
  }

  ingest(entries: LogEntry[]): number {
    if (entries.length === 0) {
      return 0;
    }
    let low = 0;
    let high = entries.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (entries[middle].id <= this.lastLogId) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    if (low >= entries.length) {
      return 0;
    }
    const fresh = entries.slice(low);
    if (this.serverStartMs === null) {
      let bestSeconds = -1;
      let bestReceivedAt = 0;
      for (const entry of fresh) {
        const match = /^[A-Z]+\[(\d+)\] /.exec(stripAnsi(entry.message));
        if (match) {
          const seconds = Number(match[1]);
          if (seconds > bestSeconds) {
            bestSeconds = seconds;
            bestReceivedAt = entry.receivedAt;
          }
        }
      }
      if (bestSeconds >= 0 && bestReceivedAt > 0) {
        this.serverStartMs = bestReceivedAt - bestSeconds * 1000;
      }
    }
    for (const entry of fresh) {
      this.ingestEntry(entry);
    }
    this.lastLogId = fresh[fresh.length - 1].id;
    return fresh.length;
  }

  setRows(rows: Map<string, ConnectionRow>): void {
    this.rows = rows;
    for (const id of Array.from(this.connectionFlows.keys())) {
      if (!rows.has(id)) {
        const flow = this.connectionFlows.get(id);
        this.connectionFlows.delete(id);
        if (flow !== undefined) {
          this.flowConnectionIds.delete(flow.flowId);
        }
      }
    }
    for (const id of Array.from(this.seenConnectionIds)) {
      if (!rows.has(id)) {
        this.seenConnectionIds.delete(id);
      }
    }
    for (const [id, row] of rows) {
      if (this.seenConnectionIds.has(id)) {
        continue;
      }
      this.seenConnectionIds.add(id);
      const flow = this.findFlowForConnection(row.connection);
      if (flow !== null) {
        this.cacheMatch(flow, id);
      }
    }
  }

  findConnectionForFlow(flowId: number): ConnectionRow | null {
    const flow = this.flows.get(flowId);
    if (flow === undefined) {
      const cachedId = this.flowConnectionIds.get(flowId);
      return cachedId !== undefined ? (this.rows.get(cachedId) ?? null) : null;
    }
    const row = this.findBestRowForFlow(flow);
    if (row !== null) {
      this.cacheMatch(flow, row.connection.id);
    }
    return row;
  }

  getFlow(flowId: number): FlowTrace | null {
    return this.flows.get(flowId) ?? null;
  }

  getConnectionTrace(connection: Connection): ConnectionTrace {
    const flow = this.findFlowForConnection(connection);
    if (flow !== null && flow.dns !== null) {
      return { flow, dns: { event: flow.dns, flow, via: "flow" }, dnsCandidates: 1 };
    }
    const { link, candidates } = this.findDnsLink(connection, flow);
    return { flow, dns: link, dnsCandidates: candidates };
  }

  private ingestEntry(entry: LogEntry): void {
    const line = parseLogMessage(entry, this.serverStartMs);
    if (line.flowId === null) {
      return;
    }
    const flow = this.ensureFlow(line.flowId, line);
    this.appendLine(flow, line);
    this.applyLine(flow, line);
    if (!this.matchAttempted.has(flow.flowId) && flow.inboundTag !== null && flow.source !== null) {
      this.matchAttempted.add(flow.flowId);
      const row = this.findBestRowForFlow(flow);
      if (row !== null) {
        this.cacheMatch(flow, row.connection.id);
      }
    }
  }

  private ensureFlow(flowId: number, line: ParsedLogLine): FlowTrace {
    const existing = this.flows.get(flowId);
    if (existing !== undefined) {
      return existing;
    }
    const flow = emptyFlow(flowId, line);
    this.flows.set(flowId, flow);
    if (this.flows.size > MAX_FLOWS) {
      const oldest = this.flows.keys().next();
      if (!oldest.done && oldest.value !== flowId) {
        this.flows.delete(oldest.value);
      }
    }
    return flow;
  }

  private appendLine(flow: FlowTrace, line: ParsedLogLine): void {
    flow.lineCount += 1;
    flow.lines.push(line);
    if (flow.lines.length > MAX_FLOW_LINES) {
      flow.lines.splice(FLOW_HEAD_LINES, flow.lines.length - MAX_FLOW_LINES);
      flow.truncated = true;
    }
    flow.firstReceivedAt = Math.min(flow.firstReceivedAt, line.receivedAt);
    flow.lastReceivedAt = Math.max(flow.lastReceivedAt, line.receivedAt);
    if (line.serverTime !== null) {
      if (flow.firstTime === null || line.serverTime < flow.firstTime) {
        flow.firstTime = line.serverTime;
      }
      if (flow.lastTime === null || line.serverTime > flow.lastTime) {
        flow.lastTime = line.serverTime;
      }
    }
  }

  private applyLine(flow: FlowTrace, line: ParsedLogLine): void {
    switch (line.kind) {
      case "inbound": {
        if (line.ownerType !== null) {
          flow.inboundType = line.ownerType;
        }
        if (line.ownerTag !== null) {
          flow.inboundTag = line.ownerTag;
        }
        const inbound = /^(?:\[[^\]]+\] )?inbound(?: [a-z]+)* connection (from|to) (.+)$/.exec(
          line.body,
        );
        if (inbound !== null) {
          if (inbound[1] === "from") {
            flow.source = inbound[2];
          } else {
            flow.destination = inbound[2];
          }
          return;
        }
        const dnsPacket = /^(?:\[[^\]]+\] )?inbound DNS packet (from|to) (.+)$/.exec(line.body);
        if (dnsPacket !== null) {
          flow.isDnsFlow = true;
          if (dnsPacket[1] === "from") {
            flow.source = dnsPacket[2];
          } else {
            flow.destination = dnsPacket[2];
          }
          this.ensureDns(flow);
        }
        return;
      }
      case "outbound": {
        if (line.ownerType !== null) {
          flow.outboundType = line.ownerType;
        }
        if (line.ownerTag !== null) {
          flow.outboundTag = line.ownerTag;
        }
        const outbound = /^(?:\[[^\]]+\] )?outbound connection to (.+)$/.exec(line.body);
        if (outbound !== null && flow.destination === null) {
          flow.destination = outbound[1];
        }
        return;
      }
      case "router": {
        const sniffed = /^sniffed (?:packet )?protocol: ([^,]+)(?:, domain: (.+))?$/.exec(line.body);
        if (sniffed !== null) {
          flow.protocol = sniffed[1].trim();
          if (sniffed[2] !== undefined) {
            flow.domain = sniffed[2].trim();
          }
        }
        const mapped = /^found (?:fakeip|reverse|reserve) mapped domain: (.+)$/.exec(line.body);
        if (mapped !== null) {
          flow.domain = mapped[1].trim();
        }
        const rule = this.parseRuleMatch(line);
        if (rule !== null) {
          flow.ruleMatches.push(rule);
        }
        return;
      }
      case "dns":
        this.applyDnsLine(flow, line);
        return;
      default:
        return;
    }
  }

  private parseRuleMatch(line: ParsedLogLine): RuleMatch | null {
    const match = /^(pre-match|match|armed)\[(\d+)\](?: (.*?))? => (.+)$/.exec(line.body);
    if (match === null) {
      return null;
    }
    const rule = match[3]?.trim() ?? "";
    return {
      phase: match[1] as RuleMatch["phase"],
      index: Number(match[2]),
      rule: rule === "" ? null : rule,
      action: match[4].trim(),
      line,
    };
  }

  private applyDnsLine(flow: FlowTrace, line: ParsedLogLine): void {
    const event = this.ensureDns(flow);
    if (line.serverTime !== null) {
      if (event.firstTime === null || line.serverTime < event.firstTime) {
        event.firstTime = line.serverTime;
      }
      if (event.lastTime === null || line.serverTime > event.lastTime) {
        event.lastTime = line.serverTime;
      }
    }
    event.lines.push(line);
    if (event.lines.length > MAX_DNS_LINES) {
      event.lines.splice(0, event.lines.length - MAX_DNS_LINES);
    }

    const rule = this.parseRuleMatch(line);
    if (rule !== null) {
      flow.ruleMatches.push(rule);
      const route = rule.action !== null ? /^route\((.+)\)$/.exec(rule.action) : null;
      if (route !== null) {
        event.server = route[1];
      }
    }

    const exchange = /^exchange (.+)$/.exec(line.body);
    if (exchange !== null) {
      const question = parseQuestion(exchange[1]);
      if (question !== null) {
        if (event.name === "") {
          event.name = question.name;
        }
        if (!event.queryTypes.includes(question.qtype)) {
          event.queryTypes.push(question.qtype);
        }
      }
      return;
    }

    const lookup = /^lookup domain (.+)$/.exec(line.body);
    if (lookup !== null) {
      if (event.name === "") {
        event.name = lookup[1].trim();
      }
      return;
    }

    const succeeded = /^lookup succeed for (.+?): (.+)$/.exec(line.body);
    if (succeeded !== null) {
      if (event.name === "") {
        event.name = succeeded[1].trim();
      }
      for (const address of succeeded[2].split(/\s+/)) {
        if (address !== "" && !event.lookupAddresses.includes(address)) {
          event.lookupAddresses.push(address);
        }
      }
      return;
    }

    const summary = DNS_SUMMARY_RE.exec(line.body);
    if (summary !== null) {
      event.disposition = summary[1];
      if (event.name === "") {
        event.name = summary[2];
      }
      event.rcode = summary[3];
      if (summary[4] !== undefined) {
        event.ttl = Number(summary[4]);
      }
      return;
    }

    const record = parseDnsRecord(line.body);
    if (record !== null) {
      if (event.name === "") {
        event.name = record.name;
      }
      event.answers.push(record);
      return;
    }

    if (line.body.startsWith("strategy rejected") && event.disposition === null) {
      event.disposition = "rejected";
    }
  }

  private ensureDns(flow: FlowTrace): DnsEvent {
    if (flow.dns !== null) {
      return flow.dns;
    }
    const event = emptyDnsEvent(flow.flowId);
    flow.dns = event;
    this.dnsEvents.push(event);
    if (this.dnsEvents.length > MAX_DNS_EVENTS) {
      this.dnsEvents.splice(0, this.dnsEvents.length - MAX_DNS_EVENTS);
    }
    return event;
  }

  private findFlowForConnection(connection: Connection): FlowTrace | null {
    const cached = this.connectionFlows.get(connection.id);
    if (cached !== undefined) {
      return cached;
    }
    let best: FlowTrace | null = null;
    let bestScore = 0;
    for (const flow of this.flows.values()) {
      const score = scoreFlowConnection(flow, connection);
      if (score > bestScore) {
        bestScore = score;
        best = flow;
      }
    }
    if (best !== null && bestScore >= MATCH_THRESHOLD) {
      this.cacheMatch(best, connection.id);
      return best;
    }
    return null;
  }

  private findBestRowForFlow(flow: FlowTrace): ConnectionRow | null {
    const cachedId = this.flowConnectionIds.get(flow.flowId);
    if (cachedId !== undefined) {
      const row = this.rows.get(cachedId);
      if (row !== undefined) {
        return row;
      }
    }
    let best: ConnectionRow | null = null;
    let bestScore = 0;
    for (const row of this.rows.values()) {
      const score = scoreFlowConnection(flow, row.connection);
      if (score > bestScore) {
        bestScore = score;
        best = row;
      }
    }
    return best !== null && bestScore >= MATCH_THRESHOLD ? best : null;
  }

  private cacheMatch(flow: FlowTrace, connectionId: string): void {
    if (this.connectionFlows.has(connectionId)) {
      return;
    }
    this.connectionFlows.set(connectionId, flow);
    this.flowConnectionIds.set(flow.flowId, connectionId);
  }

  private findDnsLink(
    connection: Connection,
    flow: FlowTrace | null,
  ): { link: DnsLink | null; candidates: number } {
    const destinationHost = normalizeHost(hostOf(connection.destination));
    const names = new Set<string>();
    if (connection.domain !== "") {
      names.add(normalizeDomain(connection.domain));
    }
    if (flow !== null && flow.domain !== null) {
      names.add(normalizeDomain(flow.domain));
    }
    const createdAt = Number(connection.createdAt);
    let bestScore = 0;
    let bestEvent: DnsEvent | null = null;
    let bestVia: DnsLinkVia = "domain-time";
    let candidates = 0;

    for (const event of this.dnsEvents) {
      const ipMatch =
        destinationHost !== "" &&
        (event.answers.some((answer) => normalizeHost(answer.value) === destinationHost) ||
          event.lookupAddresses.some((address) => normalizeHost(address) === destinationHost));
      const nameMatch = event.name !== "" && names.has(normalizeDomain(event.name));
      if (!ipMatch && !nameMatch) {
        continue;
      }
      let timeBonus = 0;
      if (createdAt > 0 && event.firstTime !== null) {
        const delta = createdAt - event.firstTime;
        if (delta < -3000 || delta > DNS_LINK_WINDOW_MS) {
          continue;
        }
        timeBonus = Math.max(0, 40 - Math.floor(delta / 10_000));
      } else if (!ipMatch) {
        continue;
      }
      candidates += 1;
      const score = (ipMatch ? 200 : 80) + timeBonus + (nameMatch ? 20 : 0);
      if (score > bestScore) {
        bestScore = score;
        bestEvent = event;
        bestVia = ipMatch ? "ip" : "domain-time";
      }
    }

    if (bestEvent === null) {
      return { link: null, candidates };
    }
    const eventFlow = bestEvent.flowId !== null ? (this.flows.get(bestEvent.flowId) ?? null) : null;
    return { link: { event: bestEvent, flow: eventFlow, via: bestVia }, candidates };
  }
}

export class TraceStore {
  private readonly index = new TraceIndex();
  private listeners = new Set<() => void>();
  private version = 0;
  private refCount = 0;
  private disposers: (() => void)[] = [];
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private startedAtRequested = false;

  constructor(
    private readonly logs: StreamStore<LogsData>,
    private readonly connections: StreamStore<ConnectionsData>,
    private readonly fetchStartedAt: () => Promise<number>,
  ) {}

  start(): () => void {
    this.refCount += 1;
    if (this.refCount === 1) {
      this.begin();
    }
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.refCount -= 1;
      if (this.refCount === 0) {
        this.end();
      }
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    const release = this.start();
    return () => {
      this.listeners.delete(listener);
      release();
    };
  };

  getSnapshot = (): number => this.version;

  getConnectionTrace(connection: Connection): ConnectionTrace {
    return this.index.getConnectionTrace(connection);
  }

  findConnectionForFlow(flowId: number): ConnectionRow | null {
    return this.index.findConnectionForFlow(flowId);
  }

  getFlow(flowId: number): FlowTrace | null {
    return this.index.getFlow(flowId);
  }

  private begin(): void {
    this.disposers.push(this.logs.subscribe(this.handleLogs));
    this.disposers.push(this.connections.subscribe(this.handleConnections));
    this.handleLogs();
    this.handleConnections();
    if (!this.startedAtRequested) {
      this.startedAtRequested = true;
      void this.fetchStartedAt()
        .then((startedAt) => this.index.setServerStart(startedAt))
        .catch(() => undefined);
    }
  }

  private end(): void {
    for (const dispose of this.disposers) {
      dispose();
    }
    this.disposers = [];
    if (this.notifyTimer !== null) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
    }
  }

  private handleLogs = (): void => {
    if (this.index.ingest(this.logs.getSnapshot().data.entries) > 0) {
      this.scheduleNotify();
    }
  };

  private handleConnections = (): void => {
    this.index.setRows(this.connections.getSnapshot().data.rows);
    this.scheduleNotify();
  };

  private scheduleNotify(): void {
    if (this.notifyTimer !== null) {
      return;
    }
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.version += 1;
      for (const listener of this.listeners) {
        listener();
      }
    }, NOTIFY_INTERVAL_MS);
  }
}
