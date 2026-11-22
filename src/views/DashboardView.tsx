import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
} from "react";

import type { ConnectionRow } from "../api/daemon";
import {
  formatBytes,
  formatMemoryBytes,
  formatUptime,
  proxyDisplayType,
  urlTestDelayTone,
  type DelayTone,
} from "../api/format";
import { useStream } from "../api/stream";
import { navigate, useApi, useNow } from "../app/context";
import { useLocalDesktopHost, type DesktopHost } from "../app/desktop";
import { showError } from "../app/errorStore";
import { usePendingValue, useUnaryOnce } from "../app/hooks";
import { useI18n } from "../app/i18n";
import { Icon, type IconName } from "../components/Icon";
import { PageHeader } from "../components/PageHeader";
import { StreamBanner } from "../components/StreamBanner";
import {
  AdaptiveSegmented,
  Badge,
  Card,
  Select,
  StateDot,
  Switch,
} from "../components/ui";
import { ServiceStatus_Type, type Group } from "../gen/daemon/started_service_pb";
import { cx } from "../lib/cx";
import { useTraceCapture } from "./ConnectionTrace";
import { topActiveConnections } from "./dashboardData";
import { ProfileCard } from "./ProfileViews";
import styles from "./DashboardView.module.css";

// The status stream pushes one sample per second and keeps a 30 sample window.
const CHART_CAPACITY = 30;
const CHART_WIDTH = 1000;
const CHART_HEIGHT = 180;
// Overview shows this many live connections; the proxy group list renders all
// groups and scrolls inside its capped panel.
const CONNECTION_ROW_CAPACITY = 8;

export function DashboardView() {
  const api = useApi();
  const { t } = useI18n();
  const host = useLocalDesktopHost();
  useTraceCapture();
  const serviceStatus = useStream(api.serviceStatus);
  const statusType = serviceStatus.data.status?.status;
  const started = statusType === ServiceStatus_Type.STARTED;
  const startedAt = useUnaryOnce(() => api.getStartedAt(), started);

  let stateLabel = t("Stopped");
  let stateTone: DelayTone | undefined;
  switch (statusType) {
    case ServiceStatus_Type.STARTING:
      stateLabel = t("Service starting...");
      stateTone = "medium";
      break;
    case ServiceStatus_Type.STOPPING:
      stateLabel = t("Service stopping...");
      stateTone = "medium";
      break;
    case ServiceStatus_Type.FATAL:
      stateLabel = t("Service failed to start");
      stateTone = "bad";
      break;
    case ServiceStatus_Type.STARTED:
      stateLabel = t("Running");
      stateTone = "good";
      break;
    default:
      if (serviceStatus.phase === "active") {
        stateLabel = t("Service not started");
      }
      break;
  }

  return (
    <div className={cx("page", styles.dashboard)}>
      <PageHeader title={t("Overview")} />
      <StreamBanner snapshot={serviceStatus} />
      <div className={styles.stack}>
        <StatusHero
          started={started}
          label={stateLabel}
          tone={stateTone}
          startedAt={startedAt}
          host={host}
        />
        {started && (
          <>
            <TrafficPanel />
            <StatTiles startedAt={startedAt} />
            <div className={styles.split}>
              <ProxyGroupsPanel />
              <LiveConnectionsPanel />
            </div>
          </>
        )}
        {host !== null && <ProfileCard host={host} />}
      </div>
    </div>
  );
}

function StatusHero(props: {
  started: boolean;
  label: string;
  tone?: DelayTone;
  startedAt: number | null;
  host: DesktopHost | null;
}) {
  const api = useApi();
  const { t } = useI18n();
  const version = useUnaryOnce(() => api.serverInfo());
  const now = useNow(1000);

  return (
    <section className={styles.hero}>
      <div className={styles.heroStatus}>
        <span className={cx(styles.heroDot, props.started && styles.heroDotLive)}>
          <StateDot tone={props.tone} />
        </span>
        <div className={styles.heroText}>
          <div className={styles.heroTitle}>{props.label}</div>
          <div className={styles.heroMeta}>
            {version !== null && <span>sing-box {version.version}</span>}
            {props.started && props.startedAt !== null && props.startedAt > 0 && (
              <span>
                {t("Uptime")} {formatUptime(props.startedAt, now)}
              </span>
            )}
          </div>
        </div>
      </div>
      {props.started && (
        <div className={styles.heroControls}>
          <ModeControl />
          <SystemProxyControl host={props.host} />
        </div>
      )}
    </section>
  );
}

