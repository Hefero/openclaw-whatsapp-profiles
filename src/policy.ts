import type { BotMode, BotPolicy } from './config.js';
import { findTargetConfig } from './guidance.js';

export type PolicyDecision = {
  action: 'ignore' | 'observe' | 'draft' | 'auto';
  reasons: string[];
  profile?: string;
  targetLabel?: string;
};

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function matchesPolicyPattern(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const trimmed = pattern.trim();
    if (!trimmed) {
      return false;
    }

    return trimmed === '*' || wildcardToRegExp(trimmed).test(value);
  });
}

export function decideMessageAction(remoteJid: string, mode: BotMode, policy: BotPolicy): PolicyDecision {
  const reasons: string[] = [];
  const isGroup = remoteJid.endsWith('@g.us');
  const target = findTargetConfig(remoteJid, policy);
  const targetMode = target?.mode ?? policy.defaults.mode;
  const profile = target?.profile ?? policy.defaults.profile;

  if (target && !target.enabled) {
    return { action: 'ignore', reasons: ['target is disabled'], profile, targetLabel: target.label };
  }

  if (isGroup && !policy.allowGroups && !target) {
    return { action: 'ignore', reasons: ['groups are disabled'] };
  }

  if (matchesPolicyPattern(remoteJid, policy.denyContacts)) {
    return { action: 'ignore', reasons: ['contact is denylisted'], profile, targetLabel: target?.label };
  }

  if (mode === 'observe') {
    return { action: 'observe', reasons: ['BOT_MODE=observe'], profile, targetLabel: target?.label };
  }

  const isExplicitlyAllowed = matchesPolicyPattern(remoteJid, policy.allowContacts);
  if (!target && !isExplicitlyAllowed) {
    return { action: 'observe', reasons: ['target is not configured'], profile };
  }

  if (targetMode === 'observe') {
    return { action: 'observe', reasons: ['target mode is observe'], profile, targetLabel: target?.label };
  }

  if (mode === 'draft') {
    return { action: 'draft', reasons: ['target is configured', 'BOT_MODE=draft'], profile, targetLabel: target?.label };
  }

  if (targetMode === 'draft') {
    return { action: 'draft', reasons: ['target mode is draft'], profile, targetLabel: target?.label };
  }

  const canAutoSend =
    target?.autoReply.enabled === true || policy.autoSendContacts.includes(remoteJid);
  if (!canAutoSend) {
    return {
      action: 'draft',
      reasons: ['target is configured', 'auto-send is not enabled for target'],
      profile,
      targetLabel: target?.label
    };
  }

  reasons.push('target is configured for auto-send');
  return { action: 'auto', reasons, profile, targetLabel: target?.label };
}
