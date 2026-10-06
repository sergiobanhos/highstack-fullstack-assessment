import { Modal } from '@mantine/core';
import type { ModalProps } from '@mantine/core';

type AppModalProps = ModalProps;

export function AppModal({
  centered = true,
  size = 'md',
  radius = 'lg',
  overlayProps,
  className,
  ...props
}: AppModalProps): React.JSX.Element {
  const classes = ['hs-modal', className].filter(Boolean).join(' ');
  return (
    <Modal
      {...props}
      centered={centered}
      size={size}
      radius={radius}
      className={classes}
      overlayProps={{ backgroundOpacity: 0.72, blur: 4, ...overlayProps }}
    />
  );
}
