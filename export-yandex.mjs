import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { fail, openPage, prompt, withProjectLock, writeJson } from './common.mjs';
import { waitFor, withChromeTab } from './chrome.mjs';

const TRACK_ROW = '[class*="CommonTrack_root__"]';
const COLLECTION = 'https://music.yandex.ru/collection';

function readPlaylist(page, scrollTo = null) {
  return page.evaluate((selector, target) => {
    const first = [...document.querySelectorAll(selector)].find(visible);
    const list = document.querySelector('[data-test-id="virtuoso-item-list"], [data-testid="virtuoso-item-list"]') ??
      first?.closest('[role="region"][aria-label*="трек" i], [role="region"][aria-label$="track list" i]');
    if (!list && !first) return null;

    let scroller = list?.closest('[data-virtuoso-scroller="true"]') ?? (list ?? first).parentElement;
    while (scroller) {
      const overflow = getComputedStyle(scroller).overflowY;
      if (/^(auto|scroll|overlay)$/.test(overflow) && scroller.clientHeight > 0) break;
      scroller = scroller.parentElement;
    }
    scroller ??= document.scrollingElement;

    if (target !== null) {
      scroller.scrollTo({ top: target, behavior: 'instant' });
      return true;
    }

    const rendered = [...(list ?? document).querySelectorAll(selector)].filter(visible);
    const height = scroller.clientHeight;
    const top = scroller.scrollTop;
    const maxTop = Math.max(0, scroller.scrollHeight - height);
    if (list) {
      // Virtual rows can remain mounted at the old scroll position while the next viewport renders.
      const viewportTop = scroller === document.scrollingElement
        ? 0 : scroller.getBoundingClientRect().top + scroller.clientTop;
      const listBounds = list.getBoundingClientRect();
      const firstPixel = Math.max(viewportTop, listBounds.top);
      const lastPixel = Math.min(viewportTop + height, listBounds.bottom);
      if (lastPixel > firstPixel) {
        const firstRow = rendered[0]?.getBoundingClientRect();
        const lastRow = rendered.at(-1)?.getBoundingClientRect();
        if (!firstRow || firstRow.top > firstPixel + 3 || lastRow.bottom < lastPixel - 3) return null;
      }
    } else if (!rendered.length) {
      return null;
    }

    const content = (node) => node?.textContent?.trim() ?? '';
    const rows = rendered.map((row) => {
      const link = row.querySelector('a[href*="/track/"]');
      const id = link?.pathname.match(/\/track\/(\d+)(?:\/|$)/)?.[1] ?? null;
      const title = content(row.querySelector('[class*="Meta_title__"]')) || content(link);
      const artists = [...row.querySelectorAll('[class*="Meta_artistCaption__"]')].map(content).filter(Boolean);
      const version = content(row.querySelector('[class*="Meta_version__"]'));
      const index = row.closest('[data-item-index], [data-index]');
      const rawIndex = index?.getAttribute('data-item-index') ?? index?.getAttribute('data-index');
      return {
        index: rawIndex != null && /^\d+$/.test(rawIndex) ? Number(rawIndex) : null,
        id,
        title,
        artists,
        version,
        yandexUrl: link?.href ?? null,
        label: row.getAttribute('aria-label') || '',
      };
    });
    return { rows, top, maxTop, height };
  }, TRACK_ROW, scrollTo);
}