function ModeControl() {
  const api = useApi();
  const clashMode = useStream(api.clashMode);
  const [currentMode, setPendingMode] = usePendingValue(clashMode.data.currentMode);

  if (clashMode.data.modeList.length <= 1) {
    return null;
  }
  return (
    <div className={styles.modeControl}>
      <AdaptiveSegmented
        options={clashMode.data.modeList.map((mode) => ({ value: mode, label: mode }))}
        value={currentMode}
        onChange={(mode) => {
          setPendingMode(mode);
          api.setClashMode(mode).catch((error: unknown) => {
            setPendingMode(null);
            showError(error);
          });
        }}
      />
    </div>
  );
}

function SystemProxyControl(props: { host: DesktopHost | null }) {
  const { t } = useI18n();
  const host = props.host;
  const [status, setStatus] = useState<{ available: boolean; enabled: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (host === null) {
      return;
    }
    let stale = false;
    host.systemProxy
      .status()
      .then((value) => {
        if (!stale) {
          setStatus(() => value);
        }
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [host]);

  if (host === null || status === null || !status.available) {
    return null;
  }
  return (
    <div className={styles.proxyControl}>
      <span>{t("System HTTP Proxy")}</span>
      <Switch
        label={t("System HTTP Proxy")}
        value={status.enabled}
        disabled={busy}
        onChange={(value) => {
          setBusy(true);
          host.systemProxy
            .setEnabled(value)
            .then(() => host.systemProxy.status())
            .then(setStatus)
            .catch(showError)
            .finally(() => setBusy(false));
        }}
      />
    </div>
  );
}

function TrafficPanel() {
  const api = useApi();
  const { t } = useI18n();
  const status = useStream(api.status);
  const current = status.data.current;
  const available = current?.trafficAvailable ?? false;
  const downlinkRate = Number(current?.downlink ?? 0);
  const uplinkRate = Number(current?.uplink ?? 0);
  const downlinkTotal = current?.downlinkTotal ?? 0n;
  const uplinkTotal = current?.uplinkTotal ?? 0n;
  const rateText = (value: number) => (available ? `${formatBytes(value)}/s` : "…");
  const totalText = (value: bigint) => (available ? formatBytes(value) : "…");

  return (
    <Card
      icon="swap_horiz"
      title={t("Throughput")}
      actions={<span className={styles.range}>{t("Last 30 s")}</span>}
    >
      <div className={styles.rates}>
        <div className={styles.rate}>
          <div className={styles.rateLabel}>
            <span className={cx(styles.swatch, styles.swatchDown)} />
            {t("Download")}
          </div>
          <div className={styles.rateValue}>{rateText(downlinkRate)}</div>
          <div className={styles.rateTotal}>
            {t("Total")} {totalText(downlinkTotal)}
          </div>
        </div>
        <div className={styles.rate}>
          <div className={styles.rateLabel}>
            <span className={cx(styles.swatch, styles.swatchUp)} />
            {t("Upload")}
          </div>
          <div className={styles.rateValue}>{rateText(uplinkRate)}</div>
          <div className={styles.rateTotal}>
            {t("Total")} {totalText(uplinkTotal)}
          </div>
        </div>
      </div>
      <TrafficChart
        downlink={status.data.downlinkHistory}
        uplink={status.data.uplinkHistory}
      />
    </Card>
  );
}

function TrafficChart(props: { downlink: number[]; uplink: number[] }) {
  const { t } = useI18n();
  const gradientId = `traffic-${useId().replace(/:/g, "")}`;
  const regionRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const downlink = props.downlink;
  const uplink = props.uplink;
  const length = Math.max(downlink.length, uplink.length);
  const scaleMax = Math.max(1, ...downlink, ...uplink) * 1.18;
  const offset = CHART_CAPACITY - length;

  const slotX = (index: number) =>
    ((offset + index) / (CHART_CAPACITY - 1)) * CHART_WIDTH;
  const yOf = (value: number) =>
    CHART_HEIGHT - 2 - (value / scaleMax) * (CHART_HEIGHT - 10);
  const linePoints = (data: number[]) =>
    data
      .map((value, index) => `${slotX(index).toFixed(1)},${yOf(value).toFixed(1)}`)
      .join(" ");
  const areaPoints = (data: number[]) => {
    if (data.length < 2) {
      return "";
    }
    return `${slotX(0).toFixed(1)},${CHART_HEIGHT} ${linePoints(data)} ${slotX(data.length - 1).toFixed(1)},${CHART_HEIGHT}`;
  };

  const downIndex = hover !== null ? downlink.length - length + hover : -1;
  const upIndex = hover !== null ? uplink.length - length + hover : -1;
  const downValue = downIndex >= 0 && downIndex < downlink.length ? downlink[downIndex] : null;
  const upValue = upIndex >= 0 && upIndex < uplink.length ? uplink[upIndex] : null;
  const hoverX = hover !== null ? (slotX(hover) / CHART_WIDTH) * 100 : 0;
  const hoverSeconds = hover !== null ? length - 1 - hover : 0;
  const tooltipLeft = Math.min(86, Math.max(14, hoverX));

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (length === 0) {
      return;
    }
    const rect = regionRef.current?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0) {
      return;
    }
    const ratio = (event.clientX - rect.left) / rect.width;
    const slot = Math.round(ratio * (CHART_CAPACITY - 1));
    const index = slot - offset;
    setHover(index >= 0 && index < length ? index : null);
  };

  const ariaLabel = [
    `${t("Download")} ${formatBytes(downlink[downlink.length - 1] ?? 0)}/s`,
    `${t("Upload")} ${formatBytes(uplink[uplink.length - 1] ?? 0)}/s`,
  ].join(", ");

  return (
    <div className={styles.chartArea}>
      <div
        className={styles.chart}
        ref={regionRef}
        onPointerMove={onPointerMove}
        onPointerDown={onPointerMove}
        onPointerLeave={() => setHover(null)}
        onPointerCancel={() => setHover(null)}
      >
        <svg
          className={styles.chartSvg}
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={ariaLabel}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.2" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          {[0.25, 0.5, 0.75].map((ratio) => (
            <line
              key={ratio}
              x1={0}
              x2={CHART_WIDTH}
              y1={CHART_HEIGHT * ratio}
              y2={CHART_HEIGHT * ratio}
              stroke="var(--border)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {downlink.length > 1 && (
            <>
              <polygon points={areaPoints(downlink)} fill={`url(#${gradientId})`} />
              <polyline
                points={linePoints(downlink)}
                fill="none"
                stroke="var(--accent)"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            </>
          )}
          {uplink.length > 1 && (
            <polyline
              points={linePoints(uplink)}
              fill="none"
              stroke="var(--text-secondary)"
              strokeWidth={2}
              strokeDasharray="6 4"
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        {hover !== null && (
          <>
            <span className={styles.crosshair} style={{ left: `${hoverX}%` }} />
            {downValue !== null && (
              <span
                className={cx(styles.dot, styles.dotDown)}
                style={{
                  left: `${hoverX}%`,
                  top: `${(yOf(downValue) / CHART_HEIGHT) * 100}%`,
                }}
              />
            )}
            {upValue !== null && (
              <span
                className={cx(styles.dot, styles.dotUp)}
                style={{
                  left: `${hoverX}%`,
                  top: `${(yOf(upValue) / CHART_HEIGHT) * 100}%`,
                }}
              />
            )}
            <div className={styles.tooltip} style={{ left: `${tooltipLeft}%` }}>
              <div className={styles.tooltipTime}>
                {hoverSeconds === 0 ? t("Now") : `−${hoverSeconds}s`}
              </div>
              <div className={styles.tooltipRow}>
                <span className={cx(styles.swatch, styles.swatchDown)} />
                {t("Download")}
                <span className={styles.tooltipValue}>
                  {downValue !== null ? `${formatBytes(downValue)}/s` : "—"}
                </span>
              </div>
              <div className={styles.tooltipRow}>
                <span className={cx(styles.swatch, styles.swatchUp)} />
                {t("Upload")}
                <span className={styles.tooltipValue}>
                  {upValue !== null ? `${formatBytes(upValue)}/s` : "—"}
                </span>
              </div>
            </div>
          </>
        )}
      </div>
      <div className={styles.chartFooter}>
        <span>−{CHART_CAPACITY - 1}s</span>
        <span>{t("Now")}</span>
      </div>
      <div className={styles.srOnly}>
        <table>
          <caption>{t("Throughput")}</caption>
          <thead>
            <tr>
              <th>{t("Time")}</th>
              <th>{t("Download")}</th>
              <th>{t("Upload")}</th>
            </tr>
          </thead>
          <tbody>
            {downlink.map((value, index) => {
              const seconds = downlink.length - 1 - index;
              return (
                <tr key={index}>
                  <td>{seconds === 0 ? t("Now") : `−${seconds}s`}</td>
                  <td>{formatBytes(value)}/s</td>
                  <td>{formatBytes(uplink[index] ?? 0)}/s</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatTiles(props: { startedAt: number | null }) {
  const api = useApi();
  const { t } = useI18n();
  const status = useStream(api.status);
  const current = status.data.current;

  return (
    <section className={styles.tiles} aria-label={t("Status")}>
      <StatTile
        icon="cable"
        label={t("Connections")}
        value={
          current !== null ? String(current.connectionsIn + current.connectionsOut) : "…"
        }
        detail={
          current !== null
            ? `${t("Inbound")} ${current.connectionsIn} · ${t("Outbound")} ${current.connectionsOut}`
            : undefined
        }
        onClick={() => navigate("connections")}
      />
      <StatTile
        icon="memory"
        label={t("Memory")}
        value={current !== null ? formatMemoryBytes(current.memory) : "…"}
      />
      <StatTile
        icon="speed"
        label={t("Goroutines")}
        value={current !== null ? String(current.goroutines) : "…"}
      />
      <UptimeTile startedAt={props.startedAt} />
    </section>
  );
}

function StatTile(props: {
  icon: IconName;
  label: string;
  value: string;
  detail?: string;
  onClick?: () => void;
}) {
  const content = (
    <>
      <span className={styles.tileLabel}>
        <Icon name={props.icon} size={14} />
        {props.label}
      </span>
      <span className={styles.tileValue}>{props.value}</span>
      {props.detail !== undefined && <span className={styles.tileDetail}>{props.detail}</span>}
    </>
  );
  if (props.onClick !== undefined) {
    return (
      <button
        type="button"
        className={cx(styles.tile, styles.tileButton)}
        onClick={props.onClick}
      >
        {content}
      </button>
    );
  }
  return <div className={styles.tile}>{content}</div>;
}

function UptimeTile(props: { startedAt: number | null }) {
  const { t } = useI18n();
  const now = useNow(1000);
  const value =
    props.startedAt !== null && props.startedAt > 0
      ? formatUptime(props.startedAt, now)
      : "—";
  return <StatTile icon="schedule" label={t("Uptime")} value={value} />;
}

function ProxyGroupsPanel() {
  const api = useApi();
  const { t } = useI18n();
  const groups = useStream(api.groups);
  const visibleGroups = useMemo(
    () => groups.data.groups.filter((group) => group.items.length > 0),
    [groups.data.groups],
  );

  if (!groups.data.loaded || visibleGroups.length === 0) {
    return null;
  }
  return (
    <Card
      icon="hub"
      title={t("Proxy groups")}
      actions={
        <>
          <Badge>{visibleGroups.length}</Badge>
          <ViewAllLink label={t("Manage groups")} onClick={() => navigate("groups")} />
        </>
      }
    >
      <div className={styles.groupList}>
        {visibleGroups.map((group) => (
          <GroupRow key={group.tag} group={group} />
        ))}
      </div>
    </Card>
  );
}

function GroupRow(props: { group: Group }) {
  const api = useApi();
  const group = props.group;
  const [selected, setPending] = usePendingValue(group.selected);
  const selectedItem = group.items.find((item) => item.tag === selected);

  return (
    <div className={styles.groupRow}>
      <div className={styles.groupName}>
        <span className={styles.groupTag}>{group.tag}</span>
        <span className={styles.groupType}>{proxyDisplayType(group.type)}</span>
      </div>
      <div className={styles.groupControl}>
        {group.selectable ? (
          <Select
            options={group.items.map((item) => ({
              value: item.tag,
              label: <ProxyItemLabel name={item.tag} delay={item.urlTestDelay} />,
            }))}
            value={selected}
            placeholder="—"
            growMenu
            onChange={(tag) => {
              if (tag === selected) {
                return;
              }
              setPending(tag);
              api.selectOutbound(group.tag, tag).catch((error: unknown) => {
                setPending(null);
                showError(error);
              });
            }}
          />
        ) : (
          <span className={styles.groupStatic} title={selected}>
            <ProxyItemLabel
              name={selected !== "" ? selected : "—"}
              delay={selectedItem?.urlTestDelay ?? 0}
            />
          </span>
        )}
      </div>
    </div>
  );
}

function ProxyItemLabel(props: { name: string; delay: number }) {
  const tone = props.delay > 0 ? urlTestDelayTone(props.delay) : undefined;
  return (
    <span className={styles.optionLabel}>
      <span className={styles.optionName}>{props.name}</span>
      <Badge tone={tone}>{props.delay > 0 ? `${props.delay} ms` : "—"}</Badge>
    </span>
  );
}

function LiveConnectionsPanel() {
  const api = useApi();
  const { t } = useI18n();
  const connections = useStream(api.connections);
  const rows = useMemo(
    () => topActiveConnections(connections.data.rows.values(), CONNECTION_ROW_CAPACITY),
    [connections.data.rows],
  );
  const loading = !connections.data.loaded && connections.phase !== "error";

  return (
    <Card
      icon="cable"
      title={t("Live connections")}
      actions={<ViewAllLink label={t("View all")} onClick={() => navigate("connections")} />}
    >
      {loading ? (
        <div className={styles.hint}>{t("Loading...")}</div>
      ) : rows.length === 0 ? (
        <div className={styles.hint}>{t("No active connections")}</div>
      ) : (
        <div className={styles.connectionList}>
          {rows.map((row) => (
            <ConnectionLink key={row.connection.id} row={row} />
          ))}
        </div>
      )}
    </Card>
  );
}

function ConnectionLink(props: { row: ConnectionRow }) {
  const connection = props.row.connection;
  const chain = [...connection.chainList].reverse();
  const outbound = chain[0] ?? connection.outbound;
  const name = connection.domain || connection.destination || connection.id;
  const meta = [outbound, connection.network.toUpperCase()].filter(Boolean).join(" · ");

  return (
    <button
      type="button"
      className={styles.connectionRow}
      onClick={() => navigate("connections")}
    >
      <span className={styles.connectionMain}>
        <span className={styles.connectionName}>{name}</span>
        <span className={styles.connectionMeta}>{meta}</span>
      </span>
      <span className={styles.connectionRates}>
        <span>↓ {formatBytes(props.row.downlinkRate)}/s</span>
        <span>↑ {formatBytes(props.row.uplinkRate)}/s</span>
      </span>
    </button>
  );
}

function ViewAllLink(props: { label: string; onClick: () => void }) {
  return (
    <button type="button" className={styles.viewAll} onClick={props.onClick}>
      {props.label}
      <Icon name="keyboard_arrow_right" size={14} />
    </button>
  );
}
