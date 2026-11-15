# เชื่อม Google Search Console และ GA4 เข้า gstats

เมื่อเชื่อมแล้ว แท็บ **SEO** ใน dashboard จะแสดงข้อมูลจาก Google คู่กับข้อมูลที่ gstats เก็บเอง

- คนค้นคำว่าอะไรแล้วเจอเกม แต่ละคำได้กี่คลิก มีคนเห็นกี่ครั้ง และขึ้นอันดับเท่าไร
- **คำที่เกือบติดหน้าแรก** (อันดับ 4-20) ซึ่งเป็นคำที่ปรับง่ายที่สุดเพื่อให้ได้คลิกเพิ่ม
- หน้าไหนขึ้นใน Google เทียบกับจำนวนคนที่เข้ามาจริง
- (ถ้าเชื่อม GA4) จำนวน session และ key event จาก GA4 แยกตามช่องทาง เทียบกับ gstats

ฟรีทั้งหมด ไม่ต้องใส่บัตร ใช้เวลาประมาณ 15 นาที ทำครั้งเดียว

> How it works: one Google Cloud **service account** reads every linked property (read-only scopes `webmasters.readonly` and `analytics.readonly`). Its JSON key is the `GOOGLE_SERVICE_ACCOUNT` secret on Cloudflare. Data is pulled into D1 (daily totals for 180 days, page × query rows for 90 days, GA4 sessions by channel for 180 days) when someone opens the SEO tab and the last sync is older than 6 hours, or when "sync now" is pressed. Code: [`cloudflare/lib/google.js`](../cloudflare/lib/google.js).

## ภาพรวม
1. สร้าง service account ใน Google Cloud (เหมือนสร้าง "บัญชีหุ่นยนต์" ที่อ่านข้อมูลได้อย่างเดียว)
2. เอา key ของบัญชีนั้นไปใส่ใน Cloudflare
3. เพิ่มอีเมลของบัญชีนั้นเป็นผู้ใช้ใน Search Console (และ GA4)
4. ใส่ที่อยู่เว็บของแต่ละเกมในหน้า `/admin.html`

---

## 1. สร้าง service account ใน Google Cloud

