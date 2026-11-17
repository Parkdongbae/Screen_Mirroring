# 교실 전자칠판용 화면 미러링 (MVP)

Android 휴대전화와 학생용 Windows 11 노트북의 화면과 소리를 교실 Windows PC로 보내, PC에 HDMI로 연결된 전자칠판에 표시한다. 외부 서버 없이 학교 네트워크 안에서만 동작한다. 요구사항은 [PRD.txt](PRD.txt), 통신 규격은 [docs/protocol.md](docs/protocol.md)를 본다.

| 폴더 | 내용 | 기술 |
|---|---|---|
| `receiver/` | Windows 프로그램 두 가지: 교실 PC 수신기(접속 서버 내장, `src/main.js`)와 학생 노트북 ‘화면 보내기’(`src/sender/`) | Electron 44, WebCodecs H.264 인코딩·디코딩, AudioWorklet, 시스템 소리 루프백 |
| `android/` | Android 송신 앱 | Java, MediaProjection + MediaCodec H.264, AudioPlaybackCapture(PCM) |
| `docs/` | 프로토콜 문서 | TLS(인증서 지문 고정) + 자체 프레임 형식 |

## 내려받기

[릴리즈 목록](https://github.com/Parkdongbae/Screen_Mirroring/releases)에서 내려받는다. 현재 **v0.3.0 시험판**이며 실제 휴대전화·노트북 여러 대로는 아직 시험하지 않았다.

| 파일 | 용도 |
|---|---|
| `ScreenMirrorReceiver-Setup-0.3.0.exe` | 교실 PC(Windows 11) 수신기. 관리자 권한으로 설치하며, 설치 시 Windows 방화벽 허용 규칙(도메인·사설 네트워크)을 자동 추가한다. |
| `ScreenMirrorSender-Setup-0.3.0.exe` | 학생 노트북(Windows 11)용 ‘화면 보내기’. 관리자 권한 없이 설치된다. |
| `ScreenMirror-Android-0.3.0-debug.apk` | Android 8.0 이상 송신 앱(디버그 서명). 소리 전송은 Android 10 이상. |
| `SHA256SUMS.txt` | 파일 변조 확인용 해시 |

직접 빌드하면 PC 설치 파일 두 개는 `receiver/dist/`, APK는 `android/app/build/outputs/apk/debug/`에 생긴다(아래 ‘개발’ 참고).

## 교실에서 쓰는 법

1. 교실 PC에서 **화면 미러링 수신기**를 실행한다. QR 코드와 6자리 코드가 표시된다.
2. 휴대전화를 학교 Wi-Fi에 연결하고 **화면 미러링** 앱에서 QR 코드를 스캔한다(기본 카메라로 찍어도 앱이 열린다). 같은 네트워크 대역이면 6자리 코드 입력도 된다.
3. PC 화면의 **허용**을 누른다.
4. 휴대전화에 나오는 화면 공유 안내에서 **지금 시작**을 누른다.
5. PC에서 **전체 화면**을 누른다. 확장 모니터 구성이면 **설정 → 출력 모니터**에서 전자칠판을 고른다. 소리는 **설정 → 소리 출력 장치**에서 바꾼다.

### 학생 노트북(Windows 11)에서 보내기

1. 노트북을 학교 네트워크에 연결하고 **화면 보내기**를 실행한다.
2. 칠판에 표시된 6자리 코드와 이름을 입력하고 **연결**을 누른다.
3. 교실 PC에서 **허용**을 누르면 노트북 화면이 바로 칠판에 나온다(휴대전화처럼 따로 ‘지금 시작’을 누르지 않는다).
4. ‘노트북 소리도 함께 보내기’를 켜면 공유 중에는 노트북 스피커가 꺼지고 소리가 칠판 스피커로 나온다.
5. 코드로 PC를 찾지 못하면(다른 네트워크 대역) **코드로 연결이 안 될 때**를 눌러 칠판 아래쪽의 PC 주소를 입력한다.

공유 중에는 ‘화면 보내기’ 창이 칠판에 보이지 않는다.

### 여러 모둠 동시에 보기(최대 6대)

- 휴대전화·노트북을 섞어 **최대 6대**까지 같은 코드로 연결할 수 있다. 1대는 전체, 2대는 좌우, 3~4대는 2×2, 5~6대는 3×2로 화면이 나뉜다.
- 요청이 여러 개 오면 오른쪽 아래 **연결 요청** 목록에서 하나씩 허용하거나 **모두 허용**을 누른다.
- 2대 이상이 보이면 **모든 기기의 소리가 자동으로 꺼진다.** 칸 아래의 **소리 꺼짐/소리 켜짐** 버튼으로 기기별로 켜고 끈다. 1대만 남으면 자동으로 끈 소리는 다시 켜진다.
- 칸 아래의 **크게**(또는 칸 더블클릭)로 한 모둠만 크게 보고, **나눠 보기**나 Esc로 돌아온다. **종료**로 그 모둠만 끝낸다.
- 공유 중 화면 위쪽을 건드리면 도구 모음이 나온다. **참여 코드**를 누르면 QR과 코드가 크게 떠서 다른 모둠이 이어서 참여할 수 있다.
- 3대 이상이면 송신기가 자동으로 낮은 화질(분할 화면용)로 보내 학교 Wi-Fi 부담을 줄인다.

## 배포

### PC (전산 담당자)

- 한 대씩: 설치 파일을 실행한다(관리자 권한 필요).
- 여러 대 일괄 설치: 설치 파일을 `/S` 옵션으로 실행하면 화면 없이 설치된다.

```bash
"ScreenMirrorReceiver-Setup-0.3.0.exe" /S
```

- 삭제하면 방화벽 규칙도 함께 지워진다.

### 학생 노트북

- `ScreenMirrorSender-Setup-<버전>.exe`를 실행하면 관리자 권한 없이 사용자 계정에 바로 설치된다. 방화벽 설정은 바꾸지 않는다.
- 여러 대에 미리 깔아 둘 때도 `/S` 옵션으로 화면 없이 설치할 수 있다.

### Android (교사)

1. APK 파일을 휴대전화로 옮긴다(메신저, USB, 학교 드라이브 등).
2. 파일을 누르면 ‘출처를 알 수 없는 앱 설치’를 허용하라는 안내가 나온다. 파일을 연 앱(예: 내 파일)에 허용한다.
3. 새 버전은 기존 앱 위에 그대로 설치하면 된다. 설정은 유지된다.

**정식 배포 전 반드시 할 일:** 지금 APK는 디버그 키로 서명되어 있다. 배포용 서명 키를 만들어 계속 같은 키로 서명해야 업데이트가 덮어 설치된다. 키를 잃어버리면 모든 교사가 앱을 지우고 새로 설치해야 한다.

```bash
keytool -genkeypair -v -keystore android/release.jks -alias mirror -keyalg RSA -keysize 2048 -validity 10000
```

`android/keystore.properties` 파일을 만들어 아래 값을 넣으면 `gradlew assembleRelease`가 이 키로 서명한다(이 파일과 `.jks`는 저장소에 올리지 않는다).

```
storeFile=release.jks
storePassword=...
keyAlias=mirror
keyPassword=...
```

## 개발

### Windows 프로그램(수신기·학생용 송신기)

```bash
cd receiver && npm install && node node_modules/electron/install.js
```

```bash
cd receiver && npm start
```

```bash
cd receiver && npm test
```

```bash
cd receiver && npm run start:sender
```

```bash
cd receiver && npm run dist && npm run dist:sender
```

이 PC 한 대에서 송신기 → 수신기를 시험할 수 있다. 수신기를 코드 고정·자동 승인으로 띄운 뒤 송신기를 같은 코드로 자동 연결한다. 이미 설치된 수신기가 실행 중이면 `SMIRROR_USER_DATA`로 설정 폴더를 따로 주고, 포트가 겹치면 `SMIRROR_PORT`를 준다.

```bash
cd receiver && SMIRROR_USER_DATA=./.dev-recv SMIRROR_DEV_CODE=123456 SMIRROR_AUTO_APPROVE=1 SMIRROR_STATS=1 npx electron .
```

```bash
cd receiver && SMIRROR_SENDER_CODE=123456 SMIRROR_SENDER_SECONDS=15 npx electron src/sender/main.js
```

휴대전화 없이 화면 표시를 시험할 때는 개발 모드에서 코드를 고정하고 자동 승인한 뒤 가짜 송신기를 실행한다(설치본에서는 동작하지 않음).

```bash
cd receiver && SMIRROR_DEV_CODE=123456 SMIRROR_AUTO_APPROVE=1 npx electron .
```

```bash
cd receiver && npx electron test/fake-sender.js 123456
```

가짜 송신기는 시험 영상(가로 → 세로 → 가로 회전)과 440Hz 소리를 11초간 보낸 뒤 종료한다.

### Android 앱

```bash
cd android && ./gradlew assembleDebug
```

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

## 확인된 것과 남은 것

| 항목 | 상태 |
|---|---|
| 접속 서버 규칙(코드 오입력·5회 잠금·승인·거절·공유 중 거부·코드 재사용 차단·버전 불일치) | 자동 시험 통과(`npm test`) |
| PC 화면 표시·회전 대응·종료 후 새 코드 | 가짜 송신기로 실제 화면 확인 |
| 설치본 실행·포트 열림 | 확인 |
| 학생 노트북 송신기 → 수신기(코드 탐색·주소 직접 입력, 화면 약 30fps, 시스템 소리 48kHz) | 같은 PC에서 실제 화면 캡처로 확인 |
| 6대 동시 연결 분할 화면·자동 음소거·소리 다시 켜기·7번째 거절 | 같은 PC에서 가짜 송신기 5대 + 학생용 송신기 1대로 확인, 서버 자동 시험 7개 통과 |
| 학생 노트북 송신기를 **다른 노트북**에서 교실 PC로 보내기, 45분 사용, 노트북 스피커 꺼짐 | 미확인. 실기기 시험 필요 |
| Android 앱 빌드·lint | 오류 없음 |
| **실제 휴대전화 → PC 연결, 소리 재생, 45분 연속 사용** | **미확인. 실기기 시험 필요(PRD 9장)** |
| 설치 시 방화벽 규칙 추가 | 설치 스크립트 작성, 실제 설치로는 미확인 |
| APK를 PC에서 내려받는 QR(FR-18, P1) | 미구현 |
| 끊김 후 자동 재연결(FR-12, P1) | 미구현 |

## 라이선스

[MIT License](LICENSE). 함께 배포되는 주요 라이브러리는 각자의 라이선스를 따른다: Electron(MIT), qrcode(MIT), selfsigned(MIT), ZXing Android Embedded(Apache-2.0), AndroidX·Material Components(Apache-2.0).
