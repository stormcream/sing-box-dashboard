import { useEffect, useId, useMemo, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";

import { formatBytes, formatDateTime, formatDurationMs } from "../api/format";
import type { ConnectionTrace, ParsedLogLine, RuleMatch } from "../api/trace";
import type { Connection } from "../gen/daemon/started_service_pb";
import { useApi } from "../app/context";
import { showError } from "../app/errorStore";
import { useI18n } from "../app/i18n";
import { AnsiText } from "../components/AnsiText";
import { Icon } from "../components/Icon";
import type { IconName } from "../components/iconPaths";
import { Badge, Button, DataLine, DetailSection } from "../components/ui";
import styles from "./ConnectionTrace.module.css";

export function useTraceCapture(): void {
  const api = useApi();
  useEffect(() => api.trace.start(), [api]);
}

export function useTraceVersion(): number {
  const api = useApi();
  return useSyncExternalStore(api.trace.subscribe, api.trace.getSnapshot);
}

function uniqueLines(...groups: (ParsedLogLine[] | null | undefined)[]): ParsedLogLine[] {
  const seen = new Set<number>();
  const result: ParsedLogLine[] = [];
  for (const group of groups) {
    if (group === undefined || group === null) {
      continue;
    }
    for (const line of group) {
      if (seen.has(line.id)) {
        continue;
      }
      seen.add(line.id);
      result.push(line);
    }
  }
  result.sort((left, right) => left.id - right.id);
  return result;
}

function uniqueRuleMatches(...groups: (RuleMatch[] | undefined)[]): RuleMatch[] {
  const seen = new Set<number>();
  const result: RuleMatch[] = [];
  for (const group of groups) {
    if (group === undefined) {
      continue;
    }
    for (const rule of group) {
      if (seen.has(rule.line.id)) {
        continue;
      }
      seen.add(rule.line.id);
      result.push(rule);
    }
  }
  return result;
}

function ruleText(rule: RuleMatch): string {
  return `${rule.rule ?? ""}${rule.rule !== null ? " " : ""}=> ${rule.action ?? ""}`;
}

function TraceStage(props: {
  icon: IconName;
  title: string;
  lines: ParsedLogLine[];
  flowId?: number | null;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.stage}>
      <span className={styles.dot} />
      <div className={styles.header}>
        <Icon name={props.icon} size={15} />
        <span className={styles.title}>{props.title}</span>
        {props.flowId !== undefined && props.flowId !== null && (
          <span className={styles.flow}>{t("Flow {id}", { id: props.flowId })}</span>
        )}
        {props.lines.length > 0 && (
          <button
            type="button"
            className={styles.toggle}
            onClick={() => setOpen((value) => !value)}
          >
            <Icon name={open ? "expand_less" : "expand_more"} size={14} />
            {open ? t("Hide logs") : t("Show logs ({count})", { count: props.lines.length })}
          </button>
        )}
      </div>
      <div className={styles.content}>
        {props.children}
        {open && (
          <div className={styles.logs}>
            {props.lines.map((line) => (
              <div key={line.id} className={styles.logLine}>
                <AnsiText text={line.raw} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function traceText(connection: Connection, trace: ConnectionTrace, closedAt: number | null): string {
  const output: string[] = [];
  output.push(`connection ${connection.id}`);
  output.push(`inbound ${connection.inboundType}/${connection.inbound} ${connection.source}`);
  output.push(`network ${connection.network} destination ${connection.destination}`);
  if (connection.domain !== "") {
    output.push(`domain ${connection.domain}`);
  }
  if (connection.protocol !== "") {
    output.push(`protocol ${connection.protocol}`);
  }
  output.push(`rule ${connection.rule !== "" ? connection.rule : "(none)"}`);
  output.push(`outbound ${connection.outboundType}/${connection.outbound}`);
  if (connection.chainList.length > 0) {
    output.push(`chain ${[...connection.chainList].reverse().join(" / ")}`);
  }
  if (trace.dns !== null) {
    const event = trace.dns.event;
    output.push(`dns ${event.name} ${event.queryTypes.join("/")} ${event.rcode ?? ""}`);
    if (event.server !== null) {
      output.push(`dns route ${event.server}`);
    }
    for (const answer of event.answers) {
      output.push(`answer ${answer.recordType} ${answer.value} ttl=${answer.ttl ?? ""}`);
    }
    for (const address of event.lookupAddresses) {
      output.push(`address ${address}`);
    }
    output.push(`dns link ${trace.dns.via}`);
  }
  if (closedAt !== null) {
    output.push(`closed ${new Date(closedAt).toISOString()}`);
  }
  output.push("", "logs:");
  for (const line of uniqueLines(trace.flow?.lines, trace.dns?.flow?.lines)) {
    output.push(line.text);
  }
  return output.join("\n");
}

export function ConnectionTraceSection(props: { connection: Connection; closedAt: number | null }) {
  const api = useApi();
  const { t, language } = useI18n();
  const version = useTraceVersion();
  const trace = useMemo(() => {
    void version;
    return api.trace.getConnectionTrace(props.connection);
  }, [api, props.connection, version]);
  const connection = props.connection;
  const flow = trace.flow;
  const dns = trace.dns;
  const dnsFlow = dns?.flow ?? null;
  const closedAt =
    props.closedAt ?? (Number(connection.closedAt) > 0 ? Number(connection.closedAt) : null);

  const inboundLines = flow?.lines.filter((line) => line.kind === "inbound") ?? [];
  const outboundLines = flow?.lines.filter((line) => line.kind === "outbound") ?? [];
  const routeLines = flow?.lines.filter((line) => line.kind === "router") ?? [];
  const timelineLines = flow?.lines.filter((line) => line.kind === "connection") ?? [];
  const dnsLines = uniqueLines(
    dns?.event.lines,
    flow?.lines.filter((line) => line.kind === "dns"),
  );
  const allLines = uniqueLines(flow?.lines, dnsFlow?.lines);
  const routeMatches = flow?.ruleMatches.filter((rule) => rule.line.kind === "router") ?? [];
  const dnsMatches = uniqueRuleMatches(
    flow?.ruleMatches.filter((rule) => rule.line.kind === "dns"),
    dnsFlow?.ruleMatches,
  );
  const finalRoute =
    [...routeMatches].reverse().find((rule) => rule.action?.startsWith("route(") === true) ?? null;
  const chain = [...connection.chainList].reverse();
  const firstLine = flow?.lines[0];
  const lastLine = flow?.lines[flow.lines.length - 1];
  const linkBasis =
    dns === null
      ? ""
      : dns.via === "flow"
        ? t("From this connection's logs")
        : dns.via === "ip"
          ? t("Linked by IP")
          : t("Linked by domain and time");

  const copyTrace = () => {
    void navigator.clipboard.writeText(traceText(connection, trace, closedAt)).catch(showError);
  };

  return (
    <DetailSection
      title={t("Trace")}
      accessory={
        <Badge tone={flow !== null ? "good" : undefined}>
          {flow !== null ? t("Flow {id}", { id: flow.flowId }) : t("Unmatched")}
        </Badge>
      }
    >
      <div className={styles.stages}>
        {flow === null && (
          <div className={styles.hint}>
            {t("Trace capture may have started after this connection, or the logs were rotated.")}
          </div>
        )}
        {flow !== null && flow.truncated && (
          <div className={styles.hint}>
            {t("Some log lines were dropped because the trace buffer is full.")}
          </div>
        )}
        <TraceStage icon="download" title={t("Inbound")} lines={inboundLines} flowId={flow?.flowId}>
          <DataLine
            label={t("Inbound")}
            value={`${connection.inboundType}/${connection.inbound}`}
            mono
          />
          <DataLine label={t("Network")} value={connection.network.toUpperCase()} />
          <DataLine label={t("Source")} value={connection.source} mono />
          <DataLine label={t("Destination")} value={connection.destination} mono />
          <DataLine
            label={t("Protocol")}
            value={connection.protocol || flow?.protocol || ""}
            mono
          />
          <DataLine label={t("Domain")} value={connection.domain || flow?.domain || ""} mono />
          <DataLine label={t("User")} value={connection.user} />
          <DataLine
            label={t("IP version")}
            value={connection.ipVersion > 0 ? `IPv${connection.ipVersion}` : ""}
          />
        </TraceStage>

        <TraceStage icon="dns" title={t("DNS")} lines={dnsLines} flowId={dns?.event.flowId ?? null}>
          {dns === null ? (
            <div className={styles.hint}>
              {t("No DNS record captured")}{" "}
              {t("The DNS query may not have gone through sing-box, or the logs were rotated.")}
            </div>
          ) : (
            <>
              <DataLine label={t("Domain")} value={dns.event.name} mono />
              <DataLine label={t("Query type")} value={dns.event.queryTypes.join(" / ")} mono />
              <DataLine label={t("DNS route")} value={dns.event.server ?? ""} mono />
              <DataLine
                label={t("Query status")}
                value={[dns.event.disposition, dns.event.rcode].filter(Boolean).join(" ")}
              />
              <DataLine
                label={t("TTL")}
                value={dns.event.ttl !== null ? String(dns.event.ttl) : ""}
              />
              <DataLine
                label={t("Answers")}
                value={dns.event.answers
                  .map((answer) => `${answer.recordType} ${answer.value}`)
                  .join(" · ")}
                mono
              />
              <DataLine
                label={t("Lookup addresses")}
                value={dns.event.lookupAddresses.join(" ")}
                mono
              />
              {dns.event.firstTime !== null && (
                <DataLine
                  label={t("Query time")}
                  value={formatDateTime(dns.event.firstTime, language)}
                />
              )}
              <DataLine label={t("Link basis")} value={linkBasis} />
              {dnsMatches.map((rule) => (
                <DataLine
                  key={rule.line.id}
                  label={`${rule.phase}[${rule.index}]`}
                  value={ruleText(rule)}
                  mono
                />
              ))}
              {trace.dnsCandidates > 1 && (
                <div className={styles.hint}>
                  {t("Related DNS queries: {count}", { count: trace.dnsCandidates })}
                </div>
              )}
            </>
          )}
        </TraceStage>

        <TraceStage icon="router" title={t("Routing")} lines={routeLines} flowId={flow?.flowId}>
          <DataLine
            label={t("Match rule")}
            value={connection.rule !== "" ? connection.rule : t("No rule matched")}
            mono
          />
          {finalRoute !== null && (
            <DataLine label={t("Final action")} value={finalRoute.action ?? ""} mono />
          )}
          {routeMatches.map((rule) => (
            <DataLine
              key={rule.line.id}
              label={`${rule.phase}[${rule.index}]`}
              value={ruleText(rule)}
              mono
            />
          ))}
        </TraceStage>

        <TraceStage icon="upload" title={t("Outbound")} lines={outboundLines} flowId={flow?.flowId}>
          <DataLine
            label={t("Outbound")}
            value={`${connection.outboundType}/${connection.outbound}`}
            mono
          />
          <DataLine label={t("Chain")} value={chain.join(" / ")} mono />
          <DataLine label={t("From outbound")} value={connection.fromOutbound} />
        </TraceStage>

        <TraceStage icon="schedule" title={t("Timeline")} lines={timelineLines}>
          <DataLine
            label={t("Created at")}
            value={formatDateTime(Number(connection.createdAt), language)}
          />
          {closedAt !== null && (
            <DataLine label={t("Closed at")} value={formatDateTime(closedAt, language)} />
          )}
          {closedAt !== null && (
            <DataLine
              label={t("Duration")}
              value={formatDurationMs(closedAt - Number(connection.createdAt))}
            />
          )}
          <DataLine label={t("Uplink")} value={formatBytes(connection.uplinkTotal)} />
          <DataLine label={t("Downlink")} value={formatBytes(connection.downlinkTotal)} />
          {firstLine !== undefined && lastLine !== undefined && (
            <DataLine
              label={t("Elapsed")}
              value={`${firstLine.elapsedText ?? ""} → ${lastLine.elapsedText ?? ""}`}
            />
          )}
        </TraceStage>

        {allLines.length > 0 && (
          <TraceStage icon="text_snippet" title={t("All logs")} lines={allLines}>
            <div className={styles.hint}>
              {t("Flow {id}", { id: flow?.flowId ?? "" })} · {allLines.length}
            </div>
          </TraceStage>
        )}
      </div>
      <div className={styles.actions}>
        <Button size="small" onClick={copyTrace}>
          <Icon name="content_copy" size={13} />
          {t("Copy trace")}
        </Button>
      </div>
    </DetailSection>
  );
}

export type ConnectionDetailTab = "details" | "trace";

const DETAIL_TABS: ConnectionDetailTab[] = ["details", "trace"];

export function ConnectionDetailTabs(props: {
  connection: Connection;
  closedAt: number | null;
  initialTab?: ConnectionDetailTab;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<ConnectionDetailTab>(props.initialTab ?? "details");
  const id = useId();
  const tabId = (value: ConnectionDetailTab) => `${id}-${value}-tab`;
  const panelId = (value: ConnectionDetailTab) => `${id}-${value}-panel`;
  const labels: Record<ConnectionDetailTab, string> = {
    details: t("Details"),
    trace: t("Trace"),
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const { key } = event;
    if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "Home" && key !== "End") {
      return;
    }
    event.preventDefault();
    let next: ConnectionDetailTab;
    if (key === "Home") {
      next = DETAIL_TABS[0];
    } else if (key === "End") {
      next = DETAIL_TABS[DETAIL_TABS.length - 1];
    } else {
      const current = DETAIL_TABS.indexOf(tab);
      const rtl = document.documentElement.dir === "rtl";
      const forward = (key === "ArrowRight") !== rtl;
      next = DETAIL_TABS[(current + (forward ? 1 : -1) + DETAIL_TABS.length) % DETAIL_TABS.length];
    }
    setTab(next);
    document.getElementById(tabId(next))?.focus();
  };

  return (
    <>
      <div
        className={`segmented full ${styles.tabs}`}
        role="tablist"
        aria-label={t("Connection")}
        onKeyDown={onKeyDown}
      >
        {DETAIL_TABS.map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={tabId(value)}
            aria-selected={tab === value}
            aria-controls={panelId(value)}
            tabIndex={tab === value ? 0 : -1}
            className={tab === value ? "active" : undefined}
            onClick={() => setTab(value)}
          >
            {labels[value]}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={panelId("details")}
        aria-labelledby={tabId("details")}
        hidden={tab !== "details"}
      >
        {props.children}
      </div>
      <div
        role="tabpanel"
        id={panelId("trace")}
        aria-labelledby={tabId("trace")}
        hidden={tab !== "trace"}
      >
        <ConnectionTraceSection connection={props.connection} closedAt={props.closedAt} />
      </div>
    </>
  );
}
