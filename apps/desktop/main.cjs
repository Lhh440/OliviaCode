const { app, BrowserWindow, shell, nativeTheme } = require('electron');
const path = require('node:path');

const isDev = process.env.OLIVIA_DEV === '1';
const devUrl = process.env.OLIVIA_DEV_URL || 'http://127.0.0.1:5273';

function createWindow() {
  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: '#fbfbfc',
    autoHideMenuBar: true,
    title: 'OliviaCode',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    win.loadURL(devUrl);
  } else {
    win.loadFile(path.join(__dirname, '..', 'web', 'dist', 'index.html'));
  }
}

nativeTheme.themeSource = 'light';

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
