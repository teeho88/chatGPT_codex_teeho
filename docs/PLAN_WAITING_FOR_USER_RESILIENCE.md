# Kế hoạch nâng cấp: turn chờ người dùng không làm rớt stream

## 1. Mục tiêu

Loại bỏ lỗi kiểu:

`stream disconnected before completion: ChatGPT stopped responding after the task started. Check the ChatGPT tab before continuing.`

khi turn vẫn hợp lệ nhưng Codex đang chờ người dùng:

- approve một tool/action;
- trả lời `request_user_input` hoặc một quyết định tương tác;
- hoàn tất một bước thủ công trong Launcher/ChatGPT;
- quay lại sau thời gian dài, có thể từ vài phút tới nhiều giờ/ngày.

Thiết kế mới phải phân biệt rõ ba khái niệm:

1. **Model progress**: ChatGPT/Codex đang thực sự tạo reasoning, text, tool call hoặc tool result.
2. **Runtime liveness**: browser helper, daemon, launcher và broker vẫn sống và còn sở hữu turn.
3. **User wait**: turn cố ý tạm dừng vì cần input/approval từ người dùng.

`upstream_stall_timeout` chỉ được dùng để phát hiện runtime/model thực sự bị treo. Thời gian ở trạng thái `waiting_for_user` không được tính vào progress stall budget.

## 2. Hiện trạng cần giữ

Các cơ chế hiện tại đã đúng và nên được tái sử dụng:

- `src/bridge.ts` đã phát `response.heartbeat` xuống Codex trong lúc upstream im lặng.
- `src/stall-timeout.ts` có watchdog riêng cho upstream silence, mặc định 300 giây.
- `src/adapters/chatgpt-web/browser-worker.ts` phát heartbeat định kỳ trong vòng quan sát browser.
- `src/adapters/chatgpt-web/turn-progress.ts` đã theo dõi tool batch, tool result, active tool calls và timestamp progress.
- `src/adapters/chatgpt-web/turn-broker.ts` đã có lifecycle turn và cơ chế chờ bằng `AbortSignal`.
- Launcher đã có turn heartbeat/lease và xử lý suspension của process/máy.

Không thay `response.heartbeat` bằng wait-state mới. Hai cơ chế phục vụ mục đích khác nhau:

- heartbeat chứng minh transport/runtime còn sống;
- wait-state chứng minh việc thiếu progress là hợp lệ.

## 3. Kiến trúc mục tiêu

### 3.1. State machine

Chuẩn hóa lifecycle logic ở mức turn:

```text
starting
   |
   v
running
   |  user decision / approval required
   v
waiting_for_user
   |  answer / approval received
   v
running
   |
   +--------------------+
   |                    |
   v                    v
completed            failed/cancelled
```

Các transition bắt buộc:

- `running -> waiting_for_user`: chỉ khi có một wait request có identity cụ thể.
- `waiting_for_user -> running`: khi đúng wait request được resolve.
- `waiting_for_user -> cancelled`: khi người dùng/hệ thống hủy.
- `waiting_for_user -> failed`: khi owner/runtime chết hoặc state không thể phục hồi.
- một wait cũ/replayed không được resume turn mới hơn.

### 3.2. Identity của wait

Mỗi lần cần người dùng phải có:

```ts
interface TurnUserWait {
  waitId: string;
  kind: "approval" | "user_input" | "manual_step";
  enteredAt: number;
  ownerTurnId: string;
  toolCallId?: string;
  requestId?: string;
}
```

`waitId` là idempotency key. Resume/deny/cancel luôn kiểm tra `waitId` và owner trước khi thay đổi state.

Không dùng text của câu hỏi hoặc label của button làm identity.

### 3.3. Hai watchdog độc lập

Sau nâng cấp phải có hai timer:

**Progress watchdog**

- áp dụng khi state là `running`;
- reset bởi AdapterEvent/progress thật;
- hết hạn -> `upstream_stall_timeout`.

**Liveness watchdog**

- áp dụng cả `running` và `waiting_for_user`;
- reset bởi heartbeat của helper/launcher/broker owner;
- hết hạn -> lỗi runtime/owner cụ thể;
- không reset progress timestamp.

Khi chuyển `waiting_for_user -> running`, progress baseline phải được reset về thời điểm resume để tránh timeout ngay lập tức vì timestamp cũ.

## 4. Protocol/event thay đổi

### 4.1. AdapterEvent

Mở rộng internal adapter event union bằng các event control:

```ts
{ type: "user_wait_started"; wait: TurnUserWait }
{ type: "user_wait_resumed"; waitId: string; resumedAt: number }
{ type: "heartbeat" }
```

