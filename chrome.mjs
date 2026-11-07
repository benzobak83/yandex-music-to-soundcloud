import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const SCRIPT = `
on run argv
  set action to item 1 of argv
  tell application id "com.google.Chrome"
    if action is "open" then
      activate
      if (count of windows) is 0 then make new window
      set targetWindow to missing value
      repeat with candidate in windows
        if mode of candidate is "normal" then
          set targetWindow to contents of candidate
          exit repeat
        end if
      end repeat
      if targetWindow is missing value then set targetWindow to make new window
      set index of targetWindow to 1
      set createdWindowId to id of targetWindow
      tell targetWindow
        make new tab at end of tabs with properties {URL:"about:blank"}
        set active tab index to count of tabs
        set createdTabId to id of active tab
      end tell
      return createdWindowId & ":" & createdTabId
    end if
    set windowId to item 2 of argv
    set tabId to item 3 of argv
    set targetTab to tab id tabId of window id windowId
    if action is "navigate" then
      set URL of targetTab to item 4 of argv
    else if action is "location" then
      if loading of targetTab then return ""
      return URL of targetTab
    else if action is "evaluate" then
      return execute targetTab javascript (item 4 of argv)
    end if
  end tell
end run
`;

async function appleScript(action, ...args) {
  try {
    const { stdout } = await exec('/usr/bin/osascript', ['-e', SCRIPT, action, ...args],
      { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  } catch (error) {
    const message = error.stderr || error.message;
    if (/-1743\b/.test(message)) {
      throw new Error('Разрешите Терминалу управлять Google Chrome в «Системные настройки → Конфиденциальность и безопасность → Автоматизация».');
    }
    if (action === 'evaluate' && /Apple Events|JavaScript through AppleScript|JavaScript через AppleScript/i.test(message)) {
      throw new Error('В выбранном профиле Chrome включите «Вид → Разработчик → Разрешить JavaScript из событий Apple» и запустите команду снова.');
    }
    if (/\(-1728\)/.test(message)) throw new Error('Рабочая вкладка Chrome закрыта или перемещена в другое окно.');
    throw new Error(`Не удалось управлять вкладкой Chrome. ${message.trim()}`);
  }
}

export async function waitFor(check, timeout, message) {
  const deadline = Date.now() + timeout;
  do {
    const value = await check();
    if (value) return value;
    await delay(300);
  } while (Date.now() < deadline);
  const error = new Error(message);
  error.name = 'TimeoutError';
  throw error;
}

async function openAppleScriptTab() {
  const ids = (await appleScript('open')).split(':');
  const run = (action, ...args) => appleScript(action, ...ids, ...args);
  return {
    async navigate(url) {
      await run('navigate', url);
      return waitFor(() => run('location'), 30000, 'Chrome не завершил загрузку страницы за 30 секунд.');
    },
    evaluate: (code) => run('evaluate', code),
  };
}

async function openBrowserTab() {
  if (process.platform === 'darwin') return openAppleScriptTab();
  if (process.platform === 'win32') {
    const { openDevToolsTab } = await import('./chrome-devtools.mjs');
    return openDevToolsTab();
  }
  throw new Error('Скрипт поддерживает macOS и Windows.');
}

export async function withChromeTab(origin, run) {
  const driver = await openBrowserTab();
  try {
    return await run({
      async navigate(url) {
        if (new URL(url).origin !== origin) throw new Error('Неожиданный адрес для рабочего профиля.');
        return driver.navigate(url);
      },
      async evaluate(callback, ...args) {
        const code = `(() => {
          if (location.origin !== ${JSON.stringify(origin)}) return JSON.stringify({wrongPage: true});
          const visible = (element) => element && element.getClientRects().length > 0 &&
            getComputedStyle(element).visibility === 'visible';
          const value = (${callback})(...${JSON.stringify(args)});
          return JSON.stringify({value});
        })()`;
        const result = JSON.parse(await driver.evaluate(code));
        if (result.wrongPage) throw new Error('Рабочая вкладка перешла на другой сайт.');
        return result.value;
      },
    });
  } finally {
    await driver.disconnect?.();
  }
}
