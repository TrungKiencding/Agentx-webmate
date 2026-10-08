<p align="center">
  <img src="brand/icons/icon128.png" alt="AgentX WebMate" width="92">
</p>

<h1 align="center">AgentX WebMate</h1>

<p align="center">
  Trợ lý AI ngay trong trình duyệt — đọc trang web, trả lời câu hỏi và thực hiện tác vụ trong phiên làm việc của bạn.
</p>

<p align="center">
  <a href="https://github.com/TrungKiencding/agentx-webmate">Repository</a> ·
  <a href="https://github.com/TrungKiencding/agentx-webmate/issues">Báo lỗi</a> ·
  <a href="docs/">Tài liệu</a> ·
  <a href="LICENSE">Giấy phép</a>
</p>

AgentX WebMate là tiện ích trình duyệt đưa AI vào một bảng bên cạnh các tab đang mở. Bạn có thể hỏi về nội dung trang, yêu cầu tóm tắt tài liệu, trích xuất dữ liệu hoặc giao cho trợ lý một chuỗi thao tác như tìm kiếm, điền biểu mẫu và điều hướng.

Tiện ích làm việc trong trình duyệt bạn đang sử dụng, với phiên đăng nhập hiện có. Khi kết nối qua MCP, AgentX Workmate hoặc một ứng dụng hỗ trợ MCP có thể giao tác vụ cho WebMate và nhận kết quả.

## Tính năng

- **Hỏi đáp theo nội dung trang:** đọc văn bản, liên kết, bảng, biểu mẫu và các phần tử tương tác.
- **Thao tác trên trình duyệt:** nhấp, nhập liệu, cuộn, điều hướng, tải lên và tải xuống theo quyền được cấp.
- **Đọc tài liệu đính kèm:** hỗ trợ ảnh, PDF, DOCX và các tệp văn bản như TXT, JSON, CSV.
- **Lập kế hoạch:** xem và duyệt kế hoạch trước khi thực hiện tác vụ nhiều bước.
- **Workflow tái sử dụng:** lưu quy trình đã thực hiện để chạy lại, xuất hoặc chia sẻ.
- **Lịch và theo dõi:** hẹn tác vụ hoặc theo dõi trang theo một điều kiện.
- **Skills:** bổ sung hướng dẫn và công cụ cho các tác vụ chuyên biệt.
- **Lựa chọn mô hình:** kết nối các nhà cung cấp AI hoặc máy chủ mô hình cục bộ tương thích OpenAI.
- **Tích hợp AgentX:** đăng nhập AgentX, kết nối Skill Hub và phối hợp với AgentX Workmate.

## Cài đặt từ mã nguồn

Cần Git, Node.js và npm. Sử dụng **Node.js 20 trở lên** nếu bạn chạy MCP server.

```bash
git clone https://github.com/TrungKiencding/agentx-webmate.git
cd agentx-webmate
npm ci
npm run brand:build
```

Lệnh build tạo hai thư mục `brand-dist/chrome` và `brand-dist/firefox`.

### Chrome, Edge và các trình duyệt Chromium

1. Mở `chrome://extensions/` hoặc `edge://extensions/`.
2. Bật **Developer mode / Chế độ dành cho nhà phát triển**.
3. Chọn **Load unpacked / Tải tiện ích đã giải nén**.
4. Chọn thư mục **`brand-dist/chrome`** trong dự án.
5. Ghim biểu tượng AgentX WebMate và mở bảng bên để bắt đầu.

### Firefox

1. Mở `about:debugging#/runtime/this-firefox`.
2. Chọn **Load Temporary Add-on**.
3. Chọn `brand-dist/firefox/manifest.json`.

Bản cài tạm thời sẽ bị gỡ khi Firefox khởi động lại. Cài đặt lâu dài cần một gói tiện ích đã được ký.

## Bắt đầu sử dụng

Mở AgentX WebMate, hoàn tất đăng nhập AgentX khi được yêu cầu và chọn nhà cung cấp, mô hình trong **Settings / Cài đặt**. Với nhà cung cấp yêu cầu khóa API, nhập khóa của bạn trong phần cấu hình tương ứng.

Mở trang bạn muốn làm việc và thử:

- “Tóm tắt nội dung trang này bằng tiếng Việt.”
- “Trích xuất bảng giá thành danh sách để tôi so sánh.”
- “Tìm các liên kết liên quan đến tài liệu API.”
- “Nhập từ khóa AI agents vào ô tìm kiếm và tìm kiếm.”

Chọn chế độ phù hợp trước khi gửi yêu cầu:

| Chế độ | Khả năng |
| --- | --- |
| **Ask** | Đọc trang, trả lời câu hỏi và lấy nội dung URL. |
| **Act** | Thực hiện thao tác như nhấp, nhập liệu, điều hướng và điền biểu mẫu. |
| **Dev** | Bổ sung công cụ kiểm tra mã trang, CSS, console, network và chỉnh sửa trang có thể hoàn tác. |

