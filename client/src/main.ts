import Game from './Game';
import PerformanceMetricsManager from './core/PerformanceMetricsManager';

(async () => {
  const params = new URLSearchParams(window.location.search);

  if (params.has('sessionToken') && params.has('lobbyId')) {
    void import('./services/hytopia/heartbeat').catch((error) => {
      console.error('Failed to start HYTOPIA heartbeat.', error);
    });
  }

  // To measure a more accurate refresh rate, we do so before starting the game.
  // Concerns:
  // * This may delay the game start slightly — will it affect user experience? The delay is likely
  //   short enough to be negligible, but if it's a concern, we could perform the measurement
  //   in parallel with the server connection, assuming that process is lightweight.
  // * Refresh rate measurement only runs while the tab is active. If the tab remains inactive,
  //   the measurement will never complete, and server connection or game start won't proceed.
  //   Is this acceptable?

  // Test potential cause of game join -> ready failure?
  void PerformanceMetricsManager.measureRefreshRate().catch(console.error);

  Game.instance.start();
})();
