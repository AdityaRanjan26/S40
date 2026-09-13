/** On-device port of voice/leaky_bucket.py's LeakyBucketAccumulator. */
export class LeakyBucketAccumulator {
  private capacity: number;
  private leakRate: number;
  currentLevel = 0.0;
  private lastUpdate = Date.now();

  constructor(capacity = 1.0, leakRate = 0.02) {
    this.capacity = capacity;
    this.leakRate = leakRate;
  }

  addRisk(riskDelta: number): number {
    const now = Date.now();
    const elapsedSec = (now - this.lastUpdate) / 1000;
    this.lastUpdate = now;

    this.currentLevel = Math.max(0.0, this.currentLevel - elapsedSec * this.leakRate);
    this.currentLevel = Math.min(this.capacity, this.currentLevel + riskDelta);
    return this.currentLevel;
  }

  reset(): void {
    this.currentLevel = 0.0;
    this.lastUpdate = Date.now();
  }
}
