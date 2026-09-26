/**
 * The one event primitive for the whole library (issue #50).
 *
 * Six removal conventions used to coexist here: `removeXListener(fn)` by identity, `add(fn)`
 * returning a remover, `on(type, fn)` returning a remover, and React props layered on top of
 * the first. Identity based removal is the broken one: every controller subscribed with an
 * inline arrow, so nothing could ever be removed, and under StrictMode the same function
 * registered twice could only ever be unregistered once.
 *
 * `on()` therefore hands back a closure over the *entry object* it just pushed. Two calls with
 * the same function produce two entries and two independent unsubscribes. Identity is never
 * compared.
 *
 * Dispatch walks by index and skips entries flagged `dead`, so unsubscribing (or subscribing)
 * from inside a handler is safe; the array is compacted once the outermost `emit` returns.
 */

export type Unsubscribe = () => void;

export type EventMap = Record<string, (...args: any[]) => any>;

type Entry = {
    fn: (...args: any[]) => any;
    dead: boolean;
    once: boolean;
};

export class Emitter<M extends EventMap> {
    private lists = new Map<string, Entry[]>();
    /** Bit per event type, used to build {@link mask}. Types absent from it contribute 0. */
    private readonly bits: Record<string, number>;
    private _mask = 0;
    private depth = 0;
    private dirty = false;

    /**
     * @param bits optional `{ eventName: bit }` map backing the zero cost dispatch path. A
     * caller inside a Jolt callback can test `emitter.mask & SOME_BIT` and skip all of the
     * (expensive) wrapping work when nobody is listening.
     */
    constructor(bits: Partial<Record<keyof M & string, number>> = {}) {
        this.bits = bits as Record<string, number>;
    }

    /** Bitfield of the event types that currently have at least one live listener. */
    get mask(): number {
        return this._mask;
    }

    /** Subscribe. The returned function removes *this* subscription, and only this one. */
    on<K extends keyof M & string>(type: K, fn: M[K]): Unsubscribe {
        return this.add(type, fn, false);
    }

    /** Subscribe for exactly one dispatch. */
    once<K extends keyof M & string>(type: K, fn: M[K]): Unsubscribe {
        return this.add(type, fn, true);
    }

    private add(type: string, fn: Entry['fn'], once: boolean): Unsubscribe {
        if (typeof fn !== 'function') throw new TypeError(`Emitter.on(${type}): not a function`);
        let list = this.lists.get(type);
        if (!list) {
            list = [];
            this.lists.set(type, list);
        }
        const entry: Entry = { fn, dead: false, once };
        list.push(entry);
        this._mask |= this.bits[type] ?? 0;
        let removed = false;
        return () => {
            if (removed) return;
            removed = true;
            this.kill(type, entry);
        };
    }

    private kill(type: string, entry: Entry): void {
        if (entry.dead) return;
        entry.dead = true;
        // During dispatch the indices have to stay put; compaction happens in `emit`.
        if (this.depth > 0) {
            this.dirty = true;
            return;
        }
        this.compact(type);
    }

    private compact(type: string): void {
        const list = this.lists.get(type);
        if (!list) return;
        let write = 0;
        for (let i = 0; i < list.length; i++) {
            const entry = list[i];
            if (entry.dead) continue;
            list[write++] = entry;
        }
        list.length = write;
        if (write === 0) {
            this.lists.delete(type);
            this.recomputeMask();
        }
    }

    private compactAll(): void {
        this.dirty = false;
        for (const type of [...this.lists.keys()]) this.compact(type);
    }

    private recomputeMask(): void {
        let mask = 0;
        for (const [type, list] of this.lists) {
            if (list.length === 0) continue;
            mask |= this.bits[type] ?? 0;
        }
        this._mask = mask;
    }

    /** True when at least one live listener is registered for `type`. */
    has<K extends keyof M & string>(type: K): boolean {
        const list = this.lists.get(type);
        if (!list) return false;
        for (let i = 0; i < list.length; i++) if (!list[i].dead) return true;
        return false;
    }

    /** Live listener count for `type`. Mostly for tests. */
    listenerCount<K extends keyof M & string>(type: K): number {
        const list = this.lists.get(type);
        if (!list) return 0;
        let n = 0;
        for (let i = 0; i < list.length; i++) if (!list[i].dead) n++;
        return n;
    }

    /**
     * Dispatch. Every handler runs inside its own try/catch: these fire from inside
     * `joltInterface.Step()` or immediately after it, and an exception unwinding through
     * emscripten's callback glue corrupts the step for everyone else.
     */
    emit<K extends keyof M & string>(type: K, ...args: Parameters<M[K]>): void {
        const list = this.lists.get(type);
        if (!list || list.length === 0) return;
        this.depth++;
        // Length is read once: handlers subscribing during dispatch are not called this round.
        const length = list.length;
        for (let i = 0; i < length; i++) {
            const entry = list[i];
            if (entry.dead) continue;
            if (entry.once) this.kill(type, entry);
            try {
                entry.fn(...args);
            } catch (error) {
                console.error(`*** R3/Jolt: "${type}" event handler threw ***`, error);
            }
        }
        this.depth--;
        if (this.depth === 0 && this.dirty) this.compactAll();
    }

    /**
     * Dispatch and let handlers veto: returns false as soon as any handler returns exactly
     * `false`, after running all of them. This is how `onContactValidate` gets an answer back
     * out of a synchronous, inside-the-step dispatch; everything else uses {@link emit}.
     */
    emitVeto<K extends keyof M & string>(type: K, ...args: Parameters<M[K]>): boolean {
        const list = this.lists.get(type);
        if (!list || list.length === 0) return true;
        let accepted = true;
        this.depth++;
        const length = list.length;
        for (let i = 0; i < length; i++) {
            const entry = list[i];
            if (entry.dead) continue;
            if (entry.once) this.kill(type, entry);
            try {
                if (entry.fn(...args) === false) accepted = false;
            } catch (error) {
                console.error(`*** R3/Jolt: "${type}" event handler threw ***`, error);
            }
        }
        this.depth--;
        if (this.depth === 0 && this.dirty) this.compactAll();
        return accepted;
    }

    /** Drop every listener, or every listener of one type. */
    clear<K extends keyof M & string>(type?: K): void {
        if (type === undefined) {
            // Mark entries dead as well as dropping the lists: an unsubscribe closure captured
            // by a caller must stay a no-op rather than resurrecting anything.
            for (const list of this.lists.values()) for (const entry of list) entry.dead = true;
            this.lists.clear();
            this._mask = 0;
            this.dirty = false;
            return;
        }
        const list = this.lists.get(type);
        if (!list) return;
        for (const entry of list) entry.dead = true;
        this.lists.delete(type);
        this.recomputeMask();
    }
}
