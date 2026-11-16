import { invoke, isTauri } from '@tauri-apps/api/core';
export interface AppInfo { name: string; version: string }
export async function getAppInfo(): Promise<AppInfo> {
 if (!isTauri()) return {name:'PCB RE Studio',version:'Browser preview'};
 try { return await invoke<AppInfo>('app_info'); } catch { throw new Error('Application information could not be loaded.'); }
}
