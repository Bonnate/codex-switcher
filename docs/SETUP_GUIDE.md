# Codex Switcher Setup Guide

이 문서는 `codex-switcher`를 새 PC에서 직접 실행하기 위한 최소 셋업 절차를 정리합니다.

목표:
- 각 PC에 `Node.js`, `pnpm`, `Rust`를 설치
- 저장소를 받아서 바로 실행
- 필요하면 빌드해서 실행 파일 생성

## 1. 필수 준비물

공통:
- `Node.js` 18 이상
- `pnpm`
- `Rust`
- `git`

추가 준비물:
- Windows: WebView2 런타임이 보통 기본 탑재되어 있음
- macOS: Xcode Command Line Tools 필요

## 2. Windows 셋업

### 2-1. Node.js 설치

권장:
- Node.js LTS 설치

예시:
```powershell
winget install OpenJS.NodeJS.LTS
```

### 2-2. pnpm 설치

권장:
```powershell
npm install -g pnpm
```

PowerShell에서 실행 정책 때문에 `npm` 또는 `pnpm`이 막히면:
- 새 `cmd` 창에서 실행
- 또는 PowerShell 실행 정책을 조정

예시:
```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

### 2-3. Rust 설치

```powershell
winget install Rustlang.Rustup
```

설치 후:
- 터미널을 완전히 닫고 새로 열기

확인:
```powershell
cargo --version
rustc --version
```

### 2-4. 저장소 받기

```powershell
git clone https://github.com/Lampese/codex-switcher.git
cd codex-switcher
```

### 2-5. 의존성 설치

```powershell
pnpm install
```

### 2-6. 개발 모드 실행

```powershell
pnpm tauri dev
```

정상이라면 데스크톱 창이 뜹니다.

## 3. macOS 셋업

### 3-1. Xcode Command Line Tools 설치

```bash
xcode-select --install
```

### 3-2. Node.js 설치

예시:
```bash
brew install node
```

### 3-3. pnpm 설치

예시:
```bash
npm install -g pnpm
```

### 3-4. Rust 설치

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

설치 후:
```bash
source "$HOME/.cargo/env"
```

확인:
```bash
cargo --version
rustc --version
```

### 3-5. 저장소 받기

```bash
git clone https://github.com/Lampese/codex-switcher.git
cd codex-switcher
```

### 3-6. 의존성 설치

```bash
pnpm install
```

### 3-7. 개발 모드 실행

```bash
pnpm tauri dev
```

## 4. 브라우저 대시보드 모드

Tauri 창 대신 브라우저로 띄우고 싶으면:

```bash
pnpm lan
```

기본 주소:
- `http://0.0.0.0:3210`

옵션 환경 변수:
- `CODEX_SWITCHER_WEB_HOST`
- `CODEX_SWITCHER_WEB_PORT`

예시:
```bash
CODEX_SWITCHER_WEB_PORT=4000 pnpm lan
```

## 5. 릴리스 빌드

설치형 또는 배포용 실행 파일을 만들려면:

```bash
pnpm tauri build
```

출력 위치:
- `src-tauri/target/release/bundle/`

Windows에서 보통:
- 설치 파일
- 번들 파일
- `src-tauri/target/release/codex-switcher.exe`

가 생성됩니다.

## 6. 계정 데이터 위치

이 프로젝트의 소스 폴더와 계정 데이터는 별개입니다.

실제 계정 관련 파일:
- Codex CLI 활성 인증: `%USERPROFILE%\.codex\auth.json` 또는 `~/.codex/auth.json`
- Codex Switcher 저장소: `%USERPROFILE%\.codex-switcher\accounts.json` 또는 `~/.codex-switcher/accounts.json`

즉:
- 프로젝트 폴더만 복사해도 계정은 자동으로 따라오지 않을 수 있음
- 계정까지 옮기려면 위 경로의 데이터도 같이 이동해야 함

## 7. 다른 PC로 계정 옮기기

권장 방법:
1. 앱에서 `Account -> Export Full Encrypted File`
2. 생성된 `.cswf` 파일을 다른 PC로 복사
3. 다른 PC에서 `Account -> Import Full Encrypted File`

대안:
- `%USERPROFILE%\.codex`
- `%USERPROFILE%\.codex-switcher`

두 폴더를 같은 위치로 복사

복사 전 권장 사항:
- Codex CLI 종료
- Codex Switcher 종료

## 8. 자주 막히는 문제

### `cargo not found`

원인:
- Rust 미설치
- 설치 후 터미널 재시작 안 함

해결:
- Rust 설치 후 새 터미널 열기

### PowerShell에서 `npm` 또는 `pnpm` 실행이 막힘

원인:
- 실행 정책 제한

해결:
- `cmd`에서 실행
- 또는 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`

### `pnpm tauri dev` 실행 시 창이 안 뜸

확인:
- `pnpm install`이 끝났는지
- `cargo --version`이 되는지
- Tauri 빌드 에러가 없는지

### 계정 전환이 안 됨

원인:
- 이미 Codex 프로세스가 실행 중일 수 있음

해결:
- 실행 중인 Codex CLI 세션 종료 후 다시 전환

## 9. 가장 짧은 실행 절차

Windows:
```powershell
winget install OpenJS.NodeJS.LTS
winget install Rustlang.Rustup
npm install -g pnpm
git clone https://github.com/Lampese/codex-switcher.git
cd codex-switcher
pnpm install
pnpm tauri dev
```

macOS:
```bash
xcode-select --install
brew install node
npm install -g pnpm
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
git clone https://github.com/Lampese/codex-switcher.git
cd codex-switcher
pnpm install
pnpm tauri dev
```
