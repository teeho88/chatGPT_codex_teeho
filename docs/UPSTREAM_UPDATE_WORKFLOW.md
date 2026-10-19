# Cập nhật từ upstream và publish lên origin

Tài liệu này áp dụng cho repository hiện tại trên Windows PowerShell.

- Mã gốc: `https://github.com/miuuyy/codex-chatgpt-web.git` (`upstream`)
- Repository của bạn: `origin`
- Nhánh phát hành: `master`

Quy trình luôn tạo nhánh backup, hợp nhất upstream trước, kiểm thử, sau đó mới publish.

## Chạy tự động từ PowerShell

Trên Windows, nhấp đúp `UPDATE-UPSTREAM.bat` ở thư mục gốc repository để
chạy toàn bộ quy trình một lần. Cửa sổ lệnh giữ nguyên sau khi chạy để xem
kết quả hoặc thông báo lỗi. File `.bat` tự tìm đúng đường dẫn script dù mở
từ shortcut hoặc thư mục khác. Muốn chỉ kiểm tra, chạy
`UPDATE-UPSTREAM.bat -Check` trong CMD/PowerShell.

Từ thư mục repository, chạy một lệnh để kiểm tra upstream, tạo backup, merge,
giữ README ở trạng thái đã xóa, xác minh tùy biến, kiểm thử, commit và push
`master` lên `origin`:

```powershell
.\scripts\update-upstream.ps1
```

Chỉ kiểm tra có cập nhật mới, không merge/commit/push:

```powershell
.\scripts\update-upstream.ps1 -Check
```

Có thể dùng trực tiếp `node scripts/update-upstream.cjs` hoặc thêm `--check`.
Script yêu cầu Git, Node.js và Bun; nếu không tìm thấy Bun trong `PATH`,
script dùng `launcher/build/runtime/runtime/bun.exe` như quy trình thủ công.
Khi có thay đổi tracked/staged chưa commit, script hiển thị menu trước khi fetch
và so sánh upstream:

- `C` hoặc `commit`: stage các thay đổi tracked rồi commit cùng các file đã stage,
  với thông điệp `Save local changes before upstream update`.
- `S` hoặc `stash`: lưu các thay đổi tracked/staged vào stash, rồi khôi phục cả
  nội dung và trạng thái stage sau khi cập nhật hoặc bỏ qua. Stash dự phòng vẫn
  được giữ lại; thông báo in SHA để khôi phục khi cần. Nếu fetch/merge thất bại,
  script cũng thử khôi phục. Nếu khôi phục bị chặn hoặc có conflict, script báo
  lỗi và giữ stash để xử lý thủ công.
- `A`, `abort`, Enter trống hoặc hết đầu vào: hủy mà không commit/stash/push.

File untracked không được tự thêm vào commit hoặc stash; chúng được giữ nguyên.
Muốn đưa file mới vào commit, hãy `git add` file đó trước khi chạy script.

Sau bước này, script fetch upstream và hiển thị hai giá trị `version` trong
`package.json` local và `upstream/main`. Nếu **hai version giống hệt nhau**,
script bỏ qua merge, commit merge và push, kể cả khi upstream có commit khác
hoặc local có commit chưa publish. Commit đã tạo bằng lựa chọn `C` vẫn nằm local;
thay đổi đã stash bằng `S` được khôi phục. Nếu version khác nhau, quy trình cập
nhật tiếp tục; khi upstream không có commit mới, script vẫn có thể publish các
commit local. `-Check` chỉ fetch và so version, không hỏi commit/stash hay thay
đổi working tree, kể cả khi có thay đổi chưa commit.

Quy tắc bỏ qua theo version áp dụng cho BAT/CLI; updater trong launcher tiếp tục
kiểm tra theo commit. Nếu push bị từ chối, script báo lỗi,
giữ nguyên commit local và không force-push. Khi merge xung đột, script cho chọn
local hoặc upstream cho từng file. Nếu hủy lựa chọn hoặc kiểm thử thất bại,
script hủy merge và giữ nhánh backup để khôi phục.

### Khi Git có conflict hoặc trạng thái chưa hoàn tất

Khi chạy `UPDATE-UPSTREAM.bat` hoặc CLI Node, script liệt kê các file conflict,
rồi hỏi lần lượt cho từng file:

