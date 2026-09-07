const { app, BrowserWindow, ipcMain, shell, dialog, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const si = require('systeminformation');

// Явно задаём имя приложения и AppUserModelID до создания окна - иначе
// Windows (диспетчер задач, уведомления, закрепление на панели задач)
// показывает процесс как общий "Electron" вместо "fyLight". Для полноценной
// замены иконки/имени процесса в диспетчере задач всё равно нужна сборка
// через electron-builder (npm run dist) - именно она даёт fyLight.exe со
// своей иконкой (build/icon.ico, уже подключена в package.json).
app.setName('fyLight');
if (process.platform === 'win32') {
  app.setAppUserModelId('com.fylight.optimizer');
}

// =====================================================================
// ССЫЛКИ НА СБОРКИ (fylight://build/<код>)
// Регистрируем свой протокол, чтобы ссылку на публичную сборку можно было
// прислать в Telegram/Discord и т.п. - клик по ней открывает fyLight (или
// переключает на уже открытое окно) и показывает предпросмотр импорта.
// Для portable-сборки регистрация обновляется при каждом запуске из
// текущего пути exe, так что сохраняется даже если .exe переносили.
// =====================================================================
const BUILD_LINK_SCHEME = 'fylight';
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(BUILD_LINK_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient(BUILD_LINK_SCHEME);
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

let pendingBuildLinkCode = null;
function handleBuildLink(url) {
  try {
    const withoutScheme = String(url).replace(`${BUILD_LINK_SCHEME}://`, '');
    const [kind, code] = withoutScheme.split('/');
    if (kind !== 'build' || !code) return;
    if (mainWindow && !mainWindow.webContents.isLoading()) {
      mainWindow.webContents.send('builds:importRequest', code);
      mainWindow.show();
      mainWindow.focus();
    } else {
      pendingBuildLinkCode = code;
    }
  } catch {
    // некорректная ссылка - просто игнорируем
  }
}

app.on('second-instance', (_event, argv) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  const link = argv.find((a) => a.startsWith(`${BUILD_LINK_SCHEME}://`));
  if (link) handleBuildLink(link);
});

app.on('open-url', (event, url) => {
  event.preventDefault();
  handleBuildLink(url);
});

let mainWindow = null;
const appIconPath = path.join(__dirname, 'build', 'icon.ico');

const settingsPath = path.join(app.getPath('userData'), 'settings.json');
const defaultSettings = {
  theme: 'system',
  language: 'ru',
  accentColor: '#5e63ff',
  backgroundStyle: 'solid',
  particleDensity: 50,
  cardOpacity: 50,
  reduceMotion: false,
  backgroundImagePath: null,
  isFirstLaunch: true,
  snowEnabled: false,
  // Показана ли уже карточка первого запуска (см. runFirstInstallFlow) -
  // отдельный флаг от isFirstLaunch, который отвечает только за длину
  // прогрева обычного сплэша, а не за показ окна-"установщика".
  installerShown: false,
};

// =====================================================================
// ЛОГИ И ДАННЫЕ (создаются при первом запуске)
// =====================================================================
// По просьбе пользователя создаём отдельную папку для логов и данных.
// Используем %PROGRAMDATA%, так как это стандартное место для общих данных
// приложений в Windows, которое не требует прав администратора для записи
// в созданную подпапку (в отличие от Program Files).
const DATA_ROOT = process.platform === 'win32'
  ? path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'fyLight')
  : path.join(app.getPath('userData'), 'data');

const LOG_DIR = path.join(DATA_ROOT, 'logs');

function ensureDataDirectories() {
  try {
    if (!fs.existsSync(DATA_ROOT)) fs.mkdirSync(DATA_ROOT, { recursive: true });
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch (e) {
    console.error('Failed to create data directories:', e);
  }
}

// Вызываем сразу при старте
ensureDataDirectories();

// Пишет строки в файл-лог вместо того, чтобы показывать их прямо в
// интерфейсе - так экран не захламляется, а полная история всё равно
// доступна на диске (кнопка "Открыть папку с логами" в интерфейсе).
function writeLogFile(fileName, lines) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const stamp = new Date().toISOString();
    const body = `\n===== ${stamp} =====\n${lines.join('\n')}\n`;
    fs.appendFileSync(path.join(LOG_DIR, fileName), body, 'utf-8');
  } catch {
    // не удалось записать на диск - не критично, само применение уже прошло
  }
}

ipcMain.handle('logs:openFolder', async () => {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const err = await shell.openPath(LOG_DIR);
    return { ok: !err, message: err || 'Открыто' };
  } catch {
    return { ok: false, message: 'Не удалось открыть папку с логами' };
  }
});

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    return { ...defaultSettings, ...JSON.parse(raw) };
  } catch {
    return { ...defaultSettings };
  }
}

function saveSettings(partial) {
  const merged = { ...loadSettings(), ...partial };
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2), 'utf-8');
  } catch {
    // если не удалось сохранить на диск - просто отдаём объект в памяти
  }
  return merged;
}

// =====================================================================
// ЯРЛЫКИ (Desktop и Start Menu)
// =====================================================================
// Возвращает { desktopOk, startMenuOk } - проверяем РЕАЛЬНОЕ наличие
// файлов после запуска PowerShell, а не просто "отправили команду и
// забыли", чтобы можно было честно показать статус и записать в лог,
// если что-то не создалось (например, из-за политики выполнения
// PowerShell на конкретном компьютере).
async function createShortcuts() {
  if (process.platform !== 'win32') {
    return { desktopOk: false, startMenuOk: false, skipped: true };
  }

  // ВАЖНО: process.execPath для portable-сборки electron-builder указывает
  // не на тот .exe, который запустил пользователь (например, с рабочего
  // стола или из Downloads), а на КОПИЮ, распакованную во временную папку
  // (%LOCALAPPDATA%\Temp\...). Эта временная папка удаляется после
  // закрытия приложения, поэтому ярлык, созданный на process.execPath,
  // либо не создаётся из-за отсутствия прав на Temp-путь, либо (что чаще)
  // создаётся, но ссылается на уже несуществующий файл при следующем
  // запуске - portable-стаб electron-builder кладёт РЕАЛЬНЫЙ путь к exe в
  // переменную окружения PORTABLE_EXECUTABLE_FILE, и использовать нужно
  // именно её.
  const exePath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  const exeDir = path.dirname(exePath);
  // ВАЖНО: НЕ собирать путь к рабочему столу как os.homedir() + 'Desktop' -
  // у части пользователей (чаще всего из-за OneDrive "Резервное копирование
  // папок") реальный рабочий стол физически лежит по другому пути, например
  // C:\Users\<имя>\OneDrive\Desktop, а C:\Users\<имя>\Desktop может вообще
  // не существовать на диске. Именно это ловилось в логах как
  // DirectoryNotFoundException при $Shortcut.Save(). app.getPath('desktop')
  // берёт реальный путь из системных Known Folders (учитывает такой
  // редирект), поэтому используем его.
  const desktopDir = app.getPath('desktop');
  const desktopPath = path.join(desktopDir, 'fyLight.lnk');
  const startMenuDir = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const startMenuPath = path.join(startMenuDir, 'fyLight.lnk');

  // Раньше здесь была проверка "оба ярлыка уже существуют - выходим", но
  // из-за бага выше это означало, что если ярлык уже был создан (пусть
  // даже битый, указывающий на удалённый Temp-путь), он никогда не
  // перезаписывался повторно правильным путём. Теперь дополнительно
  // проверяем реальную цель существующих .lnk через PowerShell и
  // пересоздаём ярлык, если он битый или указывает не туда.
  async function targetMatches(lnkPath) {
    if (!fs.existsSync(lnkPath)) return false;
    const r = await runPowerShell(`
      $sc = (New-Object -ComObject WScript.Shell).CreateShortcut(${psQuoteOuter(lnkPath)})
      Write-Output $sc.TargetPath
    `);
    const target = (r.stdout || '').trim();
    return r.ok && target.toLowerCase() === exePath.toLowerCase() && fs.existsSync(target);
  }

  function psQuoteOuter(s) {
    return `"${String(s).replace(/"/g, '""')}"`;
  }

  const desktopAlready = await targetMatches(desktopPath);
  const startMenuAlready = await targetMatches(startMenuPath);

  // Если оба ярлыка уже есть и указывают на актуальный exe, не пересоздаём их
  if (desktopAlready && startMenuAlready) {
    return { desktopOk: true, startMenuOk: true };
  }

  // В PowerShell (двойные кавычки) обратный слэш НЕ является управляющим
  // символом - экранировать его как в JS/C (\\) не нужно и даже вредно,
  // так делать не нужно. Просто подставляем пути как есть, экранируя
  // только двойные кавычки на случай нестандартных путей пользователя.
  const psQuote = (s) => `"${String(s).replace(/"/g, '""')}"`;

  // Пересоздаём КОНКРЕТНО те ярлыки, которые отсутствуют или битые (решение
  // принято в JS через targetMatches выше) - Test-Path внутри PowerShell
  // больше не используется для этого решения, т.к. "файл .lnk существует"
  // не значит "указывает на актуальный exe".
  const createLnkScript = `
    $ErrorActionPreference = 'Stop'
    $WshShell = New-Object -ComObject WScript.Shell

    New-Item -ItemType Directory -Force -Path ${psQuote(startMenuDir)} | Out-Null
    New-Item -ItemType Directory -Force -Path ${psQuote(desktopDir)} | Out-Null

    ${!desktopAlready ? `
    $Shortcut = $WshShell.CreateShortcut(${psQuote(desktopPath)})
    $Shortcut.TargetPath = ${psQuote(exePath)}
    $Shortcut.WorkingDirectory = ${psQuote(exeDir)}
    $Shortcut.IconLocation = ${psQuote(exePath)}
    $Shortcut.Save()
    ` : ''}

    ${!startMenuAlready ? `
    $Shortcut = $WshShell.CreateShortcut(${psQuote(startMenuPath)})
    $Shortcut.TargetPath = ${psQuote(exePath)}
    $Shortcut.WorkingDirectory = ${psQuote(exeDir)}
    $Shortcut.IconLocation = ${psQuote(exePath)}
    $Shortcut.Save()
    ` : ''}
  `;

  const result = await runPowerShell(createLnkScript);

  const desktopOk = fs.existsSync(desktopPath);
  const startMenuOk = fs.existsSync(startMenuPath);

  writeLogFile('shortcuts.log', [
    `TargetPath: ${exePath}`,
    `Desktop: ${desktopPath} -> ${desktopOk ? 'OK' : 'НЕ создан'}`,
    `Start Menu: ${startMenuPath} -> ${startMenuOk ? 'OK' : 'НЕ создан'}`,
    result.ok ? 'PowerShell: OK' : `PowerShell error: ${result.stderr || 'неизвестная ошибка'}`,
  ]);

  return { desktopOk, startMenuOk };
}

// Общие обработчики окна (F11, полноэкранный режим, сброс ссылки на
// mainWindow при закрытии) - вынесены отдельно, т.к. теперь окно может
// "родиться" как маленькая карточка первого запуска (см. runFirstInstallFlow)
// и уже потом стать обычным окном приложения, а не только создаваться
// сразу как обычное окно через createWindow().
function attachMainWindowBehaviors(win) {
  win.on('closed', () => {
    mainWindow = null;
  });

  // ---------- F11: переключение полноэкранного режима ----------
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      event.preventDefault();
      win.setFullScreen(!win.isFullScreen());
    }
  });

  win.on('enter-full-screen', () => {
    win?.webContents.send('window:fullscreen-state', true);
  });
  win.on('leave-full-screen', () => {
    win?.webContents.send('window:fullscreen-state', false);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 680,
    minWidth: 860,
    minHeight: 560,
    frame: false,
    backgroundColor: '#0a0c10', // чтобы не было белой вспышки при старте
    show: false,
    icon: appIconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (pendingBuildLinkCode) {
      mainWindow.webContents.send('builds:importRequest', pendingBuildLinkCode);
      pendingBuildLinkCode = null;
    }
  });

  attachMainWindowBehaviors(mainWindow);
}

// =====================================================================
// ПЕРВЫЙ ЗАПУСК: маленькое окно-"установщик" (как у Discord)
// =====================================================================
// Показывается ОДИН раз - только когда приложение запускают первый раз
// на этом компьютере (settings.installerShown === false). Окно нельзя
// подвинуть и нельзя изменить в размерах вручную - на нём только молния
// (та же анимация, что и на обычном сплэше) и статус того, что сейчас
// делается: проверка обновлений, создание папки данных/логов, создание
// ярлыков. Когда всё готово, окно плавно "расширяется" во все стороны до
// обычного размера приложения, и уже после этого в него загружается
// index.html (обычный сплэш с прогрузкой всех данных, как и раньше).
function sendInstallerStatus(win, payload) {
  if (win && !win.isDestroyed()) win.webContents.send('installer:status', payload);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Плавно анимирует bounds окна из одного прямоугольника в другой -
// используется, чтобы карточка первого запуска "выросла" в обычное окно
// приложения (влево/вправо/вверх/вниз одновременно, т.к. окно остаётся
// отцентрированным на экране на всём протяжении анимации).
function animateWindowBounds(win, fromBounds, toBounds, duration = 700) {
  return new Promise((resolve) => {
    if (win.isDestroyed()) return resolve();
    const start = Date.now();
    const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

    const step = () => {
      if (win.isDestroyed()) return resolve();
      const elapsed = Date.now() - start;
      const t = Math.min(1, elapsed / duration);
      const e = easeOutCubic(t);
      win.setBounds({
        x: Math.round(fromBounds.x + (toBounds.x - fromBounds.x) * e),
        y: Math.round(fromBounds.y + (toBounds.y - fromBounds.y) * e),
        width: Math.round(fromBounds.width + (toBounds.width - fromBounds.width) * e),
        height: Math.round(fromBounds.height + (toBounds.height - fromBounds.height) * e),
      });
      if (t < 1) {
        setTimeout(step, 16);
      } else {
        resolve();
      }
    };
    step();
  });
}

async function runFirstInstallFlow() {
  // Размер окна равен размеру самой карточки (см. .card в installer.html) -
  // раньше окно было больше карточки, и вокруг неё была видна лишняя
  // чёрная рамка (фон окна, не закрытый карточкой). Теперь их размеры
  // совпадают 1:1, так что окно = карточка, без зазоров по краям.
  const cardWidth = 320;
  const cardHeight = 380;
  const finalWidth = 1040;
  const finalHeight = 680;

  const display = screen.getPrimaryDisplay();
  const startX = Math.round(display.workArea.x + (display.workArea.width - cardWidth) / 2);
  const startY = Math.round(display.workArea.y + (display.workArea.height - cardHeight) / 2);

  const win = new BrowserWindow({
    width: cardWidth,
    height: cardHeight,
    x: startX,
    y: startY,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    // Не делаем окно transparent: true - оно должно быть залито тем же
    // фоновым цветом, что и обычное окно приложения (#0a0c10), иначе при
    // росте окна во время анимации будет видно "дыры" до рабочего стола
    // там, где контент ещё не дорисовался, и переход в index.html будет
    // с рассинхронизированной вспышкой.
    backgroundColor: '#0a0c10',
    show: false,
    icon: appIconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow = win;

  win.loadFile(path.join(__dirname, 'src', 'installer.html'));

  await new Promise((resolve) => {
    win.once('ready-to-show', () => {
      win.show();
      resolve();
    });
  });

  // ---------- Шаг 1: проверка обновлений ----------
  await wait(400);
  sendInstallerStatus(win, { step: 'update', text: 'Проверка обновлений…' });
  await wait(1100);
  let updateInfo = { updateAvailable: false };
  try {
    updateInfo = await checkForUpdates(false);
  } catch {
    // не критично для первого запуска - продолжаем в любом случае
  }
  sendInstallerStatus(win, {
    step: 'update-done',
    text: updateInfo.updateAvailable
      ? `Доступна новая версия ${updateInfo.latest}`
      : 'Установлена последняя версия',
  });

  // ---------- Шаг 2: папка данных и логов ----------
  await wait(1100);
  sendInstallerStatus(win, { step: 'folders', text: 'Подготовка папки данных…' });
  await wait(500);
  ensureDataDirectories();
  const dataFolderOk = fs.existsSync(DATA_ROOT) && fs.existsSync(LOG_DIR);
  writeLogFile('install.log', [
    `Папка данных: ${DATA_ROOT}`,
    `Создана: ${dataFolderOk ? 'да' : 'нет'}`,
  ]);
  sendInstallerStatus(win, {
    step: 'folders-done',
    text: dataFolderOk ? 'Папка данных готова' : 'Не удалось создать папку данных',
    ok: dataFolderOk,
  });

  // ---------- Шаг 3: ярлыки на рабочем столе и в меню «Пуск» ----------
  await wait(1100);
  sendInstallerStatus(win, { step: 'shortcuts', text: 'Создание ярлыков…' });
  let shortcutsResult = { desktopOk: false, startMenuOk: false };
  try {
    shortcutsResult = await createShortcuts();
  } catch {
    // не критично - приложение всё равно можно будет открыть вручную
  }
  await wait(700);
  const shortcutsOk = shortcutsResult.desktopOk && shortcutsResult.startMenuOk;
  sendInstallerStatus(win, {
    step: 'shortcuts-done',
    text: shortcutsOk ? 'Ярлыки созданы' : 'Ярлыки: не всё удалось создать',
    ok: shortcutsOk,
  });

  // ---------- Шаг 4: сбор данных о железе (пригодятся сразу в приложении,
  // чтобы главный экран не ждал их отдельно после открытия) ----------
  await wait(1100);
  sendInstallerStatus(win, { step: 'hardware', text: 'Определение конфигурации ПК…' });
  try {
    await getStaticInfo();
  } catch {
    // не критично - обычный экран запросит эти данные ещё раз сам
  }
  await wait(1100);

  sendInstallerStatus(win, { step: 'done', text: 'Готово' });
  await wait(900);

  // ---------- Анимация: карточка "расширяется" во все стороны ----------
  // Комментарий к самой логике - см. блок ниже (EXPAND_MS): окно растёт,
  // а карточка плавно тает синхронно с этим ростом.
  // ---------- Анимация: окно растёт, а карточка тает по ходу этого роста ----------
  // 'expand' уходит в рендерер вместе с длительностью - CSS-переход
  // opacity там ставится на ТОЧНО ТАКОЕ ЖЕ время, что и анимация bounds
  // ниже, и обе стартуют в один момент, поэтому карточка не "рвётся"
  // раньше или позже конца роста окна, а тает плавно вместе с ним.
  const EXPAND_MS = 900;
  sendInstallerStatus(win, { step: 'expand', durationMs: EXPAND_MS });
  await wait(150);

  const fromBounds = win.getBounds();
  const toBounds = {
    x: Math.round(display.workArea.x + (display.workArea.width - finalWidth) / 2),
    y: Math.round(display.workArea.y + (display.workArea.height - finalHeight) / 2),
    width: finalWidth,
    height: finalHeight,
  };

  win.setResizable(true);
  await animateWindowBounds(win, fromBounds, toBounds, EXPAND_MS);

  // Возвращаем окну обычное поведение приложения
  win.setMinimumSize(860, 560);
  win.setMovable(true);
  win.setMaximizable(true);
  win.setFullScreenable(true);

  attachMainWindowBehaviors(win);

  // К этому моменту карточка уже полностью растаяла (её CSS-переход занял
  // ровно EXPAND_MS, столько же, сколько мы только что ждали в
  // animateWindowBounds), так что подмена страницы происходит без рывка.
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
}

app.whenReady().then(async () => {
  const settings = loadSettings();

  if (!settings.installerShown) {
    // Первый запуск на этом компьютере: сначала показываем маленькую
    // карточку-"установщик" (ярлыки создаются внутри неё), и только
    // после того как она "расширится", в то же окно грузится обычный
    // интерфейс со своим сплэшем.
    await runFirstInstallFlow();
    saveSettings({ installerShown: true });
  } else {
    createShortcuts().catch(() => {});
    createWindow();
  }

  // Холодный запуск по ссылке fylight://build/... (Windows передаёт её
  // как обычный аргумент командной строки, если приложение ещё не было
  // открыто) - second-instance выше покрывает случай, когда оно уже было.
  const initialBuildLink = process.argv.find((a) => a.startsWith(`${BUILD_LINK_SCHEME}://`));
  if (initialBuildLink) handleBuildLink(initialBuildLink);

  // Имитация долгого первого запуска (прогрев данных на обычном сплэше)
  if (settings.isFirstLaunch) {
    saveSettings({ isFirstLaunch: false });
  }

  // Проверка обновлений сразу при старте (для отображения в сплэше).
  // Если это первый запуск, апдейт уже проверялся внутри карточки
  // установки - здесь не дублируем запрос второй раз.
  if (settings.installerShown) {
    checkForUpdates().catch(() => {});
  }

  // Раньше проверка обновлений выполнялась только один раз при старте
  // приложения - если пользователь не перезапускал fyLight неделями, он
  // никогда не узнавал о новой версии, пока не закроет и не откроет
  // приложение заново. Теперь дополнительно перепроверяем периодически,
  // пока приложение открыто, и рендерер (index.html) покажет тот же оверлей
  // 'available', даже если пользователь ничего не перезапускал - слушатель
  // window.updaterAPI.onStatus уже подписан и сработает в любой момент.
  const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000; // раз в 30 минут
  setInterval(() => {
    // Не дёргаем проверку, если сейчас уже идёт скачивание/установка
    // предыдущего обновления - checkForUpdates(false) сам по себе не
    // запускает скачивание, так что достаточно просто не спамить, пока
    // окно закрыто (mainWindow === null, например, в трее).
    if (!mainWindow || mainWindow.isDestroyed()) return;
    checkForUpdates(false).catch(() => {});
  }, UPDATE_CHECK_INTERVAL_MS);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Управление окном из рендерера (кастомный тайтлбар, т.к. frame: false)
ipcMain.on('window:minimize', () => {
  mainWindow?.minimize();
});

ipcMain.on('window:close', () => {
  mainWindow?.close();
});

ipcMain.on('window:toggleFullscreen', () => {
  if (!mainWindow) return;
  mainWindow.setFullScreen(!mainWindow.isFullScreen());
});

ipcMain.handle('window:isFullscreen', () => mainWindow?.isFullScreen() ?? false);

// ---------- Настройки (язык / тема / автозапуск / фон) ----------

ipcMain.handle('settings:get', () => loadSettings());

ipcMain.handle('settings:set', (_event, partial) => saveSettings(partial || {}));

ipcMain.handle('settings:getAutoLaunch', () => {
  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
});

ipcMain.handle('settings:setAutoLaunch', (_event, enabled) => {
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled });
    return true;
  } catch {
    return false;
  }
});

// ---------- Свой фон (PNG) ----------
// Пользователь выбирает файл через системный диалог -> копируем его в
// userData, чтобы приложение не зависело от исходного расположения файла,
// и отдаём путь рендереру (используется как file:// в CSS).
ipcMain.handle('background:choosePng', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Выберите изображение фона',
    filters: [{ name: 'PNG изображения', extensions: ['png'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths[0]) return null;

  const destDir = path.join(app.getPath('userData'), 'backgrounds');
  const dest = path.join(destDir, 'custom-bg.png');
  try {
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(result.filePaths[0], dest);
    saveSettings({ backgroundImagePath: dest });
    return dest;
  } catch {
    return null;
  }
});

ipcMain.handle('background:clearPng', () => {
  saveSettings({ backgroundImagePath: null });
  return true;
});

// ---------- Внешние ссылки (соцсети: GitHub / Telegram) ----------
const ALLOWED_EXTERNAL_HOSTS = ['github.com', 'www.github.com', 't.me', 'telegram.me'];

ipcMain.on('links:open', (_event, url) => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' && ALLOWED_EXTERNAL_HOSTS.includes(parsed.hostname)) {
      shell.openExternal(url);
    }
  } catch {
    // некорректный URL - просто игнорируем
  }
});

