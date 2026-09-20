/**
 * The deferred half of the contact pipeline: a fixed width event queue, the sub-shape pair
 * refcount that enter/persist/exit are derived from, and the payload pool.
 *
 * Jolt fires `ContactListener` callbacks from inside `PhysicsSystem::Update`, i.e. inside
 * `joltInterface.Step()`. Adding, removing or mutating a body there is illegal, and the
 * `ContactManifold` / `ContactSettings` pointers are into memory Jolt reuses the moment the
 * step returns. So the callback writes numbers into these arrays and returns; everything user
 * facing is dispatched from `BodySystem.flushEvents()` between `Step()` and `afterStep`.
 */

import { Vector3 } from 'three';
import type {
    ActivationPayload,
    CollisionEnterPayload,
    CollisionPayload,
    CollisionTarget,
    SubShapeRef
} from './events';

/** Record kinds stored in the queue. */
export const EventKind = {
    collisionEnter: 0,
    collisionPersist: 1,
    collisionExit: 2,
    sensorEnter: 3,
    sensorExit: 4,
    sleep: 5,
    wake: 6
} as const;
export type EventKind = (typeof EventKind)[keyof typeof EventKind];

/**
 * Dispatch order within one flush: every exit, then every enter, then persists, then
 * sleep/wake. Exits first so a handler keeping a "things I am touching" set is never
 * transiently over-counted while a contact migrates between sub-shapes.
 */
export const FLUSH_ORDER: readonly number[] = [
    EventKind.collisionExit,
    EventKind.sensorExit,
    EventKind.collisionEnter,
    EventKind.sensorEnter,
    EventKind.collisionPersist,
    EventKind.sleep,
    EventKind.wake
];

/** Record kind -> the event name it is dispatched under. */
export const KIND_EVENT: readonly string[] = [
    'collisionEnter',
    'collisionPersist',
    'collisionExit',
    'sensorEnter',
    'sensorExit',
    'sleep',
    'wake'
];

// per record: handle1, handle2, sub1, sub2, contactCount, pointCount
const HANDLE_FIELDS = 6;
// per record: nx, ny, nz, penetration, then 3 floats per contact point
const SCALAR_HEADER = 4;

class EventBuffer {
    kinds: Uint8Array;
    handles: Int32Array;
    scalars: Float32Array;
    count = 0;
    capacity: number;

    constructor(
        capacity: number,
        private readonly scalarStride: number
    ) {
        this.capacity = capacity;
        this.kinds = new Uint8Array(capacity);
        this.handles = new Int32Array(capacity * HANDLE_FIELDS);
        this.scalars = new Float32Array(capacity * scalarStride);
    }

    /** Grow by doubling. Only ever happens when a frame produces more events than any before. */
    ensure(): void {
        if (this.count < this.capacity) return;
        const capacity = this.capacity * 2;
        const kinds = new Uint8Array(capacity);
        kinds.set(this.kinds);
        const handles = new Int32Array(capacity * HANDLE_FIELDS);
        handles.set(this.handles);
        const scalars = new Float32Array(capacity * this.scalarStride);
        scalars.set(this.scalars);
        this.kinds = kinds;
        this.handles = handles;
        this.scalars = scalars;
        this.capacity = capacity;
    }
}

export class ContactEventQueue {
    /** Contact points copied per event. `0` skips the copy entirely. */
    readonly pointCapacity: number;
    private readonly scalarStride: number;
    private front: EventBuffer;
    private back: EventBuffer;
    /** The buffer the accessors read from; set for the duration of `drain`. */
    private reading: EventBuffer;

    constructor(pointCapacity = 4, initialCapacity = 32) {
        this.pointCapacity = Math.max(0, pointCapacity);
        this.scalarStride = SCALAR_HEADER + 3 * this.pointCapacity;
        this.front = new EventBuffer(initialCapacity, this.scalarStride);
        this.back = new EventBuffer(initialCapacity, this.scalarStride);
        this.reading = this.back;
    }

    get length(): number {
        return this.front.count;
    }

