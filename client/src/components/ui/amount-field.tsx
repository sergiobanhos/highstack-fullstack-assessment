import { TextInput } from '@mantine/core';
import type { TextInputProps } from '@mantine/core';

type AmountFieldProps = TextInputProps;

export function AmountField({ inputMode = 'decimal', leftSection = '$', ...props }: AmountFieldProps): React.JSX.Element {
  return <TextInput {...props} inputMode={inputMode} leftSection={leftSection} />;
}