// ---------- Информация о системе (CPU / GPU / RAM / накопитель) ----------

let staticInfo = null;
let lastCpuTicks = null;
let cachedCpuLoad = 0;

function getCpuLoad() {
  const cpus = os.cpus();
  let user = 0, nice = 0, sys = 0, idle = 0, irq = 0;
  for (const cpu of cpus) {
    user += cpu.times.user;
    nice += cpu.times.nice;
    sys += cpu.times.sys;
    idle += cpu.times.idle;
    irq += cpu.times.irq;
  }
  const total = user + nice + sys + idle + irq;

  if (lastCpuTicks) {
    const diffTotal = total - lastCpuTicks.total;
    const diffIdle = idle - lastCpuTicks.idle;
    if (diffTotal > 0) {
      cachedCpuLoad = Math.round(100 * (1 - diffIdle / diffTotal));
    }
  }

  lastCpuTicks = { total, idle };
  return cachedCpuLoad;
}

getCpuLoad();

async function getStaticInfo() {
  if (staticInfo) return staticInfo;

  try {
    const [cpu, memLayout, graphics, diskLayout] = await Promise.all([
      si.cpu(),
      si.memLayout(),
      si.graphics(),
      si.diskLayout(),
    ]);

    const controllers = (graphics.controllers || []).filter((c) => c && (c.model || c.vendor));
    let gpuName = 'GPU';
    let gpuIntegrated = false;
    if (controllers.length) {
      const classified = controllers.map((c) => ({ ...c, _class: classifyGpu(c) }));
      const dedicated = classified.find((c) => c._class === 'dedicated');
      const chosen = dedicated || classified[0];
      gpuName = chosen.model || chosen.vendor || 'GPU';
      gpuIntegrated = chosen._class === 'integrated';
    }

    staticInfo = {
      cpuName: `${cpu.manufacturer || ''} ${cpu.brand || ''}`.trim() || 'CPU',
      ramType: (memLayout.find((m) => m.type && m.type !== 'Unknown') || {}).type || null,
      gpuName,
      gpuIntegrated,
      diskType: diskLayout[0]?.type === 'HD' ? 'HDD' : diskLayout[0]?.type || null,
    };
    return staticInfo;
  } catch (e) {
    return { cpuName: 'CPU', ramType: null, gpuName: 'GPU', gpuIntegrated: false, diskType: null };
  }
}

function withTimeout(promise, ms, fallbackValue) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallbackValue), ms)),
  ]);
}

function classifyGpu(controller) {
  const vendor = (controller.vendor || '').toLowerCase();
  const model = (controller.model || '').toLowerCase();
  const text = `${vendor} ${model}`;

  const dedicatedSignals = [
    'geforce', 'rtx', 'gtx', 'quadro', 'tesla',
    'radeon rx', 'radeon pro', 'radeon vii',
    'arc a', 'arc b',
  ];
  const integratedSignals = [
    'uhd graphics', 'iris', 'hd graphics', 'graphics family',
    'radeon(tm) graphics', 'radeon graphics',
    'apple m', 'apple silicon',
  ];

  if (dedicatedSignals.some((s) => text.includes(s))) return 'dedicated';
  if (integratedSignals.some((s) => text.includes(s))) return 'integrated';
  if (/vega\s*\d+/.test(text) && vendor.includes('amd')) return 'integrated';
  if (vendor.includes('intel')) return 'integrated';

  return 'dedicated';
}

ipcMain.handle('system:getInfo', async () => {
  const [sInfo, mem, graphics, fsSize] = await Promise.all([
    getStaticInfo(),
    withTimeout(si.mem(), 2000, {}),
    withTimeout(si.graphics(), 2000, { controllers: [] }),
    withTimeout(si.fsSize(), 2000, []),
  ]);

  const result = { cpu: null, gpu: null, ram: null, storage: null };

  result.cpu = {
    name: sInfo.cpuName,
    load: getCpuLoad(),
  };

  if (mem && mem.total) {
    result.ram = {
      totalGb: Math.round((mem.total / 1024 ** 3) * 10) / 10,
      usedPercent: Math.round(((mem.total - mem.available) / mem.total) * 100),
      type: sInfo.ramType,
    };
  }

  const controllers = (graphics.controllers || []).filter((c) => c && (c.model || c.vendor));
  let currentGpuLoad = null;
  if (controllers.length) {
    const active = controllers.find(c => (c.model || c.vendor) === sInfo.gpuName) || controllers[0];
    currentGpuLoad = typeof active.utilizationGpu === 'number' ? Math.round(active.utilizationGpu) : null;
  }
  result.gpu = {
    name: sInfo.gpuName,
    integrated: sInfo.gpuIntegrated,
    load: currentGpuLoad,
  };

  const mainVolume =
    fsSize.find((v) => v.mount === 'C:' || v.mount === '/') ||
    [...fsSize].sort((a, b) => (b.size || 0) - (a.size || 0))[0] ||
    null;

  if (mainVolume) {
    result.storage = {
      type: sInfo.diskType,
      totalGb: Math.round(mainVolume.size / 1024 ** 3),
      freeGb: Math.round((mainVolume.size - mainVolume.used) / 1024 ** 3),
    };
  }

  return result;
});

// ---------- Определение версии Windows (10 / 11) ----------
// У Windows 11 та же мажорная версия ядра (10.0), отличается только
// номер сборки: 22000+ значит "11".
function getOsInfo() {
  if (process.platform !== 'win32') {
    return { platform: process.platform, isWindows: false, windowsVersion: null, build: null };
  }
  const release = os.release(); // напр. "10.0.22631"
  const parts = release.split('.');
  const build = parseInt(parts[2] || '0', 10);
  const windowsVersion = build >= 22000 ? '11' : '10';
  return { platform: 'win32', isWindows: true, windowsVersion, build };
}

ipcMain.handle('system:getOsInfo', () => getOsInfo());

// ---------- Выполнение PowerShell-команд ----------
function runPowerShell(command, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { windowsHide: true, timeout },
      (error, stdout, stderr) => {
        resolve({ ok: !error, stdout: String(stdout || ''), stderr: String(stderr || (error ? error.message : '')) });
      }
    );
  });
}

