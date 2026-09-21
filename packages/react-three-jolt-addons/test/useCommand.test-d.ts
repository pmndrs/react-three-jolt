import { assertType, expectTypeOf, test } from 'vitest';
import type { CommandInfo } from '../src/useCommand/Commander';
import { useCommand } from '../src/useCommand/index';

// Issue #78: `isInitial` is on the callback payload, but `useCommand` used to declare its
// callbacks as `(info: CommandCallback) => void` -- so `info` was typed as the callback itself
// and every `info.isInitial` needed a `@ts-expect-error`.
test('the useCommand callback receives the command info, not another callback', () => {
    useCommand('Control', (info) => {
        expectTypeOf(info).toEqualTypeOf<CommandInfo>();
        expectTypeOf(info.isInitial).toEqualTypeOf<boolean>();
        expectTypeOf(info.label).toEqualTypeOf<string>();
        expectTypeOf(info.startTime).toEqualTypeOf<number>();
        assertType<boolean>(info.isInitial);
    });
});

test('options are typed and still accept consumer specific keys', () => {
    useCommand('look', undefined, undefined, { asVector: true, sensitivity: 2 });
    // @ts-expect-error -- keys must be a string array
    useCommand('look', undefined, undefined, { keys: 'w' });
});
