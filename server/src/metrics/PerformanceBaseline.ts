import StatsWindow, { type StatsWindowSnapshot } from '@/metrics/StatsWindow';
import msgpackr from '@/shared/helpers/msgpackr';
import type { AnyPacket } from '@hytopia.com/server-protocol';
import { PacketId } from '@hytopia.com/server-protocol';

type PacketFamilyCounters = {
  batchCount: number;
  packetCount: number;
  rawBytes: number;
  wireBytes: number;
};

type PacketBatchCounters = {
  compressedBatches: number;
  rawBytes: number;
  reliableBatches: number;
  totalBatches: number;
  unreliableBatches: number;
  wireBytes: number;
};

export type PerformanceBaselineSnapshot = {
  generatedAt: string;
  packets: {
    batches: PacketBatchCounters & {
      compressionRatio: number;
    };
    families: Record<string, PacketFamilyCounters & {
      averageRawBytes: number;
      averageWireBytes: number;
    }>;
  };
  spans: Record<string, StatsWindowSnapshot>;
  worlds: Record<string, Record<string, StatsWindowSnapshot>>;
};

const DEFAULT_SCOPE_ID = 'global';
const DEFAULT_STATS_WINDOW_CAPACITY = 256;

export default class PerformanceBaseline {
  private static _packetBatchCounters: PacketBatchCounters = {
    compressedBatches: 0,
    rawBytes: 0,
    reliableBatches: 0,
    totalBatches: 0,
    unreliableBatches: 0,
    wireBytes: 0,
  };

  private static _packetFamilies: Map<string, PacketFamilyCounters> = new Map();
  private static _spanWindows: Map<string, StatsWindow> = new Map();
  private static _worldScopedSpanWindows: Map<string, Map<string, StatsWindow>> = new Map();

  public static recordPackets(
    packets: AnyPacket[],
    options: {
      rawBytes: number;
      reliable: boolean;
      wireBytes: number;
    },
  ): void {
    if (packets.length === 0) {
      return;
    }

    const { rawBytes, reliable, wireBytes } = options;

    PerformanceBaseline._packetBatchCounters.totalBatches++;
    PerformanceBaseline._packetBatchCounters.rawBytes += rawBytes;
    PerformanceBaseline._packetBatchCounters.wireBytes += wireBytes;
    if (reliable) {
      PerformanceBaseline._packetBatchCounters.reliableBatches++;
    } else {
      PerformanceBaseline._packetBatchCounters.unreliableBatches++;
    }
    if (wireBytes < rawBytes) {
      PerformanceBaseline._packetBatchCounters.compressedBatches++;
    }

    let totalEstimatedRawBytes = 0;
    const packetRawBytes: number[] = new Array<number>(packets.length);
    for (let i = 0; i < packets.length; i++) {
      const estimatedRawBytes = (msgpackr.pack(packets[i]) as unknown as Uint8Array).byteLength;
      packetRawBytes[i] = estimatedRawBytes;
      totalEstimatedRawBytes += estimatedRawBytes;
    }

    for (let i = 0; i < packets.length; i++) {
      const packet = packets[i];
      const family = PerformanceBaseline._packetFamilyName(packet);
      const counters = PerformanceBaseline._getOrCreatePacketFamilyCounters(family);
      const estimatedRawBytes = packetRawBytes[i];
      const estimatedWireBytes = totalEstimatedRawBytes > 0
        ? (estimatedRawBytes / totalEstimatedRawBytes) * wireBytes
        : 0;

      counters.packetCount++;
      counters.rawBytes += estimatedRawBytes;
      counters.wireBytes += estimatedWireBytes;
    }

    const countedFamilies = new Set<string>();
    for (let i = 0; i < packets.length; i++) {
      countedFamilies.add(PerformanceBaseline._packetFamilyName(packets[i]));
    }

    for (const family of countedFamilies) {
      PerformanceBaseline._getOrCreatePacketFamilyCounters(family).batchCount++;
    }
  }

