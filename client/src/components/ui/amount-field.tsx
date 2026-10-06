import { TextInput } from '@mantine/core';
import type { ComponentProps } from 'react';

type AmountFieldProps = ComponentProps<typeof TextInput>;

export function AmountField({ inputMode = 'decimal', leftSection = '$', ...props }: AmountFieldProps): React.JSX.Element {
  return <TextInput {...props} inputMode={inputMode} leftSection={leftSection} />;
}
