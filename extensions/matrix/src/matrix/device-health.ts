// Matrix plugin module implements device health behavior.
export type MatrixManagedDeviceInfo = {
  deviceId: string;
  displayName: string | null;
  current: boolean;
};

type MatrixDeviceHealthSummary = {
  currentDeviceId: string | null;
  staleAforaDevices: MatrixManagedDeviceInfo[];
  currentAforaDevices: MatrixManagedDeviceInfo[];
};

const AFORA_DEVICE_NAME_PREFIX = "Afora ";

export function isAforaManagedMatrixDevice(displayName: string | null | undefined): boolean {
  return displayName?.startsWith(AFORA_DEVICE_NAME_PREFIX) === true;
}

export function summarizeMatrixDeviceHealth(
  devices: MatrixManagedDeviceInfo[],
): MatrixDeviceHealthSummary {
  const currentDeviceId = devices.find((device) => device.current)?.deviceId ?? null;
  const aforaDevices = devices.filter((device) =>
    isAforaManagedMatrixDevice(device.displayName),
  );
  return {
    currentDeviceId,
    staleAforaDevices: aforaDevices.filter((device) => !device.current),
    currentAforaDevices: aforaDevices.filter((device) => device.current),
  };
}
