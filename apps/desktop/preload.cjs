const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('olivia', {
  version: process.env.OLIVIA_VERSION || '0.3.0',
  platform: process.platform,
  desktop: true,
});
