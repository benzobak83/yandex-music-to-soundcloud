import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { fail, openPage, prompt, withProjectLock, writeJson } from './common.mjs';
import { waitFor, withChromeTab } from './chrome.mjs';

const SOUNDCLOUD = 'https://soundcloud.com';
const SEARCH_ROW = '.searchList__item, .soundList__item';
const SEARCH_TRACK = `:is(${SEARCH_ROW}) a.soundTitle__title`;
const REGION_LABEL = '.waveform__disabledMessage';
const REGION_TEXT = /^(?:not available in|недоступ[а-яё]* в)\s+/iu;
const REGION_REPORT = 'soundcloud-region-blocked.json';
const LIKED = 'liked';
const REGION_BLOCKED = 'region-blocked';
const EMPTY_SEARCH = '.searchNothingFound, .search__noResults';
const SIGNED_IN = '.header__userNavButton, .header__userNavUsernameButton, .header__userNav .header__userNavAvatar';

function normalize(value) {
  return value.normalize('NFKC').toLowerCase()
    .replace(/[‘’`]/g, "'")
    .replace(/['"]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function trackUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin !== SOUNDCLOUD || url.username || url.password ||
        !/^\/[a-z0-9_-]+\/[a-z0-9_-]+\/?$/i.test(url.pathname) ||
        /\/(sets|tracks|albums|popular-tracks|likes|reposts|followers|following|spotlight)\/?$/i.test(url.pathname)) {
      return null;
    }
    return SOUNDCLOUD + url.pathname.replace(/\/$/, '');
  } catch {
    return null;
  }
}

const FEATURE = /^(?:feat|ft|featuring) (.+)$/;
const PRODUCER = /^(?:prod|produced) (?:by )?(.+)$/;
const VERSION_WORDS = /(?:^| )(?:remix|slowed|sped up|speed up|reverb|cover|instrumental|acoustic|live|remaster(?:ed)?|karaoke|mashup|radio edit|demo|mix|версия|ремикс|кавер)(?: |$)/u;
const CYRILLIC = 'абвгдежзийклмнопрстуфхцчшщъыьэюя';
const LATIN = ['a', 'b', 'v', 'g', 'd', 'e', 'zh', 'z', 'i', 'i', 'k', 'l', 'm', 'n', 'o', 'p', 'r', 's', 't', 'u', 'f', 'h', 'ts', 'ch', 'sh', 'shch', '', 'y', '', 'e', 'yu', 'ya'];

function titleCredits(value) {
  const credit = value.match(/^(.+?)(?:\s*[([]\s*|\s+)((?:feat(?:uring)?|ft|prod(?:uced)?)(?:\.\s*|\s+)\S.*)$/i);
  const details = credit && normalize(credit[2]);
  if (!details || VERSION_WORDS.test(details)) return { title: value, featured: '', producer: '' };
  return {
    title: credit[1].trim(),
    featured: details.match(FEATURE)?.[1].split(/ (?:prod|produced) /)[0] ?? '',
    producer: details.match(PRODUCER)?.[1] ?? '',
  };
}

function sameTitle(actual, expected) {
  if (normalize(actual) === expected) return true;
  const names = actual.split(/\s+\/\s+/).map(normalize);
  if (names.length !== 2 || !names.includes(expected)) return false;
  const alias = names.find((name) => name !== expected);
  if (!alias || !/^[a-z0-9 ]+$/.test(alias) || !/[а-яё]/i.test(expected)) return false;
  const latin = expected.replace(/ё/g, 'е').replace(/[а-я]/g, (letter) => LATIN[CYRILLIC.indexOf(letter)] ?? letter);
  return alias.replace(/kh/g, 'h').replace(/x/g, 'ks') === latin;
}

function containsArtist(credits, artist) {
  return ` ${credits} `.includes(` ${artist} `);
}

function isExactMatch(track, candidate) {
  const artists = track.artists.map(normalize).filter(Boolean);
  const version = normalize(track.version);
  const feature = version.match(FEATURE)?.[1];
  const producer = version.match(PRODUCER)?.[1];
  const source = titleCredits(track.title);
  const title = normalize([source.title, !feature && !producer ? track.version : ''].filter(Boolean).join(' '));
  if (!title || !artists.length) return false;

  const checks = [{ title: candidate.title, prefix: '' }];
  const prefix = candidate.title.match(/^(.+?)\s+[-–—]\s+(.+)$/u);
  if (prefix && containsArtist(normalize(prefix[1]), artists[0])) {
    checks.push({ title: prefix[2], prefix: prefix[1] });
  }

  return checks.some((check) => {
    const actual = titleCredits(check.title);
    if (!sameTitle(actual.title, title)) return false;
    if (producer && actual.producer && producer !== actual.producer) return false;
    const mainCredits = normalize([candidate.artist, check.prefix].join(' '));
    if (!containsArtist(mainCredits, artists[0])) return false;
    const allCredits = [mainCredits, actual.featured].join(' ');
    return artists.every((artist) => containsArtist(allCredits, artist)) &&
      (!feature || containsArtist(allCredits, feature));
  });
}

async function searchTracks(page, query) {
  const url = new URL('/search/sounds', SOUNDCLOUD);
  url.searchParams.set('q', query);
  await openPage(page, url.href);
  const candidates = await waitFor(() => page.evaluate((trackSelector, emptySelector, rowSelector, regionSelector) => {
    const links = [...document.querySelectorAll(trackSelector)].filter(visible);
    if (!links.length) {
      const emptyText = /^(No results(?: found)?|We can[’']t find any results|No tracks found|We didn[’']t find any (?:tracks|results))/i;
      const empty = [...document.querySelectorAll(emptySelector + ', h1, h2, h3, [role="heading"]')];
      return empty.some((element) => visible(element) &&
        (element.matches(emptySelector) || emptyText.test(element.textContent.trim()))) ? [] : null;
    }
    return links.slice(0, 15).map((link) => ({
      title: (link.textContent || '').trim(),
      artist: (link.closest('.soundTitle')?.querySelector('.soundTitle__username')?.textContent || '').trim(),
      url: link.href,
      restriction: link.closest(rowSelector)?.querySelector(regionSelector)?.textContent.trim() ?? '',
    }));
  }, SEARCH_TRACK, EMPTY_SEARCH, SEARCH_ROW, REGION_LABEL), 15000, 'SoundCloud не показал результаты поиска.');
  return candidates.map((candidate) => ({
    ...candidate,
    url: trackUrl(candidate.url),
    searchUrl: url.href,
    restriction: REGION_TEXT.test(candidate.restriction) ? candidate.restriction : '',
  }));
}

async function findMatch(page, track) {
  const title = titleCredits(track.title).title;
  const queries = new Set([
    [track.artists[0], title].join(' '),
    [...track.artists, title, track.version].filter(Boolean).join(' '),
    title,
  ]);
  let blocked;
  let searchTimeout;
  for (const query of queries) {
    let candidates;
    try {
      candidates = await searchTracks(page, query);
    } catch (error) {
      if (error.name !== 'TimeoutError') throw error;
      searchTimeout ??= error;
      continue;
    }
    for (const candidate of candidates) {
      if (!candidate.url || !isExactMatch(track, candidate)) continue;
      if (!candidate.restriction) return candidate;
      blocked ??= candidate;
    }
  }
  // A failed query could have contained an available version.
  if (searchTimeout) throw searchTimeout;
  return blocked;
}

function readLike(page, match, click = false) {
  return page.evaluate((target, searchUrl, trackSelector, rowSelector, regionSelector, regionPattern, signedIn, apply) => {
    const expected = new URL(searchUrl);
    if (location.pathname !== expected.pathname ||
        new URLSearchParams(location.search).get('q') !== expected.searchParams.get('q')) return 'redirected';

    const link = [...document.querySelectorAll(trackSelector)].filter(visible).find((item) =>
      item.origin + item.pathname.replace(/\/$/, '') === target);
    if (!link) return null;

    const row = link.closest(rowSelector);
    const restriction = row.querySelector(regionSelector)?.textContent.trim() ?? '';
    if (new RegExp(regionPattern, 'iu').test(restriction)) return 'restricted';
    const buttons = [...row.querySelectorAll('button.sc-button-like')].filter(visible);
    if (buttons.length !== 1) return null;

    const button = buttons[0];
    const pressed = button.getAttribute('aria-pressed');
    const label = (button.getAttribute('title') || button.getAttribute('aria-label') || '').trim();
    if (pressed === 'true' || button.classList.contains('sc-button-selected') ||
        /^(Unlike|Remove (?:from )?(?:your )?likes)$/i.test(label)) return 'liked';
    if (pressed !== 'false' && !/^(Like|Нравится)$/i.test(label)) return 'unknown';
    if (!apply) return 'unliked';
    if (![...document.querySelectorAll(signedIn)].some(visible)) return 'signed-out';
    if (button.disabled || button.getAttribute('aria-disabled') === 'true') {
      return 'unavailable';
    }
    button.click();
    return 'clicked';
  }, match.url, match.searchUrl, SEARCH_TRACK, SEARCH_ROW, REGION_LABEL, REGION_TEXT.source, SIGNED_IN, click);
}

async function waitForLike(page, match) {
  const state = await waitFor(() => readLike(page, match), 12000, 'Кнопка лайка найденного трека не появилась в поиске.');
  if (state === 'redirected') throw new Error('SoundCloud перенаправил со страницы поиска.');
  return state;
}

async function likeMatch(page, match) {
  const state = await waitForLike(page, match);
  if (state === 'liked' || state === 'restricted') return state;
  if (state !== 'unliked') throw new Error('Не удалось определить состояние кнопки лайка.');

  const result = await readLike(page, match, true);
  if (result === 'liked' || result === 'restricted') return result;
  if (result === 'signed-out') throw new Error('Не удалось подтвердить вход в SoundCloud.');
  if (result !== 'clicked') throw new Error('Кнопка лайка стала недоступна.');

  await delay(2000);
  await openPage(page, match.searchUrl);
  const confirmed = await waitForLike(page, match);
  if (confirmed === 'liked') return 'added';
  if (confirmed === 'restricted') return 'restricted';
  throw new Error('SoundCloud не подтвердил лайк после повторного открытия поиска.');
}

async function writeRegionReport(tracks) {
  const blocked = tracks.filter((track) => track.soundcloud?.status === REGION_BLOCKED).map((track) => ({
    title: track.title,
    artists: track.artists,
    version: track.version,
    soundcloudUrl: track.soundcloud.url,
    restriction: track.soundcloud.restriction,
  }));
  await writeJson(REGION_REPORT, blocked);
  return blocked.length;
}

function isHandled(track) {
  return track.soundcloud?.status === LIKED || track.soundcloud?.status === REGION_BLOCKED;
}

async function importLikes(page, data, path) {
  const { tracks } = data;
  await openPage(page, SOUNDCLOUD);
  const hasAccount = () => page.evaluate((selector) => [...document.querySelectorAll(selector)].some(visible), SIGNED_IN);
  try {
    await waitFor(hasAccount, 4000, 'Вход в SoundCloud пока не подтверждён.');
  } catch (error) {
    if (error.name !== 'TimeoutError') throw error;
    await prompt('Если нужно, войдите в SoundCloud в рабочей вкладке Chrome и нажмите Enter в Терминале. ');
    await waitFor(hasAccount, 12000, 'Не удалось подтвердить вход в SoundCloud.');
  }

  let liked = 0;
  let already = 0;
  let cached = 0;
  let missing = 0;
  let timedOut = 0;
  const likedUrls = new Set();
  for (const [index, track] of tracks.entries()) {
    const label = `${index + 1}/${tracks.length}  ${track.artists.join(', ')} — ${track.title || track.label || '?'}`;
    if (isHandled(track)) {
      cached += 1;
      const status = track.soundcloud.status === LIKED ? 'лайк подтверждён ранее' : 'недоступен в регионе';
      console.log(`${label}  ·  Пропущен по статусу — ${status}`);
      continue;
    }

    try {
      let match;
      try {
        if (track.title && track.artists.length) match = await findMatch(page, track);
      } catch (error) {
        if (error.name !== 'TimeoutError') throw error;
        timedOut += 1;
        console.log(`${label}  ·  Поиск не ответил, пропущен до следующего запуска`);
        await delay(700);
        continue;
      }
      if (!match) {
        missing += 1;
        console.log(`${label}  ·  Совпадение не найдено`);
        await delay(700);
        continue;
      }

      let state = 'restricted';
      if (!match.restriction) state = likedUrls.has(match.url) ? 'liked' : await likeMatch(page, match);
      if (state === 'restricted') {
        track.soundcloud = {
          status: REGION_BLOCKED,
          url: match.url,
          restriction: match.restriction || 'Недоступен в регионе',
        };
        await writeJson(path, data);
        await writeRegionReport(tracks);
        console.log(`${label}  ·  Пропущен, недоступен в регионе`);
      } else {
        track.soundcloud = { status: LIKED, url: match.url };
        await writeJson(path, data);
        likedUrls.add(match.url);
        if (state === 'liked') {
          already += 1;
          console.log(`${label}  ·  Уже в лайках`);
        } else {
          liked += 1;
          console.log(`${label}  ·  Лайк поставлен  ${match.url}`);
        }
      }
      await delay(700);
    } catch (error) {
      throw new Error(`Остановка на треке ${label}. Новых лайков подтверждено — ${liked}. ${error.message}`);
    }
  }
  const blocked = tracks.filter((track) => track.soundcloud?.status === REGION_BLOCKED).length;
  console.log(`Новых лайков — ${liked}. Уже были в лайках — ${already}. Пропущено по статусу — ${cached}.`);
  console.log(`Без совпадения — ${missing}. Поиск не ответил — ${timedOut}. Регионально недоступных — ${blocked}, список в ${REGION_REPORT}.`);
}

async function clearStatus(path, data, selection) {
  const index = Number(selection) - 1;
  if (selection !== 'all' && (!/^\d+$/.test(selection) || index < 0 || index >= data.tracks.length)) {
    throw new Error(`Укажите номер от 1 до ${data.tracks.length} или all.`);
  }
  const selected = selection === 'all' ? data.tracks : [data.tracks[index]];
  for (const track of selected) delete track.soundcloud;
  await writeJson(path, data);
  await writeRegionReport(data.tracks);
  if (selection === 'all') console.log('Статусы всех треков сброшены.');
  else console.log(`Статус трека ${index + 1} «${selected[0].title}» сброшен.`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: 'string', default: 'tracks.json' },
      'clear-status': { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log('npm run import -- [--input tracks.json]');
    console.log('npm run import -- --clear-status <номер трека|all> [--input tracks.json]');
    return;
  }

  const path = resolve(values.input);
  if (path === resolve(REGION_REPORT)) throw new Error('Укажите файл треков отдельно от регионального отчёта.');
  const data = JSON.parse(await readFile(path, 'utf8'));
  if (data?.source !== 'yandex-music' || !Array.isArray(data.tracks) || data.tracks.some((track) =>
    !track || typeof track.title !== 'string' || typeof track.version !== 'string' ||
    !Array.isArray(track.artists) || track.artists.some((artist) => typeof artist !== 'string'))) {
    throw new Error('Некорректный файл треков. Используйте результат npm run export.');
  }
  if (!data.tracks.length) throw new Error('Файл треков пуст.');
  if (values['clear-status'] !== undefined) {
    await clearStatus(path, data, values['clear-status']);
    return;
  }
  await writeRegionReport(data.tracks);
  if (data.tracks.every(isHandled)) {
    console.log('У всех треков уже есть статус. Поиск не требуется.');
    return;
  }
  await withChromeTab(SOUNDCLOUD, (page) => importLikes(page, data, path));
}

await withProjectLock(main).catch(fail);
