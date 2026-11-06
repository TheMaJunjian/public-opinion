import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Marked, Renderer } from 'marked';
import type { Plugin } from 'vite';

interface PublicDocument {
  slug: string;
  source: string;
  title: string;
  category: string;
  description: string;
  notice: string;
}

export const publicDocuments: readonly PublicDocument[] = [
  {
    slug: 'usage', source: 'README/现行收费与操作规则.md', title: '公论现行收费与操作规则', category: '现行规则',
    description: '贡献点计量什么、当前如何获得、逐条计费与投票结算。',
    notice: '',
  },
  {
    slug: 'promotion', source: 'README/公论推广.md', title: '公论推广', category: '产品介绍',
    description: '争论、辩论、线上文字开会。发言投票（权）、贡献点（钱）、被认可的信息（真理）。',
    notice: '',
  },
  {
    slug: 'what-is-truman', source: 'README/什么是楚门.md', title: '什么是楚门', category: '楚门理念',
    description: '透明协作、基础生活保障、自愿贡献与楚门组织构想。',
    notice: '楚门计划的早期理念原文，保留当时的观点与组织设想；文中保障和权益属于愿景。',
  },
  {
    slug: 'join-truman', source: 'README/欢迎加入楚门.md', title: '欢迎加入楚门', category: '楚门理念',
    description: '招合伙人，条件不限。线上运营，信息公开。投票结算，按功分配。',
    notice: '',
  },
  {
    slug: 'gonglun-for-truman', source: 'README/给楚门设计的工具.md', title: '给楚门设计的工具', category: '工具与运营设计',
    description: '消息图、贡献计量、讨论结算与公开运营：用公论建设和运营公论。',
    notice: '',
  },
  {
    slug: 'business-plan', source: 'README/楚门公论-BP.md', title: '楚门公论商业计划书', category: '发展规划',
    description: '争论与开会工具、用户公开运营、贡献计量与分配、融资沟通和发展路径。',
    notice: '',
  },
];

/** Reading paths share the published pages and their existing section anchors. */
export const publicDocumentGroups = [
  { title: '入门', links: [
    { title: '公论介绍', href: '/about.html' },
    { title: '上手', href: '/about.html#quick-start' },
    { title: '界面导览', href: '/about.html#interface-guide' },
    { title: '公论推广', href: '/docs/promotion.html', slug: 'promotion' },
  ] },
  { title: '操作指南', links: [
    { title: '发言与创建关系', href: '/docs/usage.html#发言与创建关系' },
    { title: '投票、结算与翻案', href: '/docs/usage.html#投票结算与后续翻案' },
    { title: '本地文件阅览', href: '/about.html#local-reading' },
  ] },
  { title: '现行规则', links: [
    { title: '收费与操作规则', href: '/docs/usage.html', slug: 'usage' },
  ] },
  { title: '理念与规划', links: [
    { title: '什么是楚门', href: '/docs/what-is-truman.html', slug: 'what-is-truman' },
    { title: '欢迎加入楚门', href: '/docs/join-truman.html', slug: 'join-truman' },
    { title: '给楚门设计的工具', href: '/docs/gonglun-for-truman.html', slug: 'gonglun-for-truman' },
    { title: '楚门公论商业计划书', href: '/docs/business-plan.html', slug: 'business-plan' },
  ] },
] as const;

const repositoryUrl = 'https://github.com/TheMaJunjian/public-opinion';
const sourceOrigin = 'https://repository.invalid';
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]!);

/** Published source links stay inside the document library; code links point to the repository. */
function documentLink(href: string, document: PublicDocument): string | undefined {
  if (href.startsWith('#')) return href;
  try {
    const target = new URL(href, `${sourceOrigin}/${document.source}`);
    if (!['https:', 'http:'].includes(target.protocol)) return undefined;
    if (target.origin !== sourceOrigin) return target.href;
    const path = decodeURIComponent(target.pathname.slice(1));
    const published = publicDocuments.find(entry => entry.source === path);
    if (published) return `/docs/${published.slug}.html${target.hash}`;
    if (path === 'frontend/public/about.html' || path === 'README/README.md') return '/about.html#documents';
    if (path === 'frontend/public/llms.txt') return '/llms.txt';
    return `${repositoryUrl}/blob/HEAD/${target.pathname.slice(1)}${target.hash}`;
  } catch {
    return undefined;
  }
}

