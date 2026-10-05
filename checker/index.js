import * as cheerio from 'cheerio';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VENUE_URL = 'https://biletinial.com/tr-tr/mekan/kocaeli-buyuksehir-belediyesi-sehir-tiyatrolari';
const CITY_THEATRE_URL = 'https://biletinial.com/tr-tr/tiyatro/kocaeli';
const VENUE_NAME = 'Kocaeli Büyükşehir Belediyesi Şehir Tiyatroları';
const BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '').trim();
const MIN_TICKETS = Math.max(2, Number(process.env.MIN_TICKETS || 2));
const REPEAT_REMINDER_MINUTES = Math.max(0, Number(process.env.REPEAT_REMINDER_MINUTES || 0));
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.resolve(process.env.STATE_FILE || path.join(HERE, 'state.json'));

validateConfig();
await runCheck();

function validateConfig() {
  if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN tanımlı değil.');
  if (!CHAT_ID) throw new Error('TELEGRAM_CHAT_ID tanımlı değil.');
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(BOT_TOKEN)) throw new Error('TELEGRAM_BOT_TOKEN biçimi geçersiz görünüyor.');
}

async function runCheck() {
  const results = await collectAvailability();
  if (!results.length) throw new Error('Kontrol sonucu boş geldi, state değiştirilmedi.');

  const state = await loadState();
  const now = new Date();
  const previousItems = state.items || {};
  const nextItems = { ...previousItems };
  let notified = 0;

  for (const item of results) {
    const key = trackingKey(item);
    const prior = previousItems[key] || {};
    const available = Boolean(item.availableForTwo);
    const wasAvailable = Boolean(prior.available);
    let shouldNotify = false;
    let repeat = false;

    if (available && !wasAvailable) {
      shouldNotify = true;
    } else if (available && wasAvailable && REPEAT_REMINDER_MINUTES > 0 && prior.notifiedAt) {
      const elapsed = now.getTime() - new Date(prior.notifiedAt).getTime();
      if (Number.isFinite(elapsed) && elapsed >= REPEAT_REMINDER_MINUTES * 60_000) {
        shouldNotify = true;
        repeat = true;
      }
    }

    let notificationSent = false;
    if (shouldNotify) {
      await sendAvailability(item, repeat);
      notificationSent = true;
      notified += 1;
    }

    const availabilityChanged = available !== wasAvailable;
    nextItems[key] = {
      available,
      title: item.title,
      sessionDate: item.sessionDate || '',
      sessionTime: item.sessionTime || '',
      hall: item.hall || '',
      notifiedAt: notificationSent ? now.toISOString() : (available ? prior.notifiedAt || null : null),
      updatedAt: (availabilityChanged || notificationSent || !prior.updatedAt) ? now.toISOString() : prior.updatedAt
    };
  }

  const previousHeartbeat = state.heartbeatAt || null;
  const heartbeatAge = previousHeartbeat ? now.getTime() - new Date(previousHeartbeat).getTime() : Infinity;
  const heartbeatAt = (!Number.isFinite(heartbeatAge) || heartbeatAge >= 30 * 24 * 60 * 60_000)
    ? now.toISOString()
    : previousHeartbeat;

  const nextState = { heartbeatAt, items: nextItems };
  const comparablePrevious = { heartbeatAt: previousHeartbeat, items: previousItems };
  if (JSON.stringify(nextState) !== JSON.stringify(comparablePrevious)) {
    await saveState(nextState);
  }

  for (const item of results) {
    const seatInfo = typeof item.seatsLeft === 'number' ? `${item.seatsLeft} bilet` : 'bilet sayısı bilinmiyor';
    console.log(
      `[session] ${item.title} | ${item.sessionDate || '-'} ${item.sessionTime || ''} | ` +
      `${item.hall || '-'} | ${seatInfo} | ${item.reason || '-'}`
    );
  }

  const suitable = results.filter(x => x.availableForTwo).length;
  console.log(`[check] ${now.toISOString()} ${results.length} seans/kayıt, ${suitable} uygun, ${notified} Telegram bildirimi.`);
}

