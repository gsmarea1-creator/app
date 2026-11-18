const { app, BrowserWindow, ipcMain, screen, clipboard } = require('electron');
const WebSocket = require('ws');
const { mouse, keyboard, Point, Button, Key } = require('@nut-tree-fork/nut-js');const { uIOhook, UiohookKey } = require('uiohook-napi');
const fs = require('fs');
const path = require('path');
const os = require('os');

// استجابة فورية بدون أي تأخير (0ms Latency)
mouse.config.autoDelayMs = 0;
keyboard.config.autoDelayMs = 0;

let mainWindow;
let wss = null;
let wsClient = null;
let activeSocket = null;
let isRemoteActive = false;
let mouseWatcher = null;
let clipboardWatcher = null;
let hooksInitialized = false;
let lastClipboardText = '';

let macScreen = { width: 1440, height: 900 };
let macCursor = { x: 720, y: 450 };

// جدول تحويل الأزرار (مع ربط Ctrl بـ Command في الماك لسهولة الاختصارات)
const KEY_MAP = {
  [UiohookKey.A]: Key.A, [UiohookKey.B]: Key.B, [UiohookKey.C]: Key.C,
  [UiohookKey.D]: Key.D, [UiohookKey.E]: Key.E, [UiohookKey.F]: Key.F,
  [UiohookKey.G]: Key.G, [UiohookKey.H]: Key.H, [UiohookKey.I]: Key.I,
  [UiohookKey.J]: Key.J, [UiohookKey.K]: Key.K, [UiohookKey.L]: Key.L,
  [UiohookKey.M]: Key.M, [UiohookKey.N]: Key.N, [UiohookKey.O]: Key.O,
  [UiohookKey.P]: Key.P, [UiohookKey.Q]: Key.Q, [UiohookKey.R]: Key.R,
  [UiohookKey.S]: Key.S, [UiohookKey.T]: Key.T, [UiohookKey.U]: Key.U,
  [UiohookKey.V]: Key.V, [UiohookKey.W]: Key.W, [UiohookKey.X]: Key.X,
  [UiohookKey.Y]: Key.Y, [UiohookKey.Z]: Key.Z,
  [UiohookKey['0']]: Key.Num0, [UiohookKey['1']]: Key.Num1, [UiohookKey['2']]: Key.Num2,
  [UiohookKey['3']]: Key.Num3, [UiohookKey['4']]: Key.Num4, [UiohookKey['5']]: Key.Num5,
  [UiohookKey['6']]: Key.Num6, [UiohookKey['7']]: Key.Num7, [UiohookKey['8']]: Key.Num8,
  [UiohookKey['9']]: Key.Num9,
  [UiohookKey.Space]: Key.Space, [UiohookKey.Enter]: Key.Enter,
  [UiohookKey.Backspace]: Key.Backspace, [UiohookKey.Tab]: Key.Tab,
  [UiohookKey.Escape]: Key.Escape,
  [UiohookKey.Shift]: Key.LeftShift, [UiohookKey.ShiftRight]: Key.RightShift,
  // تحويل Ctrl في الويندوز لـ Command (LeftSuper) في الماك باش يخدم Copy/Paste طبيعي
  [UiohookKey.Ctrl]: Key.LeftSuper, [UiohookKey.CtrlRight]: Key.RightSuper,
  [UiohookKey.Alt]: Key.LeftAlt, [UiohookKey.AltRight]: Key.RightAlt,
  [UiohookKey.Meta]: Key.LeftControl, [UiohookKey.MetaRight]: Key.RightControl,
  [UiohookKey.ArrowUp]: Key.Up, [UiohookKey.ArrowDown]: Key.Down,
  [UiohookKey.ArrowLeft]: Key.Left, [UiohookKey.ArrowRight]: Key.Right,
  [UiohookKey.Comma]: Key.Comma, [UiohookKey.Period]: Key.Period,
  [UiohookKey.Slash]: Key.Slash, [UiohookKey.Semicolon]: Key.Semicolon,
  [UiohookKey.Quote]: Key.Quote, [UiohookKey.BracketLeft]: Key.LeftBracket,
  [UiohookKey.BracketRight]: Key.RightBracket, [UiohookKey.Backslash]: Key.Backslash,
  [UiohookKey.Minus]: Key.Minus, [UiohookKey.Equal]: Key.Equal
};

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 940,
    height: 680,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0b0f19',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  mainWindow.loadFile('index.html');
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('local-ip', getLocalIP());
  });
}

app.whenReady().then(createWindow);

// حساب حدود شاشات الويندوز (كيتعامل مع 2 شاشات أو أكثر)
function getWindowsBounds() {
  const displays = screen.getAllDisplays();
  let minX = 0, maxX = 0, minY = 0, maxY = 0;
  displays.forEach(d => {
    if (d.bounds.x < minX) minX = d.bounds.x;
    if (d.bounds.x + d.bounds.width > maxX) maxX = d.bounds.x + d.bounds.width;
    if (d.bounds.y < minY) minY = d.bounds.y;
    if (d.bounds.y + d.bounds.height > maxY) maxY = d.bounds.y + d.bounds.height;
  });
  return { minX, maxX, minY, maxY };
}

