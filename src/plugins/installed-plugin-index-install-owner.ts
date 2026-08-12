type InstalledPluginIndexInstallOwner = { installOwner?: string; ambiguous?: true };
type InstalledPluginIndexRecordWithOwner = {
  installOwner?: string;
  installOwnerAmbiguous?: true;
};

export function recordInstalledPluginIndexInstallOwner<T extends object>(
  record: T,
  installOwner: string | undefined,
  ambiguous = false,
): T {
  if (!installOwner && !ambiguous) {
    return record;
  }
  const ownedRecord = record as T & InstalledPluginIndexRecordWithOwner;
  if (ambiguous) {
    delete ownedRecord.installOwner;
    ownedRecord.installOwnerAmbiguous = true;
  } else {
    ownedRecord.installOwner = installOwner;
    delete ownedRecord.installOwnerAmbiguous;
  }
  return record;
}

function readInstalledPluginIndexInstallOwner<TRecord extends object>(
  record: TRecord,
): InstalledPluginIndexInstallOwner | undefined {
  const ownedRecord = record as InstalledPluginIndexRecordWithOwner;
  return ownedRecord.installOwnerAmbiguous
    ? { ambiguous: true }
    : ownedRecord.installOwner
      ? { installOwner: ownedRecord.installOwner }
      : undefined;
}

export function resolveInstalledPluginIndexInstallOwner<TRecord extends object>(
  record: TRecord,
): string | undefined {
  return readInstalledPluginIndexInstallOwner(record)?.installOwner;
}

export function isInstalledPluginIndexInstallOwnerAmbiguous<TRecord extends object>(
  record: TRecord,
): boolean {
  return readInstalledPluginIndexInstallOwner(record)?.ambiguous === true;
}
