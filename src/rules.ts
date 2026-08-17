/**
 * Compliance rules as data, not prose.
 *
 * The obvious place to put "never guarantee an outcome" is the system prompt.
 * That is necessary and insufficient: a prompt is a request, and requests to a
 * language model have a failure rate that is small, non-zero, and not under
 * your control. So the rules live in a versioned file that both the prompt and
 * the enforcement layer read from, and the version travels into every audit row
 * so that months later you can answer which ruleset produced a given decision.
 */

export type Severity = 'block' | 'warn';

export interface RuleCategory {
  /** Doubles as documentation and as the text the system prompt is built from. */
  description: string;
  severity: Severity;
  /** Regular expression sources, matched case-insensitively. */
  patterns: string[];
}

export interface RuleSet {
  version: string;
  forbiddenOutputPatterns: Record<string, RuleCategory>;
}

export interface Violation {
  rule: string;
  severity: Severity;
  description: string;
}

export interface GuardrailResult {
  /** False when at least one `block` category matched. */
  passed: boolean;
  violations: Violation[];
  /** Ruleset version that produced this decision. Goes into the audit row. */
  version: string;
}

interface CompiledCategory {
  name: string;
  severity: Severity;
  description: string;
  regexes: RegExp[];
}

export class RuleSetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuleSetError';
  }
}

/**
 * Validate and compile a ruleset.
 *
 * Patterns are compiled once, here, so that a malformed regex fails loudly at
 * load time rather than throwing inside a hook on a request at 3am.
 */
export function compileRuleSet(raw: unknown): CompiledRuleSet {
  if (raw === null || typeof raw !== 'object') {
    throw new RuleSetError('ruleset must be an object');
  }
  const rs = raw as Partial<RuleSet>;
  if (typeof rs.version !== 'string' || rs.version.trim() === '') {
    throw new RuleSetError('ruleset.version must be a non-empty string');
  }
  if (rs.forbiddenOutputPatterns === null || typeof rs.forbiddenOutputPatterns !== 'object') {
    throw new RuleSetError('ruleset.forbiddenOutputPatterns must be an object');
  }

  const compiled: CompiledCategory[] = [];
  for (const [name, category] of Object.entries(rs.forbiddenOutputPatterns)) {
    if (category === null || typeof category !== 'object') {
      throw new RuleSetError(`category "${name}" must be an object`);
    }
    const { description, severity, patterns } = category as Partial<RuleCategory>;
    if (severity !== 'block' && severity !== 'warn') {
      throw new RuleSetError(`category "${name}" severity must be "block" or "warn"`);
    }
    if (!Array.isArray(patterns) || patterns.length === 0) {
      throw new RuleSetError(`category "${name}" must have a non-empty patterns array`);
    }
    const regexes = patterns.map((p) => {
      if (typeof p !== 'string') {
        throw new RuleSetError(`category "${name}" contains a non-string pattern`);
      }
      try {
        return new RegExp(p, 'i');
      } catch (cause) {
        throw new RuleSetError(`category "${name}" pattern ${JSON.stringify(p)} is not valid: ${String(cause)}`);
      }
    });
    compiled.push({
      name,
      severity,
      description: typeof description === 'string' ? description : '',
      regexes,
    });
  }

  return new CompiledRuleSet(rs.version, compiled);
}

export class CompiledRuleSet {
  constructor(
    readonly version: string,
    private readonly categories: readonly CompiledCategory[],
  ) {}

  /**
   * Run every category against a string.
   *
   * One violation per category is enough: knowing that `impersonation` matched
   * is what the caller acts on, and enumerating which of its eight patterns
   * fired only matters when you are tuning the ruleset, which is what the eval
   * harness is for.
   */
  validate(output: string): GuardrailResult {
    const violations: Violation[] = [];
    for (const category of this.categories) {
      for (const regex of category.regexes) {
        if (regex.test(output)) {
          violations.push({
            rule: category.name,
            severity: category.severity,
            description: category.description,
          });
          break;
        }
      }
    }
    return {
      passed: !violations.some((v) => v.severity === 'block'),
      violations,
      version: this.version,
    };
  }

  /**
   * Render the ruleset as prompt text, so the instruction the model sees and
   * the enforcement it is checked against cannot drift apart.
   */
  toPromptSection(): string {
    const lines = [`Compliance rules (ruleset ${this.version}). Output must never:`];
    for (const category of this.categories) {
      lines.push(`- [${category.name}] ${category.description}`);
    }
    return lines.join('\n');
  }

  get categoryNames(): string[] {
    return this.categories.map((c) => c.name);
  }
}
