import { type LayerId } from './layers';

//* Narration — what one temporal frame does, in dispatch order.
// Every claim maps to source: Upscaler.ts (beginFrame/_encodeGuides/
// _encodeLate), reconstruct.ts, luminancePyramid.ts, shadingChange.ts,
// accumulate.ts and rcas.ts. The order is the GPU's: the reconstruct pass
// (dilation + disocclusion) runs before accumulate reprojects history, and
// exposure + shading change run between them.

/** One narration step: a title, a short explanation, and the layer it shows. */
export interface NarrationStep {
    title: string;
    /** Where it happens in the code. */
    where: string;
    /** HTML body (trusted, authored here). */
    body: string;
    /** Main-view layer selected when the step is opened. */
    layer: LayerId;
    /** A hint for what to do to see it happen. */
    tryIt: string;
}

/** The ordered steps of one temporal frame. */
export const STEPS: NarrationStep[] = [
    {
        title: 'Jitter the projection',
        where: 'Upscaler.beginFrame()',
        layer: 'input',
        body:
            'Before the scene renders, the camera is shifted by a sub-pixel offset — a view ' +
            'offset, the same mechanism as three’s TRAA. Offsets follow a Halton(2,3) sequence ' +
            'of <b>8·ratio²</b> phases, enough for every display pixel inside a render pixel to ' +
            'receive samples (see the diagram). Motion vectors are computed with the ' +
            '<i>unjittered</i> projection, so jitter never reads as motion.',
        tryIt: 'Step a few frames and watch the cyan dot hop around the pixel.',
    },
    {
        title: 'Render at low resolution',
        where: 'your render · MRT color + velocity, float depth',
        layer: 'input',
        body:
            'The scene renders at <b>1/ratio</b> of display size per axis into a color + velocity ' +
            'MRT with a depth texture. Each render pixel holds the scene at its jittered sample ' +
            'point only, so the input aliases and wobbles from frame to frame — fine detail in ' +
            'the star and the wires appears in some phases and vanishes in others.',
        tryIt: 'Step with the Input layer on: the chart shimmers by up to half a render pixel.',
    },
    {
        title: 'Dilate motion and depth',
        where: 'reconstruct pass · render res',
        layer: 'motion',
        body:
            'For each render pixel the reconstruct pass finds the <b>nearest depth in its 3×3 ' +
            'neighbourhood</b> and takes that texel’s motion vector, so thin foreground edges ' +
            'carry their own motion instead of the background’s. Velocity arrives as an NDC ' +
            'delta and is stored as a UV delta.',
        tryIt: 'Drag to slide the camera: static geometry turns one smooth colour (olive means no motion); the object keeps its own.',
    },
    {
        title: 'Detect disocclusion',
        where: 'reconstruct pass (same dispatch)',
        layer: 'disocclusion',
        body:
            'The same pass reprojects through that motion (compensating the jitter change) and ' +
            'compares the current depth with <b>last frame’s dilated depth</b>, with a tolerance ' +
            'that scales with viewport size and depth (AMD’s depth-clip formulation). A surface ' +
            'that was behind something nearer last frame — or off-screen — is disoccluded: its ' +
            'history will be thrown away. Because the test is against last frame’s depth, a ' +
            'surface the camera moves away from reads as disoccluded too.',
        tryIt: 'Slide the camera one frame: slivers of wall light up beside each wire. Orbit 1° and the wall’s far edge lights up as well.',
    },
    {
        title: 'Exposure and shading change',
        where: 'luminancePyramid + shadingChange passes',
        layer: 'shading',
        body:
            'Auto-exposure reduces the frame to one log-average luminance and eases a ' +
            '<b>pre-exposure</b> toward it; accumulation runs on exposed color and the factor is ' +
            'divided back out at output. The shading-change detector compares 4×4 and 8×8 ' +
            'block-mean luma with the previous frame; where lighting genuinely changed it ages ' +
            'unlocked history. On a still, steadily lit scene it should stay mostly dark; here the ' +
            'finest bars and the wires — patterns near the render-pixel limit, whose block means ' +
            'shift with every jitter phase — still trip it, a limit of its noise-floor tuning.',
        tryIt: 'Untick “shading change” under Pipeline, reset and step: the bars then converge like everything else.',
    },
    {
        title: 'Upsample, then reproject history',
        where: 'accumulate pass · display res',
        layer: 'history',
        body:
            'Per display pixel, the current frame is upsampled with a <b>jitter-aware Lanczos2</b> ' +
            'over 3×3 render texels — weighted by distance to where the samples actually landed. ' +
            'Last frame’s history is fetched at <code>uv − motion</code> with a 5-tap ' +
            'Catmull-Rom filter. Both live in an invertible tonemap space, <code>c/(1+max c)</code>, ' +
            'so fireflies can’t dominate the average.',
        tryIt: 'Compare History with Input in the magnifier: the history already holds detail no single input has.',
    },
    {
        title: 'Rectify history',
        where: 'accumulate pass',
        layer: 'locks',
        body:
            'History is clipped toward the current 3×3 neighbourhood’s <b>YCoCg mean ± σ</b> box ' +
            '(variance clipping), so a stale colour can’t ghost. Thin high-contrast features grow ' +
            '<b>locks</b> (white here) that widen that box, so wires keep their accumulated value ' +
            'instead of dimming; still, converged pixels get a milder widening. Disocclusion ' +
            'zeroes the sample count; a shading change ages it unless locked.',
        tryIt: 'Step ~10 frames: locks build up along the wires and hairlines, flat areas stay black.',
    },
    {
        title: 'Blend and accumulate',
        where: 'accumulate pass',
        layer: 'age',
        body:
            'The result is <code>mix(history, current, α)</code> with <b>α ≈ confidence / ' +
            'samples</b>, a running average that a locked pixel tilts further toward history. ' +
            'The sample count grows by one per frame up to <code>maxAccumulation</code> and is ' +
            'stored in the history’s alpha as the accumulation age shown here: white once full, ' +
            'black where disocclusion discarded history, grey where a shading change aged it.',
        tryIt: 'Reset history, then step: everything whitens together over maxAccumulation frames; the object’s wake stays dark.',
    },
    {
        title: 'Sharpen (RCAS)',
        where: 'rcas pass · display res',
        layer: 'output',
        body:
            'RCAS (FSR1’s robust contrast-adaptive sharpening) sharpens the accumulated history in ' +
            'its conditioned space, then inverts the tonemap and divides the exposure out once, ' +
            'writing <b>linear HDR</b>. Tone mapping is the app’s presentation step — here three’s ' +
            'ACES + sRGB — not part of the upscaler.',
        tryIt: 'Flip between History and Output: same samples, RCAS adds the edge contrast.',
    },
];