Nếu kiến trúc hiện tại cần deny/cancel phân biệt:

```ts
{ type: "user_wait_ended"; waitId: string; outcome: "resumed" | "denied" | "cancelled" }
```

Ưu tiên một event `user_wait_ended` nếu giúp state machine đơn giản hơn.

Các control event này là internal transport metadata. Không biến chúng thành assistant text, reasoning text hoặc output item hiển thị cho người dùng.

### 4.2. Bridge

`src/bridge.ts` cần có state nội bộ:

```ts
let waitState: TurnUserWait | undefined;
let progressBaselineAt = now();
let lastLivenessAt = now();
```

Quy tắc:

- AdapterEvent bình thường cập nhật progress + liveness.
- `heartbeat` chỉ cập nhật liveness.
- `user_wait_started` xác lập wait state, không đóng Responses stream.
- trong `waiting_for_user`, bỏ qua progress stall calculation.
- `user_wait_ended/resumed` xóa wait state và reset progress baseline.
- wait event không được emit thành unknown public Responses event trừ khi Codex protocol thực sự cần nó.
- downstream `response.heartbeat` vẫn tiếp tục đều đặn để Codex HTTP/SSE idle timer không kích hoạt.

### 4.3. Không dùng một timeout rất lớn để thay state machine

Không giải quyết bằng cách chỉ tăng:

`DEFAULT_STALL_TIMEOUT_SEC = 300`

lên hàng giờ. Cách này làm chậm phát hiện hung upstream và vẫn không hỗ trợ wait nhiều ngày.

`stallTimeoutSec` tiếp tục là timeout cho trạng thái `running`.

## 5. Nguồn phát hiện user wait

### 5.1. Codex approval / local tool action

Điểm lý tưởng để phát `waiting_for_user` là nơi đã biết một tool invocation đang bị chặn vì user approval, thay vì suy đoán từ việc tool chạy lâu.

Yêu cầu:

- tool chạy lâu tự nhiên vẫn là `running`;
- tool chờ approval mới là `waiting_for_user`;
- approval resolve thì resume đúng `toolCallId/waitId`.

Nếu outer Codex API chưa expose wait-state trực tiếp, triển khai theo hai bước:

1. trước mắt giữ liveness bằng broker/helper heartbeat trong toàn bộ thời gian tool result chưa quay lại;
2. bổ sung protocol signal explicit khi outer runtime có hook approval/input.

Không suy ra `waiting_for_user` chỉ từ `activeToolCalls > 0`.

### 5.2. `request_user_input`

`request_user_input` phải được map vào `kind: "user_input"`.

Wait record cần giữ tối thiểu:

- call/request id;
- native turn/thread identity nếu có;
- prompt metadata đủ để kiểm tra resume;
- entered timestamp;
- owner/session identity.

### 5.3. Manual/Zero Risk flow

Các trạng thái `awaiting_start`/manual confirmation hiện có nên được map rõ sang user-wait semantics thay vì chỉ dựa vào deadline.

Không thay đổi deadline ngắn dành cho thao tác có UX bắt buộc, ví dụ submit confirmation, nếu deadline đó là một business rule. Chỉ tránh để bridge hiểu nhầm khoảng chờ hợp lệ là upstream stall.

## 6. Nâng cấp turn-progress

File chính: `src/adapters/chatgpt-web/turn-progress.ts`.

Mở rộng snapshot bằng wait/liveness state, ví dụ:

```ts
interface ChatGptExternalTurnProgressSnapshot {
  revision: number;
  lastToolBatchRevision: number;
  activeToolCalls: number;
  lastProgressAt?: number;
  phase: "running" | "waiting_for_user";
  wait?: TurnUserWait;
  lastLivenessAt?: number;
}
```

Quy tắc revision:

- enter wait -> tăng revision;
- resume/deny/cancel -> tăng revision;
- heartbeat không nhất thiết tăng semantic revision; có thể có `lastLivenessAt` riêng;
- stale frame không được rollback phase hoặc wait identity;
- mirror process phải reject transition không hợp lệ.

Tách helper hiện tại kiểu `chatGptExternalProgressIsLive(...)` thành hai câu hỏi:

```ts
isRuntimeLive(snapshot, now, livenessGraceMs)
isProgressExpected(snapshot)
```

Không dùng một boolean `live` cho cả hai ý nghĩa.

## 7. Nâng cấp turn-broker

File chính: `src/adapters/chatgpt-web/turn-broker.ts`.

Mở rộng lifecycle hiện tại để broker có thể biểu diễn wait:

