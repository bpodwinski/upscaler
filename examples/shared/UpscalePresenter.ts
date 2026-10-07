// UpscalePresenter has graduated into the library as the public `UpscalePass`
// drop-in. This shim keeps the examples' imports working; new code should
// import `UpscalePass` from '@ruxelion/upscaler' directly.
export { UpscalePass as UpscalePresenter, type UpscalePassConfig as PresenterConfig } from '@ruxelion/upscaler';
