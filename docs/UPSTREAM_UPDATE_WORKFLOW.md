# Cập nhật từ upstream và publish lên origin

Tài liệu này áp dụng cho repository hiện tại trên Windows PowerShell.

- Mã gốc: `https://github.com/miuuyy/codex-chatgpt-web.git` (`upstream`)
- Repository của bạn: `origin`
- Nhánh phát hành: `master`

Quy trình luôn tạo nhánh backup, hợp nhất upstream trước, kiểm thử, sau đó mới publish.

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
