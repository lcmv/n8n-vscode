# n8n Code Node Sync

Tool đồng bộ 2 chiều giữa Code node trong workflow n8n (quản lý qua extension
**n8n-as-code**) và file `.js`/`.py` độc lập, để dev sửa code với đầy đủ
IntelliSense/lint trong VSCode.

## 1. Việc tool này làm

- **Pull** (qua n8n-as-code) → `.workflow.ts` được ghi lại → tool tự tách
  từng Code node ra file `.js`/`.py` riêng trong `.n8n-code/`.
- **Dev sửa file `.js`/`.py`** → Save → tool tự ghi ngược vào `.workflow.ts`
  đúng node, rồi tự chạy `n8nac push` lên n8n server.
- **Workflow đổi tên trên n8n** → sau khi pull, folder chứa code tự đổi tên
  theo tên mới — nhưng vẫn giữ đúng file đang mở (đường dẫn folder neo theo
  `workflow id`, không đổi được, chỉ đổi phần tên hiển thị).
- Có cơ chế chống lặp vô hạn giữa 2 chiều sync, và circuit-breaker tự ngắt
  nếu phát hiện 1 file bị ghi bất thường nhiều lần trong thời gian ngắn.

## 2. Yêu cầu trước khi cài

| Thành phần | Yêu cầu |
|---|---|
| Node.js | >= 18 (khuyến nghị >= 20, vì `n8nac` CLI báo warning với Node 21 trở xuống — vẫn chạy được nhưng nên nâng cấp nếu rảnh) |
| VSCode extension | **n8n-as-code** đã cài, đã đăng nhập/kết nối n8n server, đã pull ít nhất 1 workflow về (có sẵn file `.workflow.ts` và `n8nac-config.json` ở root project) |
| Cấu trúc project | Workspace root chứa: `workflows/` (chứa các `.workflow.ts`), `n8nac-config.json`, và sẽ có thêm `.n8n-code/` (tool tự tạo) |

## 3. Cài đặt

**Bước 1** — Copy folder `n8n-code-node-sync/` vào **root workspace** của
project N8N bạn đang làm (n8n-code-node-sync trên máy dev ngang hàng với `workflows/`,
`n8nac-config.json`).

**Bước 2** — Cài dependency:

```bash
cd n8n-code-node-sync
npm install
```

**Bước 3** — Kiểm tra lại đường dẫn glob mặc định trong `package.json` khớp
với cấu trúc thật của project:

```json
"dev": "node sync-daemon.js \"../workflows/**/*.workflow.ts\" ../.n8n-code"
```

- Arg 1 (`../workflows/**/*.workflow.ts`): glob tới toàn bộ file `.workflow.ts`,
  tính từ trong folder `n8n-code-node-sync/`. Nếu cấu trúc project dev khác
  (ví dụ nhiều cấp folder `workflows/<team>/<name>.workflow.ts`), glob này vẫn
  khớp nhờ `**`, không cần sửa gì.
- Arg 2 (`../.n8n-code`): nơi output code đã tách ra, luôn đặt ngay tại
  workspace root.

Nếu tên project khác cấu trúc (`n8n-code-node-sync` không nằm trực tiếp dưới
root), sửa lại 2 path này cho đúng số cấp `../`.

**Bước 4 (khuyến nghị)** — Thêm task tự chạy khi mở workspace, để khỏi phải
tự tay mở terminal gõ `npm run dev` mỗi lần. Tạo (hoặc thêm vào)
`.vscode/tasks.json` ở root project:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "n8n-code-sync",
      "type": "npm",
      "script": "dev",
      "path": "n8n-code-node-sync",
      "isBackground": true,
      "runOptions": {
        "runOn": "folderOpen"
      },
      "presentation": {
        "reveal": "never",
        "panel": "dedicated"
      },
      "problemMatcher": []
    }
  ]
}
```

- `"runOn": "folderOpen"` — tự chạy `npm run dev` (trong folder
  `n8n-code-node-sync`) ngay khi mở workspace này trong VSCode.
- `"reveal": "never"` — chạy ngầm, không tự bung terminal ra màn hình (nhưng
  vẫn xem log được qua panel Terminal, chọn đúng task "n8n-code-sync").
- `"isBackground": true` — VSCode không coi task này là "task chạy xong rồi
  kết thúc" (vì `sync-daemon.js` chạy vô hạn), tránh bị báo lỗi/treo.

**Lưu ý quan trọng khi mở máy mới lần đầu:** VSCode chặn task tự chạy theo
`folderOpen` bằng 1 hộp thoại xác nhận ("Do you allow this workspace to run
automatic tasks?" hoặc tương tự) — dev **phải bấm "Allow"/"Allow Automatic
Tasks in Folder"** ở lần mở đầu tiên, nếu không task này sẽ không tự chạy và
tưởng nhầm là daemon không hoạt động. Nếu lỡ bấm "Disallow", vào
`Cmd+Shift+P → Tasks: Manage Automatic Tasks in Folder` để đổi lại.

## 4. Chạy

**Nếu đã setup task ở Bước 4:** không cần làm gì thêm — mở workspace lên là
daemon tự chạy. Xem log qua `Terminal panel → chọn task "n8n-code-sync"`
(dropdown cạnh nút `+` trong panel Terminal).

**Nếu chưa setup task (chạy tay):**

```bash
cd n8n-code-node-sync
npm run dev
```

Giữ terminal này chạy suốt session làm việc (mở 1 tab terminal riêng trong
VSCode, không tắt). Log khởi động mẫu (giống nhau ở cả 2 cách chạy):

```
Initial extract: N Code node script(s) under ../.n8n-code/