async function collectAvailability() {
  const venueHtml = await fetchPage(VENUE_URL);
  const venue = parseVenue(venueHtml, VENUE_URL);

  // Biletinial mekan sayfasındaki etkinlik kartları bazı durumlarda href içermiyor.
  // Kocaeli tiyatro liste sayfası ise aynı etkinliklerin gerçek detay URL'lerini içeriyor.
  let cityEventLinks = new Map();
  if (venue.events.some(event => !event.url || event.url === VENUE_URL)) {
    try {
      const cityHtml = await fetchPage(CITY_THEATRE_URL);
      debugRawSnippet(cityHtml, 'karar-kocaeli-bb', 'city-list-slug');
      debugRawSnippet(cityHtml, '>Karar<', 'city-list-title');
      cityEventLinks = parseCityEventLinks(cityHtml, CITY_THEATRE_URL);
    } catch (error) {
      console.error(`[discovery] Kocaeli tiyatro liste sayfası okunamadı: ${error.message}`);
    }
  }

  const events = venue.events.slice(0, 25).map(event => {
    const resolvedUrl = event.url && event.url !== VENUE_URL
      ? event.url
      : cityEventLinks.get(normalize(event.title)) || findEventUrlBySlug(cityEventLinks, event.title) || '';
    return { ...event, url: resolvedUrl || event.url || '' };
  });

  console.log(
    `[discovery] Mekan sayfasında ${events.length} etkinlik bulundu: ` +
    (events.map(event => `${event.title}${event.dateText ? ` (${event.dateText})` : ''}${event.url ? ` -> ${event.url}` : ' -> URL yok'}`).join(', ') || 'yok')
  );

  const results = [];

  for (const event of events) {
    const base = {
      title: event.title || 'Kocaeli Şehir Tiyatroları Oyunu',
      url: event.url || VENUE_URL,
      purchaseUrl: event.url || VENUE_URL,
      venueStatus: event.status || 'unknown',
      sessionDate: event.dateText || '',
      sessionTime: event.timeText || '',
      hall: event.hall || VENUE_NAME,
      adjacencyStatus: 'unknown'
    };

    if (event.status === 'upcoming' || event.status === 'ended') {
      results.push({ ...base, availableForTwo: false, reason: event.status });
      continue;
    }

    if (!event.url || event.url === VENUE_URL) {
      results.push({
        ...base,
        availableForTwo: event.status === 'on_sale',
        seatsLeft: null,
        exactCountKnown: false,
        reason: event.status === 'on_sale' ? 'sale_open_no_detail_url' : event.status === 'sold_out' ? 'sold_out_no_detail_url' : 'event_url_unresolved'
      });
      continue;
    }

    try {
      const html = await fetchPage(event.url);
      debugHtmlMarkers(html, event.title);
      const detail = parseEvent(html, event.url, VENUE_NAME);

      if (!detail.sessions.length) {
        results.push({
          ...base,
          availableForTwo: detail.pageStatus === 'on_sale',
          seatsLeft: null,
          exactCountKnown: false,
          reason: detail.pageStatus === 'on_sale' ? 'event_page_sale_open' : detail.pageStatus
        });
        continue;
      }

      for (const session of detail.sessions) {
        const seatsKnown = typeof session.seatsLeft === 'number';
        const availableForTwo = session.status === 'on_sale' && (!seatsKnown || session.seatsLeft >= MIN_TICKETS);
        results.push({
          ...base,
          availableForTwo,
          seatsLeft: seatsKnown ? session.seatsLeft : null,
          exactCountKnown: seatsKnown,
          sessionDate: session.dateText || event.dateText || '',
          sessionTime: session.timeText || event.timeText || '',
          hall: session.hall || event.hall || VENUE_NAME,
          adjacencyStatus: session.adjacencyStatus || 'unknown',
          purchaseUrl: session.purchaseUrl || event.url,
          reason: availableForTwo ? (seatsKnown ? 'two_or_more_confirmed' : 'sale_open') : session.status
        });
      }
    } catch (error) {
      console.error(`[event] ${event.title} ayrıntı kontrolü başarısız: ${error.message}`);
      results.push({
        ...base,
        availableForTwo: event.status === 'on_sale',
        seatsLeft: null,
        exactCountKnown: false,
        reason: event.status === 'on_sale' ? 'detail_check_failed_but_sale_open' : 'detail_check_failed'
      });
    }
  }

  if (!results.length) {
    results.push({
      title: 'Kocaeli Şehir Tiyatroları',
      url: VENUE_URL,
      purchaseUrl: VENUE_URL,
      venueStatus: venue.pageStatus,
      hall: VENUE_NAME,
      adjacencyStatus: 'unknown',
      availableForTwo: false,
      seatsLeft: null,
      exactCountKnown: false,
      reason: 'no_event_discovered'
    });
  }

  return results;
}