async function scanPlaylist(page, step, renderTimeout) {
  await waitFor(() => readPlaylist(page, 0), 15000,
    'Строки с треками не появились. Проверьте, что открыт плейлист с треками.');
  const collected = new Map();
  const indexes = new Set();
  let target = 0;
  let bottomPasses = 0;
  while (bottomPasses < 4) {
    const { rows, top, maxTop, height } = await waitFor(async () => {
      const view = await readPlaylist(page);
      return view && Math.abs(view.top - Math.min(target, view.maxTop)) <= 3 ? view : null;
    }, renderTimeout, 'Строки в очередной части плейлиста не успели загрузиться.');

    const previousCount = collected.size;
    for (const { index, ...track } of rows) {
      if (index !== null) indexes.add(index);
      const key = index !== null ? index : (track.id || track.label || track.title);
      if (!key && key !== 0) throw new Error('Найдена строка без названия и идентификатора.');
      const previous = collected.get(key);
      if (previous?.id && track.id && previous.id !== track.id) {
        throw new Error('Порядок треков изменился во время выгрузки.');
      }
      if (!previous || (!previous.artists.length && track.artists.length)) collected.set(key, track);
    }

    if (maxTop - top <= 3) {
      bottomPasses = collected.size === previousCount ? bottomPasses + 1 : 0;
      if (bottomPasses < 4) await delay(500);
      continue;
    }
    bottomPasses = 0;
    target = Math.min(maxTop, top + Math.max(1, Math.floor(height * step)));
    await waitFor(() => readPlaylist(page, target), renderTimeout, 'Не удалось прокрутить плейлист.');
  }

  const orderedIndexes = [...indexes].sort((a, b) => a - b);
  if (orderedIndexes[0] > 1 ||
      orderedIndexes.some((index, position) => index !== orderedIndexes[0] + position)) {
    return null;
  }
  if (indexes.size === collected.size) return orderedIndexes.map((index) => collected.get(index));
  return [...collected.values()];
}

async function collectTracks(page, expected) {
  let lastError;
  for (const [step, timeout] of [[0.65, 3500], [0.35, 8000]]) {
    try {
      const tracks = await scanPlaylist(page, step, timeout);
      if (!tracks) lastError = 'В нумерации строк остались пропуски.';
      else if (!tracks.length) lastError = 'В плейлисте не найдено треков.';
      else if (expected !== undefined && tracks.length !== expected) {
        lastError = `Собрано ${tracks.length} из ожидаемых ${expected} треков.`;
      } else {
        return tracks;
      }
    } catch (error) {
      if (error.name !== 'TimeoutError') throw error;
      lastError = error.message;
    }
    if (step === 0.65) console.log('Часть списка не загрузилась. Повторяю проход с меньшим шагом прокрутки.');
  }
  throw new Error(`${lastError} Файл не заменён.`);
}

async function main() {
  const { values } = parseArgs({
    options: { output: { type: 'string', default: 'tracks.json' }, count: { type: 'string' }, help: { type: 'boolean' } },
  });
  if (values.help) {
    console.log('npm run export -- [--output tracks.json] [--count ЧИСЛО_ТРЕКОВ]');
    return;
  }
  const expected = values.count === undefined ? undefined : Number(values.count);
  if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 1)) {
    throw new Error('--count должен быть положительным целым числом.');
  }

  await withChromeTab(new URL(COLLECTION).origin, async (page) => {
    await openPage(page, COLLECTION);
    await prompt('В открывшейся вкладке Chrome выберите «Коллекция → Мне нравится» или «My Collection → My Favorites» без фильтров и нажмите Enter в Терминале. ');
    const isPlaylist = await page.evaluate(() => {
      if (/^\/playlists\/lk\.[^/]+\/?$/.test(location.pathname)) return true;
      return [...document.querySelectorAll('h1, h2, [role="heading"]')].some((heading) =>
        visible(heading) && /^(Мне нравится|My Favo[u]?rites|Liked tracks|Liked songs)$/i.test(heading.textContent.trim()));
    });
    if (!isPlaylist) throw new Error('Откройте «Мне нравится» (My Favorites) именно во вкладке, которую открыла команда.');

    console.log('Читаю плейлист. Оставьте вкладку на этой странице.');
    const tracks = await collectTracks(page, expected);
    tracks.reverse();
    await writeJson(values.output, { source: 'yandex-music', tracks });
    const incomplete = tracks.filter((track) => !track.title || !track.artists.length).length;
    console.log(`Сохранено треков — ${tracks.length}. Файл — ${values.output}.`);
    if (incomplete) console.log(`Строк без названия или исполнителя — ${incomplete}. Они потребуют ручной проверки.`);
  });
}

await withProjectLock(main).catch(fail);
