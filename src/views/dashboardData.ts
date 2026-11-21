import type { ConnectionRow } from "../api/daemon";

export function topActiveConnections(
  rows: Iterable<ConnectionRow>,
  limit: number,
): ConnectionRow[] {
  const active: ConnectionRow[] = [];
  for (const row of rows) {
    if (row.closedAt === null) {
      active.push(row);
    }
  }
  active.sort(
    (left, right) =>
      right.uplinkRate + right.downlinkRate - (left.uplinkRate + left.downlinkRate),
  );
  return active.slice(0, Math.max(0, limit));
}
