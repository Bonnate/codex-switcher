# Codex Switcher 설치 가이드

이 문서는 새 PC에서 `codex-switcher`를 직접 실행하거나 빌드하기 위한 최소 절차를 정리한 문서입니다.

목표:
- 각 PC에 `Node.js`, `pnpm`, `Rust`, `git`을 설치합니다.
- 저장소를 내려받아 개발 모드로 바로 실행합니다.
- 필요하면 Windows `exe` 또는 macOS `.app` 형태로 빌드합니다.

## 1. 준비물

공통 준비물:
- `Node.js` 18 이상
- `pnpm`
- `Rust`
- `git`

추가 준비물:
- Windows: WebView2 런타임이 보통 기본 탑재되어 있습니다.
- macOS: Xcode Command Line Tools가 필요합니다.

## 2. Windows 설치

### 2-1. Node.js 설치

권장:
- Node.js LTS 버전을 설치합니다.

예시:
```powershell
winget install OpenJS.NodeJS.LTS
```

### 2-2. pnpm 설치

```powershell
npm install -g pnpm
```

PowerShell 실행 정책 때문에 `npm` 또는 `pnpm` 실행이 막히면:
- 새 `cmd` 창에서 실행하거나
- PowerShell 실행 정책을 조정합니다.

예시:
```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

### 2-3. Rust 설치

```powershell
winget install Rustlang.Rustup
```

설치 후:
- 터미널을 완전히 닫고 새로 엽니다.

확인:
```powershell
cargo --version
rustc --version
```

### 2-4. 저장소 복제

```powershell
git clone https://github.com/Bonnate/codex-switcher.git
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

정상이라면 데스크톱 창이 열립니다.

## 3. macOS 설치

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

### 3-5. 저장소 복제

```bash
git clone https://github.com/Bonnate/codex-switcher.git
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

Tauri 창 대신 브라우저로 대시보드를 띄우고 싶다면:

```bash
pnpm lan
```

기본 주소:
- `http://0.0.0.0:3210`

선택 환경 변수:
- `CODEX_SWITCHER_WEB_HOST`
- `CODEX_SWITCHER_WEB_PORT`

예시:
```bash
CODEX_SWITCHER_WEB_PORT=4000 pnpm lan
```

## 5. 릴리스 빌드

### 5-1. Windows 실행 파일 빌드

이 프로젝트는 서버 없이 단독 실행되는 Windows용 `exe`를 만들 수 있습니다.

권장 방법:
```powershell
build-windows.cmd
```

직접 명령으로 실행하려면:
```powershell
pnpm tauri build --no-bundle
```

출력 위치:
- `src-tauri/target/release/codex-switcher.exe`

실행:
```powershell
run-windows.cmd
```

또는:
```powershell
src-tauri\target\release\codex-switcher.exe
```

참고:
- 생성된 `exe`는 별도 서버 없이 단독 실행됩니다.
- 기존 `build-exe.cmd`, `run-exe.cmd`도 같은 용도로 사용할 수 있습니다.
- `cargo build --release`만으로 만든 실행 파일은 Tauri 설정이 완전히 반영되지 않을 수 있어 권장하지 않습니다.
- 설치형 `setup.exe` 또는 `.msi`가 필요하면 서명 설정을 마친 뒤 `pnpm tauri build`를 사용해야 합니다.

### 5-2. macOS 실행 파일 빌드

macOS에서는 `.app` 번들을 우선 빌드하고, 업데이터 서명 키가 없어도 생성 가능한 산출물을 그대로 사용할 수 있습니다.

권장 방법:
```bash
chmod +x build-macos.sh run-macos.sh build-macos.command run-macos.command
./build-macos.sh
```

직접 명령으로 실행하려면:
```bash
node ./scripts/tauri.mjs build
```

주요 출력 위치:
- `src-tauri/target/release/codex-switcher`
- `src-tauri/target/release/bundle/macos/Codex Switcher.app`

실행:
```bash
./run-macos.sh
```

또는:
```bash
src-tauri/target/release/codex-switcher
```

Finder에서 더블클릭으로 실행하려면:
- `build-macos.command`
- `run-macos.command`

참고:
- `build-macos.sh`는 빌드 후 감지한 산출물 경로를 출력합니다.
- `.app` 번들이 생성되면 `run-macos.sh`는 `open` 명령으로 실행합니다.
- 업데이터 공개키만 있고 개인키가 없으면 업데이터 아티팩트 서명은 건너뛰지만 `.app` 번들은 그대로 사용할 수 있습니다.
- `.command` 파일은 실행 후 Enter를 누를 때까지 터미널 창을 유지합니다.
- `cargo build --release`만으로 만든 실행 파일은 Tauri 설정이 완전히 반영되지 않을 수 있어 권장하지 않습니다.