- `L` hoặc `local`: giữ toàn bộ bản file phía local trước merge.
- `U` hoặc `upstream`: giữ toàn bộ bản file phía upstream đang được merge.
- `A`, `abort`, Enter trống, Ctrl+C tại menu hoặc hết đầu vào: hủy cập nhật,
  thử khôi phục trạng thái trước merge và giữ backup.

Lựa chọn áp dụng cho **toàn bộ file**, bao gồm cả phần không bị conflict.
Nếu một phía không có file, menu ghi rõ chọn phía đó nghĩa là xóa file.
Các đường dẫn được hiển thị đúng theo index conflict của Git; với conflict
đổi tên hoặc file/thư mục, Git có thể đưa ra nhiều đường dẫn cần chọn riêng.
Script thu thập đủ lựa chọn trước khi áp dụng, rồi chạy kiểm tra tùy biến,
kiểm thử, commit và push như trước. README và các tài liệu bị loại trừ vẫn
được giữ ở trạng thái xóa theo quy tắc repository. Lựa chọn làm mất tùy biến
được bảo vệ hoặc khiến kiểm thử thất bại vẫn bị từ chối và hủy merge.

Không thể bảo đảm mọi conflict đều tự hợp nhất đúng hoặc mọi lệnh Git
luôn thành công (mạng, quyền truy cập và chính sách remote vẫn có thể gây lỗi).

- Trước khi cập nhật hoặc push, script chặn merge, rebase, `git am`, cherry-pick,
  revert, bisect đang dang dở, index còn conflict và `index.lock` còn tồn tại.
  Hoàn tất hoặc hủy thao tác tương ứng trước khi chạy lại.
- Một khóa riêng trong thư mục Git dùng chung ngăn hai updater cùng cập nhật.
  Nếu updater bị tắt đột ngột, thông báo sẽ chỉ đúng đường dẫn khóa còn lại.
  Chỉ xóa khóa sau khi đã xác minh không còn updater chạy. Không tự xóa
  `index.lock` của Git khi có tiến trình Git đang hoạt động.
- Merge không tự stash thay đổi và không được ghi đè file bị ignore. Nếu file
  untracked hoặc ignored chặn merge, script dừng để bạn tự di chuyển hoặc lưu file.
- Nếu không cung cấp bộ chọn (như updater trong launcher) hoặc không giải quyết
  được conflict sau lựa chọn, script liệt kê conflict cùng backup và commit
  upstream, rồi thử `git merge --abort`. Nếu thành công, HEAD và các thay đổi
  tracked do merge được khôi phục. Có thể xử lý thủ công theo mục 5.
- Nếu abort thất bại, thông báo giữ cả lỗi ban đầu, lỗi abort và tên backup.
  Giữ nguyên working tree, kiểm tra `git status`, rồi xử lý thao tác đang dở.
  Script không dùng `reset --hard` hoặc xóa file local để che lỗi.
- Nếu push bị từ chối do `origin/master` có commit khác, commit local được giữ.
  Fetch origin, hợp nhất lịch sử và xử lý conflict thủ công trước khi chạy lại.
  Script không force-push.

Các chốt kiểm tra này dùng chung với updater của launcher. Trước khi tạo merge,
script cũng kiểm tra danh tính commit; sau kiểm thử, script yêu cầu không có
thay đổi tracked chưa stage do quá trình kiểm thử tạo ra trước khi commit.

Push có commit mới lên `master` sẽ kích hoạt GitHub Actions build và publish
Windows Release theo `.github/workflows/teeho-windows-release.yml`.

## Cập nhật trực tiếp trong launcher chạy từ source

Khi chạy launcher từ checkout Git bằng chế độ development, launcher tự chạy
`git fetch upstream --prune` khi mở ứng dụng. Nếu có commit mới trên `upstream/main`, nút
**Update** sẽ xuất hiện. Bấm nút để chạy lần lượt các bước kiểm tra, tạo backup,
merge giữ trạng thái xóa `README*.md`, xác minh tùy biến quan trọng, cài dependency,
kiểm thử, commit và `git push origin master:master` như quy trình bên dưới.