    /**
     * Append one record. Allocation free. Returns its index, for `setPoint`.
     */
    push(
        kind: number,
        handle1: number,
        handle2: number,
        sub1: number,
        sub2: number,
        contactCount: number,
        normalX = 0,
        normalY = 0,
        normalZ = 0,
        penetration = 0,
        pointCount = 0
    ): number {
        const buffer = this.front;
        buffer.ensure();
        const index = buffer.count++;
        buffer.kinds[index] = kind;
        const h = index * HANDLE_FIELDS;
        buffer.handles[h] = handle1;
        buffer.handles[h + 1] = handle2;
        buffer.handles[h + 2] = sub1;
        buffer.handles[h + 3] = sub2;
        buffer.handles[h + 4] = contactCount;
        buffer.handles[h + 5] = pointCount;
        const s = index * this.scalarStride;
        buffer.scalars[s] = normalX;
        buffer.scalars[s + 1] = normalY;
        buffer.scalars[s + 2] = normalZ;
        buffer.scalars[s + 3] = penetration;
        return index;
    }

    /** Store one world space contact point on the record `push` just returned. */
    setPoint(index: number, point: number, x: number, y: number, z: number): void {
        if (point >= this.pointCapacity) return;
        const s = index * this.scalarStride + SCALAR_HEADER + point * 3;
        this.front.scalars[s] = x;
        this.front.scalars[s + 1] = y;
        this.front.scalars[s + 2] = z;
    }

    /**
     * Dispatch every queued record, grouped by `order`, then reset.
     *
     * Double buffered: the buffer being read is swapped out first, so a handler that provokes
     * another step (or removes a body, queueing its exits) appends to the other one and is
     * flushed next time round rather than mutating the array being walked.
     */
    drain(order: readonly number[], callback: (kind: number, index: number) => void): void {
        if (this.front.count === 0) return;
        const reading = this.front;
        this.front = this.back;
        this.back = reading;
        this.reading = reading;
        for (let k = 0; k < order.length; k++) {
            const kind = order[k];
            for (let i = 0; i < reading.count; i++) {
                if (reading.kinds[i] !== kind) continue;
                callback(kind, i);
            }
        }
        reading.count = 0;
    }

    /** Drop everything without dispatching. */
    clear(): void {
        this.front.count = 0;
        this.back.count = 0;
    }

    // Record accessors, valid inside a `drain` callback ------------------------------------
    handle1(i: number): number {
        return this.reading.handles[i * HANDLE_FIELDS];
    }
    handle2(i: number): number {
        return this.reading.handles[i * HANDLE_FIELDS + 1];
    }
    sub1(i: number): number {
        return this.reading.handles[i * HANDLE_FIELDS + 2];
    }
    sub2(i: number): number {
        return this.reading.handles[i * HANDLE_FIELDS + 3];
    }
    contactCount(i: number): number {
        return this.reading.handles[i * HANDLE_FIELDS + 4];
    }
    pointCount(i: number): number {
        return this.reading.handles[i * HANDLE_FIELDS + 5];
    }
    normalX(i: number): number {
        return this.reading.scalars[i * this.scalarStride];
    }
    normalY(i: number): number {
        return this.reading.scalars[i * this.scalarStride + 1];
    }
    normalZ(i: number): number {
        return this.reading.scalars[i * this.scalarStride + 2];
    }
    penetration(i: number): number {
        return this.reading.scalars[i * this.scalarStride + 3];
    }
    /** Write world space contact point `point` of record `i` into `out`. */
    readPoint(i: number, point: number, out: Vector3): Vector3 {
        const s = i * this.scalarStride + SCALAR_HEADER + point * 3;
        const scalars = this.reading.scalars;
        return out.set(scalars[s], scalars[s + 1], scalars[s + 2]);
    }
}

// Sub-shape pair tracking =================================================================

/**
 * One body pair's open sub-shape manifolds.
 *
 * `subs` is two levels deep rather than a `Set` of packed keys because `SubShapeID.GetValue()`
 * is a full 32 bit path whose unused high bits are all ones (the empty id is `-1`), so two of
 * them do not fit in a JS number together.
 */
