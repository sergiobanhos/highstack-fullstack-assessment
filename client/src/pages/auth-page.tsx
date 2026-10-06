import {
  Alert, Button, Center, Paper, PasswordInput, SegmentedControl,
  Stack, Text, TextInput, Title,
} from '@mantine/core';
import type { OperatorApi, SessionInfo } from '../lib/operator/operator-api';
import { MIN_PASSWORD_LENGTH, useAuthForm, type AuthMode } from '../features/auth/hooks/use-auth-form';

export interface AuthScreenProps {
  api: OperatorApi;
  notice: string | null;
  onNoticeDismissed(): void;
  onAuthenticated(session: SessionInfo): void;
}

export function AuthScreen({ api, notice, onNoticeDismissed, onAuthenticated }: AuthScreenProps): React.JSX.Element {
  const { mode, formError, form, submitting, handleSubmit, switchMode } = useAuthForm({
    api, onAuthenticated, onNoticeDismissed,
  });

  return (
    <Center mih="100dvh" p="md">
      <Paper withBorder shadow="sm" p="lg" radius="md" w={440} maw="100%">
        <Stack gap="md">
          <div>
            <Title order={2}>Crashsim</Title>
            <Text size="sm" c="dimmed">
              Sign in to play and move your balance.
            </Text>
          </div>

          <SegmentedControl
            fullWidth
            value={mode}
            onChange={(value) => switchMode(value as AuthMode)}
            data={[
              { label: 'Sign in', value: 'login' },
              { label: 'Create account', value: 'register' },
            ]}
          />

          {notice !== null && (
            <Alert color="blue" withCloseButton onClose={onNoticeDismissed} title="Notice">
              {notice}
            </Alert>
          )}

          {formError !== null && (
            <Alert color="red" title="Could not continue">
              {formError}
            </Alert>
          )}

          <form onSubmit={handleSubmit} noValidate>
            <Stack gap="sm">
              {mode === 'register' && (
                <TextInput
                  label="Name"
                  placeholder="What should we call you?"
                  autoComplete="name"
                  required
                  {...form.getInputProps('name')}
                />
              )}
              <TextInput
                label="Email"
                placeholder="you@example.com"
                type="email"
                inputMode="email"
                autoComplete="email"
                required
                {...form.getInputProps('email')}
              />
              <PasswordInput
                label="Password"
                description={mode === 'register' ? `At least ${MIN_PASSWORD_LENGTH} characters.` : undefined}
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                required
                {...form.getInputProps('password')}
              />
              <Button type="submit" loading={submitting} fullWidth mt="xs">
                {mode === 'register' ? 'Create account and sign in' : 'Sign in'}
              </Button>
            </Stack>
          </form>

          <Text size="xs" c="dimmed">
            Local development environment. Balance, top-up and payout are test operations.
          </Text>
        </Stack>
      </Paper>
    </Center>
  );
}
