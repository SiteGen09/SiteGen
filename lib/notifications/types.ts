export const NOTIFICATION_KINDS = [
  'model_added',
  'model_removed',
  'price_change',
  'announcement',
  'low_balance',
  'key_expiring',
  'key_quota',
  'support_reply',
  'upstream_alert',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_KIND_LABELS: Record<NotificationKind, string> = {
  model_added: 'New model',
  model_removed: 'Model removed',
  price_change: 'Price change',
  announcement: 'Announcement',
  low_balance: 'Balance',
  key_expiring: 'API key',
  key_quota: 'API key',
  support_reply: 'Support',
  upstream_alert: 'Provider alert',
};

export const TITLE_MAX = 200;
export const BODY_MAX = 5000;
