// Measures animation-frame cadence, not GPU execution time. Ignore hidden tabs
// and restart the sample after renderer switches and asset builds.
export class FrameMeter {
  constructor(onSample) { this.onSample = onSample; this.reset(); }
  reset() { this.previous = null; this.elapsed = 0; this.frames = 0; }
  tick(now, active = true) {
    if (!active || !Number.isFinite(now)) { this.reset(); return; }
    if (this.previous === null) { this.previous = now; return; }
    const delta = now - this.previous;
    this.previous = now;
    if (delta <= 0) return;
    this.elapsed += delta; this.frames++;
    if (this.elapsed >= 500) {
      this.onSample({fps:1000*this.frames/this.elapsed, ms:this.elapsed/this.frames});
      this.elapsed = 0; this.frames = 0;
    }
  }
}
