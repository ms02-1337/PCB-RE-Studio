import { it, expect, vi, afterEach } from 'vitest';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(),isTauri:vi.fn()}));
import { invoke, isTauri } from '@tauri-apps/api/core';
import { getAppInfo } from './app-info';
afterEach(()=>vi.resetAllMocks());
it('returns native metadata',async()=>{vi.mocked(isTauri).mockReturnValue(true);vi.mocked(invoke).mockResolvedValue({name:'PCB RE Studio',version:'0.1.0'});expect(await getAppInfo()).toEqual({name:'PCB RE Studio',version:'0.1.0'});expect(invoke).toHaveBeenCalledWith('app_info');});
it('normalizes native failures',async()=>{vi.mocked(isTauri).mockReturnValue(true);vi.mocked(invoke).mockRejectedValue('private');await expect(getAppInfo()).rejects.toThrow('Application information could not be loaded.');});