Các thao tác thực tế chịu sự kiểm soát của chế độ quyền đã chọn. Xem yêu cầu cấp quyền và kiểm tra nội dung trước khi duyệt hành động.

## Kết nối mô hình

WebMate hỗ trợ các nhà cung cấp như OpenAI, Anthropic, Google Gemini, Azure OpenAI, AWS Bedrock, OpenRouter và các dịch vụ tương thích khác. Danh sách và hướng dẫn cấu hình nằm trong [Providers and models](docs/providers-and-models.md).

Bạn cũng có thể sử dụng Ollama, llama.cpp, LM Studio hoặc một máy chủ tương thích OpenAI trên máy:

```bash
# Ollama
ollama serve

# llama.cpp
llama-server -m your-model.gguf --port 8080
```

Trong Settings, chọn nhà cung cấp cục bộ phù hợp và cấu hình địa chỉ máy chủ, ví dụ `http://localhost:11434/v1` cho Ollama hoặc `http://localhost:8080/v1` cho llama.cpp. Tải mô hình trước khi gửi yêu cầu.

Nên dùng mô hình có cửa sổ ngữ cảnh ít nhất **16k token** cho tác vụ trình duyệt. Chọn tier **Compact** khi sử dụng mô hình nhỏ; khả năng nhận ảnh phụ thuộc vào mô hình và cấu hình máy chủ.

## Tích hợp AgentX Workmate và MCP

MCP cho phép ứng dụng AI giao tác vụ cho WebMate trong trình duyệt đang đăng nhập của bạn. Tính năng cầu nối trình duyệt hiện hỗ trợ **Chromium**.

### AgentX Workmate

```bash
agentx mcp install webmate
```

Sau khi cài, bắt đầu phiên mới hoặc chạy `/reload-mcp` trong Workmate. Xem [hướng dẫn tích hợp Workmate](docs/workmate-integration.md) để biết cách cài tiện ích, ghép nối và cập nhật.

### Chạy MCP server từ mã nguồn

Từ thư mục gốc dự án:

```bash
cd mcp-server
npm ci
npm run build
```

Ví dụ đăng ký với Claude Code, ngay trong thư mục `mcp-server`:

```bash
claude mcp add --transport stdio webmate -- node "$PWD/dist/index.js"
```

Với ứng dụng MCP khác, cấu hình lệnh `node` và đường dẫn tuyệt đối đến `mcp-server/dist/index.js`. Ứng dụng MCP sẽ khởi chạy server khi kết nối.

Cầu nối mặc định của tiện ích là `ws://127.0.0.1:17374/extension`. Kiểm tra trạng thái trong **Settings → General → Advanced → Cloud bridge**. Nếu Settings báo **Connection error: WebSocket error**, thường là không có tiến trình nào nghe ở địa chỉ đã chọn: hãy chạy MCP server, kiểm tra địa chỉ dùng cổng `17374` và để tiến trình đó chạy tiếp.

