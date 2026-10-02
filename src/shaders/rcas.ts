import { WGSL_CONSTANTS, WGSL_TONEMAP } from './common';
import { assembleShader } from './wgsl';

/**
 * Builds the RCAS compute shader.
 *
 * `conditionedInput` selects where the temporal path's tonemap/pre-exposure
 * conditioning is undone. `false` reproduces the historical form: every tap
 * inverts the conditioning, so the sharpening math runs in the caller's
 * linear/HDR domain. `true` sharpens the accumulate history's conditioned
 * [0,1) texels directly — the range the limiter math assumes — and inverts
 * the conditioning once on the result. Measured ~35% cheaper on GPU with
 * visually equivalent output (Q0/Q1/Q3/Q9 captures, 2026-07-21); this is the
 * production form.
 *
 * The production form also conditions the spatial (EASU) path, which hands
 * RCAS the caller's unbounded linear/HDR color: FSR1's limiter assumes [0,1],
 * so in linear HDR `hitMax` switches sharpening off wherever the cross ring
 * straddles 1.0 (every edge between a highlight and its surroundings) and
 * divides 0/0 on a ring of exactly 1.0. The frozen per-tap forms
 * (`conditionedInput = false`) keep sharpening that path in linear space.
 */
function createRcasShader(fsr315NumericParity: boolean, conditionedInput = false): string {
    const luma = fsr315NumericParity
        ? /* wgsl */ `
    // FSR's inexpensive luma is scaled by two; the scale cancels in ratios.
    let bL = 0.5 * b.r + b.g + 0.5 * b.b;
    let dL = 0.5 * d.r + d.g + 0.5 * d.b;
    let eL = 0.5 * e.r + e.g + 0.5 * e.b;
    let fL = 0.5 * f.r + f.g + 0.5 * f.b;
    let hL = 0.5 * h.r + h.g + 0.5 * h.b;
`
        : '';
    const lowerLimiter = fsr315NumericParity
        ? /* wgsl */ `
    let lowerLimiterMultiplier = clamp(
        eL / min(min(bL, dL), min(fL, hL)),
        0.0,
        1.0
    );
`
        : '';
    const hitMinMultiplier = fsr315NumericParity ? ' * lowerLimiterMultiplier' : '';
    const denoise = fsr315NumericParity
        ? /* wgsl */ `
        let mn = min(min(min(bL, dL), eL), min(fL, hL));
        let mx = max(max(max(bL, dL), eL), max(fL, hL));
        var nz = 0.25 * (bL + dL + fL + hL) - eL;
        nz = clamp(abs(nz) / max(mx - mn, 1.0e-4), 0.0, 1.0);
        lobe *= 1.0 - 0.5 * nz;
`
        : /* wgsl */ `
        let mn = min(min(b.g, d.g), min(f.g, h.g));
        let mx = max(max(b.g, d.g), max(f.g, h.g));
        var nz = 0.25 * (b.g + d.g + f.g + h.g) - e.g;
        nz = clamp(abs(nz) / max(mx - mn, 1.0e-4), 0.0, 1.0);
        lobe *= 1.0 - 0.5 * nz;
`;
    const load = conditionedInput
        ? /* wgsl */ `
// Loads a display-resolution texel as-is: conditioned tonemap-space history on
// the temporal path, the caller's linear domain on the spatial path (main
// conditions those taps itself).
fn rcasLoad(p : vec2i) -> vec3f {
    let clamped = clamp(p, vec2i(0), vec2i(C.displaySize) - 1);
    return textureLoad(inputColor, clamped, 0).rgb;
}`
        : /* wgsl */ `
// Loads a display-resolution texel in the caller's linear/HDR domain.
fn rcasLoad(p : vec2i) -> vec3f {
    let clamped = clamp(p, vec2i(0), vec2i(C.displaySize) - 1);
    let c = textureLoad(inputColor, clamped, 0).rgb;
    if (hasFlag(FLAG_INPUT_REINHARD)) {
        // Undo the pre-exposure the accumulate pass baked in before tonemapping.
        let exposure = max(textureLoad(exposureTex, vec2i(0), 0).r, 1.0e-4);
        return tonemapInvert(c) / exposure;
    }
    return c;
}`;
    const resolve = conditionedInput
        ? /* wgsl */ `
    var pix = (lobe * b + lobe * d + lobe * h + lobe * f + e) * rcpL;
    if (hasFlag(FLAG_INPUT_REINHARD)) {
        // Undo the accumulate conditioning once on the sharpened result: invert
        // the tonemap, then divide out the baked-in pre-exposure.
        let exposure = max(textureLoad(exposureTex, vec2i(0), 0).r, 1.0e-4);
        pix = tonemapInvert(max(pix, vec3f(0.0))) / exposure;
    } else {
        // Spatial: invert the tap conditioning once. Unlike accumulate history,
        // this input has no pre-exposure bounding it, so two guards:
        // - anchor on the exact linear center — an unsharpened pixel passes
        //   through bit-exact, and values beyond tonemapInvert's clamp
        //   (linear ~1000) are not flattened to it;
        // - cap at linear RCAS's own maximum gain for this sharpness. An
        //   isolated peak overshoots the conditioned range, and inverting that
        //   multiplies it up to ~1000x (a lone 0.5 on near-black became 1303
        //   at sharpness 1 in GPU probes).
        let maxIn = max(max(max(bIn, dIn), max(fIn, hIn)), max(eIn, vec3f(0.0)));
        let maxGain = 1.0 / (1.0 - 4.0 * RCAS_LIMIT * peak);
        pix = clamp(
            eIn + tonemapInvert(max(pix, vec3f(0.0))) - tonemapInvert(e),
            vec3f(0.0),
            maxIn * maxGain
        );
    }`
        : /* wgsl */ `
    let pix = (lobe * b + lobe * d + lobe * h + lobe * f + e) * rcpL;`;
    const taps = conditionedInput
        ? /* wgsl */ `    let bIn = rcasLoad(sp + vec2i(0, -1));
    let dIn = rcasLoad(sp + vec2i(-1, 0));
    let eIn = rcasLoad(sp);
    let fIn = rcasLoad(sp + vec2i(1, 0));
    let hIn = rcasLoad(sp + vec2i(0, 1));
    // The limiter below assumes [0,1]. Accumulate history already arrives
    // conditioned; the spatial path's linear/HDR taps get the same invertible
    // tonemap here, so both paths sharpen in one bounded space.
    let conditionTaps = !hasFlag(FLAG_INPUT_REINHARD);
    let b = select(bIn, tonemapInvertible(bIn), conditionTaps);
    let d = select(dIn, tonemapInvertible(dIn), conditionTaps);
    let e = select(eIn, tonemapInvertible(eIn), conditionTaps);
    let f = select(fIn, tonemapInvertible(fIn), conditionTaps);
    let h = select(hIn, tonemapInvertible(hIn), conditionTaps);`
        : /* wgsl */ `    let b = rcasLoad(sp + vec2i(0, -1));
    let d = rcasLoad(sp + vec2i(-1, 0));
    let e = rcasLoad(sp);
    let f = rcasLoad(sp + vec2i(1, 0));
    let h = rcasLoad(sp + vec2i(0, 1));`;

    // Alpha rides its own binding (4): on the temporal path binding 1 is the
    // accumulate history, whose .a is the accumulation age, so the resolved
    // alpha comes from the locks buffer's spare .a instead. On the spatial path
    // it is the EASU output — the same texture as binding 1. RCAS never sharpens
    // alpha (a coverage mask has no local contrast to preserve); the center tap
    // passes through, as in FSR1Node. Every RCAS form — production, the frozen
    // benchmark identities, the experiments — declares it, so one bind-group
    // shape fits whichever shader `Upscaler` is handed.
    return assembleShader(
        WGSL_CONSTANTS,
        WGSL_TONEMAP,
        /* wgsl */ `
@group(0) @binding(1) var inputColor : texture_2d<f32>;
@group(0) @binding(2) var exposureTex : texture_2d<f32>;
@group(0) @binding(3) var outputColor : texture_storage_2d<rgba16float, write>;
@group(0) @binding(4) var alphaSource : texture_2d<f32>;

// Maximum sharpening lobe magnitude — set so a single tap cannot exceed the
// local contrast ring (0.25 - 1/16 in the reference).
const RCAS_LIMIT : f32 = 0.25 - (1.0 / 16.0);
${load}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3u) {
    if (any(vec2f(gid.xy) >= C.displaySize)) { return; }
    let sp = vec2i(gid.xy);

    //* Cross Neighborhood
    //   b
    // d e f
    //   h
${taps}
${luma}

    //* Sharpening Lobe
    // Min/max ring per channel bounds how strong the negative lobe may be
    // before the output would exceed local contrast.
    let mn4 = min(min(b, d), min(f, h));
    let mx4 = max(max(b, d), max(f, h));
${lowerLimiter}
    let hitMin = mn4 / (4.0 * mx4)${hitMinMultiplier};
    let hitMax = (vec3f(1.0) - mx4) / (4.0 * mn4 - 4.0);
    let lobeRGB = max(-hitMin, hitMax);
    // C.sharpness 1 -> 0 attenuation stops (sharpest), 0 -> 2 stops.
    let peak = exp2(-2.0 * (1.0 - C.sharpness));
    var lobe = max(-RCAS_LIMIT, min(max(lobeRGB.r, max(lobeRGB.g, lobeRGB.b)), 0.0)) * peak;

    //* Denoise (FSR1's FSR_RCAS_DENOISE)
    // A lone luma outlier vs its cross-neighborhood, normalized by the local
    // range, reads as noise; attenuate the lobe there (up to 50%) so RCAS
    // doesn't amplify grain from noisy inputs (e.g. reduced-res SSR/GI).
    if (hasFlag(FLAG_RCAS_DENOISE)) {
${denoise}
    }

    //* Resolve
    let rcpL = 1.0 / (4.0 * lobe + 1.0);
${resolve}

    textureStore(outputColor, gid.xy, vec4f(pix, textureLoad(alphaSource, sp, 0).a));
}
`,
    );
}

