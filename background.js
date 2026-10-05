const VENUE_URL = 'https://biletinial.com/tr-tr/mekan/kocaeli-buyuksehir-belediyesi-sehir-tiyatrolari';
const VENUE_NAME = 'Kocaeli Büyükşehir Belediyesi Şehir Tiyatroları';
const DEFAULT_SETTINGS = {
  enabled: true,
  intervalMinutes: 1,
  minTickets: 2,
  repeatReminderMinutes: 0,
  telegramEnabled: false,
  telegramBotToken: '',
  telegramChatId: ''
};

let checkInProgress = false;

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(['settings']);
  const settings = { ...DEFAULT_SETTINGS, ...(current.settings || {}) };
  await chrome.storage.local.set({ settings });
  await rebuildAlarm(settings);
  await checkAvailability('install');
});

chrome.runtime.onStartup.addListener(async () => {
  const settings = await getSettings();
  await rebuildAlarm(settings);
  if (settings.enabled) await checkAvailability('startup');
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'ticket-check') checkAvailability('alarm');
});

chrome.notifications.onClicked.addListener(openNotificationLink);
chrome.notifications.onButtonClicked.addListener(openNotificationLink);

async function openNotificationLink(notificationId) {
  const { notificationLinks = {} } = await chrome.storage.local.get('notificationLinks');
  const url = notificationLinks[notificationId] || VENUE_URL;
  chrome.tabs.create({ url });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target === 'offscreen') return false;

  if (message.type === 'CHECK_NOW') {
    checkAvailability('manual').then(sendResponse);
    return true;
  }

  if (message.type === 'GET_STATE') {
    Promise.all([
      getSettings(),
      chrome.storage.local.get(['lastCheck', 'lastResult', 'lastError', 'lastTelegramError', 'lastTelegramSuccess'])
    ]).then(([settings, state]) => sendResponse({ settings, ...state }));
    return true;
  }

  if (message.type === 'SAVE_SETTINGS') {
    (async () => {
      const oldSettings = await getSettings();
      const incoming = message.settings || {};
      const settings = {
        ...oldSettings,
        ...incoming,
        intervalMinutes: Math.max(1, Number(incoming.intervalMinutes ?? oldSettings.intervalMinutes ?? 1)),
        repeatReminderMinutes: Math.max(0, Number(incoming.repeatReminderMinutes ?? oldSettings.repeatReminderMinutes ?? 0)),
        minTickets: 2,
        telegramEnabled: Boolean(incoming.telegramEnabled ?? oldSettings.telegramEnabled),
        telegramBotToken: String(incoming.telegramBotToken ?? oldSettings.telegramBotToken ?? '').trim(),
        telegramChatId: String(incoming.telegramChatId ?? oldSettings.telegramChatId ?? '').trim()
      };
      await chrome.storage.local.set({ settings });
      await rebuildAlarm(settings);
      if (settings.enabled) await checkAvailability('settings');
      sendResponse({ ok: true, settings });
    })();
    return true;
  }

  if (message.type === 'TEST_TELEGRAM') {
    (async () => {
      const settings = await getSettings();
      try {
        validateTelegramSettings(settings);
        await sendTelegramText(settings, {
          text: '✅ Kocaeli Tiyatro Bilet Takipçisi Telegram bağlantısı çalışıyor.',
          url: VENUE_URL
        });
        const now = new Date().toISOString();
        await chrome.storage.local.set({ lastTelegramError: null, lastTelegramSuccess: now });
        sendResponse({ ok: true });
      } catch (error) {
        const errorText = String(error?.message || error);
        await chrome.storage.local.set({ lastTelegramError: errorText });
        sendResponse({ ok: false, error: errorText });
      }
    })();
    return true;
  }

  if (message.type === 'OPEN_VENUE') {
    chrome.tabs.create({ url: VENUE_URL });
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function rebuildAlarm(settings) {
  await chrome.alarms.clear('ticket-check');
  if (!settings.enabled) return;
  chrome.alarms.create('ticket-check', {
    delayInMinutes: 0.1,
    periodInMinutes: Math.max(1, Number(settings.intervalMinutes || 1))
  });
}

async function ensureOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['DOM_SCRAPING'],
    justification: 'Biletinial sayfalarındaki oyun, seans ve bilet durumunu ayrıştırmak.'
  });
}

async function parseHtml(mode, html, extra = {}) {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'PARSE_HTML',
    mode,
    html,
    ...extra
  });
}

