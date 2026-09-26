// creates (and owns the lifetime of) a PointCollider - the CollidePoint narrow-phase query
// (issue #248). Mirrors useRaycaster (use-raycasters.ts): no hook wrapper existed yet for any of
// the QueryBase-direct query types (ShapeCollider included - see docs/api/queries.mdx's
// "Lifetime" section), so this is the first one, added alongside PointCollider itself per the
// issue's ask.

import { useMemo, useRef } from 'react';
import { type PointCollectorType, type PointCollider } from '../systems';
import type { anyVec3 } from '../utils';
import { useJolt, useUnmount } from './hooks';

export const useCollidePoint = (point?: anyVec3 | null, type?: PointCollectorType) => {
    const { physicsSystem } = useJolt();
    // Tears down the previous collider (freeing its jolt allocations) whenever a memo dep
    // changes, not just at unmount - a bare `useMemo` would otherwise leak every collider it
    // replaces, since only the LAST instance would ever reach the useUnmount below. Mirrors
    // useRaycaster (issue #192).
    const previous = useRef<PointCollider | null>(null);
    const collider: PointCollider = useMemo(() => {
        previous.current?.destroy();
        const query: PointCollider = physicsSystem.getPointCollider();
        if (point) query.point = point;
        if (type) query.setCollector(type);
        previous.current = query;
        return query;
    }, [point, type, physicsSystem]);

    useUnmount(() => {
        collider.destroy();
    });
    return collider;
};