1. เข้า [console.cloud.google.com](https://console.cloud.google.com) ด้วยบัญชี Google เดียวกับที่ใช้ Search Console
   ถ้าเป็นครั้งแรก ให้กดยอมรับเงื่อนไข ไม่ต้องเปิด billing หรือใส่บัตร
2. ด้านบนซ้าย กดที่ชื่อโปรเจกต์ (หรือ **Select a project**) > **New project**
   ตั้งชื่อ เช่น `gstats` แล้วกด **Create** รอสักครู่แล้วเลือกโปรเจกต์นี้
3. เปิด API สองตัว (กดลิงก์แล้วกด **Enable** ให้แน่ใจว่าด้านบนเลือกโปรเจกต์ `gstats` อยู่):
   - [Google Search Console API](https://console.cloud.google.com/apis/library/searchconsole.googleapis.com)
   - [Google Analytics Data API](https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com) (ข้ามได้ถ้าไม่ใช้ GA4)
4. ไปที่ [IAM & Admin > Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts) > **+ Create service account**
   - Service account name: `gstats-reader`
   - กด **Create and continue** แล้วกด **Done** เลย (ไม่ต้องเลือก role)
5. จะเห็นอีเมลแบบ `gstats-reader@gstats-xxxxx.iam.gserviceaccount.com` **คัดลอกเก็บไว้** ใช้ในข้อ 3
6. กดที่อีเมลนั้น > แท็บ **Keys** > **Add key** > **Create new key** > เลือก **JSON** > **Create**
   ไฟล์ `.json` จะดาวน์โหลดลงเครื่อง

> ไฟล์ JSON นี้คือรหัสลับ อย่าส่งในแชต อย่าใส่ใน GitHub ถ้าหลุด ให้ลบ key นั้นในแท็บ Keys แล้วสร้างใหม่
>
> ถ้าขึ้นว่า **"Service account key creation is disabled"** แปลว่าบัญชีอยู่ใต้องค์กรที่ปิดการสร้าง key ไว้ ให้ใช้บัญชี Gmail ส่วนตัวสร้างโปรเจกต์แทน

## 2. ใส่ key ใน Cloudflare

1. เปิดไฟล์ `.json` ที่ดาวน์โหลดมาด้วยโปรแกรมแก้ข้อความ (Mac: คลิกขวา > Open With > TextEdit) แล้ว **คัดลอกทั้งไฟล์** ตั้งแต่ `{` ถึง `}`
2. เข้า [dash.cloudflare.com](https://dash.cloudflare.com) > **Workers & Pages** > โปรเจกต์ `gstats` > **Settings** > **Variables and Secrets** > **Add**
   - Type: **Secret**
   - Variable name: `GOOGLE_SERVICE_ACCOUNT`
   - Value: วางข้อความที่คัดลอกมาทั้งหมด
   - กด **Save**
3. ไปแท็บ **Deployments** > กด **...** ที่รายการล่าสุด > **Retry deployment**
4. เช็ก: เปิด `https://gstats.pages.dev/healthz` ต้องเห็นบรรทัด
   `google: on, service account gstats-reader@...`

## 3. ให้สิทธิ์ service account อ่านข้อมูล

### Search Console (ทำทีละเว็บ)
1. เข้า [search.google.com/search-console](https://search.google.com/search-console) เลือกเว็บ (ถ้ายังไม่ได้เพิ่มเว็บ ดูหัวข้อ "ยังไม่มีเว็บใน Search Console" ด้านล่าง)
2. เมนูซ้ายล่าง **Settings** > **Users and permissions** > **Add user**
3. Email: วางอีเมล service account จากข้อ 1.5 · Permission: **Restricted** (อ่านอย่างเดียว) > **Add**

ทำซ้ำกับทุกเว็บที่จะดูใน gstats เช่น
| เกม | เว็บใน Search Console |
|---|---|
| Tavern Knights | `https://tavern-knights.pages.dev/` |
| Chess | `https://rochano.github.io/chess/` (หรือ `https://rochano.github.io/` ถ้ายืนยันไว้ทั้งโดเมน) |

### GA4 (ถ้าใช้)
1. เข้า [analytics.google.com](https://analytics.google.com) > **Admin** (เฟืองซ้ายล่าง) > คอลัมน์ Property > **Property access management**
2. กด **+** > **Add users** > วางอีเมล service account > Role: **Viewer** > **Add**
3. ที่ **Admin > Property details** (หรือ Property settings) จะเห็น **Property ID** เป็นตัวเลข เช่น `412345678` จดไว้
   (ไม่ใช่ Measurement ID ที่ขึ้นต้นด้วย `G-`)

## 4. ผูกเว็บกับโปรเจกต์ใน gstats

1. เปิด `https://gstats.pages.dev/admin.html` ใส่ `ADMIN_KEY`
2. การ์ด **เชื่อม Google Search Console และ GA4** แต่ละโปรเจกต์มีช่องให้ใส่
   - **เว็บใน Search Console:** พิมพ์ให้ตรงกับที่เห็นใน Search Console เช่น `https://tavern-knights.pages.dev/` หรือ `sc-domain:example.com` ถ้าเป็น Domain property
   - **GA4 Property ID:** ตัวเลขจากข้อ 3 (เว้นว่างได้)
3. กด **บันทึก** ระบบจะลองดึงข้อมูลทันที
   - ขึ้น "ใช้งานได้" หรือ "กำลังดึงข้อมูลย้อนหลัง" = สำเร็จ
   - ขึ้นข้อความสีแดง = ดูตารางแก้ปัญหาด้านล่าง
4. เปิด dashboard ของเกม > แท็บ **SEO** ข้อมูลย้อนหลัง 90 วันจะทยอยเข้ามาเองภายในประมาณหนึ่งนาที (เปิดหน้าทิ้งไว้)

หลังจากนี้ไม่ต้องทำอะไรอีก ข้อมูลจะอัปเดตเองทุกครั้งที่เปิดแท็บ SEO และข้อมูลเก่ากว่า 6 ชั่วโมง หรือกด **ดึงข้อมูลใหม่** มุมขวาบนของการ์ด

## สิ่งที่ควรรู้
- **Search Console ช้ากว่าจริง 1-3 วัน** dashboard จึงแสดง "N วันล่าสุดที่ Google มีข้อมูล" และบอกวันที่ล่าสุดไว้ใต้กราฟ
- Google ไม่แสดงคำค้นที่มีคนค้นน้อยมาก (เพื่อความเป็นส่วนตัว) ผลรวมคลิกของตารางคำค้นจึงน้อยกว่าตัวเลขรวมด้านบนได้
- ตัวเลข GA4 กับ gstats ไม่ตรงกันเป๊ะเป็นเรื่องปกติ: GA4 ถูกตัวบล็อกโฆษณาบล็อกบ่อยกว่า และ GA4 นับคนที่มาจาก ChatGPT/Perplexity รวมไว้ใน Referral ส่วน gstats แยกเป็นช่องทาง AI
- ใช้โควตาฟรีของ Cloudflare น้อยมาก: การดึงแต่ละรอบเขียนข้อมูลแค่หลักร้อยถึงไม่กี่พันแถว และ Google API ทั้งสองตัวฟรี
- ตอนนี้ผู้ดูแลเป็นคนผูกเว็บให้ (หน้า `/admin.html`) เพราะ service account ตัวเดียวอ่านได้ทุกเว็บที่เพิ่มมันไว้ ถ้าให้ลูกค้าพิมพ์เว็บเองได้ ลูกค้าคนหนึ่งอาจพิมพ์เว็บของลูกค้าอีกคนแล้วเห็นข้อมูล ขั้นต่อไปสำหรับขายแบบลูกค้าตั้งเอง คือให้ลูกค้ากด "Sign in with Google" (OAuth) ซึ่งต้องผ่านการตรวจแอปของ Google ก่อน

## ยังไม่มีเว็บใน Search Console
1. เข้า [search.google.com/search-console](https://search.google.com/search-console) > **Add property**
2. เลือก **URL prefix** แล้วใส่ `https://tavern-knights.pages.dev/` (เว็บบน pages.dev หรือ github.io ใช้แบบ Domain ไม่ได้)
3. วิธียืนยันที่ง่ายที่สุดคือ **HTML tag**: คัดลอก `<meta name="google-site-verification" ...>` ไปใส่ใน `<head>` ของหน้าแรก deploy แล้วกด **Verify**
   (ถ้าเว็บมี Google Analytics ที่ใช้บัญชีเดียวกันอยู่แล้ว เลือก **Google Analytics** แล้วกด Verify ได้เลย)
4. เมนู **Sitemaps** ใส่ `sitemap.xml` แล้วกด **Submit**
5. ข้อมูลจะเริ่มมีหลังจากนั้นประมาณ 2-3 วัน

## แก้ปัญหา
| ข้อความ | สาเหตุและวิธีแก้ |
|---|---|
| `ยังไม่ได้ตั้ง GOOGLE_SERVICE_ACCOUNT` | ทำข้อ 2 แล้วอย่าลืม Retry deployment |
| `GOOGLE_SERVICE_ACCOUNT อ่านเป็น JSON ไม่ได้` | คัดลอกไม่ครบ ต้องเริ่มที่ `{` และจบที่ `}` วางใหม่ทั้งไฟล์ |
| `ยังไม่ได้เปิด API ใน Google Cloud` | กด Enable API ในข้อ 1.3 ให้ตรงโปรเจกต์ที่สร้าง service account รอ 2-3 นาทีแล้วกด "ดึงตอนนี้" |
| `service account ยังไม่มีสิทธิ์` | ยังไม่ได้เพิ่มอีเมล service account ในเว็บนั้น (ข้อ 3) หรือที่อยู่เว็บที่พิมพ์ไม่ตรงกับใน Search Console ทุกตัวอักษร รวมทั้ง `https://` และ `/` ท้าย |
| `ไม่พบ property นี้` | GA4 Property ID ผิด ต้องเป็นตัวเลข ไม่ใช่ `G-XXXX` |
| `Google ไม่ให้ token` | key ถูกลบหรือหมดอายุ สร้าง key ใหม่ (ข้อ 1.6) แล้วใส่แทนในข้อ 2 |

## (ไม่บังคับ) ดึงตามเวลาแม้ไม่มีใครเปิด dashboard
ค่าเริ่มต้นจะดึงเมื่อมีคนเปิดแท็บ SEO ซึ่งพอสำหรับคนส่วนใหญ่ ถ้าอยากให้ดึงเองทุกวัน ตั้งตัวเรียกตามเวลา (เช่น cron-job.org หรือ GitHub Actions) ให้ส่ง

```sh
curl -X POST https://gstats.pages.dev/api/admin/google/sync -H "X-Admin-Key: <ADMIN_KEY>"
```

แต่ละครั้งดึงโปรเจกต์ที่ถึงเวลาได้สูงสุด 3 โปรเจกต์
