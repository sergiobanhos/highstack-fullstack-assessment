import { Badge } from '@mantine/core';
import type { ComponentProps } from 'react';

export type StatusTone = 'neutral' | 'live' | 'success' | 'warning' | 'danger';

interface StatusBadgeProps extends Omit<ComponentProps<typeof Badge>, 'color' | 'variant'> {
  tone?: StatusTone;
}

const STATUS_COLORS: Record<StatusTone, string> = {
  neutral: 'gray',
  live: 'emerald',
  success: 'green',
  warning: 'yellow',
  danger: 'red',
};

export function StatusBadge({ tone = 'neutral', ...props }: StatusBadgeProps): React.JSX.Element {
  return <Badge variant="light" color={STATUS_COLORS[tone]} {...props} />;
}
