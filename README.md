# 교실 전자칠판용 화면 미러링 (MVP)

Android 휴대전화의 화면과 소리를 교실 Windows PC로 보내, PC에 HDMI로 연결된 전자칠판에 표시한다. 외부 서버 없이 학교 네트워크 안에서만 동작한다. 요구사항은 [PRD.txt](PRD.txt), 통신 규격은 [docs/protocol.md](docs/protocol.md)를 본다.

| 폴더 | 내용 | 기술 |
|---|---|---|
| `receiver/` | Windows PC 수신 프로그램(접속 서버 내장) | Electron 44, WebCodecs H.264 하드웨어 디코딩, AudioWorklet |
| `android/` | Android 송신 앱 | Java, MediaProjection + MediaCodec H.264, AudioPlaybackCapture(PCM) |
| `docs/` | 프로토콜 문서 | TLS(인증서 지문 고정) + 자체 프레임 형식 |

## 결과물

| 파일 | 용도 |
|---|---|
| `receiver/dist/ScreenMirrorReceiver Setup 0.1.0.exe` | PC 설치 파일. 설치 시 Windows 방화벽 허용 규칙(도메인·사설 네트워크)을 자동 추가한다. |
| `android/app/build/outputs/apk/debug/app-debug.apk` | 시험용 APK(디버그 서명) |

## 교실에서 쓰는 법

1. 교실 PC에서 **화면 미러링 수신기**를 실행한다. QR 코드와 6자리 코드가 표시된다.
2. 휴대전화를 학교 Wi-Fi에 연결하고 **화면 미러링** 앱에서 QR 코드를 스캔한다(기본 카메라로 찍어도 앱이 열린다). 같은 네트워크 대역이면 6자리 코드 입력도 된다.
3. PC 화면의 **허용**을 누른다.
4. 휴대전화에 나오는 화면 공유 안내에서 **지금 시작**을 누른다.
5. PC에서 **전체 화면**을 누른다. 확장 모니터 구성이면 **설정 → 출력 모니터**에서 전자칠판을 고른다. 소리는 **설정 → 소리 출력 장치**에서 바꾼다.

## 배포

### PC (전산 담당자)

- 한 대씩: 설치 파일을 실행한다(관리자 권한 필요).
- 여러 대 일괄 설치: 설치 파일을 `/S` 옵션으로 실행하면 화면 없이 설치된다.

```bash
"ScreenMirrorReceiver Setup 0.1.0.exe" /S
```

- 삭제하면 방화벽 규칙도 함께 지워진다.

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

### PC 수신 프로그램

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
cd receiver && npm run dist
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
| Android 앱 빌드·lint | 오류 없음 |
| **실제 휴대전화 → PC 연결, 소리 재생, 45분 연속 사용** | **미확인. 실기기 시험 필요(PRD 9장)** |
| 설치 시 방화벽 규칙 추가 | 설치 스크립트 작성, 실제 설치로는 미확인 |
| APK를 PC에서 내려받는 QR(FR-18, P1) | 미구현 |
| 끊김 후 자동 재연결(FR-12, P1) | 미구현 |