Watching M workflow file(s) (for pulls) and N code file(s) (for local edits)...
Auto-push enabled: npx n8nac push
```

**Lần chạy đầu tiên trên máy mới:** `npx n8nac push` sẽ hỏi cài `n8nac` CLI
(`Ok to proceed? (y)`) — gõ `y` một lần, các lần sau không hỏi lại nữa (npx
cache). Nếu daemon chạy qua task tự động (không có terminal tương tác để gõ
`y`), lần đầu nên chạy tay 1 lần theo cách "chạy tay" ở trên để xác nhận cài
`n8nac` xong, sau đó mới để task tự chạy các lần sau.

## 5. Cách dev dùng hằng ngày

1. Pull workflow qua extension n8n-as-code như bình thường.
2. Mở `.n8n-code/<id>__<tên workflow>/` trong Explorer — mỗi Code node là
   1 file `.js`/`.py`, sửa với đầy đủ IntelliSense.
3. Sửa xong `Cmd+S` — tool tự sync vào `.workflow.ts` + tự `push` lên n8n
   server. Xem log terminal xác nhận `Synced "..." -> ...` và
   `Pushed workflow ...`.
4. Test lại trực tiếp trên n8n UI (F5 nếu tab n8n đang mở sẵn để thấy code mới).

**Không cần** thao tác gì thêm trong tab n8n-as-code (không cần bấm Push tay) —
daemon đã tự làm.

## 6. Các quyết định thiết kế cần biết (để không sửa nhầm)

- **Tên folder = `<workflowId>__<tên hiện tại>`.** `id` là phần bất biến,
  dùng để tool tìm đúng folder dù workflow bị đổi tên. Phần tên sau `__` chỉ
  là hiển thị, tool tự đổi theo khi phát hiện tên mới sau 1 lần pull — không
  cần dev đổi tay, không cần tắt mở lại VSCode.
- **Ký tự trong tên file/folder** giữ nguyên khoảng trắng, dấu `-`, dấu câu
  bình thường — chỉ escape các ký tự thật sự không hợp lệ trên filesystem
  (`/ \ : * ? " < > |`).
- **Chỉ những Code node có `jsCode`/`pythonCode` là string/template literal
  thuần** mới được tách ra file. Nếu n8n-as-code sinh ra code dạng expression
  động (hiếm gặp), tool sẽ log skip — trường hợp đó sửa trực tiếp trong
  `.workflow.ts`.
- **Vòng lặp 2 chiều được chặn bằng content-diff cache** (`lastKnownContent`):
  bên nào ghi trước sẽ tự chốt mốc, bên kia bị trigger lại thấy khớp mốc thì
  dừng — không thể lặp vô hạn theo logic hiện tại.
- **Circuit breaker:** nếu 1 file bị ghi > 6 lần trong 3 giây, tool tự ngắt
  xử lý file đó và in cảnh báo đỏ — nếu gặp, kiểm tra lại có process nào khác
  (ví dụ 2 daemon cùng chạy trên 1 folder) đang ghi đè lẫn nhau không, rồi
  restart daemon.

## 7. Biết trước để không bối rối

- **Tab VSCode bị gạch ngang sau khi workflow đổi tên + pull:** bình thường —
  folder bị rename ở tầng OS, VSCode không tự dò theo, chỉ cần đóng tab cũ mở
  lại từ folder mới (nội dung không mất).
- **Đổi tên suffix folder bằng tay lúc daemon đang chạy:** vẫn an toàn (tool
  tự phát hiện qua watcher glob, rebuild lại mapping) — nhưng khuyến nghị chỉ
  làm khi cần, tránh đổi tay đồng thời với việc pull/push để tránh rối log.
- **Nếu dùng máy Node cũ (< 22):** `npx n8nac push` sẽ in nhiều
  `npm WARN EBADENGINE` — không chặn chạy, chỉ là cảnh báo tương thích.