// =====================================================================
// КАТАЛОГ ОПТИМИЗАЦИЙ ("Ускорение" -> вкладка "Оптимизация")
// Каждый пункт обратим (enable/disable), не хранится в рендерере, чтобы
// рендерер не мог подменить исполняемую команду - только id/enable.
// os: 'all' | '10' | '11'
// =====================================================================
const TWEAKS = [
  // ---------- Визуальные эффекты и анимации ----------
  { id: 'vfx-best-performance', category: 'Визуальные эффекты', category_en: 'Visual Effects', os: 'all',
    title: 'Режим «Наилучшее быстродействие»',
    title_en: 'Best Performance Mode',
    description: 'Отключает почти все визуальные эффекты Windows разом (тени, анимации, сглаживание).',
    description_en: 'Disables almost all Windows visual effects at once (shadows, animations, smoothing).',
    impact: 'Интерфейс станет более резким и «плоским», зато отклик окон и меню будет быстрее на слабом железе.',
    impact_en: 'The interface will become sharper and "flatter", but windows and menus will respond faster on weak hardware.',
    enableCmd: `Set-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop' -Name 'UserPreferencesMask' -Type Binary -Value ([byte[]](0x90,0x12,0x03,0x80,0x10,0x00,0x00,0x00)); Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VisualEffects' -Name 'VisualFXSetting' -Type DWord -Value 2`,
    disableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VisualEffects' -Name 'VisualFXSetting' -Type DWord -Value 0`,
    previewKind: 'anim' },
  { id: 'window-animations', category: 'Визуальные эффекты', category_en: 'Visual Effects', os: 'all',
    title: 'Анимация сворачивания/разворачивания окон',
    title_en: 'Window Animations',
    description: 'Плавная анимация при минимизации и восстановлении окон.',
    description_en: 'Smooth animation when minimizing and restoring windows.',
    impact: 'Окна будут открываться и закрываться мгновенно, без анимации «раскрытия».',
    impact_en: 'Windows will open and close instantly, without "unfolding" animation.',
    enableCmd: `Set-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop\\WindowMetrics' -Name 'MinAnimate' -Type String -Value '1'`,
    disableCmd: `Set-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop\\WindowMetrics' -Name 'MinAnimate' -Type String -Value '0'`,
    previewKind: 'anim' },
  { id: 'taskbar-animations', category: 'Визуальные эффекты', category_en: 'Visual Effects', os: 'all',
    title: 'Анимации панели задач',
    title_en: 'Taskbar Animations',
    description: 'Анимация появления кнопок и предпросмотра на панели задач.',
    description_en: 'Animation of buttons appearing and previews on the taskbar.',
    impact: 'Панель задач будет реагировать без плавных переходов.',
    impact_en: 'The taskbar will react without smooth transitions.',
    enableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced' -Name 'TaskbarAnimations' -Type DWord -Value 1`,
    disableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced' -Name 'TaskbarAnimations' -Type DWord -Value 0`,
    previewKind: 'anim' },
  { id: 'transparency-effects', category: 'Визуальные эффекты', category_en: 'Visual Effects', os: 'all',
    title: 'Прозрачность элементов интерфейса',
    title_en: 'Transparency Effects',
    description: 'Эффект полупрозрачного стекла на панели задач, меню «Пуск» и окнах.',
    description_en: 'Translucent glass effect on the taskbar, Start menu, and windows.',
    impact: 'Панели станут полностью непрозрачными - меньше нагрузки на видеокарту.',
    impact_en: 'Panels will become fully opaque - less load on the graphics card.',
    enableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize' -Name 'EnableTransparency' -Type DWord -Value 1`,
    disableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize' -Name 'EnableTransparency' -Type DWord -Value 0`,
    previewKind: 'transparency' },
  { id: 'menu-fade', category: 'Визуальные эффекты', category_en: 'Visual Effects', os: 'all',
    title: 'Затухание меню и всплывающих подсказок',
    title_en: 'Menu and Tooltip Fading',
    description: 'Плавное появление/исчезновение меню и тултипов.',
    description_en: 'Smooth appearance/disappearance of menus and tooltips.',
    impact: 'Меню и подсказки будут появляться сразу, без затухания.',
    impact_en: 'Menus and tooltips will appear immediately, without fading.',
    enableCmd: `Set-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop' -Name 'UserPreferencesMask' -Type Binary -Value ([byte[]](0x9E,0x1E,0x07,0x80,0x12,0x00,0x00,0x00))`,
    disableCmd: `Set-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop' -Name 'UserPreferencesMask' -Type Binary -Value ([byte[]](0x9E,0x1E,0x03,0x80,0x12,0x00,0x00,0x00))`,
    previewKind: 'anim' },
  { id: 'menu-show-delay', category: 'Визуальные эффекты', category_en: 'Visual Effects', os: 'all',
    title: 'Задержка перед открытием подменю',
    title_en: 'Menu Show Delay',
    description: 'Стандартная задержка 400 мс перед раскрытием вложенных пунктов меню.',
    description_en: 'Standard 400 ms delay before opening nested menu items.',
    impact: 'Подменю будут раскрываться мгновенно при наведении.',
    impact_en: 'Submenus will open instantly upon hovering.',
    enableCmd: `Set-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop' -Name 'MenuShowDelay' -Type String -Value '400'`,
    disableCmd: `Set-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop' -Name 'MenuShowDelay' -Type String -Value '0'`,
    previewKind: 'anim' },
  { id: 'smooth-scroll-lists', category: 'Визуальные эффекты', category_en: 'Visual Effects', os: 'all',
    title: 'Плавная прокрутка списков',
    title_en: 'Smooth Scrolling',
    description: 'Инерционная прокрутка в проводнике и списках.',
    description_en: 'Inertial scrolling in Explorer and lists.',
    impact: 'Прокрутка станет «ступенчатой», но менее нагруженной для GPU.',
    impact_en: 'Scrolling will become "stepped", but less loaded for the GPU.',
    enableCmd: `Set-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop' -Name 'SmoothScroll' -Type DWord -Value 1`,
    disableCmd: `Set-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop' -Name 'SmoothScroll' -Type DWord -Value 0`,
    previewKind: 'anim' },
  { id: 'aero-peek', category: 'Визуальные эффекты', category_en: 'Visual Effects', os: 'all',
    title: 'Aero Peek (просмотр рабочего стола)',
    title_en: 'Aero Peek',
    description: 'Предпросмотр рабочего стола при наведении на кнопку в правом углу панели задач.',
    description_en: 'Preview the desktop when hovering over the button in the right corner of the taskbar.',
    impact: 'Наведение больше не будет «просвечивать» окна.',
    impact_en: 'Hovering will no longer make windows transparent.',
    enableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced' -Name 'DisablePreviewDesktop' -Type DWord -Value 0`,
    disableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced' -Name 'DisablePreviewDesktop' -Type DWord -Value 1`,
    previewKind: 'anim' },
  { id: 'thumbnail-previews', category: 'Визуальные эффекты', category_en: 'Visual Effects', os: 'all',
    title: 'Миниатюры вместо значков',
    title_en: 'Thumbnails instead of Icons',
    description: 'Показ реальных превью файлов/окон вместо стандартных иконок.',
    description_en: 'Showing real previews of files/windows instead of standard icons.',
    impact: 'Проводник будет показывать обычные иконки - быстрее открывает папки с медиафайлами.',
    impact_en: 'Explorer will show regular icons - opens folders with media files faster.',
    enableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced' -Name 'IconsOnly' -Type DWord -Value 0`,
    disableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced' -Name 'IconsOnly' -Type DWord -Value 1`,
    previewKind: 'anim' },
  { id: 'controls-animation', category: 'Визуальные эффекты', category_en: 'Visual Effects', os: 'all',
    title: 'Анимация элементов управления',
    title_en: 'Control Animations',
    description: 'Плавные переходы у кнопок, чекбоксов и других элементов внутри окон.',
    description_en: 'Smooth transitions for buttons, checkboxes, and other elements inside windows.',
    impact: 'Элементы управления будут переключаться без плавности.',
    impact_en: 'Controls will switch without smoothness.',
    enableCmd: `Set-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop' -Name 'UserPreferencesMask' -Type Binary -Value ([byte[]](0x9E,0x3E,0x07,0x80,0x12,0x00,0x00,0x00))`,
    disableCmd: `Set-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop' -Name 'UserPreferencesMask' -Type Binary -Value ([byte[]](0x9E,0x3E,0x03,0x80,0x12,0x00,0x00,0x00))`,
    previewKind: 'anim' },

  // ---------- Автозагрузка и фоновые службы ----------
  { id: 'svc-sysmain', category: 'Автозагрузка и службы', category_en: 'Startup & Services', os: 'all',
    title: 'Служба SysMain (Superfetch)',
    title_en: 'SysMain Service (Superfetch)',
    description: 'Предзагружает часто используемые программы в оперативную память.',
    description_en: 'Preloads frequently used programs into RAM.',
    impact: 'Освобождает RAM и снижает фоновую нагрузку на диск; на HDD иногда ускоряет старт системы, на SSD обычно бесполезна.',
    impact_en: 'Frees up RAM and reduces background disk load; sometimes speeds up system start on HDD, usually useless on SSD.',
    enableCmd: `Set-Service -Name SysMain -StartupType Automatic -ErrorAction SilentlyContinue; Start-Service -Name SysMain -ErrorAction SilentlyContinue`,
    disableCmd: `Stop-Service -Name SysMain -Force -ErrorAction SilentlyContinue; Set-Service -Name SysMain -StartupType Disabled -ErrorAction SilentlyContinue`,
    previewKind: 'text' },
  { id: 'svc-search', category: 'Автозагрузка и службы', category_en: 'Startup & Services', os: 'all',
    title: 'Индексирование поиска Windows',
    title_en: 'Windows Search Indexing',
    description: 'Служба Windows Search индексирует файлы для быстрого поиска.',
    description_en: 'Windows Search service indexes files for fast searching.',
    impact: 'Поиск файлов станет медленнее, зато меньше фоновой нагрузки на диск.',
    impact_en: 'File search will be slower, but there will be less background load on the disk.',
    enableCmd: `Set-Service -Name WSearch -StartupType Automatic -ErrorAction SilentlyContinue; Start-Service -Name WSearch -ErrorAction SilentlyContinue`,
    disableCmd: `Stop-Service -Name WSearch -Force -ErrorAction SilentlyContinue; Set-Service -Name WSearch -StartupType Disabled -ErrorAction SilentlyContinue`,
    previewKind: 'text' },
  { id: 'svc-diagtrack', category: 'Автозагрузка и службы', category_en: 'Startup & Services', os: 'all',
    title: 'Служба телеметрии (DiagTrack)',
    title_en: 'Telemetry Service (DiagTrack)',
    description: 'Сбор диагностических данных и отправка в Microsoft.',
    description_en: 'Collecting diagnostic data and sending it to Microsoft.',
    impact: 'Снижает фоновую сетевую и дисковую активность, связанную со сбором телеметрии.',
    impact_en: 'Reduces background network and disk activity associated with telemetry collection.',
    enableCmd: `Set-Service -Name DiagTrack -StartupType Automatic -ErrorAction SilentlyContinue; Start-Service -Name DiagTrack -ErrorAction SilentlyContinue`,
    disableCmd: `Stop-Service -Name DiagTrack -Force -ErrorAction SilentlyContinue; Set-Service -Name DiagTrack -StartupType Disabled -ErrorAction SilentlyContinue`,
    previewKind: 'text' },
  { id: 'svc-printspooler', category: 'Автозагрузка и службы', category_en: 'Startup & Services', os: 'all',
    title: 'Диспетчер печати (Print Spooler)',
    title_en: 'Print Spooler',
    description: 'Нужен только если вы пользуетесь принтером.',
    description_en: 'Needed only if you use a printer.',
    impact: 'Освобождает немного памяти; печать станет недоступна, пока служба выключена.',
    impact_en: 'Frees up some memory; printing will be unavailable while the service is off.',
    enableCmd: `Set-Service -Name Spooler -StartupType Automatic -ErrorAction SilentlyContinue; Start-Service -Name Spooler -ErrorAction SilentlyContinue`,
    disableCmd: `Stop-Service -Name Spooler -Force -ErrorAction SilentlyContinue; Set-Service -Name Spooler -StartupType Disabled -ErrorAction SilentlyContinue`,
    previewKind: 'text' },
  { id: 'svc-fax', category: 'Автозагрузка и службы', category_en: 'Startup & Services', os: 'all',
    title: 'Служба факса',
    title_en: 'Fax Service',
    description: 'Практически никогда не используется на современных ПК.',
    description_en: 'Practically never used on modern PCs.',
    impact: 'Полностью безопасно отключить, если вы не отправляете факсы.',
    impact_en: 'Completely safe to disable if you do not send faxes.',
    enableCmd: `Set-Service -Name Fax -StartupType Manual -ErrorAction SilentlyContinue`,
    disableCmd: `Stop-Service -Name Fax -Force -ErrorAction SilentlyContinue; Set-Service -Name Fax -StartupType Disabled -ErrorAction SilentlyContinue`,
    previewKind: 'text' },
  { id: 'svc-remoteregistry', category: 'Автозагрузка и службы', category_en: 'Startup & Services', os: 'all',
    title: 'Служба удалённого реестра',
    title_en: 'Remote Registry Service',
    description: 'Позволяет редактировать реестр удалённо - редко нужна на домашнем ПК.',
    description_en: 'Allows remote registry editing - rarely needed on a home PC.',
    impact: 'Снижает поверхность атаки, освобождает небольшой объём памяти.',
    impact_en: 'Reduces attack surface, frees up a small amount of memory.',
    enableCmd: `Set-Service -Name RemoteRegistry -StartupType Manual -ErrorAction SilentlyContinue`,
    disableCmd: `Stop-Service -Name RemoteRegistry -Force -ErrorAction SilentlyContinue; Set-Service -Name RemoteRegistry -StartupType Disabled -ErrorAction SilentlyContinue`,
    previewKind: 'text' },
  { id: 'svc-wer', category: 'Автозагрузка и службы', category_en: 'Startup & Services', os: 'all',
    title: 'Отчёты об ошибках Windows (WerSvc)',
    title_en: 'Windows Error Reporting (WerSvc)',
    description: 'Автоматически собирает и отправляет отчёты о сбоях программ.',
    description_en: 'Automatically collects and sends reports about program crashes.',
    impact: 'Сбои приложений больше не будут отправлять отчёты и показывать диалог отправки.',
    impact_en: 'App crashes will no longer send reports or show the sending dialog.',
    enableCmd: `Set-Service -Name WerSvc -StartupType Manual -ErrorAction SilentlyContinue`,
    disableCmd: `Stop-Service -Name WerSvc -Force -ErrorAction SilentlyContinue; Set-Service -Name WerSvc -StartupType Disabled -ErrorAction SilentlyContinue`,
    previewKind: 'text' },
  { id: 'background-apps', category: 'Автозагрузка и службы', category_en: 'Startup & Services', os: 'all',
    title: 'Работа приложений из Microsoft Store в фоне',
    title_en: 'Background Apps (Microsoft Store)',
    description: 'Разрешает UWP-приложениям обновлять данные, пока они свёрнуты.',
    description_en: 'Allows UWP apps to update data while minimized.',
    impact: 'Приложения из Store перестанут расходовать ресурсы в фоне, но не будут обновлять данные (почта, новости) пока не открыты.',
    impact_en: 'Store apps will stop consuming resources in the background, but won\'t update data (mail, news) until opened.',
    enableCmd: `Remove-ItemProperty -Path 'HKCU:\\Software\\Policies\\Microsoft\\Windows\\AppPrivacy' -Name 'LetAppsRunInBackground' -ErrorAction SilentlyContinue`,
    disableCmd: `New-Item -Path 'HKCU:\\Software\\Policies\\Microsoft\\Windows\\AppPrivacy' -Force | Out-Null; Set-ItemProperty -Path 'HKCU:\\Software\\Policies\\Microsoft\\Windows\\AppPrivacy' -Name 'LetAppsRunInBackground' -Type DWord -Value 2`,
    previewKind: 'text' },
  { id: 'startup-delay', category: 'Автозагрузка и службы', category_en: 'Startup & Services', os: 'all',
    title: 'Искусственная задержка автозапуска',
    title_en: 'Startup Delay',
    description: 'Windows намеренно откладывает запуск автозагрузочных программ на несколько секунд после входа в систему.',
    description_en: 'Windows intentionally delays the start of startup programs by a few seconds after login.',
    impact: 'Программы из автозагрузки будут стартовать сразу при входе - рабочий стол дольше будет «тормозить» первые секунды.',
    impact_en: 'Startup programs will start immediately upon login - the desktop might "lag" longer for the first few seconds.',
    enableCmd: `Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Serialize' -Name 'StartupDelayInMSec' -ErrorAction SilentlyContinue`,
    disableCmd: `New-Item -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Serialize' -Force | Out-Null; Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Serialize' -Name 'StartupDelayInMSec' -Type DWord -Value 0`,
    previewKind: 'text' },
  { id: 'onedrive-autostart', category: 'Автозагрузка и службы', category_en: 'Startup & Services', os: 'all',
    title: 'Автозапуск OneDrive',
    title_en: 'OneDrive Autostart',
    description: 'Синхронизация OneDrive стартует вместе with Windows.',
    description_en: 'OneDrive synchronization starts along with Windows.',
    impact: 'OneDrive не будет запускаться автоматически - меньше фоновой сети и диска на старте.',
    impact_en: 'OneDrive will not start automatically - less background network and disk usage on startup.',
    enableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'OneDrive' -Type String -Value "$env:LOCALAPPDATA\\Microsoft\\OneDrive\\OneDrive.exe /background"`,
    disableCmd: `Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'OneDrive' -ErrorAction SilentlyContinue`,
    previewKind: 'text' },

  // ---------- Сеть ----------
  { id: 'net-throttling', category: 'Сеть', category_en: 'Network', os: 'all',
    title: 'Ограничение пропускной способности (Network Throttling)',
    title_en: 'Network Throttling',
    description: 'Windows по умолчанию придерживает часть канала для системных нужд.',
    description_en: 'Windows by default reserves part of the bandwidth for system needs.',
    impact: 'Снимает системное ограничение канала - может улучшить отклик сети в играх и потоковой передаче.',
    impact_en: 'Removes the system bandwidth limit - can improve network response in games and streaming.',
    enableCmd: `Remove-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile' -Name 'NetworkThrottlingIndex' -ErrorAction SilentlyContinue`,
    disableCmd: `Set-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile' -Name 'NetworkThrottlingIndex' -Type DWord -Value 0xffffffff`,
    previewKind: 'text' },
  { id: 'net-nagle', category: 'Сеть', category_en: 'Network', os: 'all',
    title: 'Алгоритм Нейгла (задержка мелких пакетов)',
    title_en: 'Nagle\'s Algorithm',
    description: 'Группирует мелкие сетевые пакеты перед отправкой, снижая нагрузку на сеть ценой задержки.',
    description_en: 'Groups small network packets before sending, reducing network load at the cost of delay.',
    impact: 'Уменьшает задержку (пинг) в онлайн-играх ценой чуть большей нагрузки на сеть.',
    impact_en: 'Reduces latency (ping) in online games at the cost of a slightly higher network load.',
    enableCmd: `Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces' | ForEach-Object { Remove-ItemProperty -Path $_.PSPath -Name 'TcpAckFrequency','TCPNoDelay' -ErrorAction SilentlyContinue }`,
    disableCmd: `Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces' | ForEach-Object { Set-ItemProperty -Path $_.PSPath -Name 'TcpAckFrequency' -Type DWord -Value 1; Set-ItemProperty -Path $_.PSPath -Name 'TCPNoDelay' -Type DWord -Value 1 }`,
    previewKind: 'text' },
  { id: 'net-autotuning', category: 'Сеть', category_en: 'Network', os: 'all',
    title: 'Автонастройка TCP-окна',
    title_en: 'TCP Window Auto-Tuning',
    description: 'Windows динамически подбирает размер окна приёма TCP.',
    description_en: 'Windows dynamically adjusts the size of the TCP receive window.',
    impact: 'Обычно ускоряет загрузку на быстрых и нестабильных соединениях; в редких случаях помогает включить «normal» вместо «disabled».',
    impact_en: 'Usually speeds up downloads on fast and unstable connections; in rare cases, enabling "normal" instead of "disabled" helps.',
    enableCmd: `netsh int tcp set global autotuninglevel=normal`,
    disableCmd: `netsh int tcp set global autotuninglevel=disabled`,
    previewKind: 'text' },
  { id: 'net-delivery-optimization', category: 'Сеть', category_en: 'Network', os: 'all',
    title: 'Обновления Windows через другие ПК (Delivery Optimization)',
    title_en: 'Delivery Optimization',
    description: 'Windows может скачивать/раздавать обновления через другие устройства в сети и интернете (P2P).',
    description_en: 'Windows can download/distribute updates via other devices on the network and internet (P2P).',
    impact: 'Отключает P2P-раздачу обновлений - меньше фонового трафика и нагрузки на канал.',
    impact_en: 'Disables P2P update distribution - less background traffic and bandwidth load.',
    enableCmd: `Set-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\DeliveryOptimization\\Config' -Name 'DODownloadMode' -Type DWord -Value 1`,
    disableCmd: `New-Item -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\DeliveryOptimization\\Config' -Force | Out-Null; Set-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\DeliveryOptimization\\Config' -Name 'DODownloadMode' -Type DWord -Value 0`,
    previewKind: 'text' },
  { id: 'net-metered-limits', category: 'Сеть', category_en: 'Network', os: 'all',
    title: 'Ограничения лимитного подключения',
    title_en: 'Metered Connection Limits',
    description: 'На лимитных сетях Windows урезает фоновые обновления и синхронизацию.',
    description_en: 'On metered networks, Windows cuts down background updates and synchronization.',
    impact: 'Приложения и обновления будут вести себя как на безлимитном интернете даже в лимитных сетях.',
    impact_en: 'Apps and updates will behave as if on unlimited internet even in metered networks.',
    enableCmd: `Remove-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\DUSMSvc' -Name 'IgnoreMetered' -ErrorAction SilentlyContinue`,
    disableCmd: `New-Item -Path 'HKLM:\\SOFTWARE\\Microsoft\\DUSMSvc' -Force | Out-Null; Set-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\DUSMSvc' -Name 'IgnoreMetered' -Type DWord -Value 1`,
    previewKind: 'text' },

  // ---------- Приватность и телеметрия ----------
  { id: 'telemetry-level', category: 'Приватность', category_en: 'Privacy', os: 'all',
    title: 'Уровень телеметрии Windows',
    title_en: 'Windows Telemetry Level',
    description: 'Объём диагностических данных, которые Windows отправляет в Microsoft.',
    description_en: 'Amount of diagnostic data Windows sends to Microsoft.',
    impact: 'Снижает уровень телеметрии до минимального из доступных на вашей редакции Windows.',
    impact_en: 'Reduces telemetry level to the minimum available on your Windows edition.',
    enableCmd: `Set-ItemProperty -Path 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\DataCollection' -Name 'AllowTelemetry' -Type DWord -Value 3`,
    disableCmd: `New-Item -Path 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\DataCollection' -Force | Out-Null; Set-ItemProperty -Path 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\DataCollection' -Name 'AllowTelemetry' -Type DWord -Value 0`,
    previewKind: 'text' },
  { id: 'advertising-id', category: 'Приватность', category_en: 'Privacy', os: 'all',
    title: 'Рекламный идентификатор',
    title_en: 'Advertising ID',
    description: 'Используется приложениями для персонализированной рекламы.',
    description_en: 'Used by apps for personalized advertising.',
    impact: 'Реклама в приложениях станет менее персонализированной.',
    impact_en: 'Ads in apps will become less personalized.',
    enableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\AdvertisingInfo' -Name 'Enabled' -Type DWord -Value 1`,
    disableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\AdvertisingInfo' -Name 'Enabled' -Type DWord -Value 0`,
    previewKind: 'text' },
  { id: 'activity-history', category: 'Приватность', category_en: 'Privacy', os: 'all',
    title: 'Журнал действий (Timeline)',
    title_en: 'Activity History (Timeline)',
    description: 'Windows запоминает историю открытых приложений и документов.',
    description_en: 'Windows remembers the history of opened apps and documents.',
    impact: 'Перестаёт вестись и отправляться история активности.',
    impact_en: 'Stops tracking and sending activity history.',
    enableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\CloudStore' -Name 'EnableActivityFeed' -Type DWord -Value 1 -ErrorAction SilentlyContinue`,
    disableCmd: `Set-ItemProperty -Path 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\System' -Name 'EnableActivityFeed' -Type DWord -Value 0 -ErrorAction SilentlyContinue; Set-ItemProperty -Path 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\System' -Name 'PublishUserActivities' -Type DWord -Value 0 -ErrorAction SilentlyContinue`,
    previewKind: 'text' },
  { id: 'location-tracking', category: 'Приватность', category_en: 'Privacy', os: 'all',
    title: 'Служба геолокации',
    title_en: 'Location Service',
    description: 'Позволяет приложениям определять ваше местоположение.',
    description_en: 'Allows apps to determine your location.',
    impact: 'Приложения, которым нужна геолокация (карты, погода), перестанут получать точные координаты.',
    impact_en: 'Apps that need location (maps, weather) will stop receiving accurate coordinates.',
    enableCmd: `Set-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\location' -Name 'Value' -Type String -Value 'Allow'`,
    disableCmd: `Set-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\location' -Name 'Value' -Type String -Value 'Deny'`,
    previewKind: 'text' },
  { id: 'tailored-experiences', category: 'Приватность', category_en: 'Privacy', os: 'all',
    title: 'Персонализированные советы Windows',
    title_en: 'Tailored Experiences',
    description: 'Windows использует данные диагностики для показа советов и рекламы внутри системы.',
    description_en: 'Windows uses diagnostic data to show tips and ads within the system.',
    impact: 'Меньше всплывающих советов и «рекомендаций» в меню Пуск и уведомлениях.',
    impact_en: 'Fewer pop-up tips and "recommendations" in the Start menu and notifications.',
    enableCmd: `Remove-ItemProperty -Path 'HKCU:\\Software\\Policies\\Microsoft\\Windows\\CloudContent' -Name 'DisableTailoredExperiencesWithDiagnosticData' -ErrorAction SilentlyContinue`,
    disableCmd: `New-Item -Path 'HKCU:\\Software\\Policies\\Microsoft\\Windows\\CloudContent' -Force | Out-Null; Set-ItemProperty -Path 'HKCU:\\Software\\Policies\\Microsoft\\Windows\\CloudContent' -Name 'DisableTailoredExperiencesWithDiagnosticData' -Type DWord -Value 1`,
    previewKind: 'text' },
  { id: 'feedback-notifications', category: 'Приватность', category_en: 'Privacy', os: 'all',
    title: 'Запросы обратной связи',
    title_en: 'Feedback Notifications',
    description: 'Периодические всплывающие окна «Оцените этот опыт».',
    description_en: 'Periodic pop-up windows "Rate this experience".',
    impact: 'Windows перестанет спрашивать вашу оценку разных функций.',
    impact_en: 'Windows will stop asking for your rating of various functions.',
    enableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Siuf\\Rules' -Name 'NumberOfSIUFInPeriod' -Type DWord -Value 1 -ErrorAction SilentlyContinue`,
    disableCmd: `New-Item -Path 'HKCU:\\Software\\Microsoft\\Siuf\\Rules' -Force | Out-Null; Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Siuf\\Rules' -Name 'NumberOfSIUFInPeriod' -Type DWord -Value 0`,
    previewKind: 'text' },
  { id: 'cortana', category: 'Приватность', category_en: 'Privacy', os: '10',
    title: 'Cortana',
    title_en: 'Cortana',
    description: 'Голосовой помощник Windows 10.',
    description_en: 'Windows 10 voice assistant.',
    impact: 'Cortana перестанет запускаться и индексировать запросы для голосового поиска.',
    impact_en: 'Cortana will stop starting and indexing voice search queries.',
    enableCmd: `Remove-ItemProperty -Path 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\Windows Search' -Name 'AllowCortana' -ErrorAction SilentlyContinue`,
    disableCmd: `New-Item -Path 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\Windows Search' -Force | Out-Null; Set-ItemProperty -Path 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\Windows Search' -Name 'AllowCortana' -Type DWord -Value 0`,
    previewKind: 'text' },

  // ---------- Питание и производительность ----------
  { id: 'power-high-performance', category: 'Питание', category_en: 'Power', os: 'all',
    title: 'Схема питания «Высокая производительность»',
    title_en: 'High Performance Power Plan',
    description: 'Переключает активную схему электропитания.',
    description_en: 'Switches the active power scheme.',
    impact: 'ЦП будет реже снижать частоту для энергосбережения - выше производительность, но и энергопотребление.',
    impact_en: 'CPU will reduce frequency less often for power saving - higher performance, but also higher power consumption.',
    enableCmd: `powercfg /setactive SCHEME_MIN`,
    disableCmd: `powercfg /setactive SCHEME_BALANCED`,
    previewKind: 'text' },
  { id: 'usb-selective-suspend', category: 'Питание', category_en: 'Power', os: 'all',
    title: 'Избирательная приостановка USB',
    title_en: 'USB Selective Suspend',
    description: 'Windows временно «усыпляет» неиспользуемые USB-устройства для экономии энергии.',
    description_en: 'Windows temporarily "sleeps" unused USB devices to save energy.',
    impact: 'USB-мышь/геймпад не будут «просыпаться» with задержкой после простоя.',
    impact_en: 'USB mouse/gamepad will not "wake up" with a delay after idle.',
    enableCmd: `powercfg /setacvalueindex SCHEME_CURRENT 2a737441-1930-4402-8d77-b2bebba308a3 48e6b7a6-50f5-4782-a5d4-53bb8f07e226 1`,
    disableCmd: `powercfg /setacvalueindex SCHEME_CURRENT 2a737441-1930-4402-8d77-b2bebba308a3 48e6b7a6-50f5-4782-a5d4-53bb8f07e226 0`,
    previewKind: 'text' },
  { id: 'fast-startup', category: 'Питание', category_en: 'Power', os: 'all',
    title: 'Быстрый запуск (Fast Startup)',
    title_en: 'Fast Startup',
    description: 'Гибридный режим завершения работы, ускоряющий следующий запуск.',
    description_en: 'Hybrid shutdown mode that speeds up the next boot.',
    impact: 'Отключение полезно, если после сна/выключения возникают проблемы with драйверами или сетью.',
    impact_en: 'Disabling is useful if issues with drivers or network occur after sleep/shutdown.',
    enableCmd: `powercfg /hibernate on; Set-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Power' -Name 'HiberbootEnabled' -Type DWord -Value 1`,
    disableCmd: `Set-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Power' -Name 'HiberbootEnabled' -Type DWord -Value 0`,
    previewKind: 'text' },
  { id: 'hibernation', category: 'Питание', category_en: 'Power', os: 'all',
    title: 'Режим гибернации',
    title_en: 'Hibernation Mode',
    description: 'Хранит образ ОЗУ на диске (файл hiberfil.sys) для восстановления сеанса.',
    description_en: 'Stores a RAM image on disk (hiberfil.sys) for session recovery.',
    impact: 'Освобождает несколько гигабайт места на системном диске (обычно 40-75% объёма ОЗУ).',
    impact_en: 'Frees up several gigabytes on the system disk (usually 40-75% of RAM size).',
    enableCmd: `powercfg /hibernate on`,
    disableCmd: `powercfg /hibernate off`,
    previewKind: 'text' },
  { id: 'gpu-hw-scheduling', category: 'Питание', category_en: 'Power', os: 'all',
    title: 'Аппаратное планирование GPU',
    title_en: 'Hardware-Accelerated GPU Scheduling',
    description: 'Передаёт часть планирования видеопамяти напрямую видеокарте (Windows 10 2004+ / Windows 11).',
    description_en: 'Offloads some video memory scheduling directly to the graphics card (Windows 10 2004+ / Windows 11).',
    impact: 'Может немного снизить задержку вывода кадров на современных GPU и драйверах.',
    impact_en: 'May slightly reduce frame output latency on modern GPUs and drivers.',
    enableCmd: `Set-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\Dwm' -Name 'HwSchMode' -Type DWord -Value 2`,
    disableCmd: `Set-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\Dwm' -Name 'HwSchMode' -Type DWord -Value 1`,
    previewKind: 'text' },
  { id: 'win32-priority', category: 'Питание', category_en: 'Power', os: 'all',
    title: 'Приоритет активного окна',
    title_en: 'Win32 Priority Separation',
    description: 'Отдаёт больше процессорного времени активному приложению на переднем плане.',
    description_en: 'Gives more CPU time to the active foreground application.',
    impact: 'Активная программа (например, игра) будет отзывчивее за счёт фоновых процессов.',
    impact_en: 'The active program (e.g., a game) will be more responsive at the expense of background processes.',
    enableCmd: `Set-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\PriorityControl' -Name 'Win32PrioritySeparation' -Type DWord -Value 2`,
    disableCmd: `Set-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\PriorityControl' -Name 'Win32PrioritySeparation' -Type DWord -Value 26`,
    previewKind: 'text' },

  // ---------- Игры ----------
  { id: 'game-mode', category: 'Игры', category_en: 'Games', os: 'all',
    title: 'Игровой режим Windows',
    title_en: 'Windows Game Mode',
    description: 'Приоритизирует ресурсы для игры и приглушает фоновые уведомления.',
    description_en: 'Prioritizes resources for gaming and silences background notifications.',
    impact: 'Во время игр система будет меньше отвлекаться на фоновые обновления и Xbox Game Bar.',
    impact_en: 'During gaming, the system will be less distracted by background updates and Xbox Game Bar.',
    enableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\GameBar' -Name 'AutoGameModeEnabled' -Type DWord -Value 1`,
    disableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\GameBar' -Name 'AutoGameModeEnabled' -Type DWord -Value 0`,
    previewKind: 'text' },
  { id: 'game-bar', category: 'Игры', category_en: 'Games', os: 'all',
    title: 'Xbox Game Bar',
    title_en: 'Xbox Game Bar',
    description: 'Оверлей для записи видео и скриншотов во время игр.',
    description_en: 'Overlay for recording video and screenshots during games.',
    impact: 'Освобождает немного ресурсов, отключает вызов оверлея по Win+G.',
    impact_en: 'Frees up some resources, disables the overlay call with Win+G.',
    enableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR' -Name 'AppCaptureEnabled' -Type DWord -Value 1`,
    disableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR' -Name 'AppCaptureEnabled' -Type DWord -Value 0`,
    previewKind: 'text' },
  { id: 'fullscreen-optimizations', category: 'Игры', category_en: 'Games', os: 'all',
    title: 'Оптимизации полноэкранного режима',
    title_en: 'Fullscreen Optimizations',
    description: 'Windows подменяет настоящий полноэкранный режим на «безрамочное окно» для быстрого переключения.',
    description_en: 'Windows replaces true fullscreen mode with a "borderless window" for fast switching.',
    impact: 'В некоторых играх отключение снижает задержку ввода и убирает микрофризы.',
    impact_en: 'In some games, disabling this reduces input lag and removes micro-stutters.',
    enableCmd: `Remove-ItemProperty -Path 'HKCU:\\System\\GameConfigStore' -Name 'GameDVR_FSEBehaviorMode' -ErrorAction SilentlyContinue`,
    disableCmd: `Set-ItemProperty -Path 'HKCU:\\System\\GameConfigStore' -Name 'GameDVR_FSEBehaviorMode' -Type DWord -Value 2 -ErrorAction SilentlyContinue`,
    previewKind: 'text' },
  { id: 'mouse-acceleration', category: 'Игры', category_en: 'Games', os: 'all',
    title: 'Ускорение указателя мыши',
    title_en: 'Mouse Acceleration',
    description: 'Windows делает движение курсора нелинейным в зависимости от скорости руки.',
    description_en: 'Windows makes cursor movement non-linear depending on hand speed.',
    impact: 'Прицеливание в шутерах станет более предсказуемым (1:1 движение).',
    impact_en: 'Aiming in shooters will become more predictable (1:1 movement).',
    enableCmd: `Set-ItemProperty -Path 'HKCU:\\Control Panel\\Mouse' -Name 'MouseSpeed' -Value '1'; Set-ItemProperty -Path 'HKCU:\\Control Panel\\Mouse' -Name 'MouseThreshold1' -Value '6'; Set-ItemProperty -Path 'HKCU:\\Control Panel\\Mouse' -Name 'MouseThreshold2' -Value '10'`,
    disableCmd: `Set-ItemProperty -Path 'HKCU:\\Control Panel\\Mouse' -Name 'MouseSpeed' -Value '0'; Set-ItemProperty -Path 'HKCU:\\Control Panel\\Mouse' -Name 'MouseThreshold1' -Value '0'; Set-ItemProperty -Path 'HKCU:\\Control Panel\\Mouse' -Name 'MouseThreshold2' -Value '0'`,
    previewKind: 'text' },

  // ---------- Диск и файловая система ----------
  { id: 'storage-sense', category: 'Диск', category_en: 'Disk', os: 'all',
    title: 'Storage Sense (автоочистка диска)',
    title_en: 'Storage Sense',
    description: 'Автоматически удаляет временные файлы и старое содержимое корзины.',
    description_en: 'Automatically deletes temporary files and old recycle bin content.',
    impact: 'Windows будет сама следить за свободным местом на диске.',
    impact_en: 'Windows will monitor free disk space itself.',
    enableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\StorageSense\\Parameters\\StoragePolicy' -Name '01' -Type DWord -Value 1 -ErrorAction SilentlyContinue`,
    disableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\StorageSense\\Parameters\\StoragePolicy' -Name '01' -Type DWord -Value 0 -ErrorAction SilentlyContinue`,
    previewKind: 'text' },
  { id: 'ssd-defrag-schedule', category: 'Диск', category_en: 'Disk', os: 'all',
    title: 'Плановая дефрагментация на SSD',
    title_en: 'SSD Defragmentation Schedule',
    description: 'Windows по умолчанию может запускать классическую дефрагментацию по расписанию.',
    description_en: 'Windows by default can run classic defragmentation on a schedule.',
    impact: 'На SSD снижает лишний износ накопителя (TRIM продолжит работать отдельно).',
    impact_en: 'Reduces excessive SSD wear (TRIM will continue to work separately).',
    enableCmd: `schtasks /Change /TN "\\Microsoft\\Windows\\Defrag\\ScheduledDefrag" /Enable`,
    disableCmd: `schtasks /Change /TN "\\Microsoft\\Windows\\Defrag\\ScheduledDefrag" /Disable`,
    previewKind: 'text' },
  { id: 'ntfs-last-access', category: 'Диск', category_en: 'Disk', os: 'all',
    title: 'Обновление метки последнего доступа к файлам (NTFS)',
    title_en: 'NTFS Last Access Update',
    description: 'При каждом открытии файла Windows обновляет метку времени доступа.',
    description_en: 'Windows updates the access timestamp every time a file is opened.',
    impact: 'Немного снижает число операций записи на диск при активной работе with файлами.',
    impact_en: 'Slightly reduces the number of disk write operations during active file usage.',
    enableCmd: `fsutil behavior set disablelastaccess 0`,
    disableCmd: `fsutil behavior set disablelastaccess 1`,
    previewKind: 'text' },
  { id: 'prefetch', category: 'Диск', category_en: 'Disk', os: 'all',
    title: 'Prefetch/Prefetcher',
    title_en: 'Prefetch/Prefetcher',
    description: 'Кэширует данные о часто запускаемых программах для более быстрого старта.',
    description_en: 'Caches data about frequently launched programs for faster starts.',
    impact: 'На HDD ускоряет повторный запуск программ; на SSD особой пользы нет, зато меньше файлов кэша.',
    impact_en: 'Speeds up program re-launch on HDD; little benefit on SSD, but fewer cache files.',
    enableCmd: `Set-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters' -Name 'EnablePrefetcher' -Type DWord -Value 3`,
    disableCmd: `Set-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters' -Name 'EnablePrefetcher' -Type DWord -Value 0`,
    previewKind: 'text' },

  // ---------- Проводник и интерфейс ----------
  { id: 'show-file-extensions', category: 'Проводник', category_en: 'Explorer', os: 'all',
    title: 'Показ расширений файлов',
    title_en: 'Show File Extensions',
    description: 'По умолчанию Windows скрывает известные расширения (.txt, .jpg и т.д.).',
    description_en: 'Windows hides known extensions (.txt, .jpg, etc.) by default.',
    impact: 'В проводнике у всех файлов будет видно полное расширение - удобно и безопаснее.',
    impact_en: 'All files in Explorer will show full extensions - convenient and safer.',
    enableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced' -Name 'HideFileExt' -Type DWord -Value 1`,
    disableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced' -Name 'HideFileExt' -Type DWord -Value 0`,
    previewKind: 'anim' },
  { id: 'quick-access-recent', category: 'Проводник', category_en: 'Explorer', os: 'all',
    title: 'Недавние файлы в «Быстром доступе»',
    title_en: 'Recent Files in Quick Access',
    description: 'Проводник запоминает и показывает недавно открытые файлы и папки.',
    description_en: 'Explorer remembers and shows recently opened files and folders.',
    impact: 'Быстрый доступ покажет только закреплённые папки - немного приватнее.',
    impact_en: 'Quick Access will only show pinned folders - a bit more private.',
    enableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced' -Name 'Start_TrackDocs' -Type DWord -Value 1`,
    disableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced' -Name 'Start_TrackDocs' -Type DWord -Value 0`,
    previewKind: 'text' },
  { id: 'search-highlights', category: 'Проводник', category_en: 'Explorer', os: '11',
    title: 'Search Highlights в поиске',
    title_en: 'Search Highlights',
    description: 'Показывает промо-контент и «интересные факты» в панели поиска (Windows 11).',
    description_en: 'Shows promotional content and "fun facts" in the search panel (Windows 11).',
    impact: 'Панель поиска станет чище и будет открываться немного быстрее.',
    impact_en: 'The search panel will be cleaner and open slightly faster.',
    enableCmd: `Remove-ItemProperty -Path 'HKCU:\\Software\\Policies\\Microsoft\\Windows\\Explorer' -Name 'DisableSearchBoxSuggestions' -ErrorAction SilentlyContinue`,
    disableCmd: `New-Item -Path 'HKCU:\\Software\\Policies\\Microsoft\\Windows\\Explorer' -Force | Out-Null; Set-ItemProperty -Path 'HKCU:\\Software\\Policies\\Microsoft\\Windows\\Explorer' -Name 'DisableSearchBoxSuggestions' -Type DWord -Value 1`,
    previewKind: 'text' },
  { id: 'widgets-taskbar', category: 'Проводник', category_en: 'Explorer', os: '11',
    title: 'Виджеты на панели задач',
    title_en: 'Taskbar Widgets',
    description: 'Кнопка новостей и погоды слева на панели задач (Windows 11).',
    description_en: 'News and weather button on the left of the taskbar (Windows 11).',
    impact: 'Убирает иконку виджетов with панели задач и фоновую подгрузку новостей.',
    impact_en: 'Removes the widgets icon from the taskbar and background news loading.',
    enableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced' -Name 'TaskbarDa' -Type DWord -Value 1`,
    disableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced' -Name 'TaskbarDa' -Type DWord -Value 0`,
    previewKind: 'anim' },
  { id: 'chat-icon-taskbar', category: 'Проводник', category_en: 'Explorer', os: '11',
    title: 'Иконка «Чат» (Teams) на панели задач',
    title_en: 'Chat Icon (Teams)',
    description: 'Встроенная кнопка быстрого чата Teams (Windows 11).',
    description_en: 'Built-in Teams quick chat button (Windows 11).',
    impact: 'Убирает иконку чата with панели задач.',
    impact_en: 'Removes the chat icon from the taskbar.',
    enableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced' -Name 'TaskbarMn' -Type DWord -Value 1`,
    disableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced' -Name 'TaskbarMn' -Type DWord -Value 0`,
    previewKind: 'anim' },
  { id: 'classic-context-menu', category: 'Проводник', category_en: 'Explorer', os: '11',
    title: 'Классическое контекстное меню',
    title_en: 'Classic Context Menu',
    description: 'Windows 11 по умолчанию показывает урезанное контекстное меню with пунктом «Показать больше опций».',
    description_en: 'Windows 11 shows a limited context menu with "Show more options" by default.',
    impact: 'Правый клик сразу покажет полное меню, как в Windows 10.',
    impact_en: 'Right-click will immediately show the full menu, like in Windows 10.',
    enableCmd: `Remove-Item -Path 'HKCU:\\Software\\Classes\\CLSID\\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}\\InprocServer32' -Recurse -Force -ErrorAction SilentlyContinue`,
    disableCmd: `New-Item -Path 'HKCU:\\Software\\Classes\\CLSID\\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}\\InprocServer32' -Force | Out-Null; Set-ItemProperty -Path 'HKCU:\\Software\\Classes\\CLSID\\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}\\InprocServer32' -Name '(Default)' -Type String -Value ''`,
    previewKind: 'anim' },
  { id: 'taskbar-align-left', category: 'Проводник', category_en: 'Explorer', os: '11',
    title: 'Панель задач по левому краю',
    title_en: 'Left-Aligned Taskbar',
    description: 'Windows 11 по умолчанию центрирует значки панели задач.',
    description_en: 'Windows 11 centers taskbar icons by default.',
    impact: 'Значки на панели задач перестроятся к левому краю, как в Windows 10.',
    impact_en: 'Taskbar icons will align to the left, like in Windows 10.',
    enableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced' -Name 'TaskbarAl' -Type DWord -Value 1`,
    disableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced' -Name 'TaskbarAl' -Type DWord -Value 0`,
    previewKind: 'anim' },
  { id: 'taskview-button', category: 'Проводник', category_en: 'Explorer', os: 'all',
    title: 'Кнопка «Представление задач»',
    title_en: 'Task View Button',
    description: 'Кнопка переключения между виртуальными рабочими столами на панели задач.',
    description_en: 'Taskbar button for switching between virtual desktops.',
    impact: 'Убирает кнопку with панели задач (сочетание клавиш Win+Tab продолжит работать).',
    impact_en: 'Removes the button from the taskbar (Win+Tab shortcut will still work).',
    enableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced' -Name 'ShowTaskViewButton' -Type DWord -Value 1`,
    disableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced' -Name 'ShowTaskViewButton' -Type DWord -Value 0`,
    previewKind: 'anim' },
  { id: 'news-and-interests', category: 'Проводник', category_en: 'Explorer', os: '10',
    title: 'Новости и интересы',
    title_en: 'News and Interests',
    description: 'Виджет новостей и погоды на панели задач в поздних версиях Windows 10.',
    description_en: 'News and weather widget on the taskbar in later versions of Windows 10.',
    impact: 'Убирает виджет и связанную with ним фоновую подгрузку контента.',
    impact_en: 'Removes the widget and associated background content loading.',
    enableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Feeds' -Name 'ShellFeedsTaskbarViewMode' -Type DWord -Value 0`,
    disableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Feeds' -Name 'ShellFeedsTaskbarViewMode' -Type DWord -Value 2`,
    previewKind: 'anim' },

  // ---------- Уведомления и центр поддержки ----------
  { id: 'notifications-tips', category: 'Уведомления', category_en: 'Notifications', os: 'all',
    title: 'Советы и рекомендации Windows',
    title_en: 'Windows Tips and Tricks',
    description: 'Всплывающие подсказки об использовании функций системы.',
    description_en: 'Pop-up tips about using system features.',
    impact: 'Меньше отвлекающих уведомлений «Знаете ли вы...».',
    impact_en: 'Fewer distracting "Did you know..." notifications.',
    enableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager' -Name 'SoftLandingEnabled' -Type DWord -Value 1`,
    disableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager' -Name 'SoftLandingEnabled' -Type DWord -Value 0`,
    previewKind: 'text' },
  { id: 'lockscreen-tips', category: 'Уведомления', category_en: 'Notifications', os: 'all',
    title: 'Факты и советы на экране блокировки',
    title_en: 'Lock Screen Facts and Tips',
    description: 'Реклама функций и приложений поверх экрана блокировки.',
    description_en: 'Ads for features and apps over the lock screen.',
    impact: 'Экран блокировки станет чище, без всплывающих советов.',
    impact_en: 'The lock screen will be cleaner, without pop-up tips.',
    enableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager' -Name 'RotatingLockScreenOverlayEnabled' -Type DWord -Value 1`,
    disableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager' -Name 'RotatingLockScreenOverlayEnabled' -Type DWord -Value 0`,
    previewKind: 'text' },
  { id: 'suggested-apps', category: 'Уведомления', category_en: 'Notifications', os: 'all',
    title: 'Рекомендованные приложения в меню Пуск',
    title_en: 'Suggested Apps in Start Menu',
    description: 'Microsoft показывает предложения установить сторонние приложения в меню Пуск.',
    description_en: 'Microsoft shows suggestions to install third-party apps in the Start menu.',
    impact: 'Меню Пуск больше не будет предлагать установить сторонние приложения.',
    impact_en: 'The Start menu will no longer suggest installing third-party apps.',
    enableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager' -Name 'SilentInstalledAppsEnabled' -Type DWord -Value 1`,
    disableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager' -Name 'SilentInstalledAppsEnabled' -Type DWord -Value 0`,
    previewKind: 'text' },
  { id: 'focus-assist-auto', category: 'Уведомления', category_en: 'Notifications', os: 'all',
    title: 'Автоматический режим "Фокусировка внимания" в играх',
    title_en: 'Automatic Focus Assist in Games',
    description: 'Автоматически включает беззвучный режим уведомлений при запуске игр в полноэкранном режиме.',
    description_en: 'Automatically enables silent notification mode when running games in fullscreen.',
    impact: 'Уведомления не будут прерывать вас во время игр.',
    impact_en: 'Notifications will not interrupt you during games.',
    enableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\CloudStore\\Store\\Cache\\DefaultAccount\\Current\\windows.data.notifications.quiethourssettings\\Current' -Name 'Data' -ErrorAction SilentlyContinue`,
    disableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\CloudStore\\Store\\Cache\\DefaultAccount\\Current\\windows.data.notifications.quiethourssettings\\Current' -Name 'Data' -ErrorAction SilentlyContinue`,
    previewKind: 'text' },

  // ---------- Питание ----------
  { id: 'power-plan-performance', category: 'Питание', category_en: 'Power', os: 'all',
    title: 'Схема электропитания «Высокая производительность»',
    title_en: 'High Performance Power Scheme',
    description: 'Переключает активную схему питания Windows на максимальную производительность вместо сбалансированной.',
    description_en: 'Switches the active Windows power plan to maximum performance instead of balanced.',
    impact: 'ЦП будет реже снижать частоту в простое - выше отклик системы, но больше энергопотребление и нагрев (на ноутбуке - короче автономная работа).',
    impact_en: 'CPU will lower frequency less often at idle - higher system responsiveness, but more power consumption and heat (shorter battery life on laptops).',
    enableCmd: `$p = powercfg -list | Select-String 'Высокая производительность|High performance' | ForEach-Object { ($_ -split '\\s+')[3] } | Select-Object -First 1; if (-not $p) { $p = (powercfg -duplicatescheme 8c5e7fda-e8bf-45a0-b970-a67e75d1a4d3 | Select-String '[0-9a-f-]{36}').Matches[0].Value }; powercfg -setactive $p`,
    disableCmd: `powercfg -setactive 381b4222-f694-41f0-9685-ff5bb260df2e`,
    previewKind: 'text' },
  { id: 'usb-power-saving', category: 'Питание', category_en: 'Power', os: 'all',
    title: 'Энергосбережение USB-портов',
    title_en: 'USB Port Power Saving',
    description: 'Windows может частично отключать питание USB-устройств для экономии энергии.',
    description_en: 'Windows can partially power down USB devices to save energy.',
    impact: 'USB-периферия (мышь, наушники, контроллеры) будет работать без микро-задержек на «пробуждение».',
    impact_en: 'USB peripherals (mouse, headphones, controllers) will work without micro-lags on "waking up".',
    enableCmd: `Get-CimInstance MSPower_DeviceEnable -Namespace root\\wmi | ForEach-Object { Set-CimInstance -InputObject $_ -Property @{Enable=$true} -ErrorAction SilentlyContinue }`,
    disableCmd: `Get-CimInstance MSPower_DeviceEnable -Namespace root\\wmi | ForEach-Object { Set-CimInstance -InputObject $_ -Property @{Enable=$false} -ErrorAction SilentlyContinue }`,
    previewKind: 'text' },

  // ---------- Безопасность и защита ----------
  { id: 'core-isolation-vbs', category: 'Безопасность', category_en: 'Security', os: 'all',
    title: 'Изоляция ядра / VBS (Memory Integrity)',
    title_en: 'Core Isolation / VBS (Memory Integrity)',
    description: 'Виртуализация на основе безопасности (Virtualization-Based Security) и целостность памяти.',
    description_en: 'Virtualization-Based Security (VBS) and memory integrity.',
    impact: 'В играх и приложениях with высокой нагрузкой на ЦП это иногда даёт заметный прирост FPS, но снижает защиту от части эксплойтов на уровне ядра. Требуется перезагрузка. Не рекомендуется отключать на рабочих/корпоративных ПК.',
    impact_en: 'In games and high-CPU load apps, this sometimes gives a noticeable FPS boost, but reduces protection from some kernel-level exploits. Reboot required. Not recommended to disable on work/corporate PCs.',
    requiresReboot: true,
    warning: true,
    enableCmd: `Set-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\DeviceGuard\\Scenarios\\HypervisorEnforcedCodeIntegrity' -Name 'Enabled' -Type DWord -Value 1 -ErrorAction Stop`,
    disableCmd: `New-Item -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\DeviceGuard\\Scenarios\\HypervisorEnforcedCodeIntegrity' -Force | Out-Null; Set-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\DeviceGuard\\Scenarios\\HypervisorEnforcedCodeIntegrity' -Name 'Enabled' -Type DWord -Value 0`,
    previewKind: 'text' },
  { id: 'hyper-v', category: 'Безопасность', category_en: 'Security', os: 'all',
    title: 'Hyper-V и платформа виртуализации',
    title_en: 'Hyper-V and Virtualization Platform',
    description: 'Гипервизор Windows, на котором также держатся WSL2, Windows Sandbox, часть VBS/Device Guard и виртуальные машины (Hyper-V, Docker Desktop в режиме WSL2/Hyper-V).',
    description_en: 'Windows hypervisor, which also supports WSL2, Windows Sandbox, part of VBS/Device Guard, and VMs.',
    impact: 'Отключение освобождает ЦП/ОЗУ от постоянно работающего гипервизора и в некоторых играх with античит-системами (VBS/HVCI) заметно поднимает FPS и стабильность. Требуется перезагрузка. Сломает виртуальные машины Hyper-V, WSL2 и Windows Sandbox — если вы ими пользуетесь, не отключайте.',
    impact_en: 'Disabling frees up CPU/RAM from the constantly running hypervisor and in some games with anti-cheat systems (VBS/HVCI) noticeably boosts FPS and stability. Reboot required. Will break Hyper-V VMs, WSL2, and Windows Sandbox.',
    requiresReboot: true,
    warning: true,
    enableCmd: `bcdedit /set hypervisorlaunchtype auto; Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -NoRestart -ErrorAction SilentlyContinue`,
    disableCmd: `bcdedit /set hypervisorlaunchtype off; Disable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -NoRestart -ErrorAction SilentlyContinue`,
    previewKind: 'text' },

  // ---------- Дополнительные твики ----------
  { id: 'aero-shake', category: 'Визуальные эффекты', category_en: 'Visual Effects', os: 'all',
    title: 'Aero Shake (тряска окна сворачивает остальные)',
    title_en: 'Aero Shake',
    description: 'Встряхивание окна мышью за заголовок автоматически сворачивает все остальные открытые окна.',
    description_en: 'Shaking a window with the mouse minimizes all other open windows.',
    impact: 'Убирает случайные неожиданные сворачивания окон при перетаскивании - на слабом железе также чуть меньше фоновой обработки жестов мыши.',
    impact_en: 'Prevents accidental window minimization while dragging - also slightly less background processing of mouse gestures on weak hardware.',
    enableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced' -Name 'DisallowShaking' -Type DWord -Value 0`,
    disableCmd: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced' -Name 'DisallowShaking' -Type DWord -Value 1`,
    previewKind: 'anim' },
  { id: 'gamedvr-background', category: 'Игры', category_en: 'Games', os: 'all',
    title: 'Фоновая запись игр (Game DVR)',
    title_en: 'Background Game Recording (Game DVR)',
    description: 'Xbox Game Bar в фоне постоянно буферизует последние минуты игры для функции "Записать последние 30 секунд".',
    description_en: 'Xbox Game Bar constantly buffers the last few minutes of gameplay for the "Record last 30 seconds" feature.',
    impact: 'Освобождает ЦП, память и запись на диск во время игры - особенно заметно на слабых накопителях (HDD).',
    impact_en: 'Frees up CPU, memory, and disk writing during gaming - especially noticeable on slow drives (HDD).',
    enableCmd: `Set-ItemProperty -Path 'HKCU:\\System\\GameConfigStore' -Name 'GameDVR_Enabled' -Type DWord -Value 1; New-Item -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR' -Force | Out-Null; Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR' -Name 'AppCaptureEnabled' -Type DWord -Value 1`,
    disableCmd: `Set-ItemProperty -Path 'HKCU:\\System\\GameConfigStore' -Name 'GameDVR_Enabled' -Type DWord -Value 0; New-Item -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR' -Force | Out-Null; Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR' -Name 'AppCaptureEnabled' -Type DWord -Value 0`,
    previewKind: 'text' },
  { id: 'dynamic-tick-hpet', category: 'Игры', category_en: 'Games', os: 'all',
    title: 'Динамический системный таймер (Dynamic Tick / HPET)',
    title_en: 'Dynamic System Timer (Dynamic Tick / HPET)',
    description: 'Windows умеет "засыпать" системный таймер между прерываниями для экономии энергии на простое (Dynamic Tick), а также может использовать менее точный аппаратный таймер платформы.',
    description_en: 'Windows can "sleep" the system timer between interrupts to save energy during idle (Dynamic Tick).',
    impact: 'Отключение динамического тика и переход на платформенный TSC-таймер делают тайминг кадров ровнее в некоторых играх (меньше микрофризов), но немного повышают энергопотребление в простое. Требуется перезагрузка.',
    impact_en: 'Disabling dynamic tick and using the platform TSC timer makes frame timing smoother in some games (fewer micro-stutters), but slightly increases idle power consumption. Reboot required.',
    requiresReboot: true,
    enableCmd: `bcdedit /set disabledynamictick no; bcdedit /deletevalue useplatformclock`,
    disableCmd: `bcdedit /set disabledynamictick yes; bcdedit /set useplatformclock false`,
    previewKind: 'text' },
  { id: 'mmcss-games-priority', category: 'Игры', category_en: 'Games', os: 'all',
    title: 'Приоритет игр в MMCSS (System Responsiveness)',
    title_en: 'MMCSS Games Priority (System Responsiveness)',
    description: 'Мультимедийный планировщик Windows (MMCSS) резервирует часть ЦП под системные задачи вместо игр (System Responsiveness = 20%).',
    description_en: 'Windows Multimedia Class Scheduler (MMCSS) reserves part of the CPU for system tasks instead of games.',
    impact: 'Обнуляет системную резервацию и поднимает приоритет задачи "Games" в MMCSS до максимума - процессу активной игры достаётся больше процессорного времени и приоритет GPU-планировщика.',
    impact_en: 'Sets system reservation to zero and raises the priority of the "Games" task in MMCSS to maximum - giving the active game more CPU time and GPU scheduler priority.',
    enableCmd: `Set-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile' -Name 'SystemResponsiveness' -Type DWord -Value 20; Set-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\Tasks\\Games' -Name 'GPU Priority' -Type DWord -Value 8 -ErrorAction SilentlyContinue; Set-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\Tasks\\Games' -Name 'Priority' -Type DWord -Value 6 -ErrorAction SilentlyContinue; Set-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\Tasks\\Games' -Name 'Scheduling Category' -Type String -Value 'Medium' -ErrorAction SilentlyContinue`,
    disableCmd: `Set-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile' -Name 'SystemResponsiveness' -Type DWord -Value 0; New-Item -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\Tasks\\Games' -Force | Out-Null; Set-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\Tasks\\Games' -Name 'GPU Priority' -Type DWord -Value 8; Set-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\Tasks\\Games' -Name 'Priority' -Type DWord -Value 8; Set-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\Tasks\\Games' -Name 'Scheduling Category' -Type String -Value 'High'`,
    previewKind: 'text' },
  { id: 'ssd-trim', category: 'Диск', category_en: 'Disk', os: 'all',
    title: 'TRIM для SSD',
    title_en: 'SSD TRIM',
    description: 'Автоматическая очистка неиспользуемых блоков памяти на твердотельных накопителях.',
    description_en: 'Automatic cleaning of unused memory blocks on solid state drives.',
    impact: 'Поддерживает скорость записи SSD на прежнем уровне со временем. На HDD никакого эффекта не даёт - можете не трогать этот пункт, если у вас только HDD.',
    impact_en: 'Maintains SSD write speed over time. Has no effect on HDD.',
    enableCmd: `fsutil behavior set DisableDeleteNotify 0`,
    disableCmd: `fsutil behavior set DisableDeleteNotify 1`,
    previewKind: 'text' },
  { id: 'shutdown-timeout', category: 'Питание', category_en: 'Power', os: 'all',
    title: 'Быстрое завершение зависших приложений и служб',
    title_en: 'Fast Shutdown of Hung Apps',
    description: 'Сколько система по умолчанию ждёт зависшую службу/приложение перед принудительным закрытием при завершении работы.',
    description_en: 'How long the system waits for a hung service/app before force closing on shutdown.',
    impact: 'Выключение и перезагрузка компьютера станут заметно быстрее, если что-то зависает при закрытии - таймаут уменьшается с 5 до 2 секунд.',
    impact_en: 'Shutdown and restart will be noticeably faster if something hangs - timeout reduced from 5 to 2 seconds.',
    enableCmd: `Set-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control' -Name 'WaitToKillServiceTimeout' -Type String -Value '5000'; Set-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop' -Name 'HungAppTimeout' -Type String -Value '5000'`,
    disableCmd: `Set-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control' -Name 'WaitToKillServiceTimeout' -Type String -Value '2000'; Set-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop' -Name 'HungAppTimeout' -Type String -Value '2000'`,
    previewKind: 'text' },
  { id: 'cpu-core-parking', category: 'Питание', category_en: 'Power', os: 'all',
    title: 'Парковка ядер процессора (Core Parking)',
    title_en: 'CPU Core Parking',
    description: 'Windows умеет временно "усыплять" неиспользуемые ядра ЦП для экономии энергии.',
    description_en: 'Windows can temporarily "sleep" unused CPU cores to save energy.',
    impact: 'Отключение парковки держит все ядра постоянно активными - быстрее реакция на резкие скачки нагрузки (игры, рендеринг), но выше энергопотребление и нагрев.',
    impact_en: 'Disabling parking keeps all cores active - faster reaction to load spikes, but higher power/heat.',
    enableCmd: `powercfg -setacvalueindex scheme_current sub_processor 0cc5b647-c1df-4637-891a-dec35c318583 0; powercfg -setactive scheme_current`,
    disableCmd: `powercfg -setacvalueindex scheme_current sub_processor 0cc5b647-c1df-4637-891a-dec35c318583 100; powercfg -setactive scheme_current`,
    previewKind: 'text' },
  { id: 'nic-power-management', category: 'Сеть', category_en: 'Network', os: 'all',
    title: 'Энергосбережение сетевого адаптера',
    title_en: 'Network Adapter Power Management',
    description: 'Windows может частично отключать питание сетевой карты для экономии энергии.',
    description_en: 'Windows can partially power down the network card to save energy.',
    impact: 'Отключение энергосбережения адаптера убирает микро-задержки/просадки пинга при "пробуждении" сетевой карты - полезно для игр и звонков.',
    impact_en: 'Disabling adapter power saving removes micro-lags/ping drops on network card "wakeup".',
    enableCmd: `Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | Enable-NetAdapterPowerManagement -Confirm:$false -ErrorAction SilentlyContinue`,
    disableCmd: `Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | Disable-NetAdapterPowerManagement -Confirm:$false -ErrorAction SilentlyContinue`,
    previewKind: 'text' },

  // ---------- Производительность и железо ----------
  { id: 'pagefile-auto-optimal', category: 'Производительность и железо', category_en: 'Performance & Hardware', os: 'all',
    title: 'Размер файла подкачки под объём RAM',
    title_en: 'Optimal Page File Size',
    description: 'По умолчанию Windows сама подбирает размер файла подкачки (pagefile.sys), иногда неоптимально.',
    description_en: 'By default, Windows selects the page file size, sometimes suboptimally.',
    impact: 'Задаёт управляемый размер (от объёма ОЗУ до x2) вместо системного автоуправления - реже случаются просадки при нехватке памяти на играх/тяжёлых приложениях. Требуется перезагрузка.',
    impact_en: 'Sets a managed size (from RAM size to x2) - fewer stutters during memory shortages in games. Reboot required.',
    requiresReboot: true,
    enableCmd: `$ramMb = [int]((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1MB); $min = $ramMb; $max = $ramMb * 2; $cs = Get-CimInstance Win32_ComputerSystem; Set-CimInstance -InputObject $cs -Property @{ AutomaticManagedPagefile = $false }; $pf = Get-CimInstance Win32_PageFileSetting; if ($pf) { Set-CimInstance -InputObject $pf -Property @{ InitialSize = $min; MaximumSize = $max } } else { New-CimInstance -ClassName Win32_PageFileSetting -Property @{ Name = 'C:\\pagefile.sys'; InitialSize = $min; MaximumSize = $max } | Out-Null }`,
    disableCmd: `$cs = Get-CimInstance Win32_ComputerSystem; Set-CimInstance -InputObject $cs -Property @{ AutomaticManagedPagefile = $true }`,
    previewKind: 'text' },
  { id: 'auto-end-tasks', category: 'Производительность и железо', category_en: 'Performance & Hardware', os: 'all',
    title: 'Автозавершение зависших ("Не отвечает") программ',
    title_en: 'Auto-End Non-Responding Programs',
    description: 'Windows по умолчанию ждёт вашего решения, если приложение перестало отвечать, вместо того чтобы закрыть его самостоятельно.',
    description_en: 'Windows waits for your input when an app stops responding instead of closing it automatically.',
    impact: 'Зависшие процессы будут закрываться автоматически примерно через 2 секунды вместо ожидания - меньше "звонящих" зависших окон, особенно при выходе из игр.',
    impact_en: 'Hung processes will close automatically after ~2 seconds - fewer frozen windows, especially when exiting games.',
    enableCmd: `Set-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop' -Name 'AutoEndTasks' -Type String -Value '1'; Set-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop' -Name 'WaitToKillAppTimeout' -Type String -Value '2000'`,
    disableCmd: `Set-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop' -Name 'AutoEndTasks' -Type String -Value '0'; Set-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop' -Name 'WaitToKillAppTimeout' -Type String -Value '5000'`,
    previewKind: 'text' },
];