function createRcasExperimentShader(loadStrategy: 'hoisted' | 'tonemap-space'): string {
    const base = createRcasShader(true);
    if (loadStrategy === 'hoisted') {
        // Same math as production, but the uniform 1×1 exposure load is hoisted
        // out of the tap function and the per-tap division folded to a multiply.
        return base
            .replace(
                `fn rcasLoad(p : vec2i) -> vec3f {
    let clamped = clamp(p, vec2i(0), vec2i(C.displaySize) - 1);
    let c = textureLoad(inputColor, clamped, 0).rgb;
    if (hasFlag(FLAG_INPUT_REINHARD)) {
        // Undo the pre-exposure the accumulate pass baked in before tonemapping.
        let exposure = max(textureLoad(exposureTex, vec2i(0), 0).r, 1.0e-4);
        return tonemapInvert(c) / exposure;
    }
    return c;
}`,
                `fn rcasLoad(p : vec2i, rcpExposure : f32) -> vec3f {
    let clamped = clamp(p, vec2i(0), vec2i(C.displaySize) - 1);
    let c = textureLoad(inputColor, clamped, 0).rgb;
    if (hasFlag(FLAG_INPUT_REINHARD)) {
        return tonemapInvert(c) * rcpExposure;
    }
    return c;
}`,
            )
            .replace(
                `    let sp = vec2i(gid.xy);`,
                `    let sp = vec2i(gid.xy);
    // Undo the pre-exposure the accumulate pass baked in — once, not per tap.
    var rcpExposure = 1.0;
    if (hasFlag(FLAG_INPUT_REINHARD)) {
        rcpExposure = 1.0 / max(textureLoad(exposureTex, vec2i(0), 0).r, 1.0e-4);
    }`,
            )
            .replace(/rcasLoad\(sp( \+ vec2i\(-?\d, -?\d\))?\)/g, (m) =>
                m.replace(/\)$/, ', rcpExposure)'),
            );
    }
    // tonemap-space: sharpen the raw tonemapped history texels (bounded [0,1),
    // the range RCAS's limiter math assumes) and invert once on the result.
    return base
        .replace(
            `fn rcasLoad(p : vec2i) -> vec3f {
    let clamped = clamp(p, vec2i(0), vec2i(C.displaySize) - 1);
    let c = textureLoad(inputColor, clamped, 0).rgb;
    if (hasFlag(FLAG_INPUT_REINHARD)) {
        // Undo the pre-exposure the accumulate pass baked in before tonemapping.
        let exposure = max(textureLoad(exposureTex, vec2i(0), 0).r, 1.0e-4);
        return tonemapInvert(c) / exposure;
    }
    return c;
}`,
            `fn rcasLoad(p : vec2i) -> vec3f {
    let clamped = clamp(p, vec2i(0), vec2i(C.displaySize) - 1);
    return textureLoad(inputColor, clamped, 0).rgb;
}`,
        )
        .replace(
            `    let pix = (lobe * b + lobe * d + lobe * h + lobe * f + e) * rcpL;

    textureStore(outputColor, gid.xy, vec4f(pix, textureLoad(alphaSource, sp, 0).a));`,
            `    var pix = (lobe * b + lobe * d + lobe * h + lobe * f + e) * rcpL;
    if (hasFlag(FLAG_INPUT_REINHARD)) {
        // Undo the conditioning once on the sharpened result instead of per tap.
        let exposure = max(textureLoad(exposureTex, vec2i(0), 0).r, 1.0e-4);
        pix = tonemapInvert(max(pix, vec3f(0.0))) / exposure;
    }

    textureStore(outputColor, gid.xy, vec4f(pix, textureLoad(alphaSource, sp, 0).a));`,
        );
}