Mỗi lúc tiện ích chỉ nối tới một đích: WebMate Cloud dùng cổng `17373`, MCP server dùng `17374`, plugin LM Studio dùng `17375`. Đổi đích ngay trong mục Cloud bridge. Xem thêm [mục xử lý sự cố của MCP server](mcp-server/README.md#troubleshooting).

Các công cụ MCP gồm:

| Công cụ | Chức năng |
| --- | --- |
| `webmate_run` | Giao một tác vụ trình duyệt. |
| `webmate_extract` | Trích xuất dữ liệu theo JSON Schema. |
| `webmate_status` | Kiểm tra trạng thái tác vụ. |
| `webmate_respond` | Trả lời yêu cầu làm rõ hoặc tương tác đang chờ. |
| `webmate_abort` | Dừng tác vụ. |
| `webmate_connection` | Kiểm tra kết nối với tiện ích. |

Xem [tài liệu MCP server](mcp-server/README.md) để biết tham số, vòng đời tác vụ, cấu hình ghép nối và cách xử lý lỗi.

## Lệnh trong bảng chat

Gõ `/help` để xem cú pháp đầy đủ.

| Lệnh | Công dụng |
| --- | --- |
| `/ask`, `/act`, `/dev` | Chuyển chế độ làm việc. |
| `/plan` | Yêu cầu lập kế hoạch. |
| `/schedule` | Tạo tác vụ hẹn giờ. |
| `/watch` | Theo dõi trang theo điều kiện. |
| `/workflow` | Quản lý hoặc lưu workflow. |
| `/teach` | Ghi nhận quy trình qua thao tác mẫu. |
| `/memory` | Lưu tùy chọn người dùng. |
| `/screenshot` | Chụp ảnh tab. |
| `/record` | Ghi lại tab. |
| `/export` | Xuất hội thoại, trace hoặc cấu hình. |
| `/compact`, `/reset` | Thu gọn ngữ cảnh hoặc đặt lại hội thoại. |

`/watch [--keep] [--secs <30-120>] [--long | --short] <điều kiện và hành động> [/beep]` kiểm tra lần đầu ngay khi tạo, sau đó cứ 60 giây kiểm tra lại (`--secs` nhận 30–120). Với điều kiện tương đối như "khi có commit mới", lần kiểm tra đầu được lấy làm mốc; `--keep` giữ việc theo dõi sau mỗi lần khớp và không báo lại cho cùng một khóa sự kiện ổn định.

Danh sách đầy đủ, kể cả `/dangerously-skip-permissions`, có trong [tài liệu lệnh](docs/slash-commands.md).

## Phím tắt

Phím tắt của bảng bên trong Chrome dùng được khi bảng WebMate đang được chọn.

| Phím | Tác dụng |
| --- | --- |
| `Ctrl/Cmd+/` | Đưa con trỏ vào ô nhập. |
| `Ctrl/Cmd+Shift+A` | Chuyển sang chế độ Hỏi. |
| `Ctrl/Cmd+Shift+X` | Chuyển sang chế độ Hành động. |
| `Ctrl/Cmd+Shift+D` | Chuyển sang chế độ Dev. |
| `Escape` | Dừng lần chạy hiện tại, trừ khi phím chỉ đang đóng gợi ý lệnh. |
| `Escape` hai lần | Dừng bản ghi đang chạy, từ bảng WebMate hoặc từ trang web. |

## Phát triển

```bash
npm run brand:build    # Build tiện ích AgentX WebMate
npm run brand:watch    # Theo dõi thay đổi và build lại
npm run build:zip      # Đóng gói tiện ích vào dist/
npm test              # Chạy bộ kiểm thử của dự án
```

Sau khi build lại, tải lại tiện ích trên trang quản lý extension. Các tệp trong `brand-dist/` là đầu ra sinh tự động; chỉnh sửa cấu hình và phần tùy biến trong `brand/` thay vì sửa trực tiếp đầu ra.

| Thư mục | Nội dung |
| --- | --- |
| `brand/` | Cấu hình AgentX, biểu tượng, giao diện và phần tùy biến. |
| `src/chrome/` | Mã nền cho tiện ích Chromium, Manifest V3. |
| `src/firefox/` | Mã nền cho tiện ích Firefox, Manifest V2. |
| `brand-dist/` | Tiện ích đã build để nạp vào trình duyệt. |
| `mcp-server/` | MCP server giao tác vụ cho trình duyệt. |
| `lmstudio-plugin/` | Mã plugin tích hợp LM Studio. |
| `docs/` | Tài liệu kiến trúc, tính năng và tích hợp. |
| `scripts/` | Công cụ build, đóng gói và phát hành. |
| `test/` | Bộ kiểm thử và kịch bản đánh giá. |
| `web/` | Mã website và trang tài liệu. |

## Tài liệu tham khảo

- [Kiến trúc](docs/architecture.md)
- [Công cụ và chế độ agent](docs/agent-tools.md)
- [Nhà cung cấp và mô hình](docs/providers-and-models.md)
- [Lệnh trong chat](docs/slash-commands.md)
- [Skills](docs/skills.md)
- [Mô hình bảo mật](docs/security-model.md)
- [Quyền riêng tư và luồng dữ liệu](docs/privacy-and-data-flow.md)
- [Tích hợp AgentX Workmate](docs/workmate-integration.md)
- [MCP server](mcp-server/README.md)

## Giới hạn hiện tại

- Firefox không có các khả năng Chrome DevTools Protocol của bản Chromium, nên một số thao tác, xử lý Shadow DOM và chụp ảnh trang có thể khác nhau.
- Cầu nối MCP trình duyệt hiện chỉ hỗ trợ Chromium.
- Kết quả phụ thuộc vào mô hình, nội dung trang và quyền được cấp. Các trang động hoặc có cơ chế chống tự động hóa có thể cần thao tác bổ sung từ người dùng.
- Nội dung trang và tài liệu được gửi đến nhà cung cấp mô hình đã chọn khi cần xử lý; xem [quyền riêng tư và luồng dữ liệu](docs/privacy-and-data-flow.md) trước khi làm việc với dữ liệu nhạy cảm.

## Đóng góp và hỗ trợ

Gửi lỗi và đề xuất tại [GitHub Issues](https://github.com/TrungKiencding/agentx-webmate/issues). Khi báo lỗi, ghi rõ trình duyệt, phiên bản tiện ích, nhà cung cấp mô hình và các bước tái hiện; loại bỏ khóa API và dữ liệu riêng tư khỏi log hoặc ảnh đính kèm.

Xem [CONTRIBUTING.md](CONTRIBUTING.md) trước khi đóng góp và [CHANGELOG.md](CHANGELOG.md) để theo dõi thay đổi.

## Giấy phép

Mã tiện ích được phân phối theo **GPL-3.0-or-later**. Xem [LICENSE](LICENSE) để biết toàn bộ điều khoản và các thông báo bản quyền áp dụng. Các thành phần có giấy phép riêng được ghi trong thư mục tương ứng, bao gồm [MCP server](mcp-server/LICENSE) và [plugin LM Studio](lmstudio-plugin/LICENSE).
