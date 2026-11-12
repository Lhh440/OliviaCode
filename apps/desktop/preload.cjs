const { contextBridge, ipcRenderer } = require('electron');

let env = { baseUrl: '', apiKey: '', model: '' };
try {
  env = ipcRenderer.sendSync('olivia:env') || env;
} catch {
  // 截图等非常规宿主没有注册 IPC，退回空配置
}

contextBridge.exposeInMainWorld('olivia', {
  version: process.env.OLIVIA_VERSION || '0.3.0',
  platform: process.platform,
  desktop: true,
  env,
});
