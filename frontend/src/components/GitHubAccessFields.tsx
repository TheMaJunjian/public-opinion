import { dialogStyles } from './dialogStyles';
import { GitHubTokenLink } from './GitMeetingGuide';
import type { GitHubAccess } from '../utils/gitMeetingSession';

export function GitHubAccessField({ access, onChange, disabled = false }: {
  access: GitHubAccess; onChange?(access: GitHubAccess): void; disabled?: boolean;
}) {
  return <>
    {onChange && <label className="git-meeting-label">GitHub 授权范围
      <select disabled={disabled} value={access} style={dialogStyles.input}
        onChange={event => onChange(event.target.value as GitHubAccess)}>
        <option value="public">公开仓库</option><option value="private">公开和私有仓库</option>
      </select>
    </label>}
    <small>Firebase 处理 GitHub 登录。发言和回复由本机直接与 GitHub 同步。
      {access === 'private' ? 'GitHub 会请求读写你有权访问的公开和私有仓库。' : '将请求你有权写入的公开仓库权限。'}</small>
  </>;
}

export function GitTokenField({ token, onChange, disabled = false }: {
  token: string; onChange(value: string): void; disabled?: boolean;
}) {
  return <>
    <label className="git-meeting-label">GitHub 访问令牌
      <input type="password" autoComplete="off" spellCheck={false} value={token} disabled={disabled}
        style={dialogStyles.input} onChange={event => onChange(event.target.value)} />
    </label>
    <small>读取私有讨论需要所选仓库的 Issues 读权限，发言和新建讨论需要 Issues 写权限。
      令牌只在当前页面内存中使用，刷新后需重填。{' '}
      <GitHubTokenLink />{' · '}<GitHubTokenLink mode="read" />
    </small>
  </>;
}
