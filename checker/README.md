# GitHub Actions checker

Bu klasör bilgisayar ve Chrome kapalıyken çalışan tek-seferlik kontrol kodunu içerir.

`index.js` her çağrıldığında Biletinial sayfasını bir kez kontrol eder, gerekiyorsa Telegram bildirimi gönderir ve spam önleme durumunu `state.json` içinde saklar.

Gerekli ortam değişkenleri

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

İsteğe bağlı

- `MIN_TICKETS` varsayılan `2`
- `REPEAT_REMINDER_MINUTES` varsayılan `0`

Bu kodu normalde elle çalıştırmak gerekmez. `.github/workflows/ticket-check.yml` otomatik olarak çağırır.