ipcMain.handle('tweaks:list', (event, lang = 'ru') => {
  const { windowsVersion } = getOsInfo();
  return TWEAKS
    .filter((t) => t.os === 'all' || t.os === windowsVersion || !windowsVersion)
    .map((t) => ({
      id: t.id,
      category: lang === 'en' ? (t.category_en || t.category) : t.category,
      os: t.os,
      title: lang === 'en' ? (t.title_en || t.title) : t.title,
      description: lang === 'en' ? (t.description_en || t.description) : t.description,
      impact: lang === 'en' ? (t.impact_en || t.impact) : t.impact,
      previewKind: t.previewKind,
    }));
});

// =====================================================================
// "БЫСТРЫЕ ДЕЙСТВИЯ" (Производительность и железо) - разовые операции,
// а не переключаемые твики: очистка ОЗУ, перезапуск Проводника, тест
// скорости диска. У них нет постоянного состояния "включено/выключено".
// =====================================================================
ipcMain.handle('quickActions:emptyStandbyList', async () => {
  if (process.platform !== 'win32') return { ok: false, message: 'Доступно только в Windows' };
  const cmd = `
    $sig = @'
using System;
using System.Runtime.InteropServices;
public class FyLightMemPurge {
  [DllImport("ntdll.dll")]
  public static extern int NtSetSystemInformation(int SystemInformationClass, IntPtr SystemInformation, int SystemInformationLength);
}
'@
    Add-Type -TypeDefinition $sig -ErrorAction Stop
    $ptr = [Runtime.InteropServices.Marshal]::AllocHGlobal(4)
    [Runtime.InteropServices.Marshal]::WriteInt32($ptr, 4)
    $res = [FyLightMemPurge]::NtSetSystemInformation(80, $ptr, 4)
    [Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)
    Write-Output "code:$res"
  `;
  const r = await runPowerShell(cmd, 15000);
  const okCall = r.ok && /code:0/.test(r.stdout);
  return {
    ok: okCall,
    message: okCall
      ? 'Список ожидания ОЗУ (Standby List) очищен - память освобождена без закрытия программ.'
      : 'Не удалось очистить память - требуются права администратора.',
  };
});

