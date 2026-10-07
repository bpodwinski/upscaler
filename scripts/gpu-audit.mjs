/** Copies WebIDL getter fields; JSON.stringify(GPUAdapterInfo) otherwise yields {}. */
export function adapterInfoRecord(info) {
    if (!info) return null;
    return { vendor: info.vendor, architecture: info.architecture,
        device: info.device, description: info.description };
}

/** Installs only adapter/device observation, outside the measured frame loop. */
function installGpuAudit(copyInfo, options) {
    const audit = window.__gpuAudit = { options, requests: [], devices: [] };
    if (!navigator.gpu || !window.GPUAdapter) return;
    const requestAdapter = navigator.gpu.requestAdapter;
    navigator.gpu.requestAdapter = async function(descriptor = {}) {
        const effective = options.powerPreference
            ? { ...descriptor, powerPreference: options.powerPreference } : descriptor;
        const adapter = await requestAdapter.call(this, effective);
        const info = copyInfo(adapter?.info);
        audit.requests.push({ requested: descriptor, effective, info });
        if (options.expectedVendor && info?.vendor?.toLowerCase() !== options.expectedVendor) {
            throw new Error('Expected GPU vendor ' + options.expectedVendor +
                ', received ' + (info?.vendor || 'unavailable') + '. Power preference is a hint.');
        }
        return adapter;
    };
    const requestDevice = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function(descriptor = {}) {
        const effective = options.withoutTimestamps
            ? { ...descriptor, requiredFeatures: [...(descriptor.requiredFeatures ?? [])]
                .filter(feature => feature !== 'timestamp-query') } : descriptor;
        const device = await requestDevice.call(this, effective);
        const record = { info: copyInfo(this.info), features: [...device.features].sort(),
            limits: { maxTextureDimension2D: device.limits.maxTextureDimension2D,
                maxComputeInvocationsPerWorkgroup: device.limits.maxComputeInvocationsPerWorkgroup },
            lost: null };
        audit.devices.push(record);
        void device.lost.then(info => { record.lost = { reason: info.reason, message: info.message }; });
        return device;
    };
}

/**
 * Builds a pre-navigation CDP script. Selection is checked against the actual
 * returned adapter because Windows hybrid-GPU preferences are advisory.
 */
export function gpuAuditSource(cli = {}) {
    const powerPreference = cli['power-preference'];
    if (powerPreference !== undefined && !['high-performance', 'low-power'].includes(powerPreference))
        throw new Error('--power-preference requires high-performance or low-power.');
    const vendor = cli['expected-vendor'];
    if (vendor !== undefined && (typeof vendor !== 'string' || !vendor.trim()))
        throw new Error('--expected-vendor requires a nonempty vendor name.');
    const options = { powerPreference: powerPreference ?? null,
        expectedVendor: vendor?.trim().toLowerCase() ?? null,
        withoutTimestamps: cli['without-timestamps'] === true };
    return '(' + installGpuAudit.toString() + ')(' + adapterInfoRecord.toString() +
        ',' + JSON.stringify(options) + ');';
}
