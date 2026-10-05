# Draft issue for mrdoob/three.js

**Title:** Screen-space effect nodes ignore `PassNode.setResolutionScale()` and run at canvas resolution

---

### Description

`SSGINode`, `SSRNode`, `GTAONode`, `RecurrentDenoiseNode` and `TemporalReprojectNode` size their render targets from `renderer.getDrawingBufferSize()` in `updateBefore()` every frame. They don't look at the size of the G-buffer textures they are given.

When the scene pass is rendered at reduced resolution with `scenePass.setResolutionScale( 0.5 )`, the pipeline used by the `webgpu_upscaling_taau` and `webgpu_upscaling_fsr1` examples, every one of these effects still runs at full canvas resolution:

- **Performance:** the effect costs as much as at native resolution, so most of the saving from rendering at reduced resolution is lost. At a scale of 0.5 the effect traces 4× the pixels it has input for.
- **Correctness (`TemporalReprojectNode`):** the node copies the current depth texture (pass resolution) into its history depth texture (canvas resolution) with `copyTextureToTexture`. For a depth format WebGPU requires the copy to cover the whole subresource, so this fails validation **every frame**, and the depth history is never valid:

```
Copy origin ([Origin3D x:0, y:0, z:0]) and size ([Extent3D width:800, height:456, depthOrArrayLayers:1])
does not cover the entire subresource (origin: [x: 0, y: 0], size: [Extent3D width:1600, height:913,
depthOrArrayLayers:1]) of [Texture (unlabeled 1600x913 px, TextureFormat::Depth24Plus)]. The entire
subresource must be copied when the format (TextureFormat::Depth24Plus) is a depth/stencil format or
the sample count (1) is > 1.
```

`SSRNode.resolutionScale` and `GTAONode.resolutionScale` don't fully cover this:

- They scale relative to the drawing buffer, so the user has to keep them in sync with the pass by hand.
- They round with `Math.round`, but `PassNode.setSize()` uses `Math.floor`. At odd sizes the effect ends up one texel larger than its inputs (913 × 0.5 → 457 rows of effect vs 456 rows of G-buffer).
- `SSGINode`, `RecurrentDenoiseNode` and `TemporalReprojectNode` have no `resolutionScale` at all. Adding one to SSGI was part of #33770, which was closed without merging.

None of the official examples combine a reduced-resolution `pass()` with these effects. The SSGI examples avoid the cost by not calling `setPixelRatio()` instead.

### Reproduction steps

1. Create a `pass()` with `setResolutionScale( 0.5 )` and an MRT providing normals.
2. Feed its color, depth and normal textures to `ssgi()` or `ssr()`.
3. After a frame, compare the pass's render-target size with the effect's render-target size.

### Code

```js
const scenePass = pass( scene, camera );
scenePass.setMRT( mrt( { output, normal: normalView } ) );
scenePass.setResolutionScale( 0.5 );

const color = scenePass.getTextureNode( 'output' );
const depth = scenePass.getTextureNode( 'depth' );
const normal = scenePass.getTextureNode( 'normal' );

const giPass = ssgi( color, depth, normal, camera );
renderPipeline.outputNode = giPass.getGINode();

renderer.setAnimationLoop( () => {

	renderPipeline.render();

	console.log(
		'pass:', scenePass.renderTarget.width, scenePass.renderTarget.height,
		'ssgi:', giPass._ssgiRenderTarget.width, giPass._ssgiRenderTarget.height
	);
	// pass: 800 456   ssgi: 1600 913   (expected: ssgi 800 456)

} );
```

Measured with a 1600×913 drawing buffer and a scale of 0.5:

| Node | Expected | Actual |
| --- | --- | --- |
| `pass()` | 800×456 | 800×456 |
| `SSGINode` | 800×456 | 1600×913 |
| `SSRNode` (base mip) | 800×456 | 1600×913 |
| `GTAONode` | 800×456 | 1600×913 |
| `RecurrentDenoiseNode` | 800×456 | 1600×913 |
| `TemporalReprojectNode` | 800×456 | 1600×913 + validation error every frame |

### Suggested fix

Have these nodes size themselves from their input instead of the drawing buffer, for example from the depth texture's `image.width` / `image.height`, and keep `resolutionScale` as a multiplier relative to that size. With a full-resolution pass the input size equals the drawing buffer size, so existing scenes would behave exactly as they do now. `TemporalReprojectNode` already reads `currentDepth.image.width` / `.height` before its depth copy, so the size is already at hand there.

A smaller alternative is to add `resolutionScale` to `SSGINode`, `RecurrentDenoiseNode` and `TemporalReprojectNode`, and switch the rounding to `Math.floor` to match `PassNode`. That still leaves the user keeping the two scales in sync by hand.

### Workaround

Wrap the effect's `updateBefore()` so that, for the duration of that call only, `renderer.getDrawingBufferSize()` returns the drawing buffer size scaled by `scenePass.getResolutionScale()` with `Math.floor` rounding. When one effect updates another from inside its own update (`recurrentDenoise` → `temporalReproject`), the inner wrapper must scale from the original method, not the outer wrapper, or the size is scaled twice.

### Live example

_TODO: attach a jsfiddle based on `webgpu_upscaling_taau` with `ssgi()` added._

### Screenshots

_n/a_

### Version

r186.1 (also checked `dev` as of 2026-10-02)

### Device

Desktop

### Browser

Chrome 154

### OS

macOS 26.6 (Apple M5 Pro)
