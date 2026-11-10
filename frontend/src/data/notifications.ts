import {notificationSection,type NotificationItem} from '@gonglun/core';

export const NOTIFICATIONS_CHANGED = 'gonglun:notifications-changed';
export const NOTIFICATIONS_STORAGE_KEY = 'gonglun:notifications-refresh';
export function refreshNotifications() {
  window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED));
  try { localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, `${Date.now()}:${Math.random()}`); } catch { /* Same-tab refresh still works. */ }
}

export function groupNotifications(items: NotificationItem[]) {
  const groups = new Map<string, NotificationItem[]>();
  for (const item of [...items].sort((a, b) => b.id - a.id)) {
    const key=`${notificationSection(item)==='review-revoked'?'withdrawn:':''}${item.kind}`;
    const group = groups.get(key) ?? [];
    group.push(item); groups.set(key, group);
  }
  return [...groups.values()];
}

export function notificationTypeLabel(kind: string): string {
  const labels: Record<string, string> = {
    reply: '回复', reference: '引用', annotation: '注释', evidence: '证据', correct: '更正', amend: '修改',
    notify: '明确通知', agree: '赞同', disagree: '反对', recommend: '推荐', tag: '标注',
    'member-of': '成员加入', updated: '正文更新', message: '新消息',
    fulfill: '委托完成', terminate: '结算截止', wager: '结算结果', reversal: '结果调整',
    delegation: '委托报酬', penalty: '评价处罚', operations: '运营分配', grant: '贡献点发放', distribution: '贡献点分配',
    classify: '分类', summary: '总结', merge: '归并', arrange: '排列', proposal: '提案',
    'review-assigned':'审核任务','review-revoked':'审核任务撤回','review-expanded':'扩大审核',
    'review-result':'审核结果','review-reopened':'重新审核','review-financial':'审核资金','review-vote':'审核判断',
  };
  return labels[kind] ?? '其他消息';
}

/** Navigation leaves the current workbench mounted and never changes its composer selections. */
export function notificationPath(item: NotificationItem, pathname: string, search = '') {
  const path = /^\/messages(?:\/|$)/.test(pathname) ? pathname : '/messages';
  const params = new URLSearchParams(path === pathname ? search : '');
  for (const key of [...params.keys()]) if (key.startsWith('notification')) params.delete(key);
  params.set('notification', String(item.id));
  params.set('notificationSource', item.navigationId ?? item.sourceId);
  params.set('notificationTarget', item.targetId);
  params.set('notificationRequest', `${Date.now()}:${Math.random()}`);
  if(item.reviewTarget){
    params.set('notificationSource',item.reviewTarget.messageId);
    params.set('notificationTarget',item.reviewTarget.messageId);
    params.set('notificationReviewRevision',String(item.reviewTarget.revision));
  }
  if (item.roundId) {
    params.set('notificationTarget', item.settlementTargetId ?? item.targetId);
    params.set('notificationRound', item.roundId);
    params.set('notificationSettlement', item.settlementType ?? 'TRUTH');
  }
  return `${path}?${params}`;
}
