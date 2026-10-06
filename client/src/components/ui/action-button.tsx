import { Button } from '@mantine/core';
import type { ButtonProps } from '@mantine/core';
import type { ButtonHTMLAttributes } from 'react';

export type ActionTone = 'primary' | 'secondary' | 'quiet' | 'danger';

type ActionButtonProps = Omit<ButtonProps, 'variant' | 'color'> &
  Pick<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'type' | 'form' | 'name' | 'value' | 'autoFocus'> & {
  tone?: ActionTone;
};

const TONE_STYLES: Record<ActionTone, Pick<ButtonProps, 'variant' | 'color'>> = {
  primary: { variant: 'filled', color: 'emerald' },
  secondary: { variant: 'default', color: 'gray' },
  quiet: { variant: 'subtle', color: 'gray' },
  danger: { variant: 'light', color: 'red' },
};

export function ActionButton({ tone = 'primary', radius = 'md', size = 'md', ...props }: ActionButtonProps): React.JSX.Element {
  return <Button {...TONE_STYLES[tone]} {...props} radius={radius} size={size} />;
}
