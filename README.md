# Kocaeli Şehir Tiyatroları Bilet Takipçisi v1.2

Kocaeli Büyükşehir Belediyesi Şehir Tiyatroları'nın Biletinial sayfasını takip eder. Uygun bilet açıldığında Chrome bildirimi ve isteğe bağlı Telegram mesajı gönderebilir.

Bu sürümde ücretli Render/VPS yapısı kaldırıldı. Bilgisayar ve Chrome kapalıyken takip için GitHub Actions kullanılır.

## Özellikler

- Oyun ve mümkün olduğunda seans bazında takip
- Bildirimde oyun adı, tarih, saat ve salon
- Sayfada görülebiliyorsa boş bilet sayısı
- Yan yana koltuk bilgisi açıkça bulunuyorsa durum bildirimi
- Bilgi kesin değilse tahmin etmek yerine `doğrulanamadı` sonucu
- Bildirime tıklayınca mümkün olan en doğrudan satın alma / koltuk seçimi bağlantısı
- Aynı seans açık kaldığı sürece normalde tek bildirim
- Bilet tükenip daha sonra yeniden açılırsa yeniden bildirim
- İsteğe bağlı tekrar hatırlatma
- Chrome açıkken masaüstü + Telegram bildirimi
- Chrome kapalıyken GitHub Actions + Telegram bildirimi

## 1. Chrome eklentisini kurma

1. ZIP dosyasını çıkar.
2. Chrome'da `chrome://extensions` adresini aç.
3. `Geliştirici modu`nu aç.
4. `Paketlenmemiş öğe yükle` seçeneğine bas.
5. `kocaeli_tiyatro_bilet_takip` klasörünü seç.
6. Eklentiyi açıp kontrol sıklığını seç.
7. İstersen Telegram Bot Token ve Chat ID girip `Telegram test` düğmesine bas.

## 2. Telegram botunu hazırlama

1. Telegram'da `@BotFather` hesabını aç.
2. `/newbot` komutuyla bir bot oluştur.
3. BotFather'ın verdiği Bot Token'ı sakla.
4. Oluşturduğun bota normal Telegram hesabından en az bir mesaj gönder.
5. Chat ID değerini öğren.

Bot Token şifre gibi düşünülmelidir. GitHub'a düz metin olarak yazılmaz. `Secrets` bölümünde saklanır.

## 3. Tamamen ücretsiz 7/24 takip

Tamamen ücretsiz kullanım için GitHub reposunu **Public** oluştur. GitHub'ın standart hosted runner'ları public repolarda ücretsizdir. Private repolarda ise hesap planına bağlı ücretsiz dakika kotası kullanılır.

### Repo oluşturma

1. GitHub'da yeni bir repository oluştur.
2. Repository görünürlüğünü `Public` seç.
3. Bu klasörün içindeki tüm dosyaları repoya yükle.
4. `.github/workflows/ticket-check.yml` dosyasının repo içinde aynı konumda kaldığından emin ol.

### Telegram bilgilerini Secrets olarak ekleme

GitHub repository içinde

`Settings → Secrets and variables → Actions → New repository secret`

bölümüne gir ve iki secret oluştur.

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

Değerlerini kendi Telegram bot bilgilerinden gir.

### İlk testi çalıştırma

1. Repository içinden `Actions` sekmesini aç.
2. `Kocaeli Tiyatro Bilet Takip` workflow'unu seç.
3. `Run workflow` düğmesine bas.
4. Çalışma başarılıysa sistem hazırdır.

Workflow daha sonra yaklaşık her 5 dakikada bir otomatik tetiklenir. GitHub yoğunluğuna göre zamanlanmış işler birkaç dakika gecikebilir.

## Bildirim spam önleme

GitHub her çalışmada yeni bir sanal makine açtığı için bildirim geçmişi `checker/state.json` dosyasında tutulur.

Örnek davranış

- Seans tükendi → mesaj yok
- Bilet açıldı → Telegram mesajı gelir
- Bilet açık kalmaya devam ediyor → tekrar mesaj gelmez
- Seans tükendi → durum sıfırlanır
- Daha sonra tekrar açıldı → yeniden mesaj gelir

State dosyası yalnızca durum değiştiğinde veya hatırlatma gönderildiğinde güncellenir. Bu yüzden her 5 dakikada bir gereksiz commit oluşmaz.

## 5 dakika sonra tekrar hatırlatma

Varsayılan olarak tekrar hatırlatma kapalıdır.

GitHub repository içinde

`Settings → Secrets and variables → Actions → Variables`

bölümünde şu repository variable'ı oluşturabilirsin.

- Adı `REPEAT_REMINDER_MINUTES`
- Değeri `5`

Böylece bilet hâlâ açıksa yaklaşık 5 dakika sonra tekrar Telegram mesajı gelir. `0` veya değişkeni hiç oluşturmamak tekrar hatırlatmayı kapatır.

Aynı bölümde `MIN_TICKETS` değişkeni de kullanılabilir. Varsayılan değer `2`dir.

## Klasör yapısı

```text
kocaeli_tiyatro_bilet_takip/
├── .github/
│   └── workflows/
│       └── ticket-check.yml
├── checker/
│   ├── index.js
│   ├── package.json
│   └── state.json
├── icons/
├── background.js
├── manifest.json
├── offscreen.html
├── offscreen.js
├── popup.css
├── popup.html
└── popup.js
```

## Önemli sınırlama

Biletinial bazı koltuk verilerini dinamik koltuk seçim ekranında gösterebilir. HTML içinde kesin yan yana koltuk bilgisi yoksa uygulama bunu tahmin etmez ve `doğrulanamadı` yazar.

GitHub Actions kontrolü otomatik bilet satın almaz. Yalnızca uygunluğu kontrol eder, Telegram'a haber verir ve satın alma bağlantısını gönderir.