```ts
type SafeTurnState =
  | "awaiting_start"
  | "running"
  | "waiting_for_user"
  | "completed"
  | "revoked";
```

Hoặc, nếu `SafeTurnState` chỉ dành cho Zero Risk, giữ type đó và thêm một lifecycle chung độc lập. Ưu tiên phương án không làm semantics của Zero Risk trở nên nhập nhằng.

Broker cần API idempotent:

```ts
beginUserWait(token, wait): void
resumeUserWait(token, waitId): void
cancelUserWait(token, waitId, reason): void
snapshotUserWait(token): TurnUserWait | undefined
```

Mọi method phải:

- validate token owner;
- validate wait identity;
- reject stale resume;
- wake waiter liên quan;
- không mất outstanding tool invocation.

## 8. Nâng cấp browser helper/worker

Các file chính:

- `src/adapters/chatgpt-web/browser-worker.ts`;
- `src/adapters/chatgpt-web/browser-helper-main.ts`.

### 8.1. Heartbeat không được phụ thuộc vòng DOM polling

Hiện worker có heartbeat trong vòng quan sát browser. Chuyển thành heartbeat owner độc lập hoặc đảm bảo mọi blocking wait path đều tiếp tục heartbeat.

Đặc biệt kiểm tra:

- tool confirmation wait;
- broker tool-result wait;
- manual start/completion wait;
- DOM recovery/rebind;
- compaction handoff;
- launcher reconnect.

Không để một `await` dài ngăn heartbeat chạy.

### 8.2. Helper protocol

Helper process phải forward:

- heartbeat;
- wait started;
- wait ended/resumed;
- terminal outcome.

Order guarantee:

```text
tool call observed
-> wait_started
-> zero or more heartbeat
-> wait_ended
-> tool result / next progress
```

Nếu helper reconnect, snapshot đầu tiên phải đủ để tái tạo phase hiện tại mà không cần replay toàn lịch sử event.

## 9. Suspend/resume cho wait hàng giờ hoặc hàng ngày

Heartbeat + paused stall giải quyết wait ngắn/trung bình nhưng không nên giữ một HTTP/SSE request vô hạn.

Thêm ngưỡng `LONG_USER_WAIT_SUSPEND_MS`, ví dụ 5-15 phút, dưới dạng internal policy/config có test deterministic.

Khi một user wait vượt ngưỡng:

1. checkpoint durable state;
2. đóng transport/browser resources có thể đóng an toàn;
3. giữ task ở trạng thái `suspended_waiting_user`;
4. không đánh dấu turn failed;
5. khi người dùng phản hồi, restore state và tạo transport/browser turn mới nếu cần;
6. đưa answer/tool decision vào đúng call identity;
7. tiếp tục từ canonical Codex history.

### 9.1. Durable record tối thiểu

```ts
interface SuspendedUserWaitRecord {
  version: 1;
  taskId: string;
  nativeThreadId?: string;
  nativeTurnId?: string;
  conversationKey?: string;
  wait: TurnUserWait;
  outstandingToolCallIds: string[];
  suspendedAt: number;
}
```

Không persist:

- raw secret token;
- bearer token;
- connector credentials;
- ephemeral browser handle;
- object không serialize được.

### 9.2. Resume contract

Resume phải idempotent:

- cùng `waitId` chỉ resolve một lần;
- duplicate answer trả kết quả đã commit hoặc no-op an toàn;
- answer cho wait đã cancelled/superseded bị reject rõ ràng;
- process restart giữa answer và commit không được thực thi tool/action hai lần.

## 10. Recovery sau process restart

Khi daemon/launcher khởi động:

1. load suspended wait records;
2. validate schema/version;
3. đối chiếu task/thread ownership;
4. mark record không hợp lệ là recovery error có thể chẩn đoán;
5. không tự động approve hoặc tự chọn câu trả lời;
6. chờ user response hoặc cancellation;
7. resume bằng canonical history thay vì cố tái sử dụng stale browser object.

Running turn chưa checkpoint không được giả vờ resume như user-wait.

## 11. File-by-file implementation plan

### Phase A - Protocol và state primitives

**`src/adapters/types.ts` hoặc file đang định nghĩa `AdapterEvent`**

- thêm control event cho user wait;
- thêm `TurnUserWait`;
- exhaustive switch phải compile-fail khi thiếu case.

**`src/adapters/chatgpt-web/turn-progress.ts`**

- thêm phase/wait/liveness snapshot;
- validate monotonic transition;
- tách runtime liveness khỏi model progress.

**Tests**

- unit test valid transitions;
- stale resume;
- duplicate resume;
- invalid owner/wait id;
- heartbeat không được tính là semantic progress.

