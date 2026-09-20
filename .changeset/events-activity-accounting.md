---
'@react-three/jolt': minor
---

Activation accounting and steady state detection (issue #52).

```tsx
<Physics
    onSettled={() => console.log('everything is asleep')}
    onActivityChange={(active, total) => setLabel(`${active}/${total} awake`)}
/>
```

`BodySystem` now maintains `activeBodyCount` from the activation listener — incremented on
activate, decremented on deactivate — alongside `simulatedBodyCount` and `isSettled`.
`activityChange` is emitted when the count changes and `settled` when it crosses to zero, both
after that step's sleep/wake events, so a handler that counts them agrees with the totals. This
is edge triggered off a single integer, so it costs one comparison per step rather than a
per-frame scan of every body.

A world that was never active does not announce itself settled, and removing the last awake body
settles the world (`RemoveBody` deactivates synchronously, which is counted).
