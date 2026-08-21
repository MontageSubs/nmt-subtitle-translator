import { registerSW } from "virtual:pwa-register";

type ApplyUpdate = (reloadPage?: boolean) => Promise<void>;

let applyUpdate: ApplyUpdate = async () => {};

export function initServiceWorker(callbacks: { onNeedRefresh: () => void; onOfflineReady: () => void }): void {
  applyUpdate = registerSW({
    onNeedRefresh: callbacks.onNeedRefresh,
    onOfflineReady: callbacks.onOfflineReady,
  });
}

export function applyServiceWorkerUpdate(): void {
  void applyUpdate(true);
}
