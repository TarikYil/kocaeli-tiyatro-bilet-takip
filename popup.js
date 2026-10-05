const enabled = document.getElementById('enabled');
const enabledText = document.getElementById('enabledText');
const interval = document.getElementById('interval');
const repeatReminder = document.getElementById('repeatReminder');
const checkNow = document.getElementById('checkNow');
const openVenue = document.getElementById('openVenue');
const statusTitle = document.getElementById('statusTitle');
const statusDetail = document.getElementById('statusDetail');
const dot = document.getElementById('dot');
const events = document.getElementById('events');
const telegramEnabled = document.getElementById('telegramEnabled');
const telegramEnabledText = document.getElementById('telegramEnabledText');
const telegramBotToken = document.getElementById('telegramBotToken');
const telegramChatId = document.getElementById('telegramChatId');
const saveTelegram = document.getElementById('saveTelegram');
const testTelegram = document.getElementById('testTelegram');
const telegramStatus = document.getElementById('telegramStatus');

init();

async function init() {
  const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  renderState(state);
}

enabled.addEventListener('change', saveGeneralSettings);
interval.addEventListener('change', saveGeneralSettings);
repeatReminder.addEventListener('change', saveGeneralSettings);
telegramEnabled.addEventListener('change', () => {
  telegramEnabledText.textContent = telegramEnabled.checked ? 'Açık' : 'Kapalı';
});

checkNow.addEventListener('click', async () => {
  checkNow.disabled = true;
  checkNow.textContent = 'Kontrol ediliyor…';
  setStatus('idle', 'Biletinial kontrol ediliyor…', '');
  const result = await chrome.runtime.sendMessage({ type: 'CHECK_NOW' });
  checkNow.disabled = false;
  checkNow.textContent = 'Şimdi kontrol et';
  const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  renderState(state, result);
});

openVenue.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'OPEN_VENUE' }));

saveTelegram.addEventListener('click', async () => {
  saveTelegram.disabled = true;
  telegramStatus.textContent = 'Kaydediliyor…';
  const result = await saveSettings({ includeTelegram: true });
  saveTelegram.disabled = false;
  telegramStatus.textContent = result?.ok ? 'Telegram ayarları kaydedildi.' : 'Ayarlar kaydedilemedi.';
});

testTelegram.addEventListener('click', async () => {
  testTelegram.disabled = true;
  telegramStatus.textContent = 'Test mesajı gönderiliyor…';
  const saved = await saveSettings({ includeTelegram: true });
  if (!saved?.ok) {
    testTelegram.disabled = false;
    telegramStatus.textContent = 'Önce Telegram ayarları kaydedilemedi.';
    return;
  }
  const result = await chrome.runtime.sendMessage({ type: 'TEST_TELEGRAM' });
  testTelegram.disabled = false;
  telegramStatus.textContent = result?.ok ? 'Telegram test mesajı gönderildi.' : `Telegram hatası: ${result?.error || 'Bilinmeyen hata'}`;
});

async function saveGeneralSettings() {
  enabledText.textContent = enabled.checked ? 'Açık' : 'Kapalı';
  await saveSettings({ includeTelegram: false });
  const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  renderState(state);
}

async function saveSettings({ includeTelegram }) {
  const settings = {
    enabled: enabled.checked,
    intervalMinutes: Number(interval.value),
    repeatReminderMinutes: Number(repeatReminder.value)
  };
  if (includeTelegram) {
    settings.telegramEnabled = telegramEnabled.checked;
    settings.telegramBotToken = telegramBotToken.value.trim();
    settings.telegramChatId = telegramChatId.value.trim();
  }
  return chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
}

