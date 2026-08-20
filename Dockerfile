# استخدام نسخة خفيفة ومستقرة ومخصصة للشركات
FROM node:22-alpine

# تثبيت متطلبات مكتبة Puppeteer (Chromium) لمنع انهيار إيصالات الصور
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    python3 \
    build-base \
    pkgconf \
    cairo-dev \
    pango-dev \
    jpeg-dev \
    giflib-dev \
    librsvg-dev

# تحديد مجلد العمل داخل الحاوية
WORKDIR /usr/src/app

# Use the patched system Chromium package and avoid downloading a second browser.
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV TZ=Africa/Tripoli

# نسخ ملفات التثبيت فقط أولاً (للاستفادة من الكاش)
COPY package*.json ./

# تثبيت الحزم الإنتاجية فقط (تنظيف المشروع من حزم المطورين)
RUN npm ci --omit=dev

# نسخ باقي ملفات المشروع السليمة
COPY . .

# إعداد بيئة التشغيل
ENV NODE_ENV=production

# فتح البورت
EXPOSE 3000

# تشغيل النظام
CMD ["node", "app.js"]
