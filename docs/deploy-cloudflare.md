# ติดตั้งฟรีบน Cloudflare (Pages + D1)

เวอร์ชันเบาของ gstats ที่รันบน Cloudflare ทั้งหมด ไม่ต้องมีเซิร์ฟเวอร์ ไม่ต้องใส่บัตร และตั้งค่าผ่านหน้าเว็บได้ทั้งหมด
Dashboard และ SDK เป็นตัวเดียวกับเวอร์ชันเต็ม ใช้ API เหมือนกัน ถ้าวันหนึ่งย้ายไปเวอร์ชันเต็ม (Go + ClickHouse) แค่เปลี่ยน `host` ใน SDK

> A serverless edition: Cloudflare Pages Functions for `/e` and `/api/*`, D1 (SQLite) for storage. Same wire format and API as the Go services. Code: [`cloudflare/`](../cloudflare).

## เหมาะกับใคร

| | Cloudflare (ไฟล์นี้) | เวอร์ชันเต็มบน VM ([deploy-free-vm.md](deploy-free-vm.md)) |
|---|---|---|
| ค่าใช้จ่าย | ฟรี | ฟรี (Oracle Always Free) ถ้าหาเครื่องได้ |
| รับ event ได้ | ประมาณ 50,000 event ต่อวัน | หลักล้านต่อวัน |
| ดูรายงาน | ประมาณ 5 ล้านแถวที่อ่านต่อวัน (พอสำหรับเปิด dashboard หลายสิบครั้งต่อวันที่ข้อมูลหลักแสน) | ไม่จำกัด |
| ตั้งค่า | หน้าเว็บอย่างเดียว | SSH + สคริปต์ |

ถ้าเกินโควตาฟรีในวันนั้น event ใหม่จะถูกปฏิเสธจนถึงเที่ยงคืน UTC (SDK จะลองส่งซ้ำให้ระยะหนึ่ง) ไม่มีการเก็บเงินเพิ่มเอง

## ขั้นตอน (ประมาณ 10 นาที)

### 1. สร้างฐานข้อมูล D1
1. เข้า [dash.cloudflare.com](https://dash.cloudflare.com) แล้วไปที่ **Storage & Databases > D1 SQL Database**
2. กด **Create** ตั้งชื่อ `analytics` แล้วกด **Create**
   ไม่ต้องสร้างตาราง ระบบสร้างให้เองตอนมี event แรก

### 2. สร้างโปรเจกต์ Pages จาก GitHub
1. ไปที่ **Workers & Pages > Create > Pages > Connect to Git**
2. เลือก repo `event-analytics` (ถ้ายังไม่เห็น กด **Add account** ให้ Cloudflare เข้าถึง repo นี้)
3. ตั้งค่า build:
   - **Project name:** เช่น `gstats` (จะได้ที่อยู่ `https://gstats.pages.dev`)
   - **Production branch:** `main`
   - **Framework preset:** None
   - **Build command:** `node build.mjs`
   - **Build output directory:** `public`
   - **Root directory (advanced):** `cloudflare`
4. กด **Save and Deploy** รอบแรกจะขึ้นว่าใช้งานไม่ได้ เพราะยังไม่ผูกฐานข้อมูล ไม่เป็นไร ทำข้อ 3 ต่อ

### 3. ผูกฐานข้อมูลและตั้ง key
เข้าโปรเจกต์ `gstats` > **Settings**

1. **Bindings > Add > D1 database**
   - Variable name: `DB` (ตัวพิมพ์ใหญ่)
   - D1 database: `analytics`
2. **Variables and Secrets > Add** สองตัว:
   - `PROJECTS` (เลือกชนิด **Secret**) ค่าแบบนี้ บรรทัดเดียว:
     ```
     1|pk_ใส่อักษรสุ่ม|rk_ใส่อักษรสุ่มอีกชุด|https://เว็บเกม.com,https://*.pages.dev|||90|ชื่อเกม
     ```
     ช่องคั่นด้วย `|` ตามลำดับ: เลขโปรเจกต์, write key (ใส่ในเกม เปิดเผยได้), read key (ใช้เปิด dashboard เก็บเป็นความลับ), เว็บที่อนุญาตให้ส่ง event (คั่นด้วย `,` ใช้ `*` = ทุกเว็บ), ว่าง, ว่าง, จำนวนวันที่เก็บข้อมูล, ชื่อที่จะแสดงบนหัว dashboard (มีเว้นวรรคได้)
     มีหลายเกมให้คั่นด้วย `;` เช่น `1|pk_a|rk_a|https://a.com|||90|เกม A;2|pk_b|rk_b|https://b.com|||90|เกม B`
     อักษรสุ่ม: ใช้ตัวอักษรและตัวเลขยาวอย่างน้อย 24 ตัว (เช่นสุ่มจากตัวจัดการรหัสผ่าน)
   - `TZ_OFFSET_MINUTES` = `420` (เวลาไทย UTC+7)
3. ไปแท็บ **Deployments** กด **...** ที่รายการล่าสุด > **Retry deployment** เพื่อให้ค่าใหม่มีผล

### 4. เปิด dashboard
เช็กก่อนว่าตั้งค่าครบ: เปิด `https://gstats.pages.dev/healthz` ต้องเห็น `database DB: connected` และ `projects: #1, #2` (หน้านี้ไม่แสดง key)

เปิด `https://gstats.pages.dev/?key=<read key>` (หรือเปิด `https://gstats.pages.dev` แล้วกรอก read key)
ลองแท็บ **ติดตั้ง** > ส่ง event ทดสอบ แล้วดูแท็บ **เหตุการณ์สด**

### 5. ใส่โค้ดในเว็บหรือเกม
```html
<script src="https://gstats.pages.dev/sdk/analytics.js"></script>
<script>
  gstats.init({ key: "pk_...", host: "https://gstats.pages.dev" });
  // gstats.capture("stage_clear", { stage: 3 });
</script>
```
รายละเอียดการส่ง event และชื่อ event ที่แนะนำสำหรับเกม ดู [INTEGRATION.md](INTEGRATION.md)

## อัปเดต
ทุกครั้งที่ merge เข้า `main` Cloudflare จะ build และ deploy ใหม่ให้เอง

## ต่างจากเวอร์ชันเต็มอย่างไร
- นับผู้ใช้ตาม `distinct_id` อย่างเดียว ยังไม่รวมตัวตนหลัง `identify()` (คนเดียวกันก่อนและหลัง login จะนับเป็นสองคน)
- ไม่มี rate limit ต่อโปรเจกต์ และไม่กรอง event ซ้ำ (ถ้า SDK ส่งซ้ำตอนเน็ตหลุดอาจนับเกินเล็กน้อย)
- event ที่ผิดรูปแบบถูกทิ้งเงียบๆ ไม่มีคิว dead-letter
- ข้อมูลเก่ากว่าจำนวนวันที่ตั้งไว้จะถูกลบเป็นระยะ
- รายงานถูก cache สั้นๆ (3 วินาทีถึง 10 นาทีแล้วแต่หน้า) เพื่อประหยัดโควตาการอ่าน

## พัฒนาในเครื่อง
```sh
cd cloudflare
npm test          # unit + end-to-end tests (Node 22+, uses node:sqlite as a fake D1)
npm run dev       # wrangler pages dev with a local D1, read key rk_dev
```