## 6. 계정 데이터 위치

프로젝트 소스 폴더와 계정 데이터는 별도로 저장됩니다.

실제 계정 관련 파일:
- Codex CLI 활성 인증: `%USERPROFILE%\.codex\auth.json` 또는 `~/.codex/auth.json`
- Codex Switcher 계정 저장소: `%USERPROFILE%\.codex-switcher\accounts.json` 또는 `~/.codex-switcher/accounts.json`

즉:
- 프로젝트 폴더만 복사해도 계정은 자동으로 따라오지 않을 수 있습니다.
- 계정까지 옮기려면 위 경로의 데이터도 함께 이동해야 합니다.

## 7. 다른 PC로 배포하기

### 방법 A. 실행 파일만 배포

대상:
- 다른 Windows PC에서 앱만 바로 실행하고 싶은 경우

절차:
1. 메인 PC에서 `build-exe.cmd` 또는 `build-windows.cmd` 실행
2. 생성된 `src-tauri/target/release/codex-switcher.exe`를 다른 PC로 복사
3. 다른 PC에서 `codex-switcher.exe` 실행

주의:
- 대상 PC에는 WebView2 런타임이 필요할 수 있습니다.
- 프로젝트 소스 전체를 복사할 필요는 없습니다.
- 이 방법은 실행 파일만 옮기는 것이므로 계정 데이터는 자동으로 포함되지 않습니다.

### 방법 B. 실행 파일과 계정 데이터 함께 배포

대상:
- 다른 Windows PC에서 같은 계정 목록까지 바로 사용하고 싶은 경우

절차:
1. 메인 PC에서 `build-exe.cmd` 또는 `build-windows.cmd` 실행
2. `src-tauri/target/release/codex-switcher.exe`를 다른 PC로 복사
3. 계정 데이터도 함께 이동
4. 다른 PC에서 앱 실행

계정 데이터 이동 방식은 아래 두 가지 중 하나를 사용하면 됩니다.

## 8. 다른 PC로 계정 옮기기

권장 방법:
1. 앱에서 `옵션 -> 백업 파일 만들기`
2. 생성된 `.cswf` 파일을 다른 PC로 복사
3. 다른 PC에서 `옵션 -> 백업 파일 복원`

대안:
- `%USERPROFILE%\.codex`
- `%USERPROFILE%\.codex-switcher`

두 폴더를 같은 위치로 복사

복사 전 권장 사항:
- Codex CLI 종료
- Codex Switcher 종료

## 9. 자주 막히는 문제

### `cargo not found`

원인:
- Rust가 설치되지 않았거나
- 설치 후 터미널을 다시 열지 않은 경우

해결:
- Rust 설치 후 새 터미널을 엽니다.

### `run-exe.cmd` 실행 시 `localhost` 연결 오류 발생

원인:
- `cargo build --release`로 만든 실행 파일을 실행했을 가능성이 큽니다.

해결:
- 반드시 `build-exe.cmd`, `build-windows.cmd`, 또는 `pnpm tauri build --no-bundle`로 다시 빌드합니다.
- 그 뒤 `src-tauri/target/release/codex-switcher.exe`를 실행합니다.

### PowerShell에서 `npm` 또는 `pnpm` 실행이 막힘

원인:
- 실행 정책 제한

해결:
- `cmd`에서 실행하거나
- `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`를 적용합니다.

### `pnpm tauri dev` 실행 시 창이 안 뜸

확인할 것:
- `pnpm install`이 정상적으로 끝났는지
- `cargo --version`이 동작하는지
- Tauri 빌드 에러가 없는지

### 계정 전환이 안 됨

원인:
- 이미 Codex 프로세스가 실행 중일 수 있습니다.

해결:
- 실행 중인 Codex CLI 세션을 종료한 뒤 다시 전환합니다.

## 10. 가장 짧은 실행 절차

Windows:
```powershell
winget install OpenJS.NodeJS.LTS
winget install Rustlang.Rustup
npm install -g pnpm
git clone https://github.com/Bonnate/codex-switcher.git
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
git clone https://github.com/Bonnate/codex-switcher.git
cd codex-switcher
pnpm install
pnpm tauri dev
```
