import * as THREE from 'three/webgpu';
import { float, floor, mix, select, step, texture, uniform, uv, vec2, vec4 } from 'three/tsl';

//* A draggable, nearest-neighbour magnifier for comparing several full-screen
//* textures pixel by pixel. Self-contained: give it the textures and the
//* fragment colour you were about to present, and it returns that colour with
//* the magnified panels composited in. The pixels are drawn on the GPU in the
//* same present pass (so they get exactly the renderer's output transform as
//* the main view); the frame, labels and drag handling are a small DOM overlay.
//*
//* Coordinates: everything on the GPU side is in "display pixels" of the
//* sampled textures, measured from the top-left — the same space as a QuadMesh
//* `uv()` scaled by the texture size (QuadMesh's uv has y = 0 at the top).

/** An RGBA shader node. */
type ColorNode = THREE.Node<'vec4'>;
/** A sampled-texture node (its `.value` is re-pointable). */
type TexNode = ReturnType<typeof texture<'vec4'>>;

/** Options for {@link Loupe}. */
export interface LoupeOptions {
    /** Panel labels, one per magnified source (1–4). */
    labels: string[];
    /** Physical pixels per CSS pixel of the displayed textures (the renderer's DPR). */
    dpr: number;
    /**
     * Magnification: how many CSS pixels each source pixel becomes. Source
     * pixels are physical (display) pixels, so on a DPR-2 screen `4` is an 8×
     * visual enlargement — each pixel still reads as a clear 4-CSS-px block.
     * Default 4.
     */
    zoom?: number;
    /** Panel edge length in CSS pixels (shrunk to fit narrow screens). Default 200. */
    panelSize?: number;
    /** Element the overlay is appended to. Default `document.body`. */
    parent?: HTMLElement;
}

/**
 * Nearest-neighbour multi-source magnifier. Build it, call {@link wrap} once on
 * the present material's colour node, then keep it fed with {@link setTextures}
 * whenever the sources are recreated and {@link setDisplaySize} on resize.
 */
export class Loupe {
    /** Fires whenever the user starts or stops dragging (so callers can pause other pointer use). */
    onDragChange: ((dragging: boolean) => void) | null = null;

    private readonly _count: number;
    private readonly _dpr: number;
    private _zoom: number;
    private _enabled = true;
    private _panelCss: number;
    private readonly _gapCss = 8;
    // Lens centre in CSS pixels.
    private readonly _centerCss = new THREE.Vector2();

    //* GPU uniforms (display pixels)
    private readonly _uCenter = uniform(new THREE.Vector2());
    private readonly _uOrigin = uniform(new THREE.Vector2());
    private readonly _uPanel = uniform(200);
    private readonly _uStride = uniform(208);
    private readonly _uZoom = uniform(4);
    private readonly _uEnabled = uniform(1);
    private readonly _uSize = uniform(new THREE.Vector2(1, 1));
    private readonly _texNodes: TexNode[] = [];

    //* DOM overlay
    private readonly _root: HTMLDivElement;
    private readonly _lens: HTMLDivElement;
    private readonly _panels: HTMLDivElement[] = [];
    private readonly _labels: HTMLSpanElement[] = [];

