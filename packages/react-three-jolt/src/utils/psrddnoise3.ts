// Quick copilot powered conversion of psrddnoise3
// original: https://github.com/stegu/psrdnoise/blob/main/src/psrddnoise3.glsl

// Im removing the ability to use the original perlin rotated grid
// also remove fast rotation of gradients (unsure its)

// types
type Vec3 = [number, number, number];
type Vec4 = [number, number, number, number];
type Mat3 = [Vec3, Vec3, Vec3];

//utility functions
function dot(a: Vec3, b: Vec3): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function permute(i: Vec4) {
    const im = i.map((val) => val % 289);
    return im.map((val) => ((val * 34 + 10) * val) % 289);
}

export function psrddnoise(
    x: Vec3,
    period: Vec3,
    alpha: number,
    gradient: Vec3,
    dg: Vec3,
    dg2: Vec3
) {
    const M: Mat3 = [
        [0.0, 1.0, 1.0],
        [1.0, 0.0, 1.0],
        [1.0, 1.0, 0.0]
    ];

    const Mi: Mat3 = [
        [-0.5, 0.5, 0.5],
        [0.5, -0.5, 0.5],
        [0.5, 0.5, -0.5]
    ];
    // these maps are nuts
    const uvw = M.map((row) => row.reduce((acc, val, index) => acc + val * x[index], 0));

    let i0 = uvw.map(Math.floor);
    const f0 = uvw.map((val) => val - Math.floor(val));

    const g_ = f0.map((val) => (val < 0.5 ? 0 : 1));
    const l_ = g_.map((val) => 1 - val);
    const g = [l_[2], g_[0], g_[1]];
    const l = [l_[0], l_[1], g_[2]];
    const o1 = g.map((val, index) => Math.min(val, l[index]));
    const o2 = g.map((val, index) => Math.max(val, l[index]));

    let i1 = i0.map((val, index) => val + o1[index]);
    let i2 = i0.map((val, index) => val + o2[index]);
    let i3 = i0.map((val) => val + 1);

    const v0 = Mi.map((row) => row.reduce((acc, val, index) => acc + val * i0[index], 0));
    const v1 = Mi.map((row) => row.reduce((acc, val, index) => acc + val * i1[index], 0));
    const v2 = Mi.map((row) => row.reduce((acc, val, index) => acc + val * i2[index], 0));
    const v3 = Mi.map((row) => row.reduce((acc, val, index) => acc + val * i3[index], 0));

    const x0 = x.map((val, index) => val - v0[index]);
    const x1 = x.map((val, index) => val - v1[index]);
    const x2 = x.map((val, index) => val - v2[index]);
    const x3 = x.map((val, index) => val - v3[index]);

    if (period.some((val) => val > 0)) {
        const vx = [v0[0], v1[0], v2[0], v3[0]];
        const vy = [v0[1], v1[1], v2[1], v3[1]];
        const vz = [v0[2], v1[2], v2[2], v3[2]];

        if (period[0] > 0) vx.forEach((val, index) => (vx[index] = val % period[0]));
        if (period[1] > 0) vy.forEach((val, index) => (vy[index] = val % period[1]));
        if (period[2] > 0) vz.forEach((val, index) => (vz[index] = val % period[2]));

        i0 = M.map((row) => row.reduce((acc, val, index) => acc + val * vx[index], 0));
        i1 = M.map((row) => row.reduce((acc, val, index) => acc + val * vy[index], 0));
        i2 = M.map((row) => row.reduce((acc, val, index) => acc + val * vz[index], 0));
        i3 = M.map((row) => row.reduce((acc, val, index) => acc + val * vz[index], 0));

        i0.forEach((val, index) => (i0[index] = Math.floor(val + 0.5)));
        i1.forEach((val, index) => (i1[index] = Math.floor(val + 0.5)));
        i2.forEach((val, index) => (i2[index] = Math.floor(val + 0.5)));
        i3.forEach((val, index) => (i3[index] = Math.floor(val + 0.5)));
    }

    const hash = permute(
        permute(permute([i0[2], i1[2], i2[2], i3[2]]).map((val, index) => val + i0[index])).map(
            (val, index) => val + i0[index]
        )
    );

    const theta = hash.map((val) => val * 3.883222077);
    const sz = hash.map((val) => val * -0.006920415 + 0.996539792);
    const psi = hash.map((val) => val * 0.108705628);

    const Ct = theta.map(Math.cos);
    const St = theta.map(Math.sin);
    const sz_prime = sz.map((val) => Math.sqrt(1.0 - val * val));

    let gx, gy, gz;

    if (alpha !== 0.0) {
        const Sp = psi.map(Math.sin);
        const Cp = psi.map(Math.cos);

        const px = Ct.map((val) => val * sz_prime[0]);
        const py = St.map((val) => val * sz_prime[0]);
        const pz = sz_prime;

        const Ctp = St.map((val, index) => val * Sp[index] - Ct[index] * Cp[index]);
        const qx = Ctp.map((val, index) => val * St[index] + Sp[index] * sz[index]);
        const qy = Ctp.map((val, index) => val * -Ct[index] + Cp[index] * sz[index]);
        const qz = py.map((val, index) => -(val * Cp[index] + px[index] * Sp[index]));

        const Sa = Math.sin(alpha);
        const Ca = Math.cos(alpha);

        gx = px.map((val, index) => Ca * val + Sa * qx[index]);
        gy = py.map((val, index) => Ca * val + Sa * qy[index]);
        gz = pz.map((val, index) => Ca * val + Sa * qz[index]);
    } else {
        gx = Ct.map((val, index) => val * sz_prime[index]);
        gy = St.map((val, index) => val * sz_prime[index]);
        gz = sz;
    }

    const g0 = [gx[0], gy[0], gz[0]];
    const g1 = [gx[1], gy[1], gz[1]];
    const g2 = [gx[2], gy[2], gz[2]];
    const g3 = [gx[3], gy[3], gz[3]];

    const w = [
        0.5 - x0.reduce((acc, val) => acc + val * val, 0),
        0.5 - x1.reduce((acc, val) => acc + val * val, 0),
        0.5 - x2.reduce((acc, val) => acc + val * val, 0),
        0.5 - x3.reduce((acc, val) => acc + val * val, 0)
    ];

    const w2 = w.map((val) => val * val);
    const w3 = w2.map((val) => val * val);

    const gdotx = [dot(g0, x0), dot(g1, x1), dot(g2, x2), dot(g3, x3)];

    const n = dot(w3, gdotx);

    const dw = w2.map((val) => -6.0 * val).map((val, index) => val * gdotx[index]);
    const dn0 = g0.map((val) => w3[0] * val).map((val, index) => val + dw[0] * x0[index]);
    const dn1 = g1.map((val) => w3[1] * val).map((val, index) => val + dw[1] * x1[index]);
    const dn2 = g2.map((val) => w3[2] * val).map((val, index) => val + dw[2] * x2[index]);
    const dn3 = g3.map((val) => w3[3] * val).map((val, index) => val + dw[3] * x3[index]);
    gradient = dn0.map((val, index) => 39.5 * (val + dn1[index] + dn2[index] + dn3[index]));

    const dw2 = w.map((val) => 24.0 * val * gdotx);
    const dga0 = dw2[0] * x0[0] * x0[0] - 6.0 * w2[0] * (gdotx[0] + 2.0 * g0[0] * x0[0]);
    const dga1 = dw2[1] * x1[0] * x1[0] - 6.0 * w2[1] * (gdotx[1] + 2.0 * g1[0] * x1[0]);
    const dga2 = dw2[2] * x2[0] * x2[0] - 6.0 * w2[2] * (gdotx[2] + 2.0 * g2[0] * x2[0]);
    const dga3 = dw2[3] * x3[0] * x3[0] - 6.0 * w2[3] * (gdotx[3] + 2.0 * g3[0] * x3[0]);
    dg = dga0.map((val, index) => 35.0 * (val + dga1[index] + dga2[index] + dga3[index]));

    const dgb0 = dw2[0] * x0[0] * x0[1] - 6.0 * w2[0] * (g0[0] * x0[1] + g0[1] * x0[0]);
    const dgb1 = dw2[1] * x1[0] * x1[1] - 6.0 * w2[1] * (g1[0] * x1[1] + g1[1] * x1[0]);
    const dgb2 = dw2[2] * x2[0] * x2[1] - 6.0 * w2[2] * (g2[0] * x2[1] + g2[1] * x2[0]);
    const dgb3 = dw2[3] * x3[0] * x3[1] - 6.0 * w2[3] * (g3[0] * x3[1] + g3[1] * x3[0]);
    dg2 = dgb0.map((val, index) => 39.5 * (val + dgb1[index] + dgb2[index] + dgb3[index]));

    return 39.5 * n;
}