ipcMain.handle('quickActions:restartExplorer', async () => {
  if (process.platform !== 'win32') return { ok: false, message: 'Доступно только в Windows' };
  const cmd = `
    Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 700
    if (-not (Get-Process -Name explorer -ErrorAction SilentlyContinue)) { Start-Process explorer.exe }
    Write-Output 'ok'
  `;
  const r = await runPowerShell(cmd, 15000);
  return {
    ok: r.ok,
    message: r.ok ? 'Проводник (Explorer.exe) перезапущен.' : 'Не удалось перезапустить Проводник.',
  };
});

ipcMain.handle('quickActions:diskBenchmark', async () => {
  if (process.platform !== 'win32') return { ok: false, message: 'Доступно только в Windows' };
  const cmd = `
    $path = Join-Path $env:TEMP 'fylight_bench.tmp'
    $sizeMb = 256
    $data = New-Object byte[] ($sizeMb * 1MB)
    (New-Object Random).NextBytes($data)
    $sw = [Diagnostics.Stopwatch]::StartNew()
    [IO.File]::WriteAllBytes($path, $data)
    $sw.Stop()
    $writeMBps = [math]::Round($sizeMb / $sw.Elapsed.TotalSeconds, 1)
    $sw2 = [Diagnostics.Stopwatch]::StartNew()
    $read = [IO.File]::ReadAllBytes($path)
    $sw2.Stop()
    $readMBps = [math]::Round($sizeMb / $sw2.Elapsed.TotalSeconds, 1)
    Remove-Item $path -Force -ErrorAction SilentlyContinue
    Write-Output "WRITE:$writeMBps;READ:$readMBps"
  `;
  const r = await runPowerShell(cmd, 30000);
  const m = r.ok && r.stdout.match(/WRITE:([\d.]+);READ:([\d.]+)/);
  if (!m) return { ok: false, message: 'Не удалось выполнить тест диска.' };
  return {
    ok: true,
    writeMBps: Number(m[1]),
    readMBps: Number(m[2]),
    message: `Запись: ~${m[1]} МБ/с, чтение: ~${m[2]} МБ/с (приблизительно, с учётом кэша ОС).`,
  };
});

