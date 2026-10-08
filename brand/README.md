# AgentX WebMate — lớp thương hiệu

Sản phẩm này là bản tuỳ biến của [webbrain-one/webbrain](https://github.com/webbrain-one/webbrain) (GPL-3.0-or-later từ bản 33.0.0; các bản trước đó là MIT).
Mục tiêu của thư mục `brand/`: **giữ nguyên vẹn toàn bộ upstream để merge tính năng mới mỗi ngày gần như không conflict.**

## Nguyên tắc số một

> **Không bao giờ sửa file trong `src/`.**

`src/chrome/` và `src/firefox/` là bản sao y nguyên upstream. Mọi thay đổi thương hiệu nằm trong `brand/`,
và `scripts/brand-build.mjs` ghép chúng lại lúc build. Nhờ vậy `git merge upstream/main` chỉ đụng tới
những file bạn thật sự sở hữu thay vì hàng trăm file của upstream.

Sửa thẳng vào `src/` sẽ vẫn chạy, nhưng mỗi lần upstream đổi file đó bạn phải giải conflict thủ công.
Đó chính xác là thứ kiến trúc này sinh ra để tránh.

## Thư mục

```
brand/
├── brand.config.json     Tên, mô tả, các rule thay chuỗi, danh sách token phải giữ nguyên
├── theme.css             Ghi đè biến CSS (nối vào cuối sidepanel.css lúc build)
├── first-run-install.css Giao diện trang chào mừng sau khi cài extension
├── first-run-onboarding.css
│                         Giao diện coachmark ghim và onboarding 3 bước trong side panel
├── icons/                Icon đã sinh từ assets/logo/logo.jpg — đè lên src/<target>/icons/
├── overrides/<target>/   Thay nguyên file upstream (cùng đường dẫn tương đối)
├── additions/<target>/   File hoàn toàn mới của bạn
└── patches/<target>/     Diff phẫu thuật, áp bằng `git apply`
```

`tokens.css` ở root chứa palette, font stack, spacing và motion token dùng chung cho hai giao diện
lần đầu. Build script nối token vào từng stylesheet đầu ra trước khi nối `first-run-*.css`.

Thứ tự áp (sau đè trước): copy upstream → overrides → additions → patches → replacements →
manifest/icons/theme → first-run styles.

## Lệnh hằng ngày

```bash
npm run brand:build     # dựng brand-dist/chrome và brand-dist/firefox
npm run brand:watch     # build lại mỗi khi sửa src/, brand/ hoặc tokens.css
npm run brand:audit     # liệt kê file còn sót chữ "webbrain", nhiều nhất trước
npm run brand:clean     # xoá brand-dist/
npm run build:zip       # build brand-dist rồi đóng gói dist/agentx-webmate-*.zip
```

Nạp extension khi dev: Chrome → `chrome://extensions` → Load unpacked → chọn **`brand-dist/chrome`**
(không phải `src/chrome`). `brand-dist/` nằm trong `.gitignore`, không commit.

## Build tự kiểm tra 3 lớp

Đây là phần đáng tin nhất của hệ thống — nó fail to, sớm, thay vì ship bản hỏng:

1. **Patch drift** — patch không áp được → build fail kèm tên file. Nghĩa là upstream đã viết lại đoạn code bạn hook vào.
2. **`preserve` guard** — nếu một rule replace vô tình đụng vào token trong danh sách `preserve`
   (`api.webbrain.one`, các storage key…), build fail. Đây là lỗi nguy hiểm nhất của white-label: đổi nhầm
   endpoint API hoặc khoá lưu trữ thì sản phẩm hỏng âm thầm.
3. **`node --check`** — mọi file JS đầu ra phải parse được. Bắt đúng lỗi kinh điển: rule replace lọt vào giữa
   tên biến và biến JS hợp lệ thành lỗi cú pháp.

## Ba loại chuỗi "webbrain" — đừng gộp làm một

Khảo sát repo cho ra 3182 chỗ, và **không phải chỗ nào cũng được thay**:

| Loại | Ví dụ | Xử lý |
|---|---|---|
| Text người dùng thấy | `WebBrain` trong `src/ui/locales/*.js` | ✅ Đã thay (2841 chỗ) |
| Tên biến / hàm | `ensureWebBrainGroup`, `helpImproveWebBrain` | ❌ Giữ — thay vào là lỗi cú pháp |
| Endpoint & storage key | `api.webbrain.one`, `webbrain_cloud`, `WEBBRAIN_CLOUD_PROVIDER_ID` | ❌ Giữ — thay vào là hỏng tính năng cloud |
| Định danh giao thức | `webbrain-tools`, `webbrain-skill` (WebMCP) | ❌ Giữ — trang web bên ngoài dựa vào tên này |

Rule trong `brand.config.json` dùng lookahead/lookbehind để tách đúng 4 nhóm trên. Khi thêm rule mới,
luôn chạy `npm run brand:build` — `preserve` guard và `node --check` sẽ chặn nếu bạn quét quá tay.

Tên file do người dùng tải xuống dùng tiền tố `agentx-webmate-`. Riêng đuôi workflow cũ
`.webbrain-workflow.json` vẫn được chấp nhận khi import để không làm hỏng dữ liệu đã có.
Các README/ARCHITECTURE và ghi chú nguồn asset của upstream không cần lúc chạy được loại khỏi gói phát hành;
`LICENSE` luôn được giữ lại.

Hai file `first-run-*.css` chỉ thay lớp giao diện: nội dung i18n, logic mở side panel, dò model,
coachmark ghim và trạng thái hoàn thành onboarding vẫn lấy nguyên từ upstream. Build script nối chúng
vào `src/ui/install.css` và `styles/sidepanel.css` của từng target, nên không cần sửa trực tiếp `src/`.

## Thêm / bớt tính năng

Chọn cách **thấp nhất còn dùng được** — càng lên cao càng dễ vỡ khi upstream đổi:

1. **`features.exclude`** trong config — loại hẳn file khỏi bản build. Tốt nhất cho tính năng gói gọn 1 file.
   ```json
   "features": { "exclude": ["src/ui/promotion-*.js"] }
   ```
2. **`additions/`** — tính năng mới, file mới. Không bao giờ conflict.
3. **`overrides/`** — thay nguyên một file upstream. Rẻ lúc viết, nhưng bạn **mất mọi cập nhật upstream cho file đó**.
   Chỉ dùng với file nhỏ và ít thay đổi.
4. **`patches/`** — sửa vài dòng giữa file lớn (ví dụ `background.js` 131KB). Giữ được cập nhật upstream,
   đổi lại patch sẽ fail khi upstream viết lại vùng đó — và fail như vậy là đúng mong muốn.

Tạo patch:
```bash
cp src/chrome/src/ui/sidepanel.js /tmp/orig.js
# sửa /tmp/orig.js theo ý bạn
diff -u src/chrome/src/ui/sidepanel.js /tmp/orig.js > brand/patches/chrome/010-sidepanel-xyz.patch
```
Sửa header trong file `.patch` cho đúng đường dẫn tương đối (`src/ui/sidepanel.js`), đánh số thứ tự để kiểm soát thứ tự áp.

## Đồng bộ upstream

Từ 2026-09-24 upstream được đồng bộ **có chọn lọc, làm tay**: cherry-pick từng commit, hoặc cả PR
bằng `git cherry-pick -m 1 <merge>` khi PR có nhánh con song song; chỉ lấy những gì áp sạch hoặc
conflict đơn giản, rồi chạy `npm test` (có `brand:build`) trước khi merge vào `main`. Lý do: từ bản
33.0.0 upstream theo GPL-3.0-or-later, và `main` đã tách xa upstream — merge nguyên khối cho ~279 file
conflict, nên merge tự động hằng ngày chỉ sinh PR conflict.

Vì vậy `.github/workflows/agentx-sync-upstream.yml` **không còn chạy theo lịch**, chỉ chạy tay
(tab **Actions** → *Sync upstream (webbrain)* → *Run workflow*). Khi chạy tay nó vẫn:

- Cập nhật nhánh `upstream-sync` = bản sao y hệt upstream/main (không bao giờ conflict, dùng để đối chiếu).
- Thử merge vào `main`:
  - **sạch + `brand:build` pass** → đẩy thẳng lên `main`.
  - **sạch nhưng build fail** → mở PR (thường là patch drift).
  - **conflict** → mở PR để bạn xử lý tay.

Với độ lệch hiện tại, lần chạy tay gần như chắc chắn ra PR conflict — dùng nó để làm mới nhánh gương
`upstream-sync`, không phải để đồng bộ.

### Secret `MIRROR_TOKEN` — đừng để hết hạn

Workflow push bằng secret `MIRROR_TOKEN` chứ **không** dùng `github.token` mặc định. Lý do:
token mặc định của Actions là token GitHub App, mà App bị GitHub cấm tạo/sửa file trong
`.github/workflows/`. Upstream có sẵn 6 workflow, nên bất cứ lần nào upstream đụng vào chúng thì
push bằng token mặc định sẽ bị từ chối ở đúng bước cuối — sau khi đã upload xong dữ liệu.

Nếu PAT hết hạn, workflow fail ngay ở bước *Kiểm tra token* với hướng dẫn tạo lại:
```bash
gh auth refresh -h github.com -s workflow
gh secret set MIRROR_TOKEN --repo astralxkienlt/agentx-webmate --body "$(gh auth token)"
```

6 workflow của upstream đã bị **tắt** trong mirror (tắt qua API, không xoá file — nên không tạo
conflict khi merge). Nếu sau này merge upstream thêm workflow mới, nhớ tắt nó đi, không thì nó
sẽ chạy và fail vì thiếu secret của WebBrain.

Merge tại máy:
```bash
git fetch upstream
git merge upstream/main
npm run brand:build
```

## Còn phải làm trước khi phát hành

Build hiện dùng giá trị tạm. Những mục dưới đây **phải** xử lý trước khi lên store:

- [ ] `product.firefoxId` đang là `agentx-webmate@example.com` — đổi sang domain bạn sở hữu.
- [ ] **Privacy policy**: `https://webbrain.one/privacy` còn xuất hiện 24 chỗ. Chrome Web Store **bắt buộc** có
      privacy policy của chính bạn với bộ quyền này (`debugger`, `<all_urls>`, `tabCapture`…). Trỏ về trang của bạn
      bằng một rule replace URL.
- [ ] Prompt đánh giá đang bị vô hiệu hoá để không đưa người dùng tới listing cũ → sau khi publish, cấu hình URL listing mới và bật lại ngưỡng hiển thị.
- [ ] Quyết định về `api.webbrain.one`: hiện các tính năng cloud vẫn gọi backend của WebBrain. Muốn tách hẳn thì
      phải tự dựng backend rồi mới đổi URL — đừng đổi URL trước.
- [ ] `theme.css` mới chỉ có khung; đặt `--accent` theo bảng màu của bạn.

## Giấy phép

Từ bản 33.0.0, upstream WebBrain chuyển sang **GPL-3.0-or-later** (các bản trước đó là MIT).
AgentX WebMate dùng code upstream từ 33.0.0 trở đi, nên **toàn bộ extension khi phân phối phải
theo GPL-3.0-or-later**: người nhận bản build có quyền nhận mã nguồn tương ứng (repo này đang
public), được sửa và phân phối lại theo cùng giấy phép, và phần code AgentX nằm trong extension
cũng thuộc GPL. Đừng xoá `LICENSE` hay `src/{chrome,firefox}/LICENSE` — chúng được copy sang
bản build, chứa cả thông báo MIT của phần code cũ lẫn toàn văn GPL-3.0.

`mcp-server/` và `lmstudio-plugin/` là chương trình riêng, vẫn theo MIT (mỗi thư mục có `LICENSE`
riêng).

## Lưu ý về repo này

Clone theo kiểu **partial + sparse** vì repo gốc nặng ~1GB:

- `--filter=blob:none`: đủ lịch sử commit để merge, blob tải theo nhu cầu.
- Sparse checkout **không có `test/`** (6674 file). Cần chạy test tại máy:
  ```bash
  git sparse-checkout add test && npm ci
  ```
- Remote `upstream` đã khoá push (`DISABLED_read_only`) để không lỡ tay đẩy code thương hiệu lên repo gốc.

## Khoá `key`, ID cố định và hợp đồng với AgentX Workmate

Workmate cài extension này kiểu *unpacked* từ thư mục nó sở hữu
(`~/.agentx/webmate/AgentX WebMate/`) và nhận diện nó trong profile trình duyệt bằng
ID. ID chỉ ổn định khi manifest có `key`, nên:

| Chỗ | Nội dung |
|---|---|
| `brand.config.json` → `manifestOverrides.chrome.key` | Khoá công khai RSA-2048 (SPKI, base64). Chỉ áp cho Chrome/Edge; Firefox không nhận. Đi kèm `minimum_chrome_version: "121"` — bản Chrome đầu tiên bỏ hộp nhắc developer mode. |
| `brand.config.json` → `product.extensionId` | ID suy ra từ `key` (SHA-256 của SPKI, 16 byte đầu, chữ a–p). Hiện là `pfadeibckkgklmmjghiikadphihbpape`. `scripts/brand-build.mjs` **fail build** nếu hai giá trị không khớp (`scripts/extension-id.mjs`). |
| `brand.config.json` → `workmate` | Tên thư mục cài (`installDirName`), sàn tương thích (`minWorkmate`, `minProtocol`) ghi vào `release.json`, địa chỉ feed, đường dẫn khoá công khai ký feed. |
| `scripts/release-signing-key.pub.pem` | Khoá công khai Ed25519 xác minh `release.json`; bản sao được biên dịch vào Workmate. |

**Khoá bí mật không nằm trong kho.** Trên máy người bảo trì: `~/.agentx/webmate-keys/manifest-key.pem`
(khoá RSA của manifest — mất nó không sao, chỉ cần giữ `key` trong config; nhưng đừng để lộ) và
`~/.agentx/webmate-keys/release-signing-key.pem` (khoá ký feed — CI đọc từ secret
`WEBMATE_RELEASE_SIGNING_KEY`; lộ khoá này là kẻ khác ký được bản cập nhật cho mọi Workmate).

Lưu ý khi dev: có `key` nghĩa là bản nạp từ `brand-dist/chrome` cũng mang ID cố định. Bản đã nạp
theo đường dẫn trước đây (ID `pobbeoaonfpakadnbgcpijngnkhnmemg`) sau khi Reload sẽ đổi sang ID mới,
và dữ liệu `chrome.storage` (phiên đăng nhập, cài đặt) gắn với ID cũ không đi theo.

Hợp đồng đầy đủ (workmate.json, pairing.json, state.json, lệnh cập nhật, release.json ký):
`docs/workmate-integration.md`.

## Lớp AgentX Skill Hub (Phase 4)

Cài skill trình duyệt từ [AgentX Skill Hub](https://agenthub.astralx.com.vn) — chi tiết ở `docs/integration-webmate.md` của repo hub. Trong `brand/`:

| Chỗ | Nội dung |
|---|---|
| `additions/common/src/agentx/hub-client.js` | Client hub: bearer = ID token của phiên AgentX, header thiết bị, timeout, mã lỗi; `getRender` tự tính SHA-256 byte nhận được và so với `X-AgentX-Render-Hash` của hub. |
| `additions/common/src/agentx/hub-sync.js` | Engine desired-state: alarm 5 phút + khi mở panel/Settings; `reconcileHubSkills()` (record hub chỉ đọc: giữ `renderHash`, bị sửa ngoài extension thì tải lại bản hub); `forkHubSkill()` ("Tách bản sao để sửa"); kênh `onMessageExternal` chỉ nhận `agentx-hub/ping` và `agentx-hub/install` từ đúng origin hub. |
| `additions/common/src/ui/agentx-hub-settings.js`, `agentx-hub.css` | Thẻ "AgentX Skill Hub" trong Settings → Skills; hàng hành động Xem · Tách bản sao · Gỡ cho record hub trong danh sách skill đã bật. |
| `patches/<target>/080…082-agentx-hub-*.patch` | `skills.js` (record `sourceType:'hub'` chỉ đọc — `applySkillEdit` trả `locked`; `renderHash`, `forkedFrom`), `background.js` (khởi tạo engine + action `agentx_hub_*`, kể cả `fork`), `settings.html/js` (thẻ + nhãn "Từ AgentX Hub" + hàng hành động riêng cho record hub). |
| `brand.config.json` `services.skillHubBaseUrl` | Địa chỉ hub — cũng là origin duy nhất trong `externally_connectable` (Chrome). Rule `MAX_CUSTOM_SKILLS = 40`. |

Build cho hub cục bộ: `AGENTX_HUB_EXTRA_ORIGINS=http://127.0.0.1:5173 npm run brand:build`, rồi trong Settings → Skills → Nâng cao đặt "Địa chỉ hub" = `http://127.0.0.1:5173` (chỉ HTTPS hoặc HTTP loopback). Test: `npm run test:agentx-hub` (chạy trên `brand-dist/` cả chrome lẫn firefox; `npm test` đã gồm).

## Giấy phép AgentX

Một giấy phép AgentX dùng chung cho Workmate, WebMate và Chat. SSO quyết định, dịch vụ khoá (`secondBrainBaseUrl`) báo lại qua `GET /v1/license` và trong mọi câu trả lời của `/v1/model-key`. Chỉ `license.access` quyết định chặn: `read_only` thì khoá. Hợp đồng đầy đủ và những gì WebMate làm với nó: mục *AgentX license* trong `docs/workmate-integration.md`.

| Chỗ | Nội dung |
|---|---|
| `additions/common/src/agentx/license.js` | Thuần: `normalizeLicense` (chỉ giữ thứ đáng tin, `access` không hợp lệ ⇒ không có giấy phép), ba mã 403 `license_*`, `licenseFromRefusal`, khoá nhắc hạn `expiringNoticeKey`, câu từ chối tiếng Anh cho lượt chạy Workmate. |
| `additions/common/src/agentx/cloud-service.js` | `refreshLicense` (tối đa 15 phút một lần, `force` cho "Kiểm tra lại", sự cố thì giữ giấy phép biết gần nhất, 404 `not_found` = SSO cũ ⇒ không có giấy phép), `knownLicense`, `licenseRunRefusal`; bản ghi `agentxLicenseV1` theo tài khoản. Mã `license_*` của `/v1/model-key` nằm trong danh sách `definitive` (không lùi về khoá cũ `stale-offline`) và không xoá phiên. |
| `additions/common/src/ui/agentx-login-gate.js`, `agentx-login-gate.css` | Màn hình giấy phép (chỉ xem ⇒ khoá cả panel, lý do, liên hệ, "Kiểm tra lại", "Mở Cài đặt"); dải cảnh báo dưới header cho `grace` (luôn hiện) và `expiring` (một lần cho mỗi gói/ngày cuối/mốc nhắc, đóng được). |
| `additions/common/src/ui/agentx-license-copy.js` | Câu chữ vi/en dùng chung cho gate, dải cảnh báo và thẻ Cài đặt; ngày `dd/MM/yyyy` (vi) chỉ đổi cách viết, không đi qua `Date`. |
| `additions/common/src/ui/agentx-cloud-ui.js`, `agentx-cloud-settings.js` | Thẻ tài khoản trong Cài đặt: tên gói, trạng thái, ngày cuối, liên hệ (hiện cả khi chưa bắt buộc), cảnh báo đang áp dụng, nút "Kiểm tra lại" khi chỉ xem. |
| `additions/common/src/agentx/license-run-gate.js` + `patches/chrome/091-agentx-license-run-gate.patch` | `runGate` cho `src/chrome/src/cloud-runs.js`: lượt chạy do Workmate điều khiển bị từ chối với mã `license_read_only` kèm giấy phép; background chuyển `code`/`license` của lỗi sang offscreen bridge. Lỗi nào trong cổng này cũng cho chạy (không bao giờ khoá vì sự cố). |
| `patches/<target>/060-agentx-login-gate.patch` | Thêm khe `#agentx-license-banner` dưới header của `sidepanel.html`. |

Test: `node test/agentx-auth.test.mjs` (sau `npm run brand:build`; phần "AgentX license"), `node test/run.js` (cổng chạy trong `cloud-runs.js`, bridge chuyển mã), `cd mcp-server && npm test` (`test/refusal.test.mjs`).
