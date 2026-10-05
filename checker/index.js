import * as cheerio from 'cheerio';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VENUE_URL = 'https://biletinial.com/tr-tr/mekan/kocaeli-buyuksehir-belediyesi-sehir-tiyatrolari';
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

  const suitable = results.filter(x => x.availableForTwo).length;
  console.log(`[check] ${now.toISOString()} ${results.length} seans/kayıt, ${suitable} uygun, ${notified} Telegram bildirimi.`);
}

async function collectAvailability() {
  const venueHtml = await fetchPage(VENUE_URL);
  const venue = parseVenue(venueHtml, VENUE_URL);
  const events = venue.events.slice(0, 25);
  const results = [];

  for (const event of events) {
    const base = {
      title: event.title || 'Kocaeli Şehir Tiyatroları Oyunu',
      url: event.url || VENUE_URL,
      purchaseUrl: event.url || VENUE_URL,
      venueStatus: event.status || 'unknown',
      hall: VENUE_NAME,
      adjacencyStatus: 'unknown'
    };

    if (event.status === 'sold_out' || event.status === 'upcoming') {
      results.push({ ...base, availableForTwo: false, reason: event.status });
      continue;
    }

    if (!event.url || event.url === VENUE_URL) {
      results.push({
        ...base,
        availableForTwo: event.status === 'on_sale',
        seatsLeft: null,
        exactCountKnown: false,
        reason: event.status === 'on_sale' ? 'sale_open_no_detail_url' : 'unknown'
      });
      continue;
    }

    try {
      const html = await fetchPage(event.url);
      const detail = parseEvent(html, event.url, VENUE_NAME);
      if (!detail.sessions.length) {
        results.push({
          ...base,
          availableForTwo: event.status === 'on_sale' || detail.pageStatus === 'on_sale',
          seatsLeft: null,
          exactCountKnown: false,
          reason: 'event_page_fallback'
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
          sessionDate: session.dateText || '',
          sessionTime: session.timeText || '',
          hall: session.hall || VENUE_NAME,
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
      availableForTwo: venue.pageStatus === 'on_sale',
      seatsLeft: null,
      exactCountKnown: false,
      reason: 'page_level_fallback'
    });
  }
  return results;
}

async function fetchPage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.7',
        'Cache-Control': 'no-cache'
      }
    });
    if (!response.ok) throw new Error(`Biletinial HTTP ${response.status}`);
    const html = await response.text();
    if (!html || html.length < 500) throw new Error('Biletinial boş veya beklenmeyen bir yanıt döndürdü.');
    const lower = html.toLocaleLowerCase('tr-TR');
    if (lower.includes('your request is being verified') || lower.includes('isteğiniz doğrulanıyor')) {
      throw new Error('Biletinial otomatik isteğe güvenlik doğrulaması döndürdü. GitHub Actions çalışmasında bu durum geçici veya IP kaynaklı olabilir.');
    }
    return html;
  } finally {
    clearTimeout(timeout);
  }
}

function parseVenue(html, baseUrl) {
  const $ = cheerio.load(html);
  const pageText = cleanText($('body').text());
  const map = new Map();

  $('a[href]').each((_, node) => {
    const anchor = $(node);
    const url = absoluteUrl(anchor.attr('href'), baseUrl);
    if (!isEventUrl(url)) return;
    const container = nearestUsefulContainer($, anchor);
    const text = cleanText(container.text() || anchor.text());
    let title = cleanText(anchor.find('h1,h2,h3,h4,h5,h6').first().text() || container.find('h1,h2,h3,h4,h5,h6').first().text() || anchor.text());
    title = title.replace(/^(TÜKENDİ|BİLETİNİ AL|Yakında)\s*/i, '').trim();
    if (!title || title.length > 180) title = cleanText(anchor.find('img[alt]').first().attr('alt') || '');
    if (!title || title.length < 2) return;

    const status = statusFromText(text);
    const existing = map.get(url);
    const candidate = { title, url, status, text: text.slice(0, 1200) };
    if (!existing) map.set(url, candidate);
    else {
      const rank = { on_sale: 4, sold_out: 3, upcoming: 2, unknown: 1 };
      if ((rank[status] || 0) > (rank[existing.status] || 0) || text.length > existing.text.length) map.set(url, candidate);
    }
  });

  return { events: [...map.values()], pageStatus: statusFromText(pageText) };
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

function parseEvent(html, baseUrl, venueName) {
  const $ = cheerio.load(html);
  const bodyText = cleanText($('body').text());
  const target = normalize(venueName);
  const map = new Map();

  $('body *').each((_, node) => {
    const el = $(node);
    if (el.children().length > 8) return;
    const text = normalize(el.text());
    if (!text.includes(target)) return;

    const container = nearestSessionContainer($, el);
    const rawText = cleanText(container.text() || el.text());
    if (!rawText) return;
    const status = statusFromText(rawText);
    const seatsLeft = extractSeatsLeft(rawText);
    const { dateText, timeText } = extractDateTime(rawText);
    const hall = extractHall($, container, venueName);
    const purchaseUrl = extractPurchaseUrl($, container, baseUrl);
    const adjacencyStatus = adjacencyFromText(rawText);
    const key = `${dateText}|${timeText}|${hall}|${seatsLeft}|${status}`;
    const candidate = { status, seatsLeft, dateText, timeText, hall, purchaseUrl, adjacencyStatus, text: rawText.slice(0, 1800) };
    const existing = map.get(key);
    if (!existing || candidate.text.length > existing.text.length) map.set(key, candidate);
  });

  if (!map.size && normalize(bodyText).includes(target)) {
    const { dateText, timeText } = extractDateTime(bodyText);
    map.set('fallback', {
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

  return { sessions: [...map.values()], pageStatus: statusFromText(bodyText) };
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

function statusFromText(text) {
  const t = normalize(text);
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
    return /^\/tr-tr\/tiyatro\/[a-z0-9ğüşöçıİĞÜŞÖÇ_-]+$/i.test(p);
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