Để đảm bảo an toàn, launcher chỉ cập nhật nhánh `master` khi không có thay đổi
tracked chưa commit. Xung đột ngoài README hoặc bài kiểm thử thất bại sẽ hủy
merge và giữ lại nhánh backup. Launcher không dùng force-push. Nếu push thất bại,
merge đã commit vẫn nằm trên `master` để có thể publish thủ công.

Sau khi cập nhật thành công, hãy khởi động lại launcher chạy từ source để nạp mã
mới. Khi `master` được push lên `teeho88/chatGPT_codex_teeho`, workflow
`.github/workflows/teeho-windows-release.yml` tự kiểm thử, build installer Windows,
và xuất bản GitHub Release dạng `vX.Y.Z-teeho.N` kèm `checksums.txt`. Bản `.exe`
Teeho kiểm tra kênh Release này và dùng chính nút **Update** để tải bản mới,
xác minh SHA-256, cài đặt và khởi động lại. Không cần chạy `git fetch` trên máy
chỉ cài `.exe`.

Workflow cần được bật GitHub Actions và có quyền tạo Release (`contents: write`).
Những bản `.exe` đã build trước khi thay đổi updater này cần được cài đè một lần
bằng installer mới để chuyển sang kênh Teeho.

> **Quy tắc local:** không đưa các file README từ upstream vào repository này. Các file
> `README.md`, `README.ja.md`, `README.ko.md`, `README.zh-CN.md` và các biến thể
> `README*.md` khác phải tiếp tục ở trạng thái không được track/xóa khỏi nhánh `master`.

## 1. Thiết lập một lần

Kiểm tra remote hiện có:

```powershell
git remote -v
```

Nếu chưa có `upstream`, thêm đúng repository gốc:

```powershell
git remote add upstream https://github.com/miuuyy/codex-chatgpt-web.git
```

Nếu `upstream` đã tồn tại nhưng sai URL, sửa URL fetch và push:

```powershell
git remote set-url upstream https://github.com/miuuyy/codex-chatgpt-web.git
git remote set-url --push upstream https://github.com/miuuyy/codex-chatgpt-web.git
```

## 2. Kiểm tra trước khi cập nhật

Chỉ bắt đầu khi không có thay đổi tracked chưa commit. Các tệp local không theo dõi như `.agent-memory/` có thể giữ nguyên.

Nếu working tree đang có các README bị xóa nhưng chưa commit, commit việc xóa đó trước
khi merge. Không restore hoặc checkout README từ upstream.

```powershell
git switch master
git status --short --branch
git diff --quiet
git diff --cached --quiet
```

Hai lệnh `git diff --quiet` phải trả về mã `0`. Nếu không, commit hoặc stash thay đổi của bạn trước khi tiếp tục.

## 3. Tải và xem thay đổi upstream

```powershell
git fetch upstream --prune
git log --oneline --decorate master..upstream/main
git rev-list --left-right --count master...upstream/main
git rev-list --left-right --count origin/master...master
```

Nếu log `master..upstream/main` không có commit nào, `master` đã mới nhất so với
upstream và không cần merge. Tuy nhiên vẫn kiểm tra kết quả
`origin/master...master`: nếu số bên phải lớn hơn `0`, local `master` còn commit
chưa publish và vẫn phải thực hiện bước push ở mục 8.

## 4. Tạo backup và merge an toàn

Tạo tên backup có timestamp, rồi bắt đầu merge nhưng chưa commit:

```powershell
$backup = "backup/pre-upstream-$(Get-Date -Format yyyyMMdd-HHmmss)"
git branch $backup master
git merge --no-commit --no-ff upstream/main
```

Nếu merge tạo lại hoặc báo xung đột modify/delete với README, luôn giữ phía local là
**xóa README**:

```powershell
git rm --ignore-unmatch README.md README.ja.md README.ko.md README.zh-CN.md
git ls-files "README*.md"
```

Lệnh `git ls-files "README*.md"` phải không in ra file nào trước khi commit merge.

Nếu Git nói merge thành công, kiểm tra các tùy biến trước khi commit:

```powershell
rg -n "UserWaitStore|userWaitStatePath" src
rg -n "CHATGPT_RESPONSE_DOM_GRACE_MS|CHATGPT_MULTIPART_RESPONSE_DOM_GRACE_MS" src/adapters/chatgpt-web/browser-worker.ts
rg -n "CHATGPT_WEB_MCP_APPROVAL_PROGRESS_MS|chatGptMcpInvocationTimeout|waitsForUserApproval|startApprovalProgress" src/adapters/chatgpt-web/mcp-server.ts
git diff --cached --stat
```

