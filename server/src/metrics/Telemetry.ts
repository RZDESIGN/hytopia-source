import * as Sentry from '@sentry/node';
import PerformanceBaseline from '@/metrics/PerformanceBaseline';
import { SDK_VERSION } from '@/networking/WebServer';

/**
 * Performance telemetry span operation types.
 *
 * **Category:** Telemetry
 * @public
 */
export enum TelemetrySpanOperation {
  BUILD_PACKETS               = 'build_packets',
  ENTITIES_EMIT_UPDATES       = 'entities_emit_updates',
  ENTITIES_TICK               = 'entities_tick',
  NETWORK_SYNCHRONIZE         = 'network_synchronize',
  NETWORK_SYNCHRONIZE_CLEANUP = 'network_synchronize_cleanup',
  PHYSICS_CLEANUP             = 'physics_cleanup',
  PHYSICS_STEP                = 'physics_step',
  SEND_ALL_PACKETS            = 'send_all_packets',
  SEND_PACKETS                = 'send_packets',
  SERIALIZE_FREE_BUFFERS      = 'serialize_free_buffers',
  SERIALIZE_PACKETS           = 'serialize_packets',
  SERIALIZE_PACKETS_ENCODE    = 'serialize_packets_encode',
  SIMULATION_STEP             = 'simulation_step',
  TICKER_TICK                 = 'ticker_tick',
  WORLD_TICK                  = 'world_tick',
}

/**
 * Options for creating a telemetry span.
 *
 * Use for: configuring `Telemetry.startSpan` calls.
 * Do NOT use for: long-lived spans; keep spans short and scoped to a task.
 *
 * **Category:** Telemetry
 * @public
 */
export type TelemetrySpanOptions = {
  /** The operation being measured. */
  operation: TelemetrySpanOperation | string,

  /** Additional attributes to attach to the span for context. */
  attributes?: Record<string, string | number>,
}

/**
 * Manages performance telemetry and error tracking through your Sentry account.
 *
 * When to use: profiling and diagnosing slow ticks or runtime errors in production.
 * Do NOT use for: high-volume custom metrics; use a dedicated metrics pipeline instead.
 *
 * @remarks
 * Provides low-overhead performance monitoring and error tracking via Sentry.
 * The system only sends telemetry data when errors or slow-tick performance issues are detected.
 *
 * Pattern: initialize once at server startup and wrap critical sections with `Telemetry.startSpan`.
 * Anti-pattern: creating spans inside tight loops without filtering.
 *
 * @example
 * ```typescript
 * // Initialize Sentry for production telemetry
 * Telemetry.initializeSentry('MY_SENTRY_PROJECT_DSN');
 *
 * // Wrap performance-critical code in spans
 * Telemetry.startSpan({
 *   operation: TelemetrySpanOperation.CUSTOM_OPERATION,
 *   attributes: {
 *     playerCount: world.playerManager.connectedPlayers.length,
 *     entityCount: world.entityManager.entityCount,
 *   },
 * }, () => {
 *   performExpensiveOperation();
 * });
 *
 * // Get current process statistics
 * const stats = Telemetry.getProcessStats();
 * console.log(`Heap usage: ${stats.jsHeapUsagePercent * 100}%`);
 * ```
 *
 * **Category:** Telemetry
 * @public
 */
export default class Telemetry {
  /**
   * Gets current process memory and performance statistics.
   *
   * @param asMeasurement - Whether to return data in Sentry measurement format with units.
   * @returns Process statistics including heap usage, RSS memory, and capacity metrics.
   *
   * **Category:** Telemetry
   */
  public static getProcessStats(asMeasurement: boolean = false): Record<string, any> {
    const processMemory = process.memoryUsage();

    const processMeasurements = {
      jsHeapSizeMb: {
        value: processMemory.heapUsed / 1024 / 1024,
        unit: 'megabyte',
      },
      jsHeapCapacityMb: {
        value: processMemory.heapTotal / 1024 / 1024,
        unit: 'megabyte',
      },
      jsHeapUsagePercent: {
        value: processMemory.heapUsed / processMemory.heapTotal,
        unit: 'percent',
      },
      processHeapSizeMb: {
        value: processMemory.heapUsed / 1024 / 1024,
        unit: 'megabyte',
      },
      rssSizeMb: {
        value: processMemory.rss / 1024 / 1024,
        unit: 'megabyte',
      },
    };

    if (asMeasurement) {
      return processMeasurements;
    }

    return Object.fromEntries(
      Object.entries(processMeasurements).map(([ key, measurement ]) => [ key, measurement.value ]),
    );
  }

