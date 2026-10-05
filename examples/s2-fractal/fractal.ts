import { wgsl, wgslFn } from 'three/tsl';

//* The fractal — a Mandelbox (box fold + sphere fold, scale 3) with a tunnel
//* carved along the flight path, written as plain WGSL and called from TSL
//* through `wgslFn`. Everything here is static geometry: the image only moves
//* because the camera does, which is what lets the motion vectors be pure
//* camera reprojection (see main.ts). Animating the fractal itself would need
//* per-pixel object motion on top — out of scope for this showcase.

/** Per-pixel cost knobs, baked into the shader as constants (one recompile per change). */
export interface FractalQuality {
    /** Mandelbox fold iterations per distance estimate. */
    iterations: number;
    /** Primary-ray march budget. */
    steps: number;
    /** Soft-shadow march budget toward the sun. */
    shadowSteps: number;
}

/** Quality presets, cheapest first. "high" is the default. */
export const QUALITY_PRESETS: Record<string, FractalQuality> = {
    low: { iterations: 8, steps: 96, shadowSteps: 24 },
    medium: { iterations: 10, steps: 160, shadowSteps: 40 },
    high: { iterations: 12, steps: 256, shadowSteps: 64 },
    ultra: { iterations: 15, steps: 400, shadowSteps: 96 },
};

/**
 * Fractal shape, flight path and lighting scale — read when the shader is
 * built (startup and every quality change).
 *
 * Scale 3 was picked by eye over −1.5…−2.5 and 2…3: the positive-scale box
 * (|x| ≤ 2(s+1)/(s−1) = 4) is sparse enough inside to fly through, and its
 * box folds stack into city-like terraces at every scale. Denser boxes (scale
 * 2, the negative "amazing box") are nearly solid along any interior path.
 * The path is an ellipse inside the box that bobs twice per lap; a tube of
 * `tunnel` radius is carved along it so the camera can never clip a wall.
 */
export const FRACTAL = {
    scale: 3.0,
    path: { rx: 3.0, rz: 2.2, y0: 0.3, bob: 0.6 },
    tunnel: 0.35,
    /** Exponential fog density per world unit. */
    fog: 0.035,
    /** Sun shadows only look this far: the box is closed, so unbounded shadow rays would black out the interior. */
    shadowDistance: 1.5,
    ambient: 1.0,
    aoScale: 1.0,
};

/**
 * Evaluates the flight path at a parameter angle (same curve as `fr_pathPoint`).
 * @param theta - Path parameter in radians (one lap = 2π)
 * @param out - Vector-like target `{ x, y, z }` to write into
 * @returns `out`
 */
export function pathPoint<T extends { x: number; y: number; z: number }>(theta: number, out: T): T {
    const { rx, rz, y0, bob } = FRACTAL.path;
    out.x = rx * Math.cos(theta);
    out.y = y0 + bob * Math.sin(2 * theta);
    out.z = rz * Math.sin(theta);
    return out;
}

