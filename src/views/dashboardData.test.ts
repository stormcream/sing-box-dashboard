import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";

import { ConnectionSchema } from "../gen/daemon/started_service_pb";
import type { ConnectionRow } from "../api/daemon";
import { topActiveConnections } from "./dashboardData";

function row(
  id: string,
  uplinkRate: number,
  downlinkRate: number,
  closedAt: number | null = null,
): ConnectionRow {
  return {
    connection: create(ConnectionSchema, { id }),
    uplinkRate,
    downlinkRate,
    uplinkTotal: 0n,
    downlinkTotal: 0n,
    closedAt,
  };
}

describe("topActiveConnections", () => {
  it("keeps active connections ordered by combined rate", () => {
    const rows = [
      row("slow", 1, 2),
      row("fast", 100, 200),
      row("closed", 999, 999, 123),
      row("medium", 10, 0),
    ];
    expect(topActiveConnections(rows, 2).map((entry) => entry.connection.id)).toEqual([
      "fast",
      "medium",
    ]);
  });

  it("honours the limit", () => {
    const rows = [row("a", 1, 0), row("b", 2, 0), row("c", 3, 0)];
    expect(topActiveConnections(rows, 2)).toHaveLength(2);
    expect(topActiveConnections(rows, 0)).toHaveLength(0);
  });
});
