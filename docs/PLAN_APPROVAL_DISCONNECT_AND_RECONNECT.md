# Kế hoạch xử lý disconnect khi chờ approval và không reconnect sau gián đoạn

## Phạm vi và kết luận hiện tại

Hai triệu chứng cần được đo riêng: (1) tool call đang chờ approval bị ngắt dù người dùng chưa trả lời; (2) sau khi mạng, tunnel, helper hoặc máy gián đoạn tạm thời, đường truyền trở lại nhưng turn cũ không tiếp tục. Đây là **giả thuyết từ mã nguồn**, chưa phải kết luận nguyên nhân của một lần lỗi cụ thể vì chưa có trace/log tái hiện cùng thời điểm.

Các bản sửa trước giải quyết từng lớp riêng lẻ: `429fcca` bỏ giới hạn broker 90 giây và gửi MCP progress cho approval đã nhận diện; `da1ab42` tiếp tục retry tunnel sau cooldown; `45333ec` khởi động lại tunnel khi resume/unlock. Chúng không tạo một giao thức resume cho MCP invocation và native turn đang dở. Tăng timeout hoặc khởi động lại tunnel đơn thuần sẽ không phục hồi request đã bị hủy.

## Bằng chứng và khoảng hở trong mã hiện tại

| Lớp | Đã có | Khoảng hở cần kiểm chứng |
| --- | --- | --- |
| MCP server | `mcp-server.ts` coi `sandbox_permissions=require_escalated` là approval, dùng TTL còn lại hoặc chờ vô hạn, gửi progress mỗi 30 giây nếu có `progressToken`. | Approval ở tool khác, hoặc invocation đi qua gateway mà không mang cờ này, vẫn chịu timeout 90 giây. Không có `progressToken` thì không có MCP progress; chưa chứng minh client xem notification đó là keepalive. |
| MCP ↔ broker | `callTurnBroker` giữ socket chờ result; `invoke` bắt lỗi/abort rồi gọi `release` để thu hồi binding. | Một đứt kết nối thoáng qua có thể biến thành abort và thu hồi toàn turn. Request gọi lại thiếu invocation ID bền vững để hỏi kết quả cũ; retry mù có thể chạy action hai lần. |
| Adapter ↔ Responses | Adapter phát heartbeat mỗi 10 giây; bridge phát SSE heartbeat và tính stall 300 giây từ adapter event cuối. | Heartbeat chỉ có tác dụng khi iterator và process còn sống. Turn chưa có trạng thái `waiting_for_user` tường minh; mất heartbeat vì transport/owner được báo như stall chung. |
| Broker/turn | Broker có replay tool batch theo call ID khi observer nối lại đúng turn. | Replay phụ thuộc channel còn sống. TTL tùy cấu hình vẫn hết hạn theo thời gian thực; `turn-progress.ts` chỉ biết revision/progress/active calls, chưa biết wait phase và owner liveness riêng. |
| Launcher/tunnel | Có health monitor, retry sau cooldown và wake recovery. Browser tab có heartbeat lease 60 giây. | Recovery tunnel khôi phục khả dụng cho request mới, không chứng minh request đang chờ được gắn lại. Việc force restart trong lúc wait có thể cắt transport cũ; cần trace để xác nhận. |
| Lưu trạng thái | `UserWaitStore` có record bền vững cho bước `waitSent` của Zero Risk. | Approval native thông thường chưa lưu pending invocation/result/decision; không thể dựa vào store này để resume sau process restart. |

Tài liệu `PLAN_WAITING_FOR_USER_RESILIENCE.md` đã đề xuất state machine tổng quát. Kế hoạch này ưu tiên **xác định điểm đứt thực tế và khôi phục invocation có identity**, rồi mới mở rộng sang suspend/resume dài hạn.

## P0 — Thu thập bằng chứng trước khi sửa tiếp

1. Gắn `traceId`, native turn ID, broker binding ID hash, invocation ID, MCP request ID và tunnel generation vào log cấu trúc ở các biên: Responses mở/đóng, adapter heartbeat, MCP invoke/progress/abort, broker enqueue/deliver/settle/revoke, launcher tunnel monitor/restart, browser helper lease. Chỉ log ID dạng hash, trạng thái, thời điểm và reason; không log lệnh, token, prompt hay câu trả lời approval.
2. Với mỗi disconnect ghi **bên nào đóng trước**: Codex MCP client, stdio/tunnel, MCP server, broker socket, adapter iterator, Responses SSE, browser helper hay launcher. Ghi error code, deadline đang chạy, tuổi turn, tuổi wait và lần heartbeat cuối của từng lớp.
3. Tái hiện có kiểm soát bốn ca: approval `require_escalated` quá 90 giây; approval vượt turn TTL; rớt tunnel 5–30 giây trong lúc approval; sleep/unlock hoặc tắt mạng tạm thời trong lúc tool đang chờ. Thêm ca tool không cần approval nhưng chạy lâu để tránh phân loại sai.
4. Với cùng trace, xác nhận `progressToken` có/không, progress notification có tới client, MCP signal có abort, broker binding có bị `release/revoke`, và exact reconnect có còn cùng turn/call ID. Lập timeline mili giây. Nếu không tái hiện, lấy một bộ log lỗi thực tế đã được ẩn dữ liệu rồi mới chọn nhánh sửa.

**Cổng quyết định:** nếu SSE mất trước MCP, sửa transport/bridge trước; nếu MCP abort trước, sửa deadline/abort semantics; nếu broker/channel mất trước, sửa ownership và persistence; nếu tunnel đã ready nhưng invocation không tiếp tục, sửa resume protocol. Không gộp các lỗi vào một nhãn “disconnect”.

