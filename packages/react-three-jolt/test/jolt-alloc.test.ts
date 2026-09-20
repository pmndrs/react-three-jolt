// The contract of the heap-comparison helper the teardown tests lean on.
//
// `expectHeapRestored` exists because Jolt's allocator can end a mount/unmount round with a few
// bytes MORE free than it started with (block coalescing), which made an exact-equality
// assertion fail on CI while passing locally. The tolerance is a fix for that artifact only -
// it must stay far below anything the library allocates, so a genuine leak still fails loudly.
// These cases pin both ends of that, including the exact numbers CI reported.

import { expect, test } from 'vitest';
import { expectHeapRestored } from './jolt-alloc';

test('expectHeapRestored allows the allocator artifact but not a real leak', () => {
    // the CI failure this was written for: 8 bytes more free after the unmount than before
    expect(() => expectHeapRestored(133050864, 133050872)).not.toThrow();
    // the local result for the same test: exactly equal
    expect(() => expectHeapRestored(133050864, 133050864)).not.toThrow();
    // a shrink inside the tolerance is still the artifact
    expect(() => expectHeapRestored(1000, 936)).not.toThrow();

    // one byte past it is not
    expect(() => expectHeapRestored(1000, 935)).toThrow(/leaked 65 bytes/);
    // and a leak of real Jolt objects (a Vec3 is 16 bytes, a body several hundred) is caught
    expect(() => expectHeapRestored(133050864, 133030864)).toThrow(/leaked 20000 bytes/);

    // the caller's label reaches the failure message
    expect(() => expectHeapRestored(1000, 0, 64, 'unmounting the tree')).toThrow(
        /unmounting the tree/
    );
});
