import { useMemo, useState } from "react";

import type { LogEntry } from "../api/daemon";
import { parseLogMessage, type FlowTrace, type ParsedLogLine } from "../api/trace";
import { useApi } from "../app/context";
import { useI18n } from "../app/i18n";
import { AnsiText } from "../components/AnsiText";
import { Icon } from "../components/Icon";
import { Badge, DataLine, DetailSection, Drawer } from "../components/ui";
import { ConnectionDetailBody } from "./ConnectionsView";
import { useTraceVersion } from "./ConnectionTrace";
import styles from "./FlowLogGroups.module.css";

interface FlowGroup {
  key: string;
  flowId: number | null;
  entries: LogEntry[];
  lines: ParsedLogLine[];
}

function buildGroups(entries: LogEntry[]): FlowGroup[] {
  const byId = new Map<number, FlowGroup>();
  const groups: FlowGroup[] = [];
  for (const entry of entries) {
    const line = parseLogMessage(entry, null);
    if (line.flowId === null) {
      groups.push({
        key: `entry-${entry.id}`,
        flowId: null,
        entries: [entry],
        lines: [line],
      });
      continue;
    }
    let group = byId.get(line.flowId);
    if (group === undefined) {
      group = { key: `flow-${line.flowId}`, flowId: line.flowId, entries: [], lines: [] };
      byId.set(line.flowId, group);
      groups.push(group);
    }
    group.entries.push(entry);
    group.lines.push(line);
  }
  return groups;
}

function flowSummary(flow: FlowTrace | null): string {
  if (flow === null) {
    return "";
  }
  const parts: string[] = [];
  if (flow.inboundTag !== null) {
    parts.push(`${flow.inboundType ?? "inbound"}/${flow.inboundTag}`);
  }
  if (flow.source !== null) {
    parts.push(flow.source);
  }
  if (flow.domain !== null) {
    parts.push(flow.domain);
  } else if (flow.destination !== null) {
    parts.push(flow.destination);
  }
  if (flow.outboundTag !== null) {
    parts.push(`→ ${flow.outboundType ?? "outbound"}/${flow.outboundTag}`);
  } else if (flow.dns !== null && flow.dns.name !== "") {
    parts.push(`DNS ${flow.dns.name}`);
  }
  return parts.join(" ");
}

function FlowOnlyBody(props: { group: FlowGroup; flow: FlowTrace | null }) {
  const { t } = useI18n();
  const flow = props.flow;
  return (
    <>
      <DetailSection title={t("Flow")}>
        <DataLine
          label={t("Inbound")}
          value={flow?.inboundTag !== null && flow?.inboundTag !== undefined
            ? `${flow.inboundType ?? ""}/${flow.inboundTag}`
            : ""}
          mono
        />
        <DataLine label={t("Source")} value={flow?.source ?? ""} mono />
        <DataLine label={t("Destination")} value={flow?.destination ?? ""} mono />
        <DataLine label={t("Domain")} value={flow?.domain ?? ""} mono />
        <DataLine label={t("Protocol")} value={flow?.protocol ?? ""} mono />
        <DataLine
          label={t("Outbound")}
          value={flow?.outboundTag !== null && flow?.outboundTag !== undefined
            ? `${flow.outboundType ?? ""}/${flow.outboundTag}`
            : ""}
          mono
        />
        <DataLine label={t("DNS")} value={flow?.dns?.name ?? ""} mono />
      </DetailSection>
      <DetailSection title={t("All logs")}>
        <div className={styles.drawerLogs}>
          {props.group.entries.map((entry) => (
            <div key={entry.id} className={styles.line}>
              <AnsiText text={entry.message} />
            </div>
          ))}
        </div>
      </DetailSection>
    </>
  );
}

export function FlowLogGroups(props: { entries: LogEntry[]; highlight: string }) {
  const api = useApi();
  const { t } = useI18n();
  const version = useTraceVersion();
  void version;
  const groups = useMemo(() => buildGroups(props.entries), [props.entries]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [openGroup, setOpenGroup] = useState<FlowGroup | null>(null);

  const toggle = (key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const drawerFlow =
    openGroup !== null && openGroup.flowId !== null ? api.trace.getFlow(openGroup.flowId) : null;
  const drawerRow =
    openGroup !== null && openGroup.flowId !== null
      ? api.trace.findConnectionForFlow(openGroup.flowId)
      : null;

  return (
    <>
      {groups.map((group) => {
        const flow = group.flowId !== null ? api.trace.getFlow(group.flowId) : null;
        const isCollapsed = collapsed.has(group.key);
        return (
          <div key={group.key} className={styles.group}>
            <div className={styles.header}>
              <button type="button" className={styles.toggle} onClick={() => toggle(group.key)}>
                <Icon name={isCollapsed ? "expand_more" : "expand_less"} size={14} />
                <span className={styles.flow}>
                  {group.flowId !== null ? t("Flow {id}", { id: group.flowId }) : t("Logs")}
                </span>
                <span className={styles.summary}>{flowSummary(flow)}</span>
                <span className={styles.count}>{group.entries.length}</span>
              </button>
              {group.flowId !== null && (
                <button
                  type="button"
                  className={styles.open}
                  title={t("Open trace")}
                  aria-label={t("Open trace")}
                  onClick={() => setOpenGroup(group)}
                >
                  <Icon name="open_in_new" size={14} />
                </button>
              )}
            </div>
            {!isCollapsed && (
              <div className={styles.lines}>
                {group.entries.map((entry) => (
                  <div key={entry.id} className={styles.line}>
                    <AnsiText text={entry.message} highlight={props.highlight} />
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {openGroup !== null && (
        <Drawer
          onClose={() => setOpenGroup(null)}
          ariaLabel={openGroup.flowId !== null ? t("Flow {id}", { id: openGroup.flowId }) : t("Logs")}
        >
          <h3>
            {openGroup.flowId !== null ? t("Flow {id}", { id: openGroup.flowId }) : t("Logs")}
            <span style={{ marginInlineStart: "auto" }}>
              <Badge>{openGroup.entries.length}</Badge>
            </span>
          </h3>
          {drawerRow !== null ? (
            <ConnectionDetailBody row={drawerRow} onClose={() => setOpenGroup(null)} initialTab="trace" />
          ) : (
            <FlowOnlyBody group={openGroup} flow={drawerFlow} />
          )}
        </Drawer>
      )}
    </>
  );
}
