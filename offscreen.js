chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== 'offscreen' || message.type !== 'PARSE_HTML') return false;
  try {
    if (message.mode === 'venue') {
      sendResponse(parseVenue(message.html, message.baseUrl));
    } else if (message.mode === 'event') {
      sendResponse(parseEvent(message.html, message.baseUrl, message.venueName));
    } else {
      sendResponse({ ok: false, error: 'Bilinmeyen ayrıştırma modu.' });
    }
  } catch (error) {
    sendResponse({ ok: false, error: String(error?.message || error) });
  }
  return false;
});

function parseDocument(html) {
  return new DOMParser().parseFromString(html, 'text/html');
}

function cleanText(value = '') {
  return String(value)
    .replace(/\u00a0/g, ' ')
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function normalize(value = '') {
  return cleanText(value).toLocaleLowerCase('tr-TR');
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

function absoluteUrl(href, baseUrl) {
  try { return new URL(href, baseUrl).href; } catch { return ''; }
}

function isEventUrl(url) {
  try {
    const p = new URL(url).pathname.replace(/\/+$/, '');
    return /^\/tr-tr\/tiyatro\/[a-z0-9ğüşöçıİĞÜŞÖÇ_-]+$/i.test(p);
  } catch {
    return false;
  }
}

function nearestUsefulContainer(el) {
  let current = el;
  let best = el;
  for (let i = 0; i < 8 && current; i++, current = current.parentElement) {
    const text = cleanText(current.innerText || current.textContent || '');
    if (text.length > 0 && text.length <= 5000) best = current;
    if (/(TÜKENDİ|BİLETİNİ AL|Yakında|satışa açılacak|Son\s+\d+\s+Bilet)/i.test(text) && text.length <= 5000) {
      return current;
    }
  }
  return best;
}

function titleFromAnchor(anchor, container) {
  const h = anchor.querySelector('h1,h2,h3,h4,h5,h6') || container?.querySelector('h1,h2,h3,h4,h5,h6');
  let title = cleanText(h?.textContent || anchor.textContent || '');
  title = title.replace(/^(TÜKENDİ|BİLETİNİ AL|Yakında)\s*/i, '').trim();
  if (!title || title.length > 180) {
    const img = anchor.querySelector('img[alt]');
    title = cleanText(img?.getAttribute('alt') || '');
  }
  return title;
}

function parseVenue(html, baseUrl) {
  const doc = parseDocument(html);
  const pageText = cleanText(doc.body?.innerText || '');
  const anchors = [...doc.querySelectorAll('a[href]')];
  const map = new Map();

  for (const anchor of anchors) {
    const url = absoluteUrl(anchor.getAttribute('href'), baseUrl);
    if (!isEventUrl(url)) continue;
    const container = nearestUsefulContainer(anchor);
    const text = cleanText(container?.innerText || anchor.innerText || '');
    const title = titleFromAnchor(anchor, container);
    if (!title || title.length < 2) continue;
    const status = statusFromText(text);
    const existing = map.get(url);
    const candidate = { title, url, status, text: text.slice(0, 1200) };
    if (!existing) {
      map.set(url, candidate);
    } else {
      const rank = { on_sale: 4, sold_out: 3, upcoming: 2, unknown: 1 };
      if ((rank[status] || 0) > (rank[existing.status] || 0) || text.length > existing.text.length) map.set(url, candidate);
    }
  }

  for (const heading of doc.querySelectorAll('h2,h3,h4')) {
    const title = cleanText(heading.textContent || '');
    if (!title || title.length > 180) continue;
    let current = heading;
    let link = null;
    let container = null;
    for (let i = 0; i < 7 && current; i++, current = current.parentElement) {
      link = current.querySelector?.('a[href*="/tr-tr/tiyatro/"]') || null;
      const text = cleanText(current.innerText || current.textContent || '');
      if (link && /(TÜKENDİ|BİLETİNİ AL|Yakında|satışa açılacak)/i.test(text)) {
        container = current;
        break;
      }
    }
    if (!link) continue;
    const url = absoluteUrl(link.getAttribute('href'), baseUrl);
    if (!isEventUrl(url)) continue;
    const text = cleanText(container?.innerText || link.innerText || '');
    if (!map.has(url)) map.set(url, { title, url, status: statusFromText(text), text: text.slice(0, 1200) });
  }

  return { ok: true, events: [...map.values()], pageStatus: statusFromText(pageText), pageText: pageText.slice(0, 1800) };
}

function extractSeatsLeft(text) {
  const t = cleanText(text);
  const patterns = [
    /Son\s+([\d.]+)\s+Bilet/i,
    /([\d.]+)\s+(?:adet\s+)?(?:boş|uygun)\s+(?:koltuk|bilet)/i
  ];
  for (const pattern of patterns) {
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
  const numericDateMatch = t.match(/\b(\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?)\b/);
  const timeMatch = t.match(/\b([01]?\d|2[0-3])[.:]([0-5]\d)\b/);
  return {
    dateText: dateMatch?.[1] || numericDateMatch?.[1] || '',
    timeText: timeMatch ? `${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}` : ''
  };
}

function elementCandidatesForVenue(doc, venueName) {
  const target = normalize(venueName);
  if (!target) return [];
  const all = [...doc.querySelectorAll('body *')];
  return all.filter(el => {
    if (el.children.length > 8) return false;
    const text = normalize(el.textContent || '');
    return text.includes(target);
  });
}

function nearestSessionContainer(el) {
  let current = el;
  let best = el;
  for (let i = 0; i < 9 && current; i++, current = current.parentElement) {
    const text = cleanText(current.innerText || current.textContent || '');
    if (text.length > 0 && text.length <= 5000) best = current;
    if (/(Son\s+\d+\s+Bilet|BİLETİNİ AL|TÜKENDİ|Yakında|satışa açılacak|koltuk seç)/i.test(text) && text.length <= 5000) return current;
  }
  return best;
}

function extractPurchaseUrl(container, baseUrl) {
  const links = [...(container?.querySelectorAll?.('a[href]') || [])];
  const preferred = links.find(a => /(biletini al|satın al|koltuk seç|bilet al)/i.test(cleanText(a.textContent || '')));
  const anchor = preferred || links.find(a => /bilet|seans|koltuk|event|activity/i.test(a.getAttribute('href') || '')) || links[0];
  return anchor ? absoluteUrl(anchor.getAttribute('href'), baseUrl) : baseUrl;
}

function extractHall(container, venueName) {
  const selectors = [
    '[class*="salon" i]', '[class*="hall" i]', '[class*="venue" i]', '[class*="location" i]',
    '[data-testid*="venue" i]', '[data-testid*="hall" i]'
  ];
  for (const selector of selectors) {
    const el = container?.querySelector?.(selector);
    const value = cleanText(el?.textContent || '');
    if (value && value.length <= 180) return value;
  }

  const text = cleanText(container?.innerText || container?.textContent || '');
  const hallMatch = text.match(/(?:Salon|Sahne|Mekân|Mekan)\s*[:\-]?\s*([^|•]{3,100})/i);
  if (hallMatch) {
    const value = cleanText(hallMatch[1]).split(/(?:Tarih|Saat|Bilet|TÜKENDİ|BİLETİNİ)/i)[0].trim();
    if (value) return value;
  }
  return venueName || '';
}

function parseEvent(html, baseUrl, venueName) {
  const doc = parseDocument(html);
  const bodyText = cleanText(doc.body?.innerText || '');
  const sessionMap = new Map();
  const candidates = elementCandidatesForVenue(doc, venueName);

  for (const el of candidates) {
    const container = nearestSessionContainer(el);
    const text = cleanText(container?.innerText || el.innerText || '');
    if (!text) continue;
    const status = statusFromText(text);
    const seatsLeft = extractSeatsLeft(text);
    const { dateText, timeText } = extractDateTime(text);
    const hall = extractHall(container, venueName);
    const purchaseUrl = extractPurchaseUrl(container, baseUrl);
    const adjacencyStatus = adjacencyFromText(text);
    const key = `${dateText}|${timeText}|${hall}|${seatsLeft}|${status}`;
    const candidate = {
      status,
      seatsLeft,
      dateText,
      timeText,
      hall,
      purchaseUrl,
      adjacencyStatus,
      text: text.slice(0, 1800)
    };
    const existing = sessionMap.get(key);
    if (!existing || candidate.text.length > existing.text.length) sessionMap.set(key, candidate);
  }

  if (sessionMap.size === 0 && normalize(bodyText).includes(normalize(venueName))) {
    const status = statusFromText(bodyText);
    const { dateText, timeText } = extractDateTime(bodyText);
    sessionMap.set('fallback', {
      status,
      seatsLeft: extractSeatsLeft(bodyText),
      dateText,
      timeText,
      hall: venueName || '',
      purchaseUrl: baseUrl,
      adjacencyStatus: adjacencyFromText(bodyText),
      text: bodyText.slice(0, 1800)
    });
  }

  return { ok: true, url: baseUrl, sessions: [...sessionMap.values()], pageStatus: statusFromText(bodyText) };
}
