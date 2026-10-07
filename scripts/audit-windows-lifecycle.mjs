// Compact resource counts deliberately distinguish explicit destruction from
// GC reachability. Use the production gallery: Vite's client reloads after freeze.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CDP } from './cdp-client.mjs';
import { browserExecutable } from './browser-executable.mjs';
import { gpuAuditSource } from './gpu-audit.mjs';
import { parseCliOrExit } from './cli-flags.mjs';
import { closeOwnedCdpBrowser, spawnVite, stopChild, waitForUrl, removeTempDirectory } from './local-processes.mjs';

const options = parseCliOrExit(process.argv.slice(2),
    ['browser','out','cycles','hold-seconds','power-preference','expected-vendor','without-timestamps'],
    'Usage: node scripts/audit-windows-lifecycle.mjs [--cycles 30] [--hold-seconds 60] [--browser path] [--power-preference high-performance|low-power] [--expected-vendor nvidia|intel] [--without-timestamps] [--out directory]');
const cycles = Number(options.cycles ?? 30), holdSeconds = Number(options['hold-seconds'] ?? 60);
if (!Number.isInteger(cycles) || cycles < 1 || !Number.isFinite(holdSeconds) || holdSeconds < 0)
    throw new Error('cycles must be positive and hold-seconds nonnegative.');