  /**
   * Initializes Sentry telemetry with the provided DSN.
   *
   * @remarks
   * This method configures Sentry for error tracking and performance monitoring.
   * It sets up filtering to only send performance spans that exceed the
   * provided threshold duration, reducing noise and costs. The initialization
   * includes game-specific tags and process statistics attachment.
   *
   * @param sentryDsn - The Sentry Data Source Name (DSN) for your project.
   * @param tickTimeMsThreshold - The tick duration that must be exceeded to
   * send a performance span to Sentry for a given tick. Defaults to 50ms.
   *
   * **Requires:** A valid Sentry DSN and network access.
   *
   * **Side effects:** Initializes the Sentry SDK and registers global hooks.
   *
   * **Category:** Telemetry
   */
  public static initializeSentry(sentryDsn: string, tickTimeMsThreshold: number = 50) {
    if (Sentry.isInitialized()) {
      return;
    }

    Sentry.init({
      dsn: sentryDsn,
      release: SDK_VERSION,
      environment: process.env.NODE_ENV || 'development',
      tracesSampleRate: 1,
      initialScope: {
        tags: {
          gameId: process.env.HYTOPIA_GAME_ID ?? 'unknown',
          gameSlug: process.env.HYTOPIA_GAME_SLUG ?? 'unknown',
          lobbyId: process.env.HYTOPIA_LOBBY_ID ?? 'unknown',
          region: process.env.REGION ?? 'unknown',
        },
      },
      beforeSend: event => {
        event.extra = Telemetry.getProcessStats();

        return event;
      },
      beforeSendTransaction: event => {
        const spanOp = event.contexts?.trace?.op;

        /**
         * The Ticker handles fixed timestep and will process multiple world ticks
         * in a single ticker tick if the accumulator balloons.
         */
        if (spanOp === TelemetrySpanOperation.TICKER_TICK) {
          const startTimestamp = event?.start_timestamp;
          const endTimestamp = event?.timestamp;

          if (!startTimestamp || !endTimestamp) { return null; }

          const tickTimeMs = (endTimestamp - startTimestamp) * 1000;

          if (tickTimeMs > tickTimeMsThreshold) {
            event.measurements = Telemetry.getProcessStats(true);

            return event;
          }        
        }

        // Ignore any other root trace/span explicitly for now.
        return null;
      },
    });
  }

  /**
   * Executes a callback function within a performance monitoring span.
   *
   * @remarks
   * This method provides zero-overhead performance monitoring in development
   * environments. In production with Sentry enabled and `SENTRY_ENABLE_TRACING=true`,
   * it creates performance spans for monitoring. The span data is only transmitted
   * to Sentry when performance issues are detected.
   *
   * @param options - Configuration for the telemetry span including operation type and attributes.
   * @param callback - The function to execute within the performance span.
   * @returns The return value of the callback function.
   *
   * @example
   * ```typescript
   * const result = Telemetry.startSpan({
   *   operation: TelemetrySpanOperation.ENTITIES_TICK,
   *   attributes: {
   *     entityCount: entities.length,
   *     worldId: world.id,
   *   },
   * }, () => {
   *   return processEntities(entities);
   * });
   * ```
   *
   * **Category:** Telemetry
   */
  public static startSpan<T>(options: TelemetrySpanOptions, callback: (span?: Sentry.Span) => T): T {
    const runCallback = (span?: Sentry.Span): T => {
      const startTimeMs = performance.now();
      try {
        return callback(span);
      } finally {
        PerformanceBaseline.recordSpan(
          options.operation,
          performance.now() - startTimeMs,
          options.attributes,
        );
      }
    };

    if (Sentry.isInitialized()) {
      return Sentry.startSpan({
        attributes: options.attributes,
        name: options.operation,
        op: options.operation,
      }, runCallback);
    } else {
      return runCallback();
    }
  }

  /**
   * Gets the Sentry SDK instance for advanced telemetry operations.
   *
   * @remarks
   * This method provides direct access to the Sentry SDK for operations
   * not covered by the Telemetry wrapper, such as custom error reporting,
   * user context setting, or advanced span manipulation.
   *
   * @returns The Sentry SDK instance.
   *
   * **Category:** Telemetry
   */
  public static sentry(): typeof Sentry {
    return Sentry;
  }
}