ipcMain.handle('tweaks:getStatus', async () => {
  // Определить текущее состояние каждого твика читать по одному было бы
  // слишком долго - приложение считает состояние "неизвестно" и полагается
  // на выбор пользователя в текущей сессии.
  return {};
});

ipcMain.handle('tweaks:apply', async (_event, items) => {
  if (process.platform !== 'win32') {
    return (items || []).map((it) => ({ id: it.id, ok: false, message: 'Доступно только в Windows' }));
  }
  const results = [];
  for (const it of items || []) {
    const tweak = TWEAKS.find((t) => t.id === it.id);
    if (!tweak) {
      results.push({ id: it.id, ok: false, message: 'Неизвестная оптимизация' });
      continue;
    }
    const cmd = it.enable ? tweak.enableCmd : tweak.disableCmd;
    const r = await runPowerShell(cmd);
    results.push({
      id: it.id,
      ok: r.ok,
      message: r.ok ? 'Применено' : (r.stderr ? r.stderr.split('\n')[0] : 'Требуются права администратора'),
      requiresReboot: !!tweak.requiresReboot,
    });
  }
  return results;
});

// =====================================================================
// ИГРОВЫЕ ПРОФИЛИ ("Ускорение" -> вкладка "Игры")
// Для каждой игры применяется общий набор открытых системных твиков
// (Game Bar/DVR, полноэкранные оптимизации, питание, сеть, MMCSS) плюс
// приоритет процесса, если игра уже запущена в момент применения.
// Никакой игро-специфичной "магии реестра под конкретный патч" не
// существует на практике - у всех современных игр это одни и те же
// системные точки оптимизации, поэтому список общий для всех профилей.
// =====================================================================
const GAME_CATALOG = [
  { id: 'cs2', name: 'Counter-Strike 2', processNames: ['cs2'], color: '#e0a72c', steamAppId: 730 },
  { id: 'valorant', name: 'Valorant', processNames: ['VALORANT-Win64-Shipping', 'RiotClientServices'], color: '#ff4655', steamAppId: null },
  { id: 'dota2', name: 'Dota 2', processNames: ['dota2'], color: '#c23c2a', steamAppId: 570 },
  { id: 'fortnite', name: 'Fortnite', processNames: ['FortniteClient-Win64-Shipping'], color: '#8e5ee0', steamAppId: null },
  { id: 'apex', name: 'Apex Legends', processNames: ['r5apex'], color: '#da3743', steamAppId: 1172470 },
  { id: 'pubg', name: 'PUBG: Battlegrounds', processNames: ['TslGame'], color: '#e2b13c', steamAppId: 578080 },
  { id: 'warzone', name: 'Call of Duty: Warzone', processNames: ['cod', 'ModernWarfare'], color: '#4c5a63', steamAppId: null },
  { id: 'gta5', name: 'GTA V', processNames: ['GTA5'], color: '#3ba55d', steamAppId: 271590 },
  { id: 'r6siege', name: 'Rainbow Six Siege', processNames: ['RainbowSix'], color: '#2b2f36', steamAppId: 359550 },
  { id: 'overwatch2', name: 'Overwatch 2', processNames: ['Overwatch'], color: '#f79b1b', steamAppId: null },
  { id: 'minecraft', name: 'Minecraft (Java/Bedrock)', processNames: ['javaw', 'Minecraft.Windows'], color: '#5c8a3a', steamAppId: null },
  { id: 'rust', name: 'Rust', processNames: ['RustClient'], color: '#a05a2c', steamAppId: 252490 },
];

