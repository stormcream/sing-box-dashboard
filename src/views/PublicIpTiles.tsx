import { useEffect, useRef, useState } from "react";

import {
  lookupPublicIp,
  publicCountryName,
  publicPlaceName,
  type LookupDirection,
  type PublicIpResult,
} from "../api/publicIp";
import { useI18n, type MessageKey } from "../app/i18n";
import { Icon, type IconName } from "../components/Icon";
import { Spinner } from "../components/ui";
import styles from "./PublicIpTiles.module.css";

const DIRECTIONS: { direction: LookupDirection; icon: IconName; label: MessageKey }[] = [
  { direction: "china", icon: "language", label: "Domestic IP" },
  { direction: "foreign", icon: "public", label: "Foreign IP" },
];

type LoadState =
  | { phase: "loading" }
  | { phase: "ready"; result: PublicIpResult }
  | { phase: "failed" };

const LOADING: LoadState = { phase: "loading" };

/**
 * Stat tiles for the two public exits, rendered in place of the uptime tile.
 *
 * Each direction is queried on its own, so a slow or blocked service on one
 * side leaves the other value intact. Pressing a tile re-queries both; a
 * service restart (`startedAt`) counts as a refresh too.
 */
export function PublicIpTiles(props: { startedAt: number | null }) {
  const { language } = useI18n();
  const [refreshKey, setRefreshKey] = useState(0);
  const [states, setStates] = useState<Record<LookupDirection, LoadState>>({
    china: LOADING,
    foreign: LOADING,
  });
  // Discards replies from a refresh that has already been superseded.
  const requestId = useRef(0);

  useEffect(() => {
    const request = ++requestId.current;
    const controller = new AbortController();
    setStates({ china: LOADING, foreign: LOADING });
    for (const { direction } of DIRECTIONS) {
      lookupPublicIp(direction, controller.signal).then(
        (result) => {
          if (!controller.signal.aborted && requestId.current === request) {
            setStates((prev) => ({ ...prev, [direction]: { phase: "ready", result } }));
          }
        },
        () => {
          if (!controller.signal.aborted && requestId.current === request) {
            setStates((prev) => ({ ...prev, [direction]: { phase: "failed" } }));
          }
        },
      );
    }
    return () => controller.abort();
  }, [refreshKey, props.startedAt]);

  return (
    <>
      {DIRECTIONS.map(({ direction, icon, label }) => (
        <PublicIpTile
          key={direction}
          icon={icon}
          label={label}
          state={states[direction]}
          language={language}
          onRefresh={() => setRefreshKey((value) => value + 1)}
        />
      ))}
    </>
  );
}

function PublicIpTile(props: {
  icon: IconName;
  label: MessageKey;
  state: LoadState;
  language: string;
  onRefresh: () => void;
}) {
  const { t } = useI18n();
  const result = props.state.phase === "ready" ? props.state.result : null;
  const detail =
    result === null
      ? ""
      : [publicCountryName(result, props.language), publicPlaceName(result, props.language)]
          .filter(Boolean)
          .join(" · ");

  return (
    <button
      type="button"
      className={styles.tile}
      title={`${t("Refresh")} · ${t(props.label)}`}
      onClick={props.onRefresh}
    >
      <span className={styles.label}>
        <Icon name={props.icon} size={14} />
        {t(props.label)}
        <span className={styles.sync}>
          <Icon name="sync" size={13} />
        </span>
      </span>
      {result === null ? (
        <span className={styles.placeholder}>
          {props.state.phase === "loading" ? <Spinner /> : t("Unavailable")}
        </span>
      ) : (
        <span className={styles.value}>{result.ip}</span>
      )}
      {detail !== "" && <span className={styles.detail}>{detail}</span>}
    </button>
  );
}
