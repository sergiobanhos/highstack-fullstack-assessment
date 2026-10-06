import { Badge } from '@mantine/core';
import type { BadgeProps } from '@mantine/core';
import type { HTMLAttributes } from 'react';

export type StatusTone = 'neutral' | 'live' | 'success' | 'warning' | 'danger';

type StatusBadgeProps = Omit<BadgeProps, 'color' | 'variant'> &
  Omit<HTMLAttributes<HTMLDivElement>, keyof BadgeProps> & {
  tone?: StatusTone;
};

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