/** Shared WGSL: constants, distance estimator, orbit trap, lighting helpers. */
function sharedSource(q: FractalQuality): string {
    const f = (v: number) => (Number.isInteger(v) ? `${v}.0` : `${v}`);
    const path = FRACTAL.path;
    return /* wgsl */ `
const FR_SCALE: f32 = ${f(FRACTAL.scale)};
const FR_MIN_R2: f32 = 0.25;
const FR_FIX_R2: f32 = 1.0;
const FR_ITER: i32 = ${q.iterations};
const FR_STEPS: i32 = ${q.steps};
const FR_SHADOW_STEPS: i32 = ${q.shadowSteps};
const FR_T_MAX: f32 = 40.0;
const FR_PATH: vec4f = vec4f(${f(path.rx)}, ${f(path.rz)}, ${f(path.y0)}, ${f(path.bob)});
const FR_TUNNEL_R: f32 = ${f(FRACTAL.tunnel)};
const FR_FOG: f32 = ${f(FRACTAL.fog)};
const FR_SHADOW_DIST: f32 = ${f(FRACTAL.shadowDistance)};
const FR_AMBIENT: f32 = ${f(FRACTAL.ambient)};
const FR_AO_SCALE: f32 = ${f(FRACTAL.aoScale)};
// The box-fold DE (length(p) / |dr|) under-reads true distance by about 2x
// (measured on CPU against a brute-force search). Marching keeps the safe
// raw value; shadow penumbrae and AO, which compare DE against a known
// distance, rescale it.
const FR_DE_GAIN: f32 = 2.0;

fn fr_pathPoint(theta: f32) -> vec3f {
    return vec3f(FR_PATH.x * cos(theta), FR_PATH.z + FR_PATH.w * sin(2.0 * theta), FR_PATH.y * sin(theta));
}

// Positive inside the tube around the flight path. The path parameter is the
// point's elliptical angle, so this is the distance to *a* path point — never
// less than the true distance to the curve, which keeps max(fractal, tube) a
// conservative (safe-to-march) bound.
fn fr_tunnel(p: vec3f) -> f32 {
    let theta = atan2(p.z / FR_PATH.y, p.x / FR_PATH.x);
    return FR_TUNNEL_R - length(p - fr_pathPoint(theta));
}

fn fr_mandelbox(p0: vec3f) -> f32 {
    var p = p0;
    var dr = 1.0;
    for (var i = 0; i < FR_ITER; i++) {
        p = clamp(p, vec3f(-1.0), vec3f(1.0)) * 2.0 - p;
        let r2 = dot(p, p);
        if (r2 < FR_MIN_R2) {
            let k = FR_FIX_R2 / FR_MIN_R2;
            p *= k;
            dr *= k;
        } else if (r2 < FR_FIX_R2) {
            let k = FR_FIX_R2 / r2;
            p *= k;
            dr *= k;
        }
        p = p * FR_SCALE + p0;
        dr = dr * abs(FR_SCALE) + 1.0;
    }
    return length(p) / abs(dr);
}

fn fr_map(p: vec3f) -> f32 {
    return max(fr_mandelbox(p), fr_tunnel(p));
}

// The same iteration, tracking an orbit trap (min |p| per axis + min r²) for coloring.
fn fr_trap(p0: vec3f) -> vec4f {
    var p = p0;
    var trap = vec4f(1e10);
    for (var i = 0; i < FR_ITER; i++) {
        p = clamp(p, vec3f(-1.0), vec3f(1.0)) * 2.0 - p;
        let r2 = dot(p, p);
        trap = min(trap, vec4f(abs(p), r2));
        if (r2 < FR_MIN_R2) {
            p *= FR_FIX_R2 / FR_MIN_R2;
        } else if (r2 < FR_FIX_R2) {
            p *= FR_FIX_R2 / r2;
        }
        p = p * FR_SCALE + p0;
    }
    return trap;
}

fn fr_normal(p: vec3f, h: f32) -> vec3f {
    // Tetrahedral central differences: 4 map evaluations instead of 6.
    let k = vec2f(1.0, -1.0);
    return normalize(
        k.xyy * fr_map(p + k.xyy * h) +
        k.yyx * fr_map(p + k.yyx * h) +
        k.yxy * fr_map(p + k.yxy * h) +
        k.xxx * fr_map(p + k.xxx * h)
    );
}

fn fr_softShadow(ro: vec3f, rd: vec3f, tmin: f32) -> f32 {
    var res = 1.0;
    var t = tmin;
    var prevH = 1e10;
    for (var i = 0; i < FR_SHADOW_STEPS; i++) {
        let h = fr_map(ro + rd * t);
        // Penumbra estimate from the closest approach between two samples,
        // which avoids the banding of the naive h/t form.
        let y = h * h / (2.0 * prevH);
        let d = sqrt(max(h * h - y * y, 0.0));
        res = min(res, 8.0 * FR_DE_GAIN * d / max(t - y, 1e-4));
        prevH = h;
        t += clamp(h, 0.002, FR_SHADOW_DIST * 0.06);
        if (res < 0.002 || t > FR_SHADOW_DIST) { break; }
    }
    return clamp(res, 0.0, 1.0);
}

// Ambient occlusion from 5 taps along the normal, each scored by how much of
// its free-space radius the scene eats ((h - DE) / h), so the result doesn't
// depend on the tap spacing.
fn fr_ambientOcclusion(p: vec3f, n: vec3f) -> f32 {
    var occ = 0.0;
    var wsum = 0.0;
    var w = 1.0;
    for (var i = 1; i <= 5; i++) {
        let h = (0.02 + 0.045 * f32(i * i)) * FR_AO_SCALE;
        occ += w * clamp((h - FR_DE_GAIN * fr_map(p + n * h)) / h, 0.0, 1.0);
        wsum += w;
        w *= 0.7;
    }
    return clamp(1.0 - 1.5 * occ / wsum, 0.0, 1.0);
}

fn fr_sky(rd: vec3f, sunDir: vec3f) -> vec3f {
    let up = clamp(rd.y, -1.0, 1.0);
    var col = mix(vec3f(1.00, 0.52, 0.28), vec3f(0.08, 0.15, 0.38), pow(max(up, 0.0), 0.5));
    col = mix(col, vec3f(0.08, 0.06, 0.08), clamp(-up * 2.0, 0.0, 1.0));
    // A broad sun glow, not a tiny disc: a sub-pixel-bright sun would be
    // exactly the kind of emitter temporal accumulation can't hold (issue #51).
    let s = max(dot(rd, sunDir), 0.0);
    col += vec3f(1.6, 0.95, 0.5) * pow(s, 24.0) + vec3f(0.5, 0.28, 0.14) * pow(s, 4.0);
    return col;
}

fn fr_fogColor(rd: vec3f, sunDir: vec3f) -> vec3f {
    let s = max(dot(rd, sunDir), 0.0);
    return mix(vec3f(0.30, 0.26, 0.34), vec3f(0.95, 0.58, 0.34), pow(s, 6.0));
}
`;
}

