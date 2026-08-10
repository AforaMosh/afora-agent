export type NativeHookRelayBridgeRecord = {
  relayId: string;
  pid: number;
  hostname: "127.0.0.1";
  port: number;
  token: string;
  expiresAtMs: number;
};

type NativeHookRelayBridgeRow = {
  relay_id: unknown;
  pid: unknown;
  hostname: unknown;
  port: unknown;
  token: unknown;
  expires_at_ms: unknown;
};

/** Validate an authoritative relay claim, including its non-routable pending locator. */
export function readNativeHookRelayBridgeClaimRow(
  row: NativeHookRelayBridgeRow | undefined,
): NativeHookRelayBridgeRecord | undefined {
  if (
    !row ||
    typeof row.relay_id !== "string" ||
    row.relay_id.length === 0 ||
    !Number.isSafeInteger(row.pid) ||
    row.hostname !== "127.0.0.1" ||
    !Number.isSafeInteger(row.port) ||
    Number(row.port) < 0 ||
    Number(row.port) > 65_535 ||
    typeof row.token !== "string" ||
    row.token.length === 0 ||
    !Number.isSafeInteger(row.expires_at_ms)
  ) {
    return undefined;
  }
  return {
    relayId: row.relay_id,
    pid: Number(row.pid),
    hostname: row.hostname,
    port: Number(row.port),
    token: row.token,
    expiresAtMs: Number(row.expires_at_ms),
  };
}

/** Validate and convert a routable persisted native relay locator row. */
export function readNativeHookRelayBridgeRecordRow(
  row: NativeHookRelayBridgeRow | undefined,
): NativeHookRelayBridgeRecord | undefined {
  const record = readNativeHookRelayBridgeClaimRow(row);
  return record && record.port > 0 ? record : undefined;
}
