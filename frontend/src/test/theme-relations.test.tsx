import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, expect, it } from 'vitest';
import { RelationChoices } from '../pages/workbench/ui/RelationToolbar';
import { ALL_RELATION_TYPES } from '../pages/workbench/model/relationComposition';
import { relationTypeName } from '../utils/graphTextSelection';
import type { RelationType } from '../utils/modelBridge';
import { setTheme } from '../theme/theme';

afterEach(() => { cleanup(); localStorage.clear(); delete document.documentElement.dataset.appearance; delete document.documentElement.dataset.theme; });

function Composer() {
  const [relationType, setRelationType] = useState<RelationType | null>(null);
  const [secondaryRelationType, setSecondaryRelationType] = useState('none');
  const [newMessageContent, setNewMessageContent] = useState('保留未发送的正文');
  const composer = { relationType, secondaryRelationType, newMessageContent, subType: null, setRelationType, setSecondaryRelationType,
    setNewMessageContent, lastTagSecondaryRef: useRef('recommend'), lastDelegationSecondaryRef: useRef<'create' | 'fulfill'>('create'),
    savedTextOnTypeSwitchRef: useRef(''), subTypeCustomBufferRef: useRef(''), guideTargetIdRef: useRef<string | null>(null) };
  return <><RelationChoices composer={composer} /><RelationChoices composer={composer} placement="desk" />
    <textarea aria-label="测试正文" value={newMessageContent} readOnly /><output>{secondaryRelationType}</output></>;
}

it('keeps exactly one entry for all 16 relation types in each theme and preserves the selected relation and draft', () => {
  setTheme('gpt'); render(<Composer />);
  const draft = screen.getByLabelText('测试正文');
  fireEvent.click(screen.getByRole('button', {name: '引用'}));
  for (const theme of ['gpt', 'opus-paper', 'gpt-arena', 'gpt'] as const) {
    act(() => setTheme(theme));
    expect(screen.getAllByRole('button')).toHaveLength(16);
    for (const type of ALL_RELATION_TYPES) expect(screen.getAllByRole('button', {name: relationTypeName(type)})).toHaveLength(1);
    expect(screen.getByRole('button', {name: '引用'})).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('测试正文')).toBe(draft);
    expect(draft).toHaveValue('保留未发送的正文');
  }
});

it('uses the existing merge draft restoration and correction defaults after moving controls to the desk', () => {
  setTheme('opus-paper'); render(<Composer />);
  fireEvent.click(screen.getByRole('button', {name: '归并'}));
  expect(screen.getByLabelText('测试正文')).toHaveValue('');
  act(() => setTheme('gpt'));
  fireEvent.click(screen.getByRole('button', {name: '更正'}));
  expect(screen.getByLabelText('测试正文')).toHaveValue('保留未发送的正文');
  expect(screen.getByRole('status')).toHaveTextContent('text-correction');
});
