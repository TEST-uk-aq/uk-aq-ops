export type StationLinkedRow = {
  station_id: number | null;
};

export type StationFkPartition<T extends StationLinkedRow> = {
  validRows: T[];
  skippedRows: T[];
  missingStationIds: number[];
};

export function partitionRowsByExistingStations<T extends StationLinkedRow>(
  rows: T[],
  existingStationIds: Set<number>,
): StationFkPartition<T> {
  const validRows: T[] = [];
  const skippedRows: T[] = [];
  const missingStationIds = new Set<number>();

  for (const row of rows) {
    const stationId = row.station_id;
    if (stationId !== null && !existingStationIds.has(stationId)) {
      skippedRows.push(row);
      missingStationIds.add(stationId);
      continue;
    }
    validRows.push(row);
  }

  return {
    validRows,
    skippedRows,
    missingStationIds: Array.from(missingStationIds).sort((a, b) => a - b),
  };
}
