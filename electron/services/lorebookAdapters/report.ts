import type {
  LorebookCompatibilityIssue,
  LorebookCompatibilityReport,
} from '../../../shared/lorebook/adapters/types'

export function createCompatibilityReport(
  adapterId: string,
  formatLabel: string,
  formatVersion: string,
  issues: LorebookCompatibilityIssue[] = [],
): LorebookCompatibilityReport {
  const count = (action: LorebookCompatibilityIssue['action']) => issues.filter((item) => item.action === action).length
  const summary = {
    mapped: count('mapped'),
    preserved: count('preserved'),
    approximated: count('approximated'),
    dropped: count('dropped'),
    rejected: count('rejected'),
    warnings: issues.filter((item) => item.severity === 'warning').length,
    errors: issues.filter((item) => item.severity === 'error').length,
  }
  const status = summary.rejected > 0 || summary.errors > 0
    ? 'rejected' as const
    : summary.dropped > 0 || summary.approximated > 0
      ? 'approximated' as const
      : summary.preserved > 0
        ? 'preserved' as const
        : 'exact' as const
  return { adapterId, formatLabel, formatVersion, status, issues, summary }
}

export function compatibilityIssue(
  severity: LorebookCompatibilityIssue['severity'],
  action: LorebookCompatibilityIssue['action'],
  code: string,
  path: string,
  message: string,
): LorebookCompatibilityIssue {
  return { severity, action, code, path, message }
}