Các tùy biến cần giữ gồm checkpoint Zero Risk user-wait, `userWaitStatePath`, timeout phản hồi/multipart, Windows packaging, metadata launcher và tài liệu local.
Ngoài ra phải giữ cơ chế approval-wait của MCP: các lệnh `require_escalated` không
dùng timeout broker 90 giây thông thường, bị giới hạn bởi turn TTL khi có, và gửi
progress notification định kỳ khi client cung cấp `progressToken`.

## 5. Xử lý xung đột

Xem file xung đột:

```powershell
git status
git diff --name-only --diff-filter=U
git diff -- path/to/conflicted-file
```

Giữ mã upstream làm nền khi upstream có sửa UI/browser mới, sau đó áp lại riêng các thay đổi local cần thiết. Không chọn hàng loạt `--ours` hoặc `--theirs` cho toàn bộ repository.

Sau khi giải quyết từng file:

```powershell
git add path/to/resolved-file
```

Khi không còn xung đột:

```powershell
git diff --cached --check
git ls-files "README*.md"
```

Kiểm tra thứ hai phải không in ra file nào. Nếu có README được upstream thêm mới,
xóa nó khỏi index/working tree trước khi tiếp tục.

Nếu nhận ra merge không an toàn, quay lại đúng trạng thái trước merge:

```powershell
git merge --abort
```

Backup `$backup` vẫn giữ nguyên và có thể dùng để đối chiếu hoặc khôi phục.

## 6. Đồng bộ dependencies và kiểm thử

Dùng Bun đã cài trong PATH. Nếu không có, dùng Bun runtime đi kèm launcher:

```powershell
bun install --frozen-lockfile
bun run typecheck
bun test tests/user-wait-store.test.ts tests/zero-risk-mcp-lifecycle.test.ts tests/browser-worker-contract.test.ts tests/chatgpt-web-harness.test.ts
```

Fallback khi `bun` không nằm trong PATH:

```powershell
& ".\launcher\build\runtime\runtime\bun.exe" install --frozen-lockfile
& ".\launcher\build\runtime\runtime\bun.exe" run typecheck
& ".\launcher\build\runtime\runtime\bun.exe" test tests/user-wait-store.test.ts tests/zero-risk-mcp-lifecycle.test.ts tests/browser-worker-contract.test.ts tests/chatgpt-web-harness.test.ts
```

## 7. Commit merge

Chỉ commit sau khi kiểm thử đạt:

```powershell
git commit -m "Merge upstream vX.Y.Z"
git log --oneline --decorate -6
git merge-base --is-ancestor upstream/main master
```

Lệnh cuối phải trả về mã `0`, nghĩa là upstream đã là tổ tiên của `master`.

## 8. Publish lên repository của bạn

Thử push thông thường trước:

```powershell
git push origin master:master
```

Chỉ khi lệnh này bị từ chối do lịch sử đã diverge và bạn **đồng ý thay thế** `origin/master`, dùng force-with-lease. Lệnh này bảo vệ khỏi việc ghi đè một commit remote vừa xuất hiện:

```powershell
$remoteMaster = (git ls-remote origin refs/heads/master).Split()[0]
git push --force-with-lease="refs/heads/master:$remoteMaster" origin master:master
```

Xác minh publish:

```powershell
git ls-remote origin refs/heads/master
git rev-parse HEAD
git status --short --branch
```

Hai hash đầu phải giống nhau. Không force-push nhánh backup; chỉ publish `master` khi đã xác nhận rõ ràng.

## 9. Khôi phục sau một merge đã commit

Nếu merge đã commit nhưng chưa push và cần quay lại, xác nhận tên backup trước, rồi chạy:

```powershell
git branch --list "backup/pre-upstream-*"
git reset --hard backup/pre-upstream-YYYYMMDD-HHmmss
```

`git reset --hard` sẽ bỏ mọi thay đổi tracked chưa commit, vì vậy chỉ dùng khi đã kiểm tra và chấp nhận mất các thay đổi đó.