async function fetchPage(url) {
  const response = await fetch(url, {
    method: 'GET',
    cache: 'no-store',
    credentials: 'include',
    redirect: 'follow',
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.7'
    }
  });

  if (!response.ok) throw new Error(`Biletinial HTTP ${response.status}`);
  const html = await response.text();
  if (!html || html.length < 500) throw new Error('Biletinial boş veya beklenmeyen bir yanıt döndürdü.');

  const lower = html.toLocaleLowerCase('tr-TR');
  if (lower.includes('your request is being verified') || lower.includes('isteğiniz doğrulanıyor')) {
    throw new Error('Biletinial güvenlik doğrulaması istedi. Biletinial sitesini Chrome’da bir kez açıp tekrar deneyin.');
  }
  return html;
}

async function checkAvailability(trigger = 'manual') {
  if (checkInProgress) return { ok: false, busy: true };
  checkInProgress = true;

  try {
    const settings = await getSettings();
    if (!settings.enabled && trigger !== 'manual') return { ok: true, disabled: true };

    const venueHtml = await fetchPage(VENUE_URL);
    const venueParsed = await parseHtml('venue', venueHtml, { baseUrl: VENUE_URL });
    if (!venueParsed?.ok) throw new Error(venueParsed?.error || 'Mekân sayfası ayrıştırılamadı.');

    const eventCandidates = (venueParsed.events || []).slice(0, 25);
    const results = [];

    for (const event of eventCandidates) {
      const base = {
        title: event.title || 'Kocaeli Şehir Tiyatroları Oyunu',
        url: event.url || VENUE_URL,
        purchaseUrl: event.url || VENUE_URL,
        venueStatus: event.status || 'unknown',
        venueText: event.text || '',
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
        const eventHtml = await fetchPage(event.url);
        const detail = await parseHtml('event', eventHtml, {
          baseUrl: event.url,
          venueName: VENUE_NAME
        });
        if (!detail?.ok) throw new Error(detail?.error || 'Oyun sayfası ayrıştırılamadı.');

        const sessions = detail.sessions || [];
        if (sessions.length === 0) {
          results.push({
            ...base,
            availableForTwo: event.status === 'on_sale' || detail.pageStatus === 'on_sale',
            seatsLeft: null,
            exactCountKnown: false,
            reason: 'event_page_fallback'
          });
          continue;
        }

        for (const session of sessions) {
          const seatsKnown = typeof session.seatsLeft === 'number';
          const availableForTwo = session.status === 'on_sale' && (!seatsKnown || session.seatsLeft >= settings.minTickets);
          results.push({
            ...base,
            availableForTwo,
            seatsLeft: seatsKnown ? session.seatsLeft : null,
            exactCountKnown: seatsKnown,
            sessionText: session.text || '',
            sessionDate: session.dateText || '',
            sessionTime: session.timeText || '',
            hall: session.hall || VENUE_NAME,
            adjacencyStatus: session.adjacencyStatus || 'unknown',
            purchaseUrl: session.purchaseUrl || event.url,
            reason: availableForTwo
              ? (seatsKnown ? 'two_or_more_confirmed' : 'sale_open')
              : (session.status === 'sold_out' ? 'sold_out' : 'not_available')
          });
        }
      } catch (eventError) {
        results.push({
          ...base,
          availableForTwo: event.status === 'on_sale',
          seatsLeft: null,
          exactCountKnown: false,
          reason: event.status === 'on_sale' ? 'detail_check_failed_but_sale_open' : 'detail_check_failed',
          detailError: String(eventError?.message || eventError)
        });
      }
    }

    if (results.length === 0 && venueParsed.pageStatus) {
      results.push({
        title: 'Kocaeli Şehir Tiyatroları',
        url: VENUE_URL,
        purchaseUrl: VENUE_URL,
        venueStatus: venueParsed.pageStatus,
        hall: VENUE_NAME,
        adjacencyStatus: 'unknown',
        availableForTwo: venueParsed.pageStatus === 'on_sale',
        seatsLeft: null,
        exactCountKnown: false,
        reason: 'page_level_fallback'
      });
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const previous = (await chrome.storage.local.get('availabilityState')).availabilityState || {};
    const nextState = {};
    const notifications = [];

    for (const item of results) {
      const key = trackingKey(item);
      const prior = previous[key] || {};
      const isAvailable = Boolean(item.availableForTwo);
      const wasAvailable = Boolean(prior.available);
      let shouldNotify = false;
      let repeat = false;

      if (isAvailable && !wasAvailable) {
        shouldNotify = true;
      } else if (isAvailable && wasAvailable && settings.repeatReminderMinutes > 0 && prior.notifiedAt) {
        const elapsedMs = now.getTime() - new Date(prior.notifiedAt).getTime();
        if (elapsedMs >= settings.repeatReminderMinutes * 60_000) {
          shouldNotify = true;
          repeat = true;
        }
      }

      nextState[key] = {
        available: isAvailable,
        title: item.title,
        sessionDate: item.sessionDate || '',
        sessionTime: item.sessionTime || '',
        hall: item.hall || '',
        notifiedAt: shouldNotify ? nowIso : (isAvailable ? prior.notifiedAt || null : null),
        updatedAt: nowIso
      };

      if (shouldNotify) notifications.push({ item, repeat });
    }

    const lastResult = {
      trigger,
      eventCount: results.length,
      availableCount: results.filter(r => r.availableForTwo).length,
      events: results
    };

    await chrome.storage.local.set({
      availabilityState: nextState,
      lastCheck: nowIso,
      lastResult,
      lastError: null
    });

    for (const entry of notifications) {
      await notifyAvailability(entry.item, entry.repeat);
      if (settings.telegramEnabled) {
        try {
          validateTelegramSettings(settings);
          await sendTelegramAvailability(entry.item, settings, entry.repeat);
          await chrome.storage.local.set({ lastTelegramError: null, lastTelegramSuccess: new Date().toISOString() });
        } catch (telegramError) {
          await chrome.storage.local.set({ lastTelegramError: String(telegramError?.message || telegramError) });
        }
      }
    }

    return { ok: true, ...lastResult };
  } catch (error) {
    const message = String(error?.message || error);
    const now = new Date().toISOString();
    await chrome.storage.local.set({ lastCheck: now, lastError: message });
    return { ok: false, error: message };
  } finally {
    checkInProgress = false;
  }
}

function trackingKey(item) {
  return [
    item.url || item.title || 'event',
    item.sessionDate || '',
    item.sessionTime || '',
    item.hall || ''
  ].join('|').toLocaleLowerCase('tr-TR');
}

function adjacencyLabel(status) {
  if (status === 'confirmed') return 'Yan yana uygun görünüyor';
  if (status === 'unavailable') return 'Yan yana uygun görünmüyor';
  return 'Yan yana durumu doğrulanamadı';
}

function seatLabel(item) {
  if (item.exactCountKnown && typeof item.seatsLeft === 'number') return `${item.seatsLeft} boş bilet`;
  return 'Boş bilet sayısı net değil';
}

async function notifyAvailability(item, repeat = false) {
  const notificationId = `ticket-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const dateTime = [item.sessionDate, item.sessionTime].filter(Boolean).join(' · ') || 'Tarih/saat bilgisi alınamadı';
  const hall = item.hall || VENUE_NAME;
  const message = `${dateTime}\n${hall}\n${seatLabel(item)} · ${adjacencyLabel(item.adjacencyStatus)}`;
  const targetUrl = item.purchaseUrl || item.url || VENUE_URL;

  const { notificationLinks = {} } = await chrome.storage.local.get('notificationLinks');
  notificationLinks[notificationId] = targetUrl;
  const ids = Object.keys(notificationLinks);
  if (ids.length > 40) {
    for (const oldId of ids.slice(0, ids.length - 40)) delete notificationLinks[oldId];
  }
  await chrome.storage.local.set({ notificationLinks });

  await chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: `${repeat ? 'Hatırlatma' : 'Bilet bulundu'} · ${item.title}`,
    message,
    contextMessage: 'Kocaeli Şehir Tiyatroları',
    priority: 2,
    requireInteraction: true,
    buttons: [{ title: 'Satın alma / koltuk seçimi' }]
  });
}

function validateTelegramSettings(settings) {
  if (!settings.telegramBotToken) throw new Error('Telegram Bot Token boş.');
  if (!settings.telegramChatId) throw new Error('Telegram Chat ID boş.');
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(settings.telegramBotToken)) {
    throw new Error('Telegram Bot Token biçimi geçersiz görünüyor.');
  }
}

async function sendTelegramAvailability(item, settings, repeat = false) {
  const dateTime = [item.sessionDate, item.sessionTime].filter(Boolean).join(' · ') || 'Tarih/saat bilgisi alınamadı';
  const text = [
    repeat ? '🔔 Bilet hâlâ açık' : '🎭 Bilet bulundu',
    `Oyun: ${item.title}`,
    `Tarih/Saat: ${dateTime}`,
    `Salon: ${item.hall || VENUE_NAME}`,
    `Boşluk: ${seatLabel(item)}`,
    `Yan yana: ${adjacencyLabel(item.adjacencyStatus)}`
  ].join('\n');

  await sendTelegramText(settings, {
    text,
    url: item.purchaseUrl || item.url || VENUE_URL
  });
}

async function sendTelegramText(settings, { text, url }) {
  const endpoint = `https://api.telegram.org/bot${settings.telegramBotToken}/sendMessage`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: settings.telegramChatId,
      text,
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[{ text: '🎟 Bilet / Koltuk Seç', url: url || VENUE_URL }]]
      }
    })
  });

  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new Error(data?.description || `Telegram HTTP ${response.status}`);
  }
  return data;
}