    /**
     * @param textures - The initial source textures, one per label
     * @param options - Labels, DPR, zoom and panel size
     */
    constructor(textures: THREE.Texture[], options: LoupeOptions) {
        if (textures.length !== options.labels.length || textures.length < 1 || textures.length > 4)
            throw new Error('Loupe: give 1–4 textures, one label each.');
        this._count = textures.length;
        this._dpr = options.dpr;
        this._zoom = options.zoom ?? 4;
        this._panelCss = options.panelSize ?? 200;

        // The sample position is a node shared by every source, so each panel
        // reads the same display pixel from its own texture.
        const sampleUV = this._sampleUV();
        for (const tex of textures) this._texNodes.push(texture(tex, sampleUV));

        this._root = document.createElement('div');
        this._root.className = 'loupe';
        this._root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:5;';
        this._lens = document.createElement('div');
        this._lens.style.cssText =
            'position:absolute;border:1px solid #7dd3fc;box-shadow:0 0 0 1px rgba(0,0,0,.6);' +
            'pointer-events:auto;cursor:grab;touch-action:none;';
        this._root.appendChild(this._lens);
        for (let i = 0; i < this._count; i++) {
            const panel = document.createElement('div');
            panel.style.cssText =
                'position:absolute;border:1px solid rgba(125,211,252,.85);' +
                'box-shadow:0 0 0 1px rgba(0,0,0,.7),0 6px 24px rgba(0,0,0,.5);' +
                'pointer-events:auto;cursor:grab;touch-action:none;';
            const label = document.createElement('span');
            label.style.cssText =
                'position:absolute;left:-1px;top:-21px;padding:2px 6px;background:rgba(8,10,14,.88);' +
                'border:1px solid rgba(125,211,252,.5);border-radius:4px 4px 0 0;color:#cfd8e3;' +
                'font:11px/1.3 ui-monospace,Menlo,monospace;white-space:nowrap;';
            label.textContent = options.labels[i];
            panel.appendChild(label);
            this._root.appendChild(panel);
            this._panels.push(panel);
            this._labels.push(label);
        }
        (options.parent ?? document.body).appendChild(this._root);
        this._installDrag();

        this._centerCss.set(window.innerWidth * 0.5, window.innerHeight * 0.55);
        this._layout();
    }

    //* Public API

    /**
     * Composites the magnified panels over `base`. Call once, on the colour
     * node of the full-screen present material.
     * @param base - The colour the present pass would output without the loupe
     * @returns The colour with the loupe panels composited in
     */
    wrap(base: ColorNode): ColorNode {
        const p = this._pixel();
        const local = p.sub(this._uOrigin);
        const index = floor(local.x.div(this._uStride));
        const lx = local.x.sub(index.mul(this._uStride));
        const inside = this._uEnabled
            .mul(step(0, local.x))
            .mul(step(index, float(this._count - 1)))
            .mul(step(lx, this._uPanel))
            .mul(step(0, local.y))
            .mul(step(local.y, this._uPanel));
        let magnified: ColorNode = vec4(this._texNodes[this._count - 1]);
        for (let i = this._count - 2; i >= 0; i--)
            magnified = select(index.equal(float(i)), vec4(this._texNodes[i]), magnified);
        return mix(base, magnified, inside);
    }

    /**
     * Re-points the sources (e.g. after the producers rebuilt their outputs).
     * @param textures - One texture per label, in panel order
     * @param labels - Optional new panel labels
     */
    setTextures(textures: THREE.Texture[], labels?: string[]): void {
        textures.forEach((tex, i) => {
            this._texNodes[i].value = tex;
        });
        labels?.forEach((text, i) => {
            this._labels[i].textContent = text;
        });
    }

    /**
     * Tells the loupe the sampled textures' size (they are assumed to cover the
     * viewport). Call after every resize/reconfigure.
     * @param width - Texture width in pixels
     * @param height - Texture height in pixels
     */
    setDisplaySize(width: number, height: number): void {
        this._uSize.value.set(width, height);
        this._layout();
    }

    /** Magnification (CSS pixels per source pixel). */
    get zoom(): number {
        return this._zoom;
    }

    set zoom(value: number) {
        this._zoom = value;
        this._layout();
    }

    /** Shows/hides the loupe (GPU panels and DOM overlay together). */
    get enabled(): boolean {
        return this._enabled;
    }

    set enabled(value: boolean) {
        this._enabled = value;
        this._uEnabled.value = value ? 1 : 0;
        this._root.style.display = value ? '' : 'none';
    }

    /**
     * Moves the lens centre.
     * @param x - CSS pixels from the left
     * @param y - CSS pixels from the top
     */
    moveTo(x: number, y: number): void {
        this._centerCss.set(x, y);
        this._layout();
    }

