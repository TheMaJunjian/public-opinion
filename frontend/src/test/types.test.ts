/**
 * types.test.ts — Unit tests for type helper functions.
 *
 * Tests: getPresentationSpec, getTargetMessageIds, getTargetRelationIds, PRESENTATION_SPECS
 */

import { describe, it, expect } from 'vitest';
import {
  getPresentationSpec,
  getTargetMessageIds,
  getTargetRelationIds,
  PRESENTATION_SPECS,
} from '../types';
import type { TargetRef } from '../types';

describe('getPresentationSpec', () => {
  it('returns the correct spec for ANNOTATION', () => {
    const spec = getPresentationSpec('ANNOTATION');
    expect(spec.kind).toBe('edge-label');
    expect(spec.label).toBe('注释');
    expect(spec.color).toBe('blue');
  });

  it('returns the correct spec for AGREE', () => {
    const spec = getPresentationSpec('AGREE');
    expect(spec.kind).toBe('decoration');
    expect(spec.stanceEffect).toBe('support');
  });

  it('returns the correct spec for DISAGREE', () => {
    const spec = getPresentationSpec('DISAGREE');
    expect(spec.kind).toBe('decoration');
    expect(spec.stanceEffect).toBe('oppose');
  });

  it('returns the correct spec for TAG (decoration-label)', () => {
    const spec = getPresentationSpec('TAG');
    expect(spec.kind).toBe('decoration-label');
    expect(spec.label).toBe('标注');
  });

  it('returns the correct spec for ARRANGE (arrange-frame)', () => {
    const spec = getPresentationSpec('ARRANGE');
    expect(spec.kind).toBe('arrange-frame');
    expect(spec.formsTrees).toBe(true);
  });

  it('returns a fallback edge-label spec for unknown types', () => {
    const spec = getPresentationSpec('UNKNOWN_RELATION_TYPE');
    expect(spec.kind).toBe('edge-label');
    expect(spec.label).toBe('UNKNOWN_RELATION_TYPE');
    expect(spec.color).toBe('gray');
  });

  it('covers all 13 required relation types', () => {
    const required = [
      'ANNOTATION', 'REFERENCE', 'REPLY', 'AGREE', 'DISAGREE',
      'TAG', 'CORRECT', 'ARRANGE', 'CLASSIFY',
      'MERGE', 'SUMMARY', 'RECOMMEND', 'ARCHIVE',
    ];
    for (const type of required) {
      expect(PRESENTATION_SPECS[type], `Missing spec for ${type}`).toBeDefined();
    }
  });
});

describe('getTargetMessageIds', () => {
  it('extracts messageId from message-kind refs', () => {
    const refs: TargetRef[] = [
      { kind: 'message', messageId: 'msg1' },
      { kind: 'message', messageId: 'msg2' },
    ];
    expect(getTargetMessageIds(refs)).toEqual(['msg1', 'msg2']);
  });

  it('extracts messageId from text-fragment-kind refs', () => {
    const refs: TargetRef[] = [
      { kind: 'text-fragment', messageId: 'msg3', text: 'hello', hash: 'abc' },
    ];
    expect(getTargetMessageIds(refs)).toEqual(['msg3']);
  });

  it('excludes relation-kind refs', () => {
    const refs: TargetRef[] = [
      { kind: 'message', messageId: 'msg1' },
      { kind: 'relation', relationId: 'rel1' },
    ];
    expect(getTargetMessageIds(refs)).toEqual(['msg1']);
  });

  it('returns empty array when all refs are relation-kind', () => {
    const refs: TargetRef[] = [
      { kind: 'relation', relationId: 'rel1', part: 'label' },
    ];
    expect(getTargetMessageIds(refs)).toEqual([]);
  });
});

describe('getTargetRelationIds', () => {
  it('extracts relationId from relation-kind refs', () => {
    const refs: TargetRef[] = [
      { kind: 'relation', relationId: 'rel1' },
      { kind: 'relation', relationId: 'rel2', part: 'label' },
    ];
    expect(getTargetRelationIds(refs)).toEqual(['rel1', 'rel2']);
  });

  it('excludes message-kind and text-fragment-kind refs', () => {
    const refs: TargetRef[] = [
      { kind: 'message', messageId: 'msg1' },
      { kind: 'text-fragment', messageId: 'msg2', text: 'hi', hash: 'xyz' },
      { kind: 'relation', relationId: 'rel1' },
    ];
    expect(getTargetRelationIds(refs)).toEqual(['rel1']);
  });

  it('returns empty array when no relation-kind refs exist', () => {
    const refs: TargetRef[] = [
      { kind: 'message', messageId: 'msg1' },
    ];
    expect(getTargetRelationIds(refs)).toEqual([]);
  });
});

describe('PRESENTATION_SPECS completeness', () => {
  it('every spec has required fields', () => {
    for (const [key, spec] of Object.entries(PRESENTATION_SPECS)) {
      expect(spec.kind, `${key} missing kind`).toBeDefined();
      expect(spec.label, `${key} missing label`).toBeDefined();
      expect(spec.color, `${key} missing color`).toBeDefined();
    }
  });

  it('all tree-forming relations have formsTrees=true', () => {
    // REPLY, CORRECT, ARRANGE are expected to form trees
    const treeForms = ['REPLY', 'CORRECT', 'ARRANGE'];
    for (const type of treeForms) {
      expect(PRESENTATION_SPECS[type]?.formsTrees, `${type} should have formsTrees=true`).toBe(true);
    }
  });

  it('ANNOTATION and REFERENCE do NOT form trees', () => {
    expect(PRESENTATION_SPECS.ANNOTATION?.formsTrees).not.toBe(true);
    expect(PRESENTATION_SPECS.REFERENCE?.formsTrees).not.toBe(true);
  });
});
