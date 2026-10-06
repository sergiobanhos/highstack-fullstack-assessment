import { Paper } from '@mantine/core';
import type { HTMLAttributes, ReactNode } from 'react';
import type { PaperProps } from '@mantine/core';

type SurfaceProps = PaperProps & HTMLAttributes<HTMLElement> & {
  children?: ReactNode;
  component?: React.ElementType;
  type?: 'button' | 'submit' | 'reset';
};

export function Surface({ className, ...props }: SurfaceProps): React.JSX.Element {
  const classes = ['hs-surface', className].filter(Boolean).join(' ');
  return <Paper {...(props as PaperProps)} className={classes} />;
}