    /** Removes the DOM overlay. */
    dispose(): void {
        this._root.remove();
    }

    //* Internals

    /** Fragment position in display pixels (top-left origin, pixel centres at .5). */
    private _pixel() {
        return uv().mul(this._uSize);
    }

    /**
     * Nearest-neighbour source UV: every fragment in a `zoom × zoom` block maps
     * to the centre of one source pixel, so even a linear sampler returns that
     * texel unfiltered.
     */
    private _sampleUV() {
        const local = this._pixel().sub(this._uOrigin);
        const index = floor(local.x.div(this._uStride));
        const inPanel = vec2(local.x.sub(index.mul(this._uStride)), local.y);
        const offset = inPanel.sub(this._uPanel.mul(0.5)).div(this._uZoom);
        return floor(this._uCenter.add(offset)).add(0.5).div(this._uSize);
    }

    /** Places the lens + panels and pushes the matching uniforms. */
    private _layout(): void {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const gutter = 16;
        // Shrink panels to fit a narrow (phone) viewport.
        const fit = (vw - gutter * 2 - this._gapCss * (this._count - 1)) / this._count;
        const panel = Math.max(80, Math.min(this._panelCss, fit));
        const groupW = panel * this._count + this._gapCss * (this._count - 1);
        // The panels show panel·dpr / (zoom·dpr) = panel / zoom source pixels,
        // which cover panel / (zoom·dpr) CSS px of the main view.
        const lensCss = panel / (this._zoom * this._dpr);

        const c = this._centerCss;
        c.x = Math.min(Math.max(c.x, 0), vw);
        c.y = Math.min(Math.max(c.y, 0), vh);

        // Panels above the lens, or below when there's no room.
        let gx = c.x - groupW / 2;
        gx = Math.min(Math.max(gx, gutter), Math.max(gutter, vw - gutter - groupW));
        let gy = c.y - lensCss / 2 - 34 - panel;
        if (gy < 40) gy = c.y + lensCss / 2 + 34;

        this._lens.style.left = `${c.x - lensCss / 2}px`;
        this._lens.style.top = `${c.y - lensCss / 2}px`;
        this._lens.style.width = `${lensCss}px`;
        this._lens.style.height = `${lensCss}px`;
        this._panels.forEach((el, i) => {
            el.style.left = `${gx + i * (panel + this._gapCss) - 1}px`;
            el.style.top = `${gy - 1}px`;
            el.style.width = `${panel}px`;
            el.style.height = `${panel}px`;
        });

        const d = this._dpr;
        this._uCenter.value.set(c.x * d, c.y * d);
        this._uOrigin.value.set(gx * d, gy * d);
        this._uPanel.value = panel * d;
        this._uStride.value = (panel + this._gapCss) * d;
        this._uZoom.value = this._zoom * d;
    }

    /** Dragging the lens or any panel moves the lens. */
    private _installDrag(): void {
        let last: { x: number; y: number } | null = null;
        const down = (e: PointerEvent): void => {
            last = { x: e.clientX, y: e.clientY };
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            (e.currentTarget as HTMLElement).style.cursor = 'grabbing';
            this.onDragChange?.(true);
            e.stopPropagation();
        };
        const move = (e: PointerEvent): void => {
            if (!last) return;
            // Dragging a panel moves the lens by the same amount on screen —
            // panels follow, so the gesture feels like dragging the whole loupe.
            this.moveTo(this._centerCss.x + e.clientX - last.x, this._centerCss.y + e.clientY - last.y);
            last = { x: e.clientX, y: e.clientY };
            e.stopPropagation();
        };
        const up = (e: PointerEvent): void => {
            if (!last) return;
            last = null;
            (e.currentTarget as HTMLElement).style.cursor = 'grab';
            this.onDragChange?.(false);
        };
        for (const el of [this._lens, ...this._panels]) {
            el.addEventListener('pointerdown', down);
            el.addEventListener('pointermove', move);
            el.addEventListener('pointerup', up);
            el.addEventListener('pointercancel', up);
        }
    }
}