type PairEntry = {
    subs: Map<number, Set<number>>;
    count: number;
    /** Decided when the pair's first contact is added; `OnContactRemoved` has no way to tell. */
    sensor: boolean;
};

/**
 * Enter / persist / exit derived from Jolt's per sub-shape-pair add/remove callbacks.
 *
 * Jolt guarantees exactly one `OnContactRemoved` per `OnContactAdded`, keyed on the same
 * `SubShapeIDPair`. Counting those - rather than counting *body* pairs, as this used to -
 * is what retires the 900 ms `contactThreshold` debounce: a manifold splitting into two
 * sub-shape manifolds no longer reads as exit-then-enter.
 */
export class ContactPairTracker {
    private pairs = new Map<number, Map<number, PairEntry>>();

    /** Open sub-shape manifolds between two bodies. */
    count(handleA: number, handleB: number): number {
        const lo = handleA < handleB ? handleA : handleB;
        const hi = handleA < handleB ? handleB : handleA;
        return this.pairs.get(lo)?.get(hi)?.count ?? 0;
    }

    /** Whether this pair was opened as a sensor overlap. */
    isSensorPair(handleA: number, handleB: number): boolean {
        const lo = handleA < handleB ? handleA : handleB;
        const hi = handleA < handleB ? handleB : handleA;
        return this.pairs.get(lo)?.get(hi)?.sensor ?? false;
    }

    /**
     * Record one sub-shape contact. Returns the pair's new count; `1` means this is an enter.
     */
    add(
        handle1: number,
        handle2: number,
        sub1: number,
        sub2: number,
        sensor: boolean
    ): { count: number; sensor: boolean } {
        const flip = handle1 > handle2;
        const lo = flip ? handle2 : handle1;
        const hi = flip ? handle1 : handle2;
        const lowSub = flip ? sub2 : sub1;
        const highSub = flip ? sub1 : sub2;

        let byHigh = this.pairs.get(lo);
        if (!byHigh) {
            byHigh = new Map();
            this.pairs.set(lo, byHigh);
        }
        let entry = byHigh.get(hi);
        if (!entry) {
            entry = { subs: new Map(), count: 0, sensor };
            byHigh.set(hi, entry);
        }
        let set = entry.subs.get(lowSub);
        if (!set) {
            set = new Set();
            entry.subs.set(lowSub, set);
        }
        if (!set.has(highSub)) {
            set.add(highSub);
            entry.count++;
        }
        return { count: entry.count, sensor: entry.sensor };
    }

    /**
     * Drop one sub-shape contact. `count === 0` with `existed` means this was the last one and
     * the pair is now closed - that is the exit.
     */
    remove(
        handle1: number,
        handle2: number,
        sub1: number,
        sub2: number
    ): { count: number; existed: boolean; sensor: boolean } {
        const flip = handle1 > handle2;
        const lo = flip ? handle2 : handle1;
        const hi = flip ? handle1 : handle2;
        const lowSub = flip ? sub2 : sub1;
        const highSub = flip ? sub1 : sub2;

        const byHigh = this.pairs.get(lo);
        const entry = byHigh?.get(hi);
        if (!byHigh || !entry) return { count: 0, existed: false, sensor: false };
        const set = entry.subs.get(lowSub);
        if (!set || !set.delete(highSub)) {
            return { count: entry.count, existed: false, sensor: entry.sensor };
        }
        entry.count--;
        if (set.size === 0) entry.subs.delete(lowSub);
        const sensor = entry.sensor;
        if (entry.count <= 0) {
            byHigh.delete(hi);
            if (byHigh.size === 0) this.pairs.delete(lo);
        }
        return { count: entry.count, existed: true, sensor };
    }