// Обложка берётся из официального CDN Steam по appid (тот же подход,
// что используют открытые библиотеки игр вроде Playnite) - никакой
// генерации или копирования чужой графики, просто ссылка на официальное
// изображение.
function gameCoverUrl(steamAppId) {
  return steamAppId ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${steamAppId}/header.jpg` : null;
}

// Игры без страницы в Steam (Valorant, Fortnite, Warzone, Overwatch 2,
// Minecraft) не получают загруженную обложку - для них рендерер сам рисует
// цветную заглушку с буквой (см. build/game-карточки в index.html).
ipcMain.handle('games:list', async () => {
  const list = GAME_CATALOG.map((g) => ({
    id: g.id,
    name: g.name,
    color: g.color,
    cover: gameCoverUrl(g.steamAppId),
  }));
  return list;
});

// Общий пакет твиков, применяемых для каждой выбранной игры - переиспользует
// те же самые enable/disable-команды, что и обычные твики из TWEAKS, чтобы
// не дублировать логику и всегда оставаться в актуальном состоянии с ними.
const GAME_BUNDLE_TWEAK_IDS = [
  'game-bar', 'gamedvr-background', 'fullscreen-optimizations', 'mouse-acceleration',
  'gpu-hw-scheduling', 'power-plan-performance', 'net-nagle', 'net-throttling',
  'nic-power-management', 'mmcss-games-priority',
];

// =====================================================================
// "ИГРОВОЙ РЕЖИМ": закрытие фоновых приложений
// Закрываем только процессы с видимым окном (MainWindowHandle != 0) -
// это обычные пользовательские программы, а не системные службы, поэтому
// риск что-то сломать в самой ОС минимален. Никогда не трогаем сам
// процесс fyLight, процессы выбранных игр и явный белый список ниже.
// Белый список подобран по запросу пользователя: запись/стрим (OBS),
// музыка (чтобы не прерывался плеер) и браузеры (чтобы можно было
// оставить открытым YouTube/чат) остаются работать.
// =====================================================================
const GAME_MODE_WHITELIST = [
  // запись/стрим
  'obs64', 'obs32', 'obs',
  // музыка
  'spotify', 'aimp', 'foobar2000', 'itunes', 'ituneshelper', 'musicbee',
  'winamp', 'yandexmusic', 'deezer', 'wmplayer', 'vlc',
  // браузеры (чтобы оставался доступен YouTube и т.п.)
  'chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi',
  // голосовая связь во время игры
  'discord',
];

// Критические системные процессы, которые нельзя закрывать в любом случае
// (даже если у них почему-то оказалось видимое окно).
const GAME_MODE_NEVER_KILL = [
  'explorer', 'svchost', 'system', 'csrss', 'wininit', 'winlogon', 'services',
  'lsass', 'dwm', 'smss', 'spoolsv', 'sihost', 'shellexperiencehost',
  'startmenuexperiencehost', 'securityhealthservice', 'msmpeng', 'audiodg',
  'textinputhost', 'ctfmon', 'runtimebroker', 'searchindexer', 'fontdrvhost',
  'electron', 'fylight',
];

async function closeBackgroundAppsForGameMode(extraKeepProcessNames = []) {
  const keep = new Set(
    [...GAME_MODE_WHITELIST, ...GAME_MODE_NEVER_KILL, ...extraKeepProcessNames]
      .map((n) => n.toLowerCase())
  );
  const keepList = Array.from(keep).map((n) => `'${n}'`).join(', ');
  const cmd = `
    $keep = @(${keepList})
    Get-Process | Where-Object {
      $_.MainWindowHandle -ne 0 -and $_.Id -ne $PID -and ($keep -notcontains $_.ProcessName.ToLower())
    } | ForEach-Object {
      try { Stop-Process -Id $_.Id -Force -ErrorAction Stop; $_.ProcessName } catch {}
    }
  `;
  const r = await runPowerShell(cmd);
  const closed = r.ok ? r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
  return { ok: r.ok, closed };
}

ipcMain.handle('games:optimize', async (_event, ids, options) => {
  if (process.platform !== 'win32') {
    return (ids || []).map((id) => ({ id, ok: false, message: 'Доступно только в Windows' }));
  }
  const results = [];

  // Системные твики применяем один раз суммарно (они не зависят от игры),
  // а не по разу на каждую выбранную игру.
  for (const tweakId of GAME_BUNDLE_TWEAK_IDS) {
    const tweak = TWEAKS.find((t) => t.id === tweakId);
    if (!tweak) continue;
    const r = await runPowerShell(tweak.disableCmd);
    results.push({
      id: `_system:${tweakId}`,
      ok: r.ok,
      message: `${tweak.title}: ${r.ok ? 'применено' : 'ошибка'}`,
    });
  }

  if (options && options.closeBackgroundApps) {
    const selectedGameProcessNames = (ids || [])
      .flatMap((id) => (GAME_CATALOG.find((g) => g.id === id)?.processNames || []))
      .map((p) => p.toLowerCase());
    const { ok, closed } = await closeBackgroundAppsForGameMode(selectedGameProcessNames);
    results.push({
      id: '_system:close-background',
      ok,
      message: ok
        ? (closed.length
          ? `Игровой режим: закрыто фоновых окон — ${closed.length} (${closed.join(', ')})`
          : 'Игровой режим: посторонних фоновых окон не найдено')
        : 'Игровой режим: не удалось закрыть фоновые приложения',
    });
  }

  for (const id of ids || []) {
    const game = GAME_CATALOG.find((g) => g.id === id);
    if (!game) { results.push({ id, ok: false, message: 'Игра не найдена в списке' }); continue; }

    const processCheck = game.processNames
      .map((p) => `Get-Process -Name '${p}' -ErrorAction SilentlyContinue`)
      .join('; ');
    const priorityCmd = game.processNames
      .map((p) => `Get-Process -Name '${p}' -ErrorAction SilentlyContinue | ForEach-Object { $_.PriorityClass = 'High' }`)
      .join('; ');

    const isRunning = await runPowerShell(`if (@(${processCheck}) | Where-Object { $_ }) { Write-Output 'running' } else { Write-Output 'idle' }`);
    if (isRunning.ok && isRunning.stdout.includes('running')) {
      const r = await runPowerShell(priorityCmd);
      results.push({
        id,
        ok: r.ok,
        message: r.ok ? `${game.name}: процесс запущен - приоритет повышен до «Высокого»` : `${game.name}: не удалось изменить приоритет процесса`,
      });
    } else {
      results.push({
        id,
        ok: true,
        message: `${game.name}: системные твики применены. Приоритет процесса выставится автоматически при следующем применении, если запустить игру заранее.`,
      });
    }
  }

  writeLogFile('games-optimize.log', results.map((r) => `${r.ok ? '[OK]  ' : '[FAIL]'} ${r.id}: ${r.message}`));
  return results;
});

// =====================================================================
// ОЧИСТКА ВРЕМЕННЫХ ФАЙЛОВ И КЭША
// Безопасный набор: временные папки пользователя/системы, кэш миниатюр,
// корзина, старый кэш загрузок Windows Update. Файлы игр, документов и
// настроек программ не трогает.
// =====================================================================
ipcMain.handle('cleanup:run', async () => {
  if (process.platform !== 'win32') {
    return [{ id: 'cleanup', ok: false, message: 'Доступно только в Windows' }];
  }
  const steps = [
    { id: 'temp-user', title: 'Временные файлы пользователя (%TEMP%)',
      cmd: `Get-ChildItem -Path $env:TEMP -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue` },
    { id: 'temp-system', title: 'Системная папка C:\\Windows\\Temp',
      cmd: `Get-ChildItem -Path "$env:WINDIR\\Temp" -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue` },
    { id: 'thumb-cache', title: 'Кэш миниатюр проводника',
      cmd: `Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue; Remove-Item -Path "$env:LOCALAPPDATA\\Microsoft\\Windows\\Explorer\\thumbcache_*.db" -Force -ErrorAction SilentlyContinue; Start-Process explorer.exe` },
    { id: 'recycle-bin', title: 'Корзина',
      cmd: `Clear-RecycleBin -Force -ErrorAction SilentlyContinue` },
    { id: 'wu-cache', title: 'Старый кэш загрузок Windows Update',
      cmd: `Stop-Service -Name wuauserv -Force -ErrorAction SilentlyContinue; Get-ChildItem -Path "$env:WINDIR\\SoftwareDistribution\\Download" -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue; Start-Service -Name wuauserv -ErrorAction SilentlyContinue` },
    { id: 'dns-cache', title: 'Кэш DNS',
      cmd: `Clear-DnsClientCache -ErrorAction SilentlyContinue; ipconfig /flushdns` },
  ];
  const results = [];
  for (const step of steps) {
    const r = await runPowerShell(step.cmd, 30000);
    results.push({ id: step.id, ok: r.ok, message: `${step.title}: ${r.ok ? 'очищено' : 'пропущено (занято/недоступно)'}` });
  }
  return results;
});

// =====================================================================
// АВТОЗАГРУЗКА: массовое отключение (не удаление!) пунктов автозапуска
// Отключает записи через тот же механизм, что и "Отключить" в диспетчере
// задач (StartupApproved) - обратимо, ничего физически не удаляется.
// =====================================================================
ipcMain.handle('startup:disableAll', async () => {
  if (process.platform !== 'win32') return { ok: false, message: 'Доступно только в Windows', disabled: [] };
  const script = `
$ErrorAction = 'SilentlyContinue'
$disabled = @()
$runKeys = @(
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
)
$approvedKeys = @{
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run'
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run'
}
foreach ($key in $runKeys) {
  if (Test-Path $key) {
    $props = Get-Item -Path $key | Select-Object -ExpandProperty Property
    $approvedPath = $approvedKeys[$key]
    New-Item -Path $approvedPath -Force | Out-Null
    foreach ($name in $props) {
      New-ItemProperty -Path $approvedPath -Name $name -PropertyType Binary -Value ([byte[]](3,0,0,0,0,0,0,0,0,0,0,0)) -Force | Out-Null
      $disabled += $name
    }
  }
}
$disabled | ConvertTo-Json -Compress
`;
  const r = await runPowerShell(script, 15000);
  let disabled = [];
  try { disabled = JSON.parse(r.stdout.trim() || '[]'); if (!Array.isArray(disabled)) disabled = [disabled]; } catch { disabled = []; }
  return { ok: r.ok, message: r.ok ? `Отключено пунктов автозагрузки: ${disabled.length}` : 'Требуются права администратора', disabled };
});

// Плановая перезагрузка компьютера (используется после применения твиков,
// требующих перезагрузки, или по запросу пользователя). delaySeconds даёт
// пользователю время всё сохранить; отмена - через system:cancelRestart.
ipcMain.handle('system:scheduleRestart', (_event, delaySeconds = 15) => {
  if (process.platform !== 'win32') return { ok: false };
  try {
    execFile('shutdown', ['/r', '/t', String(Math.max(5, delaySeconds)), '/c', 'fyLight: применение изменений'], { windowsHide: true });
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

ipcMain.handle('system:cancelRestart', () => {
  if (process.platform !== 'win32') return { ok: false };
  try {
    execFile('shutdown', ['/a'], { windowsHide: true });
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

// =====================================================================
// УСТАНОВКА ПРИЛОЖЕНИЙ
// =====================================================================
const APP_CATALOG = [
  { id: 'steam', name: 'Steam', description: 'Игровая платформа Valve.', type: 'winget', wingetId: 'Valve.Steam' },
  { id: 'chrome', name: 'Google Chrome', description: 'Браузер от Google.', type: 'winget', wingetId: 'Google.Chrome' },
  { id: 'discord', name: 'Discord', description: 'Голосовой и текстовый чат для геймеров.', type: 'winget', wingetId: 'Discord.Discord' },
  { id: 'vlc', name: 'VLC Media Player', description: 'Универсальный видеоплеер.', type: 'winget', wingetId: 'VideoLAN.VLC' },
  { id: '7zip', name: '7-Zip', description: 'Архиватор с открытым исходным кодом.', type: 'winget', wingetId: '7zip.7zip' },
  {
    id: 'zapret', name: 'Zapret (сборка Flowseal)', description: 'Обход DPI-блокировок провайдера с GitHub.',
    type: 'github', repo: 'Flowseal/zapret-discord-youtube',
  },
];

ipcMain.handle('apps:list', () => APP_CATALOG.map(({ id, name, description, type }) => ({ id, name, description, type })));

// =====================================================================
// СБОРКИ ("Установка приложений" -> готовые наборы приложений)
// Куратор фиксированный (не серверный маркетплейс - приложение работает
// офлайн-first), плюс пользователь может собрать и сохранить свою сборку
// локально. Сборка - это просто именованный список id из APP_CATALOG.
// =====================================================================
// По умолчанию встроенных ("системных") сборок нет - раздел стартует
// пустым (0), и пользователь видит только то, что создал сам через
// buildsAPI.create. Кураторские наборы можно будет добавить сюда же
// в будущем, если понадобится - формат элемента такой же, как у
// пользовательской сборки (name/description/apps/tweaks).
const CURATED_BUILDS = [];

// =====================================================================
// СИНХРОНИЗАЦИЯ ПУБЛИЧНЫХ СБОРОК ЧЕРЕЗ FIREBASE REALTIME DATABASE
// =====================================================================
// Раньше был собственный HTTP-сервер (server/index.js) с адресом по
// умолчанию http://localhost:8787 - рабочий вариант, только если реально
// задеплоить его на публичный хостинг. Теперь вместо своего сервера
// используется бесплатный тариф Firebase (Spark) - публичный адрес есть
// сразу "из коробки", ничего разворачивать не нужно.
//
// Firebase Realtime Database сама по себе не проверяет "ownerToken" -
// это была логика нашего старого сервера. Вместо этого каждая установка
// fyLight один раз анонимно авторизуется в Firebase Authentication
// (accounts:signUp, без email/пароля - просто стабильный uid для этого
// компьютера) и дальше пишет в базу под этим uid. Правила безопасности
// базы (Realtime Database → Rules, задаются в консоли Firebase) разрешают
// менять/удалять сборку только тому uid, который её создал, а увеличивать
// views/installs - любому анонимному пользователю. Правила нужно один раз
// вставить в консоли Firebase, см. FIREBASE_RULES_JSON ниже (просто текст
// для копирования, в самом приложении не используется).
//
// Если Anonymous-провайдер не включён в Firebase (Authentication → Sign-in
// method → Anonymous) - авторизация не пройдёт, и приложение так же тихо
// откатится на локальный режим, как раньше при недоступном сервере.
const FIREBASE_API_KEY = process.env.FYLIGHT_FIREBASE_API_KEY || 'AIzaSyCxvRjulxqGoca8erTu-hBphCNCBAK5kc4';
const FIREBASE_DB_URL = (process.env.FYLIGHT_FIREBASE_DB_URL
  || 'https://fouchai-default-rtdb.europe-west1.firebasedatabase.app').replace(/\/$/, '');
const FIREBASE_SIGNUP_URL = `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`;
const FIREBASE_REFRESH_URL = `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`;
const POPULAR_VIEWS_THRESHOLD = 20; // от скольких просмотров сборка помечается "Популярное"

// Правила безопасности Realtime Database - вставить в консоли Firebase
// (Build → Realtime Database → Rules → вставить целиком → Publish).
// Не используется кодом напрямую, просто справочный текст для настройки.
const FIREBASE_RULES_JSON = `{
  "rules": {
    "builds": {
      ".read": true,
      "$id": {
        ".write": "!data.exists() || data.child('ownerUid').val() === auth.uid",
        ".validate": "newData.hasChildren(['id', 'name', 'ownerUid'])",
        "views": { ".write": "auth != null" },
        "installs": { ".write": "auth != null" }
      }
    }
  }
}`;

function requestJson(method, url, body, redirectCount = 0) {
  return new Promise((resolve) => {
    if (redirectCount > 5) {
      return resolve({ ok: false, message: 'Слишком много перенаправлений' });
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return resolve({ ok: false, message: 'Некорректный адрес сервера сборок' });
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    const payload = body ? JSON.stringify(body) : null;
    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'fyLight-app',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
        timeout: 8000,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(requestJson(method, res.headers.location, body, redirectCount + 1));
        }
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const json = data ? JSON.parse(data) : {};
            const isObj = json && typeof json === 'object';
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode,
              value: json,
              ...(isObj ? json : {}),
            });
          } catch {
            resolve({ ok: false, status: res.statusCode, message: 'Сервер сборок вернул неожиданный ответ' });
          }
        });
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', (e) => resolve({ ok: false, message: `Ошибка сети: ${e.message}` }));
    if (payload) req.write(payload);
    req.end();
  });
}

// Токен обновления (`grant_type=refresh_token`) в Firebase принимает только
// application/x-www-form-urlencoded, а не JSON - отдельный маленький
// хелпер вместо requestJson.
function requestForm(url, formObj) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const payload = Object.entries(formObj)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: 443,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 6000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, ...JSON.parse(data || '{}') });
          } catch {
            resolve({ ok: false });
          }
        });
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ ok: false }));
    req.write(payload);
    req.end();
  });
}

const firebaseAuthPath = path.join(app.getPath('userData'), 'firebase-auth.json');

function loadFirebaseAuth() {
  try {
    return JSON.parse(fs.readFileSync(firebaseAuthPath, 'utf-8'));
  } catch {
    return null;
  }
}

function saveFirebaseAuth(data) {
  try {
    fs.mkdirSync(path.dirname(firebaseAuthPath), { recursive: true });
    fs.writeFileSync(firebaseAuthPath, JSON.stringify(data), 'utf-8');
  } catch {
    // не критично - просто заново авторизуемся анонимно в следующий раз
  }
}

let cachedFirebaseAuth = null; // { idToken, uid }
let cachedFirebaseAuthExpiresAt = 0;

// Возвращает { idToken, uid } для текущей установки fyLight или null, если
// авторизация недоступна (нет сети, Anonymous-провайдер выключен и т.п.) -
// в этом случае публикация/синхронизация просто не происходит, как раньше
// при недоступном сервере.
async function ensureFirebaseAuth() {
  const now = Date.now();
  if (cachedFirebaseAuth && now < cachedFirebaseAuthExpiresAt - 60_000) {
    return cachedFirebaseAuth;
  }

  const saved = loadFirebaseAuth();
  if (saved?.refreshToken) {
    const res = await requestForm(FIREBASE_REFRESH_URL, {
      grant_type: 'refresh_token',
      refresh_token: saved.refreshToken,
    });
    if (res.ok && res.id_token) {
      cachedFirebaseAuth = { idToken: res.id_token, uid: res.user_id || saved.localId };
      cachedFirebaseAuthExpiresAt = now + Number(res.expires_in || 3600) * 1000;
      if (res.refresh_token && res.refresh_token !== saved.refreshToken) {
        saveFirebaseAuth({ localId: cachedFirebaseAuth.uid, refreshToken: res.refresh_token });
      }
      return cachedFirebaseAuth;
    }
  }

  // Нет сохранённого входа или обновление не удалось - заводим новую
  // анонимную "учётку" (просто уникальный uid от Google, без email/пароля).
  const signUpRes = await requestJson('POST', FIREBASE_SIGNUP_URL, { returnSecureToken: true });
  if (!signUpRes.ok || !signUpRes.idToken) return null;
  saveFirebaseAuth({ localId: signUpRes.localId, refreshToken: signUpRes.refreshToken });
  cachedFirebaseAuth = { idToken: signUpRes.idToken, uid: signUpRes.localId };
  cachedFirebaseAuthExpiresAt = now + Number(signUpRes.expiresIn || 3600) * 1000;
  return cachedFirebaseAuth;
}

function firebasePath(pathSegment, idToken) {
  return `${FIREBASE_DB_URL}${pathSegment}.json${idToken ? `?auth=${encodeURIComponent(idToken)}` : ''}`;
}

const buildsPath = path.join(app.getPath('userData'), 'builds.json');

function loadUserBuilds() {
  try {
    const raw = fs.readFileSync(buildsPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveUserBuilds(builds) {
  try {
    fs.mkdirSync(path.dirname(buildsPath), { recursive: true });
    fs.writeFileSync(buildsPath, JSON.stringify(builds, null, 2), 'utf-8');
  } catch {
    // если не удалось сохранить - сборка останется только в памяти рендерера
  }
}

// tweaks у сборки хранятся как массив {id, enable}, а не голых id - сверяем
// именно так, иначе (старый баг) фильтр никогда не находил совпадение и
// твики сборки тихо терялись при сохранении.
function sanitizeBuildTweaks(tweaks) {
  return Array.isArray(tweaks)
    ? tweaks
      .filter((t) => t && typeof t === 'object' && TWEAKS.some((tw) => tw.id === t.id))
      .map((t) => ({ id: t.id, enable: !!t.enable }))
    : [];
}

// Помимо id из APP_CATALOG, сборка может содержать "свои" пункты, не
// привязанные к каталогу winget/GitHub - просто именованная строка,
// которую видно в списке, но у которой нет автоустановки. Формат:
// "custom:<название>". Так пользователь может добавить в сборку то, чего
// нет в предустановленном списке.
function sanitizeBuildApps(apps) {
  if (!Array.isArray(apps)) return [];
  return apps
    .filter((id) => typeof id === 'string' && id.trim())
    .map((id) => (id.startsWith('custom:') ? `custom:${id.slice(7).trim().slice(0, 60)}` : id))
    .filter((id) => (id.startsWith('custom:') ? id.length > 'custom:'.length : APP_CATALOG.some((a) => a.id === id)));
}

const BUILD_ICONS = ['game', 'shield', 'brush', 'bolt', 'palette', 'desktop', 'globe', 'tools'];
function sanitizeBuildIcon(icon) {
  return typeof icon === 'string' && BUILD_ICONS.includes(icon) ? icon : '';
}

ipcMain.handle('builds:list', async () => {
  const user = loadUserBuilds().map((b) => ({
    isPublic: false,
    views: 0,
    installs: 0,
    ...b,
    author: b.author || 'Вы',
    mine: true,
  }));

  let community = [];
  try {
    const res = await requestJson('GET', firebasePath('/builds'));
    writeLogFile('builds.log', [`Fetch community builds: status=${res.status}, ok=${res.ok}`]);

    if (res.ok && res.value && typeof res.value === 'object') {
      const ownIds = new Set(user.map((b) => b.id));
      const allEntries = Object.entries(res.value);
      writeLogFile('builds.log', [`Fetched ${allEntries.length} items from Firebase.`]);

      community = allEntries
        .filter(([bid, b]) => b && typeof b === 'object' && !ownIds.has(bid))
        .map(([bid, b]) => ({
          id: bid,
          views: 0,
          installs: 0,
          ...b,
          isPublic: true,
          mine: false,
          community: true,
        }));
      writeLogFile('builds.log', [`Loaded ${community.length} items into community list (filtered out ${allEntries.length - community.length} own/invalid builds).`]);
    } else if (!res.ok) {
      writeLogFile('builds.log', [`Failed to fetch builds: ${res.message || 'Unknown error'}`]);
    }
  } catch (e) {
    writeLogFile('builds.log', [`Exception in builds:list: ${e.message}`]);
    community = [];
  }

  // Свои сборки выводим первыми, чтобы автор сразу видел результат публикации
  return [
    ...user,
    ...CURATED_BUILDS.map((b) => ({ isPublic: true, views: 0, installs: 0, ...b, mine: false })),
    ...community,
  ];
});

async function publishBuildToServer(build) {
  const auth = await ensureFirebaseAuth();
  if (!auth) {
    writeLogFile('builds.log', ['Auth failed: ensureFirebaseAuth returned null']);
    return { ok: false, message: 'Не удалось авторизоваться в Firebase' };
  }

  const existing = await requestJson('GET', firebasePath(`/builds/${encodeURIComponent(build.id)}`));
  const existingData = (existing.ok && existing.value && typeof existing.value === 'object') ? existing.value : null;

  if (existingData?.ownerUid && existingData.ownerUid !== auth.uid) {
    writeLogFile('builds.log', [`Permission denied for build ${build.id}: owned by ${existingData.ownerUid}`]);
    return { ok: false, message: 'Эта сборка принадлежит другому автору' };
  }

  const payload = {
    id: build.id,
    name: build.name,
    description: build.description || '',
    author: build.author || 'Аноним',
    apps: build.apps || [],
    tweaks: build.tweaks || [],
    icon: build.icon || '',
    ownerUid: auth.uid,
    views: existingData?.views || 0,
    installs: existingData?.installs || 0,
    createdAt: existingData?.createdAt || Date.now(),
    updatedAt: Date.now(),
  };

  const res = await requestJson('PUT', firebasePath(`/builds/${encodeURIComponent(build.id)}`, auth.idToken), payload);
  writeLogFile('builds.log', [`Publish ${build.id}: status=${res.status}, ok=${res.ok}`]);
  return res;
}

async function unpublishBuildFromServer(build) {
  const auth = await ensureFirebaseAuth();
  if (!auth) return { ok: false, message: 'Не удалось авторизоваться в Firebase' };
  return requestJson('DELETE', firebasePath(`/builds/${encodeURIComponent(build.id)}`, auth.idToken));
}

ipcMain.handle('builds:create', async (_event, { name, description, author, apps, tweaks, isPublic, icon }) => {
  const cleanName = String(name || '').trim().slice(0, 60);
  const cleanDescription = String(description || '').trim().slice(0, 300);
  const cleanAuthor = String(author || '').trim().slice(0, 40);
  const cleanApps = sanitizeBuildApps(apps);
  const cleanTweaks = sanitizeBuildTweaks(tweaks);
  const cleanIcon = sanitizeBuildIcon(icon);
  if (!cleanName || (!cleanApps.length && !cleanTweaks.length)) {
    return { ok: false, message: 'Укажите название и хотя бы одно приложение или оптимизацию' };
  }
  const builds = loadUserBuilds();
  const id = `user-${Date.now()}`;
  const parts = [];
  if (cleanApps.length) parts.push(`${cleanApps.length} прил.`);
  if (cleanTweaks.length) parts.push(`${cleanTweaks.length} оптим.`);
  const build = {
    id,
    name: cleanName,
    description: cleanDescription || `Своя сборка · ${parts.join(', ')}`,
    author: cleanAuthor || 'Вы',
    apps: cleanApps,
    tweaks: cleanTweaks,
    icon: cleanIcon,
    isPublic: !!isPublic,
    views: 0,
    installs: 0,
  };
  builds.push(build);
  saveUserBuilds(builds);

  // Если сразу создать сборку как публичную, а Firebase недоступен
  // (нет сети, анонимная авторизация выключена и т.п.) - сообщаем об этом
  // в ответе, чтобы UI мог предупредить пользователя, а не оставлять его
  // думать, что сборка уже видна всем.
  let synced = true;
  let syncMessage = '';
  if (build.isPublic) {
    try {
      const res = await publishBuildToServer(build);
      synced = !!res?.ok;
      if (!synced) syncMessage = res?.message || 'Firebase недоступен';
    } catch {
      synced = false;
      syncMessage = 'Firebase недоступен';
    }
  }
  return { ok: true, id, synced, syncMessage };
});

ipcMain.handle('builds:delete', async (_event, id) => {
  if (id === 'ALL_LOCAL') {
    saveUserBuilds([]);
    writeLogFile('builds.log', ['Wiped all local builds by developer request.']);
    return { ok: true };
  }

  const builds = loadUserBuilds();
  const build = builds.find((b) => b.id === id);

  if (build?.isPublic) {
    try {
      const res = await unpublishBuildFromServer(build);
      writeLogFile('builds.log', [`Unpublish ${id} before delete: status=${res.status}, ok=${res.ok}`]);
    } catch (e) {
      writeLogFile('builds.log', [`Failed to unpublish ${id}: ${e.message}`]);
    }
  }

  const filtered = builds.filter((b) => b.id !== id);
  saveUserBuilds(filtered);
  writeLogFile('builds.log', [`Deleted build ${id} from local storage. Remaining: ${filtered.length}`]);
  return { ok: true };
});

// Публичность решает, видна ли сборка в Firebase всем пользователям fyLight
// (и можно ли выпустить код/ссылку для неё) - приватные сборки остаются
// только на этом компьютере.
ipcMain.handle('builds:setPublic', async (_event, id, isPublic) => {
  const builds = loadUserBuilds();
  const idx = builds.findIndex((b) => b.id === id);
  if (idx === -1) return { ok: false, message: 'Сборка не найдена' };
  builds[idx].isPublic = !!isPublic;
  saveUserBuilds(builds);

  // Ждём ответ Firebase и явно сообщаем в рендерер, удалась ли
  // синхронизация - раньше ошибка молча проглатывалась, и переключатель
  // "Публичная" включался локально, даже если сборка на самом деле никуда
  // не долетела.
  let synced = false;
  let syncMessage = '';
  try {
    const res = builds[idx].isPublic
      ? await publishBuildToServer(builds[idx])
      : await unpublishBuildFromServer(builds[idx]);
    synced = !!res?.ok;
    if (!synced) syncMessage = res?.message || 'Firebase недоступен';
  } catch {
    synced = false;
    syncMessage = 'Firebase недоступен';
  }

  return { ok: true, isPublic: builds[idx].isPublic, synced, syncMessage };
});

// Для своих сборок счётчик просмотров хранится локально (сколько раз сам
// автор сюда заходил). Для чужих публичных сборок (community: true, пришли
// из Firebase) просмотр засчитывается в базе - его видят все, поэтому
// карточка может получить пометку "Популярное".
async function bumpFirebaseCounter(id, field) {
  const auth = await ensureFirebaseAuth();
  if (!auth) return { ok: false, value: 0 };
  const currentRes = await requestJson('GET', firebasePath(`/builds/${encodeURIComponent(id)}/${field}`, auth.idToken));
  const current = typeof currentRes.value === 'number' ? currentRes.value : 0;
  const next = current + 1;
  const res = await requestJson('PUT', firebasePath(`/builds/${encodeURIComponent(id)}/${field}`, auth.idToken), next);
  return res.ok ? { ok: true, value: next } : { ok: false, value: 0 };
}

ipcMain.handle('builds:incrementViews', async (_event, id, isCommunity) => {
  if (isCommunity) {
    const res = await bumpFirebaseCounter(id, 'views');
    return { ok: res.ok, views: res.value };
  }
  const builds = loadUserBuilds();
  const idx = builds.findIndex((b) => b.id === id);
  if (idx === -1) return { ok: true, views: 0 };
  builds[idx].views = (builds[idx].views || 0) + 1;
  saveUserBuilds(builds);
  // публичная сборка - синхронизируем просмотр и в Firebase, чтобы счётчик
  // у всех совпадал, а не расходился с локальным
  if (builds[idx].isPublic) {
    bumpFirebaseCounter(id, 'views').catch(() => {});
  }
  return { ok: true, views: builds[idx].views };
});

// Счётчик установок - отдельно от просмотров. Растёт только когда кто-то
// реально нажал "Установить всё" по сборке, а не просто открыл карточку.
// Для чужих (community) сборок показывается вместо бейджа "Публичная" -
// у автора там свой бейдж публичности, а у остальных - сколько раз сборку
// уже поставили.
ipcMain.handle('builds:incrementInstalls', async (_event, id, isCommunity) => {
  if (isCommunity) {
    const res = await bumpFirebaseCounter(id, 'installs');
    return { ok: res.ok, installs: res.value };
  }
  const builds = loadUserBuilds();
  const idx = builds.findIndex((b) => b.id === id);
  if (idx === -1) return { ok: true, installs: 0 };
  builds[idx].installs = (builds[idx].installs || 0) + 1;
  saveUserBuilds(builds);
  if (builds[idx].isPublic) {
    bumpFirebaseCounter(id, 'installs').catch(() => {});
  }
  return { ok: true, installs: builds[idx].installs };
});

ipcMain.handle('builds:icons', () => BUILD_ICONS);

// Сборка "ссылкой"/кодом - т.к. отдельного сервера сборок нет, вся сборка
// (название, описание, автор, приложения, твики) упаковывается в компактный
// base64url-код. Ссылка вида fylight://build/<код> открывает приложение
// (см. регистрацию протокола выше) и запускает импорт этого же кода.
function encodeBuildPayload(build) {
  const payload = {
    v: 1,
    name: build.name,
    description: build.description || '',
    author: build.author || 'Аноним',
    apps: build.apps || [],
    tweaks: build.tweaks || [],
    icon: build.icon || '',
  };
  return Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
}

function decodeBuildPayload(code) {
  const json = Buffer.from(String(code), 'base64url').toString('utf-8');
  const payload = JSON.parse(json);
  if (!payload || typeof payload !== 'object') throw new Error('bad build payload');
  return payload;
}

ipcMain.handle('builds:exportCode', (_event, id) => {
  const build = loadUserBuilds().find((b) => b.id === id);
  if (!build) return { ok: false, message: 'Сборка не найдена' };
  if (!build.isPublic) return { ok: false, message: 'Сначала сделайте сборку публичной' };
  try {
    const code = encodeBuildPayload(build);
    return { ok: true, code, link: `${BUILD_LINK_SCHEME}://build/${code}` };
  } catch {
    return { ok: false, message: 'Не удалось собрать код сборки' };
  }
});