/**
 * Legacy RCAS shader retained only for benchmark comparisons.
 */
export const RCAS_LEGACY_SHADER = createRcasShader(false);

/**
 * The pre-2026-07-21 production shader (FSR 3.1.5 numeric parity, per-tap
 * conditioning inversion), retained so the `rcas-fsr315-limiter` /
 * `rcas-fsr315-numeric` benchmark identities stay frozen and reproducible.
 */
export const RCAS_PER_TAP_SHADER = createRcasShader(true);

/**
 * Production RCAS shader: FSR 3.1.5 lower-limiter and denoise parity,
 * sharpening in conditioned tonemap space with a single inversion on the
 * result (~35% cheaper than the per-tap form, visually equivalent — see
 * bench/docs/NEXT-STEPS.md item 1).
 */
export const RCAS_SHADER = createRcasShader(true, true);

/**
 * Benchmark candidate: production math with the exposure load hoisted out of
 * the tap function (one 1×1 load + reciprocal per pixel instead of five
 * loads + divisions). Output is visually identical to {@link RCAS_SHADER}.
 */
export const RCAS_HOISTED_EXPOSURE_SHADER = createRcasExperimentShader('hoisted');

/**
 * Benchmark candidate: sharpens in invertible-tonemap space (plain per-tap
 * loads, like the source resolver's RCAS) and inverts conditioning once on
 * the result. Output differs subtly from {@link RCAS_SHADER} — needs capture
 * validation before any adoption.
 */
export const RCAS_TONEMAP_SPACE_SHADER = createRcasExperimentShader('tonemap-space');