### Phase B - Bridge semantics

**`src/bridge.ts`**

- track wait phase;
- pause progress watchdog khi waiting;
- giữ downstream heartbeat;
- reset progress baseline khi resume;
- emit terminal lỗi riêng khi liveness thực sự chết.

**`src/stall-timeout.ts`**

- giữ stall timeout cho running;
- nếu cần, thêm liveness timeout resolver riêng thay vì tái sử dụng stall timeout.

**`tests/bridge-stall-timeout.test.ts`**

Thêm deterministic cases:

1. running + silence > stall -> incomplete;
2. waiting + heartbeat > 10x stall -> không incomplete;
3. waiting + mất liveness -> fail;
4. resume sau wait dài -> không timeout ngay;
5. resume rồi tiếp tục silence > stall -> timeout bình thường;
6. duplicate/stale wait events -> fail closed.

### Phase C - Browser/helper propagation

**`src/adapters/chatgpt-web/browser-worker.ts`**

- heartbeat độc lập với DOM wait;
- phát wait transition từ nguồn explicit;
- bỏ các implicit assumptions coi thiếu DOM progress là chết trong khi phase đang waiting;
- vẫn giữ cancellation/abort responsive.

**`src/adapters/chatgpt-web/browser-helper-main.ts`**

- forward wait/liveness protocol;
- snapshot phase sau reconnect;
- đảm bảo event ordering.

**`tests/browser-worker-contract.test.ts`**

- approval chờ lâu;
- tool result chờ lâu;
- heartbeat tiếp tục trong blocking path;
- resume khôi phục completion tracking.

### Phase D - Broker và turn execution

**`src/adapters/chatgpt-web/turn-broker.ts`**

- APIs begin/resume/cancel wait;
- identity/idempotency;
- pending waiter wake-up;
- không retire capability trong khi wait còn hợp lệ.

**`src/adapters/chatgpt-web/turn-execution.ts`**

- giữ session/capability ownership đúng trong waiting;
- retirement chỉ xảy ra khi terminal/superseded/cancelled hoặc suspend đã checkpoint xong;
- resume không tạo duplicate outstanding call.

**Tests**

- broker lifecycle;
- disconnect/reconnect trong waiting;
- delayed result;
- supersede trong waiting;
- cancellation;
- capability retirement ordering.

### Phase E - Launcher liveness

Các file:

- `src/launcher-browser-host.ts`;
- `launcher/electron/browser-host.cjs`;
- `launcher/electron/control-server.cjs`;
- `launcher/electron/turn-suspension.cjs`.

Việc cần làm:

- phase-aware heartbeat/lease;
- launcher sleep/wake re-baseline không biến waiting thành expired;
- helper chết thật vẫn reclaim tab;
- machine suspend không cộng thời gian sleep vào timeout;
- diagnostics ghi phase + wait age.

### Phase F - Durable suspend/resume

Tạo module riêng, ví dụ:

`src/adapters/chatgpt-web/user-wait-store.ts`

Trách nhiệm:

- versioned serialization;
- atomic write/replace;
- load/recover;
- delete only after resume commit;
- prune terminal/orphan record theo policy;
- không lưu secret.

Tích hợp vào turn execution/broker và lifecycle startup/shutdown.

Tests phải dùng temp directory và simulated restart.

### Phase G - Documentation/config

**`docs/architecture.md`**

- thêm user-wait lifecycle;
- giải thích progress vs liveness;
- mô tả long-wait suspend/resume.

**Config**

Chỉ expose config nếu người dùng có lý do thực tế phải chỉnh. Các default an toàn nên nằm internal:

- liveness heartbeat interval;
- liveness timeout;
- long wait suspend threshold.

Không biến mọi timer thành public knob.

## 12. Error model

Thay lỗi chung bằng reason có thể chẩn đoán:

- `upstream_stall_timeout`: running nhưng không có progress;
- `runtime_liveness_timeout`: helper/owner mất heartbeat;
- `user_wait_superseded`: wait bị instruction/turn mới thay thế;
- `user_wait_resume_mismatch`: response không thuộc wait hiện tại;
- `user_wait_recovery_failed`: record tồn tại nhưng không thể restore an toàn.

Message hiển thị phải nói rõ user action nếu có, nhưng không yêu cầu “check ChatGPT tab” cho lỗi thuần local lifecycle nếu tab không liên quan.

## 13. Observability

Thêm structured log, không log prompt/user answer/secret:

```text
turn_wait_started traceId=... waitIdHash=... kind=...
turn_wait_heartbeat traceId=... waitAgeMs=...
turn_wait_resumed traceId=... waitAgeMs=...
turn_wait_suspended traceId=...
turn_wait_restored traceId=...
runtime_liveness_timeout traceId=... phase=...
```

