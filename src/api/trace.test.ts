import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";

import { ConnectionSchema, LogLevel } from "../gen/daemon/started_service_pb";
import type { ConnectionRow, LogEntry } from "./daemon";
import { hostOf, parseLogMessage, splitAddress, TraceIndex } from "./trace";

const SERVER_START = 1_700_000_000_000;
let sequence = 0;

function entry(message: string, receivedAt = SERVER_START + 25_439_000): LogEntry {
  sequence += 1;
  return { id: sequence, level: LogLevel.DEBUG, message, receivedAt };
}

function tcpFlowEntries(): LogEntry[] {
  return [
    entry(
      "INFO[25439] [\u001b[38;5;228m1570528218\u001b[0m 0ms] inbound/tun[tun-in]: inbound redirect connection from 192.168.10.227:52173",
    ),
    entry(
      "INFO[25439] [1570528218 0ms] inbound/tun[tun-in]: inbound connection to 103.171.35.166:443",
    ),
    entry(
      "DEBUG[25439] [1570528218 0ms] router: found reserve mapped domain: api.tokenwayapi.com",
    ),
    entry(
      "DEBUG[25439] [1570528218 0ms] router: match[0] => sniff(http,tls,stun,quic,dns,100ms)",
    ),
    entry(
      "DEBUG[25439] [1570528218 0ms] router: sniffed protocol: tls, domain: api.tokenwayapi.com",
    ),
    entry(
      "DEBUG[25439] [1570528218 0ms] router: match[26] rule_set=rule-direct => route(Direct)",
    ),
    entry(
      "INFO[25439] [1570528218 1ms] outbound/anytls[Relay·新加坡01]: outbound connection to 103.171.35.166:443",
    ),
    entry("DEBUG[25439] [1570528218 14.29s] connection: connection upload finished"),
  ];
}

function dnsFlowEntries(): LogEntry[] {
  return [
    entry("INFO[25437] [1800093043 0ms] inbound/tun[tun-in]: inbound DNS packet from 192.168.10.227:53257"),
    entry("DEBUG[25437] [1800093043 0ms] dns: exchange api.tokenwayapi.com. IN A"),
    entry("DEBUG[25437] [1800093043 0ms] dns: match[11] rule_set=rule-direct => route(dns-direct)"),
    entry("DEBUG[25437] [1800093043 0ms] dns: exchanged api.tokenwayapi.com NOERROR 60"),
    entry("INFO[25437] [1800093043 0ms] dns: exchanged A api.tokenwayapi.com. 60 IN A 103.171.35.166"),
  ];
}

function connectionRow(): ConnectionRow {
  const connection = create(ConnectionSchema, {
    id: "conn-1",
    inbound: "tun-in",
    inboundType: "tun",
    network: "tcp",
    source: "192.168.10.227:52173",
    destination: "103.171.35.166:443",
    domain: "api.tokenwayapi.com",
    protocol: "tls",
    rule: "rule_set=rule-direct",
    outbound: "Relay·新加坡01",
    outboundType: "anytls",
    chainList: ["Relay·新加坡01", "Proxies"],
    createdAt: BigInt(SERVER_START + 25_439_000),
    uplinkTotal: 1024n,
    downlinkTotal: 4096n,
  });
  return {
    connection,
    uplinkRate: 0,
    downlinkRate: 0,
    uplinkTotal: 1024n,
    downlinkTotal: 4096n,
    closedAt: null,
  };
}

