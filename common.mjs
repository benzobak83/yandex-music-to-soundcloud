import { rename, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import lockfile from 'proper-lockfile';

export async function withProjectLock(run) {
  const directory = fileURLToPath(new URL('.', import.meta.url));
  const lockfilePath = fileURLToPath(new URL('./.music-transfer.lockdir', import.meta.url));
  let release;
  try {
    release = await lockfile.lock(directory, { lockfilePath, stale: 30000 });
  } catch (error) {
    if (error.code === 'ELOCKED') {
      throw new Error('В этой папке уже выполняется экспорт или импорт. Дождитесь завершения команды.');
    }
    throw error;
  }
  try {
    return await run();
  } finally {
    await release();
  }
}

export async function prompt(message) {
  if (!process.stdin.isTTY) throw new Error('Запустите скрипт в Терминале.');
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await terminal.question(message);
  } finally {
    terminal.close();
  }
}

export async function writeJson(path, data) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, path);
}

async function pageStatus(page, address) {
  if (/\/(?:showcaptcha|checkcaptcha)(?:\/|$)/i.test(new URL(address).pathname)) {
    return { challenge: true };
  }
  return page.evaluate(() => {
    const challengeTitle = /^(?:just a moment|attention required|robot check|captcha|ой[.!]+)\s*[.!…]*$/i;
    const challengeText = /проверка браузера|подтвердите, что вы не робот|вы не робот\?|verify (?:that )?you are (?:a )?human|checking your browser|security verification/i;
    const headings = document.querySelectorAll('h1, h2, [role="heading"]');
    return {
      challenge: challengeTitle.test(document.title) ||
        [...headings].some((heading) => visible(heading) && challengeText.test(heading.textContent)),
      status: performance.getEntriesByType('navigation')[0]?.responseStatus ||
        document.title.match(/^(403|429)\b/)?.[1] ||
        (/^ERROR: The request could not be satisfied$/i.test(document.title) &&
          document.body?.innerText.includes('403 ERROR') ? 403 : 0),
    };
  });
}

export async function openPage(page, url) {
  let result = await pageStatus(page, await page.navigate(url));
  if (result.challenge) {
    await prompt('Сайт запросил проверку. Пройдите её в рабочей вкладке Chrome и нажмите Enter в Терминале. ');
    result = await pageStatus(page, await page.navigate(url));
    if (result.challenge) throw new Error('Сайт снова запросил проверку браузера. Скрипт остановлен.');
  }

  const status = Number(result.status);
  const host = new URL(url).hostname;
  if (status === 403) throw new Error(`${host} отказал в доступе (HTTP 403).`);
  if (status === 429) throw new Error(`${host} временно ограничил число запросов (HTTP 429). Попробуйте позже.`);
  if (status >= 400) throw new Error(`${host} ответил HTTP ${status}.`);
}

export function fail(error) {
  console.error(error.message);
  process.exitCode = 1;
}