Metric nên có:

- số wait theo kind;
- wait duration histogram;
- suspend/resume success/failure;
- stall timeout theo phase;
- liveness timeout;
- duplicate/stale resume count.

Không ghi raw `waitId`, tool arguments hoặc answer nếu các giá trị đó có thể chứa dữ liệu nhạy cảm.

## 14. Backward compatibility

Migration phải cho phép daemon/launcher/helper lệch version ngắn hạn theo fail-safe:

- unknown wait-control frame -> version/protocol error rõ ràng, không âm thầm coi là progress;
- persisted records có `version`;
- version cũ không có wait-state tiếp tục dùng semantics hiện tại;
- không thay public connector identity chỉ vì internal lifecycle extension, trừ khi wire ABI public thực sự thay đổi.

## 15. Test strategy

### Unit

- state reducer;
- timeout accounting;
- wait identity;
- persistence codec;
- duplicate/replay handling.

### Integration

- bridge + fake adapter;
- broker + turn execution;
- browser helper protocol;
- launcher heartbeat/lease;
- restart recovery.

### Time tests

Dùng fake clock/injected `now()`. Không tạo test thật phải sleep hàng phút.

Case tối thiểu:

```text
T0 running
T1 wait_started
T1 + 24h heartbeat remains valid
T2 resume
T2 + epsilon progress accepted
T3 completed
```

và:

```text
T0 running
T1 wait_started
T1 + livenessTimeout + epsilon no heartbeat
=> runtime_liveness_timeout
```

### Regression

Phải giữ pass:

- normal browser turn;
- tool calls không cần approval;
- long-running tool không phải user wait;
- compaction;
- Zero Risk manual flow;
- cancellation;
- daemon drain;
- launcher sleep/wake;
- multi-turn retained conversation.

## 16. Rollout theo milestone

### Milestone 1 - Chống false stall ngắn hạn

- state/event primitives;
- bridge pause/resume stall;
- heartbeat không bị block;
- focused tests.

Kết quả: approval/user input vài phút không làm rớt stream.

### Milestone 2 - End-to-end explicit user wait

- broker/execution wait APIs;
- browser/helper propagation;
- diagnostics;
- launcher phase awareness.

Kết quả: toàn pipeline biết turn đang chờ user, không cần heuristic.

### Milestone 3 - Durable long wait

- persistent wait store;
- suspend;
- process restart recovery;
- idempotent resume.

Kết quả: user có thể quay lại sau nhiều giờ/ngày mà không cần giữ SSE/browser turn sống liên tục.

### Milestone 4 - Hardening

- fault injection;
- replay/duplicate tests;
- shutdown/drain race;
- suspend/resume race;
- documentation và migration checks.

## 17. Acceptance criteria

Nâng cấp được coi là hoàn thành khi tất cả điều kiện sau đúng:

1. Một turn ở `running` vẫn bị `upstream_stall_timeout` khi adapter thực sự im lặng quá budget.
2. Một turn ở `waiting_for_user` không bị progress stall dù thời gian chờ lớn hơn nhiều lần stall budget.
3. Mất heartbeat runtime trong `waiting_for_user` vẫn được phát hiện trong liveness budget.
4. Resume sau wait dài không timeout ngay và tiếp tục đúng tool/request đang chờ.
5. Duplicate/stale resume không thực thi action lần hai.
6. Cancellation/supersede trong wait giải phóng capability/tab/broker resources đúng thứ tự.
7. Restart giữa wait có thể restore từ durable record hoặc fail rõ ràng mà không tự approve.
8. Existing bridge/browser/broker/launcher regression tests vẫn pass.
9. Không cần tăng stall timeout lên hàng giờ để đạt các điều kiện trên.
10. Logs đủ xác định turn chết vì progress stall, liveness loss, cancellation hay recovery failure.

## 18. Thứ tự triển khai khuyến nghị

Thứ tự commit nên giữ mỗi thay đổi reviewable:

1. `TurnUserWait` + state reducer + tests.
2. Bridge pause/resume progress watchdog + tests.
3. Turn-progress phase/liveness split + tests.
4. Browser/helper heartbeat độc lập + wait propagation.
5. Broker/execution idempotent wait lifecycle.
6. Launcher phase-aware lease/suspend behavior.
7. Durable wait store + restart tests.
8. Architecture docs + diagnostics cleanup.

Không triển khai durable persistence trước khi state machine và idempotency contract ổn định, vì persistence sẽ khóa schema và làm migration phức tạp hơn.