// ==========================================
// 1. مراقبة ومزامنة الحافظة (Clipboard Sync)
// ==========================================
function startClipboardSync() {
  if (clipboardWatcher) clearInterval(clipboardWatcher);
  lastClipboardText = clipboard.readText();

  clipboardWatcher = setInterval(() => {
    if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN) return;
    const currentText = clipboard.readText();
    if (currentText && currentText !== lastClipboardText) {
      lastClipboardText = currentText;
      activeSocket.send(JSON.stringify({
        type: 'clipboard-sync',
        text: currentText
      }));
      mainWindow.webContents.send('log', '📋 Clipboard synced to remote device.');
    }
  }, 600);
}

// ==========================================
// 2. التقاط الكليكات، السكرول والكيبورد (Global Hooks)
// ==========================================
function setupGlobalHooks() {
  if (hooksInitialized) return;
  hooksInitialized = true;

  uIOhook.on('mousedown', (e) => {
    if (!isRemoteActive || !activeSocket || activeSocket.readyState !== WebSocket.OPEN) return;
    const btn = e.button === 1 ? 'left' : e.button === 2 ? 'right' : 'middle';
    activeSocket.send(JSON.stringify({ type: 'mousedown', button: btn }));
  });

  uIOhook.on('mouseup', (e) => {
    if (!isRemoteActive || !activeSocket || activeSocket.readyState !== WebSocket.OPEN) return;
    const btn = e.button === 1 ? 'left' : e.button === 2 ? 'right' : 'middle';
    activeSocket.send(JSON.stringify({ type: 'mouseup', button: btn }));
  });

  uIOhook.on('wheel', (e) => {
    if (!isRemoteActive || !activeSocket || activeSocket.readyState !== WebSocket.OPEN) return;
    activeSocket.send(JSON.stringify({ type: 'scroll', rotation: e.rotation }));
  });

  uIOhook.on('keydown', (e) => {
    // زر الأمان F12: كيرجع الماوس للويندوز فوراً
    if (e.keycode === UiohookKey.F12 && isRemoteActive) {
      isRemoteActive = false;
      mainWindow.webContents.send('active-screen', 'Windows');
      mainWindow.webContents.send('log', '⚡ F12 Pressed -> Returned control to Windows.');
      return;
    }

    if (!isRemoteActive || !activeSocket || activeSocket.readyState !== WebSocket.OPEN) return;
    const mappedKey = KEY_MAP[e.keycode];
    if (mappedKey !== undefined) {
      activeSocket.send(JSON.stringify({ type: 'keydown', key: mappedKey }));
    }
  });

  uIOhook.on('keyup', (e) => {
    if (!isRemoteActive || !activeSocket || activeSocket.readyState !== WebSocket.OPEN) return;
    const mappedKey = KEY_MAP[e.keycode];
    if (mappedKey !== undefined) {
      activeSocket.send(JSON.stringify({ type: 'keyup', key: mappedKey }));
    }
  });

  uIOhook.start();
}

// ==========================================
// 3. كود السيرفر (Windows Host)
// ==========================================
ipcMain.on('start-server', (event, port) => {
  if (wss) wss.close();
  wss = new WebSocket.Server({ port: Number(port), maxPayload: 500 * 1024 * 1024 }); // يدعم ملفات حتى 500MB

  setupGlobalHooks();
  startClipboardSync();

  wss.on('connection', (ws) => {
    activeSocket = ws;
    mainWindow.webContents.send('status-update', { connected: true, role: 'Server (Windows Master)' });

    ws.on('message', (data) => {
      const msg = JSON.parse(data);
      if (msg.type === 'mac-specs') {
        macScreen = { width: msg.width, height: msg.height };
        mainWindow.webContents.send('log', `💻 Mac Screen Detected: ${msg.width}x${msg.height}`);
      } else if (msg.type === 'clipboard-sync') {
        lastClipboardText = msg.text;
        clipboard.writeText(msg.text);
        mainWindow.webContents.send('log', '📋 Clipboard received from Mac.');
      } else if (msg.type === 'file-drop') {
        saveIncomingFile(msg);
      }
    });

    ws.on('close', () => {
      activeSocket = null;
      isRemoteActive = false;
      mainWindow.webContents.send('active-screen', 'Windows');
      mainWindow.webContents.send('status-update', { connected: false, role: 'Disconnected' });
    });
  });

  startMouseTracking();
  mainWindow.webContents.send('log', `🚀 Server running on IP ${getLocalIP()}:${port}`);
});