function renderState(state, directResult = null) {
  const settings = state?.settings || {};
  enabled.checked = Boolean(settings.enabled);
  enabledText.textContent = enabled.checked ? 'Açık' : 'Kapalı';
  interval.value = String(settings.intervalMinutes || 1);
  repeatReminder.value = String(settings.repeatReminderMinutes || 0);

  telegramEnabled.checked = Boolean(settings.telegramEnabled);
  telegramEnabledText.textContent = telegramEnabled.checked ? 'Açık' : 'Kapalı';
  if (document.activeElement !== telegramBotToken) telegramBotToken.value = settings.telegramBotToken || '';
  if (document.activeElement !== telegramChatId) telegramChatId.value = settings.telegramChatId || '';

  if (state?.lastTelegramError) {
    telegramStatus.textContent = `Son Telegram hatası: ${state.lastTelegramError}`;
  } else if (state?.lastTelegramSuccess) {
    telegramStatus.textContent = `Telegram son başarılı: ${formatDate(state.lastTelegramSuccess)}`;
  }

  if (state?.lastError) {
    setStatus('error', 'Kontrol sırasında hata oluştu', state.lastError);
    renderEvents(state?.lastResult?.events || []);
    return;
  }

  const result = state?.lastResult || directResult;
  const lastCheck = state?.lastCheck ? formatDate(state.lastCheck) : 'Henüz kontrol edilmedi';

  if (!enabled.checked) {
    setStatus('idle', 'Takip kapalı', `Son kontrol ${lastCheck}`);
  } else if (!result) {
    setStatus('idle', 'Takip aktif', `Son kontrol ${lastCheck}`);
  } else if ((result.availableCount || 0) > 0) {
    setStatus('ok', `${result.availableCount} seansta bilet görünüyor`, `Son kontrol ${lastCheck}`);
  } else {
    setStatus('warn', 'Şu anda 2 kişilik uygun bilet görünmüyor', `Son kontrol ${lastCheck}`);
  }

  renderEvents(result?.events || []);
}

function renderEvents(items) {
  events.innerHTML = '';
  if (!items.length) {
    const p = document.createElement('small');
    p.textContent = 'Henüz takip edilecek bir oyun bulunamadı.';
    events.appendChild(p);
    return;
  }

  for (const item of items.slice(0, 30)) {
    const row = document.createElement('div');
    row.className = 'event';

    const link = document.createElement('a');
    link.href = item.purchaseUrl || item.url || '#';
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = item.title || 'Oyun';

    const meta = document.createElement('small');
    const dateTime = [item.sessionDate, item.sessionTime].filter(Boolean).join(' · ');
    meta.textContent = [dateTime, item.hall].filter(Boolean).join(' · ');

    const badge = document.createElement('span');
    if (item.availableForTwo) {
      badge.className = 'badge available';
      badge.textContent = typeof item.seatsLeft === 'number'
        ? `${item.seatsLeft} bilet · 2+ uygun`
        : 'Satış açık · 2 kişi için kontrol et';
    } else if (item.venueStatus === 'upcoming' || item.reason === 'upcoming') {
      badge.className = 'badge upcoming';
      badge.textContent = 'Satış henüz açılmadı';
    } else {
      badge.className = 'badge sold';
      badge.textContent = item.venueStatus === 'sold_out' || item.reason === 'sold_out' ? 'Tükendi' : 'Uygun bilet görünmüyor';
    }

    const adjacent = document.createElement('small');
    adjacent.textContent = adjacencyText(item.adjacencyStatus);

    row.append(link);
    if (meta.textContent) row.appendChild(meta);
    row.append(badge, adjacent);
    events.appendChild(row);
  }
}

function adjacencyText(status) {
  if (status === 'confirmed') return 'Yan yana koltuk: uygun görünüyor';
  if (status === 'unavailable') return 'Yan yana koltuk: uygun görünmüyor';
  return 'Yan yana koltuk: doğrulanamadı';
}

function setStatus(kind, title, detail) {
  dot.className = `dot ${kind}`;
  statusTitle.textContent = title;
  statusDetail.textContent = detail || '';
}

function formatDate(iso) {
  try {
    return new Intl.DateTimeFormat('tr-TR', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}
