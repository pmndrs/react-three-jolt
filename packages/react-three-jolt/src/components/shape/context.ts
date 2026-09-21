// The compound-shape context a `<Shape>` (or a collider component) registers itself with.
//
// It lives in its own module because both `<Shape>` and `<RigidBody>` provide it: `<RigidBody>`
// is the *body root* host (issue #155 - so sibling colliders combine into one compound instead
// of the last one silently winning), and a `<Shape>` with children is a nested one. Keeping the
// context here is what stops `RigidBody.tsx` and `Shape.tsx` importing each other in a cycle.

import type Jolt from 'jolt-physics';
import { createContext } from 'react';

import type { ShapeDescriptor } from '../../systems';

export interface ShapeContext {
    shape: Jolt.Shape | undefined;
    /** register a child descriptor with this compound; returns the child's index */
    addShape: (descriptor: ShapeDescriptor) => number;
    /** replace the descriptor at `index` and rebuild */
    modifyShape: (index: number, descriptor: ShapeDescriptor) => void;
    /** drop the child at `index` and rebuild */
    removeShape: (index: number) => void;

    //* Body root only (issue #155) ------------------------
    /**
     * True on the context `<RigidBody>` itself provides. A `<Shape>` registered with it is a
     * direct child of the *body*, which is not the same thing as being a child of a compound:
     * when it is the body's only shape there is no compound at all, so its contact handlers are
     * the body's rather than a sub-shape's.
     */
    isBodyRoot?: boolean;
    /**
     * Body root only: does the registration at `index` end up as the body's entire shape (no
     * compound wrapper)? Read lazily, after mount, because it depends on the siblings.
     */
    isSoleShape?: (index: number | undefined) => boolean;
}

// Named `shapeContext` (lowercase), distinct from the `ShapeContext` *type* above (#148): the
// two used to share one identifier, a type and a value with the same name, which `Shape.tsx`
// worked around by re-exporting the type under a different name (`ShapeContextValue`) rather
// than fixing the collision itself.
export const shapeContext = createContext<ShapeContext | undefined>(undefined!);
