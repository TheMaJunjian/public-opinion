import './GitMeetingGuide.css';

export function GitHubTokenLink({ mode = 'write' }: { mode?: 'write' | 'read' }) {
  return <a href={`https://github.com/settings/personal-access-tokens/new?name=Gonglun&issues=${mode}`}
    target="_blank" rel="noreferrer">{mode === 'write' ? '创建发言令牌' : '创建只读令牌'}</a>;
}

export function GitHubArchiveWorkflowLink() {
  const base = import.meta.env.DEV ? location.origin : document.baseURI;
  const href = new URL(`${import.meta.env.BASE_URL}gonglun-archive.yml`, base).href;
  return <a href={href} download="gonglun-archive.yml">下载讨论归档工作流</a>;
}

function PersonalTokenSteps() {
  return <>
    <p>在 GitHub 生成细粒度个人访问令牌时，选择仓库所有者和讨论仓库。新建讨论或发言需要
      <b> Issues → Read and write</b>，仅读取私有讨论可选 <b>Issues → Read-only</b>。
      把生成的令牌粘贴到公论的「GitHub 访问令牌」。公开讨论可以留空直接阅读。{' '}
      <GitHubTokenLink /> · <GitHubTokenLink mode="read" /></p>
    <p>为别人的个人仓库发言时，GitHub 对细粒度令牌有使用限制。受邀协作者可使用已授权仓库访问的 GitHub 登录，
      或在了解授权范围后为自己的账号选择 classic 令牌。{' '}
      <a href="https://docs.github.com/zh/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens"
        target="_blank" rel="noreferrer">查看 GitHub 的令牌权限和限制</a></p>
  </>;
}

export default function GitMeetingGuide({ hosted }: { hosted: boolean }) {
  return <details className="git-meeting-guide">
    <summary>首次使用 GitHub</summary>
    <ol>
      <li><strong>新建讨论。</strong>在公论选「新建讨论」，填写讨论名称。
        {hosted
          ? '勾选「同时新建个人 GitHub 仓库」即可指定仓库名称及可见性，也可以取消勾选，填入一个已有仓库的地址。按提示授权 GitHub 后即可创建。'
          : <>填写已有仓库地址和自己的令牌，再点「创建并进入讨论」。首次建仓可在 GitHub 选择仓库名称和可见性。{' '}
            <a href="https://github.com/new" target="_blank" rel="noreferrer">在 GitHub 新建仓库</a></>}
        {' '}已有仓库需在 Settings 中启用 Issues。仅限成员阅读时请选择私有仓库。</li>
      <li><strong>邀请成员。</strong>在讨论里点「会议交换 → 复制加入信息」，把讨论链接发给参与者。
        仓库所有者、所属组织成员和受邀协作者可以参与。个人仓库可在 GitHub 的
        {' '}<b>Settings → Collaborators</b> 中邀请成员，由对方接受。{' '}
        <a href="https://docs.github.com/zh/repositories/managing-your-repositorys-settings-and-features/repository-access-and-collaboration/inviting-collaborators-to-a-personal-repository"
          target="_blank" rel="noreferrer">GitHub 邀请协作者说明</a></li>
      <li><strong>加入讨论。</strong>在公论选「进入已有讨论」，把链接粘到「GitHub 讨论链接」。
        {hosted ? '要发言可点「GitHub 授权并进入讨论」。私有仓库需选择「公开和私有仓库」范围。只阅读公开讨论时可以点「只读进入公开讨论」。'
          : '需要发言或读取私有讨论时，填写自己的令牌。公开讨论可以留空直接阅读。'}</li>
    </ol>
    <p>同一仓库可以开多场讨论，每场有独立的 Issue 链接。公论将发言和回复直接存为该 Issue 的评论。
      请在公论里发言并保留 GitHub 上的原始记录。手动编辑或删除 Issue 正文、发言评论，可能使新加入者与已有成员看到不同的历史。</p>
    {hosted ? <details><summary>改用个人访问令牌</summary><PersonalTokenSteps /></details> : <PersonalTokenSteps />}
    <details>
      <summary>为讨论生成 JSONL 归档文件</summary>
      <p>需要在仓库中保留一份讨论文件时，管理员可安装归档工作流。发言在 GitHub 接收评论后即可同步，文件随后更新。单个归档上限为 32 MiB。</p>
      <ol>
        <li>下载工作流，在讨论仓库的默认分支提交为 <code>.github/workflows/gonglun-archive.yml</code>。
          仓库需要启用 GitHub Actions，并允许工作流写入该分支。{' '}<GitHubArchiveWorkflowLink /></li>
        <li>同一仓库只需安装一次。每场讨论各有一个文件，例如第 17 号 Issue 的记录会写入
          {' '}<code>gonglun/discussion-17.jsonl</code>。要补归档已有讨论，可在 GitHub 的 Actions 中打开归档工作流，
          点击 <b>Run workflow</b>，填入 Issue 编号。</li>
      </ol>
    </details>
  </details>;
}