async function fetchPage(url) {
  const attempts = [url];

  try {
    const parsed = new URL(url);
    if ((parsed.hostname === 'biletinial.com' || parsed.hostname === 'www.biletinial.com') && /\/tr-tr\/(?:tiyatro|theatre)\//i.test(parsed.pathname)) {
      const cdn = new URL(url);
      cdn.hostname = 'cdn.biletinial.com';
      attempts.push(cdn.href);
    }
  } catch {}

  let lastError = null;

  for (const attemptUrl of attempts) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25_000);
    try {
      const response = await fetch(attemptUrl, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.7',
          'Cache-Control': 'no-cache'
        }
      });

      if (!response.ok) {
        lastError = new Error(`Biletinial HTTP ${response.status} (${attemptUrl})`);
        continue;
      }

      const html = await response.text();
      if (!html || html.length < 500) {
        lastError = new Error(`Biletinial boş veya beklenmeyen bir yanıt döndürdü (${attemptUrl})`);
        continue;
      }

      const lower = html.toLocaleLowerCase('tr-TR');
      const verification = lower.includes('your request is being verified') || lower.includes('isteğiniz doğrulanıyor');

      if (verification) {
        console.warn(`[fetch] Güvenlik doğrulaması: ${attemptUrl}`);
        lastError = new Error('Biletinial otomatik isteğe güvenlik doğrulaması döndürdü.');
        continue;
      }

      if (attemptUrl !== url) console.log(`[fetch] CDN fallback başarılı: ${attemptUrl}`);
      return html;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error('Biletinial sayfası alınamadı.');
}

function parseVenue(html, baseUrl) {
  const $ = cheerio.load(html);
  const pageText = cleanText($('body').text());
  const map = new Map();

  const upsert = candidate => {
    if (!candidate?.title) return;
    const key = normalize(candidate.title);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, candidate);
      return;
    }
    const rank = { on_sale: 5, sold_out: 4, upcoming: 3, ended: 2, unknown: 1 };
    const candidateHasUrl = Boolean(candidate.url && candidate.url !== baseUrl);
    const existingHasUrl = Boolean(existing.url && existing.url !== baseUrl);
    if (
      (candidateHasUrl && !existingHasUrl) ||
      (rank[candidate.status] || 0) > (rank[existing.status] || 0) ||
      (candidate.dateText && !existing.dateText)
    ) {
      map.set(key, { ...existing, ...candidate });
    }
  };

  $('a[href]').each((_, node) => {
    const anchor = $(node);
    const url = absoluteUrl(anchor.attr('href'), baseUrl);
    if (!isEventUrl(url)) return;
    const container = nearestUsefulContainer($, anchor);
    const text = cleanText(container.text() || anchor.text());
    let title = cleanText(
      anchor.find('h1,h2,h3,h4,h5,h6').first().text() ||
      container.find('h1,h2,h3,h4,h5,h6').first().text() ||
      anchor.text()
    );
    title = title.replace(/^(TÜKENDİ|BİLETİNİ AL|Yakında)\s*/i, '').trim();
    if (!title || title.length > 180) title = cleanText(anchor.find('img[alt]').first().attr('alt') || '');
    if (!title || title.length < 2) return;
    const dt = extractListingDate(text);
    upsert({
      title,
      url,
      status: statusFromText(text),
      dateText: dt.dateText,
      timeText: dt.timeText,
      text: text.slice(0, 1200)
    });
  });

  // Güncel mekan sayfasında etkinlik kartı bazen link yerine yalnızca h3 + tarih olarak geliyor.
  $('h3').each((_, node) => {
    const heading = $(node);
    const title = cleanText(heading.text());
    if (!title || title.length < 2 || title.length > 180) return;
    const container = heading.closest('li');
    if (!container.length) return;
    const text = cleanText(container.text());
    const dt = extractListingDate(text);
    if (!dt.dateText) return;

    let url = '';
    container.find('a[href]').each((__, linkNode) => {
      if (url) return;
      const candidate = absoluteUrl($(linkNode).attr('href'), baseUrl);
      if (isEventUrl(candidate)) url = candidate;
    });

    upsert({
      title,
      url,
      status: statusFromText(text),
      dateText: dt.dateText,
      timeText: dt.timeText,
      text: text.slice(0, 1200)
    });
  });

  return { events: [...map.values()], pageStatus: statusFromText(pageText) };
}

