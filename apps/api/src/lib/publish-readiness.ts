/**
 * Publish-readiness check — one source of truth for "can this account post right now".
 *
 * Used by the farm accounts list and the /social-accounts endpoint so the UI can
 * show, per account, whether it's postable and — if not — exactly why. Mirrors the
 * gates the distribute/publish workers apply at send time, so what the user sees
 * matches what actually happens.
 */

export interface ReadinessInput {
  isActive: boolean;
  authMethod: string;
  healthScore: number;
  warmupStatus: string;
  shadowBanDetected: boolean;
  hasSession: boolean;            // sessionData present (private path)
  hasProxy: boolean;             // proxyUrl set
  expiresAt: Date | null;        // official token expiry
  enforceWarmup: boolean;        // account group opts into the warmup gate
}

export interface Readiness {
  canPublish: boolean;
  blockers: string[];   // hard — publishing will be skipped/fail
  warnings: string[];   // soft — allowed but risky
}

export function computeReadiness(a: ReadinessInput): Readiness {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!a.isActive) blockers.push('Аккаунт на паузе');
  if (a.shadowBanDetected) blockers.push('Обнаружен shadow-ban');
  if ((a.healthScore ?? 100) < 30) blockers.push(`Низкий health (${a.healthScore})`);

  if (a.authMethod === 'private') {
    if (!a.hasSession) blockers.push('Нет сессии — добавьте sessionid/cookie');
    if (a.warmupStatus === 'cold' && a.enforceWarmup) blockers.push('Не прогрет (группа требует warmup)');
  } else {
    if (a.expiresAt && a.expiresAt.getTime() < Date.now()) blockers.push('Токен истёк');
  }

  if (!a.hasProxy) warnings.push('Без прокси (риск бана)');
  if (a.authMethod === 'private' && a.warmupStatus === 'cold' && !a.enforceWarmup) {
    warnings.push('Не прогрет (постинг разрешён)');
  }

  return { canPublish: blockers.length === 0, blockers, warnings };
}
