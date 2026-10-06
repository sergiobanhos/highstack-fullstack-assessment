import { Button } from '@mantine/core';
import type { ButtonProps } from '@mantine/core';

export type ActionTone = 'primary' | 'secondary' | 'quiet' | 'danger';

interface ActionButtonProps extends Omit<ButtonProps, 'variant' | 'color'> {
  tone?: ActionTone;
}

const TONE_STYLES: Record<ActionTone, Pick<ButtonProps, 'variant' | 'color'>> = {
  primary: { variant: 'filled', color: 'emerald' },
  secondary: { variant: 'default', color: 'gray' },
  quiet: { variant: 'subtle', color: 'gray' },
  danger: { variant: 'light', color: 'red' },
};

export function ActionButton({ tone = 'primary', radius = 'md', size = 'md', ...props }: ActionButtonProps): React.JSX.Element {
  return <Button {...TONE_STYLES[tone]} {...props} radius={radius} size={size} />;
}