## 8. Biến môi trường tuỳ chọn

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `N8NAC_AUTO_PUSH` | `true` | Set `false` để chỉ sync vào `.workflow.ts`, không tự push — tự chạy `n8nac push` tay khi cần |
| `N8NAC_PUSH_CMD` | `npx n8nac push` | Đổi câu lệnh push nếu team dùng cách khác (ví dụ thêm `--verify`) |

Ví dụ tắt auto-push:

```bash
N8NAC_AUTO_PUSH=false npm run dev
```

## 9. Cấu trúc file & tính năng đã gộp trong `sync-daemon.js`

```
n8n-code-node-sync/
  package.json         # chỉ 1 script "dev"
  sync-daemon.js       # toàn bộ logic — file duy nhất cần quan tâm
  node_modules/         # sau npm install
```

`sync-daemon.js` gộp toàn bộ các tính năng sau vào 1 tiến trình duy nhất:

- **Extract:** tách `jsCode`/`pythonCode` từ Code node trong `.workflow.ts`
  ra file `.js`/`.py` riêng.
- **Watch 2 chiều:** theo dõi cả `.workflow.ts` (bắt pull) và các file đã
  tách (bắt local edit), tự đồng bộ qua lại.
- **Auto push:** sau khi sync vào `.workflow.ts`, tự gọi `n8nac push`.
- **Đặt tên & tự rename folder theo `workflow id`:** để không bị lạc mapping
  khi workflow đổi tên (xem mục 6).
- **Chống loop + circuit breaker:** content-diff cache và giới hạn số lần
  ghi/giây cho 1 file (xem mục 6).

Tool này **không** mở hay điều khiển trình duyệt. Muốn mở workflow trên n8n
web để xem/test trực tiếp, dùng tính năng mở n8n web có sẵn của **n8n-as-code**
— không cần thêm gì từ phía tool này.

## 10. Rollback / gỡ

Không có thay đổi nào động vào n8n server hay database — toàn bộ chỉ là
script chạy local, tương tác qua CLI `n8nac push` (API PUT chuẩn của n8n).
Muốn gỡ: `Ctrl+C` dừng `npm run dev`, xoá folder `n8n-code-node-sync/` và
`.n8n-code/` — không ảnh hưởng gì tới workflow đã push lên n8n hoặc tới
n8n-as-code.

## 11. Chú ý

n8n-as-code là project cộng đồng độc lập, không phải sản phẩm chính thức của n8n. Trang GitHub của tool nói rõ: n8n-as-code là một project cộng đồng độc lập và không liên kết, không được xác nhận hay tài trợ bởi n8n. 
n8n Docs

Về khả năng tương thích version, chính tác giả cũng ghi rõ: bộ schema node đi kèm với n8n-as-code được build dựa trên bản stable mới nhất của n8n, và khuyến nghị giữ instance n8n luôn cập nhật để có kết quả generate/validate tốt nhất. 
n8n Docs

Vậy nghĩa là gì trên thực tế:

Phần đọc/ghi workflow JSON (pull/push) qua REST API — cái mà daemon của mình đang dùng (n8nac push gọi PUT /api/v1/workflows/:id) — về bản chất là serialize/deserialize cấu trúc nodes/connections/parameters mà n8n API trả về, nên khá ổn định qua các version, miễn API contract không đổi.
Phần "hiểu" schema từng loại node (để validate, autocomplete, hay parse đúng cấu trúc .workflow.ts) — cái này build theo bản n8n mới nhất tại thời điểm release n8n-as-code, nên nếu n8n instance của công ty đang chạy version cũ hơn nhiều, hoặc mới hơn bản mà n8n-as-code hỗ trợ, một số node đời mới/cũ có thể bị validate sai hoặc thiếu field.
Đáng chú ý hơn: n8n vừa có bản v2.0 với breaking changes khá lớn — Code node Python bản native không còn hỗ trợ biến _input hay cú pháp dot-access như bản Pyodide cũ, và n8n sẽ tắt mặc định node ExecuteCommand, LocalFileTrigger vì lý do an ninh. Nếu công ty nâng n8n lên v2.0 mà n8n-as-code chưa cập nhật schema kịp, các Code node Python cũ hoặc node bị disable có thể không được n8n-as-code xử lý đúng. 
GitHub
GitHub

Khuyến nghị thực tế:

Kiểm tra version n8n server đang chạy so với changelog n8n-as-code trên GitHub trước khi rollout rộng.
Luôn dùng n8nac push --verify (flag verify có sẵn) sau mỗi lần push quan trọng, đặc biệt sau khi công ty upgrade n8n version.
Test kỹ workflow trên n8n UI sau mỗi lần sync, không nên tin tưởng 100% "sync là chuẩn" mà không kiểm chứng lại kết quả trên canvas thật — đúng như cách mình đã làm suốt quá trình test vừa rồi.