/** The TSL-callable entry points, built for one quality preset. */
export interface FractalFunctions {
    /** `march(ro, rd, pixelAngle) → vec4(t, hit, stepFraction, 0)`. */
    march: ReturnType<typeof wgslFn>;
    /** `shade(ro, rd, hit, pixelAngle, sunDir) → linear HDR rgb`. */
    shade: ReturnType<typeof wgslFn>;
}

/**
 * Builds the WGSL march + shade functions for a quality preset.
 * @param quality - Iteration and step budgets baked into the shader
 * @returns The `wgslFn` nodes to call from TSL
 */
export function buildFractal(quality: FractalQuality): FractalFunctions {
    const shared = wgsl(sharedSource(quality));

    const march = wgslFn(
        /* wgsl */ `
fn fractal_march(ro: vec3f, rd: vec3f, pixelAngle: f32) -> vec4f {
    var t = 0.0;
    var hit = 0.0;
    var i = 0;
    while (i < FR_STEPS) {
        let d = fr_map(ro + rd * t);
        // Cone-traced hit threshold: stop once the surface is closer than
        // half a display pixel's footprint. Using the display (not render)
        // footprint keeps the geometry identical at every render scale, so the
        // ratio comparison is pure pixel count.
        if (d < pixelAngle * t + 1e-5) {
            hit = 1.0;
            break;
        }
        t += d * 0.95;
        if (t > FR_T_MAX) { break; }
        i++;
    }
    // Step budget exhausted short of T_MAX (grazing rays in deep crevices):
    // treat as a hit where we stopped — fog hides the error.
    if (hit < 0.5 && t < FR_T_MAX) { hit = 1.0; }
    return vec4f(min(t, FR_T_MAX), hit, f32(i) / f32(FR_STEPS), 0.0);
}
`,
        [shared],
    );

    const shade = wgslFn(
        /* wgsl */ `
fn fractal_shade(ro: vec3f, rd: vec3f, hit: vec4f, pixelAngle: f32, sunDir: vec3f) -> vec3f {
    let t = hit.x;
    if (hit.y < 0.5) {
        return fr_sky(rd, sunDir);
    }
    let p = ro + rd * t;
    let n = fr_normal(p, max(pixelAngle * t, 1e-4));
    let trap = fr_trap(p);

    // Orbit-trap palette. The orbit's closest approach to the origin (min r²,
    // ~0.07–1.4 on the surface) picks verdigris → copper → ivory; a near miss
    // of an axis plane (min |p.x|) leaves fine gilded veins on top.
    let k = clamp(trap.w / 1.2, 0.0, 1.0);
    var albedo = mix(vec3f(0.10, 0.34, 0.36), vec3f(0.66, 0.30, 0.12), smoothstep(0.05, 0.45, k));
    albedo = mix(albedo, vec3f(0.86, 0.78, 0.62), smoothstep(0.5, 0.95, k));
    albedo = mix(albedo, vec3f(0.95, 0.62, 0.18), (1.0 - smoothstep(0.0, 0.05, trap.x)) * 0.6);

    let ao = fr_ambientOcclusion(p, n);
    let lit = max(dot(n, sunDir), 0.0);
    let shadow = select(0.0, fr_softShadow(p + n * 0.002, sunDir, 0.01), lit > 0.0);

    var col = vec3f(0.0);
    col += albedo * vec3f(3.2, 2.3, 1.5) * lit * shadow;
    col += albedo * vec3f(0.42, 0.52, 0.72) * FR_AMBIENT * (0.6 + 0.4 * n.y) * ao;
    // Unshadowed cool fill from opposite the sun, so the backlit plates that
    // silhouette against the sky keep their relief instead of going black.
    let fillDir = normalize(vec3f(-sunDir.x, 0.25, -sunDir.z));
    col += albedo * vec3f(0.35, 0.42, 0.62) * FR_AMBIENT * max(dot(n, fillDir), 0.0) * ao;
    // Warm bounce from below, so shadowed interiors keep their form.
    col += albedo * vec3f(0.30, 0.18, 0.10) * clamp(0.5 - 0.5 * n.y, 0.0, 1.0) * ao;
    // Soft, broad rim toward the sun-side fog — rough, never a pinpoint glint.
    col += vec3f(0.6, 0.45, 0.35) * pow(clamp(1.0 + dot(n, rd), 0.0, 1.0), 3.0) * ao * 0.35;

    let fog = 1.0 - exp(-FR_FOG * t);
    return mix(col, fr_fogColor(rd, sunDir), fog);
}
`,
        [shared],
    );

    return { march, shade };
}
