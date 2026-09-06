# 🚀 สถาปัตยกรรม: หน้าบ้าน GitHub Pages + หลังบ้าน Cloudflare Workers

ระบบสอบออนไลน์วิชาคณิตศาสตร์ (QuizLive Math) ที่แยก:
- **หน้าบ้าน (Frontend):** โฮสต์ฟรีบน **GitHub Pages**
- **หลังบ้าน (Backend API):** รัน Serverless API ฟรีบน **Cloudflare Workers** (รองรับ CORS 100%)

---

## ⚡ สเต็ปที่ 1: ติดตั้งหลังบ้าน Cloudflare Worker (ใช้เวลา 1 นาที)

1. เข้าเว็บ [dash.cloudflare.com](https://dash.cloudflare.com)
2. เมนูด้านซ้าย เลือก **Workers & Pages** -> กดปุ่ม **Create application**
3. เลือกแท็บ **Workers** -> กด **Create Worker**
4. ตั้งชื่อ เช่น `quizlive-math-api` แล้วกด **Deploy**
5. กดปุ่ม **Edit code** ด้านขวาบน
6. ลบโค้ดเดิมออก แล้ว **ก๊อปปี้โค้ดจากไฟล์ `worker.js` ในเครื่องของคุณไปวางทับทั้งหมด**
7. กดปุ่ม **Deploy** สีฟ้าด้านขวาบน
8. ก๊อปปี้ **URL ของ Worker** (เช่น `https://quizlive-math-api.yourname.workers.dev`) เก็บไว้

---

## 🌐 สเต็ปที่ 2: เอาหน้าบ้านขึ้น GitHub Pages

1. เข้าเว็บ [github.com](https://github.com) สร้าง Repository ใหม่ เช่น `quiz`
2. อัปโหลดไฟล์ **`index.html`** ขึ้นไปที่ Repository นั้น
3. ไปที่เมนู **Settings** ของ Repository -> เมนูด้านซ้ายเลือก **Pages**
4. ตรง **Branch** ให้เลือก `main` (หรือ `master`) แล้วกด **Save**
5. รอ 30 วินาที คุณจะได้ลิงก์หน้าเว็บจริง เช่น:
   👉 `https://yourusername.github.io/quiz/`

---

## 🔗 สเต็ปที่ 3: เชื่อมหน้าบ้านเข้ากับหลังบ้าน Cloudflare

1. เปิดลิงก์หน้าเว็บ GitHub Pages ของคุณ
2. เข้าสู่ระบบครู (PIN: `1234`)
3. กดปุ่ม **"🔗 หลังบ้าน"**
4. วาง **URL ของ Cloudflare Worker** ที่ได้จากสเต็ปที่ 1 แล้วกด **"บันทึกการเชื่อมต่อ"**
5. สถานะจะขึ้น `☁️ Cloud Connected` สีเขียวทันที!

---

## 🎉 พร้อมใช้งานจริง:
- **ครู:** เปิดหน้าเว็บ GitHub Pages จัดการข้อสอบ และกด "เปิดห้องสอบ" ฉาย QR Code
- **นักเรียน:** สแกน QR Code จากมือถือ -> ทำข้อสอบ -> คะแนนและห้องสอบจะถูกส่งผ่าน Cloudflare Workers แบบเรียลไทม์ทันทีครับ!
