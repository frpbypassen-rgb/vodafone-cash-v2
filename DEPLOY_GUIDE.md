# Al-Ahram Pay V3 — دليل السحب والبناء والرفع الكامل

## 🎯 الخلاصة السريعة

تم إعداد كل شيء. الآن بنقرة واحدة على GitHub يبنى APK آليًا ويُرفع كـ Release جاهز للتحميل.

---

## ✅ ما تم رفعه لـ GitHub

```
https://github.com/frpbypassen-rgb/vodafone-cash-v2
```

| الملف | الوصف |
|---|---|
| `build_release_deploy.yml` | CI/CD: بناء + Release + Deploy |
| `deploy_apk.sh` | سكريبت رفع يدوي (Linux/Mac) |
| `deploy_apk.bat` | سكريبت رفع يدوي (Windows) |
| `main.dart` | مُحدّث بـ V3 |
| `pubspec.yaml` | الإصدار 3.0.0+40 |
| `brand_theme_v3.dart` | ألوان جديدة |
| `components/*.dart` | مكونات 3D + تخطيط + حركات |
| `services/ahram_notification_hub.dart` | إشعارات |

---

## 🚀 الطريقة 1: GitHub Actions — الأسرع (5 دقائق)

### 1. افتح Actions
```
https://github.com/frpbypassen-rgb/vodafone-cash-v2/actions
```

### 2. اضغط على آخر workflow

### 3. اضغط على **AhramPay-V3-APK** في قسم Artifacts

### 4. APK جاهز للتنزيل!

### أو: اذهب مباشرة لـ Releases
```
https://github.com/frpbypassen-rgb/vodafone-cash-v2/releases
```

---

## 💻 الطريقة 2: سحب وبناء يدوي

### الخطوة 1: سحب المشروع

```bash
git clone https://github.com/frpbypassen-rgb/vodafone-cash-v2.git
cd vodafone-cash-v2
```

### الخطوة 2: بناء APK

**على Windows (PowerShell):**
```powershell
cd vodafone-cash-v2
.\build_apk.bat
```

**على Linux/Mac:**
```bash
cd vodafone-cash-v2
bash build_apk.sh
```

**أو يدوياً:**
```bash
cd vodafone-cash-v2/mobile_app
flutter pub get
flutter build apk --release
```

### الخطوة 3: APK جاهز
```
mobile_app/build/app/outputs/flutter-apk/app-release.apk
```

---

## 📡 الطريقة 3: رفع APK للسيرفر ahrampay.com

### 🔑 الطريقة أ: عبر GitHub Actions التلقائي

إذا أضفت SSH keys في GitHub Secrets، سيُرفع APK تلقائياً للسيرفر.

**إعداد SSH Keys:**

1. في حاسوبك، أنشئ مفتاح (إذا لم يكن موجوداً):
```bash
ssh-keygen -t rsa -b 4096 -C "github-actions@ahrampay.com"
```

2. انسخ المفتاح العام للسيرفر:
```bash
ssh-copy-id root@ahrampay.com
```

3. اذهب لـ GitHub → Settings → Secrets → Actions

4. أضف `SSH_PRIVATE_KEY` بالقيمة:
```bash
cat ~/.ssh/id_rsa
```

5. أضف `SSH_USER` = `root` (أو اسم المستخدم)

6. اضغط Push وسترى APK يُرفع تلقائياً!

---

### 🔧 الطريقة ب: رفع يدوي

**على Windows:**
```powershell
cd vodafone-cash-v2
.\deploy_apk.bat
```

**على Linux/Mac:**
```bash
cd vodafone-cash-v2
bash deploy_apk.sh
```

**أو مباشرة بـ SCP:**
```bash
# 1. بناء APK
cd vodafone-cash-v2/mobile_app
flutter build apk --release

# 2. رفع APK للسيرفر
scp build/app/outputs/flutter-apk/app-release.apk \
  root@ahrampay.com:/var/www/ahrampay/downloads/AhramPay-v3.0.0.apk

# 3. إنشاء رابط latest
ssh root@ahrampay.com "cd /var/www/ahrampay/downloads && \
  ln -sf AhramPay-v3.0.0.apk AhramPay-latest.apk"
```

---

### 🌍 الطريقة ج: رفع عبر SFTP (أسهل)

استخدم **WinSCP** أو **FileZilla**:

| الإعداد | القيمة |
|---|---|
| **Host** | `ahrampay.com` |
| **Port** | `22` |
| **Protocol** | `SFTP` |
| **User** | `root` (أو المستخدم) |
| **Password** | كلمة المرور |
| **Remote Path** | `/var/www/ahrampay/downloads/` |

1. اتصل بالسيرفر
2. اسحب APK من جهازك للمجلد
3. انتهى!

---

## 📱 رابط التحميل للمستخدمين

بعد الرفع، رابط التحميل سيكون:

```
https://ahrampay.com/downloads/AhramPay-latest.apk
```

أو للإصدار المحدد:
```
https://ahrampay.com/downloads/AhramPay-v3.0.0.apk
```

---

## ⚡ ملخص سريع — نسخ والصق

```bash
# ═══════ السحب والبناء ═══════
git clone https://github.com/frpbypassen-rgb/vodafone-cash-v2.git
cd vodafone-cash-v2

# Windows
.\build_apk.bat

# Linux/Mac
bash build_apk.sh

# ═══════ الرفع للسيرفر ═══════
# Windows
.\deploy_apk.bat

# Linux/Mac (مع مفتاح SSH)
bash deploy_apk.sh

# يدوي
scp mobile_app/build/app/outputs/flutter-apk/app-release.apk \
  root@ahrampay.com:/var/www/ahrampay/downloads/
```

---

## 🎯 GitHub Actions — ما يحدث تلقائياً

عند كل Push لـ `main`:

```
┌─────────────────────────────────────────────┐
│  1. 🔨 Build APK                            │
│     └─ flutter build apk --release          │
│                                             │
│  2. 🚀 Create GitHub Release                │
│     └─ v3.0.0 مع ملاحظات                   │
│                                             │
│  3. 📡 Deploy to Server (اختياري)          │
│     └─ رفع APK لـ ahrampay.com              │
│                                             │
│  4. ✅ APK جاهز!                            │
│     ├─ GitHub Release: قابل للتحميل        │
│     ├─ GitHub Artifact: قابل للتحميل       │
│     └─ Server: ahrampay.com/downloads/     │
└─────────────────────────────────────────────┘
```

---

## 📞 للدعم

إذا واجهت مشكلة:
1. افتح GitHub Actions وتحقق من الأخطاء
2. تأكد من Flutter SDK مثبت
3. تأكد من Android SDK مثبت
4. أرسل لي نص الخطأ

---

**✅ تم الإنجاز: GitHub جاهز + CI/CD آلي + سكريبتات رفع جاهزة**