export function renderPublicDocument(document: PublicDocument, markdown: string): string {
  const headings: { id: string; text: string }[] = [];
  const headingIds = new Map<string, number>();
  const parser = new Marked({ gfm: true, async: false, renderer: {
    html({ text }) { return escapeHtml(text); },
    image({ text }) { return escapeHtml(text); },
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens);
      const link = documentLink(href, document);
      return link ? `<a href="${escapeHtml(link)}"${title ? ` title="${escapeHtml(title)}"` : ''}>${label}</a>` : label;
    },
    heading({ depth, text, tokens }) {
      const base = text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-') || 'section';
      const count = headingIds.get(base) ?? 0;
      headingIds.set(base, count + 1);
      const id = count ? `${base}-${count}` : base;
      const level = Math.max(2, depth);
      if (level === 2) headings.push({ id, text });
      return `<h${level} id="${escapeHtml(id)}">${this.parser.parseInline(tokens)}</h${level}>\n`;
    },
    table(token) { return `<div class="table-scroll">${Renderer.prototype.table.call(this, token)}</div>`; },
  } });
  const content = parser.parse(markdown.replace(/^\uFEFF/, '').replace(/^# [^\r\n]*(?:\r?\n|$)/, ''));
  const navigation = publicDocumentGroups.map(group => `<section class="document-nav-group"><h2>${group.title}</h2>${group.links.map(entry => `<a href="${escapeHtml(entry.href)}"${'slug' in entry && entry.slug === document.slug ? ' aria-current="page"' : ''}>${escapeHtml(entry.title)}</a>`).join('\n')}</section>`).join('\n');
  const contentsLinks = headings.map(heading => `<a href="#${escapeHtml(heading.id)}">${escapeHtml(heading.text)}</a>`).join('\n');
  const contents = headings.length ? `<aside class="document-toc"><div class="document-menu document-desktop-menu"><div class="document-menu-title">本页目录</div><nav aria-label="本页目录">${contentsLinks}</nav></div><details class="document-menu document-collapsible"><summary>本页目录</summary><nav aria-label="本页目录">${contentsLinks}</nav></details></aside>` : '';
  return `<!doctype html>
<html lang="zh-CN" data-theme="opus" data-appearance="opus-paper">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/svg+xml" href="/gonglun.svg">
  <title>${escapeHtml(document.title)} · 公论介绍</title>
  <meta name="description" content="${escapeHtml(document.description)}">
  <link rel="stylesheet" href="/about.css">
  <link rel="alternate" type="text/markdown" href="/docs/${document.slug}.md" title="文字原文">
  <link rel="alternate" type="text/plain" href="/llms.txt" title="供 AI 阅读的功能说明">
</head>
<body>
  <a class="skip-link" href="#content">跳到正文</a>
  <nav class="site-nav" aria-label="导航"><a href="/about.html"><strong>公论</strong></a><div class="nav-links"><a href="/about.html#documents">全部文档</a><a href="/#/messages">进入工作台 ↗</a></div></nav>
  <main class="document-main">
    <header><div class="eyebrow"><a href="/about.html#documents">公论文档</a><span aria-hidden="true"> / </span>${escapeHtml(document.category)}</div><h1>${escapeHtml(document.title)}</h1>${document.notice ? `<p class="note">${escapeHtml(document.notice)}</p>` : ''}</header>
    <aside class="document-sidebar"><div class="document-menu document-desktop-menu"><div class="document-menu-title">文档导航</div><nav aria-label="项目文档">${navigation}</nav></div><details class="document-menu document-collapsible"><summary>文档导航</summary><nav aria-label="项目文档">${navigation}</nav></details></aside>
    ${contents}
    <article class="prose" id="content" aria-label="文档正文">${content}</article>
  </main>
  <footer><a href="/about.html#documents">返回公论介绍</a> · <a href="/docs/${document.slug}.md">文字原文</a> · <a href="/llms.txt">AI 功能说明</a></footer>
</body>
</html>
`;
}

/** README is the source of truth for both dev pages and deployed, script-free documents. */
export function publicDocsPlugin(): Plugin {
  let repositoryRoot: string;
  return {
    name: 'public-documents',
    configResolved(config) { repositoryRoot = resolve(config.root, '..'); },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0];
        const document = publicDocuments.find(entry => path === `/docs/${entry.slug}.html` || path === `/docs/${entry.slug}.md`);
        if (!document || !['GET', 'HEAD'].includes(req.method ?? '')) return next();
        void readFile(resolve(repositoryRoot, document.source), 'utf8').then(markdown => {
          const raw = path!.endsWith('.md');
          res.setHeader('Content-Type', `${raw ? 'text/markdown' : 'text/html'}; charset=utf-8`);
          res.setHeader('Cache-Control', 'no-store');
          res.end(req.method === 'HEAD' ? undefined : raw ? markdown : renderPublicDocument(document, markdown));
        }).catch(next);
      });
    },
    async generateBundle() {
      const sources = await Promise.all(publicDocuments.map(document => readFile(resolve(repositoryRoot, document.source), 'utf8')));
      publicDocuments.forEach((document, index) => {
        const markdown = sources[index]!;
        this.emitFile({ type: 'asset', fileName: `docs/${document.slug}.html`, source: renderPublicDocument(document, markdown) });
        this.emitFile({ type: 'asset', fileName: `docs/${document.slug}.md`, source: markdown });
      });
    },
  };
}
