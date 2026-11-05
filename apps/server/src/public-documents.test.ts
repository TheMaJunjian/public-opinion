// @vitest-environment jsdom
import { readFile } from 'node:fs/promises';
import { URL as NodeURL } from 'node:url';
import { expect, it } from 'vitest';
import { publicDocumentGroups, publicDocuments, renderPublicDocument } from '../../../frontend/publicDocsPlugin';

const parsePage = (html: string) => new DOMParser().parseFromString(html, 'text/html');

it('renders the public documents and links every library entry from the introduction', async () => {
  for (const entry of publicDocuments) {
    const markdown = await readFile(new NodeURL(`../../../${entry.source}`, import.meta.url), 'utf8');
    const page = parsePage(renderPublicDocument(entry, markdown));
    expect(page.querySelector('h1')!.textContent).toBe(entry.title);
    expect(page.querySelector('article')!.textContent!.length).toBeGreaterThan(400);
    expect(page.querySelector('script')).toBeNull();
    expect(page.querySelector('[aria-current="page"]')!.getAttribute('href')).toBe(`/docs/${entry.slug}.html`);
  }
  const landing = parsePage(await readFile(new NodeURL('../../../frontend/public/about.html', import.meta.url), 'utf8'));
  const docLinks = [...landing.querySelectorAll('#documents ~ .documents a')].map(link => link.getAttribute('href'));
  expect(docLinks.sort()).toEqual(publicDocuments.map(entry => `/docs/${entry.slug}.html`).sort());
});

it('keeps relative document links and heading anchors usable, with scrollable tables', () => {
  const entry = publicDocuments.find(document => document.slug === 'promotion')!;
  const page = parsePage(renderPublicDocument(entry, `# 标题

[规则](./现行收费与操作规则.md#每条消息怎样收费)

## 费用

| 项目 | 规则 |
| --- | --- |
| 文本 | 投入与协议费 |

## 费用
`));
  expect(decodeURIComponent(page.querySelector('article a')!.getAttribute('href')!)).toBe('/docs/usage.html#每条消息怎样收费');
  expect([...page.querySelectorAll('article h2')].map(heading => heading.id)).toEqual(['费用', '费用-1']);
  expect(page.querySelector('.table-scroll table')).not.toBeNull();
});

it('groups the library into four reading paths and resolves every guide anchor', async () => {
  const pages = new Map<string, Document>();
  const landing = parsePage(await readFile(new NodeURL('../../../frontend/public/about.html', import.meta.url), 'utf8'));
  pages.set('/about.html', landing);
  for (const entry of publicDocuments) {
    const markdown = await readFile(new NodeURL(`../../../${entry.source}`, import.meta.url), 'utf8');
    const page = parsePage(renderPublicDocument(entry, markdown));
    pages.set(`/docs/${entry.slug}.html`, page);
    for (const menu of page.querySelectorAll('.document-sidebar .document-menu')) {
      expect([...menu.querySelectorAll('.document-nav-group h2')].map(heading => heading.textContent)).toEqual(['入门', '操作指南', '现行规则', '理念与规划']);
      expect(menu.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    }
    expect(page.querySelector('.document-sidebar .document-desktop-menu nav')).not.toBeNull();
    expect(page.querySelector('.document-sidebar details:not([open])')).not.toBeNull();
    if (page.querySelector('article h2')) {
      expect(page.querySelector('.document-toc .document-desktop-menu nav')).not.toBeNull();
      expect(page.querySelector('.document-toc details:not([open])')).not.toBeNull();
    }
    expect(page.querySelector('details[open]')).toBeNull();
    const ids = [...page.querySelectorAll('[id]')].map(element => element.id);
    expect(new Set(ids).size).toBe(ids.length);
  }
  for (const group of publicDocumentGroups) {
    for (const link of group.links) {
      const url = new NodeURL(link.href, 'https://docs.invalid');
      const target = pages.get(url.pathname);
      expect(target, link.href).toBeDefined();
      if (url.hash) expect(target!.getElementById(decodeURIComponent(url.hash.slice(1))), link.href).not.toBeNull();
    }
  }
  for (const menu of landing.querySelectorAll('.introduction-sidebar .document-menu')) {
    expect([...menu.querySelectorAll('.document-nav-group h2')].map(heading => heading.textContent)).toEqual(publicDocumentGroups.map(group => group.title));
  }
  expect(landing.querySelector('details[open]')).toBeNull();
  expect(landing.querySelectorAll('.introduction-shell details.document-collapsible')).toHaveLength(2);
  const interfaceGuide = landing.getElementById('interface-guide')!.closest('section')!;
  for (const anchor of ['guide-selection', 'guide-endpoints', 'guide-relations', 'guide-composer', 'guide-costs', 'guide-stake-tiers']) {
    expect(interfaceGuide.querySelector(`#${anchor}`), anchor).not.toBeNull();
  }
  const landingIds = [...landing.querySelectorAll('[id]')].map(element => element.id);
  expect(new Set(landingIds).size).toBe(landingIds.length);
});

it('treats raw HTML and executable links in documents as text', () => {
  const page = parsePage(renderPublicDocument(publicDocuments[0]!, `# 标题

<script>alert('raw HTML')</script>

[执行](javascript:alert%281%29)

![图片](data:image/svg+xml,test)
`));
  expect(page.querySelector('article')!.textContent).toContain('<script>');
  expect(page.querySelector('script, img, [onclick]')).toBeNull();
  expect([...page.querySelectorAll('a')].some(link => link.protocol === 'javascript:')).toBe(false);
});
