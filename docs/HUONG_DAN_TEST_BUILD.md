# Hướng dẫn test, build và cài đặt trên Windows

Mở PowerShell tại thư mục project:

```powershell
cd "D:\TAILIEU\MyProject\AI_Tool\codex-chatgpt-web-main"
```

## Chuẩn bị Bun và dependencies

Project yêu cầu đúng **Bun 1.4.0** để build runtime. Kiểm tra phiên bản đang dùng:

```powershell
bun --version
```

Nếu kết quả khác `1.4.0`, tải Bun 1.4.0 cục bộ và đặt nó lên đầu `PATH` của cửa sổ PowerShell hiện tại:

```powershell
$bunVersion = "1.4.0"
$bunRoot = Join-Path $env:LOCALAPPDATA "codex-chatgpt-web\bun-$bunVersion"
$bunZip = Join-Path $env:TEMP "bun-windows-x64-baseline-$bunVersion.zip"
New-Item -ItemType Directory -Force -Path $bunRoot | Out-Null
Invoke-WebRequest "https://github.com/oven-sh/bun/releases/download/bun-v$bunVersion/bun-windows-x64-baseline.zip" -OutFile $bunZip
Expand-Archive -Path $bunZip -DestinationPath $bunRoot -Force
$bunExe = (Get-ChildItem -Path $bunRoot -Filter bun.exe -File -Recurse | Select-Object -First 1).FullName
$env:Path = "$(Split-Path $bunExe);$env:Path"
& $bunExe --version
```

Kết quả phải là `1.4.0`. Giữ nguyên cửa sổ PowerShell này cho các lệnh build bên dưới để Launcher cũng dùng đúng phiên bản Bun.

Cài dependency khóa theo lockfile cho runtime và Launcher:

```powershell
bun install --frozen-lockfile
Push-Location launcher
bun install --frozen-lockfile
Pop-Location
```

## Chạy test

Chạy toàn bộ test runtime:

```powershell
bun run test
```

Kiểm tra TypeScript:

```powershell
bun run typecheck
```

Chạy một file test cụ thể:

```powershell
bun test tests/browser-worker-contract.test.ts
```

Chạy một test theo tên:

```powershell
bun test tests/browser-worker-contract.test.ts -t "a staged Bigger Context part gets an acknowledgement window sized to its payload"
```

Trên Windows chưa bật quyền tạo symbolic link, hai test integration có thể được đánh dấu `skip`. Bật **Developer Mode** hoặc cấp quyền **Create symbolic links** nếu cần chạy chúng.

## Chạy ứng dụng từ source

Nhấp đúp `START-APP.bat` ở thư mục gốc để chạy one-click. Script dùng profile thông thường (cùng cấu hình ChatGPT và Codex với bản cài), tự cài dependency và đóng terminal khi UI hiện lên. Nếu khởi động lỗi, terminal giữ lại thông báo và đường dẫn log.

Trên Windows, bản chạy source có thể bật **Launch at login** trong Settings để khởi động cùng Windows. Tùy chọn này đăng ký riêng `START-APP.bat` thông qua Windows Run, chạy ẩn trong khay hệ thống sau khi đã hoàn tất onboarding; tắt tùy chọn sẽ xóa đăng ký. Nếu di chuyển thư mục source, hãy mở lại ứng dụng và bật lại tùy chọn. Profile DEV (`bun run app:dev`) không đăng ký khởi động cùng Windows.

Để chạy cùng profile thông thường từ PowerShell (tự động dùng production):

```powershell
bun run app
```

Nếu đang mở bản cài, thoát ứng dụng từ khay hệ thống trước khi chạy source để tránh mở lại phiên bản đang chạy. Sau khi kết nối trong Launcher, khởi động lại Codex để tải danh sách model.

Để thử nghiệm với profile DEV riêng, không thay đổi kết nối của Codex đang dùng hằng ngày:

```powershell
bun run app:dev
```

## Build bộ cài Windows

Build runtime, giao diện Electron và bộ cài NSIS:

```powershell
bun run app:package
```

Sau khi build xong, tìm file cài đặt:

```powershell
Get-ChildItem .\launcher\release\*.exe
```

Chạy file `.exe` được tạo để cài **Codex Web GPT**. Sau khi cài, mở ứng dụng từ Start Menu, đăng nhập ChatGPT, rồi hoàn tất phần Models và MCP trong Launcher.

## Khi Bun không nhận diện được

Dùng trực tiếp executable đã cài trong tài khoản hiện tại:

```powershell
C:\Users\rkaka\.bun\bin\bun.exe run test
C:\Users\rkaka\.bun\bin\bun.exe run app:package
```

Lưu ý: Bun mặc định tại đường dẫn trên có thể là phiên bản mới hơn 1.4.0; dùng nó cho test được, nhưng không dùng để build package khi project vẫn khóa Bun 1.4.0.
