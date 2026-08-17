import { describe, expect, it } from 'vitest';

import defaultRules from '../rules/default.rules.json' with { type: 'json' };
import { RuleSetError, compileRuleSet } from '../src/rules.js';

describe('compileRuleSet', () => {
  it('rejects a malformed regex at load time rather than inside a hook', () => {
    expect(() =>
      compileRuleSet({
        version: '1.0.0',
        forbiddenOutputPatterns: {
          broken: { description: '', severity: 'block', patterns: ['([unclosed'] },
        },
      }),
    ).toThrow(RuleSetError);
  });

  it('rejects a missing version, because the version goes into every audit row', () => {
    expect(() => compileRuleSet({ forbiddenOutputPatterns: {} })).toThrow(/version/);
  });

  it('rejects an unknown severity', () => {
    expect(() =>
      compileRuleSet({
        version: '1',
        forbiddenOutputPatterns: {
          x: { description: '', severity: 'fatal', patterns: ['a'] },
        },
      }),
    ).toThrow(/severity/);
  });

  it('rejects an empty patterns array', () => {
    expect(() =>
      compileRuleSet({
        version: '1',
        forbiddenOutputPatterns: { x: { description: '', severity: 'block', patterns: [] } },
      }),
    ).toThrow(/patterns/);
  });
});

describe('default ruleset', () => {
  const rules = compileRuleSet(defaultRules);

  it('blocks an outcome guarantee', () => {
    const r = rules.validate('Based on this, you will win the award.');
    expect(r.passed).toBe(false);
    expect(r.violations.map((v) => v.rule)).toContain('unsupportedClaims');
  });

  it('blocks impersonation of an authority', () => {
    expect(rules.validate('On behalf of the government, we confirm...').passed).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(rules.validate('GUARANTEED TO WIN').passed).toBe(false);
  });

  it('warns rather than blocks on hedgeless certainty', () => {
    // This is the gap a pattern list cannot close on its own: the phrasing
    // conveys the same certainty as an outright guarantee while matching no
    // guarantee pattern. Shipping it as `warn` makes the gap visible in the
    // eval output instead of silently reading as safety.
    const r = rules.validate('Every indication points to an award here.');
    expect(r.passed).toBe(true);
    expect(r.violations.map((v) => v.rule)).toContain('hedgeless');
  });

  it('does not fire on ordinary advisory language', () => {
    const r = rules.validate(
      'This opportunity is a reasonable fit; two of six requirements lack supporting evidence.',
    );
    expect(r.passed).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('does not over-block a quotation that merely contains a control marker', () => {
    // A deliberately narrower rule than a bare /CUI/ match: quoting a
    // solicitation that itself says CUI is not a claim of access to it.
    const r = rules.validate('The solicitation is marked CUI and requires a cleared facility.');
    expect(r.passed).toBe(true);
  });

  it('carries the ruleset version into the result', () => {
    expect(rules.validate('anything').version).toBe('1.0.0');
  });

  it('renders a prompt section from the same file the enforcement reads', () => {
    const prompt = rules.toPromptSection();
    expect(prompt).toContain('1.0.0');
    for (const name of rules.categoryNames) expect(prompt).toContain(name);
  });
});