function slugifyTitle(value = '') {
  return normalize(value)
    .replace(/ı/g, 'i')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function findEventUrlBySlug(eventMap, title) {
  const slug = slugifyTitle(title);
  if (!slug) return '';

  const urls = [...new Set(eventMap.values())];
  return urls.find(url => {
    try {
      const pathSlug = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
      return pathSlug === slug || pathSlug.startsWith(`${slug}-`) || pathSlug.includes(`-${slug}-`);
    } catch {
      return false;
    }
  }) || '';
}

function parseCityEventLinks(html, baseUrl) {
  const $ = cheerio.load(html);
  const map = new Map();
  let unnamed = 0;

  $('a[href]').each((_, node) => {
    const anchor = $(node);
    const url = absoluteUrl(anchor.attr('href'), baseUrl);
    if (!isEventUrl(url)) return;

    const li = anchor.closest('li');
    let title = cleanText(
      anchor.find('h1,h2,h3,h4,h5,h6').first().text() ||
      li.find('h1,h2,h3,h4,h5,h6').first().text() ||
      anchor.attr('title') ||
      anchor.find('img[alt]').first().attr('alt') ||
      anchor.text()
    );

    title = title.replace(/^(TÜKENDİ|BİLETİNİ AL|Yakında)\s*/i, '').trim();

    if (title && title.length >= 2 && title.length <= 180) {
      if (!map.has(normalize(title))) map.set(normalize(title), url);
    }

    // URL'yi her durumda sakla. Başlık DOM'da yoksa slug eşlemesi bunu kullanacak.
    const uniqueKey = `__url_${unnamed++}`;
    map.set(uniqueKey, url);
  });

  console.log(`[discovery] Kocaeli liste sayfasından ${new Set(map.values()).size} etkinlik URL'si bulundu.`);
  return map;
}

function nearestUsefulContainer($, start) {
  let current = start;
  let best = start;
  for (let i = 0; i < 8 && current?.length; i++) {
    const text = cleanText(current.text());
    if (text.length > 0 && text.length <= 5000) best = current;
    if (/(TÜKENDİ|BİLETİNİ AL|Yakında|satışa açılacak|Son\s+\d+\s+Bilet)/i.test(text) && text.length <= 5000) return current;
    current = current.parent();
  }
  return best;
}

function debugRawSnippet(html, marker, label) {
  const source = String(html || '');
  const lower = source.toLocaleLowerCase('tr-TR');
  const i = lower.indexOf(String(marker).toLocaleLowerCase('tr-TR'));
  if (i < 0) {
    console.log(`[raw] ${label} | marker bulunamadı: ${marker}`);
    return;
  }
  const start = Math.max(0, i - 900);
  const end = Math.min(source.length, i + marker.length + 1600);
  const snippet = source.slice(start, end)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .slice(0, 2800);
  console.log(`[raw] ${label}: ${snippet}`);
}

function debugHtmlMarkers(html, label) {
  const text = cleanText(String(html).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '));
  const markers = ['Son 0 Bilet', 'Son ', 'Büyükşehir Belediyesi Kocaeli Kongre Merkezi', '17 Ekim', '20:30'];
  for (const marker of markers) {
    const i = text.toLocaleLowerCase('tr-TR').indexOf(marker.toLocaleLowerCase('tr-TR'));
    if (i < 0) {
      console.log(`[debug] ${label} | "${marker}" bulunamadı`);
      continue;
    }
    const start = Math.max(0, i - 220);
    const end = Math.min(text.length, i + marker.length + 320);
    console.log(`[debug] ${label} | ${marker}: ${text.slice(start, end)}`);
  }
}

function parseEvent(html, baseUrl, venueName) {
  const $ = cheerio.load(html);
  const bodyText = cleanText($('body').text());
  const target = normalize(venueName);
  const map = new Map();

  const addSession = candidate => {
    if (!candidate) return;
    const seatsLeft = typeof candidate.seatsLeft === 'number' ? candidate.seatsLeft : null;
    let status = candidate.status || 'unknown';

    // Biletinial bazen "Son 0 Bilet" yanında genel "BİLETİNİ AL" metnini de bırakıyor.
    // Kalan bilet 0 ise bunu kesin tükenmiş kabul et.
    if (seatsLeft === 0) status = 'sold_out';
    else if (typeof seatsLeft === 'number' && seatsLeft > 0 && status === 'unknown') status = 'on_sale';

    const normalized = { ...candidate, seatsLeft, status };
    const key = [
      normalized.dateText || '',
      normalized.timeText || '',
      normalize(normalized.hall || ''),
      normalized.purchaseUrl || ''
    ].join('|');

    const existing = map.get(key);
    if (!existing || normalized.text.length > existing.text.length) map.set(key, normalized);
  };

  // Güncel Biletinial sayfasında seansın salonu <address> içinde geliyor.
  // Aynı parent içindeki önceki <time> tarih/saat, sonraki öğeler ise kalan bilet bilgisini taşıyor.
  $('address').each((_, node) => {
    const addressEl = $(node);
    const hall = cleanText(addressEl.text());
    if (!hall || hall.length > 220) return;

    const parent = addressEl.parent();
    const previousText = cleanText(addressEl.prevAll().slice(0, 8).text());
    const nextText = cleanText(addressEl.nextAll().slice(0, 8).text());
    const localText = cleanText(`${previousText} ${hall} ${nextText}`);

    // Bir etkinlik seansı olduğuna dair bilet sinyali yoksa bu address öğesini atla.
    if (!/(Son\s+\d+\s+Bilet|BİLETİNİ AL|TÜKENDİ|satışa açılacak|Yakında)/i.test(localText)) return;

    let dateTimeText = cleanText(addressEl.prevAll('time').first().text());
    if (!dateTimeText) {
      addressEl.prevAll().each((__, sibling) => {
        if (dateTimeText) return;
        const candidate = cleanText($(sibling).find('time').last().text());
        if (/\d{1,2}\s+(?:Ocak|Şubat|Mart|Nisan|Mayıs|Haziran|Temmuz|Ağustos|Eylül|Ekim|Kasım|Aralık)/i.test(candidate)) {
          dateTimeText = candidate;
        }
      });
    }

    // Aynı parent çok genişse yalnızca yakın komşuları kullan, tarih/saat ayrıca eklenir.
    const sessionText = cleanText(`${dateTimeText} ${hall} ${nextText}`);
    const { dateText, timeText } = extractDateTime(sessionText);
    const seatsLeft = extractSeatsLeft(sessionText);

    addSession({
      status: statusFromText(sessionText),
      seatsLeft,
      dateText,
      timeText,
      hall,
      purchaseUrl: extractPurchaseUrl($, parent, baseUrl),
      adjacencyStatus: adjacencyFromText(sessionText),
      text: sessionText.slice(0, 1800)
    });
  });

  // Bazı varyantlarda address ile time farklı seviyelerde yer alabiliyor.
  // Bu durumda time öğesinden yukarı doğru küçük bir ortak konteyner bulmayı dene.
  if (!map.size) {
    $('time').each((_, node) => {
      const timeEl = $(node);
      const timeTextRaw = cleanText(timeEl.text());
      if (!/\d{1,2}\s+(?:Ocak|Şubat|Mart|Nisan|Mayıs|Haziran|Temmuz|Ağustos|Eylül|Ekim|Kasım|Aralık)/i.test(timeTextRaw)) return;

      let container = timeEl;
      let chosen = null;
      for (let i = 0; i < 10 && container?.length; i++) {
        const text = cleanText(container.text());
        const hasHall = container.find('address').length > 0;
        const hasTicketSignal = /(Son\s+\d+\s+Bilet|BİLETİNİ AL|TÜKENDİ|satışa açılacak|Yakında)/i.test(text);
        if (hasHall && hasTicketSignal && text.length <= 12000) {
          chosen = container;
          break;
        }
        container = container.parent();
      }
      if (!chosen?.length) return;

      const rawText = cleanText(chosen.text());
      const { dateText, timeText } = extractDateTime(rawText);
      const hall = cleanText(chosen.find('address').first().text()) || venueName;
      const seatsLeft = extractSeatsLeft(rawText);
      addSession({
        status: statusFromText(rawText),
        seatsLeft,
        dateText,
        timeText,
        hall,
        purchaseUrl: extractPurchaseUrl($, chosen, baseUrl),
        adjacencyStatus: adjacencyFromText(rawText),
        text: rawText.slice(0, 1800)
      });
    });
  }

  // Eski / farklı sayfa yapıları için önceki genel yaklaşımı yedek olarak koru.
  if (!map.size) {
    $('body *').each((_, node) => {
      const el = $(node);
      if (el.children().length > 8) return;
      const text = normalize(el.text());
      if (!text.includes(target)) return;

      const container = nearestSessionContainer($, el);
      const rawText = cleanText(container.text() || el.text());
      if (!rawText) return;
      const { dateText, timeText } = extractDateTime(rawText);
      addSession({
        status: statusFromText(rawText),
        seatsLeft: extractSeatsLeft(rawText),
        dateText,
        timeText,
        hall: extractHall($, container, venueName),
        purchaseUrl: extractPurchaseUrl($, container, baseUrl),
        adjacencyStatus: adjacencyFromText(rawText),
        text: rawText.slice(0, 1800)
      });
    });
  }

  if (!map.size && normalize(bodyText).includes(target)) {
    const { dateText, timeText } = extractDateTime(bodyText);
    addSession({
      status: statusFromText(bodyText),
      seatsLeft: extractSeatsLeft(bodyText),
      dateText,
      timeText,
      hall: venueName,
      purchaseUrl: baseUrl,
      adjacencyStatus: adjacencyFromText(bodyText),
      text: bodyText.slice(0, 1800)
    });
  }

  let pageStatus = statusFromText(bodyText);
  const pageSeats = extractSeatsLeft(bodyText);
  if (pageSeats === 0) pageStatus = 'sold_out';

  return { sessions: [...map.values()], pageStatus };
}

function nearestSessionContainer($, start) {
  let current = start;
  let best = start;
  for (let i = 0; i < 9 && current?.length; i++) {
    const text = cleanText(current.text());
    if (text.length > 0 && text.length <= 5000) best = current;
    if (/(Son\s+\d+\s+Bilet|BİLETİNİ AL|TÜKENDİ|Yakında|satışa açılacak|koltuk seç)/i.test(text) && text.length <= 5000) return current;
    current = current.parent();
  }
  return best;
}

function extractPurchaseUrl($, container, baseUrl) {
  let selected = '';
  container.find('a[href]').each((_, node) => {
    if (selected) return;
    const a = $(node);
    if (/(biletini al|satın al|koltuk seç|bilet al)/i.test(cleanText(a.text()))) selected = absoluteUrl(a.attr('href'), baseUrl);
  });
  if (selected) return selected;
  const first = container.find('a[href]').first().attr('href');
  return first ? absoluteUrl(first, baseUrl) : baseUrl;
}

function extractHall($, container, venueName) {
  const selectors = ['[class*="salon" i]', '[class*="hall" i]', '[class*="venue" i]', '[class*="location" i]', '[data-testid*="venue" i]', '[data-testid*="hall" i]'];
  for (const selector of selectors) {
    const value = cleanText(container.find(selector).first().text());
    if (value && value.length <= 180) return value;
  }
  const text = cleanText(container.text());
  const m = text.match(/(?:Salon|Sahne|Mekân|Mekan)\s*[:\-]?\s*([^|•]{3,100})/i);
  if (m) {
    const value = cleanText(m[1]).split(/(?:Tarih|Saat|Bilet|TÜKENDİ|BİLETİNİ)/i)[0].trim();
    if (value) return value;
  }
  return venueName;
}

function extractSeatsLeft(text) {
  const t = cleanText(text);
  for (const pattern of [/Son\s+([\d.]+)\s+Bilet/i, /([\d.]+)\s+(?:adet\s+)?(?:boş|uygun)\s+(?:koltuk|bilet)/i]) {
    const m = t.match(pattern);
    if (!m) continue;
    const n = Number(m[1].replace(/\./g, ''));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function extractDateTime(text) {
  const t = cleanText(text);
  const months = '(?:Ocak|Şubat|Mart|Nisan|Mayıs|Haziran|Temmuz|Ağustos|Eylül|Ekim|Kasım|Aralık)';
  const dateMatch = t.match(new RegExp(`(\\d{1,2}\\s+${months}(?:\\s+\\w+)?)`, 'i'));
  const numeric = t.match(/\b(\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?)\b/);
  const time = t.match(/\b([01]?\d|2[0-3])[.:]([0-5]\d)\b/);
  return {
    dateText: dateMatch?.[1] || numeric?.[1] || '',
    timeText: time ? `${time[1].padStart(2, '0')}:${time[2]}` : ''
  };
}

function extractListingDate(text) {
  const t = cleanText(text);
  const months = '(Ocak|Şubat|Mart|Nisan|Mayıs|Haziran|Temmuz|Ağustos|Eylül|Ekim|Kasım|Aralık)';
  const listing = t.match(new RegExp(`${months}\\s*-\\s*(\\d{1,2})`, 'i'));
  const time = t.match(/\b([01]?\d|2[0-3])[.:]([0-5]\d)\b/);
  return {
    dateText: listing ? `${listing[2]} ${listing[1]}` : '',
    timeText: time ? `${time[1].padStart(2, '0')}:${time[2]}` : ''
  };
}

function statusFromText(text) {
  const t = normalize(text);
  if (/bu etkinlik gerçekleşti|etkinlik gerçekleşti|etkinlik sona erdi|event happened|event ended/.test(t)) return 'ended';
  if (/tükendi|bilet tükendi|sold out/.test(t)) return 'sold_out';
  if (/yakında|satışa açılacak|henüz satışta değil/.test(t)) return 'upcoming';
  if (/biletini al|satın al|bilet al|koltuk seç/.test(t)) return 'on_sale';
  return 'unknown';
}

function adjacencyFromText(text) {
  const t = normalize(text);
  if (/yan yana[^.]{0,35}(yok|bulunmuyor|kalmadı|uygun değil)/.test(t)) return 'unavailable';
  if (/yan yana/.test(t) && /(uygun|mevcut|var|seç)/.test(t)) return 'confirmed';
  return 'unknown';
}

function trackingKey(item) {
  return [item.url || item.title || 'event', item.sessionDate || '', item.sessionTime || '', item.hall || '']
    .join('|')
    .toLocaleLowerCase('tr-TR');
}

async function sendAvailability(item, repeat) {
  const dateTime = [item.sessionDate, item.sessionTime].filter(Boolean).join(' · ') || 'Tarih/saat bilgisi alınamadı';
  const text = [
    repeat ? '🔔 Bilet hâlâ açık' : '🎭 Bilet bulundu',
    `Oyun: ${item.title}`,
    `Tarih/Saat: ${dateTime}`,
    `Salon: ${item.hall || VENUE_NAME}`,
    `Boşluk: ${seatLabel(item)}`,
    `Yan yana: ${adjacencyLabel(item.adjacencyStatus)}`
  ].join('\n');
  await sendTelegram(text, item.purchaseUrl || item.url || VENUE_URL);
}

async function sendTelegram(text, url) {
  const endpoint = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: '🎟 Bilet / Koltuk Seç', url: url || VENUE_URL }]] }
    })
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) throw new Error(data?.description || `Telegram HTTP ${response.status}`);
}

