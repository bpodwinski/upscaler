import type { WebGPURenderer } from 'three/webgpu';

type Uniform = { value: unknown };
type NodeLike = { version?: number; parameters?: Record<string, Uniform>; computeNode?: NodeLike };
const owners = new WeakSet<object>();

function snapshot(value: unknown): unknown {
    const object = value as { isVector2?: boolean; isVector3?: boolean; isVector4?: boolean; isMatrix3?: boolean; isMatrix4?: boolean; isColor?: boolean; isQuaternion?: boolean; clone?(): unknown } | null;
    return object && (object.isVector2 || object.isVector3 || object.isVector4 || object.isMatrix3 || object.isMatrix4 || object.isColor || object.isQuaternion)
        ? object.clone!() : value;
}
function uniforms(node: NodeLike): Uniform[] {
    return Object.values(node.parameters ?? node.computeNode?.parameters ?? {}).filter(value => value && typeof value === 'object' && 'value' in value);
}

/**
 * Prepare a synchronous path-tracer setup action through three's async compiler.
 * Records uniforms per dispatch (the Turquin bake mutates them between calls),
 * then replays compute/copy/disposal commands in their original order. Pause the
 * animation loop while preparing; the action must not await.
 */
export async function prepareComputeAction<T>(renderer: WebGPURenderer, action: () => T): Promise<T> {
    const compiler = (renderer as unknown as { compileComputeAsync?(nodes: unknown): Promise<void> }).compileComputeAsync;
    if (!compiler) throw new Error('This demo needs three.js compileComputeAsync() for async path-tracer preparation.');
    if (owners.has(renderer)) throw new Error('A compute preparation action is already active.');
    owners.add(renderer);
    // Recheck layouts for each action; resized resources can change a node's pipeline.
    const prepared = new WeakMap<object, number>();
    const compute = renderer.compute;
    const copy = renderer.copyTextureToTexture;
    const commands: Array<{ nodes?: NodeLike[]; values?: Array<[Uniform, unknown]>; disposal?: boolean; done?: boolean; run(): void }> = [];
    const touched = new Set<Uniform>();
    const disposals = new Map<{ dispose: (...args: unknown[]) => void }, (...args: unknown[]) => void>();
    const protect = (value: unknown): void => {
        if (!value || typeof value !== 'object' || !('dispose' in value) || typeof value.dispose !== 'function') return;
        const resource = value as { dispose: (...args: unknown[]) => void };
        if (disposals.has(resource)) return;
        const original = resource.dispose;
        disposals.set(resource, original);
        resource.dispose = (...args) => commands.push({ disposal: true, run: () => original.apply(resource, args) });
    };
    const releasePending = (): void => {
        for (const command of commands) {
            if (command.disposal && !command.done) {
                command.done = true;
                command.run();
            }
        }
    };
    let result: T;
    let failed = false;
    try {
        renderer.compute = (...args: Parameters<typeof compute>) => {
            const nodes = (Array.isArray(args[0]) ? args[0] : [args[0]]) as NodeLike[];
            const values = nodes.flatMap(node => uniforms(node).map(uniform => {
                touched.add(uniform);
                protect(uniform.value);
                return [uniform, snapshot(uniform.value)] as [Uniform, unknown];
            }));
            const savedArgs = [...args] as Parameters<typeof compute>;
            if (Array.isArray(savedArgs[1])) savedArgs[1] = [...savedArgs[1]];
            commands.push({ nodes, values, run: () => { compute.apply(renderer, savedArgs); } });
            return undefined;
        };
        renderer.copyTextureToTexture = (...args: Parameters<typeof copy>) => {
            args.forEach(protect);
            commands.push({ run: () => copy.apply(renderer, args) });
        };
        result = action();
        if (result && typeof (result as { then?: unknown }).then === 'function')
            throw new Error('Compute preparation requires a synchronous action.');
    } catch (error) {
        failed = true;
        owners.delete(renderer);
        throw error;
    } finally {
        renderer.compute = compute;
        renderer.copyTextureToTexture = copy;
        for (const [resource, dispose] of disposals) resource.dispose = dispose;
        if (failed) releasePending();
    }
    const finalValues = [...touched].map(uniform => [uniform, snapshot(uniform.value)] as [Uniform, unknown]);
    try {
        for (const command of commands) {
            for (const [uniform, value] of command.values ?? []) uniform.value = snapshot(value);
            for (const node of command.nodes ?? []) {
                if (prepared.get(node) !== (node.version ?? 0)) {
                    await compiler.call(renderer, node);
                    prepared.set(node, node.version ?? 0);
                }
            }
            command.done = true;
            command.run();
        }
        return result!;
    } finally {
        for (const [uniform, value] of finalValues) uniform.value = snapshot(value);
        owners.delete(renderer);
        releasePending();
    }
}
