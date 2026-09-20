// The Emitter is the one place removal semantics live (issue #50). Every one of these tests is
// a bug the old `indexOf(fn)` based listener arrays actually had.

import { assert, test } from 'vitest';
import { Emitter } from '../src/systems/emitter';

type Map1 = { a: (n: number) => void; b: () => void };

test('on returns an unsubscribe that removes that subscription only', () => {
    const emitter = new Emitter<Map1>();
    const seen: number[] = [];
    const fn = (n: number) => seen.push(n);

    // the same function twice: identity based removal could never tell these apart
    const off1 = emitter.on('a', fn);
    emitter.on('a', fn);
    emitter.emit('a', 1);
    assert.deepEqual(seen, [1, 1]);

    off1();
    emitter.emit('a', 2);
    assert.deepEqual(seen, [1, 1, 2], 'unsubscribing one handle removed both subscriptions');
    assert.equal(emitter.listenerCount('a'), 1);
});

test('an inline arrow is removable by its handle', () => {
    const emitter = new Emitter<Map1>();
    let calls = 0;
    // this is what every controller did - and what `removeStepListener(fn)` could never undo
    const off = emitter.on('a', () => {
        calls++;
    });
    emitter.emit('a', 0);
    off();
    emitter.emit('a', 0);
    assert.equal(calls, 1);
    assert.isFalse(emitter.has('a'));
});

test('unsubscribing a later listener during dispatch still skips it', () => {
    const emitter = new Emitter<Map1>();
    const order: string[] = [];
    emitter.on('a', () => {
        order.push('first');
        offSecond();
    });
    const offSecond = emitter.on('a', () => order.push('second'));
    emitter.on('a', () => order.push('third'));

    emitter.emit('a', 0);
    assert.deepEqual(order, ['first', 'third']);
    // and the dead entry is compacted once the dispatch unwinds
    assert.equal(emitter.listenerCount('a'), 2);
    emitter.emit('a', 0);
    assert.deepEqual(order, ['first', 'third', 'first', 'third']);
});

test('subscribing during dispatch does not run this round', () => {
    const emitter = new Emitter<Map1>();
    const order: string[] = [];
    emitter.on('a', () => {
        order.push('outer');
        emitter.on('a', () => order.push('inner'));
    });
    emitter.emit('a', 0);
    assert.deepEqual(order, ['outer']);
    emitter.emit('a', 0);
    assert.deepEqual(order, ['outer', 'outer', 'inner']);
});

test('once fires a single time', () => {
    const emitter = new Emitter<Map1>();
    let calls = 0;
    emitter.once('b', () => calls++);
    emitter.emit('b');
    emitter.emit('b');
    assert.equal(calls, 1);
    assert.equal(emitter.listenerCount('b'), 0);
});

test('a throwing handler does not stop the others', () => {
    const emitter = new Emitter<Map1>();
    const seen: string[] = [];
    const originalError = console.error;
    console.error = () => {};
    try {
        emitter.on('b', () => {
            throw new Error('boom');
        });
        emitter.on('b', () => seen.push('after'));
        emitter.emit('b');
    } finally {
        console.error = originalError;
    }
    assert.deepEqual(seen, ['after']);
});

test('mask tracks subscribed types', () => {
    const emitter = new Emitter<Map1>({ a: 1 << 0, b: 1 << 1 });
    assert.equal(emitter.mask, 0);
    const offA = emitter.on('a', () => {});
    assert.equal(emitter.mask, 1);
    const offB = emitter.on('b', () => {});
    assert.equal(emitter.mask, 3);
    offA();
    assert.equal(emitter.mask, 2);
    offB();
    assert.equal(emitter.mask, 0);
});

test('clear drops everything and neutralises outstanding handles', () => {
    const emitter = new Emitter<Map1>({ a: 1 });
    let calls = 0;
    const off = emitter.on('a', () => calls++);
    emitter.clear();
    assert.equal(emitter.mask, 0);
    emitter.emit('a', 0);
    assert.equal(calls, 0);
    // calling a stale handle after clear must not throw or resurrect state
    off();
    emitter.on('a', () => calls++);
    emitter.emit('a', 0);
    assert.equal(calls, 1);
});