## P1 — Giữ approval sống qua các timeout hợp lệ

1. Biểu diễn wait tường minh bằng `waitId`, `kind`, `ownerTurnId`, `invocationId`, `enteredAt`; phát `wait_started` tại nơi **native runtime xác nhận đang yêu cầu user decision**, không suy đoán từ tên tool hay `activeToolCalls > 0`. Nếu runtime không cung cấp tín hiệu này, hỗ trợ trước đường `require_escalated` và ghi rõ những approval loại khác chưa được bảo đảm.
2. Tách ba deadline: thời gian thực thi tool bình thường; thời gian chờ user; owner liveness. Tạm dừng progress watchdog khi `waiting_for_user`, nhưng vẫn kiểm tra owner heartbeat. Khi resume, đặt lại progress baseline. TTL của broker phải tuân theo wait state hoặc được gia hạn có kiểm soát, không hết hạn lặng lẽ khi user đang quyết định.
3. Duy trì heartbeat độc lập ở adapter/MCP/tunnel; đo xem client có nhận được. Nếu client có hard deadline không thể thay đổi, không giữ cùng MCP request vô hạn: checkpoint wait và chuyển sang cơ chế reattach được xác định ở P2.
4. Trên abort, phân biệt user cancel/supersede với mất transport có thể phục hồi. Chỉ thu hồi binding ngay cho terminal cancellation. Một disconnect tạm thời giữ invocation trong grace window hữu hạn và có trạng thái quan sát được.

## P2 — Reconnect đúng invocation, không chạy lại action

1. Broker lưu trạng thái invocation theo `(ownerTurnId, invocationId)` với các bước `queued → delivered → waiting_for_user → executing → settled/failed/cancelled`. Mỗi transition kiểm tra owner và revision; result được giữ đủ lâu để reconnect đọc lại. Duplicate request trả cùng trạng thái/result, không gọi native tool lần hai.
2. Client nối lại gửi `turnId`, `invocationId`, generation và cursor cuối đã nhận; server trả snapshot + các event/result còn thiếu. Generation cũ không được ghi đè generation mới. Nếu process đã restart mà không có checkpoint đáng tin, trả lỗi phục hồi cụ thể và không tự chạy lại lệnh.
3. Áp dụng nguyên tắc “at most once dispatch” cho action có tác dụng phụ. Khi mất liên lạc ở điểm không biết action đã chạy hay chưa, trả `outcome_unknown` để người dùng/outer runtime kiểm tra trạng thái thực tế; không retry tự động. Với tác vụ đọc/idempotent đã chứng minh, có thể retry có giới hạn.
4. Launcher sau recovery kiểm tra riêng: tunnel health, MCP handshake, broker reachable, binding/turn còn tồn tại, helper owner sống, cursor có thể replay. `ready` chỉ nghĩa là transport nhận request mới; UI/diagnostics phải phản ánh rõ `turn recovered`, `turn cancelled`, hoặc `outcome unknown`.
5. Sau khi contract P2 ổn định, mở rộng `UserWaitStore` cho approval native: ghi record phiên bản hóa, atomic, chỉ chứa identity và trạng thái an toàn; restore khi khởi động lại; xóa sau khi kết quả đã được client xác nhận. Không lưu secret hay browser handle.

## P3 — Kiểm thử và tiêu chí nghiệm thu

- Unit với fake clock: normal tool vẫn timeout đúng hạn; approval chờ lâu hơn 90 giây và stall budget không bị cắt; mất owner heartbeat báo lỗi liveness; resume reset progress baseline; TTL không hết khi wait hợp lệ.
- Integration với fault injection ở từng hop (MCP stdio, broker socket, tunnel, SSE, helper): ngắt 5–30 giây rồi nối lại cùng invocation; approval/deny chỉ thực hiện một lần; result replay đúng ID và thứ tự; stale generation bị từ chối; cancel/supersede dọn tài nguyên.
- Test restart ở `queued`, `waiting_for_user`, trước dispatch, sau dispatch nhưng trước ACK, và sau settle. Trạng thái không chắc chắn phải thành `outcome_unknown`, không thành success giả hoặc chạy lệnh lần hai.
- Chạy regression tập trung: `tests/chatgpt-web-harness.test.ts`, `tests/turn-broker-lifecycle.test.ts`, `tests/bridge-stall-timeout.test.ts`, `tests/user-wait-store.test.ts`, launcher runtime supervisor/browser host; sau đó typecheck và suite liên quan. Dùng fake clock, không test bằng cách sleep nhiều phút.
- Kiểm thử bản **đã cài đặt**: xác nhận artifact chứa thay đổi, tái hiện approval dài và tắt/bật mạng hoặc lock/unlock, đối chiếu log theo cùng trace. Pass khi turn tiếp tục đúng một invocation và trả kết quả; fail có reason cụ thể nếu outer runtime không hỗ trợ reattach.

## Thứ tự triển khai và điều kiện dừng

1. Commit diagnostics + ca tái hiện, chốt nguyên nhân ưu tiên từ timeline.
2. Commit wait state/deadline/abort semantics; kiểm chứng approval dài khi transport không đứt.
3. Commit invocation identity, snapshot/replay và reconnect grace; kiểm chứng mất kết nối ngắn.
4. Commit checkpoint/restart recovery và launcher health phân tầng; kiểm chứng bản cài đặt.

Không kết luận “đã sửa” chỉ vì tunnel trở lại `ready` hoặc heartbeat tiếp tục. Hoàn thành khi các ca nghiệm thu trên chạy qua và một lỗi thực tế có thể được quy về đúng lớp bằng log mà không mất hoặc nhân đôi tool result.