function startMouseTracking() {
  if (mouseWatcher) clearInterval(mouseWatcher);
  
  mouseWatcher = setInterval(async () => {
    if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN) return;

    const pos = await mouse.getPosition();
    const bounds = getWindowsBounds();
    const anchorX = Math.floor((bounds.minX + bounds.maxX) / 2);
    const anchorY = Math.floor((bounds.minY + bounds.maxY) / 2);

    if (!isRemoteActive) {
      // الانتقال للماك عند ملامسة أقصى اليسار ديال الشاشة الوسطى
      if (pos.x <= bounds.minX + 2) {
        isRemoteActive = true;
        macCursor.x = macScreen.width - 12;
        const relativeY = (pos.y - bounds.minY) / (bounds.maxY - bounds.minY || 1080);
        macCursor.y = Math.floor(relativeY * macScreen.height);

        await mouse.setPosition(new Point(anchorX, anchorY));
        activeSocket.send(JSON.stringify({ type: 'move', x: macCursor.x, y: macCursor.y }));
        mainWindow.webContents.send('active-screen', 'Mac');
      }
    } else {
      const dx = pos.x - anchorX;
      const dy = pos.y - anchorY;

      if (dx !== 0 || dy !== 0) {
        macCursor.x += dx;
        macCursor.y += dy;

        if (macCursor.x < 0) macCursor.x = 0;
        if (macCursor.y < 0) macCursor.y = 0;
        if (macCursor.y > macScreen.height) macCursor.y = macScreen.height;

        // الرجوع لشاشة الويندوز الوسطى عند ملامسة يمين شاشة الماك
        if (macCursor.x >= macScreen.width) {
          isRemoteActive = false;
          const winY = Math.floor((macCursor.y / macScreen.height) * (bounds.maxY - bounds.minY)) + bounds.minY;
          await mouse.setPosition(new Point(bounds.minX + 15, winY));
          mainWindow.webContents.send('active-screen', 'Windows');
        } else {
          await mouse.setPosition(new Point(anchorX, anchorY));
          activeSocket.send(JSON.stringify({ type: 'move', x: macCursor.x, y: macCursor.y }));
        }
      }
    }
  }, 8); // ~120Hz Polling
}

// ==========================================
// 4. كود الكلاينت (Mac Receiver)
// ==========================================
ipcMain.on('start-client', (event, { ip, port }) => {
  if (wsClient) wsClient.close();
  wsClient = new WebSocket(`ws://${ip}:${port}`, { maxPayload: 500 * 1024 * 1024 });

  wsClient.on('open', () => {
    activeSocket = wsClient;
    startClipboardSync();

    const primaryDisplay = screen.getPrimaryDisplay();
    wsClient.send(JSON.stringify({
      type: 'mac-specs',
      width: primaryDisplay.size.width,
      height: primaryDisplay.size.height
    }));
    mainWindow.webContents.send('status-update', { connected: true, role: 'Client (Mac Active)' });
    mainWindow.webContents.send('log', `✅ Connected to Windows Host at ${ip}:${port}`);
  });

  wsClient.on('message', async (data) => {
    const msg = JSON.parse(data);
    try {
      switch (msg.type) {
        case 'move':
          await mouse.setPosition(new Point(msg.x, msg.y));
          break;
        case 'mousedown':
          await mouse.pressButton(getNutButton(msg.button));
          break;
        case 'mouseup':
          await mouse.releaseButton(getNutButton(msg.button));
          break;
        case 'scroll':
          if (msg.rotation > 0) await mouse.scrollDown(Math.abs(msg.rotation) * 40);
          else await mouse.scrollUp(Math.abs(msg.rotation) * 40);
          break;
        case 'keydown':
          await keyboard.pressKey(msg.key);
          break;
        case 'keyup':
          await keyboard.releaseKey(msg.key);
          break;
        case 'clipboard-sync':
          lastClipboardText = msg.text;
          clipboard.writeText(msg.text);
          mainWindow.webContents.send('log', '📋 Clipboard synced from Windows.');
          break;
        case 'file-drop':
          saveIncomingFile(msg);
          break;
      }
    } catch (err) {}
  });

  wsClient.on('close', () => {
    activeSocket = null;
    mainWindow.webContents.send('status-update', { connected: false, role: 'Disconnected' });
    mainWindow.webContents.send('log', '❌ Connection closed.');
  });
});

function getNutButton(btnName) {
  if (btnName === 'right') return Button.RIGHT;
  if (btnName === 'middle') return Button.MIDDLE;
  return Button.LEFT;
}

// ==========================================
// 5. إرسال واستقبال الملفات (Drag & Drop)
// ==========================================
ipcMain.on('send-file', (event, filePath) => {
  if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN) {
    mainWindow.webContents.send('log', '⚠️ Error: Connect both devices before dropping files.');
    return;
  }
  const fileName = path.basename(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) return mainWindow.webContents.send('log', `❌ File Error: ${err.message}`);
    activeSocket.send(JSON.stringify({
      type: 'file-drop',
      name: fileName,
      content: data.toString('base64')
    }));
    mainWindow.webContents.send('log', `📤 File sent: ${fileName}`);
  });
});

function saveIncomingFile(msg) {
  const desktopDir = path.join(os.homedir(), 'Desktop');
  const savePath = path.join(desktopDir, msg.name);
  fs.writeFile(savePath, Buffer.from(msg.content, 'base64'), (err) => {
    if (!err) {
      mainWindow.webContents.send('log', `📥 File saved to Desktop: ${msg.name}`);
    }
  });
}