  public static recordForwardedPacketBatch(options: {
    packetCount: number;
    rawBytes: number;
    reliable: boolean;
    wireBytes: number;
  }): void {
    if (options.packetCount <= 0) {
      return;
    }

    const { rawBytes, reliable, wireBytes } = options;
    PerformanceBaseline._packetBatchCounters.totalBatches++;
    PerformanceBaseline._packetBatchCounters.rawBytes += rawBytes;
    PerformanceBaseline._packetBatchCounters.wireBytes += wireBytes;
    if (reliable) {
      PerformanceBaseline._packetBatchCounters.reliableBatches++;
    } else {
      PerformanceBaseline._packetBatchCounters.unreliableBatches++;
    }
    if (wireBytes < rawBytes) {
      PerformanceBaseline._packetBatchCounters.compressedBatches++;
    }
  }

  public static recordSpan(
    operation: string,
    durationMs: number,
    attributes?: Record<string, string | number>,
  ): void {
    PerformanceBaseline._getOrCreateWindow(PerformanceBaseline._spanWindows, operation).record(durationMs);

    const worldScopeId = attributes?.worldId;
    if (worldScopeId === undefined) {
      return;
    }

    const scopeKey = typeof worldScopeId === 'number' || typeof worldScopeId === 'string'
      ? String(worldScopeId)
      : DEFAULT_SCOPE_ID;

    let scopedWindows = PerformanceBaseline._worldScopedSpanWindows.get(scopeKey);
    if (!scopedWindows) {
      scopedWindows = new Map();
      PerformanceBaseline._worldScopedSpanWindows.set(scopeKey, scopedWindows);
    }

    PerformanceBaseline._getOrCreateWindow(scopedWindows, operation).record(durationMs);
  }

  public static reset(): void {
    PerformanceBaseline._packetBatchCounters = {
      compressedBatches: 0,
      rawBytes: 0,
      reliableBatches: 0,
      totalBatches: 0,
      unreliableBatches: 0,
      wireBytes: 0,
    };

    PerformanceBaseline._packetFamilies.clear();
    PerformanceBaseline._spanWindows.clear();
    PerformanceBaseline._worldScopedSpanWindows.clear();
  }

  public static snapshot(): PerformanceBaselineSnapshot {
    const rawBytes = PerformanceBaseline._packetBatchCounters.rawBytes;
    const wireBytes = PerformanceBaseline._packetBatchCounters.wireBytes;

    return {
      generatedAt: new Date().toISOString(),
      packets: {
        batches: {
          ...PerformanceBaseline._packetBatchCounters,
          compressionRatio: rawBytes > 0 ? wireBytes / rawBytes : 0,
        },
        families: Object.fromEntries(
          Array.from(PerformanceBaseline._packetFamilies.entries())
            .sort(([ left ], [ right ]) => left.localeCompare(right))
            .map(([ family, counters ]) => [
              family,
              {
                ...counters,
                averageRawBytes: counters.packetCount > 0 ? counters.rawBytes / counters.packetCount : 0,
                averageWireBytes: counters.packetCount > 0 ? counters.wireBytes / counters.packetCount : 0,
              },
            ]),
        ),
      },
      spans: PerformanceBaseline._snapshotWindows(PerformanceBaseline._spanWindows),
      worlds: Object.fromEntries(
        Array.from(PerformanceBaseline._worldScopedSpanWindows.entries())
          .sort(([ left ], [ right ]) => left.localeCompare(right))
          .map(([ scope, windows ]) => [scope, PerformanceBaseline._snapshotWindows(windows)]),
      ),
    };
  }

  private static _getOrCreatePacketFamilyCounters(family: string): PacketFamilyCounters {
    let counters = PerformanceBaseline._packetFamilies.get(family);
    if (!counters) {
      counters = {
        batchCount: 0,
        packetCount: 0,
        rawBytes: 0,
        wireBytes: 0,
      };
      PerformanceBaseline._packetFamilies.set(family, counters);
    }

    return counters;
  }

  private static _getOrCreateWindow(windows: Map<string, StatsWindow>, operation: string): StatsWindow {
    let window = windows.get(operation);
    if (!window) {
      window = new StatsWindow(DEFAULT_STATS_WINDOW_CAPACITY);
      windows.set(operation, window);
    }

    return window;
  }

  private static _packetFamilyName(packet: AnyPacket): string {
    return PacketId[packet[0]] ?? String(packet[0]);
  }

  private static _snapshotWindows(windows: Map<string, StatsWindow>): Record<string, StatsWindowSnapshot> {
    return Object.fromEntries(
      Array.from(windows.entries())
        .sort(([ left ], [ right ]) => left.localeCompare(right))
        .map(([ operation, window ]) => [operation, window.snapshot()]),
    );
  }
}