function seatLabel(item) {
  return item.exactCountKnown && typeof item.seatsLeft === 'number' ? `${item.seatsLeft} boş bilet` : 'Boş bilet sayısı net değil';
}

function adjacencyLabel(status) {
  if (status === 'confirmed') return 'Yan yana uygun görünüyor';
  if (status === 'unavailable') return 'Yan yana uygun görünmüyor';
  return 'Yan yana durumu doğrulanamadı';
}

function absoluteUrl(href, baseUrl) {
  try { return new URL(href, baseUrl).href; } catch { return ''; }
}

function isEventUrl(url) {
  try {
    const p = new URL(url).pathname.replace(/\/+$/, '');
    return /^\/tr-tr\/(?:tiyatro|theatre)\/[a-z0-9ğüşöçıİĞÜŞÖÇ_-]+$/i.test(p);
  } catch { return false; }
}

function cleanText(value = '') {
  return String(value).replace(/\u00a0/g, ' ').replace(/[\t\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function normalize(value = '') {
  return cleanText(value).toLocaleLowerCase('tr-TR');
}

async function loadState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { items: {} };
    console.error('[state] State okunamadı, yeni state ile devam ediliyor', error.message);
    return { items: {} };
  }
}

async function saveState(state) {
  const temp = `${STATE_FILE}.tmp`;
  await fs.writeFile(temp, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(temp, STATE_FILE);
}