    /** Forget a whole pair (a body was destroyed). Returns what it held, if anything. */
    removePair(handle1: number, handle2: number): { count: number; sensor: boolean } | undefined {
        const lo = handle1 < handle2 ? handle1 : handle2;
        const hi = handle1 < handle2 ? handle2 : handle1;
        const byHigh = this.pairs.get(lo);
        const entry = byHigh?.get(hi);
        if (!byHigh || !entry) return undefined;
        byHigh.delete(hi);
        if (byHigh.size === 0) this.pairs.delete(lo);
        return { count: entry.count, sensor: entry.sensor };
    }

    clear(): void {
        this.pairs.clear();
    }

    /** Open body pairs. Tests and leak checks. */
    get size(): number {
        let n = 0;
        for (const byHigh of this.pairs.values()) n += byHigh.size;
        return n;
    }
}

// Payload pool ============================================================================

const makeTarget = (): CollisionTarget => ({
    body: undefined,
    object: undefined,
    handle: 0,
    subShapeId: -1,
    index: undefined
});

const makeSubShapeRef = (): SubShapeRef => ({
    id: -1,
    index: -1,
    userData: 0,
    descriptor: undefined
});

/**
 * Fills a {@link SubShapeRef} from one side of a payload. `BodySystem` supplies it; it is the
 * only thing that knows how to reach the body's shape.
 */
export type SubShapeResolver = (target: CollisionTarget, out: SubShapeRef) => void;

/** The bookkeeping the lazy `targetSubShape` / `otherSubShape` getters run on. */
type SubShapeSlots = {
    /** [target, other]; reused, never reallocated. */
    _subs: [SubShapeRef, SubShapeRef];
    /** Whether each slot has been filled for the event currently being dispatched. */
    _resolvedTarget: boolean;
    _resolvedOther: boolean;
    _resolver: SubShapeResolver | undefined;
};

type PooledEnter = CollisionEnterPayload & SubShapeSlots & { _store: Vector3[] };
type PooledBasic = CollisionPayload & SubShapeSlots;

/**
 * Resolve one side's sub shape, once. Reading `payload.targetSubShape` is what triggers the
 * shape walk, so a handler that does not look at it costs nothing per contact.
 */
function resolveSide(payload: SubShapeSlots & CollisionPayload, side: 0 | 1): SubShapeRef {
    const out = payload._subs[side];
    const done = side === 0 ? payload._resolvedTarget : payload._resolvedOther;
    if (!done) {
        if (side === 0) payload._resolvedTarget = true;
        else payload._resolvedOther = true;
        const from = side === 0 ? payload.target : payload.other;
        out.id = from.subShapeId;
        out.index = -1;
        out.userData = 0;
        out.descriptor = undefined;
        payload._resolver?.(from, out);
    }
    return out;
}

/**
 * Install the two lazy accessors on a payload.
 *
 * `Object.defineProperties` rather than a spread: spreading an object literal with getters
 * *calls* them and copies the values, which would resolve every sub shape eagerly - exactly the
 * cost this is here to avoid.
 */
const defineSubShapeAccessors = <T extends SubShapeSlots & CollisionPayload>(payload: T): T => {
    Object.defineProperties(payload, {
        targetSubShape: {
            get(this: T) {
                return resolveSide(this, 0);
            },
            enumerable: true
        },
        otherSubShape: {
            get(this: T) {
                return resolveSide(this, 1);
            },
            enumerable: true
        }
    });
    return payload;
};

/**
 * Payloads are reused across events within a flush, and across flushes. Handlers must read
 * what they need and not retain the object - see the note on `BodyEventMap`.
 *
 * In debug mode nothing is pooled: each dispatch gets a fresh object which is then frozen and
 * NaN'd, so code that retained one fails immediately instead of silently reading the next
 * contact's numbers.
 */
export class PayloadPool {
    debug = false;
    /** Set by `BodySystem`; handed to every payload it hands out. */
    subShapeResolver?: SubShapeResolver;
    private enters: PooledEnter[] = [];
    private basics: PooledBasic[] = [];
    private activations: ActivationPayload[] = [];
    private enterIndex = 0;
    private basicIndex = 0;
    private activationIndex = 0;

