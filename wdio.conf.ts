import path from 'node:path';
export const config = { runner:'local',specs:['./tests/desktop/**/*.e2e.ts'],maxInstances:1,framework:'mocha',reporters:['spec'],capabilities:[{browserName:'tauri'}],services:[['tauri',{appBinaryPath:path.resolve('src-tauri/target/debug/pcb-re-studio'+(process.platform==='win32'?'.exe':'')),driverProvider:'embedded'}]],mochaOpts:{timeout:60000}};
