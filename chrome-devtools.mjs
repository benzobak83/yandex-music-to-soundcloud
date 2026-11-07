import { connect } from 'puppeteer-core';

export async function openDevToolsTab() {
  console.log('Подключаюсь к открытому Chrome. Если появится запрос на подключение, нажмите «Разрешить» в браузере.');
  let browser;
  try {
    browser = await connect({
      channel: 'chrome',
      defaultViewport: null,
      protocolTimeout: 60000,
    });
  } catch (error) {
    throw new Error(
      'Не удалось подключиться к Chrome. Откройте обычный Google Chrome 144 или новее, ' +
      'включите удалённую отладку на chrome://inspect/#remote-debugging и подтвердите запрос Chrome при следующем запуске.',
      { cause: error },
    );
  }

  try {
    const tab = await browser.newPage();
    await tab.bringToFront();
    return {
      async navigate(url) {
        await tab.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        return tab.url();
      },
      evaluate: (code) => tab.evaluate(code),
      disconnect: () => browser.disconnect(),
    };
  } catch (error) {
    await browser.disconnect();
    throw error;
  }
}