describe("parseLogMessage", () => {
  it("parses level, flow id, tag and body", () => {
    const line = parseLogMessage(
      entry(
        "\u001b[37mDEBUG\u001b[0m[25439] [\u001b[38;5;228m1570528218\u001b[0m 0ms] router: match[0] => sniff(http,tls,stun,quic,dns,100ms)",
      ),
      SERVER_START,
    );
    expect(line.flowId).toBe(1570528218);
    expect(line.levelSeconds).toBe(25439);
    expect(line.serverTime).toBe(SERVER_START + 25_439_000);
    expect(line.elapsedMs).toBe(0);
    expect(line.tag).toBe("router");
    expect(line.kind).toBe("router");
    expect(line.body).toBe("match[0] => sniff(http,tls,stun,quic,dns,100ms)");
    expect(line.text.startsWith("DEBUG[25439] [1570528218 0ms]")).toBe(true);
  });

  it("parses inbound tags and routes", () => {
    const line = parseLogMessage(
      entry(
        "INFO[25439] [1570528218 0ms] inbound/tun[tun-in]: inbound redirect connection from 192.168.10.227:52173",
      ),
      SERVER_START,
    );
    expect(line.kind).toBe("inbound");
    expect(line.ownerType).toBe("tun");
    expect(line.ownerTag).toBe("tun-in");
    expect(line.body).toBe("inbound redirect connection from 192.168.10.227:52173");
  });

  it("parses elapsed durations", () => {
    expect(parseLogMessage(entry("[1 14.29s] connection: connection upload finished"), SERVER_START).elapsedMs).toBe(14_290);
    expect(parseLogMessage(entry("[1 1m05s] connection: connection upload finished"), SERVER_START).elapsedMs).toBe(65_000);
  });

  it("ignores lines without a flow id", () => {
    const line = parseLogMessage(entry("INFO[1] sing-box started (0.00s)"), SERVER_START);
    expect(line.flowId).toBeNull();
    expect(line.kind).toBe("none");
  });
});

describe("hostOf and splitAddress", () => {
  it("handles IPv4 and IPv6", () => {
    expect(hostOf("103.171.35.166:443")).toBe("103.171.35.166");
    expect(hostOf("103.171.35.166")).toBe("103.171.35.166");
    expect(hostOf("[2001:db8::1]:443")).toBe("2001:db8::1");
    expect(splitAddress("[2001:db8::1]:443")).toEqual({ host: "2001:db8::1", port: "443" });
  });
});

describe("TraceIndex", () => {
  it("builds a DNS flow from log lines", () => {
    const index = new TraceIndex();
    index.setServerStart(SERVER_START);
    index.ingest(dnsFlowEntries());
    const flow = index.getFlow(1800093043);
    expect(flow?.isDnsFlow).toBe(true);
    expect(flow?.source).toBe("192.168.10.227:53257");
    expect(flow?.dns?.name).toBe("api.tokenwayapi.com");
    expect(flow?.dns?.queryTypes).toEqual(["A"]);
    expect(flow?.dns?.server).toBe("dns-direct");
    expect(flow?.dns?.rcode).toBe("NOERROR");
    expect(flow?.dns?.ttl).toBe(60);
    expect(flow?.dns?.answers[0].value).toBe("103.171.35.166");
  });

  it("matches a connection to its flow and DNS query", () => {
    const index = new TraceIndex();
    index.setServerStart(SERVER_START);
    index.ingest([...dnsFlowEntries(), ...tcpFlowEntries()]);
    const row = connectionRow();
    index.setRows(new Map([[row.connection.id, row]]));

    const trace = index.getConnectionTrace(row.connection);
    expect(trace.flow?.flowId).toBe(1570528218);
    expect(trace.flow?.inboundTag).toBe("tun-in");
    expect(trace.flow?.domain).toBe("api.tokenwayapi.com");
    expect(trace.flow?.outboundTag).toBe("Relay·新加坡01");
    expect(trace.flow?.ruleMatches.map((rule) => rule.action)).toContain("route(Direct)");
    expect(trace.dns?.via).toBe("ip");
    expect(trace.dns?.event.name).toBe("api.tokenwayapi.com");
    expect(trace.dns?.event.server).toBe("dns-direct");

    const matched = index.findConnectionForFlow(1570528218);
    expect(matched?.connection.id).toBe("conn-1");
  });

  it("does not match unrelated flows", () => {
    const index = new TraceIndex();
    index.setServerStart(SERVER_START);
    index.ingest([
      entry("INFO[25439] [999 0ms] inbound/tun[tun-in]: inbound connection from 10.0.0.9:1234"),
      entry("DEBUG[25439] [999 0ms] router: match[0] => route(block)"),
    ]);
    const row = connectionRow();
    index.setRows(new Map([[row.connection.id, row]]));
    expect(index.getConnectionTrace(row.connection).flow).toBeNull();
  });
});
