/**
 * RelationBadge.test.tsx — Component tests for RelationBadge.
 *
 * Tests that the badge renders the correct label and icon for each
 * presentation kind, and that unknown types use a fallback display.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import RelationBadge from '../components/RelationBadge';

describe('RelationBadge', () => {
  it('renders the Chinese label for ANNOTATION', () => {
    render(<RelationBadge type="ANNOTATION" />);
    expect(screen.getByText('注释')).toBeInTheDocument();
  });

  it('renders the Chinese label for REPLY', () => {
    render(<RelationBadge type="REPLY" />);
    expect(screen.getByText('回复')).toBeInTheDocument();
  });

  it('renders the Chinese label for AGREE', () => {
    render(<RelationBadge type="AGREE" />);
    expect(screen.getByText('赞同')).toBeInTheDocument();
  });

  it('renders the Chinese label for DISAGREE', () => {
    render(<RelationBadge type="DISAGREE" />);
    expect(screen.getByText('反对')).toBeInTheDocument();
  });

  it('renders the Chinese label for CLASSIFY', () => {
    render(<RelationBadge type="CLASSIFY" />);
    expect(screen.getByText('分类')).toBeInTheDocument();
  });

  it('renders all 14 defined relation types without error', () => {
    const types = [
      'ANNOTATION', 'REFERENCE', 'REPLY', 'AGREE', 'DISAGREE',
      'SUPPORT', 'REBUT', 'CORRECT', 'SUPPLEMENT', 'CLASSIFY',
      'MERGE', 'SUMMARY', 'RECOMMEND', 'ARCHIVE',
    ];
    for (const type of types) {
      const { unmount } = render(<RelationBadge type={type} />);
      unmount();
    }
  });

  it('renders a fallback label for an unknown relation type', () => {
    render(<RelationBadge type="UNKNOWN_TYPE" />);
    // The fallback spec uses the type string itself as the label
    expect(screen.getByText('UNKNOWN_TYPE')).toBeInTheDocument();
  });

  it('has a title attribute exposing the raw type', () => {
    const { container } = render(<RelationBadge type="REPLY" />);
    const badge = container.querySelector('[title]');
    expect(badge?.getAttribute('title')).toContain('REPLY');
  });

  it('accepts an additional className prop', () => {
    const { container } = render(<RelationBadge type="REPLY" className="my-custom-class" />);
    const badge = container.firstChild as HTMLElement;
    expect(badge.className).toContain('my-custom-class');
  });
});
