import { useState } from 'react';
import { useForm } from '@mantine/form';
import { OperatorApiError, type OperatorApi, type SessionInfo } from '../../../lib/operator/operator-api';
import { useAuthCommands } from './use-auth-commands';

export const MIN_PASSWORD_LENGTH = 12;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;
const MAX_NAME_LENGTH = 100;
const MAX_PASSWORD_LENGTH = 128;

export type AuthMode = 'login' | 'register';

function validate(values: { name: string; email: string; password: string }, mode: AuthMode) {
  const errors: Partial<Record<'name' | 'email' | 'password', string>> = {};
  if (mode === 'register') {
    const name = values.name.trim();
    if (name.length === 0) errors.name = 'Enter your name.';
    else if (name.length > MAX_NAME_LENGTH) errors.name = `Use at most ${MAX_NAME_LENGTH} characters.`;
  }
  const email = values.email.trim();
  if (email.length === 0) errors.email = 'Enter your email.';
  else if (email.length > MAX_EMAIL_LENGTH) errors.email = `Use at most ${MAX_EMAIL_LENGTH} characters.`;
  else if (!EMAIL_PATTERN.test(email)) errors.email = 'Enter a valid email.';

  if (values.password.length < MIN_PASSWORD_LENGTH) errors.password = `The password needs at least ${MIN_PASSWORD_LENGTH} characters.`;
  else if (values.password.length > MAX_PASSWORD_LENGTH) errors.password = `Use at most ${MAX_PASSWORD_LENGTH} characters.`;
  return errors;
}

function describeFailure(error: unknown): string {
  if (error instanceof OperatorApiError) {
    if (error.code === 'EMAIL_IN_USE') return 'This email is already registered. Use "Sign in".';
    if (error.code === 'INVALID_CREDENTIALS') return 'Incorrect email or password.';
    if (error.code === 'RATE_LIMITED' || error.status === 429) return 'Too many attempts in a short time. Wait and try again.';
    if (error.code === 'SERVICE_UNAVAILABLE' || error.status === 503) return 'The authentication service is unavailable. Try again in a moment.';
    if (error.kind === 'network') return 'Could not reach the operator. Check your connection.';
    return error.message;
  }
  return 'The operation could not be completed. Try again.';
}

interface UseAuthFormOptions {
  api: OperatorApi;
  onAuthenticated(session: SessionInfo): void;
  onNoticeDismissed(): void;
}

export function useAuthForm({ api, onAuthenticated, onNoticeDismissed }: UseAuthFormOptions) {
  const [mode, setMode] = useState<AuthMode>('login');
  const [formError, setFormError] = useState<string | null>(null);
  const authCommands = useAuthCommands(api);
  const form = useForm({
    initialValues: { name: '', email: '', password: '' },
    validate: (values) => validate(values, mode),
  });

  const handleSubmit = form.onSubmit(async (values) => {
    setFormError(null);
    const email = values.email.trim();
    try {
      if (mode === 'register') {
        await authCommands.register.mutateAsync({ name: values.name.trim(), email, password: values.password });
        try {
          const session = await authCommands.login.mutateAsync({ email, password: values.password });
          onAuthenticated(session);
          return;
        } catch (loginError) {
          setMode('login');
          form.setFieldValue('password', '');
          setFormError(`Your account was created. Sign in with your password to continue. (${describeFailure(loginError)})`);
          return;
        }
      }
      const session = await authCommands.login.mutateAsync({ email, password: values.password });
      onAuthenticated(session);
    } catch (error) {
      setFormError(describeFailure(error));
    }
  });

  return {
    mode,
    formError,
    form,
    submitting: authCommands.register.isPending || authCommands.login.isPending,
    handleSubmit,
    switchMode(next: AuthMode) {
      setMode(next);
      setFormError(null);
      onNoticeDismissed();
    },
  };
}
