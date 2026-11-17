# 송수신 프로토콜 v1

외부 서버 없이 교내망에서 송신기(Android 앱, 학생 노트북 ‘화면 보내기’)가 PC 수신 프로그램에 직접 접속한다.

## 1. PC 찾기

### QR 코드 (기본)

```
smirror://connect?h=<IP1>,<IP2>&p=<TLS 포트>&c=<6자리 코드>&f=<인증서 SHA-256 hex>&n=<PC 이름>
```

- `h`: PC의 IPv4 주소 목록. 송신 앱은 순서대로 접속을 시도한다.
- `f`: PC 인증서 지문. 송신 앱은 이 지문과 일치하는 인증서만 신뢰한다(가로채기 방지).

### 짧은 코드 입력 (같은 네트워크 대역 전용)

송신 앱이 UDP 47601 포트로 브로드캐스트한다.

```json
{"t":"disc","code":"123456"}
```

현재 코드가 일치하는 PC만 보낸 주소로 응답한다.

```json
{"t":"here","code":"123456","name":"3-1 교실","port":47600,"fp":"<sha256 hex>"}
```

VLAN이 다르면 브로드캐스트가 전달되지 않으므로 QR 코드를 사용한다. QR을 찍을 수 없는 학생 노트북은 PC 주소(`IP` 또는 `IP:포트`)를 직접 입력한다. 이때는 지문을 미리 알 수 없으므로 처음 연결한 인증서를 기억해 두고, 이후 같은 주소의 인증서가 바뀌면 연결하지 않는다.

## 2. 연결

- TCP 47600(사용 중이면 임의 포트, QR·탐색 응답에 실제 포트를 담음) + TLS 1.2 이상
- PC 인증서는 첫 실행 때 만든 자체 서명 인증서다. 신뢰는 지문 고정(pinning)으로만 한다.

## 3. 프레임 형식

모든 값은 빅엔디언이다.

| 필드 | 크기 | 설명 |
|---|---|---|
| type | 1 | 메시지 종류 |
| flags | 1 | 비트0 = 키프레임 |
| pts | 8 | 표시 시각(µs, 부호 있는 정수) |
| length | 4 | payload 길이(최대 8MB) |
| payload | length | |

| type | 방향 | payload |
|---|---|---|
| 1 HELLO | 송신기→PC | JSON `{proto, code, device, model, platform, android, audio, app}`. `platform`: `android`(없으면 이 값) 또는 `windows` |
| 2 ACCEPT | PC→송신기 | JSON `{mode}` |
| 3 REJECT | PC→송신기 | JSON `{reason}`: `rejected` `busy` `badcode` `expired` `locked` `version` `timeout` |
| 10 VIDEO_CONFIG | 송신기→PC | JSON `{w, h}` |
| 11 VIDEO | 송신기→PC | H.264 Annex-B. 키프레임 앞에는 SPS/PPS를 붙인다. |
| 20 AUDIO_CONFIG | 송신기→PC | JSON `{rate, channels, format:"s16le"}` |
| 21 AUDIO | 송신기→PC | PCM s16le 인터리브 |
| 30 CONTROL | 양방향 | JSON, 아래 표 |
| 31 PING / 32 PONG | 양방향 | pts에 보낸 시각 |

### CONTROL

| t | 방향 | 의미 |
|---|---|---|
| `bye` | 양방향 | 공유 종료. `reason`: `user` `consent_denied` `error` |
| `keyframe` | PC→송신기 | 키프레임 요청(디코더 오류·시작) |
| `mode` | PC→송신기 | `v`: `stable`(안정성 우선) `quality`(화질 우선) `grid`(3대 이상 분할 화면: 긴 변 960px, 최대 1.5Mbps) |
| `audio_mute` | PC→송신기 | `v`: `true`면 소리 전송을 멈춘다(교사가 끔, 또는 2대 이상이라 자동으로 끔). `false`면 다시 보낸다. 노트북은 멈춘 동안 자기 스피커로 소리를 낸다. |
| `audio` | 송신기→PC | `v`: `on` `off`(사용자가 끔) `unsupported`(Android 9 이하·캡처 실패) `denied`(권한 거부) |

## 4. 순서

```
송신기                     PC
 ── TLS 연결 ──────────────▶
 ── HELLO ─────────────────▶  코드 검사 → 교사 승인 창
 ◀──────────────── ACCEPT ──  (거절 시 REJECT 후 연결 종료)
 화면 캡처 시작(휴대전화는 OS 동의 필요)
 ── VIDEO_CONFIG, AUDIO_CONFIG, VIDEO(키프레임)… ▶
 ◀──────────── CONTROL bye ── 또는 송신기가 bye
```

- 승인 대기 60초, 동의 대기 90초를 넘기면 PC가 연결을 끊는다.
- PING은 2초마다 보내고 10초 동안 아무 데이터도 없으면 끊긴 것으로 본다.
- 한 PC에 최대 6대까지 동시에 연결한다. 코드는 빈자리가 있는 동안 여러 기기가 함께 쓰고 5분마다 바뀐다. 기기마다 교사 승인이 필요하다.
- 같은 IP에서 코드를 5번 틀리면 60초 동안 거부한다(`locked`).
- 이미 6대(요청 대기 포함)가 연결되어 있으면 `busy`로 거부하고 PC에 알린다. 이때는 UDP 탐색에도 응답하지 않는다.
