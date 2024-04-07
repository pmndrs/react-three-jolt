import { create } from '@react-three/test-renderer';
import React from 'react';
import { test } from 'vitest';
import { Placeholder } from '../src';

test('placeholder', async () => {
  await create(<Placeholder />);
});
