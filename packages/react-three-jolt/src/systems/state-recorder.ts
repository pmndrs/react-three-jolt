// World/body snapshots for save + restore, a.k.a. "rewind" (issue #247).
//
// Wraps a Jolt `StateRecorderImpl` - an in-memory byte buffer Jolt writes its own state into and
// reads it back out of. `PhysicsSystem.saveState()` / `BodyState.saveState()` write into a fresh
// one and hand it back wrapped here; the matching `restoreState()` rewinds the recorder's read
// cursor (`StateRecorderImpl.Rewind()`) and replays it. A snapshot owns real WASM heap - the
// recorded bytes - until `destroy()` frees it; restoring one does not consume it, so the same
// snapshot can be restored any number of times (a rewind ring buffer keeps one per recorded
// frame, trading heap for history depth).

import type Jolt from 'jolt-physics';
import { Raw } from '../raw';
import { disposedGuard } from '../utils';

/**
 * An opaque, destroyable snapshot of physics state - either a whole world
 * ({@link PhysicsSystem.saveState}) or a single body ({@link BodyState.saveState}). Built by
 * those methods, not directly.
 *
 * Every method guards `destroyed` the same way the rest of the library guards a torn-down world
 * (issue #227): a silent no-op by default, an `Error` once `setDebug(true)` is on.
 */
export class PhysicsSnapshot {
    /** @internal the Jolt-side byte buffer this snapshot wraps. */
    readonly recorder: Jolt.StateRecorderImpl;
    /** True once {@link destroy} has run. */
    destroyed = false;

    /** @internal built by `PhysicsSystem.saveState()` / `BodyState.saveState()`. */
    constructor(recorder: Jolt.StateRecorderImpl) {
        this.recorder = recorder;
    }

    /**
     * Reset the recorder's read cursor to the start. `RestoreState` reads forward from wherever
     * the cursor sits, and a fresh save leaves it at the end of what it just wrote - every
     * `restoreState()` calls this first so the same snapshot can be replayed any number of times.
     */
    rewind(): void {
        if (this.checkDestroyed()) return;
        this.recorder.Rewind();
    }

    /**
     * Byte-for-byte comparison against another snapshot, via Jolt's own
     * `StateRecorderImpl.IsEqual`. Handy for a determinism check: save at t0, step forward,
     * restore to t0, step forward again the same way, save again, and compare the two saves.
     */
    isEqual(other: PhysicsSnapshot): boolean {
        if (this.checkDestroyed() || other.checkDestroyed()) return false;
        return this.recorder.IsEqual(other.recorder);
    }

    /** Free the WASM-side byte buffer. Idempotent - safe to call more than once. */
    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        Raw.module.destroy(this.recorder);
    }

    private checkDestroyed(): boolean {
        if (!this.destroyed) return false;
        disposedGuard('PhysicsSnapshot was destroyed');
        return true;
    }
}
