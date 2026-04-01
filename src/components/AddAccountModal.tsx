import { useState } from "react";
import {
  describeFileSource,
  isTauriRuntime,
  openExternalUrl,
  pickAuthJsonFile,
  type FileSource,
} from "../lib/platform";

interface AddAccountModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImportFile: (source: FileSource, name: string) => Promise<void>;
  onStartOAuth: (name: string) => Promise<{ auth_url: string }>;
  onCompleteOAuth: () => Promise<unknown>;
  onCancelOAuth: () => Promise<void>;
}

type Tab = "oauth" | "import";

export function AddAccountModal({
  isOpen,
  onClose,
  onImportFile,
  onStartOAuth,
  onCompleteOAuth,
  onCancelOAuth,
}: AddAccountModalProps) {
  const [activeTab, setActiveTab] = useState<Tab>("oauth");
  const [name, setName] = useState("");
  const [fileSource, setFileSource] = useState<FileSource | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [oauthPending, setOauthPending] = useState(false);
  const [authUrl, setAuthUrl] = useState<string>("");
  const [copied, setCopied] = useState<boolean>(false);
  const isPrimaryDisabled = loading || (activeTab === "oauth" && oauthPending);
  const tauriRuntime = isTauriRuntime();

  const resetForm = () => {
    setName("");
    setFileSource(null);
    setError(null);
    setLoading(false);
    setOauthPending(false);
    setAuthUrl("");
  };

  const handleClose = () => {
    if (oauthPending) {
      onCancelOAuth();
    }
    resetForm();
    onClose();
  };

  const handleOAuthLogin = async () => {
    if (!name.trim()) {
      setError("계정 이름을 입력하세요");
      return;
    }

    try {
      setLoading(true);
      setError(null);
      const info = await onStartOAuth(name.trim());
      setAuthUrl(info.auth_url);
      setOauthPending(true);
      setLoading(false);

      // Wait for completion
      await onCompleteOAuth();
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
      setOauthPending(false);
    }
  };

  const handleSelectFile = async () => {
    try {
      const selected = await pickAuthJsonFile();
      if (selected) setFileSource(selected);
    } catch (err) {
      console.error("Failed to open file dialog:", err);
    }
  };

  const handleImportFile = async () => {
    if (!name.trim()) {
      setError("계정 이름을 입력하세요");
      return;
    }
    if (!fileSource) {
      setError("auth.json 파일을 선택하세요");
      return;
    }

    try {
      setLoading(true);
      setError(null);
      await onImportFile(fileSource, name.trim());
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center">
      <div className="modal-surface mx-4 w-full max-w-md rounded-[28px]">
        {/* Header */}
        <div className="soft-divider flex items-center justify-between border-b p-5">
          <h2 className="text-lg font-semibold text-[var(--text-strong)]">계정 추가</h2>
          <button
            onClick={handleClose}
            className="text-[var(--text-soft)] transition-colors hover:text-[var(--primary-strong)]"
          >
            ✕
          </button>
        </div>

        {/* Tabs */}
        <div className="soft-divider flex border-b">
          {(["oauth", "import"] as Tab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => {
                if (tab === "import" && oauthPending) {
                  void onCancelOAuth().catch((err) => {
                    console.error("Failed to cancel login:", err);
                  });
                  setOauthPending(false);
                  setLoading(false);
                }
                setActiveTab(tab);
                setError(null);
              }}
              className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${activeTab === tab
                  ? "text-[var(--text-strong)] border-b-2 border-[var(--primary)] -mb-px"
                  : "text-[var(--text-soft)] hover:text-[var(--primary-strong)]"
                }`}
            >
              {tab === "oauth" ? "ChatGPT 로그인" : "파일 가져오기"}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="p-5 space-y-4">
          {/* Account Name (always shown) */}
          <div>
            <label className="mb-2 block text-sm font-medium text-[var(--text-strong)]">
              계정 이름
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="예: 업무용 계정"
              className="field-shell w-full rounded-xl px-4 py-2.5 transition-colors"
            />
          </div>

          {/* Tab-specific content */}
          {activeTab === "oauth" && (
            <div className="text-sm text-[var(--text-body)]">
              {oauthPending ? (
                <div className="text-center py-4">
                  <div className="mx-auto mb-3 h-8 w-8 animate-spin rounded-full border-2 border-[var(--primary)] border-t-transparent"></div>
                  <p className="mb-2 font-medium text-[var(--text-strong)]">브라우저 로그인을 기다리는 중...</p>
                  <p className="mb-4 text-xs text-[var(--text-body)]">
                    아래 링크를 브라우저에서 열어 로그인을 진행하세요:
                  </p>
                  <div className="mb-2 flex items-center gap-2 rounded-xl border border-[rgba(186,195,233,0.52)] bg-[rgba(244,247,255,0.84)] p-2">
                    <input
                      type="text"
                      readOnly
                      value={authUrl}
                      className="flex-1 truncate border-none bg-transparent text-xs text-[var(--text-body)] focus:outline-none focus:ring-0"
                    />
                    <button
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(authUrl)
                          .then(() => {
                            setCopied(true);
                            setTimeout(() => setCopied(false), 2000);
                          })
                          .catch(() => {
                            setError("클립보드를 사용할 수 없습니다. 링크를 직접 복사하세요.");
                          });
                      }}
                      className={`shrink-0 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors 
                        ${copied
                          ? "bg-[rgba(132,223,194,0.2)] border-[rgba(132,223,194,0.34)] text-[#2f8d76]"
                          : "bg-white border-[rgba(186,195,233,0.52)] text-[var(--text-body)] hover:bg-[rgba(245,248,255,0.94)]"
                        }`}
                    >
                      {copied ? "복사됨" : "복사"}
                    </button>
                    <button
                      onClick={() => {
                        void openExternalUrl(authUrl);
                      }}
                      className="btn-base btn-primary shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium"
                    >
                      열기
                    </button>
                  </div>
                  {!tauriRuntime && (
                    <p className="text-xs text-[#946326]">
                      콜백 주소가 `localhost`로 돌아오기 때문에 OAuth 로그인도 같은 기기에서 완료해야 합니다.
                    </p>
                  )}
                </div>
              ) : (
                <p>
                  아래 버튼을 눌러 로그인 링크를 만든 뒤 브라우저에서 인증을 진행하세요.
                </p>
              )}
            </div>
          )}

          {activeTab === "import" && (
            <div>
              <label className="mb-2 block text-sm font-medium text-[var(--text-strong)]">
                auth.json 파일 선택
              </label>
              <div className="flex gap-2">
                <div className="field-shell flex-1 truncate rounded-xl px-4 py-2.5 text-sm text-[var(--text-body)]">
                  {describeFileSource(fileSource)}
                </div>
                <button
                  onClick={handleSelectFile}
                  className="btn-base btn-secondary whitespace-nowrap px-4 py-2.5 text-sm font-medium"
                >
                  찾아보기...
                </button>
              </div>
              <p className="mt-2 text-xs text-[var(--text-soft)]">
                기존 Codex `auth.json` 파일에서 인증 정보를 가져옵니다
              </p>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="rounded-xl border border-[rgba(255,159,184,0.42)] bg-[rgba(255,236,242,0.9)] p-3 text-sm text-[#c25778]">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="soft-divider flex gap-3 border-t p-5">
          <button
            onClick={handleClose}
            className="btn-base btn-secondary flex-1 px-4 py-2.5 text-sm font-medium"
          >
            취소
          </button>
          <button
            onClick={activeTab === "oauth" ? handleOAuthLogin : handleImportFile}
            disabled={isPrimaryDisabled}
            className="btn-base btn-primary flex-1 px-4 py-2.5 text-sm font-medium disabled:opacity-50"
          >
            {loading
              ? "추가 중..."
              : activeTab === "oauth"
                ? "로그인 링크 만들기"
                : "가져오기"}
          </button>
        </div>
      </div>
    </div>
  );
}
