# AI Limit Ledger

_[English](README.md)_

[![CI](https://github.com/Fatih-Dumlupinar/ai-limit-ledger/actions/workflows/ci.yml/badge.svg)](https://github.com/Fatih-Dumlupinar/ai-limit-ledger/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Fatih-Dumlupinar/ai-limit-ledger/actions/workflows/codeql.yml/badge.svg)](https://github.com/Fatih-Dumlupinar/ai-limit-ledger/actions/workflows/codeql.yml)

Codex, Claude Code, GitHub Copilot ve Grok kullanımını, kotalarını ve sıfırlanma zamanlarını VS
Code durum çubuğundan ve dashboard'dan izleyin — gizliliği önceleyen, telemetrisiz.

## Preview durumu

Bu bir **preview** sürümdür. Sağlayıcı entegrasyonları, ayarlar ve arayüz yüzeyleri işlevsel kabul
edilir ancak sürümler arasında hâlâ değişebilir; aşağıdaki [Bilinen sınırlamalar](#bilinen-sınırlamalar)
bölümü şu anki, dürüst boşluk listesidir.

## Ekran görüntüleri

Bu README şu anda ekran görüntüsü içermiyor — bu bir eksiklik değil, isteğe bağlı bir durumdur.
Aşağıdaki bölümler (özellikler, sağlayıcı matrisi, gizlilik, ayarlar, komutlar) eklentiyi eksiksiz
şekilde açıklar. Gerçek ürün ekran görüntüleri, yalnızca sentetik fixture verisiyle gerçek eklenti
arayüzünden alınarak, gelecekte isteğe bağlı bir belge güncellemesiyle eklenebilir — bu isteğe bağlı
süreç için bkz. [`docs/MARKETPLACE-SCREENSHOT-RUNBOOK.md`](docs/MARKETPLACE-SCREENSHOT-RUNBOOK.md).
Hiçbir zaman mockup, yapay zekâ ile üretilmiş görsel veya placeholder kullanılmaz.

## Neden AI Limit Ledger?

Codex, Claude Code, GitHub Copilot ve Grok'u bir arada kullanmak genellikle bir rate limit'e veya
sıfırlanma penceresine ne kadar yaklaştığınızı görmek için birkaç ayrı dashboard kontrol etmek
anlamına gelir. AI Limit Ledger, zaten erişiminiz olan sağlayıcı durumlarını, yeni bir hesap, yeni
bir giriş veya kendi telemetrisi eklemeden tek bir VS Code durum çubuğu öğesinde ve tek bir
dashboard'da bir araya getirir. Her sağlayıcının kendi resmî (veya açıkça etiketlenmişse deneysel)
yerel ya da ağ yüzeyinden okur — asla bir modele çağrı yapmaz, kullanımı prompt'larınızdan tahmin
etmez ve sağlayıcıları tek bir uydurma sayıda birleştirmez.

## Desteklenen sağlayıcılar

| Sağlayıcı      | Durum                                                                                                                               |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Codex          | Yalnızca resmî, yerel App Server                                                                                                    |
| Claude Code    | Resmî status-line entegrasyonu; bir OAuth kullanım kontrolü **deneyseldir**, varsayılan olarak kapalı                               |
| GitHub Copilot | Resmî GitHub Billing REST API                                                                                                       |
| Grok           | Deneysel `x.ai/billing` capability'sini kullanan resmî Grok Build ACP aktarımı; CLI-proxy yedeği de **deneysel** ve isteğe bağlıdır |

Tam kaynak, hesap/oturum içgörü kapsamı ve deneysel sınırlar için [sağlayıcı yetenek matrisine](docs/PROVIDER_CAPABILITY_MATRIX.md) bakın.

## Temel özellikler

- Codex, Claude Code, GitHub Copilot ve Grok için tek bir durum çubuğu öğesi ve tek bir dashboard;
  sağlayıcı hataları izole edilir — eksik bir CLI hiçbir zaman bir sağlayıcı kartını kaldırmaz.
- Aynı tipli sağlayıcı anlık görüntülerinden render edilen ve birbirleriyle eşleşen bir **Rich
  Dashboard** (temalı webview) ve bir **Safe Dashboard** (webview'siz, salt okunur metin belgesi).
- Markdown kullanım tablosu içeren hover tooltip; tıklandığında tam dashboard açılır.
- Her çalışma zamanı yüzeyinde tipli İngilizce/Türkçe yerelleştirme.
- Sıfır üretim bağımlılığı ve telemetri yok.

## Hızlı başlangıç

AI Limit Ledger,
[Visual Studio Code Marketplace](https://marketplace.visualstudio.com/items?itemName=fatihdumlupinar-dev.ai-limit-ledger)
üzerinde `fatihdumlupinar-dev.ai-limit-ledger` kimliğiyle yayınlanmıştır. Bu bir **önizleme
(preview)** sürümüdür — bkz. [Bilinen sınırlamalar](#bilinen-sınırlamalar).

İki yoldan biriyle kurabilirsiniz:

- **Marketplace arayüzünden** — `Ctrl+Shift+X` (macOS'ta `Cmd+Shift+X`) tuşlarına basın,
  `@id:fatihdumlupinar-dev.ai-limit-ledger` araması yapın ve **Install**'a tıklayın.
- **Komut satırından**:

  ```powershell
  code --install-extension "fatihdumlupinar-dev.ai-limit-ledger"
  ```

Ardından Codex CLI'yi (veya kullandığınız hangi sağlayıcı ise) kurup oturum açın; durum çubuğu bir
sonraki yenilemede raporlamaya başlar.

Eklentiyi kaynaktan derlemek isteyen katkıda bulunanlar için
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) belgesine bakın — bu yol geliştirme içindir, normal
kullanım amacıyla kurulum için değildir.

Webview kullanmayan bir ayrıntı görünümü için `AI Limit Ledger: Select Dashboard Mode` komutunu çalıştırıp `Safe Native` seçin, ardından `AI Limit Ledger: Open Dashboard` çalıştırın. Safe Dashboard, salt okunur bir metin editörü belgesi olarak açılır ve Webview veya Service Worker API'si kullanmaz.

## Rich ve Safe Dashboard

Varsayılan **Rich Dashboard**, sıfırlanma zamanları, plan, CLI/App Server durumu ve kullanılabilir token etkinliği ile temalı bir Webview panelidir. **Safe Dashboard** (`AI Limit Ledger: Select Dashboard Mode` → `Safe Native`), aynı bilgiyi Webview veya Service Worker API'si kullanmadan salt okunur bir metin editörü belgesi olarak sunar; kısıtlı veya Webview'in devre dışı olduğu ortamlar içindir. Her ikisi de aynı tipli sağlayıcı anlık görüntülerini okur ve desteklenen alanlarda birbirleriyle eşleşir.

## Sağlayıcı gereksinimleri

- **Codex** — resmî Codex CLI kurulu ve oturum açık olmalı; AI Limit Ledger yalnızca yerel App Server ile konuşur.
- **Claude Code** — resmî Claude Code CLI; status-line köprüsünü kurmak için **Enable Claude Code Integration** çalıştırın. İsteğe bağlı deneysel OAuth kullanım kontrolü ayrı, açık bir onay gerektirir.
- **GitHub Copilot** — bir VS Code GitHub kimlik doğrulama oturumu veya yalnızca **Plan: read** izinli ince taneli bir PAT; **Connect GitHub Copilot Usage** ile bağlanır.
- **Grok** — resmî Grok Build CLI, `grok login` ile oturum açılmış ve **Enable Grok Usage** açıkça çalıştırılmış olmalı; varsayılan olarak kapalıdır.

## Resmî, deneysel ve türetilmiş veri

Her sağlayıcı kartı ve alanı kaynağıyla etiketlenir. **Resmî**, verinin doğrudan sağlayıcının
belgelediği bir API'den veya yerel bir entegrasyon noktasından geldiği anlamına gelir (Codex'in App
Server'ı, Copilot'un GitHub Billing REST API'si, Claude'un status-line entegrasyonu, Grok'un ACP
aktarımı). **Deneysel**, kaynağın belgelenmemiş veya yalnızca isteğe-bağlı-katılımla kullanılan bir
uç nokta olduğu ve haber verilmeden değişebileceği veya çalışmayı durdurabileceği anlamına gelir
(Claude'un CLI'siz OAuth kullanım kontrolü, Grok'un `x.ai/billing` capability'si ve CLI-proxy
yedeği) — bunlar her zaman varsayılan olarak kapalıdır veya ayrı, açık bir onay adımı gerektirir ve
arayüz bunları her göründükleri yerde deneysel olarak etiketler. **Türetilmiş** alanlar (örneğin
yapılandırılmış bir plandan hesaplanan bir Copilot ödeneği), sağlayıcı tarafından doğrudan
bildirilmiş gibi değil, açıkça hesaplanmış olarak işaretlenir. Sağlayıcı başına tam döküm için
`docs/PROVIDER_CAPABILITY_MATRIX.md` dosyasına bakın.

## Veri ve gizlilik

Codex yalnızca yerel ve salt okunur kalır. Copilot, VS Code'un GitHub Authentication API'sinden gelen bir oturum veya yalnızca VS Code SecretStorage'da saklanan, kullanıcı tarafından girilen bir Plan-read PAT ile `GET /user` ve resmî kullanıcı AI-kredi faturalama uç noktasını çağırır; token'lar asla loglanmaz veya global/workspace state'e yazılmaz ve hiçbir repository/admin/write izni istenmez. Grok, yalnızca sağlayıcısı açıkça etkinleştirildikten sonra `grok agent stdio`'yu başlatır; AI Limit Ledger Grok kimlik doğrulama dosyalarını, prompt/transcript/kod verisini okumaz veya `grok login`'i otomatik olarak çalıştırmaz. Telemetri yoktur.

### Bu eklenti neyi okur

- Codex'in yerel App Server yanıtları (`account/read`, `account/rateLimits/read`, `account/usage/read`).
- Entegrasyonu etkinleştirdiğinizde Claude Code'un kendi status-line JSON çıktısı; ve yalnızca ayrıca onay verirseniz, deneysel kullanım kontrolü için `~/.claude/.credentials.json` dosyasından bellekte OAuth erişim belirteci.
- Bir VS Code GitHub kimlik doğrulama oturumu veya kullanıcı tarafından sağlanan Plan-read PAT kullanılarak GitHub Copilot'un faturalama uç noktaları.
- Yalnızca **Enable Grok Usage** çalıştırdıktan sonra `grok agent stdio` üzerinden Grok Build'in ACP yanıtları.
- Kendi AI Limit Ledger ayarlarınız (`aiLimitLedger.*`).

### Bu eklenti neyi okumaz veya saklamaz

- Hiçbir sağlayıcıdan model prompt'ları, tamamlamalar, transcript'ler veya kaynak kod.
- Kimlik bilgisi değerleri hiçbir zaman loglara, Output Channel'a, diagnostics dışa aktarımlarına veya Marketplace/telemetri servislerine yazılmaz — telemetri yoktur.
- Resmî sağlayıcı bağlantılarından tarayıcı oturumları, çerezler veya sayfa içeriği.
- Deneysel kullanım kontrolü sırasında bile Claude'un kimlik bilgisi dosyasından refresh token, hesap ID, e-posta veya abonelik-planı alanları.
- Ham sağlayıcı API yanıtları kalıcı hale getirilmez — yalnızca tipli, izin listeli, sağlayıcıya özel değerler saklanır.
- Sağlayıcı toplamları (token, kredi, mesaj, dolar, yüzde) sağlayıcılar arasında asla toplanmaz; eksik bir değer sıfır olarak değil, kullanılamaz olarak gösterilir.

## Ayarlar

- `aiLimitLedger.compactStatusBar` — yalnızca yüzdeleri göster.
- `aiLimitLedger.presentationMode` — kalan (varsayılan) veya kullanılan.
- `aiLimitLedger.refreshIntervalSeconds` — varsayılan olarak 30 dakika.
- `aiLimitLedger.codexExecutablePath` — machine kapsamlı mutlak yol veya `auto`; workspace ayarları bunu kontrol edemez.
- `aiLimitLedger.providers` — Codex, Claude Code, GitHub Copilot ve Grok (varsayılan olarak dördü de gösterilir).
- `aiLimitLedger.copilot.plan` — `auto`, `pro`, `proPlus`, `max` veya `custom`; `auto` asla kalan bir yüzde uydurmaz.
- `aiLimitLedger.copilot.customMonthlyCredits` — `custom` plan için kullanıcı ödeneği.
- `aiLimitLedger.copilot.refreshSeconds` ve `aiLimitLedger.grok.refreshSeconds` — 120–3600 saniye, varsayılan 300.
- `aiLimitLedger.grok.executablePath` — isteğe bağlı, machine kapsamlı mutlak Grok Build CLI yolu; workspace'e göreli yollar reddedilir.

### Merkezi ayarlar (0.6.0)

`aiLimitLedger.dashboard.insightsMode`, window kapsamlıdır ve `summary` (varsayılan), `detailed` veya `hidden` değerlerini kabul eder. Rich ve Safe Native Dashboard'lar tarafından paylaşılır ve yalnızca sunumu değiştirir; sağlayıcıları yenilemez, kimlik bilgisi okumaz, ağ çağrısı yapmaz veya eylemleri sıfırlamaz.

Tipli ayarlar servisi sağlayıcı takma adlarını normalleştirir, yinelenenleri kaldırır, bilinmeyen kimlikleri yok sayar, eşik sıralamasını ve sayısal sınırları doğrular ve yalnızca güvenli tanılar bildirir. Dashboard ve durum çubuğu sağlayıcı sırası/görünürlüğü birbirinden bağımsızdır. `display.percentageMode`; `remaining`, `used` ve `both` değerlerini destekler; dil `auto`, `en` ve `tr` değerlerini destekler; zaman biçimi `locale`, `relative`, `absolute` ve `both` değerlerini destekler. Tooltip yoğunluğu, bildirim/log seviyeleri ve sınırlı son-bilinen-iyi önbellek politikası da yapılandırılabilir.

Komut Paletinden **Select Status Bar Mode**, **Select Percentage Display**, **Reset Display Settings** ve **Copy Redacted Effective Settings** kullanın. Sağlayıcı seçimi değişiklikleri hemen uzlaştırılır; çalıştırılabilir dosya değişiklikleri yalnızca algılamayı yeniden çalıştırır. Yenileme değişiklikleri mevcut minimum-aralık, single-flight, lease ve backoff korumalarını korur. Machine kapsamlı yollar ve deneysel ayarlar workspace değerlerini yok sayar; deneysel Copilot/Grok taşıyıcıları ayrıca ayrı onay meta verisi gerektirir.

## Komutlar

Tüm komutlar Komut Paletinden (`Ctrl+Shift+P`) `AI Limit Ledger:` önekiyle kullanılabilir. En sık
kullanılanlar:

- **Open Dashboard**, **Open Rich Dashboard**, **Open Safe Dashboard**, **Select Dashboard Mode**
- **Refresh**, **Refresh Codex**, **Refresh Claude**, **Refresh GitHub Copilot Usage**, **Refresh Grok Usage**
- **Enable Claude Code Integration**, **Disable Claude Code Integration**, **Repair Claude Code Integration**, **Diagnose Claude Code Integration**
- **Enable CLI-free Claude Usage**, **Disable CLI-free Claude Usage**
- **Connect GitHub Copilot Usage**, **Disconnect GitHub Copilot Usage**, **Configure Copilot Plan**, **Diagnose GitHub Copilot Integration**
- **Enable Grok Usage**, **Disable Grok Usage**, **Recheck Grok Installation**, **Launch Grok Login**, **Diagnose Grok Integration**
- **Select Status Bar Mode**, **Select Percentage Display**, **Select Display Language**, **Reset Display Settings**
- **Copy Redacted Diagnostics**, **Copy Redacted Effective Settings**, **Export Redacted Support Bundle**, **Show Logs**, **Clear Cached Usage**

Komut kimlikleri (`aiLimitLedger.*`) çevrilmez; tam liste `package.json`'ın `contributes.commands` bölümünde tanımlıdır.

## CI ve repository güvenliği

Task 12 dört salt-okunur repository kontrolü ekler: `CI`, Ubuntu ve Windows üzerinde derleme,
lint, biçim, audit, test ve VSIX paketleme yapar; `CodeQL`, JavaScript/TypeScript kodunu pull
request'lerde, `main` push'larında ve varsayılan branch üzerinde haftalık tarar; `Secret Scan`,
resmî Gitleaks CLI release'ini SHA-256 ile doğruladıktan sonra tam Git geçmişini redacted çıktıyla
tarar; `Dependency Review` ise pull request'lerde moderate ve üzeri bağımlılık açıklarını reddeder.
Dependabot npm ve GitHub Actions güncellemelerini haftalık kontrol eder ve otomatik merge yapmaz.

Tüm harici Action'lar release sürüm yorumu ile tam commit SHA'ya sabitlenmiştir. Workflow'lar
`pull_request` kullanır, `pull_request_target` kullanmaz, repository secret açığa çıkarmaz ve
minimum izin ister. Güncel GitHub API metadata'sı native secret scanning ve push protection'ı
etkin bildiriyor; Task 12 bu ayarları değiştirmez ve bağımsız secret scan'i zorunlu tutar.
Detaylar için [CI güvenlik tasarımına](docs/CI-SECURITY-DESIGN.md) ve [ruleset kontrol listesine](docs/BRANCH-RULESET.md) bakın.

## Geliştirme gereksinimleri

Kaynaktan derleme ve test için **desteklenen bir Node.js LTS hattı ve npm 10+** gereklidir. Node 20 ömrünün sonuna ulaşmıştır ve artık önerilmez; **Node 24 (güncel LTS) tercih edilen geliştirme sürümüdür** ve **Node 22 (LTS) desteklenen minimum geliştirme çalışma zamanıdır** — bkz. `.nvmrc`/`.node-version` ve `package.json`'ın `engines.node` alanı. Eklentinin kendisi **sıfır üretim bağımlılığına** sahiptir ve çalışma zamanında VS Code `^1.95.0` sürümünü hedefler; derlemek için kullanılan Node sürümü, VS Code eklenti barındırıcısı içinde kullanılabilen Node API'leriyle ilgisizdir ve paketlenmiş `.vsix` dosyasını kuran son kullanıcıların hiçbir zaman Node'a ihtiyacı yoktur.

`npm audit`, yapılandırılmış npm registry'sine ağ erişimi gerektirir — çözümlenmiş bağımlılık ağacınızı bilinen güvenlik açıklarına karşı kontrol etmek için gönderir ve güncel bir sonuç döndürmek için bağlantı gerektirir. Bu, bu projenin kendi bağımlılıksız, tamamen çevrimdışı yerel/VSIX içerik kontrolü olan `npm run audit:release` (`scripts/release-audit.mjs`) ile **aynı araç değildir**; bu iki komut tamamlayıcıdır, birbirinin yerine geçmez ve hiçbiri diğerinin yerini almaz.

Eski `compactStatusBar`, `presentationMode`, kullanılan-yüzde eşikleri, `showErrorNotifications` ve `refreshIntervalSeconds` ayarları, kullanımdan kaldırılmış uyumluluk ayarları olarak kayıtlı kalır ve silinmeden idempotent şekilde taşınır.

### Çalışma zamanı dil davranışı

`aiLimitLedger.display.language`; çalışma zamanı Dashboard'unu, Safe Native Dashboard'u, durum çubuğunu, tooltip'i, bildirimleri, seçicileri ve eylem geri bildirimini kontrol eder. `auto`, VS Code yerel ayarını izler (`tr`, `tr-TR` ve `tr_TR` Türkçe'yi seçer; desteklenmeyen yerel ayarlar İngilizce'ye döner), `en` ve `tr` ise açık geçersiz kılmalardır. Bu yüzeyler, pencere yeniden yüklenmeden ve mevcut önbelleğe alınmış sağlayıcı anlık görüntülerini kullanarak yeniden işlenir; dili değiştirmek bir sağlayıcıyı yenilemez, kimlik bilgisi okumaz, bir işlem başlatmaz veya ağ isteği yapmaz.

Komut Paleti ve Ayarlar katkı başlıkları/açıklamaları, VS Code'un `package.nls.json` / `package.nls.tr.json` mekanizması üzerinden sağlanır. Dilleri VS Code görüntüleme dilini izler ve eklenti katkısı yüklendiğinde seçilir; `display.language`'ı değiştirmek bu platforma ait dizeleri canlı olarak değiştiremez ve Reload Window gerektirebilir.

CLI'siz deneysel Claude kullanım kontrolü, `api.anthropic.com/api/oauth/usage` adresine yapılan bir hesap kullanımı `GET` isteğidir; model üretimi veya mesaj isteği yoktur ve istek gövdesi yoktur. Paylaşılan minimum 120 saniyelik aralık ve 429 backoff politikasına tabi kalmaya devam eder.

### Sağlayıcı kullanım içgörüleri

Ortak tipli içgörü modeli; hesap metriklerini, en son oturum metriklerini, günlük eğilimleri ve kaynak kökenini birbirinden ayrı tutar. Summary modu en fazla beş güvenli alan gösterir; detailed modu kalan izin verilen alanları genişletilebilir bir bölümde sunar; hidden modu birincil kota kartlarını ve sıfırlanma bilgisini değiştirmeden bırakır. Geçersiz, negatif, sonsuz olmayan, bayat veya kullanılamayan değerler, sahte yüzdelere dönüştürülmek yerine atlanır veya etiketlenir.

- Codex yalnızca resmî App Server `account/read`, `account/rateLimits/read` (güncelleme bildirimi dahil) ve `account/usage/read`'i kullanır. Günlük kullanım sıralanır, yinelenen tarihler birleştirilir ve dahili olarak en fazla 30 gün tutulur; varsayılan görünüm son 14 gündür. Sıfırlanma kredileri ve gözlemlenen son kullanma tarihleri yalnızca görüntüleme amaçlıdır.
- Claude'un resmî status-line anlık görüntüsü, hesap 5 saatlik/7 günlük limitlerini en son gözlemlenen CLI oturumundan ayrı tutar — bu oturum içgörüsü her zaman en son gözlemlenen yerel CLI oturumunu yansıtır, hesap genelinde bir toplamı değil. Model, bağlam, girdi/çıktı/önbellek token'ları, tahmini maliyet, süreler, satır sayıları, fast/effort/thinking/output-style alanları açık izin listesi alanlarıdır. Deneysel OAuth hesap limitleri asla resmî oturum metriklerinin üzerine yazılmaz.
- GitHub Copilot, AI kredilerini birincil metrik yapar. Bir ödenek yalnızca yetkiliyse veya açıkça kullanıcı tarafından yapılandırılmışsa gösterilir ve hesaplanmış olarak işaretlenir; organizasyon tarafından yönetilen hesaplarda kişisel bir ödenek olmayabilir ve bu, tahmin edilmek yerine kullanılamaz olarak gösterilir. Premium etkileşimler, sohbet ve tamamlamalar ayrı kalır; organizasyon yönetimi aylık bir payda değildir.
- Grok, deneysel `x.ai/billing` capability'sini kullanan resmî Grok Build ACP aktarımını kullanır. CLI-proxy faturalama yedeği de deneyseldir ve isteğe bağlıdır. Ücretsiz bir Grok hesabı hiç sayısal bir kullanım yüzdesi göstermeyebilir — bu, tahmin edilmek yerine kullanılamaz olarak gösterilir. Eksik ürün dökümleri, boş bir ürün dizisi yerine gösterilmemiş olarak kalır; `/usage`, kullanıcının Grok Build içinde çalıştırdığı resmî hesap görünümüdür ve AI Limit Ledger `/usage` komutunu otomatik çalıştırmaz.

Kaynak ve sınırlama matrisi için `docs/PROVIDER_CAPABILITY_MATRIX.md` dosyasına bakın.

## Claude Code kurulumu

1. VS Code'da `Ctrl+Shift+P` tuşuna basın.
2. **AI Limit Ledger: Enable Claude Code Integration** komutunu çalıştırın.
3. İstenen değişikliği onaylayın.
4. Claude Code'un zaten bir `statusLine` komutu varsa, nasıl devam edileceğini seçin.
5. Bir Claude Code yanıtını tamamlayın.
6. **AI Limit Ledger: Open Dashboard** komutunu çalıştırın.

`AI Limit Ledger: Enable Claude Code Integration`, bir PowerShell komutu değil, bir VS Code Komut Paleti girişidir — bunu bir terminalden değil `Ctrl+Shift+P`'den çalıştırırsınız. Resmî status-line entegrasyonu Claude kimlik bilgilerini okumaz ve açık onayınız olmadan `statusLine`'ı asla değiştirmez. Ayrı, varsayılan olarak kapalı deneysel CLI'siz kullanım aktarımı ise yalnızca açık kullanıcı onayından sonra OAuth erişim belirtecini okuyabilir; ayrıntılar `PRIVACY.md` dosyasında açıklanmıştır.

### Entegrasyon modları

- **Standalone** — Claude Code'un mevcut bir `statusLine`'ı olmadığında kullanılır. AI Limit Ledger kendi köprü komutunu kurar.
- **Preserve and integrate** (önerilen, mevcut bir `statusLine` olduğunda sunulur) — mevcut status-line komutunuzun arkasına küçük bir wrapper zincirler. Wrapper, Claude Code'un status-line JSON'ını bir kez okur, izin verilen bir yerel anlık görüntü yazar, aynı JSON'ı mevcut komutunuza değiştirmeden iletir ve çıktısını Claude Code'a bayt bayt döndürür. Windows'ta tam desteklenir; macOS/Linux'ta en iyi çaba temellidir ve güvenilir zincirleme kurulamazsa açık bir "bu platformda kullanılamıyor" yedeği vardır.
- **Replace after backup** — önceki davranış: mevcut `statusLine`'ınız yedeklenir (devre dışı bırakıldığında geri yüklenebilir), ardından AI Limit Ledger köprüsüyle değiştirilir.

Etkinleştirme işlemseldir (transactional): herhangi bir adım başarısız olursa (wrapper yazma, ayarları güncelleme, sahiplik doğrulama), AI Limit Ledger önceki `statusLine`'ınızı geri yükler ve kısmi dosya bırakmaz. `AI Limit Ledger: Disable Claude Code Integration`, AI Limit Ledger etkinleştirilmeden önce var olan `statusLine`'ı geri yükler ve o zamandan beri başka bir şey onu değiştirmişse üzerine yazmayı reddeder.

## Deneysel: CLI'siz Claude kullanımı

Yalnızca Claude Code VS Code kenar çubuğunu kullanıyorsanız ve hiçbir zaman CLI çalıştırmıyorsanız, resmî status-line entegrasyonunun okuyacağı bir şey yoktur ve Claude `manual-only` olarak gösterilir — bu bir hata değil, tam olarak desteklenen bir moddur. CLI çalıştırmadan otomatik 5s/7g rakamları almak için deneysel taşıyıcıya katılabilirsiniz:

1. **AI Limit Ledger: Enable CLI-free Claude Usage** komutunu çalıştırın (`Enable Claude Code Integration`'dan ayrıdır ve onunla ima edilmez).
2. Onay iletişim kutusunu okuyun — token'ınıza tam olarak ne olacağını ve ne olmayacağını açıklar — ve **Enable Experimental Usage**'ı veya önce tam yazıyı açmak için **Learn More**'u seçin.
3. Claude Dashboard kartı artık `Account limits source: Experimental OAuth usage` gösterir; açıkça `Experimental — undocumented Anthropic usage endpoint` olarak etiketlenmiştir.
4. İstediğiniz zaman tekrar kapatmak için **AI Limit Ledger: Disable CLI-free Claude Usage** çalıştırın; resmî status-line entegrasyonu hiçbir zaman etkilenmez.

Bu, varsayılan olarak kapalıdır, hız sınırlamasına tabi olabilir ve Anthropic uç noktayı değiştirirse çalışmayı durdurabilir — onaydan sonra yalnızca OAuth erişim belirtecini bellekte okur ve `api.anthropic.com/api/oauth/usage`'ı çağırır; bu, Claude Code'un kendi `/usage` komutunun kullandığı aynı belgelenmemiş uç noktadır, genel bir API değildir. Tam ayrıntılar: `docs/EXPERIMENTAL_CLAUDE_USAGE.md` (eklentiyle birlikte paketlenir).

## Resmî sağlayıcı bağlantıları

Dashboard, Safe Dashboard ve Komut Paleti eylemleri salt okunur `ProviderLinkRegistry`'yi kullanır. Dış bağlantılar yalnızca açık bir kullanıcı eylemi sonrasında açılır ve `ProviderLinkService` tarafından varsayılan tarayıcıya iletilir.

- Codex: `https://chatgpt.com/codex/cloud/settings/analytics#usage`
- Claude: `https://claude.ai/settings/usage`

Dashboard ayrıca **Open GitHub Copilot Billing** (`https://github.com/settings/billing`) ve **Open Grok Billing** (`https://grok.com/?_s=billing`) sunar. **Open Grok**, resmî ana sayfa için ayrı bir eylem olarak kalır; sayısal bir kullanım sayfası değildir. AI Limit Ledger tarayıcı oturumlarını, çerezleri, sayfa içeriğini veya yönlendirmeleri okumaz. Bu sayfalar yedek/ayrıntı görünümleridir, kazınmış veri kaynakları değildir.

Mevcut etiketler **Open GitHub Copilot Billing** ve **Open Grok Billing**'dir. Grok billing, **Open Grok**'tan ayrıdır; Grok ana sayfası sayısal bir kullanım sayfası değildir. Resmî hesap görünümü için Grok Build içinde `/usage` kullanın.

## GitHub Copilot bağlantısı

**AI Limit Ledger: Connect GitHub Copilot Usage** komutunu çalıştırın. Önce VS Code GitHub Authentication denenir. Faturalama uç noktasını karşılayamazsa, **Use fine-grained PAT**'i seçin ve yalnızca **Plan: read** verin. Yalnızca AI Limit Ledger'ın kendi PAT sırrını kaldırmak için **Disconnect GitHub Copilot Usage** çalıştırın. GitHub faturalaması bireysel Copilot isteklerinin gerisinde kalabilir, bu yüzden Dashboard bunu açıkça belirtir. Organizasyon tarafından yönetilen Copilot hesaplarında kişisel bir ödenek hiç görünmeyebilir; bu, tahmin edilmek yerine kullanılamaz olarak gösterilir.

## Grok Build kullanımı

**Enable Grok Usage** çalıştırana kadar Grok kullanımı kapalıdır. xAI/Grok Build kılavuzundan resmî CLI'yi kurun, açılan VS Code terminalinde `grok login` ile oturum açın, ardından **Recheck Grok Installation** çalıştırın. Etkinleştirildiğinde AI Limit Ledger resmî Grok Build ACP aktarımını kullanır; `x.ai/billing` capability'si ve CLI-proxy faturalama yedeği deneyseldir, yedek isteğe bağlıdır. Topluluk `pawelhuryn.grok-vscode-phuryn` eklentisi yalnızca topluluk kaynaklı olarak algılanır ve asla resmî faturalama kaynağı olarak ele alınmaz. Resmî hesap görünümü için Grok Build içinde `/usage` kullanın; AI Limit Ledger `/usage` komutunu otomatik çalıştırmaz. Ücretsiz Grok hesapları, billing capability'sinden hiç sayısal bir kullanım yüzdesi almayabilir.

Başarılı bir Repair'dan sonra Claude kartı **Restart Claude CLI session** gösterir. Mevcut Claude CLI oturumlarını kapatın, tamamen yeni bir tane başlatın ve bir yanıtı tamamlayın. Geçerli bir anlık görüntü, yeniden başlatma/bekleme mesajını otomatik olarak kaldırır.

## Sorun giderme

Windows'ta, Codex'in kurulu ve oturum açmış olduğundan emin olun. App Server başlayamadığında **AI Limit Ledger: Show Logs** komutunu açın. App Server protokolü zamanla değişebilir; eksik alanlar, arayüzü bozmak yerine `Not available` olarak görüntülenir.

### Claude kullanım limitleri görünmüyor

Dashboard **Repair required** gösteriyorsa veya Enable'dan sonra Claude kullanım limitleri hâlâ görünmüyorsa:

1. **AI Limit Ledger: Diagnose Claude Code Integration** komutunu çalıştırın (`Ctrl+Shift+P`). Şunları kontrol edin:
   - `Effective statusLine` değeri `present`
   - `Wrapper file` değeri `present` ve `Wrapper hash match` değeri `yes`
   - `Wrapper self-check` değeri `passed`
   - `Integration state` değeri `ready` (`repair-required` değil)
2. `Integration state` değeri `repair-required` ise, **AI Limit Ledger: Repair Claude Code Integration** çalıştırın. Bu, Enable ile aynı güvenli, idempotent işlemdir — sahipliği yeniden doğrular, eksik veya bayat bir wrapper'ı yeniden oluşturur ve harici bir şey kaldırmışsa statusLine'ı yeniden kurar; zaten sağlıklı bir entegrasyonu bozmadan.
3. Devam etmeden önce Diagnose'u tekrar çalıştırın ve `Integration state: ready` olduğunu doğrulayın.
4. **Var olan her Claude Code CLI oturumunu kapatın** — zaten çalışan bir oturum, onarılmış yapılandırmayı yeniden yüklemez.
5. Tamamen yeni bir `claude` oturumu açın ve **gerçek bir yanıtı tamamlayın**. Kullanım verisini yazan status-line hook'u yalnızca bir yanıt bittikten sonra gerçek verilerle tetiklenir; bu noktadan önce yakalanan bir anlık görüntü, doğru şekilde "Waiting for the first completed Claude CLI response containing rate-limit data" gösterir, bir hata değil.
6. **AI Limit Ledger: Open Dashboard** komutunu yeniden açın (veya bir an bekleyin) — panoyu yeniden açmaya gerek kalmadan geçerli bir anlık görüntü geldiğinde canlı olarak güncellenir.

Önceden `ready` tanı durumuyla gerçek bir tamamlanmış yanıttan sonra kullanım hâlâ görünmüyorsa, **Copy redacted diagnostics** kullanın ve sorunu bildirin — kopyalanan metin asla komutları, ham JSON'ı, kimlik bilgilerini veya tam ana dizin yolunuzu içermez.

## Destek

Genel sorun giderme adımları için [SUPPORT.md](SUPPORT.md) dosyasına bakın — eksik içgörüler,
ayarlar/diagnostics dışa aktarımları, canlı yerelleştirme kontrolleri, hata bildirimleri ve
sağlayıcı başına diagnose komutlarını kapsar. Orada kapsanmayan başka bir konu için bir
[GitHub Issue](https://github.com/Fatih-Dumlupinar/ai-limit-ledger/issues) açın. Bir güvenlik açığı
için herkese açık bir issue açmayın — bkz. [Güvenlik bildirimi](#güvenlik-bildirimi).

## Geliştirme kurulumu

Desteklenen bir Node.js LTS hattı ve npm 10+ gerektirir (Node 24 tercih edilir, Node 22 minimumdur — bkz. `.nvmrc`/`.node-version` ve `package.json`'ın `engines.node` alanı). Node 20 ömrünün sonuna ulaşmıştır ve geliştirme için desteklenmez.

```powershell
npm ci
npm run compile
```

Ardından `F5` tuşuna basıp **Run Extension — Clean Development Host** profilini seçin. Bu profil,
çalışma ağacındaki derlemeyi, gitignore'lanmış `.tmp/vscode-dev/` altındaki kendi user-data ve
extensions alanlarıyla ayrı bir Extension Development Host penceresinde çalıştırır; böylece normal
VS Code profiliniz kararlı Marketplace sürümünü çalıştırmayı sürdürür ve hata ayıklama penceresine
hiçbir gerçek kimlik bilgisi veya ayar taşınmaz.

Tam kılavuz [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) belgesindedir: araç zinciri kurulumu, hata
ayıklama ve kesme noktaları, tek bir testi çalıştırma, watch modu, tam yerel kontrol, VSIX derleme
ve izole bir profilde duman testi, normal profil ile Development Host ayrımı, ve branch, pull
request ve sürüm akışı.

## Test / build komutları

```powershell
npm run compile        # TypeScript derlemesi
npm run lint            # ESLint
npm run format:check    # Prettier kontrolü
npm run verify:workflows # Workflow/Dependabot policy kontrolü
npm test                # Vitest test paketi
npm run audit:release   # Çevrimdışı manifest/lockfile/kimlik-bilgisi-deseni/VSIX denetimi
npm run package          # out/ dizinini oluşturur ve vsce ile bir .vsix paketler
```

Eklentinin **sıfır üretim bağımlılığı** vardır; tüm `devDependencies` yalnızca build/test/lint/package araçlarıdır.

## Katkı

Katkılar memnuniyetle karşılanır. Geliştirme iş akışı, test beklentileri, yerelleştirme (İngilizce/Türkçe) gereksinimleri ve bu projeye uygulanan gizlilik/log kısıtlamaları için [CONTRIBUTING.md](CONTRIBUTING.md) dosyasına bakın. Lütfen [Davranış Kuralları](CODE_OF_CONDUCT.md)'nı da okuyun.

## Güvenlik bildirimi

Bir güvenlik açığı için herkese açık bir issue açmayın. Özel olarak nasıl bildireceğinizi öğrenmek için [SECURITY.md](SECURITY.md) dosyasına bakın.

## Bilinen sınırlamalar

- **Önizleme (preview)** sürümü olarak yayınlanmıştır: manifest'te `"preview": true` korunur ve
  GitHub Release'leri ön sürüm olarak işaretlenir; davranış ve ayarlar sürümler arasında hâlâ
  değişebilir.
- Claude'un CLI'siz OAuth kullanım kontrolü, Grok'un deneysel `x.ai/billing` capability'si ve Grok'un CLI-proxy faturalama yedeği ikisi de **deneyseldir**, varsayılan olarak kapalıdır veya isteğe bağlıdır ve haber verilmeden değişebilecek veya çalışmayı durdurabilecek belgelenmemiş sağlayıcı uç noktalarına bağımlıdır.
- Claude'un en son oturum içgörüsü yalnızca en son gözlemlenen CLI oturumunu yansıtır, oturumlar arasında hesap genelinde bir toplamı değil.
- GitHub Copilot organizasyon tarafından yönetilen hesaplarda kişisel bir ödenek hiç görünmeyebilir; faturalama da bireysel Copilot isteklerinin gerisinde kalabilir ve Dashboard ikisini de tahmin etmek yerine açıkça belirtir.
- Grok Free hesapları, billing capability'sinden hiç sayısal bir kullanım yüzdesi almayabilir.
- Gelecekte yalnızca geliştirme amaçlı araçlarda (`vitest`/`vite` zinciri) bazı `npm audit` bulguları görünebilir; üretim bağımlılıkları sıfırdır ve sıfır kalacaktır.
- Claude status-line wrapper'ı için Windows birincil geliştirme ve test hedefidir; macOS/Linux zincirleme tam eşlik yerine açık bir en iyi çaba yedeğine sahiptir.

## Yol haritası

Aşağıdaki öğeler **planlanmıştır, taahhüt edilmemiştir** ve değişebilir:

- Task 12 PR'ı incelendikten sonra ek branch koruması/ruleset yapılandırması.
- Sağlayıcı entegrasyonları tam bir sürüm döngüsü boyunca gerçek kullanımda test edildikten sonra
  önizleme durumundan çıkılması. Marketplace listesindeki ekran görüntüleri isteğe bağlı, ayrı bir
  iyileştirme olmayı sürdürür (bkz. [Ekran görüntüleri](#ekran-görüntüleri)).
- Gelecekte ek sağlayıcı desteği değerlendirilebilir; şu anda Codex, Claude Code, GitHub Copilot ve Grok'un ötesinde hiçbir şey planlanmamış veya uygulanmamıştır.

## Bağlantısızlık bildirimi

AI Limit Ledger bağımsız bir projedir; Microsoft, GitHub, OpenAI, Anthropic veya xAI ile bağlantılı
değildir, bu kuruluşlar tarafından desteklenmemektedir veya sponsor olunmamaktadır. Sağlayıcı adları
yalnızca birlikte çalışabilirliği tanımlamak için kullanılır ve hiçbir sağlayıcı logosu veya ticari
markası ile birlikte ya da onun yerine kullanılmaz.

## English

Bu belgenin İngilizce sürümü için bkz. [README.md](README.md).

## Lisans

[MIT](LICENSE)
