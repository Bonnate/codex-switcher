<p align="center">
  <img src="src-tauri/icons/logo.svg" alt="Codex Switcher" width="128" height="128">
</p>

<h1 align="center">Codex Switcher</h1>

<p align="center">
  여러 OpenAI <a href="https://github.com/openai/codex">Codex CLI</a> 계정을 한곳에서 관리하는 데스크톱 앱<br>
  계정을 빠르게 전환하고, 사용량 제한을 확인하고, 쿼터를 더 쉽게 관리할 수 있습니다
</p>

## 주요 기능

- **다중 계정 관리**: 여러 Codex 계정을 한 화면에서 추가하고 관리할 수 있습니다.
- **빠른 전환**: 클릭 한 번으로 활성 계정을 바꿀 수 있습니다.
- **사용량 모니터링**: 5시간 제한과 주간 제한을 실시간으로 확인할 수 있습니다.
- **이중 로그인 방식**: OAuth 로그인 또는 기존 `auth.json` 파일 가져오기를 지원합니다.

## 설치 및 실행

### 준비물

- [Node.js](https://nodejs.org/) 18 이상
- [pnpm](https://pnpm.io/)
- [Rust](https://rustup.rs/)

### 소스에서 빌드하기

```bash
# 저장소 복제
git clone https://github.com/Bonnate/codex-switcher.git
cd codex-switcher

# 의존성 설치
pnpm install

# 개발 모드 실행
pnpm tauri dev

# 배포용 빌드
pnpm tauri build
```

빌드 결과물은 `src-tauri/target/release/bundle/`에 생성됩니다.

- Windows에서는 Rust 설치 후 PowerShell 또는 `cmd`에서 `pnpm tauri ...` 명령을 직접 실행할 수 있습니다.
- macOS에서는 `./build-macos.sh`가 `.app` 번들을 빌드하고, 업데이터 서명 키가 없더라도 가능한 산출물을 그대로 남깁니다.
- `./run-macos.sh`는 감지된 실행 파일 또는 `.app` 번들을 찾아 실행합니다.
- Finder에서 더블클릭으로 쓰고 싶다면 `build-macos.command`, `run-macos.command`도 사용할 수 있습니다.

상세 설치 절차는 [docs/SETUP_GUIDE.md](docs/SETUP_GUIDE.md)를 참고하세요.

## 브라우저 대시보드로 실행하기

Tauri 창 대신 HTTP 서버로 대시보드를 띄울 수도 있습니다.

```bash
# 프런트엔드를 빌드하고 0.0.0.0:3210에서 웹 서버 실행
pnpm lan
```

선택 환경 변수:

- `CODEX_SWITCHER_WEB_HOST`: 바인드 호스트 변경
- `CODEX_SWITCHER_WEB_PORT`: 포트 변경

브라우저 대시보드는 `/api/invoke/*` 경로를 통해 데스크톱 앱과 동일한 UI와 백엔드 기능을 제공합니다. 포트를 안전하게 노출하면 LAN, Tailscale, 원격 터널 환경에서도 사용할 수 있습니다.

## 안내 및 주의사항

이 도구는 **본인이 직접 소유한 여러 OpenAI/ChatGPT 계정을 관리하는 용도**로 설계되었습니다. 여러 계정을 더 편하게 정리하고 전환할 수 있도록 돕는 것이 목적입니다.

다음과 같은 용도로는 사용하도록 설계되지 않았습니다.

- 여러 사용자가 계정을 공유하는 방식
- OpenAI 서비스 약관이나 사용 제한을 우회하는 방식
- 계정 풀링 또는 자격 증명 공유

이 소프트웨어를 사용하는 경우, 앱에 추가한 모든 계정의 정당한 소유자임을 전제로 합니다. 개발자는 오용이나 OpenAI 약관 위반에 대해 책임지지 않습니다.
