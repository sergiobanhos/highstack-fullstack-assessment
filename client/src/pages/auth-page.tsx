import {
  Alert,
  Center,
  Group,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import type { OperatorApi, SessionInfo } from '../lib/operator/operator-api';
import { MIN_PASSWORD_LENGTH, useAuthForm } from '../features/auth/hooks/use-auth-form';
import { ActionButton, BrandIcon, BrandLogo, Surface } from '../components/ui';
import './auth-page.css';

export interface AuthScreenProps {
  api: OperatorApi;
  notice: string | null;
  onNoticeDismissed(): void;
  onAuthenticated(session: SessionInfo): void;
}

export function AuthScreen({ api, notice, onNoticeDismissed, onAuthenticated }: AuthScreenProps): React.JSX.Element {
  const { mode, formError, form, submitting, handleSubmit, switchMode } = useAuthForm({
    api,
    onAuthenticated,
    onNoticeDismissed,
  });
  const isRegister = mode === 'register';

  return (
    <Center className="hs-auth-page" mih="100dvh" p="md">
      <Surface className="hs-auth-card" p={{ base: 'lg', sm: 40 }} radius="xl" w={580} maw="100%">
        <Stack gap="xl">
          <div className="hs-auth-brand">
            <BrandLogo className="hs-auth-logo" />
            <Text size="sm" c="dimmed">Crash</Text>
          </div>

          <div className="hs-auth-heading">
            <Title order={1}>{isRegister ? 'Create account' : 'Sign in'}</Title>
          </div>

          {notice !== null && (
            <Alert color="blue" withCloseButton onClose={onNoticeDismissed} title="Notice">
              {notice}
            </Alert>
          )}

          {formError !== null && <Alert color="red" title="Could not continue">{formError}</Alert>}

          <form onSubmit={handleSubmit} noValidate>
            <Stack gap="md">
              {isRegister && (
                <TextInput
                  label="Name"
                  placeholder="Name"
                  autoComplete="name"
                  required
                  {...form.getInputProps('name')}
                />
              )}
              <TextInput
                  label="Email"
                  placeholder="Email"
                  leftSection={isRegister ? undefined : <BrandIcon name="email" />}
                type="email"
                inputMode="email"
                autoComplete="email"
                required
                {...form.getInputProps('email')}
              />
              <PasswordInput
                label="Password"
                placeholder="Password"
                leftSection={isRegister ? undefined : <BrandIcon name="lock" />}
                description={isRegister ? `Must be at least ${MIN_PASSWORD_LENGTH} characters` : undefined}
                autoComplete={isRegister ? 'new-password' : 'current-password'}
                required
                {...form.getInputProps('password')}
              />
              <ActionButton type="submit" loading={submitting} fullWidth mt="xs">
                {isRegister ? 'Create account and sign in' : 'Sign in'}
              </ActionButton>
            </Stack>
          </form>

          <div className="hs-auth-footer">
            <span className="hs-auth-footer__line" />
            <Group gap={6} justify="center" wrap="wrap">
              <Text size="sm" c="dimmed">{isRegister ? 'Already have an account?' : "Don't have an account?"}</Text>
              <ActionButton className="hs-auth-switch" tone="quiet" size="sm" px={4} onClick={() => switchMode(isRegister ? 'login' : 'register')}>
                {isRegister ? 'Sign in' : 'Create account'}
              </ActionButton>
            </Group>
            <span className="hs-auth-footer__line" />
          </div>
          <div className="hs-local-environment"><Text size="xs">Local test environment</Text></div>
        </Stack>
      </Surface>
    </Center>
  );
}
