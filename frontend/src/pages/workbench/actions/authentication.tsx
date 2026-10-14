import { api } from "../../../api";
import type { MessageStakes, User } from "../../../types";

interface RequireAuthDependencies {
  user: User | null;
  logout: () => Promise<void>;
  navigate: import("react-router-dom").NavigateFunction;
}

export function requireAuth(dependencies: RequireAuthDependencies): boolean {
  const { user, logout, navigate } = dependencies;
  const token = localStorage.getItem('token');
  if (!user || !token) {
    logout();
    navigate('/login', { state: { reason: '发送消息需要登录' } });
    return false;
  }
  return true;
}

interface HandleAuthErrorDependencies {
  logout: () => Promise<void>;
  navigate: import("react-router-dom").NavigateFunction;
}

export async function handleAuthError(dependencies: HandleAuthErrorDependencies, err: unknown): Promise<boolean> {
  const { logout, navigate } = dependencies;
  const apiError = err as { status?: number; code?: string; message?: string };
  const authFailureCodes = new Set([
    'AUTH_TOKEN_MISSING',
    'AUTH_TOKEN_INVALID',
    'AUTH_TOKEN_EXPIRED',
  ]);
  if (apiError.status === 401 && authFailureCodes.has(apiError.code ?? '')) {
    await logout();
    navigate('/login', {
      state: {
        reason: `认证失败：${apiError.message ?? '登录令牌无效或已过期'}。请求接口：${(err as any)?.path ?? '未知'}`,
      },
    });
    return true;
  }
  return false;
}

interface BlockCorrectionForSecondBettorDependencies {
  mergeStakeSnapshot: (messageId: string, stakes: MessageStakes) => void;
  showAlert: (message: string) => void;
}

export async function blockCorrectionForSecondBettor(dependencies: BlockCorrectionForSecondBettorDependencies, messageId: string): Promise<boolean> {
  const { mergeStakeSnapshot, showAlert } = dependencies;
  try {
    const stakes = await api.getMessageStakes(messageId);
    mergeStakeSnapshot(messageId, stakes);
    const bettors = new Set(stakes.stakes.map(stake => stake.user.id || stake.user.username)).size;
    if (bettors >= 2) {
      showAlert('目标消息已有第二位与会者押注，不能再发送更正消息');
      return true;
    }
  } catch {
    // The backend remains authoritative when the best-effort refresh fails.
  }
  return false;
}