ipcMain.handle('builds:importCode', (_event, rawCode) => {
  let payload;
  try {
    payload = decodeBuildPayload(rawCode);
  } catch {
    return { ok: false, message: 'Не удалось распознать код сборки' };
  }
  const cleanApps = sanitizeBuildApps(payload.apps);
  const cleanTweaks = sanitizeBuildTweaks(payload.tweaks);
  if (!cleanApps.length && !cleanTweaks.length) {
    return { ok: false, message: 'В этом коде нет ни одного известного приложения или твика' };
  }
  const builds = loadUserBuilds();
  const id = `user-${Date.now()}`;
  const cleanName = String(payload.name || '').trim().slice(0, 60) || 'Импортированная сборка';
  builds.push({
    id,
    name: cleanName,
    description: String(payload.description || '').trim().slice(0, 300),
    author: String(payload.author || 'Аноним').trim().slice(0, 40) || 'Аноним',
    apps: cleanApps,
    tweaks: cleanTweaks,
    icon: sanitizeBuildIcon(payload.icon),
    isPublic: false, // импортированная копия у получателя приватная по умолчанию
    views: 0,
    imported: true,
  });
  saveUserBuilds(builds);
  return { ok: true, id, name: cleanName };
});

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'fyLight-app' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchJson(res.headers.location));
      }
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function downloadToFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'fyLight-app' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        request.destroy();
        return resolve(downloadToFile(res.headers.location, destPath, onProgress));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      res.on('data', (chunk) => {
        received += chunk.length;
        if (onProgress) onProgress({ received, total });
      });
      const fileStream = fs.createWriteStream(destPath);
      res.pipe(fileStream);
      fileStream.on('finish', () => fileStream.close(() => resolve(destPath)));
      fileStream.on('error', reject);
    });
    request.on('error', reject);
  });
}

ipcMain.handle('apps:install', async (_event, appId) => {
  const appDef = APP_CATALOG.find((a) => a.id === appId);
  if (!appDef) return { ok: false, message: 'Приложение не найдено' };

  if (process.platform !== 'win32') {
    return { ok: false, message: 'Установка доступна только в Windows' };
  }

  if (appDef.type === 'winget') {
    return new Promise((resolve) => {
      // winget сам рисует прогресс-бар с процентами прямо в строке вывода
      // (перезаписывая её через \r). execFile ждал бы полного завершения и
      // отдавал бы весь stdout только в конце - здесь вместо этого читаем
      // вывод потоково через spawn и вытаскиваем регуляркой последний
      // встретившийся процент, чтобы показать реальный прогресс скачивания
      // в оверлее, а не просто крутящийся спиннер.
      const child = spawn(
        'winget',
        ['install', '--id', appDef.wingetId, '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements'],
        { windowsHide: true }
      );

      let buffer = '';
      let lastEmit = 0;
      let lastPercent = -1;
      const timeout = setTimeout(() => { child.kill(); }, 5 * 60 * 1000);

      const handleChunk = (chunk) => {
        buffer += chunk.toString();
        const matches = buffer.match(/(\d{1,3})\s?%/g);
        if (matches && matches.length) {
          const percent = Math.min(100, parseInt(matches[matches.length - 1], 10));
          const now = Date.now();
          if (Number.isFinite(percent) && percent !== lastPercent && (now - lastEmit > 250 || percent === 100)) {
            lastPercent = percent;
            lastEmit = now;
            mainWindow?.webContents.send('apps:progress', {
              id: appId, percent, receivedMb: null, totalMb: null, speedMbps: null,
            });
          }
        }
        // Не даём буферу расти бесконечно на длинных установках.
        if (buffer.length > 4000) buffer = buffer.slice(-2000);
      };

      child.stdout?.on('data', handleChunk);
      child.stderr?.on('data', handleChunk);

      child.on('error', () => {
        clearTimeout(timeout);
        resolve({ ok: false, message: 'Не удалось запустить winget. Установите его из Microsoft Store (App Installer) и повторите.' });
      });

      child.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve({ ok: true, message: 'Установлено' });
        } else {
          resolve({ ok: false, message: 'Не удалось запустить winget. Установите его из Microsoft Store (App Installer) и повторите.' });
        }
      });
    });
  }

  if (appDef.type === 'github') {
    try {
      const release = await fetchJson(`https://api.github.com/repos/${appDef.repo}/releases/latest`);
      const asset = (release.assets || []).find((a) => /\.(exe|zip)$/i.test(a.name));
      if (!asset) return { ok: false, message: 'В последнем релизе не найдено файлов для скачивания' };
      const destDir = path.join(app.getPath('downloads'));
      const destPath = path.join(destDir, asset.name);
      await downloadToFile(asset.browser_download_url, destPath, ({ received, total }) => {
        const now = Date.now();
        if (!this.lastTime) { this.lastTime = now; this.lastReceived = 0; }
        const elapsed = (now - this.lastTime) / 1000;
        let speedMbps = 0;
        if (elapsed >= 0.5) {
          speedMbps = ((received - this.lastReceived) * 8) / (1024 * 1024 * elapsed);
          this.lastTime = now;
          this.lastReceived = received;
        }

        mainWindow?.webContents.send('apps:progress', {
          id: appId,
          receivedMb: Math.round((received / (1024 * 1024)) * 10) / 10,
          totalMb: total ? Math.round((total / (1024 * 1024)) * 10) / 10 : null,
          percent: total ? Math.min(100, Math.round((received / total) * 100)) : null,
          speedMbps: speedMbps > 0 ? speedMbps : null,
        });
      });
      // Открываем скачанный файл штатным средством ОС - пользователь сам
      // подтверждает запуск установщика/архива, приложение ничего не
      // выполняет от его имени незаметно.
      await shell.openPath(destPath);
      return { ok: true, message: `Скачано в ${destPath}. Запустите файл, чтобы завершить установку.` };
    } catch (e) {
      return { ok: false, message: 'Не удалось скачать с GitHub: ' + e.message };
    }
  }

  return { ok: false, message: 'Неизвестный тип установки' };
});

// =====================================================================
// УДАЛЕНИЕ ВСТРОЕННЫХ ПРИЛОЖЕНИЙ (DEBLOAT)
// =====================================================================
const APPX_CATALOG = [
  { id: 'xbox-app', name: 'Xbox', pkg: 'Microsoft.GamingApp', os: 'all' },
  { id: 'xbox-tcui', name: 'Xbox TCUI', pkg: 'Microsoft.Xbox.TCUI', os: 'all' },
  { id: 'xbox-overlay', name: 'Xbox Game Overlay', pkg: 'Microsoft.XboxGamingOverlay', os: 'all' },
  { id: 'xbox-identity', name: 'Xbox Identity Provider', pkg: 'Microsoft.XboxIdentityProvider', os: 'all' },
  { id: 'xbox-speech', name: 'Xbox Speech To Text Overlay', pkg: 'Microsoft.XboxSpeechToTextOverlay', os: 'all' },
  { id: 'weather', name: 'Погода', pkg: 'Microsoft.BingWeather', os: 'all' },
  { id: 'gethelp', name: 'Возникли вопросы?', pkg: 'Microsoft.GetHelp', os: 'all' },
  { id: 'getstarted', name: 'Приступая к работе', pkg: 'Microsoft.Getstarted', os: '10' },
  { id: 'office-hub', name: 'Ярлык Office', pkg: 'Microsoft.MicrosoftOfficeHub', os: 'all' },
  { id: 'solitaire', name: 'Microsoft Solitaire Collection', pkg: 'Microsoft.MicrosoftSolitaireCollection', os: 'all' },
  { id: 'people', name: 'Люди', pkg: 'Microsoft.People', os: '10' },
  { id: 'feedback-hub', name: 'Центр отзывов', pkg: 'Microsoft.WindowsFeedbackHub', os: 'all' },
  { id: 'your-phone', name: 'Ваш телефон / Связь с Windows', pkg: 'Microsoft.YourPhone', os: 'all' },
  { id: '3dbuilder', name: '3D Builder', pkg: 'Microsoft.3DBuilder', os: '10' },
  { id: 'mixed-reality', name: 'Mixed Reality Portal', pkg: 'Microsoft.MixedReality.Portal', os: 'all' },
  { id: 'todos', name: 'Microsoft To Do', pkg: 'Microsoft.Todos', os: 'all' },
  { id: 'zune-music', name: 'Groove Музыка', pkg: 'Microsoft.ZuneMusic', os: 'all' },
  { id: 'zune-video', name: 'Кино и ТВ', pkg: 'Microsoft.ZuneVideo', os: 'all' },
  { id: 'clipchamp', name: 'Clipchamp', pkg: 'Clipchamp.Clipchamp', os: '11' },
  { id: 'teams-chat', name: 'Chat (Teams)', pkg: 'MicrosoftTeams', os: '11' },
  { id: 'skype', name: 'Skype', pkg: 'Microsoft.SkypeApp', os: '10' },
  { id: 'mixedrealityportal', name: 'Paint 3D', pkg: 'Microsoft.MSPaint', os: 'all' },
  { id: 'sticky-notes', name: 'Записки (Sticky Notes)', pkg: 'Microsoft.MicrosoftStickyNotes', os: 'all' },
  { id: 'family-safety', name: 'Family Safety', pkg: 'MicrosoftCorporationII.MicrosoftFamily', os: '11' },
  { id: 'power-automate', name: 'Power Automate Desktop', pkg: 'Microsoft.PowerAutomateDesktop', os: 'all' },
  { id: 'quick-assist', name: 'Быстрая помощь', pkg: 'MicrosoftCorporationII.QuickAssist', os: '11' },
];

ipcMain.handle('debloat:list', () => {
  const { windowsVersion } = getOsInfo();
  return APPX_CATALOG.filter((a) => a.os === 'all' || a.os === windowsVersion || !windowsVersion)
    .map(({ id, name }) => ({ id, name }));
});

ipcMain.handle('debloat:remove', async (_event, ids) => {
  if (process.platform !== 'win32') {
    return (ids || []).map((id) => ({ id, ok: false, message: 'Доступно только в Windows' }));
  }
  const results = [];
  for (const id of ids || []) {
    const def = APPX_CATALOG.find((a) => a.id === id);
    if (!def) { results.push({ id, ok: false, message: 'Не найдено' }); continue; }
    const cmd = `Get-AppxPackage -allusers "${def.pkg}" | Remove-AppxPackage -ErrorAction SilentlyContinue; Get-AppxProvisionedPackage -Online | Where-Object DisplayName -like "${def.pkg}*" | Remove-AppxProvisionedPackage -Online -ErrorAction SilentlyContinue`;
    const r = await runPowerShell(cmd);
    results.push({ id, ok: r.ok, message: r.ok ? 'Удалено' : 'Ошибка удаления' });
  }
  return results;
});

// =====================================================================
// АВТООБНОВЛЕНИЕ ИЗ GITHUB
// =====================================================================
const UPDATE_REPO = 'knowfov/FyLight';

// Последний известный статус проверки обновлений. Нужен, чтобы рендерер
// мог ЗАПРОСИТЬ текущее состояние сам (через updater:getStatus) сразу при
// загрузке, а не только пассивно ждать push-события 'updater:status'.
//
// Раньше статус доходил до рендерера ТОЛЬКО через webContents.send(), а
// проверка обновлений запускалась в app.whenReady() практически
// одновременно с созданием окна (createWindow()), без всякой синхронизации
// между ними. Ответ GitHub API - это несколько килобайт JSON и обычно
// приходит быстрее, чем index.html (большой файл с большим количеством
// встроенного JS) успевает распарситься и выполнить строку, где
// подписывается window.updaterAPI.onStatus(...). Если событие 'available'
// уходило в рендерер ДО того, как там появлялся слушатель, оно просто
// терялось безвозвратно - пользователь не видел, что вышло обновление, до
// следующей периодической проверки раз в 30 минут (или вообще никогда,
// если закрывал приложение раньше). Кэш ниже устраняет эту гонку: даже
// если push-событие было пропущено, рендерер получит тот же результат
// через pull-запрос при старте.
let lastUpdateStatus = null;

function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

// Отправляет статус в рендерер одним и тем же событием на каждой стадии:
// 'checking' -> 'none' | 'available' -> 'downloading' (с прогрессом) ->
// 'installing' (после чего процесс завершается сам, см. app.quit() ниже)
// либо 'no-asset' / 'error', если автоустановка невозможна.
function sendUpdateStatus(payload) {
  lastUpdateStatus = payload;
  mainWindow?.webContents.send('updater:status', payload);
}

async function checkForUpdates(autoInstall = false) {
  try {
    sendUpdateStatus({ stage: 'checking' });
    const release = await fetchJson(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`);

    const current = app.getVersion();
    const tag = release?.tag_name;

    writeLogFile('update.log', [
      `Check started. Repo: ${UPDATE_REPO}`,
      `Current version: ${current}`,
      `Latest tag from GitHub: ${tag || 'NONE'}`,
      release?.message ? `GitHub message: ${release.message}` : 'GitHub: OK'
    ]);

    if (!release || !release.tag_name) {
      sendUpdateStatus({ stage: 'none' });
      return { updateAvailable: false };
    }

    const latest = String(release.tag_name).replace(/^v/i, '');
    const updateAvailable = compareVersions(latest, current) > 0;

    writeLogFile('update.log', [
      `Comparing: latest=${latest} vs current=${current}`,
      `Update available: ${updateAvailable}`
    ]);

    if (!updateAvailable) {
      sendUpdateStatus({ stage: 'none', updateAvailable, latest, current });
      return { updateAvailable, latest, current };
    }

    sendUpdateStatus({ stage: 'available', updateAvailable, latest, current });

    if (autoInstall && process.platform === 'win32') {
      const asset = (release.assets || []).find((a) => a.name.endsWith('.exe'));
      if (!asset) {
        writeLogFile('update.log', ['No .exe asset found in release.']);
        sendUpdateStatus({ stage: 'no-asset', updateAvailable, latest, current });
        return { updateAvailable, latest, current };
      }
      const destPath = path.join(app.getPath('temp'), asset.name);
      let lastTime = 0;
      let lastReceived = 0;

      await downloadToFile(asset.browser_download_url, destPath, ({ received, total }) => {
        const now = Date.now();
        if (!lastTime) { lastTime = now; lastReceived = 0; }
        const elapsed = (now - lastTime) / 1000;
        let speedMbps = 0;
        if (elapsed >= 0.5) {
          speedMbps = ((received - lastReceived) * 8) / (1024 * 1024 * elapsed);
          lastTime = now;
          lastReceived = received;
        }

        sendUpdateStatus({
          stage: 'downloading',
          updateAvailable, latest, current,
          receivedMb: Math.round((received / (1024 * 1024)) * 10) / 10,
          totalMb: total ? Math.round((total / (1024 * 1024)) * 10) / 10 : null,
          percent: total ? Math.min(100, Math.round((received / total) * 100)) : null,
          speedMbps: speedMbps > 0 ? speedMbps : null,
        });
      });
      writeLogFile('update.log', ['Download finished. Launching installer.']);
      sendUpdateStatus({ stage: 'installing', updateAvailable, latest, current });
      spawn(destPath, [], { detached: true, stdio: 'ignore' }).unref();
      app.quit();
    }
    return { updateAvailable, latest, current };
  } catch (e) {
    console.error('[fyLight] Ошибка проверки обновлений:', e);
    writeLogFile('update.log', [`Error: ${e.message}`, e.stack]);
    sendUpdateStatus({ stage: 'error' });
    return { updateAvailable: false };
  }
}

ipcMain.handle('updater:check', () => checkForUpdates(false));
ipcMain.handle('updater:downloadAndInstall', () => checkForUpdates(true));
// Позволяет рендереру ЗАПРОСИТЬ последний известный статус проверки при
// своей загрузке - страховка на случай, если push-событие 'updater:status'
// ушло раньше, чем рендерер успел на него подписаться (см. комментарий у
// lastUpdateStatus выше).
ipcMain.handle('updater:getStatus', () => lastUpdateStatus);

// ---------- Вспомогательные функции для сборки ----------
// placeholder для иконки в package.json: build/icon.ico
ipcMain.handle('build:prepare', async () => {
  if (process.platform !== 'win32') return { ok: false, message: 'Только для Windows' };
  const cmd = 'powershell -Command "Get-Process fyLight -ErrorAction SilentlyContinue | Stop-Process -Force"';
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-Command', 'Get-Process fyLight -ErrorAction SilentlyContinue | Stop-Process -Force'], (error) => {
      resolve({ ok: !error, message: error ? 'Не удалось закрыть fyLight.exe' : 'fyLight.exe закрыт' });
    });
  });
});
