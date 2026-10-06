import { Paper } from '@mantine/core';
import type { ComponentProps } from 'react';

type SurfaceProps = ComponentProps<typeof Paper>;

export function Surface({ className, ...props }: SurfaceProps): React.JSX.Element {
  const classes = ['hs-surface', className].filter(Boolean).join(' ');
  return <Paper {...props} className={classes} />;
}