const source = gpuAuditSource(options);
const output = resolve(String(options.out ?? 'bench/results/windows-local/lifecycle'));
await mkdir(output, { recursive:true });
const profile = await mkdtemp(join(tmpdir(), 'upscaler-lifecycle-'));
const server = spawnVite('examples/vite.config.ts', { hostname:'127.0.0.1', port:5317 }, { extra:['preview'] });
let browser, client;
const report = { date:new Date().toISOString(), options, cycles, holdSeconds, checks:[] };
const resourceSource = `
(() => {
    const records = [], counts = {};
    window.__resourceAudit = {
        counts, documentId:crypto.randomUUID(),
        live: () => records.filter(r=>r.live).map(({kind,label,size})=>({kind,label,size})),
        reachable: () => Object.fromEntries(Object.keys(counts).map(kind=>[kind,records.filter(r=>r.kind===kind&&r.live&&r.weak.deref()).length])),
    };
    for (const [method,kind] of [['createTexture','textures'],['createBuffer','buffers'],['createQuerySet','queries']]) {
        const create = GPUDevice.prototype[method];
        counts[kind] = { created:0, destroyed:0, live:0, peak:0 };
        GPUDevice.prototype[method] = function(descriptor) {
            const resource = create.call(this,descriptor), counter = counts[kind];
            const record = { kind, label:descriptor.label ?? '', size:descriptor.size, live:true, weak:new WeakRef(resource) };
            records.push(record); counter.created++; counter.live++; counter.peak=Math.max(counter.peak,counter.live);
            const destroy = resource.destroy;
            resource.destroy = function() {
                if(record.live) { record.live=false; counter.destroyed++; counter.live--; }
                return destroy.call(this);
            };
            return resource;
        };
    }
})();
`;
try {
    await waitForUrl('http://127.0.0.1:5317', { child:server });
    browser = spawn(browserExecutable(options.browser),
        ['--headless=new','--enable-unsafe-webgpu','--no-first-run','--window-size=960,640',
         '--remote-debugging-port=9357','--user-data-dir='+profile,'about:blank'],
        { windowsHide:true, stdio:'ignore' });
    await waitForUrl('http://127.0.0.1:9357/json/version', { child:browser, allowSuccessfulExit:true });
    report.browser = await (await fetch('http://127.0.0.1:9357/json/version')).json();
    const target = await (await fetch('http://127.0.0.1:9357/json/new?about:blank',{method:'PUT'})).json();
    client = await CDP.connect(target.webSocketDebuggerUrl);
    for (const method of ['Page.enable','Runtime.enable','Log.enable']) await client.send(method);
    await client.send('Page.addScriptToEvaluateOnNewDocument', { source:source+resourceSource });
    await client.send('Page.navigate', { url:'http://127.0.0.1:5317/13-guides-node/' });
    for(let i=0;;i++) {
        if(await client.evaluate('Boolean(window.__guidesNodeExample?.fsrNode?.upscaler?.isReady)'))break;
        if(i>300)throw new Error('Linked guides startup timed out.');
        await delay(100);
    }
    const state = () => client.evaluate(`(() => {
        const api=window.__guidesNodeExample, renderer=api.renderer, u=api.fsrNode.upscaler;
        return { documentId:window.__resourceAudit.documentId, shared:api.guidesNode.upscaler===u, ready:Boolean(u?.isReady),
            rendererTextures:renderer.info.memory.textures,
            resources:window.__resourceAudit.counts, reachable:window.__resourceAudit.reachable(), dpr:devicePixelRatio,
            rendererDpr:renderer.getPixelRatio(), canvas:[renderer.domElement.width,renderer.domElement.height],
            output:u?[u.displayWidth,u.displayHeight]:null, render:u?[u.renderWidth,u.renderHeight]:null };
    })()`);
    await delay(200);
    await client.send('HeapProfiler.collectGarbage');
    report.initial = await state();
    for(let i=0;i<cycles;i++) {
        const high=i%2===0;
        await client.send('Emulation.setDeviceMetricsOverride', {
            width:high?800:960,height:high?600:640,deviceScaleFactor:high?2:1,mobile:false,
        });
        await delay(150);
        for(let n=0;n<100;n++) {
            const value=await state();
            if(value.ready && value.shared)break;
            if(n===99)throw new Error('Rebuilt linked graph did not become ready.');
            await delay(50);
        }
        await client.evaluate('window.__guidesNodeExample.renderer.backend.device.queue.onSubmittedWorkDone()');
        await delay(100);
        await client.send('HeapProfiler.collectGarbage');
        report.checks.push({cycle:i,...await state()});
        if(i%10===9)console.log('linked-guides cycles: '+(i+1));
    }
    const capturePhase = async name => {
        const shot=await client.send('Page.captureScreenshot',{format:'png'});
        await writeFile(join(output,name+'.png'),Buffer.from(shot.data,'base64'));
    };
    await capturePhase('after-resize');
    // This is page scheduling suspension, not Windows sleep or monitor hardware.
    await client.send('Page.setWebLifecycleState', { state:'frozen' });
    await delay(500);
    await client.send('Page.setWebLifecycleState', { state:'active' });
    await delay(500);
    for(let i=0;i<100;i++){if(await client.evaluate('Boolean(window.__guidesNodeExample?.fsrNode?.upscaler?.isReady)'))break;await delay(100);}
    report.afterFreeze = await state();
    if(report.afterFreeze.documentId!==report.initial.documentId)throw new Error('Suspension test reloaded the page instead of resuming it.');
    await capturePhase('after-freeze');
    report.instances = await client.evaluate(`(async () => {
        const api=window.__guidesNodeExample, renderer=api.renderer;
        const animationLoop = renderer.getAnimationLoop();
        await renderer.setAnimationLoop(null);
        const lib={UpscalePass:api.UpscalePass};
        const result=[], before=JSON.parse(JSON.stringify(window.__resourceAudit.counts));
        for(let cycle=0;cycle<${cycles};cycle++) {
            // The live linked node owns the renderer's singleton velocity matrix.
            const passes=Array.from({length:4},()=>new lib.UpscalePass(renderer,{gpuTiming:true,shareVelocityMatrix:false}));
            for(const p of passes)p.configure({displayWidth:320,displayHeight:240,ratio:2,path:'temporal'});
            await Promise.all(passes.map(p=>p.init()));
            for(let frame=0;frame<4;frame++)for(const p of passes)p.draw(api.scene,api.camera,1/60);
            for(const p of passes)p.dispose();
            await renderer.backend.device.queue.onSubmittedWorkDone();
            await new Promise(r=>setTimeout(r,50));
            result.push(JSON.parse(JSON.stringify(window.__resourceAudit.counts)));
        }
        await renderer.setAnimationLoop(animationLoop);
        return {before,afterEachCycle:result,
            activeDriverReady:api.fsrNode.upscaler.isReady, live:window.__resourceAudit.live()};
    })()`);
    report.initializationDiagnostics = await client.evaluate(`(async () => {
        const api=window.__guidesNodeExample, device=api.renderer.backend.device;
        const probe=new api.UpscalePass(api.renderer,{shareVelocityMatrix:false});
        let warnings=0, encoders=0;
        const warn=console.warn, create=device.createCommandEncoder;
        console.warn=(...args)=>{if(String(args[0]).includes('Initialization is asynchronous'))warnings++;warn(...args);};
        device.createCommandEncoder=function(...args){encoders++;return create.apply(this,args);};
        const errors=[];
        try {
            probe.configure({displayWidth:32,displayHeight:32,ratio:1,path:'bilinear'});
            for(let i=0;i<2;i++)try{probe.upscaler.dispatch({color:new api.THREE.Texture()},api.camera);}catch(e){errors.push({name:e.name,code:e.code,reason:e.reason});}
            const beforeReady=encoders;
            await probe.init();
            return {errors,warnings,encodersBeforeReady:beforeReady,readyAfterAwait:probe.upscaler.isReady};
        } finally {device.createCommandEncoder=create;console.warn=warn;probe.dispose();}
    })()`);
    if(report.initializationDiagnostics.warnings!==1 || report.initializationDiagnostics.encodersBeforeReady!==0 ||
        report.initializationDiagnostics.errors.some(e=>e.code!=='UPSCALER_NOT_READY'))throw new Error('Initialization misuse diagnostics failed.');
    await client.send('HeapProfiler.collectGarbage');
    report.afterInstances = await state();
    await capturePhase('after-instances');
    report.resizeStable = ['textures','buffers','queries'].every(kind=>report.checks.every(check=>check.resources[kind].live===report.initial.resources[kind].live));
    report.dprCorrect = report.checks.every(check=>check.rendererDpr===Math.min(check.dpr,2));
    report.instanceBufferRetention = { before:report.instances.before.buffers.live, first:report.instances.afterEachCycle[0].buffers.live, last:report.instances.afterEachCycle.at(-1).buffers.live };
    report.gpuAudit = await client.evaluate('window.__gpuAudit');
    const beforeHold = await state();
    await delay(holdSeconds*1000);
    report.hold = {seconds:holdSeconds,before:beforeHold,after:await state()};
    const screenshot=await client.send('Page.captureScreenshot',{format:'png'});
    await writeFile(join(output,'final.png'),Buffer.from(screenshot.data,'base64'));
    report.issues=client.events.filter(e=>e.method==='Runtime.exceptionThrown' ||
        (e.method==='Log.entryAdded' && e.params.entry.level==='error' && !e.params.entry.url?.endsWith('/favicon.ico') && !/WebSocket connection.*Back-Forward Cache/.test(e.params.entry.text)) ||
        (e.method==='Runtime.consoleAPICalled' && e.params.type==='error'));
    report.finalLive=await client.evaluate('window.__resourceAudit.live()');
    await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({cycles,initial:report.initial,final:report.checks.at(-1),issues:report.issues.length}));
    if(!report.resizeStable||!report.dprCorrect)throw new Error('Resize resources or DPR did not remain correct.');
    if(report.issues.length)throw new Error('Lifecycle run reported browser/GPU errors.');
} catch(error) {
    report.failure=String(error);
    if(client){report.gpuAudit=await client.evaluate('window.__gpuAudit').catch(()=>null);report.finalLive=await client.evaluate('window.__resourceAudit?.live()').catch(()=>null);} 
    if(client)report.events=client.events;
    await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));
    throw error;
} finally {
    await closeOwnedCdpBrowser(client);
    await stopChild(browser); await stopChild(server);
    await removeTempDirectory(profile);
}
