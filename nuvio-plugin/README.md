# 📺 VietStream — Plugin Nuvio (hệ plugin riêng của NuvioMobile)

Đây là **plugin scraper JavaScript** chạy trực tiếp trong app Nuvio (QuickJS runtime), khác với
addon Stremio ở thư mục gốc repo. Plugin tự query các nguồn phim Việt ngay trong app,
không cần server riêng:

| Nguồn | API | Ghi chú |
|---|---|---|
| KKphim | `phimapi.com` | m3u8 trực tiếp, Vietsub / Lồng tiếng / Thuyết minh |
| NguonC | `phim.nguonc.com/api` | m3u8 trực tiếp hoặc tự giải mã link StreamC |
| Phim4K | `vsmov.com/api` | tự giải mã embed → `master.m3u8` |
| OPhim | `ophim.live` (đổi được) | domain chết sẽ tự bỏ qua |
| VnStream | cobephim.biz | scrape trang xem phim |

## 🔗 URL cài plugin

```
https://raw.githubusercontent.com/henryhnguy/vietstream-nuvio-addon/main/nuvio-plugin/manifest.json
```

## 📲 Cài vào Nuvio

1. Mở **Nuvio → Settings → Plugins (Local Plugins)** → chọn **Import / Add từ URL**.
2. Dán URL manifest ở trên → xác nhận.
3. Bật scraper **VietStream** trong danh sách plugin.
4. Mở bất kỳ phim/series nào (Nuvio tra TMDB) → mục **Sources/Streams** sẽ hiện các luồng
   `VietStream · KKphim`, `VietStream · Phim4K`… kèm nhãn audio (Vietsub • Lồng Tiếng • Thuyết Minh).

> Nếu bạn dùng bản có **Plugin Tester** (Settings → Plugin Tester): dán cùng URL manifest trên để xem log
> và kết quả từng stream (`adb logcat -s "Plugin:*"` khi cần debug).

## ⚙️ Tắt / bật từng nguồn

Plugin đọc biến settings `disable` (mảng id nguồn: `kkphim`, `ophim`, `nguonc`, `vnstream`, `phim4k`).
Ví dụ tắt OPhim và VnStream:

```json
{ "disable": ["ophim", "vnstream"] }
```

## 🧠 Cách hoạt động

```
Nuvio chọn phim/ tập → PluginRuntime (QuickJS)
  → getStreams(tmdbId, "movie"|"tv", season, episode)
  → TMDB API (dùng TMDB_API_KEY do app inject) → tên VI + tên gốc + năm
  → 5 nguồn chạy SONG SONG (Promise.allSettled, tổng < 60s)
  → mỗi nguồn: search → chấm điểm khớp (tên gốc 100 / tên Việt 90 / một phần 10,
    năm ±1, "Phần N" đúng mùa) → detail → chọn tập theo số tập + server
  → trả về mảng stream { name, title, url, quality, type:"hls", headers }
```

Ràng buộc QuickJS đã xử lý: không `Buffer` (dùng `atob`), không `setTimeout`,
body fetch bị cắt 256KB trên NuvioTV, mỗi request ≤ 30s (TV) / 60s (Mobile).

## 🧪 Test trên máy (Node.js ≥ 18)

```bash
node nuvio-plugin/test/test.js
```

Test harness giả lập TMDB API (vì `TMDB_API_KEY` thật chỉ có trong app) và gọi ra internet thật —
xem kết quả stream cho phim mẫu (Oppenheimer, Game of Thrones).

## 🔧 Sửa nguồn / đổi domain

Toàn bộ domain nguồn nằm ở đầu từng hàm `xxxStreams()` trong
[`providers/vietstream.js`](providers/vietstream.js) — nguồn đổi host chỉ cần sửa 1 dòng.