    /** Called once per flush. */
    reset(): void {
        this.enterIndex = 0;
        this.basicIndex = 0;
        this.activationIndex = 0;
    }

    acquireEnter(): PooledEnter {
        const payload = this.debug ? PayloadPool.newEnter() : this.pooledEnter();
        this.arm(payload);
        return payload;
    }

    acquireBasic(): PooledBasic {
        const payload = this.debug ? PayloadPool.newBasic() : this.pooledBasic();
        this.arm(payload);
        return payload;
    }

    private pooledEnter(): PooledEnter {
        const index = this.enterIndex++;
        let payload = this.enters[index];
        if (!payload) {
            payload = PayloadPool.newEnter();
            this.enters[index] = payload;
        }
        return payload;
    }

    private pooledBasic(): PooledBasic {
        const index = this.basicIndex++;
        let payload = this.basics[index];
        if (!payload) {
            payload = PayloadPool.newBasic();
            this.basics[index] = payload;
        }
        return payload;
    }

    /** Re-arm the lazy sub shape getters for the event about to be dispatched. */
    private arm(payload: SubShapeSlots): void {
        payload._resolvedTarget = false;
        payload._resolvedOther = false;
        payload._resolver = this.subShapeResolver;
    }

    acquireActivation(): ActivationPayload {
        if (this.debug) return { body: undefined, handle: 0 };
        const index = this.activationIndex++;
        let payload = this.activations[index];
        if (!payload) {
            payload = { body: undefined, handle: 0 };
            this.activations[index] = payload;
        }
        return payload;
    }

    /** Size `payload.points` to `count`, reusing the payload's own vectors. */
    sizePoints(payload: PooledEnter, count: number): void {
        const store = payload._store;
        while (store.length < count) store.push(new Vector3());
        payload.points.length = count;
        for (let i = 0; i < count; i++) payload.points[i] = store[i];
    }

    /**
     * Development only: make a payload that outlived its dispatch obviously broken. Cheap
     * enough to be unconditional in debug and never runs otherwise.
     */
    // biome-ignore lint/suspicious/noExplicitAny: works on every payload shape
    poison(payload: any): void {
        if (!this.debug || !payload) return;
        if (payload.normal) payload.normal.set(Number.NaN, Number.NaN, Number.NaN);
        if (payload.penetration !== undefined) payload.penetration = Number.NaN;
        if (payload.contactCount !== undefined) payload.contactCount = Number.NaN;
        if (payload._subs) {
            for (const ref of payload._subs as SubShapeRef[]) {
                ref.index = Number.NaN;
                ref.userData = Number.NaN;
                ref.descriptor = undefined;
                Object.freeze(ref);
            }
            // freezing the payload below makes a *later* lazy resolve throw, which is the point
            payload._resolver = undefined;
        }
        for (const side of ['target', 'other'] as const) {
            const targetSide = payload[side];
            if (!targetSide) continue;
            targetSide.body = undefined;
            targetSide.object = undefined;
            targetSide.handle = Number.NaN;
            Object.freeze(targetSide);
        }
        Object.freeze(payload);
    }

    private static newEnter(): PooledEnter {
        return defineSubShapeAccessors({
            target: makeTarget(),
            other: makeTarget(),
            flipped: false,
            contactCount: 0,
            normal: new Vector3(),
            penetration: 0,
            points: [],
            pointCount: 0,
            _store: [],
            _subs: [makeSubShapeRef(), makeSubShapeRef()],
            _resolvedTarget: false,
            _resolvedOther: false,
            _resolver: undefined
        } as unknown as PooledEnter);
    }

    private static newBasic(): PooledBasic {
        return defineSubShapeAccessors({
            target: makeTarget(),
            other: makeTarget(),
            flipped: false,
            contactCount: 0,
            _subs: [makeSubShapeRef(), makeSubShapeRef()],
            _resolvedTarget: false,
            _resolvedOther: false,
            _resolver: undefined
        } as unknown as PooledBasic);
    }
}
