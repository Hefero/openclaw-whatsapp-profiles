import type { BotPolicy, TargetConfig } from './config.js';

export type DeliveryDecision = {
  allowed: boolean;
  reasons: string[];
};

function minutesOfDay(value: string): number {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

function nowMinutesInTimezone(timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date());

  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

export function isQuietHours(policy: BotPolicy): boolean {
  if (!policy.quietHours.enabled) {
    return false;
  }

  const start = minutesOfDay(policy.quietHours.start);
  const end = minutesOfDay(policy.quietHours.end);
  const now = nowMinutesInTimezone(policy.quietHours.timezone);

  if (start === end) {
    return true;
  }

  if (start < end) {
    return now >= start && now < end;
  }

  return now >= start || now < end;
}

export function decideDelivery(policy: BotPolicy, target: TargetConfig | undefined): DeliveryDecision {
  const reasons: string[] = [];

  if (!target) {
    return { allowed: false, reasons: ['target is not configured'] };
  }

  if (target.autoReply.requireDirectReply) {
    return {
      allowed: false,
      reasons: ['direct-reply detection is not implemented; delivery blocked for now']
    };
  }

  if (target.type === 'group' && target.autoReply.requireMention) {
    return {
      allowed: false,
      reasons: ['group auto-reply requires mention detection; delivery blocked for now']
    };
  }

  if (isQuietHours(policy)) {
    return { allowed: false, reasons: ['quiet hours are active'] };
  }

  reasons.push('delivery gate passed');
  return { allowed: true, reasons };
}